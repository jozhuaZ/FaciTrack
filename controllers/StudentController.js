const DepartmentModel = require('../models/DepartmentModel');
const UserModel = require('../models/UserModel');
const AppointmentModel = require('../models/AppointmentModel');
const ConsultationModel = require('../models/ConsultationModel');
const SlotReservation = require('../models/SlotReservationModel');
const AuditLogModel = require('../models/AuditLogModel');
const StudentSettingsModel = require('../models/StudentSettingsModel');
const { buildStudentUser } = require('../utils/sessionUser');
const { to12Hour } = require('../utils/timeFormat');
const { isWithinLeadTime, bookingLeadTimeHours } = require('../services/scheduling');

/**
 * A non-available availability_status is a "right now" signal, so it only bars
 * slots on TODAY. Planned multi-day absence lives in instructor_unavailability.
 */
function statusBlocksSlot(availabilityStatus, slotDate) {
    if (!availabilityStatus || availabilityStatus === 'available') return false;
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    return String(slotDate).slice(0, 10) === todayKey;
}

function getTwoWeekWindow() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayOfWeek = today.getDay();
    const windowStart = new Date(today);
    windowStart.setDate(today.getDate() - dayOfWeek);
    const windowEnd = new Date(windowStart);
    windowEnd.setDate(windowStart.getDate() + 13);
    return { windowStart, windowEnd };
}

/**
 * Why a slot cannot be booked, or null when it can.
 *
 * Ordered most-specific first: a day the instructor blocked off explains more
 * than "too soon", and the student only ever sees one reason per slot.
 */
function slotReason(sub, { isReservedByOther, roomAvailable, canDoOnline }) {
    if (sub.dateBlocked) return 'Instructor away';
    if (sub.statusBlocked) return 'Instructor unavailable today';
    if (sub.isBooked) return 'Already booked';
    if (isReservedByOther) return 'Being booked';
    if (sub.calendarBlocked) return 'Instructor busy';
    if (sub.tooSoon) return 'Too soon to book';
    if (!roomAvailable && !canDoOnline) return 'No room or link';
    return null;
}

function findNextAvailable(consultationSlots) {
    const now = new Date();
    const todayKey = now.toISOString().split('T')[0];
    const nowMins = now.getHours() * 60 + now.getMinutes();

    const openSlots = [];
    consultationSlots.forEach(group => {
        group.subSlots.forEach(sub => {
            // One rule, already decided by slotReason(): if the calendar marks
            // the slot closed, "next available" must not advertise it. This
            // previously only looked at booked/reserved, so a day the
            // instructor had blocked still showed up as the next opening.
            if (sub.unavailableReason) return;
            if (sub.isBooked || sub.isReservedByOther) return;
            openSlots.push({
                date: group.date,
                day: group.day,
                timeStart: sub.timeStart,
                timeStartMins: parseTimeToMins(sub.timeStart), // "8:00 AM" -> 480
            });
        });
    });

    openSlots.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return a.timeStartMins - b.timeStartMins;
    });

    // Skip slots earlier today that have already passed
    const next = openSlots.find(s => {
        if (s.date > todayKey) return true;
        if (s.date === todayKey) return s.timeStartMins > nowMins;
        return false;
    });

    if (!next) return null;

    const [year, month, day] = next.date.split('-').map(Number);
    const label = `${next.day}, ${MONTHS[month - 1]} ${day} — ${next.timeStart}`;
    return label;
}

function parseTimeToMins(str) {
    const [time, period] = str.trim().split(' ');
    let [h, m] = time.split(':').map(Number);
    if (period === 'PM' && h !== 12) h += 12;
    if (period === 'AM' && h === 12) h = 0;
    return h * 60 + m;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Bookings that have not happened yet and still could
const LIVE_STATUSES = ['pending', 'confirmed'];

// users.availability_status → what a student should read
// Shared with the dean's reports and the lounge board — see utils/availability.js.
const { AVAILABILITY_LABELS, loungePresence } = require('../utils/availability');
const PresenceModel = require('../models/PresenceModel');
const appSettings = require('../services/app-settings');

function dayKey(value) {
    return String(value).slice(0, 10);
}

/**
 * Collapse a student's bookings into one summary per instructor.
 *
 * Ordering puts whoever needs attention first: instructors with something
 * still pending, then anyone with an upcoming consultation, then the rest by
 * how recently the student saw them. That way the top of the grid is always
 * the part worth looking at.
 */
function groupByInstructor(appointments) {
    const today = dayKey(new Date().toISOString());
    const byInstructor = new Map();

    appointments.forEach(apt => {
        if (!byInstructor.has(apt.instructorId)) {
            byInstructor.set(apt.instructorId, {
                instructorId: apt.instructorId,
                facultyName: apt.facultyName,
                facultyDisplayName: apt.facultyDisplayName,
                facultyPhoto: apt.facultyPhoto,
                position: apt.position,
                departmentName: apt.departmentName,
                total: 0,
                pending: 0,
                upcoming: 0,
                completed: 0,
                nextDate: null,
                nextSlot: null,
                lastDate: null,
            });
        }

        const row = byInstructor.get(apt.instructorId);
        const date = dayKey(apt.date);
        row.total += 1;

        if (apt.status === 'pending') row.pending += 1;
        if (apt.status === 'completed') row.completed += 1;

        if (LIVE_STATUSES.includes(apt.status) && date >= today) {
            row.upcoming += 1;
            // Earliest still-to-come booking is the one worth surfacing
            if (!row.nextDate || date < row.nextDate) {
                row.nextDate = date;
                row.nextSlot = apt.slot;
            }
        }
        if (!row.lastDate || date > row.lastDate) row.lastDate = date;
    });

    return [...byInstructor.values()].sort((a, b) => {
        if ((b.pending > 0) - (a.pending > 0)) return (b.pending > 0) - (a.pending > 0);
        if ((b.upcoming > 0) - (a.upcoming > 0)) return (b.upcoming > 0) - (a.upcoming > 0);
        if (a.nextDate && b.nextDate && a.nextDate !== b.nextDate) return a.nextDate < b.nextDate ? -1 : 1;
        return (b.lastDate || '').localeCompare(a.lastDate || '');
    });
}

/**
 * How long ago the lounge page says someone was last seen: "Just now",
 * "30 minutes ago", "2 hours ago", "3 days ago"; past a week, the date.
 */
function lastSeenAgo(value) {
    const then = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(then.getTime())) return null;
    const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
    const mins = Math.floor((Date.now() - then.getTime()) / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return plural(mins, 'minute');
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return plural(hrs, 'hour');
    const days = Math.floor(hrs / 24);
    if (days < 7) return plural(days, 'day');
    return 'Last seen ' + then.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
}

const StudentController = {

    async renderDashboardPage(req, res) {
        try {
            const studentId = req.session.userId;
            const user = await UserModel.getUserByPublicId(studentId);
            const student = buildStudentUser(req.session);

            const [departments, faculties, appointmentCount] = await Promise.all([
                DepartmentModel.getDepartments(),
                UserModel.getFacultiesConsultation(),
                AppointmentModel.getStudentCount(user.internal_id),
            ]);

            const { windowStart, windowEnd } = getTwoWeekWindow();
            const toKey = d => d.toISOString().split('T')[0];
            const startKey = toKey(windowStart);
            const endKey = toKey(windowEnd);

            const formattedFaculties = await Promise.all(faculties.map(async f => {
                // The same query the profile page uses, so the directory's
                // "next available" cannot advertise a slot the profile then
                // shows as closed. The previous query knew nothing about
                // blocked dates, calendar events or lead time.
                const grouped = await ConsultationModel.getSlotsForStudentView(f.instructor_id);
                const canDoOnline = !!(f.default_meeting_link || f.google_connected);

            const consultationSlots = grouped
                    .filter(g => g.date >= startKey && g.date <= endKey)
                    .map(g => ({
                        day: g.day,
                        date: g.date,
                        subSlots: g.subSlots.map(sub => {
                            const roomAvailable = sub.roomAvailable !== false;
                            return {
                                id: sub.id,
                                timeStart: sub.timeStart,
                                timeEnd: sub.timeEnd,
                                isBooked: sub.isBooked,
                                // A directory preview has no per-student
                                // reservation state; a held slot still shows as
                                // the next opening until the hold is booked.
                                isReservedByOther: false,
                                unavailableReason: slotReason(sub, {
                                    isReservedByOther: false, roomAvailable, canDoOnline,
                                }),
                            };
                        }),
                    }));

                const nextAvailable = findNextAvailable(consultationSlots) || 'No upcoming slots';

                // Same "building, room" wording the lounge page used for it.
                const officeRoom = f.office_room_number
                    ? [f.office_building, f.office_room_number].filter(Boolean).join(', ')
                    : null;

                return { ...f, nextAvailable, officeRoom };
            }));

            // Settings > "Start in my department" chooses the opening filter
            // only; the directory still lists everyone and every department
            // stays selectable.
            const prefs = await StudentSettingsModel.getByPublicId(studentId);
            const defaultDeptId = prefs.directoryOwnDept && user?.department_id
                ? user.department_id
                : null;

            res.render('pages/student/dashboard', {
                title: 'FaciTrack - Faculty Directory',
                student: student,
                appointmentCount: appointmentCount,
                departments: departments,
                facultyList: formattedFaculties,
                defaultDeptId,
            });
        } catch (err) {
            console.error('[StudentController.renderDashboardPage]', err);
            // Rendered by the error page rather than written as bare text.
            throw err;
        }
    },

    async renderFacultyConsultationPage(req, res) {
        const student = buildStudentUser(req.session);

        try {
            const facultyPublicId = req.params.id;
            const studentId = req.session.userId;
            const user = await UserModel.getUserByPublicId(studentId);

            const faculty = await UserModel.getUserByPublicId(facultyPublicId);
            if (!faculty) return res.redirect('/student/dashboard');

            const { windowStart, windowEnd } = getTwoWeekWindow();
            // Every published slot, not just the bookable ones — the profile
            // explains why a slot is closed instead of leaving a gap
            const grouped = await ConsultationModel.getSlotsForStudentView(facultyPublicId);
            const activeReservations = await SlotReservation.getActiveReservationsForInstructor(facultyPublicId);
            const unavailability = await ConsultationModel.getUnavailability(facultyPublicId);

            const toKey = d => d.toISOString().split('T')[0];
            const startKey = toKey(windowStart);
            const endKey = toKey(windowEnd);

            const reservedByOther = new Set(
                activeReservations.filter(r => r.student_id !== studentId).map(r => r.slot_id)
            );

            // Online is offerable once the instructor has somewhere to host it:
            // a connected Google Calendar, or a saved personal room link.
            const canDoOnline = !!(faculty.default_meeting_link || faculty.google_connected);

            const consultationSlots = grouped
                .filter(g => g.date >= startKey && g.date <= endKey)
                .map(g => ({
                    day: g.day,
                    date: g.date,
                    subSlots: g.subSlots.map(sub => {
                        const isReservedByOther = reservedByOther.has(sub.id);
                        // A slot is only truly bookable if at least one mode works
                        const roomAvailable = sub.roomAvailable !== false;
                        return {
                            id: sub.id,
                            timeStart: sub.timeStart,
                            timeEnd: sub.timeEnd,
                            isBooked: sub.isBooked,
                            isReservedByOther,
                            status: sub.status,
                            roomAvailable,
                            onlineAvailable: canDoOnline,
                            // One reason per slot, so the page never has to
                            // guess why something is closed
                            unavailableReason: slotReason(sub, {
                                isReservedByOther, roomAvailable, canDoOnline,
                            }),
                        };
                    }),
                }));

            faculty.nextAvailable = findNextAvailable(consultationSlots);

            const appointmentCount = await AppointmentModel.getStudentCount(user.internal_id);

            res.render('pages/student/profile', {
                title: `FaciTrack - ${faculty.first_name} ${faculty.last_name}`,
                student: student,
                appointmentCount,
                faculty,
                consultationSlots,
                unavailableDates: unavailability.map(u => u.date),
                windowStart: windowStart.toISOString(),
                windowEnd: windowEnd.toISOString(),
                leadTimeHours: await bookingLeadTimeHours(),
                canDoOnline,
            });
        } catch (err) {
            console.error('[StudentController.renderFacultyConsultationPage]', err);
            // Rendered by the error page rather than written as bare text.
            throw err;
        }
    },

    async renderFacultyFormConsultationPage(req, res) {
        const student = buildStudentUser(req.session);
        try {
            const slotId = parseInt(req.params.slotId, 10);
            const studentPublicId = req.session.userId;
            const user = await UserModel.getUserByPublicId(studentPublicId);

            const slotDetails = await ConsultationModel.getSlotWithFaculty(slotId);
            if (!slotDetails) {
                return res.redirect('/student/dashboard?bookingError=slotTaken');
            }

            if (!slotDetails) {
                return res.redirect(`/student/faculty/${slotDetails.faculty.id}?bookingError=slotNotFound`);
            }

            // No room free and no meeting link — there is no way to hold this consultation
            if (!slotDetails.roomAvailable && !slotDetails.faculty.online_ready) {
                return res.redirect(`/student/faculty/${slotDetails.faculty.id}?bookingError=noModeAvailable`);
            }

            if (statusBlocksSlot(slotDetails.faculty.availability_status, slotDetails.date)) {
                return res.redirect(`/student/faculty/${slotDetails.faculty.id}?bookingError=instructorUnavailable`);
            }

            if (isWithinLeadTime(slotDetails.date, slotDetails.rawStartTime, new Date(), await bookingLeadTimeHours())) {
                return res.redirect(`/student/faculty/${slotDetails.faculty.id}?bookingError=tooSoon`);
            }

            if (slotDetails.isBooked) {
                return res.redirect(`/student/faculty/${slotDetails.faculty.id}?bookingError=slotTaken`);
            }

            if (slotDetails.isUnavailable) {
                return res.redirect(`/student/faculty/${slotDetails.faculty.id}?bookingError=dateUnavailable`);
            }

            const result = await SlotReservation.reserveSlot(slotId, studentPublicId);
            if (!result.success) {
                return res.redirect(`/student/faculty/${slotDetails.faculty.id}?reserveFailed=1`);
            }

            const appointmentCount = await AppointmentModel.getStudentCount(user.internal_id);

            res.render('pages/student/book', {
                // Disable modes the instructor cannot actually honour
                roomAvailable: slotDetails.roomAvailable,
                canDoOnline: !!slotDetails.faculty.online_ready,
                title: 'FaciTrack - Book Appointment',
                student,
                faculty: slotDetails.faculty,
                slot: {
                    id: slotDetails.id,
                    day: slotDetails.day,
                    dateFormatted: slotDetails.date,
                    date: slotDetails.date,
                    timeStart: slotDetails.timeStart,
                    timeEnd: slotDetails.timeEnd
                },
                expiresAt: result.expiresAt.toISOString(),
                appointmentCount,
            });
        } catch (err) {
            console.error('[StudentController.renderFacultyFormConsultationPage]', err);
            // Rendered by the error page rather than written as bare text.
            throw err;
        }
    },

    /**
     * The student's own bookings, grouped one card per instructor.
     *
     * A flat list grows unreadable after a term or two, so the index shows who
     * the student has consulted and the detail page shows that instructor's
     * bookings. Both pages read the same rows through this one mapper, so a
     * field added here appears in both.
     */
    async loadStudentAppointments(studentPublicId) {
        const user = await UserModel.getUserByPublicId(studentPublicId);
        const rawAppointments = await AppointmentModel.getAppointmentsByUser(user.internal_id);

        return rawAppointments.map(row => ({
            id: row.id,
            status: row.status,
            instructorId: row.instructor_public_id,
            facultyName: `${row.last_name}, ${row.first_name}${row.middle_name ? ' ' + row.middle_name : ''}`,
            facultyDisplayName: `${row.first_name} ${row.last_name}`,
            facultyPhoto: row.instructor_photo || null,
            position: row.position,
            topic: row.topic,
            mode: row.mode,
            meetingLink: row.meeting_link || null,
            declineReason: row.decline_reason,
            departmentName: row.department_name,
            date: row.consultation_date,
            rawDate: row.consultation_date,
            dayOfWeek: row.day_of_the_week,
            slot: `${to12Hour(row.start_time)} – ${to12Hour(row.end_time)}`,
            roomNumber: row.room_number,
            buildingName: row.building_name,
            notes: row.notes,
            sectionGroupName: row.section_group_name,
            courseSubject: row.course_subject,
            rescheduledToId: row.rescheduled_to_id,
            rescheduledInfo: row.rescheduled_to_id ? {
                date: row.rescheduled_date,
                dayOfWeek: row.rescheduled_day,
                slot: `${to12Hour(row.rescheduled_start_time)} – ${to12Hour(row.rescheduled_end_time)}`,
            } : null,
            rescheduledFromId: row.rescheduled_from_id,
            rescheduledFromInfo: row.rescheduled_from_id ? {
                date: row.rescheduled_from_date,
                dayOfWeek: row.rescheduled_from_day,
                slot: `${to12Hour(row.rescheduled_from_start_time)} – ${to12Hour(row.rescheduled_from_end_time)}`,
            } : null,
        }));
    },

    /**
     * The Faculty Lounge board students see.
     *
     * Two independent signals sit on each card: what the instructor set
     * themselves (real today) and what BLE reports (empty until the scanners
     * ship). They are shown separately rather than merged, so the board never
     * claims someone is out of their room when nothing has actually looked.
     */
    async renderAvailabilityPage(req, res) {
        try {
            // The page reports who is in or out of a department's Faculty
            // Lounge, so it has nothing to say until the student has a
            // department. Render the page and explain, rather than redirecting
            // — a saved link should tell you why it is empty, not bounce you.
            const me = await UserModel.getUserByPublicId(req.session.userId);
            if (!me?.department_id) {
                return res.render('pages/student/availability', {
                    title: 'FaciTrack - Faculty Lounge',
                    student: buildStudentUser(req.session),
                    faculty: [],
                    departments: [],
                    presenceUnavailable: true,
                    departmentMissing: true,
                    loungeCovered: false,
                    loungeNotice: null,
                });
            }

            // This page answers one question — is this instructor at the
            // Faculty Lounge — so it needs to know whether anything is
            // watching the lounge before it is entitled to answer at all.
            const staleAfter = await appSettings.get('presence_scanner_offline_after_sec');
            const [rows, coverage] = await Promise.all([
                UserModel.getFacultyPresence(),
                PresenceModel.loungeCoverage(staleAfter),
            ]);

            const faculty = rows.map(row => {
                return {
                    id: row.id,
                    name: row.name,
                    position: row.position || 'Faculty',
                    photo: row.profile_picture || null,
                    department: row.department_name || '',
                    departmentShort: row.department_short || '',
                    availability: row.availability_status || null,
                    availabilityLabel: AVAILABILITY_LABELS[row.availability_status] || 'Not set',
                    officeRoom: row.office_room_number
                        ? [row.office_building, row.office_room_number].filter(Boolean).join(', ')
                        : null,
                    // Scoped to the lounge, not the building: somebody detected
                    // in a laboratory is confidently not at the lounge, and
                    // 'unknown' still means nothing has reported on them at all.
                    bleStatus: loungePresence(row, { covered: coverage.covered }),
                    detectedRoom: row.detected_room_number || null,
                    detectedRoomType: row.detected_room_type || null,
                    // For the muted line under the status: how long since the
                    // scanners last saw someone who is now out.
                    lastSeen: row.presence_updated_at ? lastSeenAgo(row.presence_updated_at) : null,
                };
            });

            // Whoever is at the lounge first, then everyone alphabetically by the
            // name the card shows.
            faculty.sort((a, b) =>
                (b.bleStatus === 'in-room') - (a.bleStatus === 'in-room')
                || a.name.localeCompare(b.name));

            const departments = [...new Set(faculty.map(f => f.department).filter(Boolean))].sort();

            res.render('pages/student/availability', {
                title: 'FaciTrack - Faculty Lounge',
                loungeCovered: coverage.covered,
                loungeNotice: coverage.covered
                    ? null
                    : (coverage.installed
                        ? 'The Faculty Lounge scanner is not reporting, so lounge presence is out of date.'
                        : 'No scanner is installed in the Faculty Lounge yet, so nobody can be shown as in or out of it. The status on each card is what the instructor set themselves, and it is live.'),
                student: buildStudentUser(req.session),
                faculty,
                departments,
                // Drives both the LIVE pill and the explanatory banner
                presenceUnavailable: faculty.every(f => f.bleStatus === 'unknown'),
                departmentMissing: false,
            });
        } catch (err) {
            console.error('[StudentController.renderAvailabilityPage]', err);
            // Rendered by the error page rather than written as bare text.
            throw err;
        }
    },

    async renderAppointmentsPage(req, res) {
        const student = buildStudentUser(req.session);

        try {
            const appointments = await StudentController.loadStudentAppointments(req.session.userId);

            // Notification links still point at this page with ?openApt=<id>,
            // and those URLs are already out in sent emails. Resolve the
            // booking to its instructor and forward, so old links keep landing
            // on the right screen rather than on a grid that cannot show them.
            const openApt = req.query.openApt;
            if (openApt) {
                const target = appointments.find(a => String(a.id) === String(openApt));
                if (target) {
                    return res.redirect(
                        `/student/appointments/${encodeURIComponent(target.instructorId)}` +
                        `?openApt=${encodeURIComponent(openApt)}`
                    );
                }
            }

            res.render('pages/student/appointments', {
                title: 'FaciTrack - My Appointments',
                student,
                appointments,
                instructors: groupByInstructor(appointments),
            });
        } catch (err) {
            console.error('[StudentController.renderAppointmentsPage]', err);
            // Rendered by the error page rather than written as bare text.
            throw err;
        }
    },

    /** Every booking the student has made with one instructor. */
    async renderInstructorHistoryPage(req, res) {
        const student = buildStudentUser(req.session);

        try {
            const appointments = await StudentController.loadStudentAppointments(req.session.userId);
            const mine = appointments.filter(a => a.instructorId === req.params.instructorId);

            // Nothing with this instructor is not an error, but there is also
            // nothing to show — send them back rather than to an empty shell.
            if (!mine.length) return res.redirect('/student/appointments');

            const [summary] = groupByInstructor(mine);

            res.render('pages/student/appointment-history', {
                title: `FaciTrack - ${summary.facultyDisplayName}`,
                student,
                instructor: summary,
                appointments: mine,
                openApt: req.query.openApt || null,
            });
        } catch (err) {
            console.error('[StudentController.renderInstructorHistoryPage]', err);
            // Rendered by the error page rather than written as bare text.
            throw err;
        }
    },

    async createSlotReservation(req, res) {
        try {
            const slotId = parseInt(req.params.slotId, 10);

            // Do not let a student hold a slot they can no longer book
            const slot = await ConsultationModel.getSlotWithFaculty(slotId);
            if (slot && statusBlocksSlot(slot.faculty.availability_status, slot.date)) {
                return res.status(409).json({
                    success: false,
                    reason: 'INSTRUCTOR_UNAVAILABLE',
                    error: 'The instructor is unavailable right now. Please pick a later date.',
                });
            }

            // A calendar sync may have landed while the student sat on the page
            if (await ConsultationModel.isBlockedByCalendar(slotId)) {
                return res.status(409).json({
                    success: false,
                    reason: 'INSTRUCTOR_UNAVAILABLE',
                    error: 'The instructor has since blocked that time. Please pick another slot.',
                });
            }

            if (slot && isWithinLeadTime(slot.date, slot.rawStartTime, new Date(), await bookingLeadTimeHours())) {
                return res.status(409).json({
                    success: false,
                    reason: 'TOO_SOON',
                    error: `Slots starting within ${await bookingLeadTimeHours()} hours can no longer be booked.`,
                });
            }

            const result = await SlotReservation.reserveSlot(
                parseInt(req.params.slotId, 10),
                req.session.userId
            );
            if (!result.success) return res.status(409).json({ success: false, error: result.reason });
            res.json({ success: true, expiresAt: result.expiresAt });
        } catch (err) {
            res.status(500).json({ success: false, error: 'Failed to reserve slot.' });
        }
    },

    async extendSlotReservation(req, res) {
        try {
            const result = await SlotReservation.extendReservation(
                parseInt(req.params.slotId, 10),
                req.session.userId
            );
            if (!result.success) return res.status(410).json({ success: false, error: 'Reservation expired.' });
            res.json({ success: true, expiresAt: result.expiresAt.toISOString() });
        } catch (err) {
            res.status(500).json({ success: false, error: 'Failed to extend reservation.' });
        }
    },

    async deleteSlotReservation(req, res) {
        try {
            await SlotReservation.releaseSlot(parseInt(req.params.slotId, 10), req.session.userId);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ success: false, error: 'Failed to release reservation.' });
        }
    },

    async submitBooking(req, res) {
        const student = buildStudentUser(req.session);

        try {
            const slotId = parseInt(req.params.slotId, 10);
            const studentPublicId = req.session.userId;

            const {
                studentNumber, sectionGroup, courseSubject, studentEmail,
                consultTopic, consultType, consultNotes,
            } = req.body;

            const slotDetails = await ConsultationModel.getSlotWithFaculty(slotId);
            if (!slotDetails) {
                return res.redirect('/student/dashboard?bookingError=slotNotFound');
            }

            // The slot list already filters these out, but a stale page or a direct
            // POST could still target a slot that is now inside the lead-time window.
            if (isWithinLeadTime(slotDetails.date, slotDetails.rawStartTime, new Date(), await bookingLeadTimeHours())) {
                return res.redirect(`/student/faculty/${slotDetails.faculty.id}?bookingError=tooSoon`);
            }

            if (statusBlocksSlot(slotDetails.faculty.availability_status, slotDetails.date)) {
                return res.redirect(`/student/faculty/${slotDetails.faculty.id}?bookingError=instructorUnavailable`);
            }

            // The submit path never checked this, so a calendar event could be
            // booked straight over — by a stale page, or by a sync or an event
            // that landed while the student filled in the form.
            if (await ConsultationModel.isBlockedByCalendar(slotId)) {
                return res.redirect(`/student/faculty/${slotDetails.faculty.id}?bookingError=instructorBusy`);
            }

            // The form disables this, but a stale page could still submit it
            if (consultType === 'Online' && !slotDetails.faculty.online_ready) {
                return res.redirect(`/student/faculty/${slotDetails.faculty.id}?bookingError=noMeetingLink`);
            }

            const result = await AppointmentModel.createAppointment({
                consultationHourId: slotId,
                studentPublicId,
                instructorId: slotDetails.instructorId,
                sectionGroupName: sectionGroup,
                studentNumber: studentNumber,
                courseSubject,
                email: studentEmail,
                topic: consultTopic,
                mode: consultType,
                notes: consultNotes,
                departmentId: slotDetails.departmentId,
                consultationDate: slotDetails.date,
                timeStart: slotDetails.rawStartTime,
                timeEnd: slotDetails.rawEndTime,
            });

            if (!result.success) {
                const errorMap = {
                    SLOT_ALREADY_BOOKED: 'slotTaken',
                    NO_ROOM_AVAILABLE: 'noRoomAvailable',
                };
                return res.redirect(
                    `/student/faculty/${slotDetails.faculty.id}?bookingError=${errorMap[result.reason] || 'unknown'}`
                );
            }

            try {
                await ConsultationModel.updateStatusById(slotId, 'Booked');
            } catch (error) {
                console.error('Error cancelling slot:', error);
                res.redirect('back');
            }

            try {
                const student = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(student.internal_id, student.role, 'Booked appointment', 'appointment');
            } catch (err) {
                console.error('[AuditLog] Failed to log appointment:', err);
            }

            return res.render('pages/student/booking-confirm', {
                title: 'FaciTrack - Booking Confirmed',
                student: student,
                status: 'success',
                appointment: await AppointmentModel.getAppointmentDetails(result.appointmentId),
            });
        } catch (err) {
            console.error('[StudentController.submitBooking]', err);
            return res.render('pages/student/booking-confirm', {
                title: 'FaciTrack - Booking Failed',
                student,
                status: 'error',
                message: 'Something went wrong while processing your booking. Please try again.',
            });
        }
    },

    async cancelAppointment(req, res) {
        try {
            const appointmentId = parseInt(req.params.appointmentId, 10);
            const studentPublicId = req.session.userId;

            const result = await AppointmentModel.cancelAppointment(appointmentId, studentPublicId);

            if (!result.success) {
                const status = result.reason === 'STUDENT_NOT_FOUND' ? 403 : 404;
                const message = result.reason === 'STUDENT_NOT_FOUND'
                    ? 'Not authorized.'
                    : 'Appointment not found or already resolved.';
                return res.status(status).json({ success: false, error: message });
            }

            const slotId = await AppointmentModel.getConsultationHourId(appointmentId);

            try {
                // Cancelling frees the slot — it must go back to Available,
                // otherwise it stays 'Booked' and nobody else can take it.
                await ConsultationModel.updateStatusById(slotId, 'Available');
            } catch (error) {
                console.error('Error releasing slot:', error);
            }

            try {
                const student = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(student.internal_id, student.role, 'Cancelled appointment', 'appointment');
            } catch (err) {
                console.error('[AuditLog] Failed to log appointment:', err);
            }

            res.json({ success: true });
        } catch (err) {
            console.error('[StudentController.cancelAppointment]', err);
            res.status(500).json({ success: false, error: 'Failed to cancel appointment.' });
        }
    },

    async updateStatus(req, res) {
        try {
            const { slotId } = req.params;
            const { facultyId } = req.body;

            await ConsultationModel.updateStatusById(slotId, 'Available');

            try {
                const student = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(student.internal_id, student.role, 'Released consultation slot', 'consultation slot');
            } catch (err) {
                console.error('[AuditLog] Failed to log slot release:', err);
            }

            res.redirect('/student/faculty/' + facultyId);
        } catch (error) {
            console.error('Error cancelling slot:', error);
            res.redirect('back');
        }
    },

    /* ── Settings ─────────────────────────────────────────────────────────── */

    async renderSettingsPage(req, res) {
        try {
            const studentId = req.session.userId;
            const user = await UserModel.getUserByPublicId(studentId);
            const [departments, settings, appointmentCount] = await Promise.all([
                DepartmentModel.getDepartments(),
                StudentSettingsModel.getByPublicId(studentId),
                AppointmentModel.getStudentCount(user?.internal_id),
            ]);

            res.render('pages/student/settings', {
                title: 'FaciTrack - Settings',
                student: buildStudentUser(req.session),
                appointmentCount,
                departments,
                settings,
                departmentId: user?.department_id ?? null,
            });
        } catch (err) {
            console.error('[StudentController.renderSettingsPage]', err);
            // Rendered by the error page rather than written as bare text.
            throw err;
        }
    },

    /**
     * Save department and directory preference together — the page presents
     * them as one form, and the toggle is meaningless without the department.
     */
    async updateSettings(req, res) {
        try {
            const studentId = req.session.userId;
            const { departmentId, directoryOwnDept } = req.body;

            let deptId = null;
            if (departmentId !== undefined && departmentId !== null && departmentId !== '') {
                deptId = Number(departmentId);
                if (!Number.isInteger(deptId)) {
                    return res.status(422).json({ success: false, error: 'Pick a department from the list.' });
                }
                const departments = await DepartmentModel.getDepartments();
                if (!departments.some(d => Number(d.id) === deptId)) {
                    return res.status(422).json({ success: false, error: 'That department no longer exists.' });
                }
            }

            // Turning the toggle on without a department would silently do
            // nothing on the directory, so say so rather than saving a no-op.
            if (directoryOwnDept && deptId === null) {
                return res.status(422).json({
                    success: false,
                    error: 'Choose your department first — there is nothing to start the directory on.',
                });
            }

            await StudentSettingsModel.setDepartment(studentId, deptId);
            const saved = await StudentSettingsModel.save(studentId, {
                directoryOwnDept: Boolean(directoryOwnDept),
            });
            if (!saved) return res.status(404).json({ success: false, error: 'Account not found.' });

            // The sidebar and other pages read the department from the session.
            req.session.departmentId = deptId;

            res.json({ success: true });
        } catch (err) {
            console.error('[StudentController.updateSettings]', err);
            res.status(500).json({ success: false, error: 'Could not save your settings.' });
        }
    },
};

module.exports = StudentController;