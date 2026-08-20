const express = require('express');
const router = express.Router();
const AuthController = require('../controllers/AuthController');
const passport = require('passport');

router.get('/', (req, res) => {
    res.render('pages/index', {
        title: 'FaciTrack - Login',
        error: null
    });
});
router.get('/login', AuthController.renderLogin);
router.post('/login', AuthController.login);
router.get('/logout', AuthController.logout);

// Google OAuth routes
router.get('/auth/google', 
    passport.authenticate('google', {
        scope: ['profile', 'email'],
        prompt: 'select_account'
    })
);

router.get('/auth/google/callback',
    passport.authenticate('google', {
        failureRedirect: '/login',
        failureMessage: true
    }),
    AuthController.handleGoogleCallback
);

module.exports = router;