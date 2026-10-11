// On-screen touch controls in the style of the big mobile racing games:
//  - three steering schemes: big buttons, a floating analog "wheel" slider, or tilting the phone
//  - pedals on the right (optional auto-accelerate), ERS / DRS above them
//  - pause top-left, camera / flashback / pit in a column on the right
//  - size, opacity and left-handed layout are configurable; light haptics on Android

const HOLD = ['left', 'right', 'accel', 'brake', 'ers'];
const TAP = ['drs', 'pit', 'flashback', 'camera', 'pause'];

export const isTouchDevice = () => window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 1;

const ICON = {
  left: '<svg viewBox="0 0 24 24"><path d="M15 4 7 12l8 8" /></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="m9 4 8 8-8 8" /></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14" /></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M3 8h12v9H3zM15 11l6-3v9l-6-3" /></svg>',
  flashback: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v5h5" /></svg>',
};

export class TouchControls {
  constructor(root, input) {
    this.input = input;
    this.root = root;
    this.state = {};
    this.pointers = new Map(); // pointerId -> action | 'wheel'
    this.scheme = 'buttons';   // 'buttons' | 'wheel' | 'tilt'
    this.autoAccel = true;
    this.haptics = true;
    this.tiltSens = 1;
    this.tiltInvert = false;
    this.wheel = { id: null, x0: 0, x: 0, value: 0 };
    this.tilt = { angle: 0, zero: null, value: 0, ok: false };
    root.innerHTML = `
      <div class="tc-steer">
        <button data-a="left" aria-label="Sinistra">${ICON.left}</button>
        <button data-a="right" aria-label="Destra">${ICON.right}</button>
      </div>
      <div class="tc-wheel-zone" data-zone="wheel"><div class="tc-wheel"><i></i></div><span>Trascina per sterzare</span></div>
      <div class="tc-tilt-zone"><button data-a="calibrate" class="tc-cal">Centra</button><div class="tc-tilt"><i></i></div></div>
      <div class="tc-pedals">
        <div class="tc-small">
          <button data-a="ers" class="tc-ers">ERS<em></em></button>
          <button data-a="drs" class="tc-drs">DRS</button>
        </div>
        <button data-a="brake" class="tc-brake">FRENO</button>
        <button data-a="accel" class="tc-accel">GAS</button>
      </div>
      <button data-a="pause" class="tc-pause" aria-label="Pausa">${ICON.pause}</button>
      <div class="tc-side">
        <button data-a="flashback" aria-label="Flashback">${ICON.flashback}</button>
        <button data-a="camera" aria-label="Visuale">${ICON.camera}</button>
        <button data-a="pit" aria-label="Box">PIT</button>
      </div>`;
    root.addEventListener('pointerdown', (e) => this.onDown(e));
    root.addEventListener('pointermove', (e) => this.onMove(e));
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) root.addEventListener(ev, (e) => this.onUp(e));
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.onMotion = (e) => this.motion(e);
    input.touch = this;
  }

  configure({ scheme, autoAccel, size, opacity, lefty, haptics, tiltSens, tiltInvert }) {
    if (scheme) this.scheme = scheme;
    if (autoAccel !== undefined) this.autoAccel = autoAccel;
    if (haptics !== undefined) this.haptics = haptics;
    if (tiltSens !== undefined) this.tiltSens = tiltSens;
    if (tiltInvert !== undefined) this.tiltInvert = tiltInvert;
    const r = this.root;
    r.dataset.scheme = this.scheme;
    r.classList.toggle('auto-accel', this.autoAccel);
    r.classList.toggle('lefty', !!lefty);
    if (size) r.style.setProperty('--tc-scale', { s: 0.82, m: 1, l: 1.2 }[size] || 1);
    if (opacity !== undefined) r.style.setProperty('--tc-alpha', opacity);
    if (this.scheme === 'tilt') this.startTilt(); else window.removeEventListener('devicemotion', this.onMotion);
  }

  // iOS asks for permission to read the motion sensors (must come from a tap)
  static async requestTiltPermission() {
    const DM = window.DeviceMotionEvent;
    if (DM && typeof DM.requestPermission === 'function') {
      try { return (await DM.requestPermission()) === 'granted'; } catch { return false; }
    }
    return !!DM;
  }

  startTilt() {
    window.removeEventListener('devicemotion', this.onMotion);
    window.addEventListener('devicemotion', this.onMotion);
  }
  calibrate() { this.tilt.zero = null; }

  // steering angle from gravity, measured in the plane of the screen (independent of how far back the
  // phone is tilted); the first readings after calibrate() become "straight ahead"
  motion(e) {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null) return;
    const angle = (screen.orientation?.angle ?? window.orientation ?? 0) % 360;
    let sx, sy;
    if (angle === 90) { sx = -g.y; sy = g.x; } else if (angle === 270 || angle === -90) { sx = g.y; sy = -g.x; } else { sx = g.x; sy = g.y; }
    // turning the phone clockwise (right) moves "up" towards the screen's left: negative atan2.
    // iOS reports gravity with the opposite sign: that only adds 180°, which the calibration removes.
    const a = -Math.atan2(sx, sy) * (this.tiltInvert ? -1 : 1);
    this.tilt.ok = true;
    if (this.tilt.zero == null) this.tilt.zero = a;
    let d = a - this.tilt.zero;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const maxTilt = (28 * Math.PI / 180) / this.tiltSens;
    const raw = Math.max(-1, Math.min(1, d / maxTilt));
    const dz = 0.04;
    this.tilt.value = Math.abs(raw) < dz ? 0 : Math.sign(raw) * (Math.abs(raw) - dz) / (1 - dz);
  }

  held(id) { return !!this.state[id]; }

  // driving input from the touch layer
  read() {
    const s = this.state;
    let steer = 0, analog = false;
    if (this.scheme === 'wheel') { steer = this.wheel.value; analog = true; }
    else if (this.scheme === 'tilt' && this.tilt.ok) { steer = this.tilt.value; analog = true; }
    else steer = (s.right ? 1 : 0) - (s.left ? 1 : 0);
    const brake = s.brake ? 1 : 0;
    const throttle = brake ? 0 : this.autoAccel || s.accel ? 1 : 0;
    this.drawSteer(steer);
    return { steer, analog, throttle, brake, active: !this.root.classList.contains('hidden') };
  }

  drawSteer(v) {
    if (this.scheme === 'tilt') {
      const el = this.root.querySelector('.tc-tilt i');
      if (el) el.style.transform = `translateX(${v * 56}px)`;
    }
  }

  actionAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || !el.closest || !this.root.contains(el)) return null;
    const b = el.closest('[data-a]');
    if (b) return b.dataset.a;
    if (el.closest('[data-zone="wheel"]')) return 'wheel';
    return null;
  }

  buzz(ms = 8) { if (this.haptics && navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(ms); }

  set(action, on) {
    if (!action || !HOLD.includes(action)) return;
    this.state[action] = on;
    this.root.querySelector(`[data-a="${action}"]`)?.classList.toggle('on', on);
  }

  onDown(e) {
    const a = this.actionAt(e.clientX, e.clientY);
    if (!a) return;
    e.preventDefault();
    try { this.root.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (a === 'calibrate') { this.calibrate(); this.buzz(15); return; }
    if (TAP.includes(a)) { this.input.press(a); this.buzz(10); return; }
    if (a === 'wheel') {
      if (this.wheel.id != null) return;
      const zone = this.root.querySelector('.tc-wheel-zone').getBoundingClientRect();
      this.wheel = { id: e.pointerId, x0: e.clientX, x: e.clientX, value: 0 };
      const w = this.root.querySelector('.tc-wheel');
      w.style.left = `${e.clientX - zone.left}px`;
      w.style.top = `${e.clientY - zone.top}px`;
      w.classList.add('on');
      this.pointers.set(e.pointerId, 'wheel');
      return;
    }
    this.pointers.set(e.pointerId, a);
    this.set(a, true);
    this.buzz(6);
  }

  // sliding a finger between the two steering (or pedal) buttons switches action; the wheel follows the finger
  onMove(e) {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    if (prev === 'wheel') {
      const range = 64 * (parseFloat(getComputedStyle(this.root).getPropertyValue('--tc-scale')) || 1);
      const dx = e.clientX - this.wheel.x0;
      // the centre drifts with the finger beyond full lock, so reversing is always quick
      if (Math.abs(dx) > range) this.wheel.x0 = e.clientX - Math.sign(dx) * range;
      const v = Math.max(-1, Math.min(1, (e.clientX - this.wheel.x0) / range));
      this.wheel.value = Math.sign(v) * Math.min(1, Math.abs(v) ** 1.25);
      this.root.querySelector('.tc-wheel i').style.transform = `translateX(${v * 100}%)`;
      return;
    }
    const a = this.actionAt(e.clientX, e.clientY);
    if (a && a !== prev && HOLD.includes(a) && HOLD.includes(prev)) {
      this.set(prev, false);
      this.pointers.set(e.pointerId, a);
      this.set(a, true);
      this.buzz(5);
    }
  }

  onUp(e) {
    const a = this.pointers.get(e.pointerId);
    if (!a) return;
    this.pointers.delete(e.pointerId);
    if (a === 'wheel') {
      this.wheel = { id: null, x0: 0, x: 0, value: 0 };
      const w = this.root.querySelector('.tc-wheel');
      w.classList.remove('on');
      w.style.left = w.style.top = '';
      w.querySelector('i').style.transform = '';
      return;
    }
    if (![...this.pointers.values()].includes(a)) this.set(a, false);
  }

  // HUD feedback on the buttons: DRS available/open, ERS charge, pit requested
  setFlags({ drsAvail, drsOpen, ers, battery, pit }) {
    const q = (s) => this.root.querySelector(s);
    q('.tc-drs').classList.toggle('avail', !!drsAvail);
    q('.tc-drs').classList.toggle('open', !!drsOpen);
    q('.tc-ers').classList.toggle('active', !!ers);
    q('.tc-ers em').style.width = `${Math.round((battery ?? 1) * 100)}%`;
    q('[data-a="pit"]').classList.toggle('active', !!pit);
  }

  show(on) {
    this.root.classList.toggle('hidden', !on);
    if (!on) {
      this.state = {};
      this.pointers.clear();
      this.wheel = { id: null, x0: 0, x: 0, value: 0 };
      this.root.querySelectorAll('.on').forEach((b) => b.classList.remove('on'));
    } else if (this.scheme === 'tilt') {
      this.calibrate();
      // no motion sensor data (desktop, blocked permission, insecure page): fall back to the buttons
      clearTimeout(this.tiltCheck);
      this.root.classList.remove('no-tilt');
      this.tiltCheck = setTimeout(() => { if (!this.tilt.ok) this.root.classList.add('no-tilt'); }, 2500);
    }
  }
}
