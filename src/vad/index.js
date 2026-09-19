import { EnergyVAD } from './energy.js';
import { SileroVAD } from './silero.js';

/**
 * Pick a VAD. Measured comparison in docs/04-turntaking.md; the summary:
 *
 *   condition              energy              silero
 *   clean .. 10dB SNR      start within 1 frame, both
 *   door slam, no speech   FALSE TRIGGER       correctly silent
 *   cost per 20ms frame    11us                156us
 *
 * They are equivalent at finding speech. They differ on rejecting things that
 * are loud and are not speech, and on a phone line that difference is a
 * spurious barge-in -- the agent cutting itself off because a door shut. So
 * silero is the default despite the native dependency.
 *
 * Energy stays because it is 40 lines with no dependencies and it is genuinely
 * fine above ~10dB SNR in a room without transients, and because having both is
 * the only way the comparison above exists.
 */
export function createVad({ sampleRate, kind = process.env.VAD || 'silero' }) {
  if (kind === 'energy') return { vad: new EnergyVAD({ sampleRate }), kind: 'energy' };

  try {
    const vad = new SileroVAD({
      sampleRate,
      modelPath: process.env.SILERO_MODEL_PATH || 'models/silero_vad.onnx',
    });
    return { vad, kind: 'silero' };
  } catch (err) {
    // A missing model file or an unbuildable native runtime should degrade, not
    // take the call down. Energy is worse, not useless.
    console.error(`[vad] silero unavailable (${err.message}) — falling back to energy`);
    return { vad: new EnergyVAD({ sampleRate }), kind: 'energy' };
  }
}
