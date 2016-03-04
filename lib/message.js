/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2016, Joyent, Inc.
 */

module.exports = DnsMessage;

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
	this.code = code;
	this.name = 'DnsError';
	this.message = ERR_CODES[code] || 'DNS error code ' + this.code;
}
mod_util.inherits(DnsError, Error);

function DnsMessage(parsed) {
	mod_events.EventEmitter.call(this);
	if (parsed) {
		this.header = parsed.header;
		this.question = parsed.question;
		this.answer = parsed.answer;
		this.authority = parsed.authority;
		this.additional = parsed.additional;
	} else {
		this.header = {
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
	return (this.header.flags.rcode !== mod_proto.rCodes.NOERROR);
};

DnsMessage.prototype.toError = function () {
	return (new DnsError(this.header.flags.rcode));
};

function convertRecord(obj) {
	var newObj = {
		name: obj.name,
		type: mod_proto.queryTypes[obj.rtype],
		class: mod_proto.qClasses[obj.rclass],
		ttl: obj.rttl
	};
	Object.keys(obj.rdata).forEach(function (k) {
		newObj[k] = obj.rdata[k];
	});
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

DnsMessage.prototype.addEDNS = function (maxSize) {
	mod_assert.number(maxSize);
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
