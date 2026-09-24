// Creatures: instanced cuboid parts written into the same G-buffer as the terrain, plus a
// depth-only variant for the near shadow cascades.
import { HEADER, UTIL } from './common.js';

const ENTITY_VS = /* glsl */`
layout(location = 0) in vec3 aP;      // unit cube corner
layout(location = 1) in float aFace;  // 0..5: +x -x +y -y +z -z
layout(location = 2) in vec4 aM0;
layout(location = 3) in vec4 aM1;
layout(location = 4) in vec4 aM2;
layout(location = 5) in vec4 aC1;     // albedo (linear), roughness
layout(location = 6) in vec4 aC2;     // secondary colour, pattern
layout(location = 7) in vec4 aInfo;   // sky light, glow, fade, wet
uniform mat4 uVP;
vec3 entityPos() { vec4 p = vec4(aP, 1.0); return vec3(dot(aM0, p), dot(aM1, p), dot(aM2, p)); }
`;

export const entityVS = HEADER + ENTITY_VS + /* glsl */`
out vec3 vN;
out vec3 vLocal;
out vec3 vRound;
flat out vec3 vSize;
flat out vec4 vC1, vC2, vInfo;
flat out int vFace;
void main() {
  vec3 rel = entityPos();
  vec3 X = vec3(aM0.x, aM1.x, aM2.x), Y = vec3(aM0.y, aM1.y, aM2.y), Z = vec3(aM0.z, aM1.z, aM2.z);
  int f = int(aFace + 0.5);
  vec3 n;
  if (f < 2) n = cross(Y, Z); else if (f < 4) n = cross(Z, X); else n = cross(X, Y);
  vN = normalize(n) * ((f & 1) == 0 ? 1.0 : -1.0);
  vSize = vec3(length(X), length(Y), length(Z));
  // direction from the box centre, used to round off the box's shading
  vec3 centre = vec3(dot(aM0, vec4(0.5, 0.5, 0.5, 1.0)), dot(aM1, vec4(0.5, 0.5, 0.5, 1.0)), dot(aM2, vec4(0.5, 0.5, 0.5, 1.0)));
  vRound = rel - centre;
  vLocal = aP;
  vC1 = aC1; vC2 = aC2; vInfo = aInfo; vFace = f;
  gl_Position = uVP * vec4(rel, 1.0);
}`;

export const entityFS = HEADER + UTIL + /* glsl */`
in vec3 vN;
in vec3 vLocal;
in vec3 vRound;
flat in vec3 vSize;
flat in vec4 vC1, vC2, vInfo;
flat in int vFace;
uniform float uTime;
uniform int uFrame;
layout(location = 0) out vec4 oAlb;
layout(location = 1) out vec4 oNrm;
layout(location = 2) out vec4 oMisc;
void main() {
  // spawn/despawn dissolve
  if (vInfo.z < 0.999 && ign(gl_FragCoord.xy + float(uFrame % 16) * 5.588) > vInfo.z) discard;
  vec3 lp = vLocal * vSize;
  int pat = int(vC2.w + 0.5);
  vec3 col = vC1.rgb;
  float rough = vC1.w;
  float emit = 0.0, metal = 0.0;
  float fur = vnoise3(lp * 55.0) * 0.6 + vnoise3(lp * 140.0) * 0.4;
  if (pat == 1) {
    // countershading: pale belly and throat
    float belly = smoothstep(0.5, 0.15, vLocal.y) * (vFace == 3 ? 1.0 : 0.85);
    col = mix(col, vC2.rgb, belly);
  } else if (pat == 2) {
    vec3 cell = floor(lp * 22.0);
    float spot = step(0.72, hash13(cell)) * step(0.45, vLocal.y);
    col = mix(col, vC2.rgb, spot);
  } else if (pat == 3) {
    // eyes on the sides near the front, a dark nose on the front face
    bool side = vFace < 2;
    vec2 e = vec2(vLocal.z, vLocal.y);
    if (side && abs(e.x - 0.72) < 0.1 && abs(e.y - 0.66) < 0.11) { col = vC2.rgb; rough = 0.12; }
    if (vFace == 4 && vLocal.y < 0.45 && abs(vLocal.x - 0.5) < 0.22) { col = mix(col, vC2.rgb, 0.85); rough = 0.35; }
  } else if (pat == 4) {
    // feathers: banding along the wing and darker primaries at the tip
    float band = smoothstep(0.35, 0.5, fract(lp.x * 24.0 + lp.z * 3.0));
    float tip = smoothstep(0.62, 0.92, abs(vLocal.x - 0.5) * 2.0);
    col = mix(col, vC2.rgb, max(tip, band * 0.25));
    rough = 0.7;
  } else if (pat == 5) {
    emit = 0.75 + 0.25 * sin(uTime * 3.0 + vRound.x * 40.0);
    col = mix(col, vec3(1.0), 0.3);
  } else if (pat == 6) {
    // fish: darker back, a lateral sheen line and fine scales
    col = mix(col, vC2.rgb, smoothstep(0.55, 0.9, vLocal.y));
    float scale = smoothstep(0.35, 0.5, fract(lp.z * 60.0 + step(0.5, fract(lp.y * 30.0)) * 0.5));
    col *= 0.9 + 0.12 * scale;
    rough = 0.3; metal = 0.3;
  } else if (pat == 7) {
    // butterfly wing: dark veins and border, pale eye-spots
    vec2 w = vec2(abs(vLocal.x - 0.5) * 2.0, vLocal.z);
    float border = step(0.84, max(w.x, abs(w.y - 0.5) * 2.0));
    float vein = step(0.9, fract((w.x + w.y * 0.3) * 6.0));
    float spot = step(length((w - vec2(0.7, 0.72)) * vec2(1.0, 1.3)), 0.12);
    col = mix(col, vC2.rgb, max(border, vein * 0.8));
    col = mix(col, vec3(0.95), spot * 0.8);
    rough = 0.6;
  } else if (pat == 8) {
    col *= 0.8 + 0.3 * fur;
    rough = 0.75;
  } else if (pat == 9) {
    // wool: lumpy, fluffy, deeply shadowed between curls
    float curl = vnoise3(lp * 28.0);
    col *= 0.78 + 0.3 * curl;
    rough = 0.95;
  } else if (pat == 10) {
    col = mix(col, vC2.rgb, step(0.62, fract(lp.z * 11.0)));
    rough = 0.35;
  }
  if (pat != 5 && pat != 6 && pat != 10) col *= 0.9 + 0.2 * fur;
  // soften the box: bend the normal toward the direction from the box centre
  vec3 N = normalize(vN);
  N = normalize(N + vRound / (length(vRound) + 0.02) * 0.35);
  // cheap occlusion: undersides and the lower part of bodies are darker
  float ao = mix(0.55, 1.0, smoothstep(0.0, 0.8, vLocal.y)) * (vFace == 3 ? 0.65 : 1.0);
  int bits = 7 + 256 + (vInfo.w > 0.5 ? 32 : 0) + (int(metal * 3.0 + 0.5) << 6);
  float e = saturate(emit * vInfo.y / 16.0 * 16.0 * 0.25);
  oAlb = vec4(col, 0.0);
  oNrm = vec4(octEncode(N), rough, float(bits));
  oMisc = vec4(vInfo.x, 0.0, ao, e > 0.001 ? 0.54 + 0.46 * e : 0.48);
}`;

export const entityShadowVS = HEADER + ENTITY_VS + /* glsl */`
void main() { gl_Position = uVP * vec4(entityPos(), 1.0); }`;

export const entityShadowFS = HEADER + /* glsl */`
out vec4 o;
void main() { o = vec4(1.0); }`;

// 36 vertices: position (unit cube corner) + face id, counter-clockwise seen from outside.
export function unitCube() {
  const faces = [
    [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], // +x
    [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]], // -x
    [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], // +y
    [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], // -y
    [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]], // +z
    [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], // -z
  ];
  const out = [];
  faces.forEach((q, f) => {
    for (const k of [0, 1, 2, 0, 2, 3]) out.push(...q[k], f);
  });
  return new Float32Array(out);
}
