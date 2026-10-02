/**
 * ccs-building-monitor.js — the dean's 3D building as a live board.
 *
 * Every room the admin placed gets a pin; a room with somebody detected inside
 * gets a line rising above the roof with their faces on top. Presence comes
 * from the same feed as Faculty Monitoring (PresenceLive), so the two boards
 * can never disagree about who is where.
 *
 * Reads window.CCS_BOARD = { rooms: [...], faculty: [...] } from the page.
 */
/* globals THREE, ccsBoot, ccsCameraInit, ccsClock, ccsControls, ccsRenderer,
   ccsScene, ccsCamera, ccsCameraUpdateTransition, ccsBuildingCreate,
   ccsInteractionsInit, ccsResize, CcsPins */
(function () {
  'use strict';

  var board = window.CCS_BOARD || { rooms: [], faculty: [] };
  var rooms = board.rooms;
  var faculty = board.faculty;
  var esc = CcsPins.esc;

  var wrap = document.getElementById('ccs-canvas-wrap');
  var panel = document.getElementById('ccs-room-panel');
  var pinnedRoomId = null;     // the panel a click opened, which hover leaves alone
  var hoverRoomId = null;

  // ── Boot ──────────────────────────────────────────────────────────────────
  function hideLoading() {
    var el = document.getElementById('ccs-loading');
    if (el) el.style.display = 'none';
  }

  try { ccsBoot(); } catch (e) { console.error('ccsBoot failed:', e); }
  try { ccsCameraInit(); } catch (e) { console.error('ccsCameraInit failed:', e); }
  CcsPins.init({ onSelect: onSelect, onHover: onHover });

  (function loop() {
    requestAnimationFrame(loop);
    try {
      ccsClock.getDelta();
      ccsCameraUpdateTransition();
      if (ccsControls) ccsControls.update();
      ccsRenderer.render(ccsScene, ccsCamera);
      CcsPins.frame();
      if (pinnedRoomId || hoverRoomId) positionPanel(pinnedRoomId || hoverRoomId);
    } catch (e) { /* keep running */ }
  })();

  ccsBuildingCreate().then(hideLoading, hideLoading);
  setTimeout(hideLoading, 3000);   // show whatever is drawn, even if the model is slow
  ccsInteractionsInit({ onReset: closePanel });

  // ── Who is where ──────────────────────────────────────────────────────────
  // Faces with a photo lead the stack, so a crowded room shows the pictures
  // rather than hiding them behind "+N"; otherwise by name, so it holds still
  function occupantsOf(room) {
    return faculty.filter(function (f) {
      return f.presence === 'in-room' && String(f.roomId) === String(room.id);
    }).sort(function (a, b) {
      return (b.photo ? 1 : 0) - (a.photo ? 1 : 0) || String(a.name).localeCompare(String(b.name));
    });
  }

  function roomTitle(r, inside) {
    return r.number + (inside.length ? ' — ' + inside.length + ' inside' : ' — no one detected');
  }

  function render() {
    CcsPins.setRooms(rooms.map(function (r) {
      var inside = occupantsOf(r);
      return {
        id: r.id, number: r.number, floor: r.floor, type: r.type, pos: r.pos,
        occupants: inside, tone: inside.length ? 'live' : 'muted',
        title: roomTitle(r, inside),
      };
    }));
    renderSummary();
    var open = pinnedRoomId || hoverRoomId;
    if (open) fillPanel(roomById(open));
  }

  function renderSummary() {
    var placed = rooms.filter(function (r) { return r.pos; });
    var people = 0, busy = 0;
    placed.forEach(function (r) {
      var n = occupantsOf(r).length;
      people += n;
      if (n) busy++;
    });
    var text;
    if (!placed.length) text = 'No rooms placed on the building yet';
    else if (!people) text = 'No one detected in a room right now';
    else text = people + ' instructor' + (people === 1 ? '' : 's') +
      ' in ' + busy + ' room' + (busy === 1 ? '' : 's');
    document.getElementById('ccs-live-text').textContent = text;
  }

  function roomById(id) {
    return rooms.find(function (r) { return String(r.id) === String(id); }) || null;
  }

  // ── Room panel ────────────────────────────────────────────────────────────
  function fillPanel(r) {
    if (!r) return;
    var inside = occupantsOf(r);
    document.getElementById('rp-title').textContent = r.number;
    document.getElementById('rp-sub').textContent =
      'Floor ' + r.floor + ' · ' + r.type + (r.status === 'Inactive' ? ' · Inactive' : '');

    var body;
    if (inside.length) {
      body = '<p class="rp-label">Inside now (' + inside.length + ')</p><div class="rp-people">' +
        inside.map(function (f) {
          return '<div class="rp-person"><span class="rp-face">' + CcsPins.faceHtml(f) + '</span>' +
            '<div><p class="rp-name">' + esc(f.name) + '</p>' +
            '<p class="rp-meta">' + esc(f.position || 'Faculty') +
            (f.seen ? ' · detected ' + esc(f.seen) : '') + '</p></div></div>';
        }).join('') + '</div>';
    } else {
      body = '<p class="rp-empty">No one detected inside' +
        (r.assigned ? '. Assigned to ' + esc(r.assigned) + '.' : '.') + '</p>';
    }
    document.getElementById('rp-body').innerHTML = body;
  }

  function positionPanel(id) {
    // A phone pins the panel along the bottom in CSS; nothing to follow there
    if (window.matchMedia('(max-width: 640px)').matches) {
      panel.style.left = panel.style.top = '';
      return;
    }
    var a = CcsPins.anchorOf(id);
    if (!a) return;
    var wr = wrap.getBoundingClientRect();
    var pw = panel.offsetWidth || 250, ph = panel.offsetHeight || 140;
    // Beside the pin, flipped to its left near the right edge
    var x = a.right - wr.left + 12;
    if (x + pw > wr.width - 10) x = a.left - wr.left - pw - 12;
    var y = a.top - wr.top + a.height / 2 - ph / 2;
    panel.style.left = Math.max(10, x) + 'px';
    panel.style.top = Math.min(Math.max(56, y), wr.height - ph - 10) + 'px';
  }

  function openPanel(id, pinned) {
    var r = roomById(id);
    if (!r) return;
    if (pinned) pinnedRoomId = id; else hoverRoomId = id;
    fillPanel(r);
    panel.classList.remove('rp-hidden');
    panel.classList.add('rp-visible');
    panel.classList.toggle('rp-pinned', !!pinnedRoomId);
    positionPanel(id);
  }

  function closePanel() {
    pinnedRoomId = hoverRoomId = null;
    panel.classList.remove('rp-visible', 'rp-pinned');
    panel.classList.add('rp-hidden');
  }

  function onSelect(r) {
    if (String(pinnedRoomId) === String(r.id)) { closePanel(); return; }
    hoverRoomId = null;
    openPanel(r.id, true);
  }

  function onHover(r) {
    if (pinnedRoomId) return;          // a clicked panel stays put
    if (r) openPanel(r.id, false);
    else closePanel();
  }

  document.getElementById('room-panel-close').addEventListener('click', closePanel);
  CcsPins.fallbackFaces(panel);

  // A tap on the building itself (not a drag) dismisses a pinned panel
  (function () {
    var down = null;
    ccsRenderer.domElement.addEventListener('pointerdown', function (e) { down = { x: e.clientX, y: e.clientY }; });
    ccsRenderer.domElement.addEventListener('pointerup', function (e) {
      if (down && Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) < 6) closePanel();
      down = null;
    });
  })();

  // ── Search: a room, or the person to find ─────────────────────────────────
  var input = document.getElementById('ccs-search-input');
  function search(q) {
    q = (q || '').trim().toLowerCase();
    if (!q) return;
    var placed = rooms.filter(function (r) { return r.pos; });
    var hit = placed.find(function (r) { return r.number.toLowerCase().indexOf(q) !== -1; }) ||
      placed.find(function (r) {
        return occupantsOf(r).some(function (f) { return f.name.toLowerCase().indexOf(q) !== -1; });
      }) ||
      placed.find(function (r) { return (r.assigned || '').toLowerCase().indexOf(q) !== -1; });

    var box = input.closest('.ccs-search-wrap');
    if (!hit) {
      box.classList.add('no-match');
      setTimeout(function () { box.classList.remove('no-match'); }, 1200);
      return;
    }
    focusRoom(hit.id);
    input.blur();
  }
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') search(input.value); });

  function focusRoom(id) {
    CcsPins.focus(id);
    hoverRoomId = null;
    openPanel(id, true);
  }

  // "Placed" in the rooms table flies to that room
  document.querySelectorAll('[data-focus-room]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
      focusRoom(btn.getAttribute('data-focus-room'));
    });
  });

  // ── Full screen ───────────────────────────────────────────────────────────
  // The whole card goes full screen, header and all, so the live count and the
  // clock stay on the wall display exactly as Faculty Monitoring shows them.
  var board = document.getElementById('ccs-board');
  var clockTimer = null;

  function isFs() {
    return document.fullscreenElement === board || document.webkitFullscreenElement === board ||
      board.classList.contains('is-pseudo-fs');
  }

  function tickClock() {
    var parts = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).split(' ');
    document.getElementById('ccs-live-clock').innerHTML =
      esc(parts[0]) + (parts[1] ? '<small>' + esc(parts[1]) + '</small>' : '');
  }

  function syncFs() {
    var on = isFs();
    board.classList.toggle('is-fs', on);
    document.body.classList.toggle('ccs-fs-lock', board.classList.contains('is-pseudo-fs'));
    document.getElementById('ccs-btn-fullscreen').setAttribute('aria-pressed', on ? 'true' : 'false');
    clearInterval(clockTimer);
    if (on) { tickClock(); clockTimer = setInterval(tickClock, 15000); }
    setTimeout(ccsResize, 50);
  }

  function enterFs() {
    var req = board.requestFullscreen || board.webkitRequestFullscreen;
    var pseudo = function () { board.classList.add('is-pseudo-fs'); syncFs(); };
    if (req) Promise.resolve(req.call(board)).catch(pseudo);
    else pseudo();
  }

  function exitFs() {
    if (board.classList.contains('is-pseudo-fs')) board.classList.remove('is-pseudo-fs');
    else if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    syncFs();
  }

  document.getElementById('ccs-btn-fullscreen').addEventListener('click', function () {
    if (isFs()) exitFs(); else enterFs();
  });
  document.getElementById('ccs-btn-exit-fs').addEventListener('click', exitFs);
  document.addEventListener('fullscreenchange', syncFs);
  document.addEventListener('webkitfullscreenchange', syncFs);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && board.classList.contains('is-pseudo-fs')) exitFs();
  });

  // ── Live ──────────────────────────────────────────────────────────────────
  // Same merge as Faculty Monitoring: presence, and the room when the feed
  // carries one (it does for a dean).
  if (window.PresenceLive) {
    window.PresenceLive.onUpdate(function (live) {
      var byId = {};
      live.forEach(function (e) { byId[e.id] = e; });
      var changed = false;
      faculty.forEach(function (f) {
        var e = byId[f.id];
        if (!e) return;
        var roomId = 'roomId' in e ? e.roomId : f.roomId;
        if (f.presence !== e.presence || String(f.roomId) !== String(roomId)) {
          f.presence = e.presence;
          f.roomId = roomId;
          f.seen = 'just now';
          changed = true;
        }
      });
      if (changed) render();
    });
  }

  render();
})();
