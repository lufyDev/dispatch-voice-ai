/**
 * Resampling DSP, shared by the AudioWorklet and the Node tests so there is one
 * implementation and it is the one that gets verified.
 *
 * No Web Audio, no DOM -- pure arithmetic.
 */

/**
 * Windowed-sinc low-pass FIR taps.
 *
 * Required before any decimation. Going 48k -> 8k, the result can only hold
 * frequencies under 4kHz (Nyquist). Content above that does NOT disappear when
 * you drop samples -- it folds back as a mirror image. A 6kHz tone reappears at
 * |6000 - 8000| = 2000Hz. Unrecoverable once done. scripts/test-dsp.js measures
 * exactly this.
 *
 * Cutoff 3400Hz: the real telephone passband is 300-3400Hz, and stopping there
 * leaves the filter room to roll off before the 4kHz limit.
 *
 * n = 49, odd so the filter is symmetric and therefore linear-phase: every
 * frequency is delayed by the same 24 samples, so the waveform is delayed
 * rather than smeared.
 */
export function lowpassTaps(cutoffHz, sampleRate, n = 49) {
  const fc = cutoffHz / sampleRate;
  const mid = (n - 1) / 2;
  const h = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const k = i - mid;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
    h[i] = sinc * hamming;
  }
  // Normalise to unity gain at DC, or the whole signal changes volume.
  const sum = h.reduce((a, b) => a + b, 0);
  return Array.from(h, (v) => v / sum);
}

/**
 * Streaming FIR-then-decimate, emitting fixed-size PCM16 frames.
 *
 * Streaming is the whole difficulty. The audio thread hands us 128 samples at a
 * time; 128/6 = 21.33, so neither the decimation phase nor the output frame
 * boundary lines up with the input blocks. Both counters live on `this` and
 * carry across calls. Reset either one per block and you get a click every
 * 2.7ms.
 *
 * Pass taps = null to decimate WITHOUT filtering -- only useful for
 * demonstrating what aliasing sounds like, which the test does.
 */
export class Decimator {
  constructor({ taps, factor, frameSamples }) {
    this.h = taps ? Float32Array.from(taps) : null;
    this.factor = factor;
    this.frameSamples = frameSamples;

    this.hist = new Float32Array(this.h ? this.h.length : 1);
    this.histPos = 0;

    this.phase = 0;
    this.frame = new Int16Array(frameSamples);
    this.frameLen = 0;
  }

  /** Push Float32 input samples. Returns an array of completed Int16Array frames. */
  push(samples) {
    const out = [];

    for (let i = 0; i < samples.length; i += 1) {
      this.hist[this.histPos] = samples[i];
      this.histPos = (this.histPos + 1) % this.hist.length;

      this.phase += 1;
      if (this.phase < this.factor) continue; // drop 5 of 6 -- AFTER filtering
      this.phase = 0;

      let acc;
      if (this.h) {
        // Dot the taps against the history, newest first. Evaluating the filter
        // only on samples we keep costs 1/6 of filtering everything first.
        acc = 0;
        let p = this.histPos;
        for (let k = 0; k < this.h.length; k += 1) {
          p = p === 0 ? this.hist.length - 1 : p - 1;
          acc += this.h[k] * this.hist[p];
        }
      } else {
        acc = samples[i]; // naive: take every Nth sample and hope
      }

      // Float [-1,1] -> PCM16. Asymmetric: int16 is -32768..32767.
      const s = acc < -1 ? -1 : acc > 1 ? 1 : acc;
      this.frame[this.frameLen] = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.frameLen += 1;

      if (this.frameLen === this.frameSamples) {
        out.push(this.frame.slice());
        this.frameLen = 0;
      }
    }

    return out;
  }
}
