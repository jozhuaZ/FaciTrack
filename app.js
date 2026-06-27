// Import required modules
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { ensureSeedUsers } = require('./services/auth');
const { authContext, requireRole } = require('./middleware/auth');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;
ensureSeedUsers(); // remove soon

// Set EJS as templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware: Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Middleware: Parse URL-encoded bodies (form data)
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Middleware: Parse JSON bodies
app.use(express.json({ limit: '10mb' }));
app.use(authContext);

// Security: Basic headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// Middleware: Global logging
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        maxAge: 1000 * 60 * 60 * 8
    },
}));

// Routes 
// app.use('/', require('./routes/index'));
app.use('/', require('./routes/auth'));
app.use('/auth', require('./routes/oauth')); // Google OAuth routes
app.use('/student', require('./routes/student'));
app.use('/instructor', requireRole('Instructor'), require('./routes/instructor'));
app.use('/export', require('./routes/export'));
app.use('/dean', require('./routes/dean'));
app.use('/admin', require('./routes/admin'));
app.use('/superadmin', require('./routes/superadmin'));
app.use('/', require('./routes/display'));

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(`[Error Log]: ${err.message}`);
    console.error('URL:', req.url);
    console.error('Method:', req.method);
    console.error('Stack:', err.stack);

    const statusCode = err.status || 500;

    res.status(statusCode).json({
        status: 'error',
        message: err.message
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 FaciTrack server running on http://localhost:${PORT}`);
});
