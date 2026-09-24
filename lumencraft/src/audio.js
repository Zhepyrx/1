// Procedural soundscape (WebAudio): wind, birds, crickets, rain, thunder, water, footsteps, block sounds.

export class Audio {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.volume = 0.7;
    this.birdTimer = 2; this.cricketTimer = 1;
  }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    // gentle global lowpass used for underwater muffling
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.muffle.connect(this.master);
    this.master.connect(ctx.destination);
    this.bus = this.muffle;
    // noise buffers
    const len = ctx.sampleRate * 3;
    const white = ctx.createBuffer(1, len, ctx.sampleRate);
    const pink = ctx.createBuffer(1, len, ctx.sampleRate);
    const wd = white.getChannelData(0), pd = pink.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      wd[i] = w;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      pd[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    }
    this.white = white; this.pink = pink;
    // wind bed
    this.wind = this.loop(pink, 'bandpass', 380, 0.6, 0);
    // rain bed
    this.rain = this.loop(white, 'highpass', 900, 0.3, 0);
    this.rainLow = this.loop(pink, 'lowpass', 500, 0.5, 0);
    // water lapping
    this.water = this.loop(pink, 'lowpass', 700, 0.9, 0);
    // biome beds: jungle insects, volcanic rumble, campfire roar
    this.insects = this.loop(white, 'bandpass', 5200, 3.5, 0);
    this.rumble = this.loop(pink, 'lowpass', 70, 0.7, 0);
    this.fire = this.loop(pink, 'bandpass', 900, 0.6, 0);
    this.frogTimer = 2; this.chimeTimer = 3; this.crackleTimer = 0.5;
    this.enabled = true;
  }

  loop(buf, type, freq, q, gain) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(f); f.connect(g); g.connect(this.bus);
    src.start();
    return { src, f, g };
  }

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1); }

  update(dt, s) {
    if (!this.enabled || !this.ctx) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const alt = Math.max(0, (s.altitude - 70) / 80);
    const windG = 0.05 + 0.12 * alt + 0.08 * s.rain + (s.flying ? 0.06 : 0);
    this.wind.g.gain.setTargetAtTime(s.underwater ? 0.01 : windG, now, 0.5);
    this.wind.f.frequency.setTargetAtTime(300 + 250 * Math.sin(now * 0.13) + 200 * alt, now, 0.8);
    const shelter = s.sheltered ? 0.35 : 1;
    this.rain.g.gain.setTargetAtTime(s.rain * 0.16 * shelter, now, 0.8);
    this.rainLow.g.gain.setTargetAtTime(s.rain * 0.12, now, 0.8);
    this.water.g.gain.setTargetAtTime(s.nearWater * 0.1 * (0.6 + 0.4 * Math.sin(now * 0.7)), now, 0.3);
    this.muffle.frequency.setTargetAtTime(s.underwater ? 520 : 20000, now, 0.08);
    // birds by day, crickets at night
    this.birdTimer -= dt;
    if (this.birdTimer < 0) {
      this.birdTimer = 1.5 + Math.random() * 5;
      if (s.day > 0.5 && s.rain < 0.3 && !s.underwater && s.trees) this.bird();
    }
    this.cricketTimer -= dt;
    if (this.cricketTimer < 0) {
      this.cricketTimer = 0.4 + Math.random() * 1.2;
      if (s.day < 0.35 && s.rain < 0.3 && !s.underwater && s.altitude < 120) this.cricket();
    }
    if (s.thunder) this.thunder();
    const a = s.amb ?? {};
    const quiet = s.underwater ? 0.1 : 1;
    // jungle insects pulse slowly; volcanic ground rumbles; fires roar softly
    this.insects.g.gain.setTargetAtTime((a.jungle ?? 0) * 0.018 * (0.6 + 0.4 * Math.sin(now * 2.1)) * quiet * (1 - s.rain), now, 0.4);
    this.rumble.g.gain.setTargetAtTime((a.volcanic ?? 0) * 0.35 * quiet, now, 0.6);
    this.fire.g.gain.setTargetAtTime((s.fire ?? 0) * 0.05 * (0.7 + 0.3 * Math.sin(now * 5.3)) * quiet, now, 0.15);
    // frogs in swamps (more at night)
    this.frogTimer -= dt;
    if (this.frogTimer < 0) {
      this.frogTimer = 0.8 + Math.random() * 2.5;
      if ((a.swamp ?? 0) > 0.2 && !s.underwater && Math.random() < (a.swamp ?? 0) * (0.4 + 0.6 * (1 - s.day))) this.frog();
    }
    // Lumen Grove: soft pentatonic chimes drifting through the glow at night
    this.chimeTimer -= dt;
    if (this.chimeTimer < 0) {
      this.chimeTimer = 1.2 + Math.random() * 3;
      if ((a.lumen ?? 0) > 0.2 && !s.underwater && s.day < 0.6) this.chime(a.lumen);
    }
    // crackling campfires and volcanic vents
    this.crackleTimer -= dt;
    if (this.crackleTimer < 0) {
      this.crackleTimer = 0.05 + Math.random() * 0.35;
      const c = Math.max(s.fire ?? 0, (a.volcanic ?? 0) * 0.4);
      if (c > 0.05 && Math.random() < c) this.crackle(c);
    }
  }

  frog() {
    const ctx = this.ctx, t0 = ctx.currentTime;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    const g = ctx.createGain();
    if (pan) { pan.pan.value = Math.random() * 1.6 - 0.8; g.connect(pan); pan.connect(this.bus); } else g.connect(this.bus);
    const base = 180 + Math.random() * 220;
    const n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const t = t0 + i * 0.22;
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(base * 1.3, t);
      o.frequency.exponentialRampToValueAtTime(base * 0.8, t + 0.12);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = base * 3; f.Q.value = 3;
      const og = ctx.createGain();
      og.gain.setValueAtTime(0, t);
      og.gain.linearRampToValueAtTime(0.03, t + 0.015);
      og.gain.exponentialRampToValueAtTime(0.0005, t + 0.16);
      o.connect(f); f.connect(og); og.connect(g);
      o.start(t); o.stop(t + 0.18);
    }
  }

  chime(w) {
    const ctx = this.ctx, t0 = ctx.currentTime;
    const scale = [0, 2, 4, 7, 9, 12, 14, 16];
    const f0 = 523.25 * Math.pow(2, scale[Math.floor(Math.random() * scale.length)] / 12);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.018 * w, t0 + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0003, t0 + 3.5);
    if (pan) { pan.pan.value = Math.random() * 1.4 - 0.7; g.connect(pan); pan.connect(this.bus); } else g.connect(this.bus);
    for (const [mult, amp] of [[1, 1], [2.01, 0.35], [3.02, 0.12]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f0 * mult;
      const og = ctx.createGain();
      og.gain.value = amp;
      o.connect(og); og.connect(g);
      o.start(t0); o.stop(t0 + 3.6);
    }
  }

  crackle(v) {
    const ctx = this.ctx, t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 1800 + Math.random() * 2500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.06 * v * (0.4 + Math.random()), t0);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.03 + Math.random() * 0.03);
    src.connect(f); f.connect(g); g.connect(this.bus);
    src.start(t0, Math.random() * 2); src.stop(t0 + 0.08);
  }

  bird() {
    const ctx = this.ctx, t0 = ctx.currentTime;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    const g = ctx.createGain();
    g.gain.value = 0;
    if (pan) { pan.pan.value = Math.random() * 1.6 - 0.8; g.connect(pan); pan.connect(this.bus); } else g.connect(this.bus);
    const notes = 2 + Math.floor(Math.random() * 5);
    const base = 2600 + Math.random() * 2200;
    const vol = 0.012 + Math.random() * 0.02;
    let t = t0;
    for (let i = 0; i < notes; i++) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      const f0 = base * (0.85 + Math.random() * 0.4), f1 = f0 * (0.7 + Math.random() * 0.8);
      const d = 0.05 + Math.random() * 0.12;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + d);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0, t);
      og.gain.linearRampToValueAtTime(vol, t + 0.012);
      og.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(og); og.connect(g);
      o.start(t); o.stop(t + d + 0.02);
      t += d + 0.03 + Math.random() * 0.08;
    }
    g.gain.setValueAtTime(1, t0);
  }

  cricket() {
    const ctx = this.ctx, t0 = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = 4200 + Math.random() * 900;
    const g = ctx.createGain();
    g.gain.value = 0;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    o.connect(g);
    if (pan) { pan.pan.value = Math.random() * 2 - 1; g.connect(pan); pan.connect(this.bus); } else g.connect(this.bus);
    const pulses = 3 + Math.floor(Math.random() * 4);
    const vol = 0.006 + Math.random() * 0.008;
    for (let i = 0; i < pulses; i++) {
      const t = t0 + i * 0.055;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.008);
      g.gain.linearRampToValueAtTime(0, t + 0.035);
    }
    o.start(t0); o.stop(t0 + pulses * 0.055 + 0.05);
  }

  thunder() {
    const ctx = this.ctx, t0 = ctx.currentTime + 0.4 + Math.random() * 1.8;
    const src = ctx.createBufferSource();
    src.buffer = this.pink;
    src.playbackRate.value = 0.35;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 180;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.9, t0 + 0.08);
    g.gain.exponentialRampToValueAtTime(0.3, t0 + 1.2);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 5);
    src.connect(f); f.connect(g); g.connect(this.bus);
    src.start(t0); src.stop(t0 + 5.2);
  }

  // short filtered noise burst shaped by material
  hit(material, kind = 'step', gainMul = 1) {
    if (!this.enabled || !this.ctx) return;
    const ctx = this.ctx, t0 = ctx.currentTime;
    const M = {
      grass: [1800, 0.8, 0.09, 'bandpass', this.pink],
      gravel: [1400, 0.9, 0.1, 'bandpass', this.white],
      sand: [2600, 0.6, 0.1, 'highpass', this.white],
      snow: [3200, 1.2, 0.12, 'bandpass', this.white],
      stone: [900, 2.5, 0.06, 'bandpass', this.white],
      wood: [420, 3.0, 0.08, 'bandpass', this.pink],
      leaves: [3000, 0.7, 0.12, 'bandpass', this.white],
      glass: [3800, 6.0, 0.18, 'bandpass', this.white],
      metal: [2400, 12.0, 0.25, 'bandpass', this.white],
      water: [700, 1.0, 0.25, 'lowpass', this.pink],
    };
    const [freq, q, dur0, type, buf] = M[material] ?? M.stone;
    const dur = kind === 'break' ? dur0 * 2.2 : kind === 'place' ? dur0 * 1.4 : dur0;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq * (0.85 + Math.random() * 0.3); f.Q.value = q;
    const g = ctx.createGain();
    const vol = (kind === 'step' ? 0.07 : 0.2) * gainMul;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    src.connect(f); f.connect(g); g.connect(this.bus);
    src.start(t0, Math.random() * 2); src.stop(t0 + dur + 0.05);
    if (kind !== 'step' && (material === 'stone' || material === 'wood')) {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(material === 'wood' ? 180 : 240, t0);
      o.frequency.exponentialRampToValueAtTime(70, t0 + 0.12);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.12 * gainMul, t0);
      og.gain.exponentialRampToValueAtTime(0.001, t0 + 0.14);
      o.connect(og); og.connect(this.bus);
      o.start(t0); o.stop(t0 + 0.16);
    }
  }
}
