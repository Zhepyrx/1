// World worker: generates chunk columns and builds their meshes.
import { WorldGen, BIOME_COLORS, SEA } from './worldgen.js';
import { Mesher } from './mesher.js';

let gen = null;
const mesher = new Mesher();

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    gen = new WorldGen(m.seed);
    return;
  }
  if (m.type === 'gen') {
    const c = gen.generate(m.cx, m.cz);
    self.postMessage({ type: 'gen', id: m.id, col: c },
      [c.data.buffer, c.tintG.buffer, c.tintF.buffer, c.tintW.buffer, c.heights.buffer, c.biomes.buffer, c.temps.buffer]);
    return;
  }
  if (m.type === 'map') {
    self.postMessage(renderMap(m), []);
    return;
  }
  if (m.type === 'mesh') {
    const r = mesher.build(m.cx, m.cz, m.cols, m.tintG, m.tintF, m.tintW, m.lod);
    r.type = 'mesh'; r.id = m.id; r.cx = m.cx; r.cz = m.cz; r.version = m.version; r.lod = m.lod;
    self.postMessage(r, [r.opaque, r.cutout, r.trans, r.plants, r.opaqueG, r.cutoutG, r.transG, r.plantsG]);
  }
};

// Shaded biome map for the in-game atlas: one generator sample per pixel, hill-shaded from the height
// field, water tinted by depth. Rows are computed top to bottom.
function renderMap(m) {
  const { x0, z0, step, w, h, id } = m;
  const H = new Float32Array((w + 1) * (h + 1));
  const Bm = new Uint8Array(w * h);
  const o = gen.blank();
  for (let j = 0; j <= h; j++) {
    for (let i = 0; i <= w; i++) {
      gen.sample(x0 + i * step, z0 + j * step, o);
      H[j * (w + 1) + i] = o.h;
      if (i < w && j < h) Bm[j * w + i] = o.biome;
    }
  }
  const px = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const hh = H[j * (w + 1) + i];
      const dx = H[j * (w + 1) + i + 1] - hh, dz = H[(j + 1) * (w + 1) + i] - hh;
      let shade = 1 + (-dx - dz) / step * 0.35;
      shade = Math.max(0.55, Math.min(1.35, shade));
      let c = BIOME_COLORS[Bm[j * w + i]] ?? [128, 128, 128];
      if (hh < SEA) {
        const depth = Math.min(1, (SEA - hh) / 30);
        c = [c[0] * (1 - depth * 0.45), c[1] * (1 - depth * 0.35), c[2] * (1 - depth * 0.15)];
        shade = 1;
      } else {
        const alt = Math.min(1, Math.max(0, (hh - 70) / 110));
        c = c.map((v) => v * (0.9 + alt * 0.2));
      }
      const k = (j * w + i) * 4;
      px[k] = c[0] * shade; px[k + 1] = c[1] * shade; px[k + 2] = c[2] * shade; px[k + 3] = 255;
    }
  }
  return { type: 'map', id, x0, z0, step, w, h, px, biomes: Bm };
}
