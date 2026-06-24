const pool = require('../configs/db');

const DepartmentModel = {
    async getDepartments() {
        let query = `SELECT id, full_name, short_name, building FROM departments`;

        const [rows] = await pool.execute(query);
        return rows;
    }
}

module.exports = DepartmentModel;