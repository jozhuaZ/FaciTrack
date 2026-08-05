const DepartmentModel = require('../models/DepartmentModel');
const UserModel = require('../models/UserModel');
const AppointmentModel = require('../models/AppointmentModel');
const ConsultationModel = require('../models/ConsultationModel');
const SlotReservation = require('../models/SlotReservationModel');
const { buildStudentUser } = require('../utils/sessionUser');
const { to12Hour } = require('../utils/timeFormat');

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

function findNextAvailable(consultationSlots) {
    const now = new Date();
    const todayKey = now.toISOString().split('T')[0];
    const nowMins = now.getHours() * 60 + now.getMinutes();

    // Flatten to individual open sub-slots, sorted by date then time
    const openSlots = [];
    consultationSlots.forEach(group => {
        group.subSlots.forEach(sub => {
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

const StudentController = {

    async renderDashboardPage(req, res) {
        const student = buildStudentUser(req.session);

        const [departments, faculties, appointmentCount] = await Promise.all([
            DepartmentModel.getDepartments(),
            UserModel.getFacultiesConsultation({
                limit: 10
            }),
            AppointmentModel.getCount(),
        ]);

        const formattedFaculties = faculties.map(f => {
            let nextAvailable = 'No upcoming slots';

            if (f.next_date && f.next_start_time) {
                const date = f.next_date instanceof Date
                    ? f.next_date
                    : new Date(f.next_date + 'T00:00:00');

                const dateStr = date.toLocaleDateString('en-PH', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                });

                // Convert TIME "08:00:00" → "8:00 AM"
                const [hStr, mStr] = f.next_start_time.split(':');
                let h = parseInt(hStr);
                const m = mStr;
                const period = h >= 12 ? 'PM' : 'AM';
                if (h > 12) h -= 12;
                if (h === 0) h = 12;
                const timeStr = `${h}:${m} ${period}`;

                nextAvailable = `${f.next_day}, ${dateStr} · ${timeStr}`;
            }

            return { ...f, nextAvailable };
        });

        res.render('pages/student/dashboard', {
            title: 'FaciTrack - Faculty Directory',
            student: student,
            appointmentCount: appointmentCount,
            departments: departments,
            facultyList: formattedFaculties,
        });
    },

    async renderFacultyConsultationPage(req, res) {
        const student = buildStudentUser(req.session);

        try {
            const facultyPublicId = req.params.id;
            const studentId = req.session.userId;

            const faculty = await UserModel.getUserByPublicId(facultyPublicId);
            if (!faculty) return res.redirect('/student/dashboard');

            const { windowStart, windowEnd } = getTwoWeekWindow();
            const grouped = await ConsultationModel.getSlotsByInstructorGrouped(facultyPublicId);
            const activeReservations = await SlotReservation.getActiveReservationsForInstructor(facultyPublicId);

            const toKey = d => d.toISOString().split('T')[0];
            const startKey = toKey(windowStart);
            const endKey = toKey(windowEnd);

            const reservedByOther = new Set(
                activeReservations
                    .filter(r => r.student_id !== studentId)
                    .map(r => r.slot_id)
            );

            const consultationSlots = grouped
                .filter(g => g.date >= startKey && g.date <= endKey)
                .map(g => ({
                    day: g.day,
                    date: g.date,
                    subSlots: g.subSlots.map(sub => ({
                        id: sub.id,
                        timeStart: sub.timeStart,
                        timeEnd: sub.timeEnd,
                        isBooked: sub.isBooked,
                        isReservedByOther: reservedByOther.has(sub.id),
                    })),
                }));

            faculty.nextAvailable = findNextAvailable(consultationSlots);

            res.render('pages/student/profile', {
                title: `FaciTrack - ${faculty.first_name} ${faculty.last_name}`,
                student: student,
                faculty,
                consultationSlots,
                windowStart: windowStart.toISOString(),
                windowEnd: windowEnd.toISOString(),
            });
        } catch (err) {
            console.error('[StudentController.renderFacultyProfilePage]', err);
            res.status(500).send('Failed to load faculty schedule.');
        }
    },

    async renderFacultyFormConsultationPage(req, res) {
        const student = buildStudentUser(req.session);
        try {
            const slotId = parseInt(req.params.slotId, 10);
            const studentPublicId = req.session.userId;

            const slotDetails = await ConsultationModel.getSlotWithFaculty(slotId);
            if (!slotDetails) {
                return res.redirect('/student/dashboard?bookingError=slotTaken');
            }

            if (!slotDetails) {
                return res.redirect(`/student/faculty/${slotDetails.faculty.id}?bookingError=slotNotFound`);
            }

            if (slotDetails.isBooked) {
                return res.redirect(`/student/faculty/${slotDetails.faculty.id}?bookingError=slotTaken`);
            }


            const result = await SlotReservation.reserveSlot(slotId, studentPublicId);
            if (!result.success) {
                return res.redirect(`/student/faculty/${slotDetails.faculty.id}?reserveFailed=1`);
            }

            res.render('pages/student/book', {
                title: 'FaciTrack - Book Appointment',
                student,
                faculty: slotDetails.faculty,
                slot: {
                    id: slotDetails.id,
                    day: slotDetails.day,
                    dateFormatted: slotDetails.date.toLocaleDateString('en-PH', {
                        month: 'short', day: 'numeric', year: 'numeric'
                    }),
                    date: slotDetails.date,
                    timeStart: slotDetails.timeStart,
                    timeEnd: slotDetails.timeEnd
                },
                expiresAt: result.expiresAt.toISOString(),
            });
        } catch (err) {
            console.error('[StudentController.renderFacultyFormConsultationPage]', err);
            res.status(500).send('Failed to load booking form.');
        }
    },

    async renderAppointmentsPage(req, res) {
        const student = buildStudentUser(req.session);

        try {
            const studentId = req.session.userId;
            const user = await UserModel.getUserByPublicId(studentId);

            const rawAppointments = await AppointmentModel.getAppointmentsByUser(user.internal_id);

            const appointments = rawAppointments.map(row => ({
                id: row.id,
                status: row.status,
                facultyName: `${row.last_name}, ${row.first_name}${row.middle_name ? ' ' + row.middle_name : ''}`,
                position: row.position,
                topic: row.topic,
                mode: row.mode,
                departmentName: row.department_name,
                date: new Date(row.consultation_date).toLocaleDateString('en-PH', {
                    month: 'long', day: 'numeric', year: 'numeric'
                }),
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
                    date: new Date(row.rescheduled_date).toLocaleDateString('en-PH', {
                        month: 'long', day: 'numeric', year: 'numeric'
                    }),
                    dayOfWeek: row.rescheduled_day,
                    slot: `${to12Hour(row.rescheduled_start_time)} – ${to12Hour(row.rescheduled_end_time)}`,
                } : null,
                rescheduledFromId: row.rescheduled_from_id,
                rescheduledFromInfo: row.rescheduled_from_id ? {
                    date: new Date(row.rescheduled_from_date).toLocaleDateString('en-PH', {
                        month: 'long', day: 'numeric', year: 'numeric'
                    }),
                    dayOfWeek: row.rescheduled_from_day,
                    slot: `${to12Hour(row.rescheduled_from_start_time)} – ${to12Hour(row.rescheduled_from_end_time)}`,
                } : null,
            }));

            res.render('pages/student/appointments', {
                title: 'FaciTrack - My Appointments',
                student,
                appointments,
            });
        } catch (err) {
            console.error('[StudentController.renderAppointmentsPage]', err);
            res.status(500).send('Failed to load booking form.');
        }
    },

    async createSlotReservation(req, res) {
        try {
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
                sectionGroup, courseSubject, studentEmail,
                consultTopic, consultType, consultNotes,
            } = req.body;

            const slotDetails = await ConsultationModel.getSlotWithFaculty(slotId);
            if (!slotDetails) {
                return res.redirect('/student/dashboard?bookingError=slotNotFound');
            }

            const result = await AppointmentModel.createAppointment({
                consultationHourId: slotId,
                studentPublicId,
                instructorId: slotDetails.instructorId,
                sectionGroupName: sectionGroup,
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

            res.json({ success: true });
        } catch (err) {
            console.error('[StudentController.cancelAppointment]', err);
            res.status(500).json({ success: false, error: 'Failed to cancel appointment.' });
        }
    },
};

module.exports = StudentController;