# Third-party ports

## Cuefield AutoMix transition planner/runtime

- Upstream: `SLYysl/cuefield-mineradio`
- Reference revision: `c16f05a0bc731a49da7d42c135337fcac58f6dba`
- License: GNU GPL v3 (`GPL-3.0`)
- Port refresh date: 2026-08-01

Mineradio integrates the upstream cache-only transition planner, structure and
boundary evidence, recipe routing, preparation de-duplication, bounded bridge
and source-loop helpers, and advanced B-deck timeline actions. The runtime is
adapted to Mineradio's modular script loader, provider-aware beat-map cache,
existing AudioContext ownership transfer, finite source fallback, and the
already approved album-gapless crossmix path.

AutoMix remains opt-in and stops while disabled, paused, manually seeking, or
when album-gapless owns the next deck. Unsupported WebAudio actions degrade to
the volume-only/equal-power path instead of blocking normal queue advance. The
upstream optional remote-feedback service, monolithic Mineradio UI, private
audio URLs, account credentials, and raw local beat-map data are not included
or transmitted; ratings remain in the current user's local data directory.

## Mineradio-LX-Music desktop/home reference

- Upstream: `ww085213/Mineradio-LX-Music`
- Initial reference revision: `82826df814c32853d99697c0ee60f749a2fcad79`
- Homepage refresh revision: `812e2dc2e18bbc263e61dbd0206cb765e003d6e9`
- License: GNU GPL v3 (`GPL-3.0-only`)
- Port dates: 2026-07-18 (initial), 2026-07-19 (homepage refresh)

Mineradio's full desktop mode adapts the upstream idea of moving the existing
Electron main-window HWND between the Windows WorkerW desktop layer and an
interactive top-level window. The native attach/detach code in this project was
rewritten around the optimized edition's fail-closed WorkerW discovery, DPI
conversion, structured acknowledgements, serialized lifecycle, and cleanup
requirements.

The home dashboard adapts the upstream information hierarchy (continue,
library, daily recommendations, recent playback, today's listening, next up,
discovery, and radio entry points). Its data adapters use this project's current
multi-provider discovery, playlist, search, playback queue, and listen-history
state. Upstream LX-only server routes and the legacy standalone wallpaper
overlay were not copied.

The 2026-07-19 refresh additionally adapts the three-song "For You" strip,
stable cover-image swaps, in-place quick-card updates, daily-review hover
feedback, and compact-height scrolling/settings behavior. These features remain
implemented against Mineradio's existing provider, weather-radio, local-library,
queue, and playback modules rather than the upstream LX/local-only data model.

The combined application remains distributed under the repository's GNU GPL v3
license. Preserve this notice and the corresponding source when redistributing
modified builds.

## Visual preset 17「调音台」(MIXER DESK) — reference port (licence unverified)

- Reference: <https://www.shadertoy.com/view/cs2GWD> (author marker 0b5vr)
- Landing file: `public/js/modules/02-visual/22-mixer-desk-preset.js`
- Attribution sidecar: `public/js/modules/02-visual/22-mixer-desk-preset.LICENSE.txt`

The page was not reachable and the supplied source carried no licence header, so the licence is **UNVERIFIED**. At the requester's instruction the reference body is kept as written; the changes are limited to a handful of uniforms (camera pan/sway/roll/fov, grid scale, level gain, march/shadow steps, max distance), an opaque alpha so the post pass can copy the frame, and an audio-driven level table on iChannel0. Before distributing a build that contains this preset, confirm the author's licence and update this file, NOTICE.md and the sidecar.

## Visual preset 18「彩虹猫小镇」(NYAN TOWN) — reference port (licence unverified)

- Reference: Shadertoy "Fractal Cartoon" (formerly "DE edge detection") by Kali (source supplied by the requester; no page URL or licence header), plus the Nyan Cat cameo by mu6k: <https://www.shadertoy.com/view/4dXGWH>
- Landing file: `public/js/modules/02-visual/23-nyan-town-preset.js`
- Attribution sidecar: `public/js/modules/02-visual/23-nyan-town-preset.LICENSE.txt`

At the requester's instruction the reference body is kept as written; the changes are limited to uniforms whose defaults equal the reference literals (ray steps, detail, brightness/gamma/saturation, edge gain, wave amplitude, sun size/pump/spin, fov/pump, camera speed, time scale, nyan speed, border), runtime toggles for the cat and its rainbow, an opaque alpha, and a spectrum channel for the sun. The reference's iChannel1 Nyan Cat texture could not be fetched (403), so the sprite strip is painted in code with the same frame size — an approximation of the original art. The licence is **UNVERIFIED**; Shadertoy's default CC BY-NC-SA is incompatible with this GPL build, and Nyan Cat is a copyrighted character (Chris Torres). Do not distribute a build containing this preset until terms are confirmed and this file, NOTICE.md and the sidecar are updated.

## Visual preset 19「故障艺术」(GLITCH ART) — component port (licence unverified)

- Reference: Shadertoy view **lfscD7**: <https://www.shadertoy.com/view/lfscD7> (the page returned 403; only the presentation fragment was supplied)
- Landing file: `public/js/modules/02-visual/24-glitch-art-preset.js`
- Attribution sidecar: `public/js/modules/02-visual/24-glitch-art-preset.LICENSE.txt`

The supplied presentation fragment is kept in Shadertoy shape: Vignette() with its three #defines lifted to uniforms, the bloom contribution, `texelFetch(iChannel1, ivec2(xy)/kScreenDownsample)` as a nearest sample of the downsampled source at 0.6, the saturate → pow(0.8) → mix(0.1, 0.9) curve, and the vignette multiply. The parts the fragment names but does not define are separate components: the corrupted-signal source (hashed blocks, tear band, channel split, scanline, grain), a two-pass separable bloom, and the low-res composite. The integer PCG wrapper is replaced by a GLSL1 float hash because the source compiles in WebGL1. Every constant is a knob; audioDrive/audioGlitch/audioTear/audioBloom/beatPulse are the audio connection points (8-band frame + beat pulse). The licence is **UNVERIFIED**; do not distribute a build, screenshot or derivative of this preset until the author confirms the terms and this file, NOTICE.md and the sidecar are updated.

## Qishui Passport Web QR authentication

- Upstream: `Wx2yZx/Mineradio-Qishui-QR-Login`
- Reference revision: `aaadaab7d011714f94fbe45b382ba8dcc7cf17b9`
- Declared license: `GPL-3.0-only`
- Port date: 2026-07-30

Mineradio ports only the official Passport Web QR authentication boundary:
an isolated hidden Electron security host, the Qishui web signing bootstrap,
QR creation and polling, account-session cookie persistence, and the official
second-verification UI when the service requests it. The upstream whole-project
installer was not run, and no application files were wholesale replaced.

The QR bridge feeds the authenticated cookie into Mineradio's existing
`qishui-api.js` provider. Search, playlists, likes, comments, entitlement checks,
and audio playback remain Mineradio implementations. Legacy token/manual-cookie
login controls and local SodaMusic cookie discovery are not exposed by the
current login UI.

The web security runtime resources under `qishui-auth-v6/` are retained
byte-for-byte for protocol compatibility and remain the property of their
respective rights holders. They are loaded only inside the isolated authentication
partition for the user's own official login session.

## JIZURA text-PV engine (`vendor/jizura/`)

- Upstream: <https://github.com/852wa/JIZURA> — `hakoniwa`'s JIZURA lyric-motion generator (checked out locally at `G:\SoftwareFile\JIZURA`)
- Reference revision: `fc16bfe43ea4a6c25a21f1caf04d17326de14f00` (VERSION `0.10.1`; fetched from `refs/heads/main` on 2026-10-19)
- License: MIT (`Copyright (c) 2026 hakoniwa`) — full text at `vendor/jizura/LICENSE.txt`
- Port refresh date: 2026-10-18

Mineradio vendors the engine as **one file**, `vendor/jizura/jizura-engine.js`
(2,149,721 B, sha1 `096195a0fe8dbfb67277c9c4d147655f0a4cf36d`), generated by
`scripts/vendor-jizura-engine.js` with the same steps as upstream `build.py:11-12`
(`sorted(glob('src/*.js'))`, each file decoded as UTF-8 with CRLF folded to LF,
joined with a single newline). `vendor/jizura/engine-manifest.json` records the
per-file raw sha1s, the bundle sha1 and the exclusions; `scripts/quick-check.js`
pins them so an edit inside `vendor/` cannot ship as "the engine that was measured".

Integrated scope: the planner (`J.plan`), the serializer our PV archive format is
built on (`J.planForAE`, `J.AE_MAP`), the Canvas2D frame renderer (`J.Renderer`),
the part/style/font catalogues, and the offline font-persistence hooks
(`J.saveFontData`/`J.loadFontData`).

Excluded: the editor UI module `src/12_ui.js` (defines only `J.ui`/`J.uiApi`,
referenced by none of the other 39 sources) and the editor's own `app/` and
`src/index.html` build outputs. Not bundled: mp4-muxer, which upstream embeds in
`index.html` for MP4 export, so `J.exportMP4`/`J.exportPNGZip` are present but must
never be called — the gate fails if Mineradio calls them. The engine is not
registered in `public/js/index-loader.js`: it is a standalone IIFE bundle for the
PV route, not a renderer module.

Known divergence from upstream, **not yet patched — the vendored bytes are pristine**:
`src/02_fonts.js:135` evaluates `document.createElement('canvas')` at module scope,
so the engine cannot be loaded in any realm without a document. Measured: it is the
only one of the 39 sources that fails to load in a Node worker, and planning output
is byte-identical when it does not load (the planner does not depend on that glyph
metrics object). A `typeof document` guard must be added there before the engine is
ever loaded outside the renderer (the archive prefetch route plans to do exactly
that); adding it will change the bundle sha1, so update
`vendor/jizura/engine-manifest.json` and this entry together.

## HALOFLUX data-ring visual preset (`public/js/modules/02-visual/18-halo-ring-preset.js`)

- Upstream: <https://github.com/Ryder191/haloflux> — "RYDER CODE / Ms MAIKEBAIs CAT"
- Reference revision: `225e2b2862b3d64ae9f6e0b012b27ccbe004e3d0` (2026-10-23; checked out locally at `G:\SoftwareFile\haloflux`)
- License: MIT (`Copyright (c) 2026 RYDER CODE / Ms MAIKEBAIs CAT`) — full text at `public/js/modules/02-visual/18-halo-ring-preset.LICENSE.txt`
- Port date: 2026-10-25

**No upstream file was vendored.** Unlike the JIZURA engine above — which is a
whole engine that Mineradio loads at runtime — this is an *element* port: the
upstream `lab.html` (94,575 B, sha1 `f5b3698e7fb6ba78836edc46a2e3a726b33970bc`)
was read as a specification and re-implemented against Mineradio's own audio
analysis, beat map, lyric timeline and frame gates. Mineradio's preset 14
(环形数据流 / RING DATA STREAM) draws into its own `#halo-layer` DOM canvas.

Ported elements, with their upstream anchors in `lab.html`:

| Element | Upstream anchor | Mineradio |
| --- | --- | --- |
| Ring with micro data panels | `buildCards` :829-839, `drawRing` :1007-1059 | `haloBuildSlots`, `haloRenderSlot`, `haloDrawRing` |
| Outer beam layers | `buildOuter` :521-530, `drawStrands` :616-649 | outer-beams section |
| Inner woven web / radial lines | `radialLines` :651-658, `hash` :650 | inner-web section |
| Comets | `spawnComet` :457-477, `strokeComet` :479-486 | `haloSpawnComet`, `haloDrawComets` |
| Fly-outs | `newFlyBand`/`newFlyer`/`spawnFlyBurst`/`drawFlyers` :659-722 | fly-outs section |
| Haze / root flares | :544-554, `updateOuter` :565-599, `onBeatOuter` :601-609 | haze-and-flares section |
| DOM callout | `drawCallout` :1191-1200 | `haloUpdateCalloutText`, `haloDrawCallout` |

Written for Mineradio, not ported: the audio-driven spectrum spokes, the lyric
dial (lyrics set radially around the circumference, the ring turning with the
line), the beat-driven camera moves, the three-phase beat clock, the panel
virtualization, and click-to-emit.

Deliberate divergences from upstream:

- **The glow buffer is gone.** Upstream composites a separate 1/3-resolution
  glow canvas and blurs it (`glow` :1.1 in `BAKED_MINE`). The port uses wide
  `lighter` strokes on the single canvas instead, so the layer costs one
  rasterization pass instead of two plus a blur.
- **Bokeh, atmosphere, vignette, ring shadow and depth blur are not ported.**
  Upstream's own finalized defaults (`BAKED_MINE`, 2026-10-21) set `bokeh`,
  `bokehBright`, `atmos`, `ringShadow`, `vignette`, `depthBlur` and `webBlur`
  to 0, so these are off in the look the author shipped.
- **Culling is analytic.** Upstream assumes an off-centre ring and culls with
  half-angle and half-plane tests (`thV`/`thS` :371-372). A centred Mineradio
  ring under a moving camera needs the analytic visible radius
  (`haloVisibleRadius`), or the beams are culled while still on screen.
- **The clock is real.** Upstream drives everything from a synthetic beat
  clock; the port drives it from Mineradio's offline/realtime beat map, and the
  comet's arrival is derived from the clock (`startAt`/`endAt`) so it lands on
  the drum hit rather than on the frame the launch happened to land on.
- **The callout shows lyrics.** Upstream draws small formulas; the port
  replaces them with the current lyric line and its translation.


## Visual preset 16「日本霓虹」(NEON FUJI) — reference reproduction

- Reference: <https://www.shadertoy.com/view/Wt33Wf> ("Cyber Fuji 2020")
- Reference author: kaiware007 (2020-01-28)
- Sun/grid functions credited upstream to: Jan Mróz (jaszunio15)
- Licence: Creative Commons Attribution 3.0 Unported (CC BY 3.0)
- Landing file: `public/js/modules/02-visual/21-neon-fuji-preset.js`
- Attribution sidecar: `public/js/modules/02-visual/21-neon-fuji-preset.LICENSE.txt`

The preset is a port of the reference source: `sun()`, `grid()`, the SDF helpers and the `mainImage` composition chain are kept in the reference's own order and expressions, and the reference's literals are exposed as knobs whose defaults are those literals — so a default-valued parameter set reproduces the reference frame. That claim is enforced, not asserted: `scripts/neon-fidelity-bench.js` renders the fixture `tests/fixtures/neon-fuji-reference.glsl` and the shipped fragment under the same uniforms and fails on the pixel difference (mean and worst-pixel limits). The lyric cars — text approaching the lens with an afterimage and a light band — are original. CC BY 3.0 requires attribution only, so no upstream licence text is bundled beyond the sidecar's attribution block and the licence links it names.
