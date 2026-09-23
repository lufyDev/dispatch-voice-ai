import mongoose from 'mongoose';

const { Schema, model } = mongoose;

/** A caller. Phone is the natural key: it is what we have before a name. */
const customerSchema = new Schema(
  {
    phone: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    address: { type: String, required: true },
    notes: String,
    // A repeat customer is worth knowing about on a warm transfer: "I have
    // Maria on the line, no hot water, third call this year."
    jobCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/** A field technician. */
const technicianSchema = new Schema(
  {
    name: { type: String, required: true },
    phone: { type: String, required: true },
    // What they can actually be sent to. An emergency alert routed to someone
    // who does not do plumbing is worse than no alert.
    skills: { type: [String], enum: ['hvac', 'plumbing'], required: true },
    onCall: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const jobSchema = new Schema(
  {
    customer: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    technician: { type: Schema.Types.ObjectId, ref: 'Technician' },

    problem: { type: String, required: true },
    category: { type: String, enum: ['hvac', 'plumbing'], required: true },
    priority: { type: String, enum: ['emergency', 'routine'], required: true },
    status: {
      type: String,
      enum: ['scheduled', 'dispatched', 'complete', 'cancelled'],
      default: 'scheduled',
    },

    // The arrival window promised to the customer, not a precise appointment.
    // Home services quote windows because traffic and previous jobs overrun.
    slotStart: { type: Date, required: true },
    slotEnd: { type: Date, required: true },

    /**
     * THE DOUBLE-BOOKING GUARD.
     *
     * Derived, never supplied by the model: `${callId}:${phone}:${slotStartISO}`.
     *
     * The tempting design is to have the LLM generate a unique token per
     * booking. That fails in the exact case it exists for -- the model retries,
     * invents a NEW token, and you book the same job twice. A key derived from
     * the booking's own identity is the same on every retry by construction,
     * and the model never sees it, so it cannot forget or fumble it.
     *
     * Unique index, so the second write loses at the database rather than in
     * application logic that a race can slip past.
     */
    idempotencyKey: { type: String, required: true, unique: true },

    // Which call created this, for the M7 dashboard and for auditing a dispute.
    callId: { type: String, index: true },
  },
  { timestamps: true }
);

// Availability is computed from this: a technician's booked windows. Compound
// index because every availability check filters on exactly these three.
jobSchema.index({ technician: 1, slotStart: 1, status: 1 });

const emergencyAlertSchema = new Schema(
  {
    job: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    technician: { type: Schema.Types.ObjectId, ref: 'Technician', required: true },
    summary: { type: String, required: true },
    // Logged for now. A real one is an SMS or a page, and it is the part of the
    // system where a silent failure hurts someone.
    channel: { type: String, enum: ['log', 'sms', 'page'], default: 'log' },
    acknowledgedAt: Date,
    // Same reasoning as jobs: alerting twice wakes a technician twice.
    idempotencyKey: { type: String, required: true, unique: true },
  },
  { timestamps: true }
);

export const Customer = model('Customer', customerSchema);
export const Technician = model('Technician', technicianSchema);
export const Job = model('Job', jobSchema);
export const EmergencyAlert = model('EmergencyAlert', emergencyAlertSchema);
