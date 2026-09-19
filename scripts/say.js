/**
 * Speak one or more turns into the pipeline, without a mic.
 *
 *   node scripts/say.js "my furnace is broken"
 *   node scripts/say.js "hi my basement is flooding" "my name is vishal" "42 oak street"
 *   WS=ws://localhost:3001/browser node scripts/say.js "..."
 *
 * macOS `say` emits 8kHz mono PCM16 natively, so the same sentence produces
 * byte-identical audio every run. Repeatable input is what makes latency numbers
 * comparable between runs, and it is the seed of the M7 regression suite.
 *
 * Multi-turn matters: several bugs only appear on turn 2+ (ASR clock drift, the
 * agent hearing itself, history growth). One connection, many turns.
 *
 * INTERRUPT_MS=1200 makes each turn start 1200ms after the agent BEGINS
 * speaking, instead of waiting politely for it to finish. That is barge-in, and
 * there is no other way to test it.
 *
 * A "|" in the text inserts PAUSE_MS of silence — a breath mid-sentence, which
 * `say` never produces on its own and which is exactly what splits a real
 * caller's turn in half:
 *
 *   node scripts/say.js "hi my | basement is flooding"
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';

const TEXTS = process.argv.slice(2);
if (TEXTS.length === 0) TEXTS.push('my furnace is making a loud banging noise');
const URL = process.env.WS || 'ws://localhost:3000/browser';
const VOICE = process.env.SAY_VOICE || 'Samantha';

const RATE = 8000;
const FRAME_BYTES = 160 * 2; // 20ms of PCM16
const LEAD_MS = 400;         // silence before speaking, so the ASR settles
// Silence inserted at a "|" — a mid-sentence breath. Longer than Deepgram's
// 300ms endpointing, so it really does split the utterance.
const PAUSE_MS = Number(process.env.PAUSE_MS || 500);
const TAIL_MS = 1500;        // silence after, so endpointing fires
// Talk over the agent this many ms after it starts speaking. 0 = wait politely.
const INTERRUPT_MS = Number(process.env.INTERRUPT_MS || 0);

/** `say` inserts an FLLR padding chunk, so audio does NOT start at byte 44. */
function wavPcm(buf) {
  let i = 12;
  while (i < buf.length) {
    const id = buf.toString('ascii', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    if (id === 'data') return buf.subarray(i + 8, i + 8 + size);
    i += 8 + size + (size % 2);
  }
  throw new Error('no data chunk in wav');
}

const pad = (ms) => Buffer.alloc(Math.round(RATE * ms / 1000) * 2);

function renderOne(text) {
  const tmp = `/tmp/dispatch-say-${process.pid}.wav`;
  execFileSync('say', ['-v', VOICE, '--data-format=LEI16@8000', '--file-format=WAVE', '-o', tmp, text]);
  const speech = wavPcm(readFileSync(tmp));
  unlinkSync(tmp);
  return speech;
}

function render(text) {
  const parts = text.split('|').map((p) => p.trim()).filter(Boolean);
  const chunks = [pad(LEAD_MS)];
  parts.forEach((part, i) => {
    if (i > 0) chunks.push(pad(PAUSE_MS));
    chunks.push(renderOne(part));
  });
  chunks.push(pad(TAIL_MS));
  return Buffer.concat(chunks);
}

// We must behave like a real playback device: the server waits for a `mark`
// before reopening the mic, so we report it only once the agent's audio would
// genuinely have finished. Answering instantly would defeat the test.
let agentAudioMs = 0;
let firstAudioAt = null;
let markResolve = null;

const ws = new WebSocket(URL);

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    if (firstAudioAt === null) firstAudioAt = Date.now();
    agentAudioMs += (data.length / 2 / RATE) * 1000;
    return;
  }
  const msg = JSON.parse(data);
  if (msg.type !== 'mark') return;
  const wait = Math.max(0, (firstAudioAt ?? Date.now()) + agentAudioMs - Date.now());
  console.log(`[say] agent spoke ${(agentAudioMs / 1000).toFixed(2)}s; acking mark in ${wait.toFixed(0)}ms`);
  setTimeout(() => {
    ws.send(JSON.stringify({ type: 'mark', name: msg.name }));
    markResolve?.();
    markResolve = null;
  }, wait);
});

// ONE continuous 20ms clock for the whole session, exactly like a real phone
// line or an open mic: it never stops, and it sends silence when nobody is
// talking. Bursting audio per turn and going quiet in between is the single
// most misleading thing a fake client can do -- the ASR counts time by the
// audio it receives, so gaps make its clock fall behind the call's, and every
// latency number drifts further with each turn.
const SILENCE = Buffer.alloc(FRAME_BYTES);
let outQueue = Buffer.alloc(0);
let drained = null;
let running = true;

function startClock() {
  let next = performance.now();
  const tick = () => {
    if (!running) return;
    let frame = SILENCE;
    if (outQueue.length >= FRAME_BYTES) {
      frame = outQueue.subarray(0, FRAME_BYTES);
      outQueue = outQueue.subarray(FRAME_BYTES);
      if (outQueue.length < FRAME_BYTES) { drained?.(); drained = null; }
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(frame, { binary: true });
    next += 20;
    // Schedule against a running target rather than trusting setInterval,
    // which measured 4% slow.
    setTimeout(tick, Math.max(0, next - performance.now()));
  };
  tick();
}

/** Queue an utterance; resolves once the last frame of it has gone out. */
function stream(pcm) {
  outQueue = Buffer.concat([outQueue, pcm]);
  return new Promise((done) => { drained = done; });
}

ws.on('open', async () => {
  ws.send(JSON.stringify({ type: 'start', callId: 'say-' + Date.now() }));
  startClock();

  for (const [i, text] of TEXTS.entries()) {
    console.log(`[say] turn ${i + 1}: "${text}"`);
    firstAudioAt = null;
    agentAudioMs = 0;
    await stream(render(text));
    if (INTERRUPT_MS > 0) {
      // Wait for the agent to START, then cut in. The clock keeps running
      // throughout, so the server hears us arrive mid-sentence.
      await new Promise((r) => {
        const started = setInterval(() => {
          if (firstAudioAt === null) return;
          clearInterval(started);
          setTimeout(r, INTERRUPT_MS);
        }, 20);
        setTimeout(() => { clearInterval(started); r(); }, 20000);
      });
      console.log(`[say] cutting in ${INTERRUPT_MS}ms after the agent started`);
    } else {
      // Wait for the agent to finish speaking before the next turn.
      await new Promise((r) => {
        markResolve = r;
        setTimeout(() => { if (markResolve === r) { markResolve = null; r(); } }, 20000);
      });
    }
  }

  running = false;
  ws.send(JSON.stringify({ type: 'stop' }));
  setTimeout(() => ws.close(), 300);
});

ws.on('error', (err) => console.error('[say] error:', err.message));
