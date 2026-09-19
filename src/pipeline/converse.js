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

  // The in-flight turn's abort handle, hoisted so barge-in can reach it.
  let turnAbort = null;
  const bargeIns = [];
  let rate = 8000;

  // WHERE PLAYBACK ACTUALLY IS.
  //
  // Marks are the only ground truth about what a caller HEARD; `send` only ever
  // tells you what you handed over. So we track one timeline per turn:
  //
  //   sentMs        audio handed to the transport so far, in ms
  //   markPos       mark name -> its position on that timeline
  //   playPos/Wall  the last position a mark confirmed, and when it came back
  //   spoken[]      each sentence's [startMs, endMs) on the same timeline
  //
  // Current playback position is then playPos + (now - playWall), and marks can
  // be placed anywhere without special cases.
  let sentMs = 0;
  let markPos = new Map();
  let playPos = 0;
  let playWall = null;
  let spoken = [];

  function placeMark(name) {
    markPos.set(name, sentMs);
    transport.mark(name);
  }

  function resetPlayback() {
    sentMs = 0;
    markPos = new Map();
    playPos = 0;
    playWall = null;
    spoken = [];
  }

  /**
   * What the caller actually heard of the current reply.
   *
   * Sentences fully behind the playback cursor are certain. For the one the
   * cursor is inside we interpolate by word — the best resolution available
   * without a mark per word, which would be absurd.
   */
  function heardSoFar() {
    if (playWall === null) return ''; // no mark has come back: nothing confirmed
    const pos = playPos + (performance.now() - playWall);

    const parts = [];
    for (const sentence of spoken) {
      if (pos >= sentence.endMs) { parts.push(sentence.text); continue; }
      if (pos <= sentence.startMs) break;
      const frac = (pos - sentence.startMs) / (sentence.endMs - sentence.startMs);
      const words = sentence.text.split(/\s+/);
      const kept = words.slice(0, Math.floor(words.length * frac));
      // The dash reads to the LLM as "cut off here", which is what happened.
      if (kept.length) parts.push(`${kept.join(' ')}—`);
      break;
    }
    return parts.join(' ').trim();
  }

  /**
   * The caller started talking while we were. Five things must happen, and the
   * ORDER matters more than it looks.
   *
   * clear() goes FIRST. Whatever is queued at the far end is what the caller is
   * hearing right now, and every millisecond spent tidying up our own generators
   * is another millisecond of being talked over. Cancelling the LLM first would
   * be politer to our bill and ruder to the human.
   */
  function bargeIn(atMs) {
    const t0 = performance.now();

    transport.clear();          // 1. stop what they are hearing, immediately
    turnAbort?.abort();         // 2 & 3. stop generating text and audio
    turnAbort = null;

    speaking = false;           // 4. start listening again
    awaitingMark = null;        // the mark we were waiting on will never arrive
    // Anything the ASR captured while we spoke is our own voice, or a fragment
    // of the interruption we are about to hear properly.
    pendingFinals = [];

    // 5. Record what the caller ACTUALLY HEARD, not what we generated. Skipping
    //    this is the classic voice-agent bug: the agent believes it asked a
    //    question the human never heard, then acts baffled when it goes
    //    unanswered, or repeats itself with "as I was saying".
    const heard = heardSoFar();
    if (heard) {
      history.push({ role: 'assistant', content: heard });
      console.log(`[${label}] AGENT (heard only): "${heard}"`);
    }
    resetPlayback();

    const took = performance.now() - t0;
    bargeIns.push(took);
    console.log(`[${label}] BARGE-IN at audio ${atMs}ms — cleared + aborted in ${took.toFixed(1)}ms`);
  }

  const turnLags = [];

  async function runTurn(userText, lastWordWall) {
    // t0 is when the CALLER STOPPED TALKING, not when our ASR told us about it.
    // Measuring from the ASR signal would hide ~335ms of endpointing wait and
    // make every later number look better than the caller's experience.
    const t = { turnEnd: lastWordWall, asrSignal: performance.now() };
    history.push({ role: 'user', content: userText });
    console.log(`[${label}] USER: "${userText}"`);

    // Held per-turn so barge-in can abort the LLM and TTS instead of paying for
    // audio nobody will hear.
    const ac = new AbortController();
    turnAbort = ac;

    const turnId = ++markSeq;
    const markName = (i) => `t${turnId}-s${i}`;
    resetPlayback();

    const sentences = [];
    let queueDone = false;
    let worker = null;

    // Drains sentences in order. Started as soon as the FIRST sentence exists.
    async function drain() {
      let placedStart = false;

      while (sentences.length || !queueDone) {
        if (ac.signal.aborted) return;
        const next = sentences.shift();
        if (!next) { await new Promise((r) => setTimeout(r, 5)); continue; }

        const startMs = sentMs;
        for await (const pcm of tts.speak(next, { signal: ac.signal })) {
          if (t.ttsFirstByte === undefined) t.ttsFirstByte = performance.now();
          speaking = true;
          transport.send(pcm);
          sentMs += (pcm.length / 2 / rate) * 1000;
          if (t.firstAudioOut === undefined) t.firstAudioOut = performance.now();

          // Place the first mark right behind the first chunk of real audio,
          // not before it. A mark sent while the far end's queue is empty gets
          // scheduled at "now" and returns immediately -- hundreds of ms before
          // playback actually starts -- which would inflate what we believe the
          // caller heard.
          if (!placedStart) { placedStart = true; placeMark(markName(0)); }
        }

        spoken.push({ text: next, startMs, endMs: sentMs });
        placeMark(markName(spoken.length));
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

    if (ac.signal.aborted) return; // interrupted: no mark, no trace, no history

    // The last sentence's mark doubles as the end-of-turn mark: `speaking` stays
    // true until the transport tells us playback reached it.
    if (t.firstAudioOut !== undefined) {
      awaitingMark = markName(spoken.length);
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
    rate = sampleRate;
    asr = createAsr({ sampleRate });

    // Local VAD, fed EVERY frame including while the agent is speaking -- that
    // is the whole point, since detecting the caller talking over us is what
    // barge-in needs. Logging only for now; 4b acts on it.
    vad = new EnergyVAD({ sampleRate });
    vad.on('speechStart', ({ atMs }) => {
      if (speaking) {
        // Every voice counts as an interruption for now, including "mhm" and
        // "okay" — filtering backchannels is diff 4d.
        bargeIn(atMs);
        return;
      }
      console.log(`[${label}] VAD speech start @${atMs}ms`);
    });
    vad.on('speechEnd', ({ atMs }) => console.log(`[${label}] VAD speech end @${atMs}ms`));

    asr.on('error', (err) => console.error(`[${label}] asr error: ${err.message}`));

    // Playback reached our bookmark, so the caller has now HEARD everything we
    // sent. This is the only correct moment to reopen the mic: "finished
    // sending" is 3+ seconds earlier, because generating a reply is much faster
    // than speaking it.
    transport.on('mark', (name) => {
      // Every mark advances the playback cursor, not just the final one. This
      // is the ground truth that makes "what did they hear?" answerable.
      if (markPos.has(name)) {
        playPos = markPos.get(name);
        playWall = performance.now();
      }

      if (name !== awaitingMark) return;
      awaitingMark = null;
      speaking = false;
      // Anything captured while we were talking is our own voice or the caller
      // talking over us; the second case is handled by bargeIn(), not here.
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
        .catch((err) => {
          // An abort is barge-in working as designed, not an error. fetch()
          // surfaces it as a DOMException named AbortError.
          if (err?.name === 'AbortError') return;
          console.error(`[${label}] turn failed: ${err.message}`);
        })
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
    if (bargeIns.length) {
      const sorted = [...bargeIns].sort((a, b) => a - b);
      console.log(`[${label}] barge-ins: n=${sorted.length} p50=${sorted[Math.floor(sorted.length / 2)].toFixed(1)}ms max=${sorted.at(-1).toFixed(1)}ms`);
    }
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
