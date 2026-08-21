const ConsultationRoomModel = require('../models/ConsultationRoomModel');
const DepartmentModel = require('../models/DepartmentModel');
const UserModel = require('../models/UserModel');

const ConsultationRoomController = {
    /**
     * Render the main Consultation Room page
     */
    async renderConsultationRoomPage(req, res) {
        try {
            const admin = {
                id: req.session?.userId,
                name: req.session?.name,
                firstName: req.session.firstName,
                middleName: req.session.middleName,
                lastName: req.session.lastName,
                status: req.session.status,
                email: req.session?.email,
                position: req.session.position,
                role: req.session.role,
                profilePhoto: req.session?.profilePhoto || 'N/A',
                department: req.session?.department,
            };

            // Get program tables (BSIT, BLIS, BSCS, BSIS)
            const programTables = await ConsultationRoomModel.getProgramTables();

            // Get departments for filtering
            const departments = await DepartmentModel.getDepartments();

            // Get today's date
            const today = new Date().toISOString().split('T')[0];

            res.render('pages/admin/consultation-room', {
                title: 'FaciTrack - Consultation Room Management',
                admin: admin,
                programTables: programTables,
                departments: departments,
                today: today
            });
        } catch (err) {
            console.error('[ConsultationRoomController.renderConsultationRoomPage]', err);
            res.status(500).send('Failed to load consultation room page');
        }
    },

    /**
     * Get consultation slots by program (API endpoint)
     */
    async getSlotsByProgram(req, res) {
        try {
            const { programCode, date } = req.query;

            if (!programCode) {
                return res.status(400).json({
                    success: false,
                    error: 'Program code is required'
                });
            }

            const slots = await ConsultationRoomModel.getConsultationSlotsByProgram(
                programCode, 
                date || null
            );

            res.json({
                success: true,
                data: slots
            });
        } catch (err) {
            console.error('[ConsultationRoomController.getSlotsByProgram]', err);
            res.status(500).json({
                success: false,
                error: 'Failed to fetch consultation slots'
            });
        }
    },

    /**
     * Get consultation logs (API endpoint)
     */
    async getConsultationLogs(req, res) {
        try {
            const { 
                programCode, 
                status, 
                dateFrom, 
                dateTo, 
                instructorId,
                limit = 50,
                offset = 0 
            } = req.query;

            const [logs, total] = await Promise.all([
                ConsultationRoomModel.getConsultationLogs({
                    programCode: programCode || null,
                    status: status || null,
                    dateFrom: dateFrom || null,
                    dateTo: dateTo || null,
                    instructorId: instructorId || null,
                    limit: parseInt(limit),
                    offset: parseInt(offset)
                }),
                ConsultationRoomModel.getConsultationLogsCount({
                    programCode: programCode || null,
                    status: status || null,
                    dateFrom: dateFrom || null,
                    dateTo: dateTo || null,
                    instructorId: instructorId || null
                })
            ]);

            res.json({
                success: true,
                data: logs,
                pagination: {
                    total: total,
                    limit: parseInt(limit),
                    offset: parseInt(offset),
                    hasMore: (parseInt(offset) + logs.length) < total
                }
            });
        } catch (err) {
            console.error('[ConsultationRoomController.getConsultationLogs]', err);
            res.status(500).json({
                success: false,
                error: 'Failed to fetch consultation logs'
            });
        }
    },

    /**
     * Check slot availability for a specific time (API endpoint)
     */
    async checkSlotAvailability(req, res) {
        try {
            const { programCode, date, startTime, endTime } = req.query;

            if (!programCode || !date || !startTime || !endTime) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing required parameters'
                });
            }

            const availability = await ConsultationRoomModel.checkSlotAvailability(
                programCode,
                date,
                startTime,
                endTime
            );

            res.json({
                success: true,
                data: availability
            });
        } catch (err) {
            console.error('[ConsultationRoomController.checkSlotAvailability]', err);
            res.status(500).json({
                success: false,
                error: 'Failed to check slot availability'
            });
        }
    },

    /**
     * Get available rooms for booking (API endpoint)
     */
    async getAvailableRooms(req, res) {
        try {
            const { programCode, date, startTime, endTime } = req.query;

            if (!programCode || !date || !startTime || !endTime) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing required parameters'
                });
            }

            const rooms = await ConsultationRoomModel.getAvailableRooms(
                programCode,
                date,
                startTime,
                endTime
            );

            res.json({
                success: true,
                data: rooms
            });
        } catch (err) {
            console.error('[ConsultationRoomController.getAvailableRooms]', err);
            res.status(500).json({
                success: false,
                error: 'Failed to fetch available rooms'
            });
        }
    },

    /**
     * Get consultation statistics (API endpoint)
     */
    async getConsultationStats(req, res) {
        try {
            const { programCode, dateFrom, dateTo } = req.query;

            const [stats, roomStats] = await Promise.all([
                ConsultationRoomModel.getConsultationStats(
                    programCode || null,
                    dateFrom || null,
                    dateTo || null
                ),
                ConsultationRoomModel.getRoomUtilizationStats(
                    dateFrom || null,
                    dateTo || null
                )
            ]);

            res.json({
                success: true,
                data: {
                    consultationStats: stats,
                    roomUtilization: roomStats
                }
            });
        } catch (err) {
            console.error('[ConsultationRoomController.getConsultationStats]', err);
            res.status(500).json({
                success: false,
                error: 'Failed to fetch consultation statistics'
            });
        }
    },

    /**
     * Update appointment status (accept/decline)
     */
    async updateAppointmentStatus(req, res) {
        try {
            const { appointmentId } = req.params;
            const { status, reason } = req.body;

            if (!appointmentId || !status) {
                return res.status(400).json({
                    success: false,
                    error: 'Appointment ID and status are required'
                });
            }

            const validStatuses = ['pending', 'confirmed', 'declined', 'completed', 'cancelled'];
            if (!validStatuses.includes(status)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid status value'
                });
            }

            const result = await ConsultationRoomModel.updateAppointmentStatus(
                appointmentId,
                status,
                reason || null
            );

            if (!result.success) {
                return res.status(404).json({
                    success: false,
                    error: result.reason || 'Failed to update appointment'
                });
            }

            res.json({
                success: true,
                message: `Appointment ${status} successfully`
            });
        } catch (err) {
            console.error('[ConsultationRoomController.updateAppointmentStatus]', err);
            res.status(500).json({
                success: false,
                error: 'Failed to update appointment status'
            });
        }
    },

    /**
     * Render the Consultation Logs page
     */
    async renderConsultationLogsPage(req, res) {
        try {
            const admin = {
                id: req.session?.userId,
                name: req.session?.name,
                firstName: req.session.firstName,
                middleName: req.session.middleName,
                lastName: req.session.lastName,
                status: req.session.status,
                email: req.session?.email,
                position: req.session.position,
                role: req.session.role,
                profilePhoto: req.session?.profilePhoto || 'N/A',
                department: req.session?.department,
            };

            // Get program tables for filtering
            const programTables = await ConsultationRoomModel.getProgramTables();

            // Get initial logs (latest 50)
            const logs = await ConsultationRoomModel.getConsultationLogs({
                limit: 50,
                offset: 0
            });

            const total = await ConsultationRoomModel.getConsultationLogsCount();

            // Get instructors for filtering
            const instructors = await UserModel.getUsersByRole('Instructor');

            res.render('pages/admin/consultation-logs', {
                title: 'FaciTrack - Consultation Logs',
                admin: admin,
                programTables: programTables,
                logs: logs,
                total: total,
                instructors: instructors
            });
        } catch (err) {
            console.error('[ConsultationRoomController.renderConsultationLogsPage]', err);
            res.status(500).send('Failed to load consultation logs page');
        }
    }
};

module.exports = ConsultationRoomController;
