# SOULDARK

*Fear not the dark.*

A souls-like action game for the browser, built with **Vite**, **Bun**, **React Three Fiber** and **drei**, and playable in co-op.

The fire fades and an eclipse hangs over a ruined cathedral. Kindle the bonfire, cut your way through the graveyard of the hollowed, pass the Fallen Knight who guards the white fog, and face **Malgrave, the Ashen Warden**. You can do it alone, or with friends as golden phantoms.

Everything is generated procedurally at runtime: the models, animations, textures, sky, architecture, sound effects and music. The project ships no image, model or audio files.

## Quick start

```bash
bun install
bun run dev        # game server on :3001 + Vite on :5173
```

Open <http://localhost:5173>, name your knight and **Enter the world**. Send a friend the same address and world name to play together.

Production build, with the client and WebSocket server on one port:

```bash
bun run build
bun run start      # http://localhost:3001   (PORT=xxxx to change)
```

If no server is reachable (for example on static hosting), the game runs the same world simulation inside the browser and you play offline.

| Command | What it does |
| --- | --- |
| `bun run dev` | Bun game server (watch mode) and Vite dev server |
| `bun run build` | Production client build into `dist/` |
| `bun run start` | Serves `dist/` and the `/ws` game socket from one Bun process |
| `bun run typecheck` | TypeScript, no emit |
| `bun test` | Headless tests of the shared world simulation |

Append `?q=low`, `?q=medium` or `?q=high` to the URL to force a graphics preset. You can also change it in Settings.

## Controls

| Keyboard / mouse | Gamepad | Action |
| --- | --- | --- |
| WASD / mouse | Left / right stick | Move / camera |
| Shift (hold) | B (hold) | Sprint |
| Space | B (tap) | Roll (backstep with no direction) |
| Left click | RB | Light attack, chains a 3-hit combo |
| Right click | RT | Heavy attack (hyper armor) |
| F | LB / LT | Parry with the shield; then attack to **riposte** |
| Q / middle click | R3 | Lock on (mouse wheel or a stick flick switches target) |
| R | X | Drink from the Estus Flask |
| E | A | Interact: rest at the bonfire, traverse fog, read messages, touch bloodstains |
| G | Y | Gestures (Praise the Sun!) |
| T | Back | Write a message on the ground |
| Enter | | Chat |
| Esc | Start | Menu |
| H | | Toggle the controls overlay |

## What's in it

**Combat**
- Input buffering, combo windows, roll-cancel windows and stamina gating
- Roll and backstep invincibility frames; heavy attacks have hyper armor
- Parries open enemies to visceral ripostes. Break the Warden's poise to riposte him too
- Swept-blade hit detection: the actual sword arc is tested against enemy capsules, so a hit lands when the blade connects
- Hitstop, trauma-based camera shake, sparks, blood, sword trails and dissolve-to-ash deaths
- Enemies telegraph their attacks with wind-ups, track you during the wind-up and then commit, so rolling through attacks is a skill
- Estus Flask, souls, bloodstains to recover your lost souls, and leveling at the bonfire (Vigor / Endurance / Strength)

**Enemies**
- *Hollow Soldiers*, who kneel hollowed until you come near, then rise, circle you and hack
- The *Fallen Knight*: shield, combos, a lunging thrust and a shield bash
- *Malgrave, the Ashen Warden*, a 4.6 m boss with cleaves, sweeps, a charging thrust, a leaping slam and a stomp. At half health he roars, his blade ignites, and he adds a fire nova and a three-hit whirlwind. Braziers light up around the arena, the fog seals behind you, and a generative score plays.

**Multiplayer (Bun WebSockets)**
- Every player in the same world sees the others as glowing golden phantoms, with name labels and full animations
- Enemies, the boss fight and the fog gate are simulated on the server, so everyone fights the same enemies; boss HP scales with the number of players
- Each client is authoritative over its own movement and the damage it takes, the same model the Souls games use. That keeps dodging fair under latency. The server validates hits and owns enemy health.
- *Orange soapstone messages*: compose them from templates, engrave them on the ground, read and appraise others' messages (appraising heals the author). Messages persist on disk per world.
- *Bloodstains*: when someone dies, a pool of red appears in everyone else's world. Touch it to watch a red ghost replay their last moments.
- Text chat, join/leave notices, and separate worlds by name

**Visuals (all procedural)**
- An eclipse with a burning corona, god rays, drifting clouds and stars
- A procedural ground shader: radial flagstones at the shrine and arena, running-bond slabs on the road, cobbles through the graveyard, eroding into dirt and dead grass, with mossy grout, cracks and puddles
- Triplanar-textured gothic ruins: fluted and broken columns, pointed-arch arcades, the gate towers, walls with lancet windows, a weathered knight statue, dead trees, cliffs and a distant cathedral with glowing windows
- Wind-blown grass that parts around you, ground mist, embers and falling ash
- Characters built on a procedural IK rig: armor with rim light, painted heater shields, verlet-cloth capes and tabards
- Post-processing: N8AO ambient occlusion, bloom, AgX tone mapping, grading, chromatic aberration, vignette, film grain, SMAA

**Audio (all procedural WebAudio)**
- Sword whooshes, flesh and armor hits, parry rings, footsteps with chain-mail jingle, roars, slams, explosions
- Wind and bonfire crackle ambience, distant bells on the title screen
- A generative boss theme (choir pads, string ostinato, war drums) that intensifies in phase two

## Architecture

```
shared/           deterministic game simulation used by server AND browser
  level.ts        zones, obstacles, enemy spawns
  collision.ts    union-of-zones walkable area, circle/box push-out, camera ray test
  combat.ts       player actions, enemy attacks (timings, hit arcs, AoEs), stats
  room.ts         the world: enemy AI state machines, boss flow, messages, bloodstains
  protocol.ts     network message types and message templates
server/index.ts   Bun.serve: WebSocket rooms at /ws, static dist/, /api/status
src/
  net/            NetClient (WebSocket or in-browser Room) + snapshot sync
  game/
    session.ts    per-frame orchestration: input, player, enemies, phantoms, fx, camera
    player/       player controller (actions, buffering, hit detection, damage)
    rig/          skeleton + two-bone IK, pose clips, models, cloth, trails
    env/          sky, ground shader, architecture, bonfire, grass, atmosphere
    fx/           particle and shockwave system
  ui/             title screen, HUD, menus
  audio/          procedural sound and music
tests/            bun tests for the simulation
```

The server runs enemies at 30 Hz and broadcasts snapshots at 20 Hz. Clients render remote entities 110 ms in the past and interpolate between snapshots. Enemy animations are driven by server timestamps, so a swing looks the same on every screen and matches its hitbox.
