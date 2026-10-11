// Canvas-generated textures (no external assets needed).

import * as THREE from 'three';
import { mulberry32 } from './geo.js';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

function tex(c, { repeat = true, srgb = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
}

export function asphaltTexture() {
  const [c, g] = canvas(512, 512);
  const rnd = mulberry32(7);
  g.fillStyle = '#3a3c40';
  g.fillRect(0, 0, 512, 512);
  const img = g.getImageData(0, 0, 512, 512);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 34;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n + 1;
  }
  g.putImageData(img, 0, 0);
  // darker racing line rubber + patches
  g.globalAlpha = 0.08;
  for (let i = 0; i < 40; i++) {
    g.fillStyle = rnd() < 0.5 ? '#000' : '#666';
    g.beginPath();
    g.ellipse(rnd() * 512, rnd() * 512, 20 + rnd() * 60, 10 + rnd() * 40, rnd() * 3, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  return tex(c);
}

export function kerbTexture() {
  const [c, g] = canvas(64, 256);
  for (let i = 0; i < 4; i++) {
    g.fillStyle = i % 2 ? '#f2f2f2' : '#d71a1a';
    g.fillRect(0, i * 64, 64, 64);
  }
  return tex(c);
}

export function lineTexture() {
  const [c, g] = canvas(16, 16);
  g.fillStyle = '#f4f4f4';
  g.fillRect(0, 0, 16, 16);
  return tex(c);
}

export function checkerTexture() {
  const [c, g] = canvas(256, 64);
  const cols = 16, rows = 4, s = 16;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    g.fillStyle = (x + y) % 2 ? '#111' : '#f5f5f5';
    g.fillRect(x * s, y * s, s, s);
  }
  return tex(c, { repeat: false });
}

export function gridBoxTexture() {
  const [c, g] = canvas(128, 256);
  g.clearRect(0, 0, 128, 256);
  g.strokeStyle = '#f4f4f4';
  g.lineWidth = 10;
  g.beginPath();
  g.moveTo(8, 250); g.lineTo(8, 10); g.lineTo(120, 10); g.lineTo(120, 70);
  g.stroke();
  return tex(c, { repeat: false });
}

export function barrierTexture(city) {
  const [c, g] = canvas(2048, 128);
  const name = `GRAN PREMIO DI ${city.toUpperCase()}`;
  const blocks = [
    ['#0b2d6b', '#ffffff', name],
    ['#e10600', '#ffffff', 'CITY GP'],
    ['#f5f5f5', '#111111', name],
    ['#111111', '#ffd400', 'STREET CIRCUIT'],
  ];
  const w = 512;
  blocks.forEach(([bg, fg, text], i) => {
    g.fillStyle = bg;
    g.fillRect(i * w, 0, w, 128);
    g.fillStyle = fg;
    let size = 64;
    g.font = `900 ${size}px "Arial Black", Arial, sans-serif`;
    while (g.measureText(text).width > w - 40 && size > 20) {
      size -= 2;
      g.font = `900 ${size}px "Arial Black", Arial, sans-serif`;
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, i * w + w / 2, 68);
  });
  // concrete top & bottom edges
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.fillRect(0, 120, 2048, 8);
  g.fillStyle = 'rgba(255,255,255,0.25)';
  g.fillRect(0, 0, 2048, 6);
  return tex(c);
}

export function fenceTexture() {
  const [c, g] = canvas(128, 128);
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(190,195,200,0.9)';
  g.lineWidth = 2;
  for (let i = -128; i < 256; i += 16) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 128, 128); g.stroke();
    g.beginPath(); g.moveTo(i + 128, 0); g.lineTo(i, 128); g.stroke();
  }
  g.fillStyle = '#7a7f86';
  g.fillRect(0, 0, 6, 128);
  return tex(c);
}

// 8x8 window cells; returns { map, emissive } (emissive = some lit windows, for night)
export function facadeTextures() {
  const N = 8, S = 64;
  const [c, g] = canvas(N * S, N * S);
  const [ce, ge] = canvas(N * S, N * S);
  const rnd = mulberry32(99);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, N * S, N * S);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, N * S, N * S);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const ox = x * S, oy = y * S;
    if (y === N - 1) {
      // ground floor (texture bottom): shop fronts with awnings
      g.fillStyle = '#2f3740';
      g.fillRect(ox + 6, oy + 18, S - 12, S - 18);
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(ox + 6, oy + 18, S - 12, 8);
      const aw = ['#8c1c13', '#1d4e89', '#2d6a4f', '#6b4f2a', '#444'][Math.floor(rnd() * 5)];
      g.fillStyle = aw;
      g.fillRect(ox + 3, oy + 8, S - 6, 9);
      if (rnd() < 0.6) { ge.fillStyle = '#ffe2a8'; ge.fillRect(ox + 6, oy + 26, S - 12, S - 26); }
      continue;
    }
    // subtle panel noise
    g.fillStyle = `rgba(0,0,0,${0.02 + rnd() * 0.04})`;
    g.fillRect(ox, oy, S, S);
    // window
    g.fillStyle = '#4a5560';
    g.fillRect(ox + 18, oy + 14, 28, 34);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(ox + 18, oy + 14, 28, 6);
    // sill
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(ox + 15, oy + 48, 34, 3);
    if (rnd() < 0.35) {
      ge.fillStyle = rnd() < 0.7 ? '#ffcf7a' : '#cfe3ff';
      ge.fillRect(ox + 18, oy + 14, 28, 34);
    }
  }
  return { map: tex(c), emissive: tex(ce) };
}

export function crowdTexture() {
  const [c, g] = canvas(512, 128);
  const rnd = mulberry32(5);
  g.fillStyle = '#2a2d33';
  g.fillRect(0, 0, 512, 128);
  const cols = ['#e10600', '#ffd400', '#1e5bc6', '#ffffff', '#16a34a', '#f97316', '#111'];
  for (let row = 0; row < 8; row++) {
    for (let i = 0; i < 64; i++) {
      g.fillStyle = cols[Math.floor(rnd() * cols.length)];
      g.fillRect(i * 8 + rnd() * 2, row * 16 + 4, 6, 9);
      g.fillStyle = '#e8c4a0';
      g.fillRect(i * 8 + 1.5, row * 16, 3, 4);
    }
  }
  return tex(c);
}

export function roofTexture() {
  const [c, g] = canvas(64, 64);
  const rnd = mulberry32(3);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 300; i++) {
    g.fillStyle = `rgba(0,0,0,${rnd() * 0.12})`;
    g.fillRect(rnd() * 64, rnd() * 64, 2, 2);
  }
  return tex(c);
}

export function glassTextures() {
  const N = 8, S = 64;
  const [c, g] = canvas(N * S, N * S);
  const [ce, ge] = canvas(N * S, N * S);
  const rnd = mulberry32(42);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, N * S, N * S);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, N * S, N * S);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const ox = x * S, oy = y * S;
    const grd = g.createLinearGradient(ox, oy, ox + S, oy + S);
    grd.addColorStop(0, '#5f7d95');
    grd.addColorStop(0.5, '#88a6bd');
    grd.addColorStop(1, '#4d6880');
    g.fillStyle = grd;
    g.fillRect(ox + 2, oy + 6, S - 4, S - 10);
    if (rnd() < 0.3) { ge.fillStyle = '#dfe9ff'; ge.fillRect(ox + 2, oy + 6, S - 4, S - 10); }
  }
  return { map: tex(c), emissive: tex(ce) };
}

// Italian-style street name plate
export function streetSignTexture(name) {
  const [c, g] = canvas(1024, 256);
  g.fillStyle = '#f4f1ea';
  g.fillRect(0, 0, 1024, 256);
  g.strokeStyle = '#2b2b2b';
  g.lineWidth = 10;
  g.strokeRect(18, 18, 988, 220);
  g.fillStyle = '#1d1d1d';
  const text = name.toUpperCase();
  let size = 120;
  const font = (s) => `700 ${s}px "Titillium Web", "Arial Narrow", Arial, sans-serif`;
  g.font = font(size);
  while (g.measureText(text).width > 920 && size > 40) { size -= 4; g.font = font(size); }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 512, 134);
  return tex(c, { repeat: false });
}

// floating label for a landmark (pin + name)
export function labelTexture(name) {
  const [m, mg] = canvas(8, 8);
  mg.font = '700 44px "Titillium Web", Arial, sans-serif';
  const w = Math.ceil(Math.min(900, mg.measureText(name).width)) + 110;
  const [c, g] = canvas(w, 84);
  g.fillStyle = 'rgba(12,14,18,0.82)';
  const r = 40;
  g.beginPath();
  g.moveTo(r, 2); g.lineTo(w - r, 2); g.arc(w - r, 42, 40, -Math.PI / 2, Math.PI / 2); g.lineTo(r, 82); g.arc(r, 42, 40, Math.PI / 2, -Math.PI / 2);
  g.fill();
  g.fillStyle = '#e10600';
  g.beginPath(); g.arc(42, 42, 22, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff';
  g.beginPath(); g.arc(42, 42, 8, 0, Math.PI * 2); g.fill();
  g.font = '700 44px "Titillium Web", Arial, sans-serif';
  g.textBaseline = 'middle';
  g.fillText(name, 80, 45, w - 100);
  const t = tex(c, { repeat: false });
  t.userData = { aspect: w / 84 };
  return t;
}

// fine asphalt grain as a tangent-space normal map (no tangents needed: three uses screen derivatives)
export function asphaltNormalTexture() {
  const N = 256;
  const rnd = mulberry32(19);
  const h = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) h[i] = rnd();
  // a few larger aggregate stones
  for (let k = 0; k < 900; k++) {
    const cx = rnd() * N, cy = rnd() * N, r = 1 + rnd() * 2.2, a = 0.6 + rnd();
    for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) {
      const d = Math.hypot(x, y);
      if (d > r) continue;
      const i = (((Math.floor(cy) + y) % N + N) % N) * N + (((Math.floor(cx) + x) % N + N) % N);
      h[i] += a * (1 - d / r);
    }
  }
  const [c, g] = canvas(N, N);
  const img = g.createImageData(N, N);
  const at = (x, y) => h[((y + N) % N) * N + ((x + N) % N)];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * 1.4, dy = (at(x, y + 1) - at(x, y - 1)) * 1.4;
    const l = Math.hypot(dx, dy, 1);
    const i = (y * N + x) * 4;
    img.data[i] = (-dx / l * 0.5 + 0.5) * 255;
    img.data[i + 1] = (-dy / l * 0.5 + 0.5) * 255;
    img.data[i + 2] = (1 / l * 0.5 + 0.5) * 255;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return tex(c, { srgb: false });
}

// puddle mask (red channel): soft blobs, mostly along the edges and in dips
export function puddleTexture() {
  const [c, g] = canvas(256, 256);
  const rnd = mulberry32(23);
  g.fillStyle = '#000';
  g.fillRect(0, 0, 256, 256);
  g.filter = 'blur(6px)';
  for (let k = 0; k < 55; k++) {
    const x = rnd() * 256, y = rnd() * 256, rx = 6 + rnd() * 26, ry = 4 + rnd() * 14;
    g.fillStyle = `rgba(255,255,255,${0.5 + rnd() * 0.5})`;
    for (const [ox, oy] of [[0, 0], [256, 0], [-256, 0], [0, 256], [0, -256]]) {
      g.beginPath(); g.ellipse(x + ox, y + oy, rx, ry, rnd() * 3, 0, Math.PI * 2); g.fill();
    }
  }
  g.filter = 'none';
  return tex(c, { srgb: false });
}

// soft pool of light for street lamps at night (additive decal)
export function lightPoolTexture() {
  const [c, g] = canvas(128, 128);
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return tex(c, { repeat: false });
}

// energy-absorbing barrier block face with a stripe
export function tecproTexture() {
  const [c, g] = canvas(128, 128);
  g.fillStyle = '#f2f2f2';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#1d4ed8';
  g.fillRect(0, 0, 128, 44);
  g.fillStyle = '#d71a1a';
  g.fillRect(0, 96, 128, 32);
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 4;
  g.strokeRect(2, 2, 124, 124);
  return tex(c, { repeat: false });
}
