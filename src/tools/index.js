import { lookupCustomer } from './customers.js';
import { checkAvailability } from './availability.js';
import { bookJob } from './booking.js';
import { createEmergencyAlert } from './emergency.js';

export const TOOLS = [lookupCustomer, checkAvailability, bookJob, createEmergencyAlert];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** The shape OpenAI wants. Kept separate so the tools do not know about a vendor. */
export function toolSchemas() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * Run a tool the model asked for.
 *
 * Never throws. A model cannot read a stack trace, but it can read "that slot
 * was just taken, ask again" — so every failure comes back as a result it can
 * act on. An exception here would abort the turn and leave the caller in
 * silence, which is the worst available outcome.
 *
 * `context` carries the callId, which the model never sees and cannot forge.
 * That is what makes derived idempotency keys trustworthy.
 */
export async function runTool(name, args, context) {
  const tool = BY_NAME.get(name);
  if (!tool) return { ok: false, error: `No such tool "${name}".` };
  try {
    return await tool.execute(args ?? {}, context ?? {});
  } catch (err) {
    console.error(`[tool] ${name} threw: ${err.message}`);
    return {
      ok: false,
      error: 'That did not work because of a system problem. Apologise and offer to pass the caller to a human.',
    };
  }
}
