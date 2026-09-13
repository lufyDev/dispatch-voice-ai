import { performance } from 'node:perf_hooks';

/** min / p50 / p95 / max / mean, rounded to 0.1. */
function stats(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const r = (n) => n.toFixed(1);
  return `min=${r(sorted[0])} p50=${r(at(0.5))} p95=${r(at(0.95))} max=${r(sorted.at(-1))} mean=${r(mean)}`;
}

/**
 * M1's entire "pipeline": send back exactly what you heard.
 *
 * Read this file and note what is absent: no Twilio, no mu-law, no base64, no
 * streamSid, no WebSocket. It handles frames of PCM and nothing else, which is
 * why BrowserTransport can reuse it untouched. That reuse is the only real test
 * of whether the Transport interface is worth anything.
 */
export function attachEcho(transport, { label = 'call' } = {}) {
  const m = {
    callId: null,
    rate: null,
    frames: 0,
    bytes: 0,
    echoed: 0,
    // performance.now() is monotonic. Date.now() follows the system clock, which
    // NTP can step backwards mid-call and hand you negative durations.
    firstAt: null,
    lastAt: null,
    gaps: [],
    clumped: 0,
  };

  transport.on('start', ({ callId, sampleRate }) => {
    m.callId = callId;
    m.rate = sampleRate;
    console.log(`[${label}] start callId=${callId} sampleRate=${sampleRate}`);
  });

  transport.on('frame', (frame) => {
    const now = performance.now();
    if (m.lastAt === null) {
      m.firstAt = now;
    } else {
      const gap = now - m.lastAt;
      m.gaps.push(gap);
      // A gap well under 20ms means this frame was buffered somewhere and
      // released together with its predecessor: the network clumped them.
      if (gap < 10) m.clumped += 1;
    }
    m.lastAt = now;

    m.frames += 1;
    m.bytes += frame.pcm.length;
    if (m.frames % 50 === 1) {
      console.log(`[${label}] frame #${m.frames} audioClock=${frame.timestampMs}ms pcmBytes=${frame.pcm.length}`);
    }

    // The echo. PCM in, the same PCM straight back out. The transport handles
    // re-encoding to whatever the far end speaks.
    transport.send(frame.pcm);
    m.echoed += 1;
  });

  transport.on('mark', (name) => console.log(`[${label}] mark reached: ${name}`));
  transport.on('error', (err) => console.error(`[${label}] error: ${err.message}`));

  transport.on('stop', () => {
    const audioMs = m.frames * 20;
    console.log(`[${label}] stop frames=${m.frames} echoed=${m.echoed} pcmBytes=${m.bytes} audio=${(audioMs / 1000).toFixed(2)}s`);
    if (m.gaps.length > 0) {
      const wall = m.lastAt - m.firstAt;
      const audio = (m.frames - 1) * 20;
      console.log(`[${label}] gaps(ms) ${stats(m.gaps)} clumped(<10ms)=${m.clumped}/${m.gaps.length}`);
      // Positive drift = wall time outran audio time = we are falling behind live.
      console.log(`[${label}] wall=${wall.toFixed(0)}ms audio=${audio}ms drift=${(wall - audio).toFixed(0)}ms`);
    }
  });
}
