// Deterministic terrain, biome, cave and feature generation for 32x32 chunk columns.
import { Noise, hash2, hash3, mulberry32 } from './noise.js';
import { B } from './blocks.js';

export const CS = 32;
export const WH = 256;
export const SEA = 62;

export const BIOME = {
  OCEAN: 0, BEACH: 1, PLAINS: 2, FOREST: 3, BIRCH: 4, CHERRY: 5, TAIGA: 6, SNOWY: 7, DESERT: 8,
  MOUNTAIN: 9, PEAK: 10, RIVER: 11, MEADOW: 12,
};
export const BIOME_NAMES = [
  'Ocean', 'Beach', 'Plains', 'Forest', 'Birch Forest', 'Cherry Grove', 'Taiga', 'Snowy Taiga', 'Desert',
  'Mountains', 'Snowy Peaks', 'River', 'Flower Meadow',
];

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function rgb565(r, g, b) {
  return ((Math.round(clamp(r, 0, 255) / 255 * 31) & 31) << 11) |
    ((Math.round(clamp(g, 0, 255) / 255 * 63) & 63) << 5) |
    (Math.round(clamp(b, 0, 255) / 255 * 31) & 31);
}

// Continental spline: continentalness -> base height
function contHeight(c) {
  const pts = [[-1, 22], [-0.42, 30], [-0.24, 44], [-0.12, 57], [-0.05, 63], [0.04, 66], [0.2, 72], [0.45, 84], [1, 96]];
  for (let i = 1; i < pts.length; i++) {
    if (c <= pts[i][0]) {
      const a = pts[i - 1], b = pts[i];
      const t = (c - a[0]) / (b[0] - a[0]);
      const s = t * t * (3 - 2 * t);
      return lerp(a[1], b[1], s);
    }
  }
  return 96;
}

export class WorldGen {
  constructor(seed) {
    this.seed = seed | 0;
    const s = this.seed;
    this.nC = new Noise(s ^ 0x1a2b);
    this.nE = new Noise(s ^ 0x2b3c);
    this.nP = new Noise(s ^ 0x3c4d);
    this.nD = new Noise(s ^ 0x4d5e);
    this.nT = new Noise(s ^ 0x5e6f);
    this.nH = new Noise(s ^ 0x6f70);
    this.nR = new Noise(s ^ 0x7081);
    this.nK1 = new Noise(s ^ 0x8192);
    this.nK2 = new Noise(s ^ 0x92a3);
    this.nF = new Noise(s ^ 0xa3b4);
    this.nW = new Noise(s ^ 0xb4c5);
    this.nX = new Noise(s ^ 0xc5d6);
    this.tmp = { h: 0, temp: 0, hum: 0, biome: 0, mount: 0, river: 0, cont: 0 };
  }

  // Terrain height and climate at a world column. Writes into `o`.
  sample(x, z, o = this.tmp) {
    const wx = x + this.nW.fbm2(x / 520, z / 520, 3) * 70;
    const wz = z + this.nW.fbm2(x / 520 + 31.7, z / 520 - 17.3, 3) * 70;
    const c = this.nC.fbm2(wx / 1500, wz / 1500, 5) * 1.6 + 0.2;
    const e = this.nE.fbm2(wx / 760, wz / 760, 4) * 1.6;
    const pv = this.nP.ridged2(wx / 460, wz / 460, 5);
    const d = this.nD.fbm2(x / 110, z / 110, 4);
    let h = contHeight(c);
    const inland = sstep(-0.1, 0.05, c);
    const m = sstep(0.02, 0.4, c) * (1 - sstep(-0.35, 0.25, e));
    const hills = 1 - sstep(-0.6, 0.4, e);
    h += Math.pow(pv, 2.1) * 175 * m;
    h += d * (5 + 16 * hills * inland) + this.nD.noise2(x / 23, z / 23) * 1.6 * inland;
    // rivers
    const r = Math.abs(this.nR.fbm2(wx / 1000, wz / 1000, 4));
    let river = 0;
    if (c > -0.14) {
      const width = 0.028 * (1 - 0.5 * m);
      const k = sstep(width * 0.35, width * 2.4, r);
      const bed = SEA - 3.5 + r / width * 1.5;
      if (h > bed) h = lerp(bed, h, k);
      river = 1 - k;
    }
    const temp = this.nT.fbm2(x / 820, z / 820, 3) * 1.7 - Math.max(0, h - 108) * 0.006 + 0.06;
    const hum = this.nH.fbm2(x / 640 + 100, z / 640 - 100, 3) * 1.7;
    o.h = h; o.temp = temp; o.hum = hum; o.mount = m; o.river = river; o.cont = c;
    o.biome = this.biomeOf(h, temp, hum, m, c, river, x, z);
    return o;
  }

  biomeOf(h, temp, hum, m, c, river, x, z) {
    if (h < SEA - 0.5) return river > 0.3 && c > -0.1 ? BIOME.RIVER : BIOME.OCEAN;
    if (river > 0.55) return BIOME.RIVER;
    if (h < SEA + 2.5 && c < 0.0 && temp > -0.3) return BIOME.BEACH;
    if (h > 158 - temp * 20) return BIOME.PEAK;
    if (m > 0.45 && h > 112) return temp < -0.25 ? BIOME.PEAK : BIOME.MOUNTAIN;
    if (temp > 0.3 && hum < 0.08) return BIOME.DESERT;
    if (temp < -0.48) return BIOME.SNOWY;
    if (temp < -0.26) return BIOME.TAIGA;
    if (hum > 0.3 && temp > -0.1 && temp < 0.3) return BIOME.CHERRY;
    if (hum > 0.02) return temp < 0.04 ? BIOME.BIRCH : BIOME.FOREST;
    if (this.nF.noise2(x / 300, z / 300) > 0.35) return BIOME.MEADOW;
    return BIOME.PLAINS;
  }

  grassTint(temp, hum, biome) {
    const t = clamp((temp + 0.6) / 1.2, 0, 1), w = clamp((hum + 0.6) / 1.2, 0, 1);
    // corner palette (sRGB)
    const cd = [122, 150, 96], cw = [84, 134, 82], hd = [156, 156, 70], hw = [78, 150, 44];
    const r = lerp(lerp(cd[0], cw[0], w), lerp(hd[0], hw[0], w), t);
    const g = lerp(lerp(cd[1], cw[1], w), lerp(hd[1], hw[1], w), t);
    const b = lerp(lerp(cd[2], cw[2], w), lerp(hd[2], hw[2], w), t);
    if (biome === BIOME.CHERRY) return [r * 0.9 + 12, g * 0.9 + 22, b * 0.9 + 6];
    if (biome === BIOME.MEADOW) return [r + 6, g + 10, b];
    return [r, g, b];
  }

  treeDensity(biome) {
    switch (biome) {
      case BIOME.FOREST: return 0.62;
      case BIOME.BIRCH: return 0.55;
      case BIOME.TAIGA: return 0.55;
      case BIOME.SNOWY: return 0.32;
      case BIOME.CHERRY: return 0.24;
      case BIOME.PLAINS: return 0.035;
      case BIOME.MEADOW: return 0.02;
      case BIOME.MOUNTAIN: return 0.05;
      case BIOME.DESERT: return 0.06;
      default: return 0;
    }
  }

  // Collect tree/feature candidates whose footprint may overlap [x0-margin, x0+CS+margin).
  features(cx, cz) {
    const list = [];
    const x0 = cx * CS, z0 = cz * CS;
    const cell = 5, margin = 8;
    const gx0 = Math.floor((x0 - margin) / cell), gx1 = Math.floor((x0 + CS + margin) / cell);
    const gz0 = Math.floor((z0 - margin) / cell), gz1 = Math.floor((z0 + CS + margin) / cell);
    const o = { h: 0, temp: 0, hum: 0, biome: 0, mount: 0, river: 0, cont: 0 };
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const r0 = hash2(gx, gz, this.seed + 11);
        const x = gx * cell + Math.floor(hash2(gx, gz, this.seed + 12) * cell);
        const z = gz * cell + Math.floor(hash2(gx, gz, this.seed + 13) * cell);
        this.sample(x, z, o);
        let dens = this.treeDensity(o.biome);
        if (!dens) continue;
        const glade = this.nX.fbm2(x / 180, z / 180, 2);
        if (o.biome !== BIOME.DESERT) dens *= 0.35 + 0.65 * sstep(-0.35, 0.15, glade);
        if (o.river > 0.2) continue;
        if (r0 > dens) continue;
        const h = Math.floor(o.h);
        if (h <= SEA) continue;
        // slope check
        const hx = this.sample(x + 2, z, { ...o }).h, hz = this.sample(x, z + 2, { ...o }).h;
        if (Math.abs(hx - o.h) > 3.2 || Math.abs(hz - o.h) > 3.2) continue;
        const rnd = hash2(x, z, this.seed + 99);
        let type;
        switch (o.biome) {
          case BIOME.FOREST: type = rnd < 0.12 ? 'bigoak' : rnd < 0.3 ? 'birch' : rnd < 0.36 ? 'bush' : rnd < 0.4 ? 'boulder' : 'oak'; break;
          case BIOME.BIRCH: type = rnd < 0.8 ? 'birch' : rnd < 0.9 ? 'oak' : 'bush'; break;
          case BIOME.TAIGA: type = rnd < 0.85 ? 'spruce' : rnd < 0.93 ? 'boulder' : 'bush'; break;
          case BIOME.SNOWY: type = rnd < 0.9 ? 'spruce' : 'boulder'; break;
          case BIOME.CHERRY: type = rnd < 0.85 ? 'cherry' : 'bush'; break;
          case BIOME.PLAINS: case BIOME.MEADOW: type = rnd < 0.55 ? 'oak' : rnd < 0.75 ? 'bigoak' : 'bush'; break;
          case BIOME.MOUNTAIN: type = rnd < 0.6 ? 'spruce' : 'boulder'; break;
          case BIOME.DESERT: type = 'cactus'; break;
          default: continue;
        }
        const top = h + 1 + (type === 'bigoak' ? 18 : type === 'spruce' ? 15 : type === 'cherry' ? 12 : 10);
        list.push({ type, x, y: h + 1, z, top, biome: o.biome });
      }
    }
    return list;
  }

  // Generate a chunk column. Returns block data and per-column metadata.
  generate(cx, cz) {
    const x0 = cx * CS, z0 = cz * CS;
    const seed = this.seed;
    // --- height/climate grid with 1-block margin
    const HG = new Float32Array(34 * 34);
    const temps = new Float32Array(CS * CS), hums = new Float32Array(CS * CS);
    const biomes = new Uint8Array(CS * CS), rivers = new Float32Array(CS * CS), mounts = new Float32Array(CS * CS);
    const o = this.tmp;
    let maxH = SEA;
    for (let z = -1; z <= CS; z++) {
      for (let x = -1; x <= CS; x++) {
        this.sample(x0 + x, z0 + z, o);
        HG[(z + 1) * 34 + (x + 1)] = o.h;
        if (x >= 0 && z >= 0 && x < CS && z < CS) {
          const i = z * CS + x;
          temps[i] = o.temp; hums[i] = o.hum; biomes[i] = o.biome; rivers[i] = o.river; mounts[i] = o.mount;
          if (o.h > maxH) maxH = o.h;
        }
      }
    }
    const feats = this.features(cx, cz);
    let top = maxH + 2;
    for (const f of feats) top = Math.max(top, f.top);
    const alloc = Math.min(WH, (Math.ceil((top + 2) / 16)) * 16);
    const data = new Uint8Array(alloc * CS * CS);
    const idx = (x, y, z) => (y << 10) | (z << 5) | x;

    // --- base terrain
    for (let z = 0; z < CS; z++) {
      for (let x = 0; x < CS; x++) {
        const i = z * CS + x;
        const hf = HG[(z + 1) * 34 + (x + 1)];
        const h = Math.floor(hf);
        const biome = biomes[i];
        const wxp = x0 + x, wzp = z0 + z;
        const slope = Math.max(
          Math.abs(HG[(z + 1) * 34 + x + 2] - HG[(z + 1) * 34 + x]),
          Math.abs(HG[(z + 2) * 34 + x + 1] - HG[z * 34 + x + 1]),
        );
        const n1 = hash2(wxp, wzp, seed + 5);
        const deepY = 12 + Math.floor(hash2(wxp, wzp, seed + 6) * 4);
        let topB = B.GRASS, fill = B.DIRT, fillDepth = 3 + Math.floor(n1 * 2);
        switch (biome) {
          case BIOME.OCEAN: case BIOME.RIVER: {
            const f = this.nF.noise2(wxp / 24, wzp / 24);
            topB = h < SEA - 9 ? (f > 0.25 ? B.GRAVEL : f < -0.45 ? B.CLAY : B.SAND) : (f > 0.45 ? B.GRAVEL : f < -0.5 ? B.CLAY : B.SAND);
            fill = topB === B.CLAY ? B.CLAY : B.SAND;
            if (biome === BIOME.RIVER && h >= SEA) { topB = B.GRASS; fill = B.DIRT; }
            break;
          }
          case BIOME.BEACH: topB = B.SAND; fill = B.SAND; fillDepth = 4; break;
          case BIOME.DESERT: topB = B.SAND; fill = B.SAND; fillDepth = 5; break;
          case BIOME.SNOWY: topB = B.SNOWY_GRASS; break;
          case BIOME.MOUNTAIN:
            if (slope > 2.2) { topB = B.STONE; fill = B.STONE; }
            else if (h > 138 + n1 * 8) { topB = B.SNOW; fill = B.DIRT; }
            else if (this.nF.noise2(wxp / 14, wzp / 14) > 0.55) { topB = B.GRAVEL; fill = B.GRAVEL; }
            break;
          case BIOME.PEAK:
            if (slope > 2.8) { topB = B.STONE; fill = B.STONE; }
            else { topB = B.SNOW; fill = B.SNOW; fillDepth = 2; }
            break;
          default:
            if (slope > 3.2) { topB = B.STONE; fill = B.STONE; }
        }
        for (let y = 0; y <= h && y < alloc; y++) {
          let b;
          const depth = h - y;
          if (y === 0) b = B.OBSIDIAN;
          else if (depth === 0) b = topB;
          else if (depth <= fillDepth) b = fill;
          else if (y < deepY) b = B.DEEPSLATE;
          else b = (biome === BIOME.DESERT || biome === BIOME.BEACH) && depth <= fillDepth + 5 ? B.SANDSTONE : B.STONE;
          if (b === B.GRASS && h < SEA) b = B.DIRT;
          if (b === B.SNOWY_GRASS && h < SEA) b = B.DIRT;
          data[idx(x, y, z)] = b;
        }
        // water
        for (let y = h + 1; y <= SEA && y < alloc; y++) data[idx(x, y, z)] = B.WATER;
        if (h < SEA && temps[i] < -0.34 && this.nF.noise2(wxp / 16, wzp / 16) > -0.2) data[idx(x, SEA, z)] = B.ICE;
      }
    }

    this.carveCaves(data, alloc, x0, z0, HG);
    this.placeOres(data, alloc, cx, cz);

    // --- features (trees, boulders, cacti)
    const setF = (x, y, z, b, force) => {
      const lx = x - x0, lz = z - z0;
      if (lx < 0 || lz < 0 || lx >= CS || lz >= CS || y <= 0 || y >= alloc) return;
      const k = idx(lx, y, lz);
      const cur = data[k];
      const isWood = (b >= B.OAK_LOG && b <= B.CHERRY_LOG) || (b >= B.OAK_WOOD && b <= B.SPRUCE_WOOD);
      if (force || cur === B.AIR || cur >= 50 || (isWood && cur >= B.OAK_LEAVES && cur <= B.CHERRY_LEAVES)) data[k] = b;
    };
    const getF = (x, y, z) => {
      const lx = x - x0, lz = z - z0;
      if (lx < 0 || lz < 0 || lx >= CS || lz >= CS || y < 0 || y >= alloc) return -1;
      return data[idx(lx, y, lz)];
    };
    for (const f of feats) this.placeFeature(f, setF, getF);

    // --- ground cover
    for (let z = 0; z < CS; z++) {
      for (let x = 0; x < CS; x++) {
        const i = z * CS + x;
        const wxp = x0 + x, wzp = z0 + z;
        // find top solid
        let y = alloc - 2;
        while (y > 0 && data[idx(x, y, z)] === B.AIR) y--;
        const g = data[idx(x, y, z)];
        if (y + 1 >= alloc) continue;
        const above = idx(x, y + 1, z);
        if (data[above] !== B.AIR && data[above] !== B.WATER) continue;
        const r = hash2(wxp, wzp, seed + 21);
        const biome = biomes[i];
        if (data[above] === B.WATER) {
          if ((g === B.SAND || g === B.GRAVEL || g === B.CLAY || g === B.DIRT) && y + 2 < alloc && data[idx(x, y + 2, z)] === B.WATER && r < 0.22) data[above] = B.SEAGRASS;
          continue;
        }
        if (g === B.SAND && biome === BIOME.DESERT) { if (r < 0.012) data[above] = B.DEAD_BUSH; continue; }
        if (g !== B.GRASS) continue;
        const patch = this.nF.noise2(wxp / 38, wzp / 38);
        const kind = this.nX.noise2(wxp / 70 + 40, wzp / 70);
        const flowerOf = (k) => (k < -0.4 ? B.POPPY : k < -0.1 ? B.DANDELION : k < 0.15 ? B.CORNFLOWER : k < 0.4 ? B.DAISY : B.ALLIUM);
        let p = B.AIR;
        const grass = () => (hash2(wxp, wzp, seed + 22) < 0.3 ? B.TALL_GRASS : B.SHORT_GRASS);
        switch (biome) {
          case BIOME.PLAINS:
            if (patch > 0.42 && r < 0.3) p = flowerOf(kind);
            else if (r < 0.5) p = grass();
            else if (r < 0.515) p = flowerOf(hash2(wxp, wzp, 7) * 2 - 1);
            break;
          case BIOME.MEADOW:
            if (patch > 0.1 && r < 0.42) p = flowerOf(kind + (hash2(wxp, wzp, 3) - 0.5) * 0.3);
            else if (r < 0.6) p = grass();
            break;
          case BIOME.FOREST:
            if (r < 0.28) p = grass(); else if (r < 0.33) p = B.FERN; else if (r < 0.345) p = flowerOf(kind);
            break;
          case BIOME.BIRCH:
            if (r < 0.34) p = grass(); else if (r < 0.39) p = patch > 0 ? B.DAISY : B.ALLIUM;
            break;
          case BIOME.CHERRY:
            if (r < 0.34) p = B.PINK_PETALS; else if (r < 0.58) p = grass(); else if (r < 0.61) p = B.ALLIUM;
            break;
          case BIOME.TAIGA:
            if (r < 0.2) p = B.FERN; else if (r < 0.36) p = grass();
            break;
          case BIOME.RIVER: case BIOME.BEACH:
            if (r < 0.3) p = grass();
            break;
          default:
            if (r < 0.22) p = grass();
        }
        if (p) data[above] = p;
      }
    }

    // --- metadata
    const tintG = new Uint16Array(CS * CS), tintF = new Uint16Array(CS * CS);
    const heights = new Uint8Array(CS * CS);
    for (let z = 0; z < CS; z++) {
      for (let x = 0; x < CS; x++) {
        const i = z * CS + x;
        const wxp = x0 + x, wzp = z0 + z;
        const vary = this.nX.noise2(wxp / 9, wzp / 9) * 0.06 + (hash2(wxp, wzp, seed + 31) - 0.5) * 0.04;
        const c = this.grassTint(temps[i], hums[i], biomes[i]);
        tintG[i] = rgb565(c[0] * (1 + vary), c[1] * (1 + vary), c[2] * (1 + vary * 0.5));
        tintF[i] = rgb565(c[0] * 0.82 * (1 + vary), c[1] * 0.86 * (1 + vary), c[2] * 0.8);
        let y = alloc - 1;
        while (y > 0 && data[idx(x, y, z)] === B.AIR) y--;
        heights[i] = Math.min(255, y);
      }
    }
    return { cx, cz, alloc, data, tintG, tintF, heights, biomes, temps };
  }

  carveCaves(data, alloc, x0, z0, HG) {
    // coarse 3D density grid, 4x4x4 cells, trilinear upsampled
    const top = Math.min(alloc, 200);
    const GX = 9, GY = Math.ceil(top / 4) + 1;
    const grid = new Float32Array(GX * GX * GY);
    for (let gy = 0; gy < GY; gy++) {
      const y = gy * 4;
      for (let gz = 0; gz < GX; gz++) {
        for (let gx = 0; gx < GX; gx++) {
          const x = x0 + gx * 4, z = z0 + gz * 4;
          const a = this.nK1.noise3(x / 52, y / 30, z / 52);
          const b = this.nK2.noise3(x / 52, y / 30, z / 52);
          let v = (a * a + b * b) / 0.011;
          if (y < 56) {
            const ch = this.nK1.noise3(x / 95 + 71, y / 48, z / 95 - 13);
            const t = sstep(8, 30, y) * (1 - sstep(40, 56, y));
            v = Math.min(v, 1 + (0.56 - ch) * 9 / Math.max(t, 0.01));
          }
          grid[(gy * GX + gz) * GX + gx] = v;
        }
      }
    }
    for (let z = 0; z < CS; z++) {
      for (let x = 0; x < CS; x++) {
        const h = Math.floor(HG[(z + 1) * 34 + (x + 1)]);
        const gxf = x / 4, gzf = z / 4;
        const ix = Math.min(7, gxf | 0), iz = Math.min(7, gzf | 0);
        const fx = gxf - ix, fz = gzf - iz;
        const yMax = Math.min(h - (h < SEA + 2 ? 4 : 0), top - 1);
        for (let y = 1; y <= yMax; y++) {
          const gyf = y / 4, iy = gyf | 0, fy = gyf - iy;
          const g = (yy, zz, xx) => grid[((iy + yy) * GX + iz + zz) * GX + ix + xx];
          const v = lerp(
            lerp(lerp(g(0, 0, 0), g(0, 0, 1), fx), lerp(g(0, 1, 0), g(0, 1, 1), fx), fz),
            lerp(lerp(g(1, 0, 0), g(1, 0, 1), fx), lerp(g(1, 1, 0), g(1, 1, 1), fx), fz), fy);
          // keep a crust near the surface except in occasional openings
          const surfaceBias = y > h - 5 ? (h - y) * 0.0 + 0.35 : 0;
          if (v < 1 - surfaceBias) {
            const k = (y << 10) | (z << 5) | x;
            const cur = data[k];
            if (cur === B.WATER || cur === B.OBSIDIAN || cur === B.ICE) continue;
            // do not open caves directly under water
            const above = y + 1 < alloc ? data[((y + 1) << 10) | (z << 5) | x] : 0;
            if (above === B.WATER) continue;
            data[k] = y <= 9 ? B.LAVA : B.AIR;
          }
        }
      }
    }
    // cave floor decoration & glow
    for (let z = 0; z < CS; z++) {
      for (let x = 0; x < CS; x++) {
        const h = Math.floor(HG[(z + 1) * 34 + (x + 1)]);
        for (let y = 11; y < Math.min(h - 6, alloc - 1); y++) {
          const k = (y << 10) | (z << 5) | x;
          if (data[k] !== B.AIR) continue;
          const below = data[k - 1024];
          const r = hash3(x0 + x, y, z0 + z, this.seed + 41);
          if ((below === B.STONE || below === B.DEEPSLATE) && r < 0.035) data[k] = B.GLOW_MUSHROOM;
          else if ((below === B.STONE || below === B.DEEPSLATE) && r < 0.06 && y < 40) data[k - 1024] = B.MOSS;
        }
      }
    }
  }

  placeOres(data, alloc, cx, cz) {
    const rng = mulberry32((cx * 73856093) ^ (cz * 19349663) ^ this.seed);
    const ores = [
      [B.COAL_ORE, 20, 12, 128, 9], [B.IRON_ORE, 12, 5, 72, 6], [B.COPPER_ORE, 10, 20, 90, 7],
      [B.GOLD_ORE, 4, 5, 34, 5], [B.DIAMOND_ORE, 3, 2, 16, 4], [B.EMERALD_ORE, 2, 30, 110, 2],
      [B.AMETHYST, 3, 10, 40, 6],
    ];
    for (const [ore, count, y0, y1, size] of ores) {
      for (let n = 0; n < count; n++) {
        let x = Math.floor(rng() * CS), z = Math.floor(rng() * CS), y = y0 + Math.floor(rng() * (y1 - y0));
        const len = 1 + Math.floor(rng() * size);
        for (let s = 0; s < len; s++) {
          if (x >= 0 && z >= 0 && x < CS && z < CS && y > 0 && y < alloc) {
            const k = (y << 10) | (z << 5) | x;
            if (data[k] === B.STONE || data[k] === B.DEEPSLATE) data[k] = ore;
          }
          const d = Math.floor(rng() * 6);
          if (d === 0) x++; else if (d === 1) x--; else if (d === 2) z++; else if (d === 3) z--; else if (d === 4) y++; else y--;
        }
      }
    }
    // occasional geode pocket
    if (rng() < 0.18) {
      const gx = 6 + Math.floor(rng() * 20), gz = 6 + Math.floor(rng() * 20), gy = 16 + Math.floor(rng() * 24);
      const R = 3.5 + rng() * 1.5;
      for (let y = gy - 6; y <= gy + 6; y++) for (let z = gz - 6; z <= gz + 6; z++) for (let x = gx - 6; x <= gx + 6; x++) {
        if (x < 0 || z < 0 || x >= CS || z >= CS || y <= 1 || y >= alloc) continue;
        const d = Math.hypot(x - gx, (y - gy) * 1.15, z - gz);
        const k = (y << 10) | (z << 5) | x;
        if (data[k] === B.AIR || data[k] === B.WATER) continue;
        if (d < R - 1.2) data[k] = B.AIR;
        else if (d < R) data[k] = B.AMETHYST;
        else if (d < R + 1) data[k] = B.MARBLE;
      }
    }
  }

  placeFeature(f, set, get) {
    const rng = mulberry32((f.x * 734287) ^ (f.z * 912271) ^ (this.seed * 31));
    const { x, y, z } = f;
    // must stand on a suitable block
    const g = get(x, y - 1, z);
    if (g !== -1) {
      if (f.type === 'cactus' ? g !== B.SAND : !(g === B.GRASS || g === B.SNOWY_GRASS || g === B.DIRT || g === B.SNOW || g === B.STONE || g === B.GRAVEL)) return;
    }
    const blob = (cx, cy, cz, rx, ry, rz, leaf, rough = 0.28) => {
      const X = Math.ceil(rx), Y = Math.ceil(ry), Z = Math.ceil(rz);
      for (let dy = -Y; dy <= Y; dy++) for (let dz = -Z; dz <= Z; dz++) for (let dx = -X; dx <= X; dx++) {
        const d = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) + (dz * dz) / (rz * rz);
        const n = hash3(cx + dx, cy + dy, cz + dz, this.seed + 3);
        if (d < 1 - rough * n) set(cx + dx, cy + dy, cz + dz, leaf);
      }
    };
    const trunk = (h, log) => { for (let i = 0; i < h; i++) set(x, y + i, z, log, true); };
    switch (f.type) {
      case 'oak': {
        const h = 4 + Math.floor(rng() * 3);
        trunk(h, B.OAK_LOG);
        blob(x, y + h - 1, z, 2.6, 2.2, 2.6, B.OAK_LEAVES);
        blob(x, y + h + 1, z, 1.6, 1.2, 1.6, B.OAK_LEAVES, 0.1);
        break;
      }
      case 'bigoak': {
        const h = 8 + Math.floor(rng() * 4);
        trunk(h, B.OAK_LOG);
        const branches = 3 + Math.floor(rng() * 2);
        for (let b = 0; b < branches; b++) {
          const a = rng() * Math.PI * 2 + b * 2.1;
          const by = y + 4 + Math.floor(rng() * (h - 4));
          const len = 3 + Math.floor(rng() * 3);
          let bx = x, bz = z, yy = by;
          for (let i = 1; i <= len; i++) {
            bx = x + Math.round(Math.cos(a) * i); bz = z + Math.round(Math.sin(a) * i); yy = by + Math.floor(i * 0.6);
            set(bx, yy, bz, B.OAK_WOOD, true);
          }
          blob(bx, yy + 1, bz, 2.8, 2.0, 2.8, B.OAK_LEAVES);
        }
        blob(x, y + h, z, 3.4, 2.6, 3.4, B.OAK_LEAVES);
        break;
      }
      case 'birch': {
        const h = 5 + Math.floor(rng() * 3);
        trunk(h, B.BIRCH_LOG);
        blob(x, y + h - 1, z, 2.2, 2.6, 2.2, B.BIRCH_LEAVES);
        set(x, y + h + 1, z, B.BIRCH_LEAVES);
        break;
      }
      case 'spruce': {
        const h = 8 + Math.floor(rng() * 5);
        trunk(h, B.SPRUCE_LOG);
        let r = 0.6;
        for (let yy = y + h + 1; yy >= y + 3; yy--) {
          const layer = y + h + 1 - yy;
          r = 0.6 + layer * 0.33;
          if (layer % 3 === 2) r *= 0.6;
          const R = Math.min(r, 3.3);
          const Ri = Math.ceil(R);
          for (let dz = -Ri; dz <= Ri; dz++) for (let dx = -Ri; dx <= Ri; dx++) {
            if (dx * dx + dz * dz <= R * R + 0.3 && !(dx === 0 && dz === 0 && yy < y + h)) set(x + dx, yy, z + dz, B.SPRUCE_LEAVES);
          }
        }
        set(x, y + h + 2, z, B.SPRUCE_LEAVES);
        break;
      }
      case 'cherry': {
        const h = 4 + Math.floor(rng() * 2);
        trunk(h, B.CHERRY_LOG);
        const a0 = rng() * Math.PI * 2;
        for (let b = 0; b < 2; b++) {
          const a = a0 + b * Math.PI + (rng() - 0.5) * 0.8;
          const len = 3 + Math.floor(rng() * 2);
          let bx = x, bz = z, yy = y + h - 1;
          for (let i = 1; i <= len; i++) {
            bx = x + Math.round(Math.cos(a) * i); bz = z + Math.round(Math.sin(a) * i);
            yy = y + h - 1 + Math.floor(i * 0.75);
            set(bx, yy, bz, B.CHERRY_WOOD, true);
          }
          blob(bx, yy + 1, bz, 3.6, 1.7, 3.6, B.CHERRY_LEAVES, 0.2);
          // hanging blossoms
          for (let k = 0; k < 10; k++) {
            const hx = bx + Math.floor((rng() - 0.5) * 6), hz = bz + Math.floor((rng() - 0.5) * 6);
            const d = rng() < 0.5 ? 1 : 2;
            for (let j = 0; j < d; j++) set(hx, yy - j, hz, B.CHERRY_LEAVES);
          }
        }
        break;
      }
      case 'bush': {
        set(x, y, z, B.OAK_LOG, true);
        blob(x, y, z, 1.7, 1.2, 1.7, f.biome === BIOME.TAIGA ? B.SPRUCE_LEAVES : B.OAK_LEAVES, 0.35);
        break;
      }
      case 'boulder': {
        const r = 1.3 + rng() * 1.2;
        const X = Math.ceil(r);
        for (let dy = -1; dy <= X; dy++) for (let dz = -X; dz <= X; dz++) for (let dx = -X; dx <= X; dx++) {
          const d = Math.hypot(dx, dy * 1.2, dz);
          if (d < r - hash3(x + dx, y + dy, z + dz, 5) * 0.5) {
            const top = dy >= Math.floor(r * 0.5);
            set(x + dx, y + dy - 1, z + dz, top && rng() < 0.7 ? B.MOSSY_COBBLE : rng() < 0.5 ? B.COBBLE : B.STONE, true);
          }
        }
        break;
      }
      case 'cactus': {
        const h = 1 + Math.floor(rng() * 3);
        for (let i = 0; i < h; i++) set(x, y + i, z, B.CACTUS, true);
        break;
      }
    }
  }
}
