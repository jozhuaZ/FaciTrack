const pool = require('../configs/db');

const AuditLogModel = {
    async log(userId, role, action, type) {
        await pool.execute(
            `INSERT INTO audit_logs (user_id, role, action, type) VALUES (?, ?, ?, ?)`,
            [userId, role, action, type]
        );
    },

    async getAll({ limit = 100, offset = 0 } = {}) {
        const [rows] = await pool.execute(
            `SELECT al.id, al.action, al.type, al.created_at,
                    u.first_name, u.last_name, al.role
             FROM audit_logs al
             LEFT JOIN users u ON al.user_id = u.id
             ORDER BY al.created_at DESC
             LIMIT ? OFFSET ?`,
            [limit, offset]
        );
        return rows;
    },
};

module.exports = AuditLogModel;