import { Transport } from './transport.js';
import { decode, encode } from '../audio/mulaw.js';

const SAMPLE_RATE = 8000;
const FRAME_BYTES = 160; // 20ms of 8kHz mu-law

/**
 * Twilio Media Streams behind the Transport contract.
 *
 * Everything Twilio-shaped stops here: base64, streamSid, their event names,
 * mu-law. Nothing above this file mentions any of it.
 */
export class TwilioTransport extends Transport {
  #socket;
  #streamSid = null;
  #stopped = false;

  constructor(socket) {
    super();
    this.#socket = socket;
    socket.on('message', (data) => this.#onMessage(data));
    // A socket close without a `stop` means the call dropped rather than ended
    // cleanly, so we need both paths -- but a normal hangup fires BOTH, and
    // 'stop' will eventually be wired to "save the call record" and "create the
    // emergency alert". Emitting it twice on the happy path would double-book.
    // Idempotency belongs here, at the source, not in every listener.
    socket.on('close', () => this.#stop());
    socket.on('error', (err) => this.emit('error', err));
  }

  get sampleRate() {
    return SAMPLE_RATE;
  }

  #onMessage(data) {
    const msg = JSON.parse(data);

    switch (msg.event) {
      case 'connected':
        break; // nothing useful in it; the real metadata is in `start`

      case 'start':
        this.#streamSid = msg.start.streamSid;
        this.emit('start', { callId: msg.start.callSid, sampleRate: SAMPLE_RATE });
        break;

      case 'media':
        this.emit('frame', {
          pcm: decode(Buffer.from(msg.media.payload, 'base64')),
          sampleRate: SAMPLE_RATE,
          // Audio clock, straight from Twilio. Never Date.now().
          timestampMs: Number(msg.media.timestamp),
        });
        break;

      case 'mark':
        this.emit('mark', msg.mark.name);
        break;

      case 'stop':
        this.#stop();
        break;

      default:
        this.emit('error', new Error(`unhandled twilio event: ${msg.event}`));
    }
  }

  #stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.emit('stop');
  }

  #write(obj) {
    // streamSid is the return address; without it Twilio silently drops us.
    if (!this.#streamSid) return;
    if (this.#socket.readyState !== this.#socket.OPEN) return;
    this.#socket.send(JSON.stringify(obj));
  }

  send(pcm) {
    const mulaw = encode(pcm);
    // Chunked to 20ms even though Twilio accepts larger payloads: clear() can
    // only cut at a frame boundary, so chunk size IS the resolution of our
    // barge-in. One 4-second blob would be all-or-nothing to interrupt.
    for (let i = 0; i < mulaw.length; i += FRAME_BYTES) {
      this.#write({
        event: 'media',
        streamSid: this.#streamSid,
        media: { payload: mulaw.subarray(i, i + FRAME_BYTES).toString('base64') },
      });
    }
  }

  mark(name) {
    this.#write({ event: 'mark', streamSid: this.#streamSid, mark: { name } });
  }

  clear() {
    this.#write({ event: 'clear', streamSid: this.#streamSid });
  }

  close() {
    this.#socket.close();
  }
}
