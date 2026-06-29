const pool = require('../configs/db');
const b = require('bcrypt');
const UserModel = require('../models/UserModel');
const DepartmentModel = require('../models/DepartmentModel');
const RoomModel = require('../models/RoomModel');

const AdminController = {

    // USERS
    async renderUsersPage(req, res) {
        const admin = {
            id: req.session?.instructorId,
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
        }

        const [users, departments] = await Promise.all([
            UserModel.getUsersWithDepartment(),
            DepartmentModel.getDepartments()
        ]);

        res.render('pages/admin/users', {
            title: 'FaciTrack - Faculty Management',
            admin: admin,
            users: users,
            departments: departments
        })
    },

    async createUser(req, res) {
        try {
            const { firstName, middleName, lastName, role,
                status, email, departmentId, password,
                employmentType, position, profilePicture } = req.body;

            const errors = {};

            if (!firstName?.trim()) errors.firstName = 'First Name is required.';
            if (!lastName?.trim()) errors.lastName = 'Last Name is required.';
            if (!role?.trim()) errors.role = 'Role is required.';
            if (!employmentType?.trim()) errors.employmentType = 'Employment Type is required.';
            if (!position?.trim()) errors.position = 'Position/Title is required.';
            if (!password.trim()) errors.password = 'Password is required.';
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
                departmentId,
                status,
                employmentType,
                position,
                hashedPassword,
            });

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
            const { firstName, middleName, lastName, email, role, departmentId, status, employmentType, position } = req.body;

            const errors = {};
            if (!publicId) errors.id = `User's identifier is missing.`;
            if (!firstName?.trim()) errors.firstName = 'First name is required.';
            if (!lastName?.trim()) errors.lastName = 'Last name is required.';
            if (!email?.trim()) errors.email = 'Email is required.';
            if (!role?.trim()) errors.role = 'Role is required.';
            if (!employmentType?.trim()) errors.employmentType = 'Employment type is required.';
            if (!position?.trim()) errors.position = 'Position/Title is required.';

            if (Object.keys(errors).length > 0) {
                return res.status(422).json({ success: false, errors });
            }

            await UserModel.updateUser(publicId, {
                firstName, middleName, lastName, email,
                role, departmentId, status, employmentType, position
            });

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

            res.json({ success: true, message: `User deleted successfully!` });

        } catch (err) {
            console.error('[AdminController.deleteUser]', err);
            res.status(500).json({ success: false, error: 'Failed to delete user.' });
        }
    },

    // ROOMS 
    async renderRoomsPage(req, res) {
        const admin = {
            id: req.session?.instructorId,
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
            if (!bleStatus) errors.bleStatus = 'BLE Scanner status is required.';
            if (!status) errors.status = 'Status is required.';

            // return early if at least one error is present
            if (Object.keys(errors).length > 0) {
                return res.status(422).json({ success: false, errors })
            }

            // await for the room model to finish inserting new room
            await RoomModel.insertRoomByAdmin({
                roomNumber,
                department,
                roomType,
                bleStatus,
                assignedFaculty,
                status
            });

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

            res.json({ success: true, message: `Room deleted successfully!` });

        } catch (err) {
            console.error('[AdminController.deleteRoom]', err);
            res.status(500).json({ success: false, error: 'Failed to delete room.' });
        }
    }
}

module.exports = AdminController;