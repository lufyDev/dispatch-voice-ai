/**
 * Does pre-opening the connections actually help? WARM=1 to warm first.
 *
 *   for i in 1 2 3; do node scripts/bench-warm.js; done
 *   for i in 1 2 3; do WARM=1 node scripts/bench-warm.js; done
 *   for g in 0 2000 5000; do WARM=1 GAP=$g node scripts/bench-warm.js; done
 *
 * GAP waits that long AFTER warming before making the real call. That matters:
 * a pooled connection does not live forever, so warming "as early as possible"
 * can be worse than not warming at all.
 *
 * Must be a fresh process each run, or the previous run's pooled connection
 * makes every measurement look warm.
 */
import 'dotenv/config';
import { performance } from 'node:perf_hooks';
import { OpenAILLM } from '../src/llm/openai.js';
import { ElevenLabsTTS } from '../src/tts/elevenlabs.js';
import { DISPATCHER_PROMPT } from '../src/prompts/dispatcher.js';

const WARM = process.env.WARM === '1';
const GAP = Number(process.env.GAP || 0);
const llm = new OpenAILLM({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || 'gpt-4o-mini' });
const tts = new ElevenLabsTTS({ apiKey: process.env.ELEVENLABS_API_KEY, voiceId: process.env.ELEVENLABS_VOICE_ID });

let warmMs = 0;
if (WARM) {
  const w0 = performance.now();
  await Promise.all([llm.warm(), tts.warm()]);
  warmMs = performance.now() - w0;
}

if (GAP) await new Promise((r) => setTimeout(r, GAP));

const messages = [
  { role: 'system', content: DISPATCHER_PROMPT },
  { role: 'user', content: 'Hi, can you hear me?' },
];

const l0 = performance.now();
let llmTtft = null;
for await (const _ of llm.stream(messages)) {
  if (llmTtft === null) llmTtft = performance.now() - l0;
}

const t0 = performance.now();
let ttsTtfb = null;
for await (const _ of tts.speak('ok', {})) {
  if (ttsTtfb === null) ttsTtfb = performance.now() - t0;
}

console.log(
  `${WARM ? 'WARM' : 'COLD'} gap=${String(GAP).padStart(4)}ms  llm-ttft=${llmTtft.toFixed(0)}ms  tts-ttfb=${ttsTtfb.toFixed(0)}ms` +
  `  total=${(llmTtft + ttsTtfb).toFixed(0)}ms${WARM ? `   (warm-up itself took ${warmMs.toFixed(0)}ms)` : ''}`
);
