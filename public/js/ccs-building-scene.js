/**
 * ccs-building-scene.js — Three.js r128
 * Sky, lights, ground, clouds, 2 trees.
 */
/* globals THREE */
var ccsScene, ccsRenderer, ccsClock;

/**
 * Builds the renderer inside #ccs-canvas-wrap.
 *
 * opts.environment (default true) loads the clouds and trees. They are about
 * 97 MB of decoration, so the admin's room picker, which only needs the
 * building to click on, leaves them out.
 */
function ccsBoot(opts) {
  opts = opts || {};
  var wrap = document.getElementById('ccs-canvas-wrap');
  ccsRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  ccsRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  ccsRenderer.setSize(wrap.clientWidth, wrap.clientHeight);
  ccsRenderer.shadowMap.enabled = true;
  ccsRenderer.shadowMap.type    = THREE.PCFSoftShadowMap;
  ccsRenderer.outputEncoding    = THREE.sRGBEncoding;
  wrap.appendChild(ccsRenderer.domElement);

  ccsScene = new THREE.Scene();
  _buildSky();
  _buildLights();
  _buildGround();
  if (opts.environment !== false) _loadEnvironment();
  ccsClock = new THREE.Clock();

  window.addEventListener('resize', ccsResize);
  // Entering or leaving full screen does not always fire a window resize
  document.addEventListener('fullscreenchange', ccsResize);
  document.addEventListener('webkitfullscreenchange', ccsResize);
  // And when it does, it can fire before the new layout is in place. Watching
  // the wrapper itself catches every size change (full screen, a popup
  // opening, the sidebar collapsing) once the box has its final size.
  if (window.ResizeObserver) new ResizeObserver(ccsResize).observe(wrap);
}

/**
 * Fit the canvas to its wrapper again. Also called by pages that show the
 * wrapper after it was hidden, where it measured 0 × 0 at boot.
 */
function ccsResize() {
  var wrap = document.getElementById('ccs-canvas-wrap');
  if (!wrap || !ccsRenderer) return;
  var w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w || !h) return;
  ccsRenderer.setSize(w, h);
  if (window.ccsCamera) { ccsCamera.aspect = w/h; ccsCamera.updateProjectionMatrix(); }
}

function _buildSky() {
  var skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: 'varying vec3 vW; void main(){ vW=(modelMatrix*vec4(position,1.0)).xyz; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: 'varying vec3 vW; void main(){ float t=clamp(vW.y/80.0,0.0,1.0); vec3 h=vec3(0.72,0.86,0.95); vec3 z=vec3(0.35,0.65,0.88); gl_FragColor=vec4(mix(h,z,t*t),1.0); }',
  });
  ccsScene.add(new THREE.Mesh(new THREE.SphereGeometry(320, 32, 16), skyMat));
  ccsScene.background = new THREE.Color(0xb8daf2);
  ccsScene.fog = new THREE.Fog(0xb8daf2, 260, 420);
}

function _buildLights() {
  ccsScene.add(new THREE.AmbientLight(0xffffff, 1.2));
  var sun = new THREE.DirectionalLight(0xfff8f0, 1.8);
  sun.position.set(40, 70, 55);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left=-80; sun.shadow.camera.right=80;
  sun.shadow.camera.top=80;  sun.shadow.camera.bottom=-80;
  sun.shadow.camera.near=1;  sun.shadow.camera.far=300;
  sun.shadow.bias = -0.0003;
  ccsScene.add(sun);
  var front = new THREE.DirectionalLight(0xffffff, 1.2);
  front.position.set(0, 25, 80);
  ccsScene.add(front);
  ccsScene.add(new THREE.HemisphereLight(0xadd8f0, 0x8a9a60, 0.7));
}

function _buildGround() {
  // Large grass field covering EVERYTHING — no white gaps
  var gm = new THREE.MeshLambertMaterial({ color: 0x8a8c6a });
  var gr = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), gm);
  gr.rotation.x = -Math.PI/2; gr.position.set(0, -0.02, 0); gr.receiveShadow = true;
  ccsScene.add(gr);

  // Concrete apron — clear medium grey (NOT white)
  var cm = new THREE.MeshLambertMaterial({ color: 0x828280 });
  var ap = new THREE.Mesh(new THREE.PlaneGeometry(80, 16), cm);
  ap.rotation.x = -Math.PI/2; ap.position.set(0, 0.01, 11); ap.receiveShadow = true;
  ccsScene.add(ap);

  // Road — darker grey
  var rm = new THREE.MeshLambertMaterial({ color: 0x686864 });
  var rd = new THREE.Mesh(new THREE.PlaneGeometry(200, 30), rm);
  rd.rotation.x = -Math.PI/2; rd.position.set(0, 0.01, 29); rd.receiveShadow = true;
  ccsScene.add(rd);

  // Kerb
  var kerb = new THREE.Mesh(
    new THREE.BoxGeometry(90, 0.18, 0.45),
    new THREE.MeshLambertMaterial({ color: 0x727270 })
  );
  kerb.position.set(0, 0.09, 33.5);
  ccsScene.add(kerb);

  // Parking lines
  var lm = new THREE.MeshLambertMaterial({ color: 0x909088 });
  for (var i = -3; i <= 3; i++) {
    var ln = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 5.5), lm);
    ln.rotation.x = -Math.PI / 2;
    ln.position.set(i * 9, 0.02, 30);
    ccsScene.add(ln);
  }
}

function _loadEnvironment() {
  var loader = new THREE.GLTFLoader();

  // 20 clouds spread in all directions — big gaps between each
  var clouds = [
    ['/models/env-cloud1.glb',   20,  52, -75,  60, 0.0],
    ['/models/env-cloud2.glb',  -80,  60, -60,  55, 0.5],
    ['/models/env-cloud1.glb',   90,  58, -80,  58, 1.0],
    ['/models/env-cloud2.glb',  -30,  82, -90,  65, 0.3],
    ['/models/env-cloud1.glb',   50,  88, -85,  62, 0.8],
    ['/models/env-cloud2.glb', -130,  55,   0,  58, 1.2],
    ['/models/env-cloud1.glb', -110,  72, -50,  54, 0.6],
    ['/models/env-cloud2.glb', -120,  48,  50,  52, 1.8],
    ['/models/env-cloud1.glb',  120,  52,   0,  60, 0.2],
    ['/models/env-cloud2.glb',  115,  68, -45,  56, 1.4],
    ['/models/env-cloud1.glb',  125,  46,  55,  50, 2.0],
    ['/models/env-cloud2.glb',    0,  58,  90,  62, 0.0],
    ['/models/env-cloud1.glb',  -70,  62,  80,  55, 0.7],
    ['/models/env-cloud2.glb',   75,  55,  85,  58, 1.5],
    ['/models/env-cloud1.glb',  -40,  85,  95,  65, 0.4],
    ['/models/env-cloud2.glb',   45,  80, 100,  60, 1.1],
    ['/models/env-cloud1.glb',   10, 100, -30,  70, 0.9],
    ['/models/env-cloud2.glb',  -60,  95,  40,  68, 0.2],
    ['/models/env-cloud1.glb',   65,  98,  20,  65, 1.6],
    ['/models/env-cloud2.glb',  -15, 105,  60,  72, 0.5],
  ];

  clouds.forEach(function(c, i) {
    loader.load(c[0], function(gltf) {
      var cloud = gltf.scene;
      var bbox  = new THREE.Box3().setFromObject(cloud);
      var size  = new THREE.Vector3(); bbox.getSize(size);
      var maxD  = Math.max(size.x, size.y, size.z);
      if (maxD > 0.01) cloud.scale.setScalar(c[3] / maxD);
      cloud.position.set(c[1], c[2], c[3]);
      cloud.rotation.y = c[5];
      cloud.traverse(function(ch) {
        if (!ch.isMesh) return;
        ch.castShadow = ch.receiveShadow = false;
        var ms = Array.isArray(ch.material) ? ch.material : [ch.material];
        ms.forEach(function(m) { if(m.map){m.map.encoding=THREE.sRGBEncoding;} m.needsUpdate=true; });
      });
      ccsScene.add(cloud);
    }, undefined, function(){});
  });

  // Exactly 2 trees in front of building
  var trees = [
    ['/models/env-tree1.glb', -18, 22, 5.8, 0.0],
    ['/models/env-tree2.glb',  22, 22, 5.4, 0.3],
  ];
  trees.forEach(function(t, i) {
    loader.load(t[0], function(gltf) {
      var tree = gltf.scene;
      var bbox = new THREE.Box3().setFromObject(tree);
      var size = new THREE.Vector3(); bbox.getSize(size);
      if (size.y > 0.01) tree.scale.setScalar(t[3] / size.y);
      bbox.setFromObject(tree);
      tree.position.set(t[1], -bbox.min.y, t[2]);
      tree.rotation.y = t[4];
      tree.traverse(function(ch) {
        if (!ch.isMesh) return;
        ch.castShadow = ch.receiveShadow = true;
        var ms = Array.isArray(ch.material) ? ch.material : [ch.material];
        ms.forEach(function(m) { if(m.map){m.map.encoding=THREE.sRGBEncoding;} m.needsUpdate=true; });
      });
      ccsScene.add(tree);
    }, undefined, function(e){ console.warn('Tree',i,'fail',e); });
  });
}
