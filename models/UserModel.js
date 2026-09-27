const bcrypt = require('bcryptjs');
const crypto = require('crypto');
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
                u.profile_picture,
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

        const [rows] = await pool.query(query, params);  // query() not execute(): a built LIMIT/OFFSET param is rejected by MySQL prepared statements
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
                u.base_room_id,
                r.room_number,
                r.room_type,
                u.department_id,
                d.full_name AS department_name
            FROM users u
            LEFT JOIN departments d ON u.department_id = d.id
            LEFT JOIN rooms r ON u.base_room_id = r.id
            WHERE 1=1
        `;
        const params = [];

        if (role) { query += ' AND u.role = ?'; params.push(role); }
        if (limit) { query += ' LIMIT ?'; params.push(Number(limit)); }
        if (offset) { query += ' OFFSET ?'; params.push(Number(offset)); }

        const [rows] = await pool.query(query, params);  // query() not execute(): a built LIMIT/OFFSET param is rejected by MySQL prepared statements
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
            u.email,
            u.status,
            u.department_id,
            d.full_name          AS department_name,
            u.profile_picture,
            -- Base office, shown on the directory card (moved from the lounge page)
            office.room_number   AS office_room_number,
            officeDept.building  AS office_building,
            -- Needed to work out whether a slot is actually offerable, the same
            -- way the profile page does
            u.default_meeting_link,
            -- A connected Google Calendar is the other way an instructor can
            -- host online, so the directory has to count it too
            (ga.user_id IS NOT NULL) AS google_connected,
            u.availability_status,
            -- Next available slot fields
            next_slot.consultation_date AS next_date,
            next_slot.day_of_the_week   AS next_day,
            next_slot.start_time        AS next_start_time
        FROM users u
        LEFT JOIN departments d ON u.department_id = d.id
        LEFT JOIN rooms office           ON u.base_room_id       = office.id
        LEFT JOIN departments officeDept ON office.department_id = officeDept.id
        LEFT JOIN google_accounts ga ON ga.user_id = u.id AND ga.last_error IS NULL
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

        const [rows] = await pool.query(query, params);  // query() not execute(): a built LIMIT/OFFSET param is rejected by MySQL prepared statements
        return rows;
    },

    async insertUserByAdmin(newUser) {
        const query = `INSERT INTO users
            (first_name, middle_name, last_name, email, role, base_room_id, department_id, status, employment_type, position, profile_picture, hashed_password)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        const [result] = await pool.execute(query, [
            newUser.firstName,
            newUser.middleName ?? null,
            newUser.lastName,
            newUser.email,
            newUser.role,
            newUser.roomId,
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
                base_room_id    = ?,
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
                data.roomId,
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
            u.availability_status,
            u.default_meeting_link,
            -- Online consultations work off either venue: a scheduled Meet
            -- from the instructor's connected calendar, or their static link
            (ga.user_id IS NOT NULL) AS google_connected,
            d.full_name AS department_name
         FROM users u
         LEFT JOIN departments d ON u.department_id = d.id
         LEFT JOIN google_accounts ga ON ga.user_id = u.id AND ga.last_error IS NULL
         WHERE u.public_id = ?`,
            [publicId]
        );
        return rows[0] || null;
    },

    /**
     * Set an instructor's own availability. Values must match the
     * users.availability_status enum: available | dnd | travel | leave | meeting.
     */
    /** The instructor's personal meeting room, reused for online consultations. */
    async updateDefaultMeetingLink(publicId, link) {
        const [result] = await pool.execute(
            'UPDATE users SET default_meeting_link = ? WHERE public_id = ?',
            [link || null, publicId]
        );
        return result.affectedRows > 0;
    },

    async updateAvailabilityStatus(publicId, status) {
        const [result] = await pool.execute(
            'UPDATE users SET availability_status = ? WHERE public_id = ?',
            [status, publicId]
        );
        return result.affectedRows > 0;
    },

    /** Instructor edits their own name from Settings. Email is not editable here
     *  — it is the sign-in identity Google OAuth matches on. */
    async updateOwnProfile(publicId, { firstName, middleName, lastName }) {
        const [result] = await pool.execute(
            `UPDATE users SET first_name = ?, middle_name = ?, last_name = ? WHERE public_id = ?`,
            [firstName, middleName || null, lastName, publicId]
        );
        return result.affectedRows > 0;
    },

    /** Kept separate from getUserByPublicId so the hash is never fetched by accident. */
    async getPasswordHash(publicId) {
        const [rows] = await pool.execute(
            `SELECT hashed_password FROM users WHERE public_id = ?`,
            [publicId]
        );
        return rows[0] ? rows[0].hashed_password : null;
    },

    async updatePassword(publicId, plainPassword) {
        const hash = await bcrypt.hash(plainPassword, 10);
        const [result] = await pool.execute(
            `UPDATE users SET hashed_password = ? WHERE public_id = ?`,
            [hash, publicId]
        );
        return result.affectedRows > 0;
    },

    async getUserById(internalId) {
        const [rows] = await pool.execute(
            `SELECT public_id AS id, id AS internal_id, first_name, last_name, email, role, status, profile_picture, position
         FROM users WHERE id = ?`,
            [internalId]
        );
        return rows[0] || null;
    },

    /**
     * The credential for someone's outbound calendar feed, minted on first use.
     *
     * Calendar clients cannot log in, so the URL is the credential — 32 random
     * bytes, which is why it is generated rather than derived from anything
     * guessable like the public id.
     */
    async getOrCreateFeedToken(publicId) {
        const [rows] = await pool.execute(
            'SELECT calendar_feed_token FROM users WHERE public_id = ?', [publicId]
        );
        if (!rows.length) return null;
        if (rows[0].calendar_feed_token) return rows[0].calendar_feed_token;

        const token = crypto.randomBytes(32).toString('base64url');
        await pool.execute(
            'UPDATE users SET calendar_feed_token = ? WHERE public_id = ?', [token, publicId]
        );
        return token;
    },

    /** Regenerate, so a leaked feed URL can be revoked without affecting anyone else. */
    async rotateFeedToken(publicId) {
        const token = crypto.randomBytes(32).toString('base64url');
        const [result] = await pool.execute(
            'UPDATE users SET calendar_feed_token = ? WHERE public_id = ?', [token, publicId]
        );
        return result.affectedRows ? token : null;
    },

    /** Who a feed token belongs to. Returns null for anything unrecognised. */
    async getUserByFeedToken(token) {
        if (!token) return null;
        const [rows] = await pool.execute(
            `SELECT id AS internal_id, public_id, first_name, last_name, role, status
               FROM users WHERE calendar_feed_token = ?`,
            [token]
        );
        return rows[0] || null;
    },

    /**
     * Every active instructor with their office, self-reported availability
     * and BLE presence, for the student's Faculty Lounge board and the
     * lounge display panel. Both scope presence to the lounge itself; this
     * query returns detected_room_type so they can.
     *
     * `faculty_presence` is a LEFT JOIN because the BLE module has not shipped:
     * the rows come back with no presence today and the page says so, and the
     * same query starts returning real values the moment scanners are
     * installed — no change needed here or in the view.
     */
    async getFacultyPresence({ departmentId = null } = {}) {
        const [rows] = await pool.execute(
            `SELECT u.public_id            AS id,
                    CONCAT(u.first_name, ' ', u.last_name) AS name,
                    u.position,
                    u.profile_picture,
                    u.availability_status,
                    d.full_name            AS department_name,
                    d.short_name           AS department_short,
                    office.room_number     AS office_room_number,
                    officeDept.building    AS office_building,
                    fp.is_present,
                    fp.last_updated        AS presence_updated_at,
                    fp.room_id             AS detected_room_id,
                    detected.room_number   AS detected_room_number,
                    detected.room_type     AS detected_room_type
               FROM users u
               LEFT JOIN departments d          ON u.department_id      = d.id
               LEFT JOIN rooms office           ON u.base_room_id       = office.id
               LEFT JOIN departments officeDept ON office.department_id = officeDept.id
               LEFT JOIN faculty_presence fp    ON fp.instructor_id     = u.id
               LEFT JOIN rooms detected         ON fp.room_id           = detected.id
              WHERE u.role = 'Instructor'
                AND u.status = 'Active'
                AND (? IS NULL OR u.department_id = ?)
              ORDER BY u.last_name ASC, u.first_name ASC`,
            [departmentId, departmentId]
        );
        return rows;
    },

    /**
     * Point a user at a new avatar and hand back the path it replaced.
     *
     * The previous value comes back so the caller can delete the file it names.
     * Without that, every re-upload would strand its predecessor on disk.
     *
     * SELECT ... FOR UPDATE holds the row for the length of the transaction, so
     * two uploads racing each other cannot both read the same old path and
     * leave one of the two files orphaned.
     *
     * @returns {{previous: string|null}|null}  null when no such user
     */
    async updateProfilePicture(publicId, webPath) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [[current]] = await conn.execute(
                'SELECT profile_picture FROM users WHERE public_id = ? FOR UPDATE',
                [publicId]
            );
            if (!current) {
                await conn.rollback();
                return null;
            }

            await conn.execute(
                'UPDATE users SET profile_picture = ? WHERE public_id = ?',
                [webPath, publicId]
            );

            await conn.commit();
            return { previous: current.profile_picture || null };
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    },
}

module.exports = UserModel;