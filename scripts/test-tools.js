/**
 * The four tools, exercised directly. No LLM.
 *
 *   npm run seed && node scripts/test-tools.js
 *
 * Deliberately before wiring the model in. If the LLM goes first, every tool bug
 * looks like a prompt problem and you tune prose to fix arithmetic.
 *
 * The interesting cases are not the happy paths — they are the retry, the race,
 * and the malformed argument, because those are what a model actually produces.
 */
import 'dotenv/config';
import { connectDb, disconnectDb } from '../src/db/connect.js';
import { Job, EmergencyAlert } from '../src/db/models.js';
import { runTool } from '../src/tools/index.js';

await connectDb();

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) fail += 1;
};

const CALL_A = 'test-call-A';
const CALL_B = 'test-call-B';

// ---------------------------------------------------------------- lookup
const known = await runTool('lookup_customer', { phone: '555 123 0001' }, { callId: CALL_A });
check('lookup finds a repeat customer from a spoken number',
  known.found === true && known.name === 'Maria Whitfield', `${known.name}, ${known.previous_jobs} previous jobs`);

const unknown = await runTool('lookup_customer', { phone: '5557778888' }, { callId: CALL_A });
check('lookup reports a new caller without erroring', unknown.ok && unknown.found === false);

const junk = await runTool('lookup_customer', { phone: 'uh' }, { callId: CALL_A });
check('lookup rejects nonsense with an instruction', junk.ok === false && /repeat/.test(junk.error));

// ---------------------------------------------------------------- availability
const avail = await runTool('check_availability', { category: 'plumbing' }, { callId: CALL_A });
check('availability returns slots with spoken text and ids',
  avail.ok && avail.slots.length > 0 && !!avail.slots[0].spoken && !!avail.slots[0].slot_id,
  avail.slots[0]?.spoken);

const badCat = await runTool('check_availability', { category: 'roofing' }, { callId: CALL_A });
check('availability rejects an unknown category', badCat.ok === false);

// ---------------------------------------------------------------- booking
const slot = avail.slots[0];
const bookArgs = {
  slot_id: slot.slot_id,
  phone: '555 777 8888',
  name: 'Nadia Farrow',
  address: '7 Kestrel Way',
  problem: 'kitchen sink is backing up',
  category: 'plumbing',
};

const booked = await runTool('book_job', bookArgs, { callId: CALL_A });
check('book_job books a slot', booked.ok && !!booked.job_id, `${booked.technician}, ${booked.spoken}`);

// THE RETRY. Same call, same arguments — a model that did not notice it already
// succeeded. Must return the SAME job and must not create a second.
const retry = await runTool('book_job', bookArgs, { callId: CALL_A });
check('an identical retry returns the same job, not an error',
  retry.ok === true && retry.already_booked === true && retry.job_id === booked.job_id);
check('the retry created no second job',
  (await Job.countDocuments({ callId: CALL_A, status: 'scheduled' })) === 1,
  `${await Job.countDocuments({ callId: CALL_A, status: 'scheduled' })} job(s) for this call`);

// THE RACE. A different caller wants the same technician at the same time.
// idempotencyKey cannot stop this — different call, different key — so the
// (technician, slotStart, status) index has to.
const raced = await runTool('book_job', { ...bookArgs, phone: '555 222 3333', name: 'Tom Ash', address: '12 Vale Road' }, { callId: CALL_B });
check('a second caller cannot take the same technician and window',
  raced.ok === false && /just taken/.test(raced.error), raced.error);

// ---------------------------------------------------------------- bad arguments
const badSlot = await runTool('book_job', { ...bookArgs, slot_id: 'tomorrow at 10' }, { callId: CALL_A });
check('book_job rejects an invented slot_id', badSlot.ok === false && /check_availability/.test(badSlot.error));

const noName = await runTool('book_job', { ...bookArgs, name: '', slot_id: avail.slots[1].slot_id }, { callId: CALL_A });
check('book_job refuses without a name', noName.ok === false && /name/.test(noName.error));

const shortPhone = await runTool('book_job', { ...bookArgs, phone: '1234', slot_id: avail.slots[1].slot_id }, { callId: CALL_A });
check('book_job refuses a partial phone number', shortPhone.ok === false && /10-digit/.test(shortPhone.error));

// ---------------------------------------------------------------- emergency
const alert = await runTool('create_emergency_alert',
  { phone: '555 444 5555', problem: 'basement is flooding', category: 'plumbing', name: 'Ivo Brandt' },
  { callId: CALL_B });
check('emergency alerts the on-call technician', alert.ok && alert.technician === 'Mo Haddad', alert.spoken);

const alertAgain = await runTool('create_emergency_alert',
  { phone: '555 444 5555', problem: 'water everywhere in the basement', category: 'plumbing' },
  { callId: CALL_B });
check('a repeated emergency does not page the technician twice',
  alertAgain.ok === true && alertAgain.already_alerted === true);
check('exactly one alert exists',
  (await EmergencyAlert.countDocuments({ idempotencyKey: `${CALL_B}:emergency:5554445555` })) === 1);

const partial = await runTool('create_emergency_alert',
  { phone: '555 666 7777', problem: 'I can smell gas', category: 'hvac' },
  { callId: 'test-call-C' });
check('emergency escalates on partial information (no name, no address)',
  partial.ok === true, partial.spoken);

console.log(`\n${fail === 0 ? 'all good' : `${fail} failed`}`);
await disconnectDb();
process.exit(fail === 0 ? 0 : 1);
