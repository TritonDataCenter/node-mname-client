# node-named-client

A DNS client library using the packet parsing/generating code from node-mname.

## Example

```js
const mod_mname_client = require('mname-client');

var client = new mod_name_client.DnsClient({
    /* Will try all of the set name servers in parallel. */
    resolvers: ['8.8.8.8', '8.8.4.4']
});

client.lookup({
    domain: 'google.com',
    type: 'AAAA',
    timeout: 3000
}, function (err, message) {
        if (err) {
                /* ... */
                return;
        }
        var ans = msg.getAnswers();
        /* ans will look like: */
        ans = [ { name: 'google.com',
          type: 'A',
          class: 'IN',
          ttl: 299,
          target: '216.58.192.14' } ];
});
```

## Example (low-level API)

```js
const mod_mname_client = require('mname-client');

var req = new mod_mname_client.DnsMessage();

req.addQuestion('google.com', 'A');
req.addEDNS({ maxUDPLength: 1480 });

req.on('error', function (err) {
  /*
   * For socket-level errors that occurred while our request was
   * outstanding
   */
  ...
});
req.on('reply', function (msg, done) {
  if (msg.isError()) {
    /* For successful DNS queries that returned an error code. */
    var e = msg.toError();
    ...
    done();
    return;
  }
  var ans = msg.getAnswers();
  /* ans will look like: */
  ans = [ { name: 'google.com',
    type: 'A',
    class: 'IN',
    ttl: 299,
    target: '216.58.192.14' } ];

  /*
   * Need to call done() to indicate that this query is complete.
   * This is important so that AXFR and similar queries that can result
   * in multiple replies know when they are finished (the receiver of
   * the results can tell by comparing the SOA at the top and bottom)
   */
  done();
});

var sock = new mod_mname_client.DnsTcpSocket({
  address: '8.8.8.8',
  port: 53
});
sock.on('ready', function () {
  /*
   * sock.send can throw if the query cannot be encoded (e.g. it's
   * way too big)
   */
  sock.send(req);

  /* Call end once you've added all pipelined queries you want. */
  sock.end();
});
sock.on('error', function (err) {
  /*
   * A socket-level error resulting in this connection being unusable.
   * If this happens after sock.send() was called in on('ready') above, then
   * we will get an 'error' event on the req as well.
   */
});

var sock = new mod_mname_client.DnsUdpSocket({ family: 'udp4' });
sock.on('ready', function () {
  /*
   * You have to provide a destination to send on a DnsUdpSocket, as you
   * can re-use the one bound socket for multiple destinations.
   */
  sock.send(req, { address: '8.8.8.8', port: 53 });

  /* Will cause the socket to close after the last outstanding query returns. */
  sock.end();
});
sock.on('error', function (err) {
  /* A socket-level error resulting in this socket being unusable. */
});
```

## API

### `new mod_mname_client.DnsClient([options])`

Parameters:
 - `options` -- an optional Object, with keys:
   * `resolvers` -- an optional Array of String, IP addresses of nameservers
     to use
   * `concurrency` -- an optional Number, max number of requests to send at
     once, default 3

### `DnsClient#close()`

Ends all sockets and waits for outstanding DNS requests to finish or time out
before closing.

### `DnsClient#lookup(options, cb)`

Look up a name and return the first successful result as a DnsMessage.

Parameters:
 - `options` -- Object, with keys:
   * `domain` -- String, domain to look up
   * `type` -- String, the query type (qtype), e.g. `"AAAA"`
   * `timeout` -- Number, milliseconds
   * `resolvers` -- optional Array of String, resolvers to use just for this
     request
   * `filter` -- optional Func `(msg)`, if provided will run on each DnsMessage
     before sending (useful to set flags or sign requests)
 - `cb` -- Func `(err, message)` with parameters:
   * `err` -- either `null` or an `Error` instance
   * `message` -- a DnsMessage (if `err` is `null`)

### `new mod_mname_client.DnsMessage()`

Construct a new, empty DNS message. The message is also an EventEmitter.

### `DnsMessage->error(err)`

Event emitted when the DNS message experiences an error because of a network
or system failure. This is not emitted if the message receives a reply that is
an error-type reply (e.g. `isError()` on the reply would return `true`).

Parameters:
 - `err` -- an Error object

### `DnsMessage->reply(msg)`

Event emitted when a reply to the DNS message is received.

Parameters:
 - `msg` -- a DnsMessage instance

### `DnsMessage#isError()`

Returns `true` if this message indicates an error (either by the rcode being
something other than `NOERROR`, or the truncation flag being set).

### `DnsMessage#toError([resolver])`

Converts the DnsMessage into an `Error` object with a descriptive message about
the error that occurred. The optional `resolver` parameter is included in the
Error messages.

If the DnsMessage does not represent any kind of error condition, this function
returns `null`. The returned errors will be named either `TruncationError` or
`DnsError`.

Parameters:
 - `resolver` -- optional String, resolver IP or name to include in error
   message

### `DnsMessage#getAnswers()`

Returns the answer part of the DNS message as an Array of Record Objects, of
the form:

```json
{
  "name": "domain.foo.com",
  "type": "AAAA",
  "class": "IN",
  "ttl": 30,
  "address": "abcd::1"
}
```

The `name`, `type`, `class` and `ttl` properties are available on all types of
record. Other fields such as `address` appear only on the relevant `type`.

### `DnsMessage#getAuthority()`

Returns the authority section of the DNS message as an Array of Record Objects
(see `getAnswers()`).

### `DnsMessage#getAdditionals()`

Returns the additional section of the DNS message as an Array of Record Objects
(see `getAnswers()`).

### `DnsMessage#testFlag(flag)`

Returns `true` if a given flag is set in the message header. Valid flag names:

 - `qr`, `response`
 - `aa`, `authoritative`
 - `rd`, `recursionDesired`
 - `ra`, `recursionAvailable`
 - `ad`, `authenticated`
 - `cd`, `noChecking`
 - `cd`, `checkingDisabled`

Parameters:
 - `flag` -- a String

### `DnsMessage#setFlag(flag)`
### `DnsMessage#clearFlag(flag)`

Sets or clears a given flag (see `testFlag()` for a list of values).

Parameters:
 - `flag` -- a String

### `DnsMessage#addQuestion(name, type, qclass)`

Adds a question section to the DNS message.

Parameters:
 - `name` -- a String, the domain name to be questioned
 - `type` -- a String, the record type desired (e.g. `'AAAA'`)
 - `qclass` -- a String, the query class (e.g. `'IN'`)

### `DnsMessage#addEDNS(options)`

Adds EDNS to the message.

Parameters
 - `options` -- an Object, with keys:
   * `maxUDPLength` -- a Number, the maximum length of UDP frames

### `new mod_mname_client.DnsTcpSocket(options)`

Creates a new TCP-based DNS client socket.

Parameters:
 - `options` -- an Object, with keys:
   * `address` -- a String, IP address of remote machine
   * `port` -- a Number, the port to connect to

### `new mod_mname_client.DnsUdpSocket(options)`

Creates a new UDP-based DNS client socket.

Parameters:
 - `options` -- an Object, with keys:
   * `family` -- a String, either `'udp4'` or `'udp6'`

### `DnsSocket->ready()`

Event emitted by `DnsTcpSocket` or `DnsUdpSocket` when the socket is open and
ready for use.

### `DnsSocket->error(err)`

Event emitted by `DnsTcpSocket` or `DnsUdpSocket` when a socket-level error is
experienced.

Parameters:
 - `err` -- an Error object

### `DnsSocket#end()`

Wait for any outstanding requests to complete, and then close the socket.

### `DnsSocket#isReady()`

Returns `true` if the socket has emitted the `->ready` event.

### `DnsSocket#send(msg[, destination])`

Sends a DnsMessage over the socket.

Parameters:
 - `msg` -- a DnsMessage object
 - `destination` -- a String, optional for TCP sockets, required for UDP (must
   be remote address to send message to)
