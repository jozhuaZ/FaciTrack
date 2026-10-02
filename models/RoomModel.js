const pool = require('../configs/db');

const RoomModel = {
    async getRooms({ limit, offset, fields = '*', filters = {}, orderBy, orderDir = 'ASC' } = {}) {
        let query = `
        SELECT ${fields} FROM rooms r
        LEFT JOIN departments d ON r.department_id = d.id
        LEFT JOIN users u ON r.assigned_faculty = u.id
        WHERE 1=1
    `;
        const params = [];

        if (filters.status) {
            query += ' AND r.status = ?';
            params.push(filters.status);
        }
        if (filters.departmentId) {
            query += ' AND r.department_id = ?';
            params.push(filters.departmentId);
        }
        if (filters.roomType) {
            query += ' AND r.room_type = ?';
            params.push(filters.roomType);
        }

        const allowedOrderColumns = ['room_number', 'floor_number', 'room_type', 'status', 'created_at'];
        const allowedDirs = ['ASC', 'DESC'];

        if (orderBy && allowedOrderColumns.includes(orderBy)) {
            const dir = allowedDirs.includes(orderDir.toUpperCase()) ? orderDir.toUpperCase() : 'ASC';
            query += ` ORDER BY r.${orderBy} ${dir}`;
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

    async getRoomById(id) {
        const [rows] = await pool.execute(
            'SELECT id, room_number, room_type FROM rooms WHERE id = ?',
            [id]
        );
        return rows[0] || null;
    },

    async insertRoomByAdmin(newRoom) {
        let query = `INSERT INTO rooms (room_number, floor_number, department_id, room_type, assigned_faculty, is_ble_scanner_installed, status, capacity)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

        const [result] = await pool.execute(query, [
            newRoom.roomNumber,
            newRoom.floorNumber,
            newRoom.department,
            newRoom.roomType,
            newRoom.assignedFaculty || null,
            newRoom.bleStatus,
            newRoom.status,
            newRoom.capacity
        ]);

        return result.insertId;
    },

    async updateRoom(roomId, data) {
        let query = `UPDATE rooms
                    SET room_number = ?,
                    floor_number = ?,
                    department_id = ?,
                    room_type = ?,
                    assigned_faculty = ?,
                    is_ble_scanner_installed = ?,
                    status = ?,
                    capacity = ?
                    WHERE id = ?`;

        const [result] = await pool.execute(query, [
            data.roomNumber,
            data.floorNumber,
            data.department,
            data.roomType,
            data.assignedFaculty ?? null,
            data.bleStatus,
            data.status,
            data.capacity,
            roomId
        ]);

        return result.affectedRows;
    },

    /**
     * Where the room sits on the 3D building, or null to take its pin off.
     * Kept apart from updateRoom so an edit that never touched the location
     * cannot wipe one placed earlier.
     */
    async setModelPosition(roomId, position) {
        const { x = null, y = null, z = null } = position || {};
        const [result] = await pool.execute(
            'UPDATE rooms SET model_x = ?, model_y = ?, model_z = ? WHERE id = ?',
            [x, y, z, roomId]
        );
        return result.affectedRows;
    },

    async deleteRoom(id) {
        const query = `DELETE FROM rooms WHERE id = ?`;

        const [result] = await pool.execute(query, [id]);

        return result.affectedRows;
    },
};

module.exports = RoomModel;