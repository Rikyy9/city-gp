// Input: remappable keyboard actions, gamepad layouts and on-screen touch controls.

export const ACTIONS = [
  { id: 'accel', label: 'Accelera', def: ['ArrowUp', 'KeyW'] },
  { id: 'brake', label: 'Frena / retromarcia', def: ['ArrowDown', 'KeyS'] },
  { id: 'left', label: 'Sterza a sinistra', def: ['ArrowLeft', 'KeyA'] },
  { id: 'right', label: 'Sterza a destra', def: ['ArrowRight', 'KeyD'] },
  { id: 'ers', label: 'Boost ERS (tieni premuto)', def: ['ShiftLeft', 'KeyQ'] },
  { id: 'drs', label: 'Apri DRS', def: ['KeyE', 'Space'] },
  { id: 'pit', label: 'Richiedi pit stop', def: ['KeyP', null] },
  { id: 'flashback', label: 'Flashback (−3 s)', def: ['Backspace', 'KeyF'] },
  { id: 'camera', label: 'Cambia visuale', def: ['KeyC', null] },
  { id: 'line', label: 'Mostra/nascondi traiettoria', def: ['KeyL', null] },
  { id: 'reset', label: 'Rimetti in pista', def: ['KeyR', null] },
  { id: 'pause', label: 'Pausa', def: ['Escape', null] },
  { id: 'mute', label: 'Audio on/off', def: ['KeyM', null] },
];

export const defaultBindings = () => Object.fromEntries(ACTIONS.map((a) => [a.id, a.def.slice()]));

// gamepad layouts (standard mapping button indices)
export const PAD_LAYOUTS = {
  triggers: {
    label: 'Grilletti (RT accelera, LT frena)',
    accel: [7], brake: [6], ers: [4], drs: [5], flashback: [2], camera: [3], reset: [1], pit: [8], pause: [9], line: [12],
  },
  buttons: {
    label: 'Pulsanti (A accelera, X frena)',
    accel: [0], brake: [2], ers: [4], drs: [5], flashback: [3], camera: [13], reset: [1], pit: [8], pause: [9], line: [12],
  },
};
export const PAD_BUTTON_NAMES = { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: 'Back', 9: 'Start', 12: 'Croce ↑', 13: 'Croce ↓' };

export function keyLabel(code) {
  if (!code) return '—';
  const map = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Spazio', Backspace: '⌫', Escape: 'Esc', Enter: 'Invio',
    ShiftLeft: 'Shift sx', ShiftRight: 'Shift dx', ControlLeft: 'Ctrl sx', ControlRight: 'Ctrl dx', AltLeft: 'Alt sx', AltRight: 'Alt dx', Tab: 'Tab',
    MetaLeft: 'Cmd', MetaRight: 'Cmd dx',
  };
  if (map[code]) return map[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}

export class Input {
  constructor() {
    this.keys = new Set();
    this.pressedCodes = new Set();
    this.pressedActions = new Set();
    this.bindings = defaultBindings();
    this.padLayout = 'triggers';
    this.sensitivity = 1;
    // gamepad tuning (Options → Comandi)
    this.pad = null;
    this.deadzone = 0.08;       // stick dead zone
    this.linearity = 1.5;       // 1 = linear, >1 = finer control around the centre
    this.smoothing = 0.04;      // seconds of steering filter
    this.trigDeadzone = 0.04;
    this.rumbleStrength = 1;    // 0..1
    this.padSteer = 0;
    this.fbNext = 0;
    this.impactUntil = 0;
    this.touch = null; // set by TouchControls
    this.capture = null; // key-binding capture callback
    this.throttleK = 0;
    this.brakeK = 0;
    window.addEventListener('keydown', (e) => {
      if (this.capture) { e.preventDefault(); const cb = this.capture; this.capture = null; cb(e.code); return; }
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (this.isBound(e.code)) e.preventDefault();
      if (!this.keys.has(e.code)) {
        this.pressedCodes.add(e.code);
        for (const a of this.actionsFor(e.code)) this.pressedActions.add(a);
      }
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    this.padPrev = {};
  }

  setBindings(b) { this.bindings = { ...defaultBindings(), ...(b || {}) }; }
  isBound(code) { return Object.values(this.bindings).some((arr) => arr.includes(code)); }
  actionsFor(code) { return Object.entries(this.bindings).filter(([, arr]) => arr.includes(code)).map(([id]) => id); }
  down(id) { return (this.bindings[id] || []).some((c) => c && this.keys.has(c)) || !!this.touch?.held(id) || !!this.padHeld?.[id]; }

  // edge-triggered action
  pressed(id) {
    if (this.pressedActions.has(id)) { this.pressedActions.delete(id); return true; }
    return false;
  }
  clearPressed() { this.pressedActions.clear(); this.pressedCodes.clear(); }
  press(id) { this.pressedActions.add(id); }

  // gamepad vibration (ignored where unsupported)
  rumble(strong, weak, ms) {
    const now = performance.now();
    if (now < (this.rumbleUntil || 0) - ms * 0.5) return;
    this.rumbleUntil = now + ms;
    this.impactUntil = now + ms;
    this.playRumble(strong, weak, ms);
  }
  playRumble(strong, weak, ms, trigL = 0, trigR = 0) {
    const k = this.rumbleStrength;
    if (k <= 0) return;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      const act = p?.vibrationActuator;
      if (!act) continue;
      try {
        if ((trigL > 0.02 || trigR > 0.02) && act.effects?.includes?.('trigger-rumble')) {
          act.playEffect('trigger-rumble', { duration: ms, strongMagnitude: Math.min(1, strong * k), weakMagnitude: Math.min(1, weak * k), leftTrigger: Math.min(1, trigL * k), rightTrigger: Math.min(1, trigR * k) });
        } else act.playEffect('dual-rumble', { duration: ms, strongMagnitude: Math.min(1, strong * k), weakMagnitude: Math.min(1, weak * k) });
      } catch { /* not supported */ }
    }
  }
  // continuous force feedback from the car state (called every frame, sent at ~20 Hz)
  feedback(car, active) {
    const now = performance.now();
    if (!this.pad || now < this.fbNext || now < this.impactUntil) return;
    this.fbNext = now + 60;
    if (!active) return;
    const sp = Math.abs(car.vf);
    const engine = 0.02 + Math.max(0, (car.rpm - 9000) / 3800) * 0.06 * car.throttle;
    const kerb = car.kerb ? car.kerb * (0.35 + 0.25 * Math.sin(now / 35)) : 0;
    const slip = Math.min(1, car.slip) * Math.min(1, sp / 20);
    const lock = car.lockup || car.absActive ? 0.35 + 0.25 * Math.sin(now / 20) : 0;
    const spin = car.wheelspin || car.tcsActive ? 0.3 : 0;
    const shift = car.shift > 0.08 ? 0.25 : 0;
    const strong = Math.min(1, kerb + lock * 0.5 + shift);
    const weak = Math.min(1, engine + slip * 0.45 + kerb * 0.5 + spin * 0.4 + (car.damage?.susp || 0) * 0.15 * Math.min(1, sp / 30));
    this.playRumble(strong, weak, 110, car.brake > 0.1 ? lock + slip * 0.3 : 0, car.throttle > 0.1 ? spin + slip * 0.2 : 0);
  }

  read(dt) {
    this.pollPad();
    const up = this.down('accel'), dn = this.down('brake');
    const left = this.down('left'), right = this.down('right');
    this.throttleK += ((up ? 1 : 0) - this.throttleK) * Math.min(1, dt * 10);
    this.brakeK += ((dn ? 1 : 0) - this.brakeK) * Math.min(1, dt * 14);
    let out = {
      throttle: this.throttleK < 0.02 ? 0 : this.throttleK,
      brake: this.brakeK < 0.02 ? 0 : this.brakeK,
      steer: (right ? 1 : 0) - (left ? 1 : 0),
      analog: false,
    };
    const p = this.pad;
    if (p) {
      const L = PAD_LAYOUTS[this.padLayout] || PAD_LAYOUTS.triggers;
      const tdz = this.trigDeadzone;
      const val = (ids) => {
        const v = Math.max(0, ...ids.map((i) => (p.buttons[i] ? p.buttons[i].value : 0)));
        return v <= tdz ? 0 : Math.min(1, (v - tdz) / (0.97 - tdz));
      };
      const ax = p.axes[0] || 0;
      const dz = this.deadzone;
      const gamma = this.linearity / Math.max(0.4, this.sensitivity);
      const raw = Math.abs(ax) > dz ? Math.sign(ax) * Math.min(1, (Math.abs(ax) - dz) / (0.98 - dz)) ** gamma : 0;
      // light low-pass filter removes stick jitter without adding noticeable lag
      this.padSteer += (raw - this.padSteer) * (this.smoothing > 0.001 ? Math.min(1, dt / this.smoothing) : 1);
      if (raw === 0 && Math.abs(this.padSteer) < 0.01) this.padSteer = 0;
      const steer = this.padSteer;
      const thr = val(L.accel), brk = val(L.brake);
      if (Math.abs(steer) > 0 || thr > 0.02 || brk > 0.02) {
        out = {
          throttle: Math.max(out.throttle, thr),
          brake: Math.max(out.brake, brk),
          steer: Math.abs(steer) > 0 ? steer : out.steer,
          analog: Math.abs(steer) > 0,
        };
      }
    }
    if (this.touch) {
      const t = this.touch.read();
      if (t.active) {
        out.throttle = Math.max(out.throttle, t.throttle);
        out.brake = Math.max(out.brake, t.brake);
        if (t.brake) out.throttle = 0;
        if (t.steer !== 0 || t.analog) { out.steer = t.steer; out.analog = t.analog; }
        out.touch = true;
      }
    }
    return out;
  }

  pollPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const had = this.pad;
    this.pad = null;
    this.padHeld = {};
    for (const p of pads) {
      if (!p || !p.connected) continue;
      this.pad = p;
      if (!had || had.index !== p.index) this.onPadChange?.(p);
      const L = PAD_LAYOUTS[this.padLayout] || PAD_LAYOUTS.triggers;
      for (const [action, ids] of Object.entries(L)) {
        if (action === 'label') continue;
        const held = ids.some((i) => p.buttons[i] && p.buttons[i].pressed);
        if (held) this.padHeld[action] = true;
        const key = p.index + ':' + action;
        if (held && !this.padPrev[key] && !['accel', 'brake'].includes(action)) this.pressedActions.add(action);
        this.padPrev[key] = held;
      }
      break;
    }
    if (had && !this.pad) this.onPadChange?.(null);
  }

  // capture the next key press (for re-binding)
  captureKey(cb) { this.capture = cb; }
}
