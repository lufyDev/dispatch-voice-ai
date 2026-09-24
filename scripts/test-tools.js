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
// Booking is two tools and a consent flag the model cannot set. These cases are
// the whole reason it is shaped that way.
const slot = avail.slots[0];
const details = {
  slot_id: slot.slot_id,
  phone: '555 777 8888',
  name: 'Nadia Farrow',
  address: '7 Kestrel Way',
  problem: 'kitchen sink is backing up',
  category: 'plumbing',
};

// A per-call state object, exactly as the pipeline supplies one.
const stateA = { proposal: null, confirmed: false };
const ctxA = { callId: CALL_A, state: stateA };

const straightToBook = await runTool('book_job', {}, { callId: CALL_A, state: { proposal: null, confirmed: false } });
check('book_job refuses with nothing proposed',
  straightToBook.ok === false && /propose_booking/.test(straightToBook.error));

const proposed = await runTool('propose_booking', details, ctxA);
check('propose_booking returns a read-back sentence', proposed.ok && /is that all correct\?$/i.test(proposed.read_back), proposed.read_back);

// THE CASE THE SHAPE EXISTS FOR. The model has read the details out and is
// trying to book before the caller answered.
const unconfirmed = await runTool('book_job', {}, ctxA);
check('book_job refuses before the caller confirms',
  unconfirmed.ok === false && /has not confirmed/.test(unconfirmed.error));

// The pipeline heard "yes".
stateA.confirmed = true;
const booked = await runTool('book_job', {}, ctxA);
check('book_job commits once confirmed', booked.ok && !!booked.job_id, `${booked.technician}, ${booked.spoken}`);

// THE RETRY. Re-propose the same thing, re-confirm, book again.
const reProposed = await runTool('propose_booking', details, ctxA);
check('re-proposing an already-booked slot is refused as taken',
  reProposed.ok === false && /just been taken/.test(reProposed.error), reProposed.error);

// A correction after confirming must NOT be bookable without a fresh yes.
const stateB = { proposal: null, confirmed: false };
const ctxB = { callId: 'test-call-D', state: stateB };
await runTool('propose_booking', { ...details, slot_id: avail.slots[1].slot_id, phone: '555 222 4444', name: 'Tom Ash', address: '12 Vale Road' }, ctxB);
stateB.confirmed = true;
await runTool('propose_booking', { ...details, slot_id: avail.slots[1].slot_id, phone: '555 222 4444', name: 'Tom Ash', address: '14 Vale Road' }, ctxB);
check('a corrected proposal is unconfirmed again', stateB.confirmed === false);
const afterCorrection = await runTool('book_job', {}, ctxB);
check('book_job refuses the correction until re-confirmed',
  afterCorrection.ok === false && /has not confirmed/.test(afterCorrection.error));

// THE RETRY THAT ACTUALLY HAPPENS: the model calls book_job again because it
// never saw the first result. The proposal is already consumed.
stateB.confirmed = true;
const first = await runTool('book_job', {}, ctxB);
check('the confirmed correction books', first.ok === true && !!first.job_id);
const second = await runTool('book_job', {}, ctxB);
check('a second book_job reports the existing job rather than starting over',
  second.ok === true && second.already_booked === true && second.job_id === first.job_id);
check('the retry created no second job',
  (await Job.countDocuments({ callId: 'test-call-D', status: 'scheduled' })) === 1);

// ---------------------------------------------------------------- bad arguments
const badSlot = await runTool('propose_booking', { ...details, slot_id: 'tomorrow at 10' }, ctxA);
check('propose_booking rejects an invented slot_id', badSlot.ok === false && /check_availability/.test(badSlot.error));

const noName = await runTool('propose_booking', { ...details, name: '', slot_id: avail.slots[2].slot_id }, ctxA);
check('propose_booking refuses without a name', noName.ok === false && /name/.test(noName.error));

const shortPhone = await runTool('propose_booking', { ...details, phone: '1234', slot_id: avail.slots[2].slot_id }, ctxA);
check('propose_booking refuses a partial phone number', shortPhone.ok === false && /10-digit/.test(shortPhone.error));

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
