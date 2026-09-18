import { performance } from 'node:perf_hooks';

/**
 * M2's pipeline: audio in, transcript out. Still no LLM, no reply.
 *
 * Like echo.js this knows nothing about phones or browsers -- it takes a
 * Transport and an ASR and wires them together.
 *
 * MEASURING LATENCY HONESTLY
 *
 * Deepgram reports timings on the AUDIO clock (seconds since the stream began),
 * not wall time. We record the wall time of audio-zero once, so wall time for
 * any audio position is audioZeroWall + audioMs. Then:
 *
 *   lag = now - (audioZeroWall + lastWordEndMs)
 *
 * which is the number that actually matters: how long after the caller stopped
 * speaking did we know what they said. Measuring from "when the message arrived"
 * instead would flatter us by hiding the audio still in flight.
 */
export function attachTranscribe(transport, createAsr, { label = 'call' } = {}) {
  let asr = null;
  let audioZeroWall = null;
  let lastInterim = '';
  const finals = [];
  const lags = [];

  // Wall-clock time at which a given audio-clock position occurred.
  const wallFor = (audioMs) => (audioZeroWall === null ? null : audioZeroWall + audioMs);
  const lagFrom = (audioMs) => {
    const w = wallFor(audioMs);
    return w === null ? null : performance.now() - w;
  };

  transport.on('start', ({ callId, sampleRate }) => {
    console.log(`[${label}] start callId=${callId} sampleRate=${sampleRate}`);
    asr = createAsr({ sampleRate });

    asr.on('open', () => console.log(`[${label}] asr connected`));
    asr.on('error', (err) => console.error(`[${label}] asr error: ${err.message}`));

    asr.on('speechStarted', ({ atMs }) => {
      console.log(`[${label}] speech started @${atMs}ms`);
    });

    asr.on('interim', ({ text }) => {
      // Interims are revised constantly; overwrite one line instead of spamming.
      if (text === lastInterim) return;
      lastInterim = text;
      console.log(`[${label}]   … ${text}`);
    });

    asr.on('final', ({ text, endMs, confidence }) => {
      lastInterim = '';
      finals.push(text);
      const lag = lagFrom(endMs);
      console.log(
        `[${label}] FINAL "${text}" conf=${confidence?.toFixed(2)} ` +
        `(+${lag?.toFixed(0)}ms after those words ended)`
      );
    });

    asr.on('speechFinal', ({ endMs }) => {
      // Endpointing-driven turn end. Tunable all the way down, unlike
      // utteranceEnd, so this is what M4 will actually reply on.
      const lag = lagFrom(endMs);
      if (lag !== null) lags.push(lag);
      console.log(`[${label}] SPEECH FINAL (+${lag?.toFixed(0)}ms after last word)`);
    });

    asr.on('utteranceEnd', ({ lastWordEndMs }) => {
      // THE number for M2: speech-end -> we know the turn is over.
      const lag = lagFrom(lastWordEndMs);
      console.log(`[${label}] utteranceEnd (+${lag?.toFixed(0)}ms after last word)`);
    });
  });

  transport.on('frame', (frame) => {
    if (audioZeroWall === null) audioZeroWall = performance.now() - frame.timestampMs;
    asr?.write(frame.pcm);
  });

  transport.on('error', (err) => console.error(`[${label}] transport error: ${err.message}`));

  transport.on('stop', () => {
    asr?.finish();
    console.log(`[${label}] stop — transcript: "${finals.join(' ')}"`);
    if (lags.length) {
      const sorted = [...lags].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      console.log(`[${label}] turn-end lag: n=${lags.length} p50=${p50.toFixed(0)}ms max=${sorted.at(-1).toFixed(0)}ms`);
    }
    setTimeout(() => asr?.close(), 1000); // let CloseStream flush first
  });
}
