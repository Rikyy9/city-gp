// Procedural modern single-seater (nose points to +Z, local +X is the car's left).

import * as THREE from 'three';

let ENV = null;
let ENV_INT = 1;
export function setCarEnvIntensity(k) {
  ENV_INT = k;
  for (const m of Object.values(shared)) if (m && m.isMaterial && 'envMapIntensity' in m) m.envMapIntensity = k;
}
export function setCarEnvironment(tex) {
  ENV = tex;
  for (const m of Object.values(shared)) if (m && m.isMaterial && 'envMap' in m) { m.envMap = tex; m.needsUpdate = true; }
}

// superellipse cross-sections lofted along Z
function loft(sections, seg = 20) {
  const pos = [];
  const rows = sections.length;
  for (const s of sections) {
    const n = s.n ?? 3;
    for (let k = 0; k < seg; k++) {
      const t = (k / seg) * Math.PI * 2;
      const c = Math.cos(t), sn = Math.sin(t);
      const x = (s.w / 2) * Math.sign(c) * Math.abs(c) ** (2 / n);
      const y = s.y + s.h / 2 + (s.h / 2) * Math.sign(sn) * Math.abs(sn) ** (2 / n);
      pos.push(x + (s.x || 0), y, s.z);
    }
  }
  const idx = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let k = 0; k < seg; k++) {
      const a = r * seg + k, b = r * seg + ((k + 1) % seg), c = (r + 1) * seg + k, d = (r + 1) * seg + ((k + 1) % seg);
      idx.push(a, b, c, b, d, c);
    }
  }
  // caps
  const capF = pos.length / 3, capB = capF + 1;
  const f = sections[rows - 1], b0 = sections[0];
  pos.push(f.x || 0, f.y + f.h / 2, f.z, b0.x || 0, b0.y + b0.h / 2, b0.z);
  for (let k = 0; k < seg; k++) {
    idx.push((rows - 1) * seg + k, (rows - 1) * seg + ((k + 1) % seg), capF);
    idx.push(((k + 1) % seg), k, capB);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const shared = {};
function sharedMats() {
  if (shared.carbon) return shared;
  shared.carbon = new THREE.MeshStandardMaterial({ color: 0x16181c, roughness: 0.35, metalness: 0.4, envMap: ENV });
  shared.black = new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.6 });
  shared.tyre = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.88 });
  shared.rim = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.3, metalness: 0.85, envMap: ENV });
  shared.halo = new THREE.MeshStandardMaterial({ color: 0x1e2024, roughness: 0.25, metalness: 0.7, envMap: ENV });
  shared.visor = new THREE.MeshStandardMaterial({ color: 0x111418, roughness: 0.05, metalness: 0.9, envMap: ENV });
  shared.light = new THREE.MeshBasicMaterial({ color: 0xff2020 });
  shared.soft = new THREE.MeshStandardMaterial({ color: 0xd91f26, roughness: 0.6 });
  shared.mirror = new THREE.MeshStandardMaterial({ color: 0xc8d4e0, roughness: 0.05, metalness: 1, envMap: ENV });
  // geometries reused by every car
  const tyreProfile = [];
  const R = 0.36, W = 0.2, rIn = 0.235;
  for (let k = 0; k <= 12; k++) {
    const a = -Math.PI / 2 + (k / 12) * Math.PI;
    tyreProfile.push(new THREE.Vector2(R - 0.05 + Math.cos(a) * 0.05, Math.sin(a) * W));
  }
  tyreProfile.unshift(new THREE.Vector2(rIn, -W * 0.92));
  tyreProfile.push(new THREE.Vector2(rIn, W * 0.92));
  const mk = (wScale) => {
    const g = new THREE.LatheGeometry(tyreProfile.map((p) => new THREE.Vector2(p.x, p.y * wScale)), 28);
    g.rotateZ(Math.PI / 2);
    return g;
  };
  shared.tyreF = mk(0.95);
  shared.tyreR = mk(1.12);
  shared.rimGeo = new THREE.CylinderGeometry(0.235, 0.235, 0.3, 24, 1);
  shared.rimGeo.rotateZ(Math.PI / 2);
  shared.coverGeo = new THREE.CircleGeometry(0.2, 24);
  shared.bandGeo = new THREE.TorusGeometry(0.3, 0.012, 6, 36);
  return shared;
}

function numberTexture(num, fg) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 128, 128);
  g.font = '900 italic 92px "Titillium Web", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 8;
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.strokeText(String(num), 64, 68);
  g.fillStyle = fg;
  g.fillText(String(num), 64, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createCarModel(color = 0xe10600, accent = 0xffffff, number = 1) {
  const S = sharedMats();
  const body = new THREE.MeshPhysicalMaterial({ color, roughness: 0.32, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.08, envMap: ENV, envMapIntensity: ENV_INT });
  const acc = new THREE.MeshPhysicalMaterial({ color: accent, roughness: 0.35, metalness: 0.2, clearcoat: 0.8, clearcoatRoughness: 0.1, envMap: ENV, envMapIntensity: ENV_INT });
  const helmet = new THREE.MeshPhysicalMaterial({ color: accent, roughness: 0.2, clearcoat: 1, envMap: ENV });
  const car = new THREE.Group();
  const chassis = new THREE.Group();
  car.add(chassis);
  const add = (geo, mat, x = 0, y = 0, z = 0, parent = chassis) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };

  // --- monocoque, nose and engine cover (one smooth loft)
  add(loft([
    { z: -2.35, w: 0.26, h: 0.3, y: 0.2, n: 2.6 },
    { z: -1.8, w: 0.42, h: 0.44, y: 0.16 },
    { z: -1.1, w: 0.58, h: 0.62, y: 0.12 },
    { z: -0.55, w: 0.72, h: 0.66, y: 0.1 },
    { z: -0.1, w: 0.8, h: 0.56, y: 0.1 },
    { z: 0.55, w: 0.76, h: 0.5, y: 0.11 },
    { z: 1.2, w: 0.56, h: 0.4, y: 0.13 },
    { z: 1.9, w: 0.36, h: 0.3, y: 0.14 },
    { z: 2.55, w: 0.22, h: 0.19, y: 0.13 },
    { z: 2.95, w: 0.14, h: 0.12, y: 0.12, n: 2.2 },
  ], 24), body);
  // cockpit opening
  const cockpit = add(new THREE.CircleGeometry(1, 24), S.black, 0, 0.665, 0.25);
  cockpit.scale.set(0.27, 0.48, 1);
  cockpit.rotation.x = -Math.PI / 2 + 0.06;
  cockpit.castShadow = false;
  // airbox / roll hoop
  add(loft([
    { z: -0.95, w: 0.12, h: 0.2, y: 0.62, n: 2.4 },
    { z: -0.6, w: 0.24, h: 0.3, y: 0.62 },
    { z: -0.25, w: 0.3, h: 0.34, y: 0.6 },
    { z: -0.05, w: 0.28, h: 0.3, y: 0.62, n: 2.4 },
  ], 16), body);
  const intake = add(new THREE.CircleGeometry(1, 16), S.black, 0, 0.8, -0.04);
  intake.scale.set(0.1, 0.1, 1);
  // T-cam
  add(new THREE.BoxGeometry(0.16, 0.05, 0.1), acc, 0, 0.96, -0.2);
  // shark fin
  const fin = new THREE.Shape();
  fin.moveTo(0, 0); fin.lineTo(1.35, 0); fin.lineTo(1.35, 0.28); fin.lineTo(0.2, 0.05); fin.lineTo(0, 0.05);
  const finGeo = new THREE.ExtrudeGeometry(fin, { depth: 0.012, bevelEnabled: false });
  finGeo.rotateY(Math.PI / 2);
  add(finGeo, acc, 0.006, 0.82, -1.0);

  // --- sidepods
  for (const sx of [-1, 1]) {
    add(loft([
      { z: -1.45, w: 0.1, h: 0.12, y: 0.12, x: sx * 0.42, n: 2.6 },
      { z: -1.0, w: 0.26, h: 0.24, y: 0.11, x: sx * 0.5 },
      { z: -0.4, w: 0.4, h: 0.36, y: 0.1, x: sx * 0.56 },
      { z: 0.15, w: 0.42, h: 0.4, y: 0.1, x: sx * 0.56 },
      { z: 0.5, w: 0.38, h: 0.34, y: 0.12, x: sx * 0.56, n: 4 },
    ], 18), body);
    const inlet = add(new THREE.PlaneGeometry(0.3, 0.24), S.black, sx * 0.56, 0.3, 0.505);
    inlet.castShadow = false;
    // accent stripe
    add(new THREE.BoxGeometry(0.02, 0.06, 1.1), acc, sx * 0.77, 0.36, -0.25);
    // mirrors
    add(new THREE.CylinderGeometry(0.012, 0.012, 0.22, 6), S.carbon, sx * 0.38, 0.6, 0.62).rotation.z = sx * 1.1;
    const mir = add(new THREE.BoxGeometry(0.16, 0.07, 0.05), body, sx * 0.48, 0.66, 0.62);
    add(new THREE.PlaneGeometry(0.14, 0.055), S.mirror, sx * 0.48, 0.66, 0.594).rotation.y = Math.PI;
    void mir;
  }

  // --- floor, plank, diffuser
  add(new THREE.BoxGeometry(1.42, 0.035, 3.2), S.carbon, 0, 0.07, -0.35);
  const edge = new THREE.BoxGeometry(0.03, 0.08, 2.4);
  add(edge, S.carbon, 0.72, 0.1, -0.5); add(edge, S.carbon, -0.72, 0.1, -0.5);
  const diff = add(new THREE.BoxGeometry(1.0, 0.03, 0.55), S.carbon, 0, 0.16, -2.15);
  diff.rotation.x = -0.35;

  // --- front wing: two halves hinged at the nose (they can droop or break off), endplates
  const fwElems = [[2.95, 0.085, 0.3, 0], [2.78, 0.14, 0.22, 0.25], [2.64, 0.2, 0.16, 0.45]];
  const wingHalves = {};
  for (const sx of [-1, 1]) {
    const half = new THREE.Group();
    half.position.set(sx * 0.12, 0.12, 2.78);
    chassis.add(half);
    fwElems.forEach(([z, y, d, tilt], k) => {
      const w = (1.9 - k * 0.08) / 2 - 0.12;
      const el = add(new THREE.BoxGeometry(w, 0.018, d), k === 2 ? acc : S.carbon, sx * (w / 2), y - 0.12, z - 2.78, half);
      el.rotation.x = tilt;
    });
    const ep = add(new THREE.BoxGeometry(0.02, 0.24, 0.55), acc, sx * 0.84, 0.03, 0, half);
    ep.rotation.x = -0.05;
    wingHalves[sx] = { group: half, ep };
  }
  add(new THREE.BoxGeometry(0.24, 0.018, 0.3), S.carbon, 0, 0.085, 2.95);
  const numMat = new THREE.MeshBasicMaterial({ map: numberTexture(number, '#ffffff'), transparent: true, depthWrite: false });
  const num = add(new THREE.PlaneGeometry(0.24, 0.24), numMat, 0, 0.455, 1.85);
  num.rotation.x = -Math.PI / 2 + 0.16;
  num.castShadow = false;

  // --- rear wing (main plane, flap, endplates, beam wing, pylon)
  add(new THREE.BoxGeometry(0.96, 0.03, 0.32), S.carbon, 0, 0.88, -2.42).rotation.x = 0.12;
  const flap = add(new THREE.BoxGeometry(0.96, 0.025, 0.2), body, 0, 1.0, -2.3);
  flap.rotation.x = 0.55;
  for (const sx of [-1, 1]) {
    const ep = add(new THREE.BoxGeometry(0.025, 0.6, 0.62), acc, sx * 0.49, 0.78, -2.38);
    ep.rotation.x = 0.05;
  }
  add(new THREE.BoxGeometry(0.75, 0.025, 0.18), S.carbon, 0, 0.42, -2.42).rotation.x = 0.2;
  add(new THREE.BoxGeometry(0.05, 0.42, 0.08), S.carbon, 0, 0.64, -2.36);
  // rain / pit-limiter light (blinks)
  const lightMat = new THREE.MeshBasicMaterial({ color: 0x330404 });
  const rl = add(new THREE.BoxGeometry(0.12, 0.07, 0.03), lightMat, 0, 0.38, -2.53);
  rl.castShadow = false;

  // --- halo (tube)
  const haloCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.32, 0.6, -0.05), new THREE.Vector3(-0.29, 0.75, 0.16), new THREE.Vector3(0, 0.8, 0.36),
    new THREE.Vector3(0.29, 0.75, 0.16), new THREE.Vector3(0.32, 0.6, -0.05),
  ]);
  add(new THREE.TubeGeometry(haloCurve, 28, 0.026, 8, false), S.halo);
  add(new THREE.TubeGeometry(new THREE.LineCurve3(new THREE.Vector3(0, 0.8, 0.36), new THREE.Vector3(0, 0.6, 0.62)), 2, 0.022, 8, false), S.halo);

  // --- driver
  add(new THREE.SphereGeometry(0.15, 18, 14), helmet, 0, 0.73, 0.12);
  const visor = add(new THREE.SphereGeometry(0.151, 18, 8, -0.9, 1.8, 1.2, 0.45), S.visor, 0, 0.73, 0.12);
  visor.castShadow = false;

  // --- wheels with steering pivots, suspension arms
  const wheels = [], steerPivots = [], pivots = [];
  // per-car: glowing brake hubs and the tyre-compound band colour
  const hubMat = S.rim.clone();
  hubMat.emissive = new THREE.Color(0xff4a00);
  hubMat.emissiveIntensity = 0;
  const bandMat = S.soft.clone();
  const wp = [[0.82, 0.36, 1.8, true], [-0.82, 0.36, 1.8, true], [0.8, 0.36, -1.78, false], [-0.8, 0.36, -1.78, false]];
  const armMat = S.carbon;
  for (const [x, y, z, front] of wp) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    car.add(pivot);
    const spin = new THREE.Group();
    pivot.add(spin);
    const tyre = new THREE.Mesh(front ? S.tyreF : S.tyreR, S.tyre);
    tyre.castShadow = true;
    spin.add(tyre);
    spin.add(new THREE.Mesh(S.rimGeo, S.rim));
    const side = Math.sign(x);
    const cover = new THREE.Mesh(S.coverGeo, hubMat);
    cover.position.x = side * 0.16;
    cover.rotation.y = side * Math.PI / 2;
    spin.add(cover);
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.36, 0.04), acc);
    spoke.position.x = side * 0.165;
    spin.add(spoke);
    // compound band on the sidewall (soft = red)
    const band = new THREE.Mesh(S.bandGeo, bandMat);
    band.rotation.y = Math.PI / 2;
    band.position.x = side * (front ? 0.19 : 0.225);
    pivot.add(band);
    wheels.push(spin);
    pivots.push({ pivot, side, front });
    if (front) steerPivots.push(pivot);
    // wishbones
    for (const dy of [-0.08, 0.1]) {
      const a = new THREE.Vector3(side * 0.3, 0.3 + dy * 0.6, z + (front ? -0.25 : 0.25));
      const b = new THREE.Vector3(x - side * 0.12, y + dy, z);
      const len = a.distanceTo(b);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, len, 5), armMat);
      arm.position.copy(a).add(b).multiplyScalar(0.5);
      arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      chassis.add(arm);
    }
  }

  // soft blob shadow (visible outside the shadow-map range)
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 6.0), blobMaterial());
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.05;
  blob.renderOrder = 1;
  car.add(blob);

  return {
    group: car, body: chassis, wheels, steerPivots, pivots, flap, wingHalves,
    materials: { body, acc, helmet, light: lightMat, hub: hubMat, band: bandMat },
    heat: 0, tyre: 'slick', debris: 0, wingState: 0,
  };
}

let _blobMat;
function blobMaterial() {
  if (_blobMat) return _blobMat;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 64, 4, 32, 64, 62);
  grd.addColorStop(0, 'rgba(0,0,0,0.55)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 128);
  _blobMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false });
  return _blobMat;
}

const BAND = { slick: 0xd91f26, inter: 0x22b14c };

// damage look: wing (0..1) and suspension (0..1) on side (+1 = left, -1 = right)
export function setDamageVisual(model, wing, susp, side) {
  if (!model.wingHalves) return;
  const h = model.wingHalves[side] || model.wingHalves[1], o = model.wingHalves[-side] || model.wingHalves[-1];
  const state = wing > 0.72 ? 2 : wing > 0.35 ? 1 : 0;
  if (state > model.wingState) model.debris = state === 2 ? 14 : 6;
  model.wingState = state;
  h.group.visible = state < 2;
  h.group.rotation.set(state ? 0.1 : 0, state ? side * 0.14 : 0, -side * (state ? 0.24 : wing * 0.12));
  h.ep.visible = wing < 0.3;
  o.group.visible = true; o.group.rotation.set(0, 0, 0); o.ep.visible = true;
  for (const p of model.pivots) p.pivot.rotation.z = p.front && p.side === side ? side * 0.22 * susp : 0;
}

// lights and brake glow; ctx = { wet, time }
export function updateCarLights(model, car, dt, ctx = {}) {
  const hot = car.brake > 0.4 && car.vf > 22 ? car.brake : 0;
  model.heat = Math.min(1, Math.max(0, model.heat + (hot ? dt * 2.2 * hot : -dt * 0.5)));
  model.materials.hub.emissiveIntensity = model.heat * model.heat * 3;
  const blink = ((ctx.wet || 0) > 0.12 || car.limiter > 0) && Math.floor((ctx.time || 0) * 4) % 2 === 0;
  model.materials.light.color.setRGB(blink ? 5 : 0.25, blink ? 0.25 : 0.02, blink ? 0.2 : 0.02);
  if (car.tyre && car.tyre !== model.tyre) { model.tyre = car.tyre; model.materials.band.color.set(BAND[car.tyre] || BAND.slick); }
}

// sync a model with a physics car
export function updateCarModel(model, car, dt, ctx) {
  model.group.position.set(car.x, car.y, car.z);
  model.group.rotation.order = 'YXZ';
  model.group.rotation.y = car.h;
  model.group.rotation.x = -car.pitch;
  for (const w of model.wheels) w.rotation.x = car.wheelRot;
  const steerAngle = car.delta !== undefined ? car.delta : -car.steer * 0.42 / (1 + Math.abs(car.vf) / 22);
  for (const p of model.steerPivots) p.rotation.y = steerAngle;
  // body pitch & roll from accelerations (+ kerb vibration)
  const pitchT = Math.max(-0.02, Math.min(0.02, -(car.ax || 0) * 0.0008));
  const rollT = Math.max(-0.03, Math.min(0.03, (car.ay || 0) * 0.0009));
  const k = Math.min(1, dt * 8);
  model.body.rotation.x += (pitchT - model.body.rotation.x) * k;
  model.body.rotation.z += (rollT - model.body.rotation.z) * k;
  model.body.position.y = car.kerb ? (Math.random() - 0.5) * 0.02 * car.kerb : 0;
  if (model.flap) model.flap.rotation.x += ((car.drsOpen ? 0.06 : 0.55) - model.flap.rotation.x) * Math.min(1, dt * 12);
  if (car.damage) setDamageVisual(model, car.damage.wing, car.damage.susp, car.damage.side);
  updateCarLights(model, car, dt, ctx);
}
