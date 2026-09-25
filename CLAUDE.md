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

**Frame loop (`main.js`).** `renderer.setAnimationLoop` drives the frames. `sceneTime` advances by clamped frame deltas and stops while the scene is paused or the tab is hidden. The camera currently runs a temporary wide-to-close drift in `updateCamera`. The planned `director.js` replaces it (see Roadmap). With `prefers-reduced-motion`, the page starts paused.

**Render pipeline (`postPass.js`).** Every frame renders three passes:
1. The scene into a multisampled HalfFloat color target.
2. The scene again with `scene.overrideMaterial = MeshNormalMaterial` into a target with a depth texture.
3. A full-screen composite shader. It draws ink lines where the Laplacian of 1/depth spikes (silhouettes) or normals change (creases), then adds a vignette and film grain, and converts to sRGB through `#include <colorspace_fragment>`.

Things to know when adding to the scene:
- **`FX_LAYER`:** additive or transparent effects (light beams, and later dust and sparkles) must call `mesh.layers.set(FX_LAYER)`. That keeps them out of the normal pass, so they don't get ink outlines.
- **Shadows:** `shadowMap.autoUpdate` is off, and `render()` refreshes the shadow map once per frame during the color pass. Moving objects still get correct shadows.
- **Stray ink:** the edge detector inks any hairline crack or edge-on face. Boxes that merely touch, or coplanar seams, show up as dotted lines. Overlap the geometry slightly, or put a matching surface just behind it. The window wall's side pieces and the tatami underlay in `karutaHall.js` both do this.

**World (`karutaHall.js`).**
- **Scale:** world units are centimetres, and real card and tatami sizes are used (a card is 5.2 × 7.3).
- **Layout:** the window and its lattice are in the back wall (−z, behind the opponent). The player's side and the usual camera position are at +z, looking into the light.
- **Sun and beams:** `SUN_DIRECTION` drives both the directional light and the light-beam shader. The beam shader traces each point back to the lattice plane to cut the shafts into bands, so the window, lattice, and sun constants must stay consistent.
- **Cards:** cards come from `TERRITORY_ROWS`, a mid-match layout with 12 cards per side. The No. 17 hero card sits at `HERO_SLOT`.
- **Interface:** `createKarutaHall()` is async, because it waits for the card font. It returns `{ group, cards, heroCard, background, update(time) }`.

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

## Accessibility constraints

- The Pause/Play button must stop all motion, and sound with it.
- Under reduced motion, any future impact flashes, speed lines, and camera shake must be disabled.
- Keep full-screen flashes to one per loop, well under 3 per second.
- The poem and translation must exist as real DOM text, not only as canvas art.

## Roadmap

Feature 1 (the karuta hall) and the soundscape are built. The following features are planned but not yet written:
- **`director.js`:** a data-driven shot list for a 24-second loop. The shots are the hall establishing shot, the first-syllable 「ち」 close-up, the card sweep with an impact frame and speed lines, the Tatsuta River, and a rise into leaves.
- **`tatsutaRiver.js`:** a cel-shaded water shader with crimson dye spreading from the card, plus instanced maple leaves.
- **Poem overlay:** the full poem written vertically, with an English translation.

Object motion is meant to be animated "on twos" (12 fps) while the camera moves smoothly.

## Visual verification

Point checks at `npm run dev` or `npm run preview`. Headless Edge (`msedge --headless=new --use-angle=swiftshader --enable-unsafe-swiftshader --screenshot=...`) renders the scene, but with `--virtual-time-budget` the animation loop doesn't advance, so screenshots show the first frame. Minimum window width also crops narrow `--window-size` captures. For motion, audio, or phone layouts, drive Edge over the DevTools protocol instead: launch it with `--remote-debugging-port`, then use `Emulation.setDeviceMetricsOverride` with `mobile: true`, and `Runtime.evaluate` with `userGesture: true` for clicks.
