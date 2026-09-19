# M2 — Streaming ASR

**Goal:** the caller's audio becomes text, live, and we measure how long after they stop
talking we know what they said. No LLM.

---

## What we built

```
src/asr/asr.js               the ASR contract
src/asr/deepgram.js          Deepgram streaming over a raw WebSocket
src/pipeline/transcribe.js   audio in, transcript out, with latency measurement
src/prompts/…                (not yet — M3)
scripts/say.js               synthetic caller: macOS `say` -> 8kHz PCM16 -> WebSocket
```

`PIPELINE=transcribe` selects it; `PIPELINE=echo` still runs M1.

---

## Concepts

### Four signals, and only one is a turn signal

This is the distinction that breaks voice agents.

| Signal | Means | Act on it? |
|---|---|---|
| interim | best guess so far, **will be revised** | never |
| `is_final` | these words are frozen | no — the turn may continue |
| `speech_final` | endpointing thinks they stopped | **yes** |
| `UtteranceEnd` | a fixed silence timer expired | too slow, see below |

Observed revision in the wild: `"My furnace is May"` → `"My furnace is making"`. Interims are
guesses.

### `endpointing` vs `utterance_end_ms`

Two independent Deepgram knobs, and they drive the two different turn signals:

- **`endpointing`** (ms of silence): how long before Deepgram freezes a chunk as final. Drives
  `speech_final`. **No floor.**
- **`utterance_end_ms`** (ms of silence): how long before Deepgram declares the whole turn
  over. Drives `UtteranceEnd`. **Hard floor of 1000ms.**

### Why we send 8kHz and do not upsample

`docs/roadmap.md` planned "resampling 8kHz mu-law → 16kHz PCM". We skipped it. Deepgram
accepts `linear16` at `sample_rate=8000` natively, and upsampling adds no information — the
audio is band-limited to 4kHz regardless. It would just double the bytes and burn CPU
inventing samples.

### Raw WebSocket, not the SDK

The SDK hides the keepalive and the reconnect, which are the parts that fail in production.
Two things we would not have seen:

- **Deepgram drops an idle socket after ~10s.** A caller hunting for their house number pauses
  longer than that. We send `{"type":"KeepAlive"}` every 5s.
- **Audio arriving before the socket opens must be queued**, or you lose the caller's first
  word.

---

## What surprised us

### 1. `UtteranceEnd` is unusable, and cannot be fixed

```
utterance_end_ms=1000  ->  TURN END +1765ms
utterance_end_ms=700   ->  asr error: Unexpected server response: 400
utterance_end_ms=400   ->  400
utterance_end_ms=200   ->  400
```

Deepgram **refuses** anything below 1000ms. So `UtteranceEnd` arrives ~1765ms after the
caller's last word and there is no knob to speed it up. That alone is more than twice the
entire 800ms voice-to-voice target, before the LLM sees a token.

Switching to `speech_final` — which we were receiving and ignoring — took the turn signal from
**1765ms to 272ms**. Zero engineering. Just reading the protocol properly and measuring.

### 2. Lowering `endpointing` made things *worse*

```
endpointing=300  ->  speech_final 276ms
endpointing=150  ->  speech_final 259ms
endpointing=50   ->  speech_final 794ms
endpointing=10   ->  speech_final 1538ms
```

Backwards from the knob's description. At `10` the *final itself* arrived at +1537ms, so it is
not the turn signal lagging — the whole transcript was delayed. Interim output was
**byte-identical across all four runs**, so streaming behaviour did not change. Conclusion:
values that low are below Deepgram's usable range and behave unpredictably. We have a
measurement, not a mechanism.

Practical result: **300 and 150 are within noise of each other (276 vs 259ms)**, so take 300
for the larger safety margin. There is no reward for being aggressive here.

### 3. `is_final` splits one sentence into several

Tested with speech containing real pauses — `"my address is, um, forty two, sector fourteen,
and the unit is, uh, under the stairs"`:

```
FINAL "My address is 42 Sector 14, and the unit is"     <- paused for "uh"
FINAL "under the stairs."
SPEECH FINAL (+335ms after last word)                   <- fired ONCE, at the true end
```

An agent that replied per-final would have answered *"my address is 42 Sector 14, and the unit
is"* — talking over a caller mid-address. `transcribe.js` accumulates finals and only acts on
`speech_final`.

Encouragingly, `speech_final` **rode through the "uh" pause** rather than firing on it. It is
smarter than a raw silence timer, which is why a 300ms threshold does not cut people off as
often as you would fear.

### 4. `smart_format` earns its latency

`"forty two, sector fourteen"` arrives as **`"42 Sector 14"`**. For an agent collecting
addresses and phone numbers this is the difference between a usable transcript and a useless
one. It costs a little latency on finals; worth it.

### 5. Synthetic speech flattered us slightly, but not much

`say` produces unnaturally clean speech with crisp endings. Real mic, real voice, with a
mid-thought pause:

```
speech started @90ms
speech started @5300ms          <- paused, then resumed
FINAL "Well, hello there. My name is Vishal. I am a software developer." (+271ms)
SPEECH FINAL (+272ms after last word)
utteranceEnd (+2087ms after last word)
```

**272ms on real speech vs 259–335ms synthetic** — the synthetic numbers hold up. And note the
second `speech started`: Deepgram saw speech resume after the pause and correctly did **not**
end the turn.

---

## Measured numbers

| Metric | Value |
|---|---|
| `speech_final` after last word | **259–335ms** synthetic, **272ms** real mic |
| `is_final` after those words ended | 250–273ms |
| `UtteranceEnd` after last word | 1765–2087ms |
| `utterance_end_ms` minimum accepted | 1000 (below → HTTP 400) |
| Chosen `endpointing` | 300 |

**How the lag is measured.** Deepgram reports timings on the *audio* clock. We record the wall
time of audio-zero once, so wall time for any audio position is `audioZeroWall + audioMs`, and

```
lag = now - (audioZeroWall + lastWordEndMs)
```

Measuring from *message arrival* instead would flatter us by hiding audio still in flight.
This anchoring choice recurs in M3 and matters more there.

---

## Open questions

1. **ASR accuracy on Indian-English addresses is poor.** In a real session, a street name came
   back as `"Living Lifestyle"` then `"Living Life Drive"` across turns. Suspects: 8kHz
   mangling consonants, accent, and no keyterm coverage for local street names. Unquantified —
   needs a labelled test set (M7).
2. **Keyterm boosting is unmeasured.** We pass ~20 HVAC terms but have not run a with/without
   comparison, so we do not know if it helps.
3. **`nova-3` vs a telephony-tuned model unmeasured.** Deepgram has phone-specific models; we
   have not compared.
4. **Not tested on real phone audio.** All of this is browser mic at 8kHz, which is *format*-
   faithful but not *channel*-faithful — no carrier codec transitions, no line noise.
5. **`speech_final` behaviour on a caller who trails off slowly** ("...so yeah, I guess,
   um...") is untested. That is the case a 300ms threshold should fail on, and M4's semantic
   turn detection is the intended fix.
