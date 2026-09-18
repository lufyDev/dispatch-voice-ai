import { EventEmitter } from 'node:events';

/**
 * ASR — speech in, text out. Same idea as Transport: one interface, swappable
 * vendors, so we can change provider in one line and re-measure.
 *
 * Audio in is PCM16 at whatever rate the transport runs at. No resampling here:
 * if a vendor needs a different rate, that vendor's adapter does the conversion.
 *
 * EVENTS
 *
 *   'open'          ()                          connection ready for audio
 *   'speechStarted' ({ atMs })                  vendor VAD heard speech begin
 *   'interim'       ({ text, startMs, endMs })  best guess so far, WILL change
 *   'final'         ({ text, startMs, endMs })  these words are now frozen
 *   'utteranceEnd'  ({ lastWordEndMs })         vendor believes the turn ended
 *   'error'         (err)
 *   'close'         ()
 *
 * INTERIM vs FINAL vs UTTERANCE-END -- the distinction that breaks voice agents:
 *
 *   interim      "I think they said 'my heater is bro'"      (will be revised)
 *   final        "those words are settled: 'my heater is'"   (turn may continue)
 *   utteranceEnd "they have stopped talking"                 (now you may reply)
 *
 * Only utteranceEnd is a turn-taking signal. Replying on `final` means talking
 * over a caller who merely paused mid-sentence.
 */
export class ASR extends EventEmitter {
  /** Feed PCM16 audio. Fire and forget -- never await this per frame. */
  write(_pcm) {
    throw new Error('not implemented');
  }

  /** Stop sending audio but ask for any pending transcript first. */
  finish() {
    throw new Error('not implemented');
  }

  /** Tear down now, discarding anything pending. */
  close() {
    throw new Error('not implemented');
  }
}
