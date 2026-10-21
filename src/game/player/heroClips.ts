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

// the free (left) hand throws the punches; the sword hand trails low and out of the way
const FIST_FWD: PoseSpec = { bladeL: [0, 0.05, 1], edgeL: [0, 1, 0] }
const SWORD_BACK: PoseSpec = { handR: [-0.34, -0.22, -0.12], bladeR: [-0.35, -0.55, -1], edgeR: [0, 1, 0], poleR: [-0.8, -0.3, -0.3] }

/** Left jab: a flick of the shoulder, the whole body in behind it. */
const jab: ClipDef = {
  dur: 0.34,
  keys: [
    [0.03, { ...FIST_FWD, ...SWORD_BACK, handL: [0.24, 0.0, 0.02], poleL: [0.8, -0.5, -0.3], chestY: 0.2, spineX: 0.1, rootY: -0.06 }],
    [0.06, { ...FIST_FWD, handL: [0.07, 0.15, 0.56], poleL: [0.6, -0.7, 0], chestY: -0.5, spineY: -0.16, spineX: 0.16, headY: 0.3, rootY: -0.12, thighLX: -0.55, kneeL: 0.6, thighRX: 0.4, kneeR: 0.35, lowerY: -0.15 }],
    [0.17, { handL: [0.08, 0.13, 0.52] }],
    [0.34, {}],
  ],
}

/** Coiled for the Serious Punch: low and wide, the fist drawn back past the hip, the sword hand out front. */
const SERIOUS_COIL: PoseSpec = {
  ...FIST_FWD,
  handL: [0.3, -0.12, -0.3],
  poleL: [0.7, -0.2, -1],
  handR: [-0.18, 0.02, 0.42],
  bladeR: [-0.6, -0.6, 0.5],
  edgeR: [-0.5, 0.5, 0.3],
  poleR: [-0.8, -0.5, 0],
  chestY: 0.65,
  spineY: 0.25,
  spineX: 0.22,
  headY: -0.6,
  headX: 0.05,
  rootY: -0.24,
  thighRX: -0.55,
  thighRZ: -0.2,
  kneeR: 0.85,
  thighLX: 0.42,
  thighLZ: 0.22,
  kneeL: 0.62,
  footL: 0.2,
  lowerY: 0.55,
}

/** The fist thrown through: arm straight down the line, hips and shoulders turned all the way over. */
const SERIOUS_HIT: PoseSpec = {
  ...FIST_FWD,
  ...SWORD_BACK,
  handL: [0.02, 0.16, 0.58],
  poleL: [0.5, -0.8, 0],
  chestY: -0.6,
  spineY: -0.25,
  spineX: 0.26,
  headY: 0.35,
  headX: 0,
  rootY: -0.22,
  thighRX: -0.7,
  thighRZ: -0.12,
  kneeR: 0.9,
  thighLX: 0.6,
  thighLZ: 0.1,
  kneeL: 0.12,
  footL: 0.35,
  lowerY: -0.35,
}

const HERO_CLIPS: Record<string, ClipDef> = {
  jab,
  seriousCharge: { dur: 1, loop: true, keys: [[0.16, SERIOUS_COIL]], proc: tremble(0.014) },
  seriousRelease: {
    dur: 1,
    keys: [
      [0.0, SERIOUS_COIL],
      [0.05, SERIOUS_HIT],
      [0.7, { handL: [0.03, 0.14, 0.56], spineX: 0.2 }],
      [1, {}],
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
  charge: {
    dur: 1,
    loop: true,
    keys: [
      [
        0.12,
        {
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
        },
      ],
    ],
    proc: tremble(0.012),
  },
  cleave: {
    dur: 0.62,
    keys: [
      [0.0, { twoHand: 1, handR: [-0.06, 0.56, 0.06], bladeR: [0.04, 1, 0.06], edgeR: [0, 0, 1], poleR: [-0.85, 0.1, -0.2], poleL: [0.85, 0.1, -0.2], chestY: 0 }],
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

