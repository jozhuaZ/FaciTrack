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