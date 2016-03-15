/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2016, Joyent, Inc.
 */

module.exports = {
	DnsMessage: DnsMessage,
	DnsError: DnsError,
	TruncationError: TruncationError
};

const mod_named = require('named');
const mod_proto = mod_named.Protocol;

const mod_assert = require('assert-plus');
const mod_util = require('util');

const mod_events = require('events');

const ERR_CODES = {};
ERR_CODES[mod_proto.rCodes.FORMERR] =
    'Invalid DNS packet format (FORMERR)';
ERR_CODES[mod_proto.rCodes.SERVFAIL] =
    'DNS server failure (SERVFAIL)';
ERR_CODES[mod_proto.rCodes.NXDOMAIN] =
    'Domain name not found (NXDOMAIN)';
ERR_CODES[mod_proto.rCodes.NOTIMP] =
    'DNS request type not implemented (NOTIMP)';
ERR_CODES[mod_proto.rCodes.REFUSED] =
    'DNS request refused by policy (REFUSED)';
ERR_CODES[mod_proto.rCodes.YXDOMAIN] =
    'Domain name found when none expected (YXDOMAIN)';
ERR_CODES[mod_proto.rCodes.XRRSET] =
    'DNS RR set found when none expected (XRRSET)';
ERR_CODES[mod_proto.rCodes.NOTAUTH] =
    'Server is not authoritative for DNS zone (NOTAUTH)';
ERR_CODES[mod_proto.rCodes.NOTZONE] =
    'DNS name not contained in given zone (NOTZONE)';

function DnsError(code) {
	if (Error.captureStackTrace)
		Error.captureStackTrace(this, DnsError);
	this.rcode = code;
	this.code = mod_proto.rCodes[code];
	this.name = 'DnsError';
	this.message = ERR_CODES[code] || 'DNS error code ' + this.code;
}
mod_util.inherits(DnsError, Error);

function TruncationError(code) {
	if (Error.captureStackTrace)
		Error.captureStackTrace(this, TruncationError);
	this.name = 'TruncationError';
	this.message = 'DNS packet truncated';
}
mod_util.inherits(TruncationError, Error);

function DnsMessage(parsed) {
	mod_events.EventEmitter.call(this);
	this.dm_socket = undefined;
	this.dm_cancelled = false;
	if (parsed) {
		this.header = parsed.header;
		this.question = parsed.question;
		this.answer = parsed.answer;
		this.authority = parsed.authority;
		this.additional = parsed.additional;
		var edns = this.additional.filter(function (rr) {
			return (rr.rtype === mod_proto.queryTypes.OPT);
		});
		if (edns.length > 0) {
			this.header.flags.rcode |= (edns[0].rttl & 0xf0) << 4;
		}
	} else {
		this.header = {
			id: 0,
			flags: {
				rcode: mod_proto.rCodes.NOERROR,
				rd: 1
			},
			qdCount: 0,
			anCount: 0,
			nsCount: 0,
			arCount: 0
		};
		this.question = [];
		this.answer = [];
		this.authority = [];
		this.additional = [];
	}
}
mod_util.inherits(DnsMessage, mod_events.EventEmitter);

DnsMessage.prototype.isError = function () {
	return (this.header.flags.rcode !== mod_proto.rCodes.NOERROR ||
	    this.header.flags.tc);
};

DnsMessage.prototype.toError = function () {
	if (this.header.flags.rcode === mod_proto.rCodes.NOERROR &&
	    this.header.flags.tc) {
		return (new TruncationError());
	}
	if (this.header.flags.rcode !== mod_proto.rCodes.NOERROR) {
		return (new DnsError(this.header.flags.rcode));
	}
	return (null);
};

function convertRecord(obj) {
	var type = mod_proto.queryTypes[obj.rtype];
	var newObj;
	if (type === 'OPT') {
		newObj = {
			name: obj.name,
			type: type,
			maxUDPLength: obj.rclass,
			version: obj.rttl & 0xf,
			options: obj.rdata.options
		};
	} else {
		newObj = {
			name: obj.name,
			type: type,
			class: mod_proto.qClasses[obj.rclass],
			ttl: obj.rttl
		};
		Object.keys(obj.rdata).forEach(function (k) {
			newObj[k] = obj.rdata[k];
		});
	}
	return (newObj);
}

DnsMessage.prototype.getAnswers = function () {
	var objs = this.answer.map(convertRecord);
	return (objs);
};

DnsMessage.prototype.getAuthority = function () {
	var objs = this.authority.map(convertRecord);
	return (objs);
};

DnsMessage.prototype.getAdditionals = function () {
	var objs = this.additional.map(convertRecord);
	return (objs);
};

DnsMessage.prototype.addQuestion = function (objOrName, type, qclass) {
	var obj = objOrName;
	if (typeof (objOrName) === 'string') {
		if (type === undefined)
			type = mod_proto.queryTypes.ANY;
		if (typeof (type) === 'string')
			type = mod_proto.queryTypes[type.toUpperCase()];
		if (qclass === undefined)
			qclass = mod_proto.qClasses.IN;
		if (typeof (qclass) === 'string')
			qclass = mod_proto.qClasses[qclass.toUpperCase()];
		obj = {
			name: objOrName,
			type: type,
			qclass: qclass
		};
	}
	mod_assert.string(obj.name);
	mod_assert.number(obj.qclass);
	mod_assert.number(obj.type);
	this.question.push(obj);
	this.header.qdCount++;
};

DnsMessage.prototype.addEDNS = function (options) {
	mod_assert.object(options, 'options');
	var maxSize = options.maxUDPLength;

	mod_assert.number(maxSize, 'maxUDPLength');
	mod_assert.ok(maxSize >= 512 && maxSize <= 65535);

	var obj = {
		name: '.',
		rtype: mod_proto.queryTypes.OPT,
		rclass: maxSize,
		rttl: 0,
		rdata: { options: [] }
	};
	this.additional.push(obj);
	this.header.arCount++;
};

DnsMessage.prototype.validate = function () {
	try {
		return (!!(mod_proto.encode(this, 'message')));
	} catch (e) {
		console.log(e.stack);
		return (false);
	}
};

DnsMessage.prototype.cancel = function () {
	if (this.dm_cancelled)
		return;

	if (this.dm_socket) {
		this.dm_socket.cancel(this);
	}
	this.dm_cancelled = true;
	this.emit('cancel');
};
