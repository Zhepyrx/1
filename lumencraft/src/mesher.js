// Light propagation + greedy meshing for one 32x32 chunk column (runs in a worker).
import { B, R, OPAQUE, RENDER, EMIT, ATTEN, TEX_TOP, TEX_BOTTOM, TEX_SIDE, TINT, WAVE, PLANT_H } from './blocks.js';
import { hash3 } from './noise.js';

const CS = 32;
const RX = 64;          // region width (16 block margin on each side)
const M = 16;           // margin
const YS = RX * RX;     // y stride in region

// Face direction tables: 0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z
const DX = [1, -1, 0, 0, 0, 0], DY = [0, 0, 1, -1, 0, 0], DZ = [0, 0, 0, 0, 1, -1];
const AXIS = [0, 0, 1, 1, 2, 2];
const BAX = [2, 2, 0, 0, 0, 0];   // tangent axis b
const CAX = [1, 1, 2, 2, 1, 1];   // tangent axis c
const REV = [1, 0, 1, 0, 0, 1];   // reverse winding

class VBuf {
  constructor(cap) { this.cap = cap; this.i32 = new Int32Array(cap * 4); this.n = 0; }
  reserve(k) {
    if (this.n + k <= this.cap) return;
    let c = this.cap; while (this.n + k > c) c *= 2;
    const a = new Int32Array(c * 4); a.set(this.i32.subarray(0, this.n * 4)); this.i32 = a; this.cap = c;
  }
  // x,y,z in 1/16 units (world), packed data
  v(x, y, z, extra, d) {
    const o = this.n * 4;
    const a = this.i32;
    a[o] = x; a[o + 1] = z; a[o + 2] = (y & 0xffff) | (extra << 16); a[o + 3] = d;
    this.n++;
  }
  take() { return this.i32.slice(0, this.n * 4).buffer; }
}

export class Mesher {
  constructor() {
    this.cap = RX * RX * 258;
    this.blocks = new Uint8Array(this.cap);
    this.sky = new Uint8Array(this.cap);
    this.blk = new Uint8Array(this.cap);
    this.queue = new Int32Array(1 << 21);
    this.bufs = [new VBuf(1 << 16), new VBuf(1 << 16), new VBuf(1 << 14)];
    this.maskA = new Int32Array(CS * 258);
    this.maskB = new Int32Array(CS * 258);
  }

  // cols: 3x3 array (index (dz+1)*3+(dx+1)) of {alloc, data}
  // lod 0: full detail. lod 1 (distant): no pitch-dark cave faces, no small plants, no inner leaf faces.
  build(cx, cz, cols, tintG, tintF, lod = 0) {
    let RY = 1;
    for (const c of cols) if (c && c.alloc + 1 > RY) RY = c.alloc + 1;
    RY = Math.min(RY, 257);
    this.RY = RY;
    const size = RY * YS;
    const blocks = this.blocks;
    blocks.fill(0, 0, size);
    // --- assemble region
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const col = cols[(dz + 1) * 3 + (dx + 1)];
        if (!col) continue;
        const data = col.data, alloc = col.alloc;
        // region x range for this column
        const rx0 = Math.max(0, M + dx * CS), rx1 = Math.min(RX, M + dx * CS + CS);
        const rz0 = Math.max(0, M + dz * CS), rz1 = Math.min(RX, M + dz * CS + CS);
        const lx0 = rx0 - (M + dx * CS);
        const w = rx1 - rx0;
        for (let y = 0; y < alloc && y < RY; y++) {
          for (let rz = rz0; rz < rz1; rz++) {
            const lz = rz - (M + dz * CS);
            const src = (y << 10) | (lz << 5) | lx0;
            blocks.set(data.subarray(src, src + w), y * YS + rz * RX + rx0);
          }
        }
      }
    }
    this.computeLight(RY);
    return this.mesh(cx, cz, cols[4].alloc, tintG, tintF, lod);
  }

  computeLight(RY) {
    const blocks = this.blocks, sky = this.sky, blk = this.blk, q = this.queue;
    const size = RY * YS;
    sky.fill(0, 0, size);
    blk.fill(0, 0, size);
    const QM = q.length - 1;
    let head = 0, tail = 0;
    // pass 1: vertical sky light
    const shadowTop = this.shadowTop || (this.shadowTop = new Int16Array(RX * RX));
    const zeroTop = new Int16Array(RX * RX);
    for (let z = 0; z < RX; z++) {
      for (let x = 0; x < RX; x++) {
        let L = 15, st = -1, zy = 0;
        for (let y = RY - 1; y >= 0; y--) {
          const i = y * YS + z * RX + x;
          const b = blocks[i];
          if (OPAQUE[b]) L = 0;
          else if (ATTEN[b]) L = L > ATTEN[b] ? L - ATTEN[b] : 0;
          if (L < 15 && st < 0) st = y;
          if (L === 0) { zy = y; break; }
          sky[i] = L;
        }
        shadowTop[z * RX + x] = st;
        zeroTop[z * RX + x] = zy;
      }
    }
    // seeds for lateral spread
    for (let z = 0; z < RX; z++) {
      for (let x = 0; x < RX; x++) {
        let top = -1;
        if (x > 0) top = Math.max(top, shadowTop[z * RX + x - 1]);
        if (x < RX - 1) top = Math.max(top, shadowTop[z * RX + x + 1]);
        if (z > 0) top = Math.max(top, shadowTop[(z - 1) * RX + x]);
        if (z < RX - 1) top = Math.max(top, shadowTop[(z + 1) * RX + x]);
        top = Math.min(top + 1, RY - 1);
        for (let y = zeroTop[z * RX + x]; y <= top; y++) {
          const i = y * YS + z * RX + x;
          if (sky[i] > 1) { q[tail] = i; tail = (tail + 1) & QM; }
        }
      }
    }
    this.bfs(sky, head, tail, RY);
    // block light seeds
    head = 0; tail = 0;
    for (let i = 0; i < size; i++) {
      const e = EMIT[blocks[i]];
      if (e) { blk[i] = e; q[tail] = i; tail = (tail + 1) & QM; }
    }
    this.bfs(blk, head, tail, RY);
  }

  bfs(L, head, tail, RY) {
    const blocks = this.blocks, q = this.queue, QM = q.length - 1;
    while (head !== tail) {
      const i = q[head]; head = (head + 1) & QM;
      const l = L[i];
      if (l <= 1) continue;
      const x = i & 63, z = (i >> 6) & 63, y = (i / YS) | 0;
      for (let d = 0; d < 6; d++) {
        let n;
        if (d === 0) { if (x === RX - 1) continue; n = i + 1; }
        else if (d === 1) { if (x === 0) continue; n = i - 1; }
        else if (d === 2) { if (y === RY - 1) continue; n = i + YS; }
        else if (d === 3) { if (y === 0) continue; n = i - YS; }
        else if (d === 4) { if (z === RX - 1) continue; n = i + RX; }
        else { if (z === 0) continue; n = i - RX; }
        const b = blocks[n];
        if (OPAQUE[b]) continue;
        const nl = l - 1 - ATTEN[b];
        if (nl > L[n]) { L[n] = nl; q[tail] = n; tail = (tail + 1) & QM; }
      }
    }
  }

  mesh(cx, cz, alloc, tintG, tintF, lod) {
    const blocks = this.blocks, sky = this.sky, blk = this.blk, RY = this.RY;
    const bufs = this.bufs;
    for (const b of bufs) b.n = 0;
    const wx0 = cx * CS * 16, wz0 = cz * CS * 16;
    let minY = 9999, maxY = -1;
    const ymax = Math.min(alloc, RY - 1);
    const isWaterish = (b) => b === B.WATER || b === B.SEAGRASS;
    const emits = (b, n) => {
      const rb = RENDER[b];
      if (OPAQUE[n]) return false;
      if (rb === R.CUBE || rb === R.CUTOUT) return true;
      if (rb === R.GLASSY) return n !== b;
      if (rb === R.WATER) return !isWaterish(n) && n !== B.ICE;
      return false;
    };
    const kindOf = (b) => { const r = RENDER[b]; return r === R.CUBE ? 0 : r === R.CUTOUT ? 1 : 2; };
    const texFor = (b, d) => (d === 2 ? TEX_TOP[b] : d === 3 ? TEX_BOTTOM[b] : TEX_SIDE[b]);
    const tintFor = (b, lx, lz) => { const t = TINT[b]; return t === 1 ? tintG[lz * CS + lx] : t === 2 ? tintF[lz * CS + lx] : 0xffff; };

    const cornerAO = new Int32Array(4), cornerSky = new Int32Array(4), cornerBlk = new Int32Array(4);
    const pos = [0, 0, 0];

    function faceCorners(d, x, y, z, water) {
      // x,y,z region coords of the block; AO/light for the 4 corners (cb,cc): (0,0),(1,0),(1,1),(0,1)
      const nx = x + DX[d], ny = y + DY[d], nz = z + DZ[d];
      const bA = BAX[d], cA = CAX[d];
      const sB = bA === 0 ? 1 : bA === 1 ? YS : RX;
      const sC = cA === 0 ? 1 : cA === 1 ? YS : RX;
      const n = ny * YS + nz * RX + nx;
      for (let k = 0; k < 4; k++) {
        const cb = k === 1 || k === 2 ? 1 : -1;
        const cc = k >= 2 ? 1 : -1;
        const ib = n + cb * sB, ic = n + cc * sC, id = n + cb * sB + cc * sC;
        const bOut = bA === 1 && (ny + cb < 0 || ny + cb >= RY);
        const cOut = cA === 1 && (ny + cc < 0 || ny + cc >= RY);
        const s1 = bOut ? 0 : OPAQUE[blocks[ib]];
        const s2 = cOut ? 0 : OPAQUE[blocks[ic]];
        const c = bOut || cOut ? 0 : OPAQUE[blocks[id]];
        cornerAO[k] = water ? 3 : s1 && s2 ? 0 : 3 - (s1 + s2 + c);
        let ss = sky[n], bb = blk[n], cnt = 1;
        if (!s1 && !bOut) { ss += sky[ib]; bb += blk[ib]; cnt++; }
        if (!s2 && !cOut) { ss += sky[ic]; bb += blk[ic]; cnt++; }
        if (!c && !(s1 && s2) && !bOut && !cOut) { ss += sky[id]; bb += blk[id]; cnt++; }
        cornerSky[k] = Math.round(ss / cnt);
        cornerBlk[k] = Math.round(bb / cnt);
      }
    }

    // Emit a quad given its origin corner (in 1/16 world units) and the two edge vectors along b and c axes.
    function emitQuad(buf, d, ox, oy, oz, ebx, eby, ebz, ecx, ecy, ecz, layer, tint, aoArr, skyArr, blkArr, flags) {
      // corners in (b,c): 0:(0,0) 1:(1,0) 2:(1,1) 3:(0,1)
      const px = [ox, ox + ebx, ox + ebx + ecx, ox + ecx];
      const py = [oy, oy + eby, oy + eby + ecy, oy + ecy];
      const pz = [oz, oz + ebz, oz + ebz + ecz, oz + ecz];
      let order;
      const flip = aoArr[0] + aoArr[2] < aoArr[1] + aoArr[3];
      if (REV[d]) order = flip ? [1, 0, 3, 2] : [0, 3, 2, 1];
      else order = flip ? [1, 2, 3, 0] : [0, 1, 2, 3];
      buf.reserve(4);
      for (let k = 0; k < 4; k++) {
        const c = order[k];
        const d1 = d | (flags << 5);
        const data = layer | (d1 << 8) | (aoArr[c] << 16) | (((skyArr[c] << 4) | blkArr[c]) << 24);
        buf.v(px[c], py[c], pz[c], tint, data);
        if (py[c] < minY) minY = py[c];
        if (py[c] > maxY) maxY = py[c];
      }
    }

    const ao1 = [3, 3, 3, 3];
    const sk1 = [0, 0, 0, 0], bl1 = [0, 0, 0, 0];

    // ---------------- greedy faces (cubes, leaves, glass, water)
    const maskA = this.maskA, maskB = this.maskB;
    const STRIDE = [1, YS, RX];
    const base = M + M * RX;
    for (let d = 0; d < 6; d++) {
      const a = AXIS[d], bA = BAX[d], cA = CAX[d];
      const nSlices = a === 1 ? ymax : CS;
      const nb = bA === 1 ? ymax : CS;
      const nc = cA === 1 ? ymax : CS;
      const sA = STRIDE[a], sB = STRIDE[bA], sC = STRIDE[cA];
      const dOff = DX[d] + DY[d] * YS + DZ[d] * RX;
      for (let s = (d === 3 ? 1 : 0); s < nSlices; s++) {
        let any = false;
        // fill mask
        for (let ic = 0; ic < nc; ic++) {
          let i = base + s * sA + ic * sC;
          let mi = ic * nb;
          for (let ib = 0; ib < nb; ib++, i += sB, mi++) {
            maskA[mi] = 0;
            const b = blocks[i];
            if (b === 0) continue;
            const rb = RENDER[b];
            if (rb > R.WATER) continue;
            const n = blocks[i + dOff];
            if (OPAQUE[n] || !emits(b, n)) continue;
            if (lod > 0) {
              const ni = i + dOff;
              if (sky[ni] === 0 && blk[ni] === 0) continue;
              // deep under solid ground: invisible from a distance
              if (sky[ni] < 15 && (ni >> 12) < this.shadowTop[ni & 4095] - 6) continue;
              if (rb === R.CUTOUT && n === b) continue;
            }
            const x = i & 63, z = (i >> 6) & 63, y = i >> 12;
            const lx = x - M, lz = z - M;
            const layer = texFor(b, d);
            const tint = tintFor(b, lx, lz);
            let flags = 0;
            if (isWaterish(n)) flags |= 4; // underwater surface
            if (rb === R.WATER) {
              // water: never merge side faces; lower the surface
              const above = y + 1 < RY ? blocks[i + YS] : 0;
              const lowered = !isWaterish(above) && above !== B.ICE;
              if (d !== 2 || !lowered) {
                faceCorners(d, x, y, z, true);
                emitWaterFace(bufs[2], d, lx, y, lz, lowered, layer, tint, flags);
                continue;
              }
            }
            faceCorners(d, x, y, z, rb === R.WATER);
            const a0 = cornerAO[0];
            const s0 = cornerSky[0], b0 = cornerBlk[0];
            const uniform = cornerAO[1] === a0 && cornerAO[2] === a0 && cornerAO[3] === a0 &&
              cornerSky[1] === s0 && cornerSky[2] === s0 && cornerSky[3] === s0 &&
              cornerBlk[1] === b0 && cornerBlk[2] === b0 && cornerBlk[3] === b0;
            const kind = rb === R.WATER ? 2 : kindOf(b);
            if (!uniform || rb === R.CUTOUT) {
              emitBlockFace(bufs[kind], d, lx, y, lz, layer, tint, cornerAO, cornerSky, cornerBlk, flags, rb === R.CUTOUT ? WAVE[b] : 0, rb === R.WATER);
              continue;
            }
            maskA[mi] = 1 | (layer << 1) | (a0 << 9) | (s0 << 11) | (b0 << 15) | (flags << 19) | (kind << 23) | ((rb === R.WATER ? 1 : 0) << 25);
            maskB[mi] = tint;
            any = true;
          }
        }
        if (!any) continue;
        // greedy merge
        for (let ic = 0; ic < nc; ic++) {
          for (let ib = 0; ib < nb;) {
            const mi = ic * nb + ib;
            const k = maskA[mi];
            if (!k) { ib++; continue; }
            const t = maskB[mi];
            let w = 1;
            while (ib + w < nb && maskA[mi + w] === k && maskB[mi + w] === t) w++;
            let h = 1;
            outer: while (ic + h < nc) {
              const row = (ic + h) * nb + ib;
              for (let j = 0; j < w; j++) if (maskA[row + j] !== k || maskB[row + j] !== t) break outer;
              h++;
            }
            for (let hh = 0; hh < h; hh++) for (let j = 0; j < w; j++) maskA[(ic + hh) * nb + ib + j] = 0;
            // emit merged quad
            pos[a] = s; pos[bA] = ib; pos[cA] = ic;
            const layer = (k >> 1) & 255, ao = (k >> 9) & 3, sk = (k >> 11) & 15, bl = (k >> 15) & 15, flags = (k >> 19) & 15, kind = (k >> 23) & 3;
            const isWater = (k >> 25) & 1;
            ao1[0] = ao1[1] = ao1[2] = ao1[3] = ao;
            sk1[0] = sk1[1] = sk1[2] = sk1[3] = sk;
            bl1[0] = bl1[1] = bl1[2] = bl1[3] = bl;
            const e = [0, 0, 0], f = [0, 0, 0];
            e[bA] = w * 16; f[cA] = h * 16;
            let ox = (cx * CS + pos[0]) * 16, oy = pos[1] * 16, oz = (cz * CS + pos[2]) * 16;
            if (DX[d] > 0) ox += 16; if (DY[d] > 0) oy += isWater ? 14 : 16; if (DZ[d] > 0) oz += 16;
            emitQuad(bufs[kind], d, ox, oy, oz, e[0], e[1], e[2], f[0], f[1], f[2], layer, t, ao1, sk1, bl1, flags);
            ib += w;
          }
        }
      }
    }

    function emitBlockFace(buf, d, lx, y, lz, layer, tint, ao, sk, bl, flags, wave, isWater) {
      const e = [0, 0, 0], f = [0, 0, 0];
      e[BAX[d]] = 16; f[CAX[d]] = 16;
      let ox = (cx * CS + lx) * 16, oy = y * 16, oz = (cz * CS + lz) * 16;
      if (DX[d] > 0) ox += 16; if (DY[d] > 0) oy += isWater ? 14 : 16; if (DZ[d] > 0) oz += 16;
      emitQuad(buf, d, ox, oy, oz, e[0], e[1], e[2], f[0], f[1], f[2], layer, tint, ao, sk, bl, flags | wave);
    }

    function emitWaterFace(buf, d, lx, y, lz, lowered, layer, tint, flags) {
      const e = [0, 0, 0], f = [0, 0, 0];
      e[BAX[d]] = 16; f[CAX[d]] = 16;
      let ox = (cx * CS + lx) * 16, oy = y * 16, oz = (cz * CS + lz) * 16;
      if (DX[d] > 0) ox += 16; if (DY[d] > 0) oy += lowered ? 14 : 16; if (DZ[d] > 0) oz += 16;
      // side faces: shorten the vertical edge when the surface is lowered
      if (lowered && d !== 2 && d !== 3) f[1] = 14;
      emitQuad(buf, d, ox, oy, oz, e[0], e[1], e[2], f[0], f[1], f[2], layer, tint, cornerAO, cornerSky, cornerBlk, flags);
    }

    // ---------------- special models
    for (let y = 1; y < ymax; y++) {
      for (let lz = 0; lz < CS; lz++) {
        for (let lx = 0; lx < CS; lx++) {
          const x = lx + M, z = lz + M;
          const i = y * YS + z * RX + x;
          const b = blocks[i];
          const rb = RENDER[b];
          if (rb < R.CROSS) continue;
          if (lod > 0 && (rb === R.CROSS || rb === R.CARPET) && b !== B.GLOW_MUSHROOM) continue;
          const wx = cx * CS + lx, wz = cz * CS + lz;
          const sk = sky[i], bl = blk[i];
          sk1[0] = sk1[1] = sk1[2] = sk1[3] = sk;
          bl1[0] = bl1[1] = bl1[2] = bl1[3] = Math.max(bl, EMIT[b] ? EMIT[b] : 0);
          ao1[0] = ao1[1] = ao1[2] = ao1[3] = 3;
          const tint = tintFor(b, lx, lz);
          const layer = TEX_SIDE[b];
          const buf = bufs[1];
          const ox = wx * 16, oy = y * 16, oz = wz * 16;
          if (rb === R.CROSS) {
            const hr = hash3(wx, y, wz, 77);
            const jx = Math.round((hash3(wx, y, wz, 78) - 0.5) * 5), jz = Math.round((hash3(wx, y, wz, 79) - 0.5) * 5);
            const hh = Math.round(PLANT_H[b] * (0.82 + 0.36 * hr) * 16);
            const flags = WAVE[b] | (b === B.SEAGRASS ? 4 : 0);
            const a0 = 1 + jx, a1 = 15 + jx, c0 = 1 + jz, c1 = 15 + jz;
            buf.reserve(8);
            crossQuad(buf, 6, ox + a0, ox + a1, oz + c0, oz + c1, oy, oy + hh, layer, tint, sk1, bl1, flags);
            crossQuad(buf, 7, ox + a0, ox + a1, oz + c1, oz + c0, oy, oy + hh, layer, tint, sk1, bl1, flags);
            if (oy < minY) minY = oy; if (oy + hh > maxY) maxY = oy + hh;
          } else if (rb === R.CARPET) {
            emitQuad(buf, 2, ox, oy + 1, oz, 16, 0, 0, 0, 0, 16, layer, tint, ao1, sk1, bl1, 0);
          } else if (rb === R.TORCH) {
            const x0 = ox + 7, x1 = ox + 9, z0 = oz + 7, z1 = oz + 9, y1 = oy + 10;
            // +X (b=z,c=y) reversed winding handled by emitQuad
            emitQuad(buf, 0, x1, oy, z0, 0, 0, 2, 0, 10, 0, layer, tint, ao1, sk1, bl1, 0);
            emitQuad(buf, 1, x0, oy, z0, 0, 0, 2, 0, 10, 0, layer, tint, ao1, sk1, bl1, 0);
            emitQuad(buf, 4, x0, oy, z1, 2, 0, 0, 0, 10, 0, layer, tint, ao1, sk1, bl1, 0);
            emitQuad(buf, 5, x0, oy, z0, 2, 0, 0, 0, 10, 0, layer, tint, ao1, sk1, bl1, 0);
            emitQuad(buf, 2, x0, y1, z0, 2, 0, 0, 0, 0, 2, TEX_TOP[b], tint, ao1, sk1, bl1, 0);
          } else if (rb === R.CACTUS) {
            const x0 = ox + 1, x1 = ox + 15, z0 = oz + 1, z1 = oz + 15;
            emitQuad(buf, 0, x1, oy, oz, 0, 0, 16, 0, 16, 0, layer, tint, ao1, sk1, bl1, 0);
            emitQuad(buf, 1, x0, oy, oz, 0, 0, 16, 0, 16, 0, layer, tint, ao1, sk1, bl1, 0);
            emitQuad(buf, 4, ox, oy, z1, 16, 0, 0, 0, 16, 0, layer, tint, ao1, sk1, bl1, 0);
            emitQuad(buf, 5, ox, oy, z0, 16, 0, 0, 0, 16, 0, layer, tint, ao1, sk1, bl1, 0);
            if (blocks[i + YS] !== B.CACTUS) emitQuad(buf, 2, ox, oy + 16, oz, 16, 0, 0, 0, 0, 16, TEX_TOP[b], tint, ao1, sk1, bl1, 0);
          }
        }
      }
    }

    function crossQuad(buf, nIdx, xa, xb, za, zb, y0, y1, layer, tint, skA, blA, flags) {
      // corners: bottom-a, bottom-b, top-b, top-a ; uv corner bits: u (bit0), v (bit1) with v=1 at bottom
      const P = [[xa, y0, za, 0, 1], [xb, y0, zb, 1, 1], [xb, y1, zb, 1, 0], [xa, y1, za, 0, 0]];
      for (let k = 0; k < 4; k++) {
        const p = P[k];
        const d1 = nIdx | (p[3] << 3) | (p[4] << 4) | (flags << 5);
        // flags layout in d1 bits 5..7: bit5 = wave lo, bit6 = wave hi, bit7 = underwater
        const data = layer | (d1 << 8) | (3 << 16) | (((skA[k] << 4) | blA[k]) << 24);
        buf.v(p[0], p[1], p[2], tint, data);
      }
    }

    return {
      opaque: bufs[0].take(), cutout: bufs[1].take(), trans: bufs[2].take(),
      nOpaque: bufs[0].n >> 2, nCutout: bufs[1].n >> 2, nTrans: bufs[2].n >> 2,
      minY: minY === 9999 ? 0 : minY / 16, maxY: maxY < 0 ? 0 : maxY / 16,
    };
  }
}
