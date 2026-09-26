const path = require('path');
const fs = require('fs/promises');
const pool = require('../configs/db');

/**
 * Where uploaded files live.
 *
 * One API over two places, because the right answer depends on the host.
 *
 *  - disk: files under storage/uploads/, the way this has always worked.
 *    Right for a server with a disk, and the faster of the two.
 *  - db:   bytes in the stored_files table. Right for a serverless host,
 *    whose filesystem is read-only apart from a scratch directory thrown away
 *    between invocations — there, a written file is gone by the next request.
 *
 * Callers address a file by key ("avatars/<uuid>.jpg"), never by a filesystem
 * path, so nothing above this layer knows or cares which driver is in use.
 */

const STORAGE_ROOT = path.join(__dirname, '..', 'storage', 'uploads');

// Serverless has no durable disk, so default accordingly. FILE_STORE overrides
// it — useful for exercising the database driver locally before deploying.
const DRIVER = process.env.FILE_STORE || (process.env.VERCEL ? 'db' : 'disk');

/**
 * A key is a folder and a filename we generated, and nothing else.
 *
 * Keys reach here from database columns, and one of those columns is filled
 * from a request. Without this, a stored value of "../../.env" would resolve
 * outside the storage root and hand out whatever it found.
 */
const KEY = /^[a-z]+\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertKey(key) {
    if (typeof key !== 'string' || !KEY.test(key) || key.includes('..')) {
        throw new Error(`Refusing to use an unsafe storage key: ${key}`);
    }
    return key;
}

const diskDriver = {
    async put({ key, buffer }) {
        const full = path.join(STORAGE_ROOT, assertKey(key));
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, buffer);
        return key;
    },

    async get(key) {
        const full = path.join(STORAGE_ROOT, assertKey(key));
        try {
            const buffer = await fs.readFile(full);
            return { buffer, mimeType: null, originalName: null, size: buffer.length };
        } catch (err) {
            if (err.code === 'ENOENT') return null;
            throw err;
        }
    },

    async remove(key) {
        // Best effort: a failed delete costs disk space, not correctness.
        await fs.unlink(path.join(STORAGE_ROOT, assertKey(key))).catch(() => {});
    },
};

/**
 * How much of a file goes in one row.
 *
 * Every statement has to fit inside the server's max_allowed_packet, which the
 * application does not control and cannot rely on: this project's own MariaDB
 * ships with 1 MB, so a 10 MB make-up document failed with
 * ER_NET_PACKET_TOO_LARGE and took the connection down with it. 256 KB stays
 * well inside even that, leaving room for the protocol's own overhead, and a
 * reader streams rows rather than materialising the result set at once — so
 * this is what a file may be, not what a server must be configured to allow.
 */
const CHUNK_BYTES = Number(process.env.FILE_STORE_CHUNK_BYTES) || 256 * 1024;

/**
 * Create the tables this driver needs, once per process.
 *
 * They live in their own migrations, which are easy to miss on a fresh
 * database — and then every upload fails with "table doesn't exist" and
 * nothing more. The session store creates its own table for the same reason.
 * IF NOT EXISTS makes this a no-op wherever the migrations already ran, and the
 * SQL avoids MariaDB-only syntax so it works on MySQL (Aiven) too.
 */
let tablesReady = null;
function ensureTables() {
    if (!tablesReady) {
        tablesReady = (async () => {
            await pool.query(`CREATE TABLE IF NOT EXISTS stored_files (
                file_key      VARCHAR(255) NOT NULL,
                kind          VARCHAR(32)  NOT NULL,
                mime_type     VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
                original_name VARCHAR(255) NULL,
                byte_size     INT UNSIGNED NOT NULL DEFAULT 0,
                created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (file_key),
                INDEX idx_stored_files_kind (kind, created_at)
            )`);
            await pool.query(`CREATE TABLE IF NOT EXISTS stored_file_chunks (
                file_key    VARCHAR(255) NOT NULL,
                chunk_index INT UNSIGNED NOT NULL,
                data        MEDIUMBLOB   NOT NULL,
                PRIMARY KEY (file_key, chunk_index),
                CONSTRAINT fk_chunk_file FOREIGN KEY (file_key)
                    REFERENCES stored_files (file_key) ON DELETE CASCADE
            )`);
        })().catch((err) => {
            tablesReady = null;   // let the next request try again
            throw err;
        });
    }
    return tablesReady;
}

const dbDriver = {
    async put({ key, buffer, mimeType, originalName, kind }) {
        assertKey(key);
        await ensureTables();

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // Replacing a key means the old chunks must go first, or a shorter
            // file would keep the tail of the one it replaced.
            await conn.execute('DELETE FROM stored_files WHERE file_key = ?', [key]);
            await conn.execute(
                `INSERT INTO stored_files (file_key, kind, mime_type, original_name, byte_size)
                 VALUES (?, ?, ?, ?, ?)`,
                [key, kind || key.split('/')[0], mimeType || 'application/octet-stream',
                 originalName || null, buffer.length]
            );

            for (let i = 0, index = 0; i < buffer.length; i += CHUNK_BYTES, index++) {
                await conn.execute(
                    'INSERT INTO stored_file_chunks (file_key, chunk_index, data) VALUES (?, ?, ?)',
                    [key, index, buffer.subarray(i, i + CHUNK_BYTES)]
                );
            }

            // A zero-byte upload still gets one row, so a file that exists but
            // is empty reads back as empty rather than as missing.
            if (buffer.length === 0) {
                await conn.execute(
                    'INSERT INTO stored_file_chunks (file_key, chunk_index, data) VALUES (?, ?, ?)',
                    [key, 0, Buffer.alloc(0)]
                );
            }

            await conn.commit();
            return key;
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    },

    async get(key) {
        assertKey(key);
        await ensureTables();
        const [rows] = await pool.execute(
            'SELECT mime_type, original_name, byte_size FROM stored_files WHERE file_key = ?',
            [key]
        );
        if (!rows.length) return null;
        const meta = rows[0];

        const [chunks] = await pool.execute(
            'SELECT data FROM stored_file_chunks WHERE file_key = ? ORDER BY chunk_index ASC',
            [key]
        );

        return {
            buffer: Buffer.concat(chunks.map(c => c.data)),
            mimeType: meta.mime_type,
            originalName: meta.original_name,
            size: meta.byte_size,
        };
    },

    async remove(key) {
        assertKey(key);
        await ensureTables();
        // The chunks go with it: the foreign key cascades.
        await pool.execute('DELETE FROM stored_files WHERE file_key = ?', [key]);
    },
};

const driver = DRIVER === 'db' ? dbDriver : diskDriver;

/**
 * Read a file that predates this layer.
 *
 * Rows written before the switch hold an absolute filesystem path rather than
 * a key. On a host that still has those files, returning them is better than
 * showing an instructor that a document they uploaded has vanished. Nothing
 * new is ever written in this shape.
 */
async function getLegacyPath(absolutePath) {
    if (!absolutePath || !path.isAbsolute(absolutePath)) return null;
    // Only ever inside the storage root — the column is data, not a licence to
    // read arbitrary files.
    const resolved = path.resolve(absolutePath);
    if (!resolved.startsWith(path.resolve(STORAGE_ROOT))) return null;
    try {
        const buffer = await fs.readFile(resolved);
        return { buffer, mimeType: null, originalName: path.basename(resolved), size: buffer.length };
    } catch {
        return null;
    }
}

module.exports = {
    driver: DRIVER,
    put: (opts) => driver.put(opts),
    /** Returns null when the file is not there, rather than throwing. */
    get: (key) => driver.get(key),
    remove: (key) => driver.remove(key),
    getLegacyPath,
    STORAGE_ROOT,
};
