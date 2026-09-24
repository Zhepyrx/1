// Wildlife: data-driven cuboid creatures with articulated parts, biome-aware spawning, simple
// behaviours (graze, wander, flee, flock, flutter, swim) and instanced rendering data.
import { B, SOLID, RENDER, R, WATERLOGGED, isLeaves } from './blocks.js';
import { SEA } from './worldgen.js';

// ---- small affine helpers: { r: 3x3 row-major, t: [x, y, z] }
function rot(rx, ry, rz) {
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  // Ry * Rx * Rz
  return [
    cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx,
    cx * sz, cx * cz, -sx,
    -sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx,
  ];
}
function mul(a, b) {
  const A = a.r, Bm = b.r;
  const r = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = A[i * 3] * Bm[j] + A[i * 3 + 1] * Bm[3 + j] + A[i * 3 + 2] * Bm[6 + j];
  const t = [0, 1, 2].map((i) => A[i * 3] * b.t[0] + A[i * 3 + 1] * b.t[1] + A[i * 3 + 2] * b.t[2] + a.t[i]);
  return { r, t };
}
const lin = (c) => c.map((v) => Math.pow(v, 2.2));

// Patterns (shader): 0 fur, 1 countershade (pale belly), 2 spots, 3 head (eyes, nose), 4 feathers,
// 5 glowing, 6 scales, 7 butterfly wing, 8 horn/bone, 9 wool, 10 stripes
const P = (name, parent, pivot, box, color, opt = {}) => ({ name, parent, pivot, box, color, ...opt });

// leg hanging from the body: joint at body-relative height yTop, `len` long
const leg = (name, x, z, yTop, len, w, col) => P(name, 'body', [x, yTop, z], [-w, -len, -w, w, 0.01, w], col, { anim: name.includes('F') ? 'legF' : 'legB', side: x > 0 ? 1 : -1, pat: 0 });

export const SPECIES = {
  deer: {
    name: 'Red Deer', habitat: 'ground', biomes: [2, 3, 4, 12, 13, 22, 6], group: [2, 5], speed: 1.4, run: 7.5, shy: 16, scale: 1,
    active: 'day', height: 1.45,
    parts: [
      P('body', null, [0, 0.95, 0], [-0.2, -0.22, -0.52, 0.2, 0.2, 0.5], [0.5, 0.33, 0.2], { pat: 1, c2: [0.86, 0.8, 0.7] }),
      P('neck', 'body', [0, 0.12, 0.42], [-0.085, -0.06, -0.08, 0.085, 0.46, 0.12], [0.48, 0.32, 0.2], { rx: 0.5, anim: 'neck', pat: 1, c2: [0.8, 0.74, 0.66] }),
      P('head', 'neck', [0, 0.44, 0.02], [-0.095, -0.07, -0.08, 0.095, 0.12, 0.3], [0.5, 0.35, 0.22], { rx: -0.35, pat: 3, c2: [0.08, 0.06, 0.05], anim: 'head' }),
      P('earL', 'head', [0.08, 0.1, 0.0], [-0.02, 0, -0.03, 0.02, 0.16, 0.05], [0.45, 0.3, 0.2], { rz: -0.6 }),
      P('earR', 'head', [-0.08, 0.1, 0.0], [-0.02, 0, -0.03, 0.02, 0.16, 0.05], [0.45, 0.3, 0.2], { rz: 0.6 }),
      P('antL', 'head', [0.05, 0.11, 0.02], [-0.015, 0, -0.015, 0.015, 0.34, 0.015], [0.62, 0.55, 0.45], { rz: -0.45, rx: -0.2, pat: 8, stag: true }),
      P('antL2', 'antL', [0, 0.2, 0], [-0.012, 0, -0.012, 0.012, 0.16, 0.012], [0.62, 0.55, 0.45], { rx: 0.9, pat: 8, stag: true }),
      P('antR', 'head', [-0.05, 0.11, 0.02], [-0.015, 0, -0.015, 0.015, 0.34, 0.015], [0.62, 0.55, 0.45], { rz: 0.45, rx: -0.2, pat: 8, stag: true }),
      P('antR2', 'antR', [0, 0.2, 0], [-0.012, 0, -0.012, 0.012, 0.16, 0.012], [0.62, 0.55, 0.45], { rx: 0.9, pat: 8, stag: true }),
      P('tail', 'body', [0, 0.12, -0.5], [-0.05, -0.14, -0.05, 0.05, 0.0, 0.03], [0.9, 0.88, 0.84], { rx: 0.3 }),
      leg('legFL', 0.12, 0.38, -0.17, 0.78, 0.045, [0.38, 0.26, 0.17]),
      leg('legFR', -0.12, 0.38, -0.17, 0.78, 0.045, [0.38, 0.26, 0.17]),
      leg('legBL', 0.12, -0.38, -0.17, 0.78, 0.05, [0.38, 0.26, 0.17]),
      leg('legBR', -0.12, -0.38, -0.17, 0.78, 0.05, [0.38, 0.26, 0.17]),
    ],
  },
  rabbit: {
    name: 'Rabbit', habitat: 'ground', hop: true, biomes: [2, 12, 22, 7, 8, 5, 4, 23, 15], group: [1, 3], speed: 1.0, run: 6.5, shy: 7, scale: 1,
    active: 'any', height: 0.4,
    variants: { 7: [0.93, 0.93, 0.92], 23: [0.93, 0.93, 0.92], 8: [0.74, 0.62, 0.44], 15: [0.66, 0.54, 0.38] },
    parts: [
      P('body', null, [0, 0.16, 0], [-0.1, -0.09, -0.15, 0.1, 0.1, 0.13], [0.52, 0.42, 0.32], { pat: 1, c2: [0.88, 0.85, 0.8] }),
      P('head', 'body', [0, 0.08, 0.12], [-0.075, -0.06, -0.02, 0.075, 0.09, 0.13], [0.52, 0.42, 0.32], { pat: 3, c2: [0.3, 0.2, 0.2], anim: 'head' }),
      P('earL', 'head', [0.035, 0.08, 0.02], [-0.02, 0, -0.012, 0.02, 0.15, 0.012], [0.5, 0.4, 0.3], { rz: -0.15, rx: -0.2 }),
      P('earR', 'head', [-0.035, 0.08, 0.02], [-0.02, 0, -0.012, 0.02, 0.15, 0.012], [0.5, 0.4, 0.3], { rz: 0.15, rx: -0.2 }),
      P('tail', 'body', [0, 0.04, -0.15], [-0.04, -0.04, -0.05, 0.04, 0.04, 0.0], [0.95, 0.94, 0.92]),
      P('legFL', 'body', [0.05, -0.06, 0.1], [-0.02, -0.1, -0.02, 0.02, 0.0, 0.02], [0.5, 0.4, 0.3], { anim: 'legF', side: 1 }),
      P('legFR', 'body', [-0.05, -0.06, 0.1], [-0.02, -0.1, -0.02, 0.02, 0.0, 0.02], [0.5, 0.4, 0.3], { anim: 'legF', side: -1 }),
      P('legBL', 'body', [0.07, -0.04, -0.08], [-0.03, -0.1, -0.02, 0.03, 0.02, 0.1], [0.5, 0.4, 0.3], { anim: 'legB', side: 1 }),
      P('legBR', 'body', [-0.07, -0.04, -0.08], [-0.03, -0.1, -0.02, 0.03, 0.02, 0.1], [0.5, 0.4, 0.3], { anim: 'legB', side: -1 }),
    ],
  },
  fox: {
    name: 'Red Fox', habitat: 'ground', biomes: [6, 7, 13, 3, 4], group: [1, 2], speed: 1.6, run: 7, shy: 12, scale: 1,
    active: 'any', height: 0.55,
    variants: { 7: [0.9, 0.9, 0.9] },
    parts: [
      P('body', null, [0, 0.36, 0], [-0.1, -0.1, -0.3, 0.1, 0.1, 0.28], [0.78, 0.38, 0.12], { pat: 1, c2: [0.92, 0.9, 0.86] }),
      P('head', 'body', [0, 0.1, 0.28], [-0.1, -0.08, -0.04, 0.1, 0.09, 0.16], [0.8, 0.4, 0.13], { pat: 3, c2: [0.07, 0.05, 0.05], anim: 'head' }),
      P('snout', 'head', [0, -0.03, 0.16], [-0.04, -0.035, 0, 0.04, 0.035, 0.1], [0.92, 0.9, 0.86]),
      P('earL', 'head', [0.06, 0.08, 0.02], [-0.03, 0, -0.01, 0.03, 0.09, 0.02], [0.2, 0.12, 0.08], { rz: -0.2 }),
      P('earR', 'head', [-0.06, 0.08, 0.02], [-0.03, 0, -0.01, 0.03, 0.09, 0.02], [0.2, 0.12, 0.08], { rz: 0.2 }),
      P('tail', 'body', [0, 0.04, -0.3], [-0.07, -0.07, -0.34, 0.07, 0.07, 0.0], [0.8, 0.4, 0.13], { rx: 0.5, anim: 'tail', pat: 0 }),
      P('tip', 'tail', [0, 0, -0.34], [-0.05, -0.05, -0.1, 0.05, 0.05, 0.0], [0.94, 0.92, 0.88]),
      leg('legFL', 0.06, 0.2, -0.08, 0.28, 0.03, [0.1, 0.07, 0.06]),
      leg('legFR', -0.06, 0.2, -0.08, 0.28, 0.03, [0.1, 0.07, 0.06]),
      leg('legBL', 0.06, -0.22, -0.08, 0.28, 0.035, [0.14, 0.09, 0.07]),
      leg('legBR', -0.06, -0.22, -0.08, 0.28, 0.035, [0.14, 0.09, 0.07]),
    ],
  },
  sheep: {
    name: 'Mountain Sheep', habitat: 'ground', biomes: [2, 12, 9, 22, 15], group: [2, 5], speed: 1.0, run: 5, shy: 6, scale: 1,
    active: 'any', height: 1.0,
    parts: [
      P('body', null, [0, 0.72, 0], [-0.27, -0.24, -0.46, 0.27, 0.26, 0.44], [0.88, 0.86, 0.8], { pat: 9 }),
      P('head', 'body', [0, 0.12, 0.44], [-0.11, -0.14, -0.04, 0.11, 0.12, 0.24], [0.16, 0.14, 0.12], { pat: 3, c2: [0.05, 0.04, 0.04], anim: 'graze' }),
      P('earL', 'head', [0.11, 0.04, 0.06], [0, -0.02, -0.03, 0.1, 0.02, 0.03], [0.16, 0.14, 0.12], { rz: -0.4 }),
      P('earR', 'head', [-0.11, 0.04, 0.06], [-0.1, -0.02, -0.03, 0, 0.02, 0.03], [0.16, 0.14, 0.12], { rz: 0.4 }),
      leg('legFL', 0.15, 0.3, -0.2, 0.5, 0.05, [0.15, 0.13, 0.11]),
      leg('legFR', -0.15, 0.3, -0.2, 0.5, 0.05, [0.15, 0.13, 0.11]),
      leg('legBL', 0.15, -0.3, -0.2, 0.5, 0.05, [0.15, 0.13, 0.11]),
      leg('legBR', -0.15, -0.3, -0.2, 0.5, 0.05, [0.15, 0.13, 0.11]),
    ],
  },
  frog: {
    name: 'Tree Frog', habitat: 'ground', hop: true, biomes: [17, 14], group: [1, 3], speed: 0.6, run: 4, shy: 3, scale: 1,
    active: 'any', height: 0.2, nearWater: true,
    parts: [
      P('body', null, [0, 0.08, 0], [-0.07, -0.05, -0.08, 0.07, 0.05, 0.09], [0.28, 0.52, 0.12], { pat: 2, c2: [0.12, 0.25, 0.05] }),
      P('eyeL', 'body', [0.045, 0.05, 0.06], [-0.022, 0, -0.022, 0.022, 0.035, 0.022], [0.6, 0.55, 0.1], { pat: 3, c2: [0.02, 0.02, 0.02] }),
      P('eyeR', 'body', [-0.045, 0.05, 0.06], [-0.022, 0, -0.022, 0.022, 0.035, 0.022], [0.6, 0.55, 0.1], { pat: 3, c2: [0.02, 0.02, 0.02] }),
      P('legBL', 'body', [0.07, -0.03, -0.05], [0, -0.03, -0.02, 0.07, 0.01, 0.07], [0.3, 0.5, 0.14], { anim: 'legB', side: 1 }),
      P('legBR', 'body', [-0.07, -0.03, -0.05], [-0.07, -0.03, -0.02, 0, 0.01, 0.07], [0.3, 0.5, 0.14], { anim: 'legB', side: -1 }),
      P('legFL', 'body', [0.05, -0.03, 0.06], [0, -0.05, -0.015, 0.03, 0.0, 0.015], [0.3, 0.5, 0.14]),
      P('legFR', 'body', [-0.05, -0.03, 0.06], [-0.03, -0.05, -0.015, 0, 0.0, 0.015], [0.3, 0.5, 0.14]),
    ],
  },
  songbird: {
    name: 'Songbird', habitat: 'air', biomes: [2, 3, 4, 5, 12, 13, 14, 15, 22, 17, 6], group: [5, 11], speed: 9, scale: 1, active: 'day',
    variants: { 14: [0.1, 0.55, 0.85], 13: [0.72, 0.2, 0.12], 5: [0.45, 0.4, 0.38] },
    parts: [
      P('body', null, [0, 0, 0], [-0.05, -0.045, -0.09, 0.05, 0.05, 0.08], [0.45, 0.35, 0.25], { pat: 1, c2: [0.85, 0.78, 0.66] }),
      P('head', 'body', [0, 0.04, 0.08], [-0.04, -0.03, -0.02, 0.04, 0.05, 0.06], [0.42, 0.33, 0.24], { pat: 3, c2: [0.02, 0.02, 0.02] }),
      P('beak', 'head', [0, 0.0, 0.06], [-0.012, -0.01, 0, 0.012, 0.012, 0.035], [0.85, 0.6, 0.2]),
      P('wingL', 'body', [0.05, 0.03, 0.02], [0, -0.005, -0.06, 0.16, 0.005, 0.05], [0.35, 0.27, 0.2], { anim: 'wing', side: 1, pat: 4, c2: [0.15, 0.12, 0.1] }),
      P('wingR', 'body', [-0.05, 0.03, 0.02], [-0.16, -0.005, -0.06, 0, 0.005, 0.05], [0.35, 0.27, 0.2], { anim: 'wing', side: -1, pat: 4, c2: [0.15, 0.12, 0.1] }),
      P('tail', 'body', [0, 0.01, -0.09], [-0.035, -0.005, -0.09, 0.035, 0.005, 0], [0.3, 0.24, 0.18], { rx: -0.15 }),
    ],
  },
  gull: {
    name: 'Seagull', habitat: 'air', biomes: [0, 1, 20, 21, 11], group: [3, 6], speed: 8, scale: 1, active: 'day', soar: true,
    parts: [
      P('body', null, [0, 0, 0], [-0.08, -0.07, -0.2, 0.08, 0.07, 0.18], [0.94, 0.94, 0.92]),
      P('head', 'body', [0, 0.05, 0.18], [-0.055, -0.045, -0.02, 0.055, 0.06, 0.1], [0.96, 0.96, 0.95], { pat: 3, c2: [0.03, 0.03, 0.03] }),
      P('beak', 'head', [0, 0.0, 0.1], [-0.015, -0.015, 0, 0.015, 0.012, 0.07], [0.92, 0.75, 0.2]),
      P('wingL', 'body', [0.08, 0.03, 0.02], [0, -0.008, -0.1, 0.46, 0.008, 0.08], [0.62, 0.64, 0.66], { anim: 'wing', side: 1, pat: 4, c2: [0.06, 0.06, 0.06] }),
      P('wingR', 'body', [-0.08, 0.03, 0.02], [-0.46, -0.008, -0.1, 0, 0.008, 0.08], [0.62, 0.64, 0.66], { anim: 'wing', side: -1, pat: 4, c2: [0.06, 0.06, 0.06] }),
      P('tail', 'body', [0, 0.01, -0.2], [-0.07, -0.006, -0.12, 0.07, 0.006, 0], [0.95, 0.95, 0.94]),
    ],
  },
  butterfly: {
    name: 'Butterfly', habitat: 'flutter', biomes: [2, 5, 12, 22, 14, 13, 3, 4], group: [1, 3], speed: 1.8, scale: 1, active: 'day',
    palette: [[[0.95, 0.5, 0.08], [0.05, 0.03, 0.02]], [[0.2, 0.45, 1.0], [0.02, 0.05, 0.12]], [[0.98, 0.92, 0.35], [0.4, 0.35, 0.1]], [[0.97, 0.97, 0.95], [0.3, 0.3, 0.32]]],
    parts: [
      P('body', null, [0, 0, 0], [-0.008, -0.008, -0.04, 0.008, 0.008, 0.035], [0.08, 0.07, 0.06], { fixed: true }),
      P('wingL', 'body', [0.006, 0.0, 0.0], [0, -0.002, -0.05, 0.075, 0.002, 0.055], [0.95, 0.5, 0.08], { anim: 'flap', side: 1, pat: 7, c2: [0.05, 0.03, 0.02] }),
      P('wingR', 'body', [-0.006, 0.0, 0.0], [-0.075, -0.002, -0.05, 0, 0.002, 0.055], [0.95, 0.5, 0.08], { anim: 'flap', side: -1, pat: 7, c2: [0.05, 0.03, 0.02] }),
    ],
  },
  moth: {
    name: 'Lumen Moth', habitat: 'flutter', biomes: [18], group: [2, 5], speed: 1.2, scale: 1, active: 'night', glow: true,
    parts: [
      P('body', null, [0, 0, 0], [-0.012, -0.012, -0.05, 0.012, 0.012, 0.04], [0.3, 0.9, 1.0], { pat: 5 }),
      P('wingL', 'body', [0.01, 0.0, 0.0], [0, -0.002, -0.06, 0.09, 0.002, 0.05], [0.25, 0.85, 1.0], { anim: 'flap', side: 1, pat: 5 }),
      P('wingR', 'body', [-0.01, 0.0, 0.0], [-0.09, -0.002, -0.06, 0, 0.002, 0.05], [0.25, 0.85, 1.0], { anim: 'flap', side: -1, pat: 5 }),
    ],
  },
  fish: {
    name: 'Fish', habitat: 'water', biomes: [0, 11, 20, 17, 21, 1], group: [5, 12], speed: 1.6, run: 5, shy: 4, scale: 1, active: 'any',
    palette: [[[0.72, 0.75, 0.78], [0.25, 0.3, 0.32], 6], [[1.0, 0.82, 0.08], [0.1, 0.1, 0.12], 6], [[0.95, 0.42, 0.08], [0.97, 0.97, 0.95], 10], [[0.12, 0.35, 0.95], [0.98, 0.85, 0.1], 6]],
    parts: [
      P('body', null, [0, 0, 0], [-0.03, -0.06, -0.13, 0.03, 0.06, 0.12], [0.72, 0.75, 0.78], { pat: 6, c2: [0.25, 0.3, 0.32], anim: 'fishBody' }),
      P('tail', 'body', [0, 0, -0.13], [-0.006, -0.06, -0.09, 0.006, 0.06, 0], [0.7, 0.72, 0.75], { anim: 'fishTail', pat: 6 }),
      P('fin', 'body', [0, 0.05, 0.0], [-0.004, 0, -0.06, 0.004, 0.05, 0.04], [0.6, 0.62, 0.65], { rx: 0.4 }),
    ],
  },
};

const HABITAT_LIMIT = { ground: 18, air: 26, flutter: 14, water: 36 };

export class Creatures {
  constructor(world) {
    this.world = world;
    this.list = [];
    this.spawnTimer = 0;
    this.enabled = true;
    this.seen = new Set();
    this.onSpotted = null;
    this.instanceData = new Float32Array(2048 * 24);
    this.count = 0;
    this.shadowCount = 0;
    this.rng = Math.random;
    this.flocks = [];
  }

  clear() { this.list.length = 0; this.flocks.length = 0; }

  // ---------------------------------------------------------------- world queries
  blockAt(x, y, z) { return this.world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)); }
  walkable(b) { return b === 0 || (b > 0 && (RENDER[b] === R.CROSS || RENDER[b] === R.CARPET) && !WATERLOGGED[b]); }
  // top of the ground near height y (feet position), or null if it's a cliff/water/unloaded
  groundAt(x, y, z) {
    const fx = Math.floor(x), fz = Math.floor(z);
    for (let yy = Math.floor(y) + 2; yy >= Math.floor(y) - 4; yy--) {
      const b = this.world.getBlock(fx, yy, fz);
      if (b < 0) return null;
      if (b === B.WATER || b === B.LAVA) return { y: yy + 1, water: true };
      if (b > 0 && SOLID[b] && !isLeaves(b)) {
        if (this.walkable(this.world.getBlock(fx, yy + 1, fz)) && this.walkable(this.world.getBlock(fx, yy + 2, fz))) return { y: yy + 1, water: false };
        return null;
      }
    }
    return null;
  }
  surfaceY(x, z) {
    const col = this.world.column(Math.floor(x) >> 5, Math.floor(z) >> 5);
    if (!col || !col.heights) return null;
    return col.heights[(Math.floor(z) & 31) * 32 + (Math.floor(x) & 31)];
  }
  skyLight(x, y, z) {
    const top = this.surfaceY(x, z);
    if (top === null) return 1;
    return y >= top ? 1 : Math.max(0.12, 1 - (top - y) / 7);
  }

  // ---------------------------------------------------------------- spawning
  pickVariant(sp, biome) {
    const c = { color: null, c2: null, pat: undefined, stag: false };
    if (sp.variants && sp.variants[biome]) c.color = sp.variants[biome];
    if (sp.palette) {
      // warm reefs get the colourful fish, everywhere else the silvery ones
      let list = sp.palette;
      if (sp.habitat === 'water') list = biome === 20 || biome === 21 ? sp.palette.slice(1) : sp.palette.slice(0, 1);
      const p = list[Math.floor(this.rng() * list.length)];
      c.color = p[0]; c.c2 = p[1]; c.pat = p[2];
    }
    c.stag = this.rng() < 0.4;
    return c;
  }

  spawnGroup(key, x, y, z, biome, n) {
    const sp = SPECIES[key];
    const flock = { key, cx: x, cy: y, cz: z, heading: this.rng() * Math.PI * 2, radius: 6 + this.rng() * 10, t: 0, members: [] };
    const baseVar = this.pickVariant(sp, biome);
    for (let i = 0; i < n; i++) {
      const v = sp.palette && this.rng() < 0.5 ? this.pickVariant(sp, biome) : baseVar;
      const c = {
        sp, key, pos: [x + (this.rng() - 0.5) * 3, y, z + (this.rng() - 0.5) * 3], vel: [0, 0, 0], yaw: this.rng() * Math.PI * 2,
        pitch: 0, roll: 0, state: 'idle', timer: this.rng() * 3, phase: this.rng() * 10, speed: 0, target: null, flock,
        fade: 0, dying: false, headYaw: 0, headPitch: 0, graze: 0, light: 1, lightT: 0, hopT: 0, stag: v.stag && i === 0,
        color: v.color, c2: v.c2, pat: v.pat, size: 0.85 + this.rng() * 0.3, flee: 0,
      };
      if (sp.habitat === 'ground') {
        const g = this.groundAt(c.pos[0], y + 1, c.pos[2]);
        if (!g || g.water) continue;
        c.pos[1] = g.y;
      }
      flock.members.push(c);
      this.list.push(c);
    }
    if (flock.members.length) this.flocks.push(flock);
    return flock.members.length;
  }

  trySpawn(player, env, rain) {
    const w = this.world;
    const counts = { ground: 0, air: 0, flutter: 0, water: 0 };
    for (const c of this.list) counts[c.sp.habitat]++;
    const night = env.night > 0.5;
    // pick a random spot 22..64 m away
    const a = this.rng() * Math.PI * 2, d = 22 + this.rng() * 42;
    const x = player.pos[0] + Math.cos(a) * d, z = player.pos[2] + Math.sin(a) * d;
    const biome = w.biomeAt(Math.floor(x), Math.floor(z));
    if (biome < 0) return;
    const top = this.surfaceY(x, z);
    if (top === null) return;
    const cands = [];
    for (const key in SPECIES) {
      const sp = SPECIES[key];
      if (!sp.biomes.includes(biome)) continue;
      if (counts[sp.habitat] >= HABITAT_LIMIT[sp.habitat]) continue;
      if (sp.active === 'day' && night) continue;
      if (sp.active === 'night' && !night) continue;
      if ((sp.habitat === 'air' || sp.habitat === 'flutter') && rain > 0.5) continue;
      cands.push(key);
    }
    if (!cands.length) return;
    const key = cands[Math.floor(this.rng() * cands.length)];
    const sp = SPECIES[key];
    const n = sp.group[0] + Math.floor(this.rng() * (sp.group[1] - sp.group[0] + 1));
    const topB = w.getBlock(Math.floor(x), top, Math.floor(z));
    if (sp.habitat === 'water') {
      if (topB !== B.WATER) return;
      let floor = top;
      while (floor > 1 && w.getBlock(Math.floor(x), floor, Math.floor(z)) === B.WATER) floor--;
      if (top - floor < 2) return;
      this.spawnGroup(key, x, floor + 1 + this.rng() * (top - floor - 1), z, biome, n);
    } else if (sp.habitat === 'air') {
      this.spawnGroup(key, x, Math.max(top, SEA) + 14 + this.rng() * 18, z, biome, n);
    } else if (sp.habitat === 'flutter') {
      if (topB === B.WATER) return;
      this.spawnGroup(key, x, top + 1.2 + this.rng() * 1.5, z, biome, n);
    } else {
      if (topB === B.WATER) return;
      if (sp.nearWater) {
        let wet = false;
        for (let k = 0; k < 8 && !wet; k++) { const t2 = this.surfaceY(x + Math.cos(k) * 5, z + Math.sin(k) * 5); if (t2 !== null && w.getBlock(Math.floor(x + Math.cos(k) * 5), t2, Math.floor(z + Math.sin(k) * 5)) === B.WATER) wet = true; }
        if (!wet) return;
      }
      this.spawnGroup(key, x, top + 1, z, biome, n);
    }
  }

  // Debug/screenshot helper: spawn a group right in front of the camera.
  spawnNear(key, pos, fwd, n = 3, dist = 7) {
    const sp = SPECIES[key];
    const x = pos[0] + fwd[0] * dist, z = pos[2] + fwd[2] * dist;
    const top = this.surfaceY(x, z) ?? pos[1];
    const biome = this.world.biomeAt(Math.floor(x), Math.floor(z));
    let y = top + 1;
    if (sp.habitat === 'air') y = pos[1] + 3;
    if (sp.habitat === 'flutter') y = pos[1] - 0.3;
    if (sp.habitat === 'water') y = pos[1] - 1;
    this.spawnGroup(key, x, y, z, biome, n);
    for (const c of this.list) c.fade = 1;
  }

  // ---------------------------------------------------------------- simulation
  update(dt, player, env, rain) {
    if (!this.enabled) { this.list.length = 0; return; }
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) { this.spawnTimer = 0.6; this.trySpawn(player, env, rain); }
    const pp = player.pos;
    const moving = Math.hypot(player.vel[0], player.vel[2]) > 1.5;
    for (const f of this.flocks) this.updateFlock(f, dt, pp, env);
    for (let i = this.list.length - 1; i >= 0; i--) {
      const c = this.list[i];
      const dx = c.pos[0] - pp[0], dz = c.pos[2] - pp[2], dy = c.pos[1] - pp[1];
      const dist = Math.hypot(dx, dy, dz);
      if (dist > 96 || (c.sp.active === 'day' && env.night > 0.7 && dist > 30) || (c.sp.active === 'night' && env.night < 0.3 && dist > 30)) c.dying = true;
      c.fade = Math.max(0, Math.min(1, c.fade + (c.dying ? -dt : dt) * 1.2));
      if (c.dying && c.fade <= 0) { this.list.splice(i, 1); continue; }
      c.phase += dt;
      c.lightT -= dt;
      if (c.lightT <= 0) { c.lightT = 0.5; c.light = this.skyLight(c.pos[0], c.pos[1] + 0.5, c.pos[2]); }
      switch (c.sp.habitat) {
        case 'ground': this.updateGround(c, dt, dx, dz, dist, moving); break;
        case 'air': this.updateAir(c, dt); break;
        case 'flutter': this.updateFlutter(c, dt, dist, dx, dz); break;
        case 'water': this.updateFish(c, dt, dx, dz, dist); break;
      }
    }
    // drop empty flocks
    this.flocks = this.flocks.filter((f) => f.members.some((m) => this.list.includes(m)));
  }

  updateFlock(f, dt, pp, env) {
    f.t += dt;
    const sp = SPECIES[f.key];
    if (sp.habitat === 'air') {
      // flock centre drifts in wide arcs around the area, gulls soar in slow circles
      f.heading += dt * (sp.soar ? 0.18 : 0.35) * Math.sin(f.t * 0.13 + f.cx * 0.01);
      const sp2 = sp.soar ? 5 : 7.5;
      f.cx += Math.sin(f.heading) * sp2 * dt; f.cz += Math.cos(f.heading) * sp2 * dt;
      const top = this.surfaceY(f.cx, f.cz);
      const want = Math.max(top ?? SEA, SEA) + (sp.soar ? 18 : 12) + 6 * Math.sin(f.t * 0.2);
      f.cy += (want - f.cy) * Math.min(1, dt * 0.5);
      // stay within sight of the player
      const ddx = pp[0] - f.cx, ddz = pp[2] - f.cz;
      if (Math.hypot(ddx, ddz) > 70) f.heading += (Math.atan2(ddx, ddz) - f.heading) * dt * 0.8;
    } else if (sp.habitat === 'water') {
      f.heading += dt * 0.4 * Math.sin(f.t * 0.3 + f.cz * 0.02);
      const nx = f.cx + Math.sin(f.heading) * 1.2 * dt, nz = f.cz + Math.cos(f.heading) * 1.2 * dt;
      if (this.blockAt(nx, f.cy, nz) === B.WATER) { f.cx = nx; f.cz = nz; } else f.heading += Math.PI * 0.5;
    } else {
      f.cx = f.members[0]?.pos[0] ?? f.cx; f.cz = f.members[0]?.pos[2] ?? f.cz;
    }
  }

  updateGround(c, dt, dx, dz, dist, moving) {
    const sp = c.sp;
    // flee from a close or approaching player
    if (dist < sp.shy * (moving ? 1.2 : 0.7) && c.flee <= 0) { c.flee = 3 + this.rng() * 2; c.state = 'run'; }
    if (c.flee > 0) {
      c.flee -= dt;
      const away = Math.atan2(dx, dz);
      c.target = [c.pos[0] + Math.sin(away) * 20, c.pos[2] + Math.cos(away) * 20];
      if (c.flee <= 0) { c.state = 'idle'; c.timer = 2 + this.rng() * 3; }
    } else {
      c.timer -= dt;
      if (c.timer <= 0) {
        const r = this.rng();
        if (r < 0.45) { c.state = 'graze'; c.timer = 3 + this.rng() * 5; c.target = null; }
        else if (r < 0.65) { c.state = 'idle'; c.timer = 1.5 + this.rng() * 3; c.target = null; }
        else {
          c.state = 'walk'; c.timer = 3 + this.rng() * 5;
          // herd members drift toward the leader
          const lead = c.flock.members[0];
          const bx = lead && lead !== c ? lead.pos[0] : c.pos[0], bz = lead && lead !== c ? lead.pos[2] : c.pos[2];
          const a = this.rng() * Math.PI * 2, rr = 3 + this.rng() * 9;
          c.target = [bx + Math.cos(a) * rr, bz + Math.sin(a) * rr];
        }
      }
    }
    let want = 0;
    if (c.target && (c.state === 'walk' || c.state === 'run')) {
      const tx = c.target[0] - c.pos[0], tz = c.target[1] - c.pos[2];
      const td = Math.hypot(tx, tz);
      if (td < 0.6) { c.state = 'idle'; c.target = null; c.timer = 1 + this.rng() * 2; }
      else {
        const ty = Math.atan2(tx, tz);
        let dyaw = ((ty - c.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        c.yaw += Math.max(-dt * 4, Math.min(dt * 4, dyaw));
        want = c.state === 'run' ? sp.run : sp.speed;
      }
    }
    c.speed += (want - c.speed) * Math.min(1, dt * (c.state === 'run' ? 5 : 3));
    // hopping animals move in bursts
    if (sp.hop && c.speed > 0.1) {
      c.hopT += dt * (2.2 + c.speed * 0.5);
      if (c.hopT > 1) c.hopT -= 1;
    } else c.hopT = 0;
    const step = c.speed * dt * (sp.hop ? Math.max(0, Math.sin(c.hopT * Math.PI)) * 1.6 : 1);
    if (step > 0) {
      const nx = c.pos[0] + Math.sin(c.yaw) * step, nz = c.pos[2] + Math.cos(c.yaw) * step;
      const g = this.groundAt(nx, c.pos[1], nz);
      if (g && !g.water && g.y - c.pos[1] <= 1.05 && c.pos[1] - g.y <= 3.2) {
        c.pos[0] = nx; c.pos[2] = nz;
        c.pos[1] += (g.y - c.pos[1]) * Math.min(1, dt * (g.y > c.pos[1] ? 14 : 9));
      } else {
        // blocked by a wall, cliff or water: turn away
        c.yaw += Math.PI * (0.5 + this.rng() * 0.5);
        if (c.state === 'walk') c.target = null;
      }
    } else {
      const g = this.groundAt(c.pos[0], c.pos[1], c.pos[2]);
      if (g && !g.water) c.pos[1] += (g.y - c.pos[1]) * Math.min(1, dt * 8);
    }
    c.graze += ((c.state === 'graze' ? 1 : 0) - c.graze) * Math.min(1, dt * 2.5);
    // look at the player when they are near but not yet scary
    const look = dist < sp.shy * 2 && c.state !== 'run' ? 1 : 0;
    const rel = Math.atan2(-dx, -dz) - c.yaw;
    const want2 = look ? Math.max(-0.9, Math.min(0.9, ((rel + Math.PI * 3) % (Math.PI * 2)) - Math.PI)) : 0.3 * Math.sin(c.phase * 0.5);
    c.headYaw += (want2 - c.headYaw) * Math.min(1, dt * 3);
  }

  updateAir(c, dt) {
    const f = c.flock;
    const i = f.members.indexOf(c);
    const n = f.members.length;
    // formation around the flock centre with individual weaving
    const a = i / n * Math.PI * 2 + c.phase * 0.35;
    const tx = f.cx + Math.cos(a) * f.radius * 0.35 + Math.sin(c.phase * 0.7 + i) * 2;
    const tz = f.cz + Math.sin(a) * f.radius * 0.35 + Math.cos(c.phase * 0.6 + i * 2) * 2;
    const ty = f.cy + Math.sin(c.phase * 0.9 + i) * 1.5;
    const k = Math.min(1, dt * 1.2);
    const sp = c.sp.speed;
    const desired = [Math.sin(f.heading) * sp + (tx - c.pos[0]) * 0.6, (ty - c.pos[1]) * 0.8, Math.cos(f.heading) * sp + (tz - c.pos[2]) * 0.6];
    for (let j = 0; j < 3; j++) c.vel[j] += (desired[j] - c.vel[j]) * k;
    for (let j = 0; j < 3; j++) c.pos[j] += c.vel[j] * dt;
    const hs = Math.hypot(c.vel[0], c.vel[2]);
    const ny = Math.atan2(c.vel[0], c.vel[2]);
    let dyaw = ((ny - c.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    c.yaw += dyaw * Math.min(1, dt * 4);
    c.roll += (-dyaw * 1.5 - c.roll) * Math.min(1, dt * 3);
    c.pitch = Math.atan2(-c.vel[1], Math.max(hs, 0.1)) * 0.6;
    // flap while climbing, glide when descending
    c.flap = c.vel[1] > -0.3 ? 1 : 0.2;
  }

  updateFlutter(c, dt, dist, dx, dz) {
    // erratic zig-zag flight hugging the ground and flowers
    c.timer -= dt;
    if (c.timer <= 0 || !c.target) {
      c.timer = 0.6 + this.rng() * 1.6;
      const top = this.surfaceY(c.pos[0], c.pos[2]) ?? c.pos[1] - 1;
      c.target = [c.pos[0] + (this.rng() - 0.5) * 6, top + 1.0 + this.rng() * 1.8, c.pos[2] + (this.rng() - 0.5) * 6];
      if (dist < 3) { c.target[0] += dx * 2; c.target[2] += dz * 2; }
    }
    const sp = c.sp.speed;
    const t = c.target;
    const d = [t[0] - c.pos[0], t[1] - c.pos[1], t[2] - c.pos[2]];
    const L = Math.hypot(...d) || 1;
    for (let j = 0; j < 3; j++) c.vel[j] += (d[j] / L * sp - c.vel[j]) * Math.min(1, dt * 2.5);
    c.vel[1] += Math.sin(c.phase * 11) * dt * 3;
    for (let j = 0; j < 3; j++) c.pos[j] += c.vel[j] * dt;
    const b = this.blockAt(c.pos[0], c.pos[1], c.pos[2]);
    if (b > 0 && SOLID[b]) { c.pos[1] += 0.5; c.target = null; }
    const ny = Math.atan2(c.vel[0], c.vel[2]);
    let dyaw = ((ny - c.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    c.yaw += dyaw * Math.min(1, dt * 6);
  }

  updateFish(c, dt, dx, dz, dist) {
    const f = c.flock;
    const i = f.members.indexOf(c);
    if (dist < c.sp.shy && c.flee <= 0) c.flee = 1.5;
    c.flee -= dt;
    const a = i * 2.39996 + c.phase * 0.5;
    const tx = f.cx + Math.cos(a) * 1.6, tz = f.cz + Math.sin(a) * 1.6, ty = f.cy + Math.sin(c.phase * 0.8 + i) * 0.5;
    let desired = [(tx - c.pos[0]) * 0.9 + Math.sin(f.heading) * 1.2, (ty - c.pos[1]) * 0.8, (tz - c.pos[2]) * 0.9 + Math.cos(f.heading) * 1.2];
    if (c.flee > 0) { const L = Math.hypot(dx, dz) || 1; desired = [dx / L * c.sp.run, 0, dz / L * c.sp.run]; }
    for (let j = 0; j < 3; j++) c.vel[j] += (desired[j] - c.vel[j]) * Math.min(1, dt * 2);
    const np = [c.pos[0] + c.vel[0] * dt, c.pos[1] + c.vel[1] * dt, c.pos[2] + c.vel[2] * dt];
    const b = this.blockAt(np[0], np[1], np[2]);
    if (b === B.WATER || (b > 0 && WATERLOGGED[b])) c.pos = np;
    else { c.vel = [-c.vel[0] * 0.5, -c.vel[1] * 0.5, -c.vel[2] * 0.5]; }
    const hs = Math.hypot(c.vel[0], c.vel[2]);
    if (hs > 0.05) {
      const ny = Math.atan2(c.vel[0], c.vel[2]);
      let dyaw = ((ny - c.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      c.yaw += dyaw * Math.min(1, dt * 5);
    }
    c.pitch = Math.atan2(-c.vel[1], Math.max(hs, 0.2)) * 0.5;
    c.speed = Math.hypot(hs, c.vel[1]);
  }

  // ---------------------------------------------------------------- rendering data
  // Per part instance: 3 rows of a camera-relative affine matrix (unit cube -> world), albedo+rough,
  // secondary colour+pattern, and (sky light, emission, fade, flags).
  build(camPos, planes, frustumTest) {
    const out = this.instanceData;
    let n = 0, shadowN = 0;
    const cap = out.length / 24;
    const spotted = [];
    // near creatures first so shadow casters are a prefix of the list
    const sorted = this.list.slice().sort((a, b) => dist2(a.pos, camPos) - dist2(b.pos, camPos));
    for (const c of sorted) {
      if (c.fade <= 0.001) continue;
      const rel = [c.pos[0] - camPos[0], c.pos[1] - camPos[1], c.pos[2] - camPos[2]];
      const d = Math.hypot(...rel);
      const rad = (c.sp.height ?? 0.6) * 1.2 + 0.5;
      if (frustumTest && !frustumTest(rel, rad)) continue;
      if (d < 26 && c.fade > 0.9) spotted.push(c.key);
      const s = c.size;
      const root = { r: rot(c.pitch, c.yaw, c.roll), t: rel };
      const sc = { r: [s, 0, 0, 0, s, 0, 0, 0, s], t: [0, 0, 0] };
      const base = mul(root, sc);
      const mats = {};
      const t = c.phase;
      const moveF = c.sp.habitat === 'ground' ? Math.min(1, c.speed / Math.max(0.5, c.sp.speed)) : 1;
      const stride = c.sp.habitat === 'ground' ? t * (c.state === 'run' ? 11 : 6.5) : 0;
      for (const p of c.sp.parts) {
        if (p.stag && !c.stag) continue;
        let rx = p.rx ?? 0, ry = p.ry ?? 0, rz = p.rz ?? 0;
        switch (p.anim) {
          case 'legF': rx += Math.sin(stride + (p.side > 0 ? 0 : Math.PI)) * 0.55 * moveF; if (c.sp.hop) rx = -Math.sin(c.hopT * Math.PI * 2) * 0.6; break;
          case 'legB': rx += Math.sin(stride + (p.side > 0 ? Math.PI : 0)) * 0.55 * moveF; if (c.sp.hop) rx = Math.sin(c.hopT * Math.PI) * 0.9; break;
          case 'neck': rx += c.graze * 1.1; ry += c.headYaw * 0.4; break;
          case 'head': ry += c.headYaw * 0.6; rx += c.sp.habitat === 'ground' ? c.graze * 0.5 : 0; break;
          case 'graze': rx += c.graze * 0.9; ry += c.headYaw * 0.6; break;
          case 'tail': rx += Math.sin(t * 2.3) * 0.15; ry += Math.sin(t * 1.7) * 0.3; break;
          case 'wing': {
            const flap = (c.flap ?? 1);
            rz += p.side * (Math.sin(t * (c.sp.soar ? 4 : 18)) * (c.sp.soar ? 0.35 : 0.9) * flap + (1 - flap) * 0.1);
            break;
          }
          case 'flap': rz += p.side * (0.2 + 1.1 * Math.abs(Math.sin(t * (c.sp.glow ? 10 : 14)))); break;
          case 'fishBody': ry += Math.sin(t * (6 + c.speed * 3)) * 0.12; break;
          case 'fishTail': ry += Math.sin(t * (6 + c.speed * 3) - 1.2) * 0.6; break;
        }
        const local = { r: rot(rx, ry, rz), t: p.pivot };
        const parent = p.parent ? mats[p.parent] : base;
        if (!parent) continue;
        const m = mul(parent, local);
        mats[p.name] = m;
        // unit cube -> part box
        const bx = p.box;
        const boxM = { r: [bx[3] - bx[0], 0, 0, 0, bx[4] - bx[1], 0, 0, 0, bx[5] - bx[2]], t: [bx[0], bx[1], bx[2]] };
        const f = mul(m, boxM);
        if (n >= cap) break;
        const o = n * 24;
        out[o] = f.r[0]; out[o + 1] = f.r[1]; out[o + 2] = f.r[2]; out[o + 3] = f.t[0];
        out[o + 4] = f.r[3]; out[o + 5] = f.r[4]; out[o + 6] = f.r[5]; out[o + 7] = f.t[1];
        out[o + 8] = f.r[6]; out[o + 9] = f.r[7]; out[o + 10] = f.r[8]; out[o + 11] = f.t[2];
        const main = p.name === 'body' || p.name.startsWith('wing') || p.name === 'tail' || p.name === 'head' || p.name === 'neck' || p.name.startsWith('leg') || p.name.startsWith('ear');
        const col = lin((main && c.color && !p.fixed) ? (p.name === 'tail' && c.key !== 'fish' && c.key !== 'fox' ? p.color : c.color) : p.color);
        const c2 = lin((c.c2 && p.pat !== 3) ? c.c2 : (p.c2 ?? p.color));
        const pat = p.name === 'body' && c.pat !== undefined ? c.pat : (p.pat ?? 0);
        out[o + 12] = col[0]; out[o + 13] = col[1]; out[o + 14] = col[2]; out[o + 15] = pat === 6 || pat === 10 ? 0.35 : pat === 3 ? 0.55 : 0.85;
        out[o + 16] = c2[0]; out[o + 17] = c2[1]; out[o + 18] = c2[2]; out[o + 19] = pat;
        out[o + 20] = c.light; out[o + 21] = c.sp.glow ? 1 : 0; out[o + 22] = c.fade; out[o + 23] = c.sp.habitat === 'water' ? 1 : 0;
        n++;
      }
      if (d < 40) shadowN = n;
    }
    this.count = n;
    this.shadowCount = shadowN;
    if (this.onSpotted) for (const k of spotted) if (!this.seen.has(k)) { this.seen.add(k); this.onSpotted(k); }
    return n;
  }
}

function dist2(a, b) { return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2; }
