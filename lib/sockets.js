/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2016, Joyent, Inc.
 */

module.exports = {
	DnsTcpSocket: DnsTcpSocket,
	DnsUdpSocket: DnsUdpSocket
};

const mod_dgram = require('dgram');
const mod_net = require('net');
const mod_events = require('events');
const mod_assert = require('assert-plus');
const mod_util = require('util');
const mod_fsm = require('mooremachine');

const mod_named = require('named');
const mod_proto = mod_named.Protocol;

const mod_message = require('./message');
const DnsMessage = mod_message.DnsMessage;

function DnsTcpSocket(options) {
	mod_assert.object(options, 'options');
	mod_assert.optionalNumber(options.family, 'options.family');
	mod_assert.string(options.address, 'options.address');
	mod_assert.number(options.port, 'options.port');
	mod_assert.optionalObject(options.log, 'options.log');
	this.dts_options = options;
	this.dts_requests = {};
	this.dts_log = options.log;
	this.dts_ending = false;

	mod_fsm.FSM.call(this, 'connect');
}
mod_util.inherits(DnsTcpSocket, mod_fsm.FSM);

DnsTcpSocket.prototype.send = function (req, dest) {
	mod_assert.object(req, 'request');
	mod_assert.optionalObject(dest, 'destination');
	if (dest !== undefined) {
		mod_assert.strictEqual(dest.address, this.dts_options.address);
		mod_assert.strictEqual(dest.port, this.dts_options.port);
	}

	mod_assert.strictEqual(this.getState(), 'connected');

	var id;
	do {
		id = genReqId();
	} while (this.dts_requests[id]);

	req.header.id = id;
	this.dts_requests[id] = req;

	var buf = mod_proto.encode(req, 'message');
	var lebuf = new Buffer(buf.length + 2);
	buf.copy(lebuf, 2);
	lebuf.writeUInt16BE(buf.length, 0);
	this.dts_socket.write(lebuf);
};

DnsTcpSocket.prototype.cancel = function (req) {
	mod_assert.object(req, 'request');
	mod_assert.number(req.header.id, 'request id');
	var id = req.header.id;
	mod_assert.strictEqual(this.dts_requests[id], req);
	delete (this.dts_requests[id]);
};

DnsTcpSocket.prototype.end = function () {
	this.dts_ending = true;
	this.dts_socket.end();
};

DnsTcpSocket.prototype.state_connect = function (on, once, timeout) {
	var self = this;
	this.dts_socket = mod_net.createConnection({
		allowHalfOpen: true,
		port: this.dts_options.port,
		host: this.dts_options.address,
		family: this.dts_options.family
	});
	on(this.dts_socket, 'connect', function () {
		self.gotoState('connected');
	});
	on(this.dts_socket, 'error', function (err) {
		self.dts_lastError = err;
		self.gotoState('error');
	});
};

DnsTcpSocket.prototype.state_error = function (on, once, timeout) {
	var self = this;
	Object.keys(this.dts_requests).forEach(function (k) {
		var req = self.dts_requests[k];
		req.emit('error', self.dts_lastError);
		delete (self.dts_requests[k]);
	});
	delete (this.dts_socket);
	this.emit('error', this.dts_lastError);
};

DnsTcpSocket.prototype.state_connected = function (on, once, timeout) {
	var self = this;
	this.emit('ready');
	this.dts_buffer = new Buffer(0);
	on(this.dts_socket, 'readable', function () {
		var chunk, chunks = [self.dts_buffer];
		while ((chunk = self.dts_socket.read()) !== null)
			chunks.push(chunk);

		self.dts_buffer = Buffer.concat(chunks);

		while (self.dts_buffer.length > 2) {
			var len = self.dts_buffer.readUInt16BE(0);
			if (self.dts_buffer.length >= len + 2) {
				var pkt = self.dts_buffer.slice(2, len + 2);
				self.dts_buffer = self.dts_buffer.
				    slice(len + 2);
				var msg;
				try {
					msg = mod_proto.decode(pkt, 'message');
				} catch (e) {
					self.dts_lastError = new Error(
					    'Failed to parse DNS packet: ' +
					    e.message);
					self.dts_lastError.packet = pkt;
					self.gotoState('error');
					return;
				}
				var req = self.dts_requests[msg.header.id];
				var doneCb = function () {
					delete (self.dts_requests[
					    msg.header.id]);
				};
				if (req) {
					req.emit('reply',
					    new DnsMessage(msg), doneCb);
				}
			} else {
				break;
			}
		}
	});
	on(this.dts_socket, 'error', function (err) {
		self.dts_lastError = err;
		self.gotoState('error');
	});
	on(this.dts_socket, 'close', function () {
		if (self.dts_ending) {
			self.gotoState('closed');
		} else {
			self.dts_lastError = new Error(
			    'Socket unexpectedly closed');
			self.gotoState('error');
		}
	});
};

DnsTcpSocket.prototype.state_closed = function () {
	this.dts_socket.destroy();
	delete (this.dts_socket);
	mod_assert.strictEqual(Object.keys(this.dts_requests).length, 0,
	    'DNS TCP socket closed with outstanding requests');
};

function DnsUdpSocket(options) {
	mod_assert.object(options, 'options');
	mod_assert.string(options.family, 'options.family');
	mod_assert.optionalString(options.bindAddress, 'options.bindAddress');
	mod_assert.optionalObject(options.log, 'options.log');
	this.dus_options = options;
	this.dus_requests = {};
	this.dus_log = options.log;
	this.dus_ending = false;

	mod_fsm.FSM.call(this, 'bind');
}
mod_util.inherits(DnsUdpSocket, mod_fsm.FSM);

function genReqId() {
	return (Math.round(Math.random() * 65535));
}

DnsUdpSocket.prototype.send = function (req, dest) {
	mod_assert.object(req, 'request');
	mod_assert.object(dest, 'destination');
	mod_assert.string(dest.address, 'destination address');
	mod_assert.number(dest.port, 'destination port');

	mod_assert.strictEqual(this.getState(), 'normal');

	var id;
	do {
		id = genReqId();
	} while (this.dus_requests[id]);

	req.header.id = id;
	this.dus_requests[id] = req;

	var buf = mod_proto.encode(req, 'message');
	this.dus_socket.send(buf, 0, buf.length, dest.port, dest.address);
};

DnsUdpSocket.prototype.cancel = function (req) {
	mod_assert.object(req, 'request');
	mod_assert.number(req.header.id, 'request id');
	var id = req.header.id;
	mod_assert.strictEqual(this.dus_requests[id], req);
	delete (this.dus_requests[id]);
};

DnsUdpSocket.prototype.end = function () {
	this.dus_ending = true;
	if (Object.keys(this.dus_requests).length < 1)
		this.gotoState('closed');
};

DnsUdpSocket.prototype.state_bind = function (on, once, timeout) {
	var self = this;

	this.dus_socket = mod_dgram.createSocket(this.dus_options.family);
	this.dus_socket.dus = this;
	on(this.dus_socket, 'error', function (err) {
		self.dus_lastError = err;
		self.gotoState('error');
	});
	on(this.dus_socket, 'listening', function () {
		self.gotoState('normal');
	});
	this.dus_socket.bind({
		address: this.dus_options.bindAddress
	});
};

DnsUdpSocket.prototype.state_error = function (on, once, timeout) {
	var self = this;
	Object.keys(this.dus_requests).forEach(function (k) {
		var req = self.dus_requests[k];
		req.emit('error', self.dus_lastError);
		delete (self.dus_requests[k]);
	});
	delete (this.dus_socket);
	this.emit('error', this.dus_lastError);
};

DnsUdpSocket.prototype.state_normal = function (on, once, timeout) {
	var self = this;
	this.emit('ready');
	on(this.dus_socket, 'message', function (msg, rinfo) {
		var reply;
		try {
			reply = mod_proto.decode(msg, 'message');
		} catch (e) {
			if (self.dus_log) {
				e.packet = msg.toString('base64');
				self.dus_log.error(e, 'received invalid DNS ' +
				    'datagram');
			}
			return;
		}
		var req = self.dus_requests[reply.header.id];
		if (!req) {
			if (self.dus_log) {
				self.dus_log.debug({message: reply},
				    'received unsolicited DNS datagram with ' +
				    'id %d from [%s]:%d/%s', reply.header.id,
				    rinfo.address, rinfo.port, rinfo.family);
			}
			return;
		}
		if (req.question[0].name !== reply.question[0].name ||
		    req.question[0].qclass !== reply.question[0].qclass ||
		    req.question[0].type !== reply.question[0].type) {
			if (self.dus_log) {
				self.dus_log.error({message: reply},
				    'DNS reply for id %d did not match ' +
				    'question section of original request',
				    reply.header.id);
			}
			return;
		}
		function doneCb() {
			delete (self.dus_requests[reply.header.id]);
			if (self.dus_ending &&
			    Object.keys(self.dus_requests).length < 1) {
				self.gotoState('closed');
			}
		}
		req.emit('reply', new DnsMessage(reply), doneCb);
	});
	on(this.dus_socket, 'error', function (err) {
		self.dus_lastError = err;
		self.gotoState('error');
	});
	on(this.dus_socket, 'close', function () {
		self.dus_lastError = new Error('Socket unexpectedly closed');
		self.gotoState('error');
	});
};

DnsUdpSocket.prototype.state_closed = function () {
	this.dus_socket.close();
	delete (this.dus_socket);
	mod_assert.strictEqual(Object.keys(this.dus_requests).length, 0,
	    'DNS UDP socket closed with outstanding requests');
};
