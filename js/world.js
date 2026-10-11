// Builds the 3D scene around a track: terrain with satellite + painted OSM ground, circuit furniture,
// buildings, trees, street signs and landmark labels.

import * as THREE from 'three';
import { lon2tile, lat2tile, tile2lon, tile2lat } from './geo.js';
import { SATELLITE_URL } from './osm.js';
import * as TX from './textures.js';
import { buildBuildings, buildTrees } from './buildings.js';
import { selectLandmarks, streetNames } from './scenery.js';

// ---------------------------------------------------------------- helpers
function stripGeometry(track, i0, count, offA, offB, yOff, vScale, closed) {
  const n = track.n;
  const rows = count + 1;
  const pos = new Float32Array(rows * 2 * 3);
  const uv = new Float32Array(rows * 2 * 2);
  for (let r = 0; r < rows; r++) {
    const i = (i0 + r) % n;
    const px = track.P[2 * i], pz = track.P[2 * i + 1], nx = track.N[2 * i], nz = track.N[2 * i + 1];
    const y = track.Y[i] + yOff;
    const s = closed && r === count ? track.length : track.S[i] + (i0 + r >= n && !closed ? track.length : 0);
    const a = typeof offA === 'function' ? offA(i) : offA, b = typeof offB === 'function' ? offB(i) : offB;
    pos.set([px + nx * a, y, pz + nz * a, px + nx * b, y, pz + nz * b], r * 6);
    uv.set([0, s / vScale, 1, s / vScale], r * 4);
  }
  const idx = [];
  for (let r = 0; r < count; r++) {
    const a = 2 * r, b = 2 * r + 1, c = 2 * r + 2, d = 2 * r + 3;
    idx.push(a, c, b, b, c, d);
  }
  const p = pos;
  const e1 = [p[6] - p[0], p[8] - p[2]], e2 = [p[3] - p[0], p[5] - p[2]];
  if (e1[1] * e2[0] - e1[0] * e2[1] < 0) {
    for (let k = 0; k < idx.length; k += 3) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function wallGeometry(track, side, y0, y1, uScale) {
  const n = track.n;
  const rows = n + 1;
  const pos = new Float32Array(rows * 2 * 3);
  const uv = new Float32Array(rows * 2 * 2);
  for (let r = 0; r < rows; r++) {
    const i = r % n;
    const off = side * track.wallOff;
    const x = track.P[2 * i] + track.N[2 * i] * off, z = track.P[2 * i + 1] + track.N[2 * i + 1] * off;
    const s = r === n ? track.length : track.S[i];
    const Y = track.Y[i];
    pos.set([x, Y + y0, z, x, Y + y1, z], r * 6);
    const u = (side > 0 ? s : -s) / uScale; // keep text readable from the track on both sides
    uv.set([u, 0, u, 1], r * 4);
  }
  const idx = [];
  for (let r = 0; r < n; r++) {
    const a = 2 * r, b = 2 * r + 1, c = 2 * r + 2, d = 2 * r + 3;
    if (side > 0) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const k = next++;
      await fn(items[k], k);
    }
  }));
}

// wet-road shading: darker albedo, low roughness with puddles, reflections from the sky env map
let PUDDLES = null;
function makeWettable(mat, { puddles = true, darken = 0.5 } = {}) {
  PUDDLES = PUDDLES || TX.puddleTexture();
  const u = { uWet: { value: 0 }, tPuddle: { value: PUDDLES }, uPuddles: { value: puddles ? 1 : 0 } };
  mat.userData.wet = u;
  mat.envMapIntensity = 0;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWorldXZ;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWorldXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uWet; uniform float uPuddles; uniform sampler2D tPuddle; varying vec2 vWorldXZ;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float puddle = uPuddles * smoothstep(0.35, 0.8, texture2D(tPuddle, vWorldXZ * 0.045).r) * smoothstep(0.25, 0.85, uWet);
        diffuseColor.rgb *= mix(1.0, ${darken.toFixed(2)} - 0.12 * puddle, uWet);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, mix(0.34, 0.05, puddle), uWet);`);
  };
  mat.customProgramCacheKey = () => 'wet' + (puddles ? 1 : 0) + darken;
  return mat;
}
export function setWetness(mats, wet, envMap) {
  for (const m of mats) {
    m.userData.wet.uWet.value = wet;
    if (envMap && m.envMap !== envMap) { m.envMap = envMap; m.needsUpdate = true; }
    m.envMapIntensity = wet * 1.15;
    if (m.normalMap) m.normalScale.setScalar(m.userData.dryNormal * (1 - 0.7 * wet));
  }
}

// ---------------------------------------------------------------- OSM ground painting
const ROAD_W = {
  motorway: 22, trunk: 16, primary: 13, secondary: 11, tertiary: 9, unclassified: 7, residential: 6.5, living_street: 5.5,
  service: 4, pedestrian: 6, track: 3, footway: 2.2, path: 1.8, cycleway: 2, steps: 2.4, bridleway: 2, busway: 7,
  motorway_link: 7, trunk_link: 7, primary_link: 7, secondary_link: 7, tertiary_link: 7,
};
const PAVING = new Set(['pedestrian', 'footway', 'path', 'cycleway', 'steps', 'bridleway', 'track', 'living_street']);
const AREA_STYLE = {
  water: 'rgba(38,84,128,0.62)', park: 'rgba(84,132,58,0.30)', wood: 'rgba(46,88,40,0.34)',
  pitch: 'rgba(70,145,70,0.35)', cemetery: 'rgba(90,110,80,0.25)', plaza: 'rgba(205,196,178,0.85)',
};

function bboxOf(pts) {
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (const [x, z] of pts) { a = Math.min(a, x); b = Math.max(b, x); c = Math.min(c, z); d = Math.max(d, z); }
  return [a, b, c, d];
}

function prepFeatures(sc) {
  if (!sc) return null;
  const roads = [];
  for (const r of sc.roads) {
    const t = r.tags;
    if (t.tunnel === 'yes' || t.tunnel === 'building_passage' || parseInt(t.layer, 10) < 0 || t.area === 'yes') continue;
    let w = ROAD_W[t.highway];
    if (!w) continue;
    const wt = parseFloat(t.width), lanes = parseInt(t.lanes, 10);
    if (wt > 1 && wt < 40) w = wt;
    else if (lanes > 0 && !PAVING.has(t.highway)) w = Math.max(w * 0.7, lanes * 3.2 + 1);
    roads.push({ pts: r.pts, w, paving: PAVING.has(t.highway), sidewalk: !PAVING.has(t.highway) && t.highway !== 'service' && !/link/.test(t.highway),
      centre: !PAVING.has(t.highway) && t.oneway !== 'yes' && w >= 9, bb: bboxOf(r.pts) });
  }
  const areas = sc.areas.filter((a) => AREA_STYLE[a.kind]).map((a) => ({ ...a, bb: bboxOf(a.ring) }));
  const waters = sc.waterways.map((w) => ({ pts: w.pts, w: parseFloat(w.tags.width) || { river: 22, canal: 12, stream: 3 }[w.tags.waterway] || 3, bb: bboxOf(w.pts) }));
  const rails = sc.rails.filter((r) => r.tags.tunnel !== 'yes').map((r) => ({ pts: r.pts, tram: r.tags.railway === 'tram', bb: bboxOf(r.pts) }));
  return { roads, areas, waters, rails };
}

function paintJob(g, j, feats, mpp) {
  const W = j.W, H = j.H;
  const sx = W / (j.xE - j.xW), sz = H / (j.zS - j.zN);
  const pad = 30;
  const vis = (bb) => bb[1] >= j.xW - pad && bb[0] <= j.xE + pad && bb[3] >= j.zN - pad && bb[2] <= j.zS + pad;
  const path = (pts, close) => {
    g.beginPath();
    pts.forEach(([x, z], k) => { const px = (x - j.xW) * sx, py = (z - j.zN) * sz; if (k) g.lineTo(px, py); else g.moveTo(px, py); });
    if (close) g.closePath();
  };
  const px = (m) => Math.max(1, m / mpp);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const a of feats.areas) { if (!vis(a.bb)) continue; g.fillStyle = AREA_STYLE[a.kind]; path(a.ring, true); g.fill(); }
  g.strokeStyle = AREA_STYLE.water;
  for (const w of feats.waters) { if (!vis(w.bb)) continue; g.lineWidth = px(w.w); path(w.pts); g.stroke(); }
  const rs = feats.roads.filter((r) => vis(r.bb));
  g.strokeStyle = '#b9b3a6';
  for (const r of rs) if (r.sidewalk) { g.lineWidth = px(r.w + 5); path(r.pts); g.stroke(); }
  g.strokeStyle = '#cdc5b3';
  for (const r of rs) if (r.paving) { g.lineWidth = px(r.w); path(r.pts); g.stroke(); }
  g.strokeStyle = '#4b4c4f';
  for (const r of rs) if (!r.paving) { g.lineWidth = px(r.w); path(r.pts); g.stroke(); }
  g.strokeStyle = 'rgba(240,240,235,0.85)';
  g.lineCap = 'butt';
  g.setLineDash([px(3), px(6)]);
  for (const r of rs) if (r.centre) { g.lineWidth = px(0.18); path(r.pts); g.stroke(); }
  g.setLineDash([]);
  for (const r of feats.rails) {
    if (!vis(r.bb)) continue;
    if (!r.tram) { g.strokeStyle = '#857d72'; g.lineWidth = px(4); path(r.pts); g.stroke(); }
    g.strokeStyle = '#333'; g.lineWidth = px(1.6); g.setLineDash([px(0.3), px(0.5)]); path(r.pts); g.stroke(); g.setLineDash([]);
  }
  g.lineCap = 'round';
}

// ---------------------------------------------------------------- terrain + satellite ground
async function buildGround(group, proj, track, ground, feats, onProgress, maxAniso) {
  const b = track.bounds;
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const jobs = [];
  {
    const z = 14;
    const [n, w] = proj.toLatLon(cx - 5500, cz - 5500);
    const [s, e] = proj.toLatLon(cx + 5500, cz + 5500);
    jobs.push({ z, x0: Math.floor(lon2tile(w, z)), x1: Math.floor(lon2tile(e, z)), y0: Math.floor(lat2tile(n, z)), y1: Math.floor(lat2tile(s, z)), y: -0.6, order: -4, seg: 72, far: true });
  }
  {
    const z = 17;
    const [n, w] = proj.toLatLon(b.minX - 500, b.minZ - 500);
    const [s, e] = proj.toLatLon(b.maxX + 500, b.maxZ + 500);
    const X0 = Math.floor(lon2tile(w, z)), X1 = Math.floor(lon2tile(e, z));
    const Y0 = Math.floor(lat2tile(n, z)), Y1 = Math.floor(lat2tile(s, z));
    for (let x = X0; x <= X1; x += 4) for (let y = Y0; y <= Y1; y += 4) {
      jobs.push({ z, x0: x, x1: Math.min(X1, x + 3), y0: y, y1: Math.min(Y1, y + 3), y: -0.2, order: -3, seg: 44, paint: true });
    }
  }
  {
    // sharp corridor (zoom 19) along the circuit, 2x2-tile chunks
    const z = 19;
    const set = new Set();
    for (let i = 0; i < track.n; i += 3) {
      for (const off of [-35, 0, 35]) {
        const [lat, lon] = proj.toLatLon(track.P[2 * i] + track.N[2 * i] * off, track.P[2 * i + 1] + track.N[2 * i + 1] * off);
        set.add(`${Math.floor(lon2tile(lon, z))},${Math.floor(lat2tile(lat, z))}`);
      }
    }
    const chunks = new Map();
    for (const k of set) {
      const [tx, ty] = k.split(',').map(Number);
      const ck = `${tx >> 1},${ty >> 1}`;
      if (!chunks.has(ck)) chunks.set(ck, []);
      chunks.get(ck).push([tx, ty]);
    }
    for (const [ck, tiles] of chunks) {
      const [a, c] = ck.split(',').map(Number);
      jobs.push({ z, x0: a * 2, x1: a * 2 + 1, y0: c * 2, y1: c * 2 + 1, only: tiles, y: -0.08, order: -2, seg: 12, transparent: true, paint: true });
    }
  }

  const tileList = [];
  for (const j of jobs) {
    j.W = (j.x1 - j.x0 + 1) * 256; j.H = (j.y1 - j.y0 + 1) * 256;
    j.canvas = document.createElement('canvas');
    j.canvas.width = j.W; j.canvas.height = j.H;
    j.ctx = j.canvas.getContext('2d');
    if (!j.transparent) { j.ctx.fillStyle = '#5d6650'; j.ctx.fillRect(0, 0, j.W, j.H); }
    const list = j.only || [];
    if (!j.only) for (let x = j.x0; x <= j.x1; x++) for (let y = j.y0; y <= j.y1; y++) list.push([x, y]);
    for (const [x, y] of list) tileList.push({ j, x, y });
    const lonW = tile2lon(j.x0, j.z), lonE = tile2lon(j.x1 + 1, j.z);
    const latN = tile2lat(j.y0, j.z), latS = tile2lat(j.y1 + 1, j.z);
    [j.xW, j.zN] = proj.toXZ(latN, lonW);
    [j.xE, j.zS] = proj.toXZ(latS, lonE);
  }
  let loaded = 0;
  await pool(tileList, 16, async (t) => {
    const img = await loadImage(SATELLITE_URL(t.j.z, t.x, t.y));
    if (img) t.j.ctx.drawImage(img, (t.x - t.j.x0) * 256, (t.y - t.j.y0) * 256);
    loaded++;
    if (loaded % 10 === 0) onProgress?.(loaded / tileList.length);
  });

  const mppBase = 156543.03392 * Math.cos((proj.lat0 * Math.PI) / 180);
  for (const j of jobs) {
    if (j.paint && feats) {
      if (j.transparent) {
        // only paint where imagery exists, so the layer below shows elsewhere
        j.ctx.save();
        j.ctx.beginPath();
        for (const [x, y] of j.only) j.ctx.rect((x - j.x0) * 256, (y - j.y0) * 256, 256, 256);
        j.ctx.clip();
      }
      paintJob(j.ctx, j, feats, mppBase / 2 ** j.z);
      if (j.transparent) j.ctx.restore();
    }
    const t = new THREE.CanvasTexture(j.canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAniso;
    const mat = new THREE.MeshLambertMaterial({ map: t, depthWrite: false, transparent: !!j.transparent });
    const gx = (j.xW + j.xE) / 2, gz = (j.zN + j.zS) / 2;
    const geo = new THREE.PlaneGeometry(j.xE - j.xW, j.zS - j.zN, j.seg, j.seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, ground(pos.getX(i) + gx, pos.getZ(i) + gz, j.far) + j.y);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(gx, 0, gz);
    mesh.renderOrder = j.order;
    mesh.receiveShadow = true;
    group.add(mesh);
    j.canvas = j.ctx = null;
  }
}

// ---------------------------------------------------------------- circuit furniture
function buildCircuit(group, track, city, night) {
  const asphaltTex = TX.asphaltTexture();
  const normalTex = TX.asphaltNormalTexture();
  normalTex.repeat.set(3, 3);
  const n = track.n, hw = track.halfW, wo = track.wallOff;
  const wetMats = [];
  const asphaltMat = makeWettable(new THREE.MeshStandardMaterial({ map: asphaltTex, normalMap: normalTex, normalScale: new THREE.Vector2(0.55, 0.55), roughness: 0.9 }));
  asphaltMat.userData.dryNormal = 0.55;
  wetMats.push(asphaltMat);
  const asphalt = new THREE.Mesh(stripGeometry(track, 0, n, -hw, hw, 0.02, 12, true), asphaltMat);
  asphalt.receiveShadow = true;
  group.add(asphalt);

  const runMat = makeWettable(new THREE.MeshStandardMaterial({ map: asphaltTex, normalMap: normalTex, normalScale: new THREE.Vector2(0.7, 0.7), color: 0x9a9da3, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
  runMat.userData.dryNormal = 0.7;
  wetMats.push(runMat);
  for (const side of [-1, 1]) {
    const m = new THREE.Mesh(stripGeometry(track, 0, n, side * hw, side * (wo + 0.3), 0.02, 12, true), runMat);
    m.receiveShadow = true;
    group.add(m);
  }
  const lineMat = makeWettable(new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }), { puddles: false, darken: 0.8 });
  wetMats.push(lineMat);
  for (const side of [-1, 1]) {
    const m = new THREE.Mesh(stripGeometry(track, 0, n, side * (hw - 0.45), side * (hw - 0.15), 0.025, 10, true), lineMat);
    m.receiveShadow = true;
    group.add(m);
  }

  // darker rubbered-in racing line
  if (track.raceOffset) {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 4;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 64, 0);
    grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(0.5, 'rgba(0,0,0,1)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 4);
    const rubber = new THREE.Mesh(
      stripGeometry(track, 0, n, (i) => track.raceOffset[i] - 1.6, (i) => track.raceOffset[i] + 1.6, 0.022, 50, true),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, opacity: 0.32, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -3 }),
    );
    rubber.renderOrder = 1;
    group.add(rubber);
  }

  // kerbs on corners
  const kerbMat = makeWettable(new THREE.MeshStandardMaterial({ map: TX.kerbTexture(), roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }), { puddles: false, darken: 0.75 });
  wetMats.push(kerbMat);
  const thr = 1 / 110;
  const visited = new Uint8Array(n);
  for (let i = 0; i < n;) {
    if (Math.abs(track.kappa[i]) > thr && !visited[i]) {
      let a = i, b = i;
      while (Math.abs(track.kappa[track.wrap(a - 1)]) > thr && a - i > -n) a--;
      while (Math.abs(track.kappa[track.wrap(b + 1)]) > thr && b - i < n) b++;
      for (let k = a; k <= b; k++) visited[track.wrap(k)] = 1;
      const pad = 6;
      for (const side of [-1, 1]) {
        const m = new THREE.Mesh(stripGeometry(track, track.wrap(a - pad), b - a + 2 * pad, side * (hw - 0.2), side * (hw + 1.1), 0.03, 4, false), kerbMat);
        m.receiveShadow = true;
        group.add(m);
      }
      i = b + 1;
    } else i++;
  }

  // walls + catch fence
  const barrierTex = TX.barrierTexture(city);
  const wallMat = new THREE.MeshStandardMaterial({ map: barrierTex, roughness: 0.8, side: THREE.DoubleSide });
  const fenceMat = new THREE.MeshStandardMaterial({ map: TX.fenceTexture(), alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.4 });
  for (const side of [-1, 1]) {
    const w = new THREE.Mesh(wallGeometry(track, side, -0.6, 1.1, 17.6), wallMat);
    w.castShadow = true; w.receiveShadow = true;
    group.add(w);
    group.add(new THREE.Mesh(wallGeometry(track, side, 1.1, 4.0, 3.0), fenceMat));
  }

  // start/finish line
  const ck = new THREE.Mesh(new THREE.PlaneGeometry(track.width, 1.6),
    new THREE.MeshStandardMaterial({ map: TX.checkerTexture(), roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }));
  ck.rotation.x = -Math.PI / 2;
  ck.rotation.z = Math.atan2(track.T[0], track.T[1]);
  ck.position.set(track.P[0], track.Y[0] + 0.035, track.P[1]);
  ck.receiveShadow = true;
  group.add(ck);

  const gridMat = new THREE.MeshStandardMaterial({ map: TX.gridBoxTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 });
  for (let k = 0; k < 10; k++) {
    const p = track.pointAt(track.length - 8 - k * 8, k % 2 ? -2.8 : 2.8);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 4.8), gridMat);
    m.rotation.order = 'YXZ';
    m.rotation.y = Math.atan2(p.tx, p.tz) + Math.PI;
    m.rotation.x = -Math.PI / 2;
    m.position.set(p.x, p.y + 0.035, p.z);
    group.add(m);
  }

  // gantry with start lights
  const gantry = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0x2b2f36, metalness: 0.6, roughness: 0.4 });
  const span = 2 * wo + 1;
  const beam = new THREE.Mesh(new THREE.BoxGeometry(span, 0.9, 0.7), steel);
  beam.position.y = 6.6;
  beam.castShadow = true;
  gantry.add(beam);
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 8, 0.5), steel);
    post.position.set(s * (span / 2), 3, 0);
    post.castShadow = true;
    gantry.add(post);
  }
  const lights = [];
  for (let k = 0; k < 5; k++) {
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.5, 0.3), new THREE.MeshStandardMaterial({ color: 0x0c0c0c }));
    housing.position.set((k - 2) * 0.9, 5.6, -0.4);
    gantry.add(housing);
    for (const dy of [0.35, -0.35]) {
      const l = new THREE.Mesh(new THREE.CircleGeometry(0.22, 16), new THREE.MeshBasicMaterial({ color: 0x220000 }));
      l.position.set((k - 2) * 0.9, 5.6 + dy, -0.56);
      l.rotation.y = Math.PI;
      gantry.add(l);
      lights.push({ mesh: l, column: k });
    }
  }
  const banner = new THREE.Mesh(new THREE.PlaneGeometry(span - 1, 0.8), new THREE.MeshBasicMaterial({ map: barrierTex, side: THREE.DoubleSide }));
  banner.position.set(0, 6.6, -0.36);
  gantry.add(banner);
  gantry.position.set(track.P[0], track.Y[0], track.P[1]);
  gantry.rotation.y = Math.atan2(track.T[0], track.T[1]);
  group.add(gantry);

  // grandstand along the start straight
  const exclusions = [];
  const standMat = new THREE.MeshStandardMaterial({ map: TX.crowdTexture(), roughness: 0.9, side: THREE.DoubleSide });
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x3b4048, roughness: 0.7 });
  const s0 = track.length - 110, s1 = track.length + 30;
  let straight = true;
  for (let s = s0; s <= s1; s += 10) if (Math.abs(track.kappa[track.pointAt(s).idx]) > 1 / 300) straight = false;
  if (straight) {
    const side = 1;
    const pos = [], uv = [], idx = [];
    let row = 0;
    for (let s = s0; s <= s1; s += 4, row++) {
      const p = track.pointAt(s);
      const a = wo + 2.5, bOff = wo + 15;
      const ax = p.x + p.nx * a * side, az = p.z + p.nz * a * side;
      const bx = p.x + p.nx * bOff * side, bz = p.z + p.nz * bOff * side;
      pos.push(ax, p.y + 1.2, az, bx, p.y + 10, bz);
      uv.push((s - s0) / 12, 0, (s - s0) / 12, 3);
      exclusions.push([ax, az], [bx, bz]);
    }
    for (let r = 0; r < row - 1; r++) idx.push(2 * r, 2 * r + 2, 2 * r + 1, 2 * r + 1, 2 * r + 2, 2 * r + 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const stand = new THREE.Mesh(g, standMat);
    stand.castShadow = true; stand.receiveShadow = true;
    group.add(stand);
    const mid = track.pointAt((s0 + s1) / 2);
    const lenS = s1 - s0;
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.4, 14, lenS), frameMat);
    back.position.set(mid.x + mid.nx * (wo + 15.2), mid.y + 5, mid.z + mid.nz * (wo + 15.2));
    back.rotation.y = Math.atan2(mid.tx, mid.tz);
    back.castShadow = true;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(14, 0.3, lenS), frameMat);
    roof.position.set(mid.x + mid.nx * (wo + 9), mid.y + 13, mid.z + mid.nz * (wo + 9));
    roof.rotation.y = back.rotation.y;
    roof.castShadow = true;
    group.add(back, roof);
  }

  // lamp posts (lit at night)
  const lampEvery = 45;
  const count = Math.floor(track.length / lampEvery);
  const poleGeo = new THREE.CylinderGeometry(0.08, 0.12, 10, 6);
  poleGeo.translate(0, 4, 0);
  const poles = new THREE.InstancedMesh(poleGeo, steel, count);
  const headsMat = new THREE.MeshStandardMaterial({ color: 0x444444, emissive: night ? 0xfff2d0 : 0x000000, emissiveIntensity: 2 });
  const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.25, 1.6), headsMat, count);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
  for (let k = 0; k < count; k++) {
    const side = k % 2 ? 1 : -1;
    const p = track.pointAt(k * lampEvery + 20, side * (wo + 0.8));
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(p.tx, p.tz));
    m4.compose(new THREE.Vector3(p.x, p.y, p.z), q, one);
    poles.setMatrixAt(k, m4);
    const hp = track.pointAt(k * lampEvery + 20, side * (wo - 0.3));
    m4.compose(new THREE.Vector3(hp.x, hp.y + 9, hp.z), q, one);
    heads.setMatrixAt(k, m4);
  }
  poles.castShadow = true;
  group.add(poles, heads);

  // pools of light under the lamps (night only)
  const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: TX.lightPoolTexture(), color: 0xffd9a0, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }), count);
  for (let k = 0; k < count; k++) {
    const side = k % 2 ? 1 : -1;
    const hp = track.pointAt(k * lampEvery + 20, side * (wo - 3.5));
    m4.compose(new THREE.Vector3(hp.x, hp.y + 0.06, hp.z), q.identity(), new THREE.Vector3(17, 1, 17));
    pools.setMatrixAt(k, m4);
  }
  pools.renderOrder = 4;
  pools.visible = night;
  group.add(pools);

  buildTecpro(group, track);
  const marshals = buildMarshals(group, track);
  return { lights, exclusions, headsMat, pools, wetMats, marshals };
}

// energy-absorbing barrier blocks lining the wall on the outside of tight corners (Track.inset)
function buildTecpro(group, track) {
  const blocks = [];
  for (const z of track.tecpro || []) {
    const s0 = track.S[z.i0], len = z.count * track.ds;
    for (let d = 0; d < len; d += 1.25) blocks.push({ s: s0 + d, side: z.side });
  }
  if (!blocks.length) return;
  const mat = new THREE.MeshStandardMaterial({ map: TX.tecproTexture(), roughness: 0.75 });
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.55, 1.05, 1.2), mat, blocks.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
  blocks.forEach((b, k) => {
    const p = track.pointAt(b.s, b.side * (track.wallOff - 0.3));
    q.setFromAxisAngle(up, Math.atan2(p.tx, p.tz));
    m4.compose(new THREE.Vector3(p.x, p.y + 0.5, p.z), q, one);
    mesh.setMatrixAt(k, m4);
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

// marshal posts behind the fence, each with a waving flag (green / yellow after incidents)
function buildMarshals(group, track) {
  const out = [];
  const cabinMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.7 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xff7a00, roughness: 0.6 });
  const suitMat = new THREE.MeshStandardMaterial({ color: 0xff6a00, roughness: 0.8 });
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x777777, metalness: 0.5, roughness: 0.4 });
  const flagGeo = new THREE.PlaneGeometry(1.1, 0.75, 8, 1).translate(0.55, 0, 0);
  const every = 360;
  for (let s = 140, k = 0; s < track.length - 120; s += every, k++) {
    const side = k % 2 ? 1 : -1;
    const p = track.pointAt(s, side * (track.wallOff + 2.6));
    const g = new THREE.Group();
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.2, 1.6), cabinMat);
    cabin.position.y = 1.1;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.2, 2), roofMat);
    roof.position.y = 2.3;
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.9, 4, 8), suitMat);
    body.position.set(0, 0.8, 1.15);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), suitMat);
    head.position.set(0, 1.55, 1.15);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.8, 5), poleMat);
    pole.position.set(0.25, 1.9, 1.3);
    pole.rotation.z = -0.5;
    const flagMat = new THREE.MeshStandardMaterial({ color: 0x16c25a, side: THREE.DoubleSide, roughness: 0.8, emissive: 0x16c25a, emissiveIntensity: 0.15 });
    const flag = new THREE.Mesh(flagGeo, flagMat);
    flag.position.set(0.68, 2.65, 1.3);
    for (const m of [cabin, roof, body]) m.castShadow = true;
    g.add(cabin, roof, body, head, pole, flag);
    g.position.set(p.x, p.y, p.z);
    // face the track
    g.rotation.y = Math.atan2(-p.nx * side, -p.nz * side);
    group.add(g);
    out.push({ s, flag, mat: flagMat, phase: k * 1.7, yellow: 0 });
  }
  return out;
}

// waving flags; incidents = list of track positions s where something happened recently
export function updateMarshals(marshals, dt, time, track, incidents) {
  for (const m of marshals) {
    const near = incidents.some((s) => { const d = (s - m.s + track.length) % track.length; return d < 260 || d > track.length - 60; });
    m.yellow = near ? 6 : Math.max(0, m.yellow - dt);
    const col = m.yellow > 0 ? 0xffd400 : 0x16c25a;
    if (m.mat.color.getHex() !== col) { m.mat.color.set(col); m.mat.emissive.set(col); }
    const wave = m.yellow > 0 ? 1.6 : 0.5;
    m.flag.rotation.y = Math.sin(time * (m.yellow > 0 ? 9 : 3) + m.phase) * 0.6 * wave;
    m.flag.rotation.z = Math.sin(time * 2.1 + m.phase) * 0.1;
  }
}

// ---------------------------------------------------------------- DRS zones & pit lane markings
function textPlate(text, bg, fg, w = 512, h = 128) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  g.fillStyle = fg;
  g.font = `900 italic ${Math.round(h * 0.62)}px "Titillium Web", Arial, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 4, w - 20);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildRaceMarkings(group, track) {
  const paint = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 });
  const across = (s, a, b, width, mat) => {
    const i0 = track.pointAt(s).idx;
    const m = new THREE.Mesh(stripGeometry(track, i0, Math.max(1, Math.round(width / track.ds)), a, b, 0.03, 4, false), mat);
    m.receiveShadow = true;
    group.add(m);
  };
  const sign = (s, text, bg, fg) => {
    const p = track.pointAt(s, -(track.wallOff + 0.1));
    const g = new THREE.Group();
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.0), new THREE.MeshStandardMaterial({ map: textPlate(text, bg, fg), roughness: 0.5, emissive: 0xffffff, emissiveIntensity: 0.1 }));
    plate.position.y = 4.8;
    g.add(plate);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 5, 0.1), new THREE.MeshStandardMaterial({ color: 0x3a3d42 }));
    post.position.set(0, 2.4, -0.06);
    g.add(post);
    g.position.set(p.x, p.y, p.z);
    g.rotation.y = Math.atan2(-p.tx * Math.cos(0.4) + p.nx * Math.sin(0.4), -p.tz * Math.cos(0.4) + p.nz * Math.sin(0.4));
    group.add(g);
  };
  const white = paint(0xf2f2f2), green = paint(0x16c25a), yellow = paint(0xffd400);
  const hw = track.halfW;
  for (const z of track.drs || []) {
    across(z.detect, -hw, hw, 0.6, white);
    sign(z.detect, 'DRS DETECTION', '#111', '#fff');
    across(z.start, -hw, hw, 0.8, green);
    sign(z.start, 'DRS', '#0f7a36', '#fff');
  }
  const P = track.pit;
  if (P) {
    const laneEdge = P.offset + 2.4;
    // pit-lane separation line
    const sA = P.limitStart, len = (P.limitEnd - P.limitStart + track.length) % track.length;
    const i0 = track.pointAt(sA).idx;
    const line = new THREE.Mesh(stripGeometry(track, i0, Math.round(len / track.ds), laneEdge - 0.15, laneEdge + 0.15, 0.03, 4, false), white);
    group.add(line);
    across(P.limitStart, -track.wallOff, laneEdge, 0.5, yellow);
    across(P.limitEnd, -track.wallOff, laneEdge, 0.5, yellow);
    sign(P.limitStart, 'PIT  80', '#ffd400', '#111');
    // pit box with painted letters
    const b = track.pointAt(P.box, P.offset);
    const box = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 7), new THREE.MeshStandardMaterial({ map: textPlate('PIT', 'rgba(0,0,0,0)', '#ffd400', 256, 512), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }));
    box.rotation.order = 'YXZ';
    box.rotation.y = Math.atan2(b.tx, b.tz) + Math.PI;
    box.rotation.x = -Math.PI / 2;
    box.position.set(b.x, b.y + 0.035, b.z);
    group.add(box);
    const outline = new THREE.Mesh(stripGeometry(track, track.pointAt(P.box - 4).idx, Math.round(8 / track.ds), P.offset - 1.9, P.offset + 1.9, 0.031, 4, false),
      new THREE.MeshBasicMaterial({ color: 0xffd400, transparent: true, opacity: 0.25, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }));
    group.add(outline);
  }
}

// ---------------------------------------------------------------- street signs
function buildSigns(group, track, segments) {
  const steel = new THREE.MeshStandardMaterial({ color: 0x3a3d42, metalness: 0.5, roughness: 0.5 });
  const texCache = new Map();
  const matFor = (name) => {
    if (!texCache.has(name)) texCache.set(name, new THREE.MeshStandardMaterial({ map: TX.streetSignTexture(name), roughness: 0.6, emissive: 0xffffff, emissiveIntensity: 0.12 }));
    return texCache.get(name);
  };
  const wo = track.wallOff;
  let count = 0, lastBanner = -1e9;
  for (const seg of segments) {
    if (seg.len < 60) continue;
    const s0 = track.S[seg.start] + 12;
    const p = track.pointAt(s0);
    const yaw = Math.atan2(-p.tx, -p.tz); // plate faces oncoming cars
    if (s0 - lastBanner > 200 || s0 < lastBanner) {
      // overhead banner across the track
      lastBanner = s0;
      const g = new THREE.Group();
      const span = 2 * wo + 1;
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, 9, 0.35), steel);
        post.position.set(side * span / 2, 3.9, 0);
        post.castShadow = true;
        g.add(post);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(span, 0.4, 0.4), steel);
      beam.position.y = 8.2;
      g.add(beam);
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(10, 2.5), matFor(seg.name));
      plate.position.set(0, 6.9, 0.22);
      g.add(plate);
      const back = new THREE.Mesh(new THREE.PlaneGeometry(10, 2.5), steel);
      back.position.set(0, 6.9, 0.2);
      back.rotation.y = Math.PI;
      g.add(back);
      g.position.set(p.x, p.y, p.z);
      g.rotation.y = yaw;
      group.add(g);
      count++;
    }
    // repeat plates above the fence along long streets
    for (let d = 260; d < seg.len - 60; d += 420) {
      const q = track.pointAt(track.S[seg.start] + d, -(wo + 0.2));
      const g = new THREE.Group();
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.5), matFor(seg.name));
      plate.position.y = 5.2;
      g.add(plate);
      for (const o of [-2.4, 2.4]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 6, 0.12), steel);
        post.position.set(o, 2.4, -0.08);
        g.add(post);
      }
      g.position.set(q.x, q.y, q.z);
      const fx = -q.tx * Math.cos(0.45) + q.nx * Math.sin(0.45), fz = -q.tz * Math.cos(0.45) + q.nz * Math.sin(0.45);
      g.rotation.y = Math.atan2(fx, fz);
      group.add(g);
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------- landmark labels
function buildLabels(group, landmarks, tops, ground) {
  const out = [];
  for (const lm of landmarks) {
    const map = TX.labelTexture(lm.name);
    const mat = new THREE.SpriteMaterial({ map, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false });
    const sp = new THREE.Sprite(mat);
    const h = 0.042;
    sp.scale.set(h * map.userData.aspect, h, 1);
    sp.center.set(0.5, 0);
    const top = tops?.get(lm.id) ?? ground(lm.x, lm.z) + 14;
    sp.position.set(lm.x, top + 6, lm.z);
    sp.renderOrder = 30;
    group.add(sp);
    out.push({ sprite: sp, name: lm.name, x: lm.x, y: top, z: lm.z, lm });
  }
  return out;
}

// ---------------------------------------------------------------- entry point
export async function buildWorld({ track, proj, scenery, ground, city, night, maxAniso, onProgress, lowPoly = false }) {
  const group = new THREE.Group();
  onProgress?.('Costruisco il circuito…', 0.03);
  const landmarks = scenery ? selectLandmarks(scenery.pois, track) : [];
  const streets = scenery ? streetNames(track, scenery.roads) : null;
  const circuit = buildCircuit(group, track, city, night);
  buildRaceMarkings(group, track);
  const signs = streets ? buildSigns(group, track, streets.segments) : 0;
  onProgress?.('Scarico le immagini satellitari…', 0.06);
  await buildGround(group, proj, track, ground, prepFeatures(scenery),
    (f) => onProgress?.('Scarico le immagini satellitari…', 0.06 + 0.66 * f), maxAniso);
  onProgress?.('Ricostruisco edifici e monumenti…', 0.75);
  await new Promise((r) => setTimeout(r, 0));
  const bres = scenery ? buildBuildings(group, scenery, track, ground, circuit.exclusions, landmarks, night) : null;
  const nt = scenery ? buildTrees(group, scenery, track, ground, { lowPoly }) : 0;
  const labels = buildLabels(group, landmarks, bres?.landmarkTops, ground);
  onProgress?.('Pronto!', 1);
  const setNight = (on) => {
    circuit.headsMat.emissive.set(on ? 0xfff2d0 : 0x000000);
    circuit.pools.visible = on;
    bres?.setNight(on);
  };
  return {
    group, lights: circuit.lights, setNight, labels, landmarks, streets, wetMats: circuit.wetMats, marshals: circuit.marshals,
    stats: { buildings: bres ? bres.kept : 0, trees: nt, signs, landmarks: landmarks.length },
  };
}

export function disposeObject(obj) {
  const textures = new Set();
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      for (const k of ['map', 'emissiveMap', 'normalMap', 'alphaMap']) if (m[k]) textures.add(m[k]);
      m.dispose();
    }
  });
  textures.forEach((t) => t.dispose());
}
