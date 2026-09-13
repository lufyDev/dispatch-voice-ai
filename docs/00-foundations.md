# M0 — Conversational Voice AI: Foundations

> Project: **Dispatch** — an inbound voice receptionist for an HVAC/plumbing company.
> Notes current as of Sept 2026. Vendor latency/price numbers are published figures — verify before relying on them.

---

## 1. The mental model

A voice agent is a **real-time audio loop with a language model wedged in the middle**. Everything hard about it comes from that word *real-time*.

Text chat: user waits, you stream tokens, user reads. Latency is a comfort problem.
Voice: silence is a **signal**. 300ms of dead air reads as "did it hang up?". 200ms too early and you talk over the caller. There is no loading spinner on a phone call.

Two architectures:

### Cascaded (chained) pipeline

```
caller audio ──► VAD ──► ASR ──► [turn detection] ──► LLM ──► TTS ──► caller
                                          │
                                          └──► tools (book job, check calendar)
```

Each box is a separate vendor/model. You see the transcript, you see the LLM input and output, you can log and eval every hop. You also pay latency at every hop.

### Speech-to-speech (S2S / realtime)

```
caller audio ──► one multimodal model ──► caller audio
```

One model hears audio and emits audio. Better prosody, handles interruption server-side, lower latency. But: no transcript to audit, weaker instruction-following, weaker/flakier tool calling, harder to unit-test, more expensive per minute, and vendor lock-in.

**Rule of thumb in 2026:** production business-critical agents (booking, payments, dispatch) are still overwhelmingly cascaded, because you must be able to prove what the agent said and why. S2S is winning on consumer/companion use cases and is creeping into business voice as tool-calling reliability improves. Many production systems are hybrid — S2S for the conversational surface, a separate text LLM for the decision/tool layer.

**Interview answer:** "I'd pick cascaded for a booking agent. The failure mode that kills you isn't awkward prosody, it's a double-booked Tuesday at 2pm, and I need a transcript and a tool-call log to debug that."

---

## 2. The latency budget

This is the single most useful thing to internalize. Target: **voice-to-voice p50 under 800ms, p95 under 1.5s.** Humans in conversation swap turns with roughly a 200ms gap; anything past ~1.2s feels broken on a phone line.

Typical cascaded budget:

| Stage | Typical | Notes |
|---|---|---|
| Network: caller → your server (PSTN + WebSocket) | 50–150ms | mostly out of your control; co-locate with carrier |
| VAD detects speech stopped | 0ms | runs continuously |
| **Endpointing / turn detection wait** | **200–600ms** | **the biggest single cost, and it's a *choice*** |
| ASR final transcript | 100–300ms | streaming STT is ~150ms behind live audio |
| LLM time-to-first-token | 200–600ms | model choice + prompt size + cache hit |
| LLM first *sentence* (what TTS needs) | +100–300ms | you chunk at sentence boundaries, not full response |
| TTS time-to-first-byte | 40–300ms | Cartesia/ElevenLabs Flash are fastest tier |
| Network back | 50–150ms | |

Add it up: a naive implementation lands at 1.5–2.5s. Getting under 800ms requires deliberate work.

### The levers (memorize these)

1. **Smarter endpointing.** VAD + fixed 700ms silence timer is the lazy default and the worst offender. A semantic turn detector cuts the wait when the user clearly finished ("...my address is 42 Sector 14") and extends it when they clearly didn't ("...my address is, uh,"). Biggest single win available.
2. **Stream everything.** Never wait for a full ASR transcript, full LLM response, or full TTS audio. Pipe partials forward.
3. **Chunk TTS at sentence boundaries.** Send "Sure, I can help with that." to TTS while the LLM is still writing sentence two. First audio out the door 400ms earlier.
4. **Speculative / preemptive generation.** Start the LLM call on the *interim* transcript before endpointing fires. If the user keeps talking, cancel and redo. Costs tokens, buys ~300ms.
5. **Prompt caching.** Your system prompt is 2000 tokens of business rules and doesn't change. Cache it.
6. **Small fast model + tools.** A 7B-class or Flash/Haiku-tier model handles "what's your address?" fine. Route to a bigger model only for hard turns.
7. **Filler audio.** Play "Let me check that for you…" while a 2s calendar API call runs. This is a UX fix, not a latency fix — but callers perceive it as faster. Use sparingly; overuse sounds robotic.
8. **Co-location.** Your server in the same region as the carrier PoP and the model provider. 100ms is free money.

---

## 3. ASR (speech-to-text) — what actually matters

### Streaming vs batch
Batch (Whisper on a file) is irrelevant here. You need **streaming**: audio goes in over a WebSocket, partial transcripts come back continuously.

### Interim vs final results
- **Interim (partial)**: "I need someone to look at my" — low confidence, *mutable*, can change as more audio arrives.
- **Final**: stabilized, won't change.

Interims are great for speculative LLM calls and for detecting barge-in. Finals are what you commit to conversation history. A classic bug: building conversation state from interims and getting a history full of half-sentences.

### Endpointing
The STT provider usually offers its own endpointing (e.g. `endpointing=300ms`, `utterance_end_ms`). This is acoustic only — it's a silence timer. It does not know the difference between a thinking pause and a finished thought.

### Metrics
- **WER (word error rate)** — the headline number. Production English streaming models sit around 6–7% WER on clean audio. On a phone line with a truck engine in the background, expect much worse.
- **Latency to final** — how far behind live audio.
- Vendor WER benchmarks are on curated datasets. Your real number on 8kHz telephony audio with Indian/American/Hispanic accents will be worse. **Always benchmark on your own recordings.**

### Telephony-specific ASR pain
- **8kHz narrowband.** Phone audio is half the sample rate of "normal" 16kHz ASR training data. Models tuned for telephony matter.
- **Codec artifacts.** μ-law/PCMU compression, packet loss, jitter.
- **Domain vocabulary.** "Carrier," "Trane," "Lennox," "condenser," "capacitor," "R-410A," "mini-split." Generic ASR mangles these. Use **keyword boosting / custom vocabulary** — cheap, high leverage.
- **Numbers and spellings.** Addresses, phone numbers, names. "Fifteen" vs "fifty" is a WER of 1 word and a truck at the wrong house. Always read back critical slots: *"That's 1-5, one-five Oak Street — correct?"*
- **Whisper hallucinates on silence.** Famous failure: silence or noise produces "Thank you for watching!" Guard against empty-ish audio.

---

## 4. Turn-taking — the hardest problem

> "Is the user done talking?" is asked on every single pause, and both wrong answers are bad.

**Answer too early** → you interrupt the caller. Feels rude, they repeat themselves, call falls apart.
**Answer too late** → dead air, caller says "hello? hello?", or starts talking again just as you do.

### Levels of sophistication

**Level 1 — VAD + silence timer.** Silero/WebRTC VAD detects speech/no-speech. After N ms of silence, commit the turn. Simple, and wrong constantly: "My address is…" *(thinking)* → interrupted. Tuning N just moves the pain between the two failure modes.

**Level 2 — semantic turn detection (text).** Feed the transcript-so-far to a small model that predicts "is this a complete thought?" Fine-tuned small LLMs (sub-1B) run on CPU in ~10–30ms. Big improvement. Ceiling: text alone can't hear intonation. "You're closing at five?" and "You're closing at five." are the same string.

**Level 3 — audio-native turn detection.** Models that consume raw audio and fuse acoustic cues (pitch, rhythm, terminal intonation) with semantics. Current SOTA — LiveKit's Turn Detector v1 is the reference implementation, and Deepgram's Flux family folds turn detection into the STT model itself.

### Other turn-taking phenomena to know

- **Backchannels.** "mhm", "yeah", "right", "okay" — the listener signalling *keep going*, not taking the turn. A naive agent treats every "mhm" as an interruption and stops talking. You must classify and ignore these. (And ideally *emit* them — a well-timed "mm-hm" while the caller describes their broken AC makes the agent feel dramatically more human.)
- **Double-talk / overlap.** Both parties speaking. Humans handle it; you need a policy (usually: agent yields).
- **Trailing-off / self-repair.** "I need a— actually can you come Thursday instead."
- **The IVR hangover.** Callers trained on phone menus talk in keyword bursts ("REPRESENTATIVE") or pause in odd places. Real-world audio doesn't look like your test recordings.

---

## 5. Interruption handling (barge-in)

When the caller starts talking while the agent is speaking, four things must happen — and getting #4 wrong is a subtle, common bug.

1. **Detect** — VAD on the inbound stream fires during agent playback. Must distinguish real speech from background noise (a barking dog should not stop the agent) and from the agent's own voice echoing back (**acoustic echo cancellation** — less of an issue on PSTN, critical on speakerphone/WebRTC).
2. **Stop TTS immediately** — cancel the synthesis request *and* flush the audio buffer. You may have already pushed 3 seconds of audio downstream that's sitting in a jitter buffer. If you only stop generating, the caller keeps hearing the agent for seconds after they interrupted. Feels broken.
3. **Cancel the LLM** — abort the in-flight completion, it's stale now.
4. **Truncate conversation history to what was *actually heard*.** ← the subtle one.

On #4: your LLM "said" the full sentence *"Your appointment is confirmed for Tuesday at 2pm and a technician will call ahead."* But the caller interrupted 1.1 seconds in. They only heard *"Your appointment is confirmed for Tues—"*. If you write the full string to history, the agent now believes it communicated the callback detail and will never repeat it. The caller never heard it.

**Fix:** track playback position, estimate words actually emitted (word-level timestamps from TTS if available, otherwise time-based estimate), and truncate the assistant message to that point, typically with a marker: `"Your appointment is confirmed for Tues—" [interrupted]`.

This is an excellent interview answer — it shows you've actually built one of these rather than read about them.

---

## 6. TTS — what matters

- **TTFB (time to first byte)** is the metric, not total synthesis time. You're streaming. Sub-100ms tier exists (Cartesia Sonic, ElevenLabs Flash); premium-quality voices run 200–400ms.
- **Stream in, stream out.** Feed TTS partial LLM output; get audio chunks back immediately.
- **Normalization is a real problem.** How does your TTS say `$1,250.00`? `2-4pm`? `A/C`? `HVAC`? `Sector 14, Gurugram`? `+91 8193809760`? Most engines get some of these wrong. You normalize *in text* before synthesis: write "twelve fifty" or "between two and four PM". This is unglamorous and absolutely necessary for a booking agent quoting prices and times.
- **Prosody and pacing.** Phone numbers and addresses should be read slower with pauses. SSML or engine-specific controls.
- **Voice selection.** For a plumbing company in Ohio, a neutral American voice outperforms a "premium" British one. Match the customer's expectation, not your aesthetic.

---

## 7. Telephony layer

Concepts you need even if the platform hides them:

- **PSTN** — the actual phone network. **SIP** — the signalling protocol for VoIP. **SIP trunk** — your connection into the phone network. **DID** — a phone number you own.
- **Media streams.** Twilio's `<Stream>` TwiML verb opens a WebSocket and sends you base64 μ-law 8kHz audio in 20ms frames (160 bytes). You send audio back the same way. This is the raw interface you'll build against in M1.
- **Codecs.** PCMU (μ-law, G.711) is the telephony default: 8kHz, 8-bit, lossy-ish, ubiquitous. Your ASR wants 16kHz linear PCM. You will be resampling and transcoding.
- **DTMF** — keypad tones. Still needed: "press 1 for emergency", entering account numbers, navigating another company's IVR.
- **Answering machine detection (AMD)** — for outbound. Did a human or a voicemail greeting answer? Hard problem, lots of false positives.
- **Call transfer** — cold (blind handoff) vs warm (agent briefs the human first, "I have Maria on the line, no hot water, she's a repeat customer"). Warm transfer is a product differentiator.
- **Concurrency** — 50 simultaneous calls means 50 WebSockets, 50 ASR streams, 50 LLM sessions. Capacity planning and cost scale linearly.
- **Compliance.** US call recording consent varies by state (some require all-party consent). TCPA governs outbound calling. STIR/SHAKEN affects whether your outbound calls show as "Spam Likely". For a US home-services product these are real constraints, not footnotes.

---

## 8. The honest list of challenges

Grouped, because the interview will ask "what's hard about this?"

**Acoustic**
Background noise (job sites, traffic, kids, TV), speakerphone echo, poor cell signal, packet loss, accents, code-switching (English/Spanish is huge in US home services), fast talkers, elderly callers, children answering the phone.

**Conversational**
Endpointing, barge-in, backchannels, callers who ramble for 90 seconds, callers who say nothing, non-linear conversations ("actually, change that to Friday"), callers who realize it's a bot and either test it or get hostile, emotional callers (no heat, winter, baby at home).

**Correctness — the ones that cost money**
Hallucinated availability ("yes we can come at 6am Sunday" — you can't). Double-booking from a race between two concurrent calls. Wrong address. Wrong price quote — a quoted price may be legally binding. Mis-triaged emergency: **a gas smell classified as routine is the catastrophic failure mode**, and it's a *recall* problem — you accept false positives to drive false negatives to zero.

**Systems**
Latency, cost per minute, state management across a call, idempotency on tool calls (network retry must not create two jobs), integration with the customer's existing Field Service Management software (ServiceTitan, Housecall Pro, Jobber) — each with its own API, data model, and quirks. This integration surface is where most of the actual engineering effort lives in a company like Broccoli.

**Evaluation**
Non-deterministic system, no ground truth, "was that a good call?" is subjective. Regression testing means simulated callers. More in M7.

---

## 9. The metrics that matter to the business

Not latency — latency is an input. These are the outputs a contractor cares about:

- **Containment / automation rate** — % of calls fully handled without a human.
- **Booking conversion** — % of inbound calls that became a scheduled job. This is the revenue number. An agent that books 40% vs a voicemail that books 0% is the entire pitch.
- **After-hours capture** — the wedge. Contractors are on roofs at 2pm and asleep at 2am. Missed calls go to a competitor.
- **Emergency detection recall** — must be ~100%. Optimize for zero false negatives.
- **Escalation rate and reason** — where the agent gives up tells you what to build next.
- **Cost per call** vs. cost of a human CSR or answering service.
- **Time-to-first-response** — agent picks up in 1 ring, 24/7. Humans don't.

---

## 10. Component choices for Dispatch

We build cascaded, with every layer swappable behind an interface. Defaults:

| Layer | Pick | Why |
|---|---|---|
| Telephony | Twilio Media Streams | best docs, raw WebSocket access, you see the bytes |
| Transport | Node + `ws` | your stack; forces you to handle framing yourself |
| VAD | Silero (ONNX) | standard, runs local, ~1ms |
| ASR | Deepgram (Nova-3 / Flux) | strong streaming latency, keyword boosting, telephony-tuned |
| LLM | a fast small model with reliable tool calling | swap-able; measure TTFT yourself |
| TTS | Cartesia or ElevenLabs Flash | sub-100ms TTFB tier |
| Store | MongoDB | your stack; stands in for the FSM system |
| Dashboard | Next.js | call log, transcripts, per-turn latency traces |

**Design rule from day one:** the pipeline must not know it's on a phone. Build a `Transport` interface with two implementations — `TwilioTransport` and `BrowserTransport` (WebRTC/mic). You'll develop 95% of the time against the browser (free, fast, no international call charges from India) and flip to Twilio to validate.

---

## 11. Before M1 — accounts to create

- Twilio (trial is fine; buy one US number)
- Deepgram (free credit)
- An LLM API key you already have
- Cartesia or ElevenLabs (free tier)
- ngrok or Cloudflare Tunnel — Twilio must reach your laptop over a public WSS URL

Rough cost to build this whole thing: a few dollars. Keep an eye on TTS credits.

---

## 12. Self-check before M1

Answer these out loud. If you can't, reread the relevant section.

1. Why is endpointing the biggest item in the latency budget, and why is making it faster *not* just a matter of lowering the silence threshold?
2. The caller interrupts the agent 1 second into a 4-second sentence. Name all four things that must happen, and which one is most commonly done wrong.
3. Why does a booking agent usually use a cascaded pipeline instead of speech-to-speech?
4. Your agent says "your total is $1,250" but the TTS reads it as "one two five zero zero zero". Where do you fix this and why not in the LLM prompt?
5. Why is emergency detection a recall problem rather than an accuracy problem?

---

**Next: M1 — Twilio inbound call → WebSocket → echo the caller's audio back to them.** Small, but it forces you to confront μ-law, 20ms framing, and the sequencing rules of a live media stream. Everything after that is just swapping what sits in the middle.
