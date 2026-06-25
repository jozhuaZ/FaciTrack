const pool = require('../configs/db');
const b = require('bcrypt');
const UserModel = require('../models/UserModel');
const DepartmentModel = require('../models/DepartmentModel');

const AdminController = {
    
    async renderPage(req,res) {
        const admin = {
            // id: req.user?.id || req.session?.id || 1,
            id: 10,
            name: req.user?.name || req.session?.name || 'Admin CCS',
            role: req.user?.role || req.session?.role || 'admin',
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
                employmentType, position, profilePicture} = req.body;

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
            if (!publicId)               errors.id             = `User's identifier is missing.`;
            if (!firstName?.trim())      errors.firstName      = 'First name is required.';
            if (!lastName?.trim())       errors.lastName       = 'Last name is required.';
            if (!email?.trim())          errors.email          = 'Email is required.';
            if (!role?.trim())           errors.role           = 'Role is required.';
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
    }
}

module.exports = AdminController;