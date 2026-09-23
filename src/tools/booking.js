import { Customer, Job, Technician } from '../db/models.js';
import { parseSlotId } from './availability.js';
import { describeWindow } from '../util/businesstime.js';

const ACTIVE = ['scheduled', 'dispatched'];
const digits10 = (phone) => String(phone ?? '').replace(/\D/g, '').slice(-10);

/**
 * Book the job.
 *
 * The only tool here with a consequence a caller will notice if it is wrong, so
 * two things are true of it that are not true of the read tools:
 *
 * IDEMPOTENCY IS DERIVED, NOT SUPPLIED. The key is
 * `${callId}:${phone}:${slotStartISO}`, built from the booking's own identity.
 * If the model calls this twice with the same arguments — a retry, or simply not
 * noticing it already succeeded — the second write hits a unique index and we
 * return the EXISTING job. Note what that means: a repeat call is a SUCCESS with
 * the same answer, not an error. "Idempotent" means same result, not "complains
 * the second time".
 *
 * WE RE-CHECK THE SLOT. Time passed between check_availability and here: the
 * caller spent thirty seconds spelling their street. Another call may have taken
 * the window. We re-check, and even then the database has the final say via the
 * unique (technician, slotStart, status) index — because any check-then-insert
 * has a gap between the check and the insert.
 */
export const bookJob = {
  name: 'book_job',
  description:
    'Book a routine job into a slot from check_availability. Pass slot_id back '
    + 'UNCHANGED. Only call this after you have read the caller\'s name, address '
    + 'and phone number back to them and they confirmed.',
  parameters: {
    type: 'object',
    properties: {
      slot_id: { type: 'string', description: 'The slot_id from check_availability, copied exactly.' },
      phone: { type: 'string', description: "Caller's phone number." },
      name: { type: 'string', description: "Caller's full name." },
      address: { type: 'string', description: 'Service address, including unit or apartment.' },
      problem: { type: 'string', description: 'One short sentence describing the fault, in the caller\'s words.' },
      category: { type: 'string', enum: ['hvac', 'plumbing'] },
    },
    required: ['slot_id', 'phone', 'name', 'address', 'problem', 'category'],
  },

  async execute({ slot_id: slotId, phone, name, address, problem, category }, { callId } = {}) {
    const slot = parseSlotId(slotId);
    if (!slot) {
      return { ok: false, error: 'That slot_id is not valid. Call check_availability and use one of its slot_id values exactly.' };
    }
    if (!digits10(phone) || digits10(phone).length < 10) {
      return { ok: false, error: 'Need a full 10-digit phone number before booking.' };
    }
    if (!name || !address) {
      return { ok: false, error: 'Need both a name and a service address before booking.' };
    }

    const tech = await Technician.findById(slot.techId).lean().catch(() => null);
    if (!tech) {
      return { ok: false, error: 'That slot_id refers to an unknown technician. Call check_availability again.' };
    }
    if (slot.start.getTime() < Date.now()) {
      return { ok: false, error: 'That window is in the past. Call check_availability again.' };
    }

    const idempotencyKey = `${callId ?? 'nocall'}:${digits10(phone)}:${slot.start.toISOString()}`;

    // Fast path for an obvious retry: if we already made this exact booking,
    // say so without touching anything.
    const existing = await Job.findOne({ idempotencyKey }).lean();
    if (existing) {
      return {
        ok: true,
        already_booked: true,
        job_id: String(existing._id),
        technician: tech.name,
        spoken: describeWindow(existing.slotStart, existing.slotEnd),
      };
    }

    const customer = await Customer.findOneAndUpdate(
      { phone: new RegExp(`${digits10(phone)}$`) },
      { $setOnInsert: { phone: `+1${digits10(phone)}`, name, address } },
      { returnDocument: 'after', upsert: true }
    );
    // A returning caller may have moved, or we may have had a typo. Trust what
    // they just told us over what we stored.
    if (customer.name !== name || customer.address !== address) {
      customer.name = name;
      customer.address = address;
      await customer.save();
    }

    try {
      const job = await Job.create({
        customer: customer._id,
        technician: tech._id,
        problem,
        category,
        priority: 'routine',
        status: 'scheduled',
        slotStart: slot.start,
        slotEnd: slot.end,
        idempotencyKey,
        callId,
      });
      await Customer.updateOne({ _id: customer._id }, { $inc: { jobCount: 1 } });

      return {
        ok: true,
        job_id: String(job._id),
        technician: tech.name,
        spoken: describeWindow(job.slotStart, job.slotEnd),
      };
    } catch (err) {
      if (err?.code !== 11000) throw err;

      // Which guard fired matters: one means "you already did this", the other
      // means "somebody else got there first". They need different replies.
      const clashed = Object.keys(err.keyPattern ?? {});
      if (clashed.includes('idempotencyKey')) {
        const already = await Job.findOne({ idempotencyKey }).lean();
        return {
          ok: true,
          already_booked: true,
          job_id: String(already._id),
          technician: tech.name,
          spoken: describeWindow(already.slotStart, already.slotEnd),
        };
      }
      return {
        ok: false,
        error: 'That window was just taken by another caller. Apologise briefly, call check_availability again, and offer the new options.',
      };
    }
  },
};

/** Any active job this call already created, so the model is not told to book twice. */
export async function jobsForCall(callId) {
  return Job.find({ callId, status: { $in: ACTIVE } }).lean();
}
