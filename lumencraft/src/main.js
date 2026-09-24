// Lumencraft bootstrap: game loop, input, settings, HUD and menus.
import { Renderer, QUALITY } from './renderer.js';
import { World } from './world.js';
import { Player } from './player.js';
import { Audio } from './audio.js';
import { computeEnvironment, Weather } from './environment.js';
import { B, INFO, RENDER, R, SOLID, TEX_TOP, TEX_SIDE, TINT, HOTBAR_DEFAULT, PALETTE, PALETTE_CATS, EMIT, EMIT_COOL } from './blocks.js';
import { BIOME_NAMES, SEA } from './worldgen.js';
import { Creatures, SPECIES } from './creatures.js';
import { MapView } from './mapview.js';
import { loadSave, writeSave, clearSave, packEdits, unpackEdits, timeAgo } from './save.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const TEST = params.has('test');

// ------------------------------------------------------------------ settings
const DEFAULTS = {
  quality: 'high', dynamicRes: true, targetFps: 60, renderScale: 0.84, renderDist: 12, fov: 74, sensitivity: 1,
  volume: 0.7, viewBob: true, dayCycle: true, dayMinutes: 24, weather: 'auto', grain: true, sharpen: 0.55, motionBlur: true, gi: true,
  creatures: true, lensFlare: true, cinematic: false,
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
let renderer, world, player, audio, weather, creatures;
const state = {
  mode: 'boot', // boot | title | play | pause
  hours: +(params.get('time') ?? 7.25),
  day: 12,
  time: 0,
  slot: 0,
  hudHidden: false,
  perf: false,
  fps: 0, frameMs: 0, gpuMs: 0, cpuMs: 0,
  selection: null,
  breakTimer: 0,
  mouse: { left: false, right: false },
  pointerLocked: false,
  dragLook: false,
  lastSpace: 0,
  cine: 0,
  evComp: 0,
  photo: null,
  home: null,
  journal: { biomes: new Set(), creatures: new Set() },
  undo: [], redo: [],
  biomeCur: -1, biomeCand: -1, biomeTimer: 0,
  focus: 10,
  capture: false,
  saveTimer: 0,
  settle: false,
};
const keys = new Set();
const debris = { data: new Float32Array(256 * 8), count: 0, list: [] };
let seed = +(params.get('seed') ?? 20260924);
let saved = TEST ? null : loadSave();
if (saved && !params.has('seed')) seed = saved.seed;
let mapView = null;
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
  try {
    await renderer.init(q, (msg) => setBoot(msg, 0.3));
  } catch (e) {
    console.error(e);
    fatal(`The renderer could not start on this GPU: ${e.message}`);
    return;
  }
  renderer.autoScale = settings.dynamicRes;
  renderer.scale = settings.dynamicRes ? renderer.budgetScale() : settings.renderScale;
  renderer.allocTargets(true);
  setBoot('Shaping the world', 0.6);
  audio = new Audio();
  audio.setVolume(settings.volume);
  weather = new Weather();
  applyWeatherSetting();
  mapView = new MapView(createWorker);
  mapView.onTravel = (x, z) => { travelTo(x, z); resume(); };
  mapView.onClose = () => {
    if (state.mode !== 'pause' || !$('pause').hidden || !$('palette').hidden) return;
    // Esc can't re-grab the pointer, so it lands on the pause menu; Tab or Close go straight back in
    if (state.mapToPause) { state.mapToPause = false; $('pause').hidden = false; showPanel('main'); } else resume();
  };
  startWorld(seed, saved);
  buildHotbar();
  buildPalette();
  bindUI();
  requestAnimationFrame(loop);
}

function startWorld(s, save = null) {
  if (world) world.destroy();
  seed = s;
  world = new World(seed, renderer.pool, createWorker);
  world.renderDist = settings.renderDist;
  if (save) world.edits = unpackEdits(save.edits);
  const origin = save?.home ?? world.findSpawn();
  spawn = params.has('pos') ? params.get('pos').split(',').map(Number) : save?.pos ? save.pos.slice() : origin;
  state.home = origin.slice();
  state.restored = !!save?.pos;
  player = new Player(world, spawn);
  player.yaw = +(params.get('yaw') ?? save?.yaw ?? 0.6);
  player.pitch = +(params.get('pitch') ?? save?.pitch ?? -0.05);
  if (save) { state.hours = save.hours ?? state.hours; state.day = save.day ?? state.day; }
  state.journal = { biomes: new Set(save?.journal?.biomes ?? []), creatures: new Set(save?.journal?.creatures ?? []) };
  state.undo = []; state.redo = [];
  state.biomeCur = -1; state.biomeCand = -1;
  if (mapView) { mapView.setSeed(seed); mapView.discovered = state.journal.biomes; }
  player.onStep = (id, sprint) => audio.hit(INFO[id]?.sound ?? 'stone', 'step', sprint ? 1.2 : 1);
  world.onBlockChanged = () => { lastSurf = null; };
  if (!creatures) creatures = new Creatures(world);
  creatures.world = world;
  creatures.clear();
  creatures.seen = state.journal.creatures;
  creatures.onSpotted = (key) => { toast(`Wildlife spotted: ${SPECIES[key].name}`); state.dirty = true; };
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
let dynTimer = 0;
let emaMs = 16;
let readyFrames = 0;
let testLeft = -1;

function loop(now) {
  if (TEST && document.title === 'ready') return;
  requestAnimationFrame(loop);
  const frameStart = performance.now();
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
        if (!params.has('pos') && !state.restored) player.pos[1] = y;
        state.mode = TEST && !params.has('title') ? 'play' : 'title';
        $('boot').classList.add('done');
        if (TEST) { $('boot').hidden = true; $('hud').hidden = params.get('hud') !== '1' || state.mode === 'title'; }
        setTimeout(() => { $('boot').hidden = true; }, 900);
        if (state.mode === 'title') showTitle();
      }
    }
    if (state.mode === 'boot') return;
  }

  // --- time & weather
  const env0Night = computeEnvironment(state.hours, state.day, player.pos[1]).night;
  if (settings.dayCycle && state.mode !== 'pause' && state.mode !== 'photo' && !TEST) {
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
  } else if (state.mode === 'photo') {
    cam = updatePhotoCamera(dt);
  } else {
    if (state.settle) settleAfterTravel();
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
  state.surfTimer = (state.surfTimer ?? 0) - dt;
  if (!lastSurf || (world.surfDirty && state.surfTimer <= 0) || Math.abs(cxr - lastSurf[0]) > 12 || Math.abs(czr - lastSurf[1]) > 12) {
    state.surfTimer = 0.5;
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
  const amb = updateAmbience(dt, cam.pos);
  if (state.mode === 'play') { updateBiomeCard(dt); autosave(dt); }
  const photo = state.mode === 'photo';
  const cine = settings.cinematic && state.mode === 'play';
  if (photo || cine) {
    const cp = Math.cos(cam.pitch);
    const fw = [Math.sin(cam.yaw) * cp, Math.sin(cam.pitch), -Math.cos(cam.yaw) * cp];
    const hit = world.raycast(cam.pos, fw, 300);
    const target = photo && !state.photo.autoFocus ? state.photo.focus : (hit ? Math.max(0.6, hit.t) : 300);
    state.focus += (target - state.focus) * (1 - Math.exp(-dt * 6));
    if (photo) state.photo.focusNow = state.focus;
  }
  // wildlife
  creatures.enabled = settings.creatures && !params.has('nocreatures');
  if (state.mode === 'play' || state.mode === 'title') creatures.update(TEST ? 1 / 60 : dt, state.mode === 'title' ? { pos: cam.pos, vel: [0, 0, 0] } : player, env, weather.rain);
  const fog = {
    haze: 0.0009 + weather.rain * 0.0025 + amb.volcanic * 0.0022 + amb.jungle * 0.0009 + amb.swamp * 0.0008,
    mist: (0.018 * morning + 0.004 * evening + 0.0025 * env.night) * (1 - weather.rain * 0.5)
      + amb.swamp * (0.012 + 0.01 * morning) + amb.lumen * (0.003 + 0.008 * env.night) + amb.jungle * 0.006 * morning,
    mistY: SEA + 7 + amb.volcanic * 20,
    tint: [1 - 0.1 * amb.lumen * env.night + 0.08 * amb.volcanic, 1 - 0.05 * amb.volcanic, 1 + 0.12 * amb.lumen * env.night - 0.12 * amb.volcanic],
  };
  const dayF = 1 - env.night;
  const noRain = 1 - weather.rain;
  const particles = [
    { kind: 0, count: Math.round(12000 * weather.rain), intensity: 1, additive: false },
    { kind: 5, count: Math.round(1500 * weather.rain), intensity: 1, additive: false },
    { kind: 1, count: Math.round(4000 * weather.rain), intensity: 1, additive: false },
    { kind: 2, count: Math.round((260 + 260 * amb.jungle) * env.night * noRain), intensity: 1, additive: true },
    { kind: 3, count: Math.round(500 * dayF * noRain), intensity: 1, additive: true },
    { kind: 4, count: 320, intensity: 1, additive: false },
    { kind: 6, count: Math.round(420 * amb.autumn), intensity: 1, additive: false },
    { kind: 7, count: Math.round(700 * amb.lumen * noRain), intensity: 1, additive: true },
    { kind: 8, count: Math.round(1400 * amb.volcanic), intensity: 1, additive: false },
    { kind: 9, count: Math.round(260 * amb.volcanic), intensity: 1, additive: true },
  ];
  // campfires near the camera send up smoke and sparks
  const emitters = [];
  for (const f of world.fires.values()) {
    const d = Math.hypot(f[0] - cam.pos[0], f[1] - cam.pos[1], f[2] - cam.pos[2]);
    if (d < 64) emitters.push([f[0], f[1], f[2], d]);
  }
  emitters.sort((a, b) => a[3] - b[3]);
  if (emitters.length) {
    const n = Math.min(4, emitters.length);
    particles.push({ kind: 10, count: 90 * n, intensity: 1, additive: false }, { kind: 11, count: 24 * n, intensity: 1, additive: true });
  }
  const flickerT = state.time;
  const flicker = 1 + 0.05 * Math.sin(flickerT * 11.3) * Math.sin(flickerT * 7.1 + 1.3) + 0.03 * Math.sin(flickerT * 23.7);
  const aurora = env.night * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(state.day * 1.7 + 0.4)));
  const cirrus = (0.35 + 0.45 * (0.5 + 0.5 * Math.sin(state.day * 2.3 + 1.1))) * (1 - weather.rain);
  // rainbows while the land is still wet after a shower, with the sun low enough for the bow to clear the horizon
  const sss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const rainbow = params.has('rainbow') ? 1 : sss(0.12, 0.35, weather.wetness) * (1 - sss(0.25, 0.55, weather.rain)) *
    sss(0.02, 0.1, env.sunDir[1]) * (1 - sss(0.55, 0.72, env.sunDir[1]));

  // --- dynamic resolution
  dynTimer += dt;
  if (settings.dynamicRes && state.mode !== 'pause' && dynTimer > 0.5 && state.mode !== 'boot') {
    // Proportional controller: pixel cost scales with scale^2. With a GPU timer we can also
    // spend spare headroom above the preset budget; without one, frame time is vsync-quantised,
    // so we only probe upward occasionally.
    dynTimer = 0;
    const target = 1000 / settings.targetFps;
    const hasTimer = state.gpuMs > 0;
    const measure = hasTimer ? state.gpuMs : emaMs;
    const base = renderer.budgetScale();
    // below 30 fps, allow a deeper resolution drop before giving up frame rate
    const lo = base * (measure > 34 ? 0.45 : 0.62), hi = hasTimer ? 1 : base;
    const ratio = target / measure;
    let sc = renderer.scale;
    state.probeTimer = (state.probeTimer ?? 0) + 0.5;
    if (ratio < 0.96) sc *= Math.sqrt(Math.max(0.45, ratio * 0.92));
    else if (hasTimer && ratio > 1.3) sc *= Math.min(1.1, Math.sqrt(ratio * 0.85));
    else if (!hasTimer && ratio > 0.98 && state.probeTimer > 8) { sc += 0.04; state.probeTimer = 0; }
    renderer.setScale(Math.min(hi, Math.max(lo, sc)));
  }

  const S = {
    cam, env, weather, time: state.time, dt, renderDist: settings.renderDist, chunks: world.renderList, water: amb.water, emitters,
    wind: 1 + weather.rain * 1.2, flicker, fog, underwater, aurora, cirrus, rainbow,
    post: {
      bloom: 0.09, sharpen: settings.sharpen, vignette: photo || cine ? 0.3 : 0.22, grain: settings.grain ? 0.035 : 0, saturation: 1.08, contrast: 1.0,
      motionBlur: settings.motionBlur && !TEST && !photo ? 0.45 : 0, flare: settings.lensFlare ? 1 : 0,
      letterbox: photo ? (state.photo.letterbox ? 1 : 0) : cine ? 1 : 0, chroma: photo || cine ? 1 : 0,
    },
    dof: { on: photo ? state.photo.aperture > 0.001 : cine, focus: state.focus, aperture: photo ? state.photo.aperture : 0.045, maxCoC: photo ? 16 : 8 },
    gi: settings.gi ? 1.0 : 0,
    evComp: state.evComp + (underwater ? 0.3 : 0), particles, debris, selection: state.hudHidden ? null : state.selection,
    creatures: buildCreatures(cam),
    debug: +(params.get('dbg') ?? 0),
    plantFade: world.detailRadius * 32,
  };
  renderer.profiling = state.perf || params.has('profile');
  renderer.render(S);
  if (state.capture) { state.capture = false; captureScreenshot(); }
  state.gpuMs = renderer.gpuMs;
  state.cpuMs += (performance.now() - frameStart - state.cpuMs) * 0.1;

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
    state.fireT = (state.fireT ?? 0) - dt;
    if (state.fireT <= 0) {
      state.fireT = 0.5;
      state.fireNear = 0;
      for (let dz = -5; dz <= 5 && !state.fireNear; dz++) for (let dx = -5; dx <= 5 && !state.fireNear; dx++) for (let dy = -2; dy <= 2; dy++) {
        if (world.getBlock(ex + dx, Math.floor(cam.pos[1]) + dy, ez + dz) === B.CAMPFIRE) { state.fireNear = 1 / (1 + Math.hypot(dx, dz) * 0.4); break; }
      }
    }
    audio.update(dt, {
      altitude: cam.pos[1], rain: weather.rain, underwater, flying: player.flying, day: dayF, sheltered, nearWater, amb, fire: state.fireNear,
      trees: [2, 3, 4, 5, 6, 12, 13, 14, 15, 17, 22].includes(biome), thunder: weather.thunder > 0,
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

// ------------------------------------------------------------------ biome ambience
// Weights of the biomes around the camera, eased over a few seconds so fog, particles, sound and
// underwater colour cross-fade as you travel instead of switching at a border.
const ambience = { t: 0, target: null, autumn: 0, lumen: 0, volcanic: 0, swamp: 0, jungle: 0, cold: 0, water: null, biome: -1 };
const AMB_KEYS = { autumn: [13], lumen: [18], volcanic: [19], swamp: [17], jungle: [14], cold: [7, 23, 10] };
function updateAmbience(dt, pos) {
  ambience.t -= dt;
  if (ambience.t <= 0 || !ambience.target) {
    ambience.t = 0.3;
    const tgt = { autumn: 0, lumen: 0, volcanic: 0, swamp: 0, jungle: 0, cold: 0 };
    let n = 0;
    for (let k = 0; k < 9; k++) {
      const a = k / 8 * Math.PI * 2, r = k === 8 ? 0 : 28;
      const b = world.biomeAt(Math.floor(pos[0] + Math.cos(a) * r), Math.floor(pos[2] + Math.sin(a) * r));
      if (b < 0) continue;
      n++;
      for (const key in AMB_KEYS) if (AMB_KEYS[key].includes(b)) tgt[key]++;
    }
    for (const key in tgt) tgt[key] = n ? tgt[key] / n : 0;
    ambience.target = tgt;
    ambience.biome = world.biomeAt(Math.floor(pos[0]), Math.floor(pos[2]));
    // the water the camera would be swimming in
    const s = world.gen.sample(Math.floor(pos[0]), Math.floor(pos[2]));
    const [murk, trop] = world.gen.waterParams(s);
    const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
    ambience.water = {
      sa: mix(mix([0.30, 0.052, 0.028], [0.46, 0.26, 0.42], murk), [0.2, 0.03, 0.024], trop),
      ss: 0.012 + (0.06 - 0.012) * murk + (0.016 - (0.012 + (0.06 - 0.012) * murk)) * trop,
    };
  }
  const k = 1 - Math.exp(-dt / 2.5);
  for (const key in ambience.target) ambience[key] += (ambience.target[key] - ambience[key]) * k;
  return ambience;
}

// Instance data for the creatures in view (sphere test against the camera frustum).
function buildCreatures(cam) {
  if (!creatures.enabled || !creatures.list.length) return null;
  const cp = Math.cos(cam.pitch);
  const f = [Math.sin(cam.yaw) * cp, Math.sin(cam.pitch), -Math.cos(cam.yaw) * cp];
  const cosHalf = Math.cos(Math.min(Math.PI * 0.49, cam.fov * 0.5 * Math.max(1, canvas.width / canvas.height) + 0.2));
  const test = (rel, rad) => {
    const d = Math.hypot(rel[0], rel[1], rel[2]);
    if (d < rad + 1) return true;
    const c = (rel[0] * f[0] + rel[1] * f[1] + rel[2] * f[2]) / d;
    return c > cosHalf - rad / d;
  };
  creatures.build(cam.pos, null, test);
  return { data: creatures.instanceData, count: creatures.count, shadowCount: creatures.shadowCount };
}

// ------------------------------------------------------------------ travel, discovery, saving
function travelTo(x, z) {
  const s = world.gen.sample(Math.floor(x), Math.floor(z));
  player.pos = [Math.floor(x) + 0.5, Math.max(s.h, SEA) + 2, Math.floor(z) + 0.5];
  player.vel = [0, 0, 0];
  player.flying = false;
  state.settle = true;
  renderer.historyValid = false;
  creatures.clear();
  lastSurf = null;
  toast(`Travelling to ${BIOME_NAMES[s.biome] ?? 'the unknown'}…`);
}

// After a jump across the map, drop the player onto the real ground (trees included) once it has loaded.
function settleAfterTravel() {
  const fx = Math.floor(player.pos[0]), fz = Math.floor(player.pos[2]);
  const col = world.column(fx >> 5, fz >> 5);
  if (!col || !col.data || col.state !== 'ready') return;
  let y = Math.min(250, col.alloc + 1);
  while (y > 1 && !world.isSolid(fx, y - 1, fz)) y--;
  if (world.getBlock(fx, y - 1, fz) === B.WATER) y++;
  player.pos[1] = y + 0.01;
  player.vel = [0, 0, 0];
  state.settle = false;
}

function updateBiomeCard(dt) {
  state.biomeTimer -= dt;
  if (state.biomeTimer > 0) return;
  state.biomeTimer = 0.4;
  const b = world.biomeAt(Math.floor(player.pos[0]), Math.floor(player.pos[2]));
  if (b < 0 || b === state.biomeCur) { state.biomeCand = b; state.biomeStable = 0; return; }
  if (b !== state.biomeCand) { state.biomeCand = b; state.biomeStable = 0; return; }
  state.biomeStable = (state.biomeStable ?? 0) + 0.4;
  if (state.biomeStable < 1.6) return;
  state.biomeCur = b;
  const first = !state.journal.biomes.has(b);
  state.journal.biomes.add(b);
  if (first) state.dirty = true;
  const now = performance.now();
  state.titleSeen = state.titleSeen ?? {};
  if (!first && now - (state.titleSeen[b] ?? -1e9) < 60000) return;
  state.titleSeen[b] = now;
  showBiomeTitle(BIOME_NAMES[b], first);
}

function showBiomeTitle(name, first) {
  const el = $('biome-title');
  el.querySelector('.kicker').textContent = first ? 'New discovery' : '';
  el.querySelector('h2').textContent = name;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 4200);
}

function saveWorld() {
  if (TEST || !world || !player) return;
  const ok = writeSave({
    seed, savedAt: Date.now(), pos: player.pos.slice(), yaw: player.yaw, pitch: player.pitch,
    hours: state.hours, day: state.day, home: state.home,
    journal: { biomes: [...state.journal.biomes], creatures: [...state.journal.creatures] },
    edits: packEdits(world.edits),
  });
  state.dirty = false;
  const el = $('save-status');
  if (el) el.textContent = ok ? 'Your world, edits and discoveries are saved in this browser.' : 'This browser is not letting Lumencraft save, so progress will be lost when the page closes.';
}

function autosave(dt) {
  state.saveTimer += dt;
  if (state.saveTimer < 20) return;
  state.saveTimer = 0;
  saveWorld();
}
window.addEventListener('pagehide', () => { if (state.mode !== 'boot' && state.mode !== 'title') saveWorld(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && (state.mode === 'play' || state.mode === 'pause')) saveWorld(); });

// Inside the claude.ai artifact viewer, files are offered through the platform's downloads capability
// (the viewer confirms the save); as a standalone page a plain download link works.
const downloadsCap = window.claude?.use ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);
function captureScreenshot() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  const filename = `lumencraft-${stamp}.png`;
  canvas.toBlob(async (blob) => {
    if (!blob) { toast('The screenshot could not be captured'); return; }
    const downloads = await downloadsCap;
    if (downloads) {
      try {
        await downloads.save({ filename, data: blob });
        toast('Screenshot saved');
      } catch (err) {
        const code = err?.code;
        toast(code === 'declined' ? 'Screenshot not saved' : code === 'rate_limited' ? 'A save is already waiting for your answer' : 'Screenshots can\'t be saved in this view');
      }
      return;
    }
    if (window.claude?.use) { toast('Screenshots can\'t be saved in this view'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Screenshot saved to your downloads');
  }, 'image/png');
}

// ------------------------------------------------------------------ photo mode
function enterPhoto() {
  const e = player.eye(false);
  state.photo = { pos: e, yaw: player.yaw, pitch: player.pitch, vel: [0, 0, 0], fov: settings.fov, aperture: 0.09, autoFocus: true, focus: 10, letterbox: true };
  state.mode = 'photo';
  keys.clear();
  $('hud').hidden = true;
  $('photo').hidden = false;
  updatePhotoStatus();
}
function exitPhoto() {
  if (state.mode !== 'photo') return;
  state.mode = 'play';
  $('photo').hidden = true;
  $('hud').hidden = false;
  keys.clear();
}
function updatePhotoStatus() {
  const p = state.photo;
  if (!p) return;
  const f = p.autoFocus ? 'auto' : `${p.focus.toFixed(1)} m`;
  $('photo-status').textContent = `f/${(0.9 / Math.max(p.aperture, 0.001)).toFixed(1)} · focus ${f} · ${p.fov}° · ${fmtTime(state.hours)}${p.letterbox ? ' · 2.39:1' : ''}`;
}
function updatePhotoCamera(dt) {
  const p = state.photo;
  const cp = Math.cos(p.pitch);
  const f = [Math.sin(p.yaw) * cp, Math.sin(p.pitch), -Math.cos(p.yaw) * cp];
  const r = [Math.cos(p.yaw), 0, Math.sin(p.yaw)];
  const want = [0, 0, 0];
  const add = (v, k) => { want[0] += v[0] * k; want[1] += v[1] * k; want[2] += v[2] * k; };
  if (keys.has('KeyW')) add(f, 1);
  if (keys.has('KeyS')) add(f, -1);
  if (keys.has('KeyD')) add(r, 1);
  if (keys.has('KeyA')) add(r, -1);
  if (keys.has('Space')) add([0, 1, 0], 1);
  if (keys.has('KeyC') || keys.has('ControlLeft')) add([0, 1, 0], -1);
  const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 22 : 5;
  const k = 1 - Math.exp(-dt * 5);
  for (let i = 0; i < 3; i++) { p.vel[i] += (want[i] * speed - p.vel[i]) * k; p.pos[i] += p.vel[i] * dt; }
  world.update(p.pos[0], p.pos[2], f[0], f[2]);
  state.selection = null;
  if ((state.photoT = (state.photoT ?? 0) + dt) > 0.25) { state.photoT = 0; updatePhotoStatus(); }
  return { pos: p.pos.slice(), yaw: p.yaw, pitch: p.pitch, fov: p.fov * Math.PI / 180 };
}

// ------------------------------------------------------------------ atlas & journal
function openMap() {
  const wasPlay = state.mode === 'play';
  state.mode = 'pause';
  keys.clear();
  state.mouse.left = state.mouse.right = false;
  state.mapFromPlay = wasPlay;
  if (document.pointerLockElement) { state.paletteOpening = true; document.exitPointerLock(); }
  $('pause').hidden = true;
  mapView.discovered = state.journal.biomes;
  mapView.show(player.pos, player.yaw, state.home);
}

function openJournal() {
  if (state.mode === 'play') {
    state.mode = 'pause';
    keys.clear();
    if (document.pointerLockElement) { state.paletteOpening = true; document.exitPointerLock(); }
  }
  $('pause').hidden = false;
  showPanel('journal');
  const jb = $('j-biomes'), jc = $('j-creatures');
  jb.innerHTML = ''; jc.innerHTML = '';
  BIOME_NAMES.forEach((n, b) => { const el = document.createElement('span'); el.textContent = n; if (state.journal.biomes.has(b)) el.className = 'found'; jb.appendChild(el); });
  Object.entries(SPECIES).forEach(([k, sp]) => { const el = document.createElement('span'); el.textContent = sp.name; if (state.journal.creatures.has(k)) el.className = 'found'; jc.appendChild(el); });
  $('j-biome-count').textContent = `${state.journal.biomes.size} / ${BIOME_NAMES.length}`;
  $('j-creature-count').textContent = `${state.journal.creatures.size} / ${Object.keys(SPECIES).length}`;
}

function newWorld(text) {
  let s = (Math.random() * 1e9) | 0;
  const t = (text ?? '').trim();
  if (t) {
    if (/^-?\d+$/.test(t)) s = parseInt(t, 10) | 0;
    else { s = 0; for (const ch of t) s = (Math.imul(s, 31) + ch.charCodeAt(0)) | 0; }
  }
  clearSave();
  saved = null;
  startWorld(s, null);
  state.mode = 'boot';
  readyFrames = 0;
  $('pause').hidden = true;
  $('pause').classList.remove('from-title');
  $('title').hidden = true;
  $('boot').hidden = false;
  $('boot').classList.remove('done');
  toast(`New world · seed ${s}`);
}

// ------------------------------------------------------------------ undo / redo
function recordEdit(changes) {
  if (!changes.length) return;
  state.undo.push(changes);
  if (state.undo.length > 256) state.undo.shift();
  state.redo.length = 0;
  state.dirty = true;
}
function applyChanges(changes, forward) {
  const list = forward ? changes : changes.slice().reverse();
  for (const c of list) world.setBlock(c.x, c.y, c.z, forward ? c.next : c.prev);
}
function undo() {
  const c = state.undo.pop();
  if (!c) { toast('Nothing to undo'); return; }
  applyChanges(c, false); state.redo.push(c);
  toast(`Undone · ${state.undo.length} left`);
}
function redo() {
  const c = state.redo.pop();
  if (!c) { toast('Nothing to redo'); return; }
  applyChanges(c, true); state.undo.push(c);
  toast('Redone');
}

// ------------------------------------------------------------------ interaction
function breakBlock(hit) {
  const [x, y, z] = hit.pos;
  const id = hit.id;
  if (y <= 0) return;
  // plants on top of a broken block fall with it
  if (world.setBlock(x, y, z, 0)) {
    const changes = [{ x, y, z, prev: id, next: 0 }];
    const above = world.getBlock(x, y + 1, z);
    if (above > 0 && (RENDER[above] === R.CROSS || RENDER[above] === R.CARPET || RENDER[above] === R.TORCH || RENDER[above] === R.CAMPFIRE)) {
      world.setBlock(x, y + 1, z, 0);
      changes.push({ x, y: y + 1, z, prev: above, next: 0 });
    }
    recordEdit(changes);
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
  if ((RENDER[id] === R.CROSS || RENDER[id] === R.CARPET || RENDER[id] === R.TORCH || RENDER[id] === R.CAMPFIRE) && !world.isSolid(px, py - 1, pz) && id !== B.LILY_PAD && id !== B.VINES && id !== B.HANGING_MOSS) return;
  if (world.setBlock(px, py, pz, id)) {
    recordEdit([{ x: px, y: py, z: pz, prev: cur, next: id }]);
    audio.hit(INFO[id]?.sound ?? 'stone', 'place');
  }
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
  if (state.mode === 'photo') {
    keys.add(e.code);
    if (e.repeat) return;
    const p = state.photo;
    if (e.code === 'KeyP' || e.code === 'Escape') exitPhoto();
    if (e.code === 'KeyL') p.letterbox = !p.letterbox;
    if (e.code === 'KeyZ') p.fov = Math.max(15, p.fov - 5);
    if (e.code === 'KeyX') p.fov = Math.min(110, p.fov + 5);
    if (e.code === 'KeyF') { p.autoFocus = !p.autoFocus; p.focus = state.focus; toast(p.autoFocus ? 'Autofocus on' : 'Manual focus'); }
    if (e.code === 'F2') state.capture = true;
    if (e.code === 'Equal') state.evComp = Math.min(2, state.evComp + 0.25);
    if (e.code === 'Minus') state.evComp = Math.max(-2, state.evComp - 0.25);
    updatePhotoStatus();
    return;
  }
  if (state.mode !== 'play') {
    if (!$('map').hidden && (e.code === 'Escape' || e.code === 'Tab' || e.code === 'KeyM')) { state.mapToPause = e.code === 'Escape'; mapView.hide(); return; }
    if (e.code === 'Escape' && state.mode === 'pause' && !$('palette').hidden) { closePalette(); }
    if (e.code === 'Enter' && state.mode === 'title') (saved ? continueWorld : enterWorld)();
    return;
  }
  keys.add(e.code);
  if (e.repeat) return;
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); keys.delete(e.code); return; }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') { e.preventDefault(); redo(); keys.delete(e.code); return; }
  if (e.code === 'Tab') { openMap(); return; }
  if (e.code === 'KeyP') { enterPhoto(); return; }
  if (e.code === 'F2') { state.capture = true; }
  if (e.code === 'KeyJ') { openJournal(); return; }
  if (e.code === 'KeyH') {
    if (e.shiftKey) { state.home = player.pos.slice(); state.dirty = true; toast('Home set here'); }
    else { travelTo(state.home[0], state.home[2]); }
  }
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
  if (e.code === 'F3') { state.perf = !state.perf; $('perf').hidden = !state.perf; }
  if (e.code === 'KeyE') { openPalette(); }
  if (e.code === 'KeyM') { settings.volume = settings.volume > 0 ? 0 : 0.7; audio.setVolume(settings.volume); saveSettings(); syncSettingsUI(); toast(settings.volume ? 'Sound on' : 'Muted'); }
  if (e.code === 'Equal') { state.evComp = Math.min(2, state.evComp + 0.25); toast(`Exposure ${state.evComp >= 0 ? '+' : ''}${state.evComp.toFixed(2)} EV`); }
  if (e.code === 'Minus') { state.evComp = Math.max(-2, state.evComp - 0.25); toast(`Exposure ${state.evComp >= 0 ? '+' : ''}${state.evComp.toFixed(2)} EV`); }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

canvas.addEventListener('mousedown', (e) => {
  if (state.mode === 'photo') { if (!state.pointerLocked && !state.dragLook) lockPointer(); if (state.dragLook) state.dragging = true; return; }
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
  if (state.mode === 'photo') {
    if (!(state.pointerLocked || (state.dragLook && state.dragging))) return;
    const s = 0.0016 * settings.sensitivity * state.photo.fov / 74;
    state.photo.yaw += e.movementX * s;
    state.photo.pitch = Math.max(-1.55, Math.min(1.55, state.photo.pitch - e.movementY * s));
    return;
  }
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
  if (state.mode === 'photo') {
    const p = state.photo;
    if (e.altKey) p.aperture = Math.min(0.4, Math.max(0, p.aperture * (e.deltaY > 0 ? 0.85 : 1.18) + (e.deltaY < 0 && p.aperture < 0.005 ? 0.01 : 0)));
    else { p.autoFocus = false; p.focus = Math.min(400, Math.max(0.5, (p.focus || state.focus) * (e.deltaY > 0 ? 1.12 : 0.89))); }
    updatePhotoStatus();
    return;
  }
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
  if (!state.pointerLocked && state.mode === 'photo' && !state.dragLook) { exitPhoto(); pause(); return; }
  if (!state.pointerLocked && state.mode === 'play' && !state.dragLook) pause();
});
document.addEventListener('pointerlockerror', () => enableDragLook());

// ------------------------------------------------------------------ modes
function showTitle() {
  $('title').hidden = false;
  $('hud').hidden = true;
  const has = !!saved && saved.seed === seed;
  $('btn-continue').hidden = !has;
  $('btn-enter').hidden = has;
  const note = $('save-note');
  note.hidden = !has;
  if (has) {
    const edits = Object.values(saved.edits ?? {}).reduce((a, v) => a + v.length / 2, 0);
    note.textContent = `Saved world · seed ${saved.seed} · ${edits} block${edits === 1 ? '' : 's'} changed · ${saved.journal?.biomes?.length ?? 0} biome${(saved.journal?.biomes?.length ?? 0) === 1 ? '' : 's'} found · ${timeAgo(saved.savedAt ?? Date.now())}`;
  }
}
function continueWorld() { enterWorld(); }
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
  if (state.mode === 'play') saveWorld();
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
  if (RENDER[id] === R.TORCH) {
    g.fillStyle = '#6b4a2b';
    g.fillRect(28 * s, 26 * s, 8 * s, 32 * s);
    g.fillStyle = '#4a321d';
    g.fillRect(32 * s, 26 * s, 4 * s, 32 * s);
    const fl = g.createRadialGradient(32 * s, 20 * s, 1, 32 * s, 20 * s, 14 * s);
    fl.addColorStop(0, 'rgba(255,250,220,1)'); fl.addColorStop(0.35, 'rgba(255,200,90,0.95)'); fl.addColorStop(1, 'rgba(255,120,20,0)');
    g.fillStyle = fl;
    g.beginPath(); g.ellipse(32 * s, 18 * s, 9 * s, 13 * s, 0, 0, Math.PI * 2); g.fill();
  } else if (RENDER[id] === R.CAMPFIRE) {
    g.fillStyle = '#4a3220';
    g.save(); g.translate(32 * s, 50 * s);
    for (const a of [-0.35, 0.35]) { g.save(); g.rotate(a); g.fillRect(-22 * s, -4 * s, 44 * s, 8 * s); g.restore(); }
    g.restore();
    const { tc } = texCanvas(TEX_TOP[id], null);
    g.drawImage(tc, 12 * s, 4 * s, 40 * s, 44 * s);
  } else if (RENDER[id] === R.CROSS || RENDER[id] === R.CARPET) {
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

let palCat = 'all';
function buildPaletteTabs() {
  const tabs = $('palette-tabs');
  tabs.innerHTML = '';
  for (const [key, label] of [['all', 'All'], ...PALETTE_CATS]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('aria-pressed', String(key === palCat));
    b.addEventListener('click', () => { palCat = key; buildPaletteTabs(); buildPalette(); });
    tabs.appendChild(b);
  }
}
function buildPalette() {
  const grid = $('palette-grid');
  grid.innerHTML = '';
  const q = ($('palette-search').value || '').trim().toLowerCase();
  for (const id of PALETTE) {
    if (palCat !== 'all' && INFO[id].cat !== palCat) continue;
    if (q && !INFO[id].name.toLowerCase().includes(q)) continue;
    const el = document.createElement('button');
    el.className = 'pal-item';
    el.title = INFO[id].name;
    const img = new Image(); img.src = blockIcon(id); img.alt = '';
    el.appendChild(img);
    const lbl = document.createElement('span'); lbl.textContent = INFO[id].name; el.appendChild(lbl);
    if (EMIT[id] || EMIT_COOL[id]) el.classList.add('glow');
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
  setTimeout(() => $('palette-search').focus(), 30);
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
  const bh = world.biomeAt(Math.floor(player.pos[0]), Math.floor(player.pos[2]));
  $('biome-chip').textContent = BIOME_NAMES[bh] ?? '';
  if (state.perf) {
    const p = player.pos;
    const biome = world.biomeAt(Math.floor(p[0]), Math.floor(p[2]));
    const lines = [
      `${state.fps.toFixed(0)} fps   ${state.frameMs.toFixed(1)} ms frame   ${state.gpuMs ? state.gpuMs.toFixed(1) + ' ms GPU' : 'GPU timer n/a'}   ${state.cpuMs.toFixed(1)} ms CPU`,
      `internal ${renderer.inW}×${renderer.inH} (${Math.round(renderer.scale * 100)}%) → ${renderer.outW}×${renderer.outH}  ${renderer.q.name}`,
      `draw calls ${renderer.stats.calls}   triangles ${(renderer.stats.tris / 1e6).toFixed(2)} M`,
      `chunks ${world.renderList.length} meshed · ${world.stats.pending} queued · ${world.workers.length} workers`,
      `xyz ${p[0].toFixed(1)} ${p[1].toFixed(1)} ${p[2].toFixed(1)}   ${BIOME_NAMES[biome] ?? '—'}`,
      `sun ${(Math.asin(env.sunDir[1]) * 180 / Math.PI).toFixed(1)}°   moon phase ${(env.phase * 100).toFixed(0)}%   rain ${(w.rain * 100).toFixed(0)}%   wet ${(w.wetness * 100).toFixed(0)}%`,
    ];
    const pm = Object.entries(renderer.passMs).sort((a, b) => b[1] - a[1]);
    if (pm.length) {
      lines.push('');
      for (let i = 0; i < pm.length; i += 3) lines.push(pm.slice(i, i + 3).map(([k, v]) => `${k.padEnd(11)}${v.toFixed(2).padStart(6)} ms`).join('   '));
    }
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
  set('s-mblur', settings.motionBlur);
  set('s-gi', settings.gi);
  set('s-flare', settings.lensFlare);
  set('s-cine', settings.cinematic);
  set('s-creatures', settings.creatures);
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
  if (settings.dynamicRes) renderer.setScale(renderer.budgetScale());
  iconCache.clear();
  buildHotbar(); buildPalette();
  saveSettings();
  syncSettingsUI();
}

function bindUI() {
  $('btn-enter').addEventListener('click', enterWorld);
  $('btn-continue').addEventListener('click', continueWorld);
  $('btn-title-new').addEventListener('click', () => { $('pause').hidden = false; showPanel('newworld'); $('pause').classList.add('from-title'); setTimeout(() => $('nw-seed').focus(), 30); });
  $('btn-map').addEventListener('click', () => { $('pause').hidden = true; mapView.discovered = state.journal.biomes; mapView.show(player.pos, player.yaw, state.home); });
  $('btn-journal').addEventListener('click', openJournal);
  $('btn-photo').addEventListener('click', () => { $('pause').hidden = true; enterPhoto(); lockPointer(); });
  $('nw-create').addEventListener('click', () => newWorld($('nw-seed').value));
  $('nw-seed').addEventListener('keydown', (e) => { if (e.code === 'Enter') newWorld($('nw-seed').value); });
  $('palette-search').addEventListener('input', buildPalette);
  $('s-flare').addEventListener('change', (e) => { settings.lensFlare = e.target.checked; saveSettings(); });
  $('s-cine').addEventListener('change', (e) => { settings.cinematic = e.target.checked; saveSettings(); });
  $('s-creatures').addEventListener('change', (e) => { settings.creatures = e.target.checked; saveSettings(); });
  buildPaletteTabs();
  $('btn-title-settings').addEventListener('click', () => { $('pause').hidden = false; showPanel('settings'); $('pause').classList.add('from-title'); });
  $('btn-resume').addEventListener('click', resume);
  $('btn-settings').addEventListener('click', () => showPanel('settings'));
  $('btn-controls').addEventListener('click', () => showPanel('controls'));
  $('btn-newworld').addEventListener('click', () => { showPanel('newworld'); setTimeout(() => $('nw-seed').focus(), 30); });
  for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', () => {
    if ($('pause').classList.contains('from-title')) { $('pause').hidden = true; $('pause').classList.remove('from-title'); return; }
    showPanel('main');
  });
  document.querySelectorAll('.quality-pick button').forEach((b) => b.addEventListener('click', () => setQuality(b.dataset.q)));
  $('s-quality').addEventListener('change', (e) => setQuality(e.target.value));
  $('s-dynres').addEventListener('change', (e) => {
    settings.dynamicRes = e.target.checked;
    renderer.autoScale = settings.dynamicRes;
    renderer.setScale(settings.dynamicRes ? renderer.budgetScale() : settings.renderScale);
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
  $('s-mblur').addEventListener('change', (e) => { settings.motionBlur = e.target.checked; saveSettings(); });
  $('s-gi').addEventListener('change', (e) => { settings.gi = e.target.checked; saveSettings(); });
  $('s-sharpen').addEventListener('input', (e) => { settings.sharpen = +e.target.value / 100; saveSettings(); syncSettingsUI(); });
  $('s-time').addEventListener('input', (e) => { state.hours = +e.target.value; syncSettingsUI(); });
  $('palette-close').addEventListener('click', () => closePalette());
  syncSettingsUI();
}

// expose a tiny debug surface for automated screenshots
window.__lumencraft = {
  state, settings, get world() { return world; }, get player() { return player; }, get renderer() { return renderer; }, weather: () => weather,
  get creatures() { return creatures; }, SPECIES,
  spawn(key, n = 3, dist = 7) { const e = player.eye(false); creatures.spawnNear(key, e, player.forward(), n, dist); },
  enterPhoto, exitPhoto, openMap, openJournal, travelTo, undo, redo, get mapView() { return mapView; },
  resume(n) { testLeft = n; document.title = 'running'; requestAnimationFrame(loop); },
};

boot();
