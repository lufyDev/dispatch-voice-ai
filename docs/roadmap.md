# Dispatch — roadmap

**Current milestone: M5**

Each milestone ends with a commit and a notes file in `docs/`.

---

## M0 — Foundations ✅
Concepts only, no code. See `docs/00-foundations.md`.
Latency budget, ASR, turn-taking, interruption handling, telephony layer, challenges, metrics.

## M1 — Telephony transport ✅
Notes: `docs/01-telephony.md`
**Goal:** a real phone call reaches my laptop and I echo the caller's audio back to them.

- Express server + TwiML endpoint that returns a `<Connect><Stream>` response
- WebSocket server handling Twilio's message protocol (`connected`, `start`, `media`, `stop`)
- Echo inbound media frames back outbound
- Log frame count, byte size, arrival timing
- Same loop working over the browser mic (`BrowserTransport`)

**Learn:** μ-law encoding, 8kHz narrowband, 20ms framing, base64 over WebSocket,
streamSid/sequence numbers, `mark` and `clear` messages, why a tunnel is needed.

**Done when:** I call the number, hear myself echoed back, and can state the measured
round-trip delay.

## M2 — Streaming ASR ✅
Notes: `docs/02-asr.md`
Deepgram WebSocket, interim vs final transcripts, endpointing config, keyword boosting for
HVAC vocabulary, resampling 8kHz μ-law → 16kHz PCM. Measure time-from-speech-end to final.

## M3 — Close the loop ✅
Notes: `docs/03-loop.md`. Baseline: voice-to-voice p50 1937ms, target 800ms.
LLM + TTS wired in. First real conversation. Sentence-boundary chunking into TTS. Per-turn
latency trace logging every hop. Establish the baseline number we spend M4+ improving.

## M4 — Turn-taking and interruption ✅
Notes: `docs/04-turntaking.md`. Barge-in p50 0.8ms; voice-to-voice p50 1637ms.
Silero VAD, silence-timer endpointing, then semantic turn detection. Barge-in: detect, stop
TTS, flush buffer (`clear`), cancel LLM, truncate history to what was actually heard.
Backchannel filtering.

## M5 — Tools and booking
Function calling: `check_availability`, `book_job`, `create_emergency_alert`,
`lookup_customer`. MongoDB schema. Slot filling with read-back confirmation. Idempotency
keys so a retry can't double-book.

## M6 — Conversation design and guardrails
State machine vs free-form agent. System prompt engineering for voice (short sentences, no
markdown, no lists). Emergency triage classifier tuned for recall. Refusing to quote prices
it doesn't know. Graceful escalation to human.

## M7 — Observability and evals
Call log dashboard (Next.js + Tailwind): transcript, tool calls, per-turn latency waterfall,
audio playback. Simulated-caller test suite for regression testing.

## M8 — Frameworks and speech-to-speech
Rebuild the core on LiveKit Agents or Pipecat. Compare what the framework gave us vs what it
hid. Then try the same agent speech-to-speech and compare latency, cost, control, auditability.

## M9 — Interview drill
System design writeup. Latency numbers before/after. War stories from every bug we hit.
