/**
 * ccs-building-picker.js — placing a room on the 3D building (admin Rooms).
 *
 * The admin clicks the spot on the model where the room really is; the point
 * is saved with the room and is where the dean's live view draws its pin.
 *
 * Three.js and the building modules are fetched the first time the picker
 * opens, not with the page, so the Rooms table loads as fast as it always did.
 * The clouds and trees are left out entirely: they are most of the download
 * and nobody places a room on a tree.
 *
 *   CcsPicker.open({ label, current:{x,y,z}|null, others:[{id,number,pos}],
 *                    onDone: fn(pos) })   — pos: {x,y,z}, null (removed)
 */
/* globals THREE, ccsBoot, ccsCameraInit, ccsControls, ccsRenderer, ccsScene,
   ccsCamera, ccsCameraUpdateTransition, ccsBuildingCreate, ccsBuildingObject,
   ccsInteractionsInit, ccsResize, ccsCameraHome, ccsBuildingSettled, CcsPins */
(function (global) {
  'use strict';

  var VERSION = (document.currentScript && document.currentScript.src.split('?v=')[1]) || '';
  var SCRIPTS = [
    'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js',
    '/js/ccs-building-scene.js',
    '/js/ccs-building-camera.js',
    '/js/ccs-building-loader.js',
    '/js/ccs-building-interactions.js',
    '/js/ccs-building-pins.js',
  ];

  var modal = null;
  var booted = null;        // promise, so a second open waits on the first load
  var running = false;
  var state = null;         // the open session: { opts, pick }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src.charAt(0) === '/' && VERSION ? src + '?v=' + VERSION : src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  // In order: each module expects the ones before it to have defined their globals
  function loadAll() {
    return SCRIPTS.reduce(function (p, src) {
      return p.then(function () { return loadScript(src); });
    }, Promise.resolve());
  }

  function boot() {
    if (booted) return booted;
    booted = loadAll().then(function () {
      ccsBoot({ environment: false });
      ccsCameraInit();
      CcsPins.init({ onSelect: function () {}, onHover: showOther });
      ccsInteractionsInit();
      wirePicking();
      return ccsBuildingCreate();
    }).then(function () {
      // Wait for the real model: a pin placed on the stand-in would sit off
      // the room once the dean's view shows the actual building
      return ccsBuildingSettled;
    }).then(function () {
      document.getElementById('ccs-loading').style.display = 'none';
    });
    booted.catch(function (err) {
      console.error('[CcsPicker]', err);
      booted = null;   // let the next open try again
      setHint('The 3D building could not be loaded. Check the connection and try again.', 'error');
    });
    return booted;
  }

  function loop() {
    if (!running) return;
    requestAnimationFrame(loop);
    ccsCameraUpdateTransition();
    ccsControls.update();
    ccsRenderer.render(ccsScene, ccsCamera);
    CcsPins.frame();
  }

  // ── Picking ───────────────────────────────────────────────────────────────
  function wirePicking() {
    var canvas = ccsRenderer.domElement;
    var ray = new THREE.Raycaster();
    var mouse = new THREE.Vector2();
    var down = null;

    canvas.addEventListener('pointerdown', function (e) { down = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener('pointerup', function (e) {
      // A drag turns the building; only a click places the pin
      if (!down || Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 6) { down = null; return; }
      down = null;
      if (!state) return;

      var rect = canvas.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      ray.setFromCamera(mouse, ccsCamera);

      var building = ccsBuildingObject();
      var hits = building ? ray.intersectObject(building, true) : [];
      var hit = hits[0];
      if (!hit || hit.point.y < 0.3) {
        setHint('That is the ground — click on the building itself, on the room.', 'error');
        return;
      }

      // Lift the point just off the surface it landed on, so the dot and the
      // dean's line sit in front of the wall instead of inside it
      var normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 0, 1);
      var p = hit.point.clone().addScaledVector(normal, 0.35);
      state.pick = { x: round(p.x), y: round(p.y), z: round(p.z) };
      drawPins();
      setHint('Placed. Click somewhere else to move it, or use this spot.', 'ok');
      document.getElementById('placeConfirm').disabled = false;
    });
  }

  function round(v) { return Math.round(v * 100) / 100; }

  function drawPins() {
    var list = (state.opts.others || []).filter(function (o) { return o.pos; }).map(function (o) {
      return { id: o.id, number: o.number, pos: o.pos, tone: 'muted', title: o.number };
    });
    if (state.pick) {
      list.push({ id: '__pick', number: state.opts.label || 'This room', pos: state.pick, tone: 'pick' });
    }
    CcsPins.setRooms(list);
  }

  // Hovering another room's dot names it, so the admin can see what is already where
  function showOther(r) {
    if (!state) return;
    if (r && r.id !== '__pick') setHint(r.number + ' is already placed here.', '');
    else if (!r) setHint(state.pick ? 'Click somewhere else to move it, or use this spot.' : DEFAULT_HINT, state.pick ? 'ok' : '');
  }

  var DEFAULT_HINT = 'Click the spot on the building where this room is. Drag to turn the building, scroll to zoom.';

  function setHint(text, tone) {
    var el = document.getElementById('placeHint');
    if (!el) return;
    el.textContent = text;
    el.className = 'place-hint' + (tone ? ' is-' + tone : '');
  }

  // ── Open / close ──────────────────────────────────────────────────────────
  function close(result) {
    var s = state;
    state = null;
    running = false;
    modal.classList.remove('show');
    if (s && result !== undefined && s.opts.onDone) s.opts.onDone(result);
  }

  function open(opts) {
    modal = modal || document.getElementById('placeModal');
    state = { opts: opts || {}, pick: opts && opts.current ? opts.current : null };

    document.getElementById('placeTitle').textContent =
      'Place ' + (state.opts.label || 'this room') + ' on the building';
    document.getElementById('placeRemove').hidden = !state.opts.current;
    document.getElementById('placeConfirm').disabled = !state.pick;
    setHint(state.pick ? 'This is where it is now. Click somewhere else to move it.' : DEFAULT_HINT, '');
    modal.classList.add('show');

    boot().then(function () {
      if (!state) return;
      ccsResize();
      drawPins();
      if (state.pick) {
        // Start looking at the room being moved
        CcsPins.focus('__pick');
      } else {
        ccsCameraHome();
      }
      running = true;
      loop();
    }).catch(function () { /* boot() already said why, in the hint */ });
  }

  document.addEventListener('DOMContentLoaded', function () {
    modal = document.getElementById('placeModal');
    if (!modal) return;
    document.getElementById('placeCancel').addEventListener('click', function () { close(undefined); });
    document.getElementById('placeClose').addEventListener('click', function () { close(undefined); });
    document.getElementById('placeRemove').addEventListener('click', function () { close(null); });
    document.getElementById('placeConfirm').addEventListener('click', function () {
      if (state && state.pick) close(state.pick);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state) close(undefined);
    });
  });

  global.CcsPicker = { open: open };
})(window);
