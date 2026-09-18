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
}
