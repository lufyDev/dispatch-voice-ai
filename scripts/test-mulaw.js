/**
 * Exhaustive mu-law verification. The mu-law domain is 256 values and the PCM16
 * domain is 65536, so we don't sample — we check every single one.
 *
 *   node scripts/test-mulaw.js
 */
import { encodeSample, decodeSample } from '../src/audio/mulaw.js';

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fail += 1;
};

// 1. mu-law -> PCM -> mu-law is exact for all 256 codes EXCEPT 0x7F.
//    mu-law is signed-magnitude, so like IEEE floats it has two zeros: 0xFF is
//    +0 and 0x7F is -0. Both decode to 0, and encoding 0 has to pick one, so
//    0x7F canonicalises to 0xFF. Inaudible (both are silence) but it does mean
//    the Twilio echo path is NOT bit-perfect -- it is bit-perfect for 255 of
//    256 values and canonicalises negative zero.
const badCodes = [];
for (let u = 0; u < 256; u += 1) {
  if (u === 0x7f) continue;
  if (encodeSample(decodeSample(u)) !== u) badCodes.push(u);
}
check('mu-law round trip exact for 255/256 codes', badCodes.length === 0,
  badCodes.length ? `broken: ${badCodes.map((c) => '0x' + c.toString(16)).join(',')}` : '');

// 2. The two zeros, made explicit.
check('0xFF and 0x7F are both zero (+0 and -0)',
  decodeSample(0xff) === 0 && decodeSample(0x7f) === 0,
  `0xFF->${decodeSample(0xff)}, 0x7F->${decodeSample(0x7f)}`);
check('encode(0) canonicalises to +0 (0xFF)', encodeSample(0) === 0xff,
  `got 0x${encodeSample(0).toString(16)}`);

// 3. PCM -> mu-law -> PCM is LOSSY by construction (65536 values into 256).
//    Measure how lossy, and where.
let worstErr = 0;
let worstAt = 0;
for (let s = -32768; s <= 32767; s += 1) {
  const err = Math.abs(decodeSample(encodeSample(s)) - s);
  if (err > worstErr) { worstErr = err; worstAt = s; }
}
const pctOfFullScale = ((worstErr / 32768) * 100).toFixed(2);
check('PCM round trip error bounded', worstErr < 1024,
  `worst=${worstErr} at sample=${worstAt} (${pctOfFullScale}% of full scale)`);

// 4. Quantisation step near silence vs near full scale — the whole point of
//    mu-law. Adjacent codes should be ~2 apart when quiet, ~hundreds when loud.
const stepQuiet = Math.abs(decodeSample(0xfe) - decodeSample(0xff));
const stepLoud = Math.abs(decodeSample(0x81) - decodeSample(0x80));
check('resolution is finer near silence', stepQuiet < stepLoud,
  `step near silence=${stepQuiet}, step near full scale=${stepLoud} (${(stepLoud / stepQuiet).toFixed(0)}x coarser)`);

process.exit(fail === 0 ? 0 : 1);
