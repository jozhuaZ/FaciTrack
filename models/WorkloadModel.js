const pool = require('../configs/db');

const WorkloadModel = {

  async getSubjectsByInstructor(instructorId) {
    const [rows] = await pool.query(
      `SELECT ws.* FROM workload_subjects ws
         JOIN users u ON ws.instructor_id = u.id
         WHERE u.public_id = ?
         ORDER BY ws.subject_code`,
      [instructorId]
    );
    return rows;
  },

  async getBlocksByInstructor(instructorId) {
    const [rows] = await pool.query(
      `SELECT wb.*, ws.subject_code, ws.subject_name
         FROM workload_blocks wb
         JOIN workload_subjects ws ON wb.subject_id = ws.id
         JOIN users u ON wb.instructor_id = u.id
         WHERE u.public_id = ?
         ORDER BY wb.day_of_week, wb.start_slot`,
      [instructorId]
    );
    return rows;
  },

  async upsertSubject(instructorId, { code, name, colorHex, units }, conn = pool) {
    const [result] = await conn.query(
      `INSERT INTO workload_subjects (instructor_id, subject_code, subject_name, color_hex, units)
         SELECT u.id, ?, ?, ?, ?
         FROM users u WHERE u.public_id = ?
         ON DUPLICATE KEY UPDATE
             subject_name = VALUES(subject_name),
             color_hex    = VALUES(color_hex),
             units        = VALUES(units)`,
      [code, name, colorHex ?? null, units ?? null, instructorId]
    );

    if (result.insertId && result.insertId !== 0) return result.insertId;

    const [[row]] = await conn.query(
      `SELECT ws.id FROM workload_subjects ws
         JOIN users u ON ws.instructor_id = u.id
         WHERE u.public_id = ? AND ws.subject_code = ?`,
      [instructorId, code]
    );
    return row.id;
  },

  async upsertBlock(instructorId, subjectId, { day, startSlot, endSlot, room, section, type, colorHex }, conn = pool) {
    await conn.query(
      `INSERT INTO workload_blocks
             (instructor_id, subject_id, day_of_week, start_slot, end_slot,
              room_name, section_name, class_type, color_hex)
         SELECT u.id, ?, ?, ?, ?, ?, ?, ?, ?
         FROM users u WHERE u.public_id = ?
         ON DUPLICATE KEY UPDATE
             subject_id   = VALUES(subject_id),
             end_slot     = VALUES(end_slot),
             room_name    = VALUES(room_name),
             section_name = VALUES(section_name),
             class_type   = VALUES(class_type),
             color_hex    = VALUES(color_hex)`,
      [subjectId, day, startSlot, endSlot,
        room ?? null, section ?? null, type ?? 'Lecture', colorHex ?? null,
        instructorId]
    );
  },

  async pruneSubjects(instructorId, keepCodes, conn = pool) {
    if (!keepCodes.length) return;
    await conn.query(
      `DELETE ws FROM workload_subjects ws
         JOIN users u ON ws.instructor_id = u.id
         WHERE u.public_id = ?
           AND ws.subject_code NOT IN (?)
           AND ws.id NOT IN (
               SELECT wb.subject_id FROM workload_blocks wb
               JOIN users u2 ON wb.instructor_id = u2.id
               WHERE u2.public_id = ? AND wb.class_type = 'Make Up Class'
           )`,
      [instructorId, keepCodes, instructorId]
    );
  },

  async pruneBlocks(instructorId, keepKeys, conn = pool) {
    if (!keepKeys.length) {
      await conn.query(
        `DELETE wb FROM workload_blocks wb
             JOIN users u ON wb.instructor_id = u.id
             WHERE u.public_id = ? AND wb.class_type != 'Make Up Class'`,
        [instructorId]
      );
      return;
    }

    const conditions = keepKeys.map(() => '(wb.day_of_week = ? AND wb.start_slot = ?)').join(' OR ');
    const flatValues = keepKeys.flatMap(k => [k.day, k.startSlot]);

    await conn.query(
      `DELETE wb FROM workload_blocks wb
         JOIN users u ON wb.instructor_id = u.id
         WHERE u.public_id = ?
           AND wb.class_type != 'Make Up Class'
           AND NOT (${conditions})`,
      [instructorId, ...flatValues]
    );
  },

};

module.exports = WorkloadModel;