// Personal lap-time leaderboards: top 10 per circuit, best sectors, and an index of every circuit driven.

const PREFIX = 'citygp:';
const get = (k, d) => { try { const v = localStorage.getItem(PREFIX + k); return v ? JSON.parse(v) : d; } catch { return d; } };
const set = (k, v) => { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); return true; } catch { return false; } };

const MAX_ENTRIES = 10;
const MAX_CIRCUITS = 40;

export function lbGet(id) {
  return get('lb:' + id, null) || { entries: [], sectors: [Infinity, Infinity, Infinity] };
}

// entry: { time, model, weather, mode, sectors? } → returns the rank (1..10) or 0 when not in the top 10
export function lbSubmit(id, entry) {
  const lb = lbGet(id);
  const e = { ...entry, date: Date.now() };
  lb.entries.push(e);
  lb.entries.sort((a, b) => a.time - b.time);
  const rank = lb.entries.indexOf(e) + 1;
  lb.entries.length = Math.min(lb.entries.length, MAX_ENTRIES);
  if (entry.sectors) {
    lb.sectors = (lb.sectors || [Infinity, Infinity, Infinity]).map((s, k) => Math.min(s ?? Infinity, entry.sectors[k] ?? Infinity));
  }
  set('lb:' + id, lb);
  return rank <= MAX_ENTRIES ? rank : 0;
}

// best individual sectors (purple sectors) — updated even when the lap is not a top-10 time
export function lbBestSectors(id) {
  const s = lbGet(id).sectors || [];
  return [0, 1, 2].map((k) => (Number.isFinite(s[k]) ? s[k] : Infinity));
}
export function lbSaveSector(id, k, t) {
  const lb = lbGet(id);
  lb.sectors = lb.sectors || [Infinity, Infinity, Infinity];
  if (!(t < (lb.sectors[k] ?? Infinity))) return false;
  lb.sectors[k] = t;
  set('lb:' + id, lb);
  return true;
}

export function lbClear(id) {
  try { localStorage.removeItem(PREFIX + 'lb:' + id); } catch { /* ignore */ }
  const idx = get('lbindex', {});
  delete idx[id];
  set('lbindex', idx);
}

// keep a small index of circuits (with a decimated outline so they can be raced again)
export function lbTouch(def, length) {
  const idx = get('lbindex', {});
  const cur = idx[def.id] || { plays: 0 };
  // ~10 m spacing, ~1 m precision: small enough to keep dozens of circuits in localStorage
  const latlon = cur.latlon || def.latlon.filter((_, k) => k % 5 === 0).map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)]);
  idx[def.id] = { ...cur, id: def.id, name: def.name, city: def.city, streets: def.streets, corners: def.corners, length, latlon, plays: cur.plays + 1, last: Date.now() };
  const ids = Object.keys(idx).sort((a, b) => idx[b].last - idx[a].last);
  for (const k of ids.slice(MAX_CIRCUITS)) delete idx[k];
  if (!set('lbindex', idx)) {
    // storage full: drop the oldest half and retry
    for (const k of ids.slice(Math.floor(ids.length / 2))) delete idx[k];
    set('lbindex', idx);
  }
}

// circuits that have at least one lap time, most recently driven first
export function lbList() {
  const idx = get('lbindex', {});
  return Object.values(idx)
    .map((c) => ({ ...c, best: lbGet(c.id).entries[0] || null }))
    .filter((c) => c.best)
    .sort((a, b) => b.last - a.last);
}
