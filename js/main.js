// City GP — app flow: map & track generation → world loading → race.

import * as THREE from 'three';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import '@fontsource/titillium-web/400.css';
import '@fontsource/titillium-web/600.css';
import '@fontsource/titillium-web/700.css';
import '@fontsource/titillium-web/700-italic.css';
import '@fontsource/titillium-web/900.css';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { makeProjection, bboxAround, bboxOfXZ, hashString, mulberry32 } from './geo.js';
import { fetchRoads, fetchScenery, searchPlaces, reverseCity } from './osm.js';
import { buildGraph, generateCandidates, orientTrack, resampleClosed } from './trackgen.js';
import { Track } from './track.js';
import { Car, resolveCarCollisions, updateDraft, brakeDecel } from './physics.js';
import { Weather, CloudDome, RainStreaks } from './weather.js';
import { Radio, sayGap, posWord } from './radio.js';
import { lbGet, lbSubmit, lbBestSectors, lbSaveSector, lbTouch, lbList, lbClear } from './records.js';
import { PadNav } from './padnav.js';
import { MAP_TEMPLATE, MAP_TILE, MAP_ATTRIBUTION, SATELLITE_TEMPLATE, SATELLITE_ATTRIBUTION } from './config.js';
import { Effects } from './fx.js';
import { AIDriver, followLine, PERSONALITIES } from './ai.js';
import { createCarModel, updateCarModel, setCarEnvironment, setCarEnvIntensity, setDamageVisual, updateCarLights } from './carModel.js';
import { buildWorld, disposeObject, setWetness, updateMarshals } from './world.js';
import { buildHeightfield, trackProfile, makeGround } from './terrain.js';
import { parseScenery } from './scenery.js';
import { lon2tile, lat2tile, tile2lon, tile2lat } from './geo.js';
import { GameAudio } from './audio.js';
import { Input, defaultBindings } from './input.js';
import { TouchControls, isTouchDevice } from './touch.js';
import { createOptions } from './options.js';
import { CircuitEditor } from './editor.js';
import { ReplayViewer } from './replay.js';

const $ = (s) => document.querySelector(s);

// bundlers rename Leaflet's marker images: point the default icon at the imported files
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({ iconUrl: markerIcon, iconRetinaUrl: markerIcon2x, shadowUrl: markerShadow });

// ---------------------------------------------------------------- fatal errors (no WebGL, crashes during start-up)
function fatal(title, text) {
  const el = document.getElementById('fatal');
  if (!el) return;
  el.querySelector('h2').textContent = title;
  el.querySelector('p').textContent = text;
  el.classList.remove('hidden');
}
function webglAvailable() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}
if (!webglAvailable()) {
  fatal('Grafica 3D non disponibile', 'Il tuo browser o il tuo dispositivo non supporta WebGL. Prova con una versione recente di Chrome, Edge, Firefox o Safari e controlla che l’accelerazione hardware sia attiva.');
  throw new Error('WebGL non disponibile');
}
const store = {
  get(k, d) { try { const v = localStorage.getItem('citygp:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('citygp:' + k, JSON.stringify(v)); return true; } catch { return false; } },
};

const TEAM_COLORS = [
  [0xe10600, 0xffffff], [0x00a19c, 0xdfe6e9], [0xff8000, 0x1e5bc6], [0x1e41ff, 0xffd400],
  [0x0b6e4f, 0xd4af37], [0x0090ff, 0xff2d55], [0xd8dadc, 0x111111], [0x9b1c31, 0xffffff],
  [0xffd400, 0x111111], [0x7c3aed, 0xffffff], [0xf472b6, 0x1e293b],
];
const DRIVER_NAMES = ['Rossi', 'Bianchi', 'Ferrari', 'Esposito', 'Romano', 'Colombo', 'Ricci', 'Marino', 'Greco', 'Gallo', 'Conti'];
const CAND_COLORS = ['#e10600', '#1e90ff', '#ffb000', '#22c55e'];
const SKILL = { easy: [0.8, 0.86], medium: [0.87, 0.92], hard: [0.93, 0.98] };

const S = {
  screen: 'map',
  center: null,
  cityName: '',
  roadsCache: new Map(),
  sceneryCache: new Map(),
  cands: [],
  sel: -1,
  reverse: false,
  seed: 1,
  trackDef: null,
  track: null,
  world: null,
  race: null,
  camMode: 0,
  camH: 0,
  camY: 0,
  camBack: 0,
  headX: 0,
  headZ: 0,
  lookCur: new THREE.Vector3(),
  intro: { shots: [], k: 0, t: 0 },
  paused: false,
  fly: 0,
  settings: Object.assign({
    mode: 'race', opponents: 5, difficulty: 'medium', laps: 3, tod: 'day', color: 0,
    model: 'arcade', assists: 'medium', line: 'on', wear: 'normal', units: 'kmh', quali: 'on', adaptive: 'on', limits: 'on',
    quality: isTouchDevice() ? 'medium' : 'high', fov: 0, shake: 'on', blur: 'on', autoRes: 'on',
    weather: 'dry', damage: 'on', radio: 'voice', commentary: 'on',
    sens: 1, padLayout: 'triggers', touch: 'auto', bindings: defaultBindings(),
    padDeadzone: 0.08, padCurve: 1.5, padSmooth: 0.04, trigDeadzone: 0.04, rumble: 1,
    // touch controls & driving aids (mobile defaults follow the big mobile racers: auto-gas + brake assist)
    touchScheme: 'buttons', touchSize: 'm', touchOpacity: 0.6, lefty: 'off', haptics: 'on', tiltSens: 1, tiltInvert: 'off',
    autoAccel: 'on', brakeAssist: isTouchDevice() ? 'light' : 'off', steerAssist: 'off', fps: 60,
    vol: { master: 0.8, engine: 0.8, fx: 0.8, opponents: 0.6, radio: 0.9 },
  }, store.get('settings', {})),
};
S.settings.vol = { radio: 0.9, ...S.settings.vol };
if (!store.get('settings', null)) S.settings.quality = guessQuality();

// first launch: pick a graphics preset from the GPU / device
function guessQuality() {
  if (isTouchDevice()) return 'medium';
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    if (/swiftshader|llvmpipe|software|basic render/i.test(name)) return 'low';
    if (/intel(?!.*(arc|iris xe))|mali|adreno [1-5]|powervr/i.test(name)) return 'medium';
  } catch { /* ignore */ }
  return 'high';
}

// ====================================================================== renderer & scene
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$('#game').appendChild(renderer.domElement);
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 9000);

// reflections for the car paint
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  setCarEnvironment(pmrem.fromScene(new RoomEnvironment(), 0.04).texture);
}

// ---------------------------------------------------------------- post-processing & quality
// colour grade + radial speed blur (sharp centre, streaking edges) + faint film grain
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, vignette: { value: 0.35 }, saturation: { value: 1.08 },
    blur: { value: 0 }, center: { value: new THREE.Vector2(0.5, 0.55) }, grain: { value: 0.018 }, time: { value: 0 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float vignette; uniform float saturation; uniform float blur; uniform vec2 center;
    uniform float grain; uniform float time; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      if (blur > 0.002) {
        vec2 d = vUv - center;
        float k = blur * smoothstep(0.1, 0.75, length(d));
        vec3 acc = c.rgb;
        for (int i = 1; i <= 7; i++) acc += texture2D(tDiffuse, vUv - d * k * 0.085 * float(i) / 7.0).rgb;
        c.rgb = acc / 8.0;
        c.r = mix(c.r, texture2D(tDiffuse, vUv + d * k * 0.006).r, 0.6);
        c.b = mix(c.b, texture2D(tDiffuse, vUv - d * k * 0.006).b, 0.6);
      }
      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114)); c.rgb = mix(vec3(l), c.rgb, saturation);
      float v = smoothstep(0.95, 0.3, length(vUv - 0.5) * 1.3); c.rgb *= mix(1.0 - vignette, 1.0, v);
      float n = fract(sin(dot(vUv * 1000.0 + time, vec2(12.9898, 78.233))) * 43758.5453);
      c.rgb += (n - 0.5) * grain;
      gl_FragColor = c; }`,
};
const QUALITY = {
  high: { pr: Math.min(window.devicePixelRatio, 2), samples: 4, shadow: 4096, post: true },
  medium: { pr: Math.min(window.devicePixelRatio, 1.5), samples: 2, shadow: 2048, post: true },
  low: { pr: 1, samples: 0, shadow: 1024, post: false },
};
// phones and tablets: smaller shadow maps (the GPU is shared with a hot, battery-powered SoC)
if (isTouchDevice()) {
  QUALITY.high = { pr: Math.min(window.devicePixelRatio, 2), samples: 2, shadow: 2048, post: true };
  QUALITY.medium = { pr: Math.min(window.devicePixelRatio, 1.5), samples: 2, shadow: 1024, post: true };
  QUALITY.low = { pr: Math.min(window.devicePixelRatio, 1), samples: 0, shadow: 512, post: false };
}
const post = { composer: null, bloom: null, resScale: 1 };
function applyQuality(q) {
  const Q = QUALITY[q] || QUALITY.high;
  post.basePr = Q.pr;
  post.resScale = 1;
  renderer.setPixelRatio(Q.pr);
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (env.sun.shadow.mapSize.x !== Q.shadow) {
    env.sun.shadow.mapSize.set(Q.shadow, Q.shadow);
    env.sun.shadow.map?.dispose();
    env.sun.shadow.map = null;
  }
  post.composer?.dispose();
  post.composer = null;
  if (!Q.post) return;
  const rt = new THREE.WebGLRenderTarget(window.innerWidth * Q.pr, window.innerHeight * Q.pr, { type: THREE.HalfFloatType, samples: Q.samples });
  const comp = new EffectComposer(renderer, rt);
  comp.setPixelRatio(Q.pr);
  comp.setSize(window.innerWidth, window.innerHeight);
  comp.addPass(new RenderPass(scene, camera));
  post.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.2, 0.45, 0.9);
  comp.addPass(post.bloom);
  comp.addPass(new OutputPass());
  post.grade = new ShaderPass(GradeShader);
  comp.addPass(post.grade);
  post.composer = comp;
  setBloomForTime(S.settings.tod);
}
// automatic resolution: scale the pixel ratio when the frame rate drops
function setResScale(k) {
  k = Math.max(0.55, Math.min(1, k));
  if (Math.abs(k - post.resScale) < 0.01) return;
  post.resScale = k;
  const pr = (post.basePr || 1) * k;
  renderer.setPixelRatio(pr);
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (post.composer) { post.composer.setPixelRatio(pr); post.composer.setSize(window.innerWidth, window.innerHeight); }
}
const perf = { acc: 0, frames: 0, slow: 0 };
function trackPerformance(dt) {
  if (S.settings.autoRes !== 'on' || S.screen !== 'race' || S.paused) { perf.acc = perf.frames = 0; return; }
  perf.acc += dt; perf.frames++;
  if (perf.acc < 2) return;
  const fps = perf.frames / perf.acc;
  perf.acc = perf.frames = 0;
  if (fps < 45) setResScale(post.resScale - 0.1);
  else if (fps > 58 && post.resScale < 1) setResScale(post.resScale + 0.05);
}

function setBloomForTime(tod) {
  if (!post.bloom) return;
  const b = { day: [0.16, 0.45, 0.92], sunset: [0.32, 0.5, 0.85], night: [0.9, 0.55, 0.55] }[tod] || [0.16, 0.45, 0.92];
  [post.bloom.strength, post.bloom.radius, post.bloom.threshold] = b;
}
function renderFrame() {
  if (post.composer) post.composer.render();
  else renderer.render(scene, camera);
}

class Environment {
  constructor() {
    this.hemi = new THREE.HemisphereLight(0xcfe3ff, 0x6b5b4b, 0.9);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.5);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -110; sc.right = 110; sc.top = 110; sc.bottom = -110; sc.near = 1; sc.far = 900;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.sky = new Sky();
    this.sky.scale.setScalar(8000);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10; // before the (non depth-writing) ground layers
    const sp = new Float32Array(1800 * 3);
    const r = mulberry32(11);
    for (let i = 0; i < 1800; i++) {
      const th = r() * Math.PI * 2, ph = Math.acos(r() * 0.95);
      sp.set([Math.sin(ph) * Math.cos(th) * 6000, Math.cos(ph) * 6000, Math.sin(ph) * Math.sin(th) * 6000], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false }));
    this.stars.frustumCulled = false;
    this.stars.material.transparent = true;
    this.dir = new THREE.Vector3();
    this.clouds = new CloudDome();
    this.rain = new RainStreaks();
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envTex = null;
    this.envOvercast = -1;
    this.wx = { cloud: 0.22, overcast: 0, rain: 0, wet: 0 };
    scene.add(this.hemi, this.sun, this.sun.target, this.sky, this.stars, this.clouds.mesh, this.rain.mesh);
  }

  set(tod) {
    this.tod = tod;
    const u = this.sky.material.uniforms;
    let elev, az;
    if (tod === 'sunset') {
      elev = 9; az = 250;
      this.hemi.color.set(0xffd2b0); this.hemi.groundColor.set(0x4a3a40); this.hemi.intensity = 1.1;
      this.sun.color.set(0xffa463); this.sun.intensity = 2.8;
      u.turbidity.value = 9; u.rayleigh.value = 2.6; u.mieCoefficient.value = 0.006; u.mieDirectionalG.value = 0.85;
      scene.fog = new THREE.Fog(0xd5a283, 450, 4200); this.fogNear = 450; this.fogFar = 4200;
      renderer.toneMappingExposure = 0.95;
    } else if (tod === 'night') {
      elev = 38; az = 200;
      this.hemi.color.set(0x7088c0); this.hemi.groundColor.set(0x1c1c26); this.hemi.intensity = 1.25;
      this.sun.color.set(0xaabfff); this.sun.intensity = 0.7;
      scene.fog = new THREE.Fog(0x0a1124, 300, 3200); this.fogNear = 300; this.fogFar = 3200;
      renderer.toneMappingExposure = 1.0;
    } else {
      elev = 50; az = 145;
      this.hemi.color.set(0xd6e8ff); this.hemi.groundColor.set(0x6b5b4b); this.hemi.intensity = 0.95;
      this.sun.color.set(0xfff3e0); this.sun.intensity = 2.6;
      u.turbidity.value = 4; u.rayleigh.value = 1.2; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.8;
      scene.fog = new THREE.Fog(0xb9cde2, 700, 4800); this.fogNear = 700; this.fogFar = 4800;
      renderer.toneMappingExposure = 0.85;
    }
    this.dir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elev), THREE.MathUtils.degToRad(az));
    u.sunPosition.value.copy(this.dir);
    const night = tod === 'night';
    this.sky.visible = !night;
    this.stars.visible = night;
    scene.background = night ? new THREE.Color(0x060a18) : null;
    // clear-weather values; applyWeather() blends towards overcast from here
    this.base = {
      sunI: this.sun.intensity, sunC: this.sun.color.clone(), hemiI: this.hemi.intensity, hemiC: this.hemi.color.clone(),
      fogC: scene.fog.color.clone(), fogNear: this.fogNear, fogFar: this.fogFar, exposure: renderer.toneMappingExposure,
      turb: u.turbidity.value, ray: u.rayleigh.value,
    };
    this.envOvercast = -1;
    this.applyWeather(this.wx);
  }

  // w: { cloud, overcast, rain, wet } — grey sky, softer sun, closer fog
  applyWeather(w) {
    this.wx = w;
    const B = this.base;
    if (!B) return;
    const o = w.overcast, night = this.tod === 'night';
    this.sun.intensity = B.sunI * (1 - 0.82 * o);
    this.hemi.intensity = B.hemiI * (1 + 0.15 * o);
    this.hemi.color.copy(B.hemiC).lerp(new THREE.Color(night ? 0x5a6478 : 0xb8c0cc), o * 0.8);
    scene.fog.color.copy(B.fogC).lerp(new THREE.Color(night ? 0x0c1018 : 0x8d949d), o);
    this.fogNear = B.fogNear * (1 - 0.6 * o * Math.max(0.4, w.rain));
    this.fogFar = B.fogFar * (1 - 0.55 * o - 0.15 * w.rain);
    renderer.toneMappingExposure = B.exposure * (1 - 0.1 * o);
    const u = this.sky.material.uniforms;
    u.turbidity.value = B.turb + 8 * o;
    u.rayleigh.value = B.ray * (1 - 0.6 * o);
    if ('intensity' in this.sun.shadow) this.sun.shadow.intensity = 1 - 0.7 * o;
    this.stars.material.opacity = 1 - o;
    // refresh the sky reflection used by the wet road when the sky changed noticeably
    if (Math.abs(o - this.envOvercast) > 0.12) this.updateEnvMap(o);
  }

  // prefiltered sky (with clouds) for reflections on the wet asphalt
  updateEnvMap(o) {
    this.envOvercast = o;
    const sc = new THREE.Scene();
    const night = this.tod === 'night';
    if (night) sc.background = new THREE.Color(0x0a0e18);
    else sc.add(this.sky);
    this.clouds.mesh.position.set(0, 0, 0);
    this.clouds.mat.uniforms.cover.value = Math.min(1, 0.25 + 0.75 * this.wx.cloud);
    this.clouds.mat.uniforms.dark.value = o;
    this.clouds.mat.uniforms.skyMix.value = this.tod === 'day' ? 0.85 : 0;
    this.clouds.mat.uniforms.sunDir.value.copy(this.dir);
    sc.add(this.clouds.mesh);
    const old = this.envTex;
    this.envTex = this.pmrem.fromScene(sc, 0.02, 1, 20000).texture;
    scene.add(this.sky, this.clouds.mesh);
    old?.dispose();
  }

  // per-frame: clouds and rain follow the camera
  update(dt, cam) {
    const w = this.wx, night = this.tod === 'night';
    this.clouds.update(dt, cam, {
      cover: Math.min(1, 0.25 + 0.75 * w.cloud), dark: w.overcast, night: night ? 1 : 0, skyMix: this.tod === 'day' ? 0.85 : 0,
      sunDir: this.dir, sunColor: this.tod === 'sunset' ? new THREE.Color(1, 0.62, 0.35) : new THREE.Color(1, 0.97, 0.9),
    });
    this.rain.update(dt, cam, w.rain, night);
  }

  // push the fog away when the camera is high (aerial shots)
  adaptFog(height) {
    const h = Math.max(0, height);
    scene.fog.near = this.fogNear + h * 2.5;
    scene.fog.far = this.fogFar + h * 5;
  }

  follow(x, z, y = 0) {
    this.sun.position.set(x + this.dir.x * 400, y + this.dir.y * 400, z + this.dir.z * 400);
    this.sun.target.position.set(x, y, z);
    this.sun.target.updateMatrixWorld();
  }
}
const env = new Environment();
env.set(S.settings.tod);

const audio = new GameAudio();
const input = new Input();
const radio = new Radio({ el: document.getElementById('hud-radio'), audio });
function applyControlSettings() {
  const st = S.settings;
  input.setBindings(st.bindings);
  input.padLayout = st.padLayout;
  input.sensitivity = st.sens;
  input.deadzone = st.padDeadzone;
  input.linearity = st.padCurve;
  input.smoothing = st.padSmooth;
  input.trigDeadzone = st.trigDeadzone;
  input.rumbleStrength = st.rumble;
  audio.setVolumes(st.vol);
  radio.configure({ mode: st.radio, commentary: st.commentary === 'on', volume: st.vol.radio });
  document.body.classList.toggle('lefty-on', st.lefty === 'on');
  touch.configure({
    scheme: st.touchScheme, autoAccel: st.autoAccel === 'on', size: st.touchSize, opacity: st.touchOpacity,
    lefty: st.lefty === 'on', haptics: st.haptics === 'on', tiltSens: st.tiltSens, tiltInvert: st.tiltInvert === 'on',
  });
}
input.onPadChange = (p) => toast(p ? '🎮 Gamepad collegato' : 'Gamepad scollegato', 2000);
const touch = new TouchControls($('#touch'), input);
applyControlSettings();
const touchWanted = () => S.settings.touch === 'on' || (S.settings.touch === 'auto' && isTouchDevice());

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  post.composer?.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});
applyQuality(S.settings.quality);

// ====================================================================== UI helpers
function show(id, on = true) { $(id).classList.toggle('hidden', !on); }
let toastTimer;
function toast(text, ms = 3200) {
  const t = $('#toast');
  t.textContent = text;
  show('#toast');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => show('#toast', false), ms);
}
function setScreen(name) {
  S.screen = name;
  const tOn = name === 'race' && touchWanted();
  touch.show(tOn);
  document.body.classList.toggle('touch-on', tOn);
  show('#screen-map', name === 'map');
  show('#screen-loading', name === 'loading');
  show('#screen-setup', name === 'setup');
  show('#hud', name === 'race');
  show('#screen-pause', false);
  show('#screen-results', false);
  $('#game').style.visibility = name === 'map' ? 'hidden' : 'visible';
  if (name === 'map') { audio.silence(); keepScreenOn(false); setTimeout(() => map.invalidateSize(), 50); }
}
const fmtTime = (t) => {
  if (!Number.isFinite(t)) return '–';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
};
const fmtKm = (m) => (m / 1000).toLocaleString('it-IT', { maximumFractionDigits: 2, minimumFractionDigits: 2 }) + ' km';
const hex = (c) => '#' + c.toString(16).padStart(6, '0');

// ====================================================================== MAP SCREEN
const map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([45.4642, 9.19], 12);
const osmLayer = L.tileLayer(MAP_TEMPLATE, { maxZoom: 19, attribution: MAP_ATTRIBUTION }).addTo(map);
const satLayer = L.tileLayer(SATELLITE_TEMPLATE, { maxZoom: 19, attribution: SATELLITE_ATTRIBUTION });
L.control.layers({ Mappa: osmLayer, Satellite: satLayer }, {}, { position: 'topright' }).addTo(map);

let centerMarker = null, areaRect = null;
let candLayers = [], arrowLayer = null;

const targetLen = () => +$('#len-range').value;
const areaRadius = () => Math.max(1500, Math.min(3200, targetLen() * 0.5));

function setCenter(lat, lon, name) {
  S.center = { lat, lon };
  S.cityName = name || '';
  if (!centerMarker) {
    centerMarker = L.marker([lat, lon], { draggable: true }).addTo(map);
    centerMarker.on('dragend', () => {
      const p = centerMarker.getLatLng();
      setCenter(p.lat, p.lng, null);
    });
  } else centerMarker.setLatLng([lat, lon]);
  updateArea();
}

function updateArea() {
  if (!S.center) return;
  const b = bboxAround(S.center.lat, S.center.lon, areaRadius());
  const bounds = [[b.s, b.w], [b.n, b.e]];
  if (!areaRect) areaRect = L.rectangle(bounds, { color: '#e10600', weight: 1.5, fill: false, dashArray: '6 6', interactive: false }).addTo(map);
  else areaRect.setBounds(bounds);
}

map.on('click', (e) => {
  if (editor.active) editor.click(e.latlng);
  else setCenter(e.latlng.lat, e.latlng.lng, null);
});
const editor = new CircuitEditor(map, {
  getRoads: () => loadRoads(),
  onStatus: (msg, err) => { const el = $('#editor-status'); el.textContent = msg; el.classList.toggle('error', !!err); },
  onDone: (cand, roads) => {
    show('#editor-tools', false);
    show('#btn-editor');
    const c = { ...cand, proj: roads.proj, city: S.cityName || 'Città', name: 'Il mio circuito' };
    S.cands = [c, ...S.cands.filter((x) => !x.custom)].slice(0, 5);
    S.reverse = false;
    renderCands();
    selectCand(0);
    setStatus('Circuito disegnato pronto! Premi “Prepara la gara”.', 1);
  },
});
$('#btn-editor').addEventListener('click', async () => {
  if (!S.center) { toast('Scegli prima una città'); return; }
  show('#editor-tools');
  show('#btn-editor', false);
  for (const l of candLayers) l.setStyle({ opacity: 0.15 });
  const ok = await editor.start();
  show('#gen-status', false);
  if (!ok) { show('#editor-tools', false); show('#btn-editor'); }
});
$('#btn-ed-undo').addEventListener('click', () => editor.undo());
$('#btn-ed-close').addEventListener('click', () => editor.close());
$('#btn-ed-exit').addEventListener('click', () => { editor.stop(); show('#editor-tools', false); show('#btn-editor'); for (const l of candLayers) l.setStyle({ opacity: 0.75 }); });
setCenter(45.4642, 9.19, 'Milano');

$('#len-range').addEventListener('input', () => {
  $('#len-out').textContent = (targetLen() / 1000).toLocaleString('it-IT') + ' km';
  updateArea();
});

$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#search-input').value.trim();
  if (!q) return;
  const ul = $('#search-results');
  ul.innerHTML = '<li>Cerco…</li>';
  show('#search-results');
  try {
    const res = await searchPlaces(q);
    ul.innerHTML = '';
    if (!res.length) { ul.innerHTML = '<li>Nessun risultato</li>'; return; }
    for (const r of res) {
      const li = document.createElement('li');
      li.textContent = r.display_name;
      li.addEventListener('click', () => {
        const lat = +r.lat, lon = +r.lon;
        const name = (r.address && (r.address.city || r.address.town || r.address.village)) || r.name || r.display_name.split(',')[0];
        setCenter(lat, lon, name);
        map.setView([lat, lon], 13);
        show('#search-results', false);
      });
      ul.appendChild(li);
    }
  } catch (err) {
    ul.innerHTML = `<li>Errore nella ricerca: ${err.message}</li>`;
  }
});

function setStatus(text, frac, isError = false) {
  const st = $('#gen-status');
  show('#gen-status');
  st.classList.toggle('error', isError);
  st.querySelector('span').textContent = text;
  if (frac != null) st.querySelector('.bar i').style.width = `${Math.round(frac * 100)}%`;
}

async function loadRoads() {
  const { lat, lon } = S.center;
  const radius = areaRadius();
  const key = `${lat.toFixed(4)},${lon.toFixed(4)},${radius}`;
  let entry = S.roadsCache.get(key);
  if (!entry) {
    setStatus('Scarico le strade da OpenStreetMap…', 0.05);
    const osm = await fetchRoads(bboxAround(lat, lon, radius), (m) => setStatus(m, 0.1));
    setStatus('Costruisco la rete stradale…', 0.25);
    await new Promise((r) => setTimeout(r, 0));
    const proj = makeProjection(lat, lon);
    const G = buildGraph(osm, proj);
    entry = { proj, G };
    S.roadsCache.set(key, entry);
  }
  if (!S.cityName) S.cityName = (await reverseCity(lat, lon)) || 'Città';
  return entry;
}

async function generate(newSeed) {
  if (!S.center) { toast('Scegli prima un punto sulla mappa'); return; }
  const btn = $('#btn-generate');
  btn.disabled = true; $('#btn-regen').disabled = true;
  const { lat, lon } = S.center;
  const radius = areaRadius();
  try {
    const entry = await loadRoads();
    if (!S.cityName) S.cityName = (await reverseCity(lat, lon)) || 'Città';
    S.seed = newSeed ? Math.floor(Math.random() * 1e9) : S.seed;
    const cands = await generateCandidates(entry.G, {
      target: targetLen(), radius, seed: S.seed,
      onProgress: (f, k) => setStatus(`Cerco i circuiti migliori… (${k} trovati)`, 0.3 + 0.7 * f),
    });
    if (!cands.length) {
      setStatus('Nessun circuito adatto qui: sposta il punto su una zona con viali larghi o cambia lunghezza.', 1, true);
      return;
    }
    S.cands = cands.map((c) => ({ ...c, proj: entry.proj, city: S.cityName }));
    S.reverse = false;
    setStatus(`${cands.length} circuiti trovati a ${S.cityName}`, 1);
    renderCands();
    selectCand(0);
  } catch (err) {
    console.error(err);
    setStatus(`Errore: ${err.message}. Riprova tra qualche secondo.`, 1, true);
  } finally {
    btn.disabled = false; $('#btn-regen').disabled = false;
  }
}

$('#btn-generate').addEventListener('click', () => generate(true));
$('#btn-regen').addEventListener('click', () => generate(true));
$('#btn-reverse').addEventListener('click', () => { S.reverse = !S.reverse; if (S.sel >= 0) selectCand(S.sel); });

function candName(c) {
  return c.custom ? `Il mio circuito a ${c.city}` : `Circuito di ${c.city}`;
}

function renderCands() {
  for (const l of candLayers) map.removeLayer(l);
  candLayers = [];
  const list = $('#cand-list');
  list.innerHTML = '';
  S.cands.forEach((c, i) => {
    const m = c.metrics;
    const ll = c.center.map(([x, z]) => c.proj.toLatLon(x, z));
    c.latlonRaw = ll;
    const line = L.polyline(ll.concat([ll[0]]), { color: CAND_COLORS[i], weight: 4, opacity: 0.75 }).addTo(map);
    line.on('click', (e) => { L.DomEvent.stop(e); selectCand(i); });
    candLayers.push(line);
    const div = document.createElement('div');
    div.className = 'cand';
    div.style.setProperty('--cc', CAND_COLORS[i]);
    div.innerHTML = `${trackThumb(c.center, CAND_COLORS[i])}
      <div><h4>${c.custom ? candName(c) : candName(c) + ' ' + (i + 1 - S.cands.filter((x) => x.custom).length)}</h4>
      <div class="meta"><span><b>${fmtKm(m.length)}</b></span><span><b>${m.corners.length}</b> curve</span>
      <span>rettilineo <b>${Math.round(m.longestStraight)} m</b></span><span><b>${Math.round((1 - c.minorShare) * 100)}%</b> viali</span></div>
      <div class="streets">${c.streets.slice(0, 3).join(' · ') || '&nbsp;'}</div></div>`;
    div.addEventListener('click', () => selectCand(i));
    list.appendChild(div);
  });
  show('#cands');
  setStep(1);
  const all = L.featureGroup(candLayers);
  map.fitBounds(all.getBounds(), { paddingTopLeft: [20, 20], paddingBottomRight: [20, 20] });
}

function trackThumb(pts, color) {
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (const [x, z] of pts) { a = Math.min(a, x); b = Math.max(b, x); c = Math.min(c, z); d = Math.max(d, z); }
  const sc = 60 / Math.max(b - a, d - c), ox = 37 - ((a + b) / 2) * sc, oz = 37 - ((c + d) / 2) * sc;
  const path = pts.filter((_, k) => k % 6 === 0).map(([x, z], k) => `${k ? 'L' : 'M'}${(x * sc + ox).toFixed(1)},${(z * sc + oz).toFixed(1)}`).join('') + 'Z';
  return `<svg viewBox="0 0 74 74"><path d="${path}" fill="none" stroke="rgba(0,0,0,.6)" stroke-width="6" stroke-linejoin="round"/><path d="${path}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round"/></svg>`;
}

function setStep(n) {
  document.querySelectorAll('#stepper li').forEach((li, k) => { li.classList.toggle('on', k === n); li.classList.toggle('done', k < n); });
}

function orientedLatLon(c) {
  const pts = orientTrack(c.center, S.reverse);
  return pts.map(([x, z]) => c.proj.toLatLon(x, z));
}

function selectCand(i) {
  S.sel = i;
  document.querySelectorAll('.cand').forEach((d, k) => d.classList.toggle('sel', k === i));
  candLayers.forEach((l, k) => {
    l.setStyle({ weight: k === i ? 7 : 3, opacity: k === i ? 1 : 0.45 });
    if (k === i) l.bringToFront();
  });
  if (arrowLayer) map.removeLayer(arrowLayer);
  const c = S.cands[i];
  const ll = orientedLatLon(c);
  const group = L.layerGroup();
  L.marker(ll[0], { icon: L.divIcon({ className: 'start-flag', html: '🏁', iconSize: [24, 24], iconAnchor: [6, 22] }) }).addTo(group);
  const step = Math.floor(ll.length / 8);
  for (let k = step / 2; k < ll.length; k += step) {
    const a = ll[Math.floor(k)], b = ll[(Math.floor(k) + 3) % ll.length];
    const ang = (Math.atan2(-(b[0] - a[0]), (b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180)) * 180) / Math.PI;
    L.marker(a, {
      interactive: false,
      icon: L.divIcon({ className: '', html: `<div style="transform:rotate(${ang}deg);color:#fff;font-size:16px;text-shadow:0 0 3px #000">➤</div>`, iconSize: [16, 16], iconAnchor: [8, 8] }),
    }).addTo(group);
  }
  arrowLayer = group.addTo(map);
  $('#btn-prepare').disabled = false;
}

$('#btn-prepare').addEventListener('click', () => { S.champActive = false; prepareCandidate(S.cands[S.sel]); });
function prepareCandidate(c) {
  if (!c) return;
  const latlon = orientedLatLon(c);
  const def = {
    id: trackId(latlon),
    name: candName(c),
    city: c.city,
    streets: c.streets.slice(0, 3),
    corners: c.metrics.corners.length,
    latlon,
  };
  return prepare(def);
}

function trackId(latlon) {
  const sample = latlon.filter((_, k) => k % 50 === 0).map(([a, b]) => `${a.toFixed(4)},${b.toFixed(4)}`).join(';');
  return 't' + hashString(sample).toString(36);
}

// ---------------------------------------------------------------- championship
const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
S.champ = store.get('champ', null);
function saveChamp() { store.set('champ', S.champ); renderChamp(); }
function champStandings() {
  const C = S.champ;
  const all = [{ name: 'Tu', color: TEAM_COLORS[S.settings.color][0] }, ...C.lineup];
  return all.map((d) => ({ ...d, pts: C.points[d.name] || 0 })).sort((a, b) => b.pts - a.pts);
}
function champTableHtml(limit = 99) {
  return champStandings().slice(0, limit).map((d, k) => `<div class="${d.name === 'Tu' ? 'me' : ''}"><span>${k + 1}</span><i style="background:${hex(d.color)}"></i><span>${d.name}</span><b>${d.pts}</b></div>`).join('');
}
function renderChamp() {
  const C = S.champ;
  const active = C && C.round < C.cities.length;
  show('#champ-new', !active);
  show('#champ-active', !!active);
  if (!active) return;
  $('#champ-info').textContent = `Round ${C.round + 1} di ${C.cities.length} · prossima gara: ${C.cities[C.round]}`;
  $('#champ-table').innerHTML = champTableHtml(6);
  $('#btn-champ-next').textContent = `Corri il round ${C.round + 1}: ${C.cities[C.round]} →`;
}
$('#btn-champ-start').addEventListener('click', () => {
  const cities = $('#champ-cities').value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10);
  if (cities.length < 2) { toast('Inserisci almeno 2 città separate da virgola'); return; }
  S.champ = { cities, round: 0, lineup: makeLineup(), points: {}, history: [], laps: S.settings.laps };
  saveChamp();
  toast(`Campionato creato: ${cities.length} gare`);
});
$('#btn-champ-quit').addEventListener('click', () => { S.champ = null; store.set('champ', null); renderChamp(); });
$('#btn-champ-next').addEventListener('click', () => runChampRound());
async function runChampRound() {
  const C = S.champ;
  const city = C.cities[C.round];
  try {
    setStatus(`Campionato — round ${C.round + 1}: cerco ${city}…`, 0.02);
    const res = await searchPlaces(city);
    if (!res.length) throw new Error(`città “${city}” non trovata`);
    const r = res[0];
    setCenter(+r.lat, +r.lon, (r.address && (r.address.city || r.address.town || r.address.village)) || r.name || city);
    map.setView([+r.lat, +r.lon], 13);
    S.seed = hashString(city.toLowerCase());
    await generate(false);
    if (!S.cands.length) throw new Error('nessun circuito generato');
    S.champActive = true;
    S.settings.mode = 'race';
    await prepareCandidate(S.cands[0]);
  } catch (err) {
    setStatus(`Campionato: ${err.message}`, 1, true);
  }
}
function awardChampPoints(rows) {
  const C = S.champ;
  rows.forEach((r, k) => { C.points[r.c.name] = (C.points[r.c.name] || 0) + (POINTS[k] || 0); });
  C.history.push({ city: C.cities[C.round], order: rows.map((r) => r.c.name) });
  C.round++;
  saveChamp();
}
renderChamp();

// ---------------------------------------------------------------- saved tracks
function renderSaved() {
  const saved = store.get('saved', []);
  show('#saved', saved.length > 0);
  const list = $('#saved-list');
  list.innerHTML = '';
  saved.forEach((t, k) => {
    const rec = store.get('rec:' + t.id, null);
    const div = document.createElement('div');
    div.className = 'saved-item';
    div.innerHTML = `<div class="t">${t.name}<small>${fmtKm(t.length)}${t.streets?.length ? ' · ' + t.streets[0] : ''}${rec ? ' · record ' + fmtTime(rec.time) : ''}</small></div><button class="x" title="Elimina">×</button>`;
    div.querySelector('.t').addEventListener('click', () => {
      prepare({ ...t, latlon: t.latlon });
    });
    div.querySelector('.x').addEventListener('click', () => {
      const s = store.get('saved', []);
      s.splice(k, 1);
      store.set('saved', s);
      renderSaved();
    });
    list.appendChild(div);
  });
}
renderSaved();

// ---------------------------------------------------------------- personal records (per circuit)
const WX_LABEL = { dry: '☀️ Asciutto', wet: '🌧 Bagnato' };
const MODE_LABEL = { tt: 'Giro veloce', race: 'Gara', quali: 'Qualifica' };
function renderRecords() {
  const list = lbList();
  show('#records', list.length > 0);
  const box = $('#records-list');
  box.innerHTML = '';
  for (const c of list.slice(0, 8)) {
    const div = document.createElement('div');
    div.className = 'saved-item';
    div.innerHTML = `<div class="t">${c.name}<small>${c.city || ''} · ${fmtKm(c.length)} · ${c.plays} ${c.plays === 1 ? 'sessione' : 'sessioni'}</small></div><b class="rec-time">${fmtTime(c.best.time)}</b>`;
    div.querySelector('.t').addEventListener('click', () => openRecords(c.id));
    box.appendChild(div);
  }
}
function openRecords(id) {
  const c = lbList().find((x) => x.id === id);
  if (!c) return;
  const lb = lbGet(id);
  $('#rec-title').textContent = c.name;
  $('#rec-sub').textContent = `${c.city || ''} · ${fmtKm(c.length)}${c.streets?.length ? ' · ' + c.streets.slice(0, 2).join(', ') : ''}`;
  const best = lb.entries[0]?.time;
  $('#rec-table').innerHTML = `<tr><th>#</th><th>Tempo</th><th>Distacco</th><th>Condizioni</th><th>Guida</th><th>Sessione</th><th>Data</th></tr>` + lb.entries.map((e, k) =>
    `<tr class="${k === 0 ? 'me' : ''}"><td>${k + 1}</td><td>${fmtTime(e.time)}</td><td>${k ? '+' + (e.time - best).toFixed(3) : ''}</td><td>${WX_LABEL[e.weather] || ''}</td>
    <td>${e.model === 'sim' ? 'Simulazione' : 'Arcade'}</td><td>${MODE_LABEL[e.mode] || ''}</td><td class="muted">${new Date(e.date).toLocaleDateString('it-IT')}</td></tr>`).join('');
  const sec = (lb.sectors || []).map((v) => (Number.isFinite(v) && v ? v : Infinity));
  const theo = sec.every(Number.isFinite) ? sec.reduce((a, b) => a + b, 0) : null;
  $('#rec-sectors').innerHTML = sec.some(Number.isFinite)
    ? `Settori migliori: ${sec.map((v, k) => `<b>S${k + 1}</b> ${Number.isFinite(v) ? v.toFixed(3) : '–'}`).join(' · ')}${theo ? ` · giro ideale <b class="purple">${fmtTime(theo)}</b>` : ''}` : '';
  $('#btn-rec-race').onclick = () => { show('#screen-records', false); S.champActive = false; prepare({ id: c.id, name: c.name, city: c.city, streets: c.streets || [], corners: c.corners, latlon: c.latlon }); };
  $('#btn-rec-clear').onclick = () => { if (confirm('Cancellare i tempi di questo circuito?')) { lbClear(id); show('#screen-records', false); renderRecords(); } };
  show('#screen-records');
}
$('#btn-rec-close').addEventListener('click', () => show('#screen-records', false));
renderRecords();

$('#btn-save').addEventListener('click', () => {
  const d = S.trackDef;
  if (!d) return;
  const saved = store.get('saved', []);
  if (saved.some((t) => t.id === d.id)) { toast('Circuito già salvato'); return; }
  const latlon = d.latlon.filter((_, k) => k % 2 === 0).map(([a, b]) => [+a.toFixed(6), +b.toFixed(6)]);
  saved.unshift({ id: d.id, name: d.name, city: d.city, streets: d.streets, corners: d.corners, length: S.track.length, latlon });
  if (saved.length > 25) saved.length = 25;
  if (store.set('saved', saved)) { toast('Circuito salvato ⭐'); renderSaved(); } else toast('Impossibile salvare (memoria del browser piena o disattivata)');
});

// ====================================================================== WORLD LOADING
async function prepare(def) {
  setScreen('loading');
  // canvas textures (signs, numbers, labels) need the web font ready before they are drawn
  await Promise.all(['900 italic 40px "Titillium Web"', '700 40px "Titillium Web"'].map((f) => document.fonts?.load(f))).catch(() => {});
  const setLoad = (msg, f) => { $('#load-msg').textContent = msg; $('#load-bar').style.width = `${Math.round(f * 100)}%`; drawLoadTrack(f); };
  startLoadScreen(def);
  setLoad('Preparo il tracciato…', 0.02);
  try {
    let la = 0, lo = 0;
    for (const [a, b] of def.latlon) { la += a; lo += b; }
    la /= def.latlon.length; lo /= def.latlon.length;
    const proj = makeProjection(la, lo);
    const pts = resampleClosed(def.latlon.map(([a, b]) => proj.toXZ(a, b)), 2);
    const track = new Track(pts);
    track.setGrip(1.08); // every car uses the arcade grip level
    track.computeRacingLine();
    track.dryLapTime = track.idealLapTime;

    // real elevation
    setLoad('Scarico i dati di elevazione…', 0.03);
    const b = track.bounds;
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    let nearHf = null, farHf = null;
    try {
      [nearHf, farHf] = await Promise.all([
        buildHeightfield(proj, { minX: b.minX - 750, maxX: b.maxX + 750, minZ: b.minZ - 750, maxZ: b.maxZ + 750 }, 10, 14, 2),
        buildHeightfield(proj, { minX: cx - 5800, maxX: cx + 5800, minZ: cz - 5800, maxZ: cz + 5800 }, 90, 11, 1),
      ]);
    } catch (err) { console.warn(err); }
    let base = 0;
    if (nearHf) {
      const prof = trackProfile(track, nearHf);
      base = Math.min(...prof);
      track.setElevation(prof.map((v) => v - base));
    } else toast('Dati di elevazione non disponibili: circuito in piano');
    const ground = makeGround(track, nearHf, farHf, base);

    let raw = S.sceneryCache.get(def.id);
    if (!raw) {
      setLoad('Scarico edifici, strade e monumenti da OpenStreetMap…', 0.05);
      try {
        raw = await fetchScenery(bboxOfXZ(proj, pts, 300), bboxOfXZ(proj, pts, 560), (m) => setLoad(m.replace('Scarico dati', 'Scarico edifici e monumenti'), 0.06));
        S.sceneryCache.set(def.id, raw);
      } catch (err) {
        console.warn(err);
        toast('Edifici non disponibili ora: gareggi solo con il satellite');
        raw = null;
      }
    }
    const scenery = raw ? parseScenery(raw, proj) : null;

    if (S.world) { scene.remove(S.world.group); disposeObject(S.world.group); S.world = null; }
    clearRace();
    const world = await buildWorld({
      track, proj, scenery, ground, city: def.city || 'Città', night: S.settings.tod === 'night', maxAniso: MAX_ANISO,
      lowPoly: S.settings.quality !== 'high' || isTouchDevice(),
      onProgress: (m, f) => setLoad(m, 0.08 + 0.84 * f),
    });
    scene.add(world.group);
    S.world = world;
    S.track = track;
    if (S.fx) S.fx.dispose(scene);
    S.fx = new Effects(scene, track);
    S.trackDef = def;
    S.proj = proj;
    S.ground = ground;
    lbTouch(def, track.length);
    setLoad('Preparo la minimappa…', 0.95);
    await prepareMinimap(track, proj);
    buildIntro();
    renderer.compile(scene, camera);
    showSetup();
  } catch (err) {
    console.error(err);
    setScreen('map');
    setStatus(`Errore nel caricamento: ${err.message}`, 1, true);
  }
}

const TIPS = [
  'Premi <b>Backspace</b> (o <b>F</b>) per un <b>flashback</b>: torni indietro di 3 secondi dopo un errore.',
  'La <b>traiettoria ideale</b> diventa <b>rossa</b> quando devi frenare e <b>gialla</b> quando devi alzare il piede.',
  'Stai in <b>scia</b> a un avversario (indicatore blu SCIA) per guadagnare velocità sui rettilinei.',
  'Con gli <b>aiuti bassi</b> la macchina può scivolare: dosa l\'acceleratore in uscita di curva.',
  'Frenare un attimo prima di sterzare aiuta l\'anteriore a far girare la macchina.',
  'Sul <b>bagnato</b> le slick scivolano: quando la radio lo dice, rientra ai box per le <b>intermedie</b> (banda verde).',
  'Un urto forte può rompere l\'<b>ala anteriore</b>: la macchina sottosterza finché non ripari ai box.',
  'Ogni circuito ha la sua <b>classifica personale</b> con i 10 giri migliori e i settori più veloci.',
  'Con il <b>gamepad</b> puoi regolare zona morta, progressività dello sterzo e vibrazione in ⚙ Opzioni.',
  'I <b>settori</b> diventano viola quando batti il tuo record, verdi quando migliori il giro della sessione.',
  'Cambia visuale con <b>C</b>: c\'è anche quella dall\'abitacolo.',
];
let loadState = null;
function startLoadScreen(def) {
  const c = $('#load-track');
  let a = Infinity, b = -Infinity, cc = Infinity, d = -Infinity;
  const pts = def.latlon.filter((_, k) => k % 3 === 0).map(([la, lo]) => [lo * Math.cos((la * Math.PI) / 180), -la]);
  for (const [x, y] of pts) { a = Math.min(a, x); b = Math.max(b, x); cc = Math.min(cc, y); d = Math.max(d, y); }
  const sc = Math.min((c.width - 60) / (b - a), (c.height - 60) / (d - cc));
  const ox = c.width / 2 - ((a + b) / 2) * sc, oy = c.height / 2 - ((cc + d) / 2) * sc;
  loadState = { pts: pts.map(([x, y]) => [x * sc + ox, y * sc + oy]), shown: 0 };
  $('#load-name').textContent = def.name;
  $('#load-tip').innerHTML = TIPS[Math.floor(Math.random() * TIPS.length)];
  drawLoadTrack(0);
}
function drawLoadTrack(f) {
  if (!loadState) return;
  const c = $('#load-track'), g = c.getContext('2d');
  const P = loadState.pts;
  loadState.shown = Math.max(loadState.shown, f);
  const n = Math.max(2, Math.floor(P.length * Math.min(1, loadState.shown * 1.05)));
  g.clearRect(0, 0, c.width, c.height);
  g.lineJoin = 'round'; g.lineCap = 'round';
  const path = (k) => { g.beginPath(); P.slice(0, k).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); };
  path(P.length); g.closePath(); g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 10; g.stroke();
  path(n); g.strokeStyle = '#e10600'; g.lineWidth = 5; g.shadowColor = '#ff2a1f'; g.shadowBlur = 16; g.stroke(); g.shadowBlur = 0;
  const [hx, hy] = P[n - 1];
  g.fillStyle = '#fff'; g.beginPath(); g.arc(hx, hy, 6, 0, Math.PI * 2); g.fill();
  const [sx, sy] = P[0];
  g.fillStyle = '#ffd400'; g.fillRect(sx - 7, sy - 7, 14, 14);
}

// ====================================================================== SETUP SCREEN
function showSetup() {
  setScreen('setup');
  setStep(2);
  const champ = S.champActive && S.champ;
  show('#setup-champ', !!champ);
  if (champ) {
    $('#setup-champ').textContent = `🏆 Campionato — Round ${S.champ.round + 1} di ${S.champ.cities.length}`;
    S.settings.mode = 'race';
    S.settings.laps = S.champ.laps;
    S.settings.opponents = S.champ.lineup.length;
  }
  document.querySelectorAll('[data-key="mode"], [data-key="opponents"], [data-key="laps"]').forEach((el) => el.closest('.field').classList.toggle('locked', !!champ));
  const d = S.trackDef, T = S.track;
  $('#setup-name').textContent = d.name;
  $('#setup-stats').textContent = `${fmtKm(T.length)} · ${d.corners ?? '–'} curve · ${S.world.stats.buildings.toLocaleString('it-IT')} edifici · ${S.world.stats.landmarks} luoghi famosi`;
  drawElevation(T);
  const lb = lbGet(d.id).entries;
  $('#setup-record').innerHTML = lb.length
    ? `<span>🏅 I tuoi migliori giri qui:</span> ${lb.slice(0, 3).map((e, k) => `<b>${k + 1}.</b> ${fmtTime(e.time)}${e.weather === 'wet' ? ' 🌧' : ''}`).join(' &nbsp; ')}`
    : '';
  syncSetupControls();
  createRace();
  S.intro.k = 0; S.intro.t = 0;
  setCaption(S.intro.shots[0]);
  const at = S.intro.shots[0].at(0);
  camera.position.copy(at.pos);
  S.lookCur.copy(at.look);
}

function drawElevation(T) {
  const c = $('#setup-elev'), g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const e = T.elev, rng = Math.max(e.range, 4);
  g.beginPath();
  g.moveTo(0, H);
  for (let k = 0; k <= 200; k++) {
    const y = T.Y[Math.floor((k / 200) * (T.n - 1))];
    g.lineTo((k / 200) * W, H - 8 - ((y - e.min) / rng) * (H - 22));
  }
  g.lineTo(W, H);
  g.closePath();
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, 'rgba(225,6,0,0.75)');
  grd.addColorStop(1, 'rgba(225,6,0,0.08)');
  g.fillStyle = grd;
  g.fill();
  $('#setup-elev-text').textContent = e.range < 1.5
    ? 'Circuito pianeggiante'
    : `Dislivello ${Math.round(e.range)} m · pendenza max ${Math.round(e.maxGrade * 100)}% · salita totale ${Math.round(e.climb)} m`;
}

const ASSIST_HELP = {
  high: 'Controsterzo e stabilità automatici: la macchina perdona quasi tutto. Ideale con la tastiera.',
  medium: 'Equilibrio: puoi sentire il limite delle gomme, gli aiuti intervengono solo negli errori grandi.',
  low: 'Per esperti: la macchina può derapare e girarsi. Consigliato un gamepad.',
};
function syncSetupControls() {
  $('#assist-help').textContent = ASSIST_HELP[S.settings.assists] || '';
  document.querySelectorAll('.seg').forEach((seg) => {
    const key = seg.dataset.key;
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(S.settings[key]) === b.dataset.v));
  });
  document.querySelectorAll('.race-only').forEach((el) => el.classList.toggle('hidden', S.settings.mode !== 'race'));
  document.querySelectorAll('.sim-only').forEach((el) => el.classList.toggle('hidden', S.settings.model !== 'sim'));
  const sw = $('#swatches');
  sw.innerHTML = '';
  TEAM_COLORS.slice(0, 9).forEach(([c, a], k) => {
    const b = document.createElement('button');
    b.style.background = `linear-gradient(135deg, ${hex(c)} 60%, ${hex(a)} 60%)`;
    b.classList.toggle('on', k === S.settings.color);
    b.addEventListener('click', () => { S.settings.color = k; saveSettings(); syncSetupControls(); createRace(); });
    sw.appendChild(b);
  });
}

function saveSettings() { store.set('settings', S.settings); }

document.querySelectorAll('.seg').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const key = seg.dataset.key;
    const v = b.dataset.v;
    S.settings[key] = ['opponents', 'laps'].includes(key) ? +v : v;
    saveSettings();
    syncSetupControls();
    if (key === 'tod') { env.set(v); S.world?.setNight(v === 'night'); setBloomForTime(v); }
    if (key === 'quality') applyQuality(v);
    if (key === 'line') S.fx?.setLineVisible(v === 'on');
    createRace();
  });
});

$('#btn-back-map').addEventListener('click', () => { clearRace(); S.champActive = false; setScreen('map'); setStep(S.cands.length ? 1 : 0); });
$('#btn-start').addEventListener('click', () => {
  if (S.settings.mode === 'race' && S.settings.quali === 'on') { createRace({ quali: true, keepLineup: true }); startRace(); }
  else startRace();
});

// ====================================================================== RACE
function clearRace() {
  const R = S.race;
  if (!R) return;
  for (const m of R.models) { scene.remove(m.group); }
  if (R.ghostModel) scene.remove(R.ghostModel.group);
  S.race = null;
}

const CAR_NUMBERS = [4, 7, 11, 16, 22, 31, 44, 55, 63, 77, 81];
function makeLineup() {
  const st = S.settings;
  const rnd = mulberry32((Math.random() * 1e9) | 0);
  const others = TEAM_COLORS.filter((_, k) => k !== st.color);
  const names = DRIVER_NAMES.slice().sort(() => rnd() - 0.5);
  const [lo, hi] = SKILL[st.difficulty] || SKILL.medium;
  return Array.from({ length: st.opponents }, (_, k) => ({
    name: names[k % names.length], color: others[k % others.length][0], accent: others[k % others.length][1],
    number: CAR_NUMBERS[k % CAR_NUMBERS.length], skill: lo + (hi - lo) * rnd(), persona: PERSONALITIES[Math.floor(rnd() * PERSONALITIES.length)].id,
  }));
}
// AI pace relative to what the player's car model can do
const skillFor = (d) => d.skill * (S.settings.model === 'sim' ? 0.94 : 1);

// opts: { quali: true } for a qualifying lap, { grid: [names in grid order] } after qualifying
function createRace(opts = {}) {
  clearRace();
  const T = S.track, st = S.settings;
  const quali = !!opts.quali;
  const race = st.mode === 'race' && !quali;
  if (S.champActive) S.lineup = S.champ.lineup;
  else if (!opts.keepLineup || !S.lineup || S.lineup.length !== st.opponents) S.lineup = makeLineup();
  const rnd = mulberry32((Math.random() * 1e9) | 0);
  const cars = [], models = [], drivers = [];
  const playerColor = TEAM_COLORS[st.color] || TEAM_COLORS[0];
  setCarEnvIntensity(st.tod === 'night' ? 0.22 : st.tod === 'sunset' ? 0.6 : 1);
  // weather for this session (a variable forecast places the shower within the expected race length)
  const dur = race ? st.laps * (T.dryLapTime || T.idealLapTime) * 1.06 + 15 : 240;
  const weather = new Weather(st.weather, { duration: dur, seed: (Math.random() * 1e9) | 0 });
  T.setWeatherGrip(weather.bestGrip());
  applyWeatherState(weather);
  // grid: qualifying order, or AI by pace with the player at the back
  let entries;
  if (!race) entries = [{ player: true }];
  else if (opts.grid) entries = opts.grid.map((name) => (name === 'Tu' ? { player: true } : S.lineup.find((d) => d.name === name))).filter(Boolean);
  else entries = [...S.lineup.slice().sort((a, b) => b.skill - a.skill), { player: true }];
  entries.forEach((e, k) => {
    const isPlayer = !!e.player;
    const car = new Car({
      name: isPlayer ? 'Tu' : e.name, color: isPlayer ? playerColor[0] : e.color, isPlayer,
      dynamic: isPlayer && st.model === 'sim', arcade: !(isPlayer && st.model === 'sim'), assists: st.assists, steerSens: isPlayer ? st.sens : 1,
    });
    car.wearRate = race ? ({ off: 0, normal: 0.001, high: 0.003 }[st.wear] ?? 0.001) : 0;
    car.pit = { requested: false, phase: null, timer: 0 };
    car.penalty = 0; car.strikes = 0;
    car.damageMode = st.damage;
    car.tyre = weather.bestTyre();
    car.weatherGrip = weather.grip(car.tyre);
    car.trackWet = weather.wet;
    car.sector = 0; car.sectorStart = 0; car.sectorTimes = [];
    const s = quali ? T.length - 350 : race ? T.length - 8 - k * 8 : T.length - 25;
    car.place(T, s, race ? (k % 2 ? -2.8 : 2.8) : quali ? T.raceOffset[T.pointAt(s).idx] : 0);
    if (quali) { const v0 = T.speedProfile[car.idx] * 0.85; car.vx = Math.sin(car.h) * v0; car.vz = Math.cos(car.h) * v0; car.vf = v0; }
    car.progress = s - T.length;
    car.lapsDone = 0; car.lapStart = 0; car.gap = 0; car.bucket = -1;
    cars.push(car);
    const model = createCarModel(isPlayer ? playerColor[0] : e.color, isPlayer ? playerColor[1] : e.accent, isPlayer ? 1 : e.number);
    updateCarModel(model, car, 0.016);
    scene.add(model.group);
    models.push(model);
    drivers.push(isPlayer ? null : new AIDriver(car, T, skillFor(e), rnd, PERSONALITIES.find((p) => p.id === e.persona)));
  });
  const player = cars.find((c) => c.isPlayer);
  const autoDriver = new AIDriver(player, T, 0.97, rnd); // debug: window.__citygp.S.autopilot = true
  S.race = {
    autoDriver,
    cars, models, drivers, player, laps: race ? st.laps : quali ? 1 : Infinity, mode: quali ? 'quali' : st.mode,
    phase: 'grid', t: 0, cd: 0, lightsOn: 0, goDelay: 0.4 + Math.random() * 1.2, acc: 0,
    leaderTimes: [], msgTimer: 0, finishedAt: null,
    ghostRec: [], ghostNext: 0, ghost: null, ghostModel: null,
    snaps: [], snapNext: 0, flashbacks: 0,
    rec: { cars: cars.length, frames: [], times: [], wx: [], next: 0 },
    weather, incidents: [], wxNext: 0,
    radio: { pos: 0, posSince: 0, leader: null, fastest: Infinity, said: new Set(), stint: new Set() },
    bestSectors: lbBestSectors(S.trackDef.id), sessionSectors: [Infinity, Infinity, Infinity],
  };
  updateSectorHud(true);
  S.fx?.reset();
  S.fx?.setLineVisible(st.line === 'on');
  if (st.mode === 'tt' && !quali) {
    const rec = store.get('rec:' + S.trackDef.id, null);
    if (rec && rec.ghost) S.race.ghost = { frames: rec.ghost, time: rec.time };
    const gm = createCarModel(0xb14cff, 0xffffff);
    gm.group.traverse((o) => {
      if (o.material) {
        o.material = o.material.clone();
        o.material.transparent = true;
        o.material.opacity = 0.32;
        o.material.depthWrite = false;
      }
      o.castShadow = false;
    });
    gm.group.visible = false;
    scene.add(gm.group);
    S.race.ghostModel = gm;
  }
}

function startRace() {
  if (!S.race || S.race.phase !== 'grid') createRace();
  audio.ensure();
  radio.stop();
  if (touchWanted()) {
    goFullscreen();
    if (S.settings.touchScheme === 'tilt') TouchControls.requestTiltPermission();
    showTouchTutorial();
  }
  keepScreenOn(true);
  setScreen('race');
  S.paused = false;
  const R = S.race;
  R.phase = 'countdown';
  R.cd = 0;
  R.lightsOn = 0;
  setLights(0);
  show('#start-lights', R.mode !== 'quali');
  if (R.mode === 'quali') { R.phase = 'racing'; R.t = 0; flash('QUALIFICHE — giro di lancio', 'warn', 2200); }
  $('#hud-penalty').classList.add('hidden');
  $('#hud-pos-tot').textContent = '/' + R.cars.length;
  $('#hud-lap-tot').textContent = R.mode === 'race' ? '/' + R.laps : '';
  $('#hud-pos-wrap').classList.toggle('hidden', R.mode !== 'race');
  document.querySelector('.tower').classList.toggle('tt', R.mode !== 'race');
  show('#hud-delta-wrap', R.mode === 'tt');
  show('#hud-standings', R.mode === 'race');
  $('#hud-best').classList.add('best');
  S.camH = R.player.h;
  const p = R.player;
  S.camY = p.y;
  camera.position.set(p.x - Math.sin(p.h) * 8, p.y + 3, p.z - Math.cos(p.h) * 8);
  R.announced = new Set();
  S.streetShown = '';
  input.clearPressed();
}

function setLights(k) {
  document.querySelectorAll('#start-lights i').forEach((el, i) => el.classList.toggle('on', i < k));
  if (S.world) for (const l of S.world.lights) l.mesh.material.color.set(l.column < k ? 0xff1a1a : 0x220000);
}

let msgTimer = null;
function flash(text, cls = '', ms = 1800) {
  const el = $('#hud-msg');
  el.textContent = text;
  el.className = 'msg show ' + cls;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { el.className = 'msg ' + cls; }, ms);
}

function onLap(car, lapTime) {
  const R = S.race;
  lapRadio(car, lapTime);
  if (!car.isPlayer) return;
  const secs = finishSectors(car);
  const pitLap = car.lapHadPit;
  car.lapHadPit = !!car.pit.phase;
  if (car.lapInvalid) {
    car.lapInvalid = false;
    if (car.bestLap === lapTime) car.bestLap = Math.min(Infinity, ...car.lapTimes.slice(0, -1).filter((t, i) => !(car.invalidLaps || []).includes(i)));
    (car.invalidLaps = car.invalidLaps || []).push(car.lapTimes.length - 1);
    flash(`Giro annullato (limiti della pista) ${fmtTime(lapTime)}`, 'warn', 2200);
    R.ghostRec = []; R.ghostNext = 0;
    return;
  }
  const rank = pitLap ? 0 : submitLap(lapTime, secs);
  const rec = store.get('rec:' + S.trackDef.id, null);
  const isBest = lapTime <= car.bestLap;
  if (rank === 1) {
    flash(`RECORD! ${fmtTime(lapTime)}`, 'purple', 2500);
    if (R.mode === 'tt') radio.say('Nuovo record personale su questo circuito!', 'team', { key: 'lap' });
  } else if (isBest) flash(`Giro migliore ${fmtTime(lapTime)}${rank ? ` · #${rank} nei tuoi record` : ''}`, 'purple');
  else flash(`Giro ${fmtTime(lapTime)}${rank ? ` · #${rank} nei tuoi record` : ''}`);
  // ghost of the fastest time-trial lap
  if (!rec || lapTime < rec.time) {
    const data = { time: lapTime };
    if (R.mode === 'tt' && R.ghostRec.length) data.ghost = R.ghostRec.map((v) => Math.round(v * 100) / 100);
    else if (rec && rec.ghost) data.ghost = rec.ghost;
    store.set('rec:' + S.trackDef.id, data);
    renderSaved();
  }
  renderRecords();
  if (R.mode === 'tt' && isBest) R.ghost = { frames: R.ghostRec.slice(), time: lapTime };
  R.ghostRec = [];
  R.ghostNext = 0;
  R.announced = new Set();
  if (R.mode === 'race' && car.lapsDone === R.laps - 1) setTimeout(() => flash('ULTIMO GIRO', 'warn'), 1900);
}

// closes the last sector of a lap and starts the next lap's timing
function finishSectors(car) {
  const R = S.race;
  closeSector(car, 2, R.t - car.sectorStart);
  const secs = car.sectorTimes.slice(0, 3);
  car.sector = 0; car.sectorStart = R.t; car.sectorTimes = [];
  updateSectorHud();
  return secs.length === 3 && secs.every(Number.isFinite) ? secs : null;
}

// personal leaderboard for this circuit → rank (1..10) or 0
function submitLap(time, sectors) {
  const R = S.race;
  const rank = lbSubmit(S.trackDef.id, {
    time, sectors, mode: R.mode, model: S.settings.model, weather: R.weather.wet > 0.25 ? 'wet' : 'dry',
  });
  if (rank) R.bestRank = Math.min(R.bestRank || 99, rank);
  return rank;
}

const started0 = (R) => R.phase === 'racing' || R.phase === 'done';

// ---------------------------------------------------------------- track limits (player)
function trackLimits(car, h) {
  const T = S.track, R = S.race;
  if (S.settings.limits === 'off' || !started0(R) || car.pit.phase) return;
  const insideSign = -Math.sign(T.kappa[car.idx]);
  const cutting = T.kerb[car.idx] && Math.abs(car.d) > T.halfW + 0.35 && Math.sign(car.d) === insideSign;
  car.cutTime = cutting ? (car.cutTime || 0) + h : 0;
  if (car.cutTime > 0.2 && car.lastCut !== car.lapsDone + ':' + Math.floor(car.s / 80)) {
    car.lastCut = car.lapsDone + ':' + Math.floor(car.s / 80);
    car.strikes++;
    car.lapInvalid = true;
    if (R.mode === 'race' && car.strikes > 3) {
      car.penalty += 5;
      flash('PENALITÀ +5 s — limiti della pista', 'warn', 2400);
      radio.say('Ci hanno dato cinque secondi di penalità per i limiti della pista.', 'team', { priority: 'high' });
      const el = $('#hud-penalty');
      el.textContent = `+${car.penalty} s`;
      el.classList.remove('hidden');
    } else if (R.mode === 'race') flash(`Limiti della pista — avviso ${car.strikes}/3`, 'warn', 1800);
    else flash('Limiti della pista — giro annullato', 'warn', 1800);
    audio.beep(330, 0.2);
  }
}

// ---------------------------------------------------------------- qualifying
function finishQuali(lt) {
  const R = S.race, T = S.track, p = R.player;
  R.phase = 'done';
  const valid = !p.lapInvalid;
  const secs = finishSectors(p);
  if (valid) { submitLap(lt, secs); renderRecords(); }
  const rnd = mulberry32((Math.random() * 1e9) | 0);
  const rows = S.lineup.map((d) => ({ name: d.name, color: d.color, time: (T.idealLapTime / skillFor(d)) * 1.035 * (1 + (rnd() - 0.5) * 0.012) }));
  rows.push({ name: 'Tu', color: TEAM_COLORS[S.settings.color][0], time: valid ? lt : Infinity, me: true, invalid: !valid, raw: lt });
  rows.sort((a, b) => a.time - b.time);
  S.qualiGrid = rows.map((r) => r.name);
  flash(valid ? `Tempo: ${fmtTime(lt)}` : 'Giro annullato', valid ? 'purple' : 'warn', 1800);
  setTimeout(() => showQualiResults(rows), 1600);
}

function showQualiResults(rows) {
  if (S.screen !== 'race') return;
  const pole = rows[0].time;
  const pos = rows.findIndex((r) => r.me) + 1;
  S.resultsKind = 'quali';
  $('#res-title').textContent = rows[pos - 1].invalid ? 'Qualifiche: giro annullato' : pos === 1 ? 'Pole position! 🏁' : `Qualifiche: partirai ${pos}°`;
  $('#podium').innerHTML = '';
  $('#res-table').innerHTML = `<tr><th>Pos</th><th>Pilota</th><th>Tempo</th><th>Distacco</th></tr>` + rows.map((r, k) =>
    `<tr class="${r.me ? 'me' : ''}"><td>${k + 1}</td><td><span class="sw" style="background:${hex(r.color)}"></span>${r.name}</td>
    <td>${r.invalid ? '<s>' + fmtTime(r.raw) + '</s>' : fmtTime(r.time)}</td><td>${k === 0 || !Number.isFinite(r.time) ? '' : '+' + (r.time - pole).toFixed(3)}</td></tr>`).join('');
  setResultButtons([['Vai alla gara →', 'primary', () => { createRace({ grid: S.qualiGrid, keepLineup: true }); startRace(); }],
    ['Riprova il giro', '', () => { createRace({ quali: true, keepLineup: true }); startRace(); }],
    ['Impostazioni', 'ghost', () => showSetup()]]);
  show('#screen-results');
  audio.silence();
  S.paused = true;
}

function setResultButtons(list) {
  const box = $('#res-buttons');
  box.innerHTML = '';
  for (const [label, cls, fn] of list) {
    const b = document.createElement('button');
    b.className = `btn grow ${cls}`;
    b.textContent = label;
    b.addEventListener('click', () => { show('#screen-results', false); S.paused = false; fn(); });
    box.appendChild(b);
  }
}

// ---------------------------------------------------------------- pit stops
function pitLogic(car, h) {
  const T = S.track, R = S.race, P = T.pit, L = T.length;
  if (!car.pit.phase) {
    car.limiter = 0;
    // AI strategy: tyres worn, wrong tyres for the weather, or a damaged car — with enough race left
    if (!car.isPlayer && !car.pit.requested && R.mode === 'race' && !car.finished) {
      const left = R.laps - car.lapsDone;
      const W = R.weather;
      const want = W.pitTyre(R.t);
      const tyreCall = want !== car.tyre && W.grip(want) - W.grip(car.tyre) > 0.035 && left >= 1.2;
      const wornCall = car.wearRate > 0 && car.wear > 0.62 && left >= 1.5;
      const dmgCall = car.damageMode === 'on' && (car.damage.wing > 0.45 || car.damage.susp > 0.5) && left >= 1.2;
      if (tyreCall || wornCall || dmgCall) car.pit.requested = true;
    }
    if (car.pit.requested && T.inRange(car.s, P.entry, P.entry + 40) && !car.finished) car.pit.phase = 'in';
    else return null;
  }
  car.limiter = T.inRange(car.s, P.limitStart, P.limitEnd) ? P.limit : 0;
  car.drsOpen = false; car.ersOn = false;
  car.lapHadPit = true; // in-laps and out-laps don't count for the personal leaderboard
  const toBox = (P.box - car.s + L) % L;
  if (car.pit.phase === 'in') {
    if (toBox < 1.2 || toBox > L - 15) {
      car.pit.phase = 'stop';
      // repairs take longer: new front wing, then the suspension
      const fixWing = car.damage.wing > 0.08, fixSusp = car.damage.susp > 0.08;
      car.pit.repair = fixWing || fixSusp;
      car.pit.timer = (car.isPlayer ? 2.6 : 2.4 + Math.random() * 0.8) + (fixWing ? 3.5 : 0) + (fixSusp ? 5 : 0);
      car.pit.tyre = R.weather.pitTyre(R.t);
      if (car.isPlayer) audio.beep(660, 0.15);
    } else {
      const target = Math.min(P.limit + (car.limiter ? 0 : 25), Math.sqrt(2 * 7 * Math.max(0, toBox - 1)), T.speedProfile[car.idx] * 0.9);
      return followLine(car, T, P.offset, target);
    }
  }
  if (car.pit.phase === 'stop') {
    car.pit.timer -= h;
    if (car.pit.timer <= 0) {
      car.wear = 0;
      if (car.pit.repair) car.repair();
      const changed = car.pit.tyre !== car.tyre;
      car.tyre = car.pit.tyre || car.tyre;
      car.weatherGrip = R.weather.grip(car.tyre);
      car.pit.phase = 'out';
      car.pit.requested = false;
      if (car.isPlayer) {
        audio.beep(990, 0.2);
        flash(`${changed ? (car.tyre === 'inter' ? 'Intermedie montate' : 'Slick montate') : 'Gomme nuove'}${car.pit.repair ? ' · macchina riparata' : ''}! Vai!`, '', 1600);
        R.radio.stint = new Set();
      }
    }
    return { throttle: 0, brake: 1, steer: 0, analog: true };
  }
  if (car.pit.phase === 'out') {
    if (!T.inRange(car.s, P.box - 10, P.exit)) { car.pit.phase = null; car.limiter = 0; return null; }
    const toExit = (P.exit - car.s + L) % L;
    const off = P.offset * Math.min(1, toExit / 60);
    return followLine(car, T, off, car.limiter ? P.limit : 60);
  }
  return null;
}

// ---------------------------------------------------------------- DRS
function drsLogic(car) {
  const T = S.track, R = S.race;
  if (!T.drs || !T.drs.length) return;
  const prev = car.prevS ?? car.s;
  car.prevS = car.s;
  const crossed = (x) => { const d = (car.s - prev + T.length) % T.length; return d < 30 && T.inRange(x, prev, car.s); };
  car.inDrsZone = T.drs.some((z) => T.inRange(car.s, z.start, z.end));
  for (const z of T.drs) {
    if (crossed(z.detect)) {
      let gap = Infinity;
      for (const o of R.cars) { if (o === car) continue; const g = o.progress - car.progress; if (g > 0 && g < gap) gap = g; }
      const tGap = gap / Math.max(10, car.vf);
      car.drsAvailable = !car.pit.phase && (R.mode === 'tt' || (car.lapsDone >= 1 && tGap < 1.0));
    }
    if (crossed(z.end)) { car.drsAvailable = false; car.drsOpen = false; }
  }
  if (!car.inDrsZone) car.drsOpen = false;
}

function updateRace(dt) {
  const R = S.race, T = S.track;
  const inp = applyAssists(input.read(dt), R.player);
  if (input.pressed('pause')) { pause(true); return; }
  if (input.pressed('camera')) S.camMode = (S.camMode + 1) % 3;
  if (input.pressed('mute')) { audio.setMuted(!audio.muted); toast(audio.muted ? 'Audio disattivato' : 'Audio attivo', 1200); }
  if (input.pressed('flashback') && R.phase === 'racing') flashback();
  const pl = R.player;
  if (input.pressed('pit') && started0(R) && !pl.pit.phase) {
    pl.pit.requested = !pl.pit.requested;
    flash(pl.pit.requested ? 'BOX, BOX!' : 'Pit stop annullato', pl.pit.requested ? 'warn' : '', 1200);
  }
  if (input.pressed('drs')) {
    if (pl.drsAvailable && pl.inDrsZone) { pl.drsOpen = true; audio.beep(880, 0.08); }
    else if (!pl.drsAvailable) toast(T.drs?.length ? 'DRS non disponibile: devi essere entro 1 s dall\'auto davanti al punto di rilevamento' : 'Questo circuito non ha zone DRS', 1800);
  }
  pl.ersOn = input.down('ers') && pl.battery > 0 && started0(R);
  if (input.pressed('line')) {
    S.settings.line = S.settings.line === 'on' ? 'off' : 'on';
    saveSettings();
    S.fx?.setLineVisible(S.settings.line === 'on');
    toast(S.settings.line === 'on' ? 'Traiettoria ideale attiva' : 'Traiettoria ideale nascosta', 1200);
  }
  if (input.pressed('reset') && R.phase !== 'countdown' && !R.player.pit.phase) {
    const p = R.player;
    p.place(T, T.S[p.idx], 0); // progress is kept: place() only re-syncs the arc position
  }

  // start lights
  if (R.phase === 'countdown') {
    R.cd += dt;
    const k = Math.min(5, Math.floor(R.cd));
    if (k > R.lightsOn) { R.lightsOn = k; setLights(k); audio.beep(520, 0.18); }
    if (R.cd >= 5 + R.goDelay) {
      R.phase = 'racing';
      R.t = 0;
      setLights(0);
      setTimeout(() => show('#start-lights', false), 900);
      audio.beep(1040, 0.45);
      flash('VIA!', '', 900);
      radio.say(R.weather.rain > 0.2 ? 'Semaforo verde, si parte sotto la pioggia!' : 'Si spengono i semafori… via!', 'comment', { priority: 'high' });
    }
  }
  const started = R.phase === 'racing' || R.phase === 'done';

  // weather: track wetness → grip of each car's tyres; AI speed profile follows the best tyre
  const W = R.weather;
  if (started) W.update(dt, R.t);
  for (const c of R.cars) { c.weatherGrip = W.grip(c.tyre); c.trackWet = W.wet; }
  T.setWeatherGrip(W.bestGrip());
  applyWeatherState(W);

  const h = 1 / 120;
  R.acc += dt;
  let steps = 0;
  while (R.acc >= h && steps < 12) {
    R.acc -= h; steps++;
    for (let k = 0; k < R.cars.length; k++) {
      const car = R.cars[k];
      if (!started) {
        // cars held on the grid: only rev the engines
        const thr = car.isPlayer ? inp.throttle : 0.3 + 0.2 * Math.sin(R.cd * 3 + k);
        car.throttle = thr;
        car.rpm += (4200 + 7000 * thr - car.rpm) * Math.min(1, h * 8);
        continue;
      }
      const pitIn = pitLogic(car, h);
      const ci = pitIn || (car.isPlayer ? (S.autopilot ? R.autoDriver.control(R.cars, h, started) : inp) : R.drivers[k].control(R.cars, h, started, { time: R.t, player: R.player, adaptive: S.settings.adaptive === 'on' && R.mode === 'race' }));
      car.step(h, ci, T);
      if (car.pit.phase === 'stop') { car.vx = car.vz = car.vf = 0; }
      drsLogic(car);
      if (car.wallHit > 11 && started && R.t - (car.lastIncident || -9) > 4) {
        car.lastIncident = R.t;
        R.incidents.push({ s: car.s, t: R.t });
        if (!car.isPlayer && R.mode === 'race') radio.say(`Incidente per ${car.name}! Bandiere gialle.`, 'comment', { key: 'crash' });
      }
    }
    resolveCarCollisions(R.cars);
    if (started) {
      R.t += h;
      updateDraft(R.cars);
      if (R.t >= R.snapNext && R.phase === 'racing') { R.snapNext = R.t + 0.1; takeSnapshot(); }
    }

    if (R.mode === 'quali' && !R.qStart && R.player.progress >= 0) {
      R.qStart = true; R.player.lapStart = R.t; R.player.lapInvalid = false;
      R.player.sector = 0; R.player.sectorStart = R.t; R.player.sectorTimes = [];
      flash('Giro lanciato!', '', 1200);
    }
    for (const car of R.cars) {
      // gap timing every 25 m
      const b = Math.floor(car.progress / 25);
      if (b > car.bucket && started) {
        car.bucket = b;
        if (R.leaderTimes[b] === undefined) R.leaderTimes[b] = R.t;
        car.gap = R.t - R.leaderTimes[b];
      }
      const done = Math.max(0, Math.floor(car.progress / T.length));
      if (started && done > car.lapsDone) {
        car.lapsDone = done;
        const lt = R.t - car.lapStart;
        car.lapStart = R.t;
        car.lapTimes.push(lt);
        car.lastLap = lt;
        if (lt < car.bestLap) car.bestLap = lt;
        if (R.mode === 'quali') { finishQuali(lt); continue; }
        onLap(car, lt);
        if (R.mode === 'race' && car.lapsDone >= R.laps && !car.finished) {
          car.finished = true;
          car.finishTime = R.t;
          if (car.isPlayer) playerFinished();
        }
      }
    }
    trackLimits(R.player, h);
    if (started) playerSectors(R.player);
    // replay recording (20 Hz)
    if (started && R.mode !== 'quali' && R.t >= R.rec.next) {
      R.rec.next = R.t + 0.05;
      const f = new Float32Array(R.cars.length * 10);
      R.cars.forEach((c, i) => f.set([c.x, c.y, c.z, c.h, c.pitch, c.delta || 0, c.wheelRot, c.drsOpen ? 1 : 0,
        c.damage.wing * c.damage.side, c.damage.susp * c.damage.side], i * 10));
      R.rec.frames.push(f);
      R.rec.times.push(R.t);
      R.rec.wx.push([W.cloud, W.overcast, W.rain, W.wet]);
    }
    // ghost recording (time trial)
    if (R.mode === 'tt' && started) {
      const p = R.player;
      const tl = R.t - p.lapStart;
      while (tl >= R.ghostNext) {
        R.ghostNext += 0.05;
        R.ghostRec.push(p.x, p.z, p.h, p.progress - p.lapsDone * T.length);
      }
    }
  }

  // visuals
  const vis = { wet: W.wet, time: R.t };
  for (let k = 0; k < R.cars.length; k++) updateCarModel(R.models[k], R.cars[k], dt, vis);
  const p = R.player;
  if (p.wallHit > 1.5) { audio.impact(p.wallHit); input.rumble(Math.min(1, p.wallHit / 10), 0.5 + Math.min(0.5, p.damageHit * 2), 220); }
  input.feedback(p, started);
  // phone vibration (Android): impacts and kerbs
  if (touch.haptics && document.body.classList.contains('touch-on') && navigator.userActivation?.hasBeenActive !== false) {
    const now = performance.now();
    if (p.wallHit > 2.5 && now > (S.buzzAt || 0)) { navigator.vibrate?.(Math.min(90, 20 + p.wallHit * 5)); S.buzzAt = now + 250; }
    else if (p.kerb > 0.3 && now > (S.buzzAt || 0)) { navigator.vibrate?.(12); S.buzzAt = now + 110; }
  }
  audio.update(p, true, camera, R.cars, W.wet, W.rain);
  S.fx?.update(dt, R.cars, p, p.dynamic ? 0.88 : 0.99, { wet: W.wet, night: S.settings.tod === 'night', models: R.models });
  if (S.world.marshals) updateMarshals(S.world.marshals, dt, R.t, T, R.incidents.filter((i) => R.t - i.t < 10).map((i) => i.s));
  if (started && R.phase === 'racing') raceRadio(dt);
  post.speed = Math.abs(p.vf);
  updateGhost();
  updateCamera(dt, p);
  env.follow(p.x, p.z, p.y);
  updateLabels();
  updateHud();
  updatePlaceInfo();
}

// ---------------------------------------------------------------- driving aids (mobile-style)
// brake assist (Real Racing style): brakes for the corner ahead when you arrive too fast;
// steering assist (Mario Kart style): gently pulls the car towards the racing line.
const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);
function applyAssists(inp, p) {
  const st = S.settings, T = S.track, R = S.race;
  p.assistBraking = false;
  if (!R || !started0(R) || p.pit.phase || p.finished) return inp;
  const out = { ...inp };
  const v = Math.max(0, p.vf);
  if (st.brakeAssist !== 'off' && v > 10 && p.wrongWay === 0) {
    const full = st.brakeAssist === 'full';
    // the speed profile assumes an undamaged car on the best tyres: scale to this car's real grip
    const gripK = Math.sqrt(Math.min(1, p.damageGrip(0.12, 0.08) * p.weatherGrip / (T.weatherGrip || 1)));
    const scale = (p.dynamic ? 0.9 : 1) * (full ? 0.92 : 0.97) * gripK;
    let need = 0;
    for (let k = 2; k < 170; k += 2) {
      const i = T.wrap(p.idx + k);
      const vt = T.speedProfile[i] * scale;
      if (v <= vt) continue;
      const n = (v * v - vt * vt) / (2 * k * T.ds);
      if (n > need) need = n;
    }
    const dec = brakeDecel(v) * 0.8 * Math.min(1, p.weatherGrip * 1.04);
    if (need > dec * (full ? 0.78 : 0.88)) {
      out.brake = Math.max(out.brake, clampN(0.45 + (need / dec - 0.85) * 2, 0.35, 1));
      out.throttle = 0;
      p.assistBraking = true;
    } else if (full && need > 4 && !inp.brake) out.throttle = Math.min(out.throttle, 0.35);
    // through the corner itself: no throttle above the cornering speed, brake if well above it
    const here = Math.min(T.speedProfile[p.idx], T.speedProfile[T.wrap(p.idx + 3)]) * scale;
    if (v > here + 0.5) {
      out.throttle = 0;
      if (v > here * 1.05) { out.brake = Math.max(out.brake, 0.5); p.assistBraking = true; }
    }
    // don't run into the back of a slower car in the same line
    for (const o of R.cars) {
      if (o === p) continue;
      const gap = o.progress - p.progress, closing = p.vf - o.vf;
      if (gap > 2 && gap < 40 && Math.abs(o.d - p.d) < 2.3 && closing > 0 && gap < 5 + closing * 1.1) {
        out.brake = Math.max(out.brake, clampN(closing / 12, 0.3, 1));
        out.throttle = 0;
        p.assistBraking = true;
      }
    }
  }
  if (st.steerAssist === 'on' && v > 4) {
    // pure pursuit towards the racing line (same geometry the AI uses)
    const look = 5 + v * 0.22;
    const ia = T.wrap(p.idx + Math.round(look / T.ds));
    let off = T.raceOffset[ia];
    // a slower car ahead on the line: aim for the side with more room (the player can override)
    const lim = T.halfW - 1.3;
    for (const o of R.cars) {
      const gap = o.progress - p.progress;
      if (o === p || gap < 2 || gap > 35 || Math.abs(o.d - off) > 2.6 || o.vf > p.vf + 1) continue;
      const side = o.d <= 0 ? 1 : -1; // pass on the side with more track
      off = clampN(o.d + side * 3.4, -lim, lim);
    }
    // side by side: keep a car's width
    for (const o of R.cars) {
      if (o === p || Math.abs(o.progress - p.progress) > 5) continue;
      const dd = p.d - o.d;
      if (Math.abs(dd) < 2.8) off = clampN(p.d + Math.sign(dd || 1) * (2.9 - Math.abs(dd)), -lim, lim);
    }
    const dx = T.P[2 * ia] + T.N[2 * ia] * off - p.x, dz = T.P[2 * ia + 1] + T.N[2 * ia + 1] * off - p.z;
    const sinH = Math.sin(p.h), cosH = Math.cos(p.h);
    const alpha = Math.atan2(-dx * cosH + dz * sinH, dx * sinH + dz * cosH);
    const delta = Math.atan((2 * 3.6 * Math.sin(alpha)) / Math.max(3, Math.hypot(dx, dz)));
    const maxAngle = p.dynamic ? (p.dMax || 0.42) : 0.42 / (1 + v / 22);
    const assist = clampN(delta / maxAngle, -1, 1);
    const human = inp.steer;
    // hands off = the car follows the line; any input from the player takes over proportionally
    out.steer = clampN(human + assist * (1 - Math.abs(human)), -1, 1);
    out.analog = true;
  }
  return out;
}

// weather → sky, fog, wet asphalt
function applyWeatherState(W) {
  env.applyWeather({ cloud: W.cloud, overcast: W.overcast, rain: W.rain, wet: W.wet });
  if (S.world?.wetMats) setWetness(S.world.wetMats, W.wet, env.envTex);
}

// ---------------------------------------------------------------- sectors (player)
function playerSectors(p) {
  const R = S.race, T = S.track;
  if (R.mode === 'quali' && !R.qStart) return;
  const lapDist = p.progress - p.lapsDone * T.length;
  const sec = Math.min(2, Math.max(0, Math.floor(lapDist / (T.length / 3))));
  if (sec > p.sector) {
    closeSector(p, p.sector, R.t - p.sectorStart);
    p.sector = sec;
    p.sectorStart = R.t;
  }
}
function closeSector(p, k, t) {
  const R = S.race;
  p.sectorTimes[k] = t;
  let cls = 'yellow';
  const standingStart = R.mode === 'race' && p.lapsDone === 0 && k === 0;
  if (p.lapInvalid) cls = 'invalid';
  else if (!standingStart) {
    if (t < R.bestSectors[k]) { cls = 'purple'; R.bestSectors[k] = t; lbSaveSector(S.trackDef.id, k, t); }
    else if (t < R.sessionSectors[k]) cls = 'green';
    if (t < R.sessionSectors[k]) R.sessionSectors[k] = t;
  }
  if (k === 0 || !p.sectorCls) p.sectorCls = [];
  p.sectorCls[k] = cls;
  updateSectorHud();
}
function updateSectorHud(reset) {
  const p = S.race?.player;
  const els = document.querySelectorAll('#hud-sectors i');
  els.forEach((el, k) => {
    el.className = reset || !p?.sectorCls ? '' : p.sectorCls[k] || '';
    el.classList.toggle('cur', !reset && p && p.sector === k);
  });
}

// ---------------------------------------------------------------- team radio & commentary
function raceRadio(dt) {
  const R = S.race, T = S.track, p = R.player, W = R.weather, rs = R.radio;
  const once = (key, text, kind = 'team', opts = {}) => { if (rs.said.has(key)) return; rs.said.add(key); radio.say(text, kind, opts); };
  const stint = (key, text, kind = 'team', opts = {}) => { if (rs.stint.has(key)) return; rs.stint.add(key); radio.say(text, kind, opts); };
  // weather
  if (W.mode !== 'dry') {
    if (W.rain < 0.05 && W.rainAt(R.t + 60) > 0.15 && R.t > 5) once('forecast:' + Math.floor(R.t / 300), 'Il radar dice pioggia in arrivo tra circa un minuto.', 'team', { priority: 'high' });
    if (W.rain > 0.2 && R.t > 5) once('rainstart', 'Inizia a piovere sul circuito!', 'comment');
    if (W.rain < 0.05 && W.wet < 0.3 && rs.said.has('rainstart')) once('drying', 'La pioggia si è fermata, la pista si sta asciugando.', 'comment');
    if (!p.pit.phase && !p.pit.requested && !p.finished) {
      const want = W.pitTyre(R.t);
      if (want !== p.tyre && W.grip(want) - W.grip(p.tyre) > 0.035 && (R.mode !== 'race' || R.laps - p.lapsDone >= 1)) {
        stint('tyre:' + want, want === 'inter' ? 'Box, box! La pista è bagnata: rientra per le intermedie. Premi il tasto pit.' : 'La pista è asciutta: box per le gomme slick quando vuoi.', 'team', { priority: 'high' });
      }
    }
  }
  // tyres & damage
  if (p.wearRate > 0 && p.wear > 0.7 && R.laps - p.lapsDone >= 1) stint('wear', 'Le gomme sono finite, valuta il pit stop.', 'team');
  const D = p.damage;
  if (p.damageMode !== 'off' && (D.wing > 0.35 || D.susp > 0.35)) {
    const what = D.wing >= D.susp ? 'all’ala anteriore' : 'alla sospensione';
    stint('damage', p.damageMode === 'on' ? `Abbiamo danni ${what}: rientra ai box per riparare.` : `Danni ${what}, ma la macchina è a posto.`, 'team', { priority: 'high' });
  }
  if (R.mode !== 'race') return;
  // positions (debounced)
  const order = standingsOrder();
  const pos = order.indexOf(p) + 1;
  if (pos !== rs.pos) { rs.pend = pos; rs.posSince = rs.posSince || R.t; }
  if (rs.pend && rs.pend !== rs.pos && R.t - rs.posSince > 1.5) {
    if (rs.pos && R.t > 8) {
      if (rs.pend < rs.pos) {
        const passed = order[rs.pend];
        radio.say(`Sorpasso! Ora sei ${posWord(rs.pend)}${passed && rs.pend === rs.pos - 1 ? `, hai passato ${passed.name}` : ''}.`, 'comment', { key: 'pos' });
      } else {
        const by = order[rs.pend - 2];
        radio.say(`${by && !by.isPlayer ? by.name + ' ti passa' : 'Hai perso una posizione'}: sei ${posWord(rs.pend)}.`, 'comment', { key: 'pos' });
      }
    }
    rs.pos = rs.pend; rs.posSince = 0;
  } else if (rs.pend === rs.pos) rs.posSince = 0;
  const leader = order[0];
  if (rs.leader && leader !== rs.leader && !leader.isPlayer && R.t > 10) radio.say(`${leader.name} prende il comando della gara!`, 'comment', { key: 'lead' });
  if (leader.isPlayer && rs.leader && rs.leader !== leader) radio.say('Sei in testa alla gara!', 'team', { key: 'lead', priority: 'high' });
  rs.leader = leader;
  // AI mistakes close to the player
  R.drivers.forEach((d) => {
    if (!d || !d.mistakeEvent) return;
    const ev = d.mistakeEvent; d.mistakeEvent = null;
    if (Math.abs(d.car.progress - p.progress) < 250) radio.say(ev === 'wide' ? `${d.car.name} va lungo!` : `${d.car.name} blocca le ruote in staccata!`, 'comment', { key: 'mistake', priority: 'low', ttl: 3000 });
  });
  if (p.drsAvailable && !rs.said.has('drs')) once('drs', 'DRS disponibile: aprilo sul rettilineo!', 'team', { priority: 'low', ttl: 4000 });
}

// lap message from the engineer
function lapRadio(car, lapTime) {
  const R = S.race;
  if (R.mode !== 'race') return;
  // fastest lap of the race (any car)
  if (car.lapsDone > 1 && lapTime < R.radio.fastest) {
    R.radio.fastest = lapTime;
    if (car.isPlayer) radio.say(`Giro più veloce della gara: ${fmtTime(lapTime)}!`, 'team', { key: 'fl' });
    else radio.say(`Giro più veloce per ${car.name}.`, 'comment', { key: 'fl', priority: 'low' });
  } else if (car.lapsDone === 1 && lapTime < R.radio.fastest) R.radio.fastest = lapTime;
  if (!car.isPlayer || car.lapsDone >= R.laps) return;
  const order = standingsOrder();
  const k = order.indexOf(car);
  const ahead = order[k - 1], behind = order[k + 1];
  let msg = car.lapsDone === R.laps - 1 ? 'Ultimo giro, spingi! ' : `Giro ${car.lapsDone + 1}. `;
  msg += `Sei ${posWord(k + 1)}`;
  if (ahead && !ahead.finished) msg += `, ${sayGap(Math.max(0.1, car.gap - ahead.gap))} da ${ahead.name}`;
  else if (behind) msg += `, ${behind.name} è a ${sayGap(Math.max(0.1, behind.gap - car.gap))}`;
  radio.say(msg + '.', 'team', { key: 'lap', priority: car.lapsDone === R.laps - 1 ? 'high' : 'normal' });
}

function updateGhost() {
  const R = S.race;
  if (!R.ghostModel) return;
  const g = R.ghost;
  if (!g || R.phase !== 'racing') { R.ghostModel.group.visible = false; return; }
  const tl = R.t - R.player.lapStart;
  const f = g.frames;
  const i = Math.floor(tl / 0.05);
  if (i * 4 + 7 >= f.length) { R.ghostModel.group.visible = false; return; }
  const a = tl / 0.05 - i;
  const x = f[i * 4] * (1 - a) + f[i * 4 + 4] * a;
  const z = f[i * 4 + 1] * (1 - a) + f[i * 4 + 5] * a;
  let dh = f[i * 4 + 6] - f[i * 4 + 2];
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  R.ghostModel.group.visible = true;
  const nr = S.track.nearest(x, z, 20);
  R.ghostModel.group.position.set(x, nr ? S.track.Y[nr.idx] : R.player.y, z);
  R.ghostModel.group.rotation.y = f[i * 4 + 2] + dh * a;
}

function ghostDelta() {
  const R = S.race, T = S.track;
  if (!R.ghost || R.phase !== 'racing') return null;
  const f = R.ghost.frames;
  const dist = R.player.progress - R.player.lapsDone * T.length;
  if (dist < 20) return null;
  // first frame whose lap distance >= dist
  let lo = 0, hi = f.length / 4 - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (f[mid * 4 + 3] < dist) lo = mid + 1; else hi = mid;
  }
  if (lo === 0 || lo >= f.length / 4 - 1) return null;
  return R.t - R.player.lapStart - lo * 0.05;
}

const camTmp = new THREE.Vector3();
const camLook = new THREE.Vector3();
function updateCamera(dt, car) {
  const sp = Math.abs(car.vf);
  const shake = S.settings.shake === 'off' ? 0 : car.kerb * 0.045 + Math.max(0, sp - 60) * 0.0009;
  if (S.camMode === 2) {
    // cockpit: head moves against the G forces
    const f = [Math.sin(car.h), Math.cos(car.h)], l = [Math.cos(car.h), -Math.sin(car.h)];
    S.headX += (car.ay * 0.004 - S.headX) * Math.min(1, dt * 8);
    S.headZ += (-car.ax * 0.003 - S.headZ) * Math.min(1, dt * 8);
    const hx = -S.headX, hz = S.headZ;
    camera.position.set(car.x + f[0] * (0.1 + hz) + l[0] * hx, car.y + 1.02 + (Math.random() - 0.5) * shake * 0.5, car.z + f[1] * (0.1 + hz) + l[1] * hx);
    camLook.set(car.x + f[0] * 30, car.y + 0.75 + Math.tan(car.pitch) * 30, car.z + f[1] * 30);
    camera.lookAt(camLook);
    camera.rotateZ(-car.ay * 0.0025);
    camera.fov = 72 + Math.min(12, sp * 0.13) + S.settings.fov;
    camera.near = 0.05;
  } else {
    // chase: follow a blend of heading and velocity direction so slides are visible
    const velH = sp > 6 ? Math.atan2(car.vx, car.vz) : car.h;
    let dv = velH - car.h;
    while (dv > Math.PI) dv -= 2 * Math.PI;
    while (dv < -Math.PI) dv += 2 * Math.PI;
    const target = car.h + dv * 0.55;
    let d = S.camH - target;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    S.camH = target + d * Math.exp(-dt * 6);
    S.camBack += ((car.ax < 0 ? -0.5 : 0.35) * Math.min(1, Math.abs(car.ax) / 15) - S.camBack) * Math.min(1, dt * 3);
    const far = S.camMode === 1;
    const dist = (far ? 11.5 : 6.6) + sp * 0.014 + S.camBack;
    const hgt = (far ? 4.2 : 2.15) + sp * 0.007;
    S.camY += (car.y - S.camY) * (1 - Math.exp(-dt * 6));
    const lat = -car.ay * 0.018;
    const lx = Math.cos(S.camH), lz = -Math.sin(S.camH);
    camTmp.set(car.x - Math.sin(S.camH) * dist + lx * lat, S.camY + hgt + Math.max(0, -Math.tan(car.pitch) * dist * 0.5), car.z - Math.cos(S.camH) * dist + lz * lat);
    camera.position.lerp(camTmp, 1 - Math.exp(-dt * 30));
    camera.position.x += (Math.random() - 0.5) * shake;
    camera.position.y += (Math.random() - 0.5) * shake;
    camLook.set(car.x + Math.sin(S.camH) * 6, car.y + 1.15, car.z + Math.cos(S.camH) * 6);
    camera.lookAt(camLook);
    camera.fov = 58 + Math.min(20, sp * 0.22) + S.settings.fov;
    camera.near = 0.1;
  }
  if (car.wallHit > 2 && S.settings.shake !== 'off') {
    const k = Math.min(0.3, car.wallHit * 0.025);
    camera.position.x += (Math.random() - 0.5) * k;
    camera.position.y += (Math.random() - 0.5) * k;
  }
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------- flashback (rewind)
const SNAP_FIELDS = ['x', 'y', 'z', 'h', 'vx', 'vz', 'vf', 'vr', 'r', 'delta', 'steer', 'ax', 'ay', 'idx', 's', 'd', 'progress', 'battery', 'wear', 'drsAvailable', 'drsOpen', 'prevS',
  'gear', 'rpm', 'lapsDone', 'lapStart', 'bestLap', 'lastLap', 'finished', 'finishTime', 'bucket', 'gap', 'draft', 'pitch',
  'tyre', 'weatherGrip', 'trackWet', 'sector', 'sectorStart', 'lapInvalid'];
function takeSnapshot() {
  const R = S.race;
  R.snaps.push({
    t: R.t, ghostLen: R.ghostRec.length, ghostNext: R.ghostNext,
    weather: R.weather.snapshot(),
    cars: R.cars.map((c) => {
      const o = {};
      for (const f of SNAP_FIELDS) o[f] = c[f];
      o.lapTimes = c.lapTimes.slice(); o.pit = { ...c.pit }; o.damage = { ...c.damage }; o.sectorTimes = c.sectorTimes.slice();
      return o;
    }),
    ai: R.drivers.map((d) => d && { avoid: d.avoid, passTarget: d.passTarget, passTimer: d.passTimer, stuck: d.stuck }),
  });
  if (R.snaps.length > 120) R.snaps.shift();
}
function flashback() {
  const R = S.race;
  const target = R.t - 3;
  let k = R.snaps.length - 1;
  while (k > 0 && R.snaps[k].t > target) k--;
  const sn = R.snaps[k];
  if (!sn || R.t - sn.t < 0.5) { toast('Flashback non disponibile', 1200); return; }
  R.snaps.length = k + 1;
  R.t = sn.t;
  R.snapNext = sn.t + 0.1;
  R.cars.forEach((c, i) => {
    Object.assign(c, sn.cars[i]);
    c.lapTimes = sn.cars[i].lapTimes.slice(); c.pit = { ...sn.cars[i].pit }; c.damage = { ...sn.cars[i].damage }; c.sectorTimes = sn.cars[i].sectorTimes.slice();
    c.wallHit = 0; c.slip = 0;
  });
  R.weather.restore(sn.weather);
  R.models.forEach((m, i) => { const w = R.cars[i].damage.wing; m.wingState = w > 0.72 ? 2 : w > 0.35 ? 1 : 0; m.debris = 0; });
  R.incidents = R.incidents.filter((i) => i.t <= sn.t);
  R.drivers.forEach((d, i) => { if (d && sn.ai[i]) Object.assign(d, sn.ai[i]); });
  R.ghostRec.length = sn.ghostLen;
  R.ghostNext = sn.ghostNext;
  for (const key in R.leaderTimes) if (R.leaderTimes[key] > R.t) delete R.leaderTimes[key];
  R.flashbacks++;
  S.camH = R.player.h;
  flash('⟲ FLASHBACK', 'purple', 1000);
  audio.beep(300, 0.25);
}

function standingsOrder() {
  const R = S.race;
  return R.cars.slice().sort((a, b) => {
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.progress - a.progress;
  });
}

let hudTick = 0;
function revLeds() {
  const el = $('#hud-revs');
  if (!el.children.length) {
    for (let k = 0; k < 15; k++) { const i = document.createElement('i'); i.className = k < 5 ? 'g' : k < 10 ? 'r' : 'b'; el.appendChild(i); }
  }
  return el;
}
function updateHud() {
  const R = S.race, T = S.track, p = R.player;
  const mph = S.settings.units === 'mph';
  $('#hud-speed').textContent = Math.round(Math.abs(p.vf) * 3.6 * (mph ? 0.6214 : 1));
  $('#hud-speed').nextElementSibling.textContent = mph ? 'MPH' : 'KM/H';
  $('#hud-ers').style.width = `${Math.round(p.battery * 100)}%`;
  document.querySelector('.ers').classList.toggle('on', !!p.ersOn);
  const drs = $('#flag-drs');
  drs.className = 'drs' + (p.drsOpen ? ' open' : p.drsAvailable ? ' avail' + (p.inDrsZone ? ' zone' : '') : '');
  const tyre = $('#hud-tyre');
  const life = 1 - p.wear;
  tyre.style.setProperty('--tc', life > 0.6 ? '#22c55e' : life > 0.35 ? '#ffd400' : '#ef4444');
  tyre.querySelector('span').textContent = p.wearRate ? `${Math.round(life * 100)}%` : '';
  tyre.querySelector('b').textContent = p.tyre === 'inter' ? 'I' : 'S';
  tyre.classList.toggle('inter', p.tyre === 'inter');
  tyre.classList.toggle('hidden', !p.wearRate && R.weather.mode === 'dry');
  // damage diagram
  const dm = $('#hud-dmg');
  dm.classList.toggle('hidden', p.damageMode === 'off');
  if (p.damageMode !== 'off') {
    const col = (v) => (v < 0.08 ? '' : v < 0.35 ? 'd1' : v < 0.7 ? 'd2' : 'd3');
    const D = p.damage;
    dm.querySelector('.w-l').setAttribute('class', 'w-l ' + col(D.side > 0 ? D.wing : D.wing * 0.3));
    dm.querySelector('.w-r').setAttribute('class', 'w-r ' + col(D.side < 0 ? D.wing : D.wing * 0.3));
    dm.querySelector('.s-l').setAttribute('class', 's-l ' + col(D.side > 0 ? D.susp : 0));
    dm.querySelector('.s-r').setAttribute('class', 's-r ' + col(D.side < 0 ? D.susp : 0));
  }
  // track conditions
  const W = R.weather;
  const wx = $('#hud-wx');
  wx.classList.toggle('hidden', W.mode === 'dry');
  if (W.mode !== 'dry') {
    wx.querySelector('i').textContent = W.rain > 0.5 ? '🌧' : W.rain > 0.08 ? '🌦' : W.overcast > 0.5 ? '☁️' : '⛅';
    wx.querySelector('span').textContent = W.wet < 0.12 ? 'Asciutta' : W.wet < 0.35 ? 'Umida' : W.wet < 0.7 ? 'Bagnata' : 'Molto bagnata';
  }
  $('#flag-pit').classList.toggle('on', p.pit.requested && !p.pit.phase);
  if (document.body.classList.contains('touch-on')) {
    touch.setFlags({ drsAvail: p.drsAvailable && p.inDrsZone, drsOpen: p.drsOpen, ers: p.ersOn, battery: p.battery, pit: p.pit.requested && !p.pit.phase });
    $('#touch .tc-brake').classList.toggle('assist', !!p.assistBraking);
  }
  const ps = $('#hud-pitstop');
  ps.classList.toggle('hidden', p.pit.phase !== 'stop');
  if (p.pit.phase === 'stop') {
    ps.querySelector('b').textContent = Math.max(0, p.pit.timer).toFixed(1);
    ps.querySelector('small').textContent = p.pit.repair ? 'PIT STOP · RIPARAZIONE' : 'PIT STOP';
  }
  $('#hud-gear').textContent = p.gear < 0 ? 'R' : Math.abs(p.vf) < 0.5 && p.throttle === 0 ? 'N' : p.gear;
  const leds = revLeds();
  const lit = Math.round(Math.max(0, Math.min(1, (p.rpm - 7600) / 4700)) * 15);
  for (let k = 0; k < 15; k++) leds.children[k].classList.toggle('on', k < lit);
  leds.classList.toggle('flash', p.rpm > 12250 && p.gear < 8 && p.gear > 0 && Math.floor(performance.now() / 80) % 2 === 0);
  $('#flag-tc').classList.toggle('on', !!p.tcsActive);
  $('#flag-abs').classList.toggle('on', !!p.absActive);
  $('#flag-draft').classList.toggle('on', p.draft > 0.3);
  $('#hud-fb').textContent = R.flashbacks;
  const lapNo = R.mode === 'race' ? Math.min(R.laps, p.lapsDone + 1) : p.lapsDone + 1;
  $('#hud-lap').textContent = lapNo;
  const curLap = R.phase === 'countdown' || (R.mode === 'quali' && !R.qStart) ? 0 : p.finished ? p.lastLap : R.t - p.lapStart;
  $('#hud-time').textContent = fmtTime(curLap);
  $('#hud-last').textContent = fmtTime(p.lastLap ?? Infinity);
  $('#hud-best').textContent = fmtTime(p.bestLap);
  if (R.mode === 'tt') {
    const d = ghostDelta();
    const el = $('#hud-delta');
    if (d == null) { el.textContent = '–'; el.className = ''; }
    else { el.textContent = (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(2); el.className = d < 0 ? 'neg' : 'pos'; }
  }
  const order = standingsOrder();
  $('#hud-pos').textContent = order.indexOf(p) + 1;
  if (p.wrongWay > 1) flash('CONTROMANO!', 'warn', 600);

  // standings & minimap at lower rate
  if (++hudTick % 6 === 0) {
    if (R.mode === 'race') {
      const lead = order[0];
      $('#hud-standings').innerHTML = order.map((c, k) => {
        let gap;
        if (k === 0) gap = c.finished ? 'FINE' : `G${Math.min(R.laps, c.lapsDone + 1)}`;
        else if (c.finished) gap = '+' + (c.finishTime - lead.finishTime).toFixed(1);
        else gap = lead.progress - c.progress > T.length ? `+${Math.floor((lead.progress - c.progress) / T.length)} g` : '+' + Math.max(0, c.gap).toFixed(1);
        const short = c.isPlayer ? 'TU' : c.name.slice(0, 3).toUpperCase();
        return `<div class="${c.isPlayer ? 'me' : ''}"><span>${k + 1}</span><i style="background:${hex(c.color)}"></i><span class="name">${short}</span><span class="gap">${gap}</span></div>`;
      }).join('');
    }
  }
  if (hudTick % 2 === 0) drawMinimap();
}

// ---------------------------------------------------------------- minimap (real map, heading-up)
const mm = { canvas: $('#minimap'), map: null, toMap: null, pxPerM: 1 };
const MAP_TS = 256;

function loadImg(url) {
  return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = url; }); // pixels never read back
}

async function prepareMinimap(T, proj) {
  mm.map = null;
  const b = T.bounds, pad = 500;
  const [n, w] = proj.toLatLon(b.minX - pad, b.minZ - pad);
  const [s2, e] = proj.toLatLon(b.maxX + pad, b.maxZ + pad);
  let z = 16, x0, x1, y0, y1;
  for (; z >= 13; z--) {
    x0 = Math.floor(lon2tile(w, z)); x1 = Math.floor(lon2tile(e, z));
    y0 = Math.floor(lat2tile(n, z)); y1 = Math.floor(lat2tile(s2, z));
    if ((x1 - x0 + 1) * MAP_TS <= 4096 && (y1 - y0 + 1) * MAP_TS <= 4096) break;
  }
  const c = document.createElement('canvas');
  c.width = (x1 - x0 + 1) * MAP_TS; c.height = (y1 - y0 + 1) * MAP_TS;
  const g = c.getContext('2d');
  g.fillStyle = '#1b1d22';
  g.fillRect(0, 0, c.width, c.height);
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([x, y]);
  let ok = 0;
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { while (next < jobs.length) { const [x, y] = jobs[next++];
    const img = await loadImg(MAP_TILE(z, x, y));
    if (img) { g.drawImage(img, (x - x0) * MAP_TS, (y - y0) * MAP_TS, MAP_TS, MAP_TS); ok++; }
  } }));
  const [xW, zN] = proj.toXZ(tile2lat(y0, z), tile2lon(x0, z));
  const [xE, zS] = proj.toXZ(tile2lat(y1 + 1, z), tile2lon(x1 + 1, z));
  const sx = c.width / (xE - xW), sz = c.height / (zS - zN);
  mm.toMap = (x, zz) => [(x - xW) * sx, (zz - zN) * sz];
  mm.pxPerM = sx;
  // circuit drawn on top of the map
  g.lineJoin = 'round';
  g.beginPath();
  for (let i = 0; i <= T.n; i += 2) {
    const [px, py] = mm.toMap(T.px(i), T.pz(i));
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.closePath();
  g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 12 * sx; g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 7 * sx; g.stroke();
  g.strokeStyle = '#e10600'; g.lineWidth = 3 * sx; g.stroke();
  const [sx0, sy0] = mm.toMap(T.px(0), T.pz(0));
  g.fillStyle = '#fff';
  g.beginPath(); g.arc(sx0, sy0, 9 * sx, 0, Math.PI * 2); g.fill();
  if (ok) mm.map = c;
}

function drawMinimap() {
  const R = S.race;
  const g = mm.canvas.getContext('2d');
  const W = mm.canvas.width, C = W / 2, rad = C - 6;
  g.clearRect(0, 0, W, W);
  if (!mm.map) return;
  const p = R.player;
  const viewR = 300; // metres visible from centre to edge
  const scale = rad / viewR / mm.pxPerM;
  const rot = -Math.PI / 2 - Math.atan2(Math.cos(p.h), Math.sin(p.h));
  const [mx, my] = mm.toMap(p.x, p.z);
  g.save();
  g.beginPath(); g.arc(C, C, rad, 0, Math.PI * 2); g.clip();
  g.translate(C, C);
  g.rotate(rot);
  g.scale(scale, scale);
  g.translate(-mx, -my);
  g.drawImage(mm.map, 0, 0);
  const inv = 1 / scale;
  for (const l of S.world.labels || []) {
    const [lx, ly] = mm.toMap(l.x, l.z);
    g.fillStyle = '#ffd400';
    g.strokeStyle = '#000'; g.lineWidth = 3 * inv;
    g.beginPath(); g.arc(lx, ly, 9 * inv, 0, Math.PI * 2); g.fill(); g.stroke();
  }
  if (R.ghostModel && R.ghostModel.group.visible) {
    const [gx, gy] = mm.toMap(R.ghostModel.group.position.x, R.ghostModel.group.position.z);
    g.fillStyle = 'rgba(177,76,255,0.85)';
    g.beginPath(); g.arc(gx, gy, 10 * inv, 0, Math.PI * 2); g.fill();
  }
  for (const c of R.cars) {
    if (c.isPlayer) continue;
    const [cx, cy] = mm.toMap(c.x, c.z);
    g.fillStyle = hex(c.color); g.strokeStyle = '#000'; g.lineWidth = 3 * inv;
    g.beginPath(); g.arc(cx, cy, 11 * inv, 0, Math.PI * 2); g.fill(); g.stroke();
  }
  g.restore();
  // player arrow
  g.fillStyle = '#ffd400'; g.strokeStyle = '#000'; g.lineWidth = 4;
  g.beginPath(); g.moveTo(C, C - 20); g.lineTo(C + 14, C + 16); g.lineTo(C, C + 8); g.lineTo(C - 14, C + 16); g.closePath();
  g.fill(); g.stroke();
  // rim + north marker
  g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 4;
  g.beginPath(); g.arc(C, C, rad, 0, Math.PI * 2); g.stroke();
  const na = -Math.PI / 2 + rot;
  const nx = C + Math.cos(na) * (rad - 22), ny = C + Math.sin(na) * (rad - 22);
  g.fillStyle = 'rgba(10,12,16,0.85)';
  g.beginPath(); g.arc(nx, ny, 18, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#e10600'; g.font = '900 24px "Titillium Web", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('N', nx, ny + 1);
}

// ---------------------------------------------------------------- options
const options = createOptions({
  root: $('#screen-options'),
  settings: S.settings,
  save: () => saveSettings(),
  input,
  defaultTab: isTouchDevice() ? 'touch' : 'controls',
  onChange: (key, v) => {
    if (['touchScheme', 'autoAccel', 'touchSize', 'touchOpacity', 'lefty', 'haptics', 'tiltSens', 'tiltInvert'].includes(key)) applyControlSettings();
    if (key === 'touchScheme' && v === 'tilt') {
      TouchControls.requestTiltPermission().then((ok) => { if (!ok) toast('Il browser non permette di leggere l’inclinazione: usa Pulsanti o Volante', 3500); });
    }
    if (key === 'haptics' && v === 'on') navigator.vibrate?.(30);
    if (['bindings', 'padLayout', 'sens', 'padDeadzone', 'padCurve', 'padSmooth', 'trigDeadzone', 'rumble', 'radio', 'commentary'].includes(key) || key.startsWith('vol_')) applyControlSettings();
    if (key === 'rumble') input.rumble(0.6, 0.6, 250);
    if (key === 'autoRes' && v === 'off') setResScale(1);
    if (key === 'quality') applyQuality(v);
    if (key === 'tod') { env.set(v); S.world?.setNight(v === 'night'); setBloomForTime(v); }
    if (key === 'line') S.fx?.setLineVisible(v === 'on');
    if (key === 'sens' && S.race) S.race.player.steerSens = v;
    if (key === 'touch' && S.screen === 'race') setScreen('race');
    if (['model', 'assists', 'wear', 'damage', 'weather'].includes(key) && S.screen === 'setup') createRace();
    if (S.screen === 'setup') syncSetupControls();
  },
});
document.querySelectorAll('[data-open-options]').forEach((b) => b.addEventListener('click', () => options.open(b.dataset.openOptions || undefined)));
$('#btn-opt-close').addEventListener('click', () => options.close());

// ---------------------------------------------------------------- pause & results
function pause(on) {
  S.paused = on;
  show('#screen-pause', on);
  if (on) { audio.silence(); radio.stop(); }
  input.clearPressed();
}
$('#btn-resume').addEventListener('click', () => pause(false));
$('#btn-restart').addEventListener('click', () => { pause(false); createRace(); startRace(); });
$('#btn-to-setup').addEventListener('click', () => { pause(false); showSetup(); });
$('#btn-to-map').addEventListener('click', () => { pause(false); clearRace(); setScreen('map'); });
document.addEventListener('keydown', (e) => {
  // Esc closes the options panel (without also toggling pause)
  if (options.isOpen && e.code === 'Escape' && !input.capture) { options.close(); setTimeout(() => input.clearPressed(), 0); }
});
// touch pause while paused
setInterval(() => { if (S.screen === 'race' && S.paused && !options.isOpen && input.pressed('pause') && !$('#screen-pause').classList.contains('hidden')) pause(false); }, 100);

function playerFinished() {
  const R = S.race;
  R.phase = 'done';
  const order = standingsOrder();
  const pos = order.indexOf(R.player) + 1;
  flash(pos === 1 ? 'VITTORIA! 🏆' : `TRAGUARDO — P${pos}`, pos === 1 ? 'purple' : '', 3000);
  radio.say(pos === 1 ? 'Bandiera a scacchi! Hai vinto, che gara!' : pos <= 3 ? `Bandiera a scacchi! Sei ${posWord(pos)}, sul podio!` : `Bandiera a scacchi. Hai chiuso ${posWord(pos)}.`, 'team', { priority: 'high' });
  setTimeout(showResults, 3200);
}

function showResults() {
  const R = S.race, T = S.track;
  if (!R || S.screen !== 'race') return;
  // estimate finishing times of cars still racing; add penalties
  const rows = R.cars.map((c) => {
    let total = c.finishTime;
    let est = false;
    if (!c.finished) {
      const avg = Math.max(5, c.progress / Math.max(1, R.t));
      total = R.t + (R.laps * T.length - c.progress) / avg;
      est = true;
    }
    return { c, total: total + (c.penalty || 0), est, d: R.drivers[R.cars.indexOf(c)] };
  }).sort((a, b) => a.total - b.total);
  const winner = rows[0].total;
  const bestOverall = Math.min(...R.cars.map((c) => c.bestLap));
  const pos = rows.findIndex((r) => r.c.isPlayer) + 1;
  S.resultsKind = 'race';
  $('#res-title').textContent = pos === 1 ? 'Hai vinto! 🏆' : `Sei arrivato ${pos}°`;
  const podium = [1, 0, 2].map((k) => rows[k] && `<div class="p${k + 1} ${rows[k].c.isPlayer ? 'me' : ''}"><b>${k + 1}</b><span>${rows[k].c.name}</span><i style="background:${hex(rows[k].c.color)}"></i></div>`);
  $('#podium').innerHTML = podium.map((x) => x || '<div style="visibility:hidden"></div>').join('');
  $('#res-table').innerHTML = `<tr><th>Pos</th><th>Pilota</th><th>Stile</th><th>Tempo</th><th>Giro migliore</th></tr>` + rows.map((r, k) =>
    `<tr class="${r.c.isPlayer ? 'me' : ''}"><td>${k + 1}</td><td><span class="sw" style="background:${hex(r.c.color)}"></span>${r.c.name}</td>
    <td class="muted">${r.d ? r.d.persona.label : '—'}</td>
    <td>${k === 0 ? fmtTime(r.total) : '+' + (r.total - winner).toFixed(3)}${r.est ? '*' : ''}${r.c.penalty ? ` <span class="penalty">+${r.c.penalty}s</span>` : ''}</td>
    <td class="${r.c.bestLap === bestOverall ? 'best' : ''}">${fmtTime(r.c.bestLap)}</td></tr>`).join('');
  // championship
  const champ = S.champActive && S.champ && !R.champAwarded;
  $('#res-champ').innerHTML = R.bestRank && R.bestRank <= 10
    ? `<p class="lb-note">🏅 Il tuo giro migliore (${fmtTime(R.player.bestLap)}) è <b>#${R.bestRank}</b> nella tua classifica di questo circuito.</p>` : '';
  if (champ) {
    R.champAwarded = true;
    awardChampPoints(rows);
    const done = S.champ.round >= S.champ.cities.length;
    const leader = champStandings()[0];
    $('#res-champ').innerHTML += `<h3>${done ? `Campionato finito — campione: ${leader.name === 'Tu' ? 'TU! 🏆' : leader.name}` : `Classifica campionato dopo ${S.champ.round} gare`}</h3><div class="champ-table">${champTableHtml()}</div>`;
    setResultButtons([
      ...(done ? [] : [[`Prossimo round: ${S.champ.cities[S.champ.round]} →`, 'primary', () => { clearRace(); setScreen('map'); runChampRound(); }]]),
      ['▶ Replay', '', () => startReplay()],
      ['Torna alla mappa', 'ghost', () => { clearRace(); S.champActive = false; setScreen('map'); }],
    ]);
  } else {
    setResultButtons([
      ['Rigioca', 'primary', () => { if (S.settings.quali === 'on' && S.settings.mode === 'race') { createRace({ quali: true, keepLineup: true }); } else createRace({ keepLineup: true }); startRace(); }],
      ['▶ Replay', '', () => startReplay()],
      ['Impostazioni', '', () => showSetup()],
      ['Cambia circuito', 'ghost', () => { clearRace(); setScreen('map'); }],
    ]);
  }
  show('#screen-results');
  audio.silence();
  S.paused = true;
}

// ---------------------------------------------------------------- replay
function startReplay() {
  const R = S.race;
  if (!R || R.rec.frames.length < 10) { toast('Replay non disponibile'); show('#screen-results'); S.paused = true; return; }
  S.replay = new ReplayViewer({ camera, track: S.track, rec: R.rec, models: R.models, cars: R.cars });
  S.screen = 'replay';
  show('#hud', false);
  show('#replay-bar');
  touch.show(false);
  audio.silence();
  syncReplayBar();
}
function syncReplayBar() {
  const V = S.replay;
  if (!V) return;
  $('#rp-play').textContent = V.playing ? '❚❚' : '▶';
  $('#rp-speed').textContent = V.speed + '×';
  $('#rp-car').textContent = V.focusName;
  $('#rp-cam').textContent = { tv: '🎥 TV', chase: '🎥 Inseguimento', heli: '🎥 Elicottero' }[V.mode];
}
function exitReplay() {
  S.replay = null;
  setTimeout(() => input.clearPressed(), 0);
  show('#replay-bar', false);
  S.screen = 'race';
  show('#screen-results');
  S.paused = true;
}
$('#rp-play').addEventListener('click', () => { const V = S.replay; if (V.t >= V.end) V.seek(0); V.playing = !V.playing; syncReplayBar(); });
$('#rp-speed').addEventListener('click', () => { const V = S.replay; V.speed = { 0.5: 1, 1: 2, 2: 4, 4: 0.5 }[V.speed]; syncReplayBar(); });
$('#rp-prev').addEventListener('click', () => { S.replay.nextCar(-1); syncReplayBar(); });
$('#rp-next').addEventListener('click', () => { S.replay.nextCar(1); syncReplayBar(); });
$('#rp-cam').addEventListener('click', () => { S.replay.cycleMode(); syncReplayBar(); });
$('#rp-exit').addEventListener('click', () => exitReplay());
$('#rp-seek').addEventListener('input', (e) => { S.replay.seek(+e.target.value); });
document.addEventListener('keydown', (e) => {
  if (S.screen !== 'replay' || !S.replay) return;
  if (e.code === 'Space') { S.replay.playing = !S.replay.playing; e.preventDefault(); }
  else if (e.code === 'ArrowLeft') S.replay.nextCar(-1);
  else if (e.code === 'ArrowRight') S.replay.nextCar(1);
  else if (e.code === 'KeyC') S.replay.cycleMode();
  else if (e.code === 'Escape') { exitReplay(); return; }
  syncReplayBar();
});

// ====================================================================== setup flyover (intro with landmarks)
function buildIntro() {
  const T = S.track, W = S.world;
  const b = T.bounds;
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const R = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 0.62 + 150;
  const cy = (T.elev.min + T.elev.max) / 2;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const shots = [];
  shots.push({
    dur: 8, kicker: S.trackDef.city || '', title: S.trackDef.name,
    at: (t) => {
      const a = 0.6 + t * 0.06;
      return { pos: V(cx + Math.cos(a) * R, cy + R * 0.55 + 80, cz + Math.sin(a) * R), look: V(cx, cy, cz) };
    },
  });
  const lms = (W.labels || []).slice().sort((a, b2) => b2.lm.rank - a.lm.rank).slice(0, 5);
  for (const l of lms) {
    const top = l.y;
    const g0 = S.ground ? S.ground(l.x, l.z) : 0;
    let size = 15;
    if (l.lm.ring) for (const [x, z] of l.lm.ring) size = Math.max(size, Math.hypot(x - l.x, z - l.z));
    size = Math.min(size, 250);
    const r = Math.max(80, size * 1.7, (top - g0) * 1.6);
    const a0 = Math.atan2(l.z - cz, l.x - cx);
    shots.push({
      dur: 6.5, kicker: 'Luogo lungo il circuito', title: l.name,
      at: (t) => {
        const a = a0 + 0.35 - t * 0.09;
        return { pos: V(l.x + Math.cos(a) * r, Math.max(top, g0 + r * 0.5) + 20, l.z + Math.sin(a) * r), look: V(l.x, top * 0.6 + g0 * 0.4, l.z) };
      },
    });
  }
  shots.push({
    dur: 8, kicker: 'Griglia di partenza', title: S.world.streets?.per?.[0] || S.trackDef.name,
    at: (t) => {
      const s = T.length - 140 + t * 18;
      const p = T.pointAt(s), a = T.pointAt(s + 90);
      return { pos: V(p.x + p.nx * 4, p.y + 14, p.z + p.nz * 4), look: V(a.x, a.y + 2, a.z) };
    },
  });
  S.intro = { shots, k: 0, t: 0 };
}

function setCaption(shot) {
  const el = $('#intro-caption');
  el.classList.remove('show');
  setTimeout(() => {
    el.querySelector('small').textContent = shot.kicker;
    el.querySelector('b').textContent = shot.title;
    el.classList.add('show');
  }, 350);
}

function updateFlyover(dt) {
  const T = S.track, I = S.intro;
  if (!T || !I.shots.length) return;
  I.t += dt;
  if (I.t > I.shots[I.k].dur) {
    I.k = (I.k + 1) % I.shots.length;
    I.t = 0;
    setCaption(I.shots[I.k]);
  }
  const { pos, look } = I.shots[I.k].at(I.t);
  camera.position.lerp(pos, 1 - Math.exp(-dt * 1.4));
  S.lookCur.lerp(look, 1 - Math.exp(-dt * 2));
  camera.lookAt(S.lookCur);
  camera.fov = 55;
  camera.near = 0.1;
  camera.updateProjectionMatrix();
  env.follow(S.lookCur.x, S.lookCur.z, S.lookCur.y);
  updateLabels();
  if (S.race) for (let k = 0; k < S.race.cars.length; k++) updateCarModel(S.race.models[k], S.race.cars[k], dt);
}

// landmark labels: fade with distance and hide overlapping ones (most important first)
const _lv = new THREE.Vector3();
function updateLabels() {
  const labels = S.world?.labels;
  if (!labels) return;
  const inRace = S.screen === 'race';
  if (inRace) { for (const l of labels) { l.sprite.visible = false; l.sprite.material.opacity = 0; } return; }
  const W = window.innerWidth, H = window.innerHeight;
  const placed = [];
  const order = labels.slice().sort((a, b) => b.lm.rank - a.lm.rank);
  for (const l of order) {
    const d = camera.position.distanceTo(l.sprite.position);
    const far = inRace ? 1400 : 3500;
    let o = d < (inRace ? 70 : 20) ? 0 : Math.max(0, Math.min(1, (far - d) / 500));
    if (o > 0) {
      _lv.copy(l.sprite.position).project(camera);
      if (_lv.z > 1) o = 0;
      else {
        const x = (_lv.x * 0.5 + 0.5) * W, y = (-_lv.y * 0.5 + 0.5) * H;
        const h = (l.sprite.scale.y / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * H * 0.5, w = h * l.sprite.material.map.userData.aspect;
        const box = [x - w / 2, y - h, x + w / 2, y];
        if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) o = 0;
        else placed.push(box);
      }
    }
    const cur = l.sprite.material.opacity;
    l.sprite.material.opacity = cur + (o - cur) * 0.2;
    l.sprite.visible = l.sprite.material.opacity > 0.02;
  }
}

// street name + nearby landmarks in the HUD
function updatePlaceInfo() {
  const R = S.race, W = S.world, p = R.player;
  const street = W.streets?.per?.[p.idx] || '';
  if (street !== S.streetShown) {
    S.streetShown = street;
    const el = $('#hud-street');
    el.classList.remove('show');
    if (street) setTimeout(() => { el.querySelector('span').textContent = street; el.classList.add('show'); }, 200);
  }
  if (!W.labels || R.phase !== 'racing') return;
  for (const l of W.labels) {
    if (R.announced.has(l.name)) continue;
    if (Math.hypot(l.x - p.x, l.z - p.z) < 170) {
      R.announced.add(l.name);
      const el = $('#hud-place');
      el.querySelector('span').textContent = l.name;
      el.classList.add('show');
      clearTimeout(S.placeTimer);
      S.placeTimer = setTimeout(() => el.classList.remove('show'), 3500);
      break;
    }
  }
}

// ====================================================================== main loop
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  // battery saver: draw every other frame on 60 Hz screens
  if (S.settings.fps === 30 && now - last < 1000 / 30 - 4) return;
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (S.screen === 'replay' && S.replay) {
    S.replay.update(dt);
    const wx = S.replay.rec.wx?.[S.replay.fr?.i ?? 0];
    if (wx) {
      env.applyWeather({ cloud: wx[0], overcast: wx[1], rain: wx[2], wet: wx[3] });
      if (S.world?.wetMats) setWetness(S.world.wetMats, wx[3], env.envTex);
    }
    env.follow(S.replay.look.x || camera.position.x, S.replay.look.z || camera.position.z, camera.position.y - 5);
    if (!document.activeElement || document.activeElement.id !== 'rp-seek') $('#rp-seek').value = S.replay.progress;
    if (S.replay.playing === false && $('#rp-play').textContent !== '▶') syncReplayBar();
  } else if (S.screen === 'race' && S.race && !S.paused) updateRace(dt);
  else if (S.screen === 'setup') updateFlyover(dt);
  else if (S.screen === 'race' && S.paused) input.read(dt);
  else input.pollPad();
  const racing = S.screen === 'race' && S.race && !S.paused;
  if (!racing) padNav.update();
  if (options.isOpen) updatePadMeter(dt);
  if (S.screen === 'race' || S.screen === 'setup' || S.screen === 'replay') {
    env.adaptFog(camera.position.y - (S.track ? S.track.elev.min : 0) - 20);
    env.update(S.paused ? 0 : dt, camera);
    if (post.grade) {
      // speed blur only while driving in the chase / cockpit views
      const want = racing && S.settings.blur === 'on' ? Math.min(0.9, Math.max(0, ((post.speed || 0) - 45) / 45)) : 0;
      post.grade.uniforms.blur.value += (want - post.grade.uniforms.blur.value) * Math.min(1, dt * 4);
      post.grade.uniforms.center.value.set(0.5, S.camMode === 2 ? 0.5 : 0.56);
      post.grade.uniforms.time.value = (now / 1000) % 100;
    }
    trackPerformance(dt);
    renderFrame();
  }
}

// gamepad: menus are navigable with the D-pad / stick, A selects, B goes back
const padNav = new PadNav({
  getRoot: () => {
    const vis = (sel) => { const el = $(sel); return el && !el.classList.contains('hidden') ? el : null; };
    return (options.isOpen && $('#screen-options .menu')) || vis('#screen-info') && $('#screen-info .menu') || vis('#screen-records') && $('#screen-records .menu')
      || (vis('#screen-results') && $('#screen-results .menu')) || (vis('#screen-pause') && $('#screen-pause .menu'))
      || (S.screen === 'replay' && $('#replay-bar')) || (S.screen === 'setup' && $('.setup-card')) || (S.screen === 'map' && $('#panel')) || null;
  },
  onBack: () => {
    if (options.isOpen) options.close();
    else if (!$('#screen-info').classList.contains('hidden')) show('#screen-info', false);
    else if (!$('#screen-records').classList.contains('hidden')) show('#screen-records', false);
    else if (S.screen === 'race' && S.paused && !$('#screen-pause').classList.contains('hidden')) pause(false);
    else if (S.screen === 'replay') exitReplay();
  },
});

// live stick / trigger meter in Options → Comandi
function updatePadMeter(dt) {
  const el = document.getElementById('pad-meter-steer');
  if (!el) return;
  const r = S.screen === 'race' && !S.paused ? null : input.read(dt);
  if (!r) return;
  el.style.left = `${50 + Math.min(0, r.steer) * 50}%`;
  el.style.width = `${Math.abs(r.steer) * 50}%`;
  document.getElementById('pad-meter-thr').style.width = `${r.throttle * 100}%`;
  document.getElementById('pad-meter-brk').style.width = `${r.brake * 100}%`;
  const st = document.getElementById('pad-status');
  if (st) st.textContent = input.pad ? 'Collegato: ' + input.pad.id.replace(/\(.*\)/, '').trim() : 'Nessun gamepad rilevato: collegalo e premi un tasto.';
}

// ====================================================================== publishing niceties
// pause automatically when the tab is hidden; resume audio when it comes back
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (S.screen === 'race' && S.race && !S.paused) pause(true);
    radio.stop();
    audio.ctx?.suspend?.();
  } else if (audio.ctx && S.screen !== 'map') audio.ctx.resume?.();
});
// the GPU can drop the WebGL context (driver reset, too many tabs): offer a reload
renderer.domElement.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  fatal('La grafica si è interrotta', 'Il browser ha perso il contesto grafico (succede con driver instabili o troppe schede aperte). Ricarica la pagina per continuare.');
});
// unexpected errors: keep playing when possible, but let the player know
let errorShown = 0;
function reportError(err) {
  console.error(err);
  if (Date.now() - errorShown < 8000) return;
  errorShown = Date.now();
  toast('Si è verificato un errore imprevisto. Se qualcosa non va, ricarica la pagina.', 4000);
}
window.addEventListener('error', (e) => reportError(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportError(e.reason));

// keep the screen awake while racing (phones dim after ~30 s without touches)
let wakeLock = null;
async function keepScreenOn(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.screen === 'race') keepScreenOn(true); });

// first race on a touch screen: show where the controls are (like the mobile racers' first-run hints)
function showTouchTutorial() {
  if (store.get('touchTutorial', 0) >= 2) return;
  store.set('touchTutorial', store.get('touchTutorial', 0) + 1);
  const el = $('#touch-tutorial');
  const st = S.settings;
  el.querySelector('.tt-steer').textContent = { buttons: 'Tieni premuto ◀ ▶ per sterzare', wheel: 'Trascina il pollice per sterzare', tilt: 'Inclina il telefono per sterzare' }[st.touchScheme] || '';
  el.querySelector('.tt-pedal').textContent = st.autoAccel === 'on' ? 'Accelera da solo · tieni FRENO per frenare' : 'GAS per accelerare · FRENO per frenare';
  el.classList.toggle('lefty', st.lefty === 'on');
  show('#touch-tutorial');
  const hide = () => show('#touch-tutorial', false);
  el.onclick = hide;
  setTimeout(hide, 6500);
}

// portrait during a race on a phone: pause until the phone is rotated back
window.addEventListener('resize', () => {
  if (S.screen === 'race' && S.race && !S.paused && touchWanted() && window.innerHeight > window.innerWidth * 1.1) pause(true);
});

// "install the app": Android/Chrome gives an install prompt, iPhone needs Share → Add to Home Screen
let installEvent = null;
const standalone = () => window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; show('#btn-install', !standalone()); });
if (/iP(hone|ad|od)/.test(navigator.userAgent) && !standalone()) show('#btn-install');
$('#btn-install').addEventListener('click', async () => {
  if (installEvent) {
    installEvent.prompt();
    const r = await installEvent.userChoice.catch(() => null);
    if (r?.outcome === 'accepted') show('#btn-install', false);
    installEvent = null;
  } else toast('Su iPhone: tocca Condividi ⬆︎ e poi “Aggiungi alla schermata Home”. Il gioco si aprirà a schermo intero.', 6000);
});

// fullscreen (and landscape on phones) when racing on touch devices
function goFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement || !el.requestFullscreen) return Promise.resolve();
  return el.requestFullscreen({ navigationUI: 'hide' }).then(() => screen.orientation?.lock?.('landscape').catch(() => {})).catch(() => {});
}
document.querySelectorAll('[data-fullscreen]').forEach((b) => b.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen?.(); else goFullscreen();
}));

// info / credits / privacy
document.querySelectorAll('[data-open-info]').forEach((b) => b.addEventListener('click', () => show('#screen-info')));
$('#btn-info-close').addEventListener('click', () => show('#screen-info', false));
$('#info-version').textContent = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
$('#btn-clear-data').addEventListener('click', async () => {
  if (!confirm('Cancellare record, circuiti salvati, campionato e impostazioni di City GP su questo dispositivo?')) return;
  try {
    Object.keys(localStorage).filter((k) => k.startsWith('citygp:')).forEach((k) => localStorage.removeItem(k));
    indexedDB.deleteDatabase('citygp-cache');
  } catch { /* ignore */ }
  location.reload();
});

// offline support (production build only)
if (import.meta.env?.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

requestAnimationFrame(frame);
setScreen('map');

// debug handle
window.__citygp = {
  S, scene, camera, renderer, map, editor,
  // advance the game without requestAnimationFrame (useful when the tab is in the background)
  tick(n = 60, dt = 1 / 60, onStep = null) {
    for (let k = 0; k < n; k++) {
      if (S.screen === 'race' && S.race && !S.paused) updateRace(dt);
      else if (S.screen === 'setup') updateFlyover(dt);
      env.update(dt, camera);
      if (onStep && onStep() === false) break;
    }
    renderFrame();
  },
};
