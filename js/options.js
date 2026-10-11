// Options menu: controls (re-binding), driving, graphics, audio.

import { ACTIONS, PAD_LAYOUTS, PAD_BUTTON_NAMES, defaultBindings, keyLabel } from './input.js';

const seg = (key, opts, cur, help = '') => `
  <div class="field"><span>${opts.title}</span>
    <div class="seg" data-key="${key}">${opts.items.map(([v, l]) => `<button data-v="${v}" class="${String(cur) === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${help ? `<small class="help">${help}</small>` : ''}
  </div>`;
const range = (key, title, cur, min, max, step, fmt) => `
  <div class="field"><span>${title} <output data-out="${key}">${fmt(cur)}</output></span>
    <input type="range" data-range="${key}" min="${min}" max="${max}" step="${step}" value="${cur}" />
  </div>`;

export function createOptions({ root, settings, save, input, onChange }) {
  let tab = 'controls';
  let capturing = null;

  const render = () => {
    const S = settings;
    let html = '';
    if (tab === 'controls') {
      const b = S.bindings || defaultBindings();
      html += `<p class="help">Clicca su un tasto per cambiarlo, poi premi il nuovo tasto (Esc annulla, Canc per svuotare).</p>
        <div class="binds">${ACTIONS.map((a) => `
          <div class="bind-row"><span>${a.label}</span>
            ${[0, 1].map((k) => `<button class="key ${capturing && capturing.id === a.id && capturing.k === k ? 'wait' : ''}" data-bind="${a.id}" data-k="${k}">${capturing && capturing.id === a.id && capturing.k === k ? 'Premi un tasto…' : keyLabel(b[a.id]?.[k])}</button>`).join('')}
          </div>`).join('')}</div>
        <button class="btn ghost small" data-act="reset-keys">Ripristina tasti predefiniti</button>
        ${seg('padLayout', { title: 'Gamepad', items: Object.entries(PAD_LAYOUTS).map(([k, v]) => [k, v.label]) }, S.padLayout)}
        <div class="pad-map">${Object.entries(PAD_LAYOUTS[S.padLayout] || PAD_LAYOUTS.triggers).filter(([k]) => k !== 'label')
          .map(([k, ids]) => `<span><b>${ids.map((i) => PAD_BUTTON_NAMES[i] || i).join('/')}</b> ${ACTIONS.find((a) => a.id === k)?.label || k}</span>`).join('')}
          <span><b>Stick sx</b> Sterzo</span></div>
        ${range('sens', 'Sensibilità sterzo', S.sens, 0.5, 1.5, 0.05, (v) => Math.round(v * 100) + '%')}
        <div class="group-title">Regolazione gamepad</div>
        <p class="help" id="pad-status">${input.pad ? 'Collegato: ' + input.pad.id.replace(/\(.*\)/, '').trim() : 'Nessun gamepad rilevato: collegalo e premi un tasto.'}</p>
        <div class="pad-meter"><span>Sterzo</span><div><i id="pad-meter-steer"></i></div><span>Gas</span><div><i id="pad-meter-thr"></i></div><span>Freno</span><div><i id="pad-meter-brk"></i></div></div>
        ${range('padDeadzone', 'Zona morta stick', S.padDeadzone, 0, 0.3, 0.01, (v) => Math.round(v * 100) + '%')}
        ${range('padCurve', 'Progressività sterzo', S.padCurve, 1, 3, 0.1, (v) => (v <= 1.05 ? 'lineare' : '×' + (+v).toFixed(1)))}
        ${range('padSmooth', 'Filtro sterzo', S.padSmooth, 0, 0.15, 0.01, (v) => (v < 0.005 ? 'off' : Math.round(v * 1000) + ' ms'))}
        ${range('trigDeadzone', 'Zona morta grilletti', S.trigDeadzone, 0, 0.3, 0.01, (v) => Math.round(v * 100) + '%')}
        ${range('rumble', 'Vibrazione', S.rumble, 0, 1, 0.05, (v) => Math.round(v * 100) + '%')}
        <small class="help">Progressività alta = sterzo più dolce al centro, preciso nelle curve veloci. La vibrazione segue cordoli, slittamenti, bloccaggi e urti (grilletti vibranti sui controller che li supportano).</small>
        ${seg('touch', { title: 'Comandi touch', items: [['auto', 'Automatici'], ['on', 'Sempre'], ['off', 'Mai']] }, S.touch)}`;
    } else if (tab === 'driving') {
      html += seg('model', { title: 'Modello di guida', items: [['arcade', 'Arcade'], ['sim', 'Simulazione']] }, S.model,
        S.model === 'arcade' ? 'La macchina va dove sterzi, tanta aderenza e muri morbidi. Consigliato.' : 'Gomme, trasferimento di carico e derapate realistiche.');
      if (S.model === 'sim') html += seg('assists', { title: 'Aiuti alla guida', items: [['high', 'Alti'], ['medium', 'Medi'], ['low', 'Bassi']] }, S.assists);
      html += seg('line', { title: 'Traiettoria ideale', items: [['on', 'Visibile'], ['off', 'Nascosta']] }, S.line);
      html += seg('wear', { title: 'Usura gomme', items: [['off', 'Disattivata'], ['normal', 'Normale'], ['high', 'Alta']] }, S.wear,
        'Con le gomme consumate perdi aderenza: premi il tasto pit stop per cambiarle al prossimo passaggio.');
      html += seg('damage', { title: 'Danni', items: [['off', 'No'], ['visual', 'Solo estetici'], ['on', 'Realistici']] }, S.damage,
        'Con i danni realistici un urto forte rompe l’ala anteriore o piega le sospensioni: la macchina perde aderenza finché non ripari ai box.');
      html += seg('weather', { title: 'Meteo', items: [['dry', 'Sole'], ['wet', 'Pioggia'], ['variable', 'Variabile']] }, S.weather,
        'Sul bagnato servono le gomme intermedie (verdi): il pit stop le monta da solo quando conviene.');
      html += seg('limits', { title: 'Limiti della pista', items: [['on', 'Attivi'], ['off', 'Disattivati']] }, S.limits,
        'Tagliare le curve oltre il cordolo annulla il giro; in gara dopo 3 avvisi arriva +5 s di penalità.');
      html += seg('adaptive', { title: 'Difficoltà adattiva', items: [['on', 'Sì'], ['off', 'No']] }, S.adaptive,
        'Gli avversari regolano leggermente il ritmo per tenere la gara combattuta.');
      html += seg('quali', { title: 'Qualifiche prima della gara', items: [['on', 'Sì'], ['off', 'No']] }, S.quali);
      html += seg('units', { title: 'Unità di velocità', items: [['kmh', 'km/h'], ['mph', 'mph']] }, S.units);
    } else if (tab === 'graphics') {
      html += seg('quality', { title: 'Qualità grafica', items: [['high', 'Alta'], ['medium', 'Media'], ['low', 'Bassa']] }, S.quality,
        'Se il gioco va a scatti, scegli Media o Bassa.');
      html += range('fov', 'Campo visivo (FOV)', S.fov, -10, 15, 1, (v) => (v > 0 ? '+' : '') + v + '°');
      html += seg('shake', { title: 'Vibrazioni della telecamera', items: [['on', 'Sì'], ['off', 'No']] }, S.shake);
      html += seg('blur', { title: 'Effetto velocità (motion blur)', items: [['on', 'Sì'], ['off', 'No']] }, S.blur);
      html += seg('autoRes', { title: 'Risoluzione automatica', items: [['on', 'Sì'], ['off', 'No']] }, S.autoRes,
        'Abbassa un po’ la risoluzione se il gioco scende sotto i 45 fotogrammi al secondo.');
      html += seg('tod', { title: 'Orario', items: [['day', 'Giorno'], ['sunset', 'Tramonto'], ['night', 'Notte']] }, S.tod);
    } else if (tab === 'audio') {
      for (const [k, t] of [['master', 'Volume generale'], ['engine', 'Motore'], ['fx', 'Effetti'], ['opponents', 'Motori avversari'], ['radio', 'Radio e telecronaca']]) {
        html += range('vol_' + k, t, S.vol[k] ?? 0.9, 0, 1, 0.05, (v) => Math.round(v * 100) + '%');
      }
      html += seg('radio', { title: 'Radio del box', items: [['voice', 'Voce + testo'], ['text', 'Solo testo'], ['off', 'Spenta']] }, S.radio,
        'L’ingegnere ti dà distacchi, meteo e consigli sui pit stop. La voce usa la sintesi vocale del browser.');
      html += seg('commentary', { title: 'Telecronaca', items: [['on', 'Sì'], ['off', 'No']] }, S.commentary);
    }
    root.querySelector('#opt-body').innerHTML = html;
    root.querySelectorAll('#opt-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  };

  const set = (key, v) => {
    if (key.startsWith('vol_')) settings.vol[key.slice(4)] = v;
    else settings[key] = v;
    save();
    onChange(key, v);
  };

  root.querySelector('#opt-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) { tab = b.dataset.tab; capturing = null; render(); }
  });
  root.querySelector('#opt-body').addEventListener('click', (e) => {
    const sb = e.target.closest('.seg button');
    if (sb) {
      const key = sb.closest('.seg').dataset.key;
      set(key, sb.dataset.v);
      render();
      return;
    }
    const kb = e.target.closest('[data-bind]');
    if (kb) {
      capturing = { id: kb.dataset.bind, k: +kb.dataset.k };
      render();
      input.captureKey((code) => {
        const c = capturing;
        capturing = null;
        if (!c) return;
        if (code !== 'Escape' || c.id === 'pause') {
          const b = settings.bindings || defaultBindings();
          const val = code === 'Delete' ? null : code;
          if (val) for (const arr of Object.values(b)) for (let i = 0; i < arr.length; i++) if (arr[i] === val) arr[i] = null; // no duplicates
          b[c.id][c.k] = val;
          set('bindings', b);
        }
        render();
      });
      return;
    }
    if (e.target.closest('[data-act="reset-keys"]')) { set('bindings', defaultBindings()); render(); }
  });
  root.querySelector('#opt-body').addEventListener('input', (e) => {
    const r = e.target.closest('[data-range]');
    if (!r) return;
    const key = r.dataset.range;
    const v = parseFloat(r.value);
    const out = root.querySelector(`[data-out="${key}"]`);
    if (out) {
      const fmt = {
        fov: (x) => (x > 0 ? '+' : '') + x + '°',
        padCurve: (x) => (x <= 1.05 ? 'lineare' : '×' + x.toFixed(1)),
        padSmooth: (x) => (x < 0.005 ? 'off' : Math.round(x * 1000) + ' ms'),
      }[key] || ((x) => Math.round(x * 100) + '%');
      out.textContent = fmt(v);
    }
    set(key, v);
  });

  return {
    open(t) { if (t) tab = t; render(); root.classList.remove('hidden'); },
    close() { capturing = null; input.capture = null; root.classList.add('hidden'); },
    get isOpen() { return !root.classList.contains('hidden'); },
  };
}
