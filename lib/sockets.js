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

const mod_named = require('mname');
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

	if (req.dm_cancelled)
		return;

	var id;
	do {
		id = genReqId();
	} while (this.dts_requests[id]);

	req.header.id = id;
	this.dts_requests[id] = req;
	req.dm_socket = this;

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
	if (this.dts_requests[id] === req) {
		req.dm_socket = undefined;
		delete (this.dts_requests[id]);
		if (Object.keys(this.dts_requests).length < 1) {
			if (this.dts_ending)
				this.emit('finalReqCancelled');
			else
				this.dts_socket.unref();
		}
	}
};

DnsTcpSocket.prototype.end = function () {
	this.dts_ending = true;
	this.dts_socket.end();
};

DnsTcpSocket.prototype.isReady = function () {
	return (this.getState() === 'connected');
};

DnsTcpSocket.prototype.unref = function () {
	if (Object.keys(this.dts_requests).length < 1)
		this.dts_socket.unref();
};

DnsTcpSocket.prototype.ref = function () {
	this.dts_socket.ref();
};

DnsTcpSocket.prototype.state_connect = function (S) {
	S.validTransitions(['connected', 'error']);
	var self = this;
	this.dts_socket = mod_net.createConnection({
		allowHalfOpen: true,
		port: this.dts_options.port,
		host: this.dts_options.address,
		family: this.dts_options.family
	});
	S.on(this.dts_socket, 'connect', function () {
		S.gotoState('connected');
	});
	S.on(this.dts_socket, 'error', function (err) {
		self.dts_lastError = err;
		S.gotoState('error');
	});
};

DnsTcpSocket.prototype.state_error = function (S) {
	S.validTransitions([]);
	var self = this;
	Object.keys(this.dts_requests).forEach(function (k) {
		var req = self.dts_requests[k];
		req.emit('error', self.dts_lastError);
		delete (self.dts_requests[k]);
	});
	delete (this.dts_socket);
	this.emit('error', this.dts_lastError);
};

DnsTcpSocket.prototype.state_connected = function (S) {
	var self = this;
	S.validTransitions(['error', 'closed']);
	this.dts_buffer = new Buffer(0);
	S.on(this.dts_socket, 'readable', function () {
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
					S.gotoState('error');
					return;
				}
				var req = self.dts_requests[msg.header.id];
				var doneCb = function () {
					delete (self.dts_requests[
					    msg.header.id]);
					var ks = Object.keys(self.dts_requests);
					if (ks.length < 1)
						self.dts_socket.unref();
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
	S.on(this.dts_socket, 'error', function (err) {
		self.dts_lastError = err;
		S.gotoState('error');
	});
	S.on(this.dts_socket, 'close', function () {
		if (self.dts_ending) {
			S.gotoState('closed');
		} else {
			self.dts_lastError = new Error(
			    'Socket unexpectedly closed');
			S.gotoState('error');
		}
	});
	S.on(this, 'finalReqCancelled', function () {
		S.gotoState('closed');
	});
	S.immediate(function () {
		self.emit('ready');
	});
};

DnsTcpSocket.prototype.state_closed = function (S) {
	S.validTransitions([]);
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

	if (req.dm_cancelled)
		return;

	var id;
	do {
		id = genReqId();
	} while (this.dus_requests[id]);

	req.header.id = id;
	this.dus_requests[id] = req;
	req.dm_socket = this;

	var buf = mod_proto.encode(req, 'message');
	this.dus_socket.ref();
	this.dus_socket.send(buf, 0, buf.length, dest.port, dest.address);
};

DnsUdpSocket.prototype.unref = function () {
	if (Object.keys(this.dus_requests).length < 1)
		this.dus_socket.unref();
};

DnsUdpSocket.prototype.ref = function () {
	this.dus_socket.ref();
};

DnsUdpSocket.prototype.isReady = function () {
	return (this.getState() === 'normal');
};

DnsUdpSocket.prototype.cancel = function (req) {
	mod_assert.object(req, 'request');
	mod_assert.number(req.header.id, 'request id');
	var id = req.header.id;
	if (this.dus_requests[id] === req) {
		req.dm_socket = undefined;
		delete (this.dus_requests[id]);
		if (Object.keys(this.dus_requests).length < 1) {
			if (this.dus_ending)
				this.emit('lastRequestCancelled');
			else
				this.dus_socket.unref();
		}
	}
};

DnsUdpSocket.prototype.end = function () {
	this.dus_ending = true;
	if (Object.keys(this.dus_requests).length < 1)
		this.emit('endAsserted');
};

DnsUdpSocket.prototype.state_bind = function (S) {
	S.validTransitions(['error', 'normal']);
	var self = this;

	this.dus_socket = mod_dgram.createSocket(this.dus_options.family);
	this.dus_socket.dus = this;
	S.on(this.dus_socket, 'error', function (err) {
		self.dus_lastError = err;
		S.gotoState('error');
	});
	S.on(this.dus_socket, 'listening', function () {
		S.gotoState('normal');
	});
	this.dus_socket.bind({
		address: this.dus_options.bindAddress
	});
};

DnsUdpSocket.prototype.state_error = function (S) {
	S.validTransitions([]);
	var self = this;
	Object.keys(this.dus_requests).forEach(function (k) {
		var req = self.dus_requests[k];
		req.emit('error', self.dus_lastError);
		delete (self.dus_requests[k]);
	});
	delete (this.dus_socket);
	this.emit('error', this.dus_lastError);
};

DnsUdpSocket.prototype.state_normal = function (S) {
	S.validTransitions(['error', 'closed']);
	var self = this;
	S.on(this.dus_socket, 'message', function (msg, rinfo) {
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
			if (Object.keys(self.dus_requests).length < 1) {
				if (self.dus_ending)
					S.gotoState('closed');
				else
					self.dus_socket.unref();
			}
		}
		req.emit('reply', new DnsMessage(reply), doneCb);
	});
	S.on(this, 'lastRequestCancelled', function () {
		if (self.dus_ending)
			S.gotoState('closed');
	});
	S.on(this, 'endAsserted', function () {
		S.gotoState('closed');
	});
	S.on(this.dus_socket, 'error', function (err) {
		self.dus_lastError = err;
		S.gotoState('error');
	});
	S.on(this.dus_socket, 'close', function () {
		self.dus_lastError = new Error('Socket unexpectedly closed');
		S.gotoState('error');
	});
	S.immediate(function () {
		self.emit('ready');
	});
};

DnsUdpSocket.prototype.state_closed = function (S) {
	S.validTransitions([]);
	this.dus_socket.close();
	delete (this.dus_socket);
	mod_assert.strictEqual(Object.keys(this.dus_requests).length, 0,
	    'DNS UDP socket closed with outstanding requests');
};
