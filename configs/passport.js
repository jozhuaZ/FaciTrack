const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const UserModel      = require('../models/UserModel');

const ALLOWED_FACULTY_DOMAIN  = 'cspc.edu.ph';
const ALLOWED_STUDENT_DOMAIN  = 'my.cspc.edu.ph';

passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  process.env.GOOGLE_CALLBACK_URL,
}, async (accessToken, refreshToken, profile, done) => {
    try {
        const email  = profile.emails?.[0]?.value;
        if (!email) return done(null, false, { message: 'No email returned from Google.' });

        const domain = email.split('@')[1];

        // Only allow institutional domains
        if (domain !== ALLOWED_FACULTY_DOMAIN && domain !== ALLOWED_STUDENT_DOMAIN) {
            return done(null, false, {
                message: 'Only CSPC institutional emails are allowed.',
            });
        }

        const isStudent = domain === ALLOWED_STUDENT_DOMAIN;

        // Try to find existing user
        let user = await UserModel.getUserByEmail(email);

        if (!user) {
            if (isStudent) {
                // Auto-provision student accounts on first OAuth login
                const { v4: uuidv4 } = require('uuid');
                const newId = await UserModel.insertUserByOAuth({
                    firstName:      profile.name?.givenName  || '',
                    lastName:       profile.name?.familyName || '',
                    email,
                    role:           'Student',
                    status:         'Active',
                });
                user = await UserModel.getUserById(newId);
                await UserModel.updateLastLogin(newId);
            } else {
                // Faculty must be pre-registered by admin — don't auto-create
                return done(null, false, {
                    message: 'Faculty account not found. Please contact the administrator.',
                });
            }
        }

        if (user.status !== 'Active') {
            return done(null, false, { message: 'Your account is inactive.' });
        }

        return done(null, user);
    } catch (err) {
        return done(err);
    }
}));

passport.serializeUser((user, done) => {
    done(null, user.id); // stores public_id in session
});

passport.deserializeUser(async (publicId, done) => {
    try {
        const user = await UserModel.getUserByPublicId(publicId);
        done(null, user);
    } catch (err) {
        done(err);
    }
});

module.exports = passport;