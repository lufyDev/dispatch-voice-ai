/**
 * How good is the energy VAD, in milliseconds and in failures?
 *
 *   node scripts/test-vad.js
 *
 * Renders real speech with `say`, wraps it in known amounts of silence, and
 * checks where the VAD thinks speech starts and stops. Then repeats with noise
 * added, because "works on my headphones" is not a result.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { EnergyVAD } from '../src/vad/energy.js';

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
  const tmp = `/tmp/vadtest-${process.pid}.wav`;
  execFileSync('say', ['-v', 'Samantha', '--data-format=LEI16@8000', '--file-format=WAVE', '-o', tmp, text]);
  const pcm = wavPcm(readFileSync(tmp));
  unlinkSync(tmp);
  return pcm;
}

/** Add white noise at a given RMS to every sample. */
function addNoise(pcm, rms) {
  const out = Buffer.from(pcm);
  const amp = rms * 32768;
  for (let i = 0; i < out.length / 2; i += 1) {
    // Box-Muller would be tidier; uniform is plenty for a noise floor.
    const n = (Math.random() * 2 - 1) * amp * 1.73;
    const v = Math.max(-32768, Math.min(32767, out.readInt16LE(i * 2) + n));
    out.writeInt16LE(Math.round(v), i * 2);
  }
  return out;
}

function run(label, pcm, speechStartMs, speechEndMs) {
  const vad = new EnergyVAD({ sampleRate: RATE });
  const events = [];
  vad.on('speechStart', ({ atMs }) => events.push(['start', atMs]));
  vad.on('speechEnd', ({ atMs }) => events.push(['end', atMs]));

  const frames = Math.floor(pcm.length / FRAME_BYTES);
  for (let i = 0; i < frames; i += 1) {
    vad.push(pcm.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES), i * 20);
  }

  const starts = events.filter((e) => e[0] === 'start');
  const ends = events.filter((e) => e[0] === 'end');
  const firstStart = starts[0]?.[1];
  const lastEnd = ends.at(-1)?.[1];

  const fmt = (v, truth) => (v === undefined ? 'never' : `${v}ms (${v - truth >= 0 ? '+' : ''}${v - truth} vs truth)`);
  console.log(`\n${label}`);
  console.log(`  speech truly runs ${speechStartMs}ms -> ${speechEndMs}ms`);
  console.log(`  detected start: ${fmt(firstStart, speechStartMs)}`);
  console.log(`  detected end:   ${fmt(lastEnd, speechEndMs)}`);
  console.log(`  events: ${starts.length} start(s), ${ends.length} end(s)` +
    (starts.length > 1 ? '   <-- CHOPPED: speech split into fragments' : ''));
}

const speech = render('my furnace is making a loud banging noise and there is no hot water');
const speechMs = (speech.length / 2 / RATE) * 1000;
const pad = (ms) => Buffer.alloc((RATE * ms / 1000) * 2);
const clean = Buffer.concat([pad(LEAD_MS), speech, pad(TAIL_MS)]);

run('CLEAN (digital silence around speech)', clean, LEAD_MS, LEAD_MS + speechMs);

for (const noiseRms of [0.002, 0.01, 0.03]) {
  const noisy = addNoise(clean, noiseRms);
  const snr = (20 * Math.log10(EnergyVAD.rms(speech) / noiseRms)).toFixed(0);
  run(`NOISY  rms=${noiseRms} (SNR ~${snr}dB)`, noisy, LEAD_MS, LEAD_MS + speechMs);
}
