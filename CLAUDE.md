# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Karakurenai is a static three.js page: an anime-style (Madhouse / *Chihayafuru*-inspired) scene built around Hyakunin Isshu poem No. 17, 「ちはやぶる … からくれなゐに 水くくるとは」. It is deployed on Netlify (https://karakurenai.netlify.app/) from the GitHub repo boobeh123/Karakurenai, so a push to `main` is a production deploy.

Vite builds the site. three.js comes from npm and is pinned to an exact version in `package.json`, because three makes breaking changes between 0.x releases. Google Fonts and normalize.css still load from CDNs. Netlify runs `npm run build` and publishes `dist/`, as configured in `netlify.toml`. There is no linter or test suite.

## Commands

```
npm install        # once
npm run dev        # dev server with reload on save: http://localhost:5173
npm run build      # production build into dist/
npm run preview    # serve dist/ to check the production build: http://localhost:4173
```

Windows PowerShell 5.1 swallows the `--` in `npm run preview -- --port 1234`, so npm receives the flags instead of Vite. To pass flags to Vite, call it directly, e.g. `npx vite preview --port 1234`.

Vite warns that the bundle is over 500 kB. That's expected, because three.js makes up most of it.

## Architecture

**Entry and dependencies.**
- **Entry:** `index.html` loads `public/js/main.js` as `type="module"`, and Vite bundles everything from there.
- **Imports:** modules use `import * as THREE from 'three'`. Official add-ons come from the same package, e.g. `import { SVGLoader } from 'three/addons/loaders/SVGLoader.js'`.
- **`publicDir: false`:** `vite.config.js` sets this because `public/` holds the site's JS and CSS source. By default Vite would copy that folder as unprocessed static files, which would break the imports. Keep source files under `public/`.
- **Post-processing:** it is hand-written in `postPass.js` rather than built on `EffectComposer`, and it does exactly what the scene needs.

**Frame loop (`main.js`).**
- **Clock:** `renderer.setAnimationLoop` drives the frames. `sceneTime` advances by frame deltas capped at 0.1 s, and stops while the scene is paused or the tab is hidden.
- **Each frame:** `main.js` asks the director for the frame at `sceneTime % LOOP_SECONDS`, applies the camera, and hands the frame's `fx` values to the active world, the post pass, the 「ち」 and poem overlays, and the soundscape.
- **Worlds:** the frame's `world` is `'hall'` or `'river'`. Only that world is updated and rendered, and both use the same 3D camera. `getView()` picks what the post pass draws: an insert, the river scene, or by default the hall.
- **Reduced motion:** with `prefers-reduced-motion`, the page starts paused at `STILL_FRAME_TIME` (17.5 s), on the river with the poem showing.
- **Dev jump:** on the dev server only, `?t=8` opens the sequence paused at 8 seconds, so a single frame can be inspected. Production builds strip it via `import.meta.env.DEV`.

**Sequence (`director.js`).**
- **Pure function of time:** `getFrame(loopTime, { reducedMotion })` returns the camera pose and a flat `fx` object. The `fx` values cover the smear, impact, shake, speed lines, card flight, skid, sparkles, sound ring, the 「ち」 flag, music ducking, and the character states (breath wisps, the eyes' drawing, the glint, and the hand).
- **Insert shots:** these have an `insert` (a name plus zoom and pan) instead of 3D poses. `getFrame` then returns `insert`, and `main.js` renders that insert while the 3D camera holds still.
- **Shot list:** data-driven, over a 24-second loop. The hall shots run from 0 to 11 s: hall, breath, eyes, syllable, and sweep. The river shots run from 11 to 24 s: landing, river, and rise. Hall positions are relative to the hero card's rest position and the reader's position. River positions follow the floating card through `riverCardAfter()`, which comes from `tatsutaRiver.js`. Moving any of these keeps the camera work intact.
- **River timing:** the `RIVER` constants set when the card falls, lands, ripples, dyes the water, and when the poem shows. `FADE` joins the loop's end to its start through paper colour. The fade is slow, so it is not a flash.
- **On twos:** drawn motion (card flight, skid, dust, rings, sparkles) is computed from `drawnTime`, which is stepped to 12 fps. The camera and the smear and impact frames run on ones.
- **Reduced motion:** the director zeroes the impact flash, speed lines, and camera shake when `reducedMotion` is set.
- **Cues:** `getCues(previousTime, time)` returns the cues crossed since the last frame, including across the loop wrap, so each fires once per loop.
- **Framing:** `fitFieldOfView()` widens the vertical FOV on portrait screens, up to 2.2×, so the board isn't cropped. Shots are composed for 16:9.

**Render pipeline (`postPass.js`).** Every frame renders three passes:
1. The scene into a multisampled HalfFloat color target.
2. The scene again with `scene.overrideMaterial = MeshNormalMaterial` into a target with a depth texture.
3. A full-screen composite shader. It draws ink lines where the Laplacian of 1/depth spikes (silhouettes) or normals change (creases). It then applies the impact frame (a two-tone paper-and-ink picture with crimson lines, set by the `impact` uniform), speed lines radiating from `speedCenter`, a vignette, the fade to paper (`fade`), and film grain, and converts to sRGB through `#include <colorspace_fragment>`.

Things to know when adding to the scene:
- **`FX_LAYER`:** effects (light beams, dust, sound rings, the smear, sparkles) must call `mesh.layers.set(FX_LAYER)`. That keeps them out of the normal pass, so they don't get ink outlines. Character cutouts must *not* go on it. Anything missing from the normal pass is invisible to the edge detector, so the floor's lines get inked straight through the character.
- **Shadows:** `shadowMap.autoUpdate` is off, and `render()` refreshes the shadow map once per frame during the color pass. Moving objects still get correct shadows.
- **Stray ink:** the edge detector inks any hairline crack or edge-on face. Boxes that merely touch, or coplanar seams, show up as dotted lines. Overlap the geometry slightly, or put a matching surface just behind it. The window wall's side pieces and the tatami underlay in `karutaHall.js` both do this.

**World (`karutaHall.js`).**
- **Scale:** world units are centimetres, and real card and tatami sizes are used (a card is 5.2 × 7.3).
- **Layout:** the window and its lattice are in the back wall (−z, behind the opponent). The player's side and the usual camera position are at +z, looking into the light.
- **Sun and beams:** `SUN_DIRECTION` drives both the directional light and the light-beam shader. The beam shader traces each point back to the lattice plane to cut the shafts into bands, so the window, lattice, and sun constants must stay consistent. Dust motes are also placed along rays from the window.
- **Board lighting:** `WINDOW.bottom` (48) is chosen so the lattice's horizontal-bar shadows fall just outside the board's rows. At 40, a bar shadow lay across the hero card's row.
- **Cards:** cards come from `TERRITORY_ROWS`, a mid-match layout with 12 cards per side. The No. 17 hero card sits at `HERO_SLOT`. `update()` resets the hero card and its skidding neighbours to their rest transforms whenever `fx.flight` and `fx.skid` are 0, so each loop starts clean.
- **Interface:** `createKarutaHall()` is async, because it waits for the card font. It returns `{ group, cards, heroCard, heroRestPosition, readerPosition, background, update({ time, drawnTime, fx, pointScale, cameraPosition }) }`. `pointScale` converts centimetres to pixels for the point-sprite effects, and `cameraPosition` turns the character cutouts to face the camera.

**River (`tatsutaRiver.js`).**
- **Its own scene:** it has its own lights, sky and background. The units are centimetres, the water surface is y = 0, and the current (`FLOW`) runs toward +x.
- **Water:** one `ShaderMaterial`. It has three flat tones that lighten toward the far bank, and white glints made of noise stretched along the current. It also has two ripple rings from the landing point, and the crimson dye. The dye is an ellipse around the card, stretched downstream with a noisy edge, and filled with tie-dye streaks of crimson and deep red. It is gated on its radius, so there is no stain before the landing.
- **Leaves:** a single `InstancedMesh` of seven-lobed maple leaves, some falling and some floating. Every instance's matrix is recomputed each frame from `drawnTime`, so they move on twos.
- **The card:** it shares the hall hero card's geometry and face texture. It tumbles in on twos and lands face up (the tumble counts are whole turns), then floats downstream. `getCardPositionAfter(seconds)` gives its position, and the director uses it.
- **Far bank:** a low toon bank with maples. Each crown is a cluster of small faceted icosahedron clumps, which reads as painted foliage, where single big spheres read as balloons.

**Characters (`celArt.js`, `public/art/*.svg`).**
- **SVG source:** the characters are SVG drawings, imported as strings with Vite's `?raw` suffix and turned into flat, unlit meshes by three's `SVGLoader`, one mesh per fill and per stroke. SVGLoader handles only fills, strokes, transforms and opacity. Draw without gradients, clip paths, `<use>`, or `<text>`: the iris uses flat cel bands, and the eye lids simply cover what shouldn't show.
- **Layering:** each shape sits `Z_STEP` in front of the one before, and meshes write depth. So a drawing layers in document order, and a cutout hides what's behind it like a solid object. `<g data-layer="front">` jumps forward by `FRONT_Z`, which lets the reading card's textured plane sit between the art's back and front.
- **Swappable drawings:** `<g data-layer="name">` groups can be toggled with `setLayerVisible()`. The eyes use `closed`, `half`, and `open`, the three drawings of the blink, plus `glint`. The breath insert uses `breath`.
- **In the hall:** `createCutout()` places a drawing in the room. SVG y runs down, so the art is flipped, and an anchor point in SVG units lands on the cutout's origin. `karutaHall.js` turns each cutout around the vertical axis every frame to face the camera. The reader is life-size, about 90 cm kneeling, and casts a shadow. The hand is drawn at about 10 cm instead of life size, because the sweep camera sits a hand's length from the cards.
- **Inserts:** `createInsertShots()` builds the full-screen 2D cuts (`readerBreath`, `playerEyes`), each with its own scene and orthographic camera. `postPass.render(time, view)` draws them without the ink pass. Each is drawn on a 1600 × 900 sheet with a `FOCUS` band. Narrow screens crop the sides down to that band, then show space above and below, so insert art must bleed past the sheet's top and bottom (the breath art bleeds about 500 units) or end on the scene background colour.

**Materials and text (`materials.js`, `poems.js`).**
- **Materials:** all scene materials go through `createToonMaterial`, which shares one 3-step gradient map. The lavender hemisphere light provides the tinted shadows.
- **Card faces:** each card face is a canvas texture in the Yuji Syuku font, drawn only after `loadCardFont()` has loaded the required kana subsets.
- **Poem data:** `poems.js` holds real lower verses in historical kana, *with* dakuten. `getTorifudaText()` strips spaces and dakuten (via NFD normalization), the way traditional cards are printed.
- **Accuracy:** poem text must be accurate. Verify any verse before adding it.

**Sound (`soundscape.js`).**
- **No files:** all audio is synthesized with the Web Audio API.
- **Lifecycle:** the `AudioContext` is created lazily inside the Sound button's click handler, because of autoplay rules and iOS. Sound plays only when `setEnabled(true)` (the user's toggle) and `setRunning(true)` are both set. `setRunning` follows `isPlaying && !document.hidden`. Otherwise the context is suspended, which freezes the audio clock so scheduled music stays in step with the paused scene.
- **Koto:** plucks are Karplus-Strong strings, pre-rendered for each scale note. The fractional-delay allpass in `renderPluck` keeps them in tune; without it they drift sharp by up to a third of a semitone.
- **Melody:** a lookahead scheduler composes phrases in the miyako-bushi scale on D, ending on D or A, with rests between phrases.
- **Music bus:** music (plucks and drone) runs through its own dry and reverb buses, so `setMusicDucked()` can fade it out before the first syllable while the room air and higurashi cicadas continue. It is safe to call every frame; only a change starts a fade.
- **Rest and re-entry:** the koto composes no new phrases while ducked. When the music returns, a phrase starts about 0.3 s later with a sararin sweep into D5. Without this, the short unducked window at the start of each loop often held no audible notes; one measured loop had none.
- **Cues:** `playCue(name)` plays the one-shot effects: `breath`, `bell` (a rin with inharmonic partials), `slap`, `whoosh`, and `splash`. Each is built from the shared noise buffer or oscillators, and is ignored unless sound is on and running.
- **Water:** a looping noise bed runs through a slowly wandering band-pass. `setWater()` fades it in and out with the river shots, and is safe to call every frame. The music is ducked only from the breath to the cut to the river (4.4–11 s).

## Accessibility constraints

- The Pause/Play button must stop all motion, and sound with it.
- Under reduced motion, impact flashes, speed lines, and camera shake are disabled (in `director.js`). Any new flash or shake must follow the same rule.
- Keep full-screen flashes to one per loop (the impact frame), well under 3 per second. Transitions between worlds are hard cuts or slow fades.
- The poem, romaji, translation, and attribution are real DOM text in `index.html` (`.poemCard`, with the Japanese set vertically via `writing-mode`). They only fade in visually, and screen readers can reach them at any time.

## Roadmap

Built:
- **Feature 1:** the karuta hall, plus the soundscape.
- **Feature 2a:** the 11-second match sequence. Its shots are the hall, breath, eyes, syllable, and sweep, with effects and sound cues.
- **Feature 2b:** the characters.
  - The reader (Claude, in a clay-orange haori) kneels beside the board, and the establishing shot ends on them.
  - The `breath` and `eyes` shots are full-screen inserts.
  - The player's hand waits at the ready, then leads the smear.
- **Feature 3:** the Tatsuta River.
  - The card falls onto the water and lands with ripples and a splash.
  - Crimson tie-dye spreads from it, and maple leaves fall and float.
  - The full poem fades in with its translation.
  - The camera rises to the maples, then the loop fades through paper back to the hall.

All planned features are built.

## Visual verification

Point checks at `npm run dev` or `npm run preview`.

- **Screenshots:** headless Edge (`msedge --headless=new --use-angle=swiftshader --enable-unsafe-swiftshader --screenshot=...`) renders the scene. For an exact moment, screenshot the dev server with `?t=<seconds>`; the page opens paused there, so the capture can't drift. The minimum window width crops narrow `--window-size` captures.
- **Motion, audio, and phone layouts:** drive Edge over the DevTools protocol instead. Launch it with `--remote-debugging-port`, then use `Emulation.setDeviceMetricsOverride` with `mobile: true`, and `Runtime.evaluate` with `userGesture: true` for clicks.
- **Timing under software rendering:** SwiftShader renders slower than 60 fps, and the 0.1 s frame cap then makes the scene clock run slower than wall time. Real-time probes therefore show cues later than their scene times. Check order and counts there, not absolute times.
