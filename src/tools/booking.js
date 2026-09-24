import { Customer, Job, Technician } from '../db/models.js';
import { parseSlotId } from './availability.js';
import { describeWindow } from '../util/businesstime.js';

const ACTIVE = ['scheduled', 'dispatched'];
const digits10 = (phone) => String(phone ?? '').replace(/\D/g, '').slice(-10);

/** "5557778888" -> "555, 777, 8888". TTS reads grouped digits as a phone number. */
const sayPhone = (phone) => {
  const d = digits10(phone);
  return `${d.slice(0, 3)}, ${d.slice(3, 6)}, ${d.slice(6)}`;
};

/**
 * Validate a booking and produce the sentence to read back.
 *
 * Booking is deliberately TWO tools rather than one, because "read the details
 * back and wait for confirmation" cannot be achieved by instructing the model.
 * We tried: it read the details back and confirmed the appointment in the same
 * breath, twice, with the prompt explicitly forbidding it.
 *
 * So the shape enforces it. This tool validates and records a proposal; book_job
 * takes NO ARGUMENTS and can only commit what was proposed and then confirmed.
 * The model cannot read one thing aloud and book another, because by the time it
 * books there is nothing left to choose.
 *
 * Validation happens HERE rather than at booking time on purpose: a problem
 * should surface before the caller is asked to agree to something, not after.
 */
export const proposeBooking = {
  name: 'propose_booking',
  description:
    'Check a booking and get the exact wording to read back to the caller. Call '
    + 'this once you have a slot_id, name, address and phone number. Read the '
    + '"read_back" text out loud EXACTLY as given, then wait for their answer. '
    + 'If they correct anything, call this again with the corrected details.',
  parameters: {
    type: 'object',
    properties: {
      slot_id: { type: 'string', description: 'The slot_id from check_availability, copied exactly.' },
      phone: { type: 'string', description: "Caller's phone number." },
      name: { type: 'string', description: "Caller's full name." },
      address: { type: 'string', description: 'Service address, including unit or apartment.' },
      problem: { type: 'string', description: "One short sentence describing the fault, in the caller's words." },
      category: { type: 'string', enum: ['hvac', 'plumbing'] },
    },
    required: ['slot_id', 'phone', 'name', 'address', 'problem', 'category'],
  },

  async execute({ slot_id: slotId, phone, name, address, problem, category }, { state } = {}) {
    const slot = parseSlotId(slotId);
    if (!slot) {
      return { ok: false, error: 'That slot_id is not valid. Call check_availability and use one of its slot_id values exactly.' };
    }
    if (digits10(phone).length < 10) {
      return { ok: false, error: 'Need a full 10-digit phone number. Ask the caller to repeat it.' };
    }
    if (!name?.trim()) return { ok: false, error: 'Need the caller\'s name before booking.' };
    if (!address?.trim()) return { ok: false, error: 'Need the service address before booking.' };
    if (!['hvac', 'plumbing'].includes(category)) {
      return { ok: false, error: `Unknown category "${category}". Use hvac or plumbing.` };
    }

    const tech = await Technician.findById(slot.techId).lean().catch(() => null);
    if (!tech) {
      return { ok: false, error: 'That slot_id refers to an unknown technician. Call check_availability again.' };
    }
    if (slot.start.getTime() < Date.now()) {
      return { ok: false, error: 'That window is in the past. Call check_availability again.' };
    }
    // Check the window is still free BEFORE asking the caller to agree to it.
    const taken = await Job.exists({
      technician: tech._id, status: { $in: ACTIVE },
      slotStart: { $lt: slot.end }, slotEnd: { $gt: slot.start },
    });
    if (taken) {
      return { ok: false, error: 'That window has just been taken. Call check_availability again and offer what is actually free.' };
    }

    if (state) {
      state.proposal = {
        slotStart: slot.start, slotEnd: slot.end, techId: String(tech._id), techName: tech.name,
        phone: digits10(phone), name: name.trim(), address: address.trim(),
        problem: (problem ?? '').trim() || 'Not described', category,
      };
      // A fresh proposal is always unconfirmed, including when it REPLACES a
      // confirmed one. Otherwise a caller who corrects their address after
      // saying yes would have the correction booked without ever agreeing to it.
      state.confirmed = false;
    }

    return {
      ok: true,
      // describeWindow ends in "a.m."/"p.m.", so appending ". Is that..." gave
      // "10 a.m.. Is that", which TTS reads as a stumble.
      read_back:
        `Let me confirm. ${name.trim()}, ${address.trim()}, phone ${sayPhone(phone)}, `
        + `${describeWindow(slot.start, slot.end)} — is that all correct?`,
    };
  },
};

/**
 * Commit the proposal the caller confirmed.
 *
 * NO ARGUMENTS, deliberately. If it accepted the details again, the model could
 * read one set aloud and book a different set -- and the caller would have no way
 * to detect it on the phone. With nothing to pass, what was heard is what is
 * booked, by construction. Same principle as truncating history to what was
 * actually played in M4.
 *
 * IDEMPOTENCY IS DERIVED from the proposal: `${callId}:${phone}:${slotStartISO}`.
 * A retry produces the same key, hits the unique index, and we return the
 * EXISTING job. A repeat call is a SUCCESS with the same answer, not an error --
 * if it errored, the model would apologise for a booking that exists.
 */
export const bookJob = {
  name: 'book_job',
  description:
    'Commit the booking the caller just confirmed. Takes no arguments: it books '
    + 'exactly what propose_booking read out. Only call this after the caller has '
    + 'said yes to the read_back.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },

  async execute(_args, { callId, state } = {}) {
    const p = state?.proposal;
    if (!p) {
      // The proposal is consumed on success, so a model that calls this twice --
      // because it never saw the first result -- would otherwise be told
      // "nothing proposed", which is true but useless and invites it to start
      // over and book a second job. Tell it what it already did instead.
      const done = await Job.findOne({ callId, priority: 'routine', status: { $in: ACTIVE } })
        .sort({ createdAt: -1 })
        .populate('technician')
        .lean();
      if (done) {
        return {
          ok: true, already_booked: true, job_id: String(done._id),
          technician: done.technician?.name, spoken: describeWindow(done.slotStart, done.slotEnd),
        };
      }
      return { ok: false, error: 'Nothing has been proposed yet. Call propose_booking first and read out its read_back text.' };
    }
    if (!state.confirmed) {
      return {
        ok: false,
        error: 'The caller has not confirmed these details. Read out the read_back sentence from propose_booking and wait for their answer before calling this again.',
      };
    }

    const idempotencyKey = `${callId ?? 'nocall'}:${p.phone}:${p.slotStart.toISOString()}`;

    const existing = await Job.findOne({ idempotencyKey }).lean();
    if (existing) {
      return {
        ok: true, already_booked: true, job_id: String(existing._id),
        technician: p.techName, spoken: describeWindow(existing.slotStart, existing.slotEnd),
      };
    }

    const customer = await Customer.findOneAndUpdate(
      { phone: new RegExp(`${p.phone}$`) },
      { $setOnInsert: { phone: `+1${p.phone}`, name: p.name, address: p.address } },
      { returnDocument: 'after', upsert: true }
    );
    // A returning caller may have moved, or we may have had a typo. Trust what
    // they just confirmed over what we stored.
    if (customer.name !== p.name || customer.address !== p.address) {
      customer.name = p.name;
      customer.address = p.address;
      await customer.save();
    }

    try {
      const job = await Job.create({
        customer: customer._id, technician: p.techId,
        problem: p.problem, category: p.category,
        priority: 'routine', status: 'scheduled',
        slotStart: p.slotStart, slotEnd: p.slotEnd,
        idempotencyKey, callId,
      });
      await Customer.updateOne({ _id: customer._id }, { $inc: { jobCount: 1 } });

      // Consumed. A second book_job without a new proposal must not re-commit.
      state.proposal = null;
      state.confirmed = false;

      return {
        ok: true, job_id: String(job._id), technician: p.techName,
        spoken: describeWindow(job.slotStart, job.slotEnd),
      };
    } catch (err) {
      if (err?.code !== 11000) throw err;

      // Which guard fired matters: one means "you already did this", the other
      // means "somebody else got there first". Different replies.
      if (Object.keys(err.keyPattern ?? {}).includes('idempotencyKey')) {
        const already = await Job.findOne({ idempotencyKey }).lean();
        return {
          ok: true, already_booked: true, job_id: String(already._id),
          technician: p.techName, spoken: describeWindow(already.slotStart, already.slotEnd),
        };
      }
      state.proposal = null;
      state.confirmed = false;
      return {
        ok: false,
        error: 'That window was just taken by another caller. Apologise briefly, call check_availability again, and offer the new options.',
      };
    }
  },
};

/** Any active job this call created, so the model is not told to book twice. */
export async function jobsForCall(callId) {
  return Job.find({ callId, status: { $in: ACTIVE } }).lean();
}
