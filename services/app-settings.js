/**
 * System-wide settings an administrator can change without a redeploy.
 *
 * Each setting has a definition here — its type, its bounds and the .env key it
 * falls back to. That fallback matters: the values below were environment
 * variables first, so an install that has never opened the settings page keeps
 * behaving exactly as its .env says.
 *
 * Values are cached briefly because they are read on hot paths (every booking
 * checks the lead time). Saving clears the cache, so a change takes effect on
 * the next request rather than the next restart.
 */

const AppSettingModel = require('../models/AppSettingModel');

const DEFINITIONS = {
    booking_lead_time_hours: {
        type: 'int', env: 'BOOKING_LEAD_TIME_HOURS', fallback: 4, min: 0, max: 168,
        label: 'Booking lead time (hours)',
    },
    pending_nudge_every_hours: {
        type: 'int', env: 'PENDING_NUDGE_EVERY_HOURS', fallback: 6, min: 1, max: 168,
        label: 'Remind instructors every (hours)',
    },
    pending_escalate_hours: {
        type: 'int', env: 'PENDING_ESCALATE_HOURS', fallback: 48, min: 1, max: 336,
        label: "Flag unanswered requests as overdue in the dean's report after (hours)",
    },
    makeup_max_weeks_ahead: {
        type: 'int', env: 'MAKEUP_MAX_WEEKS_AHEAD', fallback: 8, min: 1, max: 52,
        label: 'Make-up class booking window (weeks)',
    },
    makeup_day_start: {
        type: 'time', env: 'MAKEUP_DAY_START', fallback: '07:00',
        label: 'Make-up class earliest start',
    },
    makeup_day_end: {
        type: 'time', env: 'MAKEUP_DAY_END', fallback: '21:00',
        label: 'Make-up class latest end',
    },
    email_enabled: {
        type: 'bool', env: 'EMAIL_ENABLED', fallback: false,
        label: 'Email notifications',
    },
    push_enabled: {
        type: 'bool', fallback: true,
        label: 'Push notifications',
    },
    presence_rssi_threshold: {
        type: 'int', fallback: -75, min: -100, max: -30,
        label: 'Presence signal threshold (dBm)',
    },
    presence_rssi_exit_margin: {
        type: 'int', fallback: 8, min: 0, max: 30,
        label: 'Presence exit margin (dB)',
    },
    presence_room_switch_margin: {
        type: 'int', fallback: 6, min: 0, max: 30,
        label: 'Room switch margin (dB)',
    },
    presence_sighting_fresh_sec: {
        // Must sit BELOW the scanner's report interval (10s in the shipped
        // firmware) or a departure is not noticed until the second report,
        // which doubles how long somebody lingers on a board after leaving.
        type: 'int', fallback: 8, min: 3, max: 60,
        label: 'Treat a sighting as current for (seconds)',
    },
    presence_absent_after_sec: {
        type: 'int', fallback: 120, min: 30, max: 3600,
        label: 'Mark absent after (seconds)',
    },
    presence_scanner_offline_after_sec: {
        type: 'int', fallback: 60, min: 30, max: 3600,
        label: 'Call a scanner offline after (seconds)',
    },
    presence_logging_enabled: {
        type: 'bool', fallback: true,
        label: 'Presence history logging',
    },
};

const CACHE_MS = 15000;
let cache = null;
let cachedAt = 0;

/* ── Coercion ── */

function coerce(key, raw) {
    const def = DEFINITIONS[key];
    if (!def) return null;
    if (raw === null || raw === undefined || raw === '') return def.fallback;

    if (def.type === 'int') {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < def.min || n > def.max) return def.fallback;
        return n;
    }
    if (def.type === 'bool') {
        return raw === true || raw === 'true' || raw === '1' || raw === 1;
    }
    if (def.type === 'time') {
        return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw)) ? String(raw) : def.fallback;
    }
    return String(raw);
}

/** Whether a value the admin submitted is acceptable. Returns an error or null. */
function validate(key, raw) {
    const def = DEFINITIONS[key];
    if (!def) return 'Unknown setting.';

    if (def.type === 'int') {
        const n = Number(raw);
        if (!Number.isInteger(n)) return `${def.label} must be a whole number.`;
        if (n < def.min || n > def.max) return `${def.label} must be between ${def.min} and ${def.max}.`;
        return null;
    }
    if (def.type === 'time') {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw))) return `${def.label} must be a time like 07:00.`;
        return null;
    }
    return null;   // booleans coerce rather than fail
}

/* ── Reading ── */

/** Every setting, resolved: stored value, else .env, else the built-in default. */
async function all() {
    if (cache && Date.now() - cachedAt < CACHE_MS) return cache;

    let stored = {};
    try {
        stored = await AppSettingModel.getAll();
    } catch (err) {
        // A settings table that is missing or unreachable must not take booking
        // down with it — fall through to .env.
        console.error('[AppSettings] Falling back to environment:', err.message);
    }

    const resolved = {};
    for (const [key, def] of Object.entries(DEFINITIONS)) {
        const fromDb = stored[key] ? stored[key].value : undefined;
        const fromEnv = def.env ? process.env[def.env] : undefined;
        resolved[key] = coerce(key, fromDb !== undefined ? fromDb : fromEnv);
    }

    cache = resolved;
    cachedAt = Date.now();
    return resolved;
}

async function get(key) {
    const settings = await all();
    return settings[key];
}

/* ── Writing ── */

/**
 * @param {object} values  key → raw value, unknown keys ignored
 * @returns {Promise<{ok: boolean, errors: string[]}>}
 */
async function save(values, adminInternalId = null) {
    const errors = [];
    const accepted = {};

    for (const [key, raw] of Object.entries(values || {})) {
        if (!DEFINITIONS[key]) continue;
        const problem = validate(key, raw);
        if (problem) { errors.push(problem); continue; }
        accepted[key] = DEFINITIONS[key].type === 'bool' ? (coerce(key, raw) ? '1' : '0') : String(raw);
    }

    // Make-up class hours have to describe a real window
    const start = accepted.makeup_day_start;
    const end = accepted.makeup_day_end;
    if (start && end && start >= end) {
        errors.push('Make-up class earliest start must be before the latest end.');
    }

    if (errors.length) return { ok: false, errors };

    for (const [key, value] of Object.entries(accepted)) {
        await AppSettingModel.set(key, value, adminInternalId);
    }
    invalidate();
    return { ok: true, errors: [] };
}

function invalidate() { cache = null; cachedAt = 0; }

module.exports = { all, get, save, invalidate, DEFINITIONS };
