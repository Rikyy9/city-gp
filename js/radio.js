// Team radio and commentary: short Italian messages, spoken with the browser's speech synthesis
// (when available) and always shown as subtitles in the HUD.

const PRIORITY = { low: 0, normal: 1, high: 2 };

export class Radio {
  // el: subtitle element; audio: GameAudio (for the squelch and ducking)
  constructor({ el, audio }) {
    this.el = el;
    this.audio = audio;
    this.mode = 'voice';      // 'voice' | 'text' | 'off'
    this.commentary = true;
    this.volume = 0.9;
    this.queue = [];
    this.busy = false;
    this.nextAt = 0;
    this.voices = { team: null, comment: null };
    this.synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
    if (this.synth) {
      const pick = () => {
        const all = this.synth.getVoices().filter((v) => /^it/i.test(v.lang));
        if (!all.length) return;
        // prefer voices that run on the device (no text sent online), then natural / enhanced ones
        const score = (v) => (v.localService ? 4 : 0) + (/(natural|enhanced|premium|neural|siri)/i.test(v.name) ? 1 : 0);
        all.sort((a, b) => score(b) - score(a));
        this.voices.team = all[0];
        this.voices.comment = all.find((v) => v !== all[0]) || all[0];
      };
      pick();
      this.synth.addEventListener?.('voiceschanged', pick);
    }
  }

  configure({ mode, commentary, volume }) {
    if (mode) this.mode = mode;
    if (commentary !== undefined) this.commentary = commentary;
    if (volume !== undefined) this.volume = volume;
    if (this.mode === 'off') this.stop();
  }

  // kind: 'team' (engineer) | 'comment' (commentator); opts: { priority, key, ttl }
  say(text, kind = 'team', opts = {}) {
    if (this.mode === 'off') return;
    if (kind === 'comment' && !this.commentary) return;
    const now = performance.now();
    if (opts.key) {
      // replace an older message with the same key instead of queueing both
      this.queue = this.queue.filter((m) => m.key !== opts.key);
    }
    const msg = { text, kind, pr: PRIORITY[opts.priority || 'normal'], key: opts.key, until: now + (opts.ttl || 7000) };
    this.queue.push(msg);
    this.queue.sort((a, b) => b.pr - a.pr);
    if (this.queue.length > 4) this.queue.length = 4;
    this.pump();
  }

  pump() {
    if (this.busy) return;
    const now = performance.now();
    this.queue = this.queue.filter((m) => m.until > now);
    const m = this.queue.shift();
    if (!m) return;
    if (now < this.nextAt && m.pr < 2) { this.queue.unshift(m); setTimeout(() => this.pump(), this.nextAt - now + 20); return; }
    this.busy = true;
    this.show(m);
    const done = () => {
      if (!this.busy) return;
      this.busy = false;
      this.audio?.duck(false);
      if (m.kind === 'team') this.audio?.radioClick(false);
      this.nextAt = performance.now() + 900;
      setTimeout(() => this.hide(m), 1200);
      setTimeout(() => this.pump(), 950);
    };
    const minShow = 1800 + m.text.length * 45;
    if (this.mode === 'voice' && this.synth && this.volume > 0) {
      if (m.kind === 'team') this.audio?.radioClick(true);
      this.audio?.duck(true);
      const u = new SpeechSynthesisUtterance(m.text);
      u.lang = 'it-IT';
      const v = this.voices[m.kind] || this.voices.team;
      if (v) u.voice = v;
      u.rate = m.kind === 'comment' ? 1.12 : 1.05;
      u.pitch = m.kind === 'comment' ? 0.95 : 1.0;
      u.volume = this.volume;
      const started = performance.now();
      u.onend = u.onerror = () => setTimeout(done, Math.max(0, 900 - (performance.now() - started)));
      // safety net: some browsers never fire onend
      setTimeout(done, minShow + 4000);
      setTimeout(() => { try { this.synth.speak(u); } catch { done(); } }, m.kind === 'team' ? 160 : 0);
    } else setTimeout(done, minShow);
  }

  show(m) {
    if (!this.el) return;
    this.el.className = `radio show ${m.kind}`;
    this.el.querySelector('small').textContent = m.kind === 'team' ? 'RADIO SQUADRA' : 'TELECRONACA';
    this.el.querySelector('span').textContent = m.text;
    this.shown = m;
  }
  hide(m) {
    if (this.el && this.shown === m && !this.busy) this.el.className = 'radio';
  }

  stop() {
    this.queue = [];
    if (this.synth) try { this.synth.cancel(); } catch { /* ignore */ }
    this.busy = false;
    this.audio?.duck(false);
    if (this.el) this.el.className = 'radio';
  }
}

// helpers to phrase numbers naturally
export const sayGap = (g) => (g < 0.95 ? `${Math.max(1, Math.round(g * 10))} decimi` : `${g.toFixed(1).replace('.', ',')} secondi`);
const POS = ['primo', 'secondo', 'terzo', 'quarto', 'quinto', 'sesto', 'settimo', 'ottavo', 'nono', 'decimo', 'undicesimo', 'dodicesimo'];
export const posWord = (n) => POS[n - 1] || `${n}°`;
