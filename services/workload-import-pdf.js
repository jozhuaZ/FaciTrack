/**
 * FaciTrack — workload import, PDF side.
 *
 * The CSPC workload form is a Word document; this reads the same form after it
 * has been exported to PDF. A PDF has no table markup, but Word draws the table
 * as vector rules, and those rules carry the one thing that matters most:
 *
 *   a horizontal rule between two rows is drawn in every column EXCEPT where
 *   the cell is merged downward.
 *
 * That is exactly what <w:vMerge continue> records in the .docx, so a missing
 * rule becomes merge:'continue' and the shared normalizeTable() derives the same
 * duration from it. The output feeds interpretTables() untouched — the rules for
 * what a cell *means* live in workload-import.js and are never duplicated here.
 */

const { interpretTables, OVERLOAD_FILL } = require('./workload-import');

// Rules are hairline; anything thicker is a box or a filled band, not a rule.
const RULE_THICKNESS = 2;
// Shortest run that can be a table rule rather than an underline or a tick.
const MIN_RULE_LENGTH = 25;
// Two coordinates within this many points describe the same rule. Word emits a
// rule per cell edge, so the same grid line arrives many times, a hair apart.
const SNAP = 3;

/** Group near-identical coordinates and return one representative each. */
function cluster(values, tolerance = SNAP) {
    const sorted = [...values].sort((a, b) => a - b);
    const out = [];
    let run = [];
    for (const v of sorted) {
        if (run.length && v - run[run.length - 1] > tolerance) {
            out.push(run.reduce((s, n) => s + n, 0) / run.length);
            run = [];
        }
        run.push(v);
    }
    if (run.length) out.push(run.reduce((s, n) => s + n, 0) / run.length);
    return out;
}

/**
 * Every straight rule on the page, from the path bounding boxes.
 *
 * pdf.js hands constructPath a [minX, minY, maxX, maxY] box per path. A table
 * rule is a path whose box is long in one axis and hairline in the other, which
 * is cheaper and steadier to test than walking the path operators.
 */
function readRules(operatorList, OPS) {
    const name = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k]));
    const horizontal = [];
    const vertical = [];

    operatorList.fnArray.forEach((fn, i) => {
        if (name[fn] !== 'constructPath') return;
        const box = operatorList.argsArray[i][2];
        if (!box) return;

        const [ax, ay, bx, by] = Array.from(box);
        const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
        const y0 = Math.min(ay, by), y1 = Math.max(ay, by);
        const width = x1 - x0, height = y1 - y0;

        if (height <= RULE_THICKNESS && width >= MIN_RULE_LENGTH) {
            horizontal.push({ y: (y0 + y1) / 2, x0, x1 });
        } else if (width <= RULE_THICKNESS && height >= 10) {
            vertical.push({ x: (x0 + x1) / 2, y0, y1 });
        }
    });

    return { horizontal, vertical };
}

/**
 * The grid: the column edges and row edges of the largest ruled table.
 *
 * The page also carries the header box and the signature block, so candidate
 * edges are filtered to those belonging to the widest run of evenly spaced
 * verticals — the schedule is the only table on the form with eight columns.
 */
function readGrid(rules) {
    const columns = cluster(rules.vertical.map(r => r.x));
    if (columns.length < 4) {
        throw new Error('No schedule grid was found in this PDF — its column lines are missing.');
    }

    // Rows: only rules that span at least one whole column are grid rows; a
    // short rule inside a cell (an underline) must not open a new row.
    const columnWidth = columns[1] - columns[0];
    const spanning = rules.horizontal.filter(r => (r.x1 - r.x0) >= columnWidth * 0.8);

    // The column rules mark where the table starts and ends vertically. Without
    // this bound the letterhead rule and the signature block below the grid
    // become extra rows, and every cell in them is reported as an entry whose
    // row has no readable time.
    const tableTop = Math.max(...rules.vertical.map(r => r.y1));
    const tableBottom = Math.min(...rules.vertical.map(r => r.y0));

    const rows = cluster(spanning.map(r => r.y))
        .filter(y => y >= tableBottom - SNAP && y <= tableTop + SNAP)
        .sort((a, b) => b - a); // top-down

    if (rows.length < 3) {
        throw new Error('No schedule grid was found in this PDF — its row lines are missing.');
    }
    return { columns, rows, horizontal: rules.horizontal };
}

/**
 * Is the rule between two rows drawn across this column?
 *
 * Absent means the cell above continues into this row — Word omits the internal
 * border of a vertically merged cell. This is the whole reason durations survive
 * the export.
 */
function ruleAcross(horizontal, y, xLeft, xRight) {
    const midpoint = (xLeft + xRight) / 2;
    return horizontal.some(r =>
        Math.abs(r.y - y) <= SNAP &&
        r.x0 <= midpoint + SNAP &&
        r.x1 >= midpoint - SNAP
    );
}

/** Text items grouped into lines, ordered top-down then left-to-right. */
function cellLines(items, xLeft, xRight, yBottom, yTop) {
    const inside = items.filter(t =>
        t.x >= xLeft - SNAP && t.x < xRight + SNAP &&
        t.y > yBottom + 1 && t.y <= yTop - 1
    );
    if (!inside.length) return [];

    // One visual line per cluster of baselines.
    const baselines = cluster(inside.map(t => t.y), 4).sort((a, b) => b - a);
    return baselines
        .map(base => inside
            .filter(t => Math.abs(t.y - base) <= 4)
            .sort((a, b) => a.x - b.x)
            .map(t => t.str)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim())
        .filter(Boolean);
}

/**
 * Yellow shading marks an overload block on this form. Word paints it as a
 * filled rectangle behind the cell, so a fill is attributed to whichever cell
 * contains its centre.
 */
function readFills(operatorList, OPS) {
    const name = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k]));
    const fills = [];
    let current = null;

    operatorList.fnArray.forEach((fn, i) => {
        const op = name[fn];
        if (op === 'setFillRGBColor') {
            // pdf.js hands this over as a CSS hex string ("#ffff00"), not as
            // three numbers.
            current = operatorList.argsArray[i][0];
        } else if (op === 'constructPath' && current) {
            const box = operatorList.argsArray[i][2];
            if (!box) return;
            const [ax, ay, bx, by] = Array.from(box);
            const width = Math.abs(bx - ax), height = Math.abs(by - ay);
            // Only real areas — a hairline path is a rule that happens to be filled.
            if (width < 8 || height < 8) return;

            const rgb = /^#([0-9a-f]{6})$/i.exec(String(current));
            if (!rgb) return;
            const value = parseInt(rgb[1], 16);
            const r = (value >> 16) & 0xff, g = (value >> 8) & 0xff, b = value & 0xff;

            // Yellow: red and green high, blue low. Matched by eye rather than
            // exactly, since an export can shift the shade a little.
            if (r > 200 && g > 200 && b < 120) {
                fills.push({ x: (ax + bx) / 2, y: (ay + by) / 2 });
            }
        }
    });
    return fills;
}

/**
 * Read the schedule grid out of an exported workload form.
 *
 * @param {Buffer} buffer the uploaded .pdf
 * @returns {Promise<{semester, blocks, skipped, roomLabels, warnings}>}
 */
/**
 * Give pdf.js the browser classes it expects, before it loads.
 *
 * pdf.js v5 needs DOMMatrix, ImageData and Path2D, which Node does not have.
 * It fills them itself from @napi-rs/canvas — but loads that package through a
 * require it builds at runtime (createRequire(import.meta.url)), which a
 * serverless bundler cannot see. On Vercel the package, and its native Linux
 * binary, were therefore left out of the function: pdf.js only logged a
 * warning, then failed with "DOMMatrix is not defined". Locally the package
 * is simply sitting in node_modules, which is why it worked there.
 *
 * Requiring it here, statically, is what lets the bundler trace it (and the
 * platform binary it requires in turn) into the deployment. With the globals
 * already set, pdf.js skips its own attempt.
 */
function installCanvasGlobals() {
    if (globalThis.DOMMatrix && globalThis.ImageData && globalThis.Path2D) return;

    let canvas;
    try {
        canvas = require('@napi-rs/canvas');
    } catch (err) {
        // Said plainly, rather than surfacing later as an unexplained DOMMatrix error.
        throw new Error('PDF import is unavailable on this server: its PDF engine could not load '
            + `(@napi-rs/canvas: ${err.message}). A .docx workload file will still import.`);
    }
    if (!globalThis.DOMMatrix) globalThis.DOMMatrix = canvas.DOMMatrix;
    if (!globalThis.ImageData) globalThis.ImageData = canvas.ImageData;
    if (!globalThis.Path2D) globalThis.Path2D = canvas.Path2D;
}

async function parseWorkloadPdf(buffer) {
    installCanvasGlobals();
    // pdf.js ships as ESM; the legacy build is the one that runs under Node.
    const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');

    let doc;
    try {
        doc = await getDocument({
            data: new Uint8Array(buffer),
            useSystemFonts: true,
            // The form is self-contained; refusing to fetch anything keeps a
            // malicious upload from making the server issue requests.
            isEvalSupported: false,
        }).promise;
    } catch {
        throw new Error('That file could not be opened as a PDF.');
    }

    const tables = [];
    let semester = null;

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        const page = await doc.getPage(pageNumber);
        const [textContent, operatorList] = await Promise.all([
            page.getTextContent(),
            page.getOperatorList(),
        ]);

        const items = textContent.items
            .filter(t => t.str && t.str.trim())
            .map(t => ({ str: t.str.trim(), x: t.transform[4], y: t.transform[5] }));

        if (!semester) {
            const line = items.find(t => /semester/i.test(t.str));
            if (line) semester = line.str;
        }

        let grid;
        try {
            grid = readGrid(readRules(operatorList, OPS));
        } catch {
            continue;   // a cover page or signature page — not the grid
        }

        const fills = readFills(operatorList, OPS);
        const rowCount = grid.rows.length - 1;
        const colCount = grid.columns.length - 1;

        // Which cells are continuations, resolved for the whole page first. A
        // merged cell has to know how far down it reaches before its text can be
        // read, and that answer lives in the row below it.
        const continues = [];
        for (let r = 0; r < rowCount; r++) {
            continues.push([]);
            for (let c = 0; c < colCount; c++) {
                // No rule along this cell's top edge means the cell above owns
                // it — the PDF's version of <w:vMerge continue>.
                continues[r][c] = r > 0 && !ruleAcross(
                    grid.horizontal, grid.rows[r], grid.columns[c], grid.columns[c + 1]);
            }
        }

        const rows = [];
        for (let r = 0; r < rowCount; r++) {
            const row = [];

            for (let c = 0; c < colCount; c++) {
                const xLeft = grid.columns[c];
                const xRight = grid.columns[c + 1];

                if (continues[r][c]) {
                    row.push({ lines: [], span: 1, merge: 'continue' });
                    continue;
                }

                // Word lays a merged cell's text out over the whole merged
                // height, so the read has to cover every row the cell owns.
                // Reading only the first band drops the section and room lines
                // and the block stops looking like a class at all.
                let last = r;
                while (last + 1 < rowCount && continues[last + 1][c]) last++;

                const yTop = grid.rows[r];
                const yBottom = grid.rows[last + 1];
                const shaded = fills.some(f =>
                    f.x > xLeft && f.x < xRight && f.y > yBottom && f.y < yTop);

                row.push({
                    lines: cellLines(items, xLeft, xRight, yBottom, yTop),
                    span: 1,
                    merge: last > r ? 'restart' : undefined,
                    fill: shaded ? OVERLOAD_FILL : undefined,
                });
            }
            rows.push(row);
        }

        if (rows.length) tables.push(rows);
    }

    if (!tables.length) {
        throw new Error('No schedule table was found in this PDF.');
    }

    return interpretTables(tables, semester);
}

module.exports = { parseWorkloadPdf };
