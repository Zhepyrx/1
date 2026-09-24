// Volumetric cloud noise generation, raymarching and temporal resolve.
import { HEADER, UTIL, FRAME, ATMOS_SAMPLE, CLOUD_FIELD, SKY_EXTRAS } from './common.js';

const TILE_NOISE = /* glsl */`
vec3 thash(vec3 p) { return hash33(p + 0.123); }
float worley3(vec3 p, float per) {
  vec3 id = floor(p), f = fract(p);
  float md = 1.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 r = g + thash(mod(id + g, per)) - f;
    md = min(md, dot(r, r));
  }
  return 1.0 - sqrt(md);
}
float worleyFbm(vec3 p, float f) { return worley3(p * f, f) * 0.625 + worley3(p * f * 2.0, f * 2.0) * 0.25 + worley3(p * f * 4.0, f * 4.0) * 0.125; }
float pnoise3(vec3 p, float per) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash13(mod(i, per)), b = hash13(mod(i + vec3(1, 0, 0), per));
  float c = hash13(mod(i + vec3(0, 1, 0), per)), d = hash13(mod(i + vec3(1, 1, 0), per));
  float e = hash13(mod(i + vec3(0, 0, 1), per)), g = hash13(mod(i + vec3(1, 0, 1), per));
  float h = hash13(mod(i + vec3(0, 1, 1), per)), k = hash13(mod(i + vec3(1, 1, 1), per));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}
float perlinFbm(vec3 p, float f, int oct) {
  float s = 0.0, a = 1.0, n = 0.0;
  for (int i = 0; i < 7; i++) { if (i >= oct) break; s += a * pnoise3(p * f, f); n += a; a *= 0.5; f *= 2.0; }
  return s / n;
}
`;

export const cloudShapeFS = HEADER + UTIL + TILE_NOISE + /* glsl */`
uniform float uZ;
out vec4 o;
void main() {
  vec3 p = vec3(gl_FragCoord.xy / 128.0, uZ);
  float per = perlinFbm(p, 4.0, 6);
  per = abs(per * 2.0 - 1.0);
  per = 1.0 - per;
  float w0 = worleyFbm(p, 4.0);
  float pw = remap(per, 0.0, 1.0, w0, 1.0);
  o = vec4(saturate(pw), worleyFbm(p, 4.0), worleyFbm(p, 8.0), worleyFbm(p, 16.0));
}`;

export const cloudDetailFS = HEADER + UTIL + TILE_NOISE + /* glsl */`
uniform float uZ;
out vec4 o;
void main() {
  vec3 p = vec3(gl_FragCoord.xy / 32.0, uZ);
  o = vec4(worleyFbm(p, 2.0), worleyFbm(p, 4.0), worleyFbm(p, 8.0), 1.0);
}`;

export const weatherFS = HEADER + UTIL + TILE_NOISE + /* glsl */`
out vec4 o;
float pn2(vec2 p, vec2 per) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(mod(i, per)), b = hash12(mod(i + vec2(1, 0), per));
  float c = hash12(mod(i + vec2(0, 1), per)), d = hash12(mod(i + vec2(1, 1), per));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
void main() {
  vec2 uv = gl_FragCoord.xy / 512.0;
  float cov = perlinFbm(vec3(uv, 0.5), 5.0, 5);
  float w = worley3(vec3(uv * 9.0, 0.5 * 9.0), 9.0);
  cov = saturate(remap(cov, 0.35, 0.8, 0.0, 1.0)) * (0.55 + 0.45 * w);
  float type = perlinFbm(vec3(uv, 0.1), 3.0, 3);
  // cirrus: long wind-combed streaks
  vec2 per = vec2(3.0, 14.0);
  vec2 q = uv * per;
  float warp = pn2(uv * vec2(4.0, 4.0), vec2(4.0)) * 2.0;
  float ci = 0.0, amp = 0.5, n = 0.0;
  for (int k = 0; k < 5; k++) { ci += amp * pn2(q + vec2(warp, 0.0) * float(k + 1), per); n += amp; amp *= 0.55; per *= 2.0; q *= 2.0; }
  ci /= n;
  o = vec4(saturate(cov * 1.25), saturate(type * 1.4 - 0.2), saturate(remap(ci, 0.42, 0.82, 0.0, 1.0)), 1.0);
}`;

const HIT_ALT = /* glsl */`
const float KCURV = 1.0 / (2.0 * 6360000.0);
// distance along ray to altitude H using a parabolic earth-curvature approximation
bool hitAlt(float a, float dy, float H, out float t) {
  float k = KCURV * (1.0 - dy * dy);
  float c = a - H;
  float disc = dy * dy - 4.0 * k * c;
  if (disc < 0.0) return false;
  float sq = sqrt(disc);
  float q = -0.5 * (dy + (dy >= 0.0 ? sq : -sq));
  if (abs(q) < 1e-12) return false;
  float r0 = q / max(k, 1e-12), r1 = c / q;
  float t0 = min(r0, r1), t1 = max(r0, r1);
  if (k < 1e-12) { t0 = t1 = -c / dy; }
  t = t0 > 0.0 ? t0 : t1;
  return t > 0.0;
}
`;

// Camera-centred sky panorama: clouds (rgb in-scatter, a transmittance) and night-sky extras.
// Each frame refreshes one texel of every 4x4 block (Bayer order), or of every other block at high
// panorama resolutions; a full refresh takes 16 or 32 frames.
export const cloudPanoFS = HEADER + UTIL + FRAME + ATMOS_SAMPLE + CLOUD_FIELD + SKY_EXTRAS + HIT_ALT + /* glsl */`
uniform vec2 uPanoRes;
uniform int uPhase, uPhases;
uniform float uFull;
uniform int uCloudSteps;
uniform float uCirrus;
layout(location = 0) out vec4 oCloud;
layout(location = 1) out vec4 oExtra;
const int BAYER[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);

vec4 cirrusLayer(vec3 rd, vec3 sunCol, vec3 amb, float cosT) {
  float t;
  if (!hitAlt(uCamPos.y, rd.y, 7600.0, t) || t > 160000.0) return vec4(0.0, 0.0, 0.0, 1.0);
  vec2 xz = uCamPos.xz + rd.xz * t + uWindOffset.xz * 2.6;
  // footprint of one panorama texel on the cirrus deck, so the thin streaks are filtered, not aliased
  float el = asin(clamp(rd.y, -1.0, 1.0));
  vec3 tAz = normalize(vec3(-rd.z, 0.0, rd.x));
  vec2 dA = tAz.xz * (TAU / uPanoRes.x) * cos(el) * t;
  vec3 rdE = normalize(rd + cross(tAz, rd) * (sqrt(abs(el) / (0.5 * PI)) * TAU / uPanoRes.y));
  float tE;
  vec2 dE = hitAlt(uCamPos.y, rdE.y, 7600.0, tE) ? rdE.xz * tE - rd.xz * t : dA;
  float c = textureGrad(uWeather, xz / 52000.0, dA / 52000.0, dE / 52000.0).b;
  c *= smoothstep(0.0, 0.6, textureGrad(uWeather, xz / 170000.0 + 0.37, dA / 170000.0, dE / 170000.0).r + uCirrus - 0.5) * uCirrus;
  if (c <= 0.001) return vec4(0.0, 0.0, 0.0, 1.0);
  float a = c * 0.42;
  float ph = mix(hgPhase(cosT, 0.65), 1.0 / (4.0 * PI), 0.4);
  vec3 S = sunCol * ph * 5.0 + amb * 0.8;
  float fade = exp(-t / mix(60000.0, 20000.0, uRain));
  return vec4(S * a * fade, 1.0 - a * fade);
}

vec4 traceClouds(vec3 rd, float jit) {
  float a = uCamPos.y, B = uCloudBottom, TT = uCloudTop;
  float t0 = 0.0, t1 = 0.0;
  bool ok = true;
  if (a < B) {
    float tb, tt;
    ok = hitAlt(a, rd.y, B, tb) && hitAlt(a, rd.y, TT, tt);
    t0 = tb; t1 = tt;
  } else if (a < TT) {
    float tt, tb;
    if (rd.y < 0.0 && hitAlt(a, rd.y, B, tb)) t1 = tb;
    else if (hitAlt(a, rd.y, TT, tt)) t1 = tt; else t1 = 20000.0;
  } else {
    float tt, tb;
    ok = rd.y < 0.0 && hitAlt(a, rd.y, TT, tt);
    t0 = tt;
    if (ok) t1 = hitAlt(a, rd.y, B, tb) ? tb : t0 + 8000.0;
  }
  vec3 L = uLightDir;
  float cosT = dot(rd, L);
  float altKm = mix(B, TT, 0.5) * 0.001 + 0.2;
  vec3 sunCol = transmittance(altKm, L.y) * (uLightDir == uSunDir ? uSunIllum : uMoonIllum);
  vec3 ambTop = irradiance(vec3(0.0, 1.0, 0.0)) / PI;
  vec3 ambBot = irradiance(vec3(0.0, -1.0, 0.0)) / PI;
  vec4 ci = a < 7600.0 ? cirrusLayer(rd, transmittance(7.8, L.y) * (uLightDir == uSunDir ? uSunIllum : uMoonIllum), ambTop, cosT) : vec4(0.0, 0.0, 0.0, 1.0);
  t1 = min(t1, t0 + 32000.0);
  if (!ok || t1 <= t0 || t0 > 90000.0) return ci;
  const float SIGMA = 0.045;
  float stepsF = float(uCloudSteps) * mix(1.0, 0.65, saturate(abs(rd.y) * 2.0));
  float dtF = (t1 - t0) / stepsF, dtC = dtF * 3.0;
  float t = t0 + dtF * jit;
  vec3 scat = vec3(0.0);
  float T = 1.0;
  float thick = TT - B;
  float wsum = 0.0, tw = 0.0;
  bool coarse = true;
  int empty = 0;
  for (int i = 0; i < 320; i++) {
    if (t >= t1 || T < 0.012) break;
    float h = a + t * rd.y + t * t * KCURV * (1.0 - rd.y * rd.y);
    float hf = (h - B) / thick;
    vec3 p = vec3(uCamPos.x + rd.x * t, h, uCamPos.z + rd.z * t);
    if (hf < 0.0 || hf > 1.0) { t += coarse ? dtC : dtF; continue; }
    if (coarse) {
      // skip empty sky with long steps, back up when we enter a cloud
      if (cloudField(p, hf, false) > 0.0) { coarse = false; empty = 0; t = max(t0, t - dtC); }
      else t += dtC;
      continue;
    }
    float den = cloudField(p, hf, true);
    if (den > 0.002) {
      empty = 0;
      float od = 0.0;
      float ls = thick * 0.07;
      for (int j = 0; j < 4; j++) {
        float sj = ls * (1.0 + float(j) * 1.5);
        vec3 q = p + L * sj * (float(j) + 0.5);
        float qhf = (q.y - B) / thick;
        if (qhf > 1.0) break;
        od += cloudField(q, qhf, j < 2) * sj;
      }
      vec3 lightE = vec3(0.0);
      float aa = 1.0, bb = 1.0, cc = 1.0;
      for (int k = 0; k < 4; k++) {
        float ph = mix(hgPhase(cosT, 0.78 * cc), hgPhase(cosT, -0.25 * cc), 0.32);
        lightE += aa * exp(-od * SIGMA * bb) * ph;
        aa *= 0.52; bb *= 0.33; cc *= 0.5;
      }
      float powder = 1.0 - exp(-den * SIGMA * 70.0);
      lightE *= mix(1.0, powder, 0.55 * (1.0 - saturate(cosT)));
      float ext = SIGMA * den;
      vec3 S = ext * (sunCol * lightE * PI + mix(ambBot, ambTop, saturate(hf)) * mix(0.45, 1.0, hf));
      float stepT = exp(-ext * dtF);
      scat += T * (S - S * stepT) / ext;
      wsum += T * (1.0 - stepT) * t; tw += T * (1.0 - stepT);
      T *= stepT;
    } else if (++empty > 6) {
      coarse = true;
    }
    t += dtF;
  }
  // aerial perspective toward the horizon
  float cd = tw > 0.0 ? wsum / tw : t0;
  float fade = exp(-cd / mix(26000.0, 9000.0, uRain));
  vec3 sky = skyLUT(rd);
  scat = mix(sky * (1.0 - T), scat, fade);
  // cirrus sits behind the cumulus layer
  return vec4(scat + T * ci.rgb, T * ci.a);
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  // 16 phases: one texel of every 4x4 block per frame; 32 phases alternate between neighbouring blocks
  int idx = BAYER[(px.x & 3) + (px.y & 3) * 4] + (uPhases > 16 ? 16 * (((px.x >> 2) + (px.y >> 2)) & 1) : 0);
  if (uFull < 0.5 && idx != uPhase) discard;
  vec2 uv = (vec2(px) + 0.5) / uPanoRes;
  float az = (uv.x - 0.5) * TAU;
  float vv = uv.y * 2.0 - 1.0;
  float el = sign(vv) * vv * vv * 0.5 * PI;
  vec3 rd = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
  float jit = ign(vec2(px));
  oCloud = traceClouds(rd, jit);
  vec3 ex = vec3(0.0);
  if (uNight > 0.0 && rd.y > 0.0) ex = milkyWay(rd) + aurora(rd, jit);
  oExtra = vec4(ex, 1.0);
}`;

// Sunlight transmittance through the cloud layer, on a ground-referenced grid around the camera.
export const cloudShadowFS = HEADER + UTIL + FRAME + CLOUD_FIELD + /* glsl */`
uniform vec4 uCSM;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / 512.0;
  vec2 xz = uCSM.xy + uv * uCSM.z;
  vec3 L = uLightDir;
  float ly = max(L.y, 0.06);
  vec3 p0 = vec3(xz.x, uCSM.w, xz.y);
  float B = uCloudBottom, TT = uCloudTop;
  float tB = (B - uCSM.w) / ly, tT = (TT - uCSM.w) / ly;
  float seg = (tT - tB) / 6.0;
  float od = 0.0;
  for (int i = 0; i < 6; i++) {
    vec3 p = p0 + L * (tB + (float(i) + 0.5) * seg);
    od += cloudField(p, (p.y - B) / (TT - B), false) * seg;
  }
  o = vec4(0.18 + 0.82 * exp(-od * 0.045 * 0.32));
}`;
