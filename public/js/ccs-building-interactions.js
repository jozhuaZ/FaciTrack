/**
 * ccs-building-interactions.js — Three.js r128
 * The camera buttons over the canvas: preset views, reset and zoom.
 *
 * Rooms used to be hover boxes defined here; they are now pins drawn from the
 * rooms table by ccs-building-pins.js, and each page wires its own search.
 */
/* globals THREE, ccsCamera, ccsControls, ccsCameraMoveTo, ccsCameraHome */

function ccsInteractionsInit(opts) {
  opts = opts || {};

  // The last preset chosen stays marked, until the camera is reset
  function markView(id) {
    Object.keys(views).forEach(function (key) {
      var el = document.getElementById(key);
      if (el) el.classList.toggle('active', key === id);
    });
  }

  var rb = document.getElementById('ccs-btn-reset-overlay');
  if (rb) rb.addEventListener('click', function () {
    if (opts.onReset) opts.onReset();
    markView(null);
    ccsCameraHome();
  });

  var views = {
    'ccs-btn-top'  : [new THREE.Vector3(0, 85, 2),   new THREE.Vector3(0, 0, 0)],
    'ccs-btn-front': [new THREE.Vector3(0, 10, 62),  new THREE.Vector3(0, 6, 0)],
    'ccs-btn-left' : [new THREE.Vector3(-70, 12, 0), new THREE.Vector3(0, 7, 0)],
    'ccs-btn-right': [new THREE.Vector3(70, 12, 0),  new THREE.Vector3(0, 7, 0)],
  };
  Object.keys(views).forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', function () {
      markView(id);
      ccsCameraMoveTo(views[id][0], views[id][1], 1100);
    });
  });

  function zoom(step) {
    var d = new THREE.Vector3().subVectors(ccsControls.target, ccsCamera.position).normalize();
    ccsCamera.position.addScaledVector(d, step);
    ccsControls.update();
  }
  var zin = document.getElementById('ccs-btn-zoom-in');
  var zout = document.getElementById('ccs-btn-zoom-out');
  if (zin) zin.addEventListener('click', function () { zoom(5); });
  if (zout) zout.addEventListener('click', function () { zoom(-5); });
}
