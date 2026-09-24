// Block registry shared by the main thread and the world workers.

// Texture layers in the block texture arrays. Order defines the layer index.
export const TEX_NAMES = [
  'grass_top', 'grass_side', 'dirt', 'stone', 'cobblestone', 'sand', 'sandstone', 'sandstone_top', 'gravel',
  'oak_log', 'log_top', 'oak_leaves', 'birch_log', 'birch_leaves', 'spruce_log', 'spruce_leaves',
  'cherry_log', 'cherry_leaves', 'oak_planks', 'stone_bricks', 'bricks', 'snow', 'snow_side', 'ice', 'glass',
  'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'copper_ore', 'emerald_ore',
  'amethyst', 'glowstone', 'lava', 'deepslate', 'obsidian', 'clay', 'moss', 'mossy_cobblestone',
  'gold_block', 'copper_block', 'marble', 'terracotta', 'lamp', 'cactus_side', 'cactus_top', 'torch',
  'tall_grass', 'fern', 'poppy', 'dandelion', 'cornflower', 'daisy', 'allium', 'dead_bush', 'seagrass',
  'glow_mushroom', 'pink_petals', 'water',
];
export const T = Object.fromEntries(TEX_NAMES.map((n, i) => [n, i]));

export const B = {
  AIR: 0, STONE: 1, DIRT: 2, GRASS: 3, SAND: 4, GRAVEL: 5, SANDSTONE: 6, SNOW: 7, SNOWY_GRASS: 8, ICE: 9,
  WATER: 10, LAVA: 11, OAK_LOG: 12, BIRCH_LOG: 13, SPRUCE_LOG: 14, CHERRY_LOG: 15, OAK_LEAVES: 16,
  BIRCH_LEAVES: 17, SPRUCE_LEAVES: 18, CHERRY_LEAVES: 19, COBBLE: 20, MOSSY_COBBLE: 21, MOSS: 22, CLAY: 23,
  COAL_ORE: 24, IRON_ORE: 25, GOLD_ORE: 26, DIAMOND_ORE: 27, COPPER_ORE: 28, EMERALD_ORE: 29, AMETHYST: 30,
  GLOWSTONE: 31, GLASS: 32, PLANKS: 33, STONE_BRICKS: 34, BRICKS: 35, GOLD_BLOCK: 36, COPPER_BLOCK: 37,
  MARBLE: 38, OBSIDIAN: 39, CACTUS: 40, LAMP: 41, TORCH: 42, TERRACOTTA: 43, DEEPSLATE: 44,
  OAK_WOOD: 45, CHERRY_WOOD: 46, SPRUCE_WOOD: 47,
  TALL_GRASS: 50, FERN: 51, POPPY: 52, DANDELION: 53, CORNFLOWER: 54, DAISY: 55, ALLIUM: 56, DEAD_BUSH: 57,
  SEAGRASS: 58, GLOW_MUSHROOM: 59, PINK_PETALS: 60, SHORT_GRASS: 61,
};

// Render kinds
export const R = { NONE: 0, CUBE: 1, CUTOUT: 2, GLASSY: 3, WATER: 4, CROSS: 5, TORCH: 6, CARPET: 7, CACTUS: 8 };

const N = 64;
export const OPAQUE = new Uint8Array(N);   // full cube that hides neighbours and blocks light
export const SOLID = new Uint8Array(N);    // collides with the player
export const RENDER = new Uint8Array(N);
export const EMIT = new Uint8Array(N);     // block light emission 0..15
export const ATTEN = new Uint8Array(N);    // extra light attenuation when passing through
export const TEX_TOP = new Uint8Array(N);
export const TEX_BOTTOM = new Uint8Array(N);
export const TEX_SIDE = new Uint8Array(N);
export const TINT = new Uint8Array(N);     // 0 none, 1 grass, 2 foliage
export const WAVE = new Uint8Array(N);     // 0 none, 1 leaves, 2 plant (top verts), 3 seagrass
export const PLANT_H = new Float32Array(N); // height of cross plants in blocks
export const INFO = [];

function def(id, name, o) {
  const top = T[o.top ?? o.tex], side = T[o.side ?? o.tex], bottom = T[o.bottom ?? o.top ?? o.tex];
  TEX_TOP[id] = top; TEX_SIDE[id] = side; TEX_BOTTOM[id] = bottom;
  RENDER[id] = o.render ?? R.CUBE;
  OPAQUE[id] = RENDER[id] === R.CUBE ? 1 : 0;
  SOLID[id] = o.solid ?? (RENDER[id] === R.CUBE || RENDER[id] === R.CUTOUT || RENDER[id] === R.GLASSY || RENDER[id] === R.CACTUS ? 1 : 0);
  EMIT[id] = o.emit ?? 0;
  ATTEN[id] = o.atten ?? 0;
  TINT[id] = o.tint ?? 0;
  WAVE[id] = o.wave ?? 0;
  PLANT_H[id] = o.h ?? 1;
  INFO[id] = { id, name, sound: o.sound ?? 'stone', icon: o.icon ?? o.side ?? o.tex };
}

def(B.STONE, 'Stone', { tex: 'stone' });
def(B.DIRT, 'Dirt', { tex: 'dirt', sound: 'gravel' });
def(B.GRASS, 'Grass Block', { top: 'grass_top', side: 'grass_side', bottom: 'dirt', tint: 1, sound: 'grass' });
def(B.SAND, 'Sand', { tex: 'sand', sound: 'sand' });
def(B.GRAVEL, 'Gravel', { tex: 'gravel', sound: 'gravel' });
def(B.SANDSTONE, 'Sandstone', { top: 'sandstone_top', side: 'sandstone' });
def(B.SNOW, 'Snow', { tex: 'snow', sound: 'snow' });
def(B.SNOWY_GRASS, 'Snowy Grass', { top: 'snow', side: 'snow_side', bottom: 'dirt', sound: 'snow' });
def(B.ICE, 'Ice', { tex: 'ice', render: R.GLASSY, atten: 1, sound: 'glass' });
def(B.WATER, 'Water', { tex: 'water', render: R.WATER, solid: 0, sound: 'water' });
def(B.LAVA, 'Lava', { tex: 'lava', emit: 15, solid: 0 });
def(B.OAK_LOG, 'Oak Log', { top: 'log_top', side: 'oak_log', sound: 'wood' });
def(B.BIRCH_LOG, 'Birch Log', { top: 'log_top', side: 'birch_log', sound: 'wood' });
def(B.SPRUCE_LOG, 'Spruce Log', { top: 'log_top', side: 'spruce_log', sound: 'wood' });
def(B.CHERRY_LOG, 'Cherry Log', { top: 'log_top', side: 'cherry_log', sound: 'wood' });
def(B.OAK_WOOD, 'Oak Wood', { tex: 'oak_log', sound: 'wood' });
def(B.CHERRY_WOOD, 'Cherry Wood', { tex: 'cherry_log', sound: 'wood' });
def(B.SPRUCE_WOOD, 'Spruce Wood', { tex: 'spruce_log', sound: 'wood' });
def(B.OAK_LEAVES, 'Oak Leaves', { tex: 'oak_leaves', render: R.CUTOUT, atten: 1, tint: 2, wave: 1, sound: 'leaves' });
def(B.BIRCH_LEAVES, 'Birch Leaves', { tex: 'birch_leaves', render: R.CUTOUT, atten: 1, tint: 2, wave: 1, sound: 'leaves' });
def(B.SPRUCE_LEAVES, 'Spruce Leaves', { tex: 'spruce_leaves', render: R.CUTOUT, atten: 1, wave: 1, sound: 'leaves' });
def(B.CHERRY_LEAVES, 'Cherry Blossom', { tex: 'cherry_leaves', render: R.CUTOUT, atten: 1, wave: 1, sound: 'leaves' });
def(B.COBBLE, 'Cobblestone', { tex: 'cobblestone' });
def(B.MOSSY_COBBLE, 'Mossy Cobblestone', { tex: 'mossy_cobblestone' });
def(B.MOSS, 'Moss Block', { tex: 'moss', sound: 'grass' });
def(B.CLAY, 'Clay', { tex: 'clay', sound: 'gravel' });
def(B.COAL_ORE, 'Coal Ore', { tex: 'coal_ore' });
def(B.IRON_ORE, 'Iron Ore', { tex: 'iron_ore' });
def(B.GOLD_ORE, 'Gold Ore', { tex: 'gold_ore' });
def(B.DIAMOND_ORE, 'Diamond Ore', { tex: 'diamond_ore' });
def(B.COPPER_ORE, 'Copper Ore', { tex: 'copper_ore' });
def(B.EMERALD_ORE, 'Emerald Ore', { tex: 'emerald_ore' });
def(B.AMETHYST, 'Amethyst', { tex: 'amethyst', emit: 5, sound: 'glass' });
def(B.GLOWSTONE, 'Glowstone', { tex: 'glowstone', emit: 15, sound: 'glass' });
def(B.GLASS, 'Glass', { tex: 'glass', render: R.GLASSY, sound: 'glass' });
def(B.PLANKS, 'Oak Planks', { tex: 'oak_planks', sound: 'wood' });
def(B.STONE_BRICKS, 'Stone Bricks', { tex: 'stone_bricks' });
def(B.BRICKS, 'Bricks', { tex: 'bricks' });
def(B.GOLD_BLOCK, 'Gold Block', { tex: 'gold_block', sound: 'metal' });
def(B.COPPER_BLOCK, 'Copper Block', { tex: 'copper_block', sound: 'metal' });
def(B.MARBLE, 'Polished Marble', { tex: 'marble' });
def(B.OBSIDIAN, 'Obsidian', { tex: 'obsidian' });
def(B.CACTUS, 'Cactus', { top: 'cactus_top', side: 'cactus_side', render: R.CACTUS, sound: 'leaves' });
def(B.LAMP, 'Lantern Block', { tex: 'lamp', emit: 15, sound: 'glass' });
def(B.TORCH, 'Torch', { tex: 'torch', render: R.TORCH, emit: 14, solid: 0, sound: 'wood' });
def(B.TERRACOTTA, 'Terracotta', { tex: 'terracotta' });
def(B.DEEPSLATE, 'Deepslate', { tex: 'deepslate' });
def(B.TALL_GRASS, 'Tall Grass', { tex: 'tall_grass', render: R.CROSS, tint: 1, wave: 2, h: 1.0, sound: 'grass' });
def(B.SHORT_GRASS, 'Grass', { tex: 'tall_grass', render: R.CROSS, tint: 1, wave: 2, h: 0.62, sound: 'grass' });
def(B.FERN, 'Fern', { tex: 'fern', render: R.CROSS, tint: 1, wave: 2, h: 0.8, sound: 'grass' });
def(B.POPPY, 'Poppy', { tex: 'poppy', render: R.CROSS, wave: 2, h: 0.75, sound: 'grass' });
def(B.DANDELION, 'Dandelion', { tex: 'dandelion', render: R.CROSS, wave: 2, h: 0.7, sound: 'grass' });
def(B.CORNFLOWER, 'Cornflower', { tex: 'cornflower', render: R.CROSS, wave: 2, h: 0.8, sound: 'grass' });
def(B.DAISY, 'Oxeye Daisy', { tex: 'daisy', render: R.CROSS, wave: 2, h: 0.75, sound: 'grass' });
def(B.ALLIUM, 'Allium', { tex: 'allium', render: R.CROSS, wave: 2, h: 0.9, sound: 'grass' });
def(B.DEAD_BUSH, 'Dead Bush', { tex: 'dead_bush', render: R.CROSS, wave: 2, h: 0.8, sound: 'grass' });
def(B.SEAGRASS, 'Seagrass', { tex: 'seagrass', render: R.CROSS, wave: 3, h: 1.0, sound: 'grass' });
def(B.GLOW_MUSHROOM, 'Glow Mushroom', { tex: 'glow_mushroom', render: R.CROSS, emit: 9, h: 0.7, sound: 'grass' });
def(B.PINK_PETALS, 'Pink Petals', { tex: 'pink_petals', render: R.CARPET, sound: 'grass' });

export const HOTBAR_DEFAULT = [
  B.STONE_BRICKS, B.PLANKS, B.GLASS, B.TORCH, B.LAMP, B.MARBLE, B.COPPER_BLOCK, B.GOLD_BLOCK, B.CHERRY_LEAVES,
];

export const PALETTE = [
  B.GRASS, B.DIRT, B.STONE, B.COBBLE, B.MOSSY_COBBLE, B.STONE_BRICKS, B.BRICKS, B.DEEPSLATE, B.SAND, B.SANDSTONE,
  B.GRAVEL, B.CLAY, B.TERRACOTTA, B.SNOW, B.ICE, B.PLANKS, B.OAK_LOG, B.BIRCH_LOG, B.SPRUCE_LOG, B.CHERRY_LOG,
  B.OAK_LEAVES, B.BIRCH_LEAVES, B.SPRUCE_LEAVES, B.CHERRY_LEAVES, B.MOSS, B.GLASS, B.MARBLE, B.OBSIDIAN,
  B.GOLD_BLOCK, B.COPPER_BLOCK, B.GLOWSTONE, B.LAMP, B.TORCH, B.AMETHYST, B.WATER, B.LAVA, B.CACTUS,
  B.POPPY, B.DANDELION, B.CORNFLOWER, B.DAISY, B.ALLIUM, B.TALL_GRASS, B.FERN, B.GLOW_MUSHROOM, B.PINK_PETALS,
];

export function isPlant(id) { const r = RENDER[id]; return r === R.CROSS || r === R.CARPET || r === R.TORCH; }
