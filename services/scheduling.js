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
