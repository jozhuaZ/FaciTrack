
const NotificationModel = require('../models/NotificationModel');

async function attachNotifications(req, res, next) {
    if (req.session?.userId && req.session?.role) {
        try {
            res.locals.notifications = await NotificationModel.getForUser(req.session.userId);
        } catch (err) {
            console.error('[attachNotifications]', err);
            res.locals.notifications = [];
        }
    }
    next();
}

module.exports = attachNotifications;