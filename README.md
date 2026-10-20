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
| `bun test` | Headless tests (collision shapes, time control, scoring, slicing) |

Append `?q=low`, `?q=medium` or `?q=high` to the URL to force a graphics preset. You can also change it in Settings.

## Controls

| Keyboard / mouse | Gamepad | Action |
| --- | --- | --- |
| WASD / mouse | Left / right stick | Move / aim |
| Left click | RB / X | Slash: every swing throws a flying crescent |
| Right click | LB / LT | **Parry**. Hold to guard, or to catch a beam on the blade |
| E (hold) | RT | **Heaven Splitter**: charge, release, cut a canyon to the horizon |
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

Kills, parries and feats fill a style meter that climbs from **D**readful through **C**ataclysmic, **B**iblical, **A**pocalyptic, **S**overeign and **SS** Supreme to **SSS · Skycleaver**. Higher ranks multiply your score and intensify the music.

**Sandbox.** `1` Legion · `2` Arrowstorm · `3` Artillery · `4` Skyfleet · `5` Colossus · `6` Sol Lance · `7` Nuke · `8` Meteor shower · `9` The Moon · `0` immortality and full Divinity.

## What's in it

**Combat feel**
- Two clocks: hitstop freezes everything, *divine time* slows the world but not the hero, and Judgment stops world time completely
- A custom post-processing pass for flash frames, inverted and threshold impact frames, radial zoom punches, speed lines, chromatic kicks, screen-space shockwave distortion, desaturation and a damage vignette
- Trauma camera shake, FOV kicks and scripted cinematic shots (the nuke return, the finale)
- Afterimages from frozen skeleton copies, sword trails, a verlet-cloth coat and scarf

**Destruction**
- A real-time slicer: meshes are cloned into two halves clipped by the cut plane, the cut faces glow molten, and the halves topple, slide or tumble, crash and dissolve. Spires, cannons, airships, the Colossus (its posed skin is baked to static geometry first), the Sol Lance station and the moon can all be cut
- A scorch map: craters, fissures and beam trails burn into the ground and cool over time
- An instanced horde of up to 2,200 soldiers in one draw call, animated in the vertex shader, flung, sliced and vaporized
- Procedural mushroom clouds with a rolling toroidal cap, stem, base surge and condensation ring; shockwaves that travel at a visible speed and flatten everything in their band

**World**
- A scorched plain under an eclipse: domain-warped basalt cracks with lava seams, standing stone spires, the Dominion Citadel with searchlights and silos, mountain ridges, embers and ash
- A sky shader with the eclipse corona, lightning, a crack that splits the sky open and a dawn that replaces the eclipse with a true sun

**Audio (all procedural WebAudio)**
- Synthesized slashes, parry rings by tier, cannons, missiles, sirens, nuclear flashes with distance-delayed shock, beams, titan footsteps and roars
- A generative score in D minor whose layers rise with the wave and your style rank

## Architecture

```
src/
  engine/           reusable pieces
    rig/            skeleton + IK, pose clips, procedural models, cloth, trails
    gfx/            patched materials (molten cut faces), noise, textures, PowerFX post effect
    geom.ts         attack shapes (sphere, capsule, sector, slab, ring) and their tests
    particles.ts    pooled additive points and lit, depth-sorted billboard smoke
  game/
    Game.ts         systems, damage routing, threats, reflect targeting, the frame loop
    create.ts       wires every system and the sandbox spawn table
    time.ts         hitstop, divine time, slowmo, time stop
    camera.ts       follow camera, trauma, cinematic shots
    post.ts         drives the PowerFX uniforms
    player/         hero model, clips, controller, flying slashes
    enemies/        horde, arrows, projectiles (shells, missiles, nukes, meteors),
                    artillery, airships, colossus, orbital beam, Sol Lance, citadel, eclipse
    fx/             explosions, debris, afterimages, mushroom clouds, slicer
    world/          layout, sky, ground, scorch map, spires and mountains
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
