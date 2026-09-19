import { performance } from 'node:perf_hooks';
import { EnergyVAD } from '../vad/energy.js';

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
  let vad = null;
  const history = [{ role: 'system', content: systemPrompt }];
  let asr = null;
  let pendingFinals = [];
  let turnBusy = false;
  let audioZeroWall = null;

  // True from the first byte of agent audio until playback ACTUALLY finishes.
  // While set, mic audio is not fed to the ASR at all -- otherwise the agent
  // hears itself through the caller's speaker, transcribes its own words, and
  // submits them as the next user turn. (Headphones hide this in dev; a caller
  // on speakerphone does not.)
  let speaking = false;
  let markSeq = 0;
  let awaitingMark = null;
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
          speaking = true;
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

    // Bookmark behind the last audio chunk. `speaking` stays true until the
    // transport tells us playback reached it.
    if (t.firstAudioOut !== undefined) {
      awaitingMark = `turn-${++markSeq}`;
      transport.mark(awaitingMark);
      // A transport whose far end never reports the mark (dropped call, a
      // transport that does not implement marks) must not wedge the mic shut.
      const stuck = awaitingMark;
      setTimeout(() => {
        if (awaitingMark !== stuck) return;
        console.log(`[${label}] mark ${stuck} never returned — reopening mic`);
        awaitingMark = null;
        speaking = false;
        pendingFinals = [];
      }, 15000);
    } else {
      speaking = false;
    }

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

    // Local VAD, fed EVERY frame including while the agent is speaking -- that
    // is the whole point, since detecting the caller talking over us is what
    // barge-in needs. Logging only for now; 4b acts on it.
    vad = new EnergyVAD({ sampleRate });
    vad.on('speechStart', ({ atMs }) => {
      console.log(`[${label}] VAD speech start @${atMs}ms${speaking ? '  <-- WHILE AGENT SPEAKING (barge-in candidate)' : ''}`);
    });
    vad.on('speechEnd', ({ atMs }) => console.log(`[${label}] VAD speech end @${atMs}ms`));

    asr.on('error', (err) => console.error(`[${label}] asr error: ${err.message}`));

    // Playback reached our bookmark, so the caller has now HEARD everything we
    // sent. This is the only correct moment to reopen the mic: "finished
    // sending" is 3+ seconds earlier, because generating a reply is much faster
    // than speaking it.
    transport.on('mark', (name) => {
      if (name !== awaitingMark) return;
      awaitingMark = null;
      speaking = false;
      // Anything captured while we were talking is our own voice or the caller
      // talking over us. We cannot use either yet -- handling the second case
      // properly is barge-in, which is M4.
      const discarded = pendingFinals.join(' ').trim();
      pendingFinals = [];
      if (discarded) console.log(`[${label}] (discarded while speaking: "${discarded}")`);
    });
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
    // The VAD always sees real audio, even while we are speaking. The ASR does
    // not. That asymmetry is deliberate: we need to know the caller started
    // talking without paying to transcribe our own voice back to ourselves.
    vad?.push(frame.pcm, frame.timestampMs);

    // Half-duplex: deaf while talking. Crude, and it makes interruption
    // impossible -- M4 replaces this with a real VAD that can tell the caller's
    // voice from our own echo and cut us off mid-sentence.
    //
    // We feed SILENCE rather than dropping the frame. Deepgram's timestamps
    // count the audio we send it, so withholding audio makes its clock fall
    // behind the call's clock by the total time the agent has spoken -- and
    // every latency measurement drifts with it, growing every turn. Feeding
    // silence keeps one shared timeline, and it also hands the ASR a genuine
    // pause boundary between turns, which is what its endpointing wants.
    asr?.write(speaking ? Buffer.alloc(frame.pcm.length) : frame.pcm);
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
