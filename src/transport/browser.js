import { Transport } from './transport.js';

const SAMPLE_RATE = 8000;

/**
 * Browser mic over a plain WebSocket, behind the Transport contract.
 *
 * Deliberately different from Twilio on the wire, to prove the interface is
 * load-bearing rather than Twilio-shaped:
 *
 *   - audio travels as RAW BINARY frames, not base64 inside JSON. We own both
 *     ends here, so there's no reason to pay the 33% base64 tax that Twilio's
 *     text protocol forces on us.
 *   - control messages (start / mark / clear) are JSON text frames. `ws` tells
 *     us which kind arrived via isBinary.
 *   - there is no audio clock on the wire. Twilio hands us media.timestamp; the
 *     page doesn't, so we derive it by counting samples. Counting samples IS an
 *     audio clock -- same guarantee, computed instead of given.
 *
 * The page has already downsampled 48kHz -> 8kHz and converted to PCM16, so
 * frames arrive in the pipeline's format with no work here.
 */
export class BrowserTransport extends Transport {
  #socket;
  #stopped = false;
  #samplesIn = 0;

  constructor(socket) {
    super();
    this.#socket = socket;
    socket.on('message', (data, isBinary) => this.#onMessage(data, isBinary));
    socket.on('close', () => this.#stop());
    socket.on('error', (err) => this.emit('error', err));
  }

  get sampleRate() {
    return SAMPLE_RATE;
  }

  #onMessage(data, isBinary) {
    if (isBinary) {
      // Raw PCM16 little-endian at 8kHz, exactly what the pipeline wants.
      const pcm = Buffer.from(data);
      this.emit('frame', {
        pcm,
        sampleRate: SAMPLE_RATE,
        timestampMs: Math.round((this.#samplesIn / SAMPLE_RATE) * 1000),
      });
      this.#samplesIn += pcm.length / 2; // 2 bytes per sample
      return;
    }

    const msg = JSON.parse(data);
    switch (msg.type) {
      case 'start':
        this.emit('start', { callId: msg.callId ?? 'browser', sampleRate: SAMPLE_RATE });
        break;

      case 'mark':
        // The page's playback cursor passed a bookmark we set.
        this.emit('mark', msg.name);
        break;

      case 'stop':
        this.#stop();
        break;

      default:
        this.emit('error', new Error(`unhandled browser message: ${msg.type}`));
    }
  }

  #stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.emit('stop');
  }

  send(pcm) {
    if (this.#socket.readyState !== this.#socket.OPEN) return;
    // Binary frame. No chunking needed for correctness, but we still chunk to
    // 20ms so that clear() has the same cut resolution as the Twilio path --
    // otherwise barge-in would behave differently in dev than in production,
    // which defeats the point of developing against the browser.
    const FRAME_BYTES = (SAMPLE_RATE / 50) * 2; // 20ms of PCM16 = 320 bytes
    for (let i = 0; i < pcm.length; i += FRAME_BYTES) {
      this.#socket.send(pcm.subarray(i, i + FRAME_BYTES), { binary: true });
    }
  }

  #control(obj) {
    if (this.#socket.readyState !== this.#socket.OPEN) return;
    this.#socket.send(JSON.stringify(obj));
  }

  mark(name) {
    this.#control({ type: 'mark', name });
  }

  clear() {
    // The playback queue lives in the page, so clear is a control message the
    // page must honour by dropping scheduled audio. Compare with Twilio, where
    // the queue lives in their infrastructure. Same contract, opposite side.
    this.#control({ type: 'clear' });
  }

  close() {
    this.#socket.close();
  }
}
