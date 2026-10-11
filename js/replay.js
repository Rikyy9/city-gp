// Race replay with TV trackside cameras, chase and helicopter views.

import * as THREE from 'three';
import { mulberry32 } from './geo.js';
import { setDamageVisual, updateCarLights } from './carModel.js';

const STRIDE = 10; // floats per car per frame (see main.js recording)

const lerpAngle = (a, b, t) => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
};

export class ReplayViewer {
  constructor({ camera, track, rec, models, cars }) {
    this.camera = camera;
    this.T = track;
    this.rec = rec;
    this.models = models;
    this.cars = cars;
    this.t = rec.times[0] || 0;
    this.end = rec.times[rec.times.length - 1] || 0;
    this.playing = true;
    this.speed = 1;
    this.focus = cars.findIndex((c) => c.isPlayer);
    this.mode = 'tv';
    this.cam = null;
    this.chaseH = 0;
    // trackside cameras every ~170 m, alternating sides, varying height
    const rnd = mulberry32(17);
    this.cams = [];
    for (let s = 20, k = 0; s < track.length; s += 150 + rnd() * 60, k++) {
      const side = k % 2 ? 1 : -1;
      const p = track.pointAt(s, side * (track.wallOff + 4 + rnd() * 6));
      this.cams.push({ s, pos: new THREE.Vector3(p.x, p.y + 7 + rnd() * 9, p.z) });
    }
    this.look = new THREE.Vector3();
  }

  frameAt(t) {
    const ts = this.rec.times;
    let lo = 0, hi = ts.length - 1;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (ts[m] <= t) lo = m; else hi = m; }
    const a = ts[lo], b = ts[hi];
    return { i: lo, j: hi, f: b > a ? Math.min(1, Math.max(0, (t - a) / (b - a))) : 0 };
  }

  carState(k, fr) {
    const A = this.rec.frames[fr.i], B = this.rec.frames[fr.j], o = k * STRIDE, f = fr.f;
    return {
      x: A[o] + (B[o] - A[o]) * f, y: A[o + 1] + (B[o + 1] - A[o + 1]) * f, z: A[o + 2] + (B[o + 2] - A[o + 2]) * f,
      h: lerpAngle(A[o + 3], B[o + 3], f), pitch: A[o + 4], delta: A[o + 5], wheel: A[o + 6] + (B[o + 6] - A[o + 6]) * f, drs: A[o + 7],
      wing: A[o + 8], susp: A[o + 9],
    };
  }

  update(dt) {
    if (this.playing) this.t = Math.min(this.end, this.t + dt * this.speed);
    if (this.t >= this.end) this.playing = false;
    const fr = this.frameAt(this.t);
    this.fr = fr;
    const wx = this.rec.wx?.[fr.i];
    let focus = null;
    this.models.forEach((m, k) => {
      const c = this.carState(k, fr);
      m.group.position.set(c.x, c.y, c.z);
      m.group.rotation.order = 'YXZ';
      m.group.rotation.y = c.h;
      m.group.rotation.x = -c.pitch;
      for (const w of m.wheels) w.rotation.x = c.wheel;
      for (const p of m.steerPivots) p.rotation.y = c.delta;
      if (m.flap) m.flap.rotation.x = c.drs ? 0.06 : 0.55;
      const side = c.wing < 0 || c.susp < 0 ? -1 : 1;
      setDamageVisual(m, Math.abs(c.wing), Math.abs(c.susp), side);
      m.debris = 0;
      updateCarLights(m, { brake: 0, vf: 0, limiter: 0, tyre: null }, dt, { wet: wx ? wx[3] : 0, time: this.t });
      if (k === this.focus) focus = c;
    });
    if (!focus) return;
    const cam = this.camera;
    const target = new THREE.Vector3(focus.x, focus.y + 0.8, focus.z);
    if (this.mode === 'tv') {
      const s = this.T.project(focus.x, focus.z, this.T.nearestGlobal(focus.x, focus.z)).s;
      const L = this.T.length;
      const dist = this.cam ? this.cam.pos.distanceTo(target) : Infinity;
      const passed = this.cam ? ((s - this.cam.s + L) % L) : Infinity;
      if (!this.cam || dist > 170 || (passed > 70 && passed < L / 2)) {
        // pick the next camera ahead of the car
        let best = null, bd = Infinity;
        for (const c of this.cams) {
          const ahead = (c.s - s + L) % L;
          if (ahead < 160 && ahead < bd) { bd = ahead; best = c; }
        }
        this.cam = best || this.cams[0];
      }
      cam.position.copy(this.cam.pos);
      this.look.lerp(target, this.look.lengthSq() ? 0.35 : 1);
      cam.lookAt(this.look);
      const d = cam.position.distanceTo(target);
      cam.fov = Math.max(6, Math.min(55, (2 * Math.atan(5.5 / d) * 180) / Math.PI));
    } else if (this.mode === 'heli') {
      this.chaseH = lerpAngle(this.chaseH, focus.h, Math.min(1, dt * 1.5));
      cam.position.set(focus.x - Math.sin(this.chaseH) * 45, focus.y + 38, focus.z - Math.cos(this.chaseH) * 45);
      cam.lookAt(target);
      cam.fov = 40;
    } else {
      this.chaseH = lerpAngle(this.chaseH, focus.h, Math.min(1, dt * 6));
      cam.position.set(focus.x - Math.sin(this.chaseH) * 7, focus.y + 2.3, focus.z - Math.cos(this.chaseH) * 7);
      cam.lookAt(focus.x + Math.sin(this.chaseH) * 5, focus.y + 1.1, focus.z + Math.cos(this.chaseH) * 5);
      cam.fov = 62;
    }
    cam.near = 0.1;
    cam.updateProjectionMatrix();
  }

  get focusName() { return this.cars[this.focus]?.name || ''; }
  nextCar(dir) { this.focus = (this.focus + dir + this.cars.length) % this.cars.length; this.cam = null; }
  cycleMode() { this.mode = { tv: 'chase', chase: 'heli', heli: 'tv' }[this.mode]; this.cam = null; }
  seek(f) { this.t = this.rec.times[0] + (this.end - this.rec.times[0]) * f; }
  get progress() { return (this.t - this.rec.times[0]) / Math.max(0.001, this.end - this.rec.times[0]); }
}
