// GPU vertex arena: chunk meshes live in a few large vertex buffers ("pages") that share one
// static quad index buffer, so each render pass issues one multi-draw per page.

export const PAGE_QUADS = 1 << 17;
const VERT_BYTES = 16;

class Page {
  constructor(gl, ibo) {
    this.gl = gl;
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, PAGE_QUADS * 4 * VERT_BYTES, gl.DYNAMIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribIPointer(0, 2, gl.INT, VERT_BYTES, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 2, gl.SHORT, VERT_BYTES, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 4, gl.UNSIGNED_BYTE, VERT_BYTES, 12);
    gl.bindVertexArray(null);
    this.free = [[0, PAGE_QUADS]]; // sorted [start, len]
    this.used = 0;
  }
  alloc(n) {
    for (let i = 0; i < this.free.length; i++) {
      const f = this.free[i];
      if (f[1] >= n) {
        const start = f[0];
        f[0] += n; f[1] -= n;
        if (f[1] === 0) this.free.splice(i, 1);
        this.used += n;
        return start;
      }
    }
    return -1;
  }
  release(start, n) {
    this.used -= n;
    const fl = this.free;
    let i = 0;
    while (i < fl.length && fl[i][0] < start) i++;
    fl.splice(i, 0, [start, n]);
    // merge with neighbours
    if (i + 1 < fl.length && fl[i][0] + fl[i][1] === fl[i + 1][0]) { fl[i][1] += fl[i + 1][1]; fl.splice(i + 1, 1); }
    if (i > 0 && fl[i - 1][0] + fl[i - 1][1] === fl[i][0]) { fl[i - 1][1] += fl[i][1]; fl.splice(i, 1); }
  }
}

export class MeshPool {
  constructor(gl) {
    this.gl = gl;
    this.md = gl.getExtension('WEBGL_multi_draw');
    const idx = new Uint32Array(PAGE_QUADS * 6);
    for (let q = 0, o = 0; q < PAGE_QUADS; q++, o += 6) {
      const v = q * 4;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
      idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
    }
    this.ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    this.pages = [];
    this.lists = [];
    this.totalQuads = 0;
  }

  // Upload a mesh (Int32 vertex words, 4 per vertex). Returns a list of allocations.
  upload(buffer, nQuads) {
    const out = [];
    if (!nQuads) return out;
    const gl = this.gl;
    const data = new Int32Array(buffer);
    let done = 0;
    while (done < nQuads) {
      const n = Math.min(nQuads - done, PAGE_QUADS);
      let pi = -1, start = -1;
      for (let i = 0; i < this.pages.length; i++) {
        const s = this.pages[i].alloc(n);
        if (s >= 0) { pi = i; start = s; break; }
      }
      if (pi < 0) {
        this.pages.push(new Page(gl, this.ibo));
        pi = this.pages.length - 1;
        start = this.pages[pi].alloc(n);
      }
      const page = this.pages[pi];
      gl.bindBuffer(gl.ARRAY_BUFFER, page.vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, start * 4 * VERT_BYTES, data, done * 16, n * 16);
      out.push({ page: pi, start, count: n });
      done += n;
    }
    this.totalQuads += nQuads;
    return out;
  }

  // Sub-ranges of an upload (list of allocations covering quads [0, n)) for quads [start, start + count).
  slice(allocs, start, count) {
    const out = [];
    let base = 0;
    for (const a of allocs) {
      const s = Math.max(start, base), e = Math.min(start + count, base + a.count);
      if (e > s) out.push({ page: a.page, start: a.start + (s - base), count: e - s });
      base += a.count;
    }
    return out;
  }

  release(allocs) {
    for (const a of allocs) { this.pages[a.page].release(a.start, a.count); this.totalQuads -= a.count; }
  }

  // Draw the given allocation lists. `merge` combines contiguous ranges (not for sorted translucent draws).
  draw(allocLists, merge = true) {
    const gl = this.gl;
    const per = this.lists;
    for (let i = 0; i < this.pages.length; i++) { if (!per[i]) per[i] = []; per[i].length = 0; }
    for (const list of allocLists) for (const a of list) per[a.page].push(a);
    let calls = 0, tris = 0;
    for (let i = 0; i < this.pages.length; i++) {
      const arr = per[i];
      if (!arr.length) continue;
      if (merge) arr.sort((a, b) => a.start - b.start);
      const counts = [], offsets = [];
      let cs = -1, ce = -1;
      for (const a of arr) {
        if (merge && a.start === ce) { ce += a.count; continue; }
        if (cs >= 0) { counts.push((ce - cs) * 6); offsets.push(cs * 24); }
        cs = a.start; ce = a.start + a.count;
      }
      if (cs >= 0) { counts.push((ce - cs) * 6); offsets.push(cs * 24); }
      gl.bindVertexArray(this.pages[i].vao);
      if (this.md) {
        this.md.multiDrawElementsWEBGL(gl.TRIANGLES, new Int32Array(counts), 0, gl.UNSIGNED_INT, new Int32Array(offsets), 0, counts.length);
        calls++;
      } else {
        for (let k = 0; k < counts.length; k++) gl.drawElements(gl.TRIANGLES, counts[k], gl.UNSIGNED_INT, offsets[k]);
        calls += counts.length;
      }
      for (const c of counts) tris += c / 3;
    }
    gl.bindVertexArray(null);
    return { calls, tris };
  }
}
