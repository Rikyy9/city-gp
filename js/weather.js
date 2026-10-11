// Weather: rain schedule, track wetness and tyre crossover, plus the visual layer
// (cloud dome, rain streaks) that follows the camera.

import * as THREE from 'three';
import { mulberry32 } from './geo.js';
import { tyreGrip } from './physics.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Weather {
  // mode: 'dry' | 'wet' | 'variable'; duration = expected session length (s) to place the shower
  constructor(mode = 'dry', { duration = 300, seed = 1 } = {}) {
    this.mode = mode;
    const rnd = mulberry32(seed);
    this.events = [];
    this.baseCloud = 0.22;
    if (mode === 'wet') {
      const peak = 0.7 + rnd() * 0.25;
      this.events.push({ t0: -1e9, t1: 1e9, peak });
      this.rain = peak; this.wet = 0.85; this.cloud = 1;
    } else {
      this.rain = 0; this.wet = 0; this.cloud = this.baseCloud;
    }
    if (mode === 'variable') {
      this.baseCloud = 0.5;
      this.cloud = 0.5;
      if (rnd() < 0.3) {
        // damp start that dries out, then a late shower
        this.wet = 0.45 + rnd() * 0.2;
        this.events.push({ t0: -1e9, t1: 20 + rnd() * 30, peak: 0.35 });
        const t0 = duration * (0.55 + rnd() * 0.2);
        this.events.push({ t0, t1: t0 + duration * (0.3 + rnd() * 0.3), peak: 0.5 + rnd() * 0.4 });
      } else {
        const t0 = duration * (0.15 + rnd() * 0.3);
        this.events.push({ t0, t1: t0 + duration * (0.3 + rnd() * 0.35), peak: 0.55 + rnd() * 0.45 });
      }
    }
    this.forecastSaid = new Set();
  }

  // scheduled rain intensity at time t (45 s fade in, 40 s fade out)
  rainAt(t) {
    let r = 0;
    for (const e of this.events) r = Math.max(r, e.peak * smooth(e.t0, e.t0 + 45, t) * (1 - smooth(e.t1 - 40, e.t1, t)));
    return r;
  }

  update(dt, t) {
    const target = this.rainAt(t);
    this.rain += (target - this.rain) * Math.min(1, dt * 0.6);
    // clouds build up ~1 minute before the rain
    const soon = this.rainAt(t + 70);
    const cloudT = Math.max(this.baseCloud, soon > 0.02 ? 0.8 + 0.2 * soon : 0, this.rain > 0.02 ? 1 : 0);
    this.cloud += (cloudT - this.cloud) * Math.min(1, dt / 25);
    // the track soaks in ~40 s of heavy rain and dries in a few minutes (faster on the racing line)
    if (this.rain > this.wet) this.wet += (this.rain - this.wet) * dt / 40;
    else this.wet += (this.rain - this.wet) * dt / 170;
    this.wet = Math.min(1, Math.max(0, this.wet));
  }

  get overcast() { return Math.min(1, Math.max(0, (this.cloud - 0.5) / 0.5)); }
  grip(tyre) { return tyreGrip(tyre, this.wet); }
  bestGrip() { return Math.max(tyreGrip('slick', this.wet), tyreGrip('inter', this.wet)); }
  bestTyre(wet = this.wet) { return tyreGrip('inter', wet) > tyreGrip('slick', wet) ? 'inter' : 'slick'; }
  // tyre choice at a pit stop also looks a little ahead
  pitTyre(t) { return this.bestTyre(Math.max(this.wet, Math.min(0.6, this.rainAt(t + 60) * 0.8))); }

  snapshot() { return { rain: this.rain, wet: this.wet, cloud: this.cloud }; }
  restore(s) { Object.assign(this, s); }
}

// ---------------------------------------------------------------- cloud dome
const CLOUD_VS = `varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;
const CLOUD_FS = `uniform float time; uniform float cover; uniform float dark; uniform float night; uniform float skyMix;
uniform vec3 sunDir; uniform vec3 sunColor;
varying vec3 vDir;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int k = 0; k < 6; k++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return v;
}
void main() {
  if (vDir.y < -0.02) discard;
  vec2 uv = vDir.xz / (vDir.y + 0.12) * 1.6;
  vec2 wind = vec2(time * 0.006, time * 0.002);
  float d = fbm(uv + wind);
  float d2 = fbm(uv * 1.9 - wind * 1.6 + 4.0);
  float shape = d * 0.75 + d2 * 0.25;
  float c = smoothstep(1.0 - cover - 0.08, 1.0 - cover + 0.3, shape);
  c = mix(c, 1.0, smoothstep(0.85, 1.0, cover) * 0.85);
  c *= smoothstep(-0.02, 0.18, vDir.y);
  float thick = smoothstep(0.35, 1.0, shape);
  float sun = pow(max(dot(normalize(vDir), sunDir), 0.0), 6.0);
  vec3 lit = mix(vec3(1.0), sunColor, 0.35);
  vec3 col = mix(lit, vec3(0.42, 0.45, 0.5), thick * 0.7 + dark * 0.4);
  col = mix(col, vec3(0.3, 0.32, 0.36), dark * 0.6);
  col += sunColor * sun * (1.0 - thick) * 0.6 * (1.0 - dark);
  col = mix(col, vec3(0.05, 0.055, 0.07) + vec3(0.06, 0.04, 0.02) * (1.0 - vDir.y), night);
  // daytime: a deeper blue gradient over the physical sky (which is very pale at midday)
  float h = clamp(vDir.y, 0.0, 1.0);
  float sd = max(dot(normalize(vDir), sunDir), 0.0);
  vec3 sky = mix(vec3(0.62, 0.74, 0.88), vec3(0.09, 0.25, 0.62), pow(h, 0.5));
  sky = mix(sky, vec3(0.45, 0.48, 0.52), dark);
  sky += sunColor * (pow(sd, 8.0) * 0.25 + pow(sd, 300.0) * 1.5 + smoothstep(0.9994, 0.9997, sd) * 12.0) * (1.0 - dark);
  float ca = c * (0.92 - 0.25 * night);
  float a = 1.0 - (1.0 - skyMix) * (1.0 - ca);
  vec3 outc = (sky * skyMix * (1.0 - ca) + col * ca) / max(a, 0.001);
  gl_FragColor = vec4(outc, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class CloudDome {
  constructor() {
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 }, cover: { value: 0.3 }, dark: { value: 0 }, night: { value: 0 }, skyMix: { value: 0 },
        sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: new THREE.Color(1, 1, 1) },
      },
      vertexShader: CLOUD_VS, fragmentShader: CLOUD_FS,
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      // blended but kept in the opaque pass so it draws right after the sky and under the ground layers
      transparent: false, blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(5000, 48, 24), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -9; // after the sky, before the ground layers
  }
  update(dt, camera, { cover, dark, night, sunDir, sunColor, skyMix = 0 }) {
    const u = this.mat.uniforms;
    u.time.value += dt;
    u.cover.value = cover; u.dark.value = dark; u.night.value = night; u.skyMix.value = skyMix;
    u.sunDir.value.copy(sunDir);
    u.sunColor.value.copy(sunColor);
    this.mesh.position.copy(camera.position);
  }
}

// ---------------------------------------------------------------- rain streaks around the camera
const RAIN_VS = `uniform float time; uniform vec3 camPos; uniform vec3 tail; uniform float boxR; uniform float boxH;
attribute float seed; attribute float tip;
varying float vA;
void main() {
  float fall = 11.0 + seed * 4.0;
  float y = mod(position.y - time * fall, boxH);
  vec3 p = vec3(camPos.x + mod(position.x - camPos.x, 2.0 * boxR) - boxR,
                camPos.y - boxH * 0.35 + y,
                camPos.z + mod(position.z - camPos.z, 2.0 * boxR) - boxR);
  p += tail * tip * (0.7 + seed * 0.6);
  float dist = length(p - camPos);
  vA = smoothstep(0.6, 2.5, dist) * (1.0 - smoothstep(boxR * 0.6, boxR, dist)) * (0.45 + 0.55 * seed);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const RAIN_FS = `uniform float opacity; uniform vec3 color; varying float vA;
void main() { gl_FragColor = vec4(color, vA * opacity); }`;

export class RainStreaks {
  constructor(count = 9000) {
    const pos = new Float32Array(count * 6), seed = new Float32Array(count * 2), tip = new Float32Array(count * 2);
    const R = 38, H = 26;
    for (let i = 0; i < count; i++) {
      const x = Math.random() * 2 * R, y = Math.random() * H, z = Math.random() * 2 * R, s = Math.random();
      pos.set([x, y, z, x, y, z], i * 6);
      seed[i * 2] = seed[i * 2 + 1] = s;
      tip[i * 2] = 0; tip[i * 2 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    g.setAttribute('tip', new THREE.BufferAttribute(tip, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 }, camPos: { value: new THREE.Vector3() }, tail: { value: new THREE.Vector3(0, 0.5, 0) },
        boxR: { value: R }, boxH: { value: H }, opacity: { value: 0 }, color: { value: new THREE.Color(0.75, 0.8, 0.88) },
      },
      vertexShader: RAIN_VS, fragmentShader: RAIN_FS, transparent: true, depthWrite: false, fog: false,
    });
    this.mesh = new THREE.LineSegments(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.count = count;
    this.prevCam = new THREE.Vector3();
    this.vel = new THREE.Vector3();
  }
  // rain: 0..1 intensity, night: 0..1 (darker drops)
  update(dt, camera, rain, night) {
    const u = this.mat.uniforms;
    u.time.value += dt;
    if (dt > 0) {
      const v = camera.position.clone().sub(this.prevCam).divideScalar(dt);
      if (v.length() < 150) this.vel.lerp(v, Math.min(1, dt * 8));
    }
    this.prevCam.copy(camera.position);
    u.camPos.value.copy(camera.position);
    // streak direction: falling drop seen from the moving camera
    const k = 0.045;
    u.tail.value.set(this.vel.x * k, 0.55 + this.vel.y * k, this.vel.z * k).clampLength(0, 3.2);
    u.opacity.value = Math.min(0.75, rain * 0.9) * (night ? 0.65 : 1);
    u.color.value.setRGB(...(night ? [0.55, 0.6, 0.7] : [0.78, 0.82, 0.9]));
    this.mesh.visible = rain > 0.02;
    // fewer drops in light rain
    this.mesh.geometry.setDrawRange(0, Math.floor(this.count * Math.min(1, 0.25 + rain)) * 2);
  }
}
