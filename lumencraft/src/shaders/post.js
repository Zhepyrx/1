// Screen-space passes: AO, volumetric fog, deferred lighting, temporal upscaling, exposure, bloom, composite.
import { HEADER, UTIL, FRAME, ATMOS_SAMPLE, CLOUD_SAMPLE, SKY, SHADOW, FOG, BRDF } from './common.js';

const FACE_N = /* glsl */`
vec3 faceNormal(int n) {
  if (n == 0) return vec3(1, 0, 0); if (n == 1) return vec3(-1, 0, 0);
  if (n == 2) return vec3(0, 1, 0); if (n == 3) return vec3(0, -1, 0);
  if (n == 4) return vec3(0, 0, 1); if (n == 5) return vec3(0, 0, -1);
  return vec3(0, 1, 0);
}
`;

// Ground-truth AO plus near-field indirect light: occluders found during the horizon search
// contribute their previous-frame radiance (reprojected), giving one bounce of colour bleeding
// that accumulates into multiple bounces over frames.
export const aoFS = HEADER + UTIL + FACE_N + /* glsl */`
uniform sampler2D uDepth, uG1, uPrevColor;
uniform vec2 uAORes;
uniform mat4 uInvProj, uProj, uViewRot, uInvViewRot, uPrevVP;
uniform int uFrame;
uniform float uGI;
out vec4 o;
vec3 viewPos(vec2 uv, float d) { vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return p.xyz / p.w; }
void main() {
  vec2 uv = gl_FragCoord.xy / uAORes;
  float d = texture(uDepth, uv).r;
  if (d >= 1.0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec3 P = viewPos(uv, d);
  vec4 g1 = texture(uG1, uv);
  int bits = int(g1.w + 0.5);
  vec3 Nw = (bits & 7) < 6 ? faceNormal(bits & 7) : octDecode(g1.xy);
  vec3 N = normalize(mat3(uViewRot) * Nw);
  vec3 Vv = normalize(-P);
  const float radius = 1.1;
  float projScale = uProj[1][1] * 0.5 * uAORes.y;
  float rPix = radius * projScale / -P.z;
  if (rPix < 1.5) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  rPix = min(rPix, 110.0);
  float noise = ign(gl_FragCoord.xy + float(uFrame % 64) * 5.588238);
  float noise2 = fract(noise * 9.137 + 0.37);
  const int SLICES = 2, STEPS = 6;
  float vis = 0.0;
  vec3 giSum = vec3(0.0);
  float giW = 0.0;
  for (int s = 0; s < SLICES; s++) {
    float phi = (float(s) + noise) / float(SLICES) * PI;
    vec2 omega = vec2(cos(phi), sin(phi));
    vec3 dirV = vec3(omega, 0.0);
    vec3 orthoDir = dirV - dot(dirV, Vv) * Vv;
    vec3 axis = normalize(cross(orthoDir, Vv));
    vec3 projN = N - axis * dot(N, axis);
    float projNLen = max(length(projN), 1e-4);
    float sgnN = sign(dot(orthoDir, projN));
    float cosN = clamp(dot(projN, Vv) / projNLen, -1.0, 1.0);
    float n = sgnN * acos(cosN);
    float hc0 = -1.0, hc1 = -1.0;
    for (int j = 0; j < STEPS; j++) {
      float t = (float(j) + noise2) / float(STEPS);
      t = t * t;
      vec2 off = omega * max(t * rPix, float(j) + 1.0) / uAORes;
      for (int side = 0; side < 2; side++) {
        vec2 suv = side == 0 ? uv + off : uv - off;
        float sd = texture(uDepth, suv).r;
        vec3 S = viewPos(suv, sd);
        vec3 D = S - P;
        float len = length(D);
        float c = dot(D / max(len, 1e-4), Vv);
        float fall = saturate(1.0 - len * len / (radius * radius * 2.5));
        c = mix(-1.0, c, fall);
        if (side == 0) hc0 = max(hc0, c); else hc1 = max(hc1, c);
        // occluder above the tangent plane: gather its light from the previous frame
        float up = dot(D, N) / max(len, 1e-4);
        if (uGI > 0.0 && (j & 1) == 1 && up > 0.15 && fall > 0.0) {
          vec4 pc = uPrevVP * vec4(mat3(uInvViewRot) * S, 1.0);
          vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
          if (pc.w > 0.0 && puv.x > 0.0 && puv.y > 0.0 && puv.x < 1.0 && puv.y < 1.0) {
            float w = up * fall;
            giSum += min(texture(uPrevColor, puv).rgb, vec3(24.0)) * w;
            giW += w;
          }
        }
      }
    }
    float h0 = -acos(clamp(hc1, -1.0, 1.0));
    float h1 = acos(clamp(hc0, -1.0, 1.0));
    h0 = n + clamp(h0 - n, -0.5 * PI, 0.5 * PI);
    h1 = n + clamp(h1 - n, -0.5 * PI, 0.5 * PI);
    float iarc0 = (cosN + 2.0 * h0 * sin(n) - cos(2.0 * h0 - n)) / 4.0;
    float iarc1 = (cosN + 2.0 * h1 * sin(n) - cos(2.0 * h1 - n)) / 4.0;
    vis += projNLen * (iarc0 + iarc1);
  }
  vis /= float(SLICES);
  vis = pow(saturate(vis), 1.25);
  vec3 gi = giW > 0.0 ? giSum / giW * (1.0 - vis) * uGI : vec3(0.0);
  o = vec4(gi, vis);
}`;

export const aoBlurFS = HEADER + UTIL + /* glsl */`
uniform sampler2D uAO, uDepth;
uniform vec2 uAORes;
uniform float uNear, uFar;
out vec4 o;
float lin(float d) { return uNear * uFar / (uFar - d * (uFar - uNear)); }
void main() {
  vec2 uv = gl_FragCoord.xy / uAORes;
  vec2 t = 1.0 / uAORes;
  float zc = lin(texture(uDepth, uv).r);
  vec4 sum = vec4(0.0);
  float ws = 0.0;
  for (int y = -2; y <= 1; y++) for (int x = -2; x <= 1; x++) {
    vec2 s = uv + (vec2(float(x), float(y)) + 0.5) * t;
    float z = lin(texture(uDepth, s).r);
    float w = exp(-abs(z - zc) / (zc * 0.04 + 0.05));
    sum += texture(uAO, s) * w; ws += w;
  }
  o = sum / max(ws, 1e-4);
}`;

export const volFS = HEADER + UTIL + FRAME + ATMOS_SAMPLE + CLOUD_SAMPLE + SHADOW + FOG + /* glsl */`
uniform sampler2D uDepth;
uniform vec2 uVolRes;
uniform float uVolMax;
uniform int uVolSteps;
uniform vec3 uCamFwd;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uVolRes;
  float d = texture(uDepth, uv).r;
  vec3 rd = viewRay(uv);
  float dist = d >= 1.0 ? uVolMax : min(linearDepth(d) / max(dot(rd, uCamFwd), 1e-3), uVolMax);
  float N = float(uVolSteps);
  float jit = frameNoise(gl_FragCoord.xy);
  vec3 L = uLightDir;
  float cosT = dot(rd, L);
  bool uw = uUnderwater > 0.5;
  float phase = mix(hgPhase(cosT, uw ? 0.5 : 0.76), 1.0 / (4.0 * PI), 0.3);
  vec3 amb = irradiance(vec3(0.0, 1.0, 0.0)) / PI * (uw ? 0.6 : 1.0);
  vec3 acc = vec3(0.0);
  float T = 1.0;
  if (uw) {
    // water: strong per-channel absorption, weak scattering, sunlight dimming with depth
    vec3 SA = WATER_SA;
    vec3 SS = WATER_SS;
    vec3 ST = SA + SS;
    vec3 Trgb = vec3(1.0);
    float muL = max(L.y, 0.25);
    for (int i = 0; i < 64; i++) {
      if (float(i) >= N) break;
      float t0 = dist * pow(float(i) / N, 2.0), t1 = dist * pow(float(i + 1) / N, 2.0);
      float dt = t1 - t0;
      float t = mix(t0, t1, jit);
      vec3 rel = rd * t;
      vec3 wp = rel + uCamPos;
      float depth = max(62.9 - wp.y, 0.0);
      float vis = shadowFast(rel, t) * cloudShadowAt(wp);
      vec3 sunD = uLightColor * exp(-SA * depth / muL) * vis;
      vec3 ambD = amb * exp(-SA * depth * 1.3);
      vec3 S = SS * (sunD * phase + ambD);
      vec3 stepT = exp(-ST * dt);
      acc += Trgb * S * (1.0 - stepT) / ST;
      Trgb *= stepT;
    }
    o = vec4(acc, luma(Trgb));
    return;
  }
  for (int i = 0; i < 64; i++) {
    if (float(i) >= N) break;
    float t0 = dist * pow(float(i) / N, 2.0), t1 = dist * pow(float(i + 1) / N, 2.0);
    float dt = t1 - t0;
    float t = mix(t0, t1, jit);
    vec3 rel = rd * t;
    vec3 wp = rel + uCamPos;
    float den = fogDensity(wp);
    float vis = shadowFast(rel, t) * cloudShadowAt(wp);
    vec3 S = den * (uLightColor * phase * vis + amb);
    float stepT = exp(-den * dt);
    acc += T * S * (1.0 - stepT) / max(den, 1e-7);
    T *= stepT;
  }
  o = vec4(acc, T);
}`;

export const lightingFS = HEADER + UTIL + FRAME + ATMOS_SAMPLE + CLOUD_SAMPLE + SKY + SHADOW + FOG + BRDF + FACE_N + /* glsl */`
uniform sampler2D uG0, uG1, uG2, uDepth, uAO, uVol, uHistory;
uniform float uCloudBottom;
uniform vec2 uOutRes;
uniform float uSSR, uSSRSteps, uVolMax, uFlicker, uHasHistory;
uniform int uDebug;
uniform vec3 uCamFwd;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oLin;

float caustics(vec2 p, float t) {
  vec2 q = p * 0.7;
  float c = 0.0;
  for (int i = 0; i < 2; i++) {
    vec2 w = vec2(vnoise2(q + t * 0.35), vnoise2(q + 7.3 - t * 0.3));
    float n = vnoise2(q * 1.7 + w * 2.2 + t * 0.2);
    c += pow(1.0 - abs(n * 2.0 - 1.0), 7.0);
    q = q * 1.9 + 3.1;
  }
  return c;
}

vec4 ssrHistory(vec3 p0, vec3 R) {
  float maxT = 60.0;
  vec4 c0 = uVPnj * vec4(p0, 1.0);
  vec3 p1 = p0 + R * maxT;
  vec4 c1 = uVPnj * vec4(p1, 1.0);
  if (c1.w < uNear) { float k = (c0.w - uNear) / max(c0.w - c1.w, 1e-4); p1 = p0 + R * maxT * k * 0.99; c1 = uVPnj * vec4(p1, 1.0); }
  vec2 s0 = c0.xy / c0.w * 0.5 + 0.5, s1 = c1.xy / c1.w * 0.5 + 0.5;
  float iw0 = 1.0 / c0.w, iw1 = 1.0 / c1.w;
  float jit = frameNoise(gl_FragCoord.xy);
  float prevT = 0.0;
  for (int i = 1; i <= 40; i++) {
    if (float(i) > uSSRSteps) break;
    float tt = (float(i) + jit - 0.5) / uSSRSteps;
    tt *= tt;
    vec2 s = mix(s0, s1, tt);
    if (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0) break;
    float rz = 1.0 / mix(iw0, iw1, tt);
    float sd = texture(uDepth, s).r;
    float sz = sd >= 1.0 ? 1e9 : linearDepth(sd);
    if (rz > sz && rz - sz < max(1.0, rz * 0.06)) {
      float lo = prevT, hi = tt;
      for (int k = 0; k < 5; k++) {
        float mid = 0.5 * (lo + hi);
        vec2 sm = mix(s0, s1, mid);
        float mz = 1.0 / mix(iw0, iw1, mid);
        if (mz > linearDepth(texture(uDepth, sm).r)) hi = mid; else lo = mid;
      }
      vec2 hs = mix(s0, s1, hi);
      vec3 hitRel = relFromDepth(hs, texture(uDepth, hs).r);
      vec4 pc = uPrevVP * vec4(hitRel, 1.0);
      vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
      if (puv.x < 0.0 || puv.y < 0.0 || puv.x > 1.0 || puv.y > 1.0 || uHasHistory < 0.5) return vec4(0.0);
      vec2 edge = smoothstep(vec2(0.0), vec2(0.1), hs) * smoothstep(vec2(1.0), vec2(0.9), hs);
      return vec4(texture(uHistory, puv).rgb, edge.x * edge.y * (1.0 - smoothstep(0.55, 1.0, hi)));
    }
    prevT = tt;
  }
  return vec4(0.0);
}

vec3 surfaceAtmo(vec3 col, vec3 rel, vec3 rd, float dist, vec2 uv) {
  vec4 v = texture(uVol, uv);
  if (uUnderwater > 0.5) {
    vec3 T = exp(-(WATER_SA + WATER_SS) * dist);
    return col * T + v.rgb;
  }
  col = col * v.a + v.rgb;
  if (dist > uVolMax) {
    float extra = dist - uVolMax;
    vec3 pm = uCamPos + rel * ((uVolMax + dist) * 0.5 / dist);
    float den = fogDensity(pm);
    float T2 = exp(-den * extra);
    vec3 fogC = irradiance(vec3(0.0, 1.0, 0.0)) / PI + uLightColor * mix(hgPhase(dot(rd, uLightDir), 0.7), 1.0 / (4.0 * PI), 0.3) * cloudShadowAt(pm);
    col = col * T2 + fogC * (1.0 - T2);
  }
  float Ta = exp(-dist / mix(2600.0, 600.0, uRain));
  vec3 hz = skyLUT(normalize(vec3(rd.x, max(rd.y, 0.03), rd.z)));
  col = mix(hz, col, Ta);
  float edge = smoothstep(uRenderDist * 0.72, uRenderDist * 0.97, length(rel.xz));
  if (edge > 0.0) {
    // fade into exactly what a sky pixel in this direction shows (stars, moon, clouds, haze), so distant
    // hills dissolve without a ghost outline
    bool below = rd.y < 0.0 && uCamPos.y < uCloudBottom;
    vec3 hd = below ? normalize(vec3(rd.x, 0.0, rd.z)) : rd;
    vec3 s = below ? skyLUT(hd) : skyFull(rd, true);
    vec4 cl = cloudsAt(hd);
    s = (s * cl.a + cl.rgb) * v.a + v.rgb;
    col = mix(col, s, edge);
  }
  return col;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  ivec2 px = ivec2(gl_FragCoord.xy);
  float d = texelFetch(uDepth, px, 0).r;
  vec3 rd = viewRay(uv);
  if (d >= 1.0) {
    // below the horizon there is no terrain left: show the same haze that distant terrain fades into
    vec3 c = rd.y < 0.0 && uCamPos.y < uCloudBottom ? skyLUT(normalize(vec3(rd.x, 0.0, rd.z))) : skyFull(rd, true);
    vec4 cl = cloudsAt(rd.y < 0.0 && uCamPos.y < uCloudBottom ? normalize(vec3(rd.x, 0.0, rd.z)) : rd);
    c = c * cl.a + cl.rgb;
    vec4 v = texture(uVol, uv);
    c = c * v.a + v.rgb;
    if (uUnderwater > 0.5) c = c * exp(-(WATER_SA + WATER_SS) * uVolMax) + texture(uVol, uv).rgb;
    oColor = vec4(c, 1.0);
    oLin = vec4(1e6);
    return;
  }
  vec3 rel = relFromDepth(uv, d);
  float dist = length(rel);
  float viewZ = linearDepth(d);
  vec3 V = -rel / dist;
  vec4 g0 = texelFetch(uG0, px, 0), g1 = texelFetch(uG1, px, 0), g2 = texelFetch(uG2, px, 0);
  vec3 albedo = g0.rgb;
  float metal = g0.a;
  vec3 N = octDecode(g1.xy);
  float rough = max(g1.z, 0.03);
  int bits = int(g1.w + 0.5);
  int nIdx = bits & 7;
  bool foliage = (bits & 8) != 0, plant = (bits & 16) != 0, wetSurf = (bits & 32) != 0;
  vec3 Ng = faceNormal(nIdx);
  float skyL = g2.r, blkL = g2.g, vao = g2.b, packed = g2.a;
  float emissive = packed > 0.51 ? saturate((packed - 0.54) / 0.46) * 16.0 : 0.0;
  float pshadow = packed > 0.51 ? 1.0 : saturate(packed / 0.48);
  vec4 aoGI = texture(uAO, uv);
  float ssao = aoGI.a;
  float ao = vao * ssao;
  vec3 wp = rel + uCamPos;
  float noise = frameNoise(gl_FragCoord.xy);
  vec3 L = uLightDir;
  float NoLg = dot(Ng, L);
  float thick = 0.0;
  float sh = 0.0;
  float cs = 1.0;
  if ((NoLg > -0.02 || foliage || plant) && L.y > -0.03) {
    cs = cloudShadowAt(wp);
    sh = shadowSample(rel, plant ? vec3(0.0) : Ng, plant ? 1.0 : NoLg, viewZ, noise, true, thick) * pshadow * cs;
  }
  vec3 F0 = mix(vec3(0.04), albedo, metal);
  vec3 diffC = albedo * (1.0 - metal);
  float NoV = max(dot(N, V), 1e-3);
  vec3 direct;
  if (plant) {
    direct = diffC / PI * (0.55 + 0.45 * saturate(L.y * 2.0)) * sh * uLightColor;
  } else {
    vec3 H = normalize(V + L);
    float nl = saturate(dot(N, L)) * saturate(NoLg * 4.0 + 0.2);
    float a = max(rough * rough, 0.0025);
    vec3 F = F_Schlick(F0, saturate(dot(V, H)));
    vec3 spec = D_GGX(saturate(dot(N, H)), a) * V_Smith(NoV, nl, a) * F;
    direct = (diffC / PI * (1.0 - F) + min(spec, vec3(60.0))) * nl * sh * uLightColor;
  }
  if (foliage || plant) {
    float fwd = pow(saturate(dot(-V, L)), 3.0) * 2.5 + 0.35;
    direct += diffC * uLightColor * exp(-thick * 1.4) * fwd * 0.16 * cs * step(0.0, L.y);
  }
  float wdepth = max(62.9 - wp.y, 0.0);
  if (wetSurf) {
    float c = caustics(wp.xz + L.xz / max(L.y, 0.2) * (62.0 - wp.y), uTime);
    direct *= (0.45 + c * 2.2) * exp(-WATER_SA * wdepth / max(L.y, 0.25));
  }
  float skyVis = skyL * skyL * (0.3 + 0.7 * skyL);
  vec3 E = irradiance((foliage || plant) ? normalize(N + vec3(0.0, 0.8, 0.0)) : N) * skyVis;
  if (foliage) E *= 1.25;
  vec3 ambient = diffC / PI * E * ao;
  float blv = blkL * 15.0;
  float bl = 7.0 * exp2((blv - 15.0) * 0.62) * smoothstep(0.0, 2.0, blv);
  vec3 blockE = vec3(1.0, 0.54, 0.24) * bl * uFlicker;
  ambient += diffC / PI * blockE * mix(ao, 1.0, 0.3);
  ambient += diffC * 0.0005 * ao;
  ambient += diffC * aoGI.rgb * vao;
  if (wetSurf) ambient *= exp(-WATER_SA * wdepth * 1.3);
  vec2 ab = envBRDF(NoV, rough);
  vec3 specC = F0 * ab.x + ab.y;
  vec3 R = reflect(-V, N);
  vec3 env = skyLUTBlur(normalize(vec3(R.x, max(R.y, 0.0), R.z)), rough * 5.0) * skyVis;
  env = mix(env, irradiance(vec3(0.0, -1.0, 0.0)) / PI * skyVis, saturate(-R.y * 3.0));
  env += blockE / PI * 0.5 * rough;
  if (uSSR > 0.5 && rough < 0.3 && !plant) {
    vec4 ss = ssrHistory(rel + Ng * 0.04, R);
    env = mix(env, ss.rgb, ss.a * (1.0 - rough / 0.3));
  }
  float specOcc = saturate(pow(NoV + ao, exp2(-16.0 * rough - 1.0)) - 1.0 + ao);
  vec3 col = direct + ambient + env * specC * specOcc + albedo * emissive;
  if (uCamPos.y > uCloudBottom) {
    vec4 cl = cloudsAt(rd);
    col = col * cl.a + cl.rgb;
  }
  vec3 pre = col;
  col = surfaceAtmo(col, rel, -V, dist, uv);
  if (uDebug == 1) col = pre;
  else if (uDebug == 2) col = texture(uVol, uv).rgb * 10.0;
  else if (uDebug == 3) col = vec3(texture(uVol, uv).a);
  else if (uDebug == 4) col = albedo;
  else if (uDebug == 5) col = N * 0.5 + 0.5;
  else if (uDebug == 6) col = vec3(ssao);
  else if (uDebug == 7) col = vec3(sh, cs, pshadow);
  else if (uDebug == 8) col = irradiance(N);
  else if (uDebug == 9) col = vec3(skyL, blkL, vao);
  else if (uDebug == 10) col = direct;
  else if (uDebug == 11) col = ambient;
  oColor = vec4(max(col, 0.0), 1.0);
  oLin = vec4(viewZ);
}`;

export const taaFS = HEADER + UTIL + FRAME + /* glsl */`
uniform sampler2D uCurr, uDepth, uHist;
uniform vec2 uInRes, uOutRes, uJitter;
uniform float uReset;
out vec4 o;
vec3 rgb2ycocg(vec3 c) { return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b); }
vec3 ycocg2rgb(vec3 c) { return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
vec3 tmap(vec3 c) { return c / (1.0 + luma(c)); }
vec3 itmap(vec3 c) { return c / max(1.0 - luma(c), 1e-4); }
vec3 sampleCR(sampler2D tex, vec2 uv, vec2 size) {
  vec2 pos = uv * size;
  vec2 tc = floor(pos - 0.5) + 0.5;
  vec2 f = pos - tc;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 off = w2 / w12;
  vec2 t0 = (tc - 1.0) / size, t3 = (tc + 2.0) / size, t12 = (tc + off) / size;
  vec3 r = texture(tex, vec2(t12.x, t0.y)).rgb * (w12.x * w0.y)
         + texture(tex, vec2(t0.x, t12.y)).rgb * (w0.x * w12.y)
         + texture(tex, t12).rgb * (w12.x * w12.y)
         + texture(tex, vec2(t3.x, t12.y)).rgb * (w3.x * w12.y)
         + texture(tex, vec2(t12.x, t3.y)).rgb * (w12.x * w3.y);
  float ws = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(r / ws, 0.0);
}
vec3 clipAABB(vec3 q, vec3 mn, vec3 mx) {
  vec3 c = 0.5 * (mx + mn), e = 0.5 * (mx - mn) + 1e-5;
  vec3 v = q - c;
  vec3 u = abs(v / e);
  float m = max(u.x, max(u.y, u.z));
  return m > 1.0 ? c + v / m : q;
}
void main() {
  vec2 uvOut = gl_FragCoord.xy / uOutRes;
  vec2 p = uvOut * uInRes;
  ivec2 ic = ivec2(floor(p + uJitter));
  ivec2 maxI = ivec2(uInRes) - 1;
  float scale = uOutRes.x / uInRes.x;
  vec3 sum = vec3(0.0), m1 = vec3(0.0), m2 = vec3(0.0);
  vec3 mn = vec3(1e9), mx = vec3(-1e9);
  float wsum = 0.0, wmax = 0.0;
  float closestD = 1.0;
  ivec2 cpx = clamp(ic, ivec2(0), maxI);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    ivec2 q = clamp(ic + ivec2(x, y), ivec2(0), maxI);
    vec3 c = tmap(texelFetch(uCurr, q, 0).rgb);
    vec2 s = vec2(q) + 0.5 - uJitter;
    vec2 dd = (s - p) * scale;
    float w = exp(-2.29 * dot(dd, dd));
    sum += c * w; wsum += w; wmax = max(wmax, w);
    vec3 yc = rgb2ycocg(c);
    m1 += yc; m2 += yc * yc; mn = min(mn, yc); mx = max(mx, yc);
    float dq = texelFetch(uDepth, q, 0).r;
    if (dq < closestD) { closestD = dq; cpx = q; }
  }
  vec3 cur = sum / max(wsum, 1e-5);
  // wide reconstruction for disoccluded pixels
  vec3 wide = rgb2ycocg(cur);
  vec2 quv = (vec2(cpx) + 0.5) / uInRes;
  vec3 rel = relFromDepth(quv, closestD);
  vec4 pc = uPrevVP * vec4(rel, 1.0);
  vec4 cc = uVPnj * vec4(rel, 1.0);
  vec2 motion = pc.xy / pc.w * 0.5 + 0.5 - (cc.xy / cc.w * 0.5 + 0.5);
  vec2 hUV = uvOut + motion;
  bool off = hUV.x < 0.0 || hUV.y < 0.0 || hUV.x > 1.0 || hUV.y > 1.0 || uReset > 0.5 || pc.w <= 0.0;
  vec3 hist = tmap(sampleCR(uHist, hUV, uOutRes));
  vec3 mu = m1 / 9.0;
  vec3 sig = sqrt(max(m2 / 9.0 - mu * mu, 0.0));
  float vel = length(motion * uOutRes);
  float gamma = mix(1.25, 0.85, saturate(vel / 20.0));
  vec3 bmin = max(mn, mu - gamma * sig), bmax = min(mx, mu + gamma * sig);
  vec3 hy = clipAABB(rgb2ycocg(hist), bmin, bmax);
  hist = ycocg2rgb(hy);
  float alpha = mix(0.035, 0.12, saturate(wmax)) + saturate(vel * 0.01) * 0.06;
  vec3 res = off ? ycocg2rgb(wide) : mix(hist, cur, alpha);
  o = vec4(itmap(res), 1.0);
  (void(0));
}`.replace('(void(0));', '');

export const lumFS = HEADER + UTIL + /* glsl */`
uniform sampler2D uSrc;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / 64.0;
  vec3 c = texture(uSrc, uv).rgb;
  float l = log2(max(luma(c), 1e-6));
  vec2 d = uv - 0.5;
  float w = exp(-dot(d, d) * 5.0);
  o = vec4(l * w, w, 0.0, 1.0);
}`;

export const exposureFS = HEADER + UTIL + /* glsl */`
uniform sampler2D uLum, uPrev;
uniform float uDt, uEVComp, uMinLum, uMaxLum, uLumLevel, uReset;
out vec4 o;
void main() {
  vec2 a = textureLod(uLum, vec2(0.5), uLumLevel).rg;
  float avg = exp2(a.x / max(a.y, 1e-6));
  avg = clamp(avg, uMinLum, uMaxLum);
  // dim scenes keep a lower key so nights stay dark instead of being lifted to daylight
  float key = 0.14 * pow(min(avg / 0.35, 1.0), 0.36);
  float target = key / avg * exp2(uEVComp);
  float prev = texelFetch(uPrev, ivec2(0), 0).r;
  if (!(prev > 0.0) || uReset > 0.5 || prev > 1e6) prev = target;
  float speed = target > prev ? 1.1 : 2.2;
  float e = exp2(mix(log2(prev), log2(target), 1.0 - exp(-uDt * speed)));
  o = vec4(e, 0.0, 0.0, 1.0);
}`;

export const bloomDownFS = HEADER + UTIL + /* glsl */`
uniform sampler2D uSrc;
uniform vec2 uSrcTexel, uDstRes;
uniform int uFirst;
out vec4 o;
vec3 s(vec2 uv) { return texture(uSrc, uv).rgb; }
float kw(vec3 c) { return 1.0 / (1.0 + luma(c)); }
void main() {
  vec2 uv = gl_FragCoord.xy / uDstRes;
  vec2 t = uSrcTexel;
  vec3 a = s(uv + t * vec2(-2, 2)), b = s(uv + t * vec2(0, 2)), c = s(uv + t * vec2(2, 2));
  vec3 d = s(uv + t * vec2(-2, 0)), e = s(uv), f = s(uv + t * vec2(2, 0));
  vec3 g = s(uv + t * vec2(-2, -2)), h = s(uv + t * vec2(0, -2)), i = s(uv + t * vec2(2, -2));
  vec3 j = s(uv + t * vec2(-1, 1)), k = s(uv + t * vec2(1, 1)), l = s(uv + t * vec2(-1, -1)), m = s(uv + t * vec2(1, -1));
  vec3 r;
  if (uFirst == 1) {
    vec3 g0 = (j + k + l + m) * 0.25, g1 = (a + b + d + e) * 0.25, g2 = (b + c + e + f) * 0.25, g3 = (d + e + g + h) * 0.25, g4 = (e + f + h + i) * 0.25;
    float w0 = kw(g0) * 0.5, w1 = kw(g1) * 0.125, w2 = kw(g2) * 0.125, w3 = kw(g3) * 0.125, w4 = kw(g4) * 0.125;
    r = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
  } else {
    r = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  o = vec4(min(r, vec3(6e4)), 1.0);
}`;

export const bloomUpFS = HEADER + /* glsl */`
uniform sampler2D uSrc;
uniform vec2 uSrcTexel, uDstRes;
uniform float uWeight;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uDstRes;
  vec2 t = uSrcTexel;
  vec3 c = texture(uSrc, uv + vec2(-t.x, t.y)).rgb + texture(uSrc, uv + vec2(0.0, t.y)).rgb * 2.0 + texture(uSrc, uv + t).rgb
         + texture(uSrc, uv + vec2(-t.x, 0.0)).rgb * 2.0 + texture(uSrc, uv).rgb * 4.0 + texture(uSrc, uv + vec2(t.x, 0.0)).rgb * 2.0
         + texture(uSrc, uv - t).rgb + texture(uSrc, uv + vec2(0.0, -t.y)).rgb * 2.0 + texture(uSrc, uv + vec2(t.x, -t.y)).rgb;
  o = vec4(c / 16.0 * uWeight, 1.0);
}`;

export const compositeFS = HEADER + UTIL + /* glsl */`
uniform sampler2D uSrc, uBloom, uExposure, uDepth;
uniform mat4 uInvVP, uPrevVP;
uniform float uMotionBlur;
uniform vec2 uOutRes;
uniform float uBloomStr, uSharpen, uVignette, uGrain, uTime, uUnderwater, uSaturation, uContrast, uPurkinje;
uniform int uFrame;
out vec4 o;
vec3 tonemap(vec3 c) {
  float l = luma(c);
  c = mix(vec3(l), c, 0.9);
  c = max(c, 1e-9);
  vec3 x = clamp((log2(c) + 10.0) / 16.5, 0.0, 1.0);
  float k = 10.0 * uContrast, x0 = 0.456;
  float s0 = 1.0 / (1.0 + exp(k * x0)), s1 = 1.0 / (1.0 + exp(-k * (1.0 - x0)));
  vec3 y = (1.0 / (1.0 + exp(-k * (x - x0))) - s0) / (s1 - s0);
  float ly = luma(y);
  y = mix(vec3(ly), y, 1.1 * uSaturation);
  return clamp(y, 0.0, 1.0);
}
vec3 fetch(ivec2 p) { return texelFetch(uSrc, clamp(p, ivec2(0), ivec2(uOutRes) - 1), 0).rgb; }
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec2 uv = gl_FragCoord.xy / uOutRes;
  if (uUnderwater > 0.5) {
    vec2 w = vec2(sin(uv.y * 24.0 + uTime * 2.0), cos(uv.x * 20.0 + uTime * 1.7)) * 0.0025;
    px = ivec2((uv + w) * uOutRes);
    uv += w;
  }
  vec3 c = fetch(px);
  // camera motion blur along the reprojected screen velocity (static world)
  if (uMotionBlur > 0.0) {
    float d = texture(uDepth, uv).r;
    vec4 wp = uInvVP * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 pc = uPrevVP * vec4(wp.xyz / wp.w, 1.0);
    vec2 vel = (uv - (pc.xy / pc.w * 0.5 + 0.5)) * uMotionBlur;
    float vpx = length(vel * uOutRes);
    if (pc.w > 0.0 && vpx > 1.5) {
      vel *= min(1.0, 36.0 / vpx);
      vec3 acc = vec3(0.0);
      float jit = ign(gl_FragCoord.xy + float(uFrame % 8) * 3.1) - 0.5;
      for (int k = 0; k < 8; k++) {
        vec2 suv = uv + vel * ((float(k) + 0.5 + jit) / 8.0 - 0.5);
        acc += texture(uSrc, suv).rgb;
      }
      c = acc / 8.0;
    }
  }
  // contrast-adaptive sharpening in a perceptual domain
  vec3 n = fetch(px + ivec2(0, 1)), s = fetch(px - ivec2(0, 1)), e = fetch(px + ivec2(1, 0)), w = fetch(px - ivec2(1, 0));
  vec3 pc = c / (1.0 + c), pn = n / (1.0 + n), ps = s / (1.0 + s), pe = e / (1.0 + e), pw = w / (1.0 + w);
  vec3 mn = min(pc, min(min(pn, ps), min(pe, pw))), mx = max(pc, max(max(pn, ps), max(pe, pw)));
  vec3 amp = sqrt(saturate(min(mn, 1.0 - mx) / max(mx, 1e-4)));
  vec3 wgt = -amp * mix(0.0, 0.2, uSharpen);
  vec3 sharp = (pc + wgt * (pn + ps + pe + pw)) / (1.0 + 4.0 * wgt);
  sharp = clamp(sharp, 0.0, 0.9999);
  c = sharp / (1.0 - sharp);
  float exposure = texelFetch(uExposure, ivec2(0), 0).r;
  vec3 bloom = texture(uBloom, uv).rgb;
  c = mix(c, bloom, uBloomStr);
  c *= exposure;
  // scotopic (night) vision: blue shift and desaturation in very low light
  float lum = luma(c);
  float scot = saturate(1.0 - lum / 0.03) * uPurkinje;
  c = mix(c, vec3(lum) * vec3(0.72, 0.88, 1.25), scot * 0.6);
  if (uUnderwater > 0.5) c *= vec3(0.85, 1.0, 1.05);
  vec3 m = tonemap(c);
  float v = length((uv - 0.5) * vec2(uOutRes.x / uOutRes.y, 1.0));
  m *= 1.0 - uVignette * smoothstep(0.35, 1.1, v);
  float g = hash12(gl_FragCoord.xy + fract(uTime * 13.7) * 311.0) - 0.5;
  m += g * uGrain * (1.0 - m) * m * 2.0;
  m += (ign(gl_FragCoord.xy + float(uFrame % 32) * 7.1) - 0.5) / 255.0;
  o = vec4(m, 1.0);
}`;

export const copyFS = HEADER + /* glsl */`
uniform sampler2D uSrc;
in vec2 vUV;
out vec4 o;
void main() { o = texture(uSrc, vUV); }`;
