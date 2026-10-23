import { clamp } from '../../engine/math'
import { pullVec, registerClipSet, sw, type ClipDef } from '../../engine/rig/clips'
import { S, type Pose, type PoseSpec } from '../../engine/rig/pose'

/**
 * The hero's moveset. Chest space: +x = the hero's left, +y up, +z forward.
 * Everything is quick and committed: hits land within the first ~0.1 s.
 */

export const HERO_STANCE: PoseSpec = {
  rootY: -0.03,
  spineX: 0.06,
  chestY: 0.12,
  headX: -0.04,
  thighLX: -0.16,
  thighLZ: 0.07,
  kneeL: 0.22,
  footL: -0.06,
  thighRX: 0.1,
  thighRZ: -0.07,
  kneeR: 0.18,
  footR: -0.1,
  lowerY: 0.2,
  handR: [-0.33, -0.36, 0.1],
  bladeR: [-0.35, -0.42, -1],
  edgeR: [0, -1, 0.3],
  poleR: [-0.7, -0.2, -0.4],
  handL: [0.27, -0.32, 0.06],
  bladeL: [0.1, -1, 0.25],
  edgeL: [0, 0, 1],
  poleL: [0.75, -0.3, -0.3],
}

const BRACED: PoseSpec = { rootY: -0.1, thighLX: -0.42, kneeL: 0.62, thighRX: 0.36, kneeR: 0.48, lowerY: 0.45 }

const slash1: ClipDef = {
  dur: 0.42,
  keys: [
    [0.045, sw([-0.5, 0.12, -0.04], [-0.95, 0.22, -0.3], 'rl', { chestY: -0.6, spineY: -0.2, hipsY: -0.15, thighLX: -0.32, kneeL: 0.42, thighRX: 0.22, kneeR: 0.3, rootY: -0.07, handL: [0.3, -0.05, 0.22] })],
    [0.09, sw([-0.3, 0.06, 0.44], [-0.35, 0.06, 1], 'rl', { chestY: -0.2, spineY: -0.06 })],
    [0.13, sw([0.06, 0.03, 0.52], [0.45, 0.0, 1], 'rl', { chestY: 0.28, spineY: 0.08 })],
    [0.18, sw([0.3, 0.0, 0.32], [1, -0.08, 0.12], 'rl', { chestY: 0.62, spineY: 0.16, handL: [0.36, -0.1, -0.05] })],
    [0.3, sw([0.32, -0.08, 0.18], [0.82, -0.3, -0.42], 'rl', { chestY: 0.62 })],
    [0.42, {}],
  ],
}

const slash2: ClipDef = {
  dur: 0.42,
  keys: [
    [0.045, sw([0.22, 0.06, 0.2], [0.92, 0.14, -0.35], 'lr', { chestY: 0.55, spineY: 0.16, rootY: -0.07, thighRX: -0.4, kneeR: 0.45, thighLX: 0.22, kneeL: 0.3, poleR: [-0.3, -0.8, -0.2] })],
    [0.09, sw([0.08, 0.08, 0.48], [0.55, 0.1, 1], 'lr', { chestY: 0.28, spineY: 0.08 })],
    [0.13, sw([-0.22, 0.1, 0.5], [-0.42, 0.18, 1], 'lr', { chestY: -0.12, spineY: -0.04, poleR: [-0.7, -0.4, -0.4] })],
    [0.18, sw([-0.46, 0.13, 0.28], [-1, 0.26, 0.15], 'lr', { chestY: -0.5, spineY: -0.14 })],
    [0.3, sw([-0.48, 0.05, 0.08], [-0.78, 0.3, -0.55], 'lr', { chestY: -0.55 })],
    [0.42, {}],
  ],
}

const slash3: ClipDef = {
  dur: 0.46,
  keys: [
    [0.05, sw([0.16, -0.3, 0.3], [0.62, -0.68, 0.42], 'rising', { chestY: 0.42, rootY: -0.12, spineX: 0.22, thighLX: -0.5, kneeL: 0.7, thighRX: 0.3, kneeR: 0.5 })],
    [0.1, sw([-0.04, -0.1, 0.5], [0.12, -0.22, 1], 'rising', { chestY: 0.1, spineX: 0.1 })],
    [0.14, sw([-0.26, 0.22, 0.45], [-0.5, 0.52, 0.8], 'rising', { chestY: -0.15, spineX: -0.05, rootY: -0.03 })],
    [0.19, sw([-0.4, 0.5, 0.18], [-0.6, 0.82, -0.12], 'rising', { chestY: -0.38, spineX: -0.15, rootY: 0.02 })],
    [0.34, sw([-0.38, 0.46, 0.1], [-0.5, 0.82, -0.3], 'rising')],
    [0.46, {}],
  ],
}

const slash4: ClipDef = {
  dur: 0.66,
  keys: [
    [0.1, sw([-0.08, 0.56, -0.04], [0.04, 0.5, -1], 'chop', { twoHand: 1, spineX: -0.2, chestX: -0.12, chestY: 0, headX: -0.15, rootY: 0.04, poleR: [-0.8, 0.2, -0.2], poleL: [0.8, 0.2, -0.2], thighLX: -0.5, kneeL: 0.6 })],
    [0.17, sw([-0.06, 0.58, 0.08], [0.02, 0.92, -0.32], 'chop', { twoHand: 1 })],
    [0.22, sw([-0.05, 0.3, 0.46], [0, 0.55, 0.85], 'chop', { twoHand: 1, spineX: 0.12, chestX: 0, rootY: -0.1, poleR: [-0.7, -0.4, -0.2], poleL: [0.75, -0.4, -0.2] })],
    [0.26, sw([-0.05, -0.02, 0.56], [0, -0.3, 1], 'chop', { twoHand: 1, spineX: 0.45, rootY: -0.2, thighLX: -0.75, kneeL: 0.9, thighRX: 0.45, kneeR: 0.5 })],
    [0.3, sw([-0.05, -0.3, 0.46], [0, -0.85, 0.5], 'chop', { twoHand: 1, spineX: 0.65, rootY: -0.3 })],
    [0.52, sw([-0.06, -0.32, 0.44], [0.02, -0.82, 0.55], 'chop', { twoHand: 1 })],
    [0.66, {}],
  ],
}

const airslash: ClipDef = {
  dur: 0.36,
  keys: [
    [0.04, sw([-0.42, 0.45, 0.05], [-0.5, 0.75, -0.4], 'diag', { chestY: -0.45, spineX: -0.1, thighLX: -0.8, kneeL: 1.1, thighRX: -0.3, kneeR: 0.9 })],
    [0.09, sw([-0.25, 0.25, 0.45], [-0.3, 0.45, 0.85], 'diag', { chestY: -0.15 })],
    [0.13, sw([0.02, -0.05, 0.55], [0.4, -0.35, 1], 'diag', { chestY: 0.2, spineX: 0.3 })],
    [0.18, sw([0.26, -0.24, 0.36], [0.85, -0.6, 0.2], 'diag', { chestY: 0.5, spineX: 0.4 })],
    [0.36, {}],
  ],
}

const AIR: PoseSpec = {
  thighLX: -0.75,
  kneeL: 1.15,
  thighRX: -0.2,
  kneeR: 0.85,
  footR: 0.3,
  spineX: 0.12,
  lowerY: 0,
  handR: [-0.42, 0.04, 0.08],
  bladeR: [-0.9, 0.25, -0.35],
  edgeR: [0, 1, 0],
  handL: [0.36, 0.0, 0.12],
}

const tremble = (amp: number) => (out: Pose, t: number) => {
  out[S.spineZ] += Math.sin(t * 61) * amp
  out[S.headZ] += Math.sin(t * 47 + 1) * amp * 1.4
  out[S.rootY] += Math.sin(t * 38) * amp * 0.3
}

/** Blade raised overhead in both hands: the Heaven Splitter's and the Worldsplitter's charge. */
const RAISED: PoseSpec = {
  twoHand: 1,
  handR: [-0.06, 0.56, 0.06],
  bladeR: [0.04, 1, 0.06],
  edgeR: [0, 0, 1],
  poleR: [-0.85, 0.1, -0.2],
  poleL: [0.85, 0.1, -0.2],
  thighLX: -0.35,
  thighLZ: 0.22,
  kneeL: 0.5,
  thighRX: 0.3,
  thighRZ: -0.22,
  kneeR: 0.45,
  rootY: -0.1,
  spineX: -0.06,
  chestY: 0,
  headX: -0.12,
  lowerY: 0.2,
}

/** Low, the hand on the hilt at the left hip, the blade still in its scabbard. */
const IAI_SET: PoseSpec = {
  rootY: -0.24,
  spineX: 0.32,
  chestY: -0.28,
  headX: -0.12,
  handR: [0.12, -0.18, 0.2],
  bladeR: [-0.35, -0.12, -1],
  edgeR: [0, 1, 0],
  poleR: [-0.4, -0.6, -0.4],
  handL: [0.2, -0.16, 0.12],
  thighLX: -0.62,
  kneeL: 0.92,
  thighRX: 0.52,
  kneeR: 0.44,
  lowerY: 0.48,
}

/**
 * The Iai: the hilt comes forward, the blade leaves the scabbard and crosses
 * the whole front in one flat stroke, holds, and goes home with a click.
 */
const iaiDraw: ClipDef = {
  dur: 0.62,
  keys: [
    [0.03, { ...IAI_SET, handR: [0.15, -0.08, 0.38], bladeR: [0.2, -0.05, -1] }],
    [0.048, sw([0.1, 0.0, 0.46], [0.95, 0.0, 0.3], 'lr', { ...IAI_SET, chestY: 0.1, handL: [0.24, -0.2, -0.02] })],
    [0.062, sw([-0.06, 0.02, 0.52], [0.2, 0.03, 1], 'lr', { chestY: -0.15, spineY: -0.05 })],
    [0.08, sw([-0.36, 0.04, 0.42], [-0.7, 0.05, 0.7], 'lr', { chestY: -0.4, spineY: -0.12 })],
    [0.1, sw([-0.5, 0.05, 0.3], [-1, 0.05, 0.2], 'lr', { rootY: -0.26, chestY: -0.56, spineY: -0.16, spineX: 0.22, thighLX: -0.7, kneeL: 0.96, thighRX: 0.56, kneeR: 0.4, handL: [0.26, -0.1, 0.04] })],
    [0.3, sw([-0.5, 0.03, 0.28], [-1, 0.0, 0.25], 'lr', { rootY: -0.25, chestY: -0.5 })],
    [0.42, { ...IAI_SET, rootY: -0.14, spineX: 0.16 }],
    [0.62, {}],
  ],
}

/** The Worldsplitter: rear back under a kilometre of light, then bring it down on the world. */
const worldsplit: ClipDef = {
  dur: 1.25,
  keys: [
    [0.0, RAISED],
    [0.2, { ...RAISED, handR: [-0.06, 0.6, -0.04], bladeR: [0.03, 0.9, -0.42], spineX: -0.2, chestX: -0.08, headX: -0.3, rootY: -0.04 }],
    [0.3, sw([-0.05, 0.48, 0.34], [0, 0.66, 0.74], 'chop', { twoHand: 1, spineX: 0.05 })],
    [0.36, sw([-0.05, 0.12, 0.56], [0, -0.1, 1], 'chop', { twoHand: 1, spineX: 0.42, rootY: -0.24, thighLX: -0.9, kneeL: 1.05, thighRX: 0.52, kneeR: 0.62, poleR: [-0.7, -0.4, -0.2], poleL: [0.75, -0.4, -0.2] })],
    [0.44, sw([-0.05, 0.02, 0.55], [0, -0.2, 1], 'chop', { twoHand: 1, spineX: 0.5, rootY: -0.32 })],
    [0.95, sw([-0.05, 0.0, 0.54], [0, -0.22, 1], 'chop', { twoHand: 1, spineX: 0.46 })],
    [1.25, {}],
  ],
}

const HERO_CLIPS: Record<string, ClipDef> = {
  iaiDraw,
  worldsplit,
  // the blade flicked clean after a massacre: raised out to the right, snapped down, held
  chiburi: {
    dur: 0.8,
    keys: [
      [0.12, sw([-0.42, 0.3, 0.26], [-0.6, 0.72, 0.3], 'lr', { chestY: -0.3, spineX: 0.02 })],
      [0.2, sw([-0.5, -0.14, 0.3], [-0.72, -0.62, 0.32], 'lr', { chestY: -0.38, rootY: -0.08, headY: -0.25 })],
      [0.55, sw([-0.48, -0.16, 0.28], [-0.7, -0.64, 0.3], 'lr', { chestY: -0.34, rootY: -0.06, headY: -0.2 })],
      [0.8, {}],
    ],
  },
  slash1,
  slash2,
  slash3,
  slash4,
  airslash,
  parry: {
    dur: 0.3,
    keys: [
      [0.035, sw([-0.12, 0.12, 0.44], [0.12, 1, 0.28], 'lr', { chestY: 0.05, spineX: 0.08, ...BRACED, handL: [0.2, 0.0, 0.3] })],
      [0.1, sw([0.12, 0.22, 0.4], [0.75, 0.68, 0.15], 'lr', { chestY: 0.4 })],
      [0.2, sw([0.18, 0.15, 0.32], [0.8, 0.5, -0.1], 'lr')],
      [0.3, {}],
    ],
  },
  guard: {
    dur: 1,
    loop: true,
    keys: [[0.06, { twoHand: 1, handR: [-0.12, 0.06, 0.38], bladeR: [0.55, 0.78, 0.28], edgeR: [-0.2, 0.1, 1], poleR: [-0.7, -0.5, -0.2], poleL: [0.7, -0.5, -0.2], chestY: 0.1, spineX: 0.12, ...BRACED }]],
    proc: tremble(0.006),
  },
  catch: {
    dur: 1,
    loop: true,
    keys: [
      [
        0.08,
        {
          twoHand: 1,
          handR: [-0.2, 0.52, 0.22],
          bladeR: [1, 0.12, 0.15],
          edgeR: [0, 1, 0],
          poleR: [-0.8, 0.0, -0.3],
          poleL: [0.8, 0.0, -0.3],
          rootY: -0.3,
          thighLX: -0.75,
          kneeL: 1.1,
          thighRX: 0.35,
          kneeR: 0.95,
          lowerY: 0.5,
          spineX: 0.1,
          headX: -0.35,
        },
      ],
    ],
    proc: tremble(0.02),
  },
  dash: {
    dur: 0.22,
    hold: true,
    keys: [[0.04, { spineX: 0.55, headX: -0.3, rootY: -0.12, handR: [-0.3, -0.12, -0.3], bladeR: [-0.15, 0.05, -1], edgeR: [0, 1, 0], handL: [0.28, -0.1, 0.25], thighLX: -0.7, kneeL: 0.9, thighRX: 0.6, kneeR: 0.3, lowerY: 0 }]],
  },
  air: { dur: 1, loop: true, keys: [[0.12, AIR]] },
  fall: { dur: 1, loop: true, keys: [[0.2, { ...AIR, thighLX: -0.35, kneeL: 0.5, thighRX: 0.1, kneeR: 0.4, footR: 0, handR: [-0.45, 0.15, 0.0], bladeR: [-0.95, 0.35, -0.2] }]] },
  dive: {
    dur: 1,
    loop: true,
    keys: [[0.08, { twoHand: 1, handR: [-0.05, 0.05, 0.32], bladeR: [0, -1, 0.12], edgeR: [0, 0, 1], poleR: [-0.7, 0.2, -0.3], poleL: [0.7, 0.2, -0.3], thighLX: -1.1, kneeL: 1.7, thighRX: -0.85, kneeR: 1.6, spineX: 0.4, headX: 0.2, lowerY: 0 }]],
  },
  land: {
    dur: 0.62,
    keys: [
      [0.05, { rootY: -0.58, thighLX: -1.45, kneeL: 2.2, thighRX: 0.35, kneeR: 2.0, footR: 0.65, lowerY: 0.1, spineX: 0.62, headX: -0.45, handR: [-0.3, -0.36, 0.32], bladeR: [-0.15, -1, 0.25], edgeR: [0, 0, 1], handL: [0.3, -0.5, 0.36], bladeL: [0, -1, 0.3] }],
      [0.36, { headX: -0.35 }],
      [0.62, {}],
    ],
  },
  charge: { dur: 1, loop: true, keys: [[0.12, RAISED]], proc: tremble(0.012) },
  cleave: {
    dur: 0.62,
    keys: [
      [0.0, RAISED],
      [0.05, sw([-0.05, 0.46, 0.36], [0, 0.62, 0.78], 'chop', { twoHand: 1, spineX: 0.05 })],
      [0.09, sw([-0.05, 0.02, 0.56], [0, -0.28, 1], 'chop', { twoHand: 1, spineX: 0.45, rootY: -0.2, poleR: [-0.7, -0.4, -0.2], poleL: [0.75, -0.4, -0.2] })],
      [0.13, sw([-0.05, -0.32, 0.46], [0, -0.86, 0.5], 'chop', { twoHand: 1, spineX: 0.7, rootY: -0.34, thighLX: -0.85, kneeL: 1.05, thighRX: 0.5, kneeR: 0.6 })],
      [0.5, sw([-0.06, -0.33, 0.45], [0.02, -0.84, 0.52], 'chop', { twoHand: 1 })],
      [0.62, {}],
    ],
  },
  hurt: {
    dur: 0.34,
    keys: [
      [0.06, { spineX: -0.3, chestX: -0.14, headX: -0.4, rootY: -0.07, chestY: 0.2 }],
      [0.2, { spineX: -0.1, headX: -0.1 }],
      [0.34, {}],
    ],
  },
  iai: {
    dur: 1,
    loop: true,
    keys: [
      [
        0.25,
        {
          rootY: -0.26,
          spineX: 0.35,
          chestY: -0.3,
          headX: -0.15,
          handR: [0.12, -0.18, 0.2],
          bladeR: [-0.35, -0.12, -1],
          edgeR: [0, 1, 0],
          poleR: [-0.4, -0.6, -0.4],
          handL: [0.2, -0.16, 0.12],
          thighLX: -0.65,
          kneeL: 0.95,
          thighRX: 0.55,
          kneeR: 0.45,
          lowerY: 0.5,
        },
      ],
    ],
  },
  sheathe: {
    dur: 1.3,
    keys: [
      [0.0, sw([-0.5, 0.05, 0.3], [-1, 0.05, 0.2], 'lr', { rootY: -0.2, chestY: -0.5, spineX: 0.25, thighLX: -0.6, kneeL: 0.9, thighRX: 0.5, kneeR: 0.4 })],
      [0.6, { handR: [-0.35, 0.02, 0.32], bladeR: [-0.7, 0.05, 0.7] }],
      [1.05, { handR: [0.12, -0.18, 0.2], bladeR: [-0.35, -0.12, -1], edgeR: [0, 1, 0], chestY: -0.2, handL: [0.2, -0.16, 0.12] }],
      [1.3, {}],
    ],
  },
  victory: {
    dur: 1.2,
    hold: true,
    keys: [
      [0.5, { handR: [-0.26, 0.64, 0.1], bladeR: [0.08, 1, 0.12], edgeR: [0, 0, 1], poleR: [-1, 0.1, -0.2], spineX: -0.12, chestX: -0.08, headX: -0.32, thighLX: -0.1, kneeL: 0.1, thighRX: 0.1, kneeR: 0.1, lowerY: 0.1 }],
      [1.2, {}],
    ],
  },
  death: {
    dur: 2,
    hold: true,
    keys: [
      [0.3, { spineX: -0.3, headX: -0.4 }],
      [0.9, { rootY: -0.46, thighLX: -1.45, kneeL: 2.3, thighRX: -0.2, kneeR: 2.3, footR: 0.8, spineX: 0.5, headX: 0.5, handR: [-0.2, -0.3, 0.38], bladeR: [0, -1, 0.15], edgeR: [0, 0, 1], handL: [0.25, -0.36, 0.2] }],
      [2, {}],
    ],
  },
}

registerClipSet('hero', HERO_STANCE, HERO_CLIPS, {
  amp: 0.44,
  knee0: 0.12,
  bob: 0,
  breath: 1.5,
  gait: 11,
  sprint: (out, w, s) => {
    // anime run: blade trailing behind, free arm pumping
    pullVec(out, 'handR', [-0.3, -0.1 + Math.abs(s) * 0.03, -0.32 + s * 0.04], w)
    pullVec(out, 'bladeR', [-0.12, 0.12, -1], w)
    pullVec(out, 'edgeR', [0, 1, 0], w)
    pullVec(out, 'handL', [0.25, -0.12, 0.12 - s * 0.22], w)
    out[S.spineX] += 0.12 * w
    out[S.chestY] += clamp(s * 0.15, -0.15, 0.15) * w
  },
})

/** Fraction of a clip at which its blade connects. */
export const HIT_AT: Record<string, number> = {
  slash1: 0.1,
  slash2: 0.1,
  slash3: 0.11,
  slash4: 0.25,
  airslash: 0.1,
  cleave: 0.1,
}

