/**
 * Speak a sentence into the pipeline, without a mic.
 *
 *   node scripts/say.js "my furnace is making a banging noise"
 *   node scripts/say.js "..." ws://localhost:3000/browser
 *
 * macOS `say` can emit exactly what we need -- 8kHz mono PCM16 -- so the same
 * sentence produces byte-identical audio every run. Repeatable input is what
 * makes ASR latency numbers comparable, and it is the seed of the regression
 * suite M7 wants.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';

const TEXT = process.argv[2] || 'my furnace is making a loud banging noise';
const URL = process.argv[3] || 'ws://localhost:3000/browser';
const VOICE = process.env.SAY_VOICE || 'Samantha';

const RATE = 8000;
const FRAME_SAMPLES = 160;             // 20ms
const FRAME_BYTES = FRAME_SAMPLES * 2;
const TAIL_MS = 2000;                  // silence after speech, so endpointing fires

/** Find the data chunk properly -- `say` inserts an FLLR padding chunk, so the
 *  audio does NOT start at the usual byte 44. */
function wavPcm(buf) {
  let i = 12; // past "RIFF....WAVE"
  while (i < buf.length) {
    const id = buf.toString('ascii', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    if (id === 'data') return buf.subarray(i + 8, i + 8 + size);
    i += 8 + size + (size % 2);
  }
  throw new Error('no data chunk in wav');
}

const tmp = `/tmp/dispatch-say-${process.pid}.wav`;
execFileSync('say', ['-v', VOICE, '--data-format=LEI16@8000', '--file-format=WAVE', '-o', tmp, TEXT]);
const speech = wavPcm(readFileSync(tmp));
unlinkSync(tmp);

const silence = Buffer.alloc((RATE * TAIL_MS / 1000) * 2); // PCM16 zero = silence
const pcm = Buffer.concat([speech, silence]);
const totalFrames = Math.floor(pcm.length / FRAME_BYTES);

console.log(`[say] "${TEXT}"`);
console.log(`[say] ${(speech.length / 2 / RATE).toFixed(2)}s speech + ${TAIL_MS / 1000}s silence = ${totalFrames} frames`);

// We must behave like a real playback device, because the server now waits for
// a `mark` to come back before it reopens the mic. Track how much agent audio
// we have been handed, and report the mark only when that much time has passed
// -- answering instantly would defeat the very thing we are testing.
let firstAudioAt = null;
let agentAudioMs = 0;

const ws = new WebSocket(URL);
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'start', callId: 'say-' + Date.now() }));

  let n = 0;
  let next = performance.now();
  const startedAt = next;

  // Drift-corrected pacing: schedule against a running target rather than
  // trusting setInterval, which ran 4% slow when we measured it.
  const tick = () => {
    if (n >= totalFrames) {
      const wall = performance.now() - startedAt;
      console.log(`[say] sent ${n} frames (${(n * 20 / 1000).toFixed(2)}s audio) in ${wall.toFixed(0)}ms wall`);
      // Stay open so the agent can reply and we can answer its mark. Close once
      // no new agent audio has arrived for a while.
      let lastSeen = agentAudioMs;
      const idle = setInterval(() => {
        if (agentAudioMs !== lastSeen) { lastSeen = agentAudioMs; return; }
        if (firstAudioAt !== null && Date.now() < firstAudioAt + agentAudioMs) return;
        clearInterval(idle);
        ws.send(JSON.stringify({ type: 'stop' }));
        setTimeout(() => ws.close(), 300);
      }, 1500);
      return;
    }
    ws.send(pcm.subarray(n * FRAME_BYTES, (n + 1) * FRAME_BYTES), { binary: true });
    n += 1;
    next += 20;
    setTimeout(tick, Math.max(0, next - performance.now()));
  };
  tick();
});

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    if (firstAudioAt === null) firstAudioAt = Date.now();
    agentAudioMs += (data.length / 2 / RATE) * 1000; // PCM16 @ 8kHz
    return;
  }

  const msg = JSON.parse(data);
  if (msg.type === 'mark') {
    const playedOutAt = (firstAudioAt ?? Date.now()) + agentAudioMs;
    const wait = Math.max(0, playedOutAt - Date.now());
    console.log(`[say] agent sent ${(agentAudioMs / 1000).toFixed(2)}s of audio; mark "${msg.name}" in ${wait.toFixed(0)}ms`);
    setTimeout(() => ws.send(JSON.stringify({ type: 'mark', name: msg.name })), wait);
    return;
  }
  console.log(`[say] control: ${data}`);
});
ws.on('error', (err) => console.error('[say] error:', err.message));
