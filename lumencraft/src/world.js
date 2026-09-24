// Main-thread world state: streams chunk columns through a worker pool, holds block data for
// physics/editing, and uploads finished meshes into the GPU mesh pool.
import { B, SOLID, RENDER, R, INFO } from './blocks.js';
import { WorldGen, CS, SEA } from './worldgen.js';

const key = (cx, cz) => (cx + 32768) * 65536 + (cz + 32768);

export class World {
  constructor(seed, pool, createWorker) {
    this.seed = seed;
    this.pool = pool;
    this.columns = new Map();
    this.gen = new WorldGen(seed);
    const n = Math.min(6, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));
    this.workers = [];
    for (let i = 0; i < n; i++) {
      const w = createWorker();
      w.jobs = 0;
      w.onmessage = (e) => this.onMessage(w, e.data);
      w.onerror = (e) => console.error('worker error', e.message || e);
      w.postMessage({ type: 'init', seed });
      this.workers.push(w);
    }
    this.uploads = [];
    this.renderDist = 12;
    this.detailRadius = 4.5;
    this.renderList = [];
    this.offsets = null;
    this.offR = -1;
    this.jobId = 1;
    this.edits = new Map(); // column key -> Map(block index -> id), replayed onto regenerated columns
    this.fires = new Map();  // campfires (placed by the player) for smoke and sparks: "x,y,z" -> [x, y, z]
    this.stats = { gen: 0, meshed: 0, pending: 0 };
    this.surfDirty = true;
    this.onBlockChanged = null;
  }

  destroy() {
    for (const w of this.workers) w.terminate();
    for (const c of this.columns.values()) if (c.mesh) this.releaseMesh(c);
    this.columns.clear();
  }

  sortedOffsets(R) {
    if (this.offR === R) return this.offsets;
    const out = [];
    for (let dz = -R - 1; dz <= R + 1; dz++) for (let dx = -R - 1; dx <= R + 1; dx++) {
      const d = Math.hypot(dx, dz);
      if (d <= R + 1.5) out.push([dx, dz, d]);
    }
    out.sort((a, b) => a[2] - b[2]);
    this.offsets = out; this.offR = R;
    return out;
  }

  column(cx, cz) { return this.columns.get(key(cx, cz)); }

  update(px, pz, fwdX, fwdZ) {
    const R = this.renderDist;
    const ccx = Math.floor(px / CS), ccz = Math.floor(pz / CS);
    const offs = this.sortedOffsets(R);
    const genQ = [], meshQ = [];
    const cand = [];
    for (const [dx, dz, d] of offs) {
      const cx = ccx + dx, cz = ccz + dz;
      let col = this.columns.get(key(cx, cz));
      // favour chunks in front of the camera
      const len = Math.hypot(dx, dz) || 1;
      const facing = (dx * fwdX + dz * fwdZ) / len;
      const pr = d - (facing > 0.3 ? 1.5 : 0) + (facing < -0.3 ? 1.5 : 0);
      if (!col) {
        if (d <= R + 1.5) genQ.push([pr, cx, cz]);
        continue;
      }
      if (col.state !== 'ready' || d > R + 0.5) continue;
      if (col.meshPending) continue;
      const lod = d <= this.detailRadius ? 0 : 1;
      if (col.meshVersion === col.version && col.meshLod === lod) continue;
      col.wantLod = lod;
      // refreshing an existing mesh only for a detail change is lower priority than filling holes
      const refresh = col.meshVersion === col.version;
      cand.push([refresh ? pr + (lod === 0 ? 1 : 6) : pr, col]);
    }
    for (const [pr, col] of cand) {
      if (!this.neighboursReady(col.cx, col.cz)) continue;
      meshQ.push([col.dirtyEdit ? -100 + pr : pr, col]);
    }
    genQ.sort((a, b) => a[0] - b[0]);
    meshQ.sort((a, b) => a[0] - b[0]);
    // dispatch
    let gi = 0, mi = 0;
    for (const w of this.workers) {
      while (w.jobs < 2) {
        const nextMesh = meshQ[mi], nextGen = genQ[gi];
        if (!nextMesh && !nextGen) break;
        const useMesh = nextMesh && (!nextGen || nextMesh[0] <= nextGen[0] + 1);
        if (useMesh) { this.dispatchMesh(w, nextMesh[1]); mi++; }
        else { this.dispatchGen(w, nextGen[1], nextGen[2]); gi++; }
      }
    }
    this.stats.pending = genQ.length + meshQ.length;
    // unload far columns
    for (const [k, col] of this.columns) {
      const d = Math.hypot(col.cx - ccx, col.cz - ccz);
      if (d > R + 3.5) {
        if (col.mesh) this.releaseMesh(col);
        this.columns.delete(k);
        this.surfDirty = true;
      } else if (col.mesh && d > R + 1.5) {
        this.releaseMesh(col);
        col.meshVersion = -1;
      }
    }
    this.processUploads();
  }

  neighboursReady(cx, cz) {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const c = this.columns.get(key(cx + dx, cz + dz));
      if (!c || c.state !== 'ready') return false;
    }
    return true;
  }

  dispatchGen(w, cx, cz) {
    const col = { cx, cz, state: 'gen', version: 0, meshVersion: -1, meshPending: false, mesh: null, minY: 0, maxY: 0 };
    this.columns.set(key(cx, cz), col);
    w.jobs++;
    w.postMessage({ type: 'gen', id: this.jobId++, cx, cz });
  }

  dispatchMesh(w, col) {
    const cols = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const c = this.columns.get(key(col.cx + dx, col.cz + dz));
      cols.push({ alloc: c.alloc, data: c.data });
    }
    col.meshPending = true;
    col.dirtyEdit = false;
    w.jobs++;
    w.postMessage({ type: 'mesh', id: this.jobId++, cx: col.cx, cz: col.cz, cols, tintG: col.tintG, tintF: col.tintF, tintW: col.tintW, version: col.version, lod: col.wantLod ?? 0 });
  }

  onMessage(w, m) {
    w.jobs--;
    if (m.type === 'gen') {
      const c = m.col;
      const col = this.columns.get(key(c.cx, c.cz));
      if (!col) return;
      Object.assign(col, { alloc: c.alloc, data: c.data, tintG: c.tintG, tintF: c.tintF, tintW: c.tintW, heights: c.heights, biomes: c.biomes, temps: c.temps });
      this.applyEdits(col);
      if (this.onColumnReady) this.onColumnReady(col);
      col.state = 'ready';
      col.version = 1;
      this.stats.gen++;
      this.surfDirty = true;
    } else if (m.type === 'mesh') {
      const col = this.columns.get(key(m.cx, m.cz));
      if (!col) return;
      col.meshPending = false;
      this.uploads.push({ col, m });
    }
  }

  processUploads() {
    let budget = 70000; // quads uploaded per frame (~4.5 MB) to avoid hitches
    while (this.uploads.length && budget > 0) {
      const { col, m } = this.uploads.shift();
      if (!this.columns.has(key(col.cx, col.cz))) continue;
      if (col.mesh) this.releaseMesh(col);
      const part = (data, n, groups) => {
        const allocs = this.pool.upload(data, n);
        const G = new Int32Array(groups);
        const gr = [];
        for (let i = 0; i < G.length; i += 5) {
          gr.push({ dir: G[i] & 7, minY: G[i + 3] / 16, maxY: G[i + 4] / 16, ranges: this.pool.slice(allocs, G[i + 1], G[i + 2]) });
        }
        return { allocs, groups: gr };
      };
      col.mesh = {
        opaque: part(m.opaque, m.nOpaque, m.opaqueG),
        cutout: part(m.cutout, m.nCutout, m.cutoutG),
        trans: part(m.trans, m.nTrans, m.transG),
        plants: part(m.plants, m.nPlants, m.plantsG),
      };
      col.minY = m.minY; col.maxY = m.maxY;
      col.meshVersion = m.version;
      col.meshLod = m.lod;
      this.renderList.push(col);
      this.stats.meshed++;
      budget -= m.nOpaque + m.nCutout + m.nTrans + m.nPlants + 2000;
    }
  }

  releaseMesh(col) {
    const m = col.mesh;
    this.pool.release(m.opaque.allocs); this.pool.release(m.cutout.allocs); this.pool.release(m.trans.allocs); this.pool.release(m.plants.allocs);
    col.mesh = null;
    const i = this.renderList.indexOf(col);
    if (i >= 0) this.renderList.splice(i, 1);
  }

  // Replay saved edits onto a freshly generated column.
  applyEdits(col) {
    const m = this.edits.get(key(col.cx, col.cz));
    if (!m || !m.size) return;
    let top = 0;
    for (const i of m.keys()) top = Math.max(top, i >> 10);
    if (top >= col.alloc) {
      const na = Math.min(256, Math.ceil((top + 2) / 16) * 16);
      const nd = new Uint8Array(na * 1024);
      nd.set(col.data);
      col.data = nd; col.alloc = na;
    }
    for (const [i, id] of m) {
      col.data[i] = id;
      if (id === B.CAMPFIRE) { const x = col.cx * 32 + (i & 31), y = i >> 10, z = col.cz * 32 + ((i >> 5) & 31); this.fires.set(`${x},${y},${z}`, [x, y, z]); }
    }
    for (let lz = 0; lz < CS; lz++) for (let lx = 0; lx < CS; lx++) {
      let yy = col.alloc - 1;
      while (yy > 0 && col.data[(yy << 10) | (lz << 5) | lx] === 0) yy--;
      col.heights[lz * CS + lx] = yy;
    }
  }

  // ---------------------------------------------------------------- block access
  getBlock(x, y, z) {
    if (y < 0) return B.OBSIDIAN;
    if (y >= 256) return 0;
    const col = this.columns.get(key(x >> 5, z >> 5));
    if (!col || !col.data) return -1;
    if (y >= col.alloc) return 0;
    return col.data[(y << 10) | ((z & 31) << 5) | (x & 31)];
  }

  setBlock(x, y, z, id) {
    if (y < 1 || y >= 255) return false;
    const cx = x >> 5, cz = z >> 5;
    const col = this.columns.get(key(cx, cz));
    if (!col || !col.data) return false;
    if (y >= col.alloc) {
      if (id === 0) return true;
      const na = Math.min(256, Math.ceil((y + 2) / 16) * 16);
      const nd = new Uint8Array(na * 1024);
      nd.set(col.data);
      col.data = nd; col.alloc = na;
    }
    const lx = x & 31, lz = z & 31;
    const bi = (y << 10) | (lz << 5) | lx;
    if (col.data[bi] === B.CAMPFIRE) this.fires.delete(`${x},${y},${z}`);
    if (id === B.CAMPFIRE) this.fires.set(`${x},${y},${z}`, [x, y, z]);
    col.data[bi] = id;
    let em = this.edits.get(key(cx, cz));
    if (!em) { em = new Map(); this.edits.set(key(cx, cz), em); }
    em.set(bi, id);
    this.editCount = (this.editCount ?? 0) + 1;
    col.version++;
    col.dirtyEdit = true;
    // update top-surface height
    if (col.heights) {
      let yy = col.alloc - 1;
      while (yy > 0 && col.data[(yy << 10) | (lz << 5) | lx] === 0) yy--;
      col.heights[lz * CS + lx] = yy;
    }
    // light can reach up to 15 blocks into neighbouring columns
    const nx = lx < 15 ? -1 : lx > 16 ? 1 : 0, nz = lz < 15 ? -1 : lz > 16 ? 1 : 0;
    const touch = (dx, dz) => {
      const c = this.columns.get(key(cx + dx, cz + dz));
      if (c && c.state === 'ready') { c.version++; c.dirtyEdit = true; }
    };
    if (nx) touch(nx, 0);
    if (nz) touch(0, nz);
    if (nx && nz) touch(nx, nz);
    this.surfDirty = true;
    if (this.onBlockChanged) this.onBlockChanged(x, y, z, id);
    return true;
  }

  isSolid(x, y, z) {
    const b = this.getBlock(x, y, z);
    return b < 0 || SOLID[b] === 1;
  }

  // Voxel DDA raycast. Returns { pos, normal, id } for the first targetable block.
  raycast(o, d, maxDist) {
    let x = Math.floor(o[0]), y = Math.floor(o[1]), z = Math.floor(o[2]);
    const sx = Math.sign(d[0]), sy = Math.sign(d[1]), sz = Math.sign(d[2]);
    const tdx = sx ? Math.abs(1 / d[0]) : Infinity, tdy = sy ? Math.abs(1 / d[1]) : Infinity, tdz = sz ? Math.abs(1 / d[2]) : Infinity;
    let tmx = sx > 0 ? (x + 1 - o[0]) * tdx : sx < 0 ? (o[0] - x) * tdx : Infinity;
    let tmy = sy > 0 ? (y + 1 - o[1]) * tdy : sy < 0 ? (o[1] - y) * tdy : Infinity;
    let tmz = sz > 0 ? (z + 1 - o[2]) * tdz : sz < 0 ? (o[2] - z) * tdz : Infinity;
    let n = [0, 0, 0];
    let t = 0;
    for (let i = 0; i < 256 && t <= maxDist; i++) {
      const b = this.getBlock(x, y, z);
      if (b > 0 && b !== B.WATER && b !== B.LAVA) return { pos: [x, y, z], normal: n, id: b, t };
      if (tmx < tmy && tmx < tmz) { x += sx; t = tmx; tmx += tdx; n = [-sx, 0, 0]; }
      else if (tmy < tmz) { y += sy; t = tmy; tmy += tdy; n = [0, -sy, 0]; }
      else { z += sz; t = tmz; tmz += tdz; n = [0, 0, -sz]; }
    }
    return null;
  }

  // 128x128 top-surface map around (ox, oz) for weather/particle occlusion.
  buildSurface(ox, oz) {
    const data = new Uint8Array(128 * 128 * 2);
    let lastK = -1, col = null;
    for (let z = 0; z < 128; z++) {
      for (let x = 0; x < 128; x++) {
        const wx = ox + x, wz = oz + z;
        const k = key(wx >> 5, wz >> 5);
        if (k !== lastK) { col = this.columns.get(k); lastK = k; }
        const o = (z * 128 + x) * 2;
        if (!col || !col.heights) { data[o] = 0; data[o + 1] = 0; continue; }
        const i = (wz & 31) * CS + (wx & 31);
        const h = col.heights[i];
        const top = col.data[(h << 10) | ((wz & 31) << 5) | (wx & 31)];
        let flags = 0;
        const bio = col.biomes ? col.biomes[i] : -1;
        if (top === B.CHERRY_LEAVES) flags |= 2;
        if (top === B.MAPLE_RED || top === B.MAPLE_ORANGE || top === B.MAPLE_YELLOW || (bio === 13 && top !== B.WATER)) flags |= 1;
        if (col.temps && col.temps[i] < -0.42) flags |= 4;
        if (top === B.WATER) flags |= 8;
        if (top === B.GRASS || RENDER[top] === R.CROSS || top === B.PINK_PETALS || top === B.LEAF_LITTER) flags |= 16;
        if (bio === 18) flags |= 32;
        if (bio === 19) flags |= 64;
        if (bio === 14 || bio === 17) flags |= 128;
        data[o] = h; data[o + 1] = flags;
      }
    }
    return data;
  }

  biomeAt(x, z) {
    const col = this.columns.get(key(x >> 5, z >> 5));
    if (!col || !col.biomes) return -1;
    return col.biomes[(z & 31) * CS + (x & 31)];
  }

  // Find a scenic spawn: dry, gentle ground in a green biome with water and high ground in view.
  findSpawn() {
    const g = this.gen;
    const green = new Set([2, 3, 4, 5, 12, 13, 22]);
    let best = null, bestScore = -1e9;
    for (let r = 0; r <= 1400; r += 40) {
      const n = Math.max(1, Math.round(r / 40) * 6);
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const x = Math.round(Math.cos(a) * r), z = Math.round(Math.sin(a) * r);
        const s = { ...g.sample(x, z) };
        if (s.h < SEA + 3 || s.h > 104 || s.river > 0.05 || !green.has(s.biome)) continue;
        const h2 = g.sample(x + 4, z).h, h3 = g.sample(x, z + 4).h;
        const slope = Math.abs(h2 - s.h) + Math.abs(h3 - s.h);
        if (slope > 3) continue;
        let water = 0, high = 0, variety = new Set();
        for (let j = 0; j < 16; j++) {
          const b = (j / 16) * Math.PI * 2;
          for (const d of [60, 140, 260]) {
            const q = g.sample(x + Math.cos(b) * d, z + Math.sin(b) * d);
            if (q.h < SEA) water++;
            if (q.h > s.h + 35) high++;
            variety.add(q.biome);
          }
        }
        let score = -slope * 2 - r * 0.002 + Math.min(water, 10) * 0.8 + Math.min(high, 10) * 0.7 + variety.size * 0.9;
        if (s.biome === 5 || s.biome === 12 || s.biome === 13 || s.biome === 22) score += 3;
        if (water > 30) score -= 10;
        if (score > bestScore) { bestScore = score; best = [x + 0.5, Math.floor(s.h) + 1, z + 0.5]; }
      }
    }
    return best ?? [0.5, 90, 0.5];
  }
}

export function blockName(id) { return INFO[id]?.name ?? 'Air'; }
export { SOLID };
