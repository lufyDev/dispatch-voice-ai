/**
 * Energy VAD vs Silero VAD, on identical audio, in milliseconds.
 *
 *   node scripts/test-vad.js
 *
 * The comparison IS the point. "Silero is better" is not a claim until you can
 * say better than what, by how much, and under what conditions.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { EnergyVAD } from '../src/vad/energy.js';
import { SileroVAD } from '../src/vad/silero.js';

const RATE = 8000;
const FRAME_BYTES = 320;
const LEAD_MS = 600;
const TAIL_MS = 1200;

function wavPcm(buf) {
  let i = 12;
  while (i < buf.length) {
    const id = buf.toString('ascii', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    if (id === 'data') return buf.subarray(i + 8, i + 8 + size);
    i += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

function render(text) {
  const tmp = `/tmp/vadcmp-${process.pid}.wav`;
  execFileSync('say', ['-v', 'Samantha', '--data-format=LEI16@8000', '--file-format=WAVE', '-o', tmp, text]);
  const pcm = wavPcm(readFileSync(tmp));
  unlinkSync(tmp);
  return pcm;
}

function addNoise(pcm, rms) {
  const out = Buffer.from(pcm);
  const amp = rms * 32768 * 1.73;
  for (let i = 0; i < out.length / 2; i += 1) {
    const v = out.readInt16LE(i * 2) + (Math.random() * 2 - 1) * amp;
    out.writeInt16LE(Math.round(Math.max(-32768, Math.min(32767, v))), i * 2);
  }
  return out;
}

/** A single loud non-speech transient: a door slam. Energy's blind spot. */
function slam(ms) {
  const n = Math.round(RATE * ms / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    const decay = Math.exp(-i / (n / 4));
    buf.writeInt16LE(Math.round((Math.random() * 2 - 1) * 26000 * decay), i * 2);
  }
  return buf;
}

async function run(vad, pcm) {
  const events = [];
  vad.on('speechStart', ({ atMs }) => events.push(['start', atMs]));
  vad.on('speechEnd', ({ atMs }) => events.push(['end', atMs]));
  vad.on('error', (e) => console.error('  vad error:', e.message));

  const frames = Math.floor(pcm.length / FRAME_BYTES);
  const t0 = performance.now();
  for (let i = 0; i < frames; i += 1) {
    vad.push(pcm.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES), i * 20);
  }
  if (vad.drain) await vad.drain();
  const cpuMs = performance.now() - t0;

  const starts = events.filter((e) => e[0] === 'start');
  return {
    firstStart: starts[0]?.[1],
    nStarts: starts.length,
    perFrameUs: (cpuMs / frames) * 1000,
  };
}

const pad = (ms) => Buffer.alloc(Math.round(RATE * ms / 1000) * 2);
const speech = render('my furnace is making a loud banging noise and there is no hot water');
const speechMs = (speech.length / 2 / RATE) * 1000;

const cases = [];
cases.push(['clean', Buffer.concat([pad(LEAD_MS), speech, pad(TAIL_MS)]), LEAD_MS, true]);
for (const rms of [0.01, 0.03, 0.06]) {
  const snr = (20 * Math.log10(EnergyVAD.rms(speech) / rms)).toFixed(0);
  cases.push([`noise SNR ~${snr}dB`, addNoise(Buffer.concat([pad(LEAD_MS), speech, pad(TAIL_MS)]), rms), LEAD_MS, true]);
}
// No speech at all, just a door slam. Truth: there is nothing to detect.
cases.push(['door slam, NO speech', Buffer.concat([pad(600), slam(180), pad(1200)]), null, false]);

console.log(`speech runs ${LEAD_MS}ms -> ${(LEAD_MS + speechMs).toFixed(0)}ms\n`);
console.log('condition                  energy                      silero');
console.log('-------------------------  --------------------------  --------------------------');

for (const [label, pcm, truth, hasSpeech] of cases) {
  const e = await run(new EnergyVAD({ sampleRate: RATE }), pcm);
  const s = await run(new SileroVAD({ sampleRate: RATE }), pcm);

  const fmt = (r) => {
    if (!hasSpeech) {
      return r.nStarts === 0
        ? 'correctly silent'.padEnd(26)
        : `FALSE TRIGGER (${r.nStarts})`.padEnd(26);
    }
    if (r.firstStart === undefined) return 'MISSED SPEECH'.padEnd(26);
    const off = r.firstStart - truth;
    return `start ${off >= 0 ? '+' : ''}${off}ms, ${r.nStarts} seg`.padEnd(26);
  };
  console.log(`${label.padEnd(25)}  ${fmt(e)}  ${fmt(s)}`);
}

// Cost, measured once on the clean case.
const clean = Buffer.concat([pad(LEAD_MS), speech, pad(TAIL_MS)]);
const ec = await run(new EnergyVAD({ sampleRate: RATE }), clean);
const sc = await run(new SileroVAD({ sampleRate: RATE }), clean);
console.log(`\ncost per 20ms frame:  energy ${ec.perFrameUs.toFixed(0)}us   silero ${sc.perFrameUs.toFixed(0)}us`);
console.log('(a 20ms frame gives a 20000us budget, so both are far inside it)');
