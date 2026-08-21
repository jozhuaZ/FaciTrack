const bcrypt = require('bcrypt');
const pool = require('../configs/db');

const UserModel = {

    async getUserByEmail(email) {
        const query =
            `SELECT
                u.public_id AS id,
                u.id AS internal_id,
                u.first_name,
                u.last_name,
                u.middle_name,
                u.hashed_password,
                u.email,
                u.role,
                u.employment_type,
                u.position,
                u.status,
                u.last_login,
                u.department_id,
                d.full_name AS department_name
            FROM users u
            LEFT JOIN departments d ON u.department_id = d.id
            WHERE email = ?
            LIMIT 1`;

        const [rows] = await pool.execute(query, [email]);

        return rows[0] || null;
    },

    async getUsers({ role, limit, offset, fields = '*' }) {
        let query = `SELECT ${fields} FROM users WHERE 1=1`;
        const params = [];

        if (role) {
            query += ' AND role = ?';
            params.push(role);
        }

        if (limit) {
            query += ' LIMIT ?';
            params.push(Number(limit));
        }

        if (offset) {
            query += ' OFFSET ?';
            params.push(Number(offset));
        }

        const [rows] = await pool.execute(query, params);
        return rows;
    },

    async getUsersWithDepartment({ role, limit, offset } = {}) {
        let query = `
            SELECT
                u.public_id AS id,
                u.first_name,
                u.last_name,
                u.middle_name,
                u.email,
                u.role,
                u.employment_type,
                u.position,
                u.status,
                u.last_login,
                u.department_id,
                d.full_name AS department_name
            FROM users u
            LEFT JOIN departments d ON u.department_id = d.id
            WHERE 1=1
        `;
        const params = [];

        if (role) { query += ' AND u.role = ?'; params.push(role); }
        if (limit) { query += ' LIMIT ?'; params.push(Number(limit)); }
        if (offset) { query += ' OFFSET ?'; params.push(Number(offset)); }

        const [rows] = await pool.execute(query, params);
        return rows;
    },

    async getFacultiesConsultation({ limit, offset } = {}) {
        let query = `
        SELECT
            u.public_id          AS instructor_id,
            CONCAT(u.last_name, ', ', u.first_name,
                   IF(u.middle_name IS NOT NULL AND u.middle_name != '',
                      CONCAT(' ', u.middle_name), '')) AS full_name,
            u.position,
            u.status,
            u.department_id,
            d.full_name          AS department_name,
            u.profile_picture,
            -- Next available slot fields
            next_slot.consultation_date AS next_date,
            next_slot.day_of_the_week   AS next_day,
            next_slot.start_time        AS next_start_time
        FROM users u
        LEFT JOIN departments d ON u.department_id = d.id
        LEFT JOIN (
            SELECT
                instructor_id,
                consultation_date,
                day_of_the_week,
                start_time
            FROM consultation_hours
            WHERE status = 'Available'
            AND consultation_date > CURDATE() 
            ORDER BY consultation_date ASC, start_time ASC
        ) next_slot ON u.id = next_slot.instructor_id
        WHERE u.role = 'Instructor'
          AND u.status = 'Active'
        GROUP BY u.id
    `;

        const params = [];

        if (limit) {
            query += ' LIMIT ?';
            params.push(Number(limit));
        }
        if (offset) {
            query += ' OFFSET ?';
            params.push(Number(offset));
        }

        const [rows] = await pool.execute(query, params);
        return rows;
    },

    async getFacultyWithConsultation() {
        let query = `SELECT `
    },

    async insertUserByAdmin(newUser) {
        const query = `INSERT INTO users
            (first_name, middle_name, last_name, email, role, department_id, status, employment_type, position, profile_picture, hashed_password)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        const [result] = await pool.execute(query, [
            newUser.firstName,
            newUser.middleName ?? null,
            newUser.lastName,
            newUser.email,
            newUser.role,
            newUser.departmentId ?? null,
            newUser?.status || 'Active',
            newUser.employmentType ?? null,
            newUser.position ?? null,
            newUser?.profilePicture || null,
            newUser.hashedPassword ?? null
        ]);

        return result.insertId;
    },

    async insertUserByOAuth(newUser) {
        const query = `INSERT INTO users 
            (first_name, last_name, email, role, status)
            VALUES (?, ?, ?, ?, ?)`;

        const [result] = await pool.execute(query, [
            newUser.firstName,
            newUser.lastName,
            newUser.email,
            newUser.role,
            newUser.status
        ]);

        return result.insertId;
    },

    async updateUser(publicId, data) {
        const [result] = await pool.execute(
            `UPDATE users SET
                first_name      = ?,
                middle_name     = ?,
                last_name       = ?,
                email           = ?,
                role            = ?,
                department_id   = ?,
                status          = ?,
                employment_type = ?,
                position = ?
            WHERE public_id = ?`,
            [
                data.firstName,
                data.middleName ?? null,
                data.lastName,
                data.email,
                data.role,
                data.departmentId ?? null,
                data.status ?? 'Active',
                data.employmentType,
                data.position,
                publicId,
            ]
        );
        return result.affectedRows;
    },

    async deleteUser(publicId) {
        const query = `DELETE FROM users WHERE public_id = ?`;

        const [result] = await pool.execute(query, [publicId]);

        return result.affectedRows;
    },

    async updateLastLogin(id) {
        const query = `UPDATE users SET last_login = NOW() WHERE id = ?`;
        await pool.execute(query, [id]);
    },

    async getUserByPublicId(publicId) {
        const [rows] = await pool.execute(
            `SELECT 
            u.id AS internal_id,
            u.public_id AS id,
            u.first_name, u.last_name, u.middle_name,
            u.email, u.role, u.status,
            u.position, u.employment_type,
            u.profile_picture, u.department_id,
            d.full_name AS department_name
         FROM users u
         LEFT JOIN departments d ON u.department_id = d.id
         WHERE u.public_id = ?`,
            [publicId]
        );
        return rows[0] || null;
    },

    async getUserById(internalId) {
        const [rows] = await pool.execute(
            `SELECT public_id AS id, id AS internal_id, first_name, last_name, email, role, status, profile_picture, position
         FROM users WHERE id = ?`,
            [internalId]
        );
        return rows[0] || null;
    },

    async getUsersByRole(role) {
        const [rows] = await pool.execute(
            `SELECT 
                u.id,
                u.public_id,
                u.first_name,
                u.last_name,
                u.middle_name,
                u.email,
                u.role,
                u.position,
                u.status,
                u.department_id,
                d.full_name AS department_name
             FROM users u
             LEFT JOIN departments d ON u.department_id = d.id
             WHERE u.role = ?
             ORDER BY u.last_name, u.first_name`,
            [role]
        );
        return rows;
    },
}

module.exports = UserModel;