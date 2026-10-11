// AI drivers: racing line + speed profile, with personalities, mistakes, overtaking/defending
// and (optional) adaptive pace around the player.

import { WHEELBASE } from './physics.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export const PERSONALITIES = [
  { id: 'aggressive', label: 'Aggressivo', aggression: 0.95, consistency: 0.6, defense: 0.85 },
  { id: 'consistent', label: 'Costante', aggression: 0.5, consistency: 0.95, defense: 0.55 },
  { id: 'defensive', label: 'Difensivo', aggression: 0.4, consistency: 0.82, defense: 0.95 },
  { id: 'rookie', label: 'Esordiente', aggression: 0.65, consistency: 0.45, defense: 0.35 },
];

export class AIDriver {
  constructor(car, track, skill, rnd, persona = PERSONALITIES[1]) {
    this.car = car;
    this.track = track;
    this.skill = skill;
    this.rnd = rnd;
    this.persona = persona;
    this.avoid = 0;
    this.stuck = 0;
    this.lineBias = (rnd() - 0.5) * 0.4;
    this.reaction = 0.85 + rnd() * 0.3;
    this.adapt = 1;
    this.corner = -1;        // speed-profile minimum we are heading to
    this.mistake = null;     // { type, corner, factor, side, until }
    this.passSide = 0;       // committed overtaking side (+left / -right offset)
    this.passTimer = 0;
    this.defend = 0;         // defending lateral target offset
    this.defendCorner = -1;
  }

  // next corner = local minimum of the speed profile within ~300 m
  nextCorner(from) {
    const T = this.track;
    let best = -1, bv = Infinity;
    for (let k = 4; k < 150; k += 2) {
      const i = T.wrap(from + k);
      if (T.speedProfile[i] < bv) { bv = T.speedProfile[i]; best = i; }
    }
    return { idx: best, v: bv };
  }

  control(cars, dt, raceStarted, ctx = {}) {
    const c = this.car, T = this.track, P = this.persona;
    if (!raceStarted) return { throttle: 0, brake: 0, steer: 0 };
    const v = Math.max(c.vf, 0);
    const lim = T.halfW - 1.2;
    const corner = this.nextCorner(c.idx);
    const cornerDist = ((corner.idx - c.idx + T.n) % T.n) * T.ds;
    const inside = Math.sign(T.raceOffset[corner.idx]) || 1; // apex side
    const brakingZone = v > corner.v + 6 && cornerDist < 160;

    // --- mistakes: rolled once per corner, more likely for inconsistent drivers
    if (corner.idx !== this.corner) {
      this.corner = corner.idx;
      const p = 0.07 * (1 - P.consistency) * (ctx.mistakes === false ? 0 : 1);
      if (corner.v < 45 && this.rnd() < p) {
        const r = this.rnd();
        this.mistake = r < 0.55
          ? { type: 'late', corner: corner.idx, factor: 1.07 + this.rnd() * 0.07 }
          : { type: 'wide', corner: corner.idx, side: -inside, until: -1 };
      }
    }
    if (this.mistake && this.mistake.type === 'late') {
      const past = ((c.idx - this.mistake.corner + T.n) % T.n) < 40;
      if (past) this.mistake = null;
    }
    if (this.mistake && this.mistake.type === 'wide' && this.mistake.until < 0 && ((c.idx - this.mistake.corner + T.n) % T.n) < 5) { this.mistake.until = ctx.time + 2.5; this.mistakeEvent = 'wide'; }
    if (this.mistake && this.mistake.type === 'wide' && this.mistake.until > 0 && ctx.time > this.mistake.until) this.mistake = null;

    // --- adaptive pace around the player (keeps the race close)
    if (ctx.adaptive && ctx.player && ctx.player !== c) {
      const dp = c.progress - ctx.player.progress;
      const target = dp > 150 ? 0.965 : dp < -200 ? 1.02 : 1 - clamp(dp, -200, 150) * 0.00012;
      this.adapt += (target - this.adapt) * Math.min(1, dt * 0.08);
    } else this.adapt = 1;

    const lineHere = clamp(T.raceOffset[c.idx] + this.lineBias, -lim, lim);
    const planned = clamp(lineHere + this.avoid, -lim, lim);

    // --- traffic analysis
    let ahead = null, gapAhead = 60, behind = null, gapBehind = 30;
    const alongside = [];
    for (const o of cars) {
      if (o === c) continue;
      const gap = o.progress - c.progress;
      if (Math.abs(gap) < 6 && Math.abs(c.d - o.d) < 3) alongside.push(o);
      if (gap > 2 && gap < gapAhead && Math.abs(o.d - planned) < 2.6) { ahead = o; gapAhead = gap; }
      if (gap < -2 && -gap < gapBehind) { behind = o; gapBehind = -gap; }
    }

    let speedCap = Infinity;
    let avoidTarget = 0;
    let late = 1;

    // --- overtaking
    if (ahead) {
      const closing = c.vf - ahead.vf;
      const wantPass = closing > -0.5 || gapAhead < 14;
      if (wantPass) {
        const sides = this.passTimer > 0 && this.passSide ? [this.passSide] : [inside, -inside];
        let chosen = 0;
        for (const sd of sides) {
          const off = clamp(ahead.d + sd * 3.4, -lim, lim);
          if (Math.abs(off - ahead.d) < 2.7) continue;
          const blocked = cars.some((o) => o !== c && o !== ahead && Math.abs(o.progress - c.progress - gapAhead / 2) < gapAhead / 2 + 8 && Math.abs(o.d - off) < 2.6);
          if (!blocked) { chosen = sd; break; }
        }
        if (chosen) {
          this.passSide = chosen;
          this.passTimer = 1.5;
          avoidTarget = clamp(ahead.d + chosen * 3.4, -lim, lim) - lineHere;
          // out-braking on the inside: brake a touch later (aggressive drivers more)
          if (brakingZone && chosen === inside && gapAhead < 10) late = 1 + 0.035 * P.aggression;
        } else {
          // no room: follow, never ram
          speedCap = ahead.vf + clamp((gapAhead - 9) * 0.7, -6, 4);
        }
      }
      const ttc = closing > 0 ? (gapAhead - 5.5) / closing : Infinity;
      if (ttc < 1.1 && Math.abs(c.d - ahead.d) < 2.3) speedCap = Math.min(speedCap, ahead.vf - 1);
    } else {
      this.passTimer -= dt;
      if (this.passTimer <= 0) this.passSide = 0;
    }

    // --- defending: one move to the inside before the braking zone
    if (!ahead && behind && gapBehind < 22 && cornerDist < 220 && cornerDist > 60 && behind.vf > c.vf - 3) {
      if (this.defendCorner !== corner.idx && this.rnd() < P.defense * dt * 4) {
        this.defendCorner = corner.idx;
        this.defend = inside * (lim - 0.6);
      }
    }
    if (this.defendCorner !== corner.idx && ((c.idx - this.defendCorner + T.n) % T.n) > 30) this.defend = 0;
    if (this.defend && !ahead && alongside.length === 0) avoidTarget = this.defend - lineHere;

    // --- side by side: the car on the outside gives way, keep a car's width
    for (const o of alongside) {
      const dl = c.d - o.d;
      const dir = dl !== 0 ? Math.sign(dl) : (c.d >= 0 ? 1 : -1);
      avoidTarget += (3 - Math.abs(dl)) * dir * 1.2;
      const oInside = o.d * inside > c.d * inside;
      if (oInside && o.progress >= c.progress - 1 && cornerDist < 120) speedCap = Math.min(speedCap, o.vf - 0.5 + 2 * P.aggression);
    }

    // running wide after a mistake
    if (this.mistake && this.mistake.type === 'wide' && this.mistake.until > 0) avoidTarget = this.mistake.side * (lim + 0.6) - lineHere;

    avoidTarget = clamp(lineHere + avoidTarget, -lim - 0.6, lim) - lineHere;
    this.avoid += clamp(avoidTarget - this.avoid, -4 * dt, 4 * dt);

    // --- steering: pure pursuit
    const look = 7 + v * 0.33;
    const ia = T.wrap(c.idx + Math.round(look / T.ds));
    const off = clamp(T.raceOffset[ia] + this.lineBias + this.avoid, -lim - 0.6, lim + 0.6);
    const tx = T.P[2 * ia] + T.N[2 * ia] * off, tz = T.P[2 * ia + 1] + T.N[2 * ia + 1] * off;
    const dx = tx - c.x, dz = tz - c.z;
    const sinH = Math.sin(c.h), cosH = Math.cos(c.h);
    const fwd = dx * sinH + dz * cosH, right = -dx * cosH + dz * sinH;
    const alpha = Math.atan2(right, fwd);
    const Ld = Math.max(3, Math.hypot(dx, dz));
    const delta = Math.atan((2 * WHEELBASE * Math.sin(alpha)) / Ld);
    const maxAngle = c.dynamic ? (c.dMax || 0.42) : 0.42 / (1 + v / 22);
    const steer = clamp(delta / maxAngle, -1, 1);

    // --- speed
    const iv = T.wrap(c.idx + Math.round((2 + v * 0.16 * this.reaction) / T.ds));
    let vt = Math.min(T.speedProfile[iv], T.speedProfile[c.idx] + 4) * this.skill * this.adapt * late;
    if (this.mistake && this.mistake.type === 'late') vt *= this.mistake.factor;
    if (Math.abs(this.avoid) > 1.5) vt *= 0.99;
    // the speed profile assumes the best tyre for the weather and an undamaged car
    vt *= Math.sqrt(Math.max(0.5, (c.weatherGrip || 1) / (T.weatherGrip || 1)) * c.damageGrip(0.12, 0.08));
    if (c.finished) vt *= 0.72;
    vt = Math.min(vt, speedCap);
    let throttle = 0, brake = 0;
    if (v > vt + 0.6) brake = clamp((v - vt) / 5, 0.15, 1);
    else throttle = clamp((vt - v) / 2 + 0.35, 0, 1);
    if (this.mistake && this.mistake.type === 'late' && brake > 0.5) {
      c.forcedSlip = 0.6; // lock-up smoke
      if (!this.mistake.told) { this.mistake.told = true; this.mistakeEvent = 'late'; }
    }

    // --- energy: boost on straights, DRS when allowed
    const straight = Math.abs(T.raceKappa[T.wrap(c.idx + 40)]) < 1 / 300 && Math.abs(T.raceKappa[c.idx]) < 1 / 300;
    c.ersOn = straight && v > 30 && c.battery > 0.2 + (1 - this.skill) * 2 && throttle > 0.9;
    if (c.drsAvailable && c.inDrsZone && straight) c.drsOpen = true;

    // --- recovery
    if (v < 2) this.stuck += dt; else this.stuck = 0;
    if (this.stuck > 2.5 || c.wrongWay > 1.5) {
      this.stuck = 0;
      c.place(T, T.S[c.idx], T.raceOffset[c.idx]);
    }
    return { throttle, brake, steer };
  }
}

// follow the track at a fixed lateral offset and target speed (used for the pit lane & qualifying out-lap)
export function followLine(c, T, offset, targetSpeed) {
  const v = Math.max(c.vf, 0);
  const look = 6 + v * 0.3;
  const ia = T.wrap(c.idx + Math.round(look / T.ds));
  const tx = T.P[2 * ia] + T.N[2 * ia] * offset, tz = T.P[2 * ia + 1] + T.N[2 * ia + 1] * offset;
  const dx = tx - c.x, dz = tz - c.z;
  const sinH = Math.sin(c.h), cosH = Math.cos(c.h);
  const alpha = Math.atan2(-dx * cosH + dz * sinH, dx * sinH + dz * cosH);
  const Ld = Math.max(3, Math.hypot(dx, dz));
  const delta = Math.atan((2 * WHEELBASE * Math.sin(alpha)) / Ld);
  const maxAngle = c.dynamic ? (c.dMax || 0.42) : 0.42 / (1 + v / 22);
  const steer = clamp(delta / maxAngle, -1, 1);
  let throttle = 0, brake = 0;
  if (v > targetSpeed + 0.5) brake = clamp((v - targetSpeed) / 4, 0.2, 1);
  else throttle = clamp((targetSpeed - v) / 3, 0, 1);
  if (targetSpeed <= 0.01) { throttle = 0; brake = 1; }
  return { throttle, brake, steer, analog: true };
}
