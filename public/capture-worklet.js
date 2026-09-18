/**
 * Mic capture on the audio thread: 48kHz float -> 8kHz PCM16 frames.
 *
 * An AudioWorklet rather than a ScriptProcessorNode because ScriptProcessor runs
 * its callback on the MAIN thread, where a React render or a GC pause drops
 * audio. This runs on the dedicated audio thread.
 *
 * All the arithmetic lives in dsp.js so that Node tests exercise the same code
 * the browser runs. This file is only the Web Audio shell around it.
 */
import { Decimator } from './dsp.js';

const FRAME_SAMPLES = 160; // 20ms at 8kHz, matching Twilio's framing

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { inputRate, targetRate, taps } = options.processorOptions;
    this.decimator = new Decimator({
      taps,
      factor: inputRate / targetRate,
      frameSamples: FRAME_SAMPLES,
    });
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true; // mic not producing yet; keep the node alive

    for (const frame of this.decimator.push(ch)) {
      const buf = frame.buffer;
      this.port.postMessage(buf, [buf]); // transfer, don't copy
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
