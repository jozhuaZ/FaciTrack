/**
 * ccs-building-pins.js — rooms drawn on the 3D building. Three.js r128.
 *
 * Shared by the dean's live view and the admin's room picker, so a room placed
 * in one appears on exactly the same spot in the other.
 *
 * Each placed room is a small dot on the building. A room with somebody in it
 * also gets a line rising above the roof, topped with the faces of whoever is
 * inside. The line is real geometry, so the building hides it correctly; the
 * dot, faces and labels are HTML laid over the canvas and moved every frame,
 * which keeps photos sharp and lets them take hover and tap like any element.
 *
 *   CcsPins.init({ onSelect: fn(room, event) })
 *   CcsPins.setRooms([{ id, number, floor, type, pos:{x,y,z}, occupants:[...],
 *                       tone:'live'|'pick'|'muted', title }])
 *   CcsPins.frame()           — once per rendered frame
 *   CcsPins.focus(roomId)     — fly the camera to a room
 *   CcsPins.anchorOf(roomId)  — the pin's screen box, for a panel beside it
 */
/* globals THREE, ccsScene, ccsCamera, ccsRenderer, ccsCameraMoveTo, ccsBuildingObject */
(function (global) {
  'use strict';

  // Blue for "in the room", as on the Faculty Monitoring board
  var LINE_COLOR = { live: 0x2563eb, pick: 0x1e88e5 };
  var ROOF_CLEARANCE = 2.2;   // how far above the roof the first head sits
  var STAGGER = 3.2;          // extra height for a head that would collide with a neighbour
  var NEIGHBOUR_X = 5;        // rooms closer than this, left to right, share a column
  var MAX_FACES = 3;          // beyond this the stack reads "+N"

  var layer = null;
  var rooms = [];
  var group = null;           // the 3D lines, rebuilt with the rooms
  var roofY = 16;
  var opts = {};
  var projected = new THREE.Vector3();
  var lastCam = '';
  var settleTimer = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function initials(name) {
    return String(name || '?').split(/\s+/).filter(Boolean)
      .map(function (w) { return w[0]; }).slice(0, 2).join('').toUpperCase();
  }

  // Not lazy: the heads start hidden and are few, and a lazy image that has
  // not loaded yet when the head appears leaves an empty ring.
  function faceHtml(p) {
    return p.photo
      ? '<img src="' + esc(p.photo) + '" alt="" draggable="false" data-initials="' + esc(initials(p.name)) + '">'
      : '<span>' + esc(initials(p.name)) + '</span>';
  }

  /**
   * A photo that fails to load (deleted file, expired session) falls back to
   * the initials instead of a broken-image icon. Error events do not bubble,
   * so this listens in the capture phase on whatever holds the faces.
   */
  function fallbackFaces(root) {
    root.addEventListener('error', function (e) {
      var img = e.target;
      if (!img || img.tagName !== 'IMG' || !img.hasAttribute('data-initials')) return;
      var span = document.createElement('span');
      span.textContent = img.getAttribute('data-initials');
      img.replaceWith(span);
    }, true);
  }

  /** Top of the building, so every head clears the roof whichever model is loaded. */
  function measureRoof() {
    var b = typeof ccsBuildingObject === 'function' ? ccsBuildingObject() : null;
    if (!b) return;
    var box = new THREE.Box3().setFromObject(b);
    if (isFinite(box.max.y) && box.max.y > 0) roofY = box.max.y;
  }

  function init(o) {
    opts = o || {};
    var wrap = document.getElementById('ccs-canvas-wrap');
    layer = document.createElement('div');
    layer.className = 'ccs-pin-layer';
    wrap.appendChild(layer);
    fallbackFaces(layer);

    group = new THREE.Group();
    group.name = 'CCSPins';
    ccsScene.add(group);

    measureRoof();
    window.addEventListener('ccs:building', function () {
      measureRoof();
      rebuild();
    });
  }

  /**
   * Where each head sits. Rooms stacked above one another on different floors,
   * or side by side, would put their faces on top of each other, so a room
   * whose column is already taken gets pushed one step higher.
   */
  function headHeights(list) {
    var taken = [];
    list.filter(function (r) { return r.pos && (r.occupants.length || r.tone === 'pick'); })
      .sort(function (a, b) { return a.pos.x - b.pos.x; })
      .forEach(function (r) {
        var level = 0;
        while (taken.some(function (t) {
          return t.level === level && Math.abs(t.x - r.pos.x) < NEIGHBOUR_X;
        })) level++;
        taken.push({ x: r.pos.x, level: level });
        r._topY = Math.max(roofY + ROOF_CLEARANCE, r.pos.y + 3) + level * STAGGER;
      });
  }

  function disposeGroup() {
    while (group.children.length) {
      var c = group.children.pop();
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
  }

  function addLine(r) {
    var color = LINE_COLOR[r.tone] || LINE_COLOR.live;
    var h = r._topY - r.pos.y;
    var line = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.1, h, 10),
      new THREE.MeshBasicMaterial({ color: color })
    );
    line.position.set(r.pos.x, r.pos.y + h / 2, r.pos.z);
    group.add(line);

    var base = new THREE.Mesh(
      new THREE.SphereGeometry(0.26, 16, 12),
      new THREE.MeshBasicMaterial({ color: color })
    );
    base.position.set(r.pos.x, r.pos.y, r.pos.z);
    group.add(base);
  }

  function rebuild() {
    if (!layer) return;
    disposeGroup();
    layer.innerHTML = '';
    headHeights(rooms);

    rooms.forEach(function (r) {
      if (!r.pos) return;
      var busy = r.occupants.length > 0;

      var dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'ccs-pin-dot tone-' + (r.tone || 'muted') + (busy ? ' is-busy' : '');
      dot.setAttribute('aria-label', r.title || r.number);
      r._dot = dot;
      layer.appendChild(dot);

      r._head = null;
      if (busy || r.tone === 'pick') {
        addLine(r);
        var head = document.createElement('button');
        head.type = 'button';
        head.className = 'ccs-heads tone-' + (r.tone || 'live');
        var faces = '';
        if (busy) {
          faces = r.occupants.slice(0, MAX_FACES).map(function (p) {
            return '<span class="ccs-head">' + faceHtml(p) + '</span>';
          }).join('');
          if (r.occupants.length > MAX_FACES) {
            faces += '<span class="ccs-head more">+' + (r.occupants.length - MAX_FACES) + '</span>';
          }
          faces = '<span class="ccs-heads-row">' + faces + '</span>';
        }
        head.innerHTML = faces + '<span class="ccs-heads-label">' + esc(r.number) + '</span>';
        head.setAttribute('aria-label', r.title || r.number);
        r._head = head;
        layer.appendChild(head);
      }

      [dot, r._head].forEach(function (el) {
        if (!el || !opts.onSelect) return;
        el.addEventListener('click', function (e) { e.stopPropagation(); opts.onSelect(r, e); });
        el.addEventListener('mouseenter', function (e) { if (opts.onHover) opts.onHover(r, e); });
        el.addEventListener('mouseleave', function (e) { if (opts.onHover) opts.onHover(null, e); });
      });
    });

    lastCam = '';   // force the next frame to lay everything out
  }

  function setRooms(list) {
    rooms = (list || []).map(function (r) {
      return Object.assign({ occupants: [], tone: 'muted' }, r);
    });
    rebuild();
  }

  /** Canvas pixel position of a world point, or null when it is behind the camera. */
  function toScreen(x, y, z, w, h) {
    projected.set(x, y, z).project(ccsCamera);
    if (projected.z > 1) return null;
    return { x: (projected.x + 1) / 2 * w, y: (1 - projected.y) / 2 * h };
  }

  function place(el, p) {
    if (!el) return;
    if (!p) { el.style.visibility = 'hidden'; return; }
    el.style.visibility = '';
    // A dot is centred on its point; a head stands on it, the line meeting its foot
    el.style.transform = 'translate(' + p.x.toFixed(1) + 'px,' + p.y.toFixed(1) + 'px) ' +
      (el.classList.contains('ccs-heads') ? 'translate(-50%,-100%)' : 'translate(-50%,-50%)');
  }

  /**
   * Dim the dots the building stands in front of. A raycast into a detailed
   * model is not cheap, so this runs once the camera has come to rest rather
   * than on every frame.
   */
  function markHidden() {
    var b = typeof ccsBuildingObject === 'function' ? ccsBuildingObject() : null;
    if (!b) return;
    var ray = new THREE.Raycaster();
    var from = ccsCamera.position;
    rooms.forEach(function (r) {
      if (!r.pos || !r._dot) return;
      var to = new THREE.Vector3(r.pos.x, r.pos.y, r.pos.z);
      var dist = from.distanceTo(to);
      ray.set(from, to.clone().sub(from).normalize());
      ray.far = dist - 0.4;
      var hit = ray.intersectObject(b, true).length > 0;
      r._dot.classList.toggle('is-behind', hit);
    });
  }

  function frame() {
    if (!layer || !ccsCamera) return;
    // The projection is part of the key: going full screen changes the
    // camera's aspect a moment after the layer has already grown, and a key
    // without it saw "nothing moved" and left the faces where the old aspect
    // put them, off their lines.
    var key = ccsCamera.matrixWorld.elements.join(',') + '|' +
      ccsCamera.projectionMatrix.elements.join(',') + '|' +
      layer.clientWidth + 'x' + layer.clientHeight;
    if (key === lastCam) return;
    lastCam = key;

    var w = layer.clientWidth, h = layer.clientHeight;
    rooms.forEach(function (r) {
      if (!r.pos) return;
      place(r._dot, toScreen(r.pos.x, r.pos.y, r.pos.z, w, h));
      if (r._head) place(r._head, toScreen(r.pos.x, r._topY, r.pos.z, w, h));
    });

    clearTimeout(settleTimer);
    settleTimer = setTimeout(markHidden, 220);
  }

  function focus(roomId) {
    var r = rooms.find(function (x) { return String(x.id) === String(roomId); });
    if (!r || !r.pos) return null;
    // Stand off in front of the face the room is on, a little above it
    var side = r.pos.z >= 0 ? 1 : -1;
    ccsCameraMoveTo(
      new THREE.Vector3(r.pos.x * 0.85, r.pos.y + 8, r.pos.z + side * 34),
      new THREE.Vector3(r.pos.x, r.pos.y + 1.5, r.pos.z),
      1000
    );
    return r;
  }

  /** The screen box of a room's pin, for placing a panel beside it. */
  function anchorOf(roomId) {
    var r = rooms.find(function (x) { return String(x.id) === String(roomId); });
    var el = r && (r._head || r._dot);
    if (!el || el.style.visibility === 'hidden') return null;
    return el.getBoundingClientRect();
  }

  global.CcsPins = {
    init: init, setRooms: setRooms, frame: frame, focus: focus, anchorOf: anchorOf,
    initials: initials, faceHtml: faceHtml, fallbackFaces: fallbackFaces, esc: esc,
  };
})(window);
