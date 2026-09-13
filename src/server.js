import 'dotenv/config';
import express from 'express';

const PORT = process.env.PORT || 3000;

const app = express();

// Twilio posts webhooks as application/x-www-form-urlencoded, not JSON.
app.use(express.urlencoded({ extended: false }));

/**
 * Where Twilio should open the media-stream WebSocket.
 *
 * Behind ngrok the Host header is already the public hostname, so we can derive
 * the URL from the request itself and never touch .env when the tunnel restarts.
 * PUBLIC_HOST overrides it — you'd pin that in prod, where you don't want the
 * URL you hand out to be attacker-controllable via a spoofed Host header.
 */
function mediaStreamUrl(req) {
  const host = process.env.PUBLIC_HOST || req.headers.host;
  return `wss://${host}/media`;
}

// Twilio hits this when a call arrives. We answer with TwiML: instructions for
// what to do with the call.
//
// <Connect><Stream> hands the call TO our WebSocket and blocks there until we
// close it or the caller hangs up. Audio flows both ways.
// (<Start><Stream> would fork a one-way copy and let the call continue past it —
// we could listen but never speak. Wrong verb for an echo.)
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

app.listen(PORT, () => {
  console.log(`[boot] http://localhost:${PORT}`);
});
