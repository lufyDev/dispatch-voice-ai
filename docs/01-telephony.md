# M1 — Telephony transport

**Goal:** audio from a real phone call reaches my server and goes straight back out, so the
caller hears themselves. No AI. The point is understanding what a phone call *is* when it
lands on a socket.

---

## What we built

```
src/server.js              routing and wiring only — no audio logic
src/audio/mulaw.js         G.711 mu-law codec, hand-written
src/transport/transport.js the contract the pipeline sees
src/transport/twilio.js    Twilio Media Streams behind that contract
src/transport/browser.js   browser mic behind the same contract
src/pipeline/echo.js       send back what you hear + arrival instrumentation
public/dsp.js              low-pass FIR + streaming decimator
public/capture-worklet.js  mic capture on the audio thread
scripts/fake-twilio.js     protocol simulator, verifies echoed bytes
scripts/fake-browser.js    same for the browser wire format
scripts/test-mulaw.js      exhaustive codec tests
scripts/test-dsp.js        measured proof the anti-alias filter works
```

---

## Concepts

### A call is a firehose, not a request

HTTP hands you a complete thing and waits for your answer. A phone call delivers audio
continuously forever, and if you stop producing audio for a moment the caller hears silence.
There is no "wait until ready".

### 20ms / 160 bytes / 8kHz / mu-law

Twilio sends one message every 20ms: 50/sec/call. Payload is 160 bytes, because phone audio
is 8000 samples/sec at 1 byte each and `8000 × 0.02 = 160`.

8kHz means the audio physically cannot contain anything above 4kHz. That is why "s" and "f"
are confusable on a call, and it is the root cause of most ASR errors later.

mu-law packs a 14-bit sample into 8 bits **logarithmically** — fine resolution near silence,
coarse when loud, matching how hearing works. Measured: the quantisation step is **8 near
silence and 1024 at full scale, 128× coarser**. Worst round-trip error is **644/32768
(1.97%)**, and it occurs at full scale, exactly where mu-law is designed to be sloppy.

**The consequence that matters:** mu-law bytes are not numbers. You cannot threshold them for
VAD, average them to mix, or compare them for energy. Decode to PCM16 first, always.

### `mark` and `clear` are the two most important messages

When you send audio to Twilio it is **queued**, not played. You can hand over 4 seconds of
audio in 200ms, and Twilio plays it out over 4 seconds.

- `clear` discards the queue. This is barge-in: the caller interrupted and the rest of your
  sentence must never reach their ear.
- `mark` is a bookmark that reports back when playback reaches it. It is the **only**
  mechanism that tells you what the caller actually heard.

Both are transport-level. No prompt engineering fixes interruption.

### The tunnel

Twilio must reach a laptop that has no public address. ngrok makes an *outbound* connection
(which NAT allows) to a server that does have one, and pipes traffic back down it. `localhost`
in a TwiML URL means *Twilio's own machine*, so it fails without ever contacting you.

We derive the public hostname from the request's `Host` header rather than hardcoding it,
because free-tier ngrok issues a new subdomain per restart and a stale value fails **silently**
— the caller hears nothing and the call drops with no error anywhere.

---

## Design decisions

**`Transport` hands the pipeline `{ pcm, sampleRate, timestampMs }`.**

- **PCM16 always**, because you cannot do arithmetic on mu-law.
- **`sampleRate` rides on the frame** rather than being normalised to 16kHz. Upsampling
  Twilio's 8kHz adds zero information — the audio is band-limited to 4kHz either way — and it
  is a lossy commitment you cannot undo. Resample once, at the ASR boundary, when you know
  what the vendor wants.
- **`timestampMs` is the audio clock**, never `Date.now()`.

**Push (EventEmitter), not streams.** Backpressure is *wrong* for a live call: you cannot ask
a caller to talk slower. If the pipeline falls behind, queueing makes the conversation drift
further from real time every second. Dropping is the correct failure mode, and push semantics
make falling behind visible instead of silently buffering it.

**Built the interface last, not first.** An interface designed against one implementation is a
guess. `BrowserTransport` pushed back on the shape in ways Twilio alone never would have — most
sharply on `clear`, where Twilio holds the playback queue and the browser holds its own.

**Outbound audio chunked to 20ms** even though Twilio accepts larger payloads, because `clear`
can only cut at a frame boundary. **Chunk size is the resolution of your barge-in.**

**Browser downsamples to 8kHz**, deliberately matching phone quality, so dev results predict
production.

---

## What surprised us

### 1. Sent ≠ received ≠ heard

The server echoed 150 frames; the client received **149**. After the last frame the client
sent `stop` and closed; the 150th echo lost the race with the closing handshake.

One frame today. But it is the same gap that makes "what did the caller hear?" unanswerable in
general, and it is why `mark` exists. **This bug came back in M3 and cost an hour** — see
`03-loop.md`.

### 2. `stop` fired twice on every clean hangup

`TwilioTransport` emitted `stop` both on Twilio's `stop` message and on socket `close`. A
normal hangup fires both. Harmless while `stop` only logs; by M5 it is *saving the call record
twice* and *creating the emergency alert twice*. It needs no retry or network failure — **it
double-fires on the happy path.** Fixed with an idempotency flag at the source, not defensive
de-duplication in every listener.

### 3. The mu-law segment table, in the wrong bit space

My `SEG_END` table was written in 16-bit space when mu-law's segments live in **14-bit** space
(the encoder shifts right by 2 first). Every entry 4× too large, so the encoder picked segment
5 where it should have picked 7.

It did not crash and it was not silence. It would have sounded like *recognisable but
distorted speech* — which is how that class of bug ships. The exhaustive test caught it, and
the fact that `decode` passed while `encode` failed localised it immediately.

### 4. mu-law has two zeros

`0xFF` is +0 and `0x7F` is −0, like IEEE floats. Both decode to 0, and encoding 0 must pick
one. So the echo path is bit-perfect for **255 of 256** codes and canonicalises negative zero.
Inaudible, but "bit-perfect" was the wrong claim.

### 5. Timers are not clocks

| Pacing source | Drift |
|---|---|
| Node `setInterval(20)` | **+143ms over 3s** (~4.7%) |
| Browser `setTimeout(1000)`, backgrounded tab | **1407ms** — 40% over |
| Hand-corrected loop against a running target | **1ms over 4.26s** |
| **Real mic (sound card crystal)** | **−0ms over 26s** |

A hardware clock does not drift. This matters twice: never pace audio with `setInterval`, and
if a *real* call ever shows drift, that means **your event loop is blocked**, not that the
carrier is late. Same number, opposite diagnosis.

It also bit me directly: my first worklet measurement read "1.5× realtime" because I timed an
audio process with `setTimeout`. Re-measured against `ctx.currentTime`: captured audio matched
the audio clock to **0.999**.

### 6. Two `WebSocketServer({ server, path })` silently break each other

Each registers its own `upgrade` listener. Whichever fires first checks the path, doesn't
match, and **aborts the socket with a 400** before the other is consulted. The second endpoint
looks like it does not exist. Fix: `noServer: true` and route the upgrade by path yourself —
which is the dispatch `{ server, path }` was hiding.

### 7. Aliasing is not subtle

Going 48kHz → 8kHz by keeping every 6th sample, measured with a single-bin DFT:

| Signal | Path | Amplitude at 2kHz |
|---|---|---|
| 6kHz tone | naive decimation | **0.5000** — a phantom tone as loud as the original |
| 6kHz tone | 49-tap FIR @3400Hz, then decimate | **0.000758** (−56.4 dB) |
| 1kHz tone | filtered | 0.5008 (input 0.5000) — passband intact |

A 6kHz hiss reappears as a full-strength 2kHz whine that was never in the room. Same reason
wagon wheels spin backwards in old film. Unrecoverable once done.

### 8. 128 does not divide by 6

AudioWorklet hands you exactly 128 samples per call. `128/6 = 21.33`, so neither the
decimation phase nor the 160-sample output frame aligns with block boundaries. Both counters
must persist across calls; resetting either gives a click every 2.67ms.

---

## Measured numbers

**Loopback baseline (no network):**
```
gaps(ms) min=19.0 p50=21.0 p95=21.4 max=22.0 mean=20.9   clumped(<10ms)=0/249
```

**Real 26-second mic session:**
```
1301 frames sent, 1301 echoed, 0 lost
gaps(ms) min=0.1 p50=21.2 p95=22.5 max=42.8 mean=20.0    clumped(<10ms)=6/1300
wall=26000ms audio=26000ms drift=-0ms
```

`min=0.1` together with `max=42.8` is the **clumping signature**: one frame held up ~2 frame
times, then the next arriving essentially simultaneously. Six times in 26 seconds on
localhost. Without the 60ms playback jitter buffer those would have been six audible clicks.

**Codec:** round trip exact for 255/256 codes; worst PCM error 644/32768 (1.97%) at −32768;
quantisation step 8 near silence vs 1024 at full scale.

---

## Open questions

1. **Not validated on a real phone call.** Everything above is loopback or browser mic. The
   brief's "done when" asks for a measured round-trip over the PSTN and that is still unmeasured.
2. **Audio clock convention differs between transports.** Our Twilio simulator reports
   `20/1020/2020ms` while `BrowserTransport` reports `0/1000/2000ms` — a 20ms offset from
   1-based vs 0-based counting. Must be checked against real Twilio or every dev-vs-prod
   timing comparison is off by one frame.
3. **`clear` is implemented on both transports but never exercised.** Experiment 4 from the
   brief (send `clear` mid-playback and watch audio cut off) has not been run.
4. **Jitter buffer is a guessed 60ms.** Not tuned against measured real-network jitter.
