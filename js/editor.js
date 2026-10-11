// Circuit editor: click waypoints on the map, the route snaps to real roads.

import L from 'leaflet';
import { nearestNode, routeBetween, candidateFromRoute } from './trackgen.js';

export class CircuitEditor {
  constructor(map, { getRoads, onDone, onStatus }) {
    this.map = map;
    this.getRoads = getRoads;
    this.onDone = onDone;
    this.onStatus = onStatus;
    this.active = false;
    this.layer = L.layerGroup();
  }

  async start() {
    this.active = true;
    this.points = [];   // { node, latlng, marker }
    this.legs = [];     // { pts, edges, line }
    this.layer.clearLayers().addTo(this.map);
    this.onStatus('Carico le strade della zona…');
    try {
      this.roads = await this.getRoads();
    } catch (e) {
      this.onStatus(`Errore: ${e.message}`, true);
      this.active = false;
      return false;
    }
    this.onStatus('Clicca sulla mappa per aggiungere i punti del circuito, poi premi “Chiudi circuito”.');
    return true;
  }

  stop() {
    this.active = false;
    this.layer.remove();
  }

  lengthM() { return this.legs.reduce((a, l) => a + l.len, 0); }

  async click(latlng) {
    if (!this.roads) return;
    const { G, proj } = this.roads;
    const [x, z] = proj.toXZ(latlng.lat, latlng.lng);
    const node = nearestNode(G, x, z, 150);
    if (node < 0) { this.onStatus('Nessuna strada qui vicino (o sei fuori dall’area rossa).', true); return; }
    const nd = G.nodes[node];
    const ll = proj.toLatLon(nd.x, nd.z);
    if (this.points.length) {
      const prev = this.points[this.points.length - 1];
      if (prev.node === node) return;
      const r = routeBetween(G, prev.node, node);
      if (!r) { this.onStatus('Non trovo una strada che colleghi questi punti.', true); return; }
      this.addLeg(r);
    }
    const marker = L.circleMarker(ll, { radius: this.points.length ? 6 : 9, color: '#fff', weight: 2, fillColor: this.points.length ? '#e10600' : '#ffd400', fillOpacity: 1 }).addTo(this.layer);
    this.points.push({ node, marker });
    this.report();
  }

  addLeg(r) {
    const { proj } = this.roads;
    let len = 0;
    for (let k = 1; k < r.pts.length; k++) len += Math.hypot(r.pts[k][0] - r.pts[k - 1][0], r.pts[k][1] - r.pts[k - 1][1]);
    const line = L.polyline(r.pts.map(([x, z]) => proj.toLatLon(x, z)), { color: '#e10600', weight: 6, opacity: 0.9 }).addTo(this.layer);
    this.legs.push({ ...r, len, line });
  }

  report() {
    const km = (this.lengthM() / 1000).toLocaleString('it-IT', { maximumFractionDigits: 2 });
    this.onStatus(`${this.points.length} punti · ${km} km. Aggiungi punti o premi “Chiudi circuito”.`);
  }

  undo() {
    const p = this.points.pop();
    if (p) this.layer.removeLayer(p.marker);
    const leg = this.points.length ? this.legs.pop() : null;
    if (leg) this.layer.removeLayer(leg.line);
    this.report();
  }

  close() {
    if (this.points.length < 3) { this.onStatus('Servono almeno 3 punti per chiudere il circuito.', true); return; }
    const { G } = this.roads;
    const back = routeBetween(G, this.points[this.points.length - 1].node, this.points[0].node);
    if (!back) { this.onStatus('Non riesco a tornare al punto di partenza.', true); return; }
    back.len = 0;
    for (let k = 1; k < back.pts.length; k++) back.len += Math.hypot(back.pts[k][0] - back.pts[k - 1][0], back.pts[k][1] - back.pts[k - 1][1]);
    const legs = [...this.legs, back];
    const raw = [];
    const edges = [];
    for (const l of legs) { for (let k = raw.length ? 1 : 0; k < l.pts.length; k++) raw.push(l.pts[k]); edges.push(...l.edges); }
    raw.pop();
    const len = legs.reduce((a, l) => a + (l.len || 0), 0);
    if (len < 800) { this.onStatus('Circuito troppo corto: almeno 0,8 km.', true); return; }
    const cand = candidateFromRoute(G, raw, edges);
    if (!cand.ok) {
      this.onStatus('Il tracciato passa troppo vicino a se stesso (strade parallele o ripercorse): sposta qualche punto.', true);
      return;
    }
    this.stop();
    this.onDone(cand, this.roads);
  }
}
