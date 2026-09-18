import { LLM } from './llm.js';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

/**
 * OpenAI chat completions, streamed, parsing the SSE wire format by hand.
 *
 * By hand rather than the SDK because the thing that matters here is
 * time-to-first-token, and hand-parsing makes it obvious that we yield the
 * first delta the instant it lands rather than after the response completes.
 */
export class OpenAILLM extends LLM {
  #apiKey;
  #model;
  #maxTokens;

  constructor({ apiKey, model = 'gpt-4o-mini', maxTokens = 120 }) {
    super();
    this.#apiKey = apiKey;
    this.#model = model;
    // Voice replies must be SHORT. A caller will not sit through a paragraph,
    // and every extra token is TTS audio we have to generate and pay for.
    this.#maxTokens = maxTokens;
  }

  async *stream(messages, { signal } = {}) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.#model,
        messages,
        stream: true,
        temperature: 0.3, // a dispatcher should be boring and consistent
        max_tokens: this.#maxTokens,
      }),
      signal,
    });

    if (!res.ok) {
      throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    // SSE: newline-delimited "data: {json}" frames, terminated by "data: [DONE]".
    // Chunks do not align with lines, so we buffer the remainder each read.
    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // last piece may be a partial line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') return;

        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (delta) yield delta;
      }
    }
  }
}
