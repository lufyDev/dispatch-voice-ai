import { TTS } from './tts.js';
import { decode as mulawDecode } from '../audio/mulaw.js';

/**
 * ElevenLabs Flash over the HTTP streaming endpoint.
 *
 * OUTPUT FORMAT. We ask for `ulaw_8000` and decode it with our own mu-law codec.
 * That is the shortest possible path to what the transport wants:
 *
 *   ElevenLabs mu-law 8kHz -> mulaw.decode() -> PCM16 8kHz -> transport
 *
 * No resampling anywhere in the output path. Asking for pcm_16000 instead would
 * mean downsampling 16k->8k ourselves, with a filter, for audio that ends up
 * band-limited to 4kHz regardless.
 *
 * HTTP streaming rather than their WebSocket API: one request per sentence,
 * which is the chunking we want anyway, and far less machinery. The WebSocket
 * saves a connection setup per sentence and is the M4 optimisation, once we can
 * measure whether that setup cost actually matters.
 */
export class ElevenLabsTTS extends TTS {
  #apiKey;
  #voiceId;
  #model;

  // Default is Sarah. NOT Rachel/Aria: those are Voice Library voices, and a
  // free ElevenLabs account gets 402 "Free users cannot use library voices via
  // the API" for them. Sarah/George/Jessica/Lily work on the free tier.
  constructor({ apiKey, voiceId = 'EXAVITQu4vr4xnSDxMaL', model = 'eleven_flash_v2_5' }) {
    super();
    this.#apiKey = apiKey;
    this.#voiceId = voiceId;
    this.#model = model;
  }

  async *speak(text, { signal } = {}) {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.#voiceId}/stream`
      + `?output_format=ulaw_8000`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': this.#apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: this.#model,
        // optimize_streaming_latency trades a little quality for TTFB. 3 is the
        // aggressive-but-sane setting; worth sweeping like we swept endpointing.
        optimize_streaming_latency: 3,
      }),
      signal,
    });

    if (!res.ok) {
      throw new Error(`elevenlabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    for await (const chunk of res.body) {
      yield mulawDecode(Buffer.from(chunk));
    }
  }
}
