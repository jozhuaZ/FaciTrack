const bcrypt = require('bcryptjs');
const UserModel = require('../models/UserModel');
const AuditLogModel = require('../models/AuditLogModel');
const OtpModel = require('../models/OtpModel');
const emailService = require('../services/email');

const LOGIN_TITLE = 'FaciTrack - Login';

// Roles that must clear a second factor before a session is created
const OTP_REQUIRED_ROLES = ['Admin'];

// Where a signed-in user belongs. One map, because three different pages now
// answer "are you already logged in?" and they must all answer the same way.
const HOME_BY_ROLE = {
    'Student':    '/student/dashboard',
    'Admin':      '/admin/dashboard',
    'Dean':       '/dean/dashboard',
    'Instructor': '/instructor/dashboard',
};

/** Default render state for the login page. */
function loginView(overrides = {}) {
    return {
        title: LOGIN_TITLE,
        error: null,
        step: 'login',
        email: '',
        otpError: null,
        otpNotice: null,
        ...overrides,
    };
}

const AuthController = {

    /**
     * The signed-in home for this session, or null if there isn't one.
     *
     * Returning null for an unrecognised role matters: redirectByRole falls
     * back to /login, and /login asks this same question, so a session holding
     * a role no longer in the map would have bounced between the two forever.
     */
    homeFor(session) {
        if (!session?.userId) return null;
        return HOME_BY_ROLE[session.role] || null;
    },

    /**
     * Public landing page.
     *
     * A live session skips it. The PWA's start_url is "/", so closing the app
     * and reopening it landed on the marketing page even when the session was
     * still good — and the Login button there only bounced to the dashboard
     * anyway, making the landing page a detour rather than a destination.
     *
     * Navigation requests are network-first in the service worker, so this
     * redirect runs on reopen whenever the device is online. Offline, the
     * cached page is still served, which is the right trade: something to look
     * at beats a connection error.
     */
    renderLanding(req, res) {
        const home = AuthController.homeFor(req.session);
        if (home) return res.redirect(home);

        res.render('pages/index', {
            title: 'FaciTrack - Login',
            error: null,
        });
    },

    renderLogin(req, res) {
        const errorMessages = {
            'authentication_failed': 'Authentication failed. Please try again.',
            'no_email': 'Google did not return an email address for that account.',
            'domain_not_allowed': 'Only CSPC institutional email accounts are allowed.',
            'faculty_not_registered': 'Faculty account not found. Please contact the administrator.',
            'account_inactive': 'Your account is inactive. Please contact the administrator.',
            'oauth_expired': 'That Google sign-in link had already been used or expired. Please try again.',
            'oauth_cancelled': 'Google sign-in was cancelled.',
            'oauth_misconfigured': 'Google sign-in is not set up correctly for this site. Please contact the administrator.',
        };
        const errorParam = req.query.error;
        const errorMessage = errorParam ? errorMessages[errorParam] || 'An error occurred. Please try again.' : null;

        // Already signed in — nothing to log into
        const home = AuthController.homeFor(req.session);
        if (home) return res.redirect(home);

        res.render('pages/login', loginView({ error: errorMessage }));
    },

    async login(req, res) {
        try {
            const { email, password } = req.body;

            // Every failure below hands the typed address back, so a mistyped
            // password does not also cost the instructor their email. Only the
            // password is ever cleared.
            // Basic validation
            if (!email || !password) {
                return res.render('pages/login', loginView({
                    error: 'Email and password are required.',
                    email,
                }));
            }

            // Find user
            const user = await UserModel.getUserByEmail(email);
            if (!user) {
                return res.render('pages/login', loginView({
                    error: 'Invalid email or password.',
                    email,
                }));
            }

            // Check if account is active
            if (user.status !== 'Active') {
                return res.render('pages/login', loginView({
                    error: 'Your account is inactive. Please contact the administrator.',
                    email,
                }));
            }

            // Verify password
            const match = await bcrypt.compare(password, user.hashed_password);
            if (!match) {
                return res.render('pages/login', loginView({
                    error: 'Invalid email or password.',
                    email,
                }));
            }

            // Privileged roles get a second factor — no session until it clears
            if (OTP_REQUIRED_ROLES.includes(user.role)) {
                return AuthController.startOtpChallenge(req, res, user);
            }

            await AuthController.establishSession(req, user);
            // Save before redirecting, the same as the OTP and Google paths.
            // The dashboard the redirect lands on reads this session on a fresh
            // request — a different serverless instance — so the write to the
            // store must be committed before that request can arrive.
            req.session.save((err) => {
                if (err) {
                    console.error('[AuthController.login] session save failed:', err);
                    return res.redirect('/login');
                }
                AuthController.redirectByRole(res, user.role);
            });

        } catch (err) {
            console.error('[AuthController.login]', err);
            res.render('pages/login', loginView({
                error: 'Something went wrong. Please try again.',
                email: req.body?.email || '',
            }));
        }
    },

    /**
     * Populate the session for a verified user and record the login.
     * Shared by the password, OTP, and Google paths.
     */
    async establishSession(req, user) {
        req.session.userId = user.id;   // public_id
        req.session.role = user.role;
        req.session.name = `${user.first_name} ${user.last_name}`;
        req.session.firstName = user.first_name;
        req.session.middleName = user?.middle_name || '';
        req.session.lastName = user.last_name;
        req.session.email = user.email;
        req.session.position = user.position;
        req.session.departmentId = user.department_id;
        req.session.department = user.department_name;
        req.session.profilePhoto = user.profile_picture || null;

        await UserModel.updateLastLogin(user.internal_id);

        try {
            await AuditLogModel.log(user.internal_id, user.role, 'Logged in', 'login');
        } catch (err) {
            console.error('[AuditLog] Failed to log login:', err);
        }
    },

    /** Issue a code, email it, and hand the user the verification step. */
    async startOtpChallenge(req, res, user) {
        // Remember who is mid-login WITHOUT granting them a session yet
        req.session.pendingOtp = { internalId: user.internal_id, email: user.email };

        const { code, expiresInMinutes } = await OtpModel.issue(user.internal_id);
        await emailService.sendOtpCode({
            email: user.email,
            name: user.first_name,
            code,
            expiresInMinutes,
        });

        return res.render('pages/login', loginView({
            step: 'otp',
            email: user.email,
            otpNotice: `We sent a ${OtpModel.TTL_MINUTES}-minute code to ${user.email}.`,
        }));
    },

    async verifyOtp(req, res) {
        // Already through? Then this is a duplicate submit — a double-click, or
        // the service worker retrying a slow request during a cold start. The
        // first request burned the code and established the session; the second
        // would otherwise find the code consumed and report "no longer valid"
        // on an account that is in fact logged in. Send it where it belongs.
        if (req.session.userId) {
            return AuthController.redirectByRole(res, req.session.role);
        }

        const pending = req.session.pendingOtp;
        if (!pending) {
            return res.redirect('/login');
        }

        try {
            const code = String(req.body.otp || '').trim();
            if (!code) {
                return res.render('pages/login', loginView({
                    step: 'otp', email: pending.email,
                    otpError: 'Please enter the verification code.',
                }));
            }

            const result = await OtpModel.verify(pending.internalId, code);

            if (!result.success) {
                const messages = {
                    NO_CODE: 'That code is no longer valid. Please sign in again.',
                    EXPIRED: 'That code has expired. Request a new one below.',
                    TOO_MANY_ATTEMPTS: 'Too many incorrect attempts. Please sign in again.',
                };
                const message = messages[result.reason]
                    || `Incorrect code. ${result.attemptsRemaining} attempt(s) remaining.`;

                // Unrecoverable states send the user back to the password step
                if (result.reason !== 'INVALID') {
                    delete req.session.pendingOtp;
                    return res.render('pages/login', loginView({ error: message }));
                }

                return res.render('pages/login', loginView({
                    step: 'otp', email: pending.email, otpError: message,
                }));
            }

            const user = await UserModel.getUserByEmail(pending.email);
            delete req.session.pendingOtp;

            await AuthController.establishSession(req, user);
            req.session.save((err) => {
                if (err) return res.redirect('/login');
                AuthController.redirectByRole(res, user.role);
            });

        } catch (err) {
            console.error('[AuthController.verifyOtp]', err);
            res.render('pages/login', loginView({
                error: 'Something went wrong. Please try again.',
            }));
        }
    },

    async resendOtp(req, res) {
        const pending = req.session.pendingOtp;
        if (!pending) return res.redirect('/login');

        try {
            const wait = await OtpModel.secondsUntilResendAllowed(pending.internalId);
            if (wait > 0) {
                return res.render('pages/login', loginView({
                    step: 'otp', email: pending.email,
                    otpError: `Please wait ${wait} second(s) before requesting another code.`,
                }));
            }

            const user = await UserModel.getUserByEmail(pending.email);
            const { code, expiresInMinutes } = await OtpModel.issue(pending.internalId);
            await emailService.sendOtpCode({
                email: user.email, name: user.first_name, code, expiresInMinutes,
            });

            return res.render('pages/login', loginView({
                step: 'otp', email: pending.email,
                otpNotice: 'A new code is on its way.',
            }));

        } catch (err) {
            console.error('[AuthController.resendOtp]', err);
            res.render('pages/login', loginView({
                error: 'Something went wrong. Please try again.',
            }));
        }
    },

    async logout(req, res) {
        try {
            if (req.session?.userId && req.session?.role) {
                const user = await UserModel.getUserByPublicId(req.session.userId);
                if (user) {
                    await AuditLogModel.log(user.internal_id, req.session.role, 'Logged out', 'logout');
                }
            }
        } catch (err) {
            console.error('[AuditLog] Failed to log logout:', err);
        }

        req.session.destroy(() => {
            res.redirect('/login');
        });
    },

    redirectByRole(res, role) {
        res.redirect(HOME_BY_ROLE[role] || '/login');
    },

    async handleGoogleCallback(req, res) {
        // passport already verified the user — req.user is set
        const user = req.user;

        await AuthController.establishSession(req, user);

        req.session.save((err) => {
            if (err) return res.redirect('/login');
            AuthController.redirectByRole(res, user.role);
        });
    },

};

module.exports = AuthController;