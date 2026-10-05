/* global fetch */
(function () {
  'use strict';

  function esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function ensurePreviewModal() {
    if (document.getElementById('docPreviewModal')) return;

    // Screen styles live in one block so the header can reflow on phones:
    // title on the left, actions on the right, Close always last (far right).
    var css = document.createElement('style');
    css.textContent =
      '#docPreviewModal{display:none;position:fixed;inset:0;z-index:2500;background:rgba(0,0,0,.6);align-items:center;justify-content:center;padding:1rem}' +
      '.dp-dialog{background:#fff;border-radius:16px;width:100%;max-width:980px;height:90vh;display:flex;flex-direction:column;box-shadow:0 25px 70px rgba(0,0,0,.3);overflow:hidden}' +
      '.dp-head{display:flex;align-items:center;justify-content:space-between;padding:1rem 1.25rem 1rem 1.5rem;border-bottom:1px solid #e5e7eb;background:#f8fafc;gap:.75rem;flex-wrap:wrap}' +
      '.dp-heading{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 220px}' +
      '.dp-heading h3{font-size:1rem;font-weight:800;color:#111827;margin:0}' +
      '.dp-heading p{font-size:.75rem;color:#6b7280;margin:0}' +
      '.dp-actions{display:flex;gap:.5rem;flex-wrap:wrap;justify-content:flex-end;align-items:center}' +
      '.dp-actions .btn-page,.dp-actions .btn-header-action{height:36px;padding:0 1rem;font-size:.75rem}' +
      '.dp-sep{width:1px;height:24px;background:#e5e7eb;margin:0 .125rem}' +
      '.dp-close{display:inline-flex;align-items:center;gap:.3rem}' +
      '#docPreviewScroll{flex:1;overflow:auto;padding:2.5rem;background:#e5e7eb;display:flex;justify-content:center;align-items:flex-start}' +
      '#docPreviewArea{background:#fff;width:210mm;min-height:297mm;padding:18mm;box-shadow:0 0 20px rgba(0,0,0,.1);font-family:Arial,Helvetica,sans-serif;color:#000;flex-shrink:0}' +
      '#docPreviewArea.is-frame{padding:0}' +
      '#docPreviewArea iframe{display:block;width:100%;min-height:297mm;border:0}' +
      // A server-made PDF, drawn page by page at its own proportions
      '#docPreviewArea.is-pdf{width:min(100%,8.5in);min-height:0;padding:0;background:transparent;box-shadow:none}' +
      '#docPreviewArea.is-pdf canvas{display:block;width:100%;height:auto;background:#fff;box-shadow:0 0 20px rgba(0,0,0,.12)}' +
      '#docPreviewArea.is-pdf canvas+canvas{margin-top:1rem}' +
      '#docPreviewArea.is-pdf iframe{min-height:70vh}' +
      '.dp-status{background:#fff;border-radius:12px;padding:2rem 1.5rem;text-align:center;color:#6b7280;font-size:.85rem;font-family:inherit;box-shadow:0 0 20px rgba(0,0,0,.08)}' +
      '.dp-status.is-error{color:#b91c1c}' +
      '@media (max-width:640px){' +
      '  #docPreviewModal{padding:0}' +
      '  .dp-dialog{height:100%;border-radius:0}' +
      '  .dp-head{padding:.875rem 1rem}' +
      '  .dp-actions{width:100%;justify-content:flex-start}' +
      '  .dp-sep{display:none}' +
      '  .dp-close{margin-left:auto}' +
      '  #docPreviewScroll{padding:1rem;justify-content:flex-start}' +
      '}';
    document.head.appendChild(css);

    var wrap = document.createElement('div');
    wrap.innerHTML =
      '<div id="docPreviewModal" role="dialog" aria-modal="true" aria-labelledby="docPreviewTitle">' +
      '  <div class="dp-dialog">' +
      '    <div class="dp-head">' +
      '      <div class="dp-heading">' +
      '        <h3 id="docPreviewTitle">Document Preview</h3>' +
      '        <p id="docPreviewSub">Preview → choose save format or print</p>' +
      '      </div>' +
      '      <div class="dp-actions">' +
      '        <button id="docPreviewPrint" type="button" class="btn-page">Print</button>' +
      '        <button id="docPreviewPdf" type="button" class="btn-header-action primary">Save as PDF</button>' +
      '        <button id="docPreviewDocx" type="button" class="btn-page">Save as DOCX</button>' +
      '        <button id="docPreviewXlsx" type="button" class="btn-page">Save as XLSX</button>' +
      '        <span class="dp-sep" aria-hidden="true"></span>' +
      '        <button id="docPreviewCancel" type="button" class="btn-page dp-close">' +
      '          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Close' +
      '        </button>' +
      '      </div>' +
      '    </div>' +
      '    <div id="docPreviewScroll">' +
      '      <div id="docPreviewArea"></div>' +
      '    </div>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(wrap.firstChild);

    // Backdrop tap and Escape close it, like the other modals
    var modal = document.getElementById('docPreviewModal');
    modal.addEventListener('click', function (e) { if (e.target === modal) closePreview(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal.style.display === 'flex') closePreview();
    });

    // Basic print CSS so print matches preview
    var style = document.createElement('style');
    style.textContent =
      '@media print{' +
      '  body *{visibility:hidden!important;}' +
      '  #docPrintHost, #docPrintHost *{visibility:visible!important;}' +
      '  #docPrintHost{position:absolute;left:0;top:0;width:100%!important;}' +
      '  @page{size:auto;margin:12mm;}' +
      '}';
    document.head.appendChild(style);
  }

  function setBusy(isBusy) {
    ['docPreviewPdf', 'docPreviewDocx', 'docPreviewXlsx', 'docPreviewPrint'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.disabled = !!isBusy;
      el.style.opacity = isBusy ? '0.7' : '';
      el.style.cursor = isBusy ? 'wait' : '';
    });
  }

  async function postExport(format, payload) {
    var res = await fetch('/export/' + format, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      var txt = '';
      try {
        txt = await res.text();
      } catch (e) {}
      throw new Error('Export failed. ' + (txt || ''));
    }
    var blob = await res.blob();
    var dispo = res.headers.get('content-disposition') || '';
    var match = dispo.match(/filename="([^"]+)"/);
    var filename = match ? match[1] : 'report.' + format;

    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 2500);
  }

  function buildDocumentHtml(opts) {
    var title = esc(opts.title || 'Report');
    var subtitle = esc(opts.subtitle || '');
    var meta = Array.isArray(opts.meta) ? opts.meta : [];
    var columns = Array.isArray(opts.columns) ? opts.columns : [];
    var rows = Array.isArray(opts.rows) ? opts.rows : [];

    var metaHtml = meta
      .filter(Boolean)
      .slice(0, 6)
      .map(function (m) {
        return '<div style="font-size:10pt;color:#6b7280;margin-top:2px">' + esc(m) + '</div>';
      })
      .join('');

    var headCells = columns
      .map(function (c) {
        return '<th style="border:1px solid #d1d5db;padding:8px;text-align:left;background:#f3f4f6;font-size:9pt;color:#374151;text-transform:uppercase;letter-spacing:.04em">' + esc(c) + '</th>';
      })
      .join('');

    var bodyHtml = '';
    if (!rows.length) {
      bodyHtml = '<tr><td colspan="' + Math.max(1, columns.length) + '" style="border:1px solid #d1d5db;padding:18px;text-align:center;color:#6b7280">No records found.</td></tr>';
    } else {
      bodyHtml = rows
        .map(function (r) {
          var tds = r
            .map(function (cell) {
              return '<td style="border:1px solid #e5e7eb;padding:8px;font-size:10pt;color:#111827;vertical-align:top">' + esc(cell) + '</td>';
            })
            .join('');
          return '<tr>' + tds + '</tr>';
        })
        .join('');
    }

    return (
      '<div style="position:relative;padding-bottom:10px;margin-bottom:14px;border-bottom:2px solid #000">' +
      '  <div style="font-size:8pt;font-weight:700;text-align:right;margin-bottom:4px">CSPC-F-STA-01</div>' +
      '  <img src="/images/CSPC-logo.png" alt="CSPC" style="width:54px;height:54px;object-fit:contain;position:absolute;left:0;top:10px" onerror="this.style.display=\'none\'">' +
      '  <div style="text-align:center;padding-left:60px">' +
      '    <div style="font-size:7pt;font-weight:700;letter-spacing:0.05em;margin-bottom:2px">REPUBLIC OF THE PHILIPPINES</div>' +
      '    <div style="font-size:12pt;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;margin:2px 0">Camarines Sur Polytechnic Colleges</div>' +
      '    <div style="font-size:10pt;text-transform:uppercase;margin:1px 0">College of Computer Studies</div>' +
      '    <div style="font-size:16pt;font-weight:800;margin-top:6px;color:#000">' +
      title +
      '</div>' +
      (subtitle ? '<div style="font-size:10.5pt;font-weight:600;margin-top:3px">' + subtitle + '</div>' : '') +
      '  </div>' +
      '</div>' +
      '<table style="width:100%;border-collapse:collapse">' +
      '<thead><tr>' +
      headCells +
      '</tr></thead>' +
      '<tbody>' +
      bodyHtml +
      '</tbody>' +
      '</table>' +
      '<div style="margin-top:14px;font-size:9pt;color:#000;display:flex;justify-content:space-between;gap:12px">' +
      '  <div>Generated: ' +
      esc(new Date().toLocaleString()) +
      '</div>' +
      '  <div style="text-align:right">FaciTrack</div>' +
      '</div>'
    );
  }

  // html: the body shown and printed. doc: set when the caller supplied its own
  // full document (the workload form), which is previewed in an iframe.
  var state = { payload: null, html: '', doc: '', pdf: null };

  /* ── PDF mode ──
     For a document the server already lays out as a PDF (the consultation
     form), the preview is that very file, drawn with pdf.js — so what is shown
     is exactly what is saved, on a phone as much as a desktop, where an inline
     PDF viewer is often missing. */
  var PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.6.205/build/';
  var pdfjsReady = null;

  function loadPdfJs() {
    if (pdfjsReady) return pdfjsReady;
    pdfjsReady = import(PDFJS + 'pdf.min.mjs').then(function (lib) {
      // A worker cannot be started straight from another origin; a same-origin
      // stub that imports it can
      var stub = new Blob(['import "' + PDFJS + 'pdf.worker.min.mjs";'], { type: 'text/javascript' });
      lib.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(stub), { type: 'module' });
      return lib;
    });
    pdfjsReady.catch(function () { pdfjsReady = null; });   // let the next preview retry
    return pdfjsReady;
  }

  function showStatus(area, text, isError) {
    area.innerHTML = '<div class="dp-status' + (isError ? ' is-error' : '') + '">' + esc(text) + '</div>';
  }

  async function renderPdf(area, blob, token) {
    try {
      var lib = await loadPdfJs();
      var doc = await lib.getDocument({ data: await blob.arrayBuffer() }).promise;
      if (state.pdf !== token) return;
      area.innerHTML = '';
      // Sharp on a high-density screen without drawing a poster-sized bitmap
      var targetWidth = Math.min(area.clientWidth || 816, 1100) * Math.min(window.devicePixelRatio || 1, 2);
      for (var n = 1; n <= doc.numPages; n++) {
        var page = await doc.getPage(n);
        var base = page.getViewport({ scale: 1 });
        var viewport = page.getViewport({ scale: Math.max(targetWidth / base.width, 1.5) });
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        canvas.setAttribute('aria-label', 'Page ' + n + ' of the document');
        area.appendChild(canvas);
        await page.render({ canvas: canvas, viewport: viewport }).promise;
      }
    } catch (err) {
      // pdf.js could not load (offline, blocked): fall back to the browser's viewer
      if (state.pdf !== token) return;
      area.innerHTML = '';
      var frame = document.createElement('iframe');
      frame.title = 'Document preview';
      frame.src = URL.createObjectURL(blob);
      area.appendChild(frame);
    }
  }

  async function openPdfPreview(opts) {
    var area = document.getElementById('docPreviewArea');
    var token = { url: opts.pdf.url, filename: opts.pdf.filename || 'document.pdf', blob: null };
    state.pdf = token;
    showStatus(area, 'Preparing the document…');
    try {
      var res = await fetch(opts.pdf.url, { credentials: 'same-origin' });
      if (!res.ok) {
        var msg = 'The document could not be prepared.';
        try { msg = (await res.json()).error || msg; } catch (e) {}
        throw new Error(msg);
      }
      var dispo = res.headers.get('content-disposition') || '';
      var match = dispo.match(/filename="([^"]+)"/);
      if (match) token.filename = match[1];
      token.blob = await res.blob();
      if (state.pdf !== token) return;
      document.getElementById('docPreviewPdf').disabled = false;
      await renderPdf(area, token.blob, token);
    } catch (err) {
      if (state.pdf === token) showStatus(area, err.message || 'The document could not be prepared.', true);
    }
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2500);
  }

  function openPreview(opts) {
    ensurePreviewModal();

    var modal = document.getElementById('docPreviewModal');
    var area = document.getElementById('docPreviewArea');
    var titleEl = document.getElementById('docPreviewTitle');
    var subEl = document.getElementById('docPreviewSub');

    state.payload = {
      title: opts.title || 'Report',
      subtitle: opts.subtitle || '',
      meta: opts.meta || [],
      columns: opts.columns || [],
      rows: opts.rows || [],
    };
    state.doc = opts.html || '';
    state.html = state.doc ? '' : buildDocumentHtml(state.payload);

    titleEl.textContent = opts.title || 'Document Preview';
    subEl.textContent = opts.subtitle || 'Preview → choose save format or print';

    var pdfBtn = document.getElementById('docPreviewPdf');
    if (opts.pdf && opts.pdf.url) {
      // One document, one format: Download PDF and Close
      area.classList.remove('is-frame');
      area.classList.add('is-pdf');
      ['docPreviewPrint', 'docPreviewDocx', 'docPreviewXlsx'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });
      pdfBtn.textContent = 'Download PDF';
      pdfBtn.style.display = '';
      modal.style.display = 'flex';
      setBusy(false);
      pdfBtn.disabled = true;        // until the file has arrived
      openPdfPreview(opts);
      return;
    }
    state.pdf = null;
    area.classList.remove('is-pdf');
    pdfBtn.textContent = 'Save as PDF';
    document.getElementById('docPreviewPrint').style.display = '';

    area.classList.toggle('is-frame', !!state.doc);
    if (state.doc) {
      // Its own stylesheet must not leak into the page, hence the iframe
      area.innerHTML = '';
      var frame = document.createElement('iframe');
      frame.title = 'Document preview';
      frame.addEventListener('load', function () {
        try { frame.style.height = frame.contentDocument.documentElement.scrollHeight + 'px'; } catch (e) { /* cross-origin */ }
      });
      frame.srcdoc = state.doc;
      area.appendChild(frame);
    } else {
      area.innerHTML = state.html;
    }

    // Save-as needs table rows; a document without them can only be printed
    var canSave = state.payload.columns.length > 0;
    ['docPreviewPdf', 'docPreviewDocx', 'docPreviewXlsx'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = canSave ? '' : 'none';
    });

    modal.style.display = 'flex';
    setBusy(false);
  }

  function closePreview() {
    var modal = document.getElementById('docPreviewModal');
    if (modal) modal.style.display = 'none';
    state.pdf = null;
    setBusy(false);
  }

  function printPreview() {
    // Print should match preview; easiest reliable way is a new window containing the same HTML.
    var win = window.open('', '_blank', 'width=1200,height=900');
    if (!win) return;
    var html = state.doc ||
      '<!doctype html><html><head><meta charset="utf-8"><title>' +
      esc(state.payload?.title || 'Report') +
      '</title>' +
      '<style>@page{margin:12mm} body{margin:0;font-family:Arial,Helvetica,sans-serif} .page{padding:12mm}</style>' +
      '</head><body><div class="page">' +
      (state.html || '') +
      '</div></body></html>';
    win.document.open();
    win.document.write(html);
    win.document.close();
    setTimeout(function () {
      win.focus();
      win.print();
    }, 350);
  }

  function wireButtons() {
    ensurePreviewModal();
    var cancel = document.getElementById('docPreviewCancel');
    var pdf = document.getElementById('docPreviewPdf');
    var docx = document.getElementById('docPreviewDocx');
    var xlsx = document.getElementById('docPreviewXlsx');
    var prn = document.getElementById('docPreviewPrint');

    if (cancel && !cancel.__wired) {
      cancel.__wired = true;
      cancel.addEventListener('click', closePreview);
    }
    if (prn && !prn.__wired) {
      prn.__wired = true;
      prn.addEventListener('click', function () {
        printPreview();
      });
    }
    if (pdf && !pdf.__wired) {
      pdf.__wired = true;
      pdf.addEventListener('click', async function () {
        if (state.pdf) {
          if (state.pdf.blob) saveBlob(state.pdf.blob, state.pdf.filename);
          return;
        }
        try {
          setBusy(true);
          await postExport('pdf', state.payload);
        } catch (err) {
          alert(err.message || 'Export failed.');
        } finally {
          setBusy(false);
        }
      });
    }
    if (docx && !docx.__wired) {
      docx.__wired = true;
      docx.addEventListener('click', async function () {
        try {
          setBusy(true);
          await postExport('docx', state.payload);
        } catch (err) {
          alert(err.message || 'Export failed.');
        } finally {
          setBusy(false);
        }
      });
    }
    if (xlsx && !xlsx.__wired) {
      xlsx.__wired = true;
      xlsx.addEventListener('click', async function () {
        try {
          setBusy(true);
          await postExport('xlsx', state.payload);
        } catch (err) {
          alert(err.message || 'Export failed.');
        } finally {
          setBusy(false);
        }
      });
    }
  }

  function rowsFromTable(tableEl, onlyVisible) {
    var table = tableEl;
    if (typeof tableEl === 'string') table = document.querySelector(tableEl);
    if (!table) return { columns: [], rows: [] };
    var columns = Array.from(table.querySelectorAll('thead th')).map(function (th) {
      return th.textContent.trim();
    });
    var trs = Array.from(table.querySelectorAll('tbody tr'));
    if (onlyVisible) {
      trs = trs.filter(function (tr) {
        var ds = getComputedStyle(tr);
        return ds.display !== 'none' && ds.visibility !== 'hidden';
      });
    }
    var rows = trs.map(function (tr) {
      return Array.from(tr.querySelectorAll('td')).map(function (td) {
        return td.textContent.trim();
      });
    });
    return { columns: columns, rows: rows };
  }

  // Public API
  window.ExportSystem = {
    openPreview: function (opts) {
      wireButtons();
      openPreview(opts);
    },
    fromTable: function (opts) {
      var t = rowsFromTable(opts.table, opts.onlyVisible !== false);
      window.ExportSystem.openPreview({
        title: opts.title,
        subtitle: opts.subtitle,
        meta: opts.meta,
        columns: t.columns,
        rows: t.rows,
      });
    },
  };
})();

