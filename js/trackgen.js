// Street-circuit generator: turns the OSM road network into closed racing loops.
// Pure maths, no Three.js — also runs under Node for testing.

import { mulberry32 } from './geo.js';

export const TRACK_WIDTH = 12;
export const WALL_GAP = 1.5;
const MIN_RADIUS = 13;          // minimum centreline corner radius after smoothing (m)
const MIN_SEPARATION = 22;      // two distant parts of the track must stay this far apart (m)
const PARALLEL_DIST = 60;       // closer than this counts as "running alongside itself"

// Relative cost of driving on each road class: lower = preferred.
const CLASS_COST = {
  trunk: 1.0, primary: 1.0, secondary: 1.15, tertiary: 1.5,
  trunk_link: 2.2, primary_link: 2.2, secondary_link: 2.4, tertiary_link: 2.6,
  unclassified: 3.0, residential: 4.5,
};
const MINOR = new Set(['unclassified', 'residential', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ---------------------------------------------------------------- graph
export function buildGraph(osm, proj) {
  const ways = osm.elements.filter((e) => e.type === 'way' && e.nodes && e.geometry && e.nodes.length >= 2);
  const count = new Map();
  for (const w of ways) {
    const n = w.nodes;
    for (let k = 0; k < n.length; k++) {
      const add = k === 0 || k === n.length - 1 ? 2 : 1;
      count.set(n[k], (count.get(n[k]) || 0) + add);
    }
  }
  const nodeIndex = new Map();
  const nodes = [];
  const edges = [];
  const getNode = (id, x, z) => {
    let i = nodeIndex.get(id);
    if (i === undefined) {
      i = nodes.length;
      nodeIndex.set(id, i);
      nodes.push({ id, x, z, adj: [] });
    }
    return i;
  };

  for (const w of ways) {
    const tags = w.tags || {};
    const cls = tags.highway;
    let cf = CLASS_COST[cls] ?? 5;
    const width = parseFloat(tags.width);
    if (width >= 12) cf *= 0.85;
    else if (width > 0 && width < 6) cf *= 1.6;
    const lanes = parseInt(tags.lanes, 10);
    if (lanes >= 3 || (lanes >= 2 && tags.oneway === 'yes')) cf *= 0.88;
    if (lanes === 1 && tags.oneway !== 'yes') cf *= 1.5;
    if (tags.junction === 'roundabout' || tags.junction === 'circular') cf *= 1.4;

    let seg = null;
    let startNode = -1;
    for (let k = 0; k < w.nodes.length; k++) {
      const g = w.geometry[k];
      if (!g) { seg = null; continue; }
      const [x, z] = proj.toXZ(g.lat, g.lon);
      if (seg === null) {
        seg = [[x, z]];
        startNode = getNode(w.nodes[k], x, z);
        continue;
      }
      seg.push([x, z]);
      const isLast = k === w.nodes.length - 1 || !w.geometry[k + 1];
      if (count.get(w.nodes[k]) >= 2 || isLast) {
        const endNode = getNode(w.nodes[k], x, z);
        if (endNode !== startNode) {
          let len = 0;
          for (let q = 1; q < seg.length; q++) len += dist(seg[q - 1], seg[q]);
          const ei = edges.length;
          edges.push({ a: startNode, b: endNode, pts: seg, len, cf, cls, name: tags.name || '' });
          nodes[startNode].adj.push(ei);
          nodes[endNode].adj.push(ei);
        }
        seg = [[x, z]];
        startNode = endNode;
      }
    }
  }

  // largest connected component
  const comp = new Int32Array(nodes.length).fill(-1);
  let best = -1, bestSize = 0, c = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (comp[i] !== -1) continue;
    const stack = [i];
    comp[i] = c;
    let size = 0;
    while (stack.length) {
      const u = stack.pop();
      size++;
      for (const ei of nodes[u].adj) {
        const e = edges[ei];
        const v = e.a === u ? e.b : e.a;
        if (comp[v] === -1) { comp[v] = c; stack.push(v); }
      }
    }
    if (size > bestSize) { bestSize = size; best = c; }
    c++;
  }
  for (let i = 0; i < nodes.length; i++) nodes[i].main = comp[i] === best;
  return { nodes, edges };
}

// ---------------------------------------------------------------- shortest paths
class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p];
      i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const topK = k[0], topV = v[0];
    const lk = k.pop(), lv = v.pop();
    const n = k.length;
    if (n > 0) {
      let i = 0;
      while (true) {
        let l = 2 * i + 1;
        if (l >= n) break;
        if (l + 1 < n && k[l + 1] < k[l]) l++;
        if (k[l] >= lk) break;
        k[i] = k[l]; v[i] = v[l];
        i = l;
      }
      k[i] = lk; v[i] = lv;
    }
    this.lastKey = topK;
    return topV;
  }
}

function dijkstra(G, src, dst, forbidNode, forbidEdge, edgeCost) {
  const N = G.nodes.length;
  if (!G._dist || G._dist.length !== N) { G._dist = new Float64Array(N); G._prev = new Int32Array(N); }
  const D = G._dist, prev = G._prev;
  D.fill(Infinity); prev.fill(-1);
  D[src] = 0;
  const h = new MinHeap();
  h.push(0, src);
  while (h.size) {
    const u = h.pop();
    const d = h.lastKey;
    if (d > D[u]) continue;
    if (u === dst) break;
    for (const ei of G.nodes[u].adj) {
      if (forbidEdge[ei]) continue;
      const e = G.edges[ei];
      const v = e.a === u ? e.b : e.a;
      if (forbidNode[v] && v !== dst) continue;
      const nd = d + edgeCost(ei);
      if (nd < D[v]) { D[v] = nd; prev[v] = ei; h.push(nd, v); }
    }
  }
  if (D[dst] === Infinity) return null;
  const seq = [];
  const nodesOut = [dst];
  let cur = dst;
  while (cur !== src) {
    const ei = prev[cur];
    seq.push(ei);
    const e = G.edges[ei];
    cur = e.a === cur ? e.b : e.a;
    nodesOut.push(cur);
  }
  seq.reverse(); nodesOut.reverse();
  return { edges: seq, nodes: nodesOut };
}

// ---------------------------------------------------------------- polyline utils (closed loops)
export function resampleClosed(p, step) {
  const n = p.length;
  const cum = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) cum[i] = cum[i - 1] + dist(p[i - 1], p[i % n]);
  const total = cum[n];
  const m = Math.max(8, Math.round(total / step));
  const ds = total / m;
  const out = [];
  let j = 0;
  for (let k = 0; k < m; k++) {
    const s = k * ds;
    while (j < n - 1 && cum[j + 1] < s) j++;
    const segLen = cum[j + 1] - cum[j] || 1;
    const t = (s - cum[j]) / segLen;
    const a = p[j], b = p[(j + 1) % n];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

function smoothClosed(p, iters, alpha) {
  const n = p.length;
  for (let it = 0; it < iters; it++) {
    const q = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n];
      q[i] = [b[0] + alpha * ((a[0] + c[0]) / 2 - b[0]), b[1] + alpha * ((a[1] + c[1]) / 2 - b[1])];
    }
    p = q;
  }
  return p;
}

function circumRadiusSigned(a, b, c) {
  const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(cross) < 1e-9) return Infinity;
  return (dist(a, b) * dist(b, c) * dist(c, a)) / (2 * cross);
}

function enforceMinRadius(p, rmin, maxIter = 900) {
  const k = 3;
  for (let it = 0; it < maxIter; it++) {
    const n = p.length;
    const bad = new Uint8Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
      const r = Math.abs(circumRadiusSigned(p[(i - k + n) % n], p[i], p[(i + k) % n]));
      if (r < rmin) {
        any = true;
        for (let j = -k - 1; j <= k + 1; j++) bad[(i + j + n) % n] = 1;
      }
    }
    if (!any) break;
    const q = p.map((a) => a.slice());
    for (let i = 0; i < n; i++) {
      if (!bad[i]) continue;
      const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n];
      q[i] = [b[0] + 0.6 * ((a[0] + c[0]) / 2 - b[0]), b[1] + 0.6 * ((a[1] + c[1]) / 2 - b[1])];
    }
    p = q;
    if (it % 25 === 24) p = resampleClosed(p, 3);
  }
  return p;
}

export function makeCenterline(raw) {
  const p0 = [];
  for (const pt of raw) if (!p0.length || dist(p0[p0.length - 1], pt) > 0.5) p0.push(pt);
  if (p0.length > 2 && dist(p0[0], p0[p0.length - 1]) < 0.5) p0.pop();
  let p = resampleClosed(p0, 3);
  p = smoothClosed(p, 6, 0.5);
  p = enforceMinRadius(p, MIN_RADIUS);
  p = resampleClosed(p, 2);
  p = smoothClosed(p, 4, 0.5);
  return resampleClosed(p, 2);
}

// ---------------------------------------------------------------- analysis
export function analyzeCenterline(p) {
  const n = p.length;
  let length = 0;
  for (let i = 0; i < n; i++) length += dist(p[i], p[(i + 1) % n]);
  const ds = length / n;
  const k = 3;
  const kappa = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = circumRadiusSigned(p[(i - k + n) % n], p[i], p[(i + k) % n]);
    kappa[i] = Number.isFinite(r) ? 1 / r : 0;
  }
  // light smoothing of curvature
  const ks = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = -3; j <= 3; j++) s += kappa[(i + j + n) % n];
    ks[i] = s / 7;
  }

  // corners: runs of |kappa| > 1/120, total turning > 25°
  const corners = [];
  const isCurve = (i) => Math.abs(ks[i]) > 1 / 120;
  let startI = 0;
  while (startI < n && isCurve(startI)) startI++;
  if (startI === n) startI = 0;
  let run = null;
  for (let q = 0; q <= n; q++) {
    const i = (startI + q) % n;
    const curve = q < n && isCurve(i);
    if (curve && (!run || Math.sign(ks[i]) === run.sign)) {
      if (!run) run = { start: i, sign: Math.sign(ks[i]), angle: 0, len: 0, maxK: 0 };
      run.angle += ks[i] * ds; run.len += ds; run.maxK = Math.max(run.maxK, Math.abs(ks[i]));
    } else {
      if (run && Math.abs(run.angle) > (25 * Math.PI) / 180) corners.push(run);
      run = curve ? { start: i, sign: Math.sign(ks[i]), angle: ks[i] * ds, len: ds, maxK: Math.abs(ks[i]) } : null;
    }
  }
  // straights: runs of |kappa| < 1/350
  let longest = 0, longestStart = 0, cur = 0, curStart = 0;
  for (let q = 0; q < 2 * n; q++) {
    const i = q % n;
    if (Math.abs(ks[i]) < 1 / 350) {
      if (cur === 0) curStart = i;
      cur += ds;
      if (cur > longest && cur <= length) { longest = cur; longestStart = curStart; }
    } else cur = 0;
  }
  // self-proximity: minimum separation + share of track running alongside another part of itself
  const cell = PARALLEL_DIST;
  const grid = new Map();
  const key = (cx, cz) => cx * 73856093 ^ cz * 19349663;
  for (let i = 0; i < n; i++) {
    const kk = key(Math.floor(p[i][0] / cell), Math.floor(p[i][1] / cell));
    let arr = grid.get(kk);
    if (!arr) grid.set(kk, (arr = []));
    arr.push(i);
  }
  let minSep = Infinity, parallelCount = 0, tested = 0;
  const skip = Math.ceil(90 / ds);
  for (let i = 0; i < n; i += 2) {
    const cx = Math.floor(p[i][0] / cell), cz = Math.floor(p[i][1] / cell);
    let localMin = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const arr = grid.get(key(cx + dx, cz + dz));
      if (!arr) continue;
      for (const j of arr) {
        let d = Math.abs(i - j);
        d = Math.min(d, n - d);
        if (d < skip) continue;
        const dd = dist(p[i], p[j]);
        if (dd < localMin) localMin = dd;
      }
    }
    tested++;
    if (localMin < PARALLEL_DIST) parallelCount++;
    if (localMin < minSep) minSep = localMin;
  }
  return {
    length, ds, kappa: ks, corners,
    hairpins: corners.filter((c) => Math.abs(c.angle) > (130 * Math.PI) / 180).length,
    longestStraight: longest, longestStart, minSep,
    parallelShare: parallelCount / Math.max(1, tested),
  };
}

// ---------------------------------------------------------------- loop search
function edgesToPolyline(G, seq, startNode) {
  const out = [];
  let cur = startNode;
  for (const ei of seq) {
    const e = G.edges[ei];
    const p = e.a === cur ? e.pts : e.pts.slice().reverse();
    for (let k = 0; k < p.length - 1; k++) out.push(p[k]);
    cur = e.a === cur ? e.b : e.a;
  }
  return out;
}

function pickNear(nodes, pool, from, dmin, dmax, rnd, tries = 60) {
  for (let t = 0; t < tries; t++) {
    const j = pool[Math.floor(rnd() * pool.length)];
    const d = Math.hypot(nodes[j].x - from.x, nodes[j].z - from.z);
    if (d >= dmin && d <= dmax) return j;
  }
  return -1;
}

function tryLoop(G, pool, target, rnd) {
  const { nodes, edges } = G;
  const nWp = rnd() < 0.45 ? 2 : 3;
  const A = pool[Math.floor(rnd() * pool.length)];
  const wps = [A];
  if (nWp === 2) {
    const B = pickNear(nodes, pool, nodes[A], 0.25 * target, 0.38 * target, rnd);
    if (B < 0) return null;
    wps.push(B);
  } else {
    const B = pickNear(nodes, pool, nodes[A], 0.19 * target, 0.29 * target, rnd);
    if (B < 0) return null;
    let C = -1;
    for (let t = 0; t < 60 && C < 0; t++) {
      const j = pickNear(nodes, pool, nodes[A], 0.19 * target, 0.29 * target, rnd, 1);
      if (j < 0 || j === B) continue;
      const d = Math.hypot(nodes[j].x - nodes[B].x, nodes[j].z - nodes[B].z);
      if (d >= 0.19 * target && d <= 0.29 * target) C = j;
    }
    if (C < 0) return null;
    wps.push(B, C);
  }

  const forbidNode = new Uint8Array(nodes.length);
  const forbidEdge = new Uint8Array(edges.length);
  const CELL = 30;
  const marked = new Set();
  const ckey = (x, z) => Math.floor(x / CELL) * 100003 + Math.floor(z / CELL);
  let near = new Float32Array(edges.length).fill(-1);
  const edgeCost = (ei) => {
    const e = edges[ei];
    let f = near[ei];
    if (f < 0) {
      if (marked.size === 0) f = 0;
      else {
        let hit = 0;
        for (const p of e.pts) if (marked.has(ckey(p[0], p[1]))) hit++;
        f = hit / e.pts.length;
      }
      near[ei] = f;
    }
    return e.len * e.cf * (1 + 8 * f);
  };

  const seq = [];
  const visited = [A];
  for (let L = 0; L < wps.length; L++) {
    const src = wps[L], dst = wps[(L + 1) % wps.length];
    for (let j = L + 2; j < wps.length; j++) forbidNode[wps[j]] = 1;
    const r = dijkstra(G, src, dst, forbidNode, forbidEdge, edgeCost);
    for (let j = L + 2; j < wps.length; j++) forbidNode[wps[j]] = 0;
    if (!r || r.edges.length === 0) return null;
    for (const ei of r.edges) {
      forbidEdge[ei] = 1;
      seq.push(ei);
      for (const p of edges[ei].pts) {
        const cx = Math.floor(p[0] / CELL), cz = Math.floor(p[1] / CELL);
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) marked.add((cx + dx) * 100003 + cz + dz);
      }
    }
    for (let q = 1; q < r.nodes.length; q++) { forbidNode[r.nodes[q]] = 1; visited.push(r.nodes[q]); }
    forbidNode[src] = 1;
    near = new Float32Array(edges.length).fill(-1);
  }
  // must be simple: start node appears twice (start & end), others once
  visited.pop();
  if (new Set(visited).size !== visited.length) return null;

  let len = 0, minorLen = 0, costSum = 0;
  const nameLen = new Map();
  for (const ei of seq) {
    const e = edges[ei];
    len += e.len;
    costSum += e.len * e.cf;
    if (MINOR.has(e.cls)) minorLen += e.len;
    if (e.name) nameLen.set(e.name, (nameLen.get(e.name) || 0) + e.len);
  }
  if (len < 0.65 * target || len > 1.45 * target) return null;
  if (minorLen / len > 0.3) return null;

  const raw = edgesToPolyline(G, seq, A);
  const center = makeCenterline(raw);
  const m = analyzeCenterline(center);
  if (m.minSep < MIN_SEPARATION || m.parallelShare > 0.12) return null;

  const quality = costSum / len; // 1 = all primary roads
  const wantCorners = Math.max(6, m.length / 380);
  let score = 0;
  score -= (Math.abs(m.length - target) / target) * 3;
  score -= (quality - 1) * 2.2;
  score -= (Math.abs(m.corners.length - wantCorners) / wantCorners) * 1.2;
  score -= Math.max(0, m.hairpins - 2) * 0.4;
  score -= m.parallelShare * 6;
  score += (Math.min(m.longestStraight, 900) / 900) * 1.2;
  score += rnd() * 0.25;

  const streets = [...nameLen.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  return {
    edgeSet: new Set(seq), seq, center, metrics: m, score, quality,
    minorShare: minorLen / len, streets,
  };
}

export async function generateCandidates(G, opts) {
  const { target = 4500, radius = 2000, count = 4, seed = Date.now(), attempts = 450, timeBudget = 9000, onProgress } = opts;
  const rnd = mulberry32(seed);
  const { nodes, edges } = G;
  const minCf = (i) => Math.min(...nodes[i].adj.map((ei) => edges[ei].cf));
  const inArea = (i) => nodes[i].main && Math.hypot(nodes[i].x, nodes[i].z) < radius * 0.85 && nodes[i].adj.length >= 3;
  let pool = [];
  for (const lim of [1.2, 1.6, 3.5, 99]) {
    pool = [];
    for (let i = 0; i < nodes.length; i++) if (inArea(i) && minCf(i) <= lim) pool.push(i);
    if (pool.length >= 40) break;
  }
  if (pool.length < 4) throw new Error('Troppe poche strade in questa zona: prova a spostarti o allargare l\'area.');

  const results = [];
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const t0 = now();
  let lastYield = now();
  for (let a = 0; a < attempts; a++) {
    if (now() - lastYield > 40) {
      onProgress?.(a / attempts, results.length);
      await new Promise((r) => setTimeout(r, 0));
      lastYield = now();
    }
    const c = tryLoop(G, pool, target, rnd);
    if (c) results.push(c);
    if (now() - t0 > timeBudget && results.length >= count) break;
  }
  results.sort((x, y) => y.score - x.score);
  const chosen = [];
  const overlap = (a, b) => {
    let shared = 0, la = 0, lb = 0;
    for (const ei of a.edgeSet) { la += edges[ei].len; if (b.edgeSet.has(ei)) shared += edges[ei].len; }
    for (const ei of b.edgeSet) lb += edges[ei].len;
    return shared / Math.min(la, lb);
  };
  for (const c of results) {
    if (chosen.every((o) => overlap(o, c) < 0.35)) chosen.push(c);
    if (chosen.length === count) break;
  }
  return chosen;
}

// Choose race direction & start/finish line (on the longest straight), rotate so index 0 = finish line.
export function orientTrack(center, reverse) {
  let p = reverse ? center.slice().reverse() : center.slice();
  const m = analyzeCenterline(p);
  const n = p.length;
  const runSamples = Math.round(m.longestStraight / m.ds);
  const offset = Math.round(Math.max(runSamples * 0.55, Math.min(runSamples, 110 / m.ds)));
  const startIdx = (m.longestStart + offset) % n;
  p = p.slice(startIdx).concat(p.slice(0, startIdx));
  return p;
}

// ---------------------------------------------------------------- editor helpers
export function nearestNode(G, x, z, maxDist = 120) {
  let best = -1, bd = maxDist * maxDist;
  for (let i = 0; i < G.nodes.length; i++) {
    const nd = G.nodes[i];
    if (!nd.main) continue;
    const d = (nd.x - x) ** 2 + (nd.z - z) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// shortest road route between two graph nodes (prefers main roads); returns polyline points + edges
export function routeBetween(G, a, b) {
  const forbidNode = new Uint8Array(G.nodes.length), forbidEdge = new Uint8Array(G.edges.length);
  const r = dijkstra(G, a, b, forbidNode, forbidEdge, (ei) => G.edges[ei].len * Math.sqrt(G.edges[ei].cf));
  if (!r) return null;
  const pts = [];
  let cur = a;
  for (const ei of r.edges) {
    const e = G.edges[ei];
    const p = e.a === cur ? e.pts : e.pts.slice().reverse();
    for (let k = pts.length ? 1 : 0; k < p.length; k++) pts.push(p[k]);
    cur = e.a === cur ? e.b : e.a;
  }
  return { pts, edges: r.edges };
}

// turns a user-drawn closed route into a candidate (same shape as generated ones)
export function candidateFromRoute(G, raw, edgeIds) {
  const center = makeCenterline(raw);
  const m = analyzeCenterline(center);
  let len = 0, minor = 0;
  const names = new Map();
  for (const ei of edgeIds) {
    const e = G.edges[ei];
    len += e.len;
    if (MINOR.has(e.cls)) minor += e.len;
    if (e.name) names.set(e.name, (names.get(e.name) || 0) + e.len);
  }
  return {
    edgeSet: new Set(edgeIds), seq: edgeIds, center, metrics: m, score: 0, quality: 1,
    minorShare: len ? minor / len : 0, streets: [...names.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]),
    custom: true, ok: m.minSep >= MIN_SEPARATION,
  };
}
