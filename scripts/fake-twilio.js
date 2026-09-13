/**
 * Pretends to be Twilio's media stream, so we can develop without a phone call.
 *
 *   node scripts/fake-twilio.js [wsUrl] [seconds]
 *
 * Sends the real message sequence — connected, start, media every 20ms, stop.
 * The audio is a 440Hz tone, mu-law, 160 bytes per frame, same as the real thing.
 * A tone rather than silence so the echo check means something: every returned
 * frame must be byte-identical to what we sent, which proves the server's
 * mu-law decode -> PCM -> re-encode round trip is lossless in situ.
 */
import WebSocket from 'ws';
import { encode } from '../src/audio/mulaw.js';

const URL = process.argv[2] || 'ws://localhost:3000/media';
const SECONDS = Number(process.argv[3] || 3);

const streamSid = 'MZ' + 'f'.repeat(30);
const callSid = 'CA' + 'f'.repeat(30);
// One second of 440Hz at 8kHz = 8000 mu-law bytes = exactly 50 frames of 160.
const TONE = (() => {
  const pcm = Buffer.allocUnsafe(8000 * 2);
  for (let i = 0; i < 8000; i += 1) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 8000) * 20000), i * 2);
  }
  return encode(pcm);
})();
const frameAt = (n) => TONE.subarray((n % 50) * 160, (n % 50) * 160 + 160);

const ws = new WebSocket(URL);
let seq = 0;
let echoed = 0;
let mismatches = 0;
let firstSentAt = null;
let firstEchoAt = null;
const sentPayloads = [];

// We are pretending to be Twilio, so we are also the thing that PLAYS the audio
// coming back. Just count it and note when the first frame returned.
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.event === 'media') {
    echoed += 1;
    if (firstEchoAt === null) firstEchoAt = Date.now();
    // Frames come back in order, so compare against the oldest unmatched send.
    if (msg.media.payload !== sentPayloads.shift()) mismatches += 1;
  }
});
const send = (obj) => ws.send(JSON.stringify({ ...obj, sequenceNumber: String(++seq) }));

ws.on('open', () => {
  // Real Twilio sends `connected` WITHOUT a sequenceNumber; numbering starts at
  // `start`. Keep the fake faithful or you'll build on a wrong assumption.
  ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  send({
    event: 'start',
    streamSid,
    start: {
      streamSid,
      callSid,
      accountSid: 'ACfake',
      tracks: ['inbound'],
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    },
  });

  let chunk = 0;
  const total = SECONDS * 50;
  const startedAt = Date.now();

  const timer = setInterval(() => {
    chunk += 1;
    if (firstSentAt === null) firstSentAt = Date.now();
    const payload = frameAt(chunk - 1).toString('base64');
    sentPayloads.push(payload);
    send({
      event: 'media',
      streamSid,
      media: {
        track: 'inbound',
        chunk: String(chunk),
        timestamp: String(chunk * 20), // audio clock: perfectly regular by definition
        payload: payload,
      },
    });

    if (chunk >= total) {
      clearInterval(timer);
      const wall = Date.now() - startedAt;
      console.log(`[fake] sent ${chunk} frames = ${(chunk * 20) / 1000}s of audio in ${wall}ms of wall time`);
      const ttfe = firstEchoAt === null ? 'never' : `${firstEchoAt - firstSentAt}ms`;
      console.log(`[fake] echoed back ${echoed} frames, first echo after ${ttfe}`);
      console.log(`[fake] payload mismatches: ${mismatches} (0 means mu-law decode->encode was lossless)`);
      send({ event: 'stop', streamSid, stop: { accountSid: 'ACfake', callSid } });
      ws.close();
    }
  }, 20);
});

ws.on('close', () => console.log(`[fake] socket closed after ${seq} messages`));
ws.on('error', (err) => console.error('[fake] error:', err.message));
