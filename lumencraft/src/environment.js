// Time of day, sun/moon positions, weather and CPU-side atmosphere transmittance.

const Rg = 6360, Rt = 6460;
const RAY_S = [5.802e-3, 13.558e-3, 33.1e-3];
const MIE_E = 4.4e-3;
const OZO = [0.65e-3, 1.881e-3, 0.085e-3];

export function transmittance(hKm, mu) {
  const ro = [0, Rg + Math.max(hKm, 0.002), 0];
  const s = Math.sqrt(Math.max(0, 1 - mu * mu));
  const rd = [s, mu, 0];
  const b = ro[1] * rd[1];
  // ground hit
  const cg = ro[1] * ro[1] - Rg * Rg;
  const dg = b * b - cg;
  if (dg > 0 && -b - Math.sqrt(dg) > 0) return [0, 0, 0];
  const ct = ro[1] * ro[1] - Rt * Rt;
  const tMax = -b + Math.sqrt(b * b - ct);
  const N = 40, dt = tMax / N;
  const od = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) * dt;
    const px = rd[0] * t, py = ro[1] + rd[1] * t;
    const h = Math.hypot(px, py) - Rg;
    const dr = Math.exp(-h / 8), dm = Math.exp(-h / 1.2), doz = Math.max(0, 1 - Math.abs(h - 25) / 15);
    for (let k = 0; k < 3; k++) od[k] += (RAY_S[k] * dr + MIE_E * dm + OZO[k] * doz) * dt;
  }
  return od.map((v) => Math.exp(-v));
}

const TILT = 0.5;
function orbit(ang) {
  return [Math.cos(ang), Math.sin(ang) * Math.cos(TILT), Math.sin(ang) * Math.sin(TILT)];
}

export const SUN_ILLUM = 20;

export function computeEnvironment(hours, day, camY) {
  const ang = ((hours - 6) / 24) * Math.PI * 2;
  const sunDir = orbit(ang);
  const phase = (((day + hours / 24) / 29.53) % 1 + 1) % 1;
  const mAng = ang + phase * Math.PI * 2;
  let moonDir = orbit(mAng);
  moonDir = [moonDir[0], moonDir[1] + 0.06, moonDir[2]];
  const ml = Math.hypot(...moonDir); moonDir = moonDir.map((v) => v / ml);
  const full = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
  const moonIllum = 0.006 + 0.11 * Math.pow(full, 1.5);
  const altKm = 0.25 + Math.max(0, camY - 62) * 0.001;
  const Ts = transmittance(altKm, sunDir[1]);
  const Tm = transmittance(altKm, moonDir[1]);
  const sunFade = smooth(-0.035, 0.02, sunDir[1]);
  const moonFade = smooth(-0.03, 0.05, moonDir[1]);
  // dominant light: sun when above the horizon, otherwise the moon
  const useSun = sunDir[1] > -0.045 || moonDir[1] < 0;
  const lightDir = useSun ? sunDir : moonDir;
  const lightColor = useSun
    ? Ts.map((t) => t * SUN_ILLUM * sunFade)
    : Tm.map((t, i) => t * moonIllum * moonFade * [0.82, 0.9, 1.0][i]);
  const night = smooth(0.06, -0.18, sunDir[1]);
  // star field rotates about the celestial pole (normal of the sun's orbital plane)
  const ax = [0, -Math.sin(TILT), Math.cos(TILT)];
  const c = Math.cos(-ang), s = Math.sin(-ang), t = 1 - c;
  const [x, y, z] = ax;
  const starRot = new Float32Array([
    t * x * x + c, t * x * y + s * z, t * x * z - s * y,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c,
  ]);
  return { sunDir, moonDir, lightDir, lightColor, moonIllum, sunIllum: SUN_ILLUM, night, starRot, altKm, phase, useSun };
}

function smooth(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

export class Weather {
  constructor() {
    this.rainTarget = 0;
    this.rain = 0;
    this.wetness = 0;
    this.coverage = 0.45;
    this.coverageTarget = 0.45;
    this.timer = 240 + Math.random() * 200;
    this.auto = true;
    this.thunder = 0;
    this.flash = 0;
    this.nextStrike = 8;
  }
  setRain(on) { this.rainTarget = on ? 1 : 0; this.timer = 300 + Math.random() * 300; }
  update(dt) {
    if (this.auto) {
      this.timer -= dt;
      if (this.timer < 0) this.setRain(this.rainTarget < 0.5 && Math.random() < 0.5);
    }
    const k = 1 - Math.exp(-dt / 12);
    this.rain += (this.rainTarget - this.rain) * k;
    this.coverageTarget = 0.42 + 0.5 * this.rainTarget;
    this.coverage += (this.coverageTarget - this.coverage) * (1 - Math.exp(-dt / 20));
    if (this.rain > 0.5) this.wetness = Math.min(1, this.wetness + dt / 45);
    else this.wetness = Math.max(0, this.wetness - dt / 150);
    // lightning during heavy rain
    this.flash = Math.max(0, this.flash - dt * 4);
    if (this.rain > 0.85) {
      this.nextStrike -= dt;
      if (this.nextStrike < 0) { this.flash = 1; this.thunder = 1; this.nextStrike = 10 + Math.random() * 25; }
    }
  }
}
