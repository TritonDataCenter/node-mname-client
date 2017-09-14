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
		var e = msg.toError('8.8.8.8');
		t.strictEqual(e.code, 'NXDOMAIN');
		t.strictEqual(e.resolver, '8.8.8.8');
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

mod_tape.test('use the parallel lookup api', function (t) {
	var client = new mod_nsc.DnsClient({
		resolvers: ['8.8.8.8', '8.8.4.4']
	});
	client.lookup({
		domain: 'google.com',
		type: 'A',
		timeout: 2000
	}, function (err, msg) {
		t.ifError(err);
		t.ok(!msg.isError());

		var ans = msg.getAnswers();
		t.ok(Array.isArray(ans));
		t.ok(ans.length > 0);
		t.strictEqual(ans[0].name, 'google.com');
		t.strictEqual(ans[0].type, 'A');
		t.ok(mod_net.isIPv4(ans[0].target));

		client.close();

		t.end();
	});
});

mod_tape.test('filter option', function (t) {
	var client = new mod_nsc.DnsClient({
		resolvers: ['8.8.8.8']
	});
	client.lookup({
		domain: 'google.com',
		type: 'A',
		timeout: 2000,
		filter: function (msg) {
			msg.clearFlag('recursionDesired');
		}
	}, function (err, msg) {
		/*
		 * This test is kinda crappy, since 8.8.8.8 can return either
		 * a reasonable response or SERVFAIL to queries without the RD
		 * bit set. No idea why. It's not RFC-compliant.
		 */
		if (err) {
			var errs = err.errors();
			err = errs[0];
			t.strictEqual(err.code, 'SERVFAIL');
		} else {
			t.ok(!msg.isError());
			t.ok(msg.getAnswers().length > 0);

			t.ok(!msg.testFlag('rd'));
			t.ok(msg.testFlag('ra'));
		}

		client.close();

		t.end();
	});
});

mod_tape.test('parallel lookup with failing resolvers', function (t) {
	var client = new mod_nsc.DnsClient({
		resolvers: ['192.0.2.1', '192.0.2.3', '8.8.8.8', '8.8.4.4']
	});
	client.lookup({
		domain: 'google.com',
		type: 'A',
		timeout: 2000
	}, function (err, msg) {
		t.ifError(err);
		t.ok(!msg.isError());

		var ans = msg.getAnswers();
		t.ok(Array.isArray(ans));
		t.ok(ans.length > 0);
		t.strictEqual(ans[0].name, 'google.com');
		t.strictEqual(ans[0].type, 'A');
		t.ok(mod_net.isIPv4(ans[0].target));

		client.close();

		t.end();
	});
});

mod_tape.test('parallel lookup timeout', function (t) {
	var client = new mod_nsc.DnsClient();
	client.lookup({
		resolvers: ['192.0.2.1', '192.0.2.3'],
		domain: 'google.com',
		type: 'A',
		timeout: 1000
	}, function (err, msg) {
		t.ok(err);
		client.close();
		t.end();
	});
});
