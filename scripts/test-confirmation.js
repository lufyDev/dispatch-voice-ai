/**
 * node scripts/test-confirmation.js
 *
 * The cases that matter are the mixed ones. A classifier that gets "yes" and
 * "no" right and "yes, but the address is wrong" wrong is worse than useless,
 * because it fails precisely where a human would be most annoyed.
 */
import { classifyConfirmation } from '../src/turn/confirmation.js';

const CASES = [
  ['yes', 'yes'],
  ['Yes.', 'yes'],
  ['yes that is correct', 'yes'],
  ["that's right", 'yes'],
  ['correct', 'yes'],
  ['perfect, go ahead', 'yes'],
  ['please book it', 'yes'],
  ['sounds good', 'yes'],
  ['sure', 'yes'],

  ['no', 'no'],
  ['nope', 'no'],
  ['no thanks', 'no'],

  // Mixed. Every one of these must be 'no'.
  ['yes but the address is wrong', 'no'],
  ['yeah, actually can we change the time', 'no'],
  ['correct, but my number is different', 'no'],
  ["that's right, no wait", 'no'],
  // No correction KEYWORD at all — only the number gives it away.
  ['yes, it is 8 Kestrel Way not 7', 'no'],
  ['yes, my number ends 9 9 9 9', 'no'],
  // Chatty agreement with no number is still agreement.
  ['yes that is all correct thank you very much', 'yes'],

  // Not an answer to the question.
  ['what was that', 'unclear'],
  ['can you repeat it', 'unclear'],
  ['hello?', 'unclear'],
  ['', 'unclear'],
];

let fail = 0;
for (const [text, want] of CASES) {
  const got = classifyConfirmation(text);
  const ok = got === want;
  if (!ok) fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${got.padEnd(7)} "${text}"${ok ? '' : `  (wanted ${want})`}`);
}
console.log(`\n${CASES.length - fail}/${CASES.length} passed`);
process.exit(fail === 0 ? 0 : 1);
