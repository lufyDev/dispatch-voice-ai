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
   * Stream a reply.
   *
   * Yields TYPED EVENTS, not strings, because with tools available the model can
   * produce two entirely different kinds of output in one turn:
   *
   *   { type: 'text', text }                  words to speak
   *   { type: 'tool_call', id, name, args }   run this and tell me the answer
   *
   * A turn can contain both: "Let me check that for you." followed by a request
   * for check_availability.
   *
   * `args` is the PARSED arguments object, or null if the model emitted
   * malformed JSON -- which happens, and is recoverable by handing the parse
   * failure back to it as a tool result. `raw` is kept for that message.
   *
   * @param {Array<object>} messages  conversation, in the vendor's message shape
   * @param {{ signal?: AbortSignal, tools?: Array<object> }} opts
   * @returns {AsyncIterable<object>}
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
