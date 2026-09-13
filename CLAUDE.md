# Dispatch — voice AI receptionist for home services

## What this is

A learning project. I'm building an inbound voice agent for a fictional HVAC/plumbing
company: it answers the phone, triages emergency vs routine, collects customer details,
checks a schedule, books a job, and escalates emergencies to an on-call tech.

I am preparing for an interview at a company that builds exactly this. **The point is not
a working demo — the point is that I understand every layer well enough to defend design
decisions under questioning.**

## How I want you to work with me

This overrides your normal instinct to just ship code.

1. **Explain before you write.** Before any non-trivial code, say in plain language what
   we're about to build and why. Use concrete examples over abstractions. Assume I'm a
   competent backend engineer who has never touched real-time audio.
2. **Small diffs.** One concept per change. I want to read every line. If a change touches
   more than ~80 lines, stop and split it, or tell me why it can't be split.
3. **No magic.** If you reach for a library that hides something important (resampling,
   framing, VAD), say what it's hiding and offer the manual version first. I'd rather write
   20 lines I understand than call one function I don't.
4. **Make me predict.** Before running something, ask me what I expect to happen. Then we
   run it. Divergence is where the learning is.
5. **Tell me when I'm wrong.** If my approach has a bug, a race, or a bad tradeoff, say so
   directly and explain the failure mode. Don't soften it. I'd rather be corrected now than
   in an interview.
6. **Numbers over vibes.** Whenever we touch latency, we measure. Log timings, don't guess.
7. **Don't skip ahead.** Stay inside the current milestone. If I ask for something from a
   later milestone, say which one it belongs to and ask if I want to jump.

## Stack and conventions

- **JavaScript, not TypeScript.** Plain `.js`, ESM modules (`import`/`export`).
- **Tailwind** for all styling. No CSS files, no styled-components.
- Node.js (LTS), Express for HTTP, `ws` for WebSockets.
- MongoDB via Mongoose — stands in for the contractor's field-service software.
- Next.js for the dashboard (later milestone).
- Env vars in `.env`, never committed. Keep `.env.example` in sync.
- `npm`, not yarn/pnpm.

## Architecture rules

- **The pipeline must not know it's on a phone.** All audio I/O goes through a `Transport`
  interface. Two implementations: `TwilioTransport` (phone) and `BrowserTransport` (mic over
  WebRTC/WebSocket). I develop against the browser and validate on Twilio.
- Every stage (VAD, STT, LLM, TTS) sits behind a swappable interface. I want to be able to
  change vendors in one line and re-measure.
- Cascaded pipeline, not speech-to-speech. Auditability and tool-call reliability matter
  more than prosody for a booking agent.

## Commit convention

One commit per checkpoint, tagged by milestone:

```
M1: twilio media stream echo
M2: deepgram streaming asr with interim transcripts
```

At the end of each milestone, write notes to `docs/NN-<name>.md` covering: what we built,
the concepts behind it, what surprised us, measured numbers, and open questions. These notes
are interview prep material — write them for a reader who wasn't here.

## Roadmap

See `docs/roadmap.md`. Current milestone is tracked there.

## Background reading

`docs/00-foundations.md` has the concept groundwork — latency budget, turn-taking,
interruption handling, telephony basics. Read it before answering design questions.
