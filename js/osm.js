// Free data sources: OpenStreetMap (Overpass + Nominatim) and Esri World Imagery.

import { OVERPASS_ENDPOINTS, NOMINATIM, SATELLITE_URL } from './config.js';
export { SATELLITE_URL };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- tiny IndexedDB cache so already-played areas load instantly
const DB_NAME = 'citygp-cache', STORE = 'overpass', MAX_AGE = 30 * 24 * 3600 * 1000;
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function cacheGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const r = db.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result && Date.now() - r.result.t < MAX_AGE ? r.result.v : null);
      r.onerror = () => resolve(null);
    });
  } catch { return null; }
}
async function cachePut(key, v) {
  try {
    const db = await openDb();
    db.transaction(STORE, 'readwrite').objectStore(STORE).put({ t: Date.now(), v }, key);
  } catch { /* cache is optional */ }
}

export async function overpass(query, onStatus) {
  const cached = await cacheGet(query);
  if (cached) return cached;
  const res = await overpassFetch(query, onStatus);
  cachePut(query, res);
  return res;
}

async function overpassFetch(query, onStatus) {
  let lastErr = new Error('Overpass non raggiungibile');
  for (let round = 0; round < 4; round++) {
    for (const ep of OVERPASS_ENDPOINTS) {
      const host = new URL(ep).host;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 75000);
      try {
        onStatus?.(`Scarico dati da ${host}${round ? ` (tentativo ${round + 1})` : ''}…`);
        const res = await fetch(ep, {
          method: 'POST',
          body: new URLSearchParams({ data: query }),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`${host}: HTTP ${res.status}`);
        const json = await res.json();
        if (!json.elements) throw new Error(`${host}: risposta non valida`);
        if (json.remark && /error|timed out|out of memory/i.test(json.remark) && json.elements.length === 0) {
          throw new Error(`${host}: ${json.remark}`);
        }
        return json;
      } catch (e) {
        lastErr = e;
        console.warn('Overpass fallito', e);
      } finally {
        clearTimeout(timer);
      }
    }
    onStatus?.('Server mappe occupati, riprovo tra pochi secondi…');
    await sleep(3000 * (round + 1));
  }
  throw lastErr;
}

const ROAD_RE =
  '^(trunk|primary|secondary|tertiary|unclassified|residential|trunk_link|primary_link|secondary_link|tertiary_link)$';

const bbStr = (b) => `${b.s.toFixed(6)},${b.w.toFixed(6)},${b.n.toFixed(6)},${b.e.toFixed(6)}`;

export function fetchRoads(b, onStatus) {
  const q = `[out:json][timeout:60][maxsize:134217728];
way["highway"~"${ROAD_RE}"]["area"!="yes"]["tunnel"!~"^(yes|building_passage)$"]["access"!~"^(no|private)$"](${bbStr(b)});
out body geom qt;`;
  return overpass(q, onStatus);
}

// buildings within `bIn`; ground features, roads and landmarks within the wider `bOut`
export function fetchScenery(bIn, bOut, onStatus) {
  const I = bbStr(bIn), O = bbStr(bOut);
  const q = `[out:json][timeout:120][maxsize:536870912];
(
  way["building"](${I});
  relation["building"]["type"="multipolygon"](${I});
  way["building:part"](${I});
  node["natural"="tree"](${I});
  way["highway"](${O});
  way["railway"~"^(rail|tram|light_rail|narrow_gauge)$"](${O});
  way["waterway"~"^(river|canal|stream|riverbank)$"](${O});
  way["natural"~"^(water|wood|scrub|grassland)$"](${O});
  relation["natural"="water"](${O});
  way["landuse"~"^(grass|forest|meadow|recreation_ground|village_green|cemetery|reservoir|basin)$"](${O});
  way["leisure"~"^(park|garden|pitch|playground|stadium)$"](${O});
  relation["leisure"="park"](${O});
  nwr["historic"]["name"](${O});
  nwr["tourism"~"^(attraction|museum|viewpoint|artwork|gallery)$"]["name"](${O});
  nwr["amenity"~"^(place_of_worship|townhall|theatre|university)$"]["name"](${O});
  nwr["man_made"~"^(tower|campanile|obelisk|lighthouse|water_tower)$"](${O});
);
out geom qt;`;
  return overpass(q, onStatus);
}

export async function searchPlaces(text) {
  const url = `${NOMINATIM}/search?format=jsonv2&limit=6&accept-language=it&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Ricerca fallita (HTTP ${res.status})`);
  return res.json();
}

export async function reverseCity(lat, lon) {
  try {
    const url = `${NOMINATIM}/reverse?format=jsonv2&zoom=10&accept-language=it&lat=${lat}&lon=${lon}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const j = await res.json();
    const a = j.address || {};
    return a.city || a.town || a.village || a.municipality || a.county || j.name || null;
  } catch {
    return null;
  }
}
