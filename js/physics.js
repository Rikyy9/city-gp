// Single-seater dynamics confined by the track walls.
// - AI cars use a robust kinematic model (grip-limited yaw).
// - The player uses a dynamic bicycle model with tyre slip, downforce, load transfer and
//   arcade-style driving aids (steering limit, countersteer, stability, TCS, ABS).

export const VMAX = 92;            // m/s, ~330 km/h
export const WHEELBASE = 3.6;
export const CAR_HALF_WIDTH = 1.0;

export const engineAccel = (v) => Math.min(12.5, 950 / Math.max(Math.abs(v), 1));
export const coastDecel = (v) => 0.6 + 0.00118 * v * v;
// drag with slipstream / DRS (aero part only)
const dragDecel = (v, draft, drs) => 0.6 + 0.00118 * v * v * (1 - 0.3 * draft) * (drs ? 0.78 : 1);
// ERS: extra ~120 kW, traction-limited at low speed
export const ersAccel = (v) => Math.min(2.4, 150 / Math.max(Math.abs(v), 1));
const ERS_DEPLOY_TIME = 30; // seconds of boost from a full battery
export const brakeDecel = (v) => 20 + 0.0028 * v * v;
export function maxLateralAccel(v) { return maxLateralAccel.coeffs.a + maxLateralAccel.coeffs.b * v * v; }
maxLateralAccel.coeffs = { a: 17, b: 0.0042 };

const GEARS = [0, 24, 34, 44, 54, 64, 74, 84, 97];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const G = 9.81;

// tyre grip vs track wetness (0 = dry, 1 = soaked): slicks lose a lot, intermediates cross over at ~30%
export function tyreGrip(tyre, wet) {
  return tyre === 'inter' ? 0.93 - 0.07 * wet : 1 - 0.31 * wet;
}

// ---- player car parameters
const M = 800, IZ = 1050, LA = 1.95, LB = 1.65, HCG = 0.16;
const MU = 1.75;
const K_DOWN = 1.92;                 // downforce N per (m/s)^2
const DOWN_FRONT = 0.44;
const STATIC_FRONT = LB / (LA + LB);
const ALPHA_PEAK = 0.11;             // rad, tyre slip angle at peak grip
const SHAPE_B = Math.tan(Math.PI / 3) / ALPHA_PEAK, SHAPE_C = 1.5;
const tyre = (alpha) => Math.sin(SHAPE_C * Math.atan(SHAPE_B * alpha)); // 1 at peak, ~0.7 sliding

// driving-aid presets
export const ASSISTS = {
  high: { limit: 1.0, counter: 0.85, yawLimit: 1.06, tcs: true, abs: true, turnRate: 1.0 },
  medium: { limit: 1.2, counter: 0.5, yawLimit: 1.2, tcs: true, abs: true, turnRate: 1.15 },
  low: { limit: 1.45, counter: 0.3, yawLimit: 1.35, tcs: true, abs: true, turnRate: 1.3 },
};

export class Car {
  constructor({ name = 'Pilota', color = 0xe10600, isPlayer = false, dynamic = false, arcade = false, assists = 'medium', steerSens = 1 } = {}) {
    this.name = name;
    this.color = color;
    this.isPlayer = isPlayer;
    this.dynamic = dynamic;
    this.arcade = arcade;           // forgiving player model (kinematic, extra grip, soft walls)
    this.steerSens = steerSens;
    this.drsOpen = false; this.drsAvailable = false;
    this.ersOn = false; this.battery = 1;
    this.wear = 0; this.wearRate = 0;
    this.tyre = 'slick';            // 'slick' | 'inter'
    this.weatherGrip = 1;           // set every frame from the weather (tyre vs track wetness)
    this.damageMode = 'on';         // 'off' | 'visual' | 'on'
    this.damage = { wing: 0, susp: 0, side: 1 };
    this.damageHit = 0;             // damage taken this step (for effects / radio)
    this.limiter = 0;               // pit-lane speed limit (m/s), 0 = off
    this.assist = ASSISTS[assists] || ASSISTS.medium;
    this.x = 0; this.y = 0; this.z = 0; this.h = 0;
    this.pitch = 0;
    this.vx = 0; this.vz = 0;
    this.vf = 0; this.vr = 0;
    this.r = 0;                 // yaw rate (rad/s, + = left)
    this.delta = 0;             // front wheel angle (rad, + = left)
    this.steer = 0;
    this.yaw = 0;
    this.ax = 0; this.ay = 0;   // body accelerations (for load transfer, camera, HUD)
    this.throttle = 0; this.brake = 0;
    this.idx = 0; this.s = 0; this.d = 0;
    this.progress = 0;
    this.gear = 1; this.rpm = 4000; this.shift = 0;
    this.slip = 0; this.wallHit = 0; this.kerb = 0; this.slideAngle = 0;
    this.wheelspin = 0; this.lockup = 0;
    this.draft = 0;
    this.wheelRot = 0;
    this.gripMul = 1;
    this.finished = false;
    this.lapTimes = [];
    this.lapStart = 0;
    this.bestLap = Infinity;
    this.wrongWay = 0;
  }

  place(track, s, offset) {
    const p = track.pointAt(s, offset);
    this.x = p.x; this.z = p.z;
    this.h = Math.atan2(p.tx, p.tz);
    this.vx = this.vz = this.vf = this.vr = 0;
    this.steer = 0; this.yaw = 0; this.r = 0; this.delta = 0;
    const pr = track.project(this.x, this.z, p.idx);
    this.idx = pr.idx; this.s = pr.s; this.d = pr.d;
    this.y = track.yAt(pr.s);
  }

  get speed() { return Math.hypot(this.vx, this.vz); }

  slopeAt(track) {
    const tAlign = Math.sin(this.h) * track.T[2 * this.idx] + Math.cos(this.h) * track.T[2 * this.idx + 1];
    return track.G[this.idx] * tAlign;
  }

  step(dt, input, track) {
    this.throttle = input.throttle; this.brake = input.brake;
    const slope = this.slopeAt(track);
    if (this.dynamic) {
      // stiff tyre forces: integrate in sub-steps for stability
      for (let k = 0; k < 4; k++) this.stepDynamic(dt / 4, input, slope);
    }
    else this.stepKinematic(dt, input, slope);
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.postStep(dt, input, track, slope);
  }

  // ------------------------------------------------------------ AI model
  stepKinematic(dt, input, slope) {
    const sinH = Math.sin(this.h), cosH = Math.cos(this.h);
    let vf = this.vx * sinH + this.vz * cosH;
    let vr = -this.vx * cosH + this.vz * sinH;
    const st = clamp(input.steer + this.pull(), -1, 1);
    const growing = Math.abs(st) > Math.abs(this.steer) && Math.sign(st) === Math.sign(this.steer);
    const rate = input.analog ? 10 : (this.arcade ? (growing ? 4.2 : 8) : (growing ? 3.5 : 7)) * this.steerSens;
    this.steer += clamp(st - this.steer, -rate * dt, rate * dt);
    const speed = Math.abs(vf);
    const maxAngle = 0.42 / (1 + speed / 22);
    const delta = this.steer * maxAngle;
    this.delta = -delta;
    let yaw = (vf * Math.tan(delta)) / WHEELBASE;
    const latAcc = Math.abs(yaw * vf);
    const maxLat = maxLateralAccel(speed) * this.gripMul * this.damageGrip(0.12, 0.08);
    let under = 0;
    if (latAcc > maxLat && latAcc > 0) { under = latAcc / maxLat - 1; yaw *= maxLat / latAcc; }
    this.yaw = yaw;
    this.r = -yaw;
    this.h -= yaw * dt;
    let a = 0;
    if (input.throttle > 0 && vf > -0.5) a += input.throttle * engineAccel(vf) * (1 - 0.25 * Math.min(1, under)) * (this.stun > 0 ? 0.3 : 1);
    if (this.ersOn && this.battery > 0 && input.throttle > 0.5 && vf > 0) a += ersAccel(vf);
    if (input.brake > 0) {
      if (vf > 0.5) a -= input.brake * brakeDecel(vf) * Math.min(1, this.weatherGrip * 1.04);
      else if (vf > -9) a -= input.brake * 7;
    }
    if (input.throttle > 0 && vf < -0.5) a += input.throttle * 14;
    if (Math.abs(vf) > 0.3 || input.throttle > 0 || Math.abs(slope) > 0.06) a -= G * slope;
    const coast = dragDecel(Math.abs(vf), this.draft, this.drsOpen);
    if (this.limiter && vf > this.limiter) a = Math.min(a, -4);
    const before = vf;
    vf += a * dt;
    if (Math.abs(vf) > 0.05) vf -= Math.sign(vf) * coast * dt;
    if (input.throttle === 0 && input.brake === 0 && Math.sign(vf) !== Math.sign(before)) vf = 0;
    if (input.throttle === 0 && input.brake === 0 && Math.abs(vf) < 0.3) vf = 0;
    vr -= vf * yaw * dt * 0.18;
    vr *= Math.exp(-8 * dt);
    const sinN = Math.sin(this.h), cosN = Math.cos(this.h);
    this.vx = sinN * vf - cosN * vr;
    this.vz = cosN * vf + sinN * vr;
    this.ax = (vf - before) / dt;
    this.ay = -vf * yaw; // + = towards the left
    this.vf = vf; this.vr = vr;
    this.slip = Math.min(1, under * 1.5 + Math.abs(vr) / 4 + (input.brake > 0.8 && vf > 25 ? 0.15 : 0));
  }

  // ------------------------------------------------------------ player model
  stepDynamic(dt, input, slope) {
    const A = this.assist;
    const sinH = Math.sin(this.h), cosH = Math.cos(this.h);
    let u = this.vx * sinH + this.vz * cosH;          // forward
    let vl = this.vx * cosH - this.vz * sinH;         // lateral, + = left
    const sp = Math.abs(u);

    // --- steering input shaping: speed-sensitive rate, faster self-centring
    const st = clamp(input.steer + this.pull(), -1, 1);
    if (input.analog) this.steer += (st - this.steer) * Math.min(1, dt * 14);
    else {
      const turnIn = (1.45 + 4.2 * Math.exp(-sp / 20)) * A.turnRate * this.steerSens;
      const growing = Math.abs(st) > Math.abs(this.steer) && Math.sign(st) === Math.sign(this.steer || st);
      const rate = st === 0 ? turnIn * 1.9 : growing ? turnIn : turnIn * 2.2;
      this.steer += clamp(st - this.steer, -rate * dt, rate * dt);
    }

    // --- loads (downforce + longitudinal transfer)
    const grip = this.gripMul;
    const down = K_DOWN * u * u;
    const transfer = clamp((M * this.ax * HCG) / WHEELBASE, -0.22 * M * G, 0.22 * M * G);
    const fzF = Math.max(0.15 * M * G, (M * G) * STATIC_FRONT + down * DOWN_FRONT - transfer);
    const fzR = Math.max(0.15 * M * G, (M * G) * (1 - STATIC_FRONT) + down * (1 - DOWN_FRONT) + transfer);
    const maxF = MU * fzF * grip * this.damageGrip(0.3, 0.04), maxR = MU * fzR * grip * 1.04 * this.damageGrip(0, 0.12);

    // --- steering limit: full lock ≈ cornering at the grip limit (+ a bit of slip)
    const aLat = (maxF + maxR) / M;
    const kinDelta = sp > 1 ? Math.atan((WHEELBASE * aLat) / Math.max(sp * sp, 1)) : 0.42;
    const dMax = Math.min(0.42, kinDelta + ALPHA_PEAK * A.limit);
    this.dMax = dMax;
    let delta = -this.steer * dMax;

    // --- longitudinal forces
    let fxR = 0, fxF = 0;
    this.wheelspin = 0; this.lockup = 0; this.tcsActive = false; this.absActive = false;
    if (input.throttle > 0 && u > -0.5) {
      fxR = input.throttle * M * (engineAccel(u) + (this.ersOn && this.battery > 0 && input.throttle > 0.5 ? ersAccel(u) : 0)) * (this.stun > 0 ? 0.3 : 1);
      if (this.limiter && u > this.limiter) fxR = 0;
      if (A.tcs) {
        // traction control: only use the grip left over by cornering (friction circle)
        const usage = Math.min(0.97, Math.abs(this.fyR || 0) / maxR);
        const lim = maxR * (0.12 + 0.83 * Math.sqrt(1 - usage * usage)) * (A.tcs === 'light' ? 1.1 : 1);
        if (fxR > lim) {
          if (A.tcs === 'light' && fxR > maxR * 0.95) this.wheelspin = Math.min(1, (fxR - lim) / maxR);
          fxR = lim;
          this.tcsActive = input.throttle > 0.5;
        }
      } else if (fxR > maxR * 0.95) {
        this.wheelspin = Math.min(1, (fxR - maxR * 0.95) / maxR);
        fxR = maxR * 0.9;
      }
    }
    if (input.brake > 0 && u > 0.5) {
      const fb = input.brake * M * brakeDecel(u);
      fxF = -fb * 0.58; fxR -= fb * 0.42;
      if (-fxF > maxF * 0.97) { if (A.abs) { fxF = -maxF * 0.97; this.absActive = true; } else { this.lockup = 1; fxF = -maxF * 0.8; } }
      if (-fxR > maxR * 0.97) fxR = -maxR * 0.97;
    }

    let fyF = 0, fyR = 0, rDot = 0, uDot = 0, vDot = 0;
    const drag = M * dragDecel(sp, this.draft, this.drsOpen) * Math.sign(u) + (this.limiter && u > this.limiter ? M * 4 : 0);
    const grav = M * G * slope;

    if (sp < 5 || u < 0) {
      // low speed / reverse: kinematic steering (slip angles are ill-defined)
      delta = -this.steer * 0.42;
      let a = 0;
      if (input.throttle > 0) a += u < -0.5 ? input.throttle * 14 : input.throttle * engineAccel(u);
      if (input.brake > 0) a -= u > 0.5 ? input.brake * brakeDecel(u) : (u > -9 ? input.brake * 7 : 0);
      a -= (drag + grav) / M;
      const before = u;
      u += a * dt;
      if (input.throttle === 0 && input.brake === 0 && (Math.sign(u) !== Math.sign(before) || Math.abs(u) < 0.3)) u = 0;
      this.r = (u * Math.tan(delta)) / WHEELBASE;
      vl *= Math.exp(-10 * dt);
      uDot = (u - before) / dt;
      vDot = 0;
      this.slideAngle = 0;
    } else {
      // countersteer assist: steer into a rear slide
      const alphaR0 = Math.atan2(vl - LB * this.r, sp);
      if (A.counter > 0 && Math.abs(alphaR0) > ALPHA_PEAK * 0.5) delta += A.counter * (alphaR0 - Math.sign(alphaR0) * ALPHA_PEAK * 0.5);
      delta = clamp(delta, -0.42, 0.42);

      const alphaF = Math.atan2(vl + LA * this.r, sp) - delta;
      const alphaR = Math.atan2(vl - LB * this.r, sp);
      const capF = Math.sqrt(Math.max(0, maxF * maxF - fxF * fxF)) * (this.lockup ? 0.35 : 1);
      const capR = Math.sqrt(Math.max(0, maxR * maxR - fxR * fxR)) * (1 - 0.65 * this.wheelspin);
      fyF = -capF * tyre(alphaF);
      fyR = -capR * tyre(alphaR);
      this.fyR = fyR;
      const cd = Math.cos(delta), sd = Math.sin(delta);
      uDot = (fxR + fxF * cd - fyF * sd - drag - grav) / M + this.r * vl;
      vDot = (fyR + fyF * cd + fxF * sd) / M - this.r * u;
      rDot = (LA * (fyF * cd + fxF * sd) - LB * fyR) / IZ;
      u += uDot * dt;
      vl += vDot * dt;
      this.r += rDot * dt;
      // stability assist: cap the yaw rate near what the grip can sustain
      const rMax = (aLat / Math.max(sp, 1)) * A.yawLimit;
      if (Math.abs(this.r) > rMax) this.r -= (Math.abs(this.r) - rMax) * Math.sign(this.r) * Math.min(1, dt * 40);
      // keep slides catchable: bleed off excessive drift angle (strength depends on assists)
      const maxSlide = A.yawLimit < 1.1 ? 0.12 : A.yawLimit < 1.3 ? 0.2 : 0.3;
      const sa = Math.atan2(vl, sp);
      if (Math.abs(sa) > maxSlide) vl -= (Math.abs(sa) - maxSlide) * Math.sign(sa) * sp * Math.min(1, dt * 6);
      // light lateral damping keeps keyboard driving tidy
      vl *= Math.exp(-0.6 * dt);
      this.slideAngle = Math.atan2(vl, sp);
      const peak = ALPHA_PEAK * 1.15;
      this.slip = Math.min(1, Math.max(0, Math.abs(alphaR) - peak) * 6 + Math.max(0, Math.abs(alphaF) - peak) * 5 + this.wheelspin + this.lockup * 0.8);
    }
    if (sp < 5 || u < 0) this.slip = Math.min(1, this.wheelspin);
    this.delta = delta;
    this.h += this.r * dt;
    const sinN = Math.sin(this.h), cosN = Math.cos(this.h);
    this.vx = sinN * u + cosN * vl;
    this.vz = cosN * u - sinN * vl;
    this.ax += (uDot - this.ax) * Math.min(1, dt * 12);
    this.ay += ((vDot + this.r * u) - this.ay) * Math.min(1, dt * 12);
    this.vf = u; this.vr = -vl;
    this.yaw = -this.r;
  }

  // ------------------------------------------------------------ damage
  // grip multiplier from damage (only when damage affects performance)
  damageGrip(kWing, kSusp) {
    if (this.damageMode !== 'on') return 1;
    return 1 - kWing * this.damage.wing - kSusp * this.damage.susp;
  }
  // bent suspension pulls the car to one side
  pull() {
    if (this.damageMode !== 'on' || this.damage.susp < 0.05 || Math.abs(this.vf) < 3) return 0;
    return this.damage.susp * 0.07 * this.damage.side;
  }
  // impact: vn = normal speed (m/s), front = 0..1 how head-on, side = +1 left / -1 right
  addDamage(vn, front, side) {
    if (this.damageMode === 'off' || this.pit?.phase === 'stop') return;
    const w = Math.max(0, vn - 5) * 0.075 * (0.35 + front);
    const su = Math.max(0, vn - 9) * 0.045 * (1.25 - 0.5 * front);
    if (w + su < 0.01) return;
    const D = this.damage;
    if (w > D.wing * 0.3 || su > 0.05) D.side = side;
    D.wing = Math.min(1, D.wing + w);
    D.susp = Math.min(1, D.susp + su);
    this.damageHit = Math.max(this.damageHit, w + su);
  }
  repair() { this.damage = { wing: 0, susp: 0, side: 1 }; }

  // ------------------------------------------------------------ shared
  postStep(dt, input, track, slope) {
    this.wallHit = 0;
    this.damageHit = 0;
    this.scraping = false;
    if (this.stun > 0) this.stun -= dt;
    let pr = track.project(this.x, this.z, this.idx);
    const sg0 = pr.d >= 0 ? 1 : -1;
    const lim = track.wallOff - CAR_HALF_WIDTH - (track.inset ? track.inset[2 * pr.idx + (sg0 > 0 ? 0 : 1)] : 0);
    if (Math.abs(pr.d) > lim) {
      const sg = Math.sign(pr.d);
      const nx = track.N[2 * pr.idx] * sg, nz = track.N[2 * pr.idx + 1] * sg;
      const pen = Math.abs(pr.d) - lim;
      this.x -= nx * pen; this.z -= nz * pen;
      const vn = this.vx * nx + this.vz * nz;
      if (vn > 0.05) {
        // 1) normal component: absorbed, small rebound
        const e = 0.12;
        this.vx -= nx * vn * (1 + e); this.vz -= nz * vn * (1 + e);
        // 2) Coulomb friction on the tangential speed (glancing = small loss, head-on = big loss)
        const vt = Math.hypot(this.vx, this.vz);
        if (vt > 0.01) {
          const drop = Math.min(vt, 0.7 * (1 + e) * vn);
          const k = (vt - drop) / vt;
          this.vx *= k; this.vz *= k;
        }
        // 3) hard hits: crumple energy loss
        if (vn > 8) { const k = Math.max(0.5, 1 - (vn - 8) * 0.025); this.vx *= k; this.vz *= k; }
        this.wallHit = vn;
        {
          const sinH = Math.sin(this.h), cosH = Math.cos(this.h);
          const front = Math.max(0, sinH * nx + cosH * nz);
          this.addDamage(vn, front, cosH * nx - sinH * nz > 0 ? 1 : -1);
        }
        // 4) yaw kick: the nose is pushed back towards the track, harder hits = bigger kick
        const sp = Math.hypot(this.vx, this.vz);
        if (sp > 1) {
          let tx = this.vx / sp - nx * Math.min(0.35, vn * 0.03), tz = this.vz / sp - nz * Math.min(0.35, vn * 0.03);
          let dAng = Math.atan2(tx, tz) - this.h;
          while (dAng > Math.PI) dAng -= 2 * Math.PI;
          while (dAng < -Math.PI) dAng += 2 * Math.PI;
          if (Math.abs(dAng) < Math.PI * 0.6) this.h += dAng * Math.min(0.7, 0.2 + vn * 0.04);
        }
        this.r *= 0.4;
        this.r += (Math.random() - 0.5) * Math.min(1.5, vn * 0.08);
        this.stun = Math.max(this.stun || 0, Math.min(0.6, vn * 0.04)); // brief loss of drive after big hits
      }
      // 5) scraping along the wall costs speed every frame of contact
      const scrape = Math.exp(-0.9 * dt);
      this.vx *= scrape; this.vz *= scrape;
      this.scraping = true;
      pr = track.project(this.x, this.z, pr.idx);
    }
    let dS = pr.s - this.s;
    if (dS > track.length / 2) dS -= track.length;
    if (dS < -track.length / 2) dS += track.length;
    this.progress += dS;
    this.idx = pr.idx; this.s = pr.s; this.d = pr.d;
    this.y = track.yAt(pr.s);
    this.pitch = Math.atan(slope);

    // surface: kerbs rumble, dusty run-off has a bit less grip
    const ad = Math.abs(pr.d);
    const onKerb = track.kerb && track.kerb[pr.idx] && ad > track.halfW - 1.2 && ad < track.halfW + 1.6;
    this.kerb = onKerb ? Math.min(1, Math.abs(this.vf) / 25) : 0;
    const surface = ad > track.halfW + 0.9 && !onKerb ? 0.88 : 1;
    this.gripMul = surface * (1 - 0.17 * Math.pow(this.wear, 1.3)) * (this.arcade ? 1.08 : 1) * this.weatherGrip;

    if (this.forcedSlip > 0) { this.slip = Math.max(this.slip, this.forcedSlip); this.forcedSlip = Math.max(0, this.forcedSlip - dt * 1.5); }

    // tyre wear: more with load, sliding and speed
    if (this.wearRate > 0 && Math.abs(this.vf) > 2) {
      const load = 0.3 + Math.abs(this.ay || 0) / 14 + Math.abs(this.ax || 0) / 30 + this.slip * 2;
      // intermediates overheat on a dry track
      const tyreK = this.tyre === 'inter' ? 1 + 2.5 * Math.max(0, 0.25 - (this.trackWet || 0)) * 4 : 1;
      this.wear = Math.min(1, this.wear + dt * this.wearRate * load * tyreK * Math.min(1.6, Math.abs(this.vf) / 50));
    }
    // ERS battery: deploy drains, braking and lifting recharge
    if (this.ersOn && input.throttle > 0.5 && this.vf > 0) this.battery = Math.max(0, this.battery - dt / ERS_DEPLOY_TIME);
    else if (input.brake > 0.2 && this.vf > 12) this.battery = Math.min(1, this.battery + dt / 9);
    else if (input.throttle < 0.1 && this.vf > 12) this.battery = Math.min(1, this.battery + dt / 40);
    if (this.battery <= 0) this.ersOn = false;
    if (this.drsOpen && input.brake > 0.2) this.drsOpen = false;

    const tdot = Math.sin(this.h) * track.T[2 * pr.idx] + Math.cos(this.h) * track.T[2 * pr.idx + 1];
    this.wrongWay = tdot < -0.3 && this.vf > 4 ? this.wrongWay + dt : 0;

    const vf = this.vf;
    this.shift = Math.max(0, this.shift - dt);
    if (vf < -0.5) { this.gear = -1; this.rpm = 4000 + Math.abs(vf) * 400; }
    else {
      if (this.gear < 1) this.gear = 1;
      if (this.gear < 8 && vf > GEARS[this.gear] * 0.98) { this.gear++; this.shift = 0.12; }
      else if (this.gear > 1 && vf < GEARS[this.gear - 1] * 0.8) { this.gear--; this.shift = 0.1; }
      const lo = this.gear > 1 ? GEARS[this.gear - 1] * 0.72 : 0;
      const target = 4200 + 8300 * clamp((vf - lo) / (GEARS[this.gear] - lo), 0, 1) + this.wheelspin * 2500;
      const free = input.throttle > 0 && vf < 1 ? 4200 + 5000 * input.throttle : target;
      this.rpm += (Math.min(12800, Math.max(target, free)) - this.rpm) * Math.min(1, dt * 12);
    }
    this.wheelRot += (vf * dt) / 0.34 * (1 + this.wheelspin * 0.6) * (this.lockup ? 0 : 1);
  }
}

// circle-pair collisions between cars (two circles per car)
export function resolveCarCollisions(cars) {
  const R = 1.0, OFF = 1.45;
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const A = cars[i], B = cars[j];
      if (Math.abs(A.x - B.x) > 7 || Math.abs(A.z - B.z) > 7) continue;
      const ca = [[A.x + Math.sin(A.h) * OFF, A.z + Math.cos(A.h) * OFF], [A.x - Math.sin(A.h) * OFF, A.z - Math.cos(A.h) * OFF]];
      const cb = [[B.x + Math.sin(B.h) * OFF, B.z + Math.cos(B.h) * OFF], [B.x - Math.sin(B.h) * OFF, B.z - Math.cos(B.h) * OFF]];
      for (let ia = 0; ia < 2; ia++) for (let ib = 0; ib < 2; ib++) {
        const pa = ca[ia], pb = cb[ib];
        let dx = pb[0] - pa[0], dz = pb[1] - pa[1];
        const d = Math.hypot(dx, dz);
        if (d >= 2 * R || d < 1e-4) continue;
        dx /= d; dz /= d;
        const pen = (2 * R - d) / 2;
        A.x -= dx * pen; A.z -= dz * pen;
        B.x += dx * pen; B.z += dz * pen;
        const rel = (B.vx - A.vx) * dx + (B.vz - A.vz) * dz;
        if (rel < 0) {
          const imp = (-rel * 1.2) / 2;
          A.vx -= dx * imp; A.vz -= dz * imp;
          B.vx += dx * imp; B.vz += dz * imp;
          A.wallHit = Math.max(A.wallHit, -rel * 0.6);
          B.wallHit = Math.max(B.wallHit, -rel * 0.6);
          // front-to-rear contact breaks the front wing of the car behind; wheel-to-wheel bends suspension
          const v = -rel;
          if (v > 3) {
            const sideOf = (C, x, z) => ((x - C.x) * Math.cos(C.h) - (z - C.z) * Math.sin(C.h) > 0 ? 1 : -1);
            if (ia === 0 && ib === 1) A.addDamage(v + 1, 1, sideOf(A, pb[0], pb[1]));
            else if (ib === 0 && ia === 1) B.addDamage(v + 1, 1, sideOf(B, pa[0], pa[1]));
            else { A.addDamage(v, 0.2, sideOf(A, pb[0], pb[1])); B.addDamage(v, 0.2, sideOf(B, pa[0], pa[1])); }
          }
        }
      }
    }
  }
}

// slipstream: following closely behind another car reduces drag
export function updateDraft(cars) {
  for (const c of cars) {
    let best = 0;
    for (const o of cars) {
      if (o === c) continue;
      const gap = o.progress - c.progress;
      if (gap < 4 || gap > 45 || Math.abs(o.d - c.d) > 2.2 || c.vf < 30) continue;
      best = Math.max(best, 1 - (gap - 4) / 41);
    }
    c.draft += (best - c.draft) * 0.05;
  }
}
