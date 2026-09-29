/**
 * How an instructor's two independent statuses are named.
 *
 * They are two different facts and must stay that way:
 *
 *   availability_status  what the instructor said about themselves
 *   faculty_presence     what a BLE scanner observed
 *
 * Neither is derived from the other anywhere in this system, and nothing here
 * combines them into a single verdict. A dean's report, the student list and
 * the lounge display all read the same words from here so the same state is
 * never described three different ways.
 */

// Mirrors the users.availability_status enum.
const AVAILABILITY_LABELS = {
    available: 'Available',
    dnd: 'Do Not Disturb',
    travel: 'Official Travel',
    leave: 'On Leave',
    meeting: 'In a Meeting',
};

function availabilityLabel(status) {
    return AVAILABILITY_LABELS[status] || 'Not set';
}

/**
 * Presence as three states, never two.
 *
 * "No scanner has reported on this person" is not the same as "they are out",
 * and showing the second when the first is true tells a visitor something
 * nobody actually knows.
 *
 * The same goes for somebody held in a room whose scanner has gone silent
 * (signal_lost): the last reading said "in", but nothing is watching now, so
 * neither In nor Out is known.
 *
 * @param {number|boolean|null|undefined} isPresent  faculty_presence.is_present
 * @param {number|boolean} [signalLost]  faculty_presence.signal_lost
 * @returns {'in-room'|'out-of-room'|'unknown'}
 */
function presenceStatus(isPresent, signalLost = false) {
    if (isPresent === null || isPresent === undefined) return 'unknown';
    if (signalLost) return 'unknown';
    return isPresent ? 'in-room' : 'out-of-room';
}

/**
 * The room type the lounge board and the student page are asking about.
 *
 * Named once because two pages depend on it and a third will: "In" on those
 * pages does not mean "somewhere in the building", it means "at the lounge".
 * Widening what counts is a change to this one line.
 */
const FACULTY_LOUNGE_ROOM_TYPE = 'Faculty Lounge';

/**
 * Presence as the lounge board and the student page mean it.
 *
 * The dean asks a different question — where in the building is this person —
 * and gets presenceStatus() above. Here the only room that counts is the
 * lounge, so somebody detected in a laboratory is genuinely, confidently out.
 *
 * @param {object} row  needs is_present and detected_room_type
 * @param {boolean} opts.covered  whether a scanner is actually watching a
 *   lounge right now. When nothing is, every answer is 'unknown': "out" would
 *   claim this system looked and found nobody, and it did not look.
 */
function loungePresence(row, { covered = true } = {}) {
    if (!covered) return 'unknown';
    if (row.is_present === null || row.is_present === undefined) return 'unknown';
    if (row.signal_lost) return 'unknown';   // held by a scanner that went silent
    if (row.is_present && row.detected_room_type === FACULTY_LOUNGE_ROOM_TYPE) return 'in-room';
    return 'out-of-room';
}

const PRESENCE_LABELS = {
    'in-room': 'In',
    'out-of-room': 'Out',
    unknown: 'No data',
};

function presenceLabel(status) {
    return PRESENCE_LABELS[status] || PRESENCE_LABELS.unknown;
}

module.exports = {
    AVAILABILITY_LABELS,
    availabilityLabel,
    presenceStatus,
    FACULTY_LOUNGE_ROOM_TYPE,
    loungePresence,
    PRESENCE_LABELS,
    presenceLabel,
};
