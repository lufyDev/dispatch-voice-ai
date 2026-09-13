import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import { WebSocketServer } from 'ws';

import { TwilioTransport } from './transport/twilio.js';
import { attachEcho } from './pipeline/echo.js';

const PORT = process.env.PORT || 3000;

const app = express();

// Twilio posts webhooks as application/x-www-form-urlencoded, not JSON.
app.use(express.urlencoded({ extended: false }));

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

// Express and the WebSocket share one HTTP server, and therefore one port --
// we only get one ngrok tunnel, so /voice and /media must live together.
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media' });

wss.on('connection', (socket) => {
  // One transport per call. Nothing about a call may live in module scope, or a
  // second simultaneous caller corrupts the first.
  attachEcho(new TwilioTransport(socket), { label: 'twilio' });
});

server.listen(PORT, () => {
  console.log(`[boot] http://localhost:${PORT}  ws://localhost:${PORT}/media`);
});
