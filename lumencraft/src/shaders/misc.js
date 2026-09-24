// Selection outline, stateless ambient particles and block-break debris.
import { HEADER, UTIL, FRAME, ATMOS_SAMPLE, SHADOW } from './common.js';

export const outlineVS = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec3 aP;
layout(location = 1) in vec3 aQ;
layout(location = 2) in float aSide;
uniform mat4 uVP;
uniform vec3 uOrigin;
uniform vec2 uOutRes;
uniform float uWidth;
void main() {
  vec3 grow = vec3(0.004);
  vec4 a = uVP * vec4(uOrigin + aP * (1.0 + 2.0 * grow) - grow, 1.0);
  vec4 b = uVP * vec4(uOrigin + aQ * (1.0 + 2.0 * grow) - grow, 1.0);
  if (a.w < 0.01) a.w = 0.01;
  if (b.w < 0.01) b.w = 0.01;
  vec2 sa = a.xy / a.w * uOutRes, sb = b.xy / b.w * uOutRes;
  vec2 dir = normalize(sb - sa + 1e-5);
  vec2 perp = vec2(-dir.y, dir.x);
  gl_Position = a;
  gl_Position.xy += perp * aSide * uWidth / uOutRes * a.w;
}`;

export const outlineFS = HEADER + /* glsl */`
uniform sampler2D uDepth;
uniform vec2 uOutRes;
uniform float uNear, uFar;
out vec4 o;
float lin(float d) { return uNear * uFar / (uFar - d * (uFar - uNear)); }
void main() {
  vec2 uv = gl_FragCoord.xy / uOutRes;
  float sz = lin(texture(uDepth, uv).r);
  float fz = lin(gl_FragCoord.z);
  if (fz > sz * 1.004 + 0.03) discard;
  o = vec4(0.02, 0.02, 0.02, 0.62);
}`;

// Stateless particles: positions derive from the instance id and time, wrapped in a box around the camera.
export const particleVS = HEADER + UTIL + FRAME + ATMOS_SAMPLE + SHADOW + /* glsl */`
layout(location = 0) in vec2 aCorner;
uniform mat4 uVP;
uniform int uKind;
uniform float uIntensity;
uniform float uWindSmoke;
uniform sampler2D uSurf;
uniform vec2 uSurfOrigin;
uniform vec4 uEmit[4];
uniform int uEmitCount;
out vec2 vC;
out vec4 vCol;
flat out int vK;
vec2 surfAt(vec2 xz) {
  vec2 uv = (floor(xz) - uSurfOrigin + 0.5) / 128.0;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec2(0.0, 0.0);
  vec2 s = texture(uSurf, uv).rg * 255.0;
  return s;
}
void main() {
  float id = float(gl_InstanceID);
  vec3 h = hash33(vec3(id * 0.1731, id * 0.3137 + float(uKind) * 7.0, id * 0.0917));
  vec3 box; vec3 vel; float size; vec3 col; float alpha = 1.0;
  vec3 wobble = vec3(0.0);
  vK = uKind;
  float t = uTime;
  if (uKind == 0) { box = vec3(30.0, 22.0, 30.0); vel = vec3(1.2, -12.0, 0.5); size = 0.006; }
  else if (uKind == 5) { box = vec3(18.0, 1.0, 18.0); vel = vec3(0.0); size = 0.12; }
  else if (uKind == 1) { box = vec3(30.0, 20.0, 30.0); vel = vec3(0.4, -1.3, 0.2); size = 0.04; wobble = vec3(sin(t * 1.3 + id), 0.0, cos(t * 1.1 + id * 1.7)) * 0.4; }
  else if (uKind == 2) { box = vec3(40.0, 5.0, 40.0); vel = vec3(0.0); size = 0.05; wobble = vec3(sin(t * 0.7 + id * 3.1) * 1.5, sin(t * 1.1 + id) * 0.6, cos(t * 0.6 + id * 2.3) * 1.5); }
  else if (uKind == 3) { box = vec3(12.0, 8.0, 12.0); vel = vec3(0.25, 0.05, 0.12); size = 0.007; wobble = vec3(sin(t * 0.5 + id), sin(t * 0.3 + id * 2.0), cos(t * 0.4 + id)) * 0.5; }
  else if (uKind == 6) { box = vec3(34.0, 16.0, 34.0); vel = vec3(0.7, -0.9, 0.35); size = 0.1; wobble = vec3(sin(t * 1.1 + id * 2.1) * 1.2, 0.0, cos(t * 0.9 + id) * 0.9); }
  else if (uKind == 7) { box = vec3(26.0, 12.0, 26.0); vel = vec3(0.06, 0.22, 0.04); size = 0.035; wobble = vec3(sin(t * 0.4 + id * 1.3), sin(t * 0.6 + id), cos(t * 0.35 + id * 2.1)) * 0.8; }
  else if (uKind == 8) { box = vec3(30.0, 16.0, 30.0); vel = vec3(0.5, -0.45, 0.3); size = 0.045; wobble = vec3(sin(t * 0.9 + id), 0.0, cos(t * 0.7 + id * 1.7)) * 0.7; }
  else if (uKind == 9) { box = vec3(20.0, 14.0, 20.0); vel = vec3(0.2, 1.6, 0.1); size = 0.022; wobble = vec3(sin(t * 3.0 + id * 2.3), 0.0, cos(t * 2.6 + id)) * 0.35; }
  else { box = vec3(30.0, 14.0, 30.0); vel = vec3(0.9, -0.7, 0.4); size = 0.07; wobble = vec3(sin(t * 1.7 + id * 2.1), 0.0, cos(t * 1.3 + id)) * 0.6; }
  vec3 base = h * box + vel * t;
  vec3 p = uCamPos + mod(base - uCamPos + box * 0.5, box) - box * 0.5 + wobble;
  float life = 0.0;
  if (uKind == 10 || uKind == 11) {
    // plumes rising from campfires: each particle cycles through its life above one emitter
    int e = int(mod(id, float(max(uEmitCount, 1))));
    vec3 src = uEmit[e].xyz + vec3(0.5, 0.35, 0.5);
    float rate = uKind == 10 ? 0.16 : 0.55;
    life = fract(t * rate + h.x);
    float rise = uKind == 10 ? life * 7.0 : life * 3.2;
    vec3 drift = vec3(sin(t * 0.4 + h.y * 6.0), 0.0, cos(t * 0.33 + h.z * 6.0)) * life * life * (uKind == 10 ? 2.2 : 0.8);
    p = src + vec3((h.y - 0.5) * 0.3, rise, (h.z - 0.5) * 0.3) + drift + vec3(1.0, 0.0, 0.4) * life * uWindSmoke;
    size = uKind == 10 ? 0.12 + life * 0.9 : 0.018;
    box = vec3(60.0);
  }
  vec2 sf = surfAt(p.xz);
  float ground = sf.x;
  int flags = int(sf.y + 0.5);
  bool visible = true;
  float splash = 0.0;
  if (uKind == 5) {
    float ph = fract(t * 1.7 + h.z * 13.0);
    p.y = ground + 1.02;
    splash = ph;
    visible = (flags & 4) == 0 && ground > 0.0 && abs(p.y - uCamPos.y) < 12.0;
  }
  if (uKind == 0 || uKind == 1) {
    visible = p.y > ground + 1.0;
    bool cold = (flags & 4) != 0;
    visible = visible && (uKind == 0 ? !cold : cold);
  } else if (uKind == 2) {
    p.y = ground + 1.2 + h.y * 2.6 + wobble.y;
    visible = (flags & 16) != 0 && ground > 0.0;
  } else if (uKind == 4) {
    visible = (flags & 2) != 0 && p.y > ground + 0.3 && p.y < ground + 10.0;
  } else if (uKind == 6) {
    visible = (flags & 1) != 0 && p.y > ground + 0.15 && p.y < ground + 14.0;
  } else if (uKind == 7) {
    visible = (flags & 32) != 0 && p.y > ground + 0.4 && p.y < ground + 9.0;
  } else if (uKind == 8) {
    visible = (flags & 64) != 0 && p.y > ground + 0.2;
  } else if (uKind == 9) {
    visible = (flags & 64) != 0 && p.y > ground + 0.3 && p.y < ground + 12.0;
  } else if (uKind == 10 || uKind == 11) {
    visible = uEmitCount > 0;
  }
  vec3 rel = p - uCamPos;
  float dist = length(rel);
  vec3 V = rel / max(dist, 1e-3);
  vec3 right, up;
  if (uKind == 0) {
    up = normalize(vel);
    right = normalize(cross(up, V)) * size * (1.0 + dist * 0.06);
    up *= 0.3;
  } else if (uKind == 5) {
    right = vec3(1.0, 0.0, 0.0) * size * (0.3 + splash);
    up = vec3(0.0, 0.0, 1.0) * size * (0.3 + splash);
  } else {
    right = normalize(cross(vec3(0.0, 1.0, 0.0), V)) * size;
    up = normalize(cross(V, right)) * size;
    if (uKind == 4 || uKind == 6 || uKind == 8) {
      float a = t * (uKind == 6 ? 1.3 : 2.0) + id;
      right = right * cos(a) + up * sin(a) * 0.5;
      up = up * (0.6 + 0.4 * sin(a * 1.3));
    }
  }
  vec3 wpos = rel + right * aCorner.x * 2.0 + up * aCorner.y * 2.0;
  vec3 amb = irradiance(vec3(0.0, 1.0, 0.0)) / PI;
  float sh = shadowFast(rel, dist);
  if (uKind == 0) { col = (amb * 1.1 + uLightColor * 0.06) * 0.55; alpha = 0.32; }
  else if (uKind == 5) { col = amb * 0.25 * (1.0 - splash); alpha = 0.35 * (1.0 - splash); }
  else if (uKind == 1) { col = amb * 0.9 + uLightColor * sh * 0.25; alpha = 0.9; }
  else if (uKind == 2) {
    float blink = pow(max(sin(t * (0.8 + h.z * 1.4) + id * 5.0), 0.0), 6.0);
    col = vec3(0.9, 1.0, 0.35) * 14.0 * blink; alpha = 0.0;
  } else if (uKind == 3) {
    col = uLightColor * sh * 0.03 * (0.4 + 0.6 * pow(max(dot(-V, uLightDir), 0.0), 3.0)) + amb * 0.004; alpha = 0.0;
  } else if (uKind == 6) {
    vec3 leaf = h.z < 0.33 ? vec3(0.75, 0.12, 0.05) : h.z < 0.66 ? vec3(0.92, 0.45, 0.08) : vec3(0.93, 0.72, 0.16);
    col = leaf * (amb * 0.8 + uLightColor * sh * 0.3); alpha = 1.0;
  } else if (uKind == 7) {
    float tw = 0.55 + 0.45 * sin(t * (1.2 + h.x * 2.0) + id * 3.7);
    col = mix(vec3(0.25, 0.9, 1.0), vec3(0.6, 1.0, 0.8), h.y) * 3.2 * tw * (0.35 + 0.65 * uNight); alpha = 0.0;
  } else if (uKind == 8) {
    col = vec3(0.3, 0.29, 0.28) * (amb * 0.9 + uLightColor * sh * 0.3); alpha = 0.8;
  } else if (uKind == 9) {
    float life = fract(p.y * 0.08 + h.z);
    col = mix(vec3(1.0, 0.55, 0.12), vec3(1.0, 0.2, 0.03), life) * 22.0 * (1.0 - life) * (0.6 + 0.4 * sin(t * 13.0 + id)); alpha = 0.0;
  } else if (uKind == 10) {
    // wood smoke: warm-lit at the base by the fire, grey and thinning as it rises
    float a = smoothstep(0.0, 0.08, life) * (1.0 - life) * 0.3;
    col = vec3(1.0, 0.5, 0.2) * 0.45 * (1.0 - smoothstep(0.0, 0.2, life)) + vec3(0.36, 0.35, 0.34) * (amb * 1.1 + uLightColor * sh * 0.25);
    col *= a; alpha = a;
  } else if (uKind == 11) {
    col = mix(vec3(1.0, 0.7, 0.25), vec3(1.0, 0.25, 0.04), life) * 28.0 * (1.0 - life) * (0.5 + 0.5 * sin(t * 17.0 + id * 3.0)); alpha = 0.0;
  } else {
    col = vec3(0.95, 0.62, 0.78) * (amb * 0.8 + uLightColor * sh * 0.35); alpha = 1.0;
  }
  float fade = smoothstep(box.x * 0.5, box.x * 0.3, length(rel.xz)) * smoothstep(uKind == 0 ? 1.5 : 0.3, uKind == 0 ? 4.0 : 1.2, dist);
  if (uKind == 10 || uKind == 11) fade = smoothstep(0.2, 1.0, dist);
  vCol = vec4(col * uIntensity * fade, alpha * uIntensity * fade);
  vC = aCorner * 2.0;
  gl_Position = uVP * vec4(wpos, 1.0);
  if (!visible) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
}`;

export const particleFS = HEADER + /* glsl */`
in vec2 vC;
in vec4 vCol;
flat in int vK;
out vec4 o;
void main() {
  float r = length(vC);
  float a;
  if (vK == 0) a = (1.0 - abs(vC.x)) * smoothstep(1.0, 0.6, abs(vC.y));
  else if (vK == 4) { a = step(r, 0.85); }
  else if (vK == 6) { float ang = atan(vC.y, vC.x); a = step(r, 0.55 + 0.35 * pow(abs(cos(ang * 2.5)), 0.6)); }
  else if (vK == 8) { float ang = atan(vC.y, vC.x); a = step(r, 0.6 + 0.3 * sin(ang * 3.0 + vCol.a * 9.0)); }
  else if (vK == 5) { a = smoothstep(0.12, 0.0, abs(r - 0.8)) * step(r, 1.0); }
  else a = exp(-r * r * 3.5) * step(r, 1.0);
  if (a < 0.003) discard;
  o = vec4(vCol.rgb * a, vCol.a * a);
}`;

export const debrisVS = HEADER + UTIL + FRAME + ATMOS_SAMPLE + /* glsl */`
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aPos;   // world xyz, size
layout(location = 2) in vec4 aInfo;  // layer, u, v, light (sky*16+block)
uniform mat4 uVP;
out vec2 vUV;
out vec3 vLightC;
flat out float vLayer;
void main() {
  vec3 rel = aPos.xyz - uCamPos;
  vec3 V = normalize(rel);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), V));
  vec3 up = cross(V, right);
  vec3 p = rel + (right * aCorner.x + up * aCorner.y) * aPos.w;
  vUV = aInfo.yz + (aCorner + 0.5) * 0.25;
  vLayer = aInfo.x;
  float sky = floor(aInfo.w / 16.0) / 15.0, blk = mod(aInfo.w, 16.0) / 15.0;
  vLightC = irradiance(vec3(0.0, 1.0, 0.0)) / PI * sky * sky + uLightColor * 0.25 * sky + vec3(1.0, 0.55, 0.25) * pow(blk, 2.6) * 1.8;
  gl_Position = uVP * vec4(p, 1.0);
}`;

export const debrisFS = HEADER + /* glsl */`
in vec2 vUV;
in vec3 vLightC;
flat in float vLayer;
uniform sampler2DArray uAlbedo;
out vec4 o;
void main() {
  vec4 a = texture(uAlbedo, vec3(vUV, vLayer));
  if (a.a < 0.3) discard;
  o = vec4(a.rgb * vLightC, 1.0);
}`;
