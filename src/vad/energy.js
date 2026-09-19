import { VAD } from './vad.js';

/**
 * Energy VAD: is this frame louder than the room?
 *
 * The simplest thing that can work, and the baseline any fancier VAD has to
 * beat. Deliberately first: Silero is an ONNX model that costs a dependency and
 * ~1ms per frame, and "it's better" is not a reason until you can say better
 * than WHAT, by HOW MUCH.
 *
 * KNOWN FAILURE MODE, stated up front: energy cannot tell a voice from a door
 * slam, a dog, or a truck. On a phone line with background noise it will fire on
 * all of them. It is fine on headphones in a quiet room, which is exactly the
 * condition it will be developed under — so do not trust it until M4e compares
 * it against Silero on noisy audio.
 *
 * THREE IDEAS IN HERE
 *
 * 1. ADAPTIVE NOISE FLOOR, from a PERCENTILE of recent frames. A fixed threshold
 *    is wrong: a quiet room and a noisy café differ by 20dB.
 *
 *    The obvious implementation -- "update the floor only while we think it is
 *    silent" -- deadlocks. If the floor starts below the actual noise, every
 *    frame looks like speech, so it is never silent, so the floor never adapts,
 *    so every frame looks like speech. Measured: at 25dB SNR it fired on the
 *    noise at t=0 and never stopped.
 *
 *    Instead we keep the last WINDOW frames and take a low percentile. Speech is
 *    intermittent -- gaps between words, pauses between sentences -- so the
 *    quietest 20% of a 3-second window is background even mid-sentence. No
 *    state, no deadlock.
 *
 * 2. HYSTERESIS. One loud frame is a click, not speech. We need N consecutive
 *    loud frames to declare speech, which costs N*20ms of detection latency —
 *    a direct trade against false triggers.
 *
 * 3. HANGOVER. Speech has gaps inside it (the stop in "stop it" is silence).
 *    Ending on the first quiet frame would chop words apart, so we require a
 *    longer run of quiet to declare the end.
 */
export class EnergyVAD extends VAD {
  #sampleRate;
  #startFrames;
  #endFrames;
  #minRms;
  #marginDb;

  #window;      // ring buffer of recent frame RMS, for the percentile
  #wIdx = 0;
  #wFilled = 0;
  #loudRun = 0;
  #quietRun = 0;
  #active = false;

  constructor({
    sampleRate = 8000,
    // 3 frames = 60ms of sustained sound before we believe it. This IS the
    // barge-in detection latency, so it is a knob we will measure, not a
    // constant we assume.
    startFrames = 3,
    // 25 frames = 500ms of quiet before we call it over. Long, because speech
    // contains silence: plosives, and the pause before a house number.
    endFrames = 25,
    // Absolute floor. Below this it is line noise no matter what the ratio says.
    minRms = 0.006,
    // How far above the noise floor speech must sit. 6dB is 2x amplitude.
    marginDb = 6,
    // Frames of history for the percentile. 150 = 3s, long enough to contain
    // gaps between words even in continuous speech.
    window = 150,
    // Which percentile of that window counts as "background".
    percentile = 0.2,
  } = {}) {
    super();
    this.#sampleRate = sampleRate;
    this.#startFrames = startFrames;
    this.#endFrames = endFrames;
    this.#minRms = minRms;
    this.#marginDb = marginDb;
    this.#window = new Float64Array(window);
    this.#percentile = percentile;
  }

  #percentile;

  /** Low percentile of recent frame energies = the background level. */
  #noiseFloor() {
    if (this.#wFilled === 0) return this.#minRms;
    const sorted = Array.from(this.#window.subarray(0, this.#wFilled)).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * this.#percentile)];
  }

  get active() {
    return this.#active;
  }

  /** Root-mean-square amplitude of a PCM16 frame, normalised to 0..1. */
  static rms(pcm) {
    let sum = 0;
    const n = pcm.length / 2;
    for (let i = 0; i < n; i += 1) {
      const s = pcm.readInt16LE(i * 2) / 32768;
      sum += s * s;
    }
    return Math.sqrt(sum / n);
  }

  push(pcm, timestampMs) {
    const rms = EnergyVAD.rms(pcm);

    // Record BEFORE deciding, so the window is a plain description of recent
    // audio rather than something our own classification steers.
    this.#window[this.#wIdx] = rms;
    this.#wIdx = (this.#wIdx + 1) % this.#window.length;
    this.#wFilled = Math.min(this.#wFilled + 1, this.#window.length);

    const threshold = Math.max(this.#minRms, this.#noiseFloor() * 10 ** (this.#marginDb / 20));
    const loud = rms > threshold;

    if (loud) {
      this.#loudRun += 1;
      this.#quietRun = 0;
    } else {
      this.#quietRun += 1;
      this.#loudRun = 0;
    }

    if (!this.#active && this.#loudRun >= this.#startFrames) {
      this.#active = true;
      // Report the timestamp of where speech actually STARTED, not where we
      // became confident -- we are startFrames late by construction.
      this.emit('speechStart', { atMs: timestampMs - this.#startFrames * 20 });
    } else if (this.#active && this.#quietRun >= this.#endFrames) {
      this.#active = false;
      this.emit('speechEnd', { atMs: timestampMs - this.#endFrames * 20 });
    }

    return rms;
  }
}
