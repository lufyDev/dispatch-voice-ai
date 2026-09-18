import WebSocket from 'ws';
import { ASR } from './asr.js';

const ENDPOINT = 'wss://api.deepgram.com/v1/listen';

// Deepgram closes an idle socket after ~10s. A caller hunting for their address
// pauses longer than that, so we ping to keep the stream alive across silence.
const KEEPALIVE_MS = 5000;

/**
 * Deepgram streaming ASR over a raw WebSocket.
 *
 * Raw rather than @deepgram/sdk on purpose: the SDK hides the keepalive and the
 * reconnect, and those are exactly the parts that fail in production.
 *
 * We send audio at the transport's native 8kHz. Upsampling to 16kHz would add
 * no information (the audio is band-limited to 4kHz either way) and just double
 * the bytes.
 */
export class DeepgramASR extends ASR {
  #ws;
  #keepalive = null;
  #open = false;
  #queued = [];

  constructor({ apiKey, sampleRate = 8000, model = 'nova-3', keyterms = [] }) {
    super();

    const params = new URLSearchParams({
      model,
      encoding: 'linear16',
      sample_rate: String(sampleRate),
      channels: '1',
      // Send partial guesses as they form instead of waiting for the sentence.
      interim_results: 'true',
      // Silence (ms) before Deepgram freezes a chunk as final. Lower = snappier
      // finals, more mid-sentence splits. This is a latency knob we will tune.
      endpointing: '300',
      // Silence (ms) before Deepgram declares the whole TURN over. This is the
      // signal we reply on -- deliberately longer than endpointing.
      utterance_end_ms: '1000',
      // Emit SpeechStarted, so we can detect barge-in without our own VAD yet.
      vad_events: 'true',
      // Punctuation and number/date formatting. Costs a little latency on
      // finals, but "four one five" vs "415" matters a lot for addresses.
      smart_format: 'true',
    });

    // Domain vocabulary. Phone audio is 8kHz and mangles consonants, so telling
    // the model which rare words to expect is the cheapest accuracy win there is.
    for (const term of keyterms) params.append('keyterm', term);

    this.#ws = new WebSocket(`${ENDPOINT}?${params}`, {
      headers: { Authorization: `Token ${apiKey}` },
    });

    this.#ws.on('open', () => {
      this.#open = true;
      // Audio that arrived while we were still connecting. Dropping it would
      // lose the caller's first word, which is usually "hi" but sometimes isn't.
      for (const pcm of this.#queued) this.#ws.send(pcm);
      this.#queued = [];
      this.#keepalive = setInterval(() => {
        if (this.#ws.readyState === WebSocket.OPEN) {
          this.#ws.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, KEEPALIVE_MS);
      this.emit('open');
    });

    this.#ws.on('message', (data) => this.#onMessage(data));
    this.#ws.on('error', (err) => this.emit('error', err));
    this.#ws.on('close', () => {
      clearInterval(this.#keepalive);
      this.emit('close');
    });
  }

  #onMessage(data) {
    const msg = JSON.parse(data);

    switch (msg.type) {
      case 'Results': {
        const alt = msg.channel?.alternatives?.[0];
        const text = alt?.transcript ?? '';
        // Deepgram sends empty finals constantly during silence. Ignore them.
        if (!text) return;

        const payload = {
          text,
          startMs: Math.round(msg.start * 1000),
          endMs: Math.round((msg.start + msg.duration) * 1000),
          confidence: alt.confidence,
        };
        this.emit(msg.is_final ? 'final' : 'interim', payload);
        break;
      }

      case 'UtteranceEnd':
        // The turn-taking signal. NOT the same as is_final.
        this.emit('utteranceEnd', { lastWordEndMs: Math.round(msg.last_word_end * 1000) });
        break;

      case 'SpeechStarted':
        this.emit('speechStarted', { atMs: Math.round(msg.timestamp * 1000) });
        break;

      case 'Metadata':
        break; // request id and duration accounting; nothing we act on

      default:
        this.emit('error', new Error(`unhandled deepgram message: ${msg.type}`));
    }
  }

  write(pcm) {
    if (!this.#open) {
      this.#queued.push(Buffer.from(pcm));
      return;
    }
    if (this.#ws.readyState === WebSocket.OPEN) this.#ws.send(pcm);
  }

  finish() {
    // Asks Deepgram to flush pending transcripts before closing, rather than
    // dropping the caller's last few words.
    if (this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ type: 'CloseStream' }));
    }
  }

  close() {
    clearInterval(this.#keepalive);
    this.#ws.close();
  }
}
