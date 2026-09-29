const UserModel = require('../models/UserModel');
const PresenceModel = require('../models/PresenceModel');
const appSettings = require('../services/app-settings');
const { availabilityLabel, presenceStatus, loungePresence } = require('../utils/availability');

/**
 * Who is in, for any page that shows it.
 *
 * The ingest already broadcasts `presence:changed` over SSE, but only two
 * pages were listening — the dean's presence log and the admin's BLE page.
 * Every other page that shows In/Out was correct only at the moment it was
 * rendered and then quietly went stale: a student could sit on the faculty
 * availability page watching someone marked "In" long after they left.
 *
 * One endpoint serves all of them rather than four near-identical ones, so
 * "what does In mean" cannot end up answered differently per page.
 *
 * Scope follows the viewer: a dean, an instructor and a student see their own
 * department, an admin sees everyone.
 *
 * Where somebody is goes only to the roles whose pages already show it. A dean
 * managing a building needs the room and renders it server-side, so a live
 * update that could not change it left the room frozen at whatever was true
 * when the page loaded. Students and the lounge board get presence with no
 * location, exactly as before.
 *
 * Two presences ride on one entry because two pages ask different questions of
 * the same reading. A dean asks where in the building somebody is; the student
 * page asks whether they are at the Faculty Lounge, and somebody teaching in a
 * laboratory is confidently not. Sending both keeps one endpoint serving both
 * without either page deriving the other's answer for itself.
 */

/** Roles whose own pages name the room somebody is in. */
const ROLES_SHOWN_ROOMS = new Set(['Dean', 'Admin']);

function toEntry(row, coverage, { includeRoom = false } = {}) {
    const entry = {
        id: row.id,                    // public_id
        presence: presenceStatus(row.is_present, row.signal_lost),
        lounge: loungePresence(row, { covered: coverage.covered }),
        availability: row.availability_status || null,
        availabilityLabel: availabilityLabel(row.availability_status),
    };

    // Only ever added for a role that is already shown this on the page it is
    // updating. Absent — not null — for everyone else, so a student's feed
    // carries no field where a room could appear at all.
    if (includeRoom) {
        entry.room = row.detected_room_number || null;
        entry.roomId = row.detected_room_id === null || row.detected_room_id === undefined
            ? null
            : row.detected_room_id;
    }
    return entry;
}

const PresenceViewController = {

    /** GET /presence/faculty.json */
    async facultyJson(req, res) {
        const role = req.session.role;

        // An admin oversees the whole institution; everyone else sees the
        // department they belong to, and sees nothing if they have none.
        let departmentId = null;
        if (role !== 'Admin') {
            const me = await UserModel.getUserByPublicId(req.session.userId);
            departmentId = me?.department_id || null;
            if (!departmentId) {
                return res.json({
                    success: true, faculty: [], loungeCovered: false,
                    generatedAt: new Date().toISOString(),
                });
            }
        }

        const staleAfter = await appSettings.get('presence_scanner_offline_after_sec');
        const [rows, coverage] = await Promise.all([
            UserModel.getFacultyPresence({ departmentId }),
            PresenceModel.loungeCoverage(staleAfter),
        ]);

        const includeRoom = ROLES_SHOWN_ROOMS.has(role);

        res.set('Cache-Control', 'no-store');
        res.json({
            success: true,
            faculty: rows.map(row => toEntry(row, coverage, { includeRoom })),
            // Whether anything is watching a lounge at all. A page repainting
            // from this needs to know the difference between "nobody is in the
            // lounge" and "nothing can see the lounge".
            loungeCovered: coverage.covered,
            generatedAt: new Date().toISOString(),
        });
    },
};

module.exports = PresenceViewController;
module.exports.toEntry = toEntry;
