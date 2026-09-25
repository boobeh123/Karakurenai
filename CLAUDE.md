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
- **Each frame:** `main.js` asks the director for the frame at `sceneTime % LOOP_SECONDS`, applies the camera, and hands the frame's `fx` values to the hall, the post pass, the 「ち」 overlay, and the soundscape.
- **Reduced motion:** with `prefers-reduced-motion`, the page starts paused.
- **Dev jump:** on the dev server only, `?t=8` opens the sequence paused at 8 seconds, so a single frame can be inspected. Production builds strip it via `import.meta.env.DEV`.

**Sequence (`director.js`).**
- **Pure function of time:** `getFrame(loopTime, { reducedMotion })` returns the camera pose and a flat `fx` object: smear, impact, shake, speed lines, card flight, skid, sparkles, sound ring, the 「ち」 flag, and music ducking.
- **Shot list:** data-driven. Positions are relative to the hero card's rest position and the reader's position, both passed in from the hall, so moving either one keeps the camera work intact.
- **On twos:** drawn motion (card flight, skid, dust, rings, sparkles) is computed from `drawnTime`, which is stepped to 12 fps. The camera and the smear and impact frames run on ones.
- **Reduced motion:** the director zeroes the impact flash, speed lines, and camera shake when `reducedMotion` is set.
- **Cues:** `getCues(previousTime, time)` returns the cues crossed since the last frame, including across the loop wrap, so each fires once per loop.
- **Framing:** `fitFieldOfView()` widens the vertical FOV on portrait screens, up to 2.2×, so the board isn't cropped. Shots are composed for 16:9.

**Render pipeline (`postPass.js`).** Every frame renders three passes:
1. The scene into a multisampled HalfFloat color target.
2. The scene again with `scene.overrideMaterial = MeshNormalMaterial` into a target with a depth texture.
3. A full-screen composite shader. It draws ink lines where the Laplacian of 1/depth spikes (silhouettes) or normals change (creases). It then applies the impact frame (a two-tone paper-and-ink picture with crimson lines, set by the `impact` uniform), speed lines radiating from `speedCenter`, a vignette, and film grain, and converts to sRGB through `#include <colorspace_fragment>`.

Things to know when adding to the scene:
- **`FX_LAYER`:** effects (light beams, dust, sound rings, the smear, sparkles) must call `mesh.layers.set(FX_LAYER)`. That keeps them out of the normal pass, so they don't get ink outlines. Flat character cutouts belong there too, since the art has its own lines.
- **Shadows:** `shadowMap.autoUpdate` is off, and `render()` refreshes the shadow map once per frame during the color pass. Moving objects still get correct shadows.
- **Stray ink:** the edge detector inks any hairline crack or edge-on face. Boxes that merely touch, or coplanar seams, show up as dotted lines. Overlap the geometry slightly, or put a matching surface just behind it. The window wall's side pieces and the tatami underlay in `karutaHall.js` both do this.

**World (`karutaHall.js`).**
- **Scale:** world units are centimetres, and real card and tatami sizes are used (a card is 5.2 × 7.3).
- **Layout:** the window and its lattice are in the back wall (−z, behind the opponent). The player's side and the usual camera position are at +z, looking into the light.
- **Sun and beams:** `SUN_DIRECTION` drives both the directional light and the light-beam shader. The beam shader traces each point back to the lattice plane to cut the shafts into bands, so the window, lattice, and sun constants must stay consistent. Dust motes are also placed along rays from the window.
- **Board lighting:** `WINDOW.bottom` (48) is chosen so the lattice's horizontal-bar shadows fall just outside the board's rows. At 40, a bar shadow lay across the hero card's row.
- **Cards:** cards come from `TERRITORY_ROWS`, a mid-match layout with 12 cards per side. The No. 17 hero card sits at `HERO_SLOT`. `update()` resets the hero card and its skidding neighbours to their rest transforms whenever `fx.flight` and `fx.skid` are 0, so each loop starts clean.
- **Interface:** `createKarutaHall()` is async, because it waits for the card font. It returns `{ group, cards, heroCard, heroRestPosition, readerPosition, background, update({ time, drawnTime, fx, pointScale }) }`. `pointScale` converts centimetres to pixels for the point-sprite effects.

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
- **Cues:** `playCue(name)` plays the one-shot effects: `breath`, `bell` (a rin with inharmonic partials), `slap`, and `whoosh`. Each is built from the shared noise buffer or oscillators, and is ignored unless sound is on and running.

## Accessibility constraints

- The Pause/Play button must stop all motion, and sound with it.
- Under reduced motion, impact flashes, speed lines, and camera shake are disabled (in `director.js`). Any new flash or shake must follow the same rule.
- Keep full-screen flashes to one per loop, well under 3 per second.
- The poem and translation must exist as real DOM text, not only as canvas art.

## Roadmap

Built:
- **Feature 1:** the karuta hall, plus the soundscape.
- **Feature 2a:** the 11-second match sequence. Its shots are the hall, breath, eyes, syllable, and sweep, with effects and sound cues.

Planned, not yet written:
- **Feature 2b, the characters:** original art in flat cel colours, loaded as vectors with three's `SVGLoader`. It is authored without gradients, clip paths, or text, which SVGLoader doesn't support.
  - The reader (Claude, in a clay-orange haori) kneels at `readerPosition` as a flat cutout in the hall.
  - The `breath` and `eyes` shots, currently 3D placeholders, become full-screen 2D inserts: the reader's close-up and the player's eyes opening.
  - The player's hand is added at the head of the smear.
- **Feature 3, `tatsutaRiver.js`:** a cel-shaded water shader with crimson dye spreading from the card, plus instanced maple leaves. The full poem is written vertically as DOM text, with an English translation. The loop extends to about 24 seconds.

## Visual verification

Point checks at `npm run dev` or `npm run preview`.

- **Screenshots:** headless Edge (`msedge --headless=new --use-angle=swiftshader --enable-unsafe-swiftshader --screenshot=...`) renders the scene. For an exact moment, screenshot the dev server with `?t=<seconds>`; the page opens paused there, so the capture can't drift. The minimum window width crops narrow `--window-size` captures.
- **Motion, audio, and phone layouts:** drive Edge over the DevTools protocol instead. Launch it with `--remote-debugging-port`, then use `Emulation.setDeviceMetricsOverride` with `mobile: true`, and `Runtime.evaluate` with `userGesture: true` for clicks.
- **Timing under software rendering:** SwiftShader renders slower than 60 fps, and the 0.1 s frame cap then makes the scene clock run slower than wall time. Real-time probes therefore show cues later than their scene times. Check order and counts there, not absolute times.
