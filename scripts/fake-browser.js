/**
 * Pretends to be the browser page, so BrowserTransport is testable without a mic.
 *
 *   node scripts/fake-browser.js [wsUrl] [seconds]
 *
 * Deliberately mirrors scripts/fake-twilio.js: same tone, same 20ms framing,
 * same checks. The point is that the two transports should produce the same
 * pipeline behaviour over completely different wire formats -- JSON+base64+mu-law
 * for Twilio, binary PCM16 here.
 */
import WebSocket from 'ws';

const URL = process.argv[2] || 'ws://localhost:3000/browser';
const SECONDS = Number(process.argv[3] || 3);

const RATE = 8000;
const FRAME_SAMPLES = 160; // 20ms

// One second of 440Hz as PCM16, = exactly 50 frames of 160 samples.
const TONE = (() => {
  const pcm = Buffer.allocUnsafe(RATE * 2);
  for (let i = 0; i < RATE; i += 1) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / RATE) * 20000), i * 2);
  }
  return pcm;
})();
const frameAt = (n) => TONE.subarray((n % 50) * FRAME_SAMPLES * 2, ((n % 50) + 1) * FRAME_SAMPLES * 2);

const ws = new WebSocket(URL);
let sentFrames = 0;
let echoed = 0;
let mismatches = 0;
let firstSentAt = null;
let firstEchoAt = null;
const sentQueue = [];

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'start', callId: 'fake-browser' }));

  let chunk = 0;
  const total = SECONDS * 50;
  const startedAt = Date.now();

  const timer = setInterval(() => {
    if (firstSentAt === null) firstSentAt = Date.now();
    const frame = frameAt(chunk);
    sentQueue.push(Buffer.from(frame));
    ws.send(frame, { binary: true });
    sentFrames += 1;
    chunk += 1;

    if (chunk >= total) {
      clearInterval(timer);
      const wall = Date.now() - startedAt;
      console.log(`[fake-browser] sent ${sentFrames} frames = ${(sentFrames * 20) / 1000}s of audio in ${wall}ms wall`);
      const ttfe = firstEchoAt === null ? 'never' : `${firstEchoAt - firstSentAt}ms`;
      console.log(`[fake-browser] echoed back ${echoed} frames, first echo after ${ttfe}`);
      console.log(`[fake-browser] payload mismatches: ${mismatches}`);
      ws.send(JSON.stringify({ type: 'stop' }));
      ws.close();
    }
  }, 20);
});

ws.on('message', (data, isBinary) => {
  if (!isBinary) { console.log(`[fake-browser] control: ${data}`); return; }
  echoed += 1;
  if (firstEchoAt === null) firstEchoAt = Date.now();
  const expected = sentQueue.shift();
  if (!expected || !Buffer.from(data).equals(expected)) mismatches += 1;
});

ws.on('error', (err) => console.error('[fake-browser] error:', err.message));
