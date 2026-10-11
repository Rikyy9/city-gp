// Synthesised audio: V6-turbo style engines (player + nearby opponents in 3D), tyres, kerbs, impacts.

const HARMONICS = [0, 1.0, 0.55, 0.72, 0.3, 0.26, 0.48, 0.16, 0.13, 0.22, 0.08, 0.05, 0.11];

class EngineVoice {
  constructor(ctx, out, noiseBuf, seed = 0, spatial = false) {
    this.ctx = ctx;
    const rnd = (k) => { const x = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
    const real = new Float32Array(HARMONICS.length), imag = new Float32Array(HARMONICS.length);
    HARMONICS.forEach((h, k) => { imag[k] = h * (0.8 + rnd(k) * 0.4); });
    const wave = ctx.createPeriodicWave(real, imag);
    this.detune = 1 + 0.004 + rnd(20) * 0.006;
    this.pitchMul = 0.97 + rnd(21) * 0.06;

    this.out = ctx.createGain();
    this.out.gain.value = 0;
    if (spatial) {
      this.panner = ctx.createPanner();
      this.panner.panningModel = 'equalpower';
      this.panner.distanceModel = 'inverse';
      this.panner.refDistance = 7;
      this.panner.rolloffFactor = 1.3;
      this.out.connect(this.panner).connect(out);
    } else this.out.connect(out);

    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i++) { const x = (i / (curve.length - 1)) * 2 - 1; curve[i] = Math.tanh(x * 2.2) * 0.9; }
    shaper.curve = curve;
    shaper.oversample = '2x';
    this.drive = ctx.createGain();
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.Q.value = 2.5;
    const rasp = ctx.createBiquadFilter();
    rasp.type = 'peaking';
    rasp.frequency.value = 2400;
    rasp.Q.value = 1.2;
    rasp.gain.value = 5;
    this.drive.connect(shaper).connect(this.lp).connect(rasp).connect(this.out);

    this.o1 = ctx.createOscillator(); this.o1.setPeriodicWave(wave);
    this.o2 = ctx.createOscillator(); this.o2.setPeriodicWave(wave);
    this.sub = ctx.createOscillator(); this.sub.type = 'sine';
    const g1 = ctx.createGain(); g1.gain.value = 0.5;
    const g2 = ctx.createGain(); g2.gain.value = 0.32;
    this.subGain = ctx.createGain(); this.subGain.gain.value = 0.25;
    this.o1.connect(g1).connect(this.drive);
    this.o2.connect(g2).connect(this.drive);
    this.sub.connect(this.subGain).connect(this.drive);

    // combustion noise, amplitude-modulated at the firing frequency
    this.noise = ctx.createBufferSource();
    this.noise.buffer = noiseBuf;
    this.noise.loop = true;
    this.nbp = ctx.createBiquadFilter();
    this.nbp.type = 'bandpass';
    this.nbp.Q.value = 1.1;
    this.nAm = ctx.createGain();
    this.nAm.gain.value = 0;
    const amOsc = this.o1; // reuse firing-frequency oscillator as modulator
    const amDepth = ctx.createGain(); amDepth.gain.value = 0.12;
    amOsc.connect(amDepth).connect(this.nAm.gain);
    this.nLevel = ctx.createGain(); this.nLevel.gain.value = 0;
    this.noise.connect(this.nbp).connect(this.nAm).connect(this.nLevel).connect(this.drive);

    // turbo whistle
    this.turbo = ctx.createOscillator();
    this.turbo.type = 'sine';
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;
    this.turbo.connect(this.turboGain).connect(this.out);

    for (const o of [this.o1, this.o2, this.sub, this.noise, this.turbo]) o.start();
    this.lastThrottle = 0;
  }

  set(rpm, throttle, level, pitchScale = 1, t = this.ctx.currentTime) {
    const f = (rpm / 60) * 3 * this.pitchMul * pitchScale; // V6 firing frequency
    const k = 0.035;
    this.o1.frequency.setTargetAtTime(f, t, k);
    this.o2.frequency.setTargetAtTime(f * this.detune, t, k);
    this.sub.frequency.setTargetAtTime(f * 0.5, t, k);
    this.nbp.frequency.setTargetAtTime(Math.min(9000, f * 4.5), t, k);
    const load = 0.25 + 0.75 * throttle;
    this.drive.gain.setTargetAtTime(0.6 + 1.6 * load, t, 0.05);
    this.lp.frequency.setTargetAtTime(700 + 4200 * load + rpm * 0.12, t, 0.05);
    this.nLevel.gain.setTargetAtTime(0.25 + 0.5 * throttle, t, 0.05);
    this.subGain.gain.setTargetAtTime(0.18 + 0.15 * (1 - throttle), t, 0.08);
    this.turbo.frequency.setTargetAtTime(1800 + rpm * 0.38, t, 0.08);
    this.turboGain.gain.setTargetAtTime(level * 0.03 * throttle * Math.min(1, rpm / 9000), t, 0.15);
    this.out.gain.setTargetAtTime(level * (0.55 + 0.45 * load), t, 0.05);
    this.lastThrottle = throttle;
  }

  setPosition(x, y, z, t) {
    if (!this.panner) return;
    this.panner.positionX.setTargetAtTime(x, t, 0.03);
    this.panner.positionY.setTargetAtTime(y, t, 0.03);
    this.panner.positionZ.setTargetAtTime(z, t, 0.03);
  }

  mute(t) { this.out.gain.setTargetAtTime(0, t, 0.08); this.turboGain.gain.setTargetAtTime(0, t, 0.08); }
}

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.vol = { master: 0.8, engine: 0.8, fx: 0.8, opponents: 0.6 };
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.engineBus = ctx.createGain();
    this.fxBus = ctx.createGain();
    this.oppBus = ctx.createGain();
    this.engineBus.connect(this.master); this.fxBus.connect(this.master); this.oppBus.connect(this.master);
    this.applyVolumes();

    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    this.player = new EngineVoice(ctx, this.engineBus, buf, 1, false);
    this.others = [0, 1, 2].map((k) => new EngineVoice(ctx, this.oppBus, buf, 10 + k * 7, true));

    const loopNoise = (type, freq, q) => {
      const n = ctx.createBufferSource();
      n.buffer = buf; n.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      n.connect(f).connect(g).connect(this.fxBus);
      n.start(0, Math.random());
      return g;
    };
    this.squealGain = loopNoise('bandpass', 1400, 6);
    this.rainGain = loopNoise('highpass', 2600, 0.5);
    this.hissGain = loopNoise('bandpass', 4200, 0.9); // tyres on standing water
    this.windGain = loopNoise('lowpass', 500, 0.7);
    const kr = ctx.createOscillator();
    kr.type = 'square'; kr.frequency.value = 38;
    const krf = ctx.createBiquadFilter(); krf.type = 'lowpass'; krf.frequency.value = 180;
    this.kerbGain = ctx.createGain(); this.kerbGain.gain.value = 0;
    kr.connect(krf).connect(this.kerbGain).connect(this.fxBus);
    kr.start();
    this.lastPop = 0;
    this.prevThrottle = 0;
  }

  setVolumes(v) { Object.assign(this.vol, v); this.applyVolumes(); }
  applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.vol.master * 0.7, t, 0.05);
    this.engineBus.gain.setTargetAtTime(this.vol.engine * (this.ducked ? 0.45 : 1), t, 0.15);
    this.fxBus.gain.setTargetAtTime(this.vol.fx, t, 0.05);
    this.oppBus.gain.setTargetAtTime(this.vol.opponents * (this.ducked ? 0.5 : 1), t, 0.15);
  }
  setMuted(m) { this.muted = m; this.applyVolumes(); }

  oneShot(filterType, freq, q, gain, dur, bus = this.fxBus) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = filterType; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(bus);
    src.start(t, Math.random());
    src.stop(t + dur + 0.02);
  }
  // team-radio squelch (open/close) and engine ducking while someone talks
  radioClick(open) {
    if (!this.ctx) return;
    this.oneShot('bandpass', open ? 1800 : 1400, 2.5, open ? 0.22 : 0.16, open ? 0.12 : 0.18, this.master);
    this.beepAt(open ? 1250 : 900, 0.05, 0.05);
  }
  beepAt(freq, dur, gain) {
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine'; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  duck(on) {
    this.ducked = on;
    this.applyVolumes();
  }

  pop(strength = 0.25) { this.oneShot('bandpass', 250 + Math.random() * 450, 1.5, strength, 0.07, this.engineBus); }
  wastegate() { this.oneShot('highpass', 2500, 0.7, 0.12, 0.35, this.engineBus); }
  impact(strength) { if (strength >= 1.5) this.oneShot('lowpass', 700, 0.7, Math.min(0.9, strength / 15), 0.35); }

  beep(freq, dur = 0.25) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square'; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.fxBus);
    o.start(t); o.stop(t + dur + 0.05);
  }

  // car = player; camera gives the listener; cars = all cars (for nearby opponents)
  update(car, active, camera, cars, wet = 0, rain = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.rainGain.gain.setTargetAtTime(active ? rain * 0.12 : 0, t, 0.3);
    this.hissGain.gain.setTargetAtTime(active ? wet * Math.min(1, Math.abs(car.vf) / 50) * 0.1 : 0, t, 0.1);
    const cut = car.shift > 0 ? 0.35 : 1;
    if (active) this.player.set(car.rpm, car.throttle * cut, 0.42 * (car.shift > 0 ? 0.6 : 1));
    else this.player.mute(t);
    const sp = Math.abs(car.vf);
    this.squealGain.gain.setTargetAtTime(active && sp > 8 ? Math.min(0.25, car.slip * 0.3) * (1 - wet * 0.8) : 0, t, 0.05);
    this.windGain.gain.setTargetAtTime(active ? Math.min(0.25, sp / 400) : 0, t, 0.1);
    this.kerbGain.gain.setTargetAtTime(active ? car.kerb * 0.35 : 0, t, 0.03);
    if (active && car.throttle < 0.1 && car.rpm > 8500 && t - this.lastPop > 0.05 && Math.random() < 0.35) { this.lastPop = t; this.pop(0.1 + Math.random() * 0.14); }
    if (active && car.shift > 0.1 && t - this.lastPop > 0.15) { this.lastPop = t; this.pop(0.18); }
    if (active && this.prevThrottle > 0.8 && car.throttle < 0.2 && car.rpm > 8000) this.wastegate();
    this.prevThrottle = car.throttle;

    // listener follows the camera
    const L = this.ctx.listener;
    if (camera && L.positionX) {
      const p = camera.position;
      const f = camera.getWorldDirection(this._dir || (this._dir = camera.position.clone()));
      L.positionX.setTargetAtTime(p.x, t, 0.02); L.positionY.setTargetAtTime(p.y, t, 0.02); L.positionZ.setTargetAtTime(p.z, t, 0.02);
      L.forwardX.setTargetAtTime(f.x, t, 0.02); L.forwardY.setTargetAtTime(f.y, t, 0.02); L.forwardZ.setTargetAtTime(f.z, t, 0.02);
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    }
    // three nearest opponents get a positional voice with doppler
    const near = active && cars ? cars.filter((c) => c !== car)
      .map((c) => ({ c, d: Math.hypot(c.x - camera.position.x, c.z - camera.position.z) }))
      .filter((o) => o.d < 220).sort((a, b) => a.d - b.d).slice(0, 3) : [];
    this.others.forEach((v, k) => {
      const o = near[k];
      if (!o) { v.mute(t); return; }
      const c = o.c;
      const rx = camera.position.x - c.x, rz = camera.position.z - c.z;
      const rl = Math.hypot(rx, rz) || 1;
      const vr = (c.vx * rx + c.vz * rz) / rl - ((car.vx * rx + car.vz * rz) / rl);
      const doppler = Math.max(0.75, Math.min(1.3, 343 / (343 - vr)));
      v.setPosition(c.x, c.y + 0.6, c.z, t);
      v.set(c.rpm, c.throttle, 0.5, doppler);
    });
  }

  silence() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.player.mute(t);
    this.others.forEach((v) => v.mute(t));
    for (const g of [this.squealGain, this.windGain, this.kerbGain, this.rainGain, this.hissGain]) g.gain.setTargetAtTime(0, t, 0.05);
  }
}
