import { Technician, Job } from '../db/models.js';
import {
  businessLocalToUtc, businessParts, describeWindow,
  WINDOW_HOURS, OPEN_HOUR, CLOSE_HOUR,
} from '../util/businesstime.js';

// Do not offer a window starting sooner than this. A technician has to finish
// the current job and drive, and a promise we cannot keep is worse than a later
// slot the caller accepts.
const LEAD_TIME_MS = 2 * 3600 * 1000;

const ACTIVE = ['scheduled', 'dispatched'];

/**
 * When can someone actually come?
 *
 * Availability is COMPUTED from the technicians' booked windows, never stored.
 * A separate "free slots" collection is the tempting shortcut and it drifts:
 * two sources of truth for the same fact, and the calendar silently stops
 * matching the jobs.
 *
 * Returns an opaque slot_id, and book_job takes that id back. The model is
 * therefore never asked to handle a date. If it were, it would eventually
 * invent one — and a hallucinated appointment time is a truck at the wrong
 * house at the wrong hour.
 */
export const checkAvailability = {
  name: 'check_availability',
  description:
    'Find the earliest available two-hour arrival windows for a given kind of work. '
    + 'Read the "spoken" text out loud to the caller. To book one, pass its slot_id '
    + 'to book_job unchanged — never construct a date yourself.',
  parameters: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['hvac', 'plumbing'],
        description: 'hvac for heating, cooling, furnaces, thermostats. plumbing for pipes, drains, water heaters.',
      },
      days_ahead: {
        type: 'integer',
        description: 'How many days forward to search. Default 4.',
      },
    },
    required: ['category'],
  },

  async execute({ category, days_ahead: daysAhead = 4 }) {
    if (!['hvac', 'plumbing'].includes(category)) {
      return { ok: false, error: `Unknown category "${category}". Use hvac or plumbing.` };
    }

    // Sorted for determinism. Without it Mongo returns them in whatever order
    // it likes, so "which technician gets this job" changes between runs and
    // becomes impossible to reason about in a test.
    const techs = await Technician.find({ skills: category }).sort({ name: 1 }).lean();
    if (techs.length === 0) {
      return { ok: false, error: `No technicians do ${category} work. Offer to pass the caller to a human.` };
    }

    const now = new Date();
    const horizon = new Date(now.getTime() + (daysAhead + 1) * 86400 * 1000);

    // One query for the whole search, then decide in memory. A query per
    // candidate window would be ~20 round trips during a live phone call.
    const jobs = await Job.find({
      technician: { $in: techs.map((t) => t._id) },
      status: { $in: ACTIVE },
      slotStart: { $lt: horizon },
      slotEnd: { $gt: now },
    }).select('technician slotStart slotEnd').lean();

    const busy = (techId, start, end) =>
      jobs.some(
        (j) => String(j.technician) === String(techId)
          && j.slotStart < end && j.slotEnd > start
      );

    /** How many jobs this technician already has on the same business day. */
    const jobsOnDay = (techId, when) => {
      const day = businessParts(when);
      return jobs.filter((j) => {
        if (String(j.technician) !== String(techId)) return false;
        const p = businessParts(j.slotStart);
        return p.year === day.year && p.month === day.month && p.day === day.day;
      }).length;
    };

    const today = businessParts(now);
    const slots = [];

    for (let d = 0; d <= daysAhead && slots.length < 3; d += 1) {
      for (let hour = OPEN_HOUR; hour + WINDOW_HOURS <= CLOSE_HOUR; hour += WINDOW_HOURS) {
        const start = businessLocalToUtc(today.year, today.month, today.day + d, hour);
        const end = new Date(start.getTime() + WINDOW_HOURS * 3600 * 1000);

        if (start.getTime() - now.getTime() < LEAD_TIME_MS) continue;
        // Closed Sundays. Offering a window nobody will show up for is worse
        // than having no window.
        if (businessParts(start).weekday === 'Sun') continue;

        // Among the free technicians, prefer the one with the least booked that
        // day. Taking the first free name is not a dispatch policy -- it loads
        // one person up while another sits idle. Real systems also weigh travel
        // distance from the previous job, which we have no addresses for.
        const free = techs
          .filter((t) => !busy(t._id, start, end))
          .map((t) => ({ tech: t, load: jobsOnDay(t._id, start) }))
          .sort((a, b) => a.load - b.load || a.tech.name.localeCompare(b.tech.name))[0]?.tech;
        if (!free) continue;

        slots.push({
          // The token the model echoes back. Readable on purpose: when a
          // booking goes wrong, this is the first thing you read in a log.
          slot_id: `${start.toISOString()}~${free._id}`,
          spoken: describeWindow(start, end),
          technician: free.name,
        });
        if (slots.length >= 3) break;
      }
    }

    if (slots.length === 0) {
      return {
        ok: true,
        slots: [],
        message: `Nothing free for ${category} in the next ${daysAhead} days. Offer to pass the caller to a human.`,
      };
    }

    return { ok: true, slots };
  },
};

/** Parse a slot_id back into its parts. Returns null if it is not one of ours. */
export function parseSlotId(slotId) {
  const [iso, techId] = String(slotId ?? '').split('~');
  const start = new Date(iso);
  if (!iso || !techId || Number.isNaN(start.getTime())) return null;
  return { start, end: new Date(start.getTime() + WINDOW_HOURS * 3600 * 1000), techId };
}
