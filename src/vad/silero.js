import { createRequire } from 'node:module';
import { VAD } from './vad.js';

const require = createRequire(import.meta.url);

// Silero accepts only these rates, and each has one legal window size.
const WINDOW_SAMPLES = { 8000: 256, 16000: 512 };

/**
 * Samples of the PREVIOUS window that must be prepended to the current one.
 *
 * This is not documented on the ONNX graph, it lives in Silero's Python
 * wrapper, and getting it wrong is silent. The input dimension is dynamic, so
 * ONNX happily accepted a bare 256-sample window and returned plausible-looking
 * numbers -- a max probability of 0.37 on crystal-clear speech, which reads as
 * "this model is bad at 8kHz" rather than "you are calling it wrong".
 *
 * With the context prepended: max 1.000, 96% of speech windows over threshold.
 *
 * Exactly the class of detail an SDK hides and you then cannot debug.
 */
const CONTEXT_SAMPLES = { 8000: 32, 16000: 64 };

/**
 * Silero VAD v5 (ONNX).
 *
 * A small recurrent neural net trained on speech. It answers "what is the
 * probability that this 32ms window contains a human voice", so it recognises
 * the STRUCTURE of speech rather than its loudness. That is the whole
 * difference from EnergyVAD: a door slam is loud and is not speech, and energy
 * cannot tell them apart while this can.
 *
 * TWO THINGS THIS SHAPE FORCES
 *
 * 1. Inference is async, but VAD.push() is synchronous. And the model is
 *    RECURRENT -- each window's output depends on a state carried from the
 *    previous one -- so windows cannot be run concurrently or out of order.
 *    Hence a buffer plus a serialized pump. Inference is ~1ms, so at 50
 *    frames/sec the queue never backs up; if it ever did, that is real
 *    information and it would show as growing latency rather than corruption.
 *
 * 2. Its window is 256 samples (32ms) and our frames are 160 (20ms). They do
 *    not divide, so the leftover carries between calls -- the same framing
 *    problem as the mic decimator in M1.
 *
 * Loading is async too, so push() buffers until the session is ready, the same
 * way DeepgramASR queues audio until its socket opens. Dropping the caller's
 * first word to save a few lines is not a trade worth making.
 */
export class SileroVAD extends VAD {
  #ort;
  #session = null;
  #state;
  #sampleRate;
  #window;
  #context;         // samples carried from the previous window
  #contextSize;
  #threshold;
  #releaseThreshold;
  #startWindows;
  #endWindows;

  #pending = [];      // chunks of Float32Array awaiting inference
  #pendingLen = 0;
  #pumping = false;
  #clockMs = null;    // audio timestamp of the first pending sample

  #speechRun = 0;
  #silenceRun = 0;
  #active = false;

  lastLoudAtMs = -Infinity;

  constructor({
    sampleRate = 8000,
    modelPath = 'models/silero_vad.onnx',
    // Two thresholds, not one. A single threshold makes the decision chatter
    // when the probability sits near it; requiring a drop to 0.35 before
    // releasing is the same hysteresis idea as EnergyVAD's run counters,
    // applied to probability instead of loudness.
    threshold = 0.5,
    releaseThreshold = 0.35,
    // 2 windows = 64ms to confirm speech. Comparable to EnergyVAD's 60ms, so
    // the two are measured on equal terms.
    startWindows = 2,
    // 16 windows = 512ms hangover, matching EnergyVAD's 500ms.
    endWindows = 16,
  } = {}) {
    super();
    this.#sampleRate = sampleRate;
    this.#window = WINDOW_SAMPLES[sampleRate];
    if (!this.#window) {
      throw new Error(`silero supports 8000 or 16000 Hz, not ${sampleRate}`);
    }
    this.#contextSize = CONTEXT_SAMPLES[sampleRate];
    this.#context = new Float32Array(this.#contextSize);
    this.#threshold = threshold;
    this.#releaseThreshold = releaseThreshold;
    this.#startWindows = startWindows;
    this.#endWindows = endWindows;

    this.#ort = require('onnxruntime-node');
    this.#state = new Float32Array(2 * 1 * 128);

    this.#ort.InferenceSession.create(modelPath)
      .then((session) => {
        this.#session = session;
        this.#pump();
      })
      .catch((err) => this.emit('error', err));
  }

  get active() {
    return this.#active;
  }

  push(pcm, timestampMs) {
    if (this.#clockMs === null) this.#clockMs = timestampMs;

    const n = pcm.length / 2;
    const floats = new Float32Array(n);
    for (let i = 0; i < n; i += 1) floats[i] = pcm.readInt16LE(i * 2) / 32768;

    this.#pending.push(floats);
    this.#pendingLen += n;
    this.#pump();
  }

  /**
   * Wait until every pushed frame has been through the model. For tests and
   * offline evaluation -- a live call never needs this, because falling behind
   * is something we want to see, not something we want to wait out.
   */
  async drain() {
    const tick = () => new Promise((r) => setTimeout(r, 5));
    while (!this.#session) await tick();
    while (this.#pumping || this.#pendingLen >= this.#window) await tick();
  }

  /** Pull exactly n samples off the front of the pending chunks. */
  #take(n) {
    const out = new Float32Array(n);
    let off = 0;
    while (off < n) {
      const head = this.#pending[0];
      const need = n - off;
      if (head.length <= need) {
        out.set(head, off);
        off += head.length;
        this.#pending.shift();
      } else {
        out.set(head.subarray(0, need), off);
        this.#pending[0] = head.subarray(need);
        off += need;
      }
    }
    this.#pendingLen -= n;
    return out;
  }

  async #pump() {
    if (this.#pumping || !this.#session) return;
    this.#pumping = true;
    try {
      while (this.#pendingLen >= this.#window) {
        const samples = this.#take(this.#window);
        const windowStartMs = this.#clockMs;
        this.#clockMs += (this.#window / this.#sampleRate) * 1000;

        // Prepend the tail of the previous window -- see CONTEXT_SAMPLES.
        const input = new Float32Array(this.#contextSize + this.#window);
        input.set(this.#context, 0);
        input.set(samples, this.#contextSize);
        this.#context = samples.slice(this.#window - this.#contextSize);

        const out = await this.#session.run({
          input: new this.#ort.Tensor('float32', input, [1, input.length]),
          state: new this.#ort.Tensor('float32', this.#state, [2, 1, 128]),
          sr: new this.#ort.Tensor('int64', BigInt64Array.from([BigInt(this.#sampleRate)]), []),
        });

        // Carry the recurrent state forward. Forgetting this turns a sequence
        // model into 256-sample snapshots and wrecks its accuracy.
        this.#state = out.stateN.data;
        this.#decide(out.output.data[0], windowStartMs);
      }
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.#pumping = false;
      // A frame may have arrived while we were awaiting inference.
      if (this.#session && this.#pendingLen >= this.#window) this.#pump();
    }
  }

  #decide(prob, windowStartMs) {
    const windowMs = (this.#window / this.#sampleRate) * 1000;

    if (prob >= this.#threshold) {
      this.#speechRun += 1;
      this.#silenceRun = 0;
      this.lastLoudAtMs = windowStartMs;
    } else if (prob < this.#releaseThreshold) {
      this.#silenceRun += 1;
      this.#speechRun = 0;
    } // between the two thresholds: hold whatever we already believe

    if (!this.#active && this.#speechRun >= this.#startWindows) {
      this.#active = true;
      this.emit('speechStart', { atMs: Math.round(windowStartMs - (this.#startWindows - 1) * windowMs) });
    } else if (this.#active && this.#silenceRun >= this.#endWindows) {
      this.#active = false;
      this.emit('speechEnd', { atMs: Math.round(windowStartMs - (this.#endWindows - 1) * windowMs) });
    }
  }
}
