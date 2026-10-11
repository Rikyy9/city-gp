// Real elevation from free AWS Terrain Tiles (Terrarium encoding), as smoothed local heightfields.

import { lon2tile, lat2tile } from './geo.js';
import { DEM_URL } from './config.js';

function loadDemTile(z, x, y) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 256;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, 256, 256).data;
        const out = new Float32Array(256 * 256);
        for (let i = 0; i < out.length; i++) out[i] = d[4 * i] * 256 + d[4 * i + 1] + d[4 * i + 2] / 256 - 32768;
        resolve(out);
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = DEM_URL(z, x, y);
  });
}

export class Heightfield {
  constructor(minX, minZ, cell, nx, nz, data) {
    Object.assign(this, { minX, minZ, cell, nx, nz, data });
    this.maxX = minX + (nx - 1) * cell;
    this.maxZ = minZ + (nz - 1) * cell;
  }
  contains(x, z) { return x >= this.minX && x <= this.maxX && z >= this.minZ && z <= this.maxZ; }
  sample(x, z) {
    let fx = (x - this.minX) / this.cell, fz = (z - this.minZ) / this.cell;
    fx = Math.max(0, Math.min(this.nx - 1.001, fx));
    fz = Math.max(0, Math.min(this.nz - 1.001, fz));
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    const d = this.data, nx = this.nx, k = iz * nx + ix;
    const a = d[k] * (1 - tx) + d[k + 1] * tx;
    const b = d[k + nx] * (1 - tx) + d[k + nx + 1] * tx;
    return a * (1 - tz) + b * tz;
  }
}

function boxBlur(data, nx, nz, r, passes) {
  const tmp = new Float32Array(data.length);
  for (let p = 0; p < passes; p++) {
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        let s = 0, c = 0;
        for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < nx) { s += data[z * nx + xx]; c++; } }
        tmp[z * nx + x] = s / c;
      }
    }
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        let s = 0, c = 0;
        for (let k = -r; k <= r; k++) { const zz = z + k; if (zz >= 0 && zz < nz) { s += tmp[zz * nx + x]; c++; } }
        data[z * nx + x] = s / c;
      }
    }
  }
}

// Builds a heightfield over [minX,maxX]x[minZ,maxZ] (local metres). Returns null if no data could be loaded.
export async function buildHeightfield(proj, b, cell, zoom, blurR = 2) {
  const [n, w] = proj.toLatLon(b.minX, b.minZ);
  const [s, e] = proj.toLatLon(b.maxX, b.maxZ);
  const x0 = Math.floor(lon2tile(w, zoom)), x1 = Math.floor(lon2tile(e, zoom));
  const y0 = Math.floor(lat2tile(n, zoom)), y1 = Math.floor(lat2tile(s, zoom));
  const tiles = new Map();
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([x, y]);
  if (jobs.length > 64) return null;
  await Promise.all(jobs.map(async ([x, y]) => { tiles.set(`${x},${y}`, await loadDemTile(zoom, x, y)); }));
  if (![...tiles.values()].some(Boolean)) return null;

  const pix = (px, py) => {
    const t = tiles.get(`${px >> 8},${py >> 8}`);
    return t ? t[(py & 255) * 256 + (px & 255)] : NaN;
  };
  const nx = Math.ceil((b.maxX - b.minX) / cell) + 1;
  const nz = Math.ceil((b.maxZ - b.minZ) / cell) + 1;
  const data = new Float32Array(nx * nz);
  let valid = 0, sum = 0;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const [lat, lon] = proj.toLatLon(b.minX + ix * cell, b.minZ + iz * cell);
      const fx = lon2tile(lon, zoom) * 256 - 0.5, fy = lat2tile(lat, zoom) * 256 - 0.5;
      const px = Math.floor(fx), py = Math.floor(fy), tx = fx - px, ty = fy - py;
      const v = (pix(px, py) * (1 - tx) + pix(px + 1, py) * tx) * (1 - ty) + (pix(px, py + 1) * (1 - tx) + pix(px + 1, py + 1) * tx) * ty;
      data[iz * nx + ix] = v;
      if (Number.isFinite(v)) { valid++; sum += v; }
    }
  }
  const mean = valid ? sum / valid : 0;
  for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i]) || data[i] < -500) data[i] = mean;
  if (blurR > 0) boxBlur(data, nx, nz, blurR, 2);
  return new Heightfield(b.minX, b.minZ, cell, nx, nz, data);
}

// Smoothed, grade-limited elevation profile along the centreline (absolute metres).
export function trackProfile(track, hf, maxGrade = 0.13) {
  const n = track.n;
  let y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = hf.sample(track.P[2 * i], track.P[2 * i + 1]);
  const W = 20; // ±40 m moving average
  for (let pass = 0; pass < 4; pass++) {
    const out = new Float32Array(n);
    let s = 0;
    for (let k = -W; k <= W; k++) s += y[((k % n) + n) % n];
    for (let i = 0; i < n; i++) {
      out[i] = s / (2 * W + 1);
      s += y[(i + W + 1) % n] - y[((i - W) % n + n) % n];
    }
    y = out;
  }
  const dmax = maxGrade * track.ds;
  for (let it = 0; it < 6; it++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, d = y[j] - y[i];
      if (d > dmax) { const c = (d - dmax) / 2; y[j] -= c; y[i] += c; }
      else if (d < -dmax) { const c = (-dmax - d) / 2; y[j] += c; y[i] -= c; }
    }
  }
  return y;
}

const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Ground height function (relative to `base`): DEM blended into the track level near the circuit.
export function makeGround(track, nearHf, farHf, base) {
  const inner = track.wallOff + 2.5, outer = track.wallOff + 45;
  return (x, z, far = false) => {
    const hf = !far && nearHf && nearHf.contains(x, z) ? nearHf : farHf || nearHf;
    const dem = hf ? hf.sample(x, z) - base : 0;
    if (far) return dem;
    const nr = track.nearest(x, z, outer + 5);
    if (!nr) return dem;
    const ty = track.Y[nr.idx] - 0.06;
    const t = smoothstep(inner, outer, nr.dist);
    return ty + (dem - ty) * t;
  };
}
