const pool = require('../configs/db');

const UserModel = {
    
    async getUsers({role, limit, offset, fields = '*'}) {
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

        if (role)   { query += ' AND u.role = ?';  params.push(role); }
        if (limit)  { query += ' LIMIT ?';         params.push(Number(limit)); }
        if (offset) { query += ' OFFSET ?';        params.push(Number(offset)); }

        const [rows] = await pool.execute(query, params);
        return rows;
    },

    async insertUserByAdmin(newUser) {
        const query = `INSERT INTO users
            (first_name, middle_name, last_name, email, role, department_id, status, employment_type, position, profile_picture, hashed_password)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        const [result] = await pool.execute(query, [
            newUser.firstName, 
            newUser.middleName,
            newUser.lastName,
            newUser.email,
            newUser.role, 
            newUser.departmentId,
            newUser?.status || 'Active',
            newUser.employmentType,
            newUser.position,
            newUser?.profilePicture || null,
            newUser.hashedPassword
        ]);
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
                data.middleName     ?? null,
                data.lastName,
                data.email,
                data.role,
                data.departmentId   ?? null,
                data.status         ?? 'Active',
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
    }
}

module.exports = UserModel;