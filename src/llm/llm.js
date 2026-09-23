/**
 * LLM — conversation text in, reply text out, streamed.
 *
 * Pull-based (async generator), unlike Transport and ASR which are push. Audio
 * arrives whether we are ready or not; tokens do not, and we want to be able to
 * STOP mid-sentence when the caller interrupts. Hence the AbortSignal, which is
 * load-bearing from M4 onward: on barge-in we abort the generation rather than
 * letting it finish and paying for tokens nobody will hear.
 */
export class LLM {
  /**
   * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} messages
   * @param {{ signal?: AbortSignal }} opts
   * @returns {AsyncIterable<string>} text deltas
   */
  async *stream(_messages, _opts) {
    throw new Error('not implemented');
  }

  /**
   * Open the connection before we need it.
   *
   * Measured on a live demo: the first turn of a call cost 5198ms against
   * 1207ms for the fourth, because TLS to a fresh origin is several round trips
   * and every round trip from here is expensive. The first turn is also the one
   * that decides whether a caller trusts the thing.
   *
   * Optional, and must never throw -- a transport should not fail a call because
   * a warm-up 401'd.
   */
  async warm() {}
}
