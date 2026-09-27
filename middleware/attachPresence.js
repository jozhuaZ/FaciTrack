const PresenceModel = require('../models/PresenceModel');

/**
 * The signed-in instructor's own room status, for the sidebar on every
 * instructor page: in a room (and which), or out.
 *
 * Read only, and only for display. It never touches appointment status or
 * availability — BLE presence and appointments must not influence each other.
 *
 * Loaded the way attachNotifications is: only a rendered page needs it, so it
 * starts alongside the route's own queries and res.render waits for it at the
 * end. A failure (no presence tables yet, a dropped connection) shows "Out of
 * Room" rather than breaking the page.
 */

/** A faculty_presence row → what the sidebar shows. */
function shapeOwnPresence(row) {
    const inRoom = !!(row && row.is_present);
    return { inRoom, room: inRoom ? (row.room_number || null) : null };
}

async function loadOwnPresence(publicId) {
    try {
        return shapeOwnPresence(await PresenceModel.getOwn(publicId));
    } catch (err) {
        console.error('[attachPresence]', err.message);
        return shapeOwnPresence(null);
    }
}

function attachPresence(req, res, next) {
    if (!req.session?.userId || req.session?.role !== 'Instructor') return next();

    let pending = null;
    const load = () => pending || (pending = loadOwnPresence(req.session.userId));

    // A browser navigation asks for HTML; fetch() and polls ask for */* or JSON.
    if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) load();

    const originalRender = res.render.bind(res);
    res.render = function (view, options, callback) {
        load().then((presence) => {
            res.locals.ownPresence = presence;
            originalRender(view, options, callback);
        });
    };
    next();
}

module.exports = attachPresence;
module.exports.loadOwnPresence = loadOwnPresence;
