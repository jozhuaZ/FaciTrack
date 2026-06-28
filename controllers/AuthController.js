const bcrypt = require('bcrypt');
const UserModel = require('../models/UserModel');

const AuthController = {

    renderLogin(req, res) {
        const errorMessages = {
            'oauth_not_configured': 'Google Sign-In is not configured. Please use email/password login.',
            'authentication_failed': 'Authentication failed. Please try again.',
            'missing_code': 'Authentication code missing. Please try again.',
            'not_a_student_account': 'This account is not registered as a student.',
            'account_inactive': 'Your account is inactive. Please contact support.'
        };
        const errorParam = req.query.error;
        const errorMessage = errorParam ? errorMessages[errorParam] || 'An error occurred. Please try again.' : null;

        // Redirect if already logged in
        if (req.session.userId) {
            return AuthController.redirectByRole(res, req.session.role);
        }
        res.render('pages/index', {
            title: 'FaciTrack - Faculty Appointment & Monitoring System',
            error: errorMessage,
        });
    },

    async login(req, res) {
        try {
            const { email, password } = req.body;

            // Basic validation
            if (!email || !password) {
                return res.render('pages/index', {
                    title: 'FaciTrack - Faculty Appointment & Monitoring System',
                    error: 'Email and password are required.',
                });
            }

            // Find user
            const user = await UserModel.getUserByEmail(email);
            if (!user) {
                return res.render('pages/index', {
                    title: 'FaciTrack - Faculty Appointment & Monitoring System',
                    error: 'Invalid email or password.',
                });
            }

            // Check if account is active
            if (user.status !== 'Active') {
                return res.render('pages/index', {
                    title: 'FaciTrack - Faculty Appointment & Monitoring System',
                    error: 'Your account is inactive. Please contact the administrator.',
                });
            }

            // Verify password
            const match = await bcrypt.compare(password, user.hashed_password);
            if (!match) {
                return res.render('pages/index', {
                    title: 'FaciTrack - Faculty Appointment & Monitoring System',
                    error: 'Invalid email or password.',
                });
            }

            // Set session
            req.session.userId = user.id;
            req.session.role = user.role;
            req.session.name = `${user.first_name} ${user.last_name}`;
            req.session.firstName = user.first_name;
            req.session.middleName = user?.middleName || '';
            req.session.lastName = user.last_name;
            req.session.email = user.email;
            req.session.department = user.department_name;
            req.session.profilePhoto = user.profile_picture || null;

            // Update last login
            await UserModel.updateLastLogin(user.internal_id);

            // Redirect based on role
            AuthController.redirectByRole(res, user.role);

        } catch (err) {
            console.error('[AuthController.login]', err);
            res.render('pages/login', {
                title: 'FaciTrack - Faculty Appointment & Monitoring System',
                error: 'Something went wrong. Please try again.',
            });
        }
    },

    logout(req, res) {
        req.session.destroy(() => {
            res.redirect('/login');
        });
    },

    redirectByRole(res, role) {
        const destinations = {
            'Admin': '/admin/dashboard',
            'Dean': '/dean/dashboard',
            'Instructor': '/instructor/dashboard',
        };
        res.redirect(destinations[role] || '/login');
    },

};

module.exports = AuthController;