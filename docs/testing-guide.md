# Driving it yourself

A map of what exists, and a layered test plan you run. Work down the layers: each
one adds a dependency, and when something breaks you want to already know the
layer below it was fine.

---

## The milestones, one line each

| | name | the one thing it does |
|---|---|---|
| **M0** | Foundations | Concepts only, no code. Latency budget, turn-taking, telephony. `docs/00-foundations.md` |
| **M1** | Telephony transport | Audio gets in and back out. One `Transport` interface, two implementations (phone, browser mic). Echo proves it. |
| **M2** | Streaming ASR | Audio becomes text, live. Deepgram. Found `speech_final` (272ms) beats `UtteranceEnd` (1765ms). |
| **M3** | Close the loop | Text → LLM → speech → audio. First real conversation, and the latency waterfall to measure it. |
| **M4** | Turn-taking | Manners. VAD, barge-in in 0.8ms, history truncated to what was *heard*, and a caller's breath no longer splits their sentence. |
| **M5** | Tools and booking | It stops improvising. Real calendar, real MongoDB, real bookings, and guards so it cannot double-book or book without consent. |
| **M6** | Conversation design | *Next.* Triage tuned for recall, guardrails, no looping, not asking the caller to self-diagnose. |
| M7 | Observability | Dashboard, transcripts, latency waterfalls, a simulated-caller regression suite. |
| M8 | Frameworks | Rebuild on LiveKit/Pipecat, compare what a framework gave vs hid. Then speech-to-speech. |
| M9 | Interview drill | Write-up, before/after numbers, war stories. |

---

## The code, by job

**Audio plumbing** — how sound gets in and out

| file | job |
|---|---|
| `src/transport/transport.js` | The contract. Read this first: it defines the frame format every layer above sees. |
| `src/transport/twilio.js` | Phone. base64, `streamSid`, mu-law, and Twilio's event names stop here. |
| `src/transport/browser.js` | Browser mic. Binary PCM16 on the wire, audio clock derived by counting samples. |
| `src/audio/mulaw.js` | G.711 codec, hand-written. Phone audio is 8 bits, logarithmic. |
| `public/dsp.js` | Low-pass filter + decimator. 48kHz mic → 8kHz phone, without aliasing. |
| `public/capture-worklet.js` | Runs that DSP on the browser's audio thread. |
| `public/index.html` | The dev client: mic capture, playback queue, honours `clear`/`mark`. |

**The stages** — each behind a swappable interface

| file | job |
|---|---|
| `src/asr/deepgram.js` | Speech → text. Raw WebSocket, keepalive, the four turn signals. |
| `src/llm/openai.js` | Text → reply. SSE parsed by hand; yields typed events (text or tool call). |
| `src/tts/elevenlabs.js` | Reply → audio. Asks for `ulaw_8000` so our own codec decodes it — no resampling anywhere. |
| `src/vad/energy.js` | Is anyone talking? RMS + a percentile noise floor. 40 lines, no dependencies. |
| `src/vad/silero.js` | Same question, answered by a neural net. Rejects door slams, which energy cannot. |
| `src/vad/index.js` | Picks one. Read the comment for the measured comparison. |

**Turn-taking** — the hard part

| file | job |
|---|---|
| `src/turn/completeness.js` | "Hi, my" is not a finished thought. Stops a breath splitting a sentence. |
| `src/turn/confirmation.js` | Did the caller agree? Corrections beat agreement. |

**Booking** — actions with consequences

| file | job |
|---|---|
| `src/db/models.js` | Schema. **Read the index comments** — the double-booking guards live there. |
| `src/tools/availability.js` | Computes free windows from technicians' calendars. Issues opaque `slot_id`s. |
| `src/tools/booking.js` | `propose_booking` then `book_job()` with no arguments. Read the comments on why. |
| `src/tools/emergency.js` | Pages the on-call technician. Deliberately breaks the booking rules. |
| `src/tools/index.js` | Registry, and `runTool` which never throws. |
| `src/util/businesstime.js` | Store UTC, speak local. DST handled by iteration, not a fixed offset. |

**The conductor**

| file | job |
|---|---|
| `src/pipeline/converse.js` | The whole conversation. **729 lines and too big** — turn-taking, barge-in, playback tracking, the tool loop and consent state all in one file. Splitting it is real work owed. |
| `src/pipeline/echo.js` | M1's pipeline. Send back what you hear. Still runnable: `PIPELINE=echo`. |
| `src/pipeline/transcribe.js` | M2's pipeline. Audio in, transcript out, no LLM. `PIPELINE=transcribe`. |
| `src/server.js` | Routing and wiring only. No audio logic. |
| `src/prompts/dispatcher.js` | What the agent is told it is. |

### Read it in this order

1. `src/transport/transport.js` — the contract everything else obeys
2. `src/server.js` — how a call becomes a pipeline
3. `src/pipeline/converse.js` — top to bottom, it is the story of a turn
4. `src/tools/booking.js` — the most careful code in the project

---

## Layer 0 — pure logic. No keys, no database, no network.

```bash
npm test
```

Four suites. What each is actually claiming:

**`test-mulaw.js`** — the phone codec.
- mu-law → PCM → mu-law is exact for 255 of 256 codes. The exception is `0x7F`,
  negative zero. (mu-law is signed-magnitude, so like floats it has two zeros.)
- Worst PCM error is 644/32768 — 1.97% — and it happens at full volume, exactly
  where mu-law is designed to be sloppy.
- The step between codes is **8 near silence, 1024 at full scale**: 128× coarser
  when loud. That one number is the whole format.

**`test-dsp.js`** — the anti-aliasing filter. The important line:
```
without a filter, 6kHz ALIASES to 2kHz — phantom tone at amplitude 0.5000
```
A 6kHz hiss, naively downsampled, becomes a **full-strength 2kHz whine that was
never in the room**. Same reason wagon wheels spin backwards in old film. With
the filter it is 56dB quieter.

**`test-completeness.js`** — 29 cases. `"Hi. My"` must be held, `"basement is
flooding."` must not. Note `"What can you do?"` — a terminal `?` beats the
dangling-word rule, which cost 1.3 seconds before it did.

**`test-confirmation.js`** — 23 cases. The ones that matter are mixed:
`"yes, but the address is wrong"` must be **no**.

### Break it yourself
Open `src/turn/completeness.js`, delete `'is'` from the `DANGLING` set, rerun.
`"my address is"` now passes as complete — which is the bug that made the agent
answer half a sentence. Put it back.

---

## Layer 1 — the tools. Database, still no AI.

```bash
npm run test:tools
```

21 cases against a freshly seeded calendar. **This is the layer worth
understanding best**, because it is where a bug becomes a truck at the wrong
house.

Watch for these four lines specifically:

```
PASS  book_job refuses before the caller confirms
PASS  a second caller cannot take the same technician and window
PASS  a second book_job reports the existing job rather than starting over
PASS  a repeated emergency does not page the technician twice
```

Each is a different failure being prevented:

1. **Consent.** `book_job()` takes no arguments, so it can only commit what was
   read aloud and then agreed to. The model cannot say one thing and book another.
2. **Two callers, one slot.** The idempotency key cannot stop this — different
   calls derive different keys and both writes are legitimate. A unique index on
   `(technician, slotStart, status)` does.
3. **Our own retry.** Same arguments twice returns the *same* job. Idempotent
   means same result, not "errors the second time".
4. **A human being woken twice.** The emergency key deliberately excludes the
   problem text, because the model rephrases when a caller repeats themselves.

### See the data
```bash
mongosh mongodb://localhost:27017/dispatch --quiet --eval 'db.jobs.find().forEach(printjson)'
```
Or Compass → `dispatch` → `jobs` → **Indexes** tab. Two unique indexes; those are
the guards as database constraints rather than hopeful comments.

### Break it yourself
In `src/db/models.js`, change the `(technician, slotStart, status)` index to
`{ unique: false }`, then:
```bash
node -e "import('mongoose').then(async m => { await m.default.connect('mongodb://127.0.0.1:27017/dispatch'); await m.default.connection.collection('jobs').dropIndexes(); process.exit(0) })"
npm run test:tools
```
The "second caller cannot take the same window" case now fails: two callers are
promised the same technician. Revert and drop indexes again to restore.

---

## Layer 2 — a scripted caller. Everything except your voice.

Two terminals. Left:

```bash
npm run seed && npm run dev
```

Right — each of these is a scenario:

**A. Emergency. Should page a technician and never offer appointment slots.**
```bash
node scripts/say.js "hi my basement is flooding right now" "my number is five five five seven seven seven eight eight eight eight"
```
Watch the server for `*** PAGE -> Mo Haddad ***` and a
`TOOL create_emergency_alert`. Mo is the on-call *plumber* — if it pages Ray
(hvac) the category routing is wrong.

**B. Routine booking, all the way through.**
```bash
node scripts/say.js \
  "hi my thermostat is broken and the heating will not turn on it is not freezing outside" \
  "my name is Nadia Farrow my number is five five five seven seven seven eight eight eight eight and I live at seven Kestrel Way" \
  "the first one works for me" \
  "yes that is all correct"
```
The sequence to look for:
```
TOOL lookup_customer      -> found:false
TOOL check_availability   -> slots
TOOL propose_booking      -> read_back
TOOL book_job({})         -> ok:false  "has not confirmed"     <- the gate
caller CONFIRMED the read-back
TOOL book_job({})         -> ok:true                            <- committed
```
That refusal in the middle is the system working, not failing.

**C. Repeat customer. Should not ask for details it already has.**
```bash
node scripts/say.js "hi this is Maria, my number is five five five one two three zero zero zero one" "my kitchen drain is blocked"
```
`lookup_customer` should return `found:true` with `18 Larkspur Lane`.

**D. A breath mid-sentence. `|` inserts 500ms of silence.**
```bash
node scripts/say.js "my address is | forty two oak street"
```
Look for `HOLD "My address is"` then a **single** `USER:` line containing both
halves. If you get two turns, the merge lost its race — see the open question in
`docs/04-turntaking.md`.

**E. Barge-in. Talk over the agent 1.2s in.**
```bash
INTERRUPT_MS=1200 node scripts/say.js "hi my basement is flooding there is water everywhere" "wait no it is the water heater"
```
Look for `BARGE-IN ... cleared + aborted in 0.8ms` and `AGENT (heard only):` with
a **truncated** sentence. That truncation is what stops the agent believing it
said things you never heard.

### Useful switches
```bash
PIPELINE=echo npm run dev          # M1 only. No API keys needed at all.
PIPELINE=transcribe npm run dev    # M2 only. Deepgram, no LLM, no TTS.
DEBUG_ASR=1 npm run dev            # every ASR event with arrival timings
VAD=energy npm run dev             # the hand-written VAD instead of Silero
DG_ENDPOINTING=700 npm run dev     # make it wait longer before deciding you stopped
TURN_GRACE_MS=0 npm run dev        # disable dynamic endpointing; watch sentences split
```

---

## Layer 3 — your own voice

```bash
npm run seed && npm run dev
```
Open `localhost:3000`, **headphones on**, click Start mic.

Headphones are not optional: echo cancellation is off deliberately (it mangles
the signal a VAD needs), so on speakers the agent hears itself and argues with
itself.

Things worth trying, roughly in order of how much they teach:

1. **"Hi, can you hear me?"** — baseline. Watch the `TRACE` line and read the
   per-hop numbers.
2. **Interrupt it mid-sentence.** It should stop within ~60ms, and
   `AGENT (heard only):` should show only what reached your ears.
3. **Pause mid-sentence**: *"my address is… forty two Oak Street"*. Should arrive
   as one turn.
4. **Say "mhm" while it talks.** It will still stop — a known limitation, and
   the reason is in `docs/04-turntaking.md`: no threshold separates "mhm" (740ms)
   from "wait" (300ms).
5. **Book a job end to end**, then check Compass. Then **try to book the same
   slot again in the same call** and watch it report the existing job.
6. **Correct yourself during the read-back**: *"yes, but it's 8 Kestrel Way, not
   7"*. It must NOT book. Look for `caller did NOT confirm — proposal discarded`.

---

## Honest state of it

### Works, and is measured
- Audio in and out over both transports; browser mic verified at 1301 frames, 0 lost, 0ms drift
- Turn detection at ~270ms
- Barge-in at 0.8ms, with history truncated to what was actually heard
- A caller's breath no longer splits their sentence (in isolation)
- Silero rejects non-speech transients that fool the energy VAD
- Real bookings, real pages, with four separate guards against double-writes
- Consent enforced by the shape of the tools, not by asking the model nicely

### Known broken or unfinished
| what | where it bites | notes |
|---|---|---|
| Deepgram sometimes takes 6.8s to finalise a continuation | a paused sentence can still split late in a call | cause unknown; tested two theories, both wrong. `docs/04-turntaking.md` |
| "mhm" stops the agent | annoying, not dangerous | no threshold can separate it from "wait"; the fix is resuming the remainder, unbuilt |
| Agent is deaf while speaking | barge-in needs your mic not to carry its voice | true on headphones, false on speakerphone. No echo cancellation. |
| LLM hop is 650–2000ms | p50 voice-to-voice ~1.6s against an 800ms target | ~1000ms is India→OpenAI. Co-location is the fix, not code. |
| Filler fires for instant tools | you hear "let me check" before a 1ms write | cosmetic |
| Read-back gets echoed twice | "…is that all correct?Is that all correct?" | M6 |
| Asks the caller to self-triage | "Is this an emergency?" instead of working it out | M6 — the whole point of it |
| Never touched a real phone | everything is browser mic at 8kHz | M1's "done when" is still unmet |
| `converse.js` is 729 lines | hard to read, hard to test in pieces | real debt |
| No reschedule or cancel | a caller who changes their mind mid-call gets two jobs | needs a tool |
| History grows unbounded | fine for 3 minutes, wrong in general | no truncation or summarisation |
