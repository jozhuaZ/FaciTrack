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

    var wrap = document.createElement('div');
    wrap.innerHTML =
      '<div id="docPreviewModal" style="display:none;position:fixed;inset:0;z-index:2500;background:rgba(0,0,0,.6);align-items:center;justify-content:center;padding:1rem">' +
      '  <div style="background:#fff;border-radius:16px;width:100%;max-width:980px;height:90vh;display:flex;flex-direction:column;box-shadow:0 25px 70px rgba(0,0,0,.3);overflow:hidden">' +
      '    <div style="display:flex;align-items:center;justify-content:space-between;padding:1rem 1.5rem;border-bottom:1px solid #e5e7eb;background:#f8fafc;gap:.75rem;flex-wrap:wrap">' +
      '      <div style="display:flex;flex-direction:column;gap:2px;min-width:220px">' +
      '        <h3 id="docPreviewTitle" style="font-size:1rem;font-weight:800;color:#111827;margin:0">Document Preview</h3>' +
      '        <p id="docPreviewSub" style="font-size:.75rem;color:#6b7280;margin:0">Preview → choose save format or print</p>' +
      '      </div>' +
      '      <div style="display:flex;gap:.5rem;flex-wrap:wrap;justify-content:flex-end">' +
      '        <button id="docPreviewCancel" class="btn-page" style="height:36px;padding:0 1rem">Close</button>' +
      '        <button id="docPreviewPrint" class="btn-page" style="height:36px;padding:0 1rem">Print</button>' +
      '        <button id="docPreviewPdf" class="btn-header-action primary" style="height:36px;padding:0 1rem;font-size:.75rem">Save as PDF</button>' +
      '        <button id="docPreviewDocx" class="btn-page" style="height:36px;padding:0 1rem">Save as DOCX</button>' +
      '        <button id="docPreviewXlsx" class="btn-page" style="height:36px;padding:0 1rem">Save as XLSX</button>' +
      '      </div>' +
      '    </div>' +
      '    <div id="docPreviewScroll" style="flex:1;overflow:auto;padding:2.5rem;background:#e5e7eb;display:flex;justify-content:center">' +
      '      <div id="docPreviewArea" style="background:#fff;width:210mm;min-height:297mm;padding:18mm 18mm;box-shadow:0 0 20px rgba(0,0,0,.1);font-family:Arial,Helvetica,sans-serif;color:#000">' +
      '      </div>' +
      '    </div>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(wrap.firstChild);

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

  var state = { payload: null, html: '' };

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
    state.html = buildDocumentHtml(state.payload);

    titleEl.textContent = opts.title || 'Document Preview';
    subEl.textContent = 'Preview → choose save format or print';
    area.innerHTML = state.html;

    modal.style.display = 'flex';
    setBusy(false);
  }

  function closePreview() {
    var modal = document.getElementById('docPreviewModal');
    if (modal) modal.style.display = 'none';
    setBusy(false);
  }

  function printPreview() {
    // Print should match preview; easiest reliable way is a new window containing the same HTML.
    var win = window.open('', '_blank', 'width=1200,height=900');
    if (!win) return;
    var html =
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
        try {
          setBusy(true);
          await postExport('pdf', state.payload);
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

