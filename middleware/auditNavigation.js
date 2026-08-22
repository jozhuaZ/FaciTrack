// middlewares/auditNavigation.js
const pool = require('../configs/db');
const AuditLogModel = require('../models/AuditLogModel');

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

async function logNavigation(req) {
    const [[user]] = await pool.execute(
        'SELECT id FROM users WHERE public_id = ?', [req.session.userId]
    );
    if (!user) return;
    await AuditLogModel.log(user.id, req.session.role, `Viewed ${req.path}`, 'navigation');
}

module.exports = auditNavigation;