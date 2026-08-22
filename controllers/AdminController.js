const pool = require('../configs/db');
const b = require('bcrypt');
const UserModel = require('../models/UserModel');
const DepartmentModel = require('../models/DepartmentModel');
const RoomModel = require('../models/RoomModel');
const AuditLogModel = require('../models/AuditLogModel');
const { buildAdminUser } = require('../utils/sessionUser');

const AdminController = {

    // USERS
    async renderUsersPage(req, res) {
        const admin = buildAdminUser(req.session);

        const [users, departments, rooms] = await Promise.all([
            UserModel.getUsersWithDepartment(),
            DepartmentModel.getDepartments(),
            RoomModel.getRooms({
                fields: 'r.id, r.room_type, r.room_number'
            })
        ]);

        res.render('pages/admin/users', {
            title: 'FaciTrack - Faculty Management',
            admin: admin,
            users: users,
            rooms: rooms,
            departments: departments
        })
    },

    async createUser(req, res) {
        try {
            const { firstName, middleName, lastName, role,
                status, email, roomId, departmentId, password,
                employmentType, position, profilePicture } = req.body;

            const errors = {};

            if (!firstName?.trim()) errors.firstName = 'First Name is required.';
            if (!lastName?.trim()) errors.lastName = 'Last Name is required.';
            if (!role?.trim()) errors.role = 'Role is required.';
            if (!employmentType?.trim()) errors.employmentType = 'Employment Type is required.';
            if (!position?.trim()) errors.position = 'Position/Title is required.';
            if (!password.trim()) errors.password = 'Password is required.';
            if (!roomId) errors.baseRoom = 'Base Room is required.';
            else if (password.length < 8) errors.password = 'Password must be at least 8 characters.';

            if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                errors.email = 'Invalid email format.';
            }

            if (Object.keys(errors).length > 0) {
                return res.status(422).json({ success: false, errors })
            }

            // hash the password
            const hashedPassword = await b.hash(password, 10);

            // insert new user with UserModel
            await UserModel.insertUserByAdmin({
                firstName,
                middleName,
                lastName,
                email,
                role,
                roomId,
                departmentId,
                status,
                employmentType,
                position,
                hashedPassword,
            });

            try {
                const user = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(user.internal_id, user.role, 'Created user', 'users');
            } catch (logErr) {
                console.error('[AuditLog] Failed to log users:', logErr);
            }

            res.json({
                success: true,
                message: 'User created successfully!'
            })
        } catch (err) {
            if (err.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({
                    success: false,
                    errors: {
                        email: 'Email already exists.'
                    }
                });
            }
            console.error(`[UserController.createUser] ${err}`);
            res.status(500).json({
                success: false,
                error: 'Failed to create user.'
            });
        }
    },

    async updateUser(req, res) {
        try {
            const { publicId } = req.params;
            const { firstName, middleName, lastName, email, role, roomId, departmentId, status, employmentType, position } = req.body;

            const errors = {};
            if (!publicId) errors.id = `User's identifier is missing.`;
            if (!firstName?.trim()) errors.firstName = 'First name is required.';
            if (!lastName?.trim()) errors.lastName = 'Last name is required.';
            if (!email?.trim()) errors.email = 'Email is required.';
            if (!role?.trim()) errors.role = 'Role is required.';
            if (!employmentType?.trim()) errors.employmentType = 'Employment type is required.';
            if (!position?.trim()) errors.position = 'Position/Title is required.';
            if (!roomId) errors.baseRoom = 'Base Room is required';

            if (Object.keys(errors).length > 0) {
                return res.status(422).json({ success: false, errors });
            }

            await UserModel.updateUser(publicId, {
                firstName, middleName, lastName, email,
                role, roomId, departmentId, status, employmentType, position
            });

            try {
                const user = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(user.internal_id, user.role, 'Updated user', 'users');
            } catch (logErr) {
                console.error('[AuditLog] Failed to log users:', logErr);
            }

            res.json({ success: true, message: `${firstName} ${lastName} updated successfully!` });

        } catch (err) {
            if (err.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ success: false, errors: { email: 'Email already exists.' } });
            }
            console.error('[AdminController.updateUser]', err);
            res.status(500).json({ success: false, error: 'Failed to update user.' });
        }
    },

    async deleteUser(req, res) {
        try {
            const { publicId } = req.params;

            if (!publicId) errors.id = `User's identifier is missing.`;

            const affectedRows = await UserModel.deleteUser(publicId);

            if (affectedRows === 0) {
                return res.status(404).json({ success: false, error: 'User not found.' });
            }

            try {
                const user = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(user.internal_id, user.role, 'Deleted user', 'users');
            } catch (logErr) {
                console.error('[AuditLog] Failed to log users:', logErr);
            }

            res.json({ success: true, message: `User deleted successfully!` });

        } catch (err) {
            console.error('[AdminController.deleteUser]', err);
            res.status(500).json({ success: false, error: 'Failed to delete user.' });
        }
    },

    // ROOMS 
    async renderRoomsPage(req, res) {
        const admin = buildAdminUser(req.session);

        const [departments, rooms] = await Promise.all([
            DepartmentModel.getDepartments(),
            RoomModel.getRooms({
                fields: `r.id, 
                        r.room_number, 
                        r.room_type, 
                        r.department_id,
                        d.full_name AS department_name, 
                        d.building AS building_name, 
                        CONCAT(u.last_name + ', ' + u.first_name) AS assigned_faculty_name, 
                        r.is_ble_scanner_installed, 
                        r.status`
            })
        ]);

        res.render('pages/admin/rooms', {
            title: 'FaciTrack - Rooms Management',
            admin: admin,
            departments: departments,
            roomData: rooms
        });
    },

    async createRoom(req, res) {
        try {
            const { roomNumber, department, roomType, bleStatus, assignedFaculty, status } = req.body;

            const errors = {};

            if (!roomNumber) errors.roomNumber = 'Room Number is required.';
            if (!department) errors.department = 'Department is required.';
            if (!roomType) errors.roomType = 'Room Type is required.';
            if (bleStatus == null || bleStatus === '') errors.bleStatus = 'BLE Scanner status is required.';
            if (!status) errors.status = 'Status is required.';

            // return early if at least one error is present
            if (Object.keys(errors).length > 0) {
                return res.status(422).json({ success: false, errors })
            }

            let capacity = null;
            if (roomType === 'Consultation Room') {
                capacity = 5;
            }

            // await for the room model to finish inserting new room
            await RoomModel.insertRoomByAdmin({
                roomNumber,
                department,
                roomType,
                bleStatus,
                assignedFaculty,
                status,
                capacity
            });

            try {
                const user = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(user.internal_id, user.role, 'Created room', 'rooms');
            } catch (logErr) {
                console.error('[AuditLog] Failed to log room:', logErr);
            }

            return res.status(200).json({
                success: true,
                message: 'Room created successfully!'
            })
        } catch (err) {
            console.error(`[AdminController.createRoom] ${err}`);
            res.status(500).json({
                success: false,
                error: 'Failed to create room.'
            });
        }
    },

    async updateRoom(req, res) {
        try {
            const { roomId } = req.params;
            const { roomNumber, department, roomType, bleStatus, assignedFaculty, status } = req.body;

            const errors = {};

            if (!roomNumber) errors.roomNumber = 'Room Number is required.';
            if (!department) errors.department = 'Department is required.';
            if (!roomType) errors.roomType = 'Room Type is required.';
            if (!status) errors.status = 'Status is required.';

            // return early if at least one error is present
            if (Object.keys(errors).length > 0) {
                return res.status(422).json({ success: false, errors })
            }

            // await for the room model to finish updating new room
            await RoomModel.updateRoom(roomId, {
                roomNumber,
                department,
                roomType,
                bleStatus,
                assignedFaculty: assignedFaculty || null,
                status
            });

            try {
                const user = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(user.internal_id, user.role, 'Updated room', 'rooms');
            } catch (logErr) {
                console.error('[AuditLog] Failed to log room:', logErr);
            }

            return res.status(200).json({
                success: true,
                message: 'Room updated successfully!'
            })
        } catch (err) {
            console.error(`[AdminController.updateRoom] ${err}`);
            res.status(500).json({
                success: false,
                error: 'Failed to create room.'
            });
        }
    },

    async deleteRoom(req, res) {
        try {
            const { roomId } = req.params;

            if (!roomId) errors.id = `Room's identifier is missing.`;

            const affectedRows = await RoomModel.deleteRoom(roomId);

            if (affectedRows === 0) {
                return res.status(404).json({ success: false, error: 'Room not found.' });
            }

            try {
                const user = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(user.internal_id, user.role, 'Deleted room', 'rooms');
            } catch (logErr) {
                console.error('[AuditLog] Failed to log room:', logErr);
            }

            res.json({ success: true, message: `Room deleted successfully!` });

        } catch (err) {
            console.error('[AdminController.deleteRoom]', err);
            res.status(500).json({ success: false, error: 'Failed to delete room.' });
        }
    },

    async renderReportsPage(req, res) {
        try {
            const admin = buildAdminUser(req.session);

            const auditLogs = await AuditLogModel.getAll();

            res.render('pages/admin/reports', { 
                title: 'FaciTrack - Reports', 
                admin,
                logs: auditLogs,
            });
        } catch (err) {
            console.error('[AdminController.renderReportsPage]', err);
            res.status(500).send('Failed to load reports page.');
        }
    }
}

module.exports = AdminController;