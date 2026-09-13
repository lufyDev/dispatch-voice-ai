import { EventEmitter } from 'node:events';

/**
 * Transport — the ONLY thing the pipeline is allowed to know about audio I/O.
 *
 * The pipeline must not know it's on a phone. TwilioTransport and
 * BrowserTransport both satisfy this contract; nothing downstream of here can
 * tell which one it's talking to.
 *
 * ---------------------------------------------------------------------------
 * FRAME FORMAT
 *
 *   { pcm: Buffer,       16-bit signed little-endian linear PCM
 *     sampleRate: 8000,  whatever this transport natively runs at
 *     timestampMs: 340 } milliseconds of AUDIO since the stream began
 *
 * Why PCM and not the native encoding: you cannot do arithmetic on mu-law.
 * VAD compares amplitude to a threshold, barge-in measures energy, mixing adds
 * samples. All illegal on mu-law bytes. So every transport decodes on the way
 * in and re-encodes on the way out.
 *
 * Why sampleRate rides on the frame instead of being normalised to 16kHz:
 * upsampling Twilio's 8kHz adds zero information -- the audio is still
 * band-limited to 4kHz -- and it is a lossy commitment we cannot undo. We
 * resample ONCE, at the ASR boundary, when we know what the vendor wants.
 *
 * Why timestampMs is the audio clock and never Date.now(): wall time drifts
 * away from audio time (we measured 228ms over 5 seconds with a sloppy sender).
 * "When was this said" must be answerable from the audio itself.
 *
 * ---------------------------------------------------------------------------
 * PUSH, NOT PULL
 *
 * This is an EventEmitter rather than an async iterator, deliberately. Streams
 * would give us backpressure, and backpressure is WRONG for a live call: you
 * cannot ask a caller to talk slower. If the pipeline falls behind, queueing
 * makes the conversation drift further from real time every second. Dropping is
 * the correct failure mode, and push semantics make falling behind visible
 * rather than silently buffering it.
 *
 * ---------------------------------------------------------------------------
 * EVENTS
 *
 *   'start' ({ callId, sampleRate })  stream is live, metadata known
 *   'frame' ({ pcm, sampleRate, timestampMs })
 *   'mark'  (name)                    playback cursor passed a bookmark we set
 *   'stop'  ()                        far end ended the stream
 *   'error' (err)
 */
export class Transport extends EventEmitter {
  /** Native sample rate of this transport. Available after 'start'. */
  get sampleRate() {
    throw new Error('not implemented');
  }

  /**
   * Queue PCM16 (at this transport's sampleRate) for playback to the far end.
   *
   * Note "queue", not "play". This returns as soon as the bytes are handed off.
   * It tells you NOTHING about what the far end heard -- 4 seconds of audio can
   * be accepted in 200ms and then played out over 4 seconds. That gap between
   * "sent" and "heard" is the whole reason mark() and clear() exist.
   */
  send(_pcm) {
    throw new Error('not implemented');
  }

  /**
   * Drop a named bookmark behind everything currently queued. The far end emits
   * a 'mark' event with this name when playback actually reaches it.
   *
   * This is the only mechanism that answers "what did the caller really hear?"
   */
  mark(_name) {
    throw new Error('not implemented');
  }

  /**
   * Discard everything queued and not yet played. This is barge-in: the caller
   * interrupted, and the rest of our sentence must never reach their ear.
   *
   * Audio already played is gone; marks that had not yet been reached will
   * never fire. Both implementations must honour that.
   */
  clear() {
    throw new Error('not implemented');
  }

  /** Tear down. Anything still queued at the far end is lost -- see the 149/150. */
  close() {
    throw new Error('not implemented');
  }
}
