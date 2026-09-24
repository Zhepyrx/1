// Deterministic terrain, biome, cave and feature generation for 32x32 chunk columns.
import { Noise, hash2, hash3, mulberry32 } from './noise.js';
import { B, RENDER, R, isLog, isLeaves } from './blocks.js';

export const CS = 32;
export const WH = 256;
export const SEA = 62;

export const BIOME = {
  OCEAN: 0, BEACH: 1, PLAINS: 2, FOREST: 3, BIRCH: 4, CHERRY: 5, TAIGA: 6, SNOWY: 7, DESERT: 8,
  MOUNTAIN: 9, PEAK: 10, RIVER: 11, MEADOW: 12,
  AUTUMN: 13, JUNGLE: 14, SAVANNA: 15, BADLANDS: 16, SWAMP: 17, LUMEN: 18, VOLCANIC: 19, REEF: 20,
  TROPICAL: 21, LAVENDER: 22, ICE_SPIKES: 23,
};
export const BIOME_NAMES = [
  'Ocean', 'Beach', 'Plains', 'Forest', 'Birch Forest', 'Cherry Grove', 'Taiga', 'Snowy Taiga', 'Desert',
  'Mountains', 'Snowy Peaks', 'River', 'Flower Meadow',
  'Autumn Maples', 'Jungle', 'Savanna', 'Badlands Mesa', 'Willow Swamp', 'Lumen Grove', 'Volcanic Fields',
  'Coral Reef', 'Tropical Shore', 'Lavender Fields', 'Ice Spikes',
];
// Map colours (sRGB) for the world map, one per biome.
export const BIOME_COLORS = [
  [38, 78, 128], [218, 205, 150], [128, 170, 86], [62, 118, 52], [118, 160, 92], [236, 164, 196], [70, 104, 80],
  [214, 226, 232], [226, 204, 142], [128, 126, 122], [238, 242, 246], [70, 126, 176], [168, 196, 92],
  [212, 104, 40], [34, 132, 44], [196, 178, 88], [196, 98, 52], [86, 104, 62], [52, 206, 214], [70, 58, 58],
  [60, 196, 196], [236, 214, 140], [160, 128, 214], [168, 206, 240],
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

// Colour strata of the badlands, repeating every 48 blocks.
const STRATA_SRC = [B.TC_ORANGE, B.TC_ORANGE, B.TC_YELLOW, B.TC_WHITE, B.TC_ORANGE, B.TC_RED, B.TC_RED, B.TC_BROWN,
  B.TC_LIGHT, B.TC_ORANGE, B.TERRACOTTA, B.TC_YELLOW, B.TC_YELLOW, B.TC_ORANGE, B.TC_WHITE, B.TC_RED];

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
    this.nS = new Noise(s ^ 0xd6e7);   // rare special regions (Lumen Grove / volcanic)
    this.nM = new Noise(s ^ 0xe7f8);   // badlands vs desert
    this.nA = new Noise(s ^ 0xf809);   // autumn forests, lavender
    this.nI = new Noise(s ^ 0x091a);   // ice spikes
    const rng = mulberry32(s ^ 0x5eed);
    this.strata = new Uint8Array(48);
    for (let i = 0; i < 48; i++) this.strata[i] = STRATA_SRC[Math.floor(rng() * STRATA_SRC.length)];
    for (let i = 0; i < 48; i += 7 + Math.floor(rng() * 5)) this.strata[i] = B.TC_WHITE;
    this.tmp = this.blank();
  }

  blank() { return { h: 0, temp: 0, hum: 0, biome: 0, mount: 0, river: 0, cont: 0, sp: 0, mesa: 0, aut: 0, ws: 0, mdw: 0, lava: 0 }; }

  // Terrain height and climate at a world column. Writes into `o`.
  sample(x, z, o = this.tmp) {
    const wx = x + this.nW.fbm2(x / 520, z / 520, 3) * 70;
    const wz = z + this.nW.fbm2(x / 520 + 31.7, z / 520 - 17.3, 3) * 70;
    const c = this.nC.fbm2(wx / 1500, wz / 1500, 5) * 1.6 + 0.2;
    const e = this.nE.fbm2(wx / 760, wz / 760, 4) * 1.6;
    const pv = this.nP.ridged2(wx / 460, wz / 460, 5);
    const d = this.nD.fbm2(x / 110, z / 110, 4);
    const tb = this.nT.fbm2(x / 1250, z / 1250, 3) * 1.75 + 0.06;
    const hum = this.nH.fbm2(x / 980 + 100, z / 980 - 100, 3) * 1.75;
    const sp = this.nS.fbm2(x / 1150 + 7.7, z / 1150 - 3.1, 2) * 1.5;
    const mesa = this.nM.fbm2(x / 520, z / 520, 3) * 1.4;
    const aut = this.nA.fbm2(x / 900 - 40, z / 900 + 12, 2) * 1.5;
    let h = contHeight(c);
    const inland = sstep(-0.1, 0.05, c);
    const m = sstep(0.02, 0.4, c) * (1 - sstep(-0.35, 0.25, e));
    const hills = 1 - sstep(-0.6, 0.4, e);
    h += Math.pow(pv, 2.1) * 175 * m;
    h += d * (5 + 16 * hills * inland) + this.nD.noise2(x / 23, z / 23) * 1.6 * inland;
    // --- badlands mesas: terraced plateaus with steep cliffs
    const wb = sstep(0.04, 0.3, mesa) * sstep(0.22, 0.4, tb) * sstep(0.14, -0.02, hum) * inland * (1 - m);
    if (wb > 0.001) {
      const r = this.nM.ridged2(x / 240 + 5.3, z / 240 - 2.7, 4);
      let mh = SEA + 5 + Math.max(0, r * 62 - 18) + d * 4;
      const step = 7;
      const f = mh / step, fl = Math.floor(f);
      mh = (fl + sstep(0.78, 1, f - fl)) * step;
      h = lerp(h, Math.max(h, mh), wb);
    }
    // --- volcanic highlands: a cone with a crater at the heart of the region
    let lava = 0;
    const wv = sstep(-0.7, -1.05, sp) * sstep(-0.2, 0.0, tb) * inland;
    if (wv > 0.001) {
      const rough = this.nP.ridged2(x / 90, z / 90, 3);
      h += wv * wv * 62 + rough * 9 * wv;
      const crater = sstep(0.8, 0.97, wv);
      if (crater > 0) { h -= crater * 30; lava = crater; }
    }
    // --- swamps: flatten warm humid lowlands to just above/below sea level
    const ws = sstep(0.38, 0.55, hum) * sstep(-0.2, 0.0, tb) * sstep(SEA + 14, SEA + 4, h) * inland * (1 - wv);
    if (ws > 0.001) h = lerp(h, SEA + 0.4 + this.nD.noise2(x / 17, z / 17) * 1.7, ws);
    // --- rivers
    const r = Math.abs(this.nR.fbm2(wx / 1000, wz / 1000, 4));
    let river = 0;
    if (c > -0.14) {
      const width = 0.028 * (1 - 0.5 * m) * (1 - 0.6 * wv);
      const k = sstep(width * 0.35, width * 2.4, r);
      const bed = SEA - 3.5 + r / width * 1.5;
      if (h > bed) h = lerp(bed, h, k);
      river = 1 - k;
    }
    const temp = tb - Math.max(0, h - 118) * 0.005;
    o.h = h; o.temp = temp; o.hum = hum; o.mount = m; o.river = river; o.cont = c;
    o.sp = sp; o.mesa = mesa; o.aut = aut; o.ws = ws; o.lava = lava;
    o.mdw = this.nF.noise2(x / 300, z / 300);
    o.biome = this.biomeOf(o, x, z);
    return o;
  }

  biomeOf(o, x, z) {
    const { h, temp, hum, mount: m, cont: c, river, sp, mesa, aut, ws } = o;
    if (h < SEA - 0.5) {
      if (river > 0.3 && c > -0.1) return ws > 0.5 ? BIOME.SWAMP : BIOME.RIVER;
      if (ws > 0.5) return BIOME.SWAMP;
      if (temp > 0.3 && h > SEA - 18) return BIOME.REEF;
      return BIOME.OCEAN;
    }
    if (river > 0.55) return ws > 0.5 ? BIOME.SWAMP : BIOME.RIVER;
    if (sp < -0.84 && temp > -0.2 && c > -0.05) return BIOME.VOLCANIC;
    if (h < SEA + 2.5 && c < 0.0 && temp > -0.3 && ws < 0.5) return temp > 0.28 ? BIOME.TROPICAL : BIOME.BEACH;
    if (h > 158 - temp * 20) return BIOME.PEAK;
    if (m > 0.45 && h > 112) return temp < -0.25 ? BIOME.PEAK : BIOME.MOUNTAIN;
    if (sp > 0.7 && temp > -0.35 && temp < 0.42 && hum > -0.15) return BIOME.LUMEN;
    if (ws > 0.5) return BIOME.SWAMP;
    if (temp > 0.3) {
      if (hum < 0.06) return mesa > 0.1 ? BIOME.BADLANDS : BIOME.DESERT;
      if (hum < 0.32) return BIOME.SAVANNA;
      return BIOME.JUNGLE;
    }
    if (temp < -0.48) return this.nI.noise2(x / 260, z / 260) > 0.3 ? BIOME.ICE_SPIKES : BIOME.SNOWY;
    if (temp < -0.26) return BIOME.TAIGA;
    if (hum > 0.3 && temp > -0.1) return BIOME.CHERRY;
    if (hum > 0.02) return aut > 0.28 ? BIOME.AUTUMN : temp < 0.04 ? BIOME.BIRCH : BIOME.FOREST;
    if (o.mdw > 0.35) return aut < -0.15 ? BIOME.LAVENDER : BIOME.MEADOW;
    return BIOME.PLAINS;
  }

  // Grass colour from smooth climate fields, so biome borders blend instead of stepping.
  grassTint(o) {
    const { temp, hum } = o;
    const t = clamp((temp + 0.6) / 1.2, 0, 1), w = clamp((hum + 0.6) / 1.2, 0, 1);
    const cd = [122, 150, 96], cw = [84, 134, 82], hd = [156, 156, 70], hw = [78, 150, 44];
    let c = [0, 1, 2].map((k) => lerp(lerp(cd[k], cw[k], w), lerp(hd[k], hw[k], w), t));
    const mix = (tgt, a) => { if (a > 0) c = c.map((v, k) => lerp(v, tgt[k], a)); };
    const hot = sstep(0.22, 0.38, temp);
    mix([176, 160, 74], hot * (1 - sstep(0.2, 0.36, hum)));            // savanna gold
    mix([58, 164, 38], hot * sstep(0.2, 0.36, hum));                  // jungle
    mix([150, 138, 62], sstep(0.2, 0.36, o.aut) * sstep(-0.02, 0.08, hum) * (1 - hot) * sstep(-0.32, -0.2, temp)); // autumn
    mix([84, 104, 52], o.ws);                                           // swamp
    mix([54, 128, 116], sstep(0.6, 0.75, o.sp));                        // lumen
    mix([118, 112, 82], sstep(-0.75, -0.9, o.sp));                      // volcanic dust
    mix([120, 150, 100], sstep(0.25, 0.4, o.mdw) * sstep(-0.05, -0.2, o.aut) * (1 - sstep(0.0, 0.05, hum)));
    if (o.biome === BIOME.CHERRY) c = [c[0] * 0.9 + 12, c[1] * 0.9 + 22, c[2] * 0.9 + 6];
    if (o.biome === BIOME.MEADOW) c = [c[0] + 6, c[1] + 10, c[2]];
    return c;
  }

  // Water character from the (smooth) climate: murkiness in warm humid lowlands, tropical clarity in warm seas.
  waterParams(o) {
    const murk = Math.max(o.ws, sstep(0.3, 0.75, o.hum) * sstep(-0.2, 0.2, o.temp) * 0.55) * 0.85;
    const trop = sstep(0.22, 0.55, o.temp) * (1 - murk);
    return [murk, trop];
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
      case BIOME.AUTUMN: return 0.56;
      case BIOME.JUNGLE: return 0.8;
      case BIOME.SAVANNA: return 0.07;
      case BIOME.SWAMP: return 0.2;
      case BIOME.LUMEN: return 0.2;
      case BIOME.VOLCANIC: return 0.1;
      case BIOME.TROPICAL: return 0.12;
      case BIOME.REEF: return 0.5;
      case BIOME.LAVENDER: return 0.02;
      case BIOME.ICE_SPIKES: return 0.08;
      case BIOME.BADLANDS: return 0.05;
      default: return 0;
    }
  }

  // Collect tree/feature candidates whose footprint may overlap [x0-margin, x0+CS+margin).
  features(cx, cz) {
    const list = [];
    const x0 = cx * CS, z0 = cz * CS;
    const cell = 5, margin = 12;
    const gx0 = Math.floor((x0 - margin) / cell), gx1 = Math.floor((x0 + CS + margin) / cell);
    const gz0 = Math.floor((z0 - margin) / cell), gz1 = Math.floor((z0 + CS + margin) / cell);
    const o = this.blank(), o2 = this.blank();
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const r0 = hash2(gx, gz, this.seed + 11);
        const x = gx * cell + Math.floor(hash2(gx, gz, this.seed + 12) * cell);
        const z = gz * cell + Math.floor(hash2(gx, gz, this.seed + 13) * cell);
        this.sample(x, z, o);
        let dens = this.treeDensity(o.biome);
        if (!dens) continue;
        const underwater = o.biome === BIOME.REEF;
        const glade = this.nX.fbm2(x / 180, z / 180, 2);
        if (o.biome !== BIOME.DESERT && !underwater && o.biome !== BIOME.BADLANDS) dens *= 0.35 + 0.65 * sstep(-0.35, 0.15, glade);
        if (o.river > 0.2 && o.biome !== BIOME.SWAMP) continue;
        if (r0 > dens) continue;
        const h = Math.floor(o.h);
        if (underwater ? h > SEA - 3 : h <= SEA && o.biome !== BIOME.SWAMP) continue;
        if (o.biome === BIOME.SWAMP && h < SEA - 1) continue;
        // slope check
        const hx = this.sample(x + 2, z, o2).h, hz = this.sample(x, z + 2, o2).h;
        if (Math.abs(hx - o.h) > 3.2 || Math.abs(hz - o.h) > 3.2) continue;
        const rnd = hash2(x, z, this.seed + 99);
        let type, tall = 10;
        switch (o.biome) {
          case BIOME.FOREST: type = rnd < 0.12 ? 'bigoak' : rnd < 0.3 ? 'birch' : rnd < 0.36 ? 'bush' : rnd < 0.4 ? 'boulder' : 'oak'; break;
          case BIOME.BIRCH: type = rnd < 0.8 ? 'birch' : rnd < 0.9 ? 'oak' : 'bush'; break;
          case BIOME.TAIGA: type = rnd < 0.85 ? 'spruce' : rnd < 0.93 ? 'boulder' : 'bush'; break;
          case BIOME.SNOWY: type = rnd < 0.9 ? 'spruce' : 'boulder'; break;
          case BIOME.CHERRY: type = rnd < 0.85 ? 'cherry' : 'bush'; break;
          case BIOME.PLAINS: case BIOME.MEADOW: type = rnd < 0.55 ? 'oak' : rnd < 0.75 ? 'bigoak' : 'bush'; break;
          case BIOME.LAVENDER: type = rnd < 0.6 ? 'oak' : 'birch'; break;
          case BIOME.MOUNTAIN: type = rnd < 0.6 ? 'spruce' : 'boulder'; break;
          case BIOME.DESERT: type = 'cactus'; break;
          case BIOME.BADLANDS: type = rnd < 0.45 ? 'hoodoo' : 'cactus'; break;
          case BIOME.AUTUMN: type = rnd < 0.7 ? 'maple' : rnd < 0.86 ? 'birch' : rnd < 0.94 ? 'bigmaple' : 'boulder'; break;
          case BIOME.JUNGLE: type = rnd < 0.16 ? 'giantjungle' : rnd < 0.62 ? 'jungle' : 'jbush'; break;
          case BIOME.SAVANNA: type = rnd < 0.8 ? 'acacia' : 'bush'; break;
          case BIOME.SWAMP: type = rnd < 0.75 ? 'willow' : 'oak'; break;
          case BIOME.LUMEN: type = rnd < 0.55 ? 'gshroom' : rnd < 0.85 ? 'smallshroom' : 'boulder'; break;
          case BIOME.VOLCANIC: type = rnd < 0.4 ? 'basalt' : rnd < 0.7 ? 'deadtree' : 'vent'; break;
          case BIOME.TROPICAL: type = 'palm'; break;
          case BIOME.REEF: type = rnd < 0.7 ? 'coral' : 'kelp'; break;
          case BIOME.ICE_SPIKES: type = 'icespike'; break;
          default: continue;
        }
        switch (type) {
          case 'bigoak': case 'bigmaple': tall = 18; break;
          case 'spruce': tall = 15; break;
          case 'cherry': case 'maple': case 'willow': case 'palm': tall = 13; break;
          case 'giantjungle': tall = 32; break;
          case 'jungle': tall = 14; break;
          case 'gshroom': tall = 20; break;
          case 'icespike': tall = 34; break;
          case 'hoodoo': tall = 16; break;
        }
        list.push({ type, x, y: h + 1, z, top: h + 1 + tall, biome: o.biome });
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
    const biomes = new Uint8Array(CS * CS), rivers = new Float32Array(CS * CS), lavas = new Float32Array(CS * CS);
    const tintG = new Uint16Array(CS * CS), tintF = new Uint16Array(CS * CS), tintW = new Uint16Array(CS * CS);
    const o = this.tmp;
    let maxH = SEA;
    for (let z = -1; z <= CS; z++) {
      for (let x = -1; x <= CS; x++) {
        this.sample(x0 + x, z0 + z, o);
        HG[(z + 1) * 34 + (x + 1)] = o.h;
        if (x >= 0 && z >= 0 && x < CS && z < CS) {
          const i = z * CS + x;
          temps[i] = o.temp; hums[i] = o.hum; biomes[i] = o.biome; rivers[i] = o.river; lavas[i] = o.lava;
          if (o.h > maxH) maxH = o.h;
          // colours for grass, leaves and water, from smooth climate fields
          const wxp = x0 + x, wzp = z0 + z;
          const vary = this.nX.noise2(wxp / 9, wzp / 9) * 0.06 + (hash2(wxp, wzp, seed + 31) - 0.5) * 0.04;
          const c = this.grassTint(o);
          tintG[i] = rgb565(c[0] * (1 + vary), c[1] * (1 + vary), c[2] * (1 + vary * 0.5));
          tintF[i] = rgb565(c[0] * 0.82 * (1 + vary), c[1] * 0.86 * (1 + vary), c[2] * 0.8);
          const wpar = this.waterParams(o);
          tintW[i] = rgb565(wpar[0] * 255, wpar[1] * 255, 0);
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
        let topB = B.GRASS, fill = B.DIRT, fillDepth = 3 + Math.floor(n1 * 2), stone = B.STONE, strata = false;
        const patch = this.nF.noise2(wxp / 24, wzp / 24);
        switch (biome) {
          case BIOME.OCEAN: case BIOME.RIVER: case BIOME.REEF: {
            topB = h < SEA - 9 ? (patch > 0.25 ? B.GRAVEL : patch < -0.45 ? B.CLAY : B.SAND) : (patch > 0.45 ? B.GRAVEL : patch < -0.5 ? B.CLAY : B.SAND);
            if (biome === BIOME.REEF) topB = patch > 0.55 ? B.GRAVEL : B.SAND;
            fill = topB === B.CLAY ? B.CLAY : B.SAND;
            if (biome === BIOME.RIVER && h >= SEA) { topB = B.GRASS; fill = B.DIRT; }
            break;
          }
          case BIOME.BEACH: case BIOME.TROPICAL: topB = B.SAND; fill = B.SAND; fillDepth = 4; break;
          case BIOME.DESERT: topB = B.SAND; fill = B.SAND; fillDepth = 5; break;
          case BIOME.BADLANDS:
            strata = true;
            topB = slope < 1.2 && patch > -0.2 ? B.RED_SAND : 0; fill = 0; fillDepth = 1;
            break;
          case BIOME.SNOWY: topB = B.SNOWY_GRASS; break;
          case BIOME.ICE_SPIKES: topB = B.SNOW; fill = B.SNOW; fillDepth = 2; break;
          case BIOME.TAIGA: if (patch > 0.2) topB = B.PODZOL; break;
          case BIOME.AUTUMN: if (patch > 0.45) topB = B.PODZOL; break;
          case BIOME.JUNGLE: if (patch > 0.5) topB = B.PODZOL; else if (patch < -0.55) topB = B.MOSS; break;
          case BIOME.SWAMP: topB = patch > 0.25 || h < SEA ? B.MUD : B.GRASS; fill = h < SEA ? B.MUD : B.DIRT; break;
          case BIOME.LUMEN: topB = B.GLOWMOSS; break;
          case BIOME.VOLCANIC: {
            stone = B.BASALT;
            const vn = this.nF.noise2(wxp / 13, wzp / 13);
            topB = slope > 2.2 ? B.BASALT : vn > 0.5 ? B.MAGMA : vn > 0.05 ? B.ASH : vn > -0.4 ? B.BASALT : B.OBSIDIAN;
            fill = B.BASALT;
            break;
          }
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
        const soft = biome !== BIOME.VOLCANIC && biome !== BIOME.BADLANDS && biome !== BIOME.ICE_SPIKES;
        if (soft && slope > 3.2 && biome !== BIOME.MOUNTAIN && biome !== BIOME.PEAK && biome !== BIOME.SWAMP) { topB = B.STONE; fill = B.STONE; }
        const sOff = Math.floor(this.nM.noise2(wxp / 60, wzp / 60) * 3);
        for (let y = 0; y <= h && y < alloc; y++) {
          let b;
          const depth = h - y;
          if (y === 0) b = B.OBSIDIAN;
          else if (strata && y > SEA - 12 && depth > 0 || (strata && depth === 0 && !topB)) b = this.strata[((y + sOff) % 48 + 48) % 48];
          else if (depth === 0) b = topB;
          else if (depth <= fillDepth) b = fill || stone;
          else if (y < deepY) b = B.DEEPSLATE;
          else b = (biome === BIOME.DESERT || biome === BIOME.BEACH || biome === BIOME.TROPICAL) && depth <= fillDepth + 5 ? B.SANDSTONE : stone;
          if ((b === B.GRASS || b === B.SNOWY_GRASS || b === B.GLOWMOSS || b === B.PODZOL) && h < SEA) b = biome === BIOME.SWAMP ? B.MUD : B.DIRT;
          data[idx(x, y, z)] = b;
        }
        // water (or lava in volcanic craters)
        const fillB = lavas[i] > 0.3 && h < SEA + 40 ? B.LAVA : B.WATER;
        for (let y = h + 1; y <= SEA && y < alloc; y++) data[idx(x, y, z)] = fillB;
        if (lavas[i] > 0.5) {
          // molten floor of the crater
          const lvl = h + 1 + Math.floor(lavas[i] * 2);
          for (let y = h; y <= lvl && y < alloc; y++) data[idx(x, y, z)] = B.LAVA;
        }
        if (h < SEA && temps[i] < -0.34 && this.nF.noise2(wxp / 16, wzp / 16) > -0.2) data[idx(x, SEA, z)] = B.ICE;
      }
    }

    this.carveCaves(data, alloc, x0, z0, HG);
    this.placeOres(data, alloc, cx, cz);

    // --- features (trees, boulders, cacti, corals...)
    const setF = (x, y, z, b, force) => {
      const lx = x - x0, lz = z - z0;
      if (lx < 0 || lz < 0 || lx >= CS || lz >= CS || y <= 0 || y >= alloc) return;
      const k = idx(lx, y, lz);
      const cur = data[k];
      const rc = RENDER[cur];
      if (force === 2) { if (cur === B.WATER || cur === B.AIR || rc === R.CROSS) data[k] = b; return; }
      if (force || cur === B.AIR || rc === R.CROSS || rc === R.CARPET || (isLog(b) && isLeaves(cur))) data[k] = b;
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
        let y = alloc - 2;
        while (y > 0 && data[idx(x, y, z)] === B.AIR) y--;
        const g = data[idx(x, y, z)];
        if (y + 1 >= alloc) continue;
        const above = idx(x, y + 1, z);
        const r = hash2(wxp, wzp, seed + 21);
        const biome = biomes[i];
        if (g === B.WATER) {
          let fy = y;
          while (fy > 1 && data[idx(x, fy, z)] === B.WATER) fy--;
          // lily pads on calm shallow swamp and river water
          if (y === SEA && data[above] === B.AIR && (biome === BIOME.SWAMP || (biome === BIOME.RIVER && hums[i] > 0.2)) &&
              y - fy < 5 && r < (biome === BIOME.SWAMP ? 0.14 : 0.04)) data[above] = B.LILY_PAD;
          else this.coverUnderwater(data, alloc, x, fy, z, data[idx(x, fy, z)], biome, temps[i], hash2(wxp, wzp, seed + 23), wxp, wzp);
          continue;
        }
        if (data[above] !== B.AIR) continue;
        if (g === B.SAND && biome === BIOME.DESERT) { if (r < 0.012) data[above] = B.DEAD_BUSH; continue; }
        if ((g === B.RED_SAND || RENDER[g] === R.CUBE) && biome === BIOME.BADLANDS) { if (r < 0.018) data[above] = B.DEAD_BUSH; continue; }
        if (biome === BIOME.VOLCANIC) { if (g === B.ASH && r < 0.01) data[above] = B.DEAD_BUSH; continue; }
        if (g === B.GLOWMOSS) {
          if (r < 0.1) data[above] = B.GLOW_FERN;
          else if (r < 0.15) data[above] = B.GLOW_MUSHROOM;
          else if (r < 0.32) data[above] = B.SHORT_GRASS;
          continue;
        }
        const nearWater = this.nearWater(data, alloc, x, y, z);
        if ((g === B.GRASS || g === B.MUD || g === B.DIRT) && nearWater && (biome === BIOME.SWAMP || biome === BIOME.RIVER || biome === BIOME.JUNGLE) && r < 0.35) {
          if (y + 2 < alloc && data[idx(x, y + 2, z)] === B.AIR) { data[above] = B.CATTAIL; continue; }
        }
        if (g === B.PODZOL) { if (r < 0.22) data[above] = biome === BIOME.AUTUMN ? B.LEAF_LITTER : B.FERN; else if (r < 0.26) data[above] = B.RED_MUSHROOM; continue; }
        if (g === B.MUD) { if (r < 0.12) data[above] = B.SHORT_GRASS; else if (r < 0.14) data[above] = B.RED_MUSHROOM; continue; }
        if (g !== B.GRASS && g !== B.MOSS) continue;
        const patch = this.nF.noise2(wxp / 38, wzp / 38);
        const kind = this.nX.noise2(wxp / 70 + 40, wzp / 70);
        const flowerOf = (k) => (k < -0.4 ? B.POPPY : k < -0.1 ? B.DANDELION : k < 0.15 ? B.CORNFLOWER : k < 0.4 ? B.DAISY : B.ALLIUM);
        let p = B.AIR;
        const grass = () => (hash2(wxp, wzp, seed + 22) < 0.3 ? B.TALL_GRASS : B.SHORT_GRASS);
        const tallOK = y + 2 < alloc && data[idx(x, y + 2, z)] === B.AIR;
        switch (biome) {
          case BIOME.PLAINS:
            if (patch > 0.42 && r < 0.3) p = flowerOf(kind);
            else if (patch < -0.55 && r < 0.12 && tallOK) p = B.SUNFLOWER;
            else if (r < 0.5) p = grass();
            else if (r < 0.515) p = flowerOf(hash2(wxp, wzp, 7) * 2 - 1);
            break;
          case BIOME.MEADOW:
            if (patch > 0.1 && r < 0.42) p = flowerOf(kind + (hash2(wxp, wzp, 3) - 0.5) * 0.3);
            else if (patch < -0.4 && r < 0.2 && tallOK) p = B.SUNFLOWER;
            else if (r < 0.6) p = grass();
            break;
          case BIOME.LAVENDER: {
            // planted rows, as in Provence
            const row = Math.abs(Math.sin((wxp * 0.8 + wzp * 0.25) * 0.9));
            if (row > 0.35 && r < 0.85) p = B.LAVENDER;
            else if (r < 0.4) p = grass();
            break;
          }
          case BIOME.FOREST:
            if (r < 0.28) p = grass(); else if (r < 0.33) p = B.FERN; else if (r < 0.345) p = flowerOf(kind); else if (r < 0.352) p = B.RED_MUSHROOM;
            break;
          case BIOME.BIRCH:
            if (r < 0.34) p = grass(); else if (r < 0.39) p = patch > 0 ? B.DAISY : B.ALLIUM;
            break;
          case BIOME.AUTUMN:
            if (r < 0.34) p = B.LEAF_LITTER; else if (r < 0.52) p = grass(); else if (r < 0.57) p = B.FERN; else if (r < 0.59) p = B.RED_MUSHROOM;
            break;
          case BIOME.JUNGLE:
            if (r < 0.26) p = B.FERN; else if (r < 0.6) p = grass(); else if (r < 0.62) p = B.POPPY;
            break;
          case BIOME.SAVANNA:
            if (r < 0.5) p = grass(); else if (r < 0.505) p = B.DEAD_BUSH;
            break;
          case BIOME.SWAMP:
            if (r < 0.3) p = grass(); else if (r < 0.36) p = B.FERN; else if (r < 0.38) p = B.RED_MUSHROOM;
            break;
          case BIOME.CHERRY:
            if (r < 0.34) p = B.PINK_PETALS; else if (r < 0.58) p = grass(); else if (r < 0.61) p = B.ALLIUM;
            break;
          case BIOME.TAIGA:
            if (r < 0.2) p = B.FERN; else if (r < 0.36) p = grass();
            break;
          case BIOME.RIVER: case BIOME.BEACH: case BIOME.TROPICAL:
            if (r < 0.3) p = grass();
            break;
          default:
            if (r < 0.22) p = grass();
        }
        if (p) data[above] = p;
      }
    }

    // --- metadata
    const heights = new Uint8Array(CS * CS);
    for (let z = 0; z < CS; z++) {
      for (let x = 0; x < CS; x++) {
        let y = alloc - 1;
        while (y > 0 && data[idx(x, y, z)] === B.AIR) y--;
        heights[z * CS + x] = Math.min(255, y);
      }
    }
    return { cx, cz, alloc, data, tintG, tintF, tintW, heights, biomes, temps };
  }

  nearWater(data, alloc, x, y, z) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= CS || nz >= CS) continue;
      if (data[(y << 10) | (nz << 5) | nx] === B.WATER) return true;
    }
    return false;
  }

  // Sea-floor life: seagrass everywhere shallow, kelp forests in cool water, corals and fans on warm reefs.
  coverUnderwater(data, alloc, x, y, z, g, biome, temp, r, wx, wz) {
    const at = (yy) => (yy << 10) | (z << 5) | x;
    let depth = 0;
    while (y + 1 + depth < alloc && data[at(y + 1 + depth)] === B.WATER) depth++;
    if (!(g === B.SAND || g === B.GRAVEL || g === B.CLAY || g === B.DIRT || g === B.MUD)) return;
    if (biome === BIOME.REEF) {
      if (depth >= 2 && r < 0.14) data[at(y + 1)] = B.CORAL_FAN;
      else if (depth >= 2 && r < 0.42) data[at(y + 1)] = B.SEAGRASS;
      return;
    }
    if (depth >= 6 && temp > -0.3 && temp < 0.3 && biome === BIOME.OCEAN && this.nF.noise2(wx / 40, wz / 40) > 0.1 && r < 0.3) {
      const len = Math.min(depth - 2, 4 + Math.floor(hash2(wx, wz, this.seed + 71) * (depth - 4)));
      for (let k = 1; k <= len; k++) data[at(y + k)] = B.KELP;
      return;
    }
    if (depth >= 2 && r < 0.22) data[at(y + 1)] = B.SEAGRASS;
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
          const surfaceBias = y > h - 5 ? 0.35 : 0;
          if (v < 1 - surfaceBias) {
            const k = (y << 10) | (z << 5) | x;
            const cur = data[k];
            if (cur === B.WATER || cur === B.OBSIDIAN || cur === B.ICE || cur === B.LAVA) continue;
            // do not open caves directly under water
            const above = y + 1 < alloc ? data[((y + 1) << 10) | (z << 5) | x] : 0;
            if (above === B.WATER || above === B.LAVA) continue;
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
          else if (y + 1 < alloc && data[k + 1024] !== B.AIR && RENDER[data[k + 1024]] === R.CUBE && r > 0.985 && y > 24) {
            // roots and vines trailing from cave ceilings
            for (let j = 0; j < 3 && data[k - j * 1024] === B.AIR; j++) data[k - j * 1024] = B.VINES;
          }
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
    const host = (b) => b === B.STONE || b === B.DEEPSLATE || b === B.BASALT;
    for (const [ore, count, y0, y1, size] of ores) {
      for (let n = 0; n < count; n++) {
        let x = Math.floor(rng() * CS), z = Math.floor(rng() * CS), y = y0 + Math.floor(rng() * (y1 - y0));
        const len = 1 + Math.floor(rng() * size);
        for (let s = 0; s < len; s++) {
          if (x >= 0 && z >= 0 && x < CS && z < CS && y > 0 && y < alloc) {
            const k = (y << 10) | (z << 5) | x;
            if (host(data[k])) data[k] = ore;
          }
          const d = Math.floor(rng() * 6);
          if (d === 0) x++; else if (d === 1) x--; else if (d === 2) z++; else if (d === 3) z--; else if (d === 4) y++; else y--;
        }
      }
    }
    // occasional geode pocket
    if (rng() < 0.18) {
      const gx = 6 + Math.floor(rng() * 20), gz = 6 + Math.floor(rng() * 20), gy = 16 + Math.floor(rng() * 24);
      const R0 = 3.5 + rng() * 1.5;
      for (let y = gy - 6; y <= gy + 6; y++) for (let z = gz - 6; z <= gz + 6; z++) for (let x = gx - 6; x <= gx + 6; x++) {
        if (x < 0 || z < 0 || x >= CS || z >= CS || y <= 1 || y >= alloc) continue;
        const d = Math.hypot(x - gx, (y - gy) * 1.15, z - gz);
        const k = (y << 10) | (z << 5) | x;
        if (data[k] === B.AIR || data[k] === B.WATER) continue;
        if (d < R0 - 1.2) data[k] = B.AIR;
        else if (d < R0) data[k] = B.AMETHYST;
        else if (d < R0 + 1) data[k] = B.MARBLE;
      }
    }
  }

  placeFeature(f, set, get) {
    const rng = mulberry32((f.x * 734287) ^ (f.z * 912271) ^ (this.seed * 31));
    const { x, y, z } = f;
    // must stand on a suitable block
    const g = get(x, y - 1, z);
    if (g !== -1) {
      const soil = g === B.GRASS || g === B.SNOWY_GRASS || g === B.DIRT || g === B.SNOW || g === B.STONE || g === B.GRAVEL ||
        g === B.PODZOL || g === B.MOSS || g === B.MUD || g === B.GLOWMOSS;
      let ok;
      switch (f.type) {
        case 'cactus': ok = g === B.SAND || g === B.RED_SAND; break;
        case 'palm': ok = g === B.SAND || g === B.GRASS; break;
        case 'hoodoo': ok = g !== B.AIR && g !== B.WATER; break;
        case 'coral': case 'kelp': ok = g === B.SAND || g === B.GRAVEL || g === B.CLAY; break;
        case 'basalt': case 'deadtree': case 'vent': ok = g === B.BASALT || g === B.ASH || g === B.OBSIDIAN || g === B.MAGMA; break;
        case 'icespike': ok = g === B.SNOW || g === B.SNOWY_GRASS; break;
        default: ok = soil;
      }
      if (!ok) return;
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
    // strands hanging below the underside of a canopy
    const hangBelow = (cx, cy, cz, r, block, chance, maxLen) => {
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (hash3(cx + dx, cy, cz + dz, this.seed + 17) > chance) continue;
        let yy = cy - 4;
        while (yy < cy + 3 && !isLeaves(get(cx + dx, yy, cz + dz))) yy++;
        if (!isLeaves(get(cx + dx, yy, cz + dz))) continue;
        const len = 1 + Math.floor(hash3(cx + dx, yy, cz + dz, this.seed + 19) * maxLen);
        for (let k = 1; k <= len; k++) {
          if (get(cx + dx, yy - k, cz + dz) !== B.AIR) break;
          set(cx + dx, yy - k, cz + dz, block);
        }
      }
    };
    switch (f.type) {
      case 'oak': {
        const h = 4 + Math.floor(rng() * 3);
        trunk(h, B.OAK_LOG);
        blob(x, y + h - 1, z, 2.6, 2.2, 2.6, B.OAK_LEAVES);
        blob(x, y + h + 1, z, 1.6, 1.2, 1.6, B.OAK_LEAVES, 0.1);
        if (f.biome === BIOME.SWAMP) hangBelow(x, y + h - 2, z, 3, B.VINES, 0.35, 3);
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
      case 'maple': case 'bigmaple': {
        const big = f.type === 'bigmaple';
        const col = [B.MAPLE_RED, B.MAPLE_ORANGE, B.MAPLE_YELLOW][Math.floor(rng() * 3)];
        const col2 = rng() < 0.4 ? [B.MAPLE_RED, B.MAPLE_ORANGE, B.MAPLE_YELLOW][Math.floor(rng() * 3)] : col;
        const h = (big ? 7 : 5) + Math.floor(rng() * 3);
        trunk(h, B.OAK_LOG);
        const R0 = big ? 4.2 : 3.0;
        blob(x, y + h, z, R0, R0 * 0.8, R0, col, 0.3);
        blob(x + Math.round((rng() - 0.5) * 3), y + h + 1, z + Math.round((rng() - 0.5) * 3), R0 * 0.7, R0 * 0.6, R0 * 0.7, col2, 0.3);
        if (big) for (let b = 0; b < 3; b++) {
          const a = rng() * Math.PI * 2;
          const bx = x + Math.round(Math.cos(a) * 3), bz = z + Math.round(Math.sin(a) * 3), by = y + h - 3 + b;
          set(x + Math.round(Math.cos(a) * 1.5), by - 1, z + Math.round(Math.sin(a) * 1.5), B.OAK_WOOD, true);
          blob(bx, by, bz, 2.4, 1.8, 2.4, b === 1 ? col2 : col, 0.35);
        }
        // a carpet of fallen leaves under the crown
        for (let k = 0; k < 26; k++) {
          const a = rng() * Math.PI * 2, rr = rng() * (R0 + 1.5);
          const lx = x + Math.round(Math.cos(a) * rr), lz = z + Math.round(Math.sin(a) * rr);
          for (let yy = y + 2; yy >= y - 3; yy--) {
            const gb = get(lx, yy - 1, lz);
            if (gb === -1) break;
            if (gb === B.GRASS || gb === B.PODZOL) { if (get(lx, yy, lz) === B.AIR) set(lx, yy, lz, B.LEAF_LITTER); break; }
            if (gb !== B.AIR && RENDER[gb] !== R.CROSS) break;
          }
        }
        break;
      }
      case 'birch': {
        const h = 5 + Math.floor(rng() * 3);
        trunk(h, B.BIRCH_LOG);
        const leaf = f.biome === BIOME.AUTUMN ? B.MAPLE_YELLOW : B.BIRCH_LEAVES;
        blob(x, y + h - 1, z, 2.2, 2.6, 2.2, leaf);
        set(x, y + h + 1, z, leaf);
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
          const R0 = Math.min(r, 3.3);
          const Ri = Math.ceil(R0);
          for (let dz = -Ri; dz <= Ri; dz++) for (let dx = -Ri; dx <= Ri; dx++) {
            if (dx * dx + dz * dz <= R0 * R0 + 0.3 && !(dx === 0 && dz === 0 && yy < y + h)) set(x + dx, yy, z + dz, B.SPRUCE_LEAVES);
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
      case 'giantjungle': {
        // 2x2 trunk, buttress roots, layered canopy and curtains of vines
        const h = 18 + Math.floor(rng() * 9);
        for (let i = -1; i < h; i++) for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) set(x + dx, y + i, z + dz, B.JUNGLE_LOG, true);
        for (const [dx, dz] of [[-1, 0], [2, 1], [0, 2], [1, -1]]) {
          const rh = 1 + Math.floor(rng() * 3);
          for (let i = -1; i < rh; i++) set(x + dx, y + i, z + dz, B.JUNGLE_LOG, true);
        }
        for (let b = 0; b < 4; b++) {
          const a = rng() * Math.PI * 2;
          const by = y + h - 8 + Math.floor(rng() * 6);
          const len = 3 + Math.floor(rng() * 3);
          let bx = x, bz = z, yy = by;
          for (let i = 1; i <= len; i++) {
            bx = x + Math.round(Math.cos(a) * i); bz = z + Math.round(Math.sin(a) * i); yy = by + Math.floor(i * 0.5);
            set(bx, yy, bz, B.JUNGLE_LOG, true);
          }
          blob(bx, yy + 1, bz, 3.4, 1.6, 3.4, B.JUNGLE_LEAVES, 0.3);
          hangBelow(bx, yy, bz, 3, B.VINES, 0.3, 7);
        }
        blob(x, y + h, z, 5.5, 2.4, 5.5, B.JUNGLE_LEAVES, 0.3);
        blob(x, y + h + 2, z, 3.5, 1.6, 3.5, B.JUNGLE_LEAVES, 0.2);
        hangBelow(x, y + h - 1, z, 5, B.VINES, 0.3, 9);
        // vines creeping up the trunk
        for (let i = 2; i < h - 3; i++) for (const [dx, dz] of [[-1, 0], [2, 0], [0, -1], [0, 2]]) {
          if (hash3(x + dx, y + i, z + dz, this.seed + 23) < 0.35) set(x + dx, y + i, z + dz, B.VINES);
        }
        break;
      }
      case 'jungle': {
        const h = 6 + Math.floor(rng() * 5);
        trunk(h, B.JUNGLE_LOG);
        blob(x, y + h, z, 2.8, 1.8, 2.8, B.JUNGLE_LEAVES, 0.25);
        blob(x, y + h + 1, z, 1.6, 1.0, 1.6, B.JUNGLE_LEAVES, 0.1);
        hangBelow(x, y + h - 1, z, 3, B.VINES, 0.35, 5);
        break;
      }
      case 'jbush': {
        set(x, y, z, B.JUNGLE_LOG, true);
        blob(x, y, z, 2.1, 1.3, 2.1, B.JUNGLE_LEAVES, 0.3);
        break;
      }
      case 'acacia': {
        // leaning trunk that forks into flat umbrella crowns
        const h = 4 + Math.floor(rng() * 2);
        const a = rng() * Math.PI * 2;
        const dx = Math.cos(a), dz = Math.sin(a);
        let tx = x, tz = z, yy = y;
        for (let i = 0; i < h + 2; i++) {
          if (i >= 2) { tx = x + Math.round(dx * (i - 1) * 0.8); tz = z + Math.round(dz * (i - 1) * 0.8); }
          yy = y + i;
          set(tx, yy, tz, B.ACACIA_LOG, true);
        }
        const crown = (cx2, cy2, cz2, r) => {
          for (let ddz = -Math.ceil(r); ddz <= Math.ceil(r); ddz++) for (let ddx = -Math.ceil(r); ddx <= Math.ceil(r); ddx++) {
            const d = Math.hypot(ddx, ddz);
            if (d < r - hash3(cx2 + ddx, cy2, cz2 + ddz, this.seed + 5) * 0.6) set(cx2 + ddx, cy2, cz2 + ddz, B.ACACIA_LEAVES);
            if (d < r - 1.6) set(cx2 + ddx, cy2 + 1, cz2 + ddz, B.ACACIA_LEAVES);
          }
        };
        crown(tx, yy + 1, tz, 3.4);
        if (rng() < 0.7) {
          const b = a + Math.PI * (0.6 + rng() * 0.8);
          let bx = x, bz = z, by = y + 2;
          for (let i = 1; i <= 3; i++) { bx = x + Math.round(Math.cos(b) * i); bz = z + Math.round(Math.sin(b) * i); by = y + 2 + i; set(bx, by, bz, B.ACACIA_LOG, true); }
          crown(bx, by + 1, bz, 2.6);
        }
        break;
      }
      case 'willow': {
        const h = 5 + Math.floor(rng() * 3);
        trunk(h, B.OAK_LOG);
        blob(x, y + h, z, 3.4, 2.0, 3.4, B.WILLOW_LEAVES, 0.3);
        // drooping curtains of leaves at the crown's rim, then long moss
        for (let k = 0; k < 40; k++) {
          const a = rng() * Math.PI * 2, rr = 2.2 + rng() * 1.6;
          const lx = x + Math.round(Math.cos(a) * rr), lz = z + Math.round(Math.sin(a) * rr);
          const len = 2 + Math.floor(rng() * 4);
          let yy = y + h;
          for (let j = 0; j < len; j++, yy--) { if (get(lx, yy, lz) === B.AIR || get(lx, yy, lz) === B.WILLOW_LEAVES) set(lx, yy, lz, B.WILLOW_LEAVES); }
          if (rng() < 0.7) for (let j = 0; j < 2 + Math.floor(rng() * 3); j++, yy--) { if (get(lx, yy, lz) !== B.AIR) break; set(lx, yy, lz, B.HANGING_MOSS); }
        }
        break;
      }
      case 'palm': {
        // curved trunk leaning seaward, fronds radiating from the top
        const h = 6 + Math.floor(rng() * 4);
        const a = rng() * Math.PI * 2;
        let tx = x, tz = z, yy = y;
        for (let i = 0; i < h; i++) {
          const bend = Math.pow(i / h, 2) * 3;
          tx = x + Math.round(Math.cos(a) * bend); tz = z + Math.round(Math.sin(a) * bend); yy = y + i;
          set(tx, yy, tz, B.PALM_LOG, true);
        }
        set(tx, yy + 1, tz, B.PALM_LEAVES);
        for (let k = 0; k < 7; k++) {
          const fa = k / 7 * Math.PI * 2 + rng() * 0.4;
          for (let i = 1; i <= 4; i++) {
            const fx = tx + Math.round(Math.cos(fa) * i), fz = tz + Math.round(Math.sin(fa) * i);
            const fy = yy + 1 - (i >= 3 ? i - 2 : 0);
            set(fx, fy, fz, B.PALM_LEAVES);
          }
        }
        break;
      }
      case 'gshroom': case 'smallshroom': {
        // giant bioluminescent mushroom: pale stem, glowing domed cap with a lip
        const small = f.type === 'smallshroom';
        const h = small ? 3 + Math.floor(rng() * 3) : 8 + Math.floor(rng() * 8);
        const lean = small ? 0 : (rng() - 0.5) * 0.25;
        const a = rng() * Math.PI * 2;
        let sx = x, sz = z;
        for (let i = 0; i < h; i++) {
          sx = x + Math.round(Math.cos(a) * lean * i); sz = z + Math.round(Math.sin(a) * lean * i);
          set(sx, y + i, sz, B.MUSHROOM_STEM, true);
          if (!small && i < 2) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) set(sx + dx, y + i, sz + dz, B.MUSHROOM_STEM, true);
        }
        const R0 = small ? 2.2 : 3.6 + rng() * 2.4;
        const top = y + h;
        const Ri = Math.ceil(R0);
        for (let dy = -1; dy <= Math.ceil(R0 * 0.6); dy++) for (let dz = -Ri; dz <= Ri; dz++) for (let dx = -Ri; dx <= Ri; dx++) {
          const d = Math.hypot(dx, dz);
          const dome = R0 * Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(dy, 0) / (R0 * 0.6 + 0.01), 2)));
          if (dy === -1 ? (d > R0 - 1.1 && d < R0) : d < dome) set(sx + dx, top + dy, sz + dz, B.GLOW_CAP);
        }
        break;
      }
      case 'deadtree': {
        const h = 4 + Math.floor(rng() * 4);
        trunk(h, B.SPRUCE_LOG);
        for (let b = 0; b < 2; b++) {
          const a = rng() * Math.PI * 2, by = y + 2 + Math.floor(rng() * (h - 2));
          for (let i = 1; i <= 2; i++) set(x + Math.round(Math.cos(a) * i), by + i - 1, z + Math.round(Math.sin(a) * i), B.SPRUCE_WOOD, true);
        }
        break;
      }
      case 'basalt': {
        // clustered hexagonal columns
        for (let k = 0; k < 7; k++) {
          const cx2 = x + Math.round((rng() - 0.5) * 5), cz2 = z + Math.round((rng() - 0.5) * 5);
          const hh = 2 + Math.floor(rng() * 7);
          for (let i = -1; i < hh; i++) set(cx2, y + i, cz2, B.BASALT, true);
        }
        break;
      }
      case 'vent': {
        // glowing magma vent with an obsidian rim
        for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
          const d = Math.hypot(dx, dz);
          if (d < 1.2) { set(x + dx, y - 1, z + dz, B.MAGMA, true); set(x + dx, y - 2, z + dz, B.LAVA, true); }
          else if (d < 2.4) set(x + dx, y - 1, z + dz, rng() < 0.5 ? B.OBSIDIAN : B.MAGMA, true);
        }
        break;
      }
      case 'hoodoo': {
        // eroded terracotta spire
        const h = 5 + Math.floor(rng() * 9);
        const sOff = Math.floor(rng() * 48);
        for (let i = 0; i < h; i++) {
          const rr = i < 2 ? 1.6 : i > h - 3 ? 1.4 : 0.9 + 0.3 * Math.sin(i * 1.3);
          const Ri = Math.ceil(rr);
          for (let dz = -Ri; dz <= Ri; dz++) for (let dx = -Ri; dx <= Ri; dx++) {
            if (dx * dx + dz * dz <= rr * rr + 0.2) set(x + dx, y + i, z + dz, this.strata[(y + i + sOff) % 48], true);
          }
        }
        break;
      }
      case 'coral': {
        const blocks = [B.CORAL_PINK, B.CORAL_ORANGE, B.CORAL_BLUE];
        const main = blocks[Math.floor(rng() * 3)];
        const n = 3 + Math.floor(rng() * 4);
        for (let k = 0; k < n; k++) {
          const cx2 = x + Math.round((rng() - 0.5) * 4), cz2 = z + Math.round((rng() - 0.5) * 4);
          const hh = 1 + Math.floor(rng() * 3);
          const b = rng() < 0.6 ? main : blocks[Math.floor(rng() * 3)];
          for (let i = 0; i < hh; i++) {
            if (y + i >= SEA - 1) break;
            set(cx2, y + i, cz2, b, 2);
            if (rng() < 0.3) set(cx2 + (rng() < 0.5 ? 1 : -1), y + i, cz2, b, 2);
          }
          if (y + hh < SEA - 1 && rng() < 0.5) set(cx2, y + hh, cz2, B.CORAL_FAN, 2);
        }
        break;
      }
      case 'kelp': {
        for (let k = 0; k < 4; k++) {
          const cx2 = x + Math.round((rng() - 0.5) * 4), cz2 = z + Math.round((rng() - 0.5) * 4);
          if (get(cx2, y - 1, cz2) !== B.SAND && get(cx2, y - 1, cz2) !== B.GRAVEL) continue;
          const len = 2 + Math.floor(rng() * 6);
          for (let i = 0; i < len && y + i < SEA - 1; i++) set(cx2, y + i, cz2, B.KELP, 2);
        }
        break;
      }
      case 'icespike': {
        const h = 6 + Math.floor(rng() * (rng() < 0.2 ? 26 : 10));
        const R0 = 1.2 + h * 0.07;
        for (let i = -1; i < h; i++) {
          const rr = R0 * (1 - i / h) + 0.4;
          const Ri = Math.ceil(rr);
          for (let dz = -Ri; dz <= Ri; dz++) for (let dx = -Ri; dx <= Ri; dx++) {
            if (dx * dx + dz * dz <= rr * rr) set(x + dx, y + i, z + dz, (i + dx + dz) % 5 === 0 ? B.BLUE_ICE : B.PACKED_ICE, true);
          }
        }
        break;
      }
      case 'bush': {
        set(x, y, z, B.OAK_LOG, true);
        blob(x, y, z, 1.7, 1.2, 1.7, f.biome === BIOME.TAIGA ? B.SPRUCE_LEAVES : f.biome === BIOME.SAVANNA ? B.ACACIA_LEAVES : B.OAK_LEAVES, 0.35);
        break;
      }
      case 'boulder': {
        const r = 1.3 + rng() * 1.2;
        const X = Math.ceil(r);
        const lumen = f.biome === BIOME.LUMEN;
        for (let dy = -1; dy <= X; dy++) for (let dz = -X; dz <= X; dz++) for (let dx = -X; dx <= X; dx++) {
          const d = Math.hypot(dx, dy * 1.2, dz);
          if (d < r - hash3(x + dx, y + dy, z + dz, 5) * 0.5) {
            const top = dy >= Math.floor(r * 0.5);
            const b = lumen ? (rng() < 0.12 ? B.AMETHYST : B.DEEPSLATE) : top && rng() < 0.7 ? B.MOSSY_COBBLE : rng() < 0.5 ? B.COBBLE : B.STONE;
            set(x + dx, y + dy - 1, z + dz, b, true);
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
