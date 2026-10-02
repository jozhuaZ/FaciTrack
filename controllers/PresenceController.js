const crypto = require('crypto');
const PresenceModel = require('../models/PresenceModel');
const appSettings = require('../services/app-settings');
const tagDiscovery = require('../services/tag-discovery');
const { broadcast } = require('../realtime/sseRegistry');

/**
 * Takes what the room scanners heard and decides who is where.
 *
 * The scanners have no session — they are devices on the campus network — so
 * this endpoint authenticates with a shared secret instead. That secret is the
 * only thing standing between the network and forged presence data, so it is
 * compared in constant time and the endpoint says as little as possible when it
 * fails.
 */

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

/**
 * How long the room currently holding somebody keeps the right to hold them.
 *
 * Scanners report every ten seconds, so a room that still hears a tag renews
 * its claim three times inside this window. Past it the claim is stale — the
 * scanner may have died or the person may have walked out of range — and any
 * room clearing its own threshold can take over on that alone. Without this a
 * dead scanner would pin somebody to its room until the absence sweep ran.
 */
const ROOM_CLAIM_FRESH_SEC = 30;

/**
 * How old a sighting may be and still count as "the scanner can hear this".
 *
 * The firmware keeps a tag in its report for thirty seconds after it last
 * actually heard it, sending the age alongside each reading. Ignoring that age
 * is what used to leave presence half a minute behind the room even while the
 * scanner reported correctly.
 *
 * This is the single biggest lever on how fast somebody shows as gone, because
 * a departure is noticed on the first report where the tag looks stale. It is
 * a setting rather than a constant for that reason — but it is a trade, not a
 * free win: a tag advertising several times a second is heard repeatedly inside
 * every report, so a short window is safe for a healthy tag and produces false
 * departures for a weak one that is only heard now and then. Lower it while
 * signal is good; raise it if people start flickering.
 *
 * A scanner too old to send the field reports 0, which reads as fresh, so old
 * firmware keeps behaving exactly as it did before.
 *
 * See presence_sighting_fresh_sec in services/app-settings.js.
 */

/** Constant-time compare, so a wrong key cannot be found one character at a time. */
function keyMatches(supplied) {
    const expected = process.env.PRESENCE_INGEST_KEY;
    if (!expected || !supplied) return false;

    const a = Buffer.from(String(supplied));
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/**
 * A signal strength in dBm, or null when the value is not one.
 *
 * Number() alone was not enough: it turns null, "", false and [] into 0, and 0
 * is a valid reading — the strongest one there is — so a blank or missing
 * value was taken as somebody standing right beside the scanner and marked
 * them present. Only an actual number, or a string that spells one, counts.
 */
function parseRssi(value) {
    let rssi;
    if (typeof value === 'number') rssi = value;
    else if (typeof value === 'string' && value.trim() !== '') rssi = Number(value);
    else return null;

    if (!Number.isFinite(rssi) || rssi > 0 || rssi < -127) return null;
    return rssi;
}

/** Pull the usable sightings out of whatever the scanner sent. */
function parseBeacons(raw) {
    if (!Array.isArray(raw)) return [];

    const seen = new Set();
    const out = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;

        const mac = String(entry.id || '').trim().toLowerCase();
        if (!MAC_RE.test(mac) || seen.has(mac)) continue;

        const rssi = parseRssi(entry.rssi);
        if (rssi === null) continue;

        const major = Number.isInteger(Number(entry.major)) ? Number(entry.major) : null;
        const minor = Number.isInteger(Number(entry.minor)) ? Number(entry.minor) : null;

        seen.add(mac);
        out.push({ mac, rssi, lastSeenMs: Number(entry.lastSeenMs) || 0, major, minor });
    }
    return out;
}

const PresenceController = {

    /**
     * POST /api/presence/ingest
     * Body: { room, scanner, uptimeSec, beacons: [{ id, rssi, lastSeenMs }] }
     */
    async ingest(req, res) {
        if (!keyMatches(req.get('X-Presence-Key'))) {
            return res.status(401).json({ success: false, error: 'Unauthorized.' });
        }

        const roomNumber = String(req.body?.room || '').trim();
        const scannerId = String(req.body?.scanner || '').trim().slice(0, 60) || null;
        if (!roomNumber) {
            return res.status(400).json({ success: false, error: 'A room is required.' });
        }

        try {
            const room = await PresenceModel.getRoomByNumber(roomNumber);
            if (!room) {
                // Worth being explicit: this is the mistake an installer makes,
                // and it shows up on the scanner's serial monitor.
                return res.status(404).json({
                    success: false,
                    error: `No room named "${roomNumber}". Check ROOM_CODE against Admin → Rooms.`,
                });
            }

            const sightings = parseBeacons(req.body?.beacons);
            const [defaultThreshold, exitMargin, switchMargin, freshSec, absentAfter, logging, scannerStaleAfter] =
                await Promise.all([
                    appSettings.get('presence_rssi_threshold'),
                    appSettings.get('presence_rssi_exit_margin'),
                    appSettings.get('presence_room_switch_margin'),
                    appSettings.get('presence_sighting_fresh_sec'),
                    appSettings.get('presence_absent_after_sec'),
                    appSettings.get('presence_logging_enabled'),
                    appSettings.get('presence_scanner_offline_after_sec'),
                ]);
            const freshSightingMs = freshSec * 1000;

            // A room tuned individually wins over the system-wide default: a
            // large laboratory and a small consultation room do not share a
            // sensible cutoff.
            const threshold = room.rssi_threshold !== null && room.rssi_threshold !== undefined
                ? room.rssi_threshold
                : defaultThreshold;

            // Hysteresis. One hard line makes anybody sitting near it flap: BLE
            // RSSI swings several dB as a person turns around, so a desk that
            // reads within the noise band of the threshold produces a stream of
            // entered/exited pairs from someone who never moved. Crossing in
            // takes the full threshold; staying in only has to clear a weaker
            // line. Two numbers, one decision — and a margin of 0 restores the
            // old single-threshold behaviour exactly.
            const exitThreshold = threshold - exitMargin;

            // Remember the scanner itself, so a room going dark is visible as a
            // stale scanner rather than as tags that mysteriously went quiet.
            const scanner = await PresenceModel.recordScanner(scannerId, room.id, {
                uptimeSec: Number(req.body?.uptimeSec) || null,
                beaconCount: sightings.length,
                ip: req.ip,
                staleAfterSeconds: scannerStaleAfter,
            });

            // Only tags this system already knows are written down, unless an
            // admin has opened a discovery window for this room. Without that
            // gate every passing phone became a permanent row — and most phone
            // addresses rotate, so the table grew forever and held nothing
            // worth having.
            const listening = await tagDiscovery.isOpenFor(room.id);
            const recorded = await PresenceModel.recordSightings(sightings, room.id, {
                acceptUnknown: listening,
            });

            // Every known tag the scanner heard, at any strength. Presence only
            // cares about the strong ones, but signal history has to include the
            // weak: a reading below the threshold is the evidence that the
            // threshold is set too tight, and it cannot be seen if it was never
            // written down.
            const heardBeacons = await PresenceModel.getBeaconsByMac(sightings.map(s => s.mac));
            const rssiByMac = new Map(sightings.map(s => [s.mac, s.rssi]));

            // What the scanner can hear *now*, as opposed to what it remembers
            // hearing. Only these decide whether somebody is in the room.
            const heardNow = new Set(
                sightings.filter(s => s.lastSeenMs <= freshSightingMs).map(s => s.mac)
            );

            try {
                await PresenceModel.recordSamples(
                    heardBeacons.map(b => ({ beaconId: b.id, rssi: rssiByMac.get(b.mac_address) }))
                                .filter(r => Number.isFinite(r.rssi)),
                    room.id, scannerId,
                    // A discovery window means somebody is walking the room with
                    // a tag in their hand, and wants every reading.
                    { throttleSeconds: listening ? 0 : 60 },
                );
            } catch (err) {
                // Never let a history write cost somebody their presence.
                console.error('[Presence] Could not record signal samples:', err.message);
            }

            // Anything currently audible above the weaker of the two lines is a
            // candidate for being in the room. Which line each tag is actually
            // held to depends on where it already is, settled per tag below.
            const beacons = heardBeacons.filter(b =>
                heardNow.has(b.mac_address) && rssiByMac.get(b.mac_address) >= exitThreshold);
            const assigned = beacons.filter(b => b.instructor_id && b.is_active);

            // Who this room is currently credited with holding. Anyone here that
            // the loop below does not re-confirm has left, and this report is
            // the evidence — see the eviction after the loop.
            const holding = await PresenceModel.getPresentInRoom(room.id);

            const current = await PresenceModel.getCurrent(assigned.map(b => b.instructor_id));
            const events = [];
            const confirmedHere = new Set();
            let held = 0;
            let outbid = 0;

            for (const beacon of assigned) {
                const rssi = rssiByMac.get(beacon.mac_address);
                const before = current.get(beacon.instructor_id);
                const wasHere = before && before.is_present && before.room_id === room.id;

                // Already in this room, so the weaker line applies; anywhere
                // else — including in another room — and it is a crossing,
                // which takes the full threshold. Moving between two rooms must
                // not be made easy by hysteresis meant to hold somebody still.
                if (rssi < (wasHere ? exitThreshold : threshold)) continue;

                // Two scanners can hear one tag, and both clearing their own
                // threshold used to mean the last one to POST won — so presence
                // flipped between adjacent rooms every few seconds and the
                // dean's page showed whichever reported most recently rather
                // than the room the person is actually in.
                //
                // The room that hears the tag best owns it. Taking somebody
                // from a room that still hears them takes a clearly stronger
                // reading, not merely a passing one: the margin is what stops
                // two rooms of similar signal trading a person back and forth.
                if (!wasHere && before && before.is_present && before.room_id !== null
                    && before.secs_since_update !== null
                    && before.secs_since_update <= ROOM_CLAIM_FRESH_SEC) {

                    // A row written before last_rssi existed loses to any
                    // reading, so ownership settles on the next report rather
                    // than being frozen by a value that was never recorded.
                    const heldAt = before.last_rssi === null || before.last_rssi === undefined
                        ? -127
                        : before.last_rssi;

                    if (rssi < heldAt + switchMargin) { outbid++; continue; }
                }

                if (wasHere && rssi < threshold) held++;

                await PresenceModel.markPresent(beacon.instructor_id, room.id, rssi);
                confirmedHere.add(beacon.instructor_id);
                if (wasHere) continue;   // still in the same room, nothing to log

                events.push({
                    instructorId: beacon.instructor_id,
                    roomId: room.id,
                    event: before && before.is_present ? 'moved' : 'entered',
                    rssi,
                    scannerId,
                });
            }

            /* ── Leaving, while the scanner is watching ──
               A report from this room says two things, and the system only ever
               listened to one of them. It says who the scanner can hear — and
               it equally says who it cannot. Somebody this room was holding who
               is now absent from the report, too stale to count, or faded below
               the exit threshold has left, and the scanner is right there
               saying so. Waiting out an absence timeout in that case put a
               minute between walking out of a room and the board agreeing.

               This is deliberately narrow: only the room that already holds
               somebody may evict them, and only on a report it actually sent.
               A scanner that is switched off sends nothing, so it evicts
               nobody — that case is still the timeout's, and jobs/presence-sweep
               handles it. */
            const leftRoom = holding
                .filter(h => !confirmedHere.has(h.instructor_id))
                .map(h => h.instructor_id);

            let evicted = [];
            if (leftRoom.length) {
                evicted = await PresenceModel.markAbsent(leftRoom, room.id);
                for (const row of evicted) {
                    events.push({
                        instructorId: row.instructor_id,
                        roomId: row.room_id,
                        event: 'exited',
                        rssi: null,          // they were not heard; that is the point
                        scannerId,
                    });
                }
            }

            // The backstop for tags that went quiet in rooms whose scanner is
            // still reporting. A room whose scanner is silent keeps its people
            // (see jobs/presence-sweep). Anyone evicted above is already absent,
            // so this cannot double-announce.
            const departed = await PresenceModel.expireStale(absentAfter, scannerStaleAfter);
            for (const row of departed) {
                events.push({ instructorId: row.instructor_id, roomId: row.room_id, event: 'exited', scannerId });
            }

            if (logging && events.length) await PresenceModel.log(events);

            // Open dean and admin pages update without a reload. One message
            // carries the whole batch: a room with several people arriving at
            // once should wake every listener a single time, not once each.
            // A scanner coming back after going quiet is news for the health
            // page even when nobody is in the room, and nothing else would
            // ever announce it — going silent produces no report at all.
            if (events.length || scanner.wasStale) {
                try {
                    broadcast('presence:changed', {
                        room: room.room_number,
                        roomId: room.id,
                        scannerId,
                        at: new Date().toISOString(),
                        events: events.map(e => ({ instructorId: e.instructorId, event: e.event })),
                    });
                } catch (err) {
                    console.error('[Presence] Broadcast failed:', err.message);
                }
            }

            res.json({
                success: true,
                room: room.room_number,
                heard: sightings.length,
                // Sightings the scanner is remembering rather than hearing. A
                // number that is persistently high means tags are advertising
                // too slowly to be heard inside a report — or that this window
                // has been tightened past what the signal can sustain.
                stale: sightings.length - heardNow.size,
                freshWindowSec: freshSec,
                inRoom: sightings.filter(s => s.rssi >= threshold && heardNow.has(s.mac)).length,
                recognised: assigned.length,
                unassigned: beacons.filter(b => !b.instructor_id).length,
                events: events.length,
                // Shown on the scanner's serial log, so an installer can see
                // whether discovery is on without opening the admin page.
                listening,
                recorded: recorded.updated,
                discovered: recorded.discovered,
                threshold,
                exitThreshold,
                // How many people stayed counted as present only because of the
                // margin. A number that is persistently high says the threshold
                // is set too tight for where these people actually sit — the
                // margin is propping it up, and it should be tuned instead.
                heldByMargin: held,
                // People this room was holding that it can no longer hear, and
                // marked out on the strength of this report rather than a timeout.
                leftRoom: evicted.length,
                // Tags this room heard well enough to claim but another room
                // hears better. Persistently high on both sides of a wall means
                // the two rooms overlap and one of them needs a tighter
                // threshold, not a bigger switch margin.
                outbidByOtherRoom: outbid,
                // Says which number was applied, so a scanner's serial log
                // shows whether this room is tuned or on the default
                thresholdSource: room.rssi_threshold !== null && room.rssi_threshold !== undefined ? 'room' : 'default',
            });
        } catch (err) {
            console.error('[Presence.ingest]', err);
            res.status(500).json({ success: false, error: 'Could not record presence.' });
        }
    },

    /**
     * POST /api/presence/backfill
     * Body: { room, scanner, buckets: [{ ageSec, durationSec, beacons: [{ id, rssi }] }] }
     *
     * What a scanner heard while it could not reach the server (Wi-Fi down),
     * replayed once it can. Each bucket is one minute or so of listening,
     * aged from the moment it is sent — the scanner has no reliable clock, so
     * times are "this many seconds ago" and placed against the database's.
     *
     * This fills in history — the entered/exited rows the gap would otherwise
     * be missing, which the hours and presence reports are built from. It
     * never sends notifications or live "entered" alerts for things that
     * happened minutes ago. The current state is brought in line with where
     * the replay ends, quietly, so the next live report compares against the
     * right starting point.
     *
     * Someone another room had on record during the gap is left alone: a
     * scanner that was online at the time is the better witness.
     */
    async backfill(req, res) {
        if (!keyMatches(req.get('X-Presence-Key'))) {
            return res.status(401).json({ success: false, error: 'Unauthorized.' });
        }

        const roomNumber = String(req.body?.room || '').trim();
        const scannerId = String(req.body?.scanner || '').trim().slice(0, 60) || null;
        if (!roomNumber) {
            return res.status(400).json({ success: false, error: 'A room is required.' });
        }

        // Oldest first, and only buckets that make sense. Two days is far past
        // what the scanner's buffer holds; anything older is a bug, not data.
        const buckets = (Array.isArray(req.body?.buckets) ? req.body.buckets : [])
            .map(b => ({
                ageSec: Math.round(Number(b?.ageSec)),
                durationSec: Math.round(Number(b?.durationSec)) || 60,
                beacons: parseBeacons(b?.beacons),
            }))
            .filter(b => Number.isFinite(b.ageSec) && b.ageSec >= 0 && b.ageSec <= 172800
                      && b.durationSec > 0 && b.durationSec <= 600)
            .sort((a, b) => b.ageSec - a.ageSec)
            .slice(0, 500);

        if (!buckets.length) return res.json({ success: true, accepted: 0, events: 0 });

        try {
            const room = await PresenceModel.getRoomByNumber(roomNumber);
            if (!room) {
                return res.status(404).json({
                    success: false,
                    error: `No room named "${roomNumber}". Check ROOM_CODE against Admin → Rooms.`,
                });
            }

            const [defaultThreshold, exitMargin, logging] = await Promise.all([
                appSettings.get('presence_rssi_threshold'),
                appSettings.get('presence_rssi_exit_margin'),
                appSettings.get('presence_logging_enabled'),
            ]);
            const threshold = room.rssi_threshold !== null && room.rssi_threshold !== undefined
                ? room.rssi_threshold
                : defaultThreshold;
            const exitThreshold = threshold - exitMargin;

            // Every assigned tag heard in the backlog, plus whoever this room is
            // holding now — somebody never heard during the gap has left too.
            const macs = [...new Set(buckets.flatMap(b => b.beacons.map(s => s.mac)))];
            const tags = (await PresenceModel.getBeaconsByMac(macs))
                .filter(b => b.instructor_id && b.is_active);
            const instructorByMac = new Map(tags.map(t => [t.mac_address, t.instructor_id]));
            const holding = await PresenceModel.getPresentInRoom(room.id);

            const gapAge = buckets[0].ageSec;
            let candidates = [...new Set([...tags.map(t => t.instructor_id), ...holding.map(h => h.instructor_id)])];
            const elsewhere = await PresenceModel.loggedElsewhereSince(candidates, room.id, gapAge);
            candidates = candidates.filter(id => !elsewhere.has(id));

            // Starting point: where the history says each person was just
            // before the first bucket.
            const before = await PresenceModel.lastEventsBefore(candidates, gapAge);
            const state = new Map(candidates.map(id => {
                const last = before.get(id);
                const here = !!last && last.room_id === room.id && (last.event === 'entered' || last.event === 'moved');
                return [id, { here, rssi: null }];
            }));

            // Walk the minutes in order. Same two lines as the live ingest:
            // the full threshold to come in, the weaker one to stay.
            const events = [];
            for (const bucket of buckets) {
                const heard = new Map();
                for (const s of bucket.beacons) {
                    const id = instructorByMac.get(s.mac);
                    if (id && state.has(id)) heard.set(id, Math.max(heard.get(id) ?? -127, s.rssi));
                }
                for (const [id, st] of state) {
                    const rssi = heard.has(id) ? heard.get(id) : null;
                    const inNow = rssi !== null && rssi >= (st.here ? exitThreshold : threshold);
                    if (inNow !== st.here) {
                        events.push({
                            instructorId: id, roomId: room.id,
                            event: inNow ? 'entered' : 'exited',
                            rssi: inNow ? rssi : null,
                            scannerId, ageSec: bucket.ageSec,
                        });
                        st.here = inNow;
                    }
                    if (inNow) st.rssi = rssi;
                }
            }

            // The backlog proves the scanner was listening through the gap even
            // though nothing reached the server, so the gap counts as online
            // for the Class Attendance report rather than as "No signal".
            if (scannerId) {
                try {
                    const oldest = buckets[0];
                    const newest = buckets[buckets.length - 1];
                    const endAge = Math.max(0, newest.ageSec - newest.durationSec);
                    await PresenceModel.recordOfflineRun(scannerId, room.id, oldest.ageSec, endAge);
                } catch (err) {
                    console.error('[Presence.backfill] Could not record the offline run:', err.message);
                }
            }

            // A retried POST must not write the same history twice.
            const fresh = [];
            for (const e of events) {
                if (!(await PresenceModel.hasNearbyEvent(e, 45))) fresh.push(e);
            }
            if (logging && fresh.length) await PresenceModel.log(fresh);

            // Line the current state up with where the replay ended, without
            // announcing it as news. The next live report takes it from there.
            const heldHere = new Set(holding.map(h => h.instructor_id));
            let reconciled = 0;
            for (const [id, st] of state) {
                if (st.here && !heldHere.has(id)) {
                    await PresenceModel.markPresent(id, room.id, st.rssi);
                    reconciled++;
                } else if (!st.here && heldHere.has(id)) {
                    reconciled += (await PresenceModel.markAbsent([id], room.id)).length;
                }
            }

            if (fresh.length || reconciled) {
                try {
                    broadcast('presence:changed', {
                        room: room.room_number, roomId: room.id, scannerId,
                        at: new Date().toISOString(),
                        // Past events: pages refresh, but nothing is announced
                        // as happening now.
                        events: [], backfilled: fresh.length,
                    });
                } catch (err) {
                    console.error('[Presence] Broadcast failed:', err.message);
                }
            }

            console.log(`[Presence.backfill] ${scannerId || room.room_number}: ${buckets.length} bucket(s), `
                + `${fresh.length} event(s) written, ${reconciled} state change(s), ${elsewhere.size} left to another room.`);

            res.json({
                success: true,
                accepted: buckets.length,
                events: fresh.length,
                duplicates: events.length - fresh.length,
                reconciled,
                skippedElsewhere: elsewhere.size,
            });
        } catch (err) {
            console.error('[Presence.backfill]', err);
            res.status(500).json({ success: false, error: 'Could not record the backlog.' });
        }
    },

    /** GET /api/presence/health — lets an installer confirm the URL and key. */
    async health(req, res) {
        if (!keyMatches(req.get('X-Presence-Key'))) {
            return res.status(401).json({ success: false, error: 'Unauthorized.' });
        }
        res.json({ success: true, serverTime: new Date().toISOString() });
    },
};

module.exports = PresenceController;
