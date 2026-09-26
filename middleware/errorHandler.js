const crypto = require('crypto');

/**
 * The last stop for anything that went wrong.
 *
 * Replaces a handler that answered every failure with raw JSON, which meant a
 * browser showed `{"status":"error","message":"connect ECONNREFUSED..."}` on
 * screen whenever MySQL was down — and printed the internals of the failure to
 * whoever was looking.
 *
 * Two things it decides: what kind of failure this is, and who is asking.
 */

/**
 * mysql2 / Node socket codes that mean "the database is not reachable", as
 * opposed to "the query was wrong".
 *
 * The distinction is what the reader is told. Unreachable is temporary and
 * nobody's fault, so the page says wait and try again. Anything else is a
 * defect, and promising it will fix itself would be a lie.
 */
const UNAVAILABLE_CODES = new Set([
    'ECONNREFUSED',           // nothing listening — MySQL stopped
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENOTFOUND',              // DB_HOSTNAME does not resolve
    'EPIPE',
    'ECONNRESET',
    'PROTOCOL_CONNECTION_LOST',
    'PROTOCOL_SEQUENCE_TIMEOUT',
    'ER_CON_COUNT_ERROR',     // server up, but out of connections
    'POOL_CLOSED',
    'POOL_ENQUEUELIMIT',
]);

function isDatabaseUnavailable(err) {
    if (!err) return false;
    if (UNAVAILABLE_CODES.has(err.code)) return true;
    // mysql2 wraps the original in `.cause` on some paths
    if (err.cause && UNAVAILABLE_CODES.has(err.cause.code)) return true;
    // Access denied and unknown-database are configuration faults, but from a
    // reader's point of view they are the same thing: no data available.
    return err.code === 'ER_ACCESS_DENIED_ERROR' || err.code === 'ER_BAD_DB_ERROR';
}

/**
 * Does this caller want a page, or JSON?
 *
 * fetch() and XHR get JSON so their own error handling keeps working; a
 * browser navigating to a URL gets the page. The 404 handler in app.js calls
 * this same function, so the two cannot answer one caller differently.
 *
 * Sec-Fetch-Dest on its own is not enough to rule a navigation out. Installed
 * as a PWA, the service worker re-issues the navigation through fetch(), and
 * it arrives with Sec-Fetch-Dest: empty even though it is still a browser
 * asking for a page. Reading that as "not a document" is what put raw JSON on
 * screen when the database went down. The Accept header survives the detour,
 * so it is what decides.
 */
function wantsHtml(req) {
    // An explicit XHR is never after a page.
    if (req.xhr) return false;
    if (req.get('X-Requested-With') === 'XMLHttpRequest') return false;

    // A plain navigation says so outright.
    if (req.get('Sec-Fetch-Dest') === 'document') return true;

    // Listing json first means a caller stating no preference — Accept: */*,
    // which is what a bare fetch() sends — resolves to json, while one that
    // ranks text/html above it gets the page. Only a browser sends that
    // ranking, so an API call cannot be mistaken for a navigation.
    const preferred = req.accepts(['json', 'html']);
    if (preferred) return preferred === 'html';

    // Accepts nothing we can produce. The page reads fine either way.
    return true;
}

// Vercel does not reliably set NODE_ENV=production for a custom Express app
// unless it is configured to — process.env.VERCEL is set on every request it
// serves regardless, so it is the more trustworthy signal that this is a
// hosted deployment rather than a developer's own machine.
function buildErrorHandler({ isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL) } = {}) {
    return function errorHandler(err, req, res, next) {
        // A reference the reader can quote and the log can be grepped for,
        // so support does not depend on them describing what they saw.
        const reference = crypto.randomBytes(4).toString('hex');
        const unavailable = isDatabaseUnavailable(err);
        const status = err.status || (unavailable ? 503 : 500);

        console.error(`[Error ${reference}] ${req.method} ${req.originalUrl} -> ${status}`);
        console.error(`[Error ${reference}] ${err.code ? err.code + ': ' : ''}${err.message}`);
        if (err.stack) console.error(err.stack);

        // Headers already sent means a response was half-written when this
        // blew up; there is nothing left to render into.
        if (res.headersSent) return next(err);

        const heading = unavailable ? 'Service Temporarily Unavailable' : 'Something Went Wrong';
        const message = unavailable
            ? 'FaciTrack cannot reach its database at the moment, so this page has nothing to show.'
            : 'We hit an unexpected problem loading this page. It has been logged.';

        if (!wantsHtml(req)) {
            return res.status(status).json({
                status: 'error',
                // The client is told what kind of failure it was, never the
                // internals of it.
                code: unavailable ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR',
                message,
                reference,
            });
        }

        res.status(status).render('pages/error', {
            title: unavailable ? 'Service Unavailable' : 'Error',
            heading,
            message,
            unavailable,
            reference,
            // Only outside production. In production this would hand a visitor
            // the database host, the SQL, or why a credential was rejected.
            detail: isProduction ? null : [err.code, err.message].filter(Boolean).join(': '),
        }, (renderErr, html) => {
            if (!renderErr) return res.send(html);

            // The error page itself failed. Say so plainly rather than
            // recursing into this handler and looping.
            console.error(`[Error ${reference}] The error page could not render:`, renderErr.message);
            res.type('text/plain').send(
                `${heading}\n\n${message}\n\nReference: ${reference}`
            );
        });
    };
}

module.exports = buildErrorHandler;
module.exports.isDatabaseUnavailable = isDatabaseUnavailable;
module.exports.wantsHtml = wantsHtml;
module.exports.UNAVAILABLE_CODES = UNAVAILABLE_CODES;
