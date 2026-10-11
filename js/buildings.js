// OSM buildings → meshes with real roof shapes, colours and materials; landmarks get special treatment.

import * as THREE from 'three';
import { mulberry32, hashString } from './geo.js';
import { ringArea, centroid } from './scenery.js';
import * as TX from './textures.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const FACADES = ['#e9dcc3', '#dcc7a1', '#cfa47c', '#c27b54', '#efe7d9', '#d1d1cc', '#d8b98a', '#b8b2a7', '#e6cfae', '#c99a6b', '#a7a39b', '#e3d5b8'];
const ROOF_TILES = ['#a24f33', '#9d5a3c', '#8f4a33', '#b0603f', '#7f4a36'];
const ROOF_FLAT = ['#6b6b6b', '#5d5f63', '#7d7469', '#8a8a86'];
const MATERIALS = {
  brick: '#9c5a3c', stone: '#c9bba0', concrete: '#b5b3ab', glass: '#7f99ad', wood: '#9a7653',
  metal: '#9aa0a6', marble: '#e8e4dc', sandstone: '#d2b48c', limestone: '#ddd3bd', plaster: null, cement_block: '#b3b0a8',
};
const CHURCH = new Set(['church', 'cathedral', 'chapel', 'basilica', 'mosque', 'synagogue', 'temple', 'shrine']);
const PLAIN_UV = [0.01, 0.995];

const tmpColor = new THREE.Color();
function parseColour(str) {
  if (!str) return null;
  const s = String(str).trim().toLowerCase().replace(/_/g, '');
  try {
    tmpColor.setStyle(/^[0-9a-f]{6}$/.test(s) ? '#' + s : s);
    return tmpColor.clone();
  } catch { return null; }
}
const num = (v) => { const f = parseFloat(v); return Number.isFinite(f) ? f : null; };

class Buf {
  constructor() { this.p = []; this.n = []; this.u = []; this.c = []; }
  tri(a, b, c, col, uva, uvb, uvc) {
    // flat normal
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    this.p.push(...a, ...b, ...c);
    this.n.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.c.push(col.r, col.g, col.b, col.r, col.g, col.b, col.r, col.g, col.b);
    this.u.push(...(uva || PLAIN_UV), ...(uvb || PLAIN_UV), ...(uvc || PLAIN_UV));
  }
  // triangle forced to face upwards (roofs)
  triUp(a, b, c, col, uvf) {
    const cy = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    if (cy < 0) [b, c] = [c, b];
    this.tri(a, b, c, col, uvf(a), uvf(b), uvf(c));
  }
  mesh(mat) {
    if (!this.p.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }
}

// minimum-area oriented bounding box
function obb(ring) {
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    let ux = b[0] - a[0], uz = b[1] - a[1];
    const l = Math.hypot(ux, uz);
    if (l < 0.5) continue;
    ux /= l; uz /= l;
    const vx = -uz, vz = ux;
    let mnu = Infinity, mxu = -Infinity, mnv = Infinity, mxv = -Infinity;
    for (const p of ring) {
      const pu = p[0] * ux + p[1] * uz, pv = p[0] * vx + p[1] * vz;
      mnu = Math.min(mnu, pu); mxu = Math.max(mxu, pu); mnv = Math.min(mnv, pv); mxv = Math.max(mxv, pv);
    }
    const area = (mxu - mnu) * (mxv - mnv);
    if (!best || area < best.area) {
      const cu = (mnu + mxu) / 2, cv = (mnv + mxv) / 2;
      best = { area, ux, uz, vx, vz, cx: cu * ux + cv * vx, cz: cu * uz + cv * vz, du: mxu - mnu, dv: mxv - mnv };
    }
  }
  if (!best) return null;
  // long axis = u
  if (best.dv > best.du) best = { ...best, ux: best.vx, uz: best.vz, du: best.dv, dv: best.du };
  best.rect = Math.abs(ringArea(ring)) / best.area;
  return best;
}

function isConvexish(ring) {
  let pos = 0, neg = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], c = ring[(i + 2) % ring.length];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (cr > 1e-6) pos++; else if (cr < -1e-6) neg++;
  }
  return pos === 0 || neg === 0;
}

// walls of a ring between y0 and y1
function addWalls(buf, ring, y0, y1, col, uvScale = true) {
  const area = ringArea(ring);
  let perim = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k], b = ring[(k + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.05) continue;
    const u0 = perim / 28.8, u1 = (perim + len) / 28.8, v0 = 0, v1 = (y1 - y0) / 26.4;
    perim += len;
    const A = [a[0], y0, a[1]], B = [b[0], y0, b[1]], C = [b[0], y1, b[1]], D = [a[0], y1, a[1]];
    const uv = uvScale ? [[u0, v0], [u1, v0], [u1, v1], [u0, v1]] : [PLAIN_UV, PLAIN_UV, PLAIN_UV, PLAIN_UV];
    // outward for CCW (area>0) is (dz,-dx); the order A,B,C gives (-dz,dx)
    if (area > 0) { buf.tri(A, C, B, col, uv[0], uv[2], uv[1]); buf.tri(A, D, C, col, uv[0], uv[3], uv[2]); }
    else { buf.tri(A, B, C, col, uv[0], uv[1], uv[2]); buf.tri(A, C, D, col, uv[0], uv[2], uv[3]); }
  }
}

const roofUV = (p) => [p[0] / 6, p[2] / 6];

function addRoof(roofBuf, wallBuf, ring, eave, shape, rh, roofCol, wallCol) {
  const flat = () => {
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(ring.map(([x, z]) => new THREE.Vector2(x, z)), []); } catch { tris = []; }
    for (const t of tris) roofBuf.triUp([ring[t[0]][0], eave, ring[t[0]][1]], [ring[t[1]][0], eave, ring[t[1]][1]], [ring[t[2]][0], eave, ring[t[2]][1]], roofCol, roofUV);
  };
  if (shape === 'flat' || rh < 0.3) return flat();
  if (shape === 'pyramidal' || shape === 'hipped_pyramid') {
    if (!isConvexish(ring)) return flat();
    const [cx, cz] = centroid(ring);
    const apex = [cx, eave + rh, cz];
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length];
      roofBuf.triUp([a[0], eave, a[1]], [b[0], eave, b[1]], apex, roofCol, roofUV);
    }
    return;
  }
  if (shape === 'dome' || shape === 'onion') {
    if (!isConvexish(ring)) return flat();
    const [cx, cz] = centroid(ring);
    const L = 7;
    let prev = ring.map((p) => [p[0], eave, p[1]]);
    for (let l = 1; l <= L; l++) {
      const th = (l / L) * (Math.PI / 2);
      const sc = Math.cos(th), y = eave + rh * Math.sin(th);
      const cur = ring.map((p) => [cx + (p[0] - cx) * sc, y, cz + (p[1] - cz) * sc]);
      for (let k = 0; k < ring.length; k++) {
        const k2 = (k + 1) % ring.length;
        roofBuf.triUp(prev[k], prev[k2], cur[k2], roofCol, roofUV);
        if (l < L) roofBuf.triUp(prev[k], cur[k2], cur[k], roofCol, roofUV);
      }
      prev = cur;
    }
    return;
  }
  // gabled / hipped on the oriented box
  const o = obb(ring);
  if (!o || o.rect < 0.8 || o.dv < 3) return flat();
  const { cx, cz, ux, uz, du, dv } = o;
  const vx = -uz, vz = ux;
  const P = (su, sv, y) => [cx + ux * su + vx * sv, y, cz + uz * su + vz * sv];
  const hu = du / 2, hv = dv / 2;
  const c1 = P(-hu, -hv, eave), c2 = P(hu, -hv, eave), c3 = P(hu, hv, eave), c4 = P(-hu, hv, eave);
  if (shape === 'hipped' && du - dv > 0.5) {
    const r1 = P(-(hu - hv), 0, eave + rh), r2 = P(hu - hv, 0, eave + rh);
    roofBuf.triUp(c1, c2, r2, roofCol, roofUV); roofBuf.triUp(c1, r2, r1, roofCol, roofUV);
    roofBuf.triUp(c3, c4, r1, roofCol, roofUV); roofBuf.triUp(c3, r1, r2, roofCol, roofUV);
    roofBuf.triUp(c2, c3, r2, roofCol, roofUV); roofBuf.triUp(c4, c1, r1, roofCol, roofUV);
  } else if (shape === 'hipped') {
    const apex = P(0, 0, eave + rh);
    for (const [a, b] of [[c1, c2], [c2, c3], [c3, c4], [c4, c1]]) roofBuf.triUp(a, b, apex, roofCol, roofUV);
  } else {
    const r1 = P(-hu, 0, eave + rh), r2 = P(hu, 0, eave + rh);
    roofBuf.triUp(c1, c2, r2, roofCol, roofUV); roofBuf.triUp(c1, r2, r1, roofCol, roofUV);
    roofBuf.triUp(c3, c4, r1, roofCol, roofUV); roofBuf.triUp(c3, r1, r2, roofCol, roofUV);
    // gable ends (wall-coloured, both windings so they show from outside)
    wallBuf.tri(c4, c1, r1, wallCol); wallBuf.tri(c1, c4, r1, wallCol);
    wallBuf.tri(c2, c3, r2, wallCol); wallBuf.tri(c3, c2, r2, wallCol);
  }
}

function heightOf(tags, area, r, levelsDefault) {
  let h = num(tags.height);
  if (h === null && num(tags['building:levels']) !== null) h = num(tags['building:levels']) * 3.2 + 1;
  if (h !== null) return { h: Math.min(h, 400), given: true };
  switch (tags.building) {
    case 'house': case 'detached': case 'semidetached_house': case 'bungalow': case 'terrace': return { h: 6.5 + r * 3, given: false };
    case 'garage': case 'garages': case 'shed': case 'hut': case 'carport': case 'kiosk': return { h: 3 + r, given: false };
    case 'church': case 'cathedral': case 'chapel': case 'basilica': return { h: 15 + r * 8, given: false };
    case 'industrial': case 'warehouse': case 'retail': case 'supermarket': case 'commercial': return { h: 8 + r * 5, given: false };
  }
  if (area < 60) return { h: 4 + r * 3, given: false };
  if (area < 200) return { h: 9 + r * 6, given: false };
  return { h: levelsDefault + r * 10, given: false };
}

export function buildBuildings(group, sc, track, ground, exclusions, landmarks, night) {
  const facade = TX.facadeTextures();
  const glassTx = TX.glassTextures();
  const wallMat = new THREE.MeshStandardMaterial({ map: facade.map, vertexColors: true, roughness: 0.85 });
  const glassMat = new THREE.MeshStandardMaterial({ map: glassTx.map, vertexColors: true, roughness: 0.35, metalness: 0.1 });
  const roofMat = new THREE.MeshStandardMaterial({ map: TX.roofTexture(), vertexColors: true, roughness: 0.9 });
  const clearance = track.wallOff + 3.2;
  const landmarkWays = new Set(landmarks.map((l) => l.wayId).filter(Boolean));
  const landmarkRings = landmarks.filter((l) => l.ring).map((l) => {
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const [x, z] of l.ring) { a = Math.min(a, x); b = Math.max(b, x); c = Math.min(c, z); d = Math.max(d, z); }
    return { l, minX: a, maxX: b, minZ: c, maxZ: d };
  });

  // items = buildings + parts
  const items = [];
  const push = (b, isPart) => {
    const ring = b.ring;
    if (ring.length < 3) return;
    if (!isPart && (b.tags.building === 'roof' || b.tags.building === 'construction' || b.tags.location === 'underground')) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of ring) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    items.push({ ...b, isPart, minX, maxX, minZ, maxZ, removed: false, hasParts: false });
  };
  sc.buildings.forEach((b) => push(b, false));
  sc.parts.forEach((b) => push(b, true));

  const CELL = 60;
  const grid = new Map();
  const cellsOf = (it, f) => {
    for (let cx = Math.floor(it.minX / CELL); cx <= Math.floor(it.maxX / CELL); cx++)
      for (let cz = Math.floor(it.minZ / CELL); cz <= Math.floor(it.maxZ / CELL); cz++) f(cx * 100003 + cz);
  };
  items.forEach((it, k) => cellsOf(it, (key) => { if (!grid.has(key)) grid.set(key, []); grid.get(key).push(k); }));
  const at = (x, z) => grid.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL)) || [];
  const inside = (x, z, ring) => {
    let ins = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) ins = !ins;
    }
    return ins;
  };

  // outlines that contain parts are replaced by their parts
  for (const it of items) {
    if (!it.isPart) continue;
    const [cx, cz] = centroid(it.ring);
    for (const k of at(cx, cz)) {
      const o = items[k];
      if (!o.isPart && cx >= o.minX && cx <= o.maxX && cz >= o.minZ && cz <= o.maxZ && inside(cx, cz, o.ring)) { o.hasParts = true; it.parent = o; }
    }
  }
  // track passes through → remove
  for (let i = 0; i < track.n; i += 2) {
    for (const off of [-track.wallOff, 0, track.wallOff]) {
      const x = track.P[2 * i] + track.N[2 * i] * off, z = track.P[2 * i + 1] + track.N[2 * i + 1] * off;
      for (const k of at(x, z)) {
        const it = items[k];
        if (!it.removed && x >= it.minX && x <= it.maxX && z >= it.minZ && z <= it.maxZ && inside(x, z, it.ring)) it.removed = true;
      }
    }
  }
  for (const [x, z] of exclusions) {
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const k of grid.get((Math.floor(x / CELL) + dx) * 100003 + Math.floor(z / CELL) + dz) || []) {
        const it = items[k];
        if (x > it.minX - 8 && x < it.maxX + 8 && z > it.minZ - 8 && z < it.maxZ + 8) it.removed = true;
      }
    }
  }

  const chunks = new Map();
  const chunk = (x, z) => {
    const key = `${Math.floor(x / 300)},${Math.floor(z / 300)}`;
    if (!chunks.has(key)) chunks.set(key, { walls: new Buf(), glass: new Buf(), roofs: new Buf() });
    return chunks.get(key);
  };
  const towerPois = [];
  let kept = 0;
  const landmarkTops = new Map(); // landmark id -> top y
  const isLandmarkRing = (cx, cz) => {
    const f = landmarkRings.find((o) => cx >= o.minX && cx <= o.maxX && cz >= o.minZ && cz <= o.maxZ && inside(cx, cz, o.l.ring));
    return f ? f.l : null;
  };

  // an outline too close to the track takes all its parts with it
  const clearOf = (ring) => {
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(len / 3));
      for (let s = 0; s <= steps; s++) {
        const x = a[0] + ((b[0] - a[0]) * s) / steps, z = a[1] + ((b[1] - a[1]) * s) / steps;
        if (track.distToCenter(x, z, clearance + 2) < clearance) return false;
      }
    }
    return true;
  };
  for (const it of items) if (!it.isPart && it.hasParts && (it.removed || !clearOf(it.ring))) it.removed = true;
  for (const it of items) if (it.isPart && it.parent && it.parent.removed) it.removed = true;

  for (const it of items) {
    if (it.removed || it.hasParts) continue;
    const ring = it.ring;
    let tooClose = false;
    for (let k = 0; k < ring.length && !tooClose; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(len / 3));
      for (let s = 0; s <= steps; s++) {
        const x = a[0] + ((b[0] - a[0]) * s) / steps, z = a[1] + ((b[1] - a[1]) * s) / steps;
        if (track.distToCenter(x, z, clearance + 2) < clearance) { tooClose = true; break; }
      }
    }
    if (tooClose) continue;
    kept++;
    const t = it.tags;
    const area = Math.abs(ringArea(ring));
    const r = mulberry32(it.id)();
    const hs = hashString(String(it.id));
    const [cx, cz] = centroid(ring);
    const lm = (landmarkWays.has(it.id) ? landmarks.find((l) => l.wayId === it.id) : null) || isLandmarkRing(cx, cz);
    const church = CHURCH.has(t.building) || t.amenity === 'place_of_worship';

    // base on the terrain
    let gmin = Infinity;
    for (const [x, z] of ring) gmin = Math.min(gmin, ground(x, z));
    let minH = num(t.min_height) ?? (num(t['building:min_level']) !== null ? num(t['building:min_level']) * 3.2 : 0);
    if (it.isPart && !it.parent && minH > 0) minH = 0;
    const { h, given } = heightOf(t, area, r, it.isPart ? 10 : 13);

    // roof
    let shape = (t['roof:shape'] || '').toLowerCase();
    let rh = num(t['roof:height']);
    if (!shape) {
      if (church) shape = 'gabled';
      else if (area < 450 && h < 18 && !it.isPart) shape = r < 0.6 ? 'hipped' : 'gabled';
      else shape = 'flat';
    }
    if (shape === 'skillion' || shape === 'half-hipped' || shape === 'gambrel' || shape === 'mansard' || shape === 'round' || shape === 'saltbox') shape = shape === 'round' ? 'gabled' : 'hipped';
    if (rh === null) {
      const o = shape === 'dome' || shape === 'onion' ? null : obb(ring);
      const w = o ? o.dv : Math.sqrt(area);
      rh = shape === 'flat' ? 0 : shape === 'dome' || shape === 'onion' ? Math.min(Math.sqrt(area) * 0.5, 25) : Math.min(w * (church ? 0.38 : 0.3), church ? 10 : 4);
    }
    const eave = given && shape !== 'flat' ? Math.max(minH + 2, h - rh) : h;

    // colours
    const material = (t['building:material'] || '').toLowerCase();
    let wallCol = parseColour(t['building:colour']) || (MATERIALS[material] ? new THREE.Color(MATERIALS[material]) : null);
    if (!wallCol) wallCol = new THREE.Color(lm || church ? (r < 0.5 ? '#e4dccb' : '#cdbb9c') : FACADES[hs % FACADES.length]);
    let roofCol = parseColour(t['roof:colour']);
    if (!roofCol) {
      if (shape === 'dome' || shape === 'onion') roofCol = new THREE.Color(r < 0.5 ? '#8a9a8f' : '#b88a5a');
      else roofCol = new THREE.Color(shape === 'flat' ? ROOF_FLAT[hs % ROOF_FLAT.length] : ROOF_TILES[hs % ROOF_TILES.length]);
    }
    const historic = t.historic || t.heritage || t.wikidata || it.isPart || ['bell_tower', 'tower', 'campanile'].includes(t.building) || t.man_made;
    const glass = material === 'glass' || (h > 40 && area > 250 && !lm && !church && !historic);
    if (glass && !t['building:colour']) wallCol = new THREE.Color(r < 0.5 ? '#9fb6c8' : '#b9c4cc');

    const ch = chunk(cx, cz);
    const base = gmin + minH;
    const wallBottom = minH > 0 ? base : gmin - 1.2;
    addWalls(glass ? ch.glass : ch.walls, ring, wallBottom, gmin + eave, wallCol);
    addRoof(ch.roofs, ch.walls, ring, gmin + eave, shape, rh, roofCol, wallCol);
    const top = gmin + eave + rh;
    if (lm) landmarkTops.set(lm.id, Math.max(landmarkTops.get(lm.id) || 0, top));

    // bell tower for churches without a mapped one
    if (church && !it.isPart && area > 250 && area < 6000) {
      const o = obb(ring);
      const hasTower = sc.pois.some((p) => ['tower', 'campanile'].includes(p.tags.man_made) && Math.hypot(p.x - cx, p.z - cz) < 80);
      if (o && !hasTower) {
        const vx = -o.uz, vz = o.ux;
        const tx = o.cx + o.ux * (o.du / 2 - 3) + vx * (o.dv / 2 + 3.2), tz = o.cz + o.uz * (o.du / 2 - 3) + vz * (o.dv / 2 + 3.2);
        towerPois.push({ x: tx, z: tz, h: Math.max(eave * 1.9, 26), size: 5.5, ux: o.ux, uz: o.uz, col: wallCol, lmId: lm ? lm.id : null });
      }
    }
  }

  // mapped towers/campanili given as nodes
  for (const p of sc.pois) {
    if (p.ring || !['tower', 'campanile', 'obelisk'].includes(p.tags.man_made)) continue;
    if (track.distToCenter(p.x, p.z, clearance + 4) < clearance + 3) continue;
    const obel = p.tags.man_made === 'obelisk';
    towerPois.push({ x: p.x, z: p.z, h: num(p.tags.height) || (obel ? 18 : 34), size: obel ? 2.2 : 6, ux: 1, uz: 0, col: new THREE.Color(p.tags.man_made === 'campanile' ? '#b0705a' : '#cdbfa5'), lmId: p.id });
  }
  for (const tw of towerPois) {
    const s = tw.size / 2, vx = -tw.uz, vz = tw.ux;
    const ring = [[-s, -s], [s, -s], [s, s], [-s, s]].map(([a, b]) => [tw.x + tw.ux * a + vx * b, tw.z + tw.uz * a + vz * b]);
    let gmin = Infinity;
    for (const [x, z] of ring) gmin = Math.min(gmin, ground(x, z));
    const ch = chunk(tw.x, tw.z);
    addWalls(ch.walls, ring, gmin - 1, gmin + tw.h, tw.col);
    addRoof(ch.roofs, ch.walls, ring, gmin + tw.h, 'pyramidal', tw.size * 0.9, new THREE.Color('#8f4a33'), tw.col);
    if (tw.lmId) landmarkTops.set(tw.lmId, Math.max(landmarkTops.get(tw.lmId) || 0, gmin + tw.h + tw.size));
  }

  for (const ch of chunks.values()) {
    for (const [buf, mat] of [[ch.walls, wallMat], [ch.glass, glassMat], [ch.roofs, roofMat]]) {
      const m = buf.mesh(mat);
      if (m) group.add(m);
    }
  }

  const setNight = (on) => {
    for (const [m, tx] of [[wallMat, facade], [glassMat, glassTx]]) {
      m.emissiveMap = on ? tx.emissive : null;
      m.emissive.set(on ? 0xffffff : 0x000000);
      m.emissiveIntensity = on ? 1.1 : 0;
      m.needsUpdate = true;
    }
  };
  setNight(night);
  return { kept, setNight, landmarkTops };
}

export function buildTrees(group, sc, track, ground) {
  const pts = [];
  const clear = track.wallOff + 2;
  const add = (x, z, seed) => {
    if (track.distToCenter(x, z, clear + 2) < clear) return;
    pts.push([x, z, mulberry32(seed)()]);
  };
  sc.trees.forEach(([x, z], k) => { if (pts.length < 5000) add(x, z, k + 1); });
  // scatter trees inside parks & woods near the track
  const rnd = mulberry32(77);
  for (const a of sc.areas) {
    if (a.kind !== 'park' && a.kind !== 'wood') continue;
    const area = Math.abs(ringArea(a.ring));
    if (area < 300) continue;
    const [cx, cz] = centroid(a.ring);
    if (track.distToCenter(cx, cz, 400) > 350) continue;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of a.ring) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    const want = Math.min(400, area / (a.kind === 'wood' ? 90 : 260));
    for (let k = 0, tries = 0; k < want && tries < want * 4 && pts.length < 9000; tries++) {
      const x = minX + rnd() * (maxX - minX), z = minZ + rnd() * (maxZ - minZ);
      let ins = false;
      const ring = a.ring;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) ins = !ins;
      }
      if (!ins) continue;
      add(x, z, tries * 7919 + k);
      k++;
    }
  }
  if (!pts.length) return 0;
  // clustered crown: three blobs merged into one geometry
  const blobs = [[0, 0, 0, 1], [0.55, -0.15, 0.2, 0.7], [-0.45, -0.1, -0.35, 0.75], [0.1, 0.45, -0.1, 0.65]].map(([x, y, z, r]) => {
    const g = new THREE.IcosahedronGeometry(r, 1);
    g.translate(x, y, z);
    return g;
  });
  const crownGeo = mergeGeometries(blobs);
  const trunkGeo = new THREE.CylinderGeometry(0.15, 0.22, 1, 5);
  trunkGeo.translate(0, 0.5, 0);
  const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: 0x4d7a3a, roughness: 0.95, flatShading: true }), pts.length);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5a4330, roughness: 1 }), pts.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
  pts.forEach(([x, z, r], k) => {
    const y = ground(x, z);
    const s = 2.2 + r * 2.5, th = 2.5 + r * 2;
    m4.compose(new THREE.Vector3(x, y + th + s * 0.75, z), q, new THREE.Vector3(s, s * 1.15, s));
    crowns.setMatrixAt(k, m4);
    c.setHSL(0.25 + r * 0.08, 0.38, 0.28 + r * 0.1);
    crowns.setColorAt(k, c);
    m4.compose(new THREE.Vector3(x, y - 0.3, z), q, new THREE.Vector3(1, th + s * 0.4, 1));
    trunks.setMatrixAt(k, m4);
  });
  crowns.castShadow = true; trunks.castShadow = true;
  group.add(crowns, trunks);
  return pts.length;
}
