/**
 * Does the anti-aliasing filter actually work?
 *
 *   node scripts/test-dsp.js
 *
 * The claim: going 48kHz -> 8kHz, a 6kHz tone cannot be represented (8kHz audio
 * tops out at 4kHz). If you decimate without filtering first, that tone does not
 * vanish -- it FOLDS BACK to |6000 - 8000| = 2000Hz and appears as a tone that
 * was never in the room. We measure both ways.
 *
 * Input is pushed in 128-sample blocks, matching what AudioWorklet hands us, so
 * the streaming phase/frame carry-over is what gets exercised.
 */
import { lowpassTaps, Decimator } from '../public/dsp.js';

const IN_RATE = 48000;
const OUT_RATE = 8000;
const FACTOR = IN_RATE / OUT_RATE;

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fail += 1;
};

/** Amplitude of a single frequency in a signal (one-bin DFT). */
function magnitudeAt(signal, freq, rate) {
  let re = 0;
  let im = 0;
  for (let i = 0; i < signal.length; i += 1) {
    const a = (2 * Math.PI * freq * i) / rate;
    re += signal[i] * Math.cos(a);
    im -= signal[i] * Math.sin(a);
  }
  return (2 * Math.hypot(re, im)) / signal.length;
}

/** Run a tone through a Decimator in 128-sample blocks; return float output. */
function run(freqHz, { taps }) {
  const d = new Decimator({ taps, factor: FACTOR, frameSamples: 160 });
  const out = [];
  const totalIn = IN_RATE; // 1 second
  const block = new Float32Array(128);
  for (let i = 0; i < totalIn; i += 128) {
    for (let j = 0; j < 128; j += 1) {
      block[j] = 0.5 * Math.sin((2 * Math.PI * freqHz * (i + j)) / IN_RATE);
    }
    for (const frame of d.push(block)) {
      for (const s of frame) out.push(s / 32768);
    }
  }
  return out;
}

const taps = lowpassTaps(3400, IN_RATE);

// 0. Sanity: output length. 1s of 48kHz -> 8000 samples -> 50 frames of 160.
const passband = run(1000, { taps });
check('1s of 48kHz in -> 8000 samples out', passband.length === 8000,
  `got ${passband.length} (${passband.length / 160} frames of 160)`);

// 1. A 1kHz tone is inside the passband and must survive at full amplitude.
const kept = magnitudeAt(passband, 1000, OUT_RATE);
check('1kHz passes through intact', kept > 0.45 && kept < 0.55,
  `amplitude ${kept.toFixed(4)} (input was 0.5000)`);

// 2. NAIVE decimation of 6kHz: the alias must show up at 2kHz. This is the bug
//    we are preventing, demonstrated rather than described.
const naive = run(6000, { taps: null });
const ghost = magnitudeAt(naive, 2000, OUT_RATE);
check('without a filter, 6kHz ALIASES to 2kHz', ghost > 0.4,
  `phantom 2kHz tone at amplitude ${ghost.toFixed(4)} — never present in the input`);

// 3. Filtered decimation of the same 6kHz tone: the alias must be gone.
const filtered = run(6000, { taps });
const suppressed = magnitudeAt(filtered, 2000, OUT_RATE);
const dB = (20 * Math.log10(suppressed / ghost)).toFixed(1);
check('with the filter, the 2kHz alias is suppressed', suppressed < 0.01,
  `amplitude ${suppressed.toFixed(6)} — ${dB} dB below the unfiltered alias`);

process.exit(fail === 0 ? 0 : 1);
