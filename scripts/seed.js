/**
 * Reset the dispatch database to a known state.
 *
 *   npm run seed
 *
 * Deliberately destructive and deliberately repeatable: every test of a booking
 * agent needs the same starting calendar, or "is this slot free?" is not a
 * question with a stable answer.
 *
 * Seeds existing jobs on purpose. A calendar with no jobs in it makes
 * check_availability trivially correct and hides every bug in it.
 */
import 'dotenv/config';
import { connectDb, disconnectDb } from '../src/db/connect.js';
import { Customer, Technician, Job, EmergencyAlert } from '../src/db/models.js';
import { businessLocalToUtc, businessParts, describeWindow, WINDOW_HOURS } from '../src/util/businesstime.js';

await connectDb();

await Promise.all([
  Customer.deleteMany({}),
  Technician.deleteMany({}),
  Job.deleteMany({}),
  EmergencyAlert.deleteMany({}),
]);

const techs = await Technician.create([
  { name: 'Ray Alvarez', phone: '+15550110001', skills: ['hvac'], onCall: true },
  { name: 'Dee Okafor', phone: '+15550110002', skills: ['hvac'] },
  { name: 'Mo Haddad', phone: '+15550110003', skills: ['plumbing'], onCall: true },
  { name: 'Sam Reyes', phone: '+15550110004', skills: ['plumbing', 'hvac'] },
]);

const customers = await Customer.create([
  {
    phone: '+15551230001',
    name: 'Maria Whitfield',
    address: '18 Larkspur Lane',
    notes: 'Repeat customer. Dog in the yard, call on arrival.',
    jobCount: 2,
  },
  {
    phone: '+15551230002',
    name: 'Arun Patel',
    address: '904 Birchwood Court, Apt 3',
    notes: 'Buzzer is broken, call from the street.',
    jobCount: 1,
  },
]);

/** A window starting at `hour` local, `daysAhead` days from today. */
function window(daysAhead, hour) {
  const today = businessParts(new Date());
  const base = businessLocalToUtc(today.year, today.month, today.day + daysAhead, hour);
  return { slotStart: base, slotEnd: new Date(base.getTime() + WINDOW_HOURS * 3600 * 1000) };
}

// Existing bookings, so tomorrow's calendar has real holes in it.
const existing = [
  { tech: techs[0], cust: customers[0], daysAhead: 1, hour: 8,  category: 'hvac',     problem: 'Annual furnace service' },
  { tech: techs[1], cust: customers[1], daysAhead: 1, hour: 10, category: 'hvac',     problem: 'Thermostat replacement' },
  { tech: techs[0], cust: customers[1], daysAhead: 1, hour: 14, category: 'hvac',     problem: 'Condenser making noise' },
  { tech: techs[2], cust: customers[0], daysAhead: 1, hour: 10, category: 'plumbing', problem: 'Slow kitchen drain' },
  { tech: techs[0], cust: customers[0], daysAhead: 2, hour: 12, category: 'hvac',     problem: 'Duct inspection' },
];

const jobs = await Job.create(
  existing.map((e) => {
    const w = window(e.daysAhead, e.hour);
    return {
      customer: e.cust._id,
      technician: e.tech._id,
      problem: e.problem,
      category: e.category,
      priority: 'routine',
      status: 'scheduled',
      ...w,
      idempotencyKey: `seed:${e.cust.phone}:${w.slotStart.toISOString()}`,
      callId: 'seed',
    };
  })
);

console.log(`technicians: ${techs.length}`);
for (const t of techs) {
  console.log(`  ${t.name.padEnd(14)} ${t.skills.join('+').padEnd(14)} ${t.onCall ? 'ON CALL' : ''}`);
}
console.log(`customers:   ${customers.length}`);
for (const c of customers) console.log(`  ${c.name.padEnd(18)} ${c.phone}  ${c.address}`);
console.log(`existing jobs: ${jobs.length}`);
for (const j of jobs) {
  const t = techs.find((x) => String(x._id) === String(j.technician));
  console.log(`  ${t.name.padEnd(14)} ${describeWindow(j.slotStart, j.slotEnd)}  — ${j.problem}`);
}

await disconnectDb();
