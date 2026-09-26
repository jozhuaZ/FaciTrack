const NotificationModel = require('../models/NotificationModel');

/**
 * Supplies `notifications` to every rendered page (the bell and its panel).
 *
 * Only a rendered page needs them, so JSON calls and polls never pay for the
 * query. For a browser navigation the query starts here and runs alongside the
 * route's own queries; res.render waits for it only at the end. Awaiting it up
 * front used to add a full database round trip to every request.
 */
function attachNotifications(req, res, next) {
    if (!req.session?.userId || !req.session?.role) return next();

    let pending = null;
    const load = () => pending || (pending = NotificationModel.getForUser(req.session.userId)
        .catch((err) => {
            console.error('[attachNotifications]', err);
            return [];
        }));

    // A browser navigation asks for HTML; fetch() and polls ask for */* or JSON.
    if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) load();

    const originalRender = res.render.bind(res);
    res.render = function (view, options, callback) {
        if (typeof options === 'function') { callback = options; options = {}; }
        // A controller that passes its own list has already done the work.
        if (options && options.notifications !== undefined) {
            return originalRender(view, options, callback);
        }
        load().then((list) => {
            res.locals.notifications = list;
            originalRender(view, options, callback);
        });
    };
    next();
}

module.exports = attachNotifications;
