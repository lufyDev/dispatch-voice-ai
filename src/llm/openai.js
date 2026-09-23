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

  /**
   * We want the TCP + TLS handshake and the DNS lookup, nothing else. The HTTP
   * response is irrelevant -- a 401 warms undici's connection pool exactly as
   * well as a 200, and costs no tokens. HEAD so there is no body either way.
   */
  async warm() {
    try {
      await fetch(ENDPOINT, {
        method: 'HEAD',
        headers: { Authorization: `Bearer ${this.#apiKey}` },
      });
    } catch {
      // A failed warm-up is not a failed call.
    }
  }

  async *stream(messages, { signal, tools } = {}) {
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
        ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
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

    // Tool calls arrive in FRAGMENTS: the name in one frame, the arguments JSON
    // a few characters at a time across many more, with no guarantee about
    // where the splits land. So we accumulate by index and emit only once the
    // stream ends -- there is no point at which a partial argument string is
    // safe to parse.
    const partial = new Map();

    const drainToolCalls = function* () {
      for (const call of partial.values()) {
        let args = null;
        try {
          args = JSON.parse(call.args || '{}');
        } catch {
          // Left null on purpose. The caller turns this into a tool result
          // telling the model its JSON was malformed, which it can retry --
          // far better than throwing and losing the turn.
        }
        yield { type: 'tool_call', id: call.id, name: call.name, args, raw: call.args };
      }
    };

    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // last piece may be a partial line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          yield* drainToolCalls();
          return;
        }

        const delta = JSON.parse(data).choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) yield { type: 'text', text: delta.content };

        for (const tc of delta.tool_calls ?? []) {
          const cur = partial.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          partial.set(tc.index, cur);
        }
      }
    }

    // Some responses end without an explicit [DONE].
    yield* drainToolCalls();
  }
}
