// World worker: generates chunk columns and builds their meshes.
import { WorldGen } from './worldgen.js';
import { Mesher } from './mesher.js';

let gen = null;
const mesher = new Mesher();

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    gen = new WorldGen(m.seed);
    return;
  }
  if (m.type === 'gen') {
    const c = gen.generate(m.cx, m.cz);
    self.postMessage({ type: 'gen', id: m.id, col: c },
      [c.data.buffer, c.tintG.buffer, c.tintF.buffer, c.heights.buffer, c.biomes.buffer, c.temps.buffer]);
    return;
  }
  if (m.type === 'mesh') {
    const r = mesher.build(m.cx, m.cz, m.cols, m.tintG, m.tintF, m.lod);
    r.type = 'mesh'; r.id = m.id; r.cx = m.cx; r.cz = m.cz; r.version = m.version; r.lod = m.lod;
    self.postMessage(r, [r.opaque, r.cutout, r.trans]);
  }
};
