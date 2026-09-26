const pool = require('../configs/db');
const { pushToUser } = require('../realtime/sseRegistry');

function formatRelativeTime(createdAt) {
    const now = Date.now();
    const then = new Date(createdAt).getTime();
    const diffMs = now - then;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    if (days < 7) return days + 'd ago';
    return new Date(createdAt).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
}

const NotificationModel = {
    async create(userId, type, message, relatedAppointmentId = null) {
        const [result] = await pool.execute(
            `INSERT INTO notifications (user_id, type, message, related_appointment_id)
             VALUES (?, ?, ?, ?)`,
            [userId, type, message, relatedAppointmentId]
        );

        pushToUser(userId, 'notification:new', {
            id: result.insertId,
            type,
            message,
            relatedAppointmentId,
            time: 'Just now',
            read: false,
        });

        return result.insertId;
    },

    // For a public_id-based user (student/instructor session)
    async createByPublicId(publicId, type, message, relatedAppointmentId = null) {
        const [[user]] = await pool.execute(
            'SELECT id FROM users WHERE public_id = ?', [publicId]
        );
        if (!user) return;
        await this.create(user.id, type, message, relatedAppointmentId);
    },

    // Unread + first batch of read, shaped for the template
    async getForUser(publicId, readBatchSize = 10) {
        // One round trip: this runs on every page view, and a separate lookup
        // of the internal id would double its cost against a remote database.
        // query() rather than execute(): MySQL's prepared-statement protocol
        // rejects a bound LIMIT parameter (ER_WRONG_ARGUMENTS), where MariaDB
        // accepts it. query() escapes the same params client-side and sends
        // plain SQL, so the integer LIMIT works on both.
        const [rows] = await pool.query(
            `SELECT n.id, n.type, n.message, n.is_read, n.related_appointment_id, n.created_at
         FROM notifications n
         JOIN users u ON u.id = n.user_id
         WHERE u.public_id = ?
         ORDER BY n.is_read ASC, n.created_at DESC
         LIMIT ?`,
            [publicId, 200]
        );

        return rows.map(r => ({
            id: r.id,
            type: r.type,
            message: r.message,
            time: formatRelativeTime(r.created_at),
            read: !!r.is_read,
            relatedAppointmentId: r.related_appointment_id,
        }));
    },

    /**
     * Notifications newer than the last one this client saw.
     *
     * Backs the polling transport, which stands in for the event stream where
     * a host cannot hold a connection open long enough for one — see
     * public/js/realtime.js. Ordered oldest first so a client that missed
     * several replays them in the order they happened, and capped so a tab
     * left open over a weekend cannot ask for an unbounded result.
     */
    async getSince(publicId, afterId = 0, limit = 30) {
        const [[user]] = await pool.execute(
            'SELECT id FROM users WHERE public_id = ?', [publicId]
        );
        if (!user) return [];

        // query() not execute(): MySQL rejects a bound LIMIT; see getForUser.
        const [rows] = await pool.query(
            `SELECT id, type, message, is_read, related_appointment_id, created_at
               FROM notifications
              WHERE user_id = ? AND id > ?
           ORDER BY id ASC
              LIMIT ?`,
            [user.id, Number(afterId) || 0, Number(limit) || 30]
        );

        return rows.map(r => ({
            id: r.id,
            type: r.type,
            message: r.message,
            time: formatRelativeTime(r.created_at),
            read: !!r.is_read,
            relatedAppointmentId: r.related_appointment_id,
        }));
    },

    async getUnreadCount(publicId) {
        const [[user]] = await pool.execute(
            'SELECT id FROM users WHERE public_id = ?', [publicId]
        );
        if (!user) return 0;
        const [[row]] = await pool.execute(
            `SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0`,
            [user.id]
        );
        return row.count;
    },

    async markAllRead(publicId) {
        const [[user]] = await pool.execute(
            'SELECT id FROM users WHERE public_id = ?', [publicId]
        );
        if (!user) return { success: false };
        await pool.execute(
            `UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`,
            [user.id]
        );
        return { success: true };
    },

    async markOneRead(publicId, notificationId) {
        const [[user]] = await pool.execute(
            'SELECT id FROM users WHERE public_id = ?', [publicId]
        );
        if (!user) return { success: false };
        const [result] = await pool.execute(
            `UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`,
            [notificationId, user.id]
        );
        return { success: result.affectedRows > 0 };
    },

    async clearRead(publicId) {
        const [[user]] = await pool.execute(
            'SELECT id FROM users WHERE public_id = ?', [publicId]
        );
        if (!user) return { success: false };
        await pool.execute(
            `DELETE FROM notifications WHERE user_id = ? AND is_read = 1`,
            [user.id]
        );
        return { success: true };
    },

    // Pagination for "Load more" — read notifications only, offset-based
    async getMoreRead(publicId, offset, limit = 10) {
        const [[user]] = await pool.execute(
            'SELECT id FROM users WHERE public_id = ?', [publicId]
        );
        if (!user) return [];
        // query() not execute(): MySQL rejects bound LIMIT/OFFSET; see getForUser.
        const [rows] = await pool.query(
            `SELECT id, type, message, is_read, created_at, related_appointment_id
         FROM notifications
         WHERE user_id = ? AND is_read = 1
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
            [user.id, Number(limit) || 10, Number(offset) || 0]
        );
        return rows.map(r => ({
            id: r.id,
            type: r.type,
            message: r.message,
            time: formatRelativeTime(r.created_at),
            read: true,
            relatedAppointmentId: r.related_appointment_id,
        }));
    }
};

module.exports = NotificationModel;