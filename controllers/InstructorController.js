const pool = require('../configs/db');
const ConsultationModel = require('../models/ConsultationModel');

const InstructorController = {

    async renderConsultationPage(req, res) {
        try {
            const instructorId = req.session.userId;

            const instructor = {
                id: req.session?.userId,
                name: req.session?.name,
                firstName: req.session.firstName,
                middleName: req.session.middleName,
                lastName: req.session.lastName,
                status: req.session.status,
                email: req.session?.email,
                position: req.session.position,
                role: req.session.role,
                profilePhoto: req.session?.profilePhoto || null,
                department: req.session?.department,
            };

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
            console.error('[InstructorController.renderSchedulePage]', err);
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
            const { slotId } = req.params;
            const affected = await ConsultationModel.deleteSlotBlock(req.session.userId, slotId);

            if (!affected) {
                return res.status(404).json({ success: false, error: 'Slot not found or already booked.' });
            }

            res.json({ success: true, message: 'Slot deleted.' });
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
            const affected = await ConsultationModel.cancelAppointmentsOnDate(req.session.userId, date);

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
};

module.exports = InstructorController;