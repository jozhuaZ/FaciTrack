const express = require('express');
const router = express.Router();
const { authenticateUser, createSession, getRoleRedirect, revokeSession } = require('../services/auth');
const { setSessionCookie, clearSessionCookie } = require('../middleware/auth');

// Landing page
router.get('/', (req, res) => {
    const errorMessages = {
        'oauth_not_configured': 'Google Sign-In is not configured. Please use email/password login.',
        'authentication_failed': 'Authentication failed. Please try again.',
        'missing_code': 'Authentication code missing. Please try again.',
        'not_a_student_account': 'This account is not registered as a student.',
        'account_inactive': 'Your account is inactive. Please contact support.'
    };
    const errorParam = req.query.error;
    const errorMessage = errorParam ? errorMessages[errorParam] || 'An error occurred. Please try again.' : null;

    res.render('pages/index', { 
        title: 'FaciTrack - Faculty Appointment & Monitoring System',
        error: errorMessage
    });
});

// Unified login page
router.get('/login', (req, res) => {
    res.render('pages/login', {
        title: 'FaciTrack - Login',
        error: null
    });
});

// Unified login POST — detect role from credentials and redirect
// PROTOTYPE MODE: Password verification disabled for development
router.post('/login', (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.render('pages/index', {
            title: 'FaciTrack - Login',
            error: 'Please enter your email address.'
        });
    }

    const emailLower = email.trim().toLowerCase();

    // PROTOTYPE MODE: Accept any email without password verification
    // Find user by email
    const db = require('../services/data-store').readData();
    let user = (db.users || []).find((u) => String(u.email || '').toLowerCase() === emailLower);
    
    if (user) {
        const session = createSession(user, {
            ip: req.ip,
            userAgent: req.headers['user-agent'] || ''
        });
        setSessionCookie(res, session.token);
        return res.redirect(getRoleRedirect(user.role));
    }

    return res.render('pages/index', {
        title: 'FaciTrack - Login',
        error: 'User not found. Please check your email address.'
    });
});

router.post('/logout', (req, res) => {
    if (req.authToken) revokeSession(req.authToken);
    clearSessionCookie(res);
    return res.redirect('/login');
});
router.get('/logout', (req, res) => {
    if (req.authToken) revokeSession(req.authToken);
    clearSessionCookie(res);
    return res.redirect('/login');
});

// Backward compatibility — redirect old /roles to home
router.get('/roles', (req, res) => {
    res.redirect('/');
});

module.exports = router;
