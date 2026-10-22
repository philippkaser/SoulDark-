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
| `bun test` | Headless tests (collision shapes, time control, scoring, slicing, GPU particle motion, terrain, post effects, dolly-zoom, the punch's wave and the sky split, vibration merging, kill cams, returned warheads clearing the ground) |

Append `?q=low`, `?q=medium` or `?q=high` to the URL to force a graphics preset. You can also change it in Settings.

## Controls

| Keyboard / mouse | Gamepad | Action |
| --- | --- | --- |
| WASD / mouse | Left / right stick | Move / aim |
| Left click | RB / X | Slash: every swing throws a flying crescent |
| Right click | LB / LT | **Parry**. Hold to guard, or to catch a beam on the blade |
| E (hold) | RT | **Heaven Splitter**: charge, release, cut a canyon to the horizon |
| F (hold for Serious) | R3 | **Punch**: a jab of air that flings everything in front of you. Hold to coil a **Serious Punch** (50 Divinity) |
| Shift | B | Flash-step (untouchable, cuts through anything in the way) |
| Space | A | Leap. Space again in the air: meteor dive |
| Q | Y | **Judgment**, when Divinity is full: time stops, the hero cuts everything in sight, time resumes |
| Esc | Start | Pause |
| H | | Toggle the controls overlay |
| 1 – 9, 0 | | Sandbox summons, immortality |

## How it plays

**Parry everything.** Every threat in the game asks the hero what happens when it arrives. Press parry in the window and it goes back where it came from, aimed at whatever is under your crosshair. With nothing there, it goes back to its sender. Bigger threats give bigger windows and bigger spectacle. A perfect parry freezes the frame, flashes anime impact frames and slows the world while you keep moving. Each perfect parry re-arms the window, so a whole missile salvo goes home in one chain. Hold guard instead and you block, but you get pushed back and take chip damage.

**The trials**

1. **The Legion.** Thousands of soldiers march in formation. Mow down 450.
2. **Arrowstorm.** Archer volleys darken the sky. A parry in the window deflects every arrow around you.
3. **Iron Thunder.** Artillery on the ridge. Parry the shells back into the cannons.
4. **The Skyfleet.** War airships fire missile salvos. Send the missiles home, or cut the ships in half.
5. **The Colossus.** A 36 m giant with a sword to match. Parry its slam and it staggers; a Heaven Splitter cuts it in two, and the halves topple and crash.
6. **Sol Lance.** An orbital station fires a sun-beam. Parry it back up its own path, or hold guard to catch it and sweep it across the army.
7. **Doctrine of Annihilation.** The citadel launches nukes. Return a warhead to its silo for a mushroom cloud on the horizon and a shockwave that rolls back across the whole plain. Or cut it in half mid-air.
8. **The Eclipse.** Meteors, an eye that fires beams, and the moon dropped on your head: parry it home or cut it in half. When the eclipse falters, press Q.

**One punch.** Tap F and the air in front of your fist goes off like a gunshot: soldiers fly, arrows and shells are swatted out of the sky. Hold it and the hero coils, the ground gives and the rocks rise; let go with 50 Divinity and the Serious Punch throws a pressure wave out to the horizon at 900 m/s. It tears a trench across the plain, vaporizes everything in a widening cone, bores straight through the mountains and splits the cloud deck overhead from horizon to horizon. It breaks a falling moon into burning pieces, punches the Colossus in two, and aimed at the eclipse during its fight, it hurts.

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
- Controller vibration (toggle in Settings) on parries by tier, blocks, hits, nearby blasts (fading with distance), Colossus footsteps, slams, the Heaven Splitter, the punch's coil and release, a caught beam and a nuke's shockwave

**Destruction**
- A real-time slicer: meshes are cloned into two halves clipped by the cut plane, the cut faces glow molten, and the halves topple, slide or tumble, crash and dissolve. Spires, cannons, airships, the Colossus (its posed skin is baked to static geometry first), the Sol Lance station and the moon can all be cut
- A scorch map: craters, fissures and beam trails burn into the ground and cool over time
- The Serious Punch: a pressure wave swept through the world as a cone that widens with distance (a dedicated attack shape), with a travelling shock arch, a corridor of pressure rings, a vapor cone at the fist, a trench and dust walls torn along its path, a release cinematic, and a sky shader that parts the cloud deck in a straight canyon and a blasted ring, healing over a minute and a half
- Deformable terrain: a heightfield the hero's power carves for real. Meteor-dive slams leave craters that grow with the fall, the Heaven Splitter tears a canyon to the horizon, shells, meteors, crashing airships and the Colossus's sword gouge the plain, the Sol Lance bores molten grooves, and a nuke or the moon leaves a bowl a hundred metres across. Crater walls turn to fractured, stratified rock; the hero, the legion, arrows, rubble, smoke and the camera all follow the ground
- An instanced horde of up to 2,200 soldiers in one draw call, animated in the vertex shader, flung, sliced and vaporized
- Procedural mushroom clouds with a rolling toroidal cap, stem, base surge and condensation ring; shockwaves that travel at a visible speed and flatten everything in their band

**World**
- A scorched plain under an eclipse: domain-warped basalt cracks with lava seams, standing stone spires, the Dominion Citadel with searchlights and silos, mountain ridges, embers and ash
- A sky shader with the eclipse corona, lightning, a crack that splits the sky open and a dawn that replaces the eclipse with a true sun
- Two rings of solid mountains (`world/ridge.ts`, `world/mountains.ts`): a polar heightfield with a ridged-noise crest, gullied cliffs, strata, seeping lava veins, an eclipse rim light and their own aerial perspective. A punch wave bores real tunnels through them (`game.boreMountains(origin, dir, radius, speed)`): the rock shader discards a ragged cylinder when the wave arrives, a molten tube lines the tunnel, fractures race out from the hole, slabs and a dust surge pour down the slopes, and the thunder arrives at the speed of sound. A full Heaven Splitter cuts a slot down from the crest, and the eclipse light pours through whatever you open

**Audio (all procedural WebAudio)**
- Synthesized slashes, parry rings by tier, cannons, missiles, sirens, nuclear flashes with distance-delayed shock, beams, titan footsteps and roars
- A glue compressor and a brick-wall limiter on the master, the music ducking under huge booms, a generated wide-plain convolution reverb (late slap-backs off the ridges) that explosions and big hits are sent into, and ears that ring after a near nuke or a Serious Punch (everything muffles under a thin tinnitus tone for a couple of seconds)
- A generative score in D minor whose layers rise with the wave and your style rank

## Architecture

```
src/
  engine/           reusable pieces
    rig/            skeleton + IK, pose clips, procedural models, cloth, trails
    gfx/            patched materials (molten cut faces), noise, textures, post effects (PowerFX, god rays, lens streaks)
    geom.ts         attack shapes (sphere, capsule, sector, slab, ring) and their tests
    particles.ts    pooled additive points and lit, depth-sorted billboard smoke
    gpuParticles.ts stateless GPU particles: closed-form motion on the world clock, ring-buffer uploads, streaks
  game/
    Game.ts         systems, damage routing, threats, reflect targeting, the frame loop
    create.ts       wires every system and the sandbox spawn table
    time.ts         hitstop, divine time, slowmo, time stop
    feel.ts         controller vibration, kill cams, the flash-step's sonic boom, multi-kill and rank-up feedback
    camera.ts       follow camera, trauma, kicks, dolly-zoom, cinematic shots
    post.ts         screen-effect requests (flash, shocks, haze, light shafts, streaks) feeding the post effects
    player/         hero model, clips, controller, flying slashes, the fist (punch.ts: jab, Serious Punch, its wave)
    enemies/        horde, arrows, projectiles (shells, missiles, nukes, meteors),
                    artillery, airships, colossus, orbital beam, Sol Lance, citadel, eclipse
    fx/             explosions, debris, afterimages, mushroom clouds, slicer,
                    particleFx.ts: the spark / ember / mote vocabulary on the GPU pools,
                    punchFx.ts: pressure rings, vapor cones, the shock arch; shards.ts: a punched moon
    world/          layout, sky, ground, scorch map, terrain heightfield, spires and mountains
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
