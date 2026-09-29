const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

/**
 * The connection pool.
 *
 * Two things here exist only because the app can run somewhere other than a
 * developer's laptop: TLS, and a pool sized for the host rather than for one
 * long-lived process.
 */

/**
 * TLS for a managed database.
 *
 * Aiven refuses plaintext connections outright, so without this every query
 * fails and the whole app renders the "cannot reach its database" page.
 *
 * Aiven hands you a CA certificate. Point DB_SSL_CA at the file, or paste its
 * contents into DB_SSL_CA_CERT when the host has no writable disk to put a
 * file on — Vercel being exactly that case. Verification stays on in both:
 * turning it off would accept any certificate and quietly undo the point of
 * connecting over TLS at all.
 */
function buildSslOptions() {
    if (process.env.DB_SSL === 'false') return undefined;

    const inlineCert = process.env.DB_SSL_CA_CERT;
    if (inlineCert && inlineCert.trim()) {
        // Environment variables flatten newlines; the PEM needs them back.
        return { ca: inlineCert.replace(/\\n/g, '\n'), rejectUnauthorized: true };
    }

    const caPath = process.env.DB_SSL_CA;
    if (caPath) {
        const resolved = path.isAbsolute(caPath) ? caPath : path.join(__dirname, '..', caPath);
        try {
            return { ca: fs.readFileSync(resolved, 'utf8'), rejectUnauthorized: true };
        } catch (err) {
            console.error(`[DB] DB_SSL_CA points at ${resolved}, which could not be read: ${err.message}`);
            throw err;   // failing loudly beats falling back to an unverified connection
        }
    }

    // TLS was asked for without a CA. Node then checks against its built-in
    // roots, which is right for a provider using a public certificate and
    // wrong for Aiven's own CA — so say so rather than let it fail obscurely.
    if (process.env.DB_SSL === 'true') {
        console.warn('[DB] DB_SSL is on but no CA was given. Set DB_SSL_CA or DB_SSL_CA_CERT if your provider uses a private CA (Aiven does).');
        return { rejectUnauthorized: true };
    }

    return undefined;
}

/**
 * How many connections one instance may hold.
 *
 * On a single server, ten is a sensible pool. Serverless changes the sum:
 * every warm instance keeps its own pool, so the database sees
 * connectionLimit × instances, and a managed plan's connection cap — in the
 * low tens on the smaller Aiven plans — is reached by a handful of concurrent
 * visitors. Small pools per instance are what keep that total survivable.
 */
const DEFAULT_POOL = process.env.VERCEL ? 2 : 10;
const connectionLimit = Number(process.env.DB_POOL_SIZE) || DEFAULT_POOL;

/**
 * The SQL mode every connection runs under.
 *
 * The app was written and tested against MariaDB, whose default mode is
 * lenient in two ways MySQL 8 is not, and Aiven runs MySQL:
 *
 *  - ONLY_FULL_GROUP_BY: MySQL rejects a GROUP BY that selects a column not
 *    functionally dependent on the grouping key (the instructor directory does
 *    exactly this, picking one upcoming slot per instructor). MariaDB allows
 *    it. Without this line that query throws ER_WRONG_FIELD_WITH_GROUP.
 *  - ANSI_QUOTES: MySQL then reads "text" as a column name, not a string.
 *
 * STRICT_TRANS_TABLES stays — MariaDB is strict about bad data too, and
 * dropping it would let truncation pass silently. This only relaxes the two
 * differences that are behaviour, not integrity, so the database behaves the
 * same in both places. DB_SQL_MODE overrides it if a deployment needs to.
 */
const SESSION_SQL_MODE =
    process.env.DB_SQL_MODE ||
    'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

const pool = mysql.createPool({
  host: process.env.DB_HOSTNAME,
  port: process.env.DB_PORT,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: buildSslOptions(),
  waitForConnections: true,
  connectionLimit,
  queueLimit: 0,
  // A pooled connection that outlives the instance holding it is a connection
  // the database counts and nobody can use.
  idleTimeout: 30000,
  enableKeepAlive: true,
  dateStrings: true
});

/**
 * The clock every connection runs on.
 *
 * Consultation dates and times are stored as Manila wall-clock values, and
 * dozens of queries compare them with NOW(). A laptop's MariaDB runs on the
 * machine's zone (+08:00), so that worked locally — but Aiven runs on UTC,
 * which put NOW() eight hours behind every slot. The visible symptom was a
 * 409 when completing a consultation that had just ended: the page (browser
 * clock) offered Complete, the database said it had not ended yet. Reminders,
 * expiry and nudges were all eight hours late the same way.
 *
 * Manila has no daylight saving, so a fixed offset is exact and needs no
 * timezone tables on the server. DB_TIME_ZONE overrides it.
 */
const SESSION_TIME_ZONE = process.env.DB_TIME_ZONE || '+08:00';

// Applied once per physical connection, before the pool hands it out. Both
// values are checked against a strict pattern, never user input, so they are
// safe to inline.
const sessionSettings = [];
if (/^[A-Z_,]*$/.test(SESSION_SQL_MODE)) {
    sessionSettings.push(`sql_mode = '${SESSION_SQL_MODE}'`);
} else {
    console.error(`[DB] DB_SQL_MODE contains unexpected characters and was ignored: ${SESSION_SQL_MODE}`);
}
if (/^[+-]\d{2}:\d{2}$/.test(SESSION_TIME_ZONE)) {
    sessionSettings.push(`time_zone = '${SESSION_TIME_ZONE}'`);
} else {
    console.error(`[DB] DB_TIME_ZONE must look like +08:00 and was ignored: ${SESSION_TIME_ZONE}`);
}
if (sessionSettings.length) {
    pool.on('connection', (conn) => {
        conn.query(`SET SESSION ${sessionSettings.join(', ')}`, (err) => {
            if (err) console.error('[DB] Could not apply session settings:', err.message);
        });
    });
}

module.exports = pool;
