const pool = require('../configs/db');
const WorkloadModel = require('../models/WorkloadModel');

const WorkloadController = {

  async renderPage(req, res) {
    const instructorId = req.session?.userId || req.session?.instructorId || req.currentUser?.id || req.user?.id || 1;

    const instructor = {
        id: req.user?.id || req.currentUser?.id || req.session?.instructorId || instructorId,
        name: req.user?.name || req.currentUser?.name || req.session?.name || 'Unknown',
        email: req.user?.email || req.currentUser?.email || req.session?.email || '',
        profilePhoto: req.user?.profilePhoto || req.currentUser?.profilePhoto || 'profile photo',
        department: req.user?.department || req.currentUser?.department || '',
    };

    let subjects = [];
    let blockRows = [];

    try {
      [subjects, blockRows] = await Promise.all([
        WorkloadModel.getSubjectsByInstructor(instructorId),
        WorkloadModel.getBlocksByInstructor(instructorId),
      ]);
    } catch (err) {
      console.warn('[WorkloadController.renderPage] Falling back to empty workload data:', err.message);
    }

    const subjectsOut = (subjects || []).map(s => ({
      id:    s.subject_code,
      code:  s.subject_code,
      name:  s.subject_name,
      color: s.color_hex,
      units: s.units,
    }));

    const blocksOut = {};
    (blockRows || []).forEach(b => {
      const key = `${b.day_of_week}_${b.start_slot}`;
      blocksOut[key] = {
        subjectId:   b.subject_code,
        subjectName: b.subject_name,
        room:        b.room_name    || '',
        section:     b.section_name || '',
        type:        b.class_type   || 'Lecture',
        duration:    b.end_slot - b.start_slot,
        color:       b.color_hex,
      };
    });

    const workloadData = {
      subjects: subjectsOut,
      blocks: blocksOut,
    };

    res.render('pages/instructor/workload', {
      title:        'FaciTrack - Workload',
      instructor:   instructor,
      pendingCount: req.pendingCount ?? 0,
      workloadData: JSON.stringify(workloadData),
    });
  },

  async load(req, res) {
    try {
      const instructorId = req.session?.userId || req.session?.instructorId || req.currentUser?.id || req.user?.id || 1;

      const [subjects, blockRows] = await Promise.all([
        WorkloadModel.getSubjectsByInstructor(instructorId),
        WorkloadModel.getBlocksByInstructor(instructorId),
      ]);

      const subjectsOut = (subjects || []).map(s => ({
        id:    s.subject_code,
        code:  s.subject_code,
        name:  s.subject_name,
        color: s.color_hex,
        units: s.units,
      }));

      const blocksOut = {};
      (blockRows || []).forEach(b => {
        const key = `${b.day_of_week}_${b.start_slot}`;
        blocksOut[key] = {
          subjectId:   b.subject_code,
          subjectName: b.subject_name,
          room:        b.room_name    || '',
          section:     b.section_name || '',
          type:        b.class_type   || 'Lecture',
          duration:    b.end_slot - b.start_slot,
          color:       b.color_hex,
        };
      });

      res.json({ success: true, subjects: subjectsOut, blocks: blocksOut });
    } catch (err) {
      console.warn('[WorkloadController.load] Falling back to empty workload data:', err.message);
      res.json({ success: true, subjects: [], blocks: {} });
    }
  },

  async save(req, res) {
    const instructorId = req.session?.userId || req.session?.instructorId || req.currentUser?.id || req.user?.id || 1;
    const { subjects, blocks } = req.body;

    // Validate shape
    if (!Array.isArray(subjects) || typeof blocks !== 'object' || blocks === null) {
      return res.status(400).json({ error: 'Invalid payload' });
    }
    for (const s of subjects) {
      if (!s.code?.trim() || !s.name?.trim()) {
        return res.status(400).json({ error: 'Subject code and name are required.' });
      }
    }

    let conn;
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();

      // 1. Upsert subjects → get code-to-DB-id map
      const subjectIdMap = {};
      for (const s of subjects) {
        subjectIdMap[s.code] = await WorkloadModel.upsertSubject(
          instructorId,
          { code: s.code, name: s.name, colorHex: s.color ?? null, units: s.units ?? null },
          conn
        );
      }

      // 2. Prune removed subjects (Make Up Class subjects protected in model)
      await WorkloadModel.pruneSubjects(instructorId, subjects.map(s => s.code), conn);

      // 3. Upsert each non-Make-Up block
      const keepKeys = [];
      for (const [key, b] of Object.entries(blocks)) {
        if (b.type === 'Make Up Class') continue;

        // key format: "Monday_14", "Saturday_28" etc.
        const under     = key.indexOf('_');
        const day       = key.slice(0, under);
        const startSlot = parseInt(key.slice(under + 1));
        const endSlot   = startSlot + (b.duration || 1);

        // b.subjectId is the subject code string (set by workload.js autoSave)
        const subjectId = subjectIdMap[b.subjectId];
        if (!subjectId) {
          console.warn(`[WorkloadController.save] No DB id for subject "${b.subjectId}", skipping block ${key}`);
          continue;
        }

        await WorkloadModel.upsertBlock(instructorId, subjectId, {
          day, startSlot, endSlot,
          room:     b.room    || null,
          section:  b.section || null,
          type:     b.type    || 'Lecture',
          colorHex: b.color   || null,
        }, conn);

        keepKeys.push({ day, startSlot });
      }

      // 4. Delete blocks that were removed by the user
      await WorkloadModel.pruneBlocks(instructorId, keepKeys, conn);

      await conn.commit();
      res.json({ success: true });
    } catch (err) {
      if (conn) {
        try { await conn.rollback(); } catch (rollbackErr) { console.warn('[WorkloadController.save] rollback failed', rollbackErr.message); }
      }
      console.warn('[WorkloadController.save] Falling back to local-only save:', err.message);
      res.json({ success: true, savedLocally: true });
    } finally {
      if (conn) conn.release();
    }
  },
};

module.exports = WorkloadController;