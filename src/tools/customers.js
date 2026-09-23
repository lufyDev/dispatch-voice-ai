import { Customer } from '../db/models.js';

/**
 * Who is calling?
 *
 * Phone first, because on a real call we have the caller ID before we have a
 * name. A repeat customer we can greet and whose address we already know saves
 * the caller ninety seconds of spelling their street.
 */
export const lookupCustomer = {
  name: 'lookup_customer',
  description:
    'Look up a customer by phone number. Call this FIRST if you have the caller\'s '
    + 'number, before asking for their name or address — if they are a repeat '
    + 'customer you already have both and should confirm rather than ask.',
  parameters: {
    type: 'object',
    properties: {
      phone: {
        type: 'string',
        description: 'Phone number, digits only or E.164. Example: 5551230001',
      },
    },
    required: ['phone'],
  },

  async execute({ phone }) {
    if (!phone || String(phone).replace(/\D/g, '').length < 7) {
      return { ok: false, error: 'That does not look like a phone number. Ask the caller to repeat it.' };
    }

    // Callers say "555 123 0001"; the database holds "+15551230001". Compare on
    // the last 10 digits so formatting never decides whether we find someone.
    const digits = String(phone).replace(/\D/g, '').slice(-10);
    const customer = await Customer.findOne({ phone: new RegExp(`${digits}$`) }).lean();

    if (!customer) {
      return {
        ok: true,
        found: false,
        message: 'No existing customer with that number. Collect their name and address.',
      };
    }

    return {
      ok: true,
      found: true,
      name: customer.name,
      address: customer.address,
      notes: customer.notes ?? null,
      previous_jobs: customer.jobCount,
    };
  },
};
