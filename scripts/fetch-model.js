/**
 * Download the Silero VAD model. Not committed: 2.3MB of binary that npm and
 * git both handle worse than a 20-line script.
 *
 *   npm run fetch-model
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const URL = 'https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx';
const OUT = 'models/silero_vad.onnx';

if (existsSync(OUT)) {
  console.log(`${OUT} already present`);
  process.exit(0);
}

mkdirSync('models', { recursive: true });
const res = await fetch(URL);
if (!res.ok) {
  console.error(`fetch failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const bytes = Buffer.from(await res.arrayBuffer());
writeFileSync(OUT, bytes);
console.log(`wrote ${OUT} (${(bytes.length / 1024 / 1024).toFixed(1)}MB)`);
