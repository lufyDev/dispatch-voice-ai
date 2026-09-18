import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import { WebSocketServer } from 'ws';

import { TwilioTransport } from './transport/twilio.js';
import { BrowserTransport } from './transport/browser.js';
import { attachEcho } from './pipeline/echo.js';

const PORT = process.env.PORT || 3000;

const app = express();

// Twilio posts webhooks as application/x-www-form-urlencoded, not JSON.
app.use(express.urlencoded({ extended: false }));

// The browser dev client.
app.use(express.static('public'));

/**
 * Where Twilio should open the media-stream WebSocket.
 *
 * Behind ngrok the Host header is already the public hostname, so we derive the
 * URL from the request and never touch .env when the tunnel restarts. Free-tier
 * ngrok hands out a new subdomain every start; forgetting to update a hardcoded
 * value fails silently (the caller hears nothing and the call drops).
 * PUBLIC_HOST overrides it -- you'd pin that in prod, where you don't want the
 * URL you hand out to be settable by a spoofed Host header.
 */
function mediaStreamUrl(req) {
  const host = process.env.PUBLIC_HOST || req.headers.host;
  return `wss://${host}/media`;
}

// Twilio hits this when a call arrives and asks, in effect, "what do I do with
// this call?". We answer with TwiML: a list of instructions.
//
// <Connect><Stream> hands the call TO our WebSocket and blocks there until we
// close it or the caller hangs up. Audio flows both ways.
// (<Start><Stream> would fork a one-way copy and let the call continue past it,
// so we could listen but never speak. Wrong verb for an echo, and it fails
// silently -- audio arrives, our frames go nowhere, the caller hears nothing.)
//
// GET is only so we can eyeball the TwiML in a browser; Twilio always POSTs.
app.all('/voice', (req, res) => {
  const url = mediaStreamUrl(req);
  console.log(`[voice] ${req.method} incoming call from=${req.body?.From} -> ${url}`);

  res.type('text/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${url}" />
  </Connect>
</Response>`
  );
});

// Express and the WebSockets share one HTTP server, and therefore one port --
// we only get one ngrok tunnel, so /voice, /media and /browser must live
// together.
const server = http.createServer(app);

// noServer, and we route the upgrade ourselves. NOT two
// `new WebSocketServer({ server, path })` instances: each of those registers its
// own 'upgrade' listener, and whichever fires first checks the path, doesn't
// match, and aborts the socket with a 400 before the other one is ever consulted.
// The second endpoint then looks like it simply doesn't exist.
//
// This is also the dispatch that `{ server, path }` was hiding from us.
const twilioWss = new WebSocketServer({ noServer: true });
const browserWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  const target = pathname === '/media' ? twilioWss
    : pathname === '/browser' ? browserWss
    : null;

  if (!target) {
    socket.destroy();
    return;
  }
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});

// One transport per call. Nothing about a call may live in module scope, or a
// second simultaneous caller corrupts the first.
//
// Both lines hand the SAME pipeline two different transports. That reuse is the
// only real evidence the Transport interface is worth anything.
twilioWss.on('connection', (socket) => {
  attachEcho(new TwilioTransport(socket), { label: 'twilio' });
});

browserWss.on('connection', (socket) => {
  attachEcho(new BrowserTransport(socket), { label: 'browser' });
});

server.listen(PORT, () => {
  console.log(`[boot] http://localhost:${PORT}  ws://localhost:${PORT}/media`);
});
