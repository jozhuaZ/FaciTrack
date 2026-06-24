const express = require('express');
const router = express.Router();
const { createGoogleAuthURL, verifyGoogleToken, createSession, getRoleRedirect } = require('../services/auth');
const { setSessionCookie } = require('../middleware/auth');
const { readData, withData } = require('../services/data-store');

// ── Google OAuth Routes ──

// Initiate Google OAuth flow
router.get('/google', (req, res) => {
    // Check if Google OAuth is configured
    if (!process.env.GOOGLE_CLIENT_ID) {
        console.warn('[Google OAuth] Client ID not configured. Redirecting to fallback login.');
        return res.redirect('/student/login?error=oauth_not_configured');
    }

    const authURL = createGoogleAuthURL();
    res.redirect(authURL);
});

// Google OAuth callback
router.get('/google/callback', async (req, res) => {
    const { code, error, state } = req.query;

    if (error) {
        console.error('[Google OAuth] Error from Google:', error);
        return res.redirect('/student/login?error=authentication_failed');
    }

    if (!code) {
        return res.redirect('/student/login?error=missing_code');
    }

    // Verify Google token and get user info
    const result = await verifyGoogleToken(code);

    if (!result.success) {
        console.error('[Google OAuth] Verification failed:', result.error);
        return res.redirect(`/student/login?error=${encodeURIComponent(result.error)}`);
    }

    const { email, name, picture } = result;

    // Find or create student user
    const db = readData();
    let user = (db.users || []).find((u) => String(u.email || '').toLowerCase() === email.toLowerCase());

    if (!user) {
        // Auto-create student account
        const newUser = {
            id: Math.max(...(db.users || []).map(u => u.id || 0), 0) + 1,
            name: name || email.split('@')[0],
            email: email.toLowerCase(),
            role: 'student',
            status: 'active',
            studentNo: generateStudentNumber(),
            picture: picture || null,
            createdAt: new Date().toISOString(),
            authProvider: 'google'
        };

        withData((data) => ({
            ...data,
            users: [...(data.users || []), newUser]
        }));

        user = newUser;
        console.log(`[Google OAuth] Created new student account: ${email}`);
    } else if (user.role !== 'student') {
        return res.redirect('/student/login?error=not_a_student_account');
    } else if (user.status !== 'active') {
        return res.redirect('/student/login?error=account_inactive');
    }

    // Create session
    const session = createSession(user, { ip: req.ip, userAgent: req.headers['user-agent'] || '', authMethod: 'google' });
    setSessionCookie(res, session.token);

    console.log(`[Google OAuth] Student logged in: ${email}`);
    res.redirect(getRoleRedirect(user.role));
});

// Generate student number (simple implementation)
function generateStudentNumber() {
    const year = new Date().getFullYear();
    const random = Math.floor(10000 + Math.random() * 90000);
    return `${year}-${random}`;
}

module.exports = router;
