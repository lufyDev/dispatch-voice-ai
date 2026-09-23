import { performance } from 'node:perf_hooks';
import { createVad } from '../vad/index.js';
import { looksComplete } from '../turn/completeness.js';

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

/**
 * Silence for gagging the ASR while the agent speaks.
 *
 * Tried low-level dither here instead of perfect zero, on the theory that
 * Deepgram was failing to endpoint on digital silence. It made no difference:
 * the continuation's final still took 6.8s. The delay is Deepgram's, not ours
 * -- see docs/04-turntaking.md.
 */
const SILENT_FRAME = (bytes) => Buffer.alloc(bytes);

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

  // BACKCHANNELS. "mhm", "yeah", "okay", "right" are the listener saying "I am
  // still here, keep going" -- not an interruption. An agent that stops dead for
  // those is exhausting to talk to.
  //
  // DURATION CANNOT SOLVE THIS, and it is worth knowing why. Measured voiced
  // lengths of synthetic speech:
  //
  //   "mhm"    740ms   backchannel
  //   "uh huh" 600ms   backchannel
  //   "okay"   520ms   backchannel
  //   "yeah"   420ms   backchannel
  //   "right"  300ms   backchannel
  //   "wait"   ~300ms  INTERRUPTION
  //
  // The distributions overlap: "wait" and "stop" are shorter than "mhm". A
  // window long enough to catch "mhm" would talk over a real interruption for
  // three quarters of a second.
  //
  // So this window is deliberately SHORT. It filters clicks, coughs and chair
  // scrapes, and nothing more. "mhm" will stop the agent, and we accept that:
  // being talked over feels worse to a human than an agent that pauses when it
  // did not need to. The real fix is resuming the remainder after a false
  // barge-in, which needs the ASR's verdict and is not built yet.
  const BACKCHANNEL_MS = 250;
  let bargeCandidate = null;
  let backchannels = 0;

  // Second gate, on content rather than duration: a turn whose entire text is
  // acknowledgement is not a turn. Catches what the duration gate misses --
  // a drawn-out "yeeeah" or a caller who says "okay" twice.
  //
  // IT ONLY APPLIES TO SPEECH THAT OVERLAPPED OURS. "Yes" said over the agent
  // is an acknowledgement; "Yes" said in the caller's own turn is the ANSWER to
  // a yes/no question, and a booking agent asks a lot of those. Observed:
  //   AGENT: "Is there no hot water?"
  //   backchannel ignored: "Yes."     <- wrong, that was the answer
  const BACKCHANNEL_WORDS = /^(mm|mhm|mmhmm|uh huh|uh-huh|hmm|ah|oh|ok|okay|yeah|yep|yes|right|sure|got it|i see)[.!?, ]*$/i;
  // Did the utterance we are about to process begin while we were talking?
  let overlapped = false;

  // DYNAMIC ENDPOINTING. Deepgram's speech_final fires after 300ms of silence,
  // which cuts a caller in half when they draw breath mid-sentence ("Hi. My" /
  // "basement is flooding"). Raising the threshold to 700ms would fix that by
  // making EVERY turn slower — the lazy default the foundations doc warns about.
  //
  // Instead: reply immediately when the utterance looks finished, and hold it
  // for GRACE_MS when it does not. Only incomplete turns pay the cost.
  // How long to hold before giving up and replying to the fragment. This is a
  // BACKSTOP, not the primary release: the primary releases are (a) a new final
  // that completes the thought, and (b) Deepgram's UtteranceEnd.
  const GRACE_MS = Number(process.env.TURN_GRACE_MS ?? 1200);
  // Fragments can keep arriving ("I think... the thing... in the..."). Cap the
  // total hold so we never leave a caller waiting indefinitely for a reply.
  const MAX_HOLD_MS = Number(process.env.TURN_MAX_HOLD_MS ?? 4000);
  let held = null;
  let holds = 0;
  // The VAD knows speech ended before the ASR does: our hangover fires ~500ms
  // after the last sound, while Deepgram still owes us 300ms of endpointing plus
  // a network hop. Firing the moment the VAD goes quiet therefore drops the
  // continuation we were waiting for. Wait this long after quiet for the ASR to
  // catch up.
  const ASR_SETTLE_MS = Number(process.env.TURN_ASR_SETTLE_MS ?? 400);
  let quietSinceWall = null;

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
    bargeCandidate = null;
    if (held) { clearTimeout(held.timer); held = null; }
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
    // Backstop only. server.js warms at the TwiML webhook and at browser page
    // load, which is far earlier; this catches a transport that reached us by
    // some other path. Rate-limited there, so normally a no-op.
    Promise.all([llm.warm?.(), tts.warm?.()]).catch(() => {});

    const picked = createVad({ sampleRate });
    vad = picked.vad;
    console.log(`[${label}] vad=${picked.kind}`);
    vad.on('speechStart', ({ atMs }) => {
      if (speaking) {
        // Provisional. Resolved on the audio clock in the frame handler, not by
        // a wall-clock timer, and not by VAD 'speechEnd' -- that has a 500ms
        // hangover, so it arrives after our 350ms window has already closed.
        bargeCandidate = { atMs };
        overlapped = true;
        return;
      }
      quietSinceWall = null;
      overlapped = false;
      console.log(`[${label}] VAD speech start @${atMs}ms`);
    });
    vad.on('speechEnd', ({ atMs }) => {
      quietSinceWall = performance.now();
      console.log(`[${label}] VAD speech end @${atMs}ms`);
    });

    asr.on('error', (err) => console.error(`[${label}] asr error: ${err.message}`));

    /**
     * UtteranceEnd: Deepgram is certain the turn is over.
     *
     * M2 rejected this as the turn signal because it lands ~1765ms after the
     * last word and cannot be tuned below a 1000ms floor. But for a HELD
     * fragment it is exactly right: we have already decided to wait, and this
     * is the only authoritative "nothing more is coming" the ASR offers.
     *
     * The alternative was guessing a fixed settle window, and that guess was
     * wrong twice — 400ms and 700ms both fired before a continuation that was
     * genuinely in flight, producing "I did not catch that" and costing a whole
     * wasted round trip. Being slow here is cheaper than being wrong.
     */
    asr.on('utteranceEnd', () => {
      if (!held) return;
      clearTimeout(held.timer);
      const h = held;
      held = null;
      console.log(`[${label}] utteranceEnd — "${h.text}" really was the whole turn`);
      fire(h.text, h.lastWordWall);
    });

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
      // DO NOT discard pendingFinals here.
      //
      // This used to clear them, written in M3 before the gag existed, when the
      // ASR really could be transcribing our own voice off the caller's speaker.
      // It cannot now: while `speaking` we feed the ASR silence, so anything it
      // produces during a reply is the caller's genuine speech, captured before
      // the gag began.
      //
      // It was actively destroying words. Deepgram's time-to-final for a
      // continuation after a mid-utterance pause measured anywhere from 200ms to
      // 6.8s, so a late final is normal, not exceptional -- and this line threw
      // away "42 Oak Street," a full second after the caller said it. Keep the
      // words; they become the front of the next turn.
      if (pendingFinals.length) {
        console.log(`[${label}] carrying over from during our turn: "${pendingFinals.join(' ').trim()}"`);
      }
    });
    const t0dbg = performance.now();
    if (process.env.DEBUG_ASR) {
      asr.on('interim', ({ text }) => console.log(`[dbg ${(performance.now() - t0dbg).toFixed(0)}ms] interim "${text}"`));
      asr.on('speechFinal', ({ text, endMs }) => console.log(`[dbg ${(performance.now() - t0dbg).toFixed(0)}ms] SPEECH_FINAL "${text}" endMs=${endMs}`));
      asr.on('utteranceEnd', ({ lastWordEndMs }) => console.log(`[dbg ${(performance.now() - t0dbg).toFixed(0)}ms] UTTERANCE_END lastWordEnd=${lastWordEndMs}`));
    }
    asr.on('final', ({ text, endMs }) => {
      if (process.env.DEBUG_ASR) console.log(`[dbg ${(performance.now() - t0dbg).toFixed(0)}ms] final "${text}" endMs=${endMs}`);
      pendingFinals.push(text);
    });

    // speech_final, not utteranceEnd: 335ms vs 1765ms. See docs/02-asr.md.
    const fire = (text, lastWordWall) => {
      if (turnBusy) {
        console.log(`[${label}] (ignored while speaking: "${text}")`);
        return;
      }
      turnBusy = true;
      runTurn(text, lastWordWall)
        .catch((err) => {
          // An abort is barge-in working as designed, not an error. fetch()
          // surfaces it as a DOMException named AbortError.
          if (err?.name === 'AbortError') return;
          console.error(`[${label}] turn failed: ${err.message}`);
        })
        .finally(() => { turnBusy = false; });
    };

    asr.on('speechFinal', ({ endMs }) => {
      // Wall-clock time of the caller's last word, via the audio clock.
      const lastWordWall = audioZeroWall === null ? performance.now() : audioZeroWall + endMs;
      const chunk = pendingFinals.join(' ').trim();
      pendingFinals = [];
      if (!chunk) return;

      if (overlapped && BACKCHANNEL_WORDS.test(chunk)) {
        backchannels += 1;
        console.log(`[${label}] backchannel ignored: "${chunk}" (spoken over us)`);
        return;
      }

      // Glue this onto anything we were holding back.
      let text = chunk;
      let heldSince = performance.now();
      if (held) {
        clearTimeout(held.timer);
        text = `${held.text} ${chunk}`.trim();
        heldSince = held.heldSince;
        held = null;
      }

      const verdict = looksComplete(text);
      if (verdict.complete) {
        fire(text, lastWordWall);
        return;
      }

      if (performance.now() - heldSince >= MAX_HOLD_MS) {
        console.log(`[${label}] held ${MAX_HOLD_MS}ms already — replying to "${text}" regardless`);
        fire(text, lastWordWall);
        return;
      }

      holds += 1;
      console.log(`[${label}] HOLD "${text}" — ${verdict.reason}`);
      held = { text, lastWordWall, heldSince };

      const expire = () => {
        // Never fire while they are audibly still going.
        if (vad?.active) {
          held.timer = setTimeout(expire, 100);
          return;
        }
        // Quiet, but the ASR may still owe us words from that last burst.
        if (quietSinceWall !== null && performance.now() - quietSinceWall < ASR_SETTLE_MS) {
          held.timer = setTimeout(expire, 100);
          return;
        }
        const h = held;
        held = null;
        console.log(`[${label}] backstop expired — replying to "${h.text}"`);
        fire(h.text, h.lastWordWall);
      };
      held.timer = setTimeout(expire, GRACE_MS);
    });
  });

  transport.on('frame', (frame) => {
    if (audioZeroWall === null) audioZeroWall = performance.now() - frame.timestampMs;
    // The VAD always sees real audio, even while we are speaking. The ASR does
    // not. That asymmetry is deliberate: we need to know the caller started
    // talking without paying to transcribe our own voice back to ourselves.
    vad?.push(frame.pcm, frame.timestampMs);

    // Resolve a pending barge-in candidate once the window has elapsed in AUDIO
    // time. Still making noise => a real interruption. Gone quiet => a
    // backchannel, and we keep talking.
    if (bargeCandidate && frame.timestampMs - bargeCandidate.atMs >= BACKCHANNEL_MS) {
      const quietForMs = frame.timestampMs - vad.lastLoudAtMs;
      if (quietForMs <= 60) {
        bargeIn(bargeCandidate.atMs);
      } else {
        backchannels += 1;
        console.log(`[${label}] backchannel ignored @${bargeCandidate.atMs}ms (quiet again after ${BACKCHANNEL_MS - quietForMs}ms) — still speaking`);
      }
      bargeCandidate = null;
    if (held) { clearTimeout(held.timer); held = null; }
    }

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
    // While a barge-in candidate is pending we feed REAL audio, not silence:
    // if it turns out to be an interruption, its first 350ms would otherwise be
    // lost and the caller would have to repeat their first words. If it turns
    // out to be a backchannel, the resulting "Mhm." is discarded with the rest
    // of pendingFinals when our turn ends.
    const gag = speaking && !bargeCandidate;
    asr?.write(gag ? SILENT_FRAME(frame.pcm.length) : frame.pcm);
  });
  transport.on('error', (err) => console.error(`[${label}] transport error: ${err.message}`));

  transport.on('stop', () => {
    asr?.finish();
    if (held) { clearTimeout(held.timer); held = null; }
    if (holds) console.log(`[${label}] incomplete utterances held: ${holds}`);
    if (backchannels) console.log(`[${label}] backchannels ignored: ${backchannels}`);
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
