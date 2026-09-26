// middlewares/auditNavigation.js
const pool = require('../configs/db');

function auditNavigation(req, res, next) {
    const originalRender = res.render.bind(res);
    res.render = function (view, options, callback) {
        if (req.session?.userId && req.session?.role) {
            logNavigation(req).catch(err => console.error('[AuditLog] Nav log failed:', err));
        }
        return originalRender(view, options, callback);
    };
    next();
}

// A single INSERT ... SELECT: this runs beside every page render and shares a
// small connection pool with it, so a separate id lookup was a second query
// competing with the page for a connection.
async function logNavigation(req) {
    await pool.execute(
        `INSERT INTO audit_logs (user_id, role, action, type)
         SELECT id, ?, ?, 'navigation' FROM users WHERE public_id = ?`,
        [req.session.role, `Viewed ${req.path}`, req.session.userId]
    );
}

module.exports = auditNavigation;