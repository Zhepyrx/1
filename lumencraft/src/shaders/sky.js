// Atmosphere LUT passes.
import { HEADER, UTIL, ATMOS } from './common.js';

const TRANS_FN = /* glsl */`
uniform sampler2D uTrans;
vec3 transmittance(float hKm, float mu) {
  return texture(uTrans, vec2(0.5 + 0.5 * sign(mu) * sqrt(abs(mu)), sqrt(clamp(hKm / 100.0, 0.0, 1.0)))).rgb;
}
`;

export const transmittanceFS = HEADER + UTIL + ATMOS + /* glsl */`
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(256.0, 64.0);
  float x = uv.x * 2.0 - 1.0;
  float mu = sign(x) * x * x;
  float h = uv.y * uv.y * 100.0;
  vec3 ro = vec3(0.0, Rg + h + 0.002, 0.0);
  vec3 rd = vec3(sqrt(max(1.0 - mu * mu, 0.0)), mu, 0.0);
  if (sphereNear(ro, rd, Rg) > 0.0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float tMax = sphereFar(ro, rd, Rt);
  vec3 od = vec3(0.0);
  const int N = 48;
  float dt = tMax / float(N);
  for (int i = 0; i < N; i++) {
    vec3 p = ro + rd * ((float(i) + 0.5) * dt);
    vec3 rs; float ms; vec3 ext;
    medium(length(p) - Rg, rs, ms, ext);
    od += ext * dt;
  }
  o = vec4(exp(-od), 1.0);
}`;

export const multiScatterFS = HEADER + UTIL + ATMOS + TRANS_FN + /* glsl */`
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / 32.0;
  float sunMu = uv.x * 2.0 - 1.0;
  float h = max(uv.y * 100.0, 0.01);
  vec3 ro = vec3(0.0, Rg + h, 0.0);
  vec3 sd = vec3(sqrt(max(1.0 - sunMu * sunMu, 0.0)), sunMu, 0.0);
  vec3 L2 = vec3(0.0), fms = vec3(0.0);
  const int SQ = 8;
  for (int i = 0; i < SQ; i++) for (int j = 0; j < SQ; j++) {
    float u = (float(i) + 0.5) / float(SQ), v = (float(j) + 0.5) / float(SQ);
    float ct = 1.0 - 2.0 * v, st = sqrt(max(1.0 - ct * ct, 0.0)), ph = TAU * u;
    vec3 rd = vec3(st * cos(ph), ct, st * sin(ph));
    float tG = sphereNear(ro, rd, Rg), tT = sphereFar(ro, rd, Rt);
    float tMax = tG > 0.0 ? tG : tT;
    const int N = 20;
    float dt = tMax / float(N);
    vec3 T = vec3(1.0), L = vec3(0.0), f = vec3(0.0);
    for (int k = 0; k < N; k++) {
      vec3 p = ro + rd * ((float(k) + 0.5) * dt);
      float hh = length(p) - Rg;
      vec3 rs; float ms; vec3 ext; medium(hh, rs, ms, ext);
      vec3 scat = rs + ms;
      vec3 Ts = transmittance(hh, dot(normalize(p), sd));
      vec3 S = Ts * scat / (4.0 * PI);
      vec3 stepT = exp(-ext * dt);
      L += T * (S - S * stepT) / ext;
      f += T * (scat - scat * stepT) / ext;
      T *= stepT;
    }
    if (tG > 0.0) {
      vec3 pg = ro + rd * tG; vec3 ng = normalize(pg);
      L += T * transmittance(0.0, dot(ng, sd)) * max(dot(ng, sd), 0.0) * 0.3 / PI;
    }
    L2 += L; fms += f;
  }
  L2 /= float(SQ * SQ); fms /= float(SQ * SQ);
  o = vec4(L2 / (1.0 - fms), 1.0);
}`;

export const skyViewFS = HEADER + UTIL + ATMOS + TRANS_FN + /* glsl */`
uniform sampler2D uMS;
uniform vec3 uSunDir, uMoonDir;
uniform float uSunIllum, uMoonIllum, uCamAltKm, uRain;
out vec4 o;
vec3 msLUT(float h, float mu) { return texture(uMS, vec2(mu * 0.5 + 0.5, clamp(h / 100.0, 0.0, 1.0))).rgb; }
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(192.0, 108.0);
  float az = (uv.x - 0.5) * TAU;
  float vv = uv.y * 2.0 - 1.0;
  float el = sign(vv) * vv * vv * 0.5 * PI;
  vec3 rd = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
  vec3 ro = vec3(0.0, Rg + uCamAltKm, 0.0);
  float tG = sphereNear(ro, rd, Rg), tT = sphereFar(ro, rd, Rt);
  float tMax = tG > 0.0 ? tG : tT;
  float cS = dot(rd, uSunDir), cM = dot(rd, uMoonDir);
  float prS = rayleighPhase(cS), pmS = miePhase(cS), prM = rayleighPhase(cM), pmM = miePhase(cM);
  const int N = 36;
  vec3 L = vec3(0.0), T = vec3(1.0);
  for (int i = 0; i < N; i++) {
    float t0 = tMax * pow(float(i) / float(N), 2.0), t1 = tMax * pow(float(i + 1) / float(N), 2.0);
    float dt = t1 - t0;
    vec3 p = ro + rd * mix(t0, t1, 0.35);
    float hh = length(p) - Rg; vec3 up = p / length(p);
    vec3 rs; float ms; vec3 ext; medium(hh, rs, ms, ext);
    float muS = dot(up, uSunDir), muM = dot(up, uMoonDir);
    vec3 S = uSunIllum * (transmittance(hh, muS) * (rs * prS + ms * pmS) + msLUT(hh, muS) * (rs + ms))
           + uMoonIllum * (transmittance(hh, muM) * (rs * prM + ms * pmM) + msLUT(hh, muM) * (rs + ms));
    vec3 stepT = exp(-ext * dt);
    L += T * (S - S * stepT) / ext;
    T *= stepT;
  }
  // faint airglow so the night sky is never perfectly black
  L += vec3(0.00025, 0.0004, 0.0009) * (0.4 + 0.6 * smoothstep(-0.2, 0.3, rd.y));
  // overcast: flatten the sky toward grey
  float g = dot(L, vec3(0.3, 0.5, 0.2));
  L = mix(L, vec3(g) * vec3(0.92, 0.96, 1.0) * 0.75, uRain * 0.8);
  o = vec4(L, 1.0);
}`;

export const irradianceFS = HEADER + UTIL + ATMOS + TRANS_FN + /* glsl */`
uniform sampler2D uSkyView;
uniform vec3 uSunDir, uMoonDir;
uniform float uSunIllum, uMoonIllum, uCamAltKm;
out vec4 o;
vec2 dirToSkyUV(vec3 d) {
  float az = atan(d.z, d.x); float el = asin(clamp(d.y, -1.0, 1.0));
  return vec2(az / TAU + 0.5, 0.5 + 0.5 * sign(el) * sqrt(abs(el) / (0.5 * PI)));
}
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(32.0, 16.0);
  float az = (uv.x - 0.5) * TAU, th = uv.y * PI;
  vec3 n = vec3(sin(th) * cos(az), cos(th), sin(th) * sin(az));
  vec3 t = normalize(abs(n.y) < 0.99 ? cross(n, vec3(0.0, 1.0, 0.0)) : cross(n, vec3(1.0, 0.0, 0.0)));
  vec3 b = cross(n, t);
  vec3 skyUp = textureLod(uSkyView, dirToSkyUV(vec3(0.0, 1.0, 0.0)), 0.0).rgb;
  vec3 groundE = uSunIllum * transmittance(uCamAltKm, uSunDir.y) * max(uSunDir.y, 0.0)
               + uMoonIllum * transmittance(uCamAltKm, uMoonDir.y) * max(uMoonDir.y, 0.0) + PI * skyUp * 0.8;
  vec3 groundL = groundE * 0.16 / PI;
  vec3 E = vec3(0.0);
  const int N = 96;
  for (int i = 0; i < N; i++) {
    float xi = (float(i) + 0.5) / float(N), ph = float(i) * 2.39996323;
    float r = sqrt(xi);
    vec3 d = normalize(t * r * cos(ph) + b * r * sin(ph) + n * sqrt(1.0 - xi));
    vec3 L = d.y > 0.0 ? textureLod(uSkyView, dirToSkyUV(d), 1.0).rgb : mix(groundL, textureLod(uSkyView, dirToSkyUV(d), 1.0).rgb, 0.15);
    E += L;
  }
  o = vec4(E * PI / float(N), 1.0);
}`;
