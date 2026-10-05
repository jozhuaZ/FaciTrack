/**
 * The CCS Student-Teacher Consultation Form, filled in from a completed
 * appointment and drawn as a PDF.
 *
 * Laid out to the college's own Word template (consultation_log_form.docx):
 * an 8.5 × 6.5 in page with 1 in margins, the same table grid, row heights and
 * header logos, in Carlito — the open font metric-compatible with the
 * template's Calibri, so every line falls where it does in the original.
 * Action Points is left blank for the instructor to write in.
 *
 * pdfkit is loaded on first use, like the report exports, so it costs nothing
 * on a cold start that never prints a form.
 */
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets', 'consultation-form');
const { to12Hour } = require('../utils/timeFormat');

/** Minutes between two 'HH:MM[:SS]' times on the same day. */
function minutesBetween(startTime, endTime) {
    const [sh, sm] = String(startTime).split(':').map(Number);
    const [eh, em] = String(endTime).split(':').map(Number);
    return (eh * 60 + em) - (sh * 60 + sm);
}

// ── Page and grid, in points, taken from the template ─────────────────────────
const PAGE = { width: 612, height: 468 };          // 12242 × 9361 twips
const LEFT = 72;                                    // 1 in margin
const COLS = [155.85, 21.1, 155.95, 134.7];         // the table's gridCol widths
const CELL_PAD = 5.4;                               // Word's default 0.075 in cell margin
const FONT_SIZE = 11;
const LINE = 13.43;                                 // one single-spaced 11 pt line
const TABLE_TOP = 77.3;

const x = i => LEFT + COLS.slice(0, i).reduce((a, b) => a + b, 0);
const TABLE_RIGHT = x(4);

// Each row's height in lines, as the template has them (Name of Instructor is
// one line at 1.5 spacing).
const ROWS = [
    { key: 'when', lines: 2 },
    { key: 'format', lines: 6 },
    { key: 'subject', lines: 2 },
    { key: 'instructor', lines: 1.5 },
    { key: 'students', lines: 2 },
    { key: 'summary', lines: 6 },
    { key: 'actions', lines: 2 },
];

const FORMATS = [
    { key: 'scheduled', label: 'scheduled meeting' },
    { key: 'online', label: 'online (email, chat)' },
    { key: 'sms', label: 'SMS' },
    { key: 'other', label: 'other format _______________________' },
];

/**
 * Text that has to stay inside a box: shrinks a size at a time down to `min`,
 * then cuts with an ellipsis, so an unusually long topic can never spill over
 * into the next row of a printed form.
 */
function fitText(doc, text, { left, top, width, height, size = FONT_SIZE, min = 8.5, font = 'Form' }) {
    if (!text) return;
    doc.font(font);
    let s = size;
    for (; s > min; s -= 0.5) {
        doc.fontSize(s);
        if (doc.heightOfString(text, { width, lineGap: 0 }) <= height) break;
    }
    doc.fontSize(s);
    let out = text;
    while (out.length > 1 && doc.heightOfString(out, { width, lineGap: 0 }) > height) {
        out = out.slice(0, Math.floor(out.length * 0.92)).trimEnd() + '…';
        if (out.length < 4) break;
    }
    doc.text(out, left, top, { width, height, lineGap: 0, ellipsis: true });
}

/** The template's Wingdings box, ticked when it applies. */
function checkbox(doc, left, top, checked) {
    const size = 7.4;
    const bx = left, by = top + 3.2;
    doc.save().lineWidth(0.6).rect(bx, by, size, size).stroke();
    if (checked) {
        doc.lineWidth(1.3).lineCap('round').lineJoin('round')
            .moveTo(bx + 1.5, by + 3.9).lineTo(bx + 3.1, by + 5.7).lineTo(bx + 6.2, by + 1.4).stroke();
    }
    doc.restore();
}

/**
 * @param {object} form
 *   date, time, hours           — the first row
 *   format                      — 'scheduled' | 'online' | 'sms' | 'other'
 *   subject, instructor         — single values
 *   students                    — [{ name, detail }]
 *   summary                     — free text
 *   submittedBy, notedBy        — { name, date } printed above the signature lines
 * @returns {Promise<Buffer>}
 */
function buildConsultationFormPdf(form) {
    const PDFDocument = require('pdfkit');

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: [PAGE.width, PAGE.height],
            margin: 0,
            info: {
                Title: `Student-Teacher Consultation Form — ${form.date}`,
                Author: 'FaciTrack',
                Subject: 'College of Computer Studies Student-Teacher Consultation Form',
            },
        });
        const chunks = [];
        doc.on('data', c => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        doc.registerFont('Form', path.join(ASSETS, 'Carlito-Regular.ttf'));
        doc.registerFont('FormBold', path.join(ASSETS, 'Carlito-Bold.ttf'));
        doc.fillColor('#000').strokeColor('#000');

        // ── Header: the two logos either side of the college's name ──
        doc.image(path.join(ASSETS, 'cspc-logo.png'), 174.2, 33.4, { width: 40.9 });
        doc.image(path.join(ASSETS, 'ccs-logo.png'), 399.9, 33.4, { width: 40.4 });
        doc.font('FormBold').fontSize(FONT_SIZE)
            .text('COLLEGE OF COMPUTER STUDIES', 0, 50.5, { width: PAGE.width, align: 'center', lineBreak: false });
        doc.font('Form').fontSize(FONT_SIZE)
            .text('Student-Teacher Consultation Form', 0, 63.9, { width: PAGE.width, align: 'center', lineBreak: false });

        // ── Row positions ──
        const tops = [];
        let y = TABLE_TOP;
        ROWS.forEach(r => { tops.push(y); y += r.lines * LINE; });
        const tableBottom = y;
        const top = key => tops[ROWS.findIndex(r => r.key === key)];
        const height = key => ROWS.find(r => r.key === key).lines * LINE;

        // ── Grid: outer box, every row line, and each row's own column lines ──
        doc.save().lineWidth(0.5);
        doc.rect(LEFT, TABLE_TOP, TABLE_RIGHT - LEFT, tableBottom - TABLE_TOP).stroke();
        tops.slice(1).forEach(t => doc.moveTo(LEFT, t).lineTo(TABLE_RIGHT, t).stroke());
        // First row: Date | Time | Number of Hours
        doc.moveTo(x(2), top('when')).lineTo(x(2), top('when') + height('when')).stroke();
        doc.moveTo(x(3), top('when')).lineTo(x(3), top('when') + height('when')).stroke();
        // Every other row: label | value
        doc.moveTo(x(1), top('format')).lineTo(x(1), tableBottom).stroke();
        doc.restore();

        const label = (text, key, opts = {}) => doc.font('Form').fontSize(FONT_SIZE)
            .text(text, LEFT + CELL_PAD, top(key) + (opts.offset || 0),
                { width: COLS[0] - CELL_PAD * 2, lineGap: opts.lineGap || 0 });
        const valueLeft = x(1) + CELL_PAD;
        const valueWidth = TABLE_RIGHT - x(1) - CELL_PAD * 2;

        // ── Row 1: Date / Time / Number of Hours, each with its answer beneath ──
        const whenCells = [
            ['Date of Consultation', form.date, x(0), x(2)],
            ['Time of Consultation', form.time, x(2), x(3)],
            ['Number of Hours', form.hours, x(3), x(4)],
        ];
        whenCells.forEach(([text, value, l, r]) => {
            doc.font('Form').fontSize(FONT_SIZE)
                .text(text, l + CELL_PAD, top('when'), { width: r - l - CELL_PAD * 2, lineBreak: false });
            fitText(doc, value, {
                left: l + CELL_PAD, top: top('when') + LINE, width: r - l - CELL_PAD * 2, height: LINE,
            });
        });

        // ── Row 2: Format, with the box for this consultation ticked ──
        label('Format of Consultation\n(please check appropriate box)', 'format');
        FORMATS.forEach((f, i) => {
            const lineTop = top('format') + LINE * (i + 1);
            checkbox(doc, valueLeft, lineTop, form.format === f.key);
            doc.font('Form').fontSize(FONT_SIZE)
                .text(' ' + f.label, valueLeft + 7.4 + 3.6, lineTop, { lineBreak: false });
        });

        // ── Rows 3–6: label on the left, the appointment's value on the right ──
        label('Subject (place course code and course title)', 'subject');
        fitText(doc, form.subject, { left: valueLeft, top: top('subject'), width: valueWidth, height: height('subject') });

        label('Name of Instructor', 'instructor', { offset: (height('instructor') - LINE) / 2 });
        fitText(doc, form.instructor, {
            left: valueLeft, top: top('instructor') + (height('instructor') - LINE) / 2, width: valueWidth, height: LINE,
        });

        label('Name of Student/s', 'students');
        const studentText = (form.students || [])
            .map(s => s.detail ? `${s.name}  (${s.detail})` : s.name).join('\n');
        fitText(doc, studentText, { left: valueLeft, top: top('students'), width: valueWidth, height: height('students') });

        label('Summary of Consultation', 'summary');
        fitText(doc, form.summary, {
            left: valueLeft, top: top('summary') + 2, width: valueWidth, height: height('summary') - 4,
        });

        // ── Row 7: Action Points, left blank on purpose for the instructor ──
        label('Action Points', 'actions');

        // ── Signatures: names printed above the lines, signed by hand ──
        const sigBaseline = tableBottom + 12 + 10.2;     // spacing before 240 twips, then the line's ascent
        const lineY = sigBaseline + 2;
        doc.font('Form').fontSize(FONT_SIZE);
        doc.text('Submitted by:', LEFT, sigBaseline - 9.3, { lineBreak: false });
        doc.text('Noted by:', 331.7, sigBaseline - 9.3, { lineBreak: false });
        doc.save().lineWidth(0.6);
        doc.moveTo(136.9, lineY).lineTo(300.8, lineY).stroke();
        doc.moveTo(375.9, lineY).lineTo(520.1, lineY).stroke();
        doc.restore();

        // Centred on its line, a little smaller for a long name, always on the
        // line's own baseline so the signature goes over the printed name
        const signee = (who, l, r) => {
            if (!who || !who.name) return;
            const text = who.date ? `${who.name}  ·  ${who.date}` : who.name;
            const room = r - l - 4;
            doc.font('Form');
            let s = 10;
            for (; s > 7; s -= 0.5) {
                doc.fontSize(s);
                if (doc.widthOfString(text) <= room) break;
            }
            doc.fontSize(s);
            const textTop = lineY - 1.5 - doc.currentLineHeight() * 0.8;
            doc.text(text, l, textTop, { width: r - l, align: 'center', lineBreak: false, ellipsis: true });
        };
        signee(form.submittedBy, 136.9, 300.8);
        signee(form.notedBy, 375.9, 520.1);

        doc.font('Form').fontSize(FONT_SIZE);
        doc.text('Name of Student/Signature Date', 143.8, lineY + 6, { lineBreak: false });
        doc.text('Name of Inst./Signature/Date', 382.2, lineY + 6, { lineBreak: false });

        doc.end();
    });
}

// ── Filling the form from an appointment ─────────────────────────────────────
// Shared by the instructor and student endpoints, so both print the same form.

/** "Glen Mark A. Zabala": first, middle initial, last. */
function fullName(first, middle, last) {
    const initial = middle && middle.trim() ? `${middle.trim()[0].toUpperCase()}.` : '';
    return [first, initial, last].filter(Boolean).join(' ');
}

/** 'YYYY-MM-DD' (or a Date) as "August 27, 2026", or as "08/27/2026" with numeric. */
function formDate(value, numeric = false) {
    const key = value instanceof Date
        ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
        : String(value).slice(0, 10);
    const [y, m, d] = key.split('-').map(Number);
    if (numeric) return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * A completed appointment as the consultation log form's fields.
 *
 * FaciTrack books every consultation ahead, so face-to-face is the form's
 * "scheduled meeting"; an online one is its "online" box. The summary is what
 * the student booked it for and their note, plus where it was held. Action
 * Points is not filled in — that is for the instructor to write.
 */
function consultationFormFields(row) {
    const minutes = minutesBetween(row.start_time, row.end_time);
    const hours = Math.round((minutes / 60) * 100) / 100;

    const student = fullName(row.student_first_name, row.student_middle_name, row.student_last_name);
    const instructor = fullName(row.instructor_first_name, row.instructor_middle_name, row.instructor_last_name);

    let venue;
    if (row.mode === 'Online') {
        const link = String(row.meeting_link || '');
        venue = /meet\.google\.com/i.test(link) ? 'Held online via Google Meet.'
            : /zoom\.us/i.test(link) ? 'Held online via Zoom.'
            : 'Held online.';
    } else {
        venue = row.room_number ? `Held face-to-face in ${row.room_number}.` : 'Held face-to-face.';
    }

    const summary = [
        `Topic: ${row.topic}`,
        row.notes && row.notes.trim() ? `Student's notes: ${row.notes.trim()}` : null,
        venue,
    ].filter(Boolean).join('\n');

    return {
        date: formDate(row.consultation_date),
        time: `${to12Hour(row.start_time)} – ${to12Hour(row.end_time)}`,
        hours: `${hours} hr${hours === 1 ? '' : 's'} (${minutes} mins)`,
        format: row.mode === 'Online' ? 'online' : 'scheduled',
        subject: row.course_subject || '',
        instructor,
        students: [{
            name: student,
            detail: [row.student_number, row.section_group_name].filter(Boolean).join(' · '),
        }],
        summary,
        submittedBy: { name: student, date: formDate(row.consultation_date, true) },
        // Noted on the day it was marked complete, which is when the
        // instructor actually signed it off
        notedBy: { name: instructor, date: formDate(row.completed_at || row.consultation_date, true) },
        fileName: `consultation-form-${String(row.student_last_name || 'student').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${String(row.consultation_date).slice(0, 10)}.pdf`,
    };
}

module.exports = { buildConsultationFormPdf, consultationFormFields };
