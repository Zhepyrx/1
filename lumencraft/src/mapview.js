// World atlas overlay: a hill-shaded biome map rendered by its own worker from the world generator.
// Scroll to zoom, hover to read biome names, click to pick a destination and travel there.
import { BIOME_NAMES, BIOME_COLORS } from './worldgen.js';

const STEPS = [4, 8, 16, 32];

export class MapView {
  constructor(createWorker) {
    this.createWorker = createWorker;
    this.worker = null;
    this.seed = null;
    this.zoom = 1;
    this.open = false;
    this.img = null;
    this.pending = 0;
    this.jobId = 0;
    this.target = null;
    this.onTravel = null;
    this.discovered = new Set();
    this.el = document.getElementById('map');
    this.canvas = document.getElementById('map-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.info = document.getElementById('map-info');
    this.legend = document.getElementById('map-legend');
    this.travelBtn = document.getElementById('map-travel');
    this.canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.setZoom(this.zoom + (e.deltaY > 0 ? 1 : -1)); }, { passive: false });
    this.canvas.addEventListener('mousemove', (e) => this.hover(e));
    this.canvas.addEventListener('mouseleave', () => { this.hoverAt = null; this.draw(); });
    this.canvas.addEventListener('click', (e) => this.pick(e));
    this.travelBtn.addEventListener('click', () => this.travel());
    document.getElementById('map-zoom-in').addEventListener('click', () => this.setZoom(this.zoom - 1));
    document.getElementById('map-zoom-out').addEventListener('click', () => this.setZoom(this.zoom + 1));
    document.getElementById('map-close').addEventListener('click', () => this.hide());
  }

  setSeed(seed) {
    if (this.seed === seed && this.worker) return;
    if (this.worker) this.worker.terminate();
    this.seed = seed;
    this.worker = this.createWorker();
    this.worker.onmessage = (e) => this.onResult(e.data);
    this.worker.postMessage({ type: 'init', seed });
    this.img = null;
  }

  show(center, yaw, home) {
    this.open = true;
    this.center = [Math.round(center[0]), Math.round(center[2])];
    this.player = center.slice();
    this.yaw = yaw;
    this.home = home;
    this.target = null;
    this.el.hidden = false;
    this.buildLegend();
    this.request();
    this.draw();
  }

  hide() { this.open = false; this.el.hidden = true; if (this.onClose) this.onClose(); }

  setZoom(z) {
    z = Math.max(0, Math.min(STEPS.length - 1, z));
    if (z === this.zoom) return;
    this.zoom = z;
    this.request();
  }

  request() {
    const step = STEPS[this.zoom], N = 192;
    const x0 = this.center[0] - (N / 2) * step, z0 = this.center[1] - (N / 2) * step;
    this.req = { x0, z0, step, N };
    this.jobId++;
    this.worker.postMessage({ type: 'map', id: this.jobId, x0, z0, step, w: N, h: N });
    this.info.textContent = 'Surveying the land…';
  }

  onResult(m) {
    if (m.type !== 'map' || m.id !== this.jobId) return;
    const c = document.createElement('canvas');
    c.width = m.w; c.height = m.h;
    c.getContext('2d').putImageData(new ImageData(m.px, m.w, m.h), 0, 0);
    this.img = { canvas: c, x0: m.x0, z0: m.z0, step: m.step, w: m.w, h: m.h, biomes: m.biomes };
    this.info.textContent = 'Click the map to choose a destination · scroll to zoom';
    this.draw();
  }

  toWorld(e) {
    const r = this.canvas.getBoundingClientRect();
    const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
    const im = this.img;
    if (!im) return null;
    const i = Math.floor(u * im.w), j = Math.floor(v * im.h);
    if (i < 0 || j < 0 || i >= im.w || j >= im.h) return null;
    return { x: im.x0 + (i + 0.5) * im.step, z: im.z0 + (j + 0.5) * im.step, biome: im.biomes[j * im.w + i] };
  }

  hover(e) { this.hoverAt = this.toWorld(e); this.draw(); }

  pick(e) {
    const p = this.toWorld(e);
    if (!p) return;
    this.target = p;
    this.travelBtn.disabled = false;
    this.travelBtn.textContent = `Travel to ${BIOME_NAMES[p.biome]} · ${Math.round(p.x)}, ${Math.round(p.z)}`;
    this.draw();
  }

  travel() {
    if (!this.target || !this.onTravel) return;
    this.onTravel(this.target.x, this.target.z);
    this.hide();
  }

  buildLegend() {
    this.legend.innerHTML = '';
    BIOME_NAMES.forEach((name, b) => {
      const li = document.createElement('li');
      const sw = document.createElement('i');
      sw.style.background = `rgb(${BIOME_COLORS[b].join(',')})`;
      li.appendChild(sw);
      li.appendChild(document.createTextNode(name));
      if (this.discovered.has(b)) li.classList.add('found');
      this.legend.appendChild(li);
    });
  }

  draw() {
    if (!this.open) return;
    const g = this.ctx, W = this.canvas.width, H = this.canvas.height;
    g.fillStyle = '#0b0f14';
    g.fillRect(0, 0, W, H);
    const im = this.img;
    if (!im) return;
    g.imageSmoothingEnabled = false;
    g.drawImage(im.canvas, 0, 0, W, H);
    const toPx = (x, z) => [((x - im.x0) / im.step) / im.w * W, ((z - im.z0) / im.step) / im.h * H];
    // grid lines every 256 m
    g.strokeStyle = 'rgba(0,0,0,0.12)';
    g.lineWidth = 1;
    const span = im.w * im.step;
    const gs = span > 3000 ? 1024 : 256;
    for (let x = Math.ceil(im.x0 / gs) * gs; x < im.x0 + span; x += gs) { const [px] = toPx(x, 0); g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke(); }
    for (let z = Math.ceil(im.z0 / gs) * gs; z < im.z0 + span; z += gs) { const [, pz] = toPx(0, z); g.beginPath(); g.moveTo(0, pz); g.lineTo(W, pz); g.stroke(); }
    // home marker
    if (this.home) {
      const [hx, hz] = toPx(this.home[0], this.home[2]);
      g.fillStyle = '#f2c57c'; g.strokeStyle = '#1b1408'; g.lineWidth = 2;
      g.beginPath(); g.arc(hx, hz, 6, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    // destination
    if (this.target) {
      const [tx, tz] = toPx(this.target.x, this.target.z);
      g.strokeStyle = '#fff'; g.lineWidth = 2;
      g.beginPath(); g.arc(tx, tz, 9, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(tx - 14, tz); g.lineTo(tx + 14, tz); g.moveTo(tx, tz - 14); g.lineTo(tx, tz + 14); g.stroke();
    }
    // player arrow
    const [px, pz] = toPx(this.player[0], this.player[2]);
    g.save();
    g.translate(px, pz);
    g.rotate(this.yaw);
    g.fillStyle = '#ffffff'; g.strokeStyle = '#000'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, -11); g.lineTo(7, 8); g.lineTo(0, 4); g.lineTo(-7, 8); g.closePath(); g.stroke(); g.fill();
    g.restore();
    // hover label
    if (this.hoverAt) {
      const [hx, hz] = toPx(this.hoverAt.x, this.hoverAt.z);
      const label = `${BIOME_NAMES[this.hoverAt.biome]}  ${Math.round(this.hoverAt.x)}, ${Math.round(this.hoverAt.z)}`;
      g.font = '600 13px Manrope, system-ui, sans-serif';
      const tw = g.measureText(label).width;
      const lx = Math.min(W - tw - 14, hx + 12), ly = Math.max(20, hz - 10);
      g.fillStyle = 'rgba(8,10,14,0.78)';
      g.fillRect(lx - 6, ly - 15, tw + 12, 22);
      g.fillStyle = '#edf1f3';
      g.fillText(label, lx, ly);
    }
    // scale bar
    const sb = 200 * (im.step >= 16 ? 5 : 1);
    const sbPx = sb / (im.w * im.step) * W;
    g.fillStyle = 'rgba(8,10,14,0.7)'; g.fillRect(12, H - 30, sbPx + 16, 20);
    g.fillStyle = '#edf1f3'; g.fillRect(20, H - 18, sbPx, 3);
    g.font = '11px JetBrains Mono, monospace'; g.fillText(`${sb} m`, 22 + sbPx * 0.5 - 14, H - 22);
  }
}
