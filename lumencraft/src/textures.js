// Procedural PBR block textures, rendered on the GPU into texture arrays at startup.
// Each material writes albedo (linear), alpha (coverage, or biome-tint mask for opaque blocks),
// height, roughness, metalness and emission. Normals are derived from the height field.
import { TEX_NAMES } from './blocks.js';
import { FS_TRI_VS, Program } from './gl.js';

// Per-layer shading parameters.
// pom: parallax depth (blocks), nd: normal depth (blocks), por: porosity (rain darkening),
// f: flags (1 random-rotate on top faces, 2 foliage/SSS, 4 lava flow, 8 alpha-tested, 16 translucent),
// em: emission intensity scale.
const I = (pom, nd, por, f, em = 0) => ({ pom, nd, por, f, em });
export const TEX_INFO = {
  grass_top: I(0.03, 0.03, 0.5, 1), grass_side: I(0.03, 0.04, 0.6, 0), dirt: I(0.04, 0.05, 0.8, 1),
  stone: I(0.035, 0.05, 0.3, 1), cobblestone: I(0.09, 0.09, 0.45, 0), sand: I(0.02, 0.03, 0.9, 1),
  sandstone: I(0.04, 0.05, 0.6, 0), sandstone_top: I(0.02, 0.03, 0.6, 1), gravel: I(0.07, 0.07, 0.7, 1),
  oak_log: I(0.07, 0.07, 0.6, 0), log_top: I(0.03, 0.04, 0.6, 0), oak_leaves: I(0, 0.04, 0.2, 2 | 8),
  birch_log: I(0.04, 0.05, 0.5, 0), birch_leaves: I(0, 0.04, 0.2, 2 | 8), spruce_log: I(0.07, 0.08, 0.6, 0),
  spruce_leaves: I(0, 0.04, 0.2, 2 | 8), cherry_log: I(0.05, 0.06, 0.6, 0), cherry_leaves: I(0, 0.03, 0.2, 2 | 8),
  oak_planks: I(0.035, 0.04, 0.5, 0), stone_bricks: I(0.07, 0.07, 0.4, 0), bricks: I(0.06, 0.06, 0.5, 0),
  snow: I(0.02, 0.03, 0.0, 1), snow_side: I(0.03, 0.04, 0.5, 0), ice: I(0, 0.02, 0.0, 16),
  glass: I(0, 0.01, 0.0, 16), coal_ore: I(0.04, 0.05, 0.3, 0), iron_ore: I(0.04, 0.05, 0.3, 0),
  gold_ore: I(0.04, 0.05, 0.3, 0), diamond_ore: I(0.04, 0.05, 0.3, 0), copper_ore: I(0.04, 0.05, 0.3, 0),
  emerald_ore: I(0.04, 0.05, 0.3, 0), amethyst: I(0.06, 0.06, 0.0, 0, 1.6), glowstone: I(0.05, 0.05, 0.0, 0, 7),
  lava: I(0.03, 0.04, 0.0, 4, 9), deepslate: I(0.05, 0.06, 0.3, 1), obsidian: I(0.02, 0.03, 0.0, 0),
  clay: I(0.015, 0.02, 0.6, 1), moss: I(0.04, 0.05, 0.8, 1), mossy_cobblestone: I(0.09, 0.09, 0.6, 0),
  gold_block: I(0.02, 0.03, 0.0, 0), copper_block: I(0.02, 0.03, 0.1, 0), marble: I(0.01, 0.015, 0.0, 0),
  terracotta: I(0.015, 0.02, 0.5, 0), lamp: I(0.04, 0.05, 0.0, 0, 8), cactus_side: I(0.03, 0.05, 0.2, 2),
  cactus_top: I(0.02, 0.03, 0.2, 0), torch: I(0, 0.02, 0.0, 8, 12), tall_grass: I(0, 0.02, 0.2, 2 | 8),
  fern: I(0, 0.02, 0.2, 2 | 8), poppy: I(0, 0.02, 0.2, 2 | 8), dandelion: I(0, 0.02, 0.2, 2 | 8),
  cornflower: I(0, 0.02, 0.2, 2 | 8), daisy: I(0, 0.02, 0.2, 2 | 8), allium: I(0, 0.02, 0.2, 2 | 8),
  dead_bush: I(0, 0.02, 0.2, 2 | 8), seagrass: I(0, 0.02, 0.0, 2 | 8), glow_mushroom: I(0, 0.02, 0.0, 8, 5),
  pink_petals: I(0, 0.02, 0.2, 2 | 8), water: I(0, 0, 0, 16),
};

const LIB = /* glsl */`
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash2(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 srgb(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
float saturate(float x) { return clamp(x, 0.0, 1.0); }
float vnoise(vec2 p, vec2 per, float seed) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash(mod(i, per) + seed * 17.13), b = hash(mod(i + vec2(1, 0), per) + seed * 17.13);
  float c = hash(mod(i + vec2(0, 1), per) + seed * 17.13), d = hash(mod(i + vec2(1, 1), per) + seed * 17.13);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 uv, vec2 freq, int oct, float gain, float seed) {
  float s = 0.0, a = 0.5, n = 0.0; vec2 f = freq;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * vnoise(uv * f, f, seed + float(i) * 3.7);
    n += a; a *= gain; f *= 2.0;
  }
  return s / n;
}
// periodic voronoi: x=F1 y=F2 z=cell hash w=unused
vec4 voronoi(vec2 p, vec2 per, float seed, float jit) {
  vec2 n = floor(p), f = fract(p);
  float F1 = 8.0, F2 = 8.0; vec2 id1 = vec2(0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 cell = mod(n + g, per);
    vec2 o = hash2(cell + seed * 7.31) * jit + (1.0 - jit) * 0.5;
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < F1) { F2 = F1; F1 = d; id1 = cell; } else if (d < F2) F2 = d;
  }
  return vec4(sqrt(F1), sqrt(F2), hash(id1 + seed * 3.17), 0.0);
}
struct M { vec3 alb; float h; float rough; float metal; float emit; float alpha; };
M mdef() { M m; m.alb = vec3(0.5); m.h = 0.5; m.rough = 0.8; m.metal = 0.0; m.emit = 0.0; m.alpha = 1.0; return m; }

M dirtM(vec2 uv) {
  M m = mdef();
  float n = fbm(uv, vec2(4.0), 5, 0.55, 1.0);
  vec4 v = voronoi(uv * 10.0, vec2(10.0), 2.0, 1.0);
  float peb = smoothstep(0.42, 0.18, v.x) * step(0.55, v.z);
  float fine = vnoise(uv * 48.0, vec2(48.0), 4.0);
  vec3 base = mix(vec3(0.33, 0.23, 0.15), vec3(0.46, 0.33, 0.21), n) * (0.84 + 0.3 * fine);
  vec3 pc = mix(vec3(0.42, 0.39, 0.35), vec3(0.56, 0.51, 0.46), v.z);
  m.alb = srgb(mix(base, pc, peb * 0.85));
  m.h = 0.35 + 0.3 * n + 0.4 * peb * (1.0 - v.x * 1.8) + 0.1 * fine;
  m.rough = 0.93 - peb * 0.2;
  return m;
}
M stoneM(vec2 uv) {
  M m = mdef();
  float n = fbm(uv, vec2(3.0), 6, 0.55, 3.0);
  float n2 = fbm(uv, vec2(2.0, 7.0), 4, 0.5, 4.0);
  vec4 v = voronoi(uv * 5.0, vec2(5.0), 6.0, 1.0);
  float crack = smoothstep(0.03, 0.0, v.y - v.x) * smoothstep(0.4, 0.6, fbm(uv, vec2(4.0), 2, 0.5, 9.0));
  float f = vnoise(uv * 96.0, vec2(96.0), 7.0);
  float lum = 0.46 + 0.26 * (n - 0.5) + 0.07 * (n2 - 0.5) + 0.07 * (f - 0.5);
  m.alb = srgb(vec3(lum) * vec3(1.0, 0.985, 0.96) * (1.0 - crack * 0.5));
  m.h = 0.55 + 0.6 * (n - 0.5) - crack * 0.5 + 0.08 * f;
  m.rough = 0.7 - 0.1 * f;
  return m;
}
M cobbleM(vec2 uv) {
  M m = mdef();
  vec4 v = voronoi(uv * vec2(4.0, 3.0), vec2(4.0, 3.0), 5.0, 0.9);
  float edge = v.y - v.x;
  float stoneMask = smoothstep(0.03, 0.14, edge);
  float dome = sqrt(clamp(edge * 2.2, 0.0, 1.0));
  float n = fbm(uv, vec2(8.0), 4, 0.5, 2.0);
  float f = vnoise(uv * 64.0, vec2(64.0), 3.0);
  float shade = mix(0.3, 0.56, v.z) + 0.16 * (n - 0.5) + 0.05 * (f - 0.5);
  vec3 col = vec3(shade) * mix(vec3(1.0), vec3(1.05, 1.0, 0.92), step(0.6, hash(vec2(v.z * 91.0))));
  m.alb = srgb(mix(vec3(0.17, 0.16, 0.15), col, stoneMask));
  m.h = mix(0.02, 0.45 + 0.5 * dome, stoneMask) + 0.08 * (n - 0.5) + 0.03 * f;
  m.rough = mix(0.95, 0.72, stoneMask);
  return m;
}
float leafLayer(vec2 uv, float freq, float seed, float lx, float ly, out float shade, out float vein) {
  vec2 p = uv * freq; vec2 n = floor(p), f = fract(p);
  float best = 0.0; shade = 0.0; vein = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 cell = mod(n + g, vec2(freq));
    vec2 o = hash2(cell + seed);
    vec2 c = f - (g + o);
    float ang = hash(cell + seed + 3.0) * 6.2832;
    float cs = cos(ang), sn = sin(ang);
    vec2 q = vec2(cs * c.x - sn * c.y, sn * c.x + cs * c.y);
    float w = ly * (1.0 - pow(abs(q.x) / lx, 2.0));
    float e = abs(q.y) / max(w, 1e-4);
    if (abs(q.x) < lx && e < 1.0) {
      float v = (1.0 - e) * (1.0 - abs(q.x) / lx * 0.5) + hash(cell + seed + 5.0) * 0.4;
      if (v > best) { best = v; shade = hash(cell + seed + 7.0); vein = smoothstep(0.12, 0.0, e) * step(abs(q.x), lx * 0.8); }
    }
  }
  return best;
}
M leavesM(vec2 uv, float seed, float lx, float ly, vec3 c0, vec3 c1) {
  M m = mdef();
  float s1, v1, s2, v2, s3, v3, s4, v4;
  float a1 = leafLayer(uv, 4.0, seed, lx, ly, s1, v1);
  float a2 = leafLayer(uv, 6.0, seed + 11.0, lx, ly, s2, v2);
  float a3 = leafLayer(uv, 8.0, seed + 23.0, lx, ly, s3, v3);
  float a4 = leafLayer(uv, 5.0, seed + 41.0, lx, ly, s4, v4);
  float h = a1; float sh = s1; float vn = v1;
  if (a2 * 0.92 > h) { h = a2 * 0.92; sh = s2; vn = v2; }
  if (a3 * 0.85 > h) { h = a3 * 0.85; sh = s3; vn = v3; }
  if (a4 * 0.78 > h) { h = a4 * 0.78; sh = s4; vn = v4; }
  m.alpha = step(0.02, h);
  vec3 c = mix(c0, c1, sh) * (0.66 + 0.4 * h) * (1.0 - 0.18 * vn);
  m.alb = srgb(c);
  m.h = h;
  m.rough = 0.55;
  return m;
}
float blades(vec2 uv, float n, float seed, float wBase, float wave, out float lum) {
  float a = 0.0; lum = 0.0;
  float t = 1.0 - uv.y;
  for (int i = 0; i < 14; i++) {
    float fi = float(i);
    if (fi >= n) break;
    float x0 = 0.12 + 0.76 * hash(vec2(fi, seed));
    float hh = 0.5 + 0.5 * hash(vec2(fi, seed + 2.0));
    float lean = (hash(vec2(fi, seed + 3.0)) - 0.5) * 0.55;
    float w = wBase * (0.7 + 0.6 * hash(vec2(fi, seed + 4.0)));
    if (t > hh) continue;
    float cx = x0 + lean * t * t / hh + wave * sin(t * 9.0 + fi) * t;
    float ww = w * (1.0 - t / hh) + 0.004;
    float d = abs(uv.x - cx);
    if (d < ww) {
      a = 1.0;
      lum = (0.42 + 0.55 * t / hh) * (0.85 + 0.25 * hash(vec2(fi, seed + 5.0))) * (1.0 - 0.25 * d / ww);
    }
  }
  return a;
}
float segDist(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
M flowerM(vec2 uv, int kind) {
  M m = mdef();
  m.alpha = 0.0; m.rough = 0.6;
  vec2 top = vec2(0.5, 0.3);
  float stem = segDist(uv, vec2(0.5, 1.0), vec2(0.5 + 0.03 * sin(uv.y * 6.0), top.y + 0.05));
  vec3 green = srgb(vec3(0.2, 0.42, 0.12));
  if (stem < 0.025) { m.alpha = 1.0; m.alb = green * (0.8 + 0.4 * (1.0 - uv.y)); m.h = 0.5; }
  // leaves
  for (int s = 0; s < 2; s++) {
    float side = s == 0 ? -1.0 : 1.0;
    vec2 c = vec2(0.5 + side * 0.1, 0.78 - float(s) * 0.1);
    vec2 q = uv - c;
    float ang = side * 0.6;
    vec2 r = vec2(cos(ang) * q.x - sin(ang) * q.y, sin(ang) * q.x + cos(ang) * q.y);
    if (abs(r.x) < 0.12 && abs(r.y) < 0.035 * (1.0 - pow(r.x / 0.12, 2.0))) { m.alpha = 1.0; m.alb = green * 0.9; }
  }
  vec2 p = uv - top;
  float r = length(p), a = atan(p.y, p.x);
  if (kind == 0) { // poppy
    float petals = 0.15 + 0.035 * cos(a * 4.0);
    if (r < petals) { m.alpha = 1.0; m.alb = srgb(mix(vec3(0.75, 0.05, 0.04), vec3(0.92, 0.18, 0.1), r / petals)); m.h = 1.0 - r / petals * 0.5; }
    if (r < 0.035) m.alb = srgb(vec3(0.08, 0.06, 0.05));
  } else if (kind == 1) { // dandelion
    float n = vnoise(vec2(a * 3.0, r * 40.0), vec2(1000.0), 3.0);
    if (r < 0.11 + 0.02 * n) { m.alpha = 1.0; m.alb = srgb(mix(vec3(1.0, 0.75, 0.1), vec3(1.0, 0.88, 0.25), n)); m.h = 1.0 - r * 5.0; }
  } else if (kind == 2) { // cornflower
    float spikes = 0.13 + 0.05 * pow(abs(cos(a * 5.0)), 3.0);
    if (r < spikes) { m.alpha = 1.0; m.alb = srgb(mix(vec3(0.15, 0.3, 0.85), vec3(0.3, 0.5, 1.0), r / spikes)); m.h = 1.0 - r * 4.0; }
    if (r < 0.03) m.alb = srgb(vec3(0.2, 0.1, 0.4));
  } else if (kind == 3) { // daisy
    float petal = abs(fract(a / 6.2832 * 12.0) - 0.5);
    if (r < 0.15 && petal < 0.32 * (1.0 - r / 0.16)) { m.alpha = 1.0; m.alb = srgb(vec3(0.95, 0.95, 0.9)); m.h = 0.8; }
    if (r < 0.045) { m.alpha = 1.0; m.alb = srgb(vec3(0.95, 0.75, 0.15)); m.h = 1.0; }
  } else if (kind == 4) { // allium
    vec2 q = uv - vec2(0.5, 0.24);
    vec4 v = voronoi(uv * 24.0, vec2(24.0), 5.0, 1.0);
    if (length(q) < 0.16 && v.x < 0.42) { m.alpha = 1.0; m.alb = srgb(mix(vec3(0.55, 0.3, 0.8), vec3(0.75, 0.5, 0.95), v.z)); m.h = 1.0 - v.x; }
  }
  return m;
}
`;

// Material bodies. `uv` is in [0,1)^2 with v = 0 at the top of a block face.
const MAT = {
  grass_top: `
    float n1 = fbm(uv, vec2(6.0), 4, 0.5, 1.0);
    vec4 v = voronoi(uv * 26.0, vec2(26.0), 3.0, 1.0);
    vec4 v2 = voronoi(uv * 41.0, vec2(41.0), 8.0, 1.0);
    float blade = pow(1.0 - v.x, 3.0), blade2 = pow(1.0 - v2.x, 4.0);
    float fine = vnoise(uv * 64.0, vec2(64.0), 5.0);
    float lum = 0.6 + 0.22 * blade + 0.18 * blade2 + 0.22 * (n1 - 0.5) + 0.1 * (fine - 0.5);
    vec3 c = vec3(lum) * mix(vec3(1.0), vec3(1.12, 1.02, 0.78), v.z * v.z * 0.8);
    float dirt = smoothstep(0.66, 0.82, fbm(uv, vec2(5.0), 3, 0.5, 9.0)) * 0.7 * (1.0 - blade2);
    m.alb = mix(srgb(c), srgb(vec3(0.38, 0.28, 0.18)), dirt);
    m.alpha = 1.0 - dirt;
    m.h = 0.3 + 0.35 * blade + 0.25 * blade2 + 0.1 * fine - dirt * 0.25;
    m.rough = 0.82;`,
  grass_side: `
    m = dirtM(uv);
    float strip = hash(vec2(floor(uv.x * 32.0), 7.0));
    float edge = 0.12 + 0.08 * vnoise(vec2(uv.x * 8.0, 0.5), vec2(8.0, 1.0), 3.0) + 0.16 * strip * strip * strip;
    if (uv.y < edge) {
      float g = vnoise(uv * vec2(48.0, 12.0), vec2(48.0, 12.0), 2.0);
      m.alb = srgb(vec3(0.58 + 0.28 * g) * mix(vec3(1.0), vec3(1.1, 1.0, 0.8), strip * 0.5));
      m.alpha = 1.0; m.h = 0.8 + 0.2 * g; m.rough = 0.82;
    } else {
      m.alpha = 0.0;
      float sh = smoothstep(edge + 0.07, edge, uv.y);
      m.alb *= 1.0 - 0.4 * sh;
    }`,
  dirt: `m = dirtM(uv);`,
  stone: `m = stoneM(uv);`,
  cobblestone: `m = cobbleM(uv);`,
  sand: `
    float n = fbm(uv, vec2(4.0), 4, 0.5, 1.0);
    float g = vnoise(uv * 128.0, vec2(128.0), 2.0);
    float g2 = hash(floor(uv * 128.0) + 3.0);
    float ripple = sin((uv.y + 0.06 * sin(uv.x * 12.566)) * 31.4159) * 0.5 + 0.5;
    vec3 c = vec3(0.84, 0.76, 0.58) * (0.9 + 0.12 * n) * (0.93 + 0.12 * g);
    c = mix(c, vec3(0.55, 0.47, 0.38), step(0.965, g2) * 0.7);
    c = mix(c, vec3(0.95, 0.93, 0.88), step(0.985, 1.0 - g2) * 0.5);
    m.alb = srgb(c);
    m.h = 0.45 + 0.25 * ripple + 0.2 * g + 0.1 * n;
    m.rough = 0.95;`,
  sandstone: `
    float band = vnoise(vec2(uv.x * 2.0, uv.y * 18.0), vec2(2.0, 18.0), 1.0);
    float n = fbm(uv, vec2(6.0), 4, 0.5, 2.0);
    float gy = abs(fract(uv.y * 3.0 + 0.5) - 0.5);
    float groove = 1.0 - smoothstep(0.0, 0.03, gy);
    vec3 c = mix(vec3(0.85, 0.75, 0.54), vec3(0.76, 0.64, 0.43), band) * (0.92 + 0.12 * n);
    c *= 1.0 - 0.3 * groove;
    m.alb = srgb(c); m.h = 0.6 + 0.25 * n + 0.1 * band - 0.55 * groove; m.rough = 0.9;`,
  sandstone_top: `
    float n = fbm(uv, vec2(5.0), 5, 0.5, 5.0);
    float g = vnoise(uv * 96.0, vec2(96.0), 1.0);
    vec3 c = vec3(0.86, 0.77, 0.56) * (0.9 + 0.14 * n) * (0.95 + 0.08 * g);
    m.alb = srgb(c); m.h = 0.5 + 0.3 * n + 0.1 * g; m.rough = 0.88;`,
  gravel: `
    vec4 v = voronoi(uv * 7.0, vec2(7.0), 5.0, 1.0);
    vec4 v2 = voronoi(uv * 15.0, vec2(15.0), 9.0, 1.0);
    float e1 = v.y - v.x, e2 = v2.y - v2.x;
    float big = step(0.35, v.z) * smoothstep(0.02, 0.1, e1);
    float small = smoothstep(0.02, 0.1, e2);
    vec3 c1 = mix(vec3(0.34, 0.32, 0.3), vec3(0.64, 0.6, 0.56), v.z) * mix(vec3(1.0), vec3(1.12, 0.96, 0.84), step(0.7, hash(vec2(v.z * 7.0))));
    vec3 c2 = mix(vec3(0.26, 0.25, 0.24), vec3(0.52, 0.49, 0.46), v2.z) * small + 0.08 * (1.0 - small);
    m.alb = srgb(mix(c2, c1, big));
    m.h = max(big * (0.5 + 0.5 * sqrt(clamp(e1 * 3.0, 0.0, 1.0))), small * 0.45 * sqrt(clamp(e2 * 3.0, 0.0, 1.0)));
    m.rough = mix(0.9, 0.75, big);`,
  oak_log: `
    float warp = fbm(uv, vec2(3.0, 2.0), 3, 0.5, 4.0);
    float f = vnoise(vec2(uv.x * 10.0 + warp * 2.0, uv.y * 2.0), vec2(10.0, 2.0), 3.0);
    float ridges = abs(f * 2.0 - 1.0);
    float n2 = vnoise(vec2(uv.x * 24.0, uv.y * 6.0), vec2(24.0, 6.0), 6.0);
    float fine = vnoise(uv * vec2(64.0, 32.0), vec2(64.0, 32.0), 2.0);
    float h = pow(1.0 - ridges, 1.6) * 0.7 + 0.2 * n2 + 0.1 * fine;
    vec3 c = mix(vec3(0.13, 0.09, 0.06), vec3(0.37, 0.27, 0.18), h);
    float lichen = smoothstep(0.7, 0.8, fbm(uv, vec2(3.0), 3, 0.5, 12.0));
    c = mix(c, vec3(0.42, 0.46, 0.3), lichen * 0.6);
    m.alb = srgb(c); m.h = h; m.rough = 0.9;`,
  log_top: `
    vec2 p = uv - 0.5;
    float r = length(p);
    float n = fbm(uv, vec2(4.0), 3, 0.5, 5.0);
    float rings = 0.5 + 0.5 * sin((r + n * 0.04) * 90.0);
    vec3 wood = mix(vec3(0.56, 0.42, 0.26), vec3(0.7, 0.55, 0.36), rings);
    float bark = smoothstep(0.42, 0.45, max(abs(p.x), abs(p.y)));
    float crack = smoothstep(0.02, 0.0, abs(p.x * 0.3 + p.y * 0.95)) * step(r, 0.35);
    wood *= 1.0 - crack * 0.5;
    m.alb = srgb(mix(wood, vec3(0.2, 0.14, 0.09), bark));
    m.h = mix(0.55 + 0.1 * rings - crack * 0.4, 0.85, bark);
    m.rough = mix(0.7, 0.9, bark);`,
  oak_leaves: `m = leavesM(uv, 1.0, 0.5, 0.27, vec3(0.62), vec3(1.0));`,
  birch_leaves: `m = leavesM(uv, 2.0, 0.42, 0.26, vec3(0.7), vec3(1.05));`,
  spruce_leaves: `
    float s1, v1, s2, v2, s3, v3, s4, v4;
    float a1 = leafLayer(uv, 6.0, 3.0, 0.62, 0.1, s1, v1);
    float a2 = leafLayer(uv, 8.0, 17.0, 0.6, 0.1, s2, v2);
    float a3 = leafLayer(uv, 10.0, 29.0, 0.6, 0.1, s3, v3);
    float a4 = leafLayer(uv, 7.0, 43.0, 0.62, 0.11, s4, v4);
    float twig = fbm(uv, vec2(4.0), 3, 0.5, 5.0);
    float h = max(max(a1, a2 * 0.9), max(a3 * 0.8, a4 * 0.85));
    m.alpha = max(step(0.02, h), step(0.62, twig));
    m.alb = srgb(mix(vec3(0.1, 0.19, 0.13), vec3(0.22, 0.34, 0.21), s1 * 0.6 + h * 0.4) * (0.7 + 0.4 * h));
    m.h = max(h, 0.3); m.rough = 0.6;`,
  cherry_leaves: `
    float s1, v1, s2, v2, s3, v3, s4, v4;
    float a1 = leafLayer(uv, 5.0, 5.0, 0.4, 0.33, s1, v1);
    float a2 = leafLayer(uv, 7.0, 13.0, 0.38, 0.32, s2, v2);
    float a3 = leafLayer(uv, 10.0, 21.0, 0.36, 0.3, s3, v3);
    float a4 = leafLayer(uv, 6.0, 33.0, 0.4, 0.33, s4, v4);
    float h = a1; float sh = s1;
    if (a2 * 0.9 > h) { h = a2 * 0.9; sh = s2; }
    if (a3 * 0.82 > h) { h = a3 * 0.82; sh = s3; }
    if (a4 * 0.75 > h) { h = a4 * 0.75; sh = s4; }
    m.alpha = step(0.02, h);
    vec3 c = mix(vec3(0.96, 0.5, 0.64), vec3(1.0, 0.74, 0.8), sh);
    c = mix(c, vec3(1.0, 0.93, 0.93), step(0.86, sh) * 0.55);
    c = mix(c, vec3(0.8, 0.3, 0.45), smoothstep(0.3, 0.05, h) * 0.6);
    m.alb = srgb(c * (0.8 + 0.25 * h)); m.h = h; m.rough = 0.5;`,
  birch_log: `
    float n = fbm(uv, vec2(4.0, 2.0), 4, 0.5, 3.0);
    float dash = smoothstep(0.74, 0.8, vnoise(vec2(uv.x * 5.0, uv.y * 30.0), vec2(5.0, 30.0), 4.0));
    float patchy = smoothstep(0.66, 0.74, fbm(uv, vec2(3.0, 5.0), 3, 0.5, 8.0));
    vec3 c = vec3(0.86, 0.85, 0.8) * (0.88 + 0.12 * n);
    c = mix(c, vec3(0.09, 0.08, 0.07), max(dash * 0.9, patchy));
    m.alb = srgb(c); m.h = 0.6 + 0.12 * n - 0.3 * dash - 0.25 * patchy; m.rough = 0.7;`,
  spruce_log: `
    vec4 v = voronoi(uv * vec2(6.0, 3.0), vec2(6.0, 3.0), 2.0, 1.0);
    float e = smoothstep(0.0, 0.09, v.y - v.x);
    float n = fbm(uv, vec2(8.0), 3, 0.5, 1.0);
    vec3 c = mix(vec3(0.1, 0.07, 0.05), vec3(0.3, 0.2, 0.13) * (0.8 + 0.4 * v.z), e) * (0.85 + 0.3 * n);
    m.alb = srgb(c); m.h = e * (0.6 + 0.4 * v.z) + 0.1 * n; m.rough = 0.9;`,
  cherry_log: `
    float n = fbm(uv, vec2(3.0, 6.0), 4, 0.5, 5.0);
    float bands = smoothstep(0.6, 0.85, vnoise(vec2(uv.x * 3.0, uv.y * 20.0), vec2(3.0, 20.0), 2.0));
    float f = vnoise(vec2(uv.x * 30.0, uv.y * 8.0), vec2(30.0, 8.0), 9.0);
    vec3 c = mix(vec3(0.19, 0.1, 0.1), vec3(0.33, 0.18, 0.16), n) * (0.9 + 0.2 * f);
    c = mix(c, vec3(0.1, 0.05, 0.05), bands * 0.7);
    m.alb = srgb(c); m.h = 0.55 + 0.25 * n - 0.3 * bands + 0.1 * f; m.rough = 0.8;`,
  oak_planks: `
    float by = uv.y * 4.0; float bi = floor(by); float fy = fract(by);
    float off = hash(vec2(bi, 3.0));
    float jx = fract(uv.x + off);
    float joint = 1.0 - smoothstep(0.0, 0.012, min(jx, 1.0 - jx));
    float gw = fbm(uv, vec2(2.0, 8.0), 3, 0.5, bi * 7.0 + 1.0);
    float grain = 0.5 + 0.5 * sin((fy * 2.5 + gw * 5.0) * 6.2832);
    float fine = vnoise(vec2(uv.x * 4.0, uv.y * 96.0), vec2(4.0, 96.0), bi);
    float gap = 1.0 - smoothstep(0.0, 0.06, min(fy, 1.0 - fy));
    vec3 base = mix(vec3(0.52, 0.37, 0.22), vec3(0.66, 0.5, 0.31), off * 0.7 + 0.3 * gw);
    base *= (0.86 + 0.14 * grain) * (0.94 + 0.08 * fine);
    float g2 = max(gap, joint);
    m.alb = srgb(base * (1.0 - 0.65 * g2));
    m.h = 0.75 + 0.05 * grain + 0.03 * fine - 0.7 * g2;
    m.rough = 0.55 + 0.2 * fine;`,
  stone_bricks: `
    vec2 p = uv * vec2(1.0, 2.0);
    float row = floor(p.y);
    p.x += mod(row, 2.0) * 0.5;
    vec2 cell = floor(p), f = fract(p);
    float ex = min(f.x, 1.0 - f.x), ey = min(f.y, 1.0 - f.y) * 0.5;
    float d = min(ex, ey);
    float mortar = 1.0 - smoothstep(0.012, 0.03, d);
    float bevel = smoothstep(0.012, 0.07, d);
    float bh = hash(mod(cell, vec2(1.0, 2.0)) + 4.0);
    M s = stoneM(uv);
    vec4 v = voronoi(uv * 6.0, vec2(6.0), 11.0, 1.0);
    float crack = smoothstep(0.02, 0.0, v.y - v.x) * step(0.7, v.z);
    vec3 c = s.alb * (0.85 + 0.3 * bh) * (1.0 - crack * 0.5);
    m.alb = mix(c, srgb(vec3(0.24, 0.23, 0.22)), mortar);
    m.h = mix(0.05, 0.55 + 0.35 * bevel + 0.2 * (s.h - 0.5), 1.0 - mortar) - crack * 0.3;
    m.rough = mix(0.72, 0.95, mortar);`,
  bricks: `
    vec2 p = uv * vec2(2.0, 4.0);
    float row = floor(p.y);
    p.x += mod(row, 2.0) * 0.5;
    vec2 cell = floor(p), f = fract(p);
    float ex = min(f.x, 1.0 - f.x) * 0.5, ey = min(f.y, 1.0 - f.y) * 0.25;
    float d = min(ex, ey);
    float mortar = 1.0 - smoothstep(0.01, 0.022, d);
    float bh = hash(mod(cell, vec2(2.0, 4.0)) + 9.0);
    float n = fbm(uv, vec2(8.0), 4, 0.55, 3.0);
    float f2 = vnoise(uv * 80.0, vec2(80.0), 1.0);
    vec3 c = mix(vec3(0.5, 0.2, 0.14), vec3(0.64, 0.3, 0.2), bh) * (0.85 + 0.25 * n) * (0.92 + 0.12 * f2);
    c = mix(c, vec3(0.3, 0.14, 0.1), step(0.85, bh) * 0.5);
    m.alb = srgb(mix(c, vec3(0.7, 0.68, 0.64) * (0.85 + 0.2 * f2), mortar));
    m.h = mix(0.15, 0.7 + 0.2 * smoothstep(0.01, 0.05, d) + 0.1 * n, 1.0 - mortar);
    m.rough = mix(0.8, 0.95, mortar);`,
  snow: `
    float n = fbm(uv, vec2(4.0), 4, 0.5, 1.0);
    float f = vnoise(uv * 64.0, vec2(64.0), 2.0);
    float sparkle = step(0.988, hash(floor(uv * 128.0) + 11.0));
    m.alb = srgb(vec3(0.92, 0.94, 0.98) * (0.93 + 0.07 * n));
    m.h = 0.5 + 0.35 * n + 0.1 * f;
    m.rough = mix(0.62, 0.08, sparkle);`,
  snow_side: `
    m = dirtM(uv);
    float edge = 0.18 + 0.1 * vnoise(vec2(uv.x * 6.0, 0.5), vec2(6.0, 1.0), 5.0) + 0.06 * hash(vec2(floor(uv.x * 32.0), 3.0));
    if (uv.y < edge) {
      float n = fbm(uv, vec2(4.0), 3, 0.5, 1.0);
      m.alb = srgb(vec3(0.92, 0.94, 0.98) * (0.92 + 0.08 * n)); m.h = 0.9; m.rough = 0.6;
    } else m.alb *= 1.0 - 0.3 * smoothstep(edge + 0.05, edge, uv.y);
    m.alpha = 0.0;`,
  ice: `
    vec4 v = voronoi(uv * 3.0, vec2(3.0), 4.0, 1.0);
    float crack = smoothstep(0.025, 0.0, v.y - v.x);
    float n = fbm(uv, vec2(4.0), 4, 0.5, 2.0);
    float bub = step(0.992, hash(floor(uv * 64.0) + 1.0));
    m.alb = srgb(vec3(0.62, 0.78, 0.95) * (0.9 + 0.1 * n) + crack * 0.3 + bub * 0.3);
    m.alpha = 0.55 + crack * 0.35 + 0.1 * n;
    m.h = 0.6 - crack * 0.4; m.rough = 0.04 + crack * 0.3;`,
  glass: `
    vec2 d = min(uv, 1.0 - uv);
    float frame = 1.0 - smoothstep(0.035, 0.045, min(d.x, d.y));
    float streak = smoothstep(0.02, 0.0, abs(fract((uv.x + uv.y) * 1.5) - 0.3)) * step(0.15, uv.x) * step(uv.y, 0.8);
    m.alb = srgb(mix(vec3(0.85, 0.93, 0.95), vec3(0.75, 0.8, 0.82), frame));
    m.alpha = max(frame * 0.85, 0.06 + streak * 0.12);
    m.h = 0.5 + frame * 0.3; m.rough = mix(0.02, 0.3, frame);`,
  coal_ore: `m = stoneM(uv); ORE(vec3(0.05), 0.45, 0.0, 1.0)`,
  iron_ore: `m = stoneM(uv); ORE(vec3(0.85, 0.66, 0.5), 0.4, 0.6, 2.0)`,
  gold_ore: `m = stoneM(uv); ORE(vec3(1.0, 0.8, 0.28), 0.25, 1.0, 3.0)`,
  diamond_ore: `m = stoneM(uv); ORE(vec3(0.5, 0.95, 0.95), 0.05, 0.0, 4.0)`,
  copper_ore: `m = stoneM(uv); ORE(vec3(0.85, 0.48, 0.32), 0.35, 0.8, 5.0)`,
  emerald_ore: `m = stoneM(uv); ORE(vec3(0.15, 0.85, 0.4), 0.06, 0.0, 6.0)`,
  amethyst: `
    vec4 v = voronoi(uv * 4.0, vec2(4.0), 4.0, 1.0);
    vec4 v2 = voronoi(uv * 9.0, vec2(9.0), 8.0, 1.0);
    float e = smoothstep(0.0, 0.12, v.y - v.x);
    float e2 = smoothstep(0.0, 0.1, v2.y - v2.x);
    float facet = v.z * 0.7 + v2.z * 0.3;
    float grad = saturate(1.0 - v.x * 1.6);
    vec3 c = mix(vec3(0.26, 0.12, 0.42), vec3(0.62, 0.44, 0.86), facet * 0.7 + grad * 0.3) * (0.7 + 0.3 * e) * (0.85 + 0.15 * e2);
    m.alb = srgb(c); m.h = 0.3 + 0.45 * e * grad + 0.25 * e2;
    m.rough = 0.1; m.emit = 0.08 + 0.35 * smoothstep(0.75, 1.0, facet) * e * grad;`,
  glowstone: `
    vec4 v = voronoi(uv * 6.0, vec2(6.0), 1.0, 1.0);
    vec4 v2 = voronoi(uv * 13.0, vec2(13.0), 3.0, 1.0);
    float e = smoothstep(0.0, 0.16, v.y - v.x) * (0.6 + 0.4 * smoothstep(0.0, 0.2, v2.y - v2.x));
    float n = fbm(uv, vec2(8.0), 3, 0.5, 2.0);
    vec3 c = mix(vec3(0.45, 0.28, 0.1), vec3(1.0, 0.84, 0.5), e * (0.6 + 0.4 * n));
    m.alb = srgb(c); m.emit = 0.2 + 0.8 * e * (0.5 + 0.5 * n); m.h = e; m.rough = 0.45;`,
  lava: `
    vec4 v = voronoi(uv * 4.0, vec2(4.0), 3.0, 1.0);
    float n = fbm(uv, vec2(6.0), 4, 0.5, 7.0);
    float hot = smoothstep(0.05, 0.45, (v.y - v.x) * 1.6 + n * 0.6 - 0.1);
    vec3 c = mix(vec3(0.2, 0.04, 0.02), mix(vec3(1.0, 0.3, 0.04), vec3(1.0, 0.78, 0.3), n), hot);
    m.alb = srgb(c); m.emit = 0.05 + 0.95 * hot; m.h = 1.0 - hot * 0.6; m.rough = mix(0.9, 0.3, hot);`,
  deepslate: `
    float n = fbm(uv, vec2(3.0, 6.0), 5, 0.55, 2.0);
    float lam = vnoise(vec2(uv.x * 16.0, uv.y * 2.0), vec2(16.0, 2.0), 3.0);
    float f = vnoise(uv * 80.0, vec2(80.0), 5.0);
    vec3 c = vec3(0.2, 0.2, 0.23) * (0.78 + 0.45 * n) * (0.9 + 0.2 * lam) * (0.94 + 0.1 * f);
    m.alb = srgb(c); m.h = 0.4 + 0.3 * n + 0.25 * lam + 0.05 * f; m.rough = 0.78;`,
  obsidian: `
    float n = fbm(uv, vec2(3.0), 5, 0.6, 4.0);
    vec4 v = voronoi(uv * 4.0, vec2(4.0), 3.0, 1.0);
    float vein = smoothstep(0.05, 0.0, v.y - v.x);
    vec3 c = mix(vec3(0.03, 0.02, 0.05), vec3(0.12, 0.06, 0.2), n) + vein * vec3(0.15, 0.08, 0.25);
    m.alb = srgb(c); m.h = 0.5 + 0.3 * n - vein * 0.2; m.rough = 0.08 + 0.1 * n;`,
  clay: `
    float n = fbm(uv, vec2(4.0), 5, 0.5, 1.0);
    float f = vnoise(uv * 48.0, vec2(48.0), 6.0);
    m.alb = srgb(vec3(0.6, 0.62, 0.68) * (0.92 + 0.1 * n) * (0.97 + 0.05 * f));
    m.h = 0.5 + 0.25 * n + 0.05 * f; m.rough = 0.75;`,
  moss: `
    float n = fbm(uv, vec2(6.0), 5, 0.6, 3.0);
    float f = vnoise(uv * 96.0, vec2(96.0), 1.0);
    vec4 v = voronoi(uv * 20.0, vec2(20.0), 2.0, 1.0);
    float tuft = pow(1.0 - v.x, 3.0);
    m.alb = srgb(mix(vec3(0.2, 0.32, 0.09), vec3(0.42, 0.55, 0.18), n * 0.6 + tuft * 0.4) * (0.85 + 0.25 * f));
    m.h = 0.35 + 0.4 * tuft + 0.15 * n + 0.1 * f; m.rough = 0.95;`,
  mossy_cobblestone: `
    m = cobbleM(uv);
    float mn = fbm(uv, vec2(4.0), 4, 0.55, 12.0);
    float f = vnoise(uv * 96.0, vec2(96.0), 1.0);
    float moss = smoothstep(0.48, 0.58, mn + (0.5 - m.h) * 0.4);
    m.alb = mix(m.alb, srgb(mix(vec3(0.22, 0.34, 0.1), vec3(0.4, 0.52, 0.18), f)), moss);
    m.h += moss * 0.12 * f; m.rough = mix(m.rough, 0.95, moss);`,
  gold_block: `
    vec2 d = min(uv, 1.0 - uv); float edge = min(d.x, d.y);
    float bevel = smoothstep(0.0, 0.07, edge);
    float brushed = vnoise(vec2(uv.x * 3.0, uv.y * 140.0), vec2(3.0, 140.0), 3.0);
    float n = fbm(uv, vec2(4.0), 3, 0.5, 1.0);
    float groove = smoothstep(0.012, 0.0, abs(edge - 0.1));
    m.alb = vec3(1.0, 0.74, 0.32) * (0.9 + 0.1 * n) * (1.0 - 0.3 * groove);
    m.metal = 1.0; m.rough = 0.16 + 0.12 * brushed + 0.15 * (1.0 - bevel);
    m.h = 0.3 + 0.6 * bevel - 0.3 * groove + 0.03 * brushed;`,
  copper_block: `
    vec2 d = min(uv, 1.0 - uv); float edge = min(d.x, d.y);
    float bevel = smoothstep(0.0, 0.06, edge);
    float n = fbm(uv, vec2(3.0), 5, 0.55, 2.0);
    float f = vnoise(uv * 64.0, vec2(64.0), 3.0);
    float ox = smoothstep(0.6, 0.68, n + (1.0 - bevel) * 0.25 + (f - 0.5) * 0.15);
    vec3 cu = vec3(0.95, 0.6, 0.45) * (0.92 + 0.1 * f);
    m.alb = mix(cu, srgb(vec3(0.33, 0.62, 0.52) * (0.85 + 0.3 * f)), ox);
    m.metal = 1.0 - ox; m.rough = mix(0.22 + 0.1 * f, 0.8, ox);
    m.h = 0.35 + 0.5 * bevel + ox * 0.1 + 0.03 * f;`,
  marble: `
    float n = fbm(uv, vec2(2.0), 6, 0.55, 3.0);
    float n2 = fbm(uv, vec2(3.0), 5, 0.5, 8.0);
    float vein = smoothstep(0.035, 0.0, abs(sin((uv.x * 1.0 + uv.y * 2.0 + n * 2.5) * 3.14159 * 2.0)) * 0.3 + (n2 - 0.5) * 0.12);
    float vein2 = smoothstep(0.02, 0.0, abs(sin((uv.x * 3.0 - uv.y + n2 * 3.0) * 3.14159 * 2.0)) * 0.3) * 0.5;
    vec2 d = min(uv, 1.0 - uv); float edge = min(d.x, d.y);
    float seam = 1.0 - smoothstep(0.0, 0.008, edge);
    vec3 c = vec3(0.93, 0.92, 0.9) * (0.95 + 0.05 * n) - vec3(0.4, 0.38, 0.35) * max(vein, vein2);
    m.alb = srgb(c * (1.0 - 0.4 * seam)); m.h = 0.8 - seam * 0.6; m.rough = 0.05 + seam * 0.3 + vein * 0.05;`,
  terracotta: `
    float n = fbm(uv, vec2(4.0), 5, 0.5, 1.0);
    float f = vnoise(uv * 64.0, vec2(64.0), 4.0);
    m.alb = srgb(vec3(0.62, 0.36, 0.25) * (0.9 + 0.14 * n) * (0.96 + 0.06 * f));
    m.h = 0.5 + 0.2 * n + 0.1 * f; m.rough = 0.85;`,
  lamp: `
    vec2 d = min(uv, 1.0 - uv);
    float frame = 1.0 - step(0.09, min(d.x, d.y));
    vec2 g = abs(fract(uv * 2.0) - 0.5);
    float grid = step(0.465, max(g.x, g.y));
    float met = max(frame, grid);
    float n = fbm(uv, vec2(6.0), 3, 0.5, 2.0);
    vec2 cc = abs(fract(uv * 2.0) - 0.5);
    float core = 1.0 - smoothstep(0.1, 0.5, length(cc));
    vec3 glow = mix(vec3(1.0, 0.62, 0.3), vec3(1.0, 0.9, 0.7), core * n);
    m.alb = mix(srgb(glow), srgb(vec3(0.16, 0.15, 0.14)), met);
    m.emit = (1.0 - met) * (0.55 + 0.45 * core);
    m.metal = met * 0.9; m.rough = mix(0.25, 0.45, met);
    m.h = met * 0.7 + (1.0 - met) * (0.2 + 0.1 * n);`,
  cactus_side: `
    float r = 0.5 + 0.5 * cos(uv.x * 6.2832 * 4.0);
    float n = fbm(uv, vec2(4.0, 8.0), 3, 0.5, 2.0);
    vec2 sp = fract(uv * vec2(4.0, 5.0) + vec2(0.5, 0.0)) - 0.5;
    float spine = smoothstep(0.06, 0.02, length(sp * vec2(1.0, 1.4)));
    vec3 c = mix(vec3(0.12, 0.3, 0.1), vec3(0.28, 0.5, 0.2), r * 0.7 + n * 0.3);
    c = mix(c, vec3(0.9, 0.88, 0.7), spine);
    m.alb = srgb(c); m.h = 0.3 + 0.5 * r + 0.3 * spine; m.rough = 0.55;`,
  cactus_top: `
    vec2 p = uv - 0.5; float a = atan(p.y, p.x); float r = length(p);
    float rib = 0.5 + 0.5 * cos(a * 8.0);
    vec3 c = mix(vec3(0.2, 0.42, 0.16), vec3(0.4, 0.58, 0.26), rib * smoothstep(0.45, 0.1, r));
    m.alb = srgb(c); m.h = 0.4 + 0.4 * rib * (1.0 - r); m.rough = 0.55;`,
  torch: `
    float fy = uv.y;
    float xw = abs(uv.x - 0.5);
    if (fy > 0.5625) {
      float g = vnoise(vec2(uv.x * 16.0, uv.y * 40.0), vec2(16.0, 40.0), 1.0);
      m.alb = srgb(mix(vec3(0.3, 0.2, 0.1), vec3(0.45, 0.32, 0.18), g)); m.h = 0.5; m.rough = 0.8;
    } else {
      float t = clamp((fy - 0.35) / 0.2, 0.0, 1.0);
      vec3 c = mix(vec3(1.0, 0.95, 0.75), vec3(1.0, 0.55, 0.12), clamp(xw * 12.0 + (1.0 - t) * 0.3, 0.0, 1.0));
      m.alb = srgb(c); m.emit = 1.0; m.h = 0.6; m.rough = 0.5;
    }`,
  tall_grass: `
    float lum; float a = blades(uv, 12.0, 1.0, 0.045, 0.0, lum);
    m.alpha = a; m.alb = srgb(vec3(lum)); m.h = 0.5 + 0.5 * lum; m.rough = 0.55;`,
  fern: `
    float lum; float a = 0.0; lum = 0.0;
    float t = 1.0 - uv.y;
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      float x0 = 0.5 + (fi - 2.0) * 0.07;
      float lean = (fi - 2.0) * 0.18;
      float hh = 0.75 + 0.25 * hash(vec2(fi, 9.0));
      if (t > hh) continue;
      float cx = x0 + lean * t * t;
      float serr = 0.5 + 0.5 * abs(sin(t * 55.0 + fi));
      float ww = (0.09 * (1.0 - t / hh) + 0.01) * serr;
      float dd = abs(uv.x - cx);
      if (dd < ww) { a = 1.0; lum = (0.45 + 0.5 * t / hh) * (1.0 - 0.3 * step(dd, 0.008)); }
    }
    m.alpha = a; m.alb = srgb(vec3(lum)); m.h = 0.5 + 0.5 * lum; m.rough = 0.55;`,
  poppy: `m = flowerM(uv, 0);`,
  dandelion: `m = flowerM(uv, 1);`,
  cornflower: `m = flowerM(uv, 2);`,
  daisy: `m = flowerM(uv, 3);`,
  allium: `m = flowerM(uv, 4);`,
  dead_bush: `
    float a = 0.0;
    for (int i = 0; i < 9; i++) {
      float fi = float(i);
      vec2 p0 = vec2(0.5 + (hash(vec2(fi, 1.0)) - 0.5) * 0.2, 1.0 - hash(vec2(fi, 2.0)) * 0.35);
      vec2 p1 = p0 + vec2((hash(vec2(fi, 3.0)) - 0.5) * 0.9, -0.25 - hash(vec2(fi, 4.0)) * 0.45);
      if (segDist(uv, p0, p1) < 0.018) a = 1.0;
      if (segDist(uv, vec2(0.5, 1.0), p0) < 0.022) a = 1.0;
    }
    m.alpha = a; m.alb = srgb(vec3(0.42, 0.3, 0.17) * (0.8 + 0.3 * vnoise(uv * 32.0, vec2(32.0), 1.0))); m.rough = 0.8;`,
  seagrass: `
    float lum; float a = blades(uv, 9.0, 4.0, 0.05, 0.05, lum);
    m.alpha = a; m.alb = srgb(mix(vec3(0.08, 0.25, 0.08), vec3(0.3, 0.55, 0.2), lum)); m.h = lum; m.rough = 0.4;`,
  glow_mushroom: `
    m.alpha = 0.0;
    float stem = step(abs(uv.x - 0.5), 0.05) * step(0.5, uv.y);
    if (stem > 0.5) { m.alpha = 1.0; m.alb = srgb(vec3(0.8, 0.82, 0.75)); m.emit = 0.15; }
    vec2 q = (uv - vec2(0.5, 0.52)) / vec2(0.3, 0.2);
    if (length(q) < 1.0 && q.y < 0.15) {
      float spot = step(0.8, vnoise(uv * 24.0, vec2(24.0), 2.0));
      m.alpha = 1.0; m.alb = srgb(mix(vec3(0.1, 0.55, 0.6), vec3(0.5, 1.0, 0.95), spot));
      m.emit = 0.45 + 0.55 * spot; m.h = 1.0 - length(q);
    }
    m.rough = 0.45;`,
  pink_petals: `
    float s1, v1, s2, v2;
    float a1 = leafLayer(uv, 7.0, 31.0, 0.12, 0.09, s1, v1);
    float a2 = leafLayer(uv, 11.0, 37.0, 0.1, 0.08, s2, v2);
    float h = max(a1, a2);
    float keep = step(0.45, hash(floor(uv * 7.0) + 2.0));
    m.alpha = step(0.02, a1) * keep + step(0.02, a2) * step(0.5, s2);
    m.alpha = clamp(m.alpha, 0.0, 1.0);
    m.alb = srgb(mix(vec3(0.95, 0.62, 0.78), vec3(1.0, 0.82, 0.9), max(s1, s2)));
    m.h = h; m.rough = 0.5;`,
  water: `m.alb = srgb(vec3(0.1, 0.3, 0.5)); m.alpha = 0.6; m.rough = 0.02;`,
};

function oreMacro(body) {
  return body.replace(/ORE\(([^;]*?)\)$/m, (_, args) => {
    const [col, rough, metal, seed] = args.split(/,(?![^()]*\))/).map((s) => s.trim());
    return `{
      vec4 v = voronoi(uv * 5.0, vec2(5.0), ${seed}, 1.0);
      float grain = vnoise(uv * 40.0, vec2(40.0), ${seed} + 2.0);
      float blob = smoothstep(0.34, 0.2, v.x) * step(0.4, v.z) * smoothstep(0.25, 0.55, grain + 0.25);
      m.alb = mix(m.alb, srgb(${col} * (0.75 + 0.45 * grain)), blob);
      m.h = m.h + blob * 0.3;
      m.rough = mix(m.rough, ${rough}, blob);
      m.metal = blob * ${metal};
    }`;
  });
}

function materialShader(name) {
  const body = oreMacro(MAT[name] ?? '');
  return `#version 300 es
precision highp float;
precision highp int;
in vec2 vUV;
uniform float uRes;
layout(location = 0) out vec4 oAlbedo;
layout(location = 1) out vec4 oHeight;
layout(location = 2) out vec4 oMat;
${LIB}
M mat(vec2 uv) {
  M m = mdef();
${body}
  return m;
}
void main() {
  vec2 uv = (floor(gl_FragCoord.xy) + 0.5) / uRes;
  M m = mat(uv);
  oAlbedo = vec4(clamp(m.alb, 0.0, 1.0), clamp(m.alpha, 0.0, 1.0));
  oHeight = vec4(clamp(m.h, 0.0, 1.0), 0.0, 0.0, 1.0);
  float ao = mix(0.55, 1.0, clamp(m.h * 1.4, 0.0, 1.0));
  oMat = vec4(clamp(m.rough, 0.02, 1.0), clamp(m.metal, 0.0, 1.0), clamp(m.emit, 0.0, 1.0), ao);
}`;
}

// Normal map from the height field (wrapping), height kept in alpha.
const NORMAL_FS = `#version 300 es
precision highp float;
uniform sampler2D uHeight;
uniform float uRes;
uniform float uNormDepth;
out vec4 o;
float h(ivec2 p) { int n = int(uRes); return texelFetch(uHeight, ivec2((p.x + n) % n, (p.y + n) % n), 0).r; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float e = 1.0 / uRes;
  vec2 s = vec2(h(p + ivec2(1, 0)) - h(p - ivec2(1, 0)), h(p + ivec2(0, 1)) - h(p - ivec2(0, 1))) * uNormDepth / (2.0 * e);
  vec3 n = normalize(vec3(-s, 1.0));
  o = vec4(n * 0.5 + 0.5, h(p));
}`;

// Build the three block texture arrays on the GPU.
export function generateBlockTextures(gl, res, aniso) {
  const L = TEX_NAMES.length;
  const levels = Math.floor(Math.log2(res)) + 1;
  const mk = (ifmt) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, ifmt, res, res, L);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    return t;
  };
  const albedo = mk(gl.SRGB8_ALPHA8), normal = mk(gl.RGBA8), material = mk(gl.RGBA8);
  // Compile every material program first so drivers with parallel compilation can overlap them.
  const progs = TEX_NAMES.map((name) => new Program(gl, FS_TRI_VS, materialShader(name), 'tex:' + name));
  const nprog = new Program(gl, FS_TRI_VS, NORMAL_FS, 'texNormal');
  const hTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, hTex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16F, res, res);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const fb = gl.createFramebuffer();
  const fbN = gl.createFramebuffer();
  gl.viewport(0, 0, res, res);
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
  const info = [];
  for (let i = 0; i < L; i++) {
    const prog = progs[i];
    prog.check();
    prog.use().f('uRes', res);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, albedo, 0, i);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, hTex, 0);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, material, 0, i);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const ti = TEX_INFO[TEX_NAMES[i]] ?? I(0, 0.03, 0.3, 0);
    nprog.check();
    nprog.use().f('uRes', res).f('uNormDepth', ti.nd).tex('uHeight', hTex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbN);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, normal, 0, i);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    info.push(ti);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb); gl.deleteFramebuffer(fbN);
  gl.deleteTexture(hTex);
  for (const p of progs) gl.deleteProgram(p.prog);
  gl.deleteProgram(nprog.prog);
  for (const t of [albedo, normal, material]) {
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  }
  // Per-layer uniform data: (pom depth, flags, porosity, emission)
  const layerInfo = new Float32Array(64 * 4);
  info.forEach((ti, i) => { layerInfo.set([ti.pom, ti.f, ti.por, ti.em], i * 4); });
  return { albedo, normal, material, layerInfo, res, count: L };
}
