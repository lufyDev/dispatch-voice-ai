# M1 — Telephony transport

## The goal

I call a phone number. My laptop hears my voice. My laptop sends it straight back.
I hear myself, slightly delayed.

That's it. No AI. This milestone is about getting comfortable with what a phone call
actually *is* when it arrives at your server.

---

## Concepts, in plain words

### A phone call is not a file, it's a firehose

When you handle an HTTP request, you get a complete thing and respond when you're ready.
A phone call is the opposite: audio arrives continuously, forever, in tiny pieces, and if
you stop sending audio back for even a moment, the caller hears silence.

**Analogy:** HTTP is mail. A phone call is a garden hose that's already running — you have
to deal with the water as it comes.

### 20 milliseconds, 160 bytes

Twilio chops the call into **20ms chunks** and sends you one every 20ms. That's 50 messages
per second, per call.

Why 160 bytes? Phone audio is sampled 8,000 times per second, and each sample is 1 byte:

```
8000 samples/sec × 0.02 sec = 160 samples = 160 bytes
```

That's the entire payload of one message. Tiny. But at 50/sec across 100 concurrent calls,
that's 5,000 messages per second hitting your server.

### 8kHz — why phone audio sounds like phone audio

Music is sampled at 44,100 Hz. Phone calls: 8,000 Hz. This is a decision from the 1960s that
we're all still living with. It means phone audio physically cannot contain frequencies above
4kHz — which is why "s" and "f" sound so similar on a call, and why callers spell things out.

**Why this matters later:** speech recognition models are mostly trained on 16kHz audio.
Feeding them 8kHz phone audio is feeding them something blurrier than they expect. This is
a real source of transcription errors, and it's why telephony-tuned ASR models exist.

### μ-law (mu-law) — the compression

Raw audio samples are normally 16 bits. Phone audio squeezes them into 8 bits. It doesn't do
this evenly — it gives more precision to quiet sounds than loud ones.

**Analogy:** human hearing is like eyesight in a dark room. The difference between silence
and a whisper is very noticeable; the difference between loud and very loud, much less so.
μ-law spends its limited bits where your ears actually care.

Practical consequence: **μ-law bytes are not numbers you can do math on.** You cannot average
two μ-law bytes to mix audio, or check if a value is "loud" by comparing it to a threshold.
You must decode to 16-bit PCM first, do your math, then re-encode. Forgetting this produces
audio that sounds like a fax machine.

For M1's echo we don't need to decode at all — we just bounce the bytes straight back. From
M2 onward we'll decode constantly.

### Base64 — why the bytes look like gibberish

WebSocket messages from Twilio are JSON. JSON can't hold raw binary. So the 160 audio bytes
get base64-encoded into a ~216-character string. You decode it to get the actual audio.

It costs about 33% extra bandwidth. That's the price of a text protocol.

### The message types

Twilio opens a WebSocket to your server and sends:

| Message | When | What you do |
|---|---|---|
| `connected` | socket opens | note it |
| `start` | call begins | save the `streamSid` — you need it to send audio back |
| `media` | every 20ms | the actual audio |
| `stop` | call ends | clean up |

And you send back:

| Message | Purpose |
|---|---|
| `media` | audio to play to the caller |
| `mark` | a bookmark — Twilio tells you when playback reaches it |
| `clear` | **discard everything buffered and not yet played** |

`mark` and `clear` look boring right now. They are the two most important messages in the
whole protocol, and here's why.

### The buffer problem (this is the M4 bug, previewed)

When you send audio to Twilio, it does **not** play instantly. It queues it. You might push
4 seconds of the agent's reply in 200 milliseconds — Twilio holds it and plays it out over
4 seconds.

Now the caller interrupts at the 1-second mark. You stop generating — but 3 seconds of audio
is already sitting in Twilio's queue and **the caller keeps hearing it**. They interrupted,
and the bot kept talking for three more seconds. Every bad voice agent you've ever called
has this bug.

`clear` is the fix: it throws away the queue. `mark` is how you know what actually got played
before you cleared it, which tells you how much of the sentence the caller really heard.

Notice these are both *transport-level* concerns. No amount of prompt engineering fixes this.
That's the lesson of M1: interruption handling is plumbing, not AI.

### The tunnel

Twilio's servers must reach your laptop, which has no public address. ngrok (or Cloudflare
Tunnel) gives you a public URL that forwards to `localhost`.

Note the protocol: `https://` for the TwiML webhook, `wss://` for the media stream.

---

## What to build

1. `GET/POST /voice` → returns TwiML with `<Connect><Stream url="wss://..."/></Connect>`
2. WebSocket server that handles the four inbound message types
3. On `media`, send the same payload straight back as an outbound `media` message
4. Instrumentation: count frames, log the gap between arrivals, log total bytes
5. A `Transport` interface so `BrowserTransport` can be dropped in beside `TwilioTransport`

## Experiments to actually run

These matter more than the code working. Run each and note what happens:

1. **Echo with no delay.** How long is the round trip? Where does that time go?
2. **Drop every other frame.** What does 50% packet loss sound like?
3. **Buffer 2 seconds, then send it all at once.** Does the caller hear it immediately, or
   spread over 2 seconds? Now you understand the queue.
4. **Send `clear` mid-playback.** Watch the audio cut off. This is barge-in, three milestones
   early.
5. **Log arrival timing.** Are frames really 20ms apart, or does the network clump them?

## Done when

- I call the number and hear myself
- I can state the measured round-trip latency and account for it
- I can explain, from having watched it, why `clear` exists

## Commit

`M1: twilio media stream echo`

Then write `docs/01-telephony.md` — what we built, concepts, measured numbers, surprises.
