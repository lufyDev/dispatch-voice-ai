import { EventEmitter } from 'node:events';

/**
 * VAD — is someone talking right now?
 *
 * Push-based like Transport and ASR: audio arrives whether we are ready or not.
 *
 * EVENTS
 *   'speechStart' ({ atMs })  speech began (already confirmed, see hangover)
 *   'speechEnd'   ({ atMs })  speech stopped
 *
 * WHY WE NEED OUR OWN, WHEN DEEPGRAM ALREADY SENDS SpeechStarted:
 *
 *   1. Deepgram's arrives over the network, ~100-300ms late. Barge-in has to cut
 *      the agent off in well under 100ms or the caller hears it talk over them.
 *   2. During a barge-in we deliberately stop feeding the ASR real audio, so it
 *      cannot see the interruption it is supposed to detect.
 *   3. It runs locally for free. Deepgram costs money per second of audio.
 */
export class VAD extends EventEmitter {
  /** Feed one frame of PCM16. Must be called with every frame, including silence. */
  push(_pcm, _timestampMs) {
    throw new Error('not implemented');
  }

  /** True while speech is considered active. */
  get active() {
    throw new Error('not implemented');
  }
}
