import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import { WebSocketServer } from 'ws';

import { TwilioTransport } from './transport/twilio.js';
import { BrowserTransport } from './transport/browser.js';
import { attachEcho } from './pipeline/echo.js';
import { attachTranscribe } from './pipeline/transcribe.js';
import { attachConverse } from './pipeline/converse.js';
import { DeepgramASR } from './asr/deepgram.js';
import { OpenAILLM } from './llm/openai.js';
import { ElevenLabsTTS } from './tts/elevenlabs.js';
import { DISPATCHER_PROMPT } from './prompts/dispatcher.js';

const PORT = process.env.PORT || 3000;
const PIPELINE = process.env.PIPELINE || 'converse'; // 'echo' | 'transcribe' | 'converse'

// Words a home-services caller says that an 8kHz phone line mangles. Telling
// the model to expect them is the cheapest accuracy win available.
const HVAC_TERMS = [
  'HVAC', 'furnace', 'condenser', 'compressor', 'thermostat', 'refrigerant',
  'ductwork', 'heat pump', 'boiler', 'radiator', 'water heater', 'AC unit',
  'circuit breaker', 'pilot light', 'coolant leak', 'clogged drain',
  'sump pump', 'garbage disposal', 'burst pipe', 'no hot water',
];

// One instance each, for the life of the process. They hold configuration, not
// per-call state, and building them per call meant the connection warming could
// not start until a call already existed.
const llm = new OpenAILLM({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
});
const tts = new ElevenLabsTTS({
  apiKey: process.env.ELEVENLABS_API_KEY,
  voiceId: process.env.ELEVENLABS_VOICE_ID,
  model: process.env.ELEVENLABS_MODEL,
});

/**
 * Open the vendor connections before the call needs them.
 *
 * Called as early as we possibly can: at the TwiML webhook for a phone call,
 * and at page load for the browser. Warming when the media WebSocket opens was
 * too late -- a caller who greets immediately (measured: speech at 1024ms)
 * leaves nothing to hide a 400-1200ms handshake behind, and that first turn's
 * LLM hop stayed at 1958ms against ~650ms steady state.
 *
 * Deliberately fire-and-forget, and rate-limited: undici keeps pooled
 * connections alive for a while, so re-warming inside that window is wasted
 * work.
 */
const WARM_EVERY_MS = 60_000;
let lastWarm = 0;
function warmVendors(reason) {
  if (!process.env.OPENAI_API_KEY || !process.env.ELEVENLABS_API_KEY) return;
  const now = Date.now();
  if (now - lastWarm < WARM_EVERY_MS) return;
  lastWarm = now;
  Promise.all([llm.warm(), tts.warm()])
    .then(() => console.log(`[warm] llm + tts connections warmed (${reason})`))
    .catch(() => {});
}

const createAsr = ({ sampleRate }) => new DeepgramASR({
  apiKey: process.env.DEEPGRAM_API_KEY,
  model: process.env.DEEPGRAM_MODEL || 'nova-3',
  sampleRate,
  keyterms: HVAC_TERMS,
  endpointing: Number(process.env.DG_ENDPOINTING ?? 300),
  utteranceEndMs: Number(process.env.DG_UTTERANCE_END_MS ?? 1000),
  smartFormat: (process.env.DG_SMART_FORMAT ?? 'true') !== 'false',
});

/** Fail at connect time with a useful message, not mid-call with a 401. */
function missingKeys(needed) {
  return needed.filter((k) => !process.env[k]);
}

/** One pipeline per call. */
function attachPipeline(transport, label) {
  if (PIPELINE === 'echo') {
    attachEcho(transport, { label });
    return;
  }

  const needed = PIPELINE === 'converse'
    ? ['DEEPGRAM_API_KEY', 'OPENAI_API_KEY', 'ELEVENLABS_API_KEY']
    : ['DEEPGRAM_API_KEY'];
  const missing = missingKeys(needed);
  if (missing.length) {
    console.error(`[boot] missing ${missing.join(', ')} — set them, or run PIPELINE=echo`);
    transport.close();
    return;
  }

  if (PIPELINE === 'transcribe') {
    attachTranscribe(transport, createAsr, { label });
    return;
  }

  attachConverse(transport, { createAsr, llm, tts, systemPrompt: DISPATCHER_PROMPT, label });
}

const app = express();

// Twilio posts webhooks as application/x-www-form-urlencoded, not JSON.
app.use(express.urlencoded({ extended: false }));

// The browser dev client.
app.use(express.static('public'));

// The page calls this on load -- long before the mic starts, let alone before
// anyone speaks. The best cover we get.
app.post('/warm', (req, res) => {
  warmVendors('browser page load');
  res.status(204).end();
});

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

  // Twilio opens the media WebSocket a moment after reading this TwiML, so the
  // handshakes overlap the connect and the caller's first breath.
  warmVendors('twiml webhook');

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
  attachPipeline(new TwilioTransport(socket), 'twilio');
});

browserWss.on('connection', (socket) => {
  attachPipeline(new BrowserTransport(socket), 'browser');
});

server.listen(PORT, () => {
  console.log(`[boot] http://localhost:${PORT}  pipeline=${PIPELINE}`);
});
