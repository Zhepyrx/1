# Lumencraft

A voxel sandbox you can explore and build in, rendered by a physically based real-time renderer
written from scratch in WebGL 2. There are no engine dependencies and no image assets: the world, every block
texture, the sky, the clouds and the soundscape are all generated procedurally at startup.

## Play

**Quickest:** open `Lumencraft.html` in a desktop browser (Chrome, Edge, Firefox or Safari 16+). It is a single
self-contained file.

**From source:**

```bash
cd lumencraft
npm run dev          # serves http://localhost:5173/ (no dependencies needed)
```

To rebuild the single-file version after changing the source:

```bash
npm install          # esbuild, only needed for the build
npm run build        # writes Lumencraft.html
```

### Controls

| Key | Action |
| --- | --- |
| `W A S D` | Move |
| `Space` | Jump, swim up, fly up · double-tap to toggle flight |
| `Shift` | Sprint |
| `C` | Descend while flying or swimming |
| `F` | Toggle flight |
| Mouse | Look · left-click breaks · right-click places · middle-click picks a block |
| `1`–`9`, wheel | Hotbar slot |
| `E` | Block palette |
| `T` | Pause/resume the day cycle |
| `[` `]` | Scrub time of day |
| `R` | Weather: natural → clear → rain |
| `-` `=` | Exposure compensation |
| `F1` | Hide the HUD |
| `F3` | Performance overlay (fps, GPU time, internal resolution, draw calls) |
| `M` | Mute |
| `Esc` | Pause menu and settings |

## What is being rendered

Each frame runs this pipeline (`src/renderer.js`):

1. **Atmosphere** – Hillaire-style physically based sky: transmittance and multiple-scattering LUTs, a sky-view LUT
   rebuilt every frame for the current sun and moon, and a sky irradiance map used for ambient light.
2. **Cascaded shadow maps** – four texel-snapped cascades (distant ones update every 2nd/4th frame) sampled with
   PCSS, so shadows harden near contact points and soften with distance from the caster.
3. **G-buffer** – chunk meshes from one shared vertex arena drawn with `WEBGL_multi_draw` (one draw call per page).
   Materials use parallax occlusion mapping with self-shadowing, per-block texture rotation to hide tiling, wind
   animation for leaves and plants, and rain wetness with puddles and ripples.
4. **GTAO** ambient occlusion at half resolution with a depth-aware blur.
5. **Volumetric clouds** – raymarched Perlin-Worley clouds over a curved-earth layer with multiple-scattering
   approximation and silver lining, temporally reprojected. They also cast moving shadows on the terrain.
6. **Volumetric light** – shadowed height fog and morning valley mist (god rays), a separate absorption model
   underwater.
7. **Deferred lighting** – GGX specular, foliage translucency, underwater caustics, warm torch light,
   screen-space reflections, emissive blocks, aerial perspective.
8. **Water and glass** – refraction, Beer–Lambert absorption, SSR with cloud-aware sky fallback, sun glints, shore
   foam, and Snell's window with total internal reflection when you look up from underwater.
9. **Particles** – rain streaks and splashes, snow, fireflies, sunlit pollen, falling cherry petals, block debris.
10. **Temporal upscaling** – jittered rendering at a lower internal resolution reconstructed to full resolution
    with a Catmull-Rom history, variance clipping and depth-dilated reprojection.
11. **Post** – auto-exposure with night-aware metering, energy-conserving bloom, contrast-adaptive sharpening,
    a log-domain filmic tone curve, scotopic (night vision) blue shift, vignette and grain.

### Frame rate

Dynamic resolution (on by default) measures GPU time with timer queries and moves the internal render scale
between 50% and the preset's maximum to hold your target frame rate; the temporal upscaler rebuilds detail at
full output resolution. Quality presets (Low → Ultra) set shadow resolution, cloud and fog step counts, parallax
steps, texture resolution (128 or 256 px per block) and view distance.

Distant chunks use a lighter mesh without pitch-dark cave interiors, hidden inner leaf faces and small plants.
Grass and flowers dissolve out before that boundary, so the switch isn't visible.

## World

Terrain comes from continentalness, erosion and ridged-peak noise with domain warping and carved rivers.
Thirteen biomes: ocean, beach, river, plains, flower meadow, forest, birch forest, cherry grove, taiga,
snowy taiga, desert, mountains and snowy peaks. Also spaghetti and cheese caves, lava lakes, ore veins,
amethyst geodes, glow mushrooms, and oak, birch, spruce and cherry trees, boulders, cacti and flowers.
Sky and torch light spread through the voxels in the worker threads and feed smooth per-vertex lighting.

The day lasts 24 minutes by default. Nights have a phase-correct moon, a rotating star field with the Milky Way,
aurora and fireflies. Weather cycles between clear skies and rain with thunderstorms.

## Layout

```
index.html          page shell, HUD, menus and styles
src/main.js         game loop, input, settings, HUD
src/renderer.js     render pipeline and GPU resources
src/shaders/        GLSL for every pass
src/textures.js     procedural PBR block textures (generated on the GPU)
src/world.js        chunk streaming, block edits, raycasting (main thread)
src/worker.js       world worker: generation + meshing
src/worldgen.js     terrain, biomes, caves, trees
src/mesher.js       light propagation and greedy meshing
src/meshpool.js     GPU vertex arena with multi-draw
src/player.js       movement and collision
src/audio.js        procedural soundscape
build.mjs           single-file bundler
serve.mjs           zero-dependency dev server
```
