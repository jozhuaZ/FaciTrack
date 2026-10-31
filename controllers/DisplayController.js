const UserModel = require('../models/UserModel');
const DepartmentModel = require('../models/DepartmentModel');
const DisplayDeviceModel = require('../models/DisplayDeviceModel');
const { availabilityLabel, loungePresence, presenceLabel } = require('../utils/availability');
const PresenceModel = require('../models/PresenceModel');
const appSettings = require('../services/app-settings');

/**
 * The board shown on a screen outside a Faculty Lounge.
 *
 * A panel in a corridor cannot sign in, so the device is authorised instead of
 * a person: the screen shows a pairing code, an admin approves it and chooses
 * which lounge it belongs to, and only then does it get a board. Until then it
 * shows the code and nothing else.
 *
 * There is no department in the URL. An address like /display/CCS is guessable
 * from anywhere in the world, which is what made the first version of this
 * effectively public; the department now comes from the approval, so there is
 * nothing left to enumerate.
 *
 * What it publishes stays deliberately thin: a name, a position, In or Out,
 * and the availability the instructor set. getFacultyPresence() also returns
 * the detected room and the base office; both are dropped here. Saying which
 * room somebody is sitting in is a different feature from saying whether they
 * are in, and only the second was asked for.
 *
 * The two statuses shown are independent: availability is what the instructor
 * said, presence is what a scanner saw. Neither is inferred from the other.
 */

const COOKIE_NAME = 'facitrack_display';
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/** Small local cookie reader — the app has no cookie-parser mounted. */
function readCookie(req, name) {
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        if (part.slice(0, idx).trim() !== name) continue;
        try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch (_) { return null; }
    }
    return null;
}

function setDeviceCookie(res, secret) {
    res.cookie(COOKIE_NAME, secret, {
        httpOnly: true,        // the board's own script never needs to read it
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: COOKIE_MAX_AGE_MS,
        path: '/display',
    });
}

/** A board is live data about people; it must never sit in a cache. */
function noStore(res) {
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('Pragma', 'no-cache');
}

/**
 * The published shape. Everything not listed here stays on the server.
 *
 * "In" on this screen means at the lounge it hangs outside, not somewhere in
 * the building — a board on the lounge door saying somebody is In while they
 * are teaching two floors up is worse than saying nothing.
 */
function toBoardEntry(row, coverage) {
    const presence = loungePresence(row, { covered: coverage.covered });
    return {
        id: row.id,                              // public_id, not the row id
        name: row.name,
        position: row.position || 'Faculty',
        photo: row.profile_picture || null,
        presence,
        presenceLabel: presenceLabel(presence),
        availability: row.availability_status || null,
        availabilityLabel: availabilityLabel(row.availability_status),
    };
}

/**
 * Work out what this screen is allowed to see.
 *
 * Registers it if this is the first time, refreshes a lapsed pairing code, and
 * records that it is still switched on. Returns the device row plus the secret
 * when one has just been issued.
 */
async function identify(req, res) {
    const secret = readCookie(req, COOKIE_NAME);
    let device = await DisplayDeviceModel.findBySecret(secret);

    if (!device) {
        const fresh = await DisplayDeviceModel.register(req.get('User-Agent'));
        setDeviceCookie(res, fresh.secret);
        device = await DisplayDeviceModel.findBySecret(fresh.secret);
        return device;
    }

    await DisplayDeviceModel.touch(device.id);

    if (device.status === 'pending') {
        const code = await DisplayDeviceModel.refreshCodeIfExpired(device.id);
        if (code) device.pairing_code = code;
    }
    return device;
}

/**
 * The board, plus whether it is entitled to claim anything about presence.
 *
 * A lounge nobody is watching produces "no data" for everyone rather than a
 * screen full of confident Outs, and the panel is told why so it can say so.
 */
async function boardFor(device) {
    if (!device || device.status !== 'approved' || !device.department_id) {
        return { faculty: [], coverage: { covered: false, installed: 0, rooms: [] } };
    }

    const staleAfter = await appSettings.get('presence_scanner_offline_after_sec');
    const [rows, coverage] = await Promise.all([
        UserModel.getFacultyPresence({
            departmentId: device.department_id,
            scannerOfflineAfterSeconds: staleAfter,
        }),
        PresenceModel.loungeCoverage(staleAfter),
    ]);

    return { faculty: rows.map(row => toBoardEntry(row, coverage)), coverage };
}

/** What the screen is told about its own blind spot, in its own words. */
function coverageNotice(coverage) {
    if (coverage.covered) return null;
    if (!coverage.installed) return 'No scanner in the lounge yet — presence cannot be shown.';
    return 'The lounge scanner is not reporting — presence is out of date.';
}

const sseRegistry = require('../realtime/sseRegistry');

const DisplayController = {

    /** The panel's only page: either a pairing code, or the board. */
    async renderBoard(req, res) {
        noStore(res);
        const device = await identify(req, res);
        const board = await boardFor(device);

        res.render('pages/display', {
            title: device.status === 'approved'
                ? `${device.department_short || device.department_full || 'Faculty'} Faculty Lounge`
                : 'Display Setup',
            status: device.status,
            pairingCode: device.status === 'pending' ? device.pairing_code : null,
            label: device.label,
            department: device.status === 'approved' && device.department_id
                ? { short_name: device.department_short, full_name: device.department_full }
                : null,
            faculty: board.faculty,
            coverageNotice: coverageNotice(board.coverage),
            generatedAt: new Date().toISOString(),
        });
    },

    /**
     * What the panel polls.
     *
     * One endpoint answers both questions the screen has — am I approved yet,
     * and who is in — so a panel waiting to be adopted and one already showing
     * a board run exactly the same loop.
     */
    async boardJson(req, res) {
        noStore(res);
        const device = await identify(req, res);
        const board = await boardFor(device);

        res.json({
            success: true,
            status: device.status,
            pairingCode: device.status === 'pending' ? device.pairing_code : null,
            department: device.status === 'approved' && device.department_id
                ? { shortName: device.department_short, fullName: device.department_full }
                : null,
            faculty: board.faculty,
            coverageNotice: coverageNotice(board.coverage),
            generatedAt: new Date().toISOString(),
        });
    },

    /**
     * The board's live connection.
     *
     * Polling every twenty seconds was the whole of this screen's latency, and
     * a wall display is exactly where a stale name is most visible. Registered
     * under a display key rather than a user id: broadcasts reach it, and
     * nothing addressed to a person ever can.
     */
    async events(req, res) {
        const device = await identify(req, res);
        if (!device || device.status !== 'approved') {
            return res.status(403).end();
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write('retry: 5000\n\n');

        const key = 'display:' + device.id;
        sseRegistry.addClient(key, res);

        // Proxies and phones drop an idle stream; this keeps it open without
        // the board having to reconnect and re-render.
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => {
            clearInterval(ping);
            sseRegistry.removeClient(key, res);
        });
    },
};

module.exports = DisplayController;
module.exports.toBoardEntry = toBoardEntry;
module.exports.readCookie = readCookie;
module.exports.COOKIE_NAME = COOKIE_NAME;
