// Visual feedback: skid marks, tyre smoke, sparks and the coloured racing-line assist.

import * as THREE from 'three';

const WHEELS = [[0.8, -1.78], [-0.8, -1.78], [0.82, 1.8], [-0.82, 1.8]]; // [left, forward]

function softTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

class Particles {
  constructor(max, { color, additive, gravity, tex, opacity = 1 }) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.age = new Float32Array(max).fill(1e9);
    this.life = new Float32Array(max).fill(1);
    this.grow = new Float32Array(max);
    this.floor = new Float32Array(max).fill(-1e9);
    this.next = 0;
    this.gravity = gravity;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, color: { value: new THREE.Color(color) }, scale: { value: 600 }, opacity: { value: opacity } },
      vertexShader: `attribute float size; attribute float alpha; varying float vA;
        uniform float scale;
        void main() { vA = alpha; vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * scale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D map; uniform vec3 color; uniform float opacity; varying float vA;
        void main() { vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(color * t.rgb, t.a * vA * opacity); if (gl_FragColor.a < 0.01) discard; }`,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }
  emit(x, y, z, vx, vy, vz, size, life, grow = 0, floor = -1e9) {
    const i = this.next;
    this.floor[i] = floor;
    this.next = (this.next + 1) % this.max;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.size[i] = size; this.life[i] = life; this.age[i] = 0; this.grow[i] = grow;
  }
  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.age[i] > this.life[i]) { this.alpha[i] = 0; continue; }
      this.age[i] += dt;
      const k = i * 3;
      this.vel[k + 1] -= this.gravity * dt;
      const drag = Math.exp(-1.6 * dt);
      this.vel[k] *= drag; this.vel[k + 2] *= drag;
      this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      if (this.pos[k + 1] < this.floor[i]) { this.pos[k + 1] = this.floor[i]; this.vel[k] *= 0.5; this.vel[k + 1] = 0; this.vel[k + 2] *= 0.5; }
      this.size[i] += this.grow[i] * dt;
      const t = this.age[i] / this.life[i];
      this.alpha[i] = Math.max(0, (1 - t) * Math.min(1, t * 8));
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.size.needsUpdate = true;
    g.attributes.alpha.needsUpdate = true;
  }
}

class SkidMarks {
  constructor(max = 2400) {
    this.max = max;
    this.pos = new Float32Array(max * 6 * 3);
    this.col = new Float32Array(max * 6 * 4);
    this.next = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.prev = new Map();
  }
  add(key, x, y, z, rx, rz, alpha, t) {
    const p = this.prev.get(key);
    this.prev.set(key, { x, y, z, rx, rz, t, alpha });
    if (!p || t - p.t > 0.06 || Math.hypot(x - p.x, z - p.z) > 6) return;
    const w = 0.17;
    const a = [p.x + p.rx * w, p.y, p.z + p.rz * w], b = [p.x - p.rx * w, p.y, p.z - p.rz * w];
    const c = [x + rx * w, y, z + rz * w], d = [x - rx * w, y, z - rz * w];
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos.set([...a, ...c, ...b, ...b, ...c, ...d], i * 18);
    const a0 = p.alpha, a1 = alpha;
    const shade = 0.06;
    this.col.set([shade, shade, shade, a0, shade, shade, shade, a1, shade, shade, shade, a0, shade, shade, shade, a0, shade, shade, shade, a1, shade, shade, shade, a1], i * 24);
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }
  clear() {
    this.pos.fill(0); this.col.fill(0); this.prev.clear();
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }
}

// coloured racing line (green = accelerate, yellow = lift, red = brake)
class RacingLine {
  constructor(track) {
    this.track = track;
    const n = track.n;
    const rows = n + 1;
    this.pos = new Float32Array(rows * 2 * 3);
    this.col = new Float32Array(rows * 2 * 4);
    for (let r = 0; r < rows; r++) {
      const i = r % n;
      const o = track.raceOffset[i];
      const x = track.P[2 * i] + track.N[2 * i] * o, z = track.P[2 * i + 1] + track.N[2 * i + 1] * o;
      const y = track.Y[i] + 0.045;
      const hw = 0.45;
      this.pos.set([x + track.N[2 * i] * hw, y, z + track.N[2 * i + 1] * hw, x - track.N[2 * i] * hw, y, z - track.N[2 * i + 1] * hw], r * 6);
    }
    const idx = [];
    for (let r = 0; r < n; r++) idx.push(2 * r, 2 * r + 2, 2 * r + 1, 2 * r + 1, 2 * r + 2, 2 * r + 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -10,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.lastFrom = 0;
  }
  update(car, factor) {
    const T = this.track, n = T.n;
    const ahead = 230; // samples (~460 m)
    for (let k = -5; k < ahead + 10; k++) { const r = (this.lastFrom + k + n) % n; this.col.fill(0, r * 8, r * 8 + 8); }
    const from = car.idx;
    this.lastFrom = from;
    const v = Math.max(0, car.vf);
    for (let k = -4; k < ahead; k++) {
      const i = (from + k + n) % n;
      const dist = Math.max(1, k * T.ds);
      const vt = T.speedProfile[i] * factor;
      const need = (v * v - vt * vt) / (2 * dist);
      let c;
      if (need > 15) c = [0.95, 0.12, 0.1];
      else if (need > 6) c = [1, 0.78, 0.1];
      else c = [0.15, 0.85, 0.3];
      const a = k < 0 ? 0 : Math.min(1, k / 6) * (1 - k / ahead) * 0.75;
      for (const r of i === 0 ? [0, n] : [i]) {
        this.col.set([...c, a, ...c, a], r * 8);
      }
    }
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }
}

export class Effects {
  constructor(scene, track) {
    this.group = new THREE.Group();
    scene.add(this.group);
    const tex = softTexture();
    this.smoke = new Particles(500, { color: 0xd8d8d8, additive: false, gravity: -0.6, tex });
    this.sparks = new Particles(400, { color: 0xffa040, additive: true, gravity: 9.8, tex });
    this.spray = new Particles(1200, { color: 0xc4c9d0, additive: false, gravity: -0.3, tex, opacity: 0.22 });
    this.debris = new Particles(160, { color: 0x15171b, additive: false, gravity: 9.8, tex });
    this.skids = new SkidMarks();
    this.line = new RacingLine(track);
    this.group.add(this.smoke.points, this.sparks.points, this.spray.points, this.debris.points, this.skids.mesh, this.line.mesh);
    this.time = 0;
  }

  setLineVisible(on) { this.line.mesh.visible = on; }

  // ctx: { wet: 0..1, night: bool, models: car models (for debris from broken wings) }
  update(dt, cars, player, lineFactor, ctx = {}) {
    this.time += dt;
    const wet = ctx.wet || 0;
    this.spray.mat.uniforms.color.value.set(ctx.night ? 0x3c424c : 0xc4c9d0);
    for (const [ci, c] of cars.entries()) {
      const s = Math.abs(c.vf);
      const sinH = Math.sin(c.h), cosH = Math.cos(c.h);
      const lx = cosH, lz = -sinH; // car's left
      const slip = c.slip;
      const skid = slip > 0.3 && s > 6 && wet < 0.35;
      // spray from the rear tyres on a wet track (grows with speed)
      if (wet > 0.12 && s > 12) {
        const rate = wet * Math.min(1, (s - 12) / 45) * (c === player ? 1 : 0.8);
        const n = Math.floor(rate * 1.6 + Math.random());
        for (let k = 0; k < n; k++) {
          const side = Math.random() < 0.5 ? 1 : -1;
          const x = c.x + lx * side * 0.8 - sinH * 2.1, z = c.z + lz * side * 0.8 - cosH * 2.1;
          this.spray.emit(x, c.y + 0.35, z, c.vx * 0.35 + (Math.random() - 0.5) * 3, 0.8 + Math.random() * 1.6, c.vz * 0.35 + (Math.random() - 0.5) * 3,
            0.8 + Math.random() * 0.8, 0.5 + Math.random() * 0.6, 3.5 + s * 0.04);
        }
      }
      // carbon debris when a wing breaks
      const model = ctx.models?.[ci];
      if (model && model.debris > 0) {
        for (let k = 0; k < model.debris; k++) {
          this.debris.emit(c.x + sinH * 2.6 + (Math.random() - 0.5), c.y + 0.3, c.z + cosH * 2.6 + (Math.random() - 0.5),
            c.vx * 0.7 + (Math.random() - 0.5) * 5, 1.5 + Math.random() * 3, c.vz * 0.7 + (Math.random() - 0.5) * 5, 0.12 + Math.random() * 0.12, 2.5 + Math.random() * 1.5, 0, c.y + 0.06);
        }
        model.debris = 0;
      }
      for (let w = 0; w < 4; w++) {
        const [ol, of] = WHEELS[w];
        const front = w >= 2;
        const x = c.x + lx * ol + sinH * of, z = c.z + lz * ol + cosH * of;
        if (skid && (!front || c.lockup || slip > 0.7)) {
          this.skids.add(`${ci}:${w}`, x, c.y + 0.035, z, lx, lz, Math.min(0.75, (slip - 0.2) * 1.1), this.time);
          if (!front && Math.random() < slip * 0.9 * (c === player ? 1 : 0.4) * (1 - wet)) {
            this.smoke.emit(x, c.y + 0.3, z, -c.vx * 0.15 + (Math.random() - 0.5), 0.6 + Math.random() * 0.6, -c.vz * 0.15 + (Math.random() - 0.5), 0.9 + Math.random() * 0.6, 1.2 + Math.random() * 0.8, 2.6);
          }
        }
      }
      // sparks: wall contact or the plank touching the ground at high speed
      if (c.wallHit > 1.2) {
        for (let k = 0; k < Math.min(30, c.wallHit * 3); k++) {
          const side = c.d > 0 ? 1 : -1;
          this.sparks.emit(c.x + lx * side, c.y + 0.4, c.z + lz * side, c.vx * 0.6 + (Math.random() - 0.5) * 6, 1 + Math.random() * 4, c.vz * 0.6 + (Math.random() - 0.5) * 6, 0.12, 0.35 + Math.random() * 0.3);
        }
      }
      if (s > 62 && (c.kerb > 0 || Math.random() < 0.02 * (s - 62) / 30)) {
        for (let k = 0; k < 3; k++) {
          const x = c.x - sinH * 1.6, z = c.z - cosH * 1.6;
          this.sparks.emit(x, c.y + 0.05, z, c.vx * 0.85 + (Math.random() - 0.5) * 3, 0.5 + Math.random() * 2, c.vz * 0.85 + (Math.random() - 0.5) * 3, 0.09, 0.25 + Math.random() * 0.2);
        }
      }
    }
    this.smoke.update(dt);
    this.sparks.update(dt);
    this.spray.update(dt);
    this.debris.update(dt);
    if (this.line.mesh.visible) this.line.update(player, lineFactor);
  }

  reset() { this.skids.clear(); }

  dispose(scene) {
    scene.remove(this.group);
    this.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  }
}
