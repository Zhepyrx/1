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
  // terrain for the newer biomes
  'red_sand', 'terracotta_white', 'terracotta_orange', 'terracotta_yellow', 'terracotta_red', 'terracotta_brown',
  'terracotta_light', 'mud', 'podzol_top', 'podzol_side', 'basalt_side', 'basalt_top', 'magma', 'ash',
  'glowmoss_top', 'glowmoss_side', 'mushroom_stem', 'glow_cap', 'packed_ice', 'blue_ice',
  'coral_pink', 'coral_orange', 'coral_blue',
  // building
  'mossy_stone_bricks', 'spruce_planks', 'cherry_planks', 'quartz_tiles', 'paper_lantern',
  'stained_amber', 'stained_rose', 'stained_azure', 'campfire_log', 'fire',
  // trees
  'maple_red', 'maple_orange', 'maple_yellow', 'jungle_log', 'jungle_leaves', 'acacia_log', 'acacia_leaves',
  'willow_leaves', 'palm_log', 'palm_leaves',
  // plants
  'leaf_litter', 'lily_pad', 'vines', 'hanging_moss', 'lavender', 'sunflower', 'cattail', 'kelp', 'coral_fan',
  'glow_fern', 'red_mushroom',
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
  RED_SAND: 62, TC_WHITE: 63, TC_ORANGE: 64, TC_YELLOW: 65, TC_RED: 66, TC_BROWN: 67, TC_LIGHT: 68,
  MUD: 69, PODZOL: 70, BASALT: 71, MAGMA: 72, ASH: 73, GLOWMOSS: 74, MUSHROOM_STEM: 75, GLOW_CAP: 76,
  PACKED_ICE: 77, BLUE_ICE: 78, CORAL_PINK: 79, CORAL_ORANGE: 80, CORAL_BLUE: 81,
  MOSSY_STONE_BRICKS: 82, SPRUCE_PLANKS: 83, CHERRY_PLANKS: 84, QUARTZ_TILES: 85, PAPER_LANTERN: 86,
  GLASS_AMBER: 87, GLASS_ROSE: 88, GLASS_AZURE: 89, CAMPFIRE: 90,
  MAPLE_RED: 91, MAPLE_ORANGE: 92, MAPLE_YELLOW: 93, JUNGLE_LOG: 94, JUNGLE_LEAVES: 95, ACACIA_LOG: 96,
  ACACIA_LEAVES: 97, WILLOW_LEAVES: 98, PALM_LOG: 99, PALM_LEAVES: 100,
  LEAF_LITTER: 101, LILY_PAD: 102, VINES: 103, HANGING_MOSS: 104, LAVENDER: 105, SUNFLOWER: 106,
  CATTAIL: 107, KELP: 108, CORAL_FAN: 109, GLOW_FERN: 110, RED_MUSHROOM: 111,
};

// Render kinds
export const R = { NONE: 0, CUBE: 1, CUTOUT: 2, GLASSY: 3, WATER: 4, CROSS: 5, TORCH: 6, CARPET: 7, CACTUS: 8, CAMPFIRE: 9 };

const N = 256;
export const OPAQUE = new Uint8Array(N);   // full cube that hides neighbours and blocks light
export const SOLID = new Uint8Array(N);    // collides with the player
export const RENDER = new Uint8Array(N);
export const EMIT = new Uint8Array(N);     // warm block light emission 0..15 (fire, lamps, lava)
export const EMIT_COOL = new Uint8Array(N); // cool block light emission 0..15 (bioluminescence, crystals)
export const ATTEN = new Uint8Array(N);    // extra light attenuation when passing through
export const TEX_TOP = new Uint8Array(N);
export const TEX_BOTTOM = new Uint8Array(N);
export const TEX_SIDE = new Uint8Array(N);
export const TINT = new Uint8Array(N);     // 0 none, 1 grass, 2 foliage, 3 water
export const WAVE = new Uint8Array(N);     // 0 none, 1 leaves, 2 plant (top verts), 3 seagrass
export const HANG = new Uint8Array(N);     // cross plant hanging from the block above (sways at the bottom)
export const WATERLOGGED = new Uint8Array(N); // plant lives under water (keeps water around it)
export const PLANT_H = new Float32Array(N); // height of cross plants in blocks
export const INFO = [];

function def(id, name, o) {
  const top = T[o.top ?? o.tex], side = T[o.side ?? o.tex], bottom = T[o.bottom ?? o.top ?? o.tex];
  TEX_TOP[id] = top; TEX_SIDE[id] = side; TEX_BOTTOM[id] = bottom;
  RENDER[id] = o.render ?? R.CUBE;
  OPAQUE[id] = RENDER[id] === R.CUBE ? 1 : 0;
  SOLID[id] = o.solid ?? (RENDER[id] === R.CUBE || RENDER[id] === R.CUTOUT || RENDER[id] === R.GLASSY || RENDER[id] === R.CACTUS ? 1 : 0);
  EMIT[id] = o.emit ?? 0;
  EMIT_COOL[id] = o.cool ?? 0;
  ATTEN[id] = o.atten ?? 0;
  TINT[id] = o.tint ?? 0;
  WAVE[id] = o.wave ?? 0;
  HANG[id] = o.hang ? 1 : 0;
  WATERLOGGED[id] = o.wet ? 1 : 0;
  PLANT_H[id] = o.h ?? 1;
  INFO[id] = { id, name, sound: o.sound ?? 'stone', icon: o.icon ?? o.side ?? o.tex, cat: o.cat ?? 'natural' };
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
def(B.WATER, 'Water', { tex: 'water', render: R.WATER, solid: 0, tint: 3, sound: 'water' });
def(B.LAVA, 'Lava', { tex: 'lava', emit: 15, solid: 0, cat: 'light' });
def(B.OAK_LOG, 'Oak Log', { top: 'log_top', side: 'oak_log', sound: 'wood', cat: 'wood' });
def(B.BIRCH_LOG, 'Birch Log', { top: 'log_top', side: 'birch_log', sound: 'wood', cat: 'wood' });
def(B.SPRUCE_LOG, 'Spruce Log', { top: 'log_top', side: 'spruce_log', sound: 'wood', cat: 'wood' });
def(B.CHERRY_LOG, 'Cherry Log', { top: 'log_top', side: 'cherry_log', sound: 'wood', cat: 'wood' });
def(B.OAK_WOOD, 'Oak Wood', { tex: 'oak_log', sound: 'wood', cat: 'wood' });
def(B.CHERRY_WOOD, 'Cherry Wood', { tex: 'cherry_log', sound: 'wood', cat: 'wood' });
def(B.SPRUCE_WOOD, 'Spruce Wood', { tex: 'spruce_log', sound: 'wood', cat: 'wood' });
def(B.OAK_LEAVES, 'Oak Leaves', { tex: 'oak_leaves', render: R.CUTOUT, atten: 1, tint: 2, wave: 1, sound: 'leaves', cat: 'plant' });
def(B.BIRCH_LEAVES, 'Birch Leaves', { tex: 'birch_leaves', render: R.CUTOUT, atten: 1, tint: 2, wave: 1, sound: 'leaves', cat: 'plant' });
def(B.SPRUCE_LEAVES, 'Spruce Leaves', { tex: 'spruce_leaves', render: R.CUTOUT, atten: 1, wave: 1, sound: 'leaves', cat: 'plant' });
def(B.CHERRY_LEAVES, 'Cherry Blossom', { tex: 'cherry_leaves', render: R.CUTOUT, atten: 1, wave: 1, sound: 'leaves', cat: 'plant' });
def(B.COBBLE, 'Cobblestone', { tex: 'cobblestone', cat: 'build' });
def(B.MOSSY_COBBLE, 'Mossy Cobblestone', { tex: 'mossy_cobblestone', cat: 'build' });
def(B.MOSS, 'Moss Block', { tex: 'moss', sound: 'grass' });
def(B.CLAY, 'Clay', { tex: 'clay', sound: 'gravel' });
def(B.COAL_ORE, 'Coal Ore', { tex: 'coal_ore', cat: 'mineral' });
def(B.IRON_ORE, 'Iron Ore', { tex: 'iron_ore', cat: 'mineral' });
def(B.GOLD_ORE, 'Gold Ore', { tex: 'gold_ore', cat: 'mineral' });
def(B.DIAMOND_ORE, 'Diamond Ore', { tex: 'diamond_ore', cat: 'mineral' });
def(B.COPPER_ORE, 'Copper Ore', { tex: 'copper_ore', cat: 'mineral' });
def(B.EMERALD_ORE, 'Emerald Ore', { tex: 'emerald_ore', cat: 'mineral' });
def(B.AMETHYST, 'Amethyst', { tex: 'amethyst', cool: 6, sound: 'glass', cat: 'mineral' });
def(B.GLOWSTONE, 'Glowstone', { tex: 'glowstone', emit: 15, sound: 'glass', cat: 'light' });
def(B.GLASS, 'Glass', { tex: 'glass', render: R.GLASSY, sound: 'glass', cat: 'build' });
def(B.PLANKS, 'Oak Planks', { tex: 'oak_planks', sound: 'wood', cat: 'build' });
def(B.STONE_BRICKS, 'Stone Bricks', { tex: 'stone_bricks', cat: 'build' });
def(B.BRICKS, 'Bricks', { tex: 'bricks', cat: 'build' });
def(B.GOLD_BLOCK, 'Gold Block', { tex: 'gold_block', sound: 'metal', cat: 'mineral' });
def(B.COPPER_BLOCK, 'Copper Block', { tex: 'copper_block', sound: 'metal', cat: 'mineral' });
def(B.MARBLE, 'Polished Marble', { tex: 'marble', cat: 'build' });
def(B.OBSIDIAN, 'Obsidian', { tex: 'obsidian', cat: 'mineral' });
def(B.CACTUS, 'Cactus', { top: 'cactus_top', side: 'cactus_side', render: R.CACTUS, sound: 'leaves', cat: 'plant' });
def(B.LAMP, 'Lantern Block', { tex: 'lamp', emit: 15, sound: 'glass', cat: 'light' });
def(B.TORCH, 'Torch', { tex: 'torch', render: R.TORCH, emit: 14, solid: 0, sound: 'wood', cat: 'light' });
def(B.TERRACOTTA, 'Terracotta', { tex: 'terracotta', cat: 'build' });
def(B.DEEPSLATE, 'Deepslate', { tex: 'deepslate' });
def(B.TALL_GRASS, 'Tall Grass', { tex: 'tall_grass', render: R.CROSS, tint: 1, wave: 2, h: 1.0, sound: 'grass', cat: 'plant' });
def(B.SHORT_GRASS, 'Grass', { tex: 'tall_grass', render: R.CROSS, tint: 1, wave: 2, h: 0.62, sound: 'grass', cat: 'plant' });
def(B.FERN, 'Fern', { tex: 'fern', render: R.CROSS, tint: 1, wave: 2, h: 0.8, sound: 'grass', cat: 'plant' });
def(B.POPPY, 'Poppy', { tex: 'poppy', render: R.CROSS, wave: 2, h: 0.75, sound: 'grass', cat: 'plant' });
def(B.DANDELION, 'Dandelion', { tex: 'dandelion', render: R.CROSS, wave: 2, h: 0.7, sound: 'grass', cat: 'plant' });
def(B.CORNFLOWER, 'Cornflower', { tex: 'cornflower', render: R.CROSS, wave: 2, h: 0.8, sound: 'grass', cat: 'plant' });
def(B.DAISY, 'Oxeye Daisy', { tex: 'daisy', render: R.CROSS, wave: 2, h: 0.75, sound: 'grass', cat: 'plant' });
def(B.ALLIUM, 'Allium', { tex: 'allium', render: R.CROSS, wave: 2, h: 0.9, sound: 'grass', cat: 'plant' });
def(B.DEAD_BUSH, 'Dead Bush', { tex: 'dead_bush', render: R.CROSS, wave: 2, h: 0.8, sound: 'grass', cat: 'plant' });
def(B.SEAGRASS, 'Seagrass', { tex: 'seagrass', render: R.CROSS, wave: 3, h: 1.0, wet: 1, sound: 'grass', cat: 'plant' });
def(B.GLOW_MUSHROOM, 'Glow Mushroom', { tex: 'glow_mushroom', render: R.CROSS, cool: 9, h: 0.7, sound: 'grass', cat: 'light' });
def(B.PINK_PETALS, 'Pink Petals', { tex: 'pink_petals', render: R.CARPET, sound: 'grass', cat: 'plant' });

// ---- newer biomes
def(B.RED_SAND, 'Red Sand', { tex: 'red_sand', sound: 'sand' });
def(B.TC_WHITE, 'White Terracotta', { tex: 'terracotta_white', cat: 'build' });
def(B.TC_ORANGE, 'Orange Terracotta', { tex: 'terracotta_orange', cat: 'build' });
def(B.TC_YELLOW, 'Ochre Terracotta', { tex: 'terracotta_yellow', cat: 'build' });
def(B.TC_RED, 'Red Terracotta', { tex: 'terracotta_red', cat: 'build' });
def(B.TC_BROWN, 'Umber Terracotta', { tex: 'terracotta_brown', cat: 'build' });
def(B.TC_LIGHT, 'Rose Terracotta', { tex: 'terracotta_light', cat: 'build' });
def(B.MUD, 'Mud', { tex: 'mud', sound: 'gravel' });
def(B.PODZOL, 'Podzol', { top: 'podzol_top', side: 'podzol_side', bottom: 'dirt', sound: 'gravel' });
def(B.BASALT, 'Basalt', { top: 'basalt_top', side: 'basalt_side', cat: 'natural' });
def(B.MAGMA, 'Magma', { tex: 'magma', emit: 11, cat: 'light' });
def(B.ASH, 'Volcanic Ash', { tex: 'ash', sound: 'sand' });
def(B.GLOWMOSS, 'Glowmoss', { top: 'glowmoss_top', side: 'glowmoss_side', bottom: 'dirt', sound: 'grass' });
def(B.MUSHROOM_STEM, 'Mushroom Stem', { tex: 'mushroom_stem', sound: 'wood', cat: 'wood' });
def(B.GLOW_CAP, 'Lumen Cap', { tex: 'glow_cap', cool: 13, sound: 'leaves', cat: 'light' });
def(B.PACKED_ICE, 'Packed Ice', { tex: 'packed_ice', sound: 'glass' });
def(B.BLUE_ICE, 'Blue Ice', { tex: 'blue_ice', sound: 'glass' });
def(B.CORAL_PINK, 'Brain Coral', { tex: 'coral_pink', sound: 'stone', cat: 'plant' });
def(B.CORAL_ORANGE, 'Fire Coral', { tex: 'coral_orange', sound: 'stone', cat: 'plant' });
def(B.CORAL_BLUE, 'Tube Coral', { tex: 'coral_blue', sound: 'stone', cat: 'plant' });
def(B.MOSSY_STONE_BRICKS, 'Mossy Stone Bricks', { tex: 'mossy_stone_bricks', cat: 'build' });
def(B.SPRUCE_PLANKS, 'Spruce Planks', { tex: 'spruce_planks', sound: 'wood', cat: 'build' });
def(B.CHERRY_PLANKS, 'Cherry Planks', { tex: 'cherry_planks', sound: 'wood', cat: 'build' });
def(B.QUARTZ_TILES, 'Quartz Tiles', { tex: 'quartz_tiles', cat: 'build' });
def(B.PAPER_LANTERN, 'Paper Lantern', { tex: 'paper_lantern', emit: 14, sound: 'wood', cat: 'light' });
def(B.GLASS_AMBER, 'Amber Glass', { tex: 'stained_amber', render: R.GLASSY, sound: 'glass', cat: 'build' });
def(B.GLASS_ROSE, 'Rose Glass', { tex: 'stained_rose', render: R.GLASSY, sound: 'glass', cat: 'build' });
def(B.GLASS_AZURE, 'Azure Glass', { tex: 'stained_azure', render: R.GLASSY, sound: 'glass', cat: 'build' });
def(B.CAMPFIRE, 'Campfire', { top: 'fire', side: 'campfire_log', render: R.CAMPFIRE, emit: 15, solid: 0, sound: 'wood', cat: 'light', icon: 'fire' });
def(B.MAPLE_RED, 'Crimson Maple Leaves', { tex: 'maple_red', render: R.CUTOUT, atten: 1, wave: 1, sound: 'leaves', cat: 'plant' });
def(B.MAPLE_ORANGE, 'Amber Maple Leaves', { tex: 'maple_orange', render: R.CUTOUT, atten: 1, wave: 1, sound: 'leaves', cat: 'plant' });
def(B.MAPLE_YELLOW, 'Golden Maple Leaves', { tex: 'maple_yellow', render: R.CUTOUT, atten: 1, wave: 1, sound: 'leaves', cat: 'plant' });
def(B.JUNGLE_LOG, 'Jungle Log', { top: 'log_top', side: 'jungle_log', sound: 'wood', cat: 'wood' });
def(B.JUNGLE_LEAVES, 'Jungle Leaves', { tex: 'jungle_leaves', render: R.CUTOUT, atten: 1, tint: 2, wave: 1, sound: 'leaves', cat: 'plant' });
def(B.ACACIA_LOG, 'Acacia Log', { top: 'log_top', side: 'acacia_log', sound: 'wood', cat: 'wood' });
def(B.ACACIA_LEAVES, 'Acacia Leaves', { tex: 'acacia_leaves', render: R.CUTOUT, atten: 1, tint: 2, wave: 1, sound: 'leaves', cat: 'plant' });
def(B.WILLOW_LEAVES, 'Willow Leaves', { tex: 'willow_leaves', render: R.CUTOUT, atten: 1, wave: 1, sound: 'leaves', cat: 'plant' });
def(B.PALM_LOG, 'Palm Log', { top: 'log_top', side: 'palm_log', sound: 'wood', cat: 'wood' });
def(B.PALM_LEAVES, 'Palm Fronds', { tex: 'palm_leaves', render: R.CUTOUT, atten: 1, tint: 2, wave: 1, sound: 'leaves', cat: 'plant' });
def(B.LEAF_LITTER, 'Leaf Litter', { tex: 'leaf_litter', render: R.CARPET, sound: 'grass', cat: 'plant' });
def(B.LILY_PAD, 'Lily Pad', { tex: 'lily_pad', render: R.CARPET, sound: 'grass', cat: 'plant' });
def(B.VINES, 'Vines', { tex: 'vines', render: R.CROSS, hang: 1, wave: 2, h: 1.0, tint: 2, sound: 'leaves', cat: 'plant' });
def(B.HANGING_MOSS, 'Hanging Moss', { tex: 'hanging_moss', render: R.CROSS, hang: 1, wave: 2, h: 1.0, sound: 'leaves', cat: 'plant' });
def(B.LAVENDER, 'Lavender', { tex: 'lavender', render: R.CROSS, wave: 2, h: 0.95, sound: 'grass', cat: 'plant' });
def(B.SUNFLOWER, 'Sunflower', { tex: 'sunflower', render: R.CROSS, wave: 2, h: 1.75, sound: 'grass', cat: 'plant' });
def(B.CATTAIL, 'Cattail', { tex: 'cattail', render: R.CROSS, wave: 2, h: 1.5, sound: 'grass', cat: 'plant' });
def(B.KELP, 'Kelp', { tex: 'kelp', render: R.CROSS, wave: 3, h: 1.0, wet: 1, sound: 'grass', cat: 'plant' });
def(B.CORAL_FAN, 'Sea Fan', { tex: 'coral_fan', render: R.CROSS, wave: 3, h: 0.85, wet: 1, sound: 'grass', cat: 'plant' });
def(B.GLOW_FERN, 'Lumen Fern', { tex: 'glow_fern', render: R.CROSS, wave: 2, h: 0.85, cool: 5, sound: 'grass', cat: 'light' });
def(B.RED_MUSHROOM, 'Red Mushroom', { tex: 'red_mushroom', render: R.CROSS, h: 0.5, sound: 'grass', cat: 'plant' });

export const HOTBAR_DEFAULT = [
  B.STONE_BRICKS, B.PLANKS, B.GLASS, B.TORCH, B.PAPER_LANTERN, B.MARBLE, B.CAMPFIRE, B.MAPLE_RED, B.CHERRY_LEAVES,
];

export const PALETTE_CATS = [
  ['build', 'Building'], ['wood', 'Wood'], ['natural', 'Natural'], ['plant', 'Plants & leaves'],
  ['light', 'Light'], ['mineral', 'Minerals'],
];

export const PALETTE = [
  B.GRASS, B.DIRT, B.PODZOL, B.MUD, B.STONE, B.DEEPSLATE, B.BASALT, B.ASH, B.SAND, B.RED_SAND, B.SANDSTONE,
  B.GRAVEL, B.CLAY, B.SNOW, B.ICE, B.PACKED_ICE, B.BLUE_ICE, B.MOSS, B.GLOWMOSS,
  B.COBBLE, B.MOSSY_COBBLE, B.STONE_BRICKS, B.MOSSY_STONE_BRICKS, B.BRICKS, B.MARBLE, B.QUARTZ_TILES,
  B.TERRACOTTA, B.TC_WHITE, B.TC_LIGHT, B.TC_YELLOW, B.TC_ORANGE, B.TC_RED, B.TC_BROWN,
  B.PLANKS, B.SPRUCE_PLANKS, B.CHERRY_PLANKS, B.GLASS, B.GLASS_AMBER, B.GLASS_ROSE, B.GLASS_AZURE,
  B.OAK_LOG, B.BIRCH_LOG, B.SPRUCE_LOG, B.CHERRY_LOG, B.JUNGLE_LOG, B.ACACIA_LOG, B.PALM_LOG, B.MUSHROOM_STEM,
  B.OAK_LEAVES, B.BIRCH_LEAVES, B.SPRUCE_LEAVES, B.CHERRY_LEAVES, B.MAPLE_RED, B.MAPLE_ORANGE, B.MAPLE_YELLOW,
  B.JUNGLE_LEAVES, B.ACACIA_LEAVES, B.WILLOW_LEAVES, B.PALM_LEAVES,
  B.TORCH, B.CAMPFIRE, B.PAPER_LANTERN, B.LAMP, B.GLOWSTONE, B.GLOW_CAP, B.MAGMA, B.LAVA, B.WATER,
  B.GOLD_BLOCK, B.COPPER_BLOCK, B.AMETHYST, B.OBSIDIAN, B.CORAL_PINK, B.CORAL_ORANGE, B.CORAL_BLUE,
  B.POPPY, B.DANDELION, B.CORNFLOWER, B.DAISY, B.ALLIUM, B.LAVENDER, B.SUNFLOWER, B.CATTAIL, B.TALL_GRASS, B.FERN,
  B.GLOW_FERN, B.GLOW_MUSHROOM, B.RED_MUSHROOM, B.PINK_PETALS, B.LEAF_LITTER, B.LILY_PAD, B.VINES, B.HANGING_MOSS,
  B.CACTUS, B.KELP, B.CORAL_FAN,
];

export function isPlant(id) { const r = RENDER[id]; return r === R.CROSS || r === R.CARPET || r === R.TORCH || r === R.CAMPFIRE; }
export function isLeaves(id) { return RENDER[id] === R.CUTOUT; }
export function isLog(id) {
  return (id >= B.OAK_LOG && id <= B.CHERRY_LOG) || (id >= B.OAK_WOOD && id <= B.SPRUCE_WOOD) ||
    id === B.JUNGLE_LOG || id === B.ACACIA_LOG || id === B.PALM_LOG || id === B.MUSHROOM_STEM;
}
