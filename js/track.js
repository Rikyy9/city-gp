// Runtime track model: centreline frames, projection queries, racing line and AI speed profile.

import { TRACK_WIDTH, WALL_GAP } from './trackgen.js';
import { maxLateralAccel, brakeDecel, engineAccel, coastDecel, VMAX } from './physics.js';

export class Track {
  constructor(pts, { width = TRACK_WIDTH, wallGap = WALL_GAP } = {}) {
    const n = pts.length;
    this.n = n;
    this.width = width;
    this.halfW = width / 2;
    this.wallOff = width / 2 + wallGap;
    this.P = new Float32Array(2 * n);
    this.T = new Float32Array(2 * n);
    this.N = new Float32Array(2 * n); // left normal
    this.S = new Float32Array(n + 1);
    for (let i = 0; i < n; i++) { this.P[2 * i] = pts[i][0]; this.P[2 * i + 1] = pts[i][1]; }
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      let tx = this.P[2 * b] - this.P[2 * a], tz = this.P[2 * b + 1] - this.P[2 * a + 1];
      const l = Math.hypot(tx, tz) || 1;
      tx /= l; tz /= l;
      this.T[2 * i] = tx; this.T[2 * i + 1] = tz;
      this.N[2 * i] = tz; this.N[2 * i + 1] = -tx;
      const j = (i + 1) % n;
      this.S[i + 1] = this.S[i] + Math.hypot(this.P[2 * j] - this.P[2 * i], this.P[2 * j + 1] - this.P[2 * i + 1]);
    }
    this.length = this.S[n];
    this.ds = this.length / n;
    this.kappa = signedCurvature(this.P, n, 3);
    // kerb zones on corners (same rule used to draw them)
    this.kerb = new Uint8Array(n);
    const thr = 1 / 110, pad = 6;
    for (let i = 0; i < n; i++) {
      if (Math.abs(this.kappa[i]) <= thr) continue;
      for (let k = -pad; k <= pad; k++) this.kerb[((i + k) % n + n) % n] = 1;
    }
    // energy-absorbing (TecPro) barriers on the outside of tight corners: the wall comes in a little
    this.inset = new Float32Array(2 * n);
    this.tecpro = [];
    const tight = 1 / 55;
    for (let i = 0; i < n;) {
      if (Math.abs(this.kappa[i]) < tight) { i++; continue; }
      let b = i;
      while (b < i + n && Math.abs(this.kappa[(b + 1) % n]) >= tight * 0.7) b++;
      const side = Math.sign(this.kappa[((i + b) >> 1) % n]) || 1;
      const i0 = i - 6, i1 = b + 16;
      for (let k = i0; k <= i1; k++) this.inset[2 * (((k % n) + n) % n) + (side > 0 ? 0 : 1)] = 0.55;
      this.tecpro.push({ i0: ((i0 % n) + n) % n, count: i1 - i0, side });
      i = b + 1;
    }

    // spatial hash of centreline samples
    this.cell = 20;
    this.grid = new Map();
    for (let i = 0; i < n; i++) {
      const k = this._key(Math.floor(this.P[2 * i] / this.cell), Math.floor(this.P[2 * i + 1] / this.cell));
      let arr = this.grid.get(k);
      if (!arr) this.grid.set(k, (arr = []));
      arr.push(i);
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, this.P[2 * i]); maxX = Math.max(maxX, this.P[2 * i]);
      minZ = Math.min(minZ, this.P[2 * i + 1]); maxZ = Math.max(maxZ, this.P[2 * i + 1]);
    }
    this.bounds = { minX, maxX, minZ, maxZ };
    this.setElevation(new Float32Array(n));
    this.computeRaceLayout();
  }

  // Y: elevation of each centreline sample (metres, relative)
  setElevation(Y) {
    const n = this.n;
    this.Y = Y;
    this.G = new Float32Array(n); // grade dy/ds along the race direction
    for (let i = 0; i < n; i++) this.G[i] = (Y[(i + 1) % n] - Y[(i - 1 + n) % n]) / (2 * this.ds);
    let lo = Infinity, hi = -Infinity, maxG = 0, climb = 0;
    for (let i = 0; i < n; i++) {
      lo = Math.min(lo, Y[i]); hi = Math.max(hi, Y[i]);
      maxG = Math.max(maxG, Math.abs(this.G[i]));
      const d = Y[(i + 1) % n] - Y[i];
      if (d > 0) climb += d;
    }
    this.elev = { min: lo, max: hi, range: hi - lo, maxGrade: maxG, climb };
    if (this.raceKappa) this.computeSpeedProfile();
  }

  yAt(s) {
    s = ((s % this.length) + this.length) % this.length;
    const f = s / this.ds;
    const i = Math.floor(f) % this.n, j = (i + 1) % this.n, t = f - Math.floor(f);
    return this.Y[i] * (1 - t) + this.Y[j] * t;
  }

  _key(cx, cz) { return cx * 100003 + cz; }
  wrap(i) { return ((i % this.n) + this.n) % this.n; }
  px(i) { return this.P[2 * this.wrap(i)]; }
  pz(i) { return this.P[2 * this.wrap(i) + 1]; }

  // nearest centreline sample within radius (null if none)
  nearest(x, z, radius = 40) {
    const c = this.cell, r = Math.ceil(radius / c);
    const cx = Math.floor(x / c), cz = Math.floor(z / c);
    let best = -1, bd = radius * radius;
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      const arr = this.grid.get(this._key(cx + dx, cz + dz));
      if (!arr) continue;
      for (const i of arr) {
        const ex = this.P[2 * i] - x, ez = this.P[2 * i + 1] - z;
        const d = ex * ex + ez * ez;
        if (d < bd) { bd = d; best = i; }
      }
    }
    return best < 0 ? null : { idx: best, dist: Math.sqrt(bd) };
  }

  distToCenter(x, z, radius = 40) {
    const r = this.nearest(x, z, radius);
    return r ? r.dist : Infinity;
  }

  nearestGlobal(x, z) {
    const r = this.nearest(x, z, 60);
    if (r) return r.idx;
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.n; i++) {
      const ex = this.P[2 * i] - x, ez = this.P[2 * i + 1] - z;
      const d = ex * ex + ez * ez;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // local search around a hint index; returns { idx, s, d } where d = lateral offset (+left)
  project(x, z, hint, win = 30) {
    let best = hint, bd = Infinity;
    for (let k = -win; k <= win; k++) {
      const i = this.wrap(hint + k);
      const ex = this.P[2 * i] - x, ez = this.P[2 * i + 1] - z;
      const d = ex * ex + ez * ez;
      if (d < bd) { bd = d; best = i; }
    }
    if (bd > 30 * 30) best = this.nearestGlobal(x, z);
    const i = best;
    const ex = x - this.P[2 * i], ez = z - this.P[2 * i + 1];
    const along = ex * this.T[2 * i] + ez * this.T[2 * i + 1];
    const d = ex * this.N[2 * i] + ez * this.N[2 * i + 1];
    let s = this.S[i] + along;
    if (s < 0) s += this.length;
    if (s >= this.length) s -= this.length;
    return { idx: i, s, d };
  }

  // point on centreline at arc length s, with lateral offset
  pointAt(s, offset = 0) {
    s = ((s % this.length) + this.length) % this.length;
    const f = s / this.ds;
    const i = Math.floor(f) % this.n, j = (i + 1) % this.n, t = f - Math.floor(f);
    const x = this.P[2 * i] * (1 - t) + this.P[2 * j] * t;
    const z = this.P[2 * i + 1] * (1 - t) + this.P[2 * j + 1] * t;
    const nx = this.N[2 * i] * (1 - t) + this.N[2 * j] * t;
    const nz = this.N[2 * i + 1] * (1 - t) + this.N[2 * j + 1] * t;
    const tx = this.T[2 * i] * (1 - t) + this.T[2 * j] * t;
    const tz = this.T[2 * i + 1] * (1 - t) + this.T[2 * j + 1] * t;
    const y = this.Y[i] * (1 - t) + this.Y[j] * t;
    return { x: x + nx * offset, y, z: z + nz * offset, tx, tz, nx, nz, idx: i };
  }

  // DRS zones on the two longest straights + pit lane layout around the finish line
  computeRaceLayout() {
    const n = this.n, ds = this.ds, L = this.length;
    const straight = (i) => Math.abs(this.kappa[i]) < 1 / 400;
    let start = 0;
    while (start < n && straight(start)) start++;
    const runs = [];
    let cur = null;
    for (let q = 0; q <= n; q++) {
      const i = (start + q) % n;
      if (q < n && straight(i)) { if (!cur) cur = { s: this.S[i], len: 0 }; cur.len += ds; }
      else if (cur) { runs.push(cur); cur = null; }
    }
    runs.sort((a, b) => b.len - a.len);
    this.drs = runs.filter((r) => r.len >= 320).slice(0, 2).map((r) => ({
      detect: (r.s + 70 - 150 + L) % L, start: (r.s + 70) % L, end: (r.s + r.len - 50) % L,
    }));
    this.pit = { entry: L - 300, limitStart: L - 200, box: 60, limitEnd: 170, exit: 230, offset: -(this.halfW - 2.0), limit: 22 };
  }

  // is arc length s inside [a, b] (wrapping)?
  inRange(s, a, b) {
    const L = this.length;
    s = ((s % L) + L) % L; a = ((a % L) + L) % L; b = ((b % L) + L) % L;
    return a <= b ? s >= a && s <= b : s >= a || s <= b;
  }

  // ---------------------------------------------------------------- racing line
  // Racing line: minimise a blend of bending energy (curvature) and length, pick the blend with
  // the lowest simulated lap time. Solved coarse-to-fine with Gauss-Seidel on lateral offsets.
  computeRacingLine(margin = 1.3) {
    const n = this.n;
    const lim = this.halfW - margin;
    const solveLevel = (step, init, lambda, iters) => {
      const m = Math.floor(n / step);
      const px = new Float64Array(m), pz = new Float64Array(m), nx = new Float64Array(m), nz = new Float64Array(m);
      const o = new Float64Array(m), X = new Float64Array(m), Z = new Float64Array(m);
      for (let k = 0; k < m; k++) {
        const i = k * step;
        px[k] = this.P[2 * i]; pz[k] = this.P[2 * i + 1]; nx[k] = this.N[2 * i]; nz[k] = this.N[2 * i + 1];
        o[k] = init ? init(i) : 0;
        X[k] = px[k] + nx[k] * o[k]; Z[k] = pz[k] + nz[k] * o[k];
      }
      const w = 1 / (1 + lambda);
      for (let it = 0; it < iters; it++) {
        for (let k = 0; k < m; k++) {
          const a = (k - 2 + m) % m, b = (k - 1 + m) % m, c = (k + 1) % m, d = (k + 2) % m;
          // bending: zero 4th difference; length: midpoint of neighbours
          const tx = ((-X[a] + 4 * X[b] + 4 * X[c] - X[d]) / 6 + lambda * (X[b] + X[c]) / 2) * w;
          const tz = ((-Z[a] + 4 * Z[b] + 4 * Z[c] - Z[d]) / 6 + lambda * (Z[b] + Z[c]) / 2) * w;
          const target = (tx - px[k]) * nx[k] + (tz - pz[k]) * nz[k];
          let v = o[k] + 1.25 * (target - o[k]);
          v = v < -lim ? -lim : v > lim ? lim : v;
          o[k] = v;
          X[k] = px[k] + nx[k] * v; Z[k] = pz[k] + nz[k] * v;
        }
      }
      // interpolate back to every centreline sample
      return (i) => {
        const f = i / step, k = Math.floor(f) % m, t = f - Math.floor(f);
        return o[k] * (1 - t) + o[(k + 1) % m] * t;
      };
    };

    const build = (lambda) => {
      let f = solveLevel(16, null, lambda, 900);
      f = solveLevel(6, f, lambda, 700);
      f = solveLevel(2, f, lambda, 250);
      const o = new Float32Array(n);
      for (let i = 0; i < n; i++) o[i] = Math.max(-lim, Math.min(lim, f(i)));
      return o;
    };
    const evaluate = (o) => {
      const R = new Float32Array(2 * n);
      for (let i = 0; i < n; i++) {
        R[2 * i] = this.P[2 * i] + this.N[2 * i] * o[i];
        R[2 * i + 1] = this.P[2 * i + 1] + this.N[2 * i + 1] * o[i];
      }
      const kappa = signedCurvature(R, n, 3);
      const seg = new Float32Array(n);
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; seg[i] = Math.hypot(R[2 * j] - R[2 * i], R[2 * j + 1] - R[2 * i + 1]); }
      const v = this.speedProfileFor(kappa, seg);
      let time = 0;
      for (let i = 0; i < n; i++) time += seg[i] / Math.max(1, (v[i] + v[(i + 1) % n]) / 2);
      return { R, kappa, seg, v, time };
    };

    let best = null;
    for (const lambda of [0, 0.02, 0.06, 0.15, 0.4]) {
      const o = build(lambda);
      const r = evaluate(o);
      if (!best || r.time < best.time) best = { ...r, o, lambda };
    }
    this.raceOffset = best.o;
    this.raceLine = best.R;
    this.raceKappa = best.kappa;
    this.raceSeg = best.seg;
    this.raceLambda = best.lambda;
    this.idealLapTime = best.time;
    this.computeSpeedProfile();
  }

  // grip scale (1 = AI kinematic model, ~1.08 = arcade cars)
  setGrip(g) { this.grip = g; if (this.raceKappa) this.computeSpeedProfile(); }
  // weather grip of the best tyre for the current wetness (recomputed when it changes noticeably)
  setWeatherGrip(g) {
    if (Math.abs((this.weatherGrip || 1) - g) < 0.006) return;
    this.weatherGrip = g;
    if (this.raceKappa) this.computeSpeedProfile();
  }

  speedProfileFor(kappa, seg) {
    const n = this.n;
    const wg = this.weatherGrip || 1;
    const g = (this.grip || 1) * wg;
    const { a, b } = maxLateralAccel.coeffs;
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const den = Math.abs(kappa[i]) - g * b;
      v[i] = den <= 0 ? VMAX : Math.min(VMAX, Math.sqrt((g * a) / den));
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let q = 2 * n; q > 0; q--) {
        const i = q % n, j = (q + 1) % n;
        const vn = v[j];
        const dec = Math.max(4, brakeDecel(vn) + coastDecel(vn) * 0.5 + 9.81 * this.G[i]);
        const lim = Math.sqrt(vn * vn + 2 * dec * 0.82 * Math.min(1, wg * 1.04) * seg[i]);
        if (v[i] > lim) v[i] = lim;
      }
      for (let q = 0; q < 2 * n; q++) {
        const i = q % n, j = (q + 1) % n;
        const vi = v[i];
        const acc = Math.max(0.5, engineAccel(vi) - coastDecel(vi) - 9.81 * this.G[i]);
        const lim = Math.sqrt(vi * vi + 2 * acc * seg[i]);
        if (v[j] > lim) v[j] = lim;
      }
    }
    return v;
  }

  computeSpeedProfile() {
    const seg = this.raceSeg || new Float32Array(this.n).fill(this.ds);
    this.speedProfile = this.speedProfileFor(this.raceKappa, seg);
    let t = 0;
    for (let i = 0; i < this.n; i++) t += seg[i] / Math.max(1, (this.speedProfile[i] + this.speedProfile[(i + 1) % this.n]) / 2);
    this.idealLapTime = t;
  }
}

export function signedCurvature(P, n, k) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = ((i - k) % n + n) % n, c = (i + k) % n;
    const ax = P[2 * a], az = P[2 * a + 1], bx = P[2 * i], bz = P[2 * i + 1], cx = P[2 * c], cz = P[2 * c + 1];
    const cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    const ab = Math.hypot(bx - ax, bz - az), bc = Math.hypot(cx - bx, cz - bz), ca = Math.hypot(ax - cx, az - cz);
    const den = ab * bc * ca;
    out[i] = den < 1e-9 ? 0 : (2 * cross) / den;
  }
  // smooth
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = -2; j <= 2; j++) s += out[((i + j) % n + n) % n];
    sm[i] = s / 5;
  }
  return sm;
}
