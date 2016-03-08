/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2016, Joyent, Inc.
 */

module.exports = {
	DnsClient: DnsClient
};

const mod_assert = require('assert-plus');
const mod_bloom = require('bloomfilter');
const mod_events = require('events');
const mod_net = require('net');
const mod_fs = require('fs');
const mod_verror = require('verror');
const mod_util = require('util');

const mod_named = require('named');
const mod_proto = mod_named.Protocol;

const mod_message = require('./message');
const mod_sockets = require('./sockets');

var systemResolvers = new mod_events.EventEmitter();

mod_fs.readFile('/etc/resolv.conf', 'ascii',
    function (err, file) {
	if (err) {
		systemResolvers.value = ['8.8.8.8', '8.8.4.4'];
		systemResolvers.emit('ready');
		return;
	}
	systemResolvers.value = [];
	file.split(/\n/).forEach(function (line) {
		var m = line.match(
		    /^\s*nameserver\s*([^\s]+)\s*$/);
		if (m && mod_net.isIP(m[1])) {
			systemResolvers.value.push(m[1]);
		}
	});
	systemResolvers.emit('ready');
});

function DnsClient(options) {
	mod_assert.optionalObject(options, 'options');
	if (options === undefined)
		options = {};
	this.dc_options = options;

	mod_assert.optionalArrayOfString(options.resolvers,
	    'options.resolvers');
	this.dc_resolvers = options.resolvers;

	this.dc_socks = {};
	mod_assert.optionalNumber(options.concurrency, 'options.concurrency');
	this.dc_concur = options.concurrency || 3;

	this.dc_tcpNeeded = new mod_bloom.BloomFilter(8 * 1024, 16);
}

DnsClient.prototype.close = function () {
	var self = this;
	Object.keys(this.dc_socks).forEach(function (k) {
		self.dc_socks[k].end();
		delete (self.dc_socks[k]);
	});
};

DnsClient.prototype.lookup = function (options, cb) {
	var self = this;
	var obj = {};
	mod_assert.object(options, 'options');
	mod_assert.optionalArrayOfString(options.resolvers,
	    'options.resolvers');
	mod_assert.string(options.domain, 'options.domain');
	mod_assert.string(options.type, 'options.type');
	mod_assert.number(options.timeout, 'options.timeout');

	var resolvers = options.resolvers || this.dc_resolvers;
	if (resolvers === undefined) {
		if (systemResolvers.value) {
			resolvers = systemResolvers.value;
		} else {
			obj.cancel = function () {
				obj.cancelled = true;
			};
			systemResolvers.once('ready', function () {
				if (obj.cancelled)
					return;
				self.dc_resolvers = systemResolvers.value;
				var nobj = self.lookup(options, cb);
				obj.cancel = nobj.cancel;
			});
			return (obj);
		}
	}
	mod_assert.arrayOfString(resolvers);

	resolvers = shuffle(resolvers.slice()).slice(0, this.dc_concur);
	var errs = [];
	var reqs = [];
	var gotAnswer = false;
	var cancelled = false;

	resolvers.forEach(function (res) {
		var opts = {
			resolver: res,
			domain: options.domain,
			type: options.type,
			timeout: options.timeout
		};
		reqs.push(self.lookupOnce(opts, function (err, msg) {
			if (err) {
				errs.push(err);
				if (errs.length >= resolvers.length) {
					var e = new mod_verror.MultiError(errs);
					cb(e);
				}
			} else if (!gotAnswer && !cancelled) {
				gotAnswer = true;
				reqs.forEach(function (req) {
					req.cancel();
				});
				cb(null, msg);
			}
		}));
	});

	obj.cancel = function () {
		cancelled = true;
		reqs.forEach(function (req) {
			req.cancel();
		});
	};

	return (obj);
};

DnsClient.prototype.lookupOnce = function (options, cb) {
	var self = this;
	mod_assert.object(options, 'options');
	mod_assert.string(options.resolver, 'options.resolver');
	mod_assert.string(options.domain, 'options.domain');
	mod_assert.string(options.type, 'options.type');
	mod_assert.number(options.timeout, 'options.timeout');
	mod_assert.optionalString(options.protocol, 'options.protocol');

	var protocol = 'udp';
	var key = options.domain + '|' + options.type;
	if (this.dc_tcpNeeded.test(key))
		protocol = 'tcp';

	var req = new mod_message.DnsMessage();
	req.addQuestion(options.domain, options.type);
	req.addEDNS({ maxUDPLength: 1420 });

	var timer = setTimeout(function () {
		if (timer !== undefined) {
			timer = undefined;
			req.cancel();
			cb(new TimeoutError(options.domain));
		}
	}, options.timeout);

	function onError(err) {
		if (timer === undefined)
			return;
		clearTimeout(timer);
		sock.removeListener('error', onSockError);
		timer = undefined;
		cb(err);
	}

	req.once('error', onError);
	req.once('reply', function (msg, done) {
		var err = msg.toError();
		if (err && err instanceof mod_message.TruncationError &&
		    protocol === 'udp') {
			self.dc_tcpNeeded.add(
			    options.domain + '|' + options.type);

			var nopts = Object.create(options);
			nopts.protocol = 'tcp';
			var nreq = self.lookupOnce(nopts, cb);
			clearTimeout(timer);
			timer = undefined;
			req.cancel = function () {
				nreq.cancel();
			};
			done();
			return;
		}
		if (err) {
			done();
			onError(err);
			return;
		}

		sock.removeListener('error', onSockError);

		clearTimeout(timer);
		timer = undefined;
		done();

		cb(null, msg);
	});

	var sock, family;
	if (protocol === 'udp') {
		family = mod_net.isIPv4(options.resolver) ? 'udp4' : 'udp6';
		if (this.dc_socks[family]) {
			sock = this.dc_socks[family];
		} else {
			sock = new mod_sockets.DnsUdpSocket({ family: family });
			this.dc_socks[family] = sock;
		}
	} else if (protocol === 'tcp') {
		sock = new mod_sockets.DnsTcpSocket({
			address: options.resolver,
			port: 53
		});
	}
	if (!sock.isReady())
		sock.once('ready', onReady);
	else
		onReady();

	function onReady() {
		sock.unref();
		sock.send(req, {
			address: options.resolver,
			port: 53
		});
		if (protocol !== 'udp')
			sock.end();
	}
	sock.once('error', onSockError);

	function onSockError(err) {
		if (sock === self.dc_socks[family])
			delete (self.dc_socks[family]);
		onError(err);
	}

	return (req);
};

function TimeoutError(domain) {
	if (Error.captureStackTrace)
		Error.captureStackTrace(this, TimeoutError);
	this.name = 'TimeoutError';
	this.message = 'DNS request for "' + domain + '" timed out';
}
mod_util.inherits(TimeoutError, Error);

/* A Fisher-Yates shuffle. */
function shuffle(array) {
	var i = array.length;
	while (i > 0) {
		var j = Math.floor(Math.random() * i);
		--i;
		var temp = array[i];
		array[i] = array[j];
		array[j] = temp;
	}
	return (array);
}
