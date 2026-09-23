import { Customer, Job, Technician, EmergencyAlert } from '../db/models.js';

const digits10 = (phone) => String(phone ?? '').replace(/\D/g, '').slice(-10);

// How long the on-call technician is told to aim for. A window, not a promise
// of a minute, for the same reason routine jobs get windows.
const EMERGENCY_WINDOW_MS = 2 * 3600 * 1000;

/**
 * Wake the on-call technician.
 *
 * Deliberately NOT a variant of book_job. Emergencies differ in every way that
 * matters: no slot is chosen, the caller is not offered options, an actual human
 * gets woken up, and it must go out even if we are missing details we would
 * insist on for a routine booking. An agent that refuses to escalate a burst
 * pipe because it has not got the apartment number yet is worse than useless.
 *
 * Idempotency key is `${callId}:emergency:${phone}` — deliberately WITHOUT the
 * problem text. One emergency per caller per call. If the model calls this twice
 * because the caller repeated themselves, the technician must not be paged
 * twice, and the second page would say something slightly different (the model
 * rephrases), which a content-based key would treat as a new alert.
 */
export const createEmergencyAlert = {
  name: 'create_emergency_alert',
  description:
    'Escalate an emergency to the on-call technician immediately. Use for burst '
    + 'pipes, flooding, no heat in freezing weather, a gas smell, or no hot water '
    + 'with an infant in the house. Call this BEFORE collecting full details — a '
    + 'name and phone number are enough. Do not offer appointment slots for an '
    + 'emergency.',
  parameters: {
    type: 'object',
    properties: {
      phone: { type: 'string', description: "Caller's phone number." },
      problem: { type: 'string', description: "What is wrong, in the caller's words." },
      category: { type: 'string', enum: ['hvac', 'plumbing'] },
      name: { type: 'string', description: "Caller's name, if known." },
      address: { type: 'string', description: 'Service address, if known.' },
    },
    required: ['phone', 'problem', 'category'],
  },

  async execute({ phone, problem, category, name, address }, { callId } = {}) {
    if (!digits10(phone)) {
      return { ok: false, error: 'Need a phone number so the technician can call them back.' };
    }
    if (!['hvac', 'plumbing'].includes(category)) {
      return { ok: false, error: `Unknown category "${category}". Use hvac or plumbing.` };
    }

    // On-call first; fall back to anyone qualified. Failing to alert because the
    // rota is wrong is the one outcome this tool must never produce.
    const tech =
      (await Technician.findOne({ skills: category, onCall: true }).lean())
      ?? (await Technician.findOne({ skills: category }).sort({ name: 1 }).lean());
    if (!tech) {
      return { ok: false, error: `No ${category} technician exists at all. Tell the caller you are transferring them to a human immediately.` };
    }

    const idempotencyKey = `${callId ?? 'nocall'}:emergency:${digits10(phone)}`;

    const already = await EmergencyAlert.findOne({ idempotencyKey }).populate('technician').lean();
    if (already) {
      return {
        ok: true,
        already_alerted: true,
        technician: already.technician.name,
        spoken: `${already.technician.name} has already been alerted and is on the way.`,
      };
    }

    const customer = await Customer.findOneAndUpdate(
      { phone: new RegExp(`${digits10(phone)}$`) },
      {
        $setOnInsert: {
          phone: `+1${digits10(phone)}`,
          // Placeholders on purpose. We escalate on partial information; the
          // technician will get the rest on the callback.
          name: name || 'Unknown caller',
          address: address || 'Address not captured',
        },
      },
      { returnDocument: 'after', upsert: true }
    );
    if (name && customer.name === 'Unknown caller') customer.name = name;
    if (address && customer.address === 'Address not captured') customer.address = address;
    await customer.save();

    const now = new Date();
    let job;
    try {
      job = await Job.create({
        customer: customer._id,
        technician: tech._id,
        problem,
        category,
        priority: 'emergency',
        // dispatched, not scheduled: nobody is going to confirm this later.
        status: 'dispatched',
        slotStart: now,
        slotEnd: new Date(now.getTime() + EMERGENCY_WINDOW_MS),
        idempotencyKey: `${idempotencyKey}:job`,
        callId,
      });
    } catch (err) {
      if (err?.code !== 11000) throw err;
      job = await Job.findOne({ idempotencyKey: `${idempotencyKey}:job` });
    }

    const summary = `${category.toUpperCase()} EMERGENCY — ${customer.name}, ${customer.address}, ${customer.phone}: ${problem}`;
    try {
      await EmergencyAlert.create({
        job: job._id,
        technician: tech._id,
        summary,
        channel: 'log',
        idempotencyKey,
      });
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }

    // Stands in for an SMS or a page. This is the line that must never fail
    // silently in production — a dropped alert is someone's flooded basement.
    console.log(`\n*** PAGE -> ${tech.name} ${tech.phone} ***\n    ${summary}\n`);

    return {
      ok: true,
      technician: tech.name,
      job_id: String(job._id),
      spoken: `${tech.name} is our on-call technician and has been alerted. They will call this number shortly.`,
    };
  },
};
