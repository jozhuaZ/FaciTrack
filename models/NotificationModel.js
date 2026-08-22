const pool = require('../configs/db');

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
        await pool.execute(
            `INSERT INTO notifications (user_id, type, message, related_appointment_id)
             VALUES (?, ?, ?, ?)`,
            [userId, type, message, relatedAppointmentId]
        );
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
        const [[user]] = await pool.execute(
            'SELECT id FROM users WHERE public_id = ?', [publicId]
        );
        if (!user) return [];

        const [rows] = await pool.execute(
            `SELECT id, type, message, is_read, related_appointment_id, created_at
         FROM notifications
         WHERE user_id = ?
         ORDER BY is_read ASC, created_at DESC
         LIMIT ?`,
            [user.id, 200]
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
        const [rows] = await pool.execute(
            `SELECT id, type, message, is_read, created_at, related_appointment_id
         FROM notifications
         WHERE user_id = ? AND is_read = 1
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
            [user.id, limit, offset]
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