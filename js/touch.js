// On-screen touch controls (multi-touch, pointer events).

const HOLD = ['left', 'right', 'accel', 'brake', 'ers'];
const TAP = ['drs', 'pit', 'flashback', 'camera', 'pause'];

export const isTouchDevice = () => window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 1;

export class TouchControls {
  constructor(root, input) {
    this.input = input;
    this.state = {};
    this.root = root;
    this.pointers = new Map(); // pointerId -> action
    root.innerHTML = `
      <div class="tc-steer">
        <button data-a="left" aria-label="Sinistra">◀</button>
        <button data-a="right" aria-label="Destra">▶</button>
      </div>
      <div class="tc-pedals">
        <div class="tc-small">
          <button data-a="ers" class="tc-ers">ERS</button>
          <button data-a="drs" class="tc-drs">DRS</button>
        </div>
        <button data-a="brake" class="tc-brake">FRENO</button>
        <button data-a="accel" class="tc-accel">GAS</button>
      </div>
      <div class="tc-top">
        <button data-a="flashback">⟲</button>
        <button data-a="camera">🎥</button>
        <button data-a="pit">PIT</button>
        <button data-a="pause">❚❚</button>
      </div>`;
    root.addEventListener('pointerdown', (e) => this.onDown(e));
    root.addEventListener('pointermove', (e) => this.onMove(e));
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) root.addEventListener(ev, (e) => this.onUp(e));
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    input.touch = this;
  }

  held(id) { return !!this.state[id]; }

  actionAt(x, y) {
    const el = document.elementFromPoint(x, y);
    const b = el && el.closest && el.closest('[data-a]');
    return b && this.root.contains(b) ? b.dataset.a : null;
  }

  set(action, on) {
    if (!action) return;
    if (HOLD.includes(action)) {
      this.state[action] = on;
      this.root.querySelector(`[data-a="${action}"]`)?.classList.toggle('on', on);
    }
  }

  onDown(e) {
    const a = this.actionAt(e.clientX, e.clientY);
    if (!a) return;
    e.preventDefault();
    try { this.root.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (TAP.includes(a)) { this.input.press(a); navigator.vibrate?.(10); return; }
    this.pointers.set(e.pointerId, a);
    this.set(a, true);
  }

  // sliding a finger between the two steering (or pedal) buttons switches action
  onMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const prev = this.pointers.get(e.pointerId);
    const a = this.actionAt(e.clientX, e.clientY);
    if (a && a !== prev && HOLD.includes(a)) {
      this.set(prev, false);
      this.pointers.set(e.pointerId, a);
      this.set(a, true);
    }
  }

  onUp(e) {
    const a = this.pointers.get(e.pointerId);
    if (!a) return;
    this.pointers.delete(e.pointerId);
    if (![...this.pointers.values()].includes(a)) this.set(a, false);
  }

  show(on) { this.root.classList.toggle('hidden', !on); if (!on) { this.state = {}; this.pointers.clear(); } }
}
