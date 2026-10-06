/* =========================================================================
   ROVER SCENE — 3D cut-scene shown between days (three.js r128)
   Loads three.js from a local copy if present (three.min.js next to this
   file), otherwise from the cdnjs CDN. If WebGL or the library is not
   available, the game simply skips the cut-scenes.

   RoverScene.play({ outcome, title, sub, lines, names, R, continueLabel })
     outcome: "success" | "fuse" | "battery" | "error"
     names:   task names run that day (they decide which actions are shown)
     R:       wire resistance (more dust in the air when it's higher)
   Returns a Promise that resolves when the student presses Continue.
========================================================================= */
window.RoverScene = (() => {
  "use strict";
  const SOURCES = ["three.min.js", "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"];
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Load three.js in the background ---------- */
  let loading = null;
  function loadThree() {
    if (window.THREE) return Promise.resolve(true);
    if (loading) return loading;
    loading = new Promise(resolve => {
      let i = 0;
      const next = () => {
        if (i >= SOURCES.length) return resolve(false);
        const s = document.createElement("script");
        s.src = SOURCES[i++];
        s.onload = () => (window.THREE ? resolve(true) : next());
        s.onerror = () => { s.remove(); next(); };
        document.head.appendChild(s);
      };
      next();
    });
    return loading;
  }
  loadThree();

  /* ---------- Terrain height (smooth value noise) ---------- */
  function hash(x, z) { const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return s - Math.floor(s); }
  function noise(x, z) {
    const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
    const a = hash(xi, zi), b = hash(xi + 1, zi), c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function height(x, z) {
    let h = 0, amp = 2.4, f = 0.03;
    for (let o = 0; o < 4; o++) { h += (noise(x * f, z * f) - 0.5) * amp; amp *= 0.45; f *= 2.1; }
    return h * (1 - 0.65 * Math.exp(-(z * z) / 30));   // gentler along the rover's path
  }

  const clamp01 = x => Math.max(0, Math.min(1, x));
  const smooth = x => { x = clamp01(x); return x * x * (3 - 2 * x); };
  const lerp = (a, b, k) => a + (b - a) * k;

  /* ---------- Timeline constants ---------- */
  const X0 = -9, SPEED = 2.2, STOP_T = 3, STOP_LEN = 3;
  const X_STOP = X0 + SPEED * STOP_T;
  const TARGET = { x: X_STOP + 5, z: 3.0 };          // rock for the laser

  let T, renderer, scene, camera, sun, hemi, ready = false, broken = false;
  let rover, dust, dustCount = 0, puffs = [], sparks, rings = [], radar, laser, flash, glow;
  let run = null, raf = 0, last = 0;

  /* ---------- Build the world once ---------- */
  function init() {
    T = window.THREE;
    const canvas = document.getElementById("sceneCanvas");
    renderer = new T.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    scene = new T.Scene();
    camera = new T.PerspectiveCamera(45, 1, 0.1, 400);
    hemi = new T.HemisphereLight(0xffd9b0, 0x5a2a14, 0.6);
    sun = new T.DirectionalLight(0xfff0dd, 1.0);
    sun.position.set(30, 40, 12);
    scene.add(hemi, sun);
    scene.fog = new T.FogExp2(0xc99a6b, 0.02);

    // Ground
    const geo = new T.PlaneGeometry(220, 220, 150, 150);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, cols = [];
    const cLow = new T.Color(0x7e3a20), cHigh = new T.Color(0xb8733f), cDark = new T.Color(0x4e2212), c = new T.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i), y = height(x, z);
      pos.setY(i, y);
      c.copy(cLow).lerp(cHigh, clamp01((y + 1.5) / 3)).lerp(cDark, noise(x * 0.3 + 50, z * 0.3) * 0.35);
      cols.push(c.r, c.g, c.b);
    }
    geo.setAttribute("color", new T.Float32BufferAttribute(cols, 3));
    geo.computeVertexNormals();
    scene.add(new T.Mesh(geo, new T.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, metalness: 0 })));

    // Scattered rocks (kept off the rover's path)
    const rockGeo = new T.DodecahedronGeometry(1, 0);
    const rockMat = new T.MeshStandardMaterial({ color: 0x7a3b22, flatShading: true, roughness: 1 });
    const N = 150, rocks = new T.InstancedMesh(rockGeo, rockMat, N);
    const m = new T.Matrix4(), q = new T.Quaternion(), e = new T.Euler(), s = new T.Vector3(), p = new T.Vector3();
    let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < N; i++) {
      let x, z;
      do { x = (rnd() - 0.5) * 120; z = (rnd() - 0.5) * 120; } while (Math.abs(z) < 3.6 && x > -35 && x < 45);
      const sc = 0.15 + Math.pow(rnd(), 3) * 1.6;
      e.set(rnd() * 3, rnd() * 3, rnd() * 3); q.setFromEuler(e);
      s.set(sc, sc * (0.6 + rnd() * 0.5), sc); p.set(x, height(x, z) - sc * 0.25, z);
      m.compose(p, q, s); rocks.setMatrixAt(i, m);
    }
    scene.add(rocks);
    const target = new T.Mesh(rockGeo, rockMat);
    target.scale.set(0.6, 0.45, 0.6);
    target.position.set(TARGET.x, height(TARGET.x, TARGET.z) + 0.1, TARGET.z);
    scene.add(target);

    rover = buildRover();
    scene.add(rover.group);
    buildEffects();
    ready = true;
  }

  /* ---------- The rover, built from simple shapes ---------- */
  function buildRover() {
    const g = new T.Group();
    const M = (col, o) => new T.MeshStandardMaterial(Object.assign({ color: col, roughness: 0.7, metalness: 0.2, flatShading: true }, o || {}));
    const white = M(0xe8e2d6), grey = M(0x6a655f), dark = M(0x26221f);
    const gold = M(0xc79a3c, { metalness: 0.6, roughness: 0.4 });
    const panelMat = M(0x1d2c52, { metalness: 0.5, roughness: 0.35 });
    const add = (geo, mat, x, y, z, parent) => { const mesh = new T.Mesh(geo, mat); mesh.position.set(x, y, z); (parent || g).add(mesh); return mesh; };

    // Soft shadow
    const shadow = new T.Mesh(new T.CircleGeometry(1.9, 24), new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.04; g.add(shadow);

    // Body, deck, solar panel
    add(new T.BoxGeometry(2.4, 0.6, 1.6), white, 0, 1.0, 0);
    add(new T.BoxGeometry(2.2, 0.08, 1.5), gold, 0, 1.34, 0);
    add(new T.BoxGeometry(1.9, 0.05, 3.2), panelMat, -0.35, 1.45, 0);

    // Wheels and suspension
    const wheels = [];
    const tyreGeo = new T.CylinderGeometry(0.35, 0.35, 0.3, 16); tyreGeo.rotateX(Math.PI / 2);
    [-0.95, 0, 0.95].forEach(wx => [-0.98, 0.98].forEach(wz => {
      const w = new T.Group(); w.position.set(wx, 0.35, wz);
      w.add(new T.Mesh(tyreGeo, dark));
      add(new T.BoxGeometry(0.5, 0.08, 0.04), grey, 0, 0, wz > 0 ? 0.16 : -0.16, w);
      g.add(w); wheels.push(w);
      add(new T.BoxGeometry(0.07, 0.32, 0.07), grey, wx, 0.55, wz);
    }));
    [-0.98, 0.98].forEach(wz => add(new T.BoxGeometry(2.1, 0.07, 0.07), grey, 0, 0.7, wz));

    // Camera mast
    add(new T.CylinderGeometry(0.06, 0.06, 1.3, 8), grey, 0.9, 2.0, 0.55);
    const head = new T.Group(); head.position.set(0.9, 2.72, 0.55); g.add(head);
    add(new T.BoxGeometry(0.45, 0.22, 0.32), white, 0, 0, 0, head);
    const eyeGeo = new T.CylinderGeometry(0.05, 0.05, 0.06, 10); eyeGeo.rotateZ(Math.PI / 2);
    add(eyeGeo, dark, 0.24, 0.02, 0.08, head); add(eyeGeo, dark, 0.24, 0.02, -0.08, head);
    const eye = new T.Object3D(); eye.position.set(0.28, 0.02, 0); head.add(eye);

    // Antenna dish
    add(new T.CylinderGeometry(0.04, 0.04, 0.35, 6), grey, -0.1, 1.6, -0.75);
    const dishPivot = new T.Group(); dishPivot.position.set(-0.1, 1.78, -0.75); g.add(dishPivot);
    const dish = new T.Mesh(new T.SphereGeometry(0.4, 16, 6, 0, Math.PI * 2, 0, 0.9), M(0xf2ede4, { side: T.DoubleSide }));
    dish.rotation.x = Math.PI; dish.position.y = 0.38; dishPivot.add(dish);

    // Robotic arm with drill
    const shoulder = new T.Group(); shoulder.position.set(1.25, 0.85, 0); g.add(shoulder);
    add(new T.BoxGeometry(0.9, 0.1, 0.1), grey, 0.45, 0, 0, shoulder);
    const elbow = new T.Group(); elbow.position.x = 0.9; shoulder.add(elbow);
    add(new T.BoxGeometry(0.75, 0.09, 0.09), grey, 0.375, 0, 0, elbow);
    const turret = new T.Group(); turret.position.x = 0.75; elbow.add(turret);
    add(new T.BoxGeometry(0.18, 0.14, 0.18), white, 0, 0, 0, turret);
    const bit = add(new T.CylinderGeometry(0.04, 0.01, 0.3, 6), M(0xb8b8b8, { metalness: 0.8 }), 0, -0.2, 0, turret);
    const tip = new T.Object3D(); tip.position.y = -0.36; turret.add(tip);

    // Lights
    const beacon = add(new T.SphereGeometry(0.09, 10, 8), new T.MeshBasicMaterial({ color: 0x331a10 }), -1.1, 1.58, 0.5);
    const lampMat = new T.MeshBasicMaterial({ color: 0xfff2c8 });
    add(new T.BoxGeometry(0.04, 0.08, 0.16), lampMat, 1.22, 1.05, 0.5);
    add(new T.BoxGeometry(0.04, 0.08, 0.16), lampMat, 1.22, 1.05, -0.5);

    return { group: g, wheels, head, eye, dishPivot, shoulder, elbow, turret, bit, tip, beacon, lampMat };
  }

  /* ---------- Particles and task effects ---------- */
  function buildEffects() {
    // Floating dust
    const MAX = 1300, arr = new Float32Array(MAX * 3);
    for (let i = 0; i < MAX; i++) { arr[i * 3] = (Math.random() - 0.5) * 60; arr[i * 3 + 1] = Math.random() * 10; arr[i * 3 + 2] = (Math.random() - 0.5) * 40; }
    const dg = new T.BufferGeometry(); dg.setAttribute("position", new T.BufferAttribute(arr, 3));
    dust = new T.Points(dg, new T.PointsMaterial({ color: 0xe0b083, size: 0.11, transparent: true, opacity: 0.65, depthWrite: false }));
    scene.add(dust);

    // Wheel dust / smoke puffs
    const puffGeo = new T.IcosahedronGeometry(0.25, 0);
    for (let i = 0; i < 50; i++) {
      const mesh = new T.Mesh(puffGeo, new T.MeshBasicMaterial({ color: 0xc98a5a, transparent: true, opacity: 0, depthWrite: false }));
      mesh.visible = false; scene.add(mesh);
      puffs.push({ mesh, life: 0, max: 1, vel: new T.Vector3() });
    }

    // Sparks for a blown fuse
    const SP = 90, sp = new Float32Array(SP * 3);
    const sg = new T.BufferGeometry(); sg.setAttribute("position", new T.BufferAttribute(sp, 3));
    sparks = new T.Points(sg, new T.PointsMaterial({ color: 0xffc066, size: 0.12, transparent: true, blending: T.AdditiveBlending, depthWrite: false }));
    sparks.userData = { vel: new Float32Array(SP * 3), life: new Float32Array(SP), n: SP };
    sparks.frustumCulled = false; scene.add(sparks);

    // Data beam rings
    const ringGeo = new T.TorusGeometry(0.4, 0.03, 6, 32);
    for (let i = 0; i < 4; i++) {
      const r = new T.Mesh(ringGeo, new T.MeshBasicMaterial({ color: 0x86d4c4, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false }));
      r.visible = false; scene.add(r); rings.push(r);
    }

    // Radar pulse on the ground
    radar = new T.Mesh(new T.RingGeometry(0.97, 1, 64), new T.MeshBasicMaterial({ color: 0x86d4c4, transparent: true, opacity: 0, side: T.DoubleSide, depthWrite: false }));
    radar.rotation.x = -Math.PI / 2; radar.visible = false; scene.add(radar);

    // Laser and its hit flash
    const lg = new T.BufferGeometry(); lg.setAttribute("position", new T.BufferAttribute(new Float32Array(6), 3));
    laser = new T.Line(lg, new T.LineBasicMaterial({ color: 0xff3b2f })); laser.visible = false; laser.frustumCulled = false; scene.add(laser);
    flash = new T.Mesh(new T.SphereGeometry(0.25, 10, 8), new T.MeshBasicMaterial({ color: 0xff8a5a, transparent: true, blending: T.AdditiveBlending }));
    flash.position.set(TARGET.x, height(TARGET.x, TARGET.z) + 0.35, TARGET.z); flash.visible = false; scene.add(flash);

    // Heated soil glow at the arm tip
    glow = new T.Mesh(new T.SphereGeometry(0.18, 10, 8), new T.MeshBasicMaterial({ color: 0xff7a2a, transparent: true, opacity: 0, blending: T.AdditiveBlending }));
    scene.add(glow);
  }

  function spawnPuff(x, y, z, vx, vy, vz, color, life, size) {
    const p = puffs.find(q => q.life <= 0);
    if (!p) return;
    p.mesh.position.set(x, y, z); p.vel.set(vx, vy, vz);
    p.mesh.material.color.setHex(color); p.life = p.max = life; p.size = size || 1;
    p.mesh.visible = true;
  }

  function burstSparks(x, y, z) {
    const a = sparks.geometry.attributes.position.array, d = sparks.userData;
    for (let i = 0; i < d.n; i++) {
      if (d.life[i] > 0 && Math.random() < 0.5) continue;
      a[i * 3] = x; a[i * 3 + 1] = y; a[i * 3 + 2] = z;
      d.vel[i * 3] = (Math.random() - 0.5) * 6; d.vel[i * 3 + 1] = 2 + Math.random() * 5; d.vel[i * 3 + 2] = (Math.random() - 0.5) * 6;
      d.life[i] = 0.6 + Math.random() * 0.8;
    }
  }

  /* ---------- Where is the rover at time t? ---------- */
  function xAt(t) {
    switch (run.outcome) {
      case "fuse":    return X0 + SPEED * Math.min(t, 2.6);
      case "battery": return t < 4 ? X0 + SPEED * (t - t * t / 8) : X0 + SPEED * 2;
      case "error":   return X0 + SPEED * Math.min(t, 1.6);
      default:
        if (!run.stops) return X0 + SPEED * t;
        if (t < STOP_T) return X0 + SPEED * t;
        if (t < STOP_T + STOP_LEN) return X_STOP;
        return X_STOP + SPEED * (t - STOP_T - STOP_LEN);
    }
  }

  // Bell-shaped 0→1→0 envelope for an action between a and b.
  const window01 = (t, a, b, ramp) => smooth((t - a) / ramp) * (1 - smooth((t - (b - ramp)) / ramp));

  /* ---------- Per-frame update ---------- */
  function update(t, dt) {
    const r = rover, act = run.actions, x = xAt(t);
    const speed = dt > 0 ? (x - xAt(Math.max(0, t - 0.05))) / 0.05 : 0;

    // Sit the rover on the ground and tilt it with the slope
    const hF = height(x + 1.2, 0), hB = height(x - 1.2, 0), hL = height(x, -1), hR = height(x, 1);
    r.group.position.set(x, (hF + hB + hL + hR) / 4, 0);
    r.group.rotation.set(-Math.atan2(hR - hL, 2), 0, Math.atan2(hF - hB, 2.4));
    r.wheels.forEach(w => { w.rotation.z = -(x - X0) / 0.35; });

    // ---- Task actions while parked ----
    const s0 = STOP_T, s1 = STOP_T + STOP_LEN;
    const armOut = act.arm ? window01(t, s0, s1, 0.7) : 0;
    r.shoulder.rotation.z = lerp(1.35, -0.15, armOut);
    r.elbow.rotation.z = lerp(-2.6, -0.55, armOut);
    r.turret.rotation.z = -(r.shoulder.rotation.z + r.elbow.rotation.z);
    const tipPos = new T.Vector3(); r.tip.getWorldPosition(tipPos);

    const drilling = act.drill && t > s0 + 0.8 && t < s1 - 0.8;
    if (drilling) {
      r.bit.rotation.y += 30 * dt;
      if (Math.random() < 0.35) spawnPuff(tipPos.x, tipPos.y, tipPos.z, (Math.random() - 0.5), 0.6 + Math.random() * 0.6, (Math.random() - 0.5), 0xc98a5a, 1.0, 0.6);
    }
    glow.position.copy(tipPos);
    glow.material.opacity = act.soil ? window01(t, s0 + 0.8, s1 - 0.6, 0.4) * (0.6 + 0.4 * Math.sin(t * 12)) : 0;

    // Mast: panorama spin and/or aim at the laser rock
    const yawToRock = -Math.atan2(TARGET.z - 0.55, TARGET.x - (x + 0.9));
    let yaw = 0;
    if (act.pano) yaw = smooth((t - s0 - 0.2) / 2.0) * (Math.PI * 2 + (act.laser ? yawToRock : 0));
    else if (act.laser) yaw = window01(t, s0, s1, 0.6) * yawToRock;
    if (t > s1) yaw *= 1 - smooth((t - s1) / 0.6);
    r.head.rotation.y = yaw;

    const laserOn = act.laser && (act.pano ? (t > s0 + 2.3 && t < s1 - 0.2) : (t > s0 + 0.6 && t < s1 - 0.6)) && Math.sin(t * 40) > -0.6;
    laser.visible = flash.visible = laserOn;
    if (laserOn) {
      const ep = new T.Vector3(); r.eye.getWorldPosition(ep);
      const la = laser.geometry.attributes.position.array;
      la[0] = ep.x; la[1] = ep.y; la[2] = ep.z; la[3] = flash.position.x; la[4] = flash.position.y; la[5] = flash.position.z;
      laser.geometry.attributes.position.needsUpdate = true;
      flash.scale.setScalar(0.6 + Math.random() * 0.8);
    }

    // Dish: tilt up and beam rings to Earth
    const dishUp = act.dish ? window01(t, s0, s1, 0.6) : 0;
    r.dishPivot.rotation.x = lerp(1.1, 0.2, dishUp);
    const beaming = act.dish && t > s0 + 0.6 && t < s1 - 0.5;
    const dishPos = new T.Vector3(), up = new T.Vector3(0, 1, 0);
    r.dishPivot.getWorldPosition(dishPos);
    up.applyQuaternion(r.dishPivot.getWorldQuaternion(new T.Quaternion()));
    rings.forEach((ring, i) => {
      ring.visible = beaming;
      if (!beaming) return;
      const k = ((t * 0.7 + i / rings.length) % 1);
      ring.position.copy(dishPos).addScaledVector(up, 0.5 + k * 9);
      ring.lookAt(ring.position.clone().add(up));
      ring.scale.setScalar(1 + k * 4);
      ring.material.opacity = (1 - k) * 0.9;
    });

    // Radar pulse
    const radarOn = act.radar && t > s0 + 0.2 && t < s1 - 0.2;
    radar.visible = radarOn;
    if (radarOn) {
      const k = ((t - s0) % 1.2) / 1.2;
      radar.position.set(x, r.group.position.y + 0.08, 0);
      radar.scale.setScalar(1 + k * 12);
      radar.material.opacity = (1 - k) * 0.8;
    }

    // ---- Lights and failures ----
    let beacon = 0x331a10, lamp = 1;
    if (run.outcome === "success" && t > run.dur - 1.5) beacon = Math.sin(t * 6) > 0 ? 0x86d4c4 : 0x1d3a35;
    if (run.outcome === "fuse" && t > 2.6) {
      lamp = 0; beacon = Math.sin(t * 18) > 0 ? 0xff2a1a : 0x331a10;
      if (!run.burst || (t < 3.6 && Math.random() < 0.15)) { burstSparks(x + 0.2, r.group.position.y + 1.3, 0); run.burst = true; }
      if (Math.random() < 0.3) spawnPuff(x + (Math.random() - 0.5), r.group.position.y + 1.4, (Math.random() - 0.5), 0.3, 1.2, 0, 0x3a2a22, 2.2, 1.6);
    }
    if (run.outcome === "battery") {
      lamp = Math.max(0, 1 - t / 4);
      if (t > 4) beacon = Math.sin(t * 2.5) > 0.3 ? 0xffb000 : 0x331a10;
    }
    if (run.outcome === "error" && t > 1.6) beacon = Math.sin(t * 14) > 0 ? 0xff2a1a : 0x331a10;
    r.beacon.material.color.setHex(beacon);
    r.lampMat.color.setRGB(lerp(0.15, 1, lamp), lerp(0.12, 0.95, lamp), lerp(0.1, 0.78, lamp));

    // Wheel dust when moving
    if (speed > 0.3 && Math.random() < 0.6) {
      const side = Math.random() < 0.5 ? -1 : 1;
      spawnPuff(x - 1.2, r.group.position.y + 0.15, side * 1.0, -0.4, 0.35, side * 0.2 * Math.random(), 0xc98a5a, 1.1, 0.8);
    }

    // ---- Particle updates ----
    puffs.forEach(p => {
      if (p.life <= 0) return;
      p.life -= dt;
      if (p.life <= 0) { p.mesh.visible = false; return; }
      const k = 1 - p.life / p.max;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.scale.setScalar(p.size * (0.4 + k * 1.8));
      p.mesh.material.opacity = 0.55 * (1 - k);
    });
    const sa = sparks.geometry.attributes.position.array, sd = sparks.userData;
    for (let i = 0; i < sd.n; i++) {
      if (sd.life[i] <= 0) { sa[i * 3 + 1] = -999; continue; }
      sd.life[i] -= dt; sd.vel[i * 3 + 1] -= 9 * dt;
      sa[i * 3] += sd.vel[i * 3] * dt; sa[i * 3 + 1] += sd.vel[i * 3 + 1] * dt; sa[i * 3 + 2] += sd.vel[i * 3 + 2] * dt;
    }
    sparks.geometry.attributes.position.needsUpdate = true;

    const da = dust.geometry.attributes.position.array;
    for (let i = 0; i < dustCount; i++) {
      da[i * 3] += run.wind * dt * (0.6 + (i % 5) * 0.15);
      da[i * 3 + 1] += Math.sin(t + i) * 0.1 * dt;
      if (da[i * 3] > 30) da[i * 3] -= 60;
    }
    dust.geometry.attributes.position.needsUpdate = true;

    // ---- Camera: slow cinematic orbit ----
    const fit = camera.aspect < 1 ? 1.75 : 1;   // pull back on portrait phones
    const a = -0.9 + t * 0.09, rad = Math.max(6, 8.8 - t * 0.25) * fit;
    const cy = r.group.position.y;
    camera.position.set(x + Math.cos(a) * rad, cy + 2.3 + 0.6 * Math.sin(t * 0.3), Math.sin(a) * rad);
    camera.lookAt(x + 0.4, cy + 1.0, 0);
  }

  /* ---------- Playback ---------- */
  function resize() {
    if (!renderer) return;
    const o = document.getElementById("sceneOverlay");
    const w = o.clientWidth || window.innerWidth, h = o.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);

  function frame(now) {
    if (!run) return;
    const dt = Math.min(0.1, (now - last) / 1000 || 0); last = now;
    if (!run.ended) { run.t += dt; if (run.t >= run.dur) { run.t = run.dur; finish(); } }
    update(run.t, dt);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }

  function finish() {
    if (run.ended) return;
    run.ended = true;
    document.getElementById("sceneSkip").hidden = true;
    document.getElementById("sceneResult").hidden = !run.lines.length;
    const btn = document.getElementById("sceneContinue");
    btn.hidden = false; btn.focus({ preventScroll: true });
  }

  function close() {
    cancelAnimationFrame(raf);
    document.getElementById("sceneOverlay").hidden = true;
    const done = run && run.resolve; run = null;
    puffs.forEach(p => { p.life = 0; p.mesh.visible = false; });
    sparks.userData.life.fill(0);
    if (done) done();
  }

  document.getElementById("sceneSkip").addEventListener("click", () => {
    if (!run) return;
    run.t = run.dur - 0.01;   // jump to the final pose
  });
  document.getElementById("sceneContinue").addEventListener("click", close);

  async function play(opts) {
    if (broken) return;
    const timeout = new Promise(res => setTimeout(() => res(false), 5000));
    const ok = await Promise.race([loadThree(), timeout]);
    if (!ok) return;
    if (!ready) {
      try { init(); } catch (e) { console.warn("3D scenes unavailable:", e); broken = true; return; }
    }

    const names = (opts.names || []).join(" ").toLowerCase();
    const actions = {
      drill: /drill/.test(names),
      soil: /soil/.test(names),
      arm: /drill|soil|close-up/.test(names),
      pano: /panorama/.test(names),
      dish: /send data/.test(names),
      laser: /laser/.test(names),
      radar: /radar/.test(names)
    };
    const outcome = opts.outcome || "success";
    const stops = outcome === "success" && Object.values(actions).some(Boolean);
    const dur = outcome === "success" ? (stops ? 8.6 : 6) : outcome === "fuse" ? 5.2 : outcome === "battery" ? 5.6 : 4.2;

    // Weather: dustier sky and air when resistance is high
    const R = opts.R || 0.3, storm = clamp01((R - 0.2) / 1.1);
    const sky = new T.Color(0xd9a878).lerp(new T.Color(0x8a4a2a), storm);
    scene.background = sky; scene.fog.color.copy(sky);
    scene.fog.density = 0.012 + storm * 0.03;
    sun.intensity = 1.1 - storm * 0.45;
    dustCount = Math.round(200 + storm * 1100);
    dust.geometry.setDrawRange(0, dustCount);

    // Text
    document.getElementById("sceneTitle").textContent = opts.title || "";
    document.getElementById("sceneSub").textContent = opts.sub || "";
    const res = document.getElementById("sceneResult");
    res.className = "scene-result " + (outcome === "success" ? "good" : "bad");
    res.innerHTML = "";
    (opts.lines || []).forEach(l => { const p = document.createElement("p"); p.textContent = l; res.appendChild(p); });
    res.hidden = true;
    document.getElementById("sceneSkip").hidden = false;
    const btn = document.getElementById("sceneContinue");
    btn.textContent = opts.continueLabel || "Continue";
    btn.hidden = true;

    document.getElementById("sceneOverlay").hidden = false;
    resize();

    return new Promise(resolve => {
      run = { outcome, actions, stops, dur, t: 0, ended: false, wind: 0.6 + storm * 3, lines: opts.lines || [], resolve, burst: false };
      if (reduceMotion) {
        // One still frame, no animation.
        run.t = stops ? STOP_T + 1.5 : dur * 0.7;
        update(run.t, 0);
        renderer.render(scene, camera);
        finish();
        return;
      }
      last = performance.now();
      raf = requestAnimationFrame(frame);
    });
  }

  return { play };
})();
