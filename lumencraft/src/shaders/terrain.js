// Terrain vertex shader + G-buffer, shadow and translucent (water/glass) fragment shaders.
import { HEADER, UTIL, FRAME, ATMOS_SAMPLE, CLOUD_SAMPLE, SKY, SHADOW, FOG, BRDF } from './common.js';

export const terrainVS = /* glsl */`#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in ivec2 aXZ;
layout(location = 1) in ivec2 aYE;
layout(location = 2) in uvec4 aD;
uniform mat4 uVP;
uniform ivec3 uCamI;
uniform vec3 uCamF;
uniform float uTime;
uniform float uWind;
out vec3 vRel;
out vec2 vUV;
out vec3 vTint;
out vec4 vLight;
flat out ivec4 vInfo;

vec3 windOffset(vec3 wp, int wave, float topW) {
  float t = uTime;
  float gust = 0.55 + 0.45 * sin(t * 0.35 + wp.x * 0.021 + wp.z * 0.017) * sin(t * 0.13 + wp.z * 0.011 + 1.3);
  float str = uWind * gust;
  if (wave == 1) {
    float ph = t * 1.7 + dot(wp, vec3(0.7, 0.9, 0.5));
    return vec3(sin(ph), sin(ph * 1.3 + 1.7) * 0.5, cos(ph * 0.9 + 0.3)) * 0.035 * str;
  } else if (wave == 2) {
    float ph = t * 2.2 + wp.x * 0.55 + wp.z * 0.4;
    float s = (sin(ph) * 0.55 + sin(ph * 2.7 + 1.3) * 0.25 + 0.4) * 0.11 * str;
    return vec3(0.8 * s, -abs(s) * 0.2, 0.6 * s) * topW;
  }
  float ph = t * 1.1 + wp.x * 0.5 + wp.z * 0.3;
  return vec3(sin(ph) * 0.12, 0.0, cos(ph * 0.8) * 0.12) * topW;
}

void main() {
  ivec3 p16 = ivec3(aXZ.x, aYE.x, aXZ.y);
  vec3 rel = vec3(p16 - uCamI) * (1.0 / 16.0) - uCamF;
  uint d1 = aD.y;
  int nIdx = int(d1 & 7u);
  int wave = int((d1 >> 5u) & 3u);
  vec3 wp = vec3(p16) / 16.0;
  float vbit = float((d1 >> 4u) & 1u);
  if (wave > 0) rel += windOffset(wp, wave, 1.0 - vbit);
  vec2 uv;
  if (nIdx >= 6) {
    uv = vec2(float((d1 >> 3u) & 1u), vbit);
  } else {
    vec3 m = vec3(ivec3(p16.x & 16383, p16.y, p16.z & 16383)) / 16.0;
    if (nIdx == 0) uv = vec2(-m.z, -m.y);
    else if (nIdx == 1) uv = vec2(m.z, -m.y);
    else if (nIdx == 2) uv = vec2(m.x, m.z);
    else if (nIdx == 3) uv = vec2(m.x, -m.z);
    else if (nIdx == 4) uv = vec2(m.x, -m.y);
    else uv = vec2(-m.x, -m.y);
  }
  uint t = uint(aYE.y) & 0xFFFFu;
  vec3 tint = vec3(float((t >> 11u) & 31u) / 31.0, float((t >> 5u) & 63u) / 63.0, float(t & 31u) / 31.0);
  vTint = pow(tint, vec3(2.2));
  uint L = aD.w;
  vLight = vec4(float(L >> 4u) / 15.0, float(L & 15u) / 15.0, float(aD.z & 3u) / 3.0, float((aD.z >> 2u) & 15u) / 15.0);
  vInfo = ivec4(int(aD.x), nIdx, int(d1 >> 5u), 0);
  vRel = rel;
  vUV = uv;
  gl_Position = uVP * vec4(rel, 1.0);
}`;

const TANGENT = /* glsl */`
void tangentFrame(int n, out vec3 N, out vec3 T, out vec3 B) {
  if (n == 0) { N = vec3(1, 0, 0); T = vec3(0, 0, -1); B = vec3(0, -1, 0); }
  else if (n == 1) { N = vec3(-1, 0, 0); T = vec3(0, 0, 1); B = vec3(0, -1, 0); }
  else if (n == 2) { N = vec3(0, 1, 0); T = vec3(1, 0, 0); B = vec3(0, 0, 1); }
  else if (n == 3) { N = vec3(0, -1, 0); T = vec3(1, 0, 0); B = vec3(0, 0, -1); }
  else if (n == 4) { N = vec3(0, 0, 1); T = vec3(1, 0, 0); B = vec3(0, -1, 0); }
  else if (n == 5) { N = vec3(0, 0, -1); T = vec3(-1, 0, 0); B = vec3(0, -1, 0); }
  else { N = vec3(0, 1, 0); T = vec3(1, 0, 0); B = vec3(0, 0, 1); }
}
`;

// G-buffer variants. The opaque variant contains no `discard`, so tile-based GPUs (Apple) keep
// hidden-surface removal and early depth rejection for the bulk of the terrain.
export function makeGbufferFS(kind) {
  const defs = `#define GB_OPAQUE ${kind === 'opaque' ? 1 : 0}\n#define GB_CUTOUT ${kind === 'cutout' ? 1 : 0}\n#define GB_PLANT ${kind === 'plant' ? 1 : 0}\n`;
  return HEADER + defs + UTIL + TANGENT + /* glsl */`
in vec3 vRel;
in vec2 vUV;
in vec3 vTint;
in vec4 vLight;
flat in ivec4 vInfo;
uniform sampler2DArray uAlbedo, uNormal, uMaterial;
uniform vec4 uLayerInfo[128];
uniform vec3 uCamPos;
uniform vec3 uLightDir;
uniform float uTime, uWetness, uRain;
uniform float uPomDist, uTexRes;
uniform int uPomSteps;
uniform vec2 uPlantFade;
uniform int uFrame;
layout(location = 0) out vec4 oAlb;
layout(location = 1) out vec4 oNrm;
layout(location = 2) out vec4 oMisc;

vec2 ripples(vec2 p, float t) {
  vec2 g = floor(p);
  vec2 acc = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = g + vec2(float(i), float(j));
    vec2 h = hash22(c);
    float ph = fract(t * 0.9 + h.x * 7.0);
    vec2 d = p - (c + h);
    float r = length(d);
    float ring = r - ph * 0.8;
    float w = sin(clamp(ring * 38.0, -PI, PI)) * (1.0 - ph) * (1.0 - ph) * step(abs(ring), 0.09);
    acc += d / max(r, 1e-3) * w;
  }
  return acc;
}

void main() {
  int layer = vInfo.x, nIdx = vInfo.y, flags = vInfo.z;
  vec4 li = uLayerInfo[layer];
  int lf = int(li.y + 0.5);
  float lf_ = float(layer);
  vec2 uv = vUV;
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  float dist = length(vRel);
  float pshadow = 1.0;
#if GB_PLANT
  // dissolve small plants toward the edge of the detailed-mesh radius
  if (dist > uPlantFade.x && ign(gl_FragCoord.xy + float(uFrame % 16) * 5.588) < smoothstep(uPlantFade.x, uPlantFade.y, dist)) discard;
  vec3 N = vec3(0.0, 1.0, 0.0), T = vec3(1.0, 0.0, 0.0), B = vec3(0.0, 0.0, 1.0);
#else
  vec3 N, T, B;
  tangentFrame(nIdx, N, T, B);
#endif
#if GB_OPAQUE
  // random 90 degree rotation per block on natural top faces to break up tiling
  if (nIdx == 2 && (lf & 1) != 0) {
    vec2 cell = floor(uv);
    int k = int(hash12(cell + lf_ * 13.1) * 4.0);
    vec2 f = uv - cell;
    vec3 T0 = T, B0 = B;
    if (k == 1) { f = vec2(1.0 - f.y, f.x); T = -B0; B = T0; dx = vec2(-dx.y, dx.x); dy = vec2(-dy.y, dy.x); }
    else if (k == 2) { f = 1.0 - f; T = -T0; B = -B0; dx = -dx; dy = -dy; }
    else if (k == 3) { f = vec2(f.y, 1.0 - f.x); T = B0; B = -T0; dx = vec2(dx.y, -dx.x); dy = vec2(dy.y, -dy.x); }
    uv = cell + f;
  }
  // parallax occlusion mapping: step count follows the on-screen parallax span, sampled without anisotropy
  float pom = li.x * (1.0 - smoothstep(uPomDist * 0.55, uPomDist, dist));
  if (pom > 0.0005) {
    vec3 V = -vRel / dist;
    vec3 Vts = vec3(dot(V, T), dot(V, B), dot(V, N));
    float lodP = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy)) * uTexRes * uTexRes));
    vec2 span = -Vts.xy / max(Vts.z, 0.14) * pom;
    float spanTex = length(span) * uTexRes / exp2(lodP);
    if (spanTex > 0.75) {
      float steps = clamp(spanTex * 0.6, 4.0, float(uPomSteps));
      vec2 delta = span / steps;
      float layerD = 1.0 / steps;
      float curH = 1.0;
      vec2 cuv = uv;
      float h = textureLod(uNormal, vec3(cuv, lf_), lodP).a;
      for (int i = 0; i < 48; i++) {
        if (float(i) >= steps || h >= curH) break;
        cuv += delta; curH -= layerD;
        h = textureLod(uNormal, vec3(cuv, lf_), lodP).a;
      }
      vec2 puv = cuv - delta;
      float ph = textureLod(uNormal, vec3(puv, lf_), lodP).a;
      float after = h - curH, before = ph - (curH + layerD);
      uv = mix(cuv, puv, saturate(after / min(after - before, -1e-5)));
      // parallax self shadowing toward the light
      vec3 Lts = vec3(dot(uLightDir, T), dot(uLightDir, B), dot(uLightDir, N));
      if (Lts.z > 0.02 && dist < uPomDist * 0.4) {
        float hh = textureLod(uNormal, vec3(uv, lf_), lodP).a;
        vec2 ld = Lts.xy / max(Lts.z, 0.1) * pom / 6.0;
        float occ = 0.0;
        for (int i = 1; i <= 6; i++) {
          float sh = textureLod(uNormal, vec3(uv + ld * float(i), lf_), lodP).a;
          occ = max(occ, (sh - hh - float(i) / 6.0) * 6.0);
        }
        pshadow = 1.0 - saturate(occ) * (1.0 - smoothstep(uPomDist * 0.25, uPomDist * 0.4, dist));
      }
    }
  }
#endif
#if GB_PLANT
  // campfire flames: licking distortion that rises through the card
  if ((lf & 32) != 0) {
    float rise = uTime * 2.3 + vRel.x * 0.7 + vRel.z * 0.5;
    uv.x += (vnoise2(vec2(uv.y * 5.0 - rise * 1.9, rise * 0.3)) - 0.5) * 0.16 * (1.0 - uv.y * 0.6);
    uv.y += (vnoise2(vec2(uv.x * 3.0, uv.y * 4.0 - rise * 2.4)) - 0.5) * 0.08;
  }
#endif
  vec4 alb = textureGrad(uAlbedo, vec3(uv, lf_), dx, dy);
#if !GB_OPAQUE
  {
    float lod = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy)) * uTexRes * uTexRes));
    if (alb.a * (1.0 + lod * 0.35) < 0.42) discard;
  }
  float tintMask = 1.0;
#else
  // lava flow animation
  if ((lf & 4) != 0) {
    vec2 flow = vec2(uTime * 0.03, uTime * 0.017);
    vec4 a2 = textureGrad(uAlbedo, vec3(uv * 0.7 + flow, lf_), dx, dy);
    alb.rgb = mix(alb.rgb, a2.rgb, 0.5) * (0.85 + 0.15 * sin(uTime * 1.3 + uv.x * 3.0));
  }
  float tintMask = alb.a;
#endif
  vec3 albedo = alb.rgb * mix(vec3(1.0), vTint, tintMask);
  vec4 mat = textureGrad(uMaterial, vec3(uv, lf_), dx, dy);
  float rough = mat.r, metal = mat.g, emit = mat.b * li.w, tao = mat.a;
  // slow bioluminescent breathing, and fire flicker
  if ((lf & 64) != 0) emit *= 0.72 + 0.28 * sin(uTime * 1.1 + (vRel.x + uCamPos.x) * 0.37 + (vRel.z + uCamPos.z) * 0.29);
  if ((lf & 32) != 0) emit *= 0.8 + 0.2 * sin(uTime * 17.0 + vRel.x * 3.0) * sin(uTime * 7.3 + 1.1);
#if GB_PLANT
  vec3 Nm = N;
#else
  vec3 nt = textureGrad(uNormal, vec3(uv, lf_), dx, dy).xyz * 2.0 - 1.0;
  vec3 Nm = normalize(T * nt.x + B * nt.y + N * nt.z);
  if (!gl_FrontFacing) { Nm = -Nm; N = -N; }
  // rain: wet darkening, lower roughness, puddles with ripples
  if (uWetness > 0.001) {
    vec3 wp = vRel + uCamPos;
    float exposed = smoothstep(0.8, 0.97, vLight.x) * saturate(N.y * 0.6 + 0.6);
    float wet = uWetness * exposed;
    float por = li.z;
    albedo *= mix(1.0, 0.5 + 0.3 * (1.0 - por), wet * por);
    rough = mix(rough, rough * 0.35, wet);
#if GB_OPAQUE
    if (nIdx == 2 && wet > 0.01) {
      float pn = fbm2(wp.xz * 0.23) + (0.5 - textureLod(uNormal, vec3(uv, lf_), 2.0).a) * 0.25;
      float puddle = smoothstep(0.52, 0.6, pn) * wet * smoothstep(0.3, 0.8, uWetness);
      if (puddle > 0.001) {
        rough = mix(rough, 0.015, puddle);
        albedo *= mix(1.0, 0.75, puddle);
        vec2 rp = ripples(wp.xz * 3.0, uTime) * uRain;
        vec3 pn3 = normalize(vec3(rp.x * 0.35, 1.0, rp.y * 0.35));
        Nm = normalize(mix(Nm, pn3, puddle));
        tao = mix(tao, 1.0, puddle);
      }
    }
#endif
  }
#endif
  int bits = (GB_PLANT == 1 ? 7 : nIdx) + ((lf & 2) != 0 ? 8 : 0) + (GB_PLANT == 1 ? 16 : 0) + ((flags & 4) != 0 ? 32 : 0)
    + (int(saturate(metal) * 3.0 + 0.5) << 6);
  // albedo alpha carries the cool (bioluminescent) block light; metalness lives in the bit field
  oAlb = vec4(albedo, vLight.w);
  oNrm = vec4(octEncode(Nm), rough, float(bits));
  float ao = pow((vLight.z * 3.0 + 1.0) / 4.0, 0.8) * tao;
  float e = saturate(emit / 16.0);
  float packed = e > 0.001 ? 0.54 + 0.46 * e : 0.48 * pshadow;
  oMisc = vec4(vLight.x, vLight.y, ao, packed);
}`;
}

// Depth-only shadow pass. The opaque variant has no discard and no texture fetch.
export const shadowOpaqueFS = HEADER + /* glsl */`
out vec4 o;
void main() { o = vec4(1.0); }`;

export const shadowCutoutFS = HEADER + /* glsl */`
in vec2 vUV;
flat in ivec4 vInfo;
uniform sampler2DArray uAlbedo;
out vec4 o;
void main() {
  if (texture(uAlbedo, vec3(vUV, float(vInfo.x)), 1.0).a < 0.45) discard;
  o = vec4(1.0);
}`;

// Water, glass and ice. Composited over a copy of the lit opaque scene.
export const translucentFS = HEADER + UTIL + FRAME + ATMOS_SAMPLE + CLOUD_SAMPLE + SKY + SHADOW + FOG + BRDF + TANGENT + /* glsl */`
in vec3 vRel;
in vec2 vUV;
in vec3 vTint;
in vec4 vLight;
flat in ivec4 vInfo;
uniform sampler2D uSceneColor, uLinDepth, uVol;
uniform sampler2DArray uAlbedo, uNormal;
uniform int uWaterLayer;
uniform vec3 uCamFwd;
uniform vec2 uVolRes;
uniform float uSSRSteps;
out vec4 o;

float waveH(vec2 p, float t) {
  float h = 0.0, a = 1.0, f = 0.9, s = 0.0;
  vec2 dir = normalize(vec2(1.0, 0.35));
  for (int i = 0; i < 7; i++) {
    float ang = float(i) * 1.7;
    vec2 d = vec2(cos(ang) * dir.x - sin(ang) * dir.y, sin(ang) * dir.x + cos(ang) * dir.y);
    float x = dot(d, p) * f + t * (1.2 + float(i) * 0.35);
    h += a * exp(sin(x) - 1.0);
    s += a;
    a *= 0.62; f *= 1.55;
  }
  return h / s;
}
vec3 waterNormal(vec2 p, float dist) {
  float t = uTime * 1.2;
  float e = 0.04;
  float amp = mix(0.18, 0.05, saturate(dist / 120.0)) * (1.0 + uRain * 0.6);
  float h0 = waveH(p, t), hx = waveH(p + vec2(e, 0.0), t), hz = waveH(p + vec2(0.0, e), t);
  vec3 n = normalize(vec3(-(hx - h0) / e * amp, 1.0, -(hz - h0) / e * amp));
  // fine capillary detail
  vec2 q = p * 3.1 + vec2(t * 0.4, -t * 0.3);
  vec2 g = vec2(vnoise2(q) - vnoise2(q + vec2(0.3, 0.0)), vnoise2(q) - vnoise2(q + vec2(0.0, 0.3)));
  n = normalize(n + vec3(g.x, 0.0, g.y) * 0.25 * (1.0 - saturate(dist / 40.0)));
  return n;
}

vec3 projectUV(vec3 rel) { vec4 c = uVPnj * vec4(rel, 1.0); return vec3(c.xy / c.w * 0.5 + 0.5, c.w); }

// Screen-space reflection against the linear depth of the opaque scene.
vec4 traceSSR(vec3 p0, vec3 R) {
  float maxT = 80.0;
  vec4 c0 = uVPnj * vec4(p0, 1.0);
  vec3 p1 = p0 + R * maxT;
  vec4 c1 = uVPnj * vec4(p1, 1.0);
  if (c1.w < uNear) { float k = (c0.w - uNear) / max(c0.w - c1.w, 1e-4); p1 = p0 + R * maxT * k * 0.99; c1 = uVPnj * vec4(p1, 1.0); }
  vec2 s0 = c0.xy / c0.w * 0.5 + 0.5, s1 = c1.xy / c1.w * 0.5 + 0.5;
  float iw0 = 1.0 / c0.w, iw1 = 1.0 / c1.w;
  float steps = uSSRSteps;
  float jit = frameNoise(gl_FragCoord.xy);
  float prevT = 0.0;
  for (int i = 1; i <= 48; i++) {
    if (float(i) > steps) break;
    float tt = (float(i) + jit - 0.5) / steps;
    tt = tt * tt;
    vec2 s = mix(s0, s1, tt);
    if (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0) break;
    float rz = 1.0 / mix(iw0, iw1, tt);
    float sz = texture(uLinDepth, s).r;
    if (rz > sz && rz - sz < max(1.5, rz * 0.08)) {
      // refine
      float lo = prevT, hi = tt;
      for (int k = 0; k < 5; k++) {
        float mid = 0.5 * (lo + hi);
        vec2 sm = mix(s0, s1, mid);
        float mz = 1.0 / mix(iw0, iw1, mid);
        if (mz > texture(uLinDepth, sm).r) hi = mid; else lo = mid;
      }
      vec2 hs = mix(s0, s1, hi);
      vec2 edge = smoothstep(vec2(0.0), vec2(0.08), hs) * smoothstep(vec2(1.0), vec2(0.92), hs);
      float conf = edge.x * edge.y * (1.0 - smoothstep(0.6, 1.0, hi));
      return vec4(texture(uSceneColor, hs).rgb, conf);
    }
    prevT = tt;
  }
  return vec4(0.0);
}

vec4 volSample(vec2 uv) { return texture(uVol, uv); }

vec3 applyAtmo(vec3 col, vec3 rel, vec3 rd, float dist, vec2 suv) {
  vec4 v = volSample(suv);
  col = col * v.a + v.rgb;
  float Ta = exp(-dist / mix(2200.0, 500.0, uRain));
  col = mix(skyLUT(normalize(vec3(rd.x, max(rd.y, 0.02), rd.z))), col, Ta);
  float edge = smoothstep(uRenderDist * 0.75, uRenderDist * 0.98, length(rel.xz));
  col = mix(col, skyLUT(normalize(vec3(rd.x, max(rd.y, 0.0), rd.z))), edge);
  return col;
}

void main() {
  int layer = vInfo.x, nIdx = vInfo.y;
  vec3 rel = vRel;
  float dist = length(rel);
  vec3 V = -rel / dist;
  vec2 suv = gl_FragCoord.xy / uRes;
  vec3 wp = rel + uCamPos;
  float waterZ = linearDepth(gl_FragCoord.z);
  float sceneZ = texture(uLinDepth, suv).r;
  vec3 N, T, B;
  tangentFrame(nIdx, N, T, B);
  float skyVis = pow(vLight.x, 2.0);
  vec3 L = uLightDir;
  float nshadow = 1.0;
  if (dot(N, L) > -0.2) {
    float thick;
    nshadow = shadowSample(rel, N, 1.0, waterZ, frameNoise(gl_FragCoord.xy), false, thick) * cloudShadowAt(wp);
  }
  bool isWater = layer == uWaterLayer;
  if (isWater) {
    bool top = nIdx == 2;
    vec3 n = top ? waterNormal(wp.xz, dist) : N;
    bool under = !gl_FrontFacing;
    if (under) n = -n;
    float NoV = saturate(dot(n, V));
    // refraction
    float thickness = max(sceneZ - waterZ, 0.0) * dist / waterZ;
    vec2 off = n.xz * 0.05 * saturate(thickness * 0.6) / (1.0 + dist * 0.04);
    vec2 ruv = suv + off;
    if (texture(uLinDepth, ruv).r < waterZ) ruv = suv;
    vec3 refr = texture(uSceneColor, ruv).rgb;
    float thickR = max(texture(uLinDepth, ruv).r - waterZ, 0.0) * dist / waterZ;
    // per-biome water: vertex tint carries (murkiness, tropical clarity)
    vec3 wpar = pow(vTint, vec3(1.0 / 2.2));
    float murk = wpar.r, trop = wpar.g;
    vec3 wSA = mix(mix(vec3(0.30, 0.052, 0.028), vec3(0.46, 0.26, 0.42), murk), vec3(0.2, 0.03, 0.024), trop);
    vec3 wSS = vec3(mix(mix(0.012, 0.06, murk), 0.016, trop));
    vec3 wCol = mix(mix(vec3(0.015, 0.055, 0.06), vec3(0.03, 0.036, 0.012), murk), vec3(0.018, 0.11, 0.1), trop);
    vec3 sigma = (wSA + wSS) * (1.0 + uRain * 0.8);
    vec3 amb = irradiance(vec3(0.0, 1.0, 0.0)) / PI * skyVis;
    vec3 scatterCol = wCol * (amb * 1.3 + uLightColor * max(L.y, 0.0) * nshadow * 0.35);
    if (!under) {
      vec3 Tw = exp(-sigma * min(thickR, 64.0));
      refr = refr * Tw + scatterCol * (1.0 - Tw);
      // reflection
      vec3 R = reflect(-V, n);
      R.y = abs(R.y);
      vec3 sky = skyWithClouds(R, false);
      vec3 refl = sky * mix(0.25, 1.0, skyVis);
      vec4 ssr = traceSSR(rel + n * 0.05, R);
      refl = mix(refl, ssr.rgb, ssr.a);
      float F = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);
      vec3 col = mix(refr, refl, F);
      // sun glint
      vec3 H = normalize(V + L);
      float NoL = saturate(dot(n, L)), NoH = saturate(dot(n, H));
      float a = 0.03 + uRain * 0.06;
      float spec = D_GGX(NoH, a) * V_Smith(NoV, NoL, a) * NoL;
      vec3 Fs = F_Schlick(vec3(0.02), saturate(dot(V, H)));
      col += spec * Fs * uLightColor * nshadow * min(1.0, 1.0);
      // shore foam
      float foamN = fbm2(wp.xz * 1.6 + vec2(uTime * 0.25, uTime * 0.1));
      float foam = smoothstep(0.55, 0.0, thickness) * smoothstep(0.45, 0.7, foamN + 0.25 * sin(uTime * 1.5 + thickness * 8.0));
      col = mix(col, (amb * 0.9 + uLightColor * saturate(L.y) * nshadow / PI) * 0.8, foam * 0.7 * float(top));
      col = applyAtmo(col, rel, -V, dist, suv);
      o = vec4(col, 1.0);
    } else {
      // looking up at the surface from underwater: Snell's window & total internal reflection
      vec3 rr = refract(-V, n, 1.333);
      vec3 col;
      if (dot(rr, rr) < 1e-4) {
        col = scatterCol * 1.8;
      } else {
        vec3 sky = skyWithClouds(normalize(rr), true);
        vec2 wuv = suv + rr.xz * 0.05;
        vec3 above = texture(uLinDepth, wuv).r > 1e4 ? sky : texture(uSceneColor, wuv).rgb;
        float F = 0.02 + 0.98 * pow(1.0 - saturate(dot(normalize(rr), -n)), 5.0);
        col = mix(above, scatterCol * 1.8, F);
      }
      vec3 Tw = exp(-(WATER_SA + WATER_SS) * dist);
      col = col * Tw + volSample(suv).rgb;
      o = vec4(col, 1.0);
    }
    return;
  }
  // glass / ice
  vec2 uv = vUV;
  vec4 alb = texture(uAlbedo, vec3(uv, float(layer)));
  vec3 nt = texture(uNormal, vec3(uv, float(layer))).xyz * 2.0 - 1.0;
  vec3 n = normalize(T * nt.x + B * nt.y + N * nt.z);
  if (!gl_FrontFacing) n = -n;
  float NoV = saturate(dot(n, V));
  vec2 ruv = suv + n.xz * 0.012 + nt.xy * 0.01;
  if (texture(uLinDepth, ruv).r < waterZ) ruv = suv;
  vec3 refr = texture(uSceneColor, ruv).rgb;
  vec3 tintC = mix(vec3(1.0), alb.rgb, alb.a);
  vec3 amb = irradiance(n) / PI * max(skyVis, 0.02) + vec3(1.0, 0.58, 0.3) * pow(vLight.y, 2.6) * 1.2;
  vec3 R = reflect(-V, n);
  vec3 refl = skyWithClouds(R, false) * mix(0.1, 1.0, skyVis);
  vec4 ssr = traceSSR(rel + n * 0.05, R);
  refl = mix(refl, ssr.rgb, ssr.a);
  float F = 0.04 + 0.96 * pow(1.0 - NoV, 5.0);
  vec3 body = alb.rgb * (amb + uLightColor * saturate(dot(n, L)) * nshadow / PI);
  vec3 col = mix(refr * tintC * (1.0 - alb.a * 0.6) + body * alb.a * 0.6, refl, F);
  vec3 H = normalize(V + L);
  float spec = D_GGX(saturate(dot(n, H)), 0.04) * V_Smith(NoV, saturate(dot(n, L)), 0.04) * saturate(dot(n, L));
  col += spec * 0.04 * uLightColor * nshadow;
  col = applyAtmo(col, rel, -V, dist, suv);
  o = vec4(col, 1.0);
}`;
