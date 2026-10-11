// Parses the OSM scenery response into typed features, picks landmarks and maps street names onto the track.

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function openRing(pts) {
  if (pts.length > 3 && dist(pts[0], pts[pts.length - 1]) < 0.05) return pts.slice(0, -1);
  return pts;
}

// join open polylines into closed rings (multipolygon members)
function assembleRings(lines) {
  const rings = [];
  const pool = lines.filter((l) => l.length >= 2).map((l) => l.slice());
  while (pool.length) {
    let ring = pool.pop();
    let guard = 0;
    while (dist(ring[0], ring[ring.length - 1]) > 0.5 && guard++ < 500) {
      const end = ring[ring.length - 1];
      let found = -1, rev = false;
      for (let k = 0; k < pool.length; k++) {
        if (dist(pool[k][0], end) < 0.5) { found = k; break; }
        if (dist(pool[k][pool[k].length - 1], end) < 0.5) { found = k; rev = true; break; }
      }
      if (found < 0) break;
      let seg = pool.splice(found, 1)[0];
      if (rev) seg = seg.reverse();
      ring = ring.concat(seg.slice(1));
    }
    if (ring.length >= 4 && dist(ring[0], ring[ring.length - 1]) <= 0.5) rings.push(openRing(ring));
  }
  return rings;
}

export function ringArea(r) {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function centroid(r) {
  let x = 0, z = 0;
  for (const p of r) { x += p[0]; z += p[1]; }
  return [x / r.length, z / r.length];
}

function areaKind(t) {
  if (t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'reservoir' || t.landuse === 'basin') return 'water';
  if (t.natural === 'wood' || t.landuse === 'forest' || t.natural === 'scrub') return 'wood';
  if (t.leisure === 'pitch' || t.leisure === 'stadium') return 'pitch';
  if (t.landuse === 'cemetery') return 'cemetery';
  if (['park', 'garden', 'playground', 'dog_park'].includes(t.leisure) ||
      ['grass', 'meadow', 'village_green', 'recreation_ground'].includes(t.landuse) || t.natural === 'grassland') return 'park';
  return null;
}

const POI_HISTORIC = new Set(['castle', 'monument', 'church', 'city_gate', 'palace', 'tower', 'fort', 'manor', 'cathedral', 'archaeological_site', 'building', 'aqueduct', 'bridge', 'citywalls', 'ruins']);

function poiScore(t) {
  if (!t.name) return 0;
  let s = 0;
  if (t.wikidata || t.wikipedia) s += 3;
  if (POI_HISTORIC.has(t.historic)) s += 2;
  else if (t.historic) s += 0.5;
  if (t.tourism === 'attraction' || t.tourism === 'museum') s += 2;
  else if (t.tourism) s += 0.7;
  if (t.amenity === 'place_of_worship') s += 1.5;
  if (t.building === 'cathedral' || t.building === 'basilica') s += 2;
  if (t.amenity === 'townhall' || t.amenity === 'theatre') s += 1.2;
  if (['tower', 'campanile', 'obelisk', 'lighthouse', 'water_tower'].includes(t.man_made)) s += 1.5;
  if (t.leisure === 'park' || t.leisure === 'stadium') s += 1;
  return s;
}

export function parseScenery(osm, proj) {
  const out = { buildings: [], parts: [], trees: [], roads: [], areas: [], rails: [], waterways: [], pois: [] };
  const toPts = (geom) => geom.filter(Boolean).map((g) => proj.toXZ(g.lat, g.lon));
  for (const e of osm.elements || []) {
    const t = e.tags || {};
    if (e.type === 'node') {
      const p = proj.toXZ(e.lat, e.lon);
      if (t.natural === 'tree') out.trees.push(p);
      const sc = poiScore(t);
      if (sc > 0) out.pois.push({ id: 'n' + e.id, tags: t, x: p[0], z: p[1], ring: null, score: sc });
      else if (['tower', 'campanile'].includes(t.man_made)) out.pois.push({ id: 'n' + e.id, tags: t, x: p[0], z: p[1], ring: null, score: 0.5 });
      continue;
    }
    if (e.type === 'way' && e.geometry) {
      const pts = toPts(e.geometry);
      if (pts.length < 2) continue;
      const closed = e.nodes && e.nodes.length > 3 && e.nodes[0] === e.nodes[e.nodes.length - 1];
      const ring = closed ? openRing(pts) : null;
      if (t['building:part'] && ring) out.parts.push({ id: e.id, tags: t, ring });
      else if (t.building && ring) out.buildings.push({ id: e.id, tags: t, ring });
      if (t.highway && !closed) out.roads.push({ tags: t, pts });
      else if (t.highway && closed && t.area === 'yes') out.areas.push({ kind: 'plaza', ring });
      else if (t.railway) out.rails.push({ tags: t, pts });
      else if (t.waterway && !ring) out.waterways.push({ tags: t, pts });
      if (ring) { const k = areaKind(t); if (k) out.areas.push({ kind: k, ring }); }
      const sc = poiScore(t);
      if (sc > 0) {
        const c = ring ? centroid(ring) : pts[Math.floor(pts.length / 2)];
        out.pois.push({ id: 'w' + e.id, wayId: e.id, tags: t, x: c[0], z: c[1], ring, score: sc + (ring && Math.abs(ringArea(ring)) > 2000 ? 1 : 0) });
      }
      continue;
    }
    if (e.type === 'relation' && e.members) {
      const outers = assembleRings(e.members.filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry).map((m) => toPts(m.geometry)));
      if (!outers.length) continue;
      outers.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
      if (t.building) for (const r of outers) out.buildings.push({ id: e.id, tags: t, ring: r });
      const k = areaKind(t);
      if (k) for (const r of outers) out.areas.push({ kind: k, ring: r });
      const sc = poiScore(t);
      if (sc > 0) {
        const c = centroid(outers[0]);
        out.pois.push({ id: 'r' + e.id, tags: t, x: c[0], z: c[1], ring: outers[0], score: sc + (Math.abs(ringArea(outers[0])) > 2000 ? 1 : 0) });
      }
    }
  }
  return out;
}

// pick the most recognisable places near the track
export function selectLandmarks(pois, track, max = 14) {
  const cands = [];
  for (const p of pois) {
    if (!p.tags.name) continue;
    const nr = track.nearest(p.x, p.z, 700);
    if (!nr) continue;
    let s = p.score;
    if (nr.dist < 150) s += 1; else if (nr.dist > 450) s -= 1;
    cands.push({ ...p, name: p.tags.name, dist: nr.dist, idx: nr.idx, rank: s });
  }
  cands.sort((a, b) => b.rank - a.rank);
  const chosen = [];
  for (const c of cands) {
    if (c.rank < 1.5) break;
    if (chosen.some((o) => o.name === c.name || Math.hypot(o.x - c.x, o.z - c.z) < 70)) continue;
    chosen.push(c);
    if (chosen.length >= max) break;
  }
  return chosen;
}

const DRIVABLE = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'pedestrian',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);

// street name for every centreline sample + contiguous segments
export function streetNames(track, roads) {
  const CELL = 30;
  const grid = new Map();
  const segs = [];
  for (const r of roads) {
    const name = r.tags.name;
    if (!name || !DRIVABLE.has(r.tags.highway)) continue;
    for (let k = 0; k < r.pts.length - 1; k++) {
      const a = r.pts[k], b = r.pts[k + 1];
      const si = segs.length;
      segs.push([a, b, name]);
      const minx = Math.floor(Math.min(a[0], b[0]) / CELL), maxx = Math.floor(Math.max(a[0], b[0]) / CELL);
      const minz = Math.floor(Math.min(a[1], b[1]) / CELL), maxz = Math.floor(Math.max(a[1], b[1]) / CELL);
      for (let cx = minx; cx <= maxx; cx++) for (let cz = minz; cz <= maxz; cz++) {
        const key = cx * 100003 + cz;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(si);
      }
    }
  }
  const n = track.n, step = 3;
  const coarse = [];
  for (let i = 0; i < n; i += step) {
    const x = track.P[2 * i], z = track.P[2 * i + 1];
    const tx = track.T[2 * i], tz = track.T[2 * i + 1];
    let best = null, bd = 18;
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const si of grid.get((cx + dx) * 100003 + cz + dz) || []) {
        const [a, b, name] = segs[si];
        const ex = b[0] - a[0], ez = b[1] - a[1];
        const L = Math.hypot(ex, ez) || 1;
        if (Math.abs((ex * tx + ez * tz) / L) < 0.6) continue;
        const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / (L * L)));
        const d = Math.hypot(x - (a[0] + ex * t), z - (a[1] + ez * t));
        if (d < bd) { bd = d; best = name; }
      }
    }
    coarse.push(best);
  }
  // fill gaps with nearest known, then majority filter
  const m = coarse.length;
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < m; i++) {
    if (coarse[i]) continue;
    for (let k = 1; k < m; k++) {
      const a = coarse[(i - k + m) % m], b = coarse[(i + k) % m];
      if (a || b) { coarse[i] = a || b; break; }
    }
  }
  const W = 8;
  const smooth = coarse.map((_, i) => {
    const cnt = new Map();
    for (let k = -W; k <= W; k++) { const v = coarse[(i + k + m) % m]; if (v) cnt.set(v, (cnt.get(v) || 0) + 1); }
    let best = coarse[i], bc = 0;
    for (const [v, c] of cnt) if (c > bc) { bc = c; best = v; }
    return best;
  });
  const per = new Array(n);
  for (let i = 0; i < n; i++) per[i] = smooth[Math.min(m - 1, Math.floor(i / step))] || '';
  // segments
  const segments = [];
  let start = 0;
  while (start < n && per[start] === per[(start - 1 + n) % n]) start++;
  if (start >= n) return { per, segments: per[0] ? [{ start: 0, len: track.length, name: per[0] }] : [] };
  let cur = { start, name: per[start], count: 0 };
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (per[i] !== cur.name) { segments.push(cur); cur = { start: i, name: per[i], count: 0 }; }
    cur.count++;
  }
  segments.push(cur);
  return { per, segments: segments.filter((s) => s.name).map((s) => ({ start: s.start, len: s.count * track.ds, name: s.name })) };
}
