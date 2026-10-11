// Gamepad navigation for menus: D-pad / left stick moves a focus ring between buttons,
// A presses, B goes back, left/right change sliders.

const SELECTOR = 'button:not([disabled]), input[type=range], .cand, .saved-item .t';

export class PadNav {
  // getRoot(): element whose controls are navigable right now (or null); onBack(): B button
  constructor({ getRoot, onBack }) {
    this.getRoot = getRoot;
    this.onBack = onBack;
    this.prev = {};
    this.repeatAt = 0;
    this.focus = null;
    this.used = false;
  }

  visible(el) {
    if (!el.isConnected || el.closest('.hidden')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
  }

  update() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const p = [...pads].find((x) => x && x.connected);
    const root = this.getRoot();
    if (!p || !root) { this.setFocus(null); return; }
    const btn = (i) => !!(p.buttons[i] && p.buttons[i].pressed);
    const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
    const dir = btn(12) || ay < -0.6 ? 'up' : btn(13) || ay > 0.6 ? 'down' : btn(14) || ax < -0.6 ? 'left' : btn(15) || ax > 0.6 ? 'right' : null;
    const now = performance.now();
    const edge = (k, on) => { const was = this.prev[k]; this.prev[k] = on; return on && !was; };
    const dirEdge = edge('dir:' + dir, !!dir);
    if (dir && (dirEdge || now > this.repeatAt)) {
      this.repeatAt = now + (dirEdge ? 380 : 140);
      this.used = true;
      this.move(root, dir);
    }
    if (!dir) for (const k of Object.keys(this.prev)) if (k.startsWith('dir:')) this.prev[k] = false;
    if (edge('a', btn(0))) {
      this.used = true;
      if (!this.focus || !root.contains(this.focus) || !this.visible(this.focus)) this.move(root, null);
      else this.focus.click();
    }
    if (edge('b', btn(1))) this.onBack?.();
    if (this.focus && (!root.contains(this.focus) || !this.visible(this.focus))) this.setFocus(null);
  }

  move(root, dir) {
    const els = [...root.querySelectorAll(SELECTOR)].filter((e) => this.visible(e));
    if (!els.length) return;
    const cur = this.focus && els.includes(this.focus) ? this.focus : null;
    if (!cur || !dir) { this.setFocus(root.querySelector('.btn.primary:not([disabled])') && this.visible(root.querySelector('.btn.primary:not([disabled])')) ? root.querySelector('.btn.primary:not([disabled])') : els[0]); return; }
    // sliders: left/right change the value
    if (cur.type === 'range' && (dir === 'left' || dir === 'right')) {
      const st = parseFloat(cur.step) || 0.05;
      cur.value = Math.min(+cur.max, Math.max(+cur.min, +cur.value + (dir === 'right' ? st : -st)));
      cur.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bd = Infinity;
    for (const e of els) {
      if (e === cur) continue;
      const r = e.getBoundingClientRect();
      const dx = r.left + r.width / 2 - ax, dy = r.top + r.height / 2 - ay;
      const main = dir === 'up' ? -dy : dir === 'down' ? dy : dir === 'left' ? -dx : dx;
      const ortho = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
      if (main <= 2) continue;
      const score = main + ortho * 2.2;
      if (score < bd) { bd = score; best = e; }
    }
    if (best) this.setFocus(best);
  }

  setFocus(el) {
    if (this.focus === el) return;
    this.focus?.classList.remove('pad-focus');
    this.focus = el;
    if (el) {
      el.classList.add('pad-focus');
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
}
