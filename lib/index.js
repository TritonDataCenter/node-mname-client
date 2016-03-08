/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2016, Joyent, Inc.
 */

const mod_sockets = require('./sockets');
const mod_message = require('./message');
const mod_client = require('./client');

module.exports = {
	DnsUdpSocket: mod_sockets.DnsUdpSocket,
	DnsTcpSocket: mod_sockets.DnsTcpSocket,
	DnsMessage: mod_message.DnsMessage,
	DnsClient: mod_client.DnsClient,
	DnsError: mod_message.DnsError,
	TruncationError: mod_message.TruncationError
};
