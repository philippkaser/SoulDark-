# SKYCLEAVER

*Parry the apocalypse.*

A browser action game about being absurdly overpowered, built with **Vite**, **Bun**, **React Three Fiber** and **drei**.

An empire of iron sends everything it has against one swordsman: a legion of thousands, arrowstorms, artillery, an airship fleet, a mountain-sized colossus, an orbital sun-cannon, its nuclear arsenal, and finally the eclipse itself. You parry the nukes back to their silos, catch orbital beams on your blade and aim them, cut the falling moon in half, and end the game by cleaving the sky open to let the dawn through.

Everything is generated procedurally at runtime: the models, animations, textures, sky, mushroom clouds, sound effects and music. The project ships no image, model or audio files.

## Quick start

```bash
bun install
bun run dev        # http://localhost:5173
```

Click **Begin the apocalypse** for the campaign, or **Sandbox** to summon anything on demand.

| Command | What it does |
| --- | --- |
| `bun run dev` | Vite dev server |
| `bun run build` | Production build into `dist/` (fully static, host it anywhere) |
| `bun run preview` | Serve the production build |
| `bun run typecheck` | TypeScript, no emit |
| `bun test` | Headless tests (collision shapes, time control, scoring, slicing, GPU particle motion, terrain, post effects, dolly-zoom, the sword arts' cut disc and the sky split, far-field slices and the Horizon Cut's aim, vibration merging, kill cams, returned warheads clearing the ground) |

Append `?q=low`, `?q=medium` or `?q=high` to the URL to force a graphics preset. You can also change it in Settings.

## Controls

| Keyboard / mouse | Gamepad | Action |
| --- | --- | --- |
| WASD / mouse | Left / right stick | Move / aim |
| Left click | RB / X | Slash: every swing throws a flying crescent |
| Right click | LB / LT | **Parry**. Hold to guard, or to catch a beam on the blade |
| E (hold) | RT | **Heaven Splitter**: charge, release, cut a canyon to the horizon |
| F (hold for Worldsplitter) | R3 | **Iai**: draw and sheathe in one stroke; everything around you falls apart. Hold for the **Worldsplitter** (50 Divinity) |
| R | L3 / D-pad up | **Horizon Cut** (30 Divinity): one level stroke at the height you look at; every peak above it comes off |
| Shift | B | Flash-step: untouchable; a beat after it stops, everything it passed through falls apart |
| Space | A | Leap (hold it: **Sky Leap**, straight up to ~65 m). Space again in the air: meteor dive, aimed at the crosshair from high up |
| Q | Y | **Judgment**, when Divinity is full: time stops, the hero cuts everything in sight, time resumes |
| Esc | Start | Pause |
| H | | Toggle the controls overlay |
| 1 – 9, 0 | | Sandbox summons, immortality |

## How it plays

**Parry everything.** Every threat in the game asks the hero what happens when it arrives. Press parry in the window and it goes back where it came from, aimed at whatever is under your crosshair. With nothing there, it goes back to its sender. Bigger threats give bigger windows and bigger spectacle. A perfect parry freezes the frame, flashes anime impact frames and slows the world while you keep moving, and the blade answers on its own: a crescent rolls back down the line the threat came in on, and a big parry cuts a ring of steel through everything within 160 m. Each perfect parry re-arms the window, so a whole missile salvo goes home in one chain. Hold guard instead and you block, but you get pushed back and take chip damage.

**The trials**

1. **The Legion.** Thousands of soldiers march in formation. Mow down 450.
2. **Arrowstorm.** Archer volleys darken the sky. A parry in the window deflects every arrow around you.
3. **Iron Thunder.** Artillery on the ridge. Parry the shells back into the cannons.
4. **The Skyfleet.** War airships fire missile salvos. Send the missiles home, or cut the ships in half.
5. **The Colossus.** A 36 m giant with a sword to match. Parry its slam and it staggers; a Heaven Splitter cuts it in two down the middle, an Iai across the waist, and the halves topple and crash.
6. **Sol Lance.** An orbital station fires a sun-beam. Parry it back up its own path, or hold guard to catch it and sweep it across the army.
7. **Doctrine of Annihilation.** The citadel launches nukes. Return a warhead to its silo for a mushroom cloud on the horizon and a shockwave that rolls back across the whole plain. Or cut it in half mid-air.
8. **The Eclipse.** Meteors, an eye that fires beams, and the moon dropped on your head: parry it home or cut it in half. When the eclipse falters, press Q.

**The sword arts.** Tap F for the **Iai**: the blade leaves its scabbard and goes home again faster than the eye. The cut races out as a ring of light to the horizon and the picture itself slides apart along it; on the click of the guard against the scabbard, everything within 420 m in the plane of the cut falls apart. Soldiers burn away, spires lose their tops, the Colossus is cut in two at the waist, and a falling moon comes apart in burning pieces. Look up and the plane of the cut tilts with you, through an airship fleet. Hold F instead and the blade goes up: the light poured into it climbs past the clouds while lightning crawls up its length and the rocks rise. Let go with 50 Divinity and the **Worldsplitter** brings a kilometre of light down on the world. It cuts a vertical sheet six kilometres long: a molten canyon through the plain and the mountain range behind it, the cloud deck split open to the stars from horizon to horizon, and anything in the sky along the line. Aimed at the eclipse during its fight, it cuts that too.

Every swing throws a crescent of light that swells as it flies and cuts everything in its path out to about 300 m; the combo finisher throws two at once, crossed.

**The Horizon Cut.** Look at the mountains and press R: one level stroke at that height, four kilometres out across the range in front of you. A glowing line races across every slope the cut passes through; on the click of the sheathe every peak above it shudders, grinds sideways along the cut with the seam glowing open, then collapses into its stump inside avalanches of dust and rubble, the thunder arriving late. The range is left as flat-topped mesas, molten on top, cooling over a minute. Anything flying at that height comes apart too.

**Sky Leap.** Hold jump and the hero breaks the sound barrier straight up, hanging high over the battlefield. From up there the dive goes where the crosshair is and comes down burning: a crater a hundred metres across, cracks racing out of it in every direction, and a shockwave that throws everything for a hundred metres.

**The little things.** The flash-step cuts nothing while it passes: a beat after it stops, cut lines flare across everything in its path and they fall apart together on the click. When the hero gathers power the clouds wind into a spiral storm with a glowing eye overhead, and the legion loses its nerve: the ranks back away from him, eyes on him, archers lowering their bows. At S rank arrows burn to embers in his aura before they reach him; from A rank every footfall at a run cracks the ground and leaves a glowing print. Stand still after a massacre and he flicks the blade clean, molten drops scorching the ground in an arc beside him.

Kills, parries and feats fill a style meter that climbs from **D**readful through **C**ataclysmic, **B**iblical, **A**pocalyptic, **S**overeign and **SS** Supreme to **SSS · Skycleaver**. Higher ranks multiply your score and intensify the music.

**Sandbox.** `1` Legion · `2` Arrowstorm · `3` Artillery · `4` Skyfleet · `5` Colossus · `6` Sol Lance · `7` Nuke · `8` Meteor shower · `9` The Moon · `0` immortality and full Divinity.

## What's in it

**Combat feel**
- Two clocks: hitstop freezes everything, *divine time* slows the world but not the hero, and Judgment stops world time completely
- A custom post-processing pass for flash frames, inverted and threshold impact frames, radial zoom punches, speed lines, chromatic kicks, up to six stacked refractive shock rings, world-anchored heat haze over burning ground, lens-edge chromatic fringe, desaturation and a damage vignette
- Screen-space volumetric light shafts: the eclipse corona pours through the citadel towers, the spires and the hero (half-resolution radial blur of the sky found through the depth buffer); nukes, the Sol Lance, the Heaven Splitter and the moon cleave throw a second, transient light whose shafts radiate through whatever stands in front of the blast
- Anamorphic lens streaks from the hottest pixels, kicked by parries and explosions
- Trauma camera shake, FOV kicks, directional kicks, a vertigo dolly-zoom on divine parries and scripted cinematic shots (the nuke return, the finale)
- Afterimages from frozen skeleton copies, sword trails, a verlet-cloth coat and scarf
- Feel (`game/feel.ts`): slash hitstop that grows with what a swing cuts down, the camera leaning into each swing, a lens punch on huge multi-kills, a bouncing camera on meteor-dive landings, and a flourish of light when the style rank reaches S, SS and SSS
- The flash-step breaks the sound barrier: a Prandtl-Glauert vapor cone snaps around the hero, a double-crack boom, dust ripped up along the path and a shock ring where he stops. Three steps inside 1.2 s chain into a bigger boom and a FLASH STEP feat
- Kill cams: when the Colossus falls, the Sol Lance explodes, the last airship of a fleet goes down or the citadel spire topples, the game drops into slow motion behind cinema bars for a short crane, orbit or over-the-shoulder shot. Any input skips it; it never interrupts another cinematic
- Controller vibration (toggle in Settings) on parries by tier, blocks, hits, nearby blasts (fading with distance), Colossus footsteps, slams, the Heaven Splitter, the Iai, the Worldsplitter's charge and strike, a caught beam and a nuke's shockwave
- A screen-space world cut: the frame slides apart along a line projected from the world (the Iai's plane, the Worldsplitter's sheet) and closes again with a molten seam

**Destruction**
- A real-time slicer: meshes are cloned into two halves clipped by the cut plane, the cut faces glow molten, and the halves topple, slide or tumble, crash and dissolve. Spires, cannons, airships, the Colossus (its posed skin is baked to static geometry first), the Sol Lance station and the moon can all be cut
- A scorch map: craters, fissures and beam trails burn into the ground and cool over time
- The Iai: a disc attack shape through everything around the hero, tilted with the aim, a ring of light racing out to 600 m, the cut lines flaring on everything caught before it falls, sparks thrown flat along the plane; horizontally cut spires slide off their stumps and topple like felled trees
- The Worldsplitter: a blade of light up to 1.8 km long that follows the sword through a slow, heavy swing, a vertical slab of damage 6 km long and 4 km tall, a curtain of light that tears out along the cut to the horizon, a canyon through the far field, dust walls peeling off both lips, a late flash and thunder where the cut meets the mountains, a release cinematic, and a sky shader that parts the cloud deck in a straight canyon and a blasted ring, healing over a minute and a half
- Explosions with a fireball made of several boiling lobes (two octaves of displacement, per-pixel soot crusting over fire seams), white-hot to orange to smoke, handing over to a heavy smoke column
- The Horizon Cut (`world/peaks.ts`): the far field above the cut, inside the arc swept, is split into one piece per peak along the valleys between them (every cell climbs to its peak; small basins merge), each its own mesh drawn by the ground's material in a cap mode (the old surface above the plane closed by a molten underside, the texture glued to the rock while it grinds and sinks). A ceiling texture flattens exactly what was cut, the rim shaved into a steep slope; the ground shader draws the cut line glowing where the plane meets a slope
- Deformable terrain: a heightfield the hero's power carves for real. Meteor-dive slams leave craters that grow with the fall, the Heaven Splitter and the Worldsplitter tear canyons to the horizon, shells, meteors, crashing airships and the Colossus's sword gouge the plain, the Sol Lance bores molten grooves, and a nuke or the moon leaves a bowl a hundred metres across. Crater walls turn to fractured, stratified rock; the hero, the legion, arrows, rubble, smoke and the camera all follow the ground
- An instanced horde of up to 2,200 soldiers in one draw call, animated in the vertex shader, flung, sliced and vaporized
- Procedural mushroom clouds with a rolling toroidal cap, stem, base surge and condensation ring; shockwaves that travel at a visible speed and flatten everything in their band

**Look**
- A depth pass ahead of the light shafts and bloom (`engine/gfx/atmosphere.ts`): ambient occlusion from a spiral of depth samples with normals rebuilt from depth (feet, spire bases and crater walls settle into contact shadow), and exponential ground haze integrated along every view ray, broken into drifting banks and lit warm toward the eclipse, so the plain fills with smoke and the ranges stack in layers
- A filmic grade after tone mapping: violet shadows, gold highlights, an S-curve, a breath more colour and fine film grain
- Rock spires with bedded ledges, fluting and broken crowns, shaded by a procedural basalt program (banded strata, fissures that glow where they meet the burning plain, ash lying on every ledge, a relief bump)
- The hero's plate is lacquered gunmetal under a clear coat with mirror gold trim and velvet-sheened cloth; filigree engraved into the plates fills with light as Divinity does

**World**
- A scorched plain under an eclipse: domain-warped basalt cracks with lava seams, standing stone spires, the Dominion Citadel with searchlights and silos, mountain ridges, embers and ash
- A sky shader with the eclipse corona, lightning, a crack that splits the sky open and a dawn that replaces the eclipse with a true sun
- A world eight kilometres across (`world/farField.ts`): a ridged multifractal mountain range on a 512² half-float heightfield, foothills from 600 m out and peaks near a kilometre, with the range behind the citadel kept low under the eclipse. The ground is one shader over two meshes, the arena's fine grid and a geometrically spaced grid out to the horizon, with procedural relief, rock strata, ash slopes and custom aerial perspective. `game.canyon(a, b, width, depth)` carves a sheer-walled slot through it, mountains included, and the shader draws each canyon's walls molten, cooling over a minute
- Molten ground drawn crisply at any distance: irregular cooling plates with glowing seams of varying width, fine cracks and liquid pools, procedural rather than sampled from the scorch map

**Audio (all procedural WebAudio)**
- Synthesized slashes, parry rings by tier, cannons, missiles, sirens, nuclear flashes with distance-delayed shock, beams, titan footsteps and roars
- A glue compressor and a brick-wall limiter on the master, the music ducking under huge booms, a generated wide-plain convolution reverb (late slap-backs off the ridges) that explosions and big hits are sent into, and ears that ring after a near nuke or the Worldsplitter (everything muffles under a thin tinnitus tone for a couple of seconds)
- A generative score in D minor whose layers rise with the wave and your style rank

## Architecture

```
src/
  engine/           reusable pieces
    rig/            skeleton + IK, pose clips, procedural models, cloth, trails
    gfx/            patched materials (molten cut faces), noise, textures, post effects (PowerFX, god rays, lens streaks)
    geom.ts         attack shapes (sphere, capsule, sector, slab, ring, cone, disc)
    particles.ts    pooled additive points and lit, depth-sorted billboard smoke
    gpuParticles.ts stateless GPU particles: closed-form motion on the world clock, ring-buffer uploads, streaks
  game/
    Game.ts         systems, damage routing, threats, reflect targeting, the frame loop
    create.ts       wires every system and the sandbox spawn table
    time.ts         hitstop, divine time, slowmo, time stop
    feel.ts         controller vibration, kill cams, the flash-step's sonic boom, multi-kill and rank-up feedback
    camera.ts       follow camera, trauma, kicks, dolly-zoom, cinematic shots
    post.ts         screen-effect requests (flash, shocks, haze, light shafts, streaks) feeding the post effects
    player/         hero model, clips, controller, flying slashes, the sword arts (arts.ts: the Iai, the Worldsplitter)
    enemies/        horde, arrows, projectiles (shells, missiles, nukes, meteors),
                    artillery, airships, colossus, orbital beam, Sol Lance, citadel, eclipse
    fx/             explosions, debris, afterimages, mushroom clouds, slicer,
                    particleFx.ts: the spark / ember / mote vocabulary on the GPU pools,
                    swordFx.ts: the Iai's ring of light, the Worldsplitter's blade and curtain, shock rings; shards.ts: a moon cut to pieces
    world/          layout, sky, ground, scorch map, terrain heightfield, the far field and its mountains,
                    peaks.ts: mountaintops cut off by the Horizon Cut; spires
    waves.ts        the eight trials
    director.ts     title attract mode, campaign/sandbox switching
    score.ts        style ranks, combo, feed, tally
  ui/               title, HUD (canvas overlay + DOM), menus, death and results screens
  audio/            procedural sound effects and generative music
  input/            keyboard, mouse (pointer lock) and gamepad
tests/              bun tests
```

## Development hooks

- `?debug=poses&clip=slash2&t=0,0.1,0.2` renders the hero's animation clips frame by frame.
- In dev builds, `window.__sky` exposes `{ game, input, ui, THREE, step }`. `step(seconds)` advances the simulation deterministically at 60 Hz, and `input.tap('Mouse2')` injects a press. That is enough to script a perfect nuke parry from a test.
