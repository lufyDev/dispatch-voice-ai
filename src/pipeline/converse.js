import { performance } from 'node:perf_hooks';

/**
 * M3: the first real conversation. Transport -> ASR -> LLM -> TTS -> Transport.
 *
 * THE LATENCY TRACE is the point of this milestone. We stamp every hop so the
 * per-turn waterfall is a measurement rather than a feeling, and so M4 has a
 * baseline to improve against.
 *
 * WHY SENTENCES. The first sentence is handed to TTS while the LLM is still
 * writing the second. Waiting for the full reply would add the whole generation
 * time to time-to-first-audio. Audio must still PLAY in order, so sentences go
 * into a queue that one worker drains sequentially.
 */

/** Pull the first complete sentence off the front of a buffer, if there is one. */
function takeSentence(buf) {
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(buf);
  if (m) return [m[0].trim(), buf.slice(m[0].length)];
  // No punctuation yet, but do not stall forever on a long clause.
  if (buf.length > 160) {
    const cut = buf.lastIndexOf(',', 160);
    const at = cut > 40 ? cut + 1 : 160;
    return [buf.slice(0, at).trim(), buf.slice(at)];
  }
  return null;
}

export function attachConverse(transport, { createAsr, llm, tts, systemPrompt, label = 'call' }) {
  const history = [{ role: 'system', content: systemPrompt }];
  let asr = null;
  let pendingFinals = [];
  let turnBusy = false;
  let audioZeroWall = null;
  const turnLags = [];

  async function runTurn(userText, lastWordWall) {
    // t0 is when the CALLER STOPPED TALKING, not when our ASR told us about it.
    // Measuring from the ASR signal would hide ~335ms of endpointing wait and
    // make every later number look better than the caller's experience.
    const t = { turnEnd: lastWordWall, asrSignal: performance.now() };
    history.push({ role: 'user', content: userText });
    console.log(`[${label}] USER: "${userText}"`);

    // Held per-turn so M4 can abort the LLM and TTS on barge-in instead of
    // paying for audio nobody will hear.
    const ac = new AbortController();

    const sentences = [];
    let queueDone = false;
    let worker = null;

    // Drains sentences in order. Started as soon as the FIRST sentence exists.
    async function drain() {
      while (sentences.length || !queueDone) {
        const next = sentences.shift();
        if (!next) { await new Promise((r) => setTimeout(r, 5)); continue; }
        for await (const pcm of tts.speak(next, { signal: ac.signal })) {
          if (t.ttsFirstByte === undefined) t.ttsFirstByte = performance.now();
          transport.send(pcm);
          if (t.firstAudioOut === undefined) t.firstAudioOut = performance.now();
        }
      }
    }

    let buffer = '';
    let reply = '';

    for await (const delta of llm.stream(history, { signal: ac.signal })) {
      if (t.llmFirstToken === undefined) t.llmFirstToken = performance.now();
      buffer += delta;
      reply += delta;

      let piece;
      while ((piece = takeSentence(buffer)) !== null) {
        const [sentence, rest] = piece;
        buffer = rest;
        if (!sentence) continue;
        if (t.firstSentence === undefined) t.firstSentence = performance.now();
        sentences.push(sentence);
        worker ??= drain();   // start speaking before the LLM has finished
      }
    }

    if (buffer.trim()) {
      sentences.push(buffer.trim());
      worker ??= drain();
    }
    queueDone = true;
    await worker;

    history.push({ role: 'assistant', content: reply.trim() });
    console.log(`[${label}] AGENT: "${reply.trim()}"`);

    // The waterfall. Every number is milliseconds after the caller stopped talking.
    const d = (x) => (x === undefined ? '  n/a' : `${(x - t.turnEnd).toFixed(0)}ms`);
    console.log(
      `[${label}] TRACE (from caller's last word)  asr-turn-signal=${d(t.asrSignal)}` +
      `  llm-first-token=${d(t.llmFirstToken)}  first-sentence=${d(t.firstSentence)}` +
      `  tts-first-byte=${d(t.ttsFirstByte)}  AUDIO OUT=${d(t.firstAudioOut)}`
    );
    if (t.firstAudioOut !== undefined) turnLags.push(t.firstAudioOut - t.turnEnd);
  }

  transport.on('start', ({ callId, sampleRate }) => {
    console.log(`[${label}] start callId=${callId} sampleRate=${sampleRate}`);
    asr = createAsr({ sampleRate });

    asr.on('error', (err) => console.error(`[${label}] asr error: ${err.message}`));
    asr.on('final', ({ text }) => pendingFinals.push(text));

    // speech_final, not utteranceEnd: 335ms vs 1765ms. See docs/02-asr.md.
    asr.on('speechFinal', ({ endMs }) => {
      // Wall-clock time of the caller's last word, via the audio clock.
      const lastWordWall = audioZeroWall === null ? performance.now() : audioZeroWall + endMs;
      const userText = pendingFinals.join(' ').trim();
      pendingFinals = [];
      if (!userText) return;
      // No barge-in yet (that is M4) -- for now, ignore speech while replying.
      if (turnBusy) {
        console.log(`[${label}] (ignored while speaking: "${userText}")`);
        return;
      }
      turnBusy = true;
      runTurn(userText, lastWordWall)
        .catch((err) => console.error(`[${label}] turn failed: ${err.message}`))
        .finally(() => { turnBusy = false; });
    });
  });

  transport.on('frame', (frame) => {
    if (audioZeroWall === null) audioZeroWall = performance.now() - frame.timestampMs;
    asr?.write(frame.pcm);
  });
  transport.on('error', (err) => console.error(`[${label}] transport error: ${err.message}`));

  transport.on('stop', () => {
    asr?.finish();
    if (turnLags.length) {
      const sorted = [...turnLags].sort((a, b) => a - b);
      console.log(
        `[${label}] voice-to-voice: n=${sorted.length} ` +
        `p50=${sorted[Math.floor(sorted.length * 0.5)].toFixed(0)}ms max=${sorted.at(-1).toFixed(0)}ms`
      );
    }
    setTimeout(() => asr?.close(), 1000);
  });
}
