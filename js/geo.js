// Geographic helpers: local metric projection, bounding boxes, web-mercator tiles, RNG.

const EARTH_R = 6378137;
const DEG = Math.PI / 180;

// Local equirectangular projection centred on (lat0, lon0).
// x = east (metres), z = south (metres)  → north is -z in the 3D world.
export function makeProjection(lat0, lon0) {
  const kx = DEG * EARTH_R * Math.cos(lat0 * DEG);
  const kz = DEG * EARTH_R;
  return {
    lat0, lon0,
    toXZ(lat, lon) { return [(lon - lon0) * kx, -(lat - lat0) * kz]; },
    toLatLon(x, z) { return [lat0 - z / kz, lon0 + x / kx]; },
  };
}

export function bboxAround(lat, lon, radiusM) {
  const dLat = radiusM / (DEG * EARTH_R);
  const dLon = radiusM / (DEG * EARTH_R * Math.cos(lat * DEG));
  return { s: lat - dLat, w: lon - dLon, n: lat + dLat, e: lon + dLon };
}

// bbox (lat/lon) of a set of local points, expanded by margin metres
export function bboxOfXZ(proj, pts, margin) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of pts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  minX -= margin; maxX += margin; minZ -= margin; maxZ += margin;
  const [n, w] = proj.toLatLon(minX, minZ);
  const [s, e] = proj.toLatLon(maxX, maxZ);
  return { s, w, n, e, minX, maxX, minZ, maxZ };
}

// Web mercator tile maths
export const lon2tile = (lon, z) => ((lon + 180) / 360) * 2 ** z;
export const lat2tile = (lat, z) => {
  const r = lat * DEG;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
export const tile2lon = (x, z) => (x / 2 ** z) * 360 - 180;
export const tile2lat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return Math.atan(Math.sinh(n)) / DEG;
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
