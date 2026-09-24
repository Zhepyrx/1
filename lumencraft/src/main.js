// Lumencraft bootstrap: game loop, input, settings, HUD and menus.
import { Renderer, QUALITY } from './renderer.js';
import { World } from './world.js';
import { Player } from './player.js';
import { Audio } from './audio.js';
import { computeEnvironment, Weather } from './environment.js';
import { B, INFO, RENDER, R, SOLID, TEX_TOP, TEX_SIDE, TINT, HOTBAR_DEFAULT, PALETTE, EMIT } from './blocks.js';
import { BIOME_NAMES, SEA } from './worldgen.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const TEST = params.has('test');

// ------------------------------------------------------------------ settings
const DEFAULTS = {
  quality: 'high', dynamicRes: true, targetFps: 60, renderScale: 0.84, renderDist: 12, fov: 74, sensitivity: 1,
  volume: 0.7, viewBob: true, dayCycle: true, dayMinutes: 24, weather: 'auto', grain: true, sharpen: 0.55,
  hotbar: HOTBAR_DEFAULT.slice(),
};
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('lumencraft.settings') || '{}') }; } catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem('lumencraft.settings', JSON.stringify(settings)); } catch { /* storage unavailable */ }
}
const settings = loadSettings();
if (TEST) {
  settings.quality = params.get('q') ?? 'low';
  settings.renderDist = +(params.get('rd') ?? 4);
  settings.dynamicRes = false;
  settings.renderScale = +(params.get('scale') ?? 1);
}

// ------------------------------------------------------------------ worker factory
function createWorker() {
  // eslint-disable-next-line no-undef
  if (typeof __WORKER_SRC__ !== 'undefined') return new Worker(URL.createObjectURL(new Blob([__WORKER_SRC__], { type: 'text/javascript' })));
  return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
}

// ------------------------------------------------------------------ state
const canvas = $('gl');
let renderer, world, player, audio, weather;
const state = {
  mode: 'boot', // boot | title | play | pause
  hours: +(params.get('time') ?? 7.25),
  day: 12,
  time: 0,
  slot: 0,
  hudHidden: false,
  perf: false,
  fps: 0, frameMs: 0, gpuMs: 0,
  selection: null,
  breakTimer: 0,
  mouse: { left: false, right: false },
  pointerLocked: false,
  dragLook: false,
  lastSpace: 0,
  cine: 0,
  evComp: 0,
};
const keys = new Set();
const debris = { data: new Float32Array(256 * 8), count: 0, list: [] };
let seed = +(params.get('seed') ?? 20260924);
let lastSurf = null;
let spawn = [0, 90, 0];

// ------------------------------------------------------------------ boot
async function boot() {
  setBoot('Starting renderer', 0.05);
  try {
    renderer = new Renderer(canvas);
  } catch (e) {
    fatal(e.message);
    return;
  }
  resize();
  const q = QUALITY[settings.quality] ?? QUALITY.high;
  await renderer.init(q, (msg) => setBoot(msg, 0.3));
  renderer.scale = settings.dynamicRes ? q.scale : settings.renderScale;
  renderer.allocTargets(true);
  setBoot('Shaping the world', 0.6);
  audio = new Audio();
  audio.setVolume(settings.volume);
  weather = new Weather();
  applyWeatherSetting();
  startWorld(seed);
  buildHotbar();
  buildPalette();
  bindUI();
  requestAnimationFrame(loop);
}

function startWorld(s) {
  if (world) world.destroy();
  seed = s;
  world = new World(seed, renderer.pool, createWorker);
  world.renderDist = settings.renderDist;
  spawn = params.has('pos') ? params.get('pos').split(',').map(Number) : world.findSpawn();
  player = new Player(world, spawn);
  player.yaw = +(params.get('yaw') ?? 0.6);
  player.pitch = +(params.get('pitch') ?? -0.05);
  player.onStep = (id, sprint) => audio.hit(INFO[id]?.sound ?? 'stone', 'step', sprint ? 1.2 : 1);
  world.onBlockChanged = () => { lastSurf = null; };
  renderer.historyValid = false;
  lastSurf = null;
}

function setBoot(msg, p) {
  const el = $('boot-status');
  if (el) el.textContent = msg;
  const bar = $('boot-bar');
  if (bar) bar.style.transform = `scaleX(${p})`;
}
function fatal(msg) {
  $('boot').hidden = false;
  $('boot-status').textContent = msg;
  $('boot').classList.add('error');
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(64, Math.floor(window.innerWidth * dpr)), h = Math.max(64, Math.floor(window.innerHeight * dpr));
  canvas.width = w; canvas.height = h;
  if (renderer) renderer.resize(w, h);
}
window.addEventListener('resize', resize);

// ------------------------------------------------------------------ loop
let last = performance.now();
let frameCount = 0, fpsTimer = 0, fpsFrames = 0;
let gpuQueries = [];
let dynTimer = 0;
let emaMs = 16;
let readyFrames = 0;
let testLeft = -1;

function loop(now) {
  if (TEST && document.title === 'ready') return;
  requestAnimationFrame(loop);
  let dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (TEST) dt = 1 / 60;
  frameCount++;
  fpsTimer += dt; fpsFrames++;
  if (fpsTimer > 0.5) { state.fps = fpsFrames / fpsTimer; fpsTimer = 0; fpsFrames = 0; }
  emaMs += (dt * 1000 - emaMs) * 0.05;
  state.frameMs = emaMs;

  if (state.mode === 'boot') {
    // wait for the spawn area to be meshed before revealing the title screen
    world.update(spawn[0], spawn[2], 0, -1);
    const col = world.column(Math.floor(spawn[0] / 32), Math.floor(spawn[2] / 32));
    const ready = col && col.mesh && world.stats.pending < (TEST ? 1 : 60);
    setBoot(`Shaping the world · ${world.stats.meshed} chunks`, 0.6 + Math.min(0.39, world.stats.meshed / 150));
    if (ready) {
      readyFrames++;
      if (readyFrames > 2) {
        // settle the player on the ground
        let y = 200;
        while (y > 1 && !world.isSolid(Math.floor(spawn[0]), y - 1, Math.floor(spawn[2]))) y--;
        if (!params.has('pos')) player.pos[1] = y;
        state.mode = TEST ? 'play' : 'title';
        $('boot').classList.add('done');
        if (TEST) { $('boot').hidden = true; $('hud').hidden = params.get('hud') !== '1'; }
        setTimeout(() => { $('boot').hidden = true; }, 900);
        if (!TEST) showTitle();
      }
    }
    if (state.mode === 'boot') return;
  }

  // --- time & weather
  const env0Night = computeEnvironment(state.hours, state.day, player.pos[1]).night;
  if (settings.dayCycle && state.mode !== 'pause' && !TEST) {
    state.hours += dt * 24 / (settings.dayMinutes * 60);
  }
  if (keys.has('BracketRight')) state.hours += dt * 1.5;
  if (keys.has('BracketLeft')) state.hours -= dt * 1.5;
  if (state.hours >= 24) { state.hours -= 24; state.day++; }
  if (state.hours < 0) { state.hours += 24; state.day--; }
  if (!TEST) weather.update(dt);
  state.time += dt;

  // --- camera / player
  let cam;
  if (state.mode === 'title') {
    state.cine += dt;
    const a = state.cine * 0.035 + 0.8;
    const rad = 70;
    const cx = spawn[0] + Math.cos(a) * rad, cz = spawn[2] + Math.sin(a) * rad;
    let gy = 60;
    for (let y = 200; y > 0; y--) { const b = world.getBlock(Math.floor(cx), y, Math.floor(cz)); if (b > 0 && b !== B.WATER) { gy = y; break; } if (b < 0) { gy = 90; break; } }
    const cy = Math.max(gy + 26, SEA + 30);
    const lx = spawn[0] - cx, lz = spawn[2] - cz, ly = spawn[1] + 6 - cy;
    const yaw = Math.atan2(lx, -lz);
    const pitch = Math.atan2(ly, Math.hypot(lx, lz));
    cam = { pos: [cx, cy, cz], yaw, pitch, fov: 62 * Math.PI / 180 };
    world.update(cx, cz, Math.sin(yaw), -Math.cos(yaw));
  } else {
    const input = {
      forward: keys.has('KeyW') || keys.has('ArrowUp'), back: keys.has('KeyS') || keys.has('ArrowDown'),
      left: keys.has('KeyA') || keys.has('ArrowLeft'), right: keys.has('KeyD') || keys.has('ArrowRight'),
      jump: keys.has('Space'), descend: keys.has('KeyC') || keys.has('ControlLeft'),
      sprint: keys.has('ShiftLeft') || keys.has('ShiftRight'),
    };
    if (state.mode === 'play') player.update(dt, input);
    const eye = player.eye(settings.viewBob);
    cam = { pos: eye, yaw: player.yaw, pitch: player.pitch, fov: (settings.fov + player.fovKick * 8) * Math.PI / 180 };
    const f = player.forward();
    world.update(player.pos[0], player.pos[2], f[0], f[2]);
    // targeting
    state.selection = null;
    if (state.mode === 'play' && !player.frozen) {
      const hit = world.raycast(eye, f, 7);
      if (hit) { state.selection = hit.pos; state.hit = hit; } else state.hit = null;
      state.breakTimer -= dt;
      if (state.mouse.left && state.breakTimer <= 0 && hit) { breakBlock(hit); state.breakTimer = 0.22; }
      if (state.mouse.right && state.breakTimer <= 0 && hit) { placeBlock(hit); state.breakTimer = 0.22; }
    }
  }

  // --- surface map for weather particles
  const cxr = Math.floor(cam.pos[0]) - 64, czr = Math.floor(cam.pos[2]) - 64;
  if (!lastSurf || world.surfDirty || Math.abs(cxr - lastSurf[0]) > 12 || Math.abs(czr - lastSurf[1]) > 12) {
    renderer.updateSurface(world.buildSurface(cxr, czr), cxr, czr);
    lastSurf = [cxr, czr];
    world.surfDirty = false;
  }

  const env = computeEnvironment(state.hours, state.day, cam.pos[1]);
  void env0Night;
  const underwater = state.mode !== 'title' && player.eyeInWater && !params.has('nouw');
  updateDebris(dt);

  // --- fog & atmosphere parameters
  const h = state.hours;
  const morning = Math.exp(-Math.pow((h - 6.6) / 1.5, 2));
  const evening = Math.exp(-Math.pow((h - 19.5) / 1.4, 2)) * 0.35;
  const fog = {
    haze: 0.0009 + weather.rain * 0.0025,
    mist: (0.018 * morning + 0.004 * evening + 0.0025 * env.night) * (1 - weather.rain * 0.5),
    mistY: SEA + 7,
  };
  const dayF = 1 - env.night;
  const noRain = 1 - weather.rain;
  const particles = [
    { kind: 0, count: Math.round(7000 * weather.rain), intensity: 1, additive: false },
    { kind: 1, count: Math.round(4000 * weather.rain), intensity: 1, additive: false },
    { kind: 2, count: Math.round(260 * env.night * noRain), intensity: 1, additive: true },
    { kind: 3, count: Math.round(500 * dayF * noRain), intensity: 1, additive: true },
    { kind: 4, count: 320, intensity: 1, additive: false },
  ];
  const flickerT = state.time;
  const flicker = 1 + 0.05 * Math.sin(flickerT * 11.3) * Math.sin(flickerT * 7.1 + 1.3) + 0.03 * Math.sin(flickerT * 23.7);
  const aurora = env.night * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(state.day * 1.7 + 0.4)));

  // --- dynamic resolution
  pollGpuTimer();
  dynTimer += dt;
  if (settings.dynamicRes && state.mode !== 'pause' && dynTimer > 0.6) {
    dynTimer = 0;
    const target = 1000 / settings.targetFps;
    const q = renderer.q;
    const measure = state.gpuMs > 0 ? state.gpuMs : emaMs;
    if (measure > target * 1.05) renderer.setScale(renderer.scale - 0.06);
    else if (measure < target * (state.gpuMs > 0 ? 0.72 : 0.8) && renderer.scale < q.scale) renderer.setScale(Math.min(q.scale, renderer.scale + 0.06));
  }

  const S = {
    cam, env, weather, time: state.time, dt, renderDist: settings.renderDist, chunks: world.renderList,
    wind: 1 + weather.rain * 1.2, flicker, fog, underwater, aurora,
    post: { bloom: 0.09, sharpen: settings.sharpen, vignette: 0.22, grain: settings.grain ? 0.035 : 0, saturation: 1.0, contrast: 1.0 },
    evComp: state.evComp + (underwater ? 0.3 : 0), particles, debris, selection: state.hudHidden ? null : state.selection,
    debug: +(params.get('dbg') ?? 0),
    plantFade: world.detailRadius * 32,
  };
  beginGpuTimer();
  try { renderer.render(S); } finally { endGpuTimer(); }

  if (audio) {
    const ex = Math.floor(cam.pos[0]), ez = Math.floor(cam.pos[2]);
    let sheltered = false;
    for (let y = Math.floor(cam.pos[1]) + 1; y < Math.floor(cam.pos[1]) + 20; y++) { const b = world.getBlock(ex, y, ez); if (b > 0 && SOLID[b]) { sheltered = true; break; } }
    let nearWater = 0;
    for (let k = 0; k < 6; k++) {
      const a = k / 6 * Math.PI * 2;
      const b = world.getBlock(Math.floor(cam.pos[0] + Math.cos(a) * 6), Math.floor(cam.pos[1] - 1.5), Math.floor(cam.pos[2] + Math.sin(a) * 6));
      if (b === B.WATER) nearWater += 1 / 6;
    }
    const biome = world.biomeAt(ex, ez);
    audio.update(dt, {
      altitude: cam.pos[1], rain: weather.rain, underwater, flying: player.flying, day: dayF, sheltered, nearWater,
      trees: biome === 3 || biome === 4 || biome === 5 || biome === 6 || biome === 2 || biome === 12, thunder: weather.thunder > 0,
    });
    weather.thunder = 0;
  }

  if (frameCount % 10 === 0) updateHUD(env);
  if (TEST) {
    if (testLeft < 0) {
      if (world.stats.pending === 0 && world.uploads.length === 0) testLeft = +(params.get('frames') ?? 40);
    } else if (--testLeft <= 0 && world.stats.pending === 0 && world.uploads.length === 0) document.title = 'ready';
  }
}

// ------------------------------------------------------------------ GPU timing
function beginGpuTimer() {
  const gl = renderer.gl;
  const ext = renderer.timerExt ?? (renderer.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2') || false);
  if (!ext || gpuQueries.length > 4) return;
  const q = gl.createQuery();
  gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
  gpuQueries.push(q);
  state.gpuActive = true;
}
function endGpuTimer() {
  const ext = renderer.timerExt;
  if (!ext || !state.gpuActive) return;
  renderer.gl.endQuery(ext.TIME_ELAPSED_EXT);
  state.gpuActive = false;
}
function pollGpuTimer() {
  const gl = renderer.gl, ext = renderer.timerExt;
  if (!ext) return;
  while (gpuQueries.length) {
    const q = gpuQueries[0];
    if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
    gl.deleteQuery(q);
    gpuQueries.shift();
    if (!disjoint) state.gpuMs = state.gpuMs ? state.gpuMs + (ns / 1e6 - state.gpuMs) * 0.1 : ns / 1e6;
  }
}

// ------------------------------------------------------------------ interaction
function breakBlock(hit) {
  const [x, y, z] = hit.pos;
  const id = hit.id;
  if (y <= 0) return;
  // plants on top of a broken block fall with it
  if (world.setBlock(x, y, z, 0)) {
    const above = world.getBlock(x, y + 1, z);
    if (above > 0 && (RENDER[above] === R.CROSS || RENDER[above] === R.CARPET || RENDER[above] === R.TORCH)) world.setBlock(x, y + 1, z, 0);
    audio.hit(INFO[id]?.sound ?? 'stone', 'break');
    spawnDebris(x, y, z, id);
  }
}

function placeBlock(hit) {
  const id = settings.hotbar[state.slot];
  if (!id) return;
  const [x, y, z] = hit.pos;
  const n = hit.normal;
  let px = x + n[0], py = y + n[1], pz = z + n[2];
  // replace plants/grass directly
  const targetR = RENDER[hit.id];
  if (targetR === R.CROSS || targetR === R.CARPET) { px = x; py = y; pz = z; }
  const cur = world.getBlock(px, py, pz);
  if (cur !== 0 && cur !== B.WATER && RENDER[cur] !== R.CROSS && RENDER[cur] !== R.CARPET) return;
  if (SOLID[id] && player.intersectsBlock(px, py, pz)) return;
  if ((RENDER[id] === R.CROSS || RENDER[id] === R.CARPET || RENDER[id] === R.TORCH) && !world.isSolid(px, py - 1, pz)) return;
  if (world.setBlock(px, py, pz, id)) audio.hit(INFO[id]?.sound ?? 'stone', 'place');
}

function spawnDebris(x, y, z, id) {
  const layer = TEX_SIDE[id];
  for (let i = 0; i < 18; i++) {
    debris.list.push({
      p: [x + 0.2 + Math.random() * 0.6, y + 0.2 + Math.random() * 0.6, z + 0.2 + Math.random() * 0.6],
      v: [(Math.random() - 0.5) * 3, Math.random() * 3.5 + 1, (Math.random() - 0.5) * 3],
      life: 0.6 + Math.random() * 0.6, size: 0.06 + Math.random() * 0.06, layer,
      u: Math.floor(Math.random() * 4) / 4, w: Math.floor(Math.random() * 4) / 4, light: 15 * 16,
    });
  }
  if (debris.list.length > 256) debris.list.splice(0, debris.list.length - 256);
}

function updateDebris(dt) {
  let n = 0;
  const d = debris.data;
  for (let i = debris.list.length - 1; i >= 0; i--) {
    const p = debris.list[i];
    p.life -= dt;
    if (p.life <= 0) { debris.list.splice(i, 1); continue; }
    p.v[1] -= 16 * dt;
    const ny = p.p[1] + p.v[1] * dt;
    if (world.isSolid(Math.floor(p.p[0]), Math.floor(ny - p.size * 0.5), Math.floor(p.p[2]))) { p.v[1] *= -0.25; p.v[0] *= 0.6; p.v[2] *= 0.6; }
    else p.p[1] = ny;
    p.p[0] += p.v[0] * dt; p.p[2] += p.v[2] * dt;
    const o = n * 8;
    d[o] = p.p[0]; d[o + 1] = p.p[1]; d[o + 2] = p.p[2]; d[o + 3] = p.size * Math.min(1, p.life * 3);
    d[o + 4] = p.layer; d[o + 5] = p.u; d[o + 6] = p.w; d[o + 7] = p.light;
    n++;
  }
  debris.count = n;
}

// ------------------------------------------------------------------ input
function isTyping(e) { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA'); }

window.addEventListener('keydown', (e) => {
  if (isTyping(e)) return;
  if (e.code === 'Tab' || e.code === 'F1' || e.code === 'F3' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  if (state.mode !== 'play') {
    if (e.code === 'Escape' && state.mode === 'pause' && !$('palette').hidden) { closePalette(); }
    return;
  }
  keys.add(e.code);
  if (e.repeat) return;
  if (e.code.startsWith('Digit')) { const n = +e.code.slice(5); if (n >= 1 && n <= 9) selectSlot(n - 1); }
  if (e.code === 'Space') {
    const t = performance.now();
    if (t - state.lastSpace < 280) { player.flying = !player.flying; player.vel[1] = 0; toast(player.flying ? 'Flying' : 'Walking'); }
    state.lastSpace = t;
  }
  if (e.code === 'KeyF') { player.flying = !player.flying; player.vel[1] = 0; toast(player.flying ? 'Flying' : 'Walking'); }
  if (e.code === 'KeyT') { settings.dayCycle = !settings.dayCycle; saveSettings(); toast(settings.dayCycle ? 'Day cycle running' : 'Time paused'); syncSettingsUI(); }
  if (e.code === 'KeyR') { cycleWeather(); }
  if (e.code === 'F1') { state.hudHidden = !state.hudHidden; $('hud').classList.toggle('hidden', state.hudHidden); }
  if (e.code === 'F3' || e.code === 'KeyP') { state.perf = !state.perf; $('perf').hidden = !state.perf; }
  if (e.code === 'KeyE') { openPalette(); }
  if (e.code === 'KeyM') { settings.volume = settings.volume > 0 ? 0 : 0.7; audio.setVolume(settings.volume); saveSettings(); syncSettingsUI(); toast(settings.volume ? 'Sound on' : 'Muted'); }
  if (e.code === 'Equal') { state.evComp = Math.min(2, state.evComp + 0.25); toast(`Exposure ${state.evComp >= 0 ? '+' : ''}${state.evComp.toFixed(2)} EV`); }
  if (e.code === 'Minus') { state.evComp = Math.max(-2, state.evComp - 0.25); toast(`Exposure ${state.evComp >= 0 ? '+' : ''}${state.evComp.toFixed(2)} EV`); }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

canvas.addEventListener('mousedown', (e) => {
  if (state.mode !== 'play') return;
  if (!state.pointerLocked && !state.dragLook) { lockPointer(); return; }
  if (e.button === 0) { state.mouse.left = true; state.breakTimer = 0; state.dragMoved = 0; }
  if (e.button === 2) { state.mouse.right = true; state.breakTimer = 0; state.dragMoved = 0; }
  if (e.button === 1 && state.hit) { pickBlock(state.hit.id); e.preventDefault(); }
  if (state.dragLook) state.dragging = true;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) state.mouse.left = false;
  if (e.button === 2) state.mouse.right = false;
  state.dragging = false;
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('mousemove', (e) => {
  if (state.mode !== 'play') return;
  const look = state.pointerLocked || (state.dragLook && state.dragging);
  if (!look) return;
  const s = 0.0022 * settings.sensitivity;
  player.yaw += e.movementX * s;
  player.pitch = Math.max(-1.55, Math.min(1.55, player.pitch - e.movementY * s));
  if (state.dragLook) {
    state.dragMoved = (state.dragMoved || 0) + Math.abs(e.movementX) + Math.abs(e.movementY);
    if (state.dragMoved > 6) { state.mouse.left = false; state.mouse.right = false; }
  }
});
window.addEventListener('wheel', (e) => {
  if (state.mode !== 'play') return;
  selectSlot((state.slot + (e.deltaY > 0 ? 1 : -1) + 9) % 9);
}, { passive: true });

function lockPointer() {
  try {
    const p = canvas.requestPointerLock?.();
    if (p && p.catch) p.catch(() => enableDragLook());
  } catch { enableDragLook(); }
}
function enableDragLook() {
  if (state.dragLook) return;
  state.dragLook = true;
  toast('Drag to look around · click to break · right-click to place');
}
document.addEventListener('pointerlockchange', () => {
  state.pointerLocked = document.pointerLockElement === canvas;
  if (!state.pointerLocked && state.mode === 'play' && !state.dragLook) pause();
});
document.addEventListener('pointerlockerror', () => enableDragLook());

// ------------------------------------------------------------------ modes
function showTitle() {
  $('title').hidden = false;
  $('hud').hidden = true;
}
function enterWorld() {
  audio.start();
  $('title').hidden = true;
  $('pause').hidden = true;
  $('hud').hidden = false;
  if (state.mode === 'title') {
    renderer.historyValid = false;
  }
  state.mode = 'play';
  lockPointer();
}
function pause() {
  state.mode = 'pause';
  keys.clear();
  state.mouse.left = state.mouse.right = false;
  $('pause').hidden = false;
  showPanel('main');
}
function resume() {
  $('pause').hidden = true;
  closePalette(true);
  state.mode = 'play';
  lockPointer();
}

// ------------------------------------------------------------------ HUD
function selectSlot(i) {
  state.slot = i;
  document.querySelectorAll('#hotbar .slot').forEach((el, k) => el.classList.toggle('active', k === i));
  const id = settings.hotbar[i];
  toast(INFO[id]?.name ?? '', 'item');
}
function pickBlock(id) {
  if (!INFO[id] || id === B.WATER) return;
  const at = settings.hotbar.indexOf(id);
  if (at >= 0) { selectSlot(at); return; }
  settings.hotbar[state.slot] = id;
  saveSettings();
  buildHotbar();
  selectSlot(state.slot);
}

const iconCache = new Map();
function blockIcon(id, size = 64) {
  const k = id + ':' + size;
  if (iconCache.has(k)) return iconCache.get(k);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const texCanvas = (layer, tintIn) => {
    const tint = tintIn ?? [1, 1, 1];
    const { data, size: n } = renderer.readLayer(layer, 64);
    const tc = document.createElement('canvas');
    tc.width = tc.height = n;
    const tg = tc.getContext('2d');
    const img = tg.createImageData(n, n);
    for (let i = 0; i < n * n; i++) {
      const a = data[i * 4 + 3] / 255;
      const tm = tintIn ? (RENDER[id] === R.CUBE ? a : 1) : 0;
      img.data[i * 4] = data[i * 4] * (1 - tm + tm * tint[0]);
      img.data[i * 4 + 1] = data[i * 4 + 1] * (1 - tm + tm * tint[1]);
      img.data[i * 4 + 2] = data[i * 4 + 2] * (1 - tm + tm * tint[2]);
      img.data[i * 4 + 3] = RENDER[id] === R.CUBE ? 255 : data[i * 4 + 3] > 100 ? 255 : 0;
    }
    tg.putImageData(img, 0, 0);
    return { tc, n };
  };
  const tint = TINT[id] === 1 ? [0.47, 0.68, 0.32] : TINT[id] === 2 ? [0.42, 0.62, 0.3] : null;
  const s = size / 64;
  if (RENDER[id] === R.CROSS || RENDER[id] === R.TORCH || RENDER[id] === R.CARPET) {
    const { tc } = texCanvas(TEX_SIDE[id], tint);
    g.imageSmoothingEnabled = true;
    g.drawImage(tc, 6 * s, 6 * s, 52 * s, 52 * s);
  } else {
    const top = texCanvas(TEX_TOP[id], tint), side = texCanvas(TEX_SIDE[id], tint);
    g.imageSmoothingEnabled = true;
    const face = (t, a, b, cc, d, e, f, shade) => {
      g.setTransform(a * s / t.n, b * s / t.n, cc * s / t.n, d * s / t.n, e * s, f * s);
      g.drawImage(t.tc, 0, 0);
      if (shade) { g.fillStyle = `rgba(0,0,0,${shade})`; g.fillRect(0, 0, t.n, t.n); }
    };
    face(side, 28, 14, 0, 30, 4, 18, 0.22);
    face(side, 28, -14, 0, 30, 32, 32, 0.4);
    face(top, 28, -14, 28, 14, 4, 18, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
  const url = c.toDataURL();
  iconCache.set(k, url);
  return url;
}

function buildHotbar() {
  const bar = $('hotbar');
  bar.innerHTML = '';
  settings.hotbar.forEach((id, i) => {
    const el = document.createElement('button');
    el.className = 'slot' + (i === state.slot ? ' active' : '');
    el.setAttribute('aria-label', `Slot ${i + 1}: ${INFO[id]?.name ?? 'empty'}`);
    el.innerHTML = `<span class="num">${i + 1}</span>`;
    if (id) { const img = new Image(); img.src = blockIcon(id); img.alt = ''; el.appendChild(img); }
    el.addEventListener('click', () => selectSlot(i));
    bar.appendChild(el);
  });
}

function buildPalette() {
  const grid = $('palette-grid');
  grid.innerHTML = '';
  for (const id of PALETTE) {
    const el = document.createElement('button');
    el.className = 'pal-item';
    el.title = INFO[id].name;
    const img = new Image(); img.src = blockIcon(id); img.alt = '';
    el.appendChild(img);
    const lbl = document.createElement('span'); lbl.textContent = INFO[id].name; el.appendChild(lbl);
    if (EMIT[id]) el.classList.add('glow');
    el.addEventListener('click', () => {
      settings.hotbar[state.slot] = id;
      saveSettings();
      buildHotbar();
      selectSlot(state.slot);
      closePalette();
    });
    grid.appendChild(el);
  }
}
function openPalette() {
  state.mode = 'pause';
  keys.clear();
  if (document.pointerLockElement) { state.paletteOpening = true; document.exitPointerLock(); }
  $('palette').hidden = false;
}
function closePalette(silent) {
  if ($('palette').hidden) return;
  $('palette').hidden = true;
  if (!silent) { state.mode = 'play'; lockPointer(); }
}

let toastTimer = 0;
function toast(msg, kind = 'info') {
  const el = $(kind === 'item' ? 'itemname' : 'toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), kind === 'item' ? 1400 : 2200);
  void toastTimer;
}

function fmtTime(h) {
  const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function updateHUD(env) {
  const w = weather;
  const cond = w.rain > 0.85 && w.flash > 0 ? 'Thunderstorm' : w.rain > 0.5 ? 'Rain' : w.coverage > 0.6 ? 'Overcast' : env.night > 0.5 ? (env.moonIllum > 0.03 ? 'Moonlit' : 'Starlit') : 'Clear';
  $('clock').textContent = fmtTime(state.hours);
  $('cond').textContent = cond;
  if (state.perf) {
    const p = player.pos;
    const biome = world.biomeAt(Math.floor(p[0]), Math.floor(p[2]));
    const lines = [
      `${state.fps.toFixed(0)} fps   ${state.frameMs.toFixed(1)} ms frame   ${state.gpuMs ? state.gpuMs.toFixed(1) + ' ms GPU' : 'GPU timer n/a'}`,
      `internal ${renderer.inW}×${renderer.inH} (${Math.round(renderer.scale * 100)}%) → ${renderer.outW}×${renderer.outH}  ${renderer.q.name}`,
      `draw calls ${renderer.stats.calls}   triangles ${(renderer.stats.tris / 1e6).toFixed(2)} M`,
      `chunks ${world.renderList.length} meshed · ${world.stats.pending} queued · ${world.workers.length} workers`,
      `xyz ${p[0].toFixed(1)} ${p[1].toFixed(1)} ${p[2].toFixed(1)}   ${BIOME_NAMES[biome] ?? '—'}`,
      `sun ${(Math.asin(env.sunDir[1]) * 180 / Math.PI).toFixed(1)}°   moon phase ${(env.phase * 100).toFixed(0)}%   rain ${(w.rain * 100).toFixed(0)}%   wet ${(w.wetness * 100).toFixed(0)}%`,
    ];
    $('perf').textContent = lines.join('\n');
  }
}

// ------------------------------------------------------------------ settings UI
function applyWeatherSetting() {
  weather.auto = settings.weather === 'auto';
  if (settings.weather === 'clear') weather.setRain(false);
  if (settings.weather === 'rain') weather.setRain(true);
}
function cycleWeather() {
  const order = ['auto', 'clear', 'rain'];
  settings.weather = order[(order.indexOf(settings.weather) + 1) % 3];
  applyWeatherSetting();
  saveSettings();
  syncSettingsUI();
  toast({ auto: 'Weather: changing naturally', clear: 'Weather: clear skies', rain: 'Weather: rain' }[settings.weather]);
}

function showPanel(name) {
  for (const p of document.querySelectorAll('#pause .panel')) p.hidden = p.dataset.panel !== name;
}

function syncSettingsUI() {
  const set = (id, v) => { const el = $(id); if (!el) return; if (el.type === 'checkbox') el.checked = !!v; else el.value = v; };
  set('s-quality', settings.quality);
  set('s-dynres', settings.dynamicRes);
  set('s-target', settings.targetFps);
  set('s-scale', Math.round(settings.renderScale * 100));
  set('s-dist', settings.renderDist);
  set('s-fov', settings.fov);
  set('s-sens', settings.sensitivity);
  set('s-vol', Math.round(settings.volume * 100));
  set('s-bob', settings.viewBob);
  set('s-cycle', settings.dayCycle);
  set('s-weather', settings.weather);
  set('s-grain', settings.grain);
  set('s-sharpen', Math.round(settings.sharpen * 100));
  set('s-time', Math.round(state.hours * 4) / 4);
  $('s-scale').disabled = settings.dynamicRes;
  $('s-target').disabled = !settings.dynamicRes;
  for (const el of document.querySelectorAll('[data-out]')) {
    const src = $(el.dataset.out);
    if (!src) continue;
    const v = +src.value;
    el.textContent = el.dataset.fmt === 'pct' ? `${v}%` : el.dataset.fmt === 'deg' ? `${v}°` : el.dataset.fmt === 'chunks' ? `${v} chunks · ${v * 32} m` : el.dataset.fmt === 'time' ? fmtTime(v) : el.dataset.fmt === 'x' ? `${v.toFixed(2)}×` : v;
  }
  document.querySelectorAll('.quality-pick button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.q === settings.quality)));
}

function setQuality(qname) {
  if (!QUALITY[qname]) return;
  settings.quality = qname;
  const q = QUALITY[qname];
  settings.renderDist = q.renderDist;
  world.renderDist = q.renderDist;
  renderer.setQuality(q);
  if (settings.dynamicRes) renderer.setScale(q.scale);
  iconCache.clear();
  buildHotbar(); buildPalette();
  saveSettings();
  syncSettingsUI();
}

function bindUI() {
  $('btn-enter').addEventListener('click', enterWorld);
  $('btn-title-settings').addEventListener('click', () => { $('pause').hidden = false; showPanel('settings'); $('pause').classList.add('from-title'); });
  $('btn-resume').addEventListener('click', resume);
  $('btn-settings').addEventListener('click', () => showPanel('settings'));
  $('btn-controls').addEventListener('click', () => showPanel('controls'));
  $('btn-newworld').addEventListener('click', () => {
    startWorld((Math.random() * 1e9) | 0);
    state.mode = 'boot';
    readyFrames = 0;
    $('pause').hidden = true;
    $('boot').hidden = false;
    $('boot').classList.remove('done');
  });
  for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', () => {
    if ($('pause').classList.contains('from-title')) { $('pause').hidden = true; $('pause').classList.remove('from-title'); return; }
    showPanel('main');
  });
  document.querySelectorAll('.quality-pick button').forEach((b) => b.addEventListener('click', () => setQuality(b.dataset.q)));
  $('s-quality').addEventListener('change', (e) => setQuality(e.target.value));
  $('s-dynres').addEventListener('change', (e) => {
    settings.dynamicRes = e.target.checked;
    renderer.setScale(settings.dynamicRes ? renderer.q.scale : settings.renderScale);
    saveSettings(); syncSettingsUI();
  });
  $('s-target').addEventListener('change', (e) => { settings.targetFps = +e.target.value; saveSettings(); });
  $('s-scale').addEventListener('input', (e) => { settings.renderScale = +e.target.value / 100; if (!settings.dynamicRes) renderer.setScale(settings.renderScale); saveSettings(); syncSettingsUI(); });
  $('s-dist').addEventListener('input', (e) => { settings.renderDist = +e.target.value; world.renderDist = settings.renderDist; saveSettings(); syncSettingsUI(); });
  $('s-fov').addEventListener('input', (e) => { settings.fov = +e.target.value; saveSettings(); syncSettingsUI(); });
  $('s-sens').addEventListener('input', (e) => { settings.sensitivity = +e.target.value; saveSettings(); syncSettingsUI(); });
  $('s-vol').addEventListener('input', (e) => { settings.volume = +e.target.value / 100; audio.setVolume(settings.volume); saveSettings(); syncSettingsUI(); });
  $('s-bob').addEventListener('change', (e) => { settings.viewBob = e.target.checked; saveSettings(); });
  $('s-cycle').addEventListener('change', (e) => { settings.dayCycle = e.target.checked; saveSettings(); });
  $('s-weather').addEventListener('change', (e) => { settings.weather = e.target.value; applyWeatherSetting(); saveSettings(); });
  $('s-grain').addEventListener('change', (e) => { settings.grain = e.target.checked; saveSettings(); });
  $('s-sharpen').addEventListener('input', (e) => { settings.sharpen = +e.target.value / 100; saveSettings(); syncSettingsUI(); });
  $('s-time').addEventListener('input', (e) => { state.hours = +e.target.value; syncSettingsUI(); });
  $('palette-close').addEventListener('click', () => closePalette());
  syncSettingsUI();
}

// expose a tiny debug surface for automated screenshots
window.__lumencraft = {
  state, settings, get world() { return world; }, get player() { return player; }, get renderer() { return renderer; }, weather: () => weather,
  resume(n) { testLeft = n; document.title = 'running'; requestAnimationFrame(loop); },
};

boot();
