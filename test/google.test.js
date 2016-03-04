/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2016, Joyent, Inc.
 */

const mod_tape = require('tape');
const mod_nsc = require('../lib/index');
const mod_net = require('net');

mod_tape.test('look up google.com with 8.8.8.8', function (t) {
	var req = new mod_nsc.DnsMessage();
	req.addQuestion('google.com', 'A');
	t.ok(req.validate());

	req.on('error', function (err) {
		t.ifError(err);
	});
	req.on('reply', function (msg, done) {
		t.ok(!msg.isError());
		var ans = msg.getAnswers();
		t.ok(Array.isArray(ans));
		t.ok(ans.length > 0);
		t.strictEqual(ans[0].name, 'google.com');
		t.strictEqual(ans[0].type, 'A');
		t.ok(mod_net.isIPv4(ans[0].target));
		done();
		t.end();
	});

	var sock = new mod_nsc.DnsUdpSocket({ family: 'udp4' });
	sock.on('ready', function () {
		sock.send(req, { address: '8.8.8.8', port: 53 });
		sock.end();
	});
	sock.on('error', function (err) {
		t.ifError(err);
	});
});

mod_tape.test('look up a non-existent name with 8.8.8.8', function (t) {
	var req = new mod_nsc.DnsMessage();
	req.addQuestion('does-not-exist.example.com', 'A');
	t.ok(req.validate());

	req.on('error', function (err) {
		t.ifError(err);
	});
	req.on('reply', function (msg, done) {
		t.ok(msg.isError());
		var e = msg.toError();
		t.strictEqual(e.code, 'NXDOMAIN');
		done();
		t.end();
	});

	var sock = new mod_nsc.DnsUdpSocket({ family: 'udp4' });
	sock.on('ready', function () {
		sock.send(req, { address: '8.8.8.8', port: 53 });
		sock.end();
	});
	sock.on('error', function (err) {
		t.ifError(err);
	});
});
