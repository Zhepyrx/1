// First-person player: movement, collision against voxels, swimming and flying.
import { B, WATERLOGGED } from './blocks.js';

const HW = 0.3, HEIGHT = 1.8, EYE = 1.62;

export class Player {
  constructor(world, pos) {
    this.world = world;
    this.pos = pos.slice();
    this.vel = [0, 0, 0];
    this.yaw = 0; this.pitch = 0;
    this.flying = false;
    this.onGround = false;
    this.inWater = false;
    this.eyeInWater = false;
    this.bobPhase = 0; this.bobAmp = 0;
    this.fovKick = 0;
    this.stepDist = 0;
    this.onStep = null;
    this.lastGroundBlock = 0;
    this.frozen = true;
  }

  eye(bob = true) {
    let y = this.pos[1] + EYE;
    let x = this.pos[0], z = this.pos[2];
    if (bob && this.bobAmp > 0.001) {
      const s = Math.sin(this.bobPhase * 2) * 0.045 * this.bobAmp;
      const c = Math.cos(this.bobPhase) * 0.03 * this.bobAmp;
      y += s;
      x += Math.cos(this.yaw) * c; z += Math.sin(this.yaw) * c;
    }
    return [x, y, z];
  }

  forward() {
    const cp = Math.cos(this.pitch);
    return [Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp];
  }

  collides(px, py, pz) {
    const w = this.world;
    const x0 = Math.floor(px - HW), x1 = Math.floor(px + HW);
    const y0 = Math.floor(py), y1 = Math.floor(py + HEIGHT - 0.001);
    const z0 = Math.floor(pz - HW), z1 = Math.floor(pz + HW);
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      if (w.isSolid(x, y, z)) return true;
    }
    return false;
  }

  update(dt, input) {
    const w = this.world;
    // wait until the ground under us is loaded
    const here = w.getBlock(Math.floor(this.pos[0]), Math.floor(this.pos[1]) - 1, Math.floor(this.pos[2]));
    if (here < 0) { this.frozen = true; return; }
    this.frozen = false;
    const feet = w.getBlock(Math.floor(this.pos[0]), Math.floor(this.pos[1] + 0.2), Math.floor(this.pos[2]));
    const chest = w.getBlock(Math.floor(this.pos[0]), Math.floor(this.pos[1] + 1.0), Math.floor(this.pos[2]));
    const e = this.eye(false);
    const eyeB = w.getBlock(Math.floor(e[0]), Math.floor(e[1] - 0.06), Math.floor(e[2]));
    const wet = (b) => b === B.WATER || (b > 0 && WATERLOGGED[b] === 1);
    this.inWater = wet(feet) || wet(chest);
    this.eyeInWater = wet(eyeB);

    const f = [Math.sin(this.yaw), -Math.cos(this.yaw)];
    const r = [Math.cos(this.yaw), Math.sin(this.yaw)];
    let mx = 0, mz = 0;
    if (input.forward) { mx += f[0]; mz += f[1]; }
    if (input.back) { mx -= f[0]; mz -= f[1]; }
    if (input.right) { mx += r[0]; mz += r[1]; }
    if (input.left) { mx -= r[0]; mz -= r[1]; }
    const ml = Math.hypot(mx, mz);
    if (ml > 0) { mx /= ml; mz /= ml; }
    const sprint = input.sprint && input.forward;

    if (this.flying) {
      const sp = sprint ? 26 : 11;
      const k = 1 - Math.exp(-dt * 6);
      this.vel[0] += (mx * sp - this.vel[0]) * k;
      this.vel[2] += (mz * sp - this.vel[2]) * k;
      const vy = (input.jump ? 1 : 0) - (input.descend ? 1 : 0);
      this.vel[1] += (vy * sp * 0.75 - this.vel[1]) * k;
    } else if (this.inWater) {
      const sp = sprint ? 4.2 : 2.8;
      const k = 1 - Math.exp(-dt * 4);
      this.vel[0] += (mx * sp - this.vel[0]) * k;
      this.vel[2] += (mz * sp - this.vel[2]) * k;
      this.vel[1] -= 7 * dt;
      if (input.jump) this.vel[1] += 18 * dt;
      if (input.descend) this.vel[1] -= 10 * dt;
      this.vel[1] *= Math.exp(-dt * 2.2);
      this.vel[1] = Math.max(-4, Math.min(4.5, this.vel[1]));
    } else {
      const sp = sprint ? 5.9 : 4.3;
      const k = 1 - Math.exp(-dt * (this.onGround ? 14 : 2.5));
      this.vel[0] += (mx * sp - this.vel[0]) * k;
      this.vel[2] += (mz * sp - this.vel[2]) * k;
      this.vel[1] -= 28 * dt;
      if (this.vel[1] < -60) this.vel[1] = -60;
      if (input.jump && this.onGround) { this.vel[1] = 8.6; this.onGround = false; }
    }

    // integrate with substeps
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(this.vel[0]), Math.abs(this.vel[1]), Math.abs(this.vel[2])) * dt / 0.3));
    const sdt = dt / steps;
    let hitWall = false;
    const wasGround = this.onGround;
    this.onGround = false;
    for (let s = 0; s < steps; s++) {
      for (let axis = 0; axis < 3; axis++) {
        const d = this.vel[axis] * sdt;
        if (!d) continue;
        const p = this.pos.slice();
        p[axis] += d;
        if (this.collides(p[0], p[1], p[2])) {
          if (axis === 1) {
            if (d < 0) {
              this.pos[1] = Math.floor(p[1]) + 1 + 1e-4;
              this.onGround = true;
            } else {
              this.pos[1] = Math.floor(p[1] + HEIGHT) - HEIGHT - 1e-4;
            }
            this.vel[1] = 0;
          } else {
            // step up one block (auto-jump) when walking into a ledge
            const stepY = this.pos.slice();
            stepY[axis] += d; stepY[1] += 1.01;
            if (!this.flying && (wasGround || this.inWater) && !this.collides(stepY[0], stepY[1], stepY[2]) && !this.collides(this.pos[0], this.pos[1] + 1.01, this.pos[2])) {
              if (this.vel[1] <= 0.1) this.vel[1] = this.inWater ? 5.5 : 7.4;
            }
            hitWall = true;
            const snapped = d > 0 ? Math.floor(p[axis] + HW) - HW - 1e-4 : Math.floor(p[axis] - HW) + 1 + HW + 1e-4;
            const q = this.pos.slice(); q[axis] = snapped;
            if (!this.collides(q[0], q[1], q[2])) this.pos[axis] = snapped;
            this.vel[axis] = 0;
          }
        } else {
          this.pos[axis] = p[axis];
        }
      }
    }
    if (this.flying && this.onGround) this.flying = false;
    void hitWall;

    // head bob and footsteps
    const hs = Math.hypot(this.vel[0], this.vel[2]);
    const walking = this.onGround && hs > 0.5 && !this.flying;
    this.bobAmp += ((walking ? Math.min(1, hs / 5) : 0) - this.bobAmp) * (1 - Math.exp(-dt * 8));
    if (walking) {
      this.bobPhase += hs * dt * 1.9;
      this.stepDist += hs * dt;
      if (this.stepDist > (sprint ? 2.1 : 1.7)) {
        this.stepDist = 0;
        const g = w.getBlock(Math.floor(this.pos[0]), Math.floor(this.pos[1] - 0.2), Math.floor(this.pos[2]));
        if (this.onStep) this.onStep(g, sprint);
      }
    }
    this.fovKick += ((sprint && hs > 4 ? 1 : 0) - this.fovKick) * (1 - Math.exp(-dt * 6));
    if (this.pos[1] < -20) { this.pos[1] = 120; this.vel = [0, 0, 0]; }
  }

  // true if placing a solid block at (x,y,z) would intersect the player
  intersectsBlock(x, y, z) {
    return x + 1 > this.pos[0] - HW && x < this.pos[0] + HW && z + 1 > this.pos[2] - HW && z < this.pos[2] + HW &&
      y + 1 > this.pos[1] && y < this.pos[1] + HEIGHT;
  }
}
