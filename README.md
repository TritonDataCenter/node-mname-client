# node-named-client

A DNS client library using the packet parsing/generating code from node-named.

## Example (low-level API)

```js
const mod_named_client = require('named-client');

var req = new mod_named_client.DnsMessage();

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

var sock = new mod_named_client.DnsTcpSocket({
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

var sock = new mod_named_client.DnsUdpSocket({ family: 'udp4' });
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
