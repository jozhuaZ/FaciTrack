function to24Hour(str) {
    const parts = str.trim().split(' ');
    let [h, m] = parts[0].split(':').map(Number);
    const p = parts[1];
    if (p === 'PM' && h !== 12) h += 12;
    if (p === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}

function to12Hour(timeStr) {
    const [hStr, mStr] = timeStr.split(':');
    let h = parseInt(hStr);
    const m = mStr;
    const p = h >= 12 ? 'PM' : 'AM';
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return `${h}:${m} ${p}`;
}

function toMins(str) {
    const parts = str.trim().split(' ');
    let [h, m] = parts[0].split(':').map(Number);
    const p = parts[1];
    if (p === 'PM' && h !== 12) h += 12;
    if (p === 'AM' && h === 12) h = 0;
    return h * 60 + m;
}

function fromMins(mins) {
    let h = Math.floor(mins / 60);
    const m = mins % 60;
    const p = h >= 12 ? 'PM' : 'AM';
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, '0')} ${p}`;
}

function formatFullDate(dateStr) {
    const d = new Date(dateStr + (dateStr.includes('T') ? '' : 'T00:00:00'));
    return d.toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' });
}

module.exports = { to12Hour, to24Hour, toMins, fromMins, formatFullDate };