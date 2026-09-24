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
| `F3` | Performance overlay (fps, GPU time, internal resolution, draw calls, the most expensive passes) |
| `M` | Mute |
| `Esc` | Pause menu and settings |

## What is being rendered

Each frame runs this pipeline (`src/renderer.js`):

1. **Atmosphere** – Hillaire-style physically based sky: transmittance and multiple-scattering LUTs, a sky-view LUT
   rebuilt every frame for the current sun and moon, and a sky irradiance map used for ambient light.
2. **Volumetric clouds** – Perlin-Worley cumulus over a curved-earth layer plus a high cirrus deck, with
   four-octave multiple scattering, powder and silver lining. Clouds are infinitely far away compared with the
   camera's movement, so they are raymarched into a sky panorama instead of per pixel: each frame refreshes one
   pixel in 16 (a Bayer pattern), so the whole sky is refreshed every 16 frames. Rays march coarsely
   through empty air and switch to fine steps inside a cloud. The Milky Way and aurora are baked into the same pass.
   A separate top-down cloud shadow map lets the terrain, the fog and the water look up cloud cover with one
   texture read.
3. **Cascaded shadow maps** – four texel-snapped cascades. The distant ones are double-buffered and re-rendered a
   slice at a time across 2 or 4 frames, so they never tear. The near cascades use PCSS, so shadows harden near
   contact points and soften with distance from the caster.
4. **G-buffer** – chunk meshes from one shared vertex arena drawn with `WEBGL_multi_draw` (one draw call per page),
   front to back. Opaque blocks, alpha-tested leaves and dissolving plants are separate meshes and shaders. The
   opaque shader never uses `discard`, which keeps hidden-surface removal working on tile-based GPUs (Apple, mobile).
   Materials use parallax occlusion mapping with self-shadowing, with the step count scaled to the on-screen depth
   span; per-block texture rotation to hide tiling; wind animation for leaves and plants; and rain wetness with
   puddles and ripples.
5. **GTAO and bounce light** – horizon-based ambient occlusion at half resolution. The same horizon search
   collects one bounce of indirect light from the previous frame's lit image, so light accumulates multiple
   bounces over time (sunlit grass tints the trunk above it, torchlight fills a cave). A depth-aware blur follows.
6. **Volumetric light** – shadowed height fog and morning valley mist, with god rays from both terrain and cloud
   shadows. A separate absorption model applies underwater.
7. **Deferred lighting** – GGX specular, foliage translucency, underwater caustics, warm torch light,
   screen-space reflections, emissive blocks, aerial perspective.
8. **Water and glass** – refraction, Beer–Lambert absorption, SSR with cloud-aware sky fallback, sun glints, shore
   foam, and Snell's window with total internal reflection when you look up from underwater.
9. **Particles** – rain streaks and splashes, snow, fireflies, sunlit pollen, falling cherry petals, block debris.
10. **Temporal upscaling** – jittered rendering at a lower internal resolution reconstructed to full resolution
    with a Catmull-Rom history, variance clipping and depth-dilated reprojection.
11. **Post** – auto-exposure with night-aware metering, energy-conserving bloom, camera motion blur,
    contrast-adaptive sharpening, a log-domain filmic tone curve, scotopic (night vision) blue shift, vignette
    and grain.

### Frame rate

Each quality preset renders a fixed number of internal pixels (Ultra 2.4 MP, High 1.8 MP, Medium 1.3 MP,
Low 0.9 MP) whatever the display density. The temporal upscaler rebuilds full output resolution from the jittered
history. A 5K Retina window therefore costs the same to shade as a 1080p one.

Dynamic resolution (on by default) adjusts that scale to hold your target frame rate. It uses GPU timer queries
where the browser provides them and frame times where it doesn't (Safari). Presets also set shadow resolution,
cloud panorama size and step counts, fog steps, parallax steps, texture resolution (128 or 256 px per block) and
view distance. Bounce light and motion blur can be turned off in Settings → Graphics.

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
