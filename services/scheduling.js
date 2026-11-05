function normalizeDateKey(value) {
  if (!value) return null;
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  const year = dt.getFullYear();
  const month = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getBlockDateKeys(startDate, endDate) {
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  const dates = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    dates.push(normalizeDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function parseTimeToMinutes(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const simpleMatch = raw.match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
  const suffixedMatch = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  const match = suffixedMatch || simpleMatch;
  if (!match) return null;
  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const suffix = (match[3] || 'AM').toUpperCase();
  if (suffix === 'PM' && hours !== 12) hours += 12;
  if (suffix === 'AM' && hours === 12) hours = 0;
  return hours * 60 + minutes;
}

function bookingConflictsWithBlock(booking, block, blockDateKey) {
  if (!booking || !block) return false;
  if (normalizeDateKey(booking.date) !== blockDateKey) return false;

  if (block.type === 'full-day') return true;
  if (block.type !== 'time-range') return false;

  const bookingSlot = String(booking.slot || '');
  const slotMatch = bookingSlot.match(/^(\d{1,2}:\d{2})\s*(AM|PM)\s*[-–]\s*(\d{1,2}:\d{2})\s*(AM|PM)$/i);
  if (!slotMatch) return false;

  const startMinutes = parseTimeToMinutes(`${slotMatch[1]} ${slotMatch[2]}`);
  const endMinutes = parseTimeToMinutes(`${slotMatch[3]} ${slotMatch[4]}`);
  const blockStart = parseTimeToMinutes(`${block.startTime}`);
  const blockEnd = parseTimeToMinutes(`${block.endTime}`);

  if (startMinutes === null || endMinutes === null || blockStart === null || blockEnd === null) return false;
  return startMinutes < blockEnd && endMinutes > blockStart;
}


// ── What counts as a slot being taken ──
//
// Cancelled, declined and rescheduled appointments release their slot: a
// rescheduled booking has already moved somewhere else, so the original hour
// is free again. Everything else still holds it.
//
// This list must be the ONLY answer to "is this slot taken?". The booking
// calendar and the create path used to define it differently — the calendar
// offered a slot whose appointment had been rescheduled, then the submit
// refused it as already booked.
const SLOT_HOLDING_STATUSES = ['pending', 'confirmed', 'completed'];

/** The same list as a SQL fragment, for embedding in an IN (...) clause. */
const SLOT_HOLDING_SQL = SLOT_HOLDING_STATUSES.map(s => `'${s}'`).join(', ');

// A narrower question, and a different one: which bookings are still live —
// awaiting an answer or due to happen — so can be cancelled, declined or
// rescheduled. A completed consultation holds its slot but is not live: it
// already happened and must never be declined out from under the student.
const LIVE_APPOINTMENT_STATUSES = ['pending', 'confirmed'];
const LIVE_APPOINTMENT_SQL = LIVE_APPOINTMENT_STATUSES.map(s => `'${s}'`).join(', ');

// ── No same-day booking ──
//
// Students may book from tomorrow onwards. A slot dated today or earlier is
// never bookable, whatever time it starts: the rule is about the calendar
// date, not a rolling window from now. This replaced a configurable
// hour-based lead time, which let a late-evening student book the next
// morning but not the same afternoon — and needed an admin setting to explain.
//
// One rule, used by the SQL filters, the controller checks and the "next
// available" labels, so a slot can never look open on one page and be
// refused on the next.

/** Today's date in the database's clock, as YYYY-MM-DD. */
const BOOKING_TZ_OFFSET = process.env.DB_TIME_ZONE || '+08:00';

/**
 * Today's date as YYYY-MM-DD, measured on the database's clock.
 *
 * Consultation dates are Manila wall-clock values and every DB session runs at
 * DB_TIME_ZONE (see configs/db.js), so "today" must be read at that offset.
 * Using the Node server's local date instead would disagree with CURDATE() for
 * eight hours around midnight on a host that runs in UTC — long enough for a
 * direct booking link to slip a same-day slot through.
 */
function todayDateKey(now = new Date()) {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(BOOKING_TZ_OFFSET);
  if (!match) return normalizeDateKey(now);
  const offsetMins = (match[1] === '-' ? -1 : 1) *
    (Number(match[2]) * 60 + Number(match[3]));
  const shifted = new Date(now.getTime() + offsetMins * 60000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * True when a slot dated `dateKey` is today or already past, so cannot be
 * booked. An unparseable date is left to the other checks rather than being
 * treated as blocked.
 * @param {string} dateKey YYYY-MM-DD
 */
function isSameDayOrPast(dateKey, now = new Date()) {
  const key = String(dateKey || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  return key <= todayDateKey(now);
}

module.exports = {
  normalizeDateKey,
  getBlockDateKeys,
  parseTimeToMinutes,
  bookingConflictsWithBlock,
  SLOT_HOLDING_STATUSES,
  SLOT_HOLDING_SQL,
  LIVE_APPOINTMENT_STATUSES,
  LIVE_APPOINTMENT_SQL,
  todayDateKey,
  isSameDayOrPast
};
