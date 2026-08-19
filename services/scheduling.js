<<<<<<< HEAD
function normalizeDateKey(date) {
    if (typeof date === 'string') {
        const isoMatch = date.match(/^\d{4}-\d{2}-\d{2}/);
        if (isoMatch) return isoMatch[0];
    }
    const parsed = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(parsed.getTime())) return '';
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getBlockDateKeys(block) {
    return [];
}

function bookingConflictsWithBlock(booking, block) {
    return false;
}

module.exports = {
    normalizeDateKey,
    getBlockDateKeys,
    bookingConflictsWithBlock
};
=======
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

module.exports = {
  normalizeDateKey,
  getBlockDateKeys,
  parseTimeToMinutes,
  bookingConflictsWithBlock
};
>>>>>>> c71d16bf038fca6624a58a1e67b1141cc736296c
