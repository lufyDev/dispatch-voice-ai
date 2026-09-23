# M3 — Closing the loop

**Goal:** a real conversation. Audio → text → LLM → speech → audio. Plus a per-turn latency
trace, because M4 onward is spent improving a number that has to exist first.

---

## What we built

```
src/llm/llm.js              LLM contract (pull-based, AbortSignal)
src/llm/openai.js           streaming chat completions, SSE parsed by hand
src/tts/tts.js              TTS contract
src/tts/elevenlabs.js       ElevenLabs Flash -> mu-law 8kHz -> PCM16
src/pipeline/converse.js    the full loop + latency waterfall
src/prompts/dispatcher.js   system prompt written for speech, not text
```

`PIPELINE=converse`. Needs `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`.

---

## Design decisions

### Push for audio, pull for tokens

`Transport` and `ASR` are EventEmitters: audio arrives whether you are ready or not, and
backpressure is wrong because you cannot ask a caller to talk slower.

`LLM` and `TTS` are async generators. We control the pace, and more importantly we need to
**stop mid-sentence** when the caller interrupts. Both take an `AbortSignal` — unused until M4,
but retrofitting cancellation into a pipeline is much worse than designing for it.

### Sentence-boundary chunking

Sentence 1 goes to TTS while the LLM is still writing sentence 2. Waiting for the complete
reply would add the entire generation time to time-to-first-audio. Audio must still *play* in
order, so sentences enter a queue that one worker drains sequentially.

Measured effect: `first-sentence` lands 10–20ms after `llm-first-token` for short replies, so
on one-sentence answers this buys little. It matters on longer replies, and it is free.

### `output_format=ulaw_8000`, decoded with our own codec

ElevenLabs can emit mu-law 8kHz directly, so the output path is:

```
ElevenLabs mu-law 8kHz -> mulaw.decode() -> PCM16 8kHz -> transport
```

**No resampling anywhere.** Asking for `pcm_16000` would mean building a downsampler with an
anti-alias filter for audio that ends up band-limited to 4kHz regardless. The M1 codec paid for
itself here.

### HTTP streaming, not the TTS WebSocket

One request per sentence, which is the chunking we want anyway, and far less machinery. The
WebSocket API amortises connection setup across sentences and is the obvious M4 optimisation —
once we can measure whether that setup actually costs anything.

### The prompt is written for speech

An LLM's default register is *written* English: markdown, bullet lists, long hedged sentences.
A TTS engine reads "asterisk asterisk" out loud. The prompt forbids markdown, caps replies at
one or two sentences, and mandates one question at a time. M6 does this properly.

---

## What surprised us

### 1. The LLM hop was 5× my prediction, and it is not the model

Predicted 300–500ms for `gpt-4o-mini` time-to-first-token. Measured **1316–2008ms**.

So we measured the network instead of theorising:

| Request | Time |
|---|---|
| `GET /v1/models` (runs **no inference at all**) | 1075ms, 1687ms, 1231ms |
| `POST /chat/completions` TTFT | 793ms, 1384ms, 793ms, 1310ms |
| ICMP ping to `api.openai.com` | **5.5ms** |

An endpoint that does zero model work costs the same as a streaming first token. So
essentially **none** of the LLM latency is inference — it is the round trip from India to
OpenAI's servers. The 5.5ms ping is a CDN edge that does not serve the API.

This kills several optimisations before wasting time on them:

- **Prompt caching** — pointless; the prompt is ~300 tokens and compute isn't the bottleneck
- **A smaller/faster model** — pointless for the same reason
- **Connection pooling** — already happening; runs 2 and 3 were no faster
- **Co-location** — *this is the entire fix*

`docs/00-foundations.md` calls co-location "100ms is free money". From this laptop it is
**~1000ms**, the single largest item in the budget. Deepgram answered in 272ms over the same
link, so this is OpenAI's edge presence specifically, not distance in general.

### 2. TTS was the fast part

`tts-first-byte` lands **291ms** after the first sentence exists. That was the hop I expected
to fight. It needed no tuning.

### 3. The first turn of a call costs 4x the fourth, and it is just TLS

Found in a live demo. One call, four turns:

| turn | llm first token | tts first byte | total |
|---|---|---|---|
| 1st | 2652ms | 5197ms | **5198ms** |
| 2nd | 1425ms | 1929ms | 1930ms |
| 3rd | 1341ms | 1701ms | 1701ms |
| 4th | 997ms | 1207ms | **1207ms** |

Not the model warming up -- there is no such thing. It is opening two fresh HTTPS
connections. A TLS handshake is several round trips, and from here each one is
expensive. Confirmed by accident: the caller hung up and redialled without
restarting the server, so the pooled connections survived, and that call's first
turn was **1896ms instead of 5198ms**.

We handshake with both vendors as early as possible -- at the TwiML webhook for a
phone call, at page load for the browser -- via `warm()` on the LLM and TTS
interfaces.

**But be careful what you claim for it.** A first pass with three samples per
condition looked like it halved time-to-first-token. Five samples says otherwise:

```
COLD  llm-ttft:  642  671  679  879  1532     median 679   max 1532
WARM  llm-ttft:  672  755  776  821   880     median 776   max  880
```

The medians are indistinguishable. The earlier "1400ms -> 680ms" reading came from
a three-sample comparison in which one COLD run (2802ms) was the first request of
the process and paid a cold DNS lookup on top of TLS. **The India->OpenAI hop has
~900ms of inherent run-to-run variance, which is larger than the effect being
measured** -- so any claim from a handful of samples is noise.

What warming genuinely does is **cut the tail**: cold spread 890ms, warm spread
208ms. p95 improves substantially, p50 does not move. Worth keeping, because p95 is
what a caller notices and the cost is one HEAD request -- but "reduces variance",
not "halves latency".

Two details worth keeping:

- The warm-up only needs the TCP + TLS handshake and the DNS lookup. **The HTTP
  response is irrelevant** -- a 401 pools the connection exactly as well as a 200. So
  it is a HEAD request, costs no tokens and no TTS characters, and our TTS-scoped key
  401ing is fine.
- It must never be awaited before serving audio and must never throw: a call should
  not fail, or wait, because a warm-up did.

**A separate first-turn cost that warming cannot touch:** the ASR hop reads ~650ms on
turn one against ~250ms afterwards. That is the Deepgram WebSocket still settling. The
ASR is inherently per-call -- it needs that call's audio -- so there is no equivalent
trick, and this is unaddressed.

**Methodology note, since this cost us a wrong conclusion:** when the effect you are
measuring is smaller than the noise, three samples will confidently tell you
whatever you hoped. Report medians and spreads, or do not report.

### 4. A free ElevenLabs account cannot use Voice Library voices via the API

`21m00Tcm4TlvDq8ikWAM` (Rachel) returns `402 paid_plan_required: "Free users cannot use library
voices via the API"`. Probed candidates with a TTS-scoped key:

```
FAIL  Rachel   21m00Tcm4TlvDq8ikWAM
FAIL  Aria     9BWtsMINqrJLrRacOk9x
OK    Sarah    EXAVITQu4vr4xnSDxMaL
OK    George   JBFqnCBsd6RMkjVDRZzb
OK    Jessica  cgSgspJ2msm6clMCkdW9
OK    Lily     pFZP5JQG7iQjIQuC4Bku
```

Note we could not simply *list* the voices: the API key was deliberately scoped to
Text-to-Speech only, so `GET /v1/voices` returned `401 missing permission voices_read`. Correct
least-privilege behaviour, mildly inconvenient. Probing 6 voices with the text `"ok"` cost 12
characters of the 10k/month quota.

### 5. The agent heard itself, and my guard was worthless

The worst bug of the milestone:

```
AGENT: "...Can I have your name, please?"
USER:  "...Can I have your name, please?"
AGENT: "I did not understand. Can you please repeat that?"
USER:  "I did not understand. Can you please repeat that?"
```

TTS audio left the speaker, the mic picked it up, Deepgram transcribed it, and the pipeline
submitted it as the next user turn. The agent then tried to answer its own question and the
loop fed on itself. Real user speech got mixed in, producing transcripts like `"My name is
Vishal. I still did not understand. Can you please repeat your name?"`.

There *was* a guard — `turnBusy` ignored new speech while replying. It did nothing, and the
reason is exactly M1's lesson:

> **`turnBusy` cleared when we finished *sending* audio, not when the caller finished *hearing*
> it.**

Measured on one turn: generation finished at **1615ms**, the reply was **4.97 seconds** of
audio. So the mic reopened roughly **5 seconds before the agent stopped talking**.

The fix is the `mark` machinery built in M1 and unused since: drop a bookmark behind the last
audio chunk, hold `speaking` until the transport reports playback reached it, and discard
anything captured in the meantime. `scripts/say.js` had to be taught to simulate a playback
device — reporting the mark only after the audio would really have finished — because answering
instantly would have defeated the test.

This is **half-duplex**: deaf while talking, so interruption is impossible. That is M4's job.

### 6. `.env` silently overrode the code default

`PIPELINE` defaulted to `converse` in code but was pinned to `transcribe` in `.env`, so a full
session ran with no LLM and no TTS and looked like it had "worked fine". Also: `node --watch`
reloads on file changes but **not** on `.env` changes, because `dotenv` reads it once at boot.

---

## Measured numbers

Three runs of the same synthetic caller ("my basement is flooding"), plus a live mic session:

| Hop (ms after caller's last word) | run A | run B | run C (mic) |
|---|---|---|---|
| `asr-turn-signal` | 258 | 255 | 317 |
| `llm-first-token` | 2008 | 1316 | 1691 |
| `first-sentence` | 2018 | 1330 | 1711 |
| `tts-first-byte` | 2309 | 1614 | 2204 |
| **AUDIO OUT** | **2309** | **1615** | **2205** |

Live 9-turn mic session: **p50 1937ms, max 2790ms**.

Budget breakdown of a representative turn:

```
  258ms  ASR turn detection     real, tunable, already good
 1750ms  LLM first token        ~1000ms of it is geography, not compute
  291ms  TTS first byte         genuinely fast
───────
 2309ms  voice-to-voice         target is 800ms p50
```

**~3× over target**, and the run-to-run variance on the LLM hop (1316 vs 2008ms, identical
code and prompt) is itself evidence the bottleneck is network, not model.

This is the honest naive baseline: no speculative generation, no persistent TTS connection, no
semantic turn detection, no co-location. Everything M4+ does is measured against it.

---

## Open questions

1. **Co-location is untested and is the biggest single win available.** Deploy to a region near
   OpenAI and re-measure. Expect ~1000ms back, which alone would land us near target.
2. **Barge-in does not exist.** The agent is deaf while speaking. M4.
3. **No tool calling**, so the agent cannot check a calendar or book anything — it improvises.
   M5.
4. **Does a persistent TTS WebSocket beat HTTP-per-sentence?** Unmeasured. TTS is currently the
   cheapest hop, so this may not be worth doing.
5. **The 15s mark-timeout fallback is a guess.** On a real call a lost mark would leave the
   agent deaf for 15 seconds, which is a terrible failure mode. Needs a better bound.
6. **Conversation history grows unbounded.** No truncation, no summarisation. Fine for a
   3-minute call, wrong in general — and M4's "truncate history to what was actually heard"
   interacts with it.
7. **Emergency triage is prompt-only and unevaluated.** It got flooding right once. That is not
   a measurement.
