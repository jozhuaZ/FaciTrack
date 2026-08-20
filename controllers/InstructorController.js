const pool = require('../configs/db');
const ConsultationModel = require('../models/ConsultationModel');
const AppointmentModel = require('../models/AppointmentModel');
const { to12Hour } = require('../utils/timeFormat');
const { buildInstructorUser } = require('../utils/sessionUser');

function computeDuration(startTime, endTime) {
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    const mins = (eh * 60 + em) - (sh * 60 + sm);
    return `${mins} min`;
}

function computeDurationMinutes(startTime, endTime) {
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    return (eh * 60 + em) - (sh * 60 + sm);
}

const InstructorController = {

    async renderConsultationPage(req, res) {
        try {
            const instructorId = req.session.userId;

            const instructor = buildInstructorUser(req.session);

            const grouped = await ConsultationModel.getSlotsByInstructorGrouped(instructorId);

            const consultationSlots = [];
            grouped.forEach(group => {
                group.subSlots.forEach(sub => {
                    consultationSlots.push({
                        id: sub.id,
                        day: group.day,
                        date: group.date,
                        timeStart: sub.timeStart,
                        timeEnd: sub.timeEnd,
                        status: sub.status,
                        isBooked: sub.isBooked,
                        maxCapacity: group.subSlots.length,
                        bookedCount: group.subSlots.filter(s => s.isBooked).length,
                    });
                });
            });

            res.render('pages/instructor/schedule', {
                title: 'FaciTrack - Consultation Schedule',
                instructor: instructor,
                consultationSlots: consultationSlots,
            });
        } catch (err) {
            console.error('[InstructorController.renderConsultationPage]', err);
            res.status(500).send('Failed to load schedule page.');
        }
    },

    async saveSlotBlock(req, res) {
        try {
            const { date, day, timeStart, timeEnd, maxCapacity, repeatWeeks } = req.body;

            const result = await ConsultationModel.saveSlotBlock(req.session.userId, {
                date, day, timeStart, timeEnd,
                maxCapacity: parseInt(maxCapacity, 10) || 1,
                repeatWeeks: Math.max(1, Math.min(52, parseInt(repeatWeeks, 10) || 1)),
            });

            res.json({ success: true, message: `Saved ${result.count} slot(s) across ${req.body.repeatWeeks || 1} week(s).` });
        } catch (err) {
            console.error('[InstructorController.saveSlotBlock]', err);
            res.status(500).json({ success: false, error: { message: err.message } });
        }
    },

    async deleteSlot(req, res) {
        try {
            const slotId = parseInt(req.params.slotId, 10);
            const result = await ConsultationModel.deleteSlot(req.session.userId, slotId);

            if (!result.success) {
                const message = result.reason === 'ACTIVE_APPOINTMENT'
                    ? 'This slot has an active appointment and cannot be deleted.'
                    : 'Slot not found or could not be deleted.';
                return res.status(409).json({ success: false, error: message });
            }

            res.json({
                success: true,
                softClosed: result.softClosed,
                message: result.softClosed
                    ? 'Slot closed (kept for appointment history).'
                    : 'Slot deleted.',
            });
        } catch (err) {
            console.error('[InstructorController.deleteSlot]', err);
            res.status(500).json({ success: false, error: 'Failed to delete slot.' });
        }
    },

    async getUnavailability(req, res) {
        try {
            const dates = await ConsultationModel.getUnavailability(req.session.userId);
            res.json({ success: true, unavailableDates: dates });
        } catch (err) {
            console.error('[InstructorController.getUnavailability]', err);
            res.status(500).json({ success: false, error: 'Failed to load unavailability.' });
        }
    },

    async setUnavailability(req, res) {
        try {
            const { date, reason } = req.body;
            if (!date) return res.status(400).json({ success: false, error: 'Date is required.' });

            const today = new Date(); today.setHours(0, 0, 0, 0);
            const chosen = new Date(date + 'T00:00:00');
            if (chosen <= today) {
                return res.status(422).json({
                    success: false,
                    error: 'Cannot mark today or a past date as unavailable.'
                });
            }

            // Cancel appointments on this date
            const affected = await ConsultationModel.cancelAppointmentsOnDate(req.session.userId, date, reason);

            // Mark date as unavailable
            await ConsultationModel.setUnavailability(req.session.userId, date, reason);

            // TODO: send email notifications to affected students

            res.json({
                success: true,
                dateKey: date,
                reason: reason,
                cancelledCount: affected.length,
                cancelledRefs: affected.map(a => a.id),
            });
        } catch (err) {
            console.error('[InstructorController.setUnavailability]', err);
            res.status(500).json({ success: false, error: 'Failed to set unavailability.' });
        }
    },

    async checkUnavailability(req, res) {
        try {
            const { date } = req.params;
            const count = await ConsultationModel.checkAppointmentsOnDate(req.session.userId, date);
            res.json({ success: true, count });
        } catch (err) {
            res.status(500).json({ success: false, error: 'Failed to check.' });
        }
    },

    async removeUnavailability(req, res) {
        try {
            const { date } = req.params;
            await ConsultationModel.removeUnavailability(req.session.userId, date);
            res.json({ success: true });
        } catch (err) {
            console.error('[InstructorController.removeUnavailability]', err);
            res.status(500).json({ success: false, error: 'Failed to remove block.' });
        }
    },

    async renderAppointmentsPage(req, res) {
        try {
            const instructor = buildInstructorUser(req.session);

            const instructorPublicId = req.session.userId;
            const rawAppointments = await AppointmentModel.getAppointmentsByInstructor(instructorPublicId);

            const appointments = rawAppointments.map(row => ({
                id: row.id,
                status: row.status,
                firstName: row.student_first_name,
                lastName: row.student_last_name,
                studentName: `${row.student_last_name}, ${row.student_first_name}`,
                studentId: row.student_number,
                topic: row.topic,
                mode: row.mode,
                date: row.consultation_date,
                dayOfWeek: row.day_of_the_week,
                time: `${to12Hour(row.start_time)} – ${to12Hour(row.end_time)}`,
                duration: computeDuration(row.start_time, row.end_time),
                roomNumber: row.room_number,
                buildingName: row.building_name,
                notes: row.notes,
                sectionGroupName: row.section_group_name,
                courseSubject: row.course_subject,
                email: row.email,
                createdAt: row.created_at,
            }));

            res.render('pages/instructor/appointments', {
                title: 'FaciTrack - Appointments',
                instructor,
                appointments,
            });
        } catch (err) {
            console.error('[InstructorController.renderAppointmentsPage]', err);
            res.status(500).send('Failed to load appointments.');
        }
    },

    async getRescheduleOptions(req, res) {
        try {
            const instructorPublicId = req.session.userId;
            const grouped = await ConsultationModel.getBookableSlotsByInstructor(instructorPublicId);
            const slots = grouped.map(g => ({
                day: g.day,
                date: g.date,
                subSlots: g.subSlots.map(s => ({ id: s.id, timeStart: s.timeStart, timeEnd: s.timeEnd })),
            }));
            res.json({ success: true, slots });
        } catch (err) {
            console.error('[InstructorController.getRescheduleOptions]', err);
            res.status(500).json({ success: false, error: 'Failed to load available slots.' });
        }
    },

    async rescheduleAppointment(req, res) {
        try {
            const appointmentId = parseInt(req.params.id, 10);
            const { newSlotId, reason } = req.body;
            const instructorPublicId = req.session.userId;

            if (!newSlotId) {
                return res.status(400).json({ success: false, error: 'Please select a new slot.' });
            }

            const result = await AppointmentModel.rescheduleAppointment(
                appointmentId, parseInt(newSlotId, 10), instructorPublicId, reason
            );

            if (!result.success) {
                const messages = {
                    SLOT_UNAVAILABLE: 'That slot is no longer available.',
                    NO_ROOM_AVAILABLE: 'All consultation rooms are full for that time.',
                    NOT_FOUND_OR_RESOLVED: 'Appointment not found or already resolved.',
                };
                return res.status(409).json({ success: false, error: messages[result.reason] || 'Failed to reschedule.' });
            }

            res.json({ success: true, newAppointmentId: result.newAppointmentId });
        } catch (err) {
            console.error('[InstructorController.rescheduleAppointment]', err);
            res.status(500).json({ success: false, error: 'Failed to reschedule appointment.' });
        }
    },

    async approveAppointment(req, res) {
        try {
            const appointmentId = parseInt(req.params.id, 10);
            const instructorPublicId = req.session.userId;

            const result = await AppointmentModel.approveAppointment(appointmentId, instructorPublicId);
            if (!result.success) {
                return res.status(404).json({ success: false, error: 'Appointment not found or already resolved.' });
            }
            res.json({ success: true });
        } catch (err) {
            console.error('[InstructorController.approveAppointment]', err);
            res.status(500).json({ success: false, error: 'Failed to approve appointment.' });
        }
    },

    async declineAppointment(req, res) {
        try {
            const appointmentId = parseInt(req.params.id, 10);
            const instructorPublicId = req.session.userId;
            const { reason } = req.body;

            if (!reason || !reason.trim()) {
                return res.status(400).json({ success: false, error: 'A reason is required to decline.' });
            }

            const result = await AppointmentModel.declineAppointment(appointmentId, instructorPublicId, reason.trim());
            if (!result.success) {
                return res.status(404).json({ success: false, error: 'Appointment not found or already resolved.' });
            }
            res.json({ success: true });
        } catch (err) {
            console.error('[InstructorController.declineAppointment]', err);
            res.status(500).json({ success: false, error: 'Failed to decline appointment.' });
        }
    },

    async renderReportsPage(req, res) {
        try {
            const instructor = buildInstructorUser(req.session);

            const instructorPublicId = req.session.userId;
            const rawAppointments = await AppointmentModel.getAppointmentsByInstructor(instructorPublicId);

            const appointments = rawAppointments.map(row => ({
                id: row.id,
                status: row.status,
                studentName: `${row.student_last_name}, ${row.student_first_name}`,
                studentId: row.student_number,
                topic: row.topic,
                date: row.consultation_date,
                dayOfWeek: row.day_of_the_week,
                time: `${to12Hour(row.start_time)} – ${to12Hour(row.end_time)}`,
                duration: computeDuration(row.start_time, row.end_time),
                durationMinutes: computeDurationMinutes(row.start_time, row.end_time),
                buildingName: row.building_name,
                notes: row.notes,
                sectionGroupName: row.section_group_name,
                courseSubject: row.course_subject,
                createdAt: row.created_at,
            }));

            const averageDurationMinutes = appointments.length
                ? Math.round(appointments.reduce((sum, a) => sum + a.durationMinutes, 0) / appointments.length)
                : 0;

            const averageDuration = `${averageDurationMinutes} min`;

            res.render('pages/instructor/reports', {
                title: 'FaciTrack - Reports',
                instructor,
                averageDuration,
                appointments,
            });
        } catch (err) {
            console.error('[InstructorController.renderReportsPage]', err);
            res.status(500).send('Failed to load schedule page.');
        }
    },
};

module.exports = InstructorController;