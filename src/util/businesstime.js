/**
 * Business-local time, without pulling in a date library.
 *
 * Everything is STORED as a UTC Date. Everything the caller hears is rendered in
 * the business's timezone. Those are different jobs and conflating them is how
 * you promise a technician at 2pm and send them at 7am.
 *
 * Why not a fixed UTC offset: DST. A US contractor is UTC-5 in January and UTC-4
 * in July, so "10am local" is a different instant depending on the date. Fixed
 * offsets are correct for exactly half the year.
 */

export const BUSINESS_TZ = process.env.BUSINESS_TZ || 'America/New_York';

// Arrival windows, not appointments. Home services quote windows because
// traffic and an overrunning previous job make a precise time a lie.
export const WINDOW_HOURS = 2;
export const OPEN_HOUR = 8;   // first window starts 08:00 local
export const CLOSE_HOUR = 18; // last window ends 18:00 local

/** Minutes that `tz` is offset from UTC at this particular instant. */
function offsetMinutes(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  // 24 is legal in some locales' hour24 output; midnight is hour 0 for our maths.
  const hour = parts.hour === '24' ? '0' : parts.hour;
  const asIfUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(hour), Number(parts.minute), Number(parts.second)
  );
  return (asIfUtc - date.getTime()) / 60000;
}

/**
 * The UTC instant at which the business's local clock reads y-m-d h:00.
 *
 * Solved by iteration rather than algebra: guess that local == UTC, measure the
 * offset at that guess, correct, then measure again. The second pass matters
 * only on the two days a year when the guess lands on the other side of a DST
 * transition -- but those are exactly the days a naive implementation is wrong.
 */
export function businessLocalToUtc(year, month, day, hour, tz = BUSINESS_TZ) {
  let utc = Date.UTC(year, month - 1, day, hour, 0, 0);
  for (let i = 0; i < 2; i += 1) {
    utc = Date.UTC(year, month - 1, day, hour, 0, 0) - offsetMinutes(new Date(utc), tz) * 60000;
  }
  return new Date(utc);
}

/** Business-local calendar parts of an instant. */
export function businessParts(date, tz = BUSINESS_TZ) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short',
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value])
  );
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: p.hour === '24' ? 0 : Number(p.hour),
    weekday: p.weekday,
  };
}

/** How a window should be SAID out loud. TTS reads "10:00-12:00" badly. */
export function describeWindow(start, end, tz = BUSINESS_TZ) {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'long', month: 'long', day: 'numeric',
  }).format(start);
  const time = (d) =>
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: true })
      .format(d)
      .replace(' AM', ' a.m.')
      .replace(' PM', ' p.m.');
  return `${day} between ${time(start)} and ${time(end)}`;
}
