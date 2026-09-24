# Lumencraft

A voxel sandbox you can explore and build in, rendered by a physically based real-time renderer
written from scratch in WebGL 2. There are no engine dependencies and no image assets: the world, every block
texture, the creatures, the sky, the clouds and the soundscape are all generated procedurally at startup.

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
| `Tab` | Atlas: a shaded map of the surrounding biomes; click a spot to travel there |
| `J` | Journal of biomes discovered and wildlife spotted |
| `P` | Photo mode: free camera, depth of field, letterbox |
| `F2` | Save a screenshot (PNG) |
| `Ctrl Z` / `Ctrl Y` | Undo / redo block changes |
| `H` / `Shift H` | Return home / set home here |
| `-` `=` | Exposure compensation |
| `F1` | Hide the HUD |
| `F3` | Performance overlay (fps, GPU time, internal resolution, draw calls, the most expensive passes) |
| `M` | Mute |

Photo mode has its own keys: `WASD Space C` fly (`Shift` for speed), scroll sets the focus distance (`Alt` +
scroll the aperture, `F` toggles autofocus), `Z`/`X` change the field of view, `L` toggles the 2.39:1 letterbox
and `P` or `Esc` leaves.

### Saving

The world you are in (its seed, every block you place or break, where you are, the time of day, your home
point and your journal) is saved in the browser every 20 seconds and whenever you pause or leave the page.
The title screen offers **Continue**; **New world…** takes an optional seed (any text or number).
| `Esc` | Pause menu and settings |

## What is being rendered

Each frame runs this pipeline (`src/renderer.js`):

0. **Culling** – each chunk mesh is sorted into groups by 32-block height section and face direction. Groups
   outside the view, or whose faces all point away from the camera (G-buffer) or the sun (shadow maps), are
   skipped before any vertex work, which removes about a third of the triangles submitted per frame.
1. **Atmosphere** – Hillaire-style physically based sky: transmittance and multiple-scattering LUTs, a sky-view LUT
   rebuilt every frame for the current sun and moon, and a sky irradiance map used for ambient light.
2. **Volumetric clouds** – Perlin-Worley cumulus over a curved-earth layer plus a high cirrus deck, with
   four-octave multiple scattering, powder and silver lining. Clouds are infinitely far away compared with the
   camera's movement, so they are raymarched into a sky panorama instead of per pixel: each frame refreshes one
   pixel in 16 (a Bayer pattern), or one in 32 at High and Ultra, so the whole sky is refreshed every 16–32 frames. Rays march coarsely
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
7. **Deferred lighting** – GGX specular, foliage translucency with multiple scattering, underwater caustics,
   two colours of block light (warm fire and lamp light, cool bioluminescence and crystal light, each spread
   through the voxels separately), screen-space contact shadows for fine detail up close, screen-space
   reflections, emissive blocks and aerial perspective.
8. **Water and glass** – refraction, Beer–Lambert absorption, SSR with cloud-aware sky fallback, sun glints, shore
   foam, and Snell's window with total internal reflection when you look up from underwater. Water takes its
   character from the climate: turquoise and clear over tropical reefs, murky and green in swamps.
9. **Creatures and particles** – creatures are drawn as instanced cuboid parts straight into the G-buffer and
   the near shadow cascades, so they get the same lighting, shadows, fog and bounce light as the terrain.
   Particles: rain streaks and splashes, snow, fireflies, sunlit pollen, falling cherry petals and maple leaves,
   drifting bioluminescent spores, volcanic ash and rising embers, block debris.
10. **Temporal upscaling** – jittered rendering at a lower internal resolution reconstructed to full resolution
    with a Catmull-Rom history, variance clipping and depth-dilated reprojection.
11. **Post** – auto-exposure with night-aware metering, energy-conserving bloom, a lens flare placed from the
    sun's screen position and dimmed by how much of the sun terrain and clouds hide, camera motion blur,
    bokeh depth of field (photo and cinematic modes), contrast-adaptive sharpening, a log-domain filmic tone
    curve, scotopic (night vision) blue shift, vignette, chromatic aberration and grain.

The sky adds rainbows (primary and secondary bows at their true angles) while the land is still wet after a
shower, and shooting stars at night.

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
Twenty-four biomes:

- **Classic:** ocean, beach, river, plains, flower meadow, forest, birch forest, cherry grove, taiga, snowy taiga,
  desert, mountains and snowy peaks.
- **Autumn Maples:** crimson, amber and golden maples over a carpet of fallen leaves, with leaves drifting down.
- **Jungle:** giant 2×2 trees with buttress roots and curtains of vines, dense undergrowth, humid haze.
- **Savanna:** golden grass and flat-topped acacias.
- **Badlands Mesa:** terraced plateaus banded with seven colours of terracotta, and eroded hoodoos.
- **Willow Swamp:** murky water, lily pads, cattails, weeping willows hung with moss, frogs and mist.
- **Lumen Grove:** giant bioluminescent mushrooms, glowmoss and luminous ferns that light the night blue,
  with spores and glowing moths drifting between them.
- **Volcanic Fields:** basalt columns, ash, magma vents and a crater of lava, with ash falling and embers rising.
- **Coral Reef** and **Tropical Shore:** turquoise shallows with brain, fire and tube coral, sea fans, palms.
- **Lavender Fields:** planted rows of lavender.
- **Ice Spikes:** towers of packed and blue ice.

Underground there are spaghetti and cheese caves, lava lakes, ore veins, amethyst geodes, glow mushrooms and
hanging roots. Oceans grow kelp forests. Sky light and both colours of block light spread through the voxels
in the worker threads and feed smooth per-vertex lighting. About 110 block types, all with procedural PBR
materials, can be placed from the searchable, categorised palette (`E`).

### Wildlife

Red deer (stags carry antlers), rabbits (white in the snow, sandy in the desert), red and arctic foxes, sheep,
tree frogs, songbirds, seagulls, butterflies, schools of fish (silver in cold water, colourful on reefs) and
Lumen moths. They spawn in the biomes they belong to at the right time of day, graze, wander, keep an eye on
you, bolt if you come too close, flock, flutter and school. Each species is a small articulated model with
procedural fur, feathers, scales and markings. Species you see up close are recorded in the journal.

The day lasts 24 minutes by default. Nights have a phase-correct moon, a rotating star field with the Milky Way,
aurora and fireflies. Weather cycles between clear skies and rain with thunderstorms.

## Layout

```
index.html          page shell, HUD, menus and styles
src/main.js         game loop, input, settings, HUD, photo mode, saving, journal
src/creatures.js    wildlife models, spawning and behaviour
src/mapview.js      atlas overlay (rendered by its own worker)
src/save.js         world persistence
src/renderer.js     render pipeline and GPU resources
src/shaders/        GLSL for every pass
src/textures.js     procedural PBR block textures (generated on the GPU)
src/world.js        chunk streaming, block edits, raycasting (main thread)
src/worker.js       world worker: generation, meshing, atlas rendering
src/worldgen.js     terrain, biomes, caves, trees
src/mesher.js       light propagation and greedy meshing
src/meshpool.js     GPU vertex arena with multi-draw
src/player.js       movement and collision
src/audio.js        procedural soundscape
build.mjs           single-file bundler
serve.mjs           zero-dependency dev server
```
