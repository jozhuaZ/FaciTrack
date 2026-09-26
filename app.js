// Import required modules
require('dotenv').config();
require('./configs/checkEnv')();
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const path = require('path');
const pool = require('./configs/db');
const { requireRole } = require('./middleware/auth');
const attachNotifications = require('./middleware/attachNotifications');
const auditNavigation = require('./middleware/auditNavigation');
const passport = require('./configs/passport');
const startReminderJob = require('./jobs/reminder');
const startCalendarSyncJob = require('./jobs/calendar-sync');
const startPresenceSweepJob = require('./jobs/presence-sweep');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Serverless hosts set this. It marks the places where one long-lived process
// cannot be assumed: background timers, on-disk writes, open connections.
const IS_SERVERLESS = Boolean(process.env.VERCEL);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 1000 * 60 * 60 * 8;


// Set EJS as templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Behind a tunnel or reverse proxy (ngrok in testing, whatever CSPC puts in
// front of this later), the real scheme arrives in X-Forwarded-Proto. Without
// this, req.protocol reports "http" on an https request and anything built
// from it — the OAuth callback especially — comes out wrong.
app.set('trust proxy', 1);

/**
 * The ?v= stamp on every stylesheet and script tag.
 *
 * It used to be Date.now() on every render, which gave each asset a new URL
 * on every page view: the browser and the service worker could never reuse a
 * copy, so every page downloaded all of its CSS and JS again (and the service
 * worker kept storing another copy each time). In production the stamp is now
 * fixed per deployment, so a copy is reused until the next deploy changes it.
 * Locally it still changes per render, so edited CSS shows on a plain reload.
 */
app.locals.assetVersion = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 8)
    || String(Date.now());
if (!IS_PRODUCTION && !IS_SERVERLESS) {
    app.use((req, res, next) => { res.locals.assetVersion = Date.now(); next(); });
}

// Middleware: Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Middleware: Parse URL-encoded bodies (form data)
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Middleware: Parse JSON bodies
app.use(express.json({ limit: '10mb' }));

// Security: Basic headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

/**
 * Reachability probe for public/js/connection-status.js.
 *
 * Mounted above the session, logging and notification middleware so that
 * polling it costs nothing and writes no log noise. It deliberately does not
 * touch the database: this answers "can the browser reach the server", and
 * folding a database check in here would report the whole app as offline over
 * a problem the user cannot do anything about from a phone.
 */
app.get('/ping', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(204).end();
});

// Middleware: Global logging
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

/**
 * Where sessions live.
 *
 * express-session defaults to an in-memory store, which works only while one
 * process serves every request. It does not survive a restart, and on a
 * serverless host it does not survive at all: each invocation may run on a
 * different instance with its own empty memory, so a signed-in tester is
 * signed out again on their next click. It presents as "login is broken".
 *
 * The sessions table lives in the same database as everything else, so there
 * is one thing to back up and one thing that can be down.
 */
const sessionStore = new MySQLStore({
    createDatabaseTable: true,
    // Sweep expired rows rather than letting the table grow without bound.
    clearExpired: true,
    checkExpirationInterval: 1000 * 60 * 15,
    expiration: SESSION_TTL_MS,
    // A touch is an UPDATE on every request, and express-session holds the
    // response open until it finishes. It buys nothing here: the cookie is not
    // rolling, so it expires SESSION_TTL_MS after sign-in whatever the row says.
    disableTouch: true,
    schema: {
        tableName: 'sessions',
        columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' },
    },
}, pool);

sessionStore.onReady().catch((err) => {
    console.error('[Session] The session store could not start:', err.message);
});

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
        // Production is served over HTTPS, so the cookie should refuse to
        // travel any other way. Left off locally, where there is no TLS and a
        // secure cookie would simply never be sent.
        secure: IS_PRODUCTION,
        httpOnly: true,
        sameSite: 'lax',
        maxAge: SESSION_TTL_MS
    },
}));
app.use(passport.initialize());
app.use(passport.session());

// Middleware: notifications
app.use(attachNotifications);
// Middleware: audit navigations
app.use(auditNavigation);

/**
 * Background work.
 *
 * node-cron and setInterval both need a process that is still there when the
 * timer fires. A serverless instance is torn down once it goes idle, so these
 * would never run — and starting them would only produce cold-start noise and
 * connections nobody closes. There, the same work is driven by HTTP instead;
 * see routes/tasks.js and the schedule in vercel.json.
 *
 * PRESENCE_SWEEP_ENABLED exists separately because the BLE module can be
 * switched off for a deployment that has no scanners, and its absence sweep is
 * the one job that does nothing useful without them.
 */
if (!IS_SERVERLESS) {
    startReminderJob();
    startCalendarSyncJob();

    // Absence is a timeout, and it has to keep running when every scanner is
    // off — which is exactly when somebody would otherwise be left parked in
    // a room.
    if (process.env.PRESENCE_SWEEP_ENABLED !== 'false') startPresenceSweepJob();
} else {
    console.log('[Jobs] Serverless host detected — scheduled work runs over HTTP via /tasks (see vercel.json).');
}

// Routes 
// app.use('/', require('./routes/index'));
app.use('/', require('./routes/auth'));
app.use('/notifications', require('./routes/notification'));
// Token-authenticated, so it sits above the role guards — calendar clients
// subscribe with no session. See routes/calendar-feed.js.
app.use('/calendar', require('./routes/calendar-feed'));
// Scheduled work for hosts with no long-lived process. Carries its own shared
// secret rather than a session, so it sits above the role guards.
// See routes/tasks.js.
app.use('/tasks', require('./routes/tasks'));
// Shared-secret authenticated: the BLE room scanners are devices with no
// session, so this also sits above the role guards. See routes/presence.js.
app.use('/api/presence', require('./routes/presence'));
// The Faculty Lounge board: a screen on a wall, so no session either. It
// publishes a name, In or Out, and the availability the instructor set —
// never a room. See routes/display.js.
app.use('/display', require('./routes/display'));
// Profile photos: authenticated, but the same for every role — the sidebar
// avatar is one shared control — so this sits above the per-role mounts.
app.use('/', require('./routes/profile'));
// Who is in. Read by every role's pages, scoped to the viewer's department,
// so one answer serves them all. See routes/presence-view.js.
app.use('/', require('./routes/presence-view'));
app.use('/student', requireRole('Student'), require('./routes/student'));
app.use('/instructor', requireRole('Instructor'), require('./routes/instructor'));
app.use('/export', require('./routes/export'));
app.use('/dean', requireRole('Dean'), require('./routes/dean'));
app.use('/admin', requireRole('Admin'), require('./routes/admin'));
app.use('/superadmin', require('./routes/superadmin'));
// 404: nothing above matched. Answer fetch/XHR callers with JSON, browsers with
// the page — using the error handler's test so the two agree on who is asking.
app.use((req, res) => {
    const wantsHtml = require('./middleware/errorHandler').wantsHtml(req);

    /**
     * Recover a mishandled login redirect.
     *
     * After login the server answers with a 302 to a dashboard, which the
     * browser follows as a GET. An out-of-date service worker instead resolves
     * that redirect itself and re-issues it as a POST, so a signed-in user
     * lands on POST /<role>/dashboard — a path with only a GET route — and sees
     * a 404 until they reload. The worker is fixed, but an installed PWA keeps
     * running the copy it already has, so this makes the server resilient on
     * its own: a non-GET page navigation from a signed-in session is sent back
     * to the same URL as a GET (303), which is what should have happened.
     */
    if (req.method !== 'GET' && wantsHtml && req.session?.userId) {
        return res.redirect(303, req.originalUrl);
    }

    if (wantsHtml) {
        return res.status(404).render('pages/404', {
            title: 'FaciTrack - Page Not Found',
            role: req.session?.role || null,
            requestedPath: req.originalUrl,
        });
    }
    res.status(404).json({ status: 'error', message: 'Not found' });
});

// Error handling middleware. Renders a page for browsers and JSON for fetch
// callers, and tells "the database is unreachable" apart from "this broke".
// See middleware/errorHandler.js.
app.use(require('./middleware/errorHandler')());

/**
 * Start listening — but only where a port means something.
 *
 * A serverless host imports this module and calls the exported handler per
 * request; binding a port there either fails or holds the instance open for
 * nothing. Exporting the app keeps both shapes working from one file.
 */
if (!IS_SERVERLESS) {
    app.listen(PORT, () => {
        console.log(`🚀 FaciTrack server running on http://localhost:${PORT}`);
    });
}

module.exports = app;
