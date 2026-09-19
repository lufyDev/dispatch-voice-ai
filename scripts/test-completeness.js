/**
 * Cases drawn from real transcripts, including the split that motivated this.
 *
 *   node scripts/test-completeness.js
 */
import { looksComplete } from '../src/turn/completeness.js';

// [text, expected complete?]
const CASES = [
  // the actual bug
  ['Hi. My', false],
  ['basement is flooding.', true],
  ['Hi. My basement is flooding.', true],

  // dangling words
  ['my address is', false],
  ['my address is 42 Oak Street.', true],
  ['so the heater, uh,', false],
  ['it has been making a noise since', false],
  ['I think it is the', false],
  ['and', false],
  ['um', false],

  // stock short answers — these must NOT be held, or every yes/no costs 800ms
  ['Yes.', true],
  ['No.', true],
  ['Okay.', true],
  ['Hello?', true],
  ['Correct.', true],
  ['Wait.', true],

  // real sentences
  ['My name is Vishal.', true],
  ['There is water everywhere.', true],
  ['It is leaking from the bottom.', true],
  ['(987) 654-3210.', true],
  ['The furnace is making a loud banging noise', true],

  // lone words that are probably a fragment
  ['basement', false],
  ['forty', false],
];

let fail = 0;
for (const [text, want] of CASES) {
  const got = looksComplete(text);
  const ok = got.complete === want;
  if (!ok) fail += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${got.complete ? 'COMPLETE ' : 'HOLD     '} ` +
    `"${text}"${ok ? '' : `  (wanted ${want ? 'COMPLETE' : 'HOLD'})`}  — ${got.reason}`
  );
}
console.log(`\n${CASES.length - fail}/${CASES.length} passed`);
process.exit(fail === 0 ? 0 : 1);
