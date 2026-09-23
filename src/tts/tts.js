/**
 * TTS — a sentence in, PCM16 audio out, streamed.
 *
 * Pull-based like the LLM, and for the same reason: on barge-in we must stop
 * generating audio nobody will hear.
 *
 * Audio comes out as PCM16 at the transport's sample rate, so the pipeline never
 * sees a vendor's encoding. Each adapter handles its own conversion.
 */
export class TTS {
  /**
   * @param {string} text  one sentence, not a paragraph
   * @param {{ signal?: AbortSignal }} opts
   * @returns {AsyncIterable<Buffer>} PCM16 chunks
   */
  async *speak(_text, _opts) {
    throw new Error('not implemented');
  }

  /** Open the connection before we need it. See LLM.warm(). */
  async warm() {}
}
