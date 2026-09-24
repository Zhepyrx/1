// Volumetric cloud noise generation, raymarching and temporal resolve.
import { HEADER, UTIL, FRAME, ATMOS_SAMPLE, CLOUD_FIELD } from './common.js';

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
void main() {
  vec2 uv = gl_FragCoord.xy / 512.0;
  vec3 p = vec3(uv, 0.37);
  float cov = perlinFbm(vec3(uv, 0.5), 5.0, 5);
  float w = worley3(vec3(uv * 9.0, 0.5 * 9.0), 9.0);
  cov = saturate(remap(cov, 0.35, 0.8, 0.0, 1.0)) * (0.55 + 0.45 * w);
  float type = perlinFbm(vec3(uv, 0.1), 3.0, 3);
  o = vec4(saturate(cov * 1.25), saturate(type * 1.4 - 0.2), 0.0, 1.0);
  (void(p));
}`.replace('(void(p));', '');

export const cloudsFS = HEADER + UTIL + FRAME + ATMOS_SAMPLE + CLOUD_FIELD + /* glsl */`
uniform sampler2D uDepth;
uniform vec2 uCloudRes;
uniform int uCloudSteps;
uniform vec3 uCamFwd;
out vec4 o;
const float KCURV = 1.0 / (2.0 * 6360000.0);
// distance along ray to altitude H using a parabolic earth-curvature approximation
bool hitAlt(float a, float dy, float H, bool farRoot, out float t) {
  float k = KCURV * (1.0 - dy * dy);
  float c = a - H;
  float disc = dy * dy - 4.0 * k * c;
  if (disc < 0.0) return false;
  float sq = sqrt(disc);
  float q = -0.5 * (dy + (dy >= 0.0 ? sq : -sq));
  float r0 = q / max(k, 1e-12), r1 = c / q;
  if (abs(q) < 1e-12) return false;
  float t0 = min(r0, r1), t1 = max(r0, r1);
  if (k < 1e-12) { t0 = t1 = -c / dy; }
  t = farRoot ? t1 : (t0 > 0.0 ? t0 : t1);
  return t > 0.0;
}
void main() {
  vec2 uv = gl_FragCoord.xy / uCloudRes;
  vec3 rd = viewRay(uv);
  float a = uCamPos.y, B = uCloudBottom, TT = uCloudTop;
  float t0 = 0.0, t1 = 0.0;
  bool ok = true;
  if (a < B) {
    float tb, tt;
    ok = hitAlt(a, rd.y, B, false, tb) && hitAlt(a, rd.y, TT, false, tt);
    t0 = tb; t1 = tt;
  } else if (a < TT) {
    float tt, tb;
    t0 = 0.0;
    if (hitAlt(a, rd.y, B, false, tb) && rd.y < 0.0) t1 = tb;
    else if (hitAlt(a, rd.y, TT, false, tt)) t1 = tt; else t1 = 20000.0;
  } else {
    float tt, tb;
    ok = rd.y < 0.0 && hitAlt(a, rd.y, TT, false, tt);
    t0 = tt;
    if (ok) t1 = hitAlt(a, rd.y, B, false, tb) ? tb : t0 + 8000.0;
  }
  float d = texture(uDepth, uv).r;
  float sceneT = (d >= 1.0 || a < B) ? 1e9 : linearDepth(d) / max(dot(rd, uCamFwd), 1e-3);
  t1 = min(t1, min(sceneT, t0 + 30000.0));
  if (!ok || t1 <= t0 || t0 > 90000.0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec3 L = uLightDir;
  float cosT = dot(rd, L);
  int N = uCloudSteps;
  float stepsF = float(N) * mix(1.0, 0.6, saturate(abs(rd.y) * 2.0));
  float dt = (t1 - t0) / stepsF;
  float jit = frameNoise(gl_FragCoord.xy);
  float t = t0 + dt * jit;
  float altKm = mix(B, TT, 0.5) * 0.001 + 0.2;
  vec3 sunCol = transmittance(altKm, L.y) * (uLightDir == uSunDir ? uSunIllum : uMoonIllum);
  vec3 ambTop = irradiance(vec3(0.0, 1.0, 0.0)) / PI;
  vec3 ambBot = irradiance(vec3(0.0, -1.0, 0.0)) / PI;
  const float SIGMA = 0.045;
  vec3 scat = vec3(0.0);
  float T = 1.0;
  float thick = TT - B;
  float wsum = 0.0, tw = 0.0;
  for (int i = 0; i < 160; i++) {
    if (float(i) >= stepsF || T < 0.015) break;
    float h = a + t * rd.y + t * t * KCURV * (1.0 - rd.y * rd.y);
    float hf = (h - B) / thick;
    vec3 p = vec3(uCamPos.x + rd.x * t, h, uCamPos.z + rd.z * t);
    float den = (hf > 0.0 && hf < 1.0) ? cloudField(p, hf, true) : 0.0;
    if (den > 0.002) {
      float od = 0.0;
      float ls = thick * 0.08;
      for (int j = 0; j < 6; j++) {
        float sj = ls * (1.0 + float(j) * 0.9);
        vec3 q = p + L * sj * (float(j) + 0.5);
        float qhf = (q.y - B) / thick;
        if (qhf > 1.0) break;
        od += cloudField(q, qhf, j < 2) * sj;
      }
      vec3 lightE = vec3(0.0);
      float aa = 1.0, bb = 1.0, cc = 1.0;
      for (int k = 0; k < 3; k++) {
        float ph = mix(hgPhase(cosT, 0.75 * cc), hgPhase(cosT, -0.25 * cc), 0.35);
        lightE += aa * exp(-od * SIGMA * bb) * ph;
        aa *= 0.5; bb *= 0.35; cc *= 0.5;
      }
      float powder = 1.0 - exp(-den * SIGMA * 60.0);
      lightE *= mix(1.0, powder, 0.5 * (1.0 - saturate(cosT)));
      float ext = SIGMA * den;
      vec3 S = ext * (sunCol * lightE * 4.0 * PI * 0.25 + mix(ambBot, ambTop, saturate(hf)) * mix(0.45, 1.0, hf));
      float stepT = exp(-ext * dt);
      scat += T * (S - S * stepT) / ext;
      wsum += T * (1.0 - stepT) * t; tw += T * (1.0 - stepT);
      T *= stepT;
    }
    t += dt;
  }
  // aerial perspective toward the horizon
  float cd = tw > 0.0 ? wsum / tw : t0;
  float fade = exp(-cd / mix(26000.0, 9000.0, uRain));
  vec3 sky = skyLUT(rd);
  scat = mix(sky * (1.0 - T), scat, fade);
  o = vec4(scat, T);
}`;

export const cloudResolveFS = HEADER + UTIL + FRAME + /* glsl */`
uniform sampler2D uCur, uHist;
uniform vec2 uCloudRes;
uniform float uReset;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uCloudRes;
  vec2 texel = 1.0 / uCloudRes;
  vec4 cur = texture(uCur, uv);
  vec4 mn = cur, mx = cur;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec4 s = texture(uCur, uv + vec2(float(x), float(y)) * texel);
    mn = min(mn, s); mx = max(mx, s);
  }
  vec3 rd = viewRay(uv);
  vec4 pc = uPrevVP * vec4(rd, 0.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  vec4 hist = texture(uHist, puv);
  bool valid = pc.w > 0.0 && all(greaterThanEqual(puv, vec2(0.0))) && all(lessThanEqual(puv, vec2(1.0))) && uReset < 0.5;
  vec4 center = (mn + mx) * 0.5, ext = (mx - mn) * 0.5 + 0.002;
  hist = clamp(hist, center - ext * 1.25, center + ext * 1.25);
  o = valid ? mix(hist, cur, 0.12) : cur;
}`;
