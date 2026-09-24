// World persistence in localStorage: seed, player, time, discoveries and every block edit.
// Edits are stored per chunk column as flat [index, id, index, id, ...] arrays.

const KEY = 'lumencraft.world.v2';

export function loadSave() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (typeof s.seed !== 'number') return null;
    return s;
  } catch { return null; }
}

export function writeSave(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch { return false; }
}

export function clearSave() {
  try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}

// Serialise the world's edit map: Map<columnKey, Map<index, id>> -> { columnKey: [i, id, ...] }
export function packEdits(edits) {
  const out = {};
  for (const [k, m] of edits) {
    if (!m.size) continue;
    const arr = [];
    for (const [i, id] of m) arr.push(i, id);
    out[k] = arr;
  }
  return out;
}

export function unpackEdits(obj) {
  const edits = new Map();
  if (!obj) return edits;
  for (const k in obj) {
    const arr = obj[k], m = new Map();
    for (let i = 0; i + 1 < arr.length; i += 2) m.set(arr[i], arr[i + 1]);
    edits.set(+k, m);
  }
  return edits;
}

export function timeAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
