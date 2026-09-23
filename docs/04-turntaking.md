# M4 — Turn-taking and interruption

**Goal:** the agent stops when you talk over it, knows what you actually heard, and
does not cut you off when you pause to think.

This is the milestone that separates a voice agent from a walkie-talkie, and it is the
one an interviewer will push hardest on.

---

## What we built

```
src/vad/vad.js              the VAD contract
src/vad/energy.js           RMS + percentile noise floor, hand-written
src/vad/silero.js           Silero v5 ONNX behind the same contract
src/vad/index.js            picks one, falls back to energy
src/turn/completeness.js    "does this look like a finished thought?"
src/pipeline/converse.js    barge-in, history truncation, dynamic endpointing
scripts/test-vad.js         energy vs silero on identical audio
scripts/test-completeness.js 23 cases from real transcripts
```

`npm run fetch-model` pulls the 2.3MB Silero model. `VAD=energy` to swap.

---

## Concepts

### Barge-in is five things, and everyone forgets the fifth

1. **Detect** the caller started talking — local VAD
2. **Stop generating** — abort the LLM mid-stream
3. **Stop synthesising** — abort the TTS
4. **Flush the far end** — `clear()`, because seconds of your voice are already queued
5. **Truncate history to what the caller actually heard**

**Order matters.** `clear()` goes first. What sits queued at the far end is what the
caller is hearing *right now*; every millisecond spent tidying up your own generators is
another millisecond of talking over a human. Cancelling the LLM first is politer to your
bill and ruder to the person.

**#5 is the one that breaks agents.** Measured, before we fixed it:

```
AGENT: "That sounds like an emergency. I am alerting the on-call technician now.
        Can I have your name, please?"
        ^ caller interrupted about here
...next turn...
AGENT: "Thank you. I am STILL alerting the on-call technician now.
        Can you please provide your name?"
```

The caller heard five words. History recorded twenty-two. So the agent believed it had
asked for a name and been ignored, and said "still". The conversation desynchronised from
reality — and no amount of prompt engineering fixes it, because the prompt is not wrong,
the *history* is.

### Only `mark` can answer "what did they hear?"

`send()` reports what you handed over. Measured on one turn: generation finished at
**1615ms**, the reply was **4.97 seconds** of audio. So "we finished sending" happens
~3.4 seconds before "they finished hearing".

This bit us twice before we used the tool built for it in M1:

- **M3**, the agent heard itself: the mic reopened when sending finished, so the last ~5
  seconds of the agent's own voice went into the ASR and came back as the next user turn.
- **M4**, history desync: the same gap, now corrupting memory instead of input.

So we place a mark after **every sentence**, plus one behind the first chunk of audio, and
track them as positions on a per-turn audio timeline:

```
sentMs        audio handed to the transport so far
markPos       mark name -> its position on that timeline
playPos/Wall  the last position a mark confirmed, and when it came back
spoken[]      each sentence's [startMs, endMs) on the same timeline
```

Playback position is `playPos + (now - playWall)`. Sentences behind the cursor are
certain; the one the cursor sits inside is interpolated by word.

**A detail that took a debugging pass:** the first mark must go *behind* the first chunk of
real audio, not before it. A mark sent while the far end's queue is empty gets scheduled at
"now" and returns immediately — hundreds of ms before playback starts — inflating what you
believe the caller heard.

Result:

```
AGENT:              "That sounds like an emergency. I am alerting the on-call
                     technician now. Can I have your name, please?"
AGENT (heard only): "That sounds like an emergency."        <- sentence level

AGENT:              "Is the water heater leaking and causing the flooding?"
AGENT (heard only): "Is the water heater leaking and—"      <- word level
```

### Dynamic endpointing

The first real mic test found this immediately:

```
USER:  "Hi. My"
AGENT: "I didn't catch that. Could you please repeat?"
USER:  "basement is flooding."
```

One thought, two turns. We had told Deepgram "300ms of quiet means done", and a human drew
breath after "my". **Synthetic speech never reproduced it** — `say` emits one smooth stream
with no breaths. Every real caller pauses.

Raising the threshold to 700ms fixes it by making *every* turn 400ms slower, which is the
lazy default `00-foundations.md` warns about. Instead: classify the utterance, reply at once
when it looks finished, hold it when it does not. Only incomplete turns pay.

**Why rules and not an LLM.** Asking a model "is this complete?" is the obvious design and a
non-starter here: our measured round trip to OpenAI is ~1000ms, so the classifier would cost
more than the wait it saves. Rules run in microseconds.

The classifier: dangling words (fillers, conjunctions, determiners, prepositions,
auxiliaries), a stock-short-answer list, and Deepgram's own terminal punctuation.

---

## What surprised us

### 1. The energy VAD deadlocked, and measuring found it

The obvious noise floor — "adapt it while we think it is silent" — cannot bootstrap. If the
floor starts below the real noise, every frame looks like speech, so it is never silent, so
the floor never adapts.

```
condition    naive floor                 percentile floor
clean        start -20ms                 start -20ms
SNR 39dB     start -20ms                 start -20ms
SNR 25dB     fired at t=0, never ended   start -20ms, one clean segment
SNR 16dB     fired at t=0, never ended   start -20ms, one clean segment
```

Fix: a low percentile of a 3-second window of frame energies. Speech is intermittent enough
that the quietest 20% is background even mid-sentence, so there is no state to deadlock.

### 2. Silero's undocumented context window

v5 keeps an internal context: its Python wrapper prepends the previous 32 samples (at 8kHz)
to each chunk, so the model wants **288** samples, not 256. This is not on the ONNX graph,
the input dimension is dynamic, and ONNX **accepted 256 silently**, returning a max
probability of **0.37 on crystal-clear speech**.

That reads as "this model is bad at 8kHz", not "you are calling it wrong" — which is how you
lose an afternoon. With the context prepended: **max 1.000, 96% of speech windows over
threshold**.

Precisely the class of detail an SDK hides and you then cannot debug.

### 3. Energy vs Silero — closer than expected, except where it matters

```
condition              energy              silero
clean                  start -20ms         start +8ms
noise SNR ~25dB        start -20ms         start +8ms
noise SNR ~16dB        start -20ms         start +8ms
noise SNR ~10dB        start -20ms         start +8ms
door slam, NO speech   FALSE TRIGGER       correctly silent
cost per 20ms frame    11us                156us
```

They are **equivalent at finding speech**, down to 10dB SNR. The percentile fix mattered
more than the model swap.

The door slam is the entire argument. Energy cannot distinguish loud-and-not-speech, and on
a phone line that means a spurious barge-in: the agent cutting itself off because someone
shut a door. Cost is a non-issue — 156µs against a 20,000µs frame budget is 128× headroom.

**What I would ship:** Silero. **What I would defend keeping:** energy, because it is 40
lines with no native dependency and genuinely fine above 10dB SNR in a room without
transients — and because having both is the only reason this table exists.

### 4. Duration cannot separate backchannels from interruptions

"mhm" and "yeah" are the listener saying *"I'm still here, keep going"*. An agent that stops
dead for them is exhausting. The obvious filter is duration. Measured voiced lengths:

```
"mhm"    740ms   backchannel
"uh huh" 600ms   backchannel
"okay"   520ms   backchannel
"yeah"   420ms   backchannel
"right"  300ms   backchannel
"wait"   ~300ms  INTERRUPTION
```

**The distributions overlap.** "wait" and "stop" are shorter than "mhm", so no threshold
separates them even in principle. A window long enough to catch "mhm" would talk over a real
interruption for three quarters of a second.

So the window is deliberately short (250ms) — it filters clicks, coughs and chair scrapes and
nothing more. "mhm" will stop the agent, and that is the chosen trade: **being talked over
feels worse to a human than an agent that pauses when it did not need to.**

A content gate catches what duration cannot, but it is a second line of defence, not a fix:
**you cannot un-hear a `clear()`.** The agent has already gone quiet by the time the words
arrive.

### 5. A terminal "?" beats any dangling-word rule

Found in a live demo, not in testing:

```
HOLD "What all you can do?" — ends on "do", which needs a continuation
utteranceEnd — "What all you can do?" really was the whole turn
asr-turn-signal=1344ms
```

A complete question, held for 1.3 seconds. "do" is in DANGLING for good reasons
("do you have...", "did they..."), but *"what can you do?"* ends on it and is
finished. The evidence was sitting in the string: Deepgram writes "?" only where it
believes a question ended, and a finished question is a finished thought whatever
word it lands on.

`.` is deliberately NOT treated the same way -- it is the default terminator and much
weaker evidence. Deepgram will punctuate a fragment with one.

After the fix, the same utterance fires at **112ms** with no hold.

The safety net did work -- `utteranceEnd` rescued it rather than the agent answering a
fragment -- but a safety net catching a preventable fall is not a success.

### 6. The content gate ate a legitimate answer

```
AGENT: "Is there no hot water?"
backchannel ignored: "Yes."     <- that was the ANSWER
```

"Yes" over the agent is acknowledgement. "Yes" in the caller's own turn is the answer to a
yes/no question — and a booking agent asks a lot of those. The filter now applies only to
speech that *overlapped* ours.

### 7. Waiting on the VAD is not waiting on the ASR

First attempt at dynamic endpointing released a held fragment when the VAD went quiet. It
still split utterances, because **the VAD knows speech ended before the ASR does**: our
hangover fires ~500ms after the last sound, while Deepgram still owes 300ms of endpointing
plus a network hop. We were firing on the wrong signal and dropping the very continuation we
were holding for.

### 8. A line written for one reason became a bug when its reason expired

The mark handler discarded `pendingFinals`. That was correct in M3, when the ASR really could
be transcribing the agent's own voice off the caller's speaker. Once the gag existed — we feed
the ASR silence while speaking — nothing it produces during a reply is our voice. The line was
destroying real words, throwing away "42 Oak Street," a second after the caller said it.

Worth noting as a class: **a guard whose justification has quietly expired is worse than no
guard, because it looks deliberate.**

---

## Measured numbers

| Metric | Value |
|---|---|
| Barge-in: detection → cleared + aborted | **0.1–3.4ms** (p50 0.8ms) |
| Total perceived interruption latency | ~60ms VAD hysteresis + the above + one network hop |
| VAD speech-start accuracy | energy −20ms, silero +8ms (one frame) |
| VAD cost per 20ms frame | energy 11µs, silero 156µs |
| Paused utterance merged into one turn | asr-turn-signal **266ms** (no grace penalty) |
| Voice-to-voice, 3 interrupted turns | p50 **1637ms**, max 2314ms |
| Completeness classifier | 29/29 cases |

A held fragment that gets completed by the next chunk fires **on the merge**, not on timer
expiry — so the grace period is only paid by an utterance that genuinely was finished but
looked unfinished.

---

## Open questions

1. **Deepgram's time-to-final for a continuation is erratic: 200ms to 6.8s.** In the slow
   case it had the interim within 1s and re-emitted it unchanged once a second for six
   seconds before finalising, with 1.6s of ordinary trailing silence flowing throughout.
   Tested digital-zero vs dithered silence for the gag — no difference. Cause not
   established. The design is now *tolerant* of late finals (they carry into the next turn)
   rather than dependent on them, but a paused utterance late in a session can still be
   split. **This is the most important unresolved item in the milestone.**
2. **No resume after a false barge-in.** We know exactly what the caller heard, so we know
   exactly what is left to say — re-synthesising the remainder is the thing that would make
   backchannel handling actually work.
3. **Half-duplex is still assumed for echo.** The agent is deaf while speaking, so barge-in
   depends on the caller's mic not carrying the agent's voice. True on headphones, false on
   speakerphone and on a real phone line. Proper acoustic echo cancellation, or comparing the
   mic against the known reference signal, is untouched.
4. **`mark` timeout is a guessed 15s.** On a real call a lost mark leaves the agent deaf for
   fifteen seconds, which is a terrible failure mode.
5. **Completeness rules are English-shaped and hand-made.** No labelled evaluation set, so
   "23/23" measures the cases I thought of. A held-out set belongs in M7.
6. **Still not validated on a real phone call.** Everything here is browser mic at 8kHz.
