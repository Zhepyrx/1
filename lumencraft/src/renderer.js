// Frame graph: sky LUTs -> shadows -> G-buffer -> AO -> clouds -> volumetrics -> lighting ->
// translucency -> particles -> temporal upscaling -> exposure -> bloom -> composite.
import { mat4, frustumPlanes, aabbInFrustum, halton, norm } from './math.js';
import { Program, FS_TRI_VS, tex2D, fbo } from './gl.js';
import { generateBlockTextures } from './textures.js';
import { MeshPool } from './meshpool.js';
import { T as TEXL } from './blocks.js';
import * as SkyS from './shaders/sky.js';
import * as CloudS from './shaders/clouds.js';
import * as TerrS from './shaders/terrain.js';
import * as PostS from './shaders/post.js';
import * as MiscS from './shaders/misc.js';

export const QUALITY = {
  low: { name: 'Low', scale: 0.6, shadowRes: 1024, cloudDiv: 4, cloudSteps: 40, volSteps: 10, pomSteps: 10, pomDist: 12, ssrSteps: 14, texRes: 128, renderDist: 8, pcss: true },
  medium: { name: 'Medium', scale: 0.72, shadowRes: 1536, cloudDiv: 4, cloudSteps: 52, volSteps: 14, pomSteps: 16, pomDist: 18, ssrSteps: 18, texRes: 128, renderDist: 10, pcss: true },
  high: { name: 'High', scale: 0.84, shadowRes: 2048, cloudDiv: 3, cloudSteps: 64, volSteps: 18, pomSteps: 24, pomDist: 24, ssrSteps: 24, texRes: 256, renderDist: 12, pcss: true },
  ultra: { name: 'Ultra', scale: 1.0, shadowRes: 3072, cloudDiv: 2, cloudSteps: 84, volSteps: 24, pomSteps: 32, pomDist: 32, ssrSteps: 32, texRes: 256, renderDist: 16, pcss: true },
};

const SCALE_STEPS = [0.5, 0.56, 0.62, 0.68, 0.74, 0.8, 0.86, 0.92, 1.0];

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: false, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: false, desynchronized: true,
    });
    if (!gl) throw new Error('WebGL 2 is not available in this browser.');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('This GPU/browser lacks EXT_color_buffer_float, which the renderer needs for HDR.');
    gl.getExtension('OES_texture_float_linear');
    this.gl = gl;
    this.canvas = canvas;
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    this.pool = new MeshPool(gl);
    this.frame = 0;
    this.outW = 0; this.outH = 0; this.inW = 0; this.inH = 0;
    this.scale = 0.8;
    this.q = QUALITY.high;
    this.historyValid = false;
    this.cascades = [0, 1, 2, 3].map(() => ({ mat: mat4.create(), cam: [0, 0, 0], r: 1, depth: 1, valid: false }));
    this.stats = { calls: 0, tris: 0 };
    this.emptyVAO = gl.createVertexArray();
    this.prevVP = null; this.prevCam = null;
  }

  // ---------------------------------------------------------------- init
  async init(quality, onProgress = () => {}) {
    const gl = this.gl;
    this.q = quality;
    onProgress('Compiling shaders');
    const P = (vs, fs, name) => new Program(gl, vs, fs, name);
    this.progs = {
      trans: P(FS_TRI_VS, SkyS.transmittanceFS, 'transmittance'),
      ms: P(FS_TRI_VS, SkyS.multiScatterFS, 'multiscatter'),
      skyview: P(FS_TRI_VS, SkyS.skyViewFS, 'skyview'),
      irr: P(FS_TRI_VS, SkyS.irradianceFS, 'irradiance'),
      cshape: P(FS_TRI_VS, CloudS.cloudShapeFS, 'cloudShape'),
      cdetail: P(FS_TRI_VS, CloudS.cloudDetailFS, 'cloudDetail'),
      weather: P(FS_TRI_VS, CloudS.weatherFS, 'weather'),
      clouds: P(FS_TRI_VS, CloudS.cloudsFS, 'clouds'),
      cresolve: P(FS_TRI_VS, CloudS.cloudResolveFS, 'cloudResolve'),
      gbuf: P(TerrS.terrainVS, TerrS.gbufferFS, 'gbuffer'),
      shadow: P(TerrS.terrainVS, TerrS.shadowFS, 'shadow'),
      transl: P(TerrS.terrainVS, TerrS.translucentFS, 'translucent'),
      ao: P(FS_TRI_VS, PostS.aoFS, 'ao'),
      aoBlur: P(FS_TRI_VS, PostS.aoBlurFS, 'aoBlur'),
      vol: P(FS_TRI_VS, PostS.volFS, 'vol'),
      light: P(FS_TRI_VS, PostS.lightingFS, 'lighting'),
      taa: P(FS_TRI_VS, PostS.taaFS, 'taa'),
      lum: P(FS_TRI_VS, PostS.lumFS, 'lum'),
      exposure: P(FS_TRI_VS, PostS.exposureFS, 'exposure'),
      bdown: P(FS_TRI_VS, PostS.bloomDownFS, 'bloomDown'),
      bup: P(FS_TRI_VS, PostS.bloomUpFS, 'bloomUp'),
      comp: P(FS_TRI_VS, PostS.compositeFS, 'composite'),
      outline: P(MiscS.outlineVS, MiscS.outlineFS, 'outline'),
      particles: P(MiscS.particleVS, MiscS.particleFS, 'particles'),
      debris: P(MiscS.debrisVS, MiscS.debrisFS, 'debris'),
    };
    for (const k in this.progs) { this.progs[k].check(); await tick(); }

    onProgress('Painting block textures');
    await tick();
    this.blockTex = generateBlockTextures(gl, quality.texRes, this.aniso);
    await tick();

    onProgress('Growing clouds');
    this.initSky();
    this.initClouds();
    this.initShadows(quality.shadowRes);
    this.initStatic();
    await tick();
  }

  setQuality(q) {
    const texChanged = q.texRes !== this.q.texRes;
    const shChanged = q.shadowRes !== this.q.shadowRes;
    this.q = q;
    if (texChanged) {
      const gl = this.gl;
      for (const t of [this.blockTex.albedo, this.blockTex.normal, this.blockTex.material]) gl.deleteTexture(t);
      this.blockTex = generateBlockTextures(gl, q.texRes, this.aniso);
    }
    if (shChanged) this.initShadows(q.shadowRes);
    this.allocTargets(true);
  }

  initStatic() {
    const gl = this.gl;
    this.samplers = {};
    const cmp = gl.createSampler();
    gl.samplerParameteri(cmp, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.samplerParameteri(cmp, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.samplerParameteri(cmp, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(cmp, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(cmp, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.samplerParameteri(cmp, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    const raw = gl.createSampler();
    gl.samplerParameteri(raw, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.samplerParameteri(raw, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.samplerParameteri(raw, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(raw, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(raw, gl.TEXTURE_COMPARE_MODE, gl.NONE);
    this.samplers.cmp = cmp; this.samplers.raw = raw;
    // particles: unit quad
    this.quadVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5]), gl.STATIC_DRAW);
    this.partVAO = gl.createVertexArray();
    gl.bindVertexArray(this.partVAO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);
    // debris instances
    this.debrisVBO = gl.createBuffer();
    this.debrisVAO = gl.createVertexArray();
    gl.bindVertexArray(this.debrisVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.debrisVBO);
    gl.bufferData(gl.ARRAY_BUFFER, 256 * 32, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
    // outline box edges
    const e = [];
    const c = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]];
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    for (const [a, b] of edges) {
      // two triangles per edge: (a, b, side)
      for (const [p, q, s] of [[a, b, -1], [b, a, 1], [a, b, 1], [b, a, 1], [b, a, -1], [a, b, 1]]) e.push(...c[p], ...c[q], s);
    }
    this.outlineVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.outlineVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(e), gl.STATIC_DRAW);
    this.outlineVAO = gl.createVertexArray();
    gl.bindVertexArray(this.outlineVAO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 28, 24);
    gl.bindVertexArray(null);
    this.outlineCount = e.length / 7;
    // exposure 1x1 ping-pong and luminance
    this.lumTex = tex2D(gl, 64, 64, gl.RG16F, gl.RG, gl.HALF_FLOAT, { mips: true });
    this.lumFBO = fbo(gl, [this.lumTex]);
    this.expTex = [0, 1].map(() => tex2D(gl, 1, 1, gl.R32F, gl.RED, gl.FLOAT, { filter: gl.NEAREST }));
    this.expFBO = this.expTex.map((t) => fbo(gl, [t]));
    // surface height map around the player for rain/particle occlusion
    this.surfTex = tex2D(gl, 128, 128, gl.RG8, gl.RG, gl.UNSIGNED_BYTE, { filter: gl.NEAREST });
    this.surfOrigin = [0, 0];
  }

  initSky() {
    const gl = this.gl;
    const mk = (w, h, wrapS = gl.CLAMP_TO_EDGE, mips = false) => {
      const t = tex2D(gl, w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, { mips });
      if (wrapS !== gl.CLAMP_TO_EDGE) { gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS); }
      return t;
    };
    this.transTex = mk(256, 64);
    this.msTex = mk(32, 32);
    this.skyTex = mk(192, 108, gl.REPEAT, true);
    this.irrTex = mk(32, 16, gl.REPEAT);
    this.transFBO = fbo(gl, [this.transTex]);
    this.msFBO = fbo(gl, [this.msTex]);
    this.skyFBO = fbo(gl, [this.skyTex]);
    this.irrFBO = fbo(gl, [this.irrTex]);
    this.drawFS(this.transFBO, 256, 64, this.progs.trans.use());
    this.progs.ms.use().tex('uTrans', this.transTex);
    this.drawFS(this.msFBO, 32, 32, this.progs.ms);
  }

  initClouds() {
    const gl = this.gl;
    const mk3 = (n) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, t);
      gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA8, n, n, n);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.REPEAT);
      return t;
    };
    this.cloudShape = mk3(128);
    this.cloudDetail = mk3(32);
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.emptyVAO);
    for (const [tex, n, prog] of [[this.cloudShape, 128, this.progs.cshape], [this.cloudDetail, 32, this.progs.cdetail]]) {
      prog.use();
      gl.viewport(0, 0, n, n);
      for (let z = 0; z < n; z++) {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, z);
        prog.f('uZ', (z + 0.5) / n);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(f);
    this.weatherTex = tex2D(gl, 512, 512, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, { wrap: gl.REPEAT });
    const wf = fbo(gl, [this.weatherTex]);
    this.drawFS(wf, 512, 512, this.progs.weather.use());
    gl.deleteFramebuffer(wf);
  }

  initShadows(res) {
    const gl = this.gl;
    if (this.shadowTex) { gl.deleteTexture(this.shadowTex); this.shadowFBO.forEach((f) => gl.deleteFramebuffer(f)); }
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.DEPTH_COMPONENT24, res, res, 4);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.shadowTex = t;
    this.shadowRes = res;
    this.shadowFBO = [0, 1, 2, 3].map((i) => fbo(gl, [], { tex: t, layer: i }, 'shadow' + i));
    for (const c of this.cascades) c.valid = false;
  }

  // ---------------------------------------------------------------- targets
  resize(w, h) {
    if (w === this.outW && h === this.outH) return;
    this.outW = w; this.outH = h;
    this.allocTargets(true);
  }

  setScale(s) {
    s = SCALE_STEPS.reduce((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a));
    if (s === this.scale) return;
    this.scale = s;
    this.allocTargets(false);
  }

  allocTargets(full) {
    const gl = this.gl;
    const del = (arr) => { for (const t of arr) if (t) (t instanceof WebGLFramebuffer ? gl.deleteFramebuffer(t) : gl.deleteTexture(t)); };
    const W = Math.max(8, Math.round(this.outW * this.scale)), H = Math.max(8, Math.round(this.outH * this.scale));
    this.inW = W; this.inH = H;
    if (this.tgt) del(this.tgt.list);
    const L = [];
    const T = (w, h, ifmt, fmt, type, o) => { const t = tex2D(gl, w, h, ifmt, fmt, type, o); L.push(t); return t; };
    const Fb = (c, d) => { const f = fbo(gl, c, d); L.push(f); return f; };
    const t = {};
    t.gAlb = T(W, H, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, { filter: gl.NEAREST });
    t.gNrm = T(W, H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, { filter: gl.NEAREST });
    t.gMisc = T(W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, { filter: gl.NEAREST });
    t.gDepth = T(W, H, gl.DEPTH_COMPONENT32F, gl.DEPTH_COMPONENT, gl.FLOAT, { filter: gl.NEAREST });
    t.gFBO = Fb([t.gAlb, t.gNrm, t.gMisc], t.gDepth);
    t.hdr = T(W, H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, { filter: gl.NEAREST });
    t.lin = T(W, H, gl.R32F, gl.RED, gl.FLOAT, { filter: gl.NEAREST });
    t.lightFBO = Fb([t.hdr, t.lin]);
    t.hdrFBO = Fb([t.hdr]);
    t.hdrCopy = T(W, H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, {});
    t.hdrCopyFBO = Fb([t.hdrCopy]);
    t.fwdFBO = Fb([t.hdr], t.gDepth);
    const hw = Math.max(4, W >> 1), hh = Math.max(4, H >> 1);
    t.aoW = hw; t.aoH = hh;
    t.aoRaw = T(hw, hh, gl.R8, gl.RED, gl.UNSIGNED_BYTE, {});
    t.ao = T(hw, hh, gl.R8, gl.RED, gl.UNSIGNED_BYTE, {});
    t.aoRawFBO = Fb([t.aoRaw]); t.aoFBO = Fb([t.ao]);
    t.vol = T(hw, hh, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, {});
    t.volFBO = Fb([t.vol]);
    const cw = Math.max(4, Math.round(W / this.q.cloudDiv)), ch = Math.max(4, Math.round(H / this.q.cloudDiv));
    t.cw = cw; t.ch = ch;
    t.cloudCur = T(cw, ch, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, {});
    t.cloudCurFBO = Fb([t.cloudCur]);
    t.cloudHist = [0, 1].map(() => T(cw, ch, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, {}));
    t.cloudHistFBO = t.cloudHist.map((x) => Fb([x]));
    if (full || !this.tgtOut) {
      if (this.tgtOut) del(this.tgtOut.list);
      const LO = [];
      const TO = (w, h, ifmt, fmt, type, o) => { const x = tex2D(gl, w, h, ifmt, fmt, type, o); LO.push(x); return x; };
      const FO = (c) => { const f = fbo(gl, c); LO.push(f); return f; };
      const o = {};
      o.hist = [0, 1].map(() => TO(this.outW, this.outH, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, {}));
      o.histFBO = o.hist.map((x) => FO([x]));
      o.bloom = []; o.bloomFBO = []; o.bloomSize = [];
      let bw = this.outW >> 1, bh = this.outH >> 1;
      for (let i = 0; i < 6 && bw >= 4 && bh >= 4; i++) {
        const x = TO(bw, bh, gl.R11F_G11F_B10F, gl.RGB, gl.HALF_FLOAT, {});
        o.bloom.push(x); o.bloomFBO.push(FO([x])); o.bloomSize.push([bw, bh]);
        bw >>= 1; bh >>= 1;
      }
      o.list = LO;
      this.tgtOut = o;
      this.historyValid = false;
    }
    t.list = L;
    this.tgt = t;
    this.cloudValid = false;
  }

  drawFS(fb, w, h, prog) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.emptyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    void prog;
  }

  // Upload the 128x128 surface heightmap (x,z around origin) used by weather particles.
  updateSurface(data, ox, oz) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.surfTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 128, gl.RG, gl.UNSIGNED_BYTE, data);
    this.surfOrigin = [ox, oz];
  }

  // ---------------------------------------------------------------- frame
  computeFrame(S) {
    const cam = S.cam;
    const W = this.inW, H = this.inH;
    const aspect = this.outW / this.outH;
    const near = 0.06, far = Math.max(600, S.renderDist * 32 * 1.6 + 200);
    const proj = mat4.perspective(mat4.create(), cam.fov, aspect, near, far);
    const cp = Math.cos(cam.pitch);
    const fwd = [Math.sin(cam.yaw) * cp, Math.sin(cam.pitch), -Math.cos(cam.yaw) * cp];
    const view = mat4.lookDir(mat4.create(), fwd, [0, 1, 0]);
    const vpNJ = mat4.multiply(mat4.create(), proj, view);
    const ji = (this.frame % 16) + 1;
    const jx = halton(ji, 2) - 0.5, jy = halton(ji, 3) - 0.5;
    const projJ = Float64Array.from(proj);
    projJ[8] = -2 * jx / W; projJ[9] = -2 * jy / H;
    const vp = mat4.multiply(mat4.create(), projJ, view);
    const invVP = mat4.invert(mat4.create(), vp);
    const pos = cam.pos;
    let prevVP = vpNJ;
    if (this.prevVP && this.prevCam) {
      prevVP = mat4.translate(mat4.create(), this.prevVP, [pos[0] - this.prevCam[0], pos[1] - this.prevCam[1], pos[2] - this.prevCam[2]]);
    }
    const camI = [Math.floor(pos[0] * 16), Math.floor(pos[1] * 16), Math.floor(pos[2] * 16)];
    const camF = [pos[0] - camI[0] / 16, pos[1] - camI[1] / 16, pos[2] - camI[2] / 16];
    const f32 = (m) => new Float32Array(m);
    return {
      proj, projJ, view, vp, vpNJ, invVP, fwd, near, far, jitter: [jx, jy], pos, camI, camF, aspect,
      vp32: f32(vp), vpNJ32: f32(vpNJ), invVP32: f32(invVP), prevVP32: f32(prevVP), view32: f32(view),
      invProj32: f32(mat4.invert(mat4.create(), projJ)), proj32: f32(projJ),
      planes: frustumPlanes(vpNJ),
    };
  }

  updateCascades(S, F) {
    const L = S.env.lightDir;
    const res = this.shadowRes;
    const dist = S.renderDist * 32;
    const splits = [12, 34, 100, Math.min(dist * 0.9, 380)];
    const lightRot = mat4.lookDir(mat4.create(), [-L[0], -L[1], -L[2]], [0, 1, 0]);
    const tanH = Math.tan(S.cam.fov / 2);
    const right = norm([F.view[0], F.view[4], F.view[8]]);
    const up = norm([F.view[1], F.view[5], F.view[9]]);
    const fwd = F.fwd;
    const updateMask = [true, true, this.frame % 2 === 0, this.frame % 4 === 1];
    for (let c = 0; c < 4; c++) {
      const C = this.cascades[c];
      const lightMoved = !C.L || Math.abs(C.L[0] - L[0]) + Math.abs(C.L[1] - L[1]) + Math.abs(C.L[2] - L[2]) > 1e-4;
      if (C.valid && !updateMask[c] && !lightMoved) continue;
      const n = c === 0 ? 0.05 : splits[c - 1], f = splits[c];
      let cx = 0, cy = 0, cz = 0;
      const pts = [];
      for (const d of [n, f]) {
        const hh = d * tanH, hw = hh * F.aspect;
        for (const sy of [-1, 1]) for (const sx of [-1, 1]) {
          const p = [fwd[0] * d + up[0] * hh * sy + right[0] * hw * sx, fwd[1] * d + up[1] * hh * sy + right[1] * hw * sx, fwd[2] * d + up[2] * hh * sy + right[2] * hw * sx];
          pts.push(p); cx += p[0]; cy += p[1]; cz += p[2];
        }
      }
      cx /= 8; cy /= 8; cz /= 8;
      let r = 0;
      for (const p of pts) r = Math.max(r, Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz));
      r = Math.ceil(r * 1.04 + 1);
      const texel = (2 * r) / res;
      // world-space centre, snapped to shadow texels in light space
      const wc = [F.pos[0] + cx, F.pos[1] + cy, F.pos[2] + cz];
      const lx = lightRot[0] * wc[0] + lightRot[4] * wc[1] + lightRot[8] * wc[2];
      const ly = lightRot[1] * wc[0] + lightRot[5] * wc[1] + lightRot[9] * wc[2];
      const lz = lightRot[2] * wc[0] + lightRot[6] * wc[1] + lightRot[10] * wc[2];
      const sx = Math.floor(lx / texel) * texel, sy = Math.floor(ly / texel) * texel;
      const sc = [
        lightRot[0] * sx + lightRot[1] * sy + lightRot[2] * lz,
        lightRot[4] * sx + lightRot[5] * sy + lightRot[6] * lz,
        lightRot[8] * sx + lightRot[9] * sy + lightRot[10] * lz,
      ];
      const zr = r + 300;
      const ortho = mat4.ortho(mat4.create(), -r, r, -r, r, -zr, zr);
      const m = mat4.multiply(mat4.create(), ortho, lightRot);
      mat4.translate(m, m, [-(sc[0] - F.pos[0]), -(sc[1] - F.pos[1]), -(sc[2] - F.pos[2])]);
      C.mat = m; C.cam = F.pos.slice(); C.r = r; C.depth = 2 * zr; C.texel = texel; C.far = f; C.valid = true; C.dirty = true;
      C.L = L.slice();
    }
    // matrices relative to the current camera for sampling
    const mats = new Float32Array(64);
    for (let c = 0; c < 4; c++) {
      const C = this.cascades[c];
      const m = mat4.translate(mat4.create(), C.mat, [F.pos[0] - C.cam[0], F.pos[1] - C.cam[1], F.pos[2] - C.cam[2]]);
      C.matNow = m;
      mats.set(m, c * 16);
    }
    this.shadowMats = mats;
  }

  visibleChunks(chunks, planes, F, kind) {
    const out = [];
    for (const ch of chunks) {
      const a = ch.mesh && ch.mesh[kind];
      if (!a || !a.length) continue;
      const x0 = ch.cx * 32 - F.pos[0], z0 = ch.cz * 32 - F.pos[2];
      if (!aabbInFrustum(planes, x0, ch.minY - F.pos[1] - 1, z0, x0 + 32, ch.maxY - F.pos[1] + 1, z0 + 32)) continue;
      out.push(a);
    }
    return out;
  }

  // Set every shared uniform/texture that a program declares.
  bindCommon(p, S, F) {
    const env = S.env, w = S.weather, gl = this.gl;
    p.f('uRes', this.inW, this.inH).f('uOutRes', this.outW, this.outH);
    p.m4('uInvVP', F.invVP32).m4('uVPnj', F.vpNJ32).m4('uPrevVP', F.prevVP32);
    p.f('uCamPos', F.pos[0], F.pos[1], F.pos[2]).f('uCamFwd', F.fwd[0], F.fwd[1], F.fwd[2]);
    p.f('uNear', F.near).f('uFar', F.far).f('uTime', S.time).i('uFrame', this.frame);
    p.f('uSunDir', ...env.sunDir).f('uMoonDir', ...env.moonDir).f('uLightDir', ...env.lightDir);
    const flash = w.flash;
    p.f('uLightColor', env.lightColor[0] + flash * 3, env.lightColor[1] + flash * 3.2, env.lightColor[2] + flash * 4);
    p.f('uNight', env.night).f('uCamAltKm', env.altKm).f('uRenderDist', S.renderDist * 32);
    p.f('uSunIllum', env.sunIllum * (1 - w.rain * 0.55)).f('uMoonIllum', env.moonIllum * (1 - w.rain * 0.6));
    p.f('uHaze', S.fog.haze).f('uMist', S.fog.mist).f('uMistY', S.fog.mistY).f('uRain', w.rain).f('uWetness', w.wetness);
    p.f('uUnderwater', S.underwater ? 1 : 0);
    p.f('uAurora', S.aurora);
    if (p.u.uStarRot) gl.uniformMatrix3fv(p.u.uStarRot, false, env.starRot);
    p.f('uCloudBottom', 650).f('uCloudTop', 1500).f('uCloudCoverage', w.coverage).f('uCloudDensity', 1.0 + w.rain * 0.6);
    p.f('uWindOffset', S.time * 9.0, S.time * 0.8, S.time * 4.0);
    p.m4v('uShadowMat', this.shadowMats);
    const C = this.cascades;
    p.f('uCascadeFar', C[0].far, C[1].far, C[2].far, C[3].far);
    p.f('uCascadeTexel', C[0].texel, C[1].texel, C[2].texel, C[3].texel);
    p.f('uCascadeDepth', C[0].depth, C[1].depth, C[2].depth, C[3].depth);
    p.f('uCascadeSize', C[0].r * 2, C[1].r * 2, C[2].r * 2, C[3].r * 2);
    p.f('uShadowRes', this.shadowRes).f('uLightAngle', env.useSun ? 0.022 : 0.03);
    p.tex('uTrans', this.transTex).tex('uSkyView', this.skyTex).tex('uIrr', this.irrTex);
    p.tex('uShadow', this.shadowTex, gl.TEXTURE_2D_ARRAY, this.samplers.cmp);
    p.tex('uShadowRaw', this.shadowTex, gl.TEXTURE_2D_ARRAY, this.samplers.raw);
    p.tex('uCloudShape', this.cloudShape, gl.TEXTURE_3D).tex('uCloudDetail', this.cloudDetail, gl.TEXTURE_3D);
    p.tex('uWeather', this.weatherTex);
  }

  render(S) {
    const gl = this.gl;
    const F = this.computeFrame(S);
    this.F = F;
    const q = this.q;
    const t = this.tgt, o = this.tgtOut;
    const P = this.progs;
    const env = S.env;
    this.stats.calls = 0; this.stats.tris = 0;
    const acc = (r) => { this.stats.calls += r.calls; this.stats.tris += r.tris; };

    // ---- sky
    gl.bindVertexArray(this.emptyVAO);
    P.skyview.use().tex('uTrans', this.transTex).tex('uMS', this.msTex)
      .f('uSunDir', ...env.sunDir).f('uMoonDir', ...env.moonDir)
      .f('uSunIllum', env.sunIllum * (1 - S.weather.rain * 0.55)).f('uMoonIllum', env.moonIllum * (1 - S.weather.rain * 0.6)).f('uCamAltKm', env.altKm).f('uRain', S.weather.rain);
    this.drawFS(this.skyFBO, 192, 108, P.skyview);
    gl.bindTexture(gl.TEXTURE_2D, this.skyTex);
    gl.generateMipmap(gl.TEXTURE_2D);
    P.irr.use().tex('uSkyView', this.skyTex).tex('uTrans', this.transTex)
      .f('uSunDir', ...env.sunDir).f('uMoonDir', ...env.moonDir)
      .f('uSunIllum', env.sunIllum * (1 - S.weather.rain * 0.55)).f('uMoonIllum', env.moonIllum).f('uCamAltKm', env.altKm);
    this.drawFS(this.irrFBO, 32, 16, P.irr);

    // ---- shadows
    this.updateCascades(S, F);
    const chunks = S.chunks;
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.1, 2.0);
    P.shadow.use();
    P.shadow.i('uCamI', ...F.camI).f('uCamF', ...F.camF).f('uTime', S.time).f('uWind', S.wind);
    P.shadow.tex('uAlbedo', this.blockTex.albedo, gl.TEXTURE_2D_ARRAY);
    for (let c = 0; c < 4; c++) {
      const C = this.cascades[c];
      if (!C.dirty) continue;
      C.dirty = false;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFBO[c]);
      gl.viewport(0, 0, this.shadowRes, this.shadowRes);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      const m32 = new Float32Array(C.matNow);
      P.shadow.m4('uVP', m32);
      const planes = frustumPlanes(C.matNow);
      gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
      P.shadow.i('uCutout', 0);
      acc(this.pool.draw(this.visibleChunks(chunks, planes, F, 'opaque')));
      gl.disable(gl.CULL_FACE);
      P.shadow.i('uCutout', 1);
      acc(this.pool.draw(this.visibleChunks(chunks, planes, F, 'cutout')));
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);

    // ---- G-buffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.gFBO);
    gl.viewport(0, 0, this.inW, this.inH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const G = P.gbuf.use();
    G.m4('uVP', F.vp32).i('uCamI', ...F.camI).f('uCamF', ...F.camF).f('uTime', S.time).f('uWind', S.wind);
    G.f('uCamPos', ...F.pos).f('uLightDir', ...env.lightDir).f('uWetness', S.weather.wetness).f('uRain', S.weather.rain);
    G.f('uPomDist', q.pomDist).i('uPomSteps', q.pomSteps).i('uFrame', this.frame).f('uPlantFade', S.plantFade * 0.68, S.plantFade * 0.92);
    G.fv('uLayerInfo', this.blockTex.layerInfo, 4);
    G.tex('uAlbedo', this.blockTex.albedo, gl.TEXTURE_2D_ARRAY).tex('uNormal', this.blockTex.normal, gl.TEXTURE_2D_ARRAY).tex('uMaterial', this.blockTex.material, gl.TEXTURE_2D_ARRAY);
    gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    acc(this.pool.draw(this.visibleChunks(chunks, F.planes, F, 'opaque')));
    gl.disable(gl.CULL_FACE);
    acc(this.pool.draw(this.visibleChunks(chunks, F.planes, F, 'cutout')));
    gl.disable(gl.DEPTH_TEST);

    // ---- AO
    P.ao.use().tex('uDepth', t.gDepth).tex('uG1', t.gNrm).f('uAORes', t.aoW, t.aoH)
      .m4('uInvProj', F.invProj32).m4('uProj', F.proj32).m4('uViewRot', F.view32).i('uFrame', this.frame);
    this.drawFS(t.aoRawFBO, t.aoW, t.aoH);
    P.aoBlur.use().tex('uAO', t.aoRaw).tex('uDepth', t.gDepth).f('uAORes', t.aoW, t.aoH).f('uNear', F.near).f('uFar', F.far);
    this.drawFS(t.aoFBO, t.aoW, t.aoH);

    // ---- clouds
    const ci = this.frame & 1;
    const Cl = P.clouds.use();
    this.bindCommon(Cl, S, F);
    Cl.tex('uDepth', t.gDepth).f('uCloudRes', t.cw, t.ch).i('uCloudSteps', q.cloudSteps);
    this.drawFS(t.cloudCurFBO, t.cw, t.ch);
    const CR = P.cresolve.use();
    this.bindCommon(CR, S, F);
    CR.tex('uCur', t.cloudCur).tex('uHist', t.cloudHist[1 - ci]).f('uCloudRes', t.cw, t.ch).f('uReset', this.cloudValid ? 0 : 1);
    this.drawFS(t.cloudHistFBO[ci], t.cw, t.ch);
    this.cloudValid = true;
    const cloudTex = t.cloudHist[ci];

    // ---- volumetric light
    const volMax = 160;
    const Vo = P.vol.use();
    this.bindCommon(Vo, S, F);
    Vo.tex('uDepth', t.gDepth).f('uVolRes', t.aoW, t.aoH).f('uVolMax', volMax).i('uVolSteps', q.volSteps);
    this.drawFS(t.volFBO, t.aoW, t.aoH);

    // ---- lighting
    const hi = this.frame & 1;
    const Li = P.light.use();
    this.bindCommon(Li, S, F);
    Li.tex('uG0', t.gAlb).tex('uG1', t.gNrm).tex('uG2', t.gMisc).tex('uDepth', t.gDepth).tex('uAO', t.ao)
      .tex('uVol', t.vol).tex('uCloudTex', cloudTex).tex('uHistory', o.hist[1 - hi]);
    Li.i('uDebug', S.debug | 0).f('uSSR', 1).f('uSSRSteps', q.ssrSteps).f('uVolMax', volMax).f('uFlicker', S.flicker).f('uHasHistory', this.historyValid ? 1 : 0);
    this.drawFS(t.lightFBO, this.inW, this.inH);

    // ---- translucent (water, glass, ice)
    const transList = [];
    for (const ch of chunks) {
      const a = ch.mesh && ch.mesh.trans;
      if (!a || !a.length) continue;
      const x0 = ch.cx * 32 - F.pos[0], z0 = ch.cz * 32 - F.pos[2];
      if (!aabbInFrustum(F.planes, x0, ch.minY - F.pos[1] - 1, z0, x0 + 32, ch.maxY - F.pos[1] + 1, z0 + 32)) continue;
      transList.push({ a, d: (x0 + 16) ** 2 + (z0 + 16) ** 2 });
    }
    if (transList.length) {
      transList.sort((x, y) => y.d - x.d);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.hdrFBO);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.hdrCopyFBO);
      gl.blitFramebuffer(0, 0, this.inW, this.inH, 0, 0, this.inW, this.inH, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fwdFBO);
      gl.viewport(0, 0, this.inW, this.inH);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
      gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);
      const Tr = P.transl.use();
      this.bindCommon(Tr, S, F);
      Tr.m4('uVP', F.vp32).i('uCamI', ...F.camI).f('uCamF', ...F.camF).f('uWind', S.wind);
      Tr.tex('uSceneColor', t.hdrCopy).tex('uLinDepth', t.lin).tex('uVol', t.vol).tex('uCloudTex', cloudTex)
        .tex('uAlbedo', this.blockTex.albedo, gl.TEXTURE_2D_ARRAY).tex('uNormal', this.blockTex.normal, gl.TEXTURE_2D_ARRAY)
        .i('uWaterLayer', TEXL.water).f('uSSRSteps', q.ssrSteps).f('uVolRes', t.aoW, t.aoH);
      acc(this.pool.draw(transList.map((x) => x.a), false));
      gl.disable(gl.DEPTH_TEST);
    }

    // ---- particles (weather, fireflies, pollen) and block debris
    this.renderParticles(S, F);

    // ---- temporal upscaling
    const Ta = P.taa.use();
    this.bindCommon(Ta, S, F);
    Ta.tex('uCurr', t.hdr).tex('uDepth', t.gDepth).tex('uHist', o.hist[1 - hi])
      .f('uInRes', this.inW, this.inH).f('uOutRes', this.outW, this.outH).f('uJitter', F.jitter[0], F.jitter[1])
      .f('uReset', this.historyValid ? 0 : 1);
    this.drawFS(o.histFBO[hi], this.outW, this.outH);
    const taaOut = o.hist[hi];

    // ---- exposure
    P.lum.use().tex('uSrc', taaOut);
    this.drawFS(this.lumFBO, 64, 64);
    gl.bindTexture(gl.TEXTURE_2D, this.lumTex);
    gl.generateMipmap(gl.TEXTURE_2D);
    const ei = this.frame & 1;
    P.exposure.use().tex('uLum', this.lumTex).tex('uPrev', this.expTex[1 - ei])
      .f('uDt', S.dt).f('uEVComp', S.evComp).f('uMinLum', 0.0008).f('uMaxLum', 40.0).f('uLumLevel', 6).f('uReset', this.historyValid ? 0 : 1);
    this.drawFS(this.expFBO[ei], 1, 1);

    // ---- bloom
    const nb = o.bloom.length;
    P.bdown.use();
    for (let i = 0; i < nb; i++) {
      const src = i === 0 ? taaOut : o.bloom[i - 1];
      const sw = i === 0 ? this.outW : o.bloomSize[i - 1][0], sh = i === 0 ? this.outH : o.bloomSize[i - 1][1];
      P.bdown.tex('uSrc', src).f('uSrcTexel', 1 / sw, 1 / sh).f('uDstRes', o.bloomSize[i][0], o.bloomSize[i][1]).i('uFirst', i === 0 ? 1 : 0);
      this.drawFS(o.bloomFBO[i], o.bloomSize[i][0], o.bloomSize[i][1]);
    }
    P.bup.use();
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = nb - 1; i > 0; i--) {
      P.bup.tex('uSrc', o.bloom[i]).f('uSrcTexel', 1 / o.bloomSize[i][0], 1 / o.bloomSize[i][1])
        .f('uDstRes', o.bloomSize[i - 1][0], o.bloomSize[i - 1][1]).f('uWeight', 1.0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, o.bloomFBO[i - 1]);
      gl.viewport(0, 0, o.bloomSize[i - 1][0], o.bloomSize[i - 1][1]);
      gl.bindVertexArray(this.emptyVAO);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);

    // ---- composite to screen
    const Co = P.comp.use();
    Co.tex('uSrc', taaOut).tex('uBloom', o.bloom[0]).tex('uExposure', this.expTex[ei])
      .f('uOutRes', this.outW, this.outH).f('uBloomStr', S.post.bloom / nb).f('uSharpen', S.post.sharpen)
      .f('uVignette', S.post.vignette).f('uGrain', S.post.grain).f('uTime', S.time).f('uUnderwater', S.underwater ? 1 : 0)
      .f('uSaturation', S.post.saturation).f('uContrast', S.post.contrast).f('uPurkinje', 1.0).i('uFrame', this.frame);
    this.drawFS(null, this.outW, this.outH);

    // ---- block selection outline
    if (S.selection) this.renderOutline(S, F);

    this.prevVP = F.vpNJ;
    this.prevCam = F.pos.slice();
    this.historyValid = true;
    this.frame++;
  }

  renderParticles(S, F) {
    const gl = this.gl;
    const t = this.tgt;
    const P = this.progs;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fwdFBO);
    gl.viewport(0, 0, this.inW, this.inH);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    // ambient particle systems
    const Pa = P.particles.use();
    this.bindCommon(Pa, S, F);
    Pa.m4('uVP', F.vp32).tex('uSurf', this.surfTex).f('uSurfOrigin', this.surfOrigin[0], this.surfOrigin[1]);
    gl.bindVertexArray(this.partVAO);
    for (const sys of S.particles) {
      if (sys.count <= 0) continue;
      Pa.i('uKind', sys.kind).f('uIntensity', sys.intensity);
      if (sys.additive) gl.blendFunc(gl.ONE, gl.ONE); else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, sys.count);
    }
    // debris
    if (S.debris && S.debris.count) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.debrisVBO);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, S.debris.data, 0, S.debris.count * 8);
      const D = P.debris.use();
      this.bindCommon(D, S, F);
      D.m4('uVP', F.vp32).tex('uAlbedo', this.blockTex.albedo, gl.TEXTURE_2D_ARRAY);
      gl.bindVertexArray(this.debrisVAO);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, S.debris.count);
    }
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.disable(gl.DEPTH_TEST);
  }

  renderOutline(S, F) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.outW, this.outH);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const O = this.progs.outline.use();
    const s = S.selection;
    O.m4('uVP', F.vpNJ32).f('uOrigin', s[0] - F.pos[0], s[1] - F.pos[1], s[2] - F.pos[2]).f('uOutRes', this.outW, this.outH)
      .tex('uDepth', this.tgt.gDepth).f('uNear', F.near).f('uFar', F.far).f('uWidth', Math.max(1.5, this.outH / 700));
    gl.bindVertexArray(this.outlineVAO);
    gl.drawArrays(gl.TRIANGLES, 0, this.outlineCount);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  // Read the first mip of a texture layer back as RGBA8 (used for hotbar icons).
  readLayer(layer, size = 64) {
    const gl = this.gl;
    const src = this.blockTex;
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    const lvl = Math.max(0, Math.round(Math.log2(src.res / size)));
    const n = src.res >> lvl;
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, src.albedo, lvl, layer);
    const out = new Uint8Array(n * n * 4);
    gl.readPixels(0, 0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(f);
    return { data: out, size: n };
  }
}

function tick() { return new Promise((r) => setTimeout(r, 0)); }
