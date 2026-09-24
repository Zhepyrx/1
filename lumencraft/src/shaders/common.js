// Shared GLSL chunks.

export const HEADER = /* glsl */`#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
precision highp sampler2DArray;
precision highp sampler2DArrayShadow;
#define PI 3.14159265359
#define TAU 6.28318530718
`;

export const UTIL = /* glsl */`
float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3) { p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash33(vec3 p3) { p3 = fract(p3 * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float vnoise2(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p); vec3 u = f * f * (3.0 - 2.0 * f);
  float a = hash13(i), b = hash13(i + vec3(1, 0, 0)), c = hash13(i + vec3(0, 1, 0)), d = hash13(i + vec3(1, 1, 0));
  float e = hash13(i + vec3(0, 0, 1)), f1 = hash13(i + vec3(1, 0, 1)), g = hash13(i + vec3(0, 1, 1)), h = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, f1, u.x), mix(g, h, u.x), u.y), u.z);
}
float fbm2(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise2(p); p = p * 2.03 + 17.1; a *= 0.5; } return s / 0.9375; }
float fbm3(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise3(p); p = p * 2.03 + 17.1; a *= 0.5; } return s / 0.9375; }
vec2 signNZ(vec2 v) { return vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0); }
vec2 octEncode(vec3 n) { n /= (abs(n.x) + abs(n.y) + abs(n.z)); vec2 e = n.xy; if (n.z < 0.0) e = (1.0 - abs(n.yx)) * signNZ(n.xy); return e; }
vec3 octDecode(vec2 e) { vec3 n = vec3(e, 1.0 - abs(e.x) - abs(e.y)); float t = max(-n.z, 0.0); n.xy += vec2(n.x >= 0.0 ? -t : t, n.y >= 0.0 ? -t : t); return normalize(n); }
float remap(float v, float l0, float h0, float l1, float h1) { return l1 + (v - l0) * (h1 - l1) / (h0 - l0); }
float hgPhase(float c, float g) { float g2 = g * g; return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5)); }
const vec3 COOL_LIGHT = vec3(0.2, 0.7, 1.0);
vec2 vogel(int i, int n, float phi) { float r = sqrt((float(i) + 0.5) / float(n)); float th = float(i) * 2.39996323 + phi; return r * vec2(cos(th), sin(th)); }
`;

// Frame-wide uniforms used by many passes.
export const FRAME = /* glsl */`
uniform vec2 uRes;
uniform mat4 uInvVP;
uniform mat4 uVPnj;
uniform mat4 uPrevVP;
uniform vec3 uCamPos;
uniform float uNear, uFar;
uniform float uTime;
uniform int uFrame;
uniform vec3 uSunDir, uMoonDir, uLightDir, uLightColor;
uniform float uNight;
uniform float uCamAltKm;
uniform float uRenderDist;
uniform float uHaze, uMist, uMistY, uRain, uWetness;
uniform float uUnderwater;
uniform vec3 uWaterSA, uWaterSS;
#define WATER_SA uWaterSA
#define WATER_SS uWaterSS
float linearDepth(float d) { return uNear * uFar / (uFar - d * (uFar - uNear)); }
vec3 relFromDepth(vec2 uv, float d) { vec4 p = uInvVP * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return p.xyz / p.w; }
vec3 viewRay(vec2 uv) { vec4 p = uInvVP * vec4(uv * 2.0 - 1.0, 1.0, 1.0); return normalize(p.xyz / p.w); }
float frameNoise(vec2 px) { return ign(px + float(uFrame % 64) * 5.588238); }
`;

// Physically based atmosphere (Hillaire 2020), units in km.
export const ATMOS = /* glsl */`
const float Rg = 6360.0, Rt = 6460.0;
const vec3 RAY_S = vec3(5.802, 13.558, 33.1) * 1e-3;
const float RAY_H = 8.0;
const float MIE_S = 3.996e-3, MIE_E = 4.40e-3, MIE_H = 1.2;
const vec3 OZO_A = vec3(0.650, 1.881, 0.085) * 1e-3;
void medium(float h, out vec3 rayS, out float mieS, out vec3 ext) {
  float dr = exp(-h / RAY_H), dm = exp(-h / MIE_H);
  float doz = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  rayS = RAY_S * dr; mieS = MIE_S * dm;
  ext = rayS + MIE_E * dm + OZO_A * doz;
}
// distance to sphere of radius r from ro (|ro| >= 0) along rd; returns far hit or -1
float sphereFar(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd), c = dot(ro, ro) - r * r, d = b * b - c;
  if (d < 0.0) return -1.0;
  return -b + sqrt(d);
}
float sphereNear(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd), c = dot(ro, ro) - r * r, d = b * b - c;
  if (d < 0.0) return -1.0;
  float t = -b - sqrt(d);
  return t > 0.0 ? t : -1.0;
}
float rayleighPhase(float c) { return 3.0 / (16.0 * PI) * (1.0 + c * c); }
float miePhase(float c) {
  const float g = 0.8; float g2 = g * g;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + c * c)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
`;

export const ATMOS_SAMPLE = /* glsl */`
uniform sampler2D uTrans;
uniform sampler2D uSkyView;
uniform sampler2D uIrr;
uniform float uSunIllum, uMoonIllum;
vec3 transmittance(float hKm, float mu) {
  return texture(uTrans, vec2(0.5 + 0.5 * sign(mu) * sqrt(abs(mu)), sqrt(clamp(hKm / 100.0, 0.0, 1.0)))).rgb;
}
vec2 dirToSkyUV(vec3 d) {
  float az = atan(d.z, d.x);
  float el = asin(clamp(d.y, -1.0, 1.0));
  return vec2(az / TAU + 0.5, 0.5 + 0.5 * sign(el) * sqrt(abs(el) / (0.5 * PI)));
}
vec3 skyLUT(vec3 d) { return textureLod(uSkyView, dirToSkyUV(d), 0.0).rgb; }
vec3 skyLUTBlur(vec3 d, float lod) { return textureLod(uSkyView, dirToSkyUV(d), lod).rgb; }
vec2 dirToIrrUV(vec3 d) { return vec2(atan(d.z, d.x) / TAU + 0.5, acos(clamp(d.y, -1.0, 1.0)) / PI); }
vec3 irradiance(vec3 n) { return texture(uIrr, dirToIrrUV(n)).rgb; }
`;

// Sun, moon, stars, milky way, aurora.
// Sky pieces sampled per pixel: sun, moon, star points, plus the baked panorama (clouds, Milky Way, aurora).
export const CLOUD_SAMPLE = /* glsl */`
uniform sampler2D uCloudPano;
uniform sampler2D uSkyExtra;
uniform sampler2D uCloudShadow;
uniform vec4 uCSM;
vec2 panoUV(vec3 d) {
  float az = atan(d.z, d.x);
  float el = asin(clamp(d.y, -1.0, 1.0));
  return vec2(az / TAU + 0.5, 0.5 + 0.5 * sign(el) * sqrt(abs(el) / (0.5 * PI)));
}
vec4 cloudsAt(vec3 d) { return texture(uCloudPano, panoUV(d)); }
vec3 skyExtraAt(vec3 d) { return texture(uSkyExtra, panoUV(d)).rgb; }
// sunlight transmittance through the cloud layer, from a 2D map projected along the light
float cloudShadowAt(vec3 wp) {
  vec3 L = uLightDir;
  float ly = max(L.y, 0.06);
  vec2 xz = wp.xz - L.xz * ((wp.y - uCSM.w) / ly);
  vec2 uv = (xz - uCSM.xy) / uCSM.z;
  // beyond the map, fade to its mean (last mip) so distant fog and terrain don't switch to full sun
  vec2 e = min(uv, 1.0 - uv);
  float s = mix(textureLod(uCloudShadow, vec2(0.5), 9.0).r, textureLod(uCloudShadow, uv, 0.0).r, smoothstep(0.0, 0.12, min(e.x, e.y)));
  return mix(1.0, s, smoothstep(0.0, 0.08, L.y));
}
`;

export const SKY = /* glsl */`
uniform mat3 uStarRot;
vec3 sunDisc(vec3 d) {
  const float r = 0.0085;
  float c = dot(d, uSunDir);
  if (c < cos(r * 1.25)) return vec3(0.0);
  float t = acos(clamp(c, -1.0, 1.0)) / r;
  float limb = 1.0 - 0.55 * (1.0 - sqrt(max(1.0 - t * t, 0.0)));
  float edge = smoothstep(1.05, 0.95, t);
  vec3 T = transmittance(uCamAltKm, uSunDir.y);
  return T * uSunIllum * 1600.0 * limb * edge;
}
vec3 moonDisc(vec3 d) {
  const float r = 0.011;
  vec3 md = uMoonDir;
  vec3 right = normalize(cross(md, vec3(0.0, 1.0, 0.0) + 1e-4));
  vec3 up = cross(right, md);
  vec3 dd = d - md * dot(d, md);
  vec2 q = vec2(dot(dd, right), dot(dd, up)) / r;
  float r2 = dot(q, q);
  if (dot(d, md) < 0.0 || r2 > 1.1) return vec3(0.0);
  float aa = smoothstep(1.02, 0.96, sqrt(r2));
  vec3 n = normalize(right * q.x + up * q.y - md * sqrt(max(1.0 - r2, 0.0)));
  vec2 mq = q * 1.7;
  float maria = smoothstep(0.45, 0.62, fbm2(mq * 1.3 + 3.1));
  float crater = 0.0;
  for (int i = 0; i < 6; i++) {
    vec2 c = hash22(vec2(float(i), 3.0)) * 2.0 - 1.0; float rr = 0.08 + 0.12 * hash12(vec2(float(i), 7.0));
    crater += smoothstep(rr, rr * 0.6, length(q - c * 0.7)) * 0.25;
  }
  float alb = 0.22 - 0.1 * maria + 0.05 * fbm2(mq * 8.0) - crater * 0.05;
  float lit = max(dot(n, uSunDir), 0.0);
  vec3 T = transmittance(uCamAltKm, max(md.y, 0.0));
  return T * (alb * lit * 60.0 + 0.012) * aa * vec3(1.0, 0.97, 0.92) * step(-0.02, md.y);
}
vec3 starPoints(vec3 d) {
  vec3 s = uStarRot * d;
  vec3 col = vec3(0.0);
  for (int layer = 0; layer < 2; layer++) {
    float sc = layer == 0 ? 160.0 : 320.0;
    vec3 p = s * sc; vec3 cell = floor(p); vec3 f = fract(p) - 0.5;
    float h = hash13(cell + float(layer) * 91.7);
    float thr = layer == 0 ? 0.9955 : 0.9985;
    if (h > thr) {
      vec3 o = hash33(cell) - 0.5;
      float dist = length(f - o * 0.6);
      float b = pow((h - thr) / (1.0 - thr), 3.0) * (layer == 0 ? 1.0 : 2.5);
      float tw = 0.6 + 0.4 * sin(uTime * (2.0 + h * 9.0) + h * 300.0);
      vec3 tint = mix(vec3(0.65, 0.78, 1.0), vec3(1.0, 0.82, 0.62), fract(h * 137.0));
      col += tint * b * tw * smoothstep(0.3, 0.0, dist) * 1.6;
    }
  }
  return col * 0.2;
}
uniform float uRainbow;
vec3 hue(float h) { return saturate(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0); }
// Primary (42 deg, red outside) and secondary (51 deg, reversed) bows around the antisolar point,
// with the brighter sky inside the primary and Alexander's dark band between the two.
vec3 rainbow(vec3 d, vec3 sky) {
  if (uRainbow <= 0.001 || d.y < -0.01) return vec3(0.0);
  float ang = degrees(acos(clamp(dot(d, -uSunDir), -1.0, 1.0)));
  float p = (ang - 40.3) / 2.5, q = (53.4 - ang) / 3.4;
  vec3 col = hue((1.0 - p) * 0.78) * smoothstep(0.0, 0.18, p) * smoothstep(1.0, 0.8, p);
  col += hue((1.0 - q) * 0.78) * smoothstep(0.0, 0.18, q) * smoothstep(1.0, 0.8, q) * 0.38;
  float inside = smoothstep(40.5, 24.0, ang) * smoothstep(8.0, 20.0, ang) * 0.14;
  float band = smoothstep(42.5, 44.0, ang) * smoothstep(50.5, 49.0, ang) * 0.1;
  return (col * 0.55 + inside - band) * luma(sky) * uRainbow * smoothstep(-0.01, 0.06, d.y);
}
// A couple of meteors per minute: a short bright streak with a fading tail.
vec3 meteors(vec3 d) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 2; i++) {
    float period = 11.0 + float(i) * 6.0;
    float tt = uTime / period + float(i) * 0.37;
    float id = floor(tt), ph = fract(tt);
    const float dur = 0.07;
    if (ph > dur) continue;
    vec3 h = hash33(vec3(id, float(i), 7.0));
    vec3 start = normalize(vec3(h.x * 2.0 - 1.0, 0.4 + h.y * 0.55, h.z * 2.0 - 1.0));
    vec3 axis = normalize(cross(start, normalize(vec3(h.z - 0.5, -0.6, h.x - 0.5))));
    float k = ph / dur;
    float a = k * 0.3;
    vec3 head = start * cos(a) + cross(axis, start) * sin(a) + axis * dot(axis, start) * (1.0 - cos(a));
    vec3 dir = normalize(cross(axis, head));
    vec3 rel = d - head;
    float along = -dot(rel, dir);
    if (along < 0.0 || along > 0.1) continue;
    float across = length(rel + dir * along);
    float I = exp(-across * across / 1.6e-6) * (1.0 - along / 0.1) * sin(k * 3.14159);
    acc += vec3(0.85, 0.92, 1.0) * I * 0.9;
  }
  return acc;
}
vec3 skyFull(vec3 d, bool withDiscs) {
  vec3 c = skyLUT(d);
  if (withDiscs) {
    float night = uNight;
    if (night > 0.0 && d.y > 0.0) {
      vec3 T = transmittance(uCamAltKm, max(d.y, 0.02));
      c += (starPoints(d) + skyExtraAt(d) + meteors(d)) * night * T;
    }
    c += sunDisc(d) + moonDisc(d) * night;
    c += rainbow(d, c);
  }
  return c;
}
// sky with the cloud panorama composited in front
vec3 skyWithClouds(vec3 d, bool withDiscs) {
  vec3 c = skyFull(d, withDiscs);
  vec4 cl = cloudsAt(d);
  return c * cl.a + cl.rgb;
}
`;

// Baked into the sky panorama: Milky Way and aurora (smooth, so a low update rate is invisible).
export const SKY_EXTRAS = /* glsl */`
uniform mat3 uStarRot;
uniform float uAurora;
vec3 milkyWay(vec3 d) {
  vec3 s = uStarRot * d;
  vec3 mwN = normalize(vec3(0.3, 0.55, -0.78));
  float bd = dot(s, mwN);
  float band = exp(-bd * bd * 22.0);
  if (band < 0.002) return vec3(0.0);
  float detail = fbm3(s * 7.0);
  float dust = smoothstep(0.45, 0.7, fbm3(s * 16.0 + 3.0)) * exp(-bd * bd * 90.0);
  vec3 mw = mix(vec3(0.45, 0.5, 0.75), vec3(0.8, 0.7, 0.6), detail) * band * (0.3 + 0.9 * detail) * (1.0 - 0.75 * dust);
  float coreDir = pow(max(dot(s, normalize(vec3(0.8, 0.2, 0.55))), 0.0), 6.0);
  return mw * (1.0 + 2.5 * coreDir) * 0.0056;
}
vec3 aurora(vec3 d, float jit) {
  if (d.y < 0.05 || uAurora <= 0.001) return vec3(0.0);
  vec3 acc = vec3(0.0);
  float t = uTime * 0.05;
  for (int i = 0; i < 28; i++) {
    float fi = (float(i) + jit) / 28.0;
    float h = 1.0 + fi * 1.4;
    vec2 p = d.xz / (d.y + 0.08) * h;
    float w = fbm2(p * 0.35 + vec2(t, -t * 0.7)) * 3.0;
    float bandCoord = p.x * 0.45 + p.y * 0.2 + w + sin(p.y * 0.25 + t * 2.0) * 1.3;
    float curtain = pow(1.0 - abs(sin(bandCoord * 1.4)), 10.0) + 0.35 * pow(1.0 - abs(sin(bandCoord * 0.7 + 1.1)), 5.0);
    float mask = smoothstep(0.35, 0.75, fbm2(p * 0.12 + vec2(t * 0.4, 0.0)));
    float fade = exp(-fi * 2.2) * (1.0 - exp(-fi * 30.0));
    vec3 col = mix(vec3(0.15, 1.0, 0.45), vec3(0.55, 0.25, 1.0), smoothstep(0.25, 0.9, fi));
    acc += col * curtain * mask * fade;
  }
  float north = smoothstep(-0.4, 0.6, -d.z);
  return acc * 0.077 * uAurora * smoothstep(0.1, 0.42, d.y) * north;
}
`;

// Cascaded shadow maps with PCSS.
export const SHADOW = /* glsl */`
uniform sampler2DArrayShadow uShadow;
uniform sampler2DArray uShadowRaw;
uniform mat4 uShadowMat[4];
uniform vec4 uCascadeFar;
uniform vec4 uCascadeTexel;
uniform vec4 uCascadeDepth;
uniform vec4 uCascadeSize;
uniform float uShadowRes;
uniform float uLightAngle;
uniform int uPcssCascades;
uniform vec4 uCascadeLayer;
int cascadeFor(float z, float dither) {
  for (int c = 0; c < 4; c++) { if (z < uCascadeFar[c] * (1.0 - 0.12 * dither)) return c; }
  return 4;
}
float shadowSample(vec3 rel, vec3 N, float NoL, float viewZ, float noise, bool pcss, out float thick) {
  thick = 0.0;
  int c = cascadeFor(viewZ, noise);
  if (c > 3) return 1.0;
  float texel = uCascadeTexel[c];
  vec3 p = rel + N * texel * (1.2 + 2.5 * (1.0 - saturate(NoL)));
  vec3 s = (uShadowMat[c] * vec4(p, 1.0)).xyz * 0.5 + 0.5;
  if (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0 || s.z > 1.0) return 1.0;
  float z = s.z - 0.08 / uCascadeDepth[c];
  float phi = noise * TAU;
  float fc = uCascadeLayer[c];
  float raw = texture(uShadowRaw, vec3(s.xy, fc)).r;
  thick = max(z - raw, 0.0) * uCascadeDepth[c];
  if (!pcss || c >= uPcssCascades) {
    float sum = 0.0;
    float r = 1.5 / uShadowRes;
    for (int i = 0; i < 4; i++) sum += texture(uShadow, vec4(s.xy + vogel(i, 4, phi) * r, fc, z));
    return sum * 0.25;
  }
  float searchR = min(uLightAngle * 24.0 / uCascadeSize[c], 40.0 / uShadowRes);
  float avgB = 0.0, nB = 0.0;
  for (int i = 0; i < 6; i++) {
    float d = texture(uShadowRaw, vec3(s.xy + vogel(i, 6, phi) * searchR, fc)).r;
    if (d < z) { avgB += d; nB += 1.0; }
  }
  if (nB == 0.0) return 1.0;
  avgB /= nB;
  float pen = (z - avgB) * uCascadeDepth[c] * uLightAngle / uCascadeSize[c];
  pen = clamp(pen, 1.0 / uShadowRes, searchR);
  float sum = 0.0;
  for (int i = 0; i < 10; i++) sum += texture(uShadow, vec4(s.xy + vogel(i, 10, phi + 1.3) * pen, fc, z));
  return sum * 0.1;
}
float shadowFast(vec3 rel, float dist) {
  int c = cascadeFor(dist, 0.0);
  if (c > 3) return 1.0;
  vec3 s = (uShadowMat[c] * vec4(rel, 1.0)).xyz * 0.5 + 0.5;
  if (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0 || s.z > 1.0) return 1.0;
  return texture(uShadow, vec4(s.xy, uCascadeLayer[c], s.z - 0.25 / uCascadeDepth[c]));
}
`;

// Cloud density field shared by the cloud raymarcher and cloud shadows.
export const CLOUD_FIELD = /* glsl */`
uniform sampler3D uCloudShape;
uniform sampler3D uCloudDetail;
uniform sampler2D uWeather;
uniform float uCloudBottom, uCloudTop, uCloudCoverage, uCloudDensity;
uniform vec3 uWindOffset;
float cloudField(vec3 p, float hf, bool detail) {
  vec3 wp = p + uWindOffset;
  vec4 w = textureLod(uWeather, wp.xz / 24000.0, 0.0);
  float cov = saturate(w.r * 1.15 + (uCloudCoverage - 0.5) * 1.3);
  float type = w.g;
  float prof = smoothstep(0.0, 0.08 + 0.1 * type, hf) * (1.0 - smoothstep(mix(0.35, 0.7, type), 1.0, hf));
  vec4 s = texture(uCloudShape, wp * vec3(1.0, 1.4, 1.0) / 3200.0);
  float fbmW = s.g * 0.625 + s.b * 0.25 + s.a * 0.125;
  float base = remap(s.r, fbmW - 1.0, 1.0, 0.0, 1.0) * prof;
  float d = remap(base, 1.0 - cov, 1.0, 0.0, 1.0) * cov;
  if (d <= 0.0) return 0.0;
  if (detail) {
    vec3 dn = texture(uCloudDetail, wp / 380.0 + vec3(0.0, uTime * 0.004, 0.0)).rgb;
    float df = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    df = mix(df, 1.0 - df, saturate(hf * 3.0));
    d = remap(d, df * 0.32, 1.0, 0.0, 1.0);
  }
  return max(d, 0.0) * uCloudDensity;
}
`;

// Exponential height fog / valley mist.
export const FOG = /* glsl */`
uniform sampler3D uFogNoise;
uniform vec3 uFogTint;
float fogDensity(vec3 wp) {
  float h = wp.y;
  float d = uHaze * exp(-max(h - 60.0, 0.0) / 140.0);
  float mistN = 0.5 + 0.5 * texture(uFogNoise, vec3(wp.xz * 0.012 + vec2(uTime * 0.004, 0.0), wp.y * 0.02 + uTime * 0.003)).r;
  d += uMist * exp(-max(h - uMistY, 0.0) / 9.0) * mistN;
  d += uRain * 0.004;
  return d;
}
`;

export const BRDF = /* glsl */`
float D_GGX(float NoH, float a) { float a2 = a * a; float f = (NoH * a2 - NoH) * NoH + 1.0; return a2 / (PI * f * f); }
float V_Smith(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}
vec3 F_Schlick(vec3 f0, float VoH) { float f = pow(1.0 - VoH, 5.0); return f0 + (1.0 - f0) * f; }
vec2 envBRDF(float NoV, float rough) {
  vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022), c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  return vec2(-1.04, 1.04) * a004 + r.zw;
}
`;
