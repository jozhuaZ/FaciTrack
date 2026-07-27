const pool = require('../configs/db');
const WorkloadModel = require('../models/WorkloadModel');
const RoomModel = require('../models/RoomModel');

const WorkloadController = {

  async renderPage(req, res) {
    const instructorId = req.session.userId;

    const instructor = {
      id: req.session?.userId,
      name: req.session?.name,
      firstName: req.session.firstName,
      middleName: req.session.middleName,
      lastName: req.session.lastName,
      status: req.session.status,
      email: req.session?.email,
      position: req.session.position,
      role: req.session.role,
      profilePhoto: req.session?.profilePhoto || null,
      department: req.session?.department,
    };

    const [subjects, blockRows, rooms] = await Promise.all([
      WorkloadModel.getSubjectsByInstructor(instructorId),
      WorkloadModel.getBlocksByInstructor(instructorId),
      RoomModel.getRooms({
        fields: 'r.id AS room_id, r.room_number, r.room_type, r.status',
        filters: { status: 'Active' },
        orderBy: 'room_number'
      })
    ]);

    const subjectsOut = subjects.map(s => ({
      id: s.subject_code,
      code: s.subject_code,
      name: s.subject_name,
      color: s.color_hex,
      units: s.units,
    }));

    const blocksOut = {};
    (blockRows || []).forEach(b => {
      const key = `${b.day_of_week}_${b.start_slot}`;
      blocksOut[key] = {
        subjectId: b.subject_code,
        subjectName: b.subject_name,
        roomId: b.room_id,
        room: b.room_number || '',
        section: b.section_name || '',
        type: b.class_type || 'Lecture',
        duration: b.end_slot - b.start_slot,
        color: b.color_hex,
      };
    }); 

    const workloadData = {
      subjects: subjectsOut,
      blocks: blocksOut,
    };

    res.render('pages/instructor/workload', {
      title: 'FaciTrack - Workload',
      instructor: instructor,
      pendingCount: req.pendingCount ?? 0,
      workloadData: JSON.stringify({ subjects: subjectsOut, blocks: blocksOut }),
      rooms: rooms
    });
  },

  async load(req, res) {
    try {
      const instructorId = req.session?.userId || req.session?.instructorId || req.currentUser?.id || req.user?.id || 1;

      const [subjects, blockRows] = await Promise.all([
        WorkloadModel.getSubjectsByInstructor(instructorId),
        WorkloadModel.getBlocksByInstructor(instructorId),
      ]);

      const subjectsOut = subjects.map(s => ({
        id: s.subject_code,
        code: s.subject_code,
        name: s.subject_name,
        color: s.color_hex,
        units: s.units,
      }));

      const blocksOut = {};
      (blockRows || []).forEach(b => {
        const key = `${b.day_of_week}_${b.start_slot}`;
        blocksOut[key] = {
          subjectId: b.subject_code,
          subjectName: b.subject_name,
          room: b.room_name || '',
          section: b.section_name || '',
          type: b.class_type || 'Lecture',
          duration: b.end_slot - b.start_slot,
          color: b.color_hex,
        };
      });

      res.json({ success: true, subjects: subjectsOut, blocks: blocksOut });
    } catch (err) {
      console.warn('[WorkloadController.load] Falling back to empty workload data:', err.message);
      res.json({ success: true, subjects: [], blocks: {} });
    }
  },

  async save(req, res) {
    const instructorId = req.session.userId;
    const { subjects, blocks } = req.body;

    if (!Array.isArray(subjects) || typeof blocks !== 'object' || blocks === null) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    for (const s of subjects) {
        if (!s.code?.trim() || !s.name?.trim()) {
            return res.status(400).json({ error: 'Subject code and name are required.' });
        }
    }

    // validate
    for (const [key, b] of Object.entries(blocks)) {
        if (b.type === 'Make Up Class') continue;
        if (!b.roomId) continue;

        const room = await RoomModel.getRoomById(b.roomId);
        if (!room) continue;

        if (b.type === 'Online') {
            return res.status(422).json({
                success: false,
                error: `Online class type cannot be assigned to a physical room (${key}).`
            });
        }
        if (room.room_type === 'Laboratory' && b.type !== 'Laboratory') {
            return res.status(422).json({
                success: false,
                error: `Room "${room.room_number}" is a Laboratory — class type must be Laboratory.`
            });
        }
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const subjectIdMap = {};
        for (const s of subjects) {
            subjectIdMap[s.code] = await WorkloadModel.upsertSubject(
                instructorId,
                { code: s.code, name: s.name, colorHex: s.color ?? null, units: s.units ?? null },
                conn
            );
        }

        await WorkloadModel.pruneSubjects(instructorId, subjects.map(s => s.code), conn);

        const keepKeys = [];
        for (const [key, b] of Object.entries(blocks)) {
            if (b.type === 'Make Up Class') continue;

            const under     = key.indexOf('_');
            const day       = key.slice(0, under);
            const startSlot = parseInt(key.slice(under + 1));
            const endSlot   = startSlot + (b.duration || 1);

            const subjectId = subjectIdMap[b.subjectId];
            if (!subjectId) { 
                console.warn(`[WorkloadController.save] No DB id for subject "${b.subjectId}", skipping block ${key}`);
                continue;
            }

            await WorkloadModel.upsertBlock(instructorId, subjectId, {
                day, startSlot, endSlot,
                roomId:   b.roomId  || null,
                section:  b.section || null,
                type:     b.type    || 'Lecture',
                colorHex: b.color   || null,
            }, conn);

            keepKeys.push({ day, startSlot });
        }

        await WorkloadModel.pruneBlocks(instructorId, keepKeys, conn);

        await conn.commit();
        res.json({ success: true });
    } catch (err) {
        await conn.rollback();
        console.error('[WorkloadController.save]', err);
        res.status(500).json({ error: 'Failed to save workload' });
    } finally {
        conn.release();
    }
},
};

module.exports = WorkloadController;