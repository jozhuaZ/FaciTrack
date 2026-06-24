const pool = require('../configs/db');

const WorkloadModel = {

  async getSubjectsByInstructor(instructorId) {
    const [rows] = await pool.query(
      'SELECT * FROM workload_subjects WHERE instructor_id = ? ORDER BY subject_code',
      [instructorId]
    );
    return rows;
  },

  async getBlocksByInstructor(instructorId) {
    const [rows] = await pool.query(
      `SELECT wb.*, ws.subject_code, ws.subject_name
       FROM workload_blocks wb
       JOIN workload_subjects ws ON wb.subject_id = ws.id
       WHERE wb.instructor_id = ?
       ORDER BY wb.day_of_week, wb.start_slot`,
      [instructorId]
    );
    return rows;
  },

  async upsertSubject(instructorId, { code, name, colorHex, units }, conn = pool) {
    const [result] = await conn.query(
      `INSERT INTO workload_subjects (instructor_id, subject_code, subject_name, color_hex, units)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         subject_name = VALUES(subject_name),
         color_hex    = VALUES(color_hex),
         units        = VALUES(units)`,
      [instructorId, code, name, colorHex ?? null, units ?? null]
    );

    if (result.insertId && result.insertId !== 0) return result.insertId;

    // ON DUPLICATE KEY: insertId is 0, fetch the existing id
    const [[row]] = await conn.query(
      'SELECT id FROM workload_subjects WHERE instructor_id = ? AND subject_code = ?',
      [instructorId, code]
    );
    return row.id;
  },

  async pruneSubjects(instructorId, keepCodes, conn = pool) {
    if (!keepCodes.length) return;
    await conn.query(
      `DELETE FROM workload_subjects
       WHERE instructor_id = ?
         AND subject_code NOT IN (?)
         AND id NOT IN (
           SELECT subject_id FROM workload_blocks
           WHERE instructor_id = ? AND class_type = 'Make Up Class'
         )`,
      [instructorId, keepCodes, instructorId]
    );
  },

  async upsertBlock(instructorId, subjectId, { day, startSlot, endSlot, room, section, type, colorHex }, conn = pool) {
    await conn.query(
      `INSERT INTO workload_blocks
         (instructor_id, subject_id, day_of_week, start_slot, end_slot,
          room_name, section_name, class_type, color_hex)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         subject_id   = VALUES(subject_id),
         end_slot     = VALUES(end_slot),
         room_name    = VALUES(room_name),
         section_name = VALUES(section_name),
         class_type   = VALUES(class_type),
         color_hex    = VALUES(color_hex)`,
      [instructorId, subjectId, day, startSlot, endSlot,
       room ?? null, section ?? null, type ?? 'Lecture', colorHex ?? null]
    );
  },

  async pruneBlocks(instructorId, keepKeys, conn = pool) {
    if (!keepKeys.length) {
      // Nothing to keep — delete everything except Make Up Class
      await conn.query(
        `DELETE FROM workload_blocks
         WHERE instructor_id = ? AND class_type != 'Make Up Class'`,
        [instructorId]
      );
      return;
    }

    const conditions  = keepKeys.map(() => '(day_of_week = ? AND start_slot = ?)').join(' OR ');
    const flatValues  = keepKeys.flatMap(k => [k.day, k.startSlot]);

    await conn.query(
      `DELETE FROM workload_blocks
       WHERE instructor_id = ?
         AND class_type != 'Make Up Class'
         AND NOT (${conditions})`,
      [instructorId, ...flatValues]
    );
  },

};

module.exports = WorkloadModel;