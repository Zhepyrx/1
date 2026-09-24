// Thin WebGL2 helpers: programs with cached uniforms, textures, framebuffers.

export const FS_TRI_VS = `#version 300 es
out vec2 vUV;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export class Program {
  constructor(gl, vs, fs, name) {
    this.gl = gl;
    this.name = name;
    const v = compile(gl, gl.VERTEX_SHADER, vs, name + '.vs');
    const f = compile(gl, gl.FRAGMENT_SHADER, fs, name + '.fs');
    const p = gl.createProgram();
    gl.attachShader(p, v); gl.attachShader(p, f);
    gl.linkProgram(p);
    this.prog = p;
    this._vs = v; this._fs = f; this._linked = null;
  }
  // Deferred link-status check so that parallel compilation (KHR_parallel_shader_compile) can overlap.
  check() {
    if (this._linked !== null) return this._linked;
    const gl = this.gl, p = this.prog;
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = (s, src) => {
        const info = gl.getShaderInfoLog(s);
        if (info) {
          const lines = src.split('\n');
          const m = /ERROR: \d+:(\d+)/.exec(info);
          const ln = m ? +m[1] : 0;
          const ctx = lines.slice(Math.max(0, ln - 4), ln + 2).map((l, i) => `${Math.max(1, ln - 3) + i}: ${l}`).join('\n');
          console.error(`[${this.name}] ${info}\n${ctx}`);
        }
      };
      log(this._vs, gl.getShaderSource(this._vs));
      log(this._fs, gl.getShaderSource(this._fs));
      throw new Error(`Shader link failed: ${this.name}: ${gl.getProgramInfoLog(p)}`);
    }
    this._linked = true;
    this.u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      this.u[name] = gl.getUniformLocation(p, info.name);
    }
    this.units = {};
    let unit = 0;
    gl.useProgram(p);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const t = info.type;
      if (t === gl.SAMPLER_2D || t === gl.SAMPLER_3D || t === gl.SAMPLER_2D_ARRAY || t === gl.SAMPLER_2D_ARRAY_SHADOW ||
          t === gl.SAMPLER_2D_SHADOW || t === gl.INT_SAMPLER_2D || t === gl.UNSIGNED_INT_SAMPLER_2D) {
        this.units[info.name] = unit;
        gl.uniform1i(this.u[info.name], unit);
        unit++;
      }
    }
    return true;
  }
  use() { this.gl.useProgram(this.prog); return this; }
  tex(name, tex, target, sampler = null) {
    const unit = this.units[name];
    if (unit === undefined) return this;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target ?? gl.TEXTURE_2D, tex);
    gl.bindSampler(unit, sampler);
    return this;
  }
  f(name, ...v) {
    const l = this.u[name]; if (!l) return this;
    const gl = this.gl;
    if (v.length === 1) gl.uniform1f(l, v[0]);
    else if (v.length === 2) gl.uniform2f(l, v[0], v[1]);
    else if (v.length === 3) gl.uniform3f(l, v[0], v[1], v[2]);
    else gl.uniform4f(l, v[0], v[1], v[2], v[3]);
    return this;
  }
  fv(name, arr, size) {
    const l = this.u[name]; if (!l) return this;
    const gl = this.gl;
    if (size === 1) gl.uniform1fv(l, arr); else if (size === 2) gl.uniform2fv(l, arr);
    else if (size === 3) gl.uniform3fv(l, arr); else gl.uniform4fv(l, arr);
    return this;
  }
  i(name, ...v) {
    const l = this.u[name]; if (!l) return this;
    const gl = this.gl;
    if (v.length === 1) gl.uniform1i(l, v[0]);
    else if (v.length === 2) gl.uniform2i(l, v[0], v[1]);
    else if (v.length === 3) gl.uniform3i(l, v[0], v[1], v[2]);
    else gl.uniform4i(l, v[0], v[1], v[2], v[3]);
    return this;
  }
  m4(name, m) {
    const l = this.u[name]; if (!l) return this;
    this.gl.uniformMatrix4fv(l, false, m instanceof Float32Array ? m : new Float32Array(m));
    return this;
  }
  m4v(name, arr) {
    const l = this.u[name]; if (!l) return this;
    this.gl.uniformMatrix4fv(l, false, arr);
    return this;
  }
}

function compile(gl, type, src, name) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  void name;
  return s;
}

export function tex2D(gl, w, h, ifmt, fmt, type, opts = {}) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  const levels = opts.mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
  gl.texStorage2D(gl.TEXTURE_2D, levels, ifmt, w, h);
  const filt = opts.filter ?? gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.mips ? gl.LINEAR_MIPMAP_LINEAR : filt);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
  const wrap = opts.wrap ?? gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  if (opts.data) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, fmt, type, opts.data);
  t.w = w; t.h = h; t.levels = levels;
  return t;
}

export function fbo(gl, colors, depth, layerInfo) {
  const f = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  const bufs = [];
  colors.forEach((c, i) => {
    if (c.layer !== undefined) gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, c.tex, c.level ?? 0, c.layer);
    else gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, c.tex ?? c, c.level ?? 0);
    bufs.push(gl.COLOR_ATTACHMENT0 + i);
  });
  if (depth) {
    if (depth.layer !== undefined) gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, depth.tex, 0, depth.layer);
    else gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
  }
  gl.drawBuffers(bufs.length ? bufs : [gl.NONE]);
  if (!bufs.length) gl.readBuffer(gl.NONE);
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (st !== gl.FRAMEBUFFER_COMPLETE) console.warn('Framebuffer incomplete', st.toString(16), layerInfo ?? '');
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return f;
}
