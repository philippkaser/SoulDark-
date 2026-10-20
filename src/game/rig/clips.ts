import { clamp, smoothstep } from '../../../shared/math'
import { applySpec, copyPose, makePose, newPose, S, sampleKeys, VI, type Key, type Pose, type PoseSpec, type V3 } from './pose'

export type Archetype = 'knight' | 'hollow' | 'fallen' | 'boss'

// ---------------------------------------------------------------------------
// Helpers for authoring swings: the sword's edge should lead the motion, so
// it is derived from the swing's rotation axis: edge = axis × blade.
// ---------------------------------------------------------------------------

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const AX = {
  rl: [0, 1, 0] as V3, // horizontal, right to left
  lr: [0, -1, 0] as V3, // horizontal, left to right
  chop: [1, 0, 0] as V3, // overhead downward
  rise: [-1, 0, 0] as V3,
  diag: [0.6, 0.8, 0] as V3, // upper right to lower left
  rising: [-0.8, -0.6, 0] as V3, // lower left to upper right
}
type AxisName = keyof typeof AX

/** Sword key: hand position, blade direction, swing axis. */
const sw = (hand: V3, blade: V3, axis: AxisName = 'rl', extra: PoseSpec = {}): PoseSpec => ({
  handR: hand,
  bladeR: blade,
  edgeR: cross(AX[axis], blade),
  ...extra,
})

export interface ClipDef {
  dur: number
  keys: Array<[number, PoseSpec]>
  /** Keep locomotion legs while playing (estus, fog walk). */
  legs?: 'loco'
  /** Procedural layer applied after keys. */
  proc?: (out: Pose, t: number, base: Pose) => void
  loop?: boolean
}

// ---------------------------------------------------------------------------
// Stances
// ---------------------------------------------------------------------------

const KNIGHT_STANCE: PoseSpec = {
  rootY: -0.035,
  spineX: 0.06,
  chestX: 0.03,
  headX: -0.06,
  thighLX: -0.14,
  thighLZ: 0.06,
  kneeL: 0.22,
  footL: -0.08,
  thighRX: 0.1,
  thighRZ: -0.07,
  kneeR: 0.2,
  footR: -0.1,
  lowerY: 0.12,
  handR: [-0.3, -0.2, 0.22],
  bladeR: [0.08, 0.32, 1],
  edgeR: [0, 1, -0.3],
  poleR: [-0.6, -0.45, -0.4],
  handL: [0.24, -0.1, 0.26],
  bladeL: [0.18, 0.05, 1],
  edgeL: [0, 1, 0],
  poleL: [0.7, -0.4, -0.3],
}

const HOLLOW_STANCE: PoseSpec = {
  rootY: -0.08,
  spineX: 0.32,
  chestX: 0.14,
  headX: -0.34,
  headZ: 0.12,
  thighLX: -0.22,
  thighLZ: 0.07,
  kneeL: 0.4,
  footL: -0.12,
  thighRX: 0.12,
  thighRZ: -0.07,
  kneeR: 0.34,
  footR: -0.14,
  lowerY: 0.1,
  handR: [-0.3, -0.34, 0.16],
  bladeR: [0.1, -0.25, 1],
  edgeR: [0, 1, 0.2],
  poleR: [-0.6, -0.4, -0.3],
  handL: [0.25, -0.36, 0.12],
  bladeL: [0.2, -1, 0.2],
  edgeL: [0, 0, 1],
  poleL: [0.6, -0.4, -0.3],
}

const FALLEN_STANCE: PoseSpec = {
  ...KNIGHT_STANCE,
  rootY: -0.06,
  spineX: 0.1,
  kneeL: 0.3,
  kneeR: 0.28,
  handR: [-0.32, -0.12, 0.2],
  bladeR: [0.15, 0.6, 1],
  handL: [0.16, 0.04, 0.32],
  bladeL: [0.1, 0.05, 1],
}

const BOSS_STANCE: PoseSpec = {
  rootY: -0.07,
  spineX: 0.14,
  chestX: 0.04,
  chestY: -0.18,
  headX: -0.1,
  thighLX: -0.22,
  thighLZ: 0.13,
  kneeL: 0.32,
  footL: -0.1,
  thighRX: 0.16,
  thighRZ: -0.13,
  kneeR: 0.3,
  footR: -0.1,
  lowerY: 0.3,
  twoHand: 1,
  handR: [-0.1, -0.16, 0.36],
  bladeR: [0.32, 0.5, 1],
  edgeR: [0, 1, -0.4],
  poleR: [-0.7, -0.5, -0.2],
  handL: [0.1, -0.3, 0.3],
  bladeL: [0, 0, 1],
  edgeL: [0, 1, 0],
  poleL: [0.75, -0.5, -0.2],
}

export const STANCES: Record<Archetype, Pose> = {
  knight: makePose(null, KNIGHT_STANCE),
  hollow: makePose(null, HOLLOW_STANCE),
  fallen: makePose(null, FALLEN_STANCE),
  boss: makePose(null, BOSS_STANCE),
}

// ---------------------------------------------------------------------------
// Shared reaction clips
// ---------------------------------------------------------------------------

const hurt: ClipDef = {
  dur: 0.45,
  keys: [
    [0.07, { spineX: -0.28, chestX: -0.15, headX: -0.4, rootY: -0.07, chestY: 0.18, handR: [-0.38, -0.06, 0.08], handL: [0.36, -0.02, 0.12] }],
    [0.22, { spineX: -0.12, headX: -0.15 }],
  ],
}

const stagger: ClipDef = {
  dur: 1.25,
  keys: [
    [0.1, { spineX: -0.4, chestX: -0.2, headX: -0.5, rootY: -0.06, handR: [-0.46, 0.1, -0.05], handL: [0.44, 0.1, -0.02], thighLX: 0.2, kneeL: 0.4 }],
    [0.45, { spineX: -0.15, rootY: -0.16, kneeL: 0.7, kneeR: 0.6, thighRX: -0.3, headX: -0.1 }],
    [0.9, { spineX: 0.2, headX: 0.1 }],
  ],
}

const parried: ClipDef = {
  dur: 2.3,
  keys: [
    [0.12, sw([-0.5, 0.3, -0.12], [-0.3, 0.85, -0.3], 'rise', { spineX: -0.45, chestX: -0.2, headX: -0.5, handL: [0.46, 0.22, 0.0], rootY: -0.04 })],
    [0.45, { spineX: -0.25, rootY: -0.18, kneeL: 0.75, kneeR: 0.7, thighLX: -0.35, thighRX: 0.2, headX: -0.2, handR: [-0.44, -0.1, 0.05], handL: [0.4, -0.15, 0.05] }],
    [1.9, { spineX: 0.15, headX: 0.25, rootY: -0.2 }],
  ],
}

const riposted: ClipDef = {
  dur: 2.4,
  keys: [
    [0.15, { spineX: -0.2, headX: -0.3, rootY: -0.12 }],
    [0.6, { spineX: 0.65, chestX: 0.2, headX: 0.55, rootY: -0.1, handR: [-0.2, -0.3, 0.3], handL: [0.2, -0.3, 0.3], kneeL: 0.5, kneeR: 0.5 }],
    [1.25, { spineX: 0.55 }],
    [1.5, { spineX: -0.3, headX: -0.3, pivotX: -0.25, rootY: -0.1, thighLX: 0.1, thighRX: -0.4, kneeR: 0.6 }],
    [2.0, { spineX: 0.1, headX: 0.1, pivotX: 0, rootY: -0.12 }],
  ],
}

const death: ClipDef = {
  dur: 6,
  loop: true,
  keys: [
    [0.15, { spineX: -0.3, headX: -0.4, rootY: -0.06 }],
    [0.65, { rootY: -0.46, thighLX: -1.45, kneeL: 2.4, thighRX: -0.25, kneeR: 2.3, footR: 0.8, spineX: 0.35, headX: 0.45, handR: [-0.26, -0.36, 0.12], handL: [0.26, -0.36, 0.12] }],
    [0.95, { spineX: 0.5, headX: 0.6 }],
    [1.4, { pivotX: 1.38, rootY: -0.8, spineX: 0.1, thighLX: -0.25, kneeL: 0.4, thighRX: -0.1, kneeR: 0.3, headX: -0.2, handR: [-0.4, -0.05, 0.3], handL: [0.4, -0.05, 0.3] }],
    [6, {}],
  ],
}

// ---------------------------------------------------------------------------
// Player (knight) clips
// ---------------------------------------------------------------------------

const rollProc = (out: Pose, t: number) => {
  const spin = smoothstep(0.04, 0.48, t)
  out[S.pivotX] = spin * Math.PI * 2
  const u = Math.sin(clamp((t - 0.01) / 0.52, 0, 1) * Math.PI)
  const rise = 1 - smoothstep(0.46, 0.76, t)
  out[S.rootY] = -0.5 * u - 0.14 * (1 - u) * rise * (t > 0.3 ? 1 : 0)
  out[S.spineX] += 0.55 * u
  out[S.chestX] += 0.3 * u
  out[S.headX] += 0.7 * u
  const tuck = Math.max(u, (t > 0.3 ? 1 : 0) * rise * 0.6)
  out[S.thighLX] = -1.75 * tuck
  out[S.thighRX] = -1.6 * tuck
  out[S.kneeL] = 2.3 * tuck + 0.2
  out[S.kneeR] = 2.2 * tuck + 0.2
  out[S.lowerY] *= 1 - u
}

const backstepProc = (out: Pose, t: number) => {
  const air = Math.sin(clamp((t - 0.08) / 0.26, 0, 1) * Math.PI)
  out[S.rootY] += air * 0.05
}

const KNIGHT_CLIPS: Record<string, ClipDef> = {
  light1: {
    dur: 0.72,
    keys: [
      [0.13, sw([-0.46, 0.12, 0.02], [-0.92, 0.3, -0.32], 'rl', { chestY: -0.5, spineY: -0.15, hipsY: -0.1, rootY: -0.06, thighLX: -0.25, kneeL: 0.35, thighRX: 0.15, kneeR: 0.3, handL: [0.3, -0.05, 0.2] })],
      [0.22, sw([-0.32, 0.05, 0.4], [-0.4, 0.05, 1], 'rl', { chestY: -0.2, spineY: -0.05, rootY: -0.08, thighLX: -0.45, kneeL: 0.5, thighRX: 0.25, kneeR: 0.35 })],
      [0.28, sw([-0.05, 0.02, 0.52], [0.35, -0.02, 1], 'rl', { chestY: 0.2, spineY: 0.08 })],
      [0.34, sw([0.24, -0.02, 0.4], [1, -0.1, 0.25], 'rl', { chestY: 0.5, spineY: 0.15 })],
      [0.5, sw([0.28, -0.12, 0.22], [0.8, -0.35, -0.3], 'rl', { chestY: 0.55, rootY: -0.07 })],
      [0.72, {}],
    ],
  },
  light2: {
    dur: 0.72,
    keys: [
      [0.12, sw([0.18, 0.02, 0.24], [0.9, 0.1, -0.35], 'lr', { chestY: 0.45, spineY: 0.12, rootY: -0.06, thighRX: -0.38, kneeR: 0.42, thighLX: 0.2, kneeL: 0.3, poleR: [-0.3, -0.8, -0.2] })],
      [0.2, sw([0.08, 0.06, 0.46], [0.55, 0.1, 1], 'lr', { chestY: 0.25, spineY: 0.08, rootY: -0.08 })],
      [0.26, sw([-0.2, 0.1, 0.5], [-0.4, 0.2, 1], 'lr', { chestY: -0.1, spineY: -0.04, poleR: [-0.6, -0.45, -0.4] })],
      [0.32, sw([-0.44, 0.14, 0.3], [-1, 0.3, 0.2], 'lr', { chestY: -0.42, spineY: -0.12 })],
      [0.5, sw([-0.46, 0.05, 0.1], [-0.75, 0.3, -0.55], 'lr', { chestY: -0.5 })],
      [0.72, {}],
    ],
  },
  light3: {
    dur: 0.98,
    keys: [
      [0.2, sw([-0.14, 0.5, -0.02], [0.05, 0.45, -1], 'chop', { spineX: -0.12, chestX: -0.1, chestY: -0.15, headX: -0.1, rootY: 0, poleR: [-0.8, 0.2, -0.3], handL: [0.3, 0.05, 0.22] })],
      [0.3, sw([-0.14, 0.52, 0.12], [0.02, 0.9, -0.3], 'chop')],
      [0.38, sw([-0.1, 0.32, 0.45], [0, 0.55, 0.85], 'chop', { spineX: 0.1, chestX: 0, chestY: 0, rootY: -0.08, thighLX: -0.5, kneeL: 0.55, thighRX: 0.3, kneeR: 0.35, poleR: [-0.7, -0.3, -0.3] })],
      [0.43, sw([-0.08, 0.02, 0.56], [0, -0.25, 1], 'chop', { spineX: 0.35, rootY: -0.14 })],
      [0.48, sw([-0.08, -0.24, 0.48], [0, -0.8, 0.6], 'chop', { spineX: 0.45, chestX: 0.1, rootY: -0.18 })],
      [0.72, sw([-0.12, -0.28, 0.42], [0.05, -0.75, 0.65], 'chop')],
      [0.98, {}],
    ],
  },
  heavy: {
    dur: 1.3,
    keys: [
      [0.25, sw([-0.25, 0.38, -0.12], [-0.3, 0.35, -1], 'chop', { spineX: -0.15, chestY: -0.45, spineY: -0.15, rootY: -0.1, thighRX: 0.35, kneeR: 0.5, thighLX: -0.25, kneeL: 0.45, handL: [0.38, 0.0, 0.18], poleR: [-0.8, 0.1, -0.3] })],
      [0.5, sw([-0.22, 0.56, -0.1], [-0.1, 0.6, -0.9], 'chop', { spineX: -0.25, chestX: -0.1, chestY: -0.5, rootY: -0.04 })],
      [0.62, sw([-0.15, 0.42, 0.35], [0, 0.8, 0.5], 'chop', { spineX: -0.05, chestY: -0.25 })],
      [0.68, sw([-0.1, 0.05, 0.58], [0, -0.15, 1], 'chop', { spineX: 0.35, chestY: 0, chestX: 0, rootY: -0.12, thighLX: -0.6, kneeL: 0.7, thighRX: 0.45, kneeR: 0.4, poleR: [-0.7, -0.3, -0.3] })],
      [0.74, sw([-0.1, -0.3, 0.5], [0, -0.85, 0.5], 'chop', { spineX: 0.55, chestX: 0.15, rootY: -0.24 })],
      [1.0, sw([-0.12, -0.32, 0.45], [0.05, -0.8, 0.55], 'chop')],
      [1.3, {}],
    ],
  },
  sprintAttack: {
    dur: 0.9,
    keys: [
      [0.1, sw([-0.42, 0.38, 0.0], [-0.5, 0.6, -0.6], 'diag', { spineX: 0.25, rootY: 0.05, chestY: -0.4, thighLX: -0.7, kneeL: 0.9, thighRX: 0.3, kneeR: 0.6 })],
      [0.2, sw([-0.3, 0.3, 0.38], [-0.4, 0.5, 0.8], 'diag')],
      [0.28, sw([-0.02, 0.0, 0.55], [0.4, -0.3, 1], 'diag', { chestY: 0.1, spineX: 0.35, rootY: -0.1 })],
      [0.36, sw([0.22, -0.2, 0.4], [0.9, -0.6, 0.2], 'diag', { chestY: 0.45, rootY: -0.18, thighLX: -0.5, kneeL: 0.6, thighRX: 0.4, kneeR: 0.5 })],
      [0.6, sw([0.24, -0.24, 0.36], [0.85, -0.65, 0.1], 'diag')],
      [0.9, {}],
    ],
  },
  riposte: {
    dur: 1.9,
    keys: [
      [0.3, sw([-0.3, 0.02, -0.12], [0.05, 0.05, 1], 'rl', { edgeR: [0, 1, 0], chestY: -0.4, rootY: -0.08, handL: [0.3, 0.1, 0.35], thighLX: -0.5, kneeL: 0.5, thighRX: 0.3, kneeR: 0.3 })],
      [0.55, { handR: [-0.08, 0.02, 0.56], bladeR: [0.05, -0.05, 1], chestY: 0.1, spineX: 0.25, rootY: -0.14, thighLX: -0.7, kneeL: 0.75, thighRX: 0.4, kneeR: 0.35 }],
      [1.15, { handR: [-0.08, 0.0, 0.54], bladeR: [0.05, -0.1, 1] }],
      [1.45, { handR: [-0.32, 0.0, 0.1], bladeR: [0.1, 0.1, 1], chestY: -0.3, spineX: 0.05, rootY: -0.05 }],
      [1.9, {}],
    ],
  },
  parry: {
    dur: 0.68,
    keys: [
      [0.06, { handL: [0.38, 0.12, 0.22], bladeL: [0.9, 0.2, 0.4], chestY: 0.35, spineY: 0.1, handR: [-0.34, -0.1, 0.05] }],
      [0.16, { handL: [0.14, 0.14, 0.44], bladeL: [-0.1, 0.1, 1], chestY: 0 }],
      [0.28, { handL: [-0.08, 0.08, 0.36], bladeL: [-0.8, 0, 0.6], chestY: -0.3, spineY: -0.1 }],
      [0.45, { handL: [-0.02, 0.0, 0.33] }],
      [0.68, {}],
    ],
  },
  roll: {
    dur: 0.76,
    keys: [
      [0.06, { handR: [-0.18, -0.02, 0.24], bladeR: [0.1, 0.25, -1], edgeR: [0, 1, 0], handL: [0.18, 0.0, 0.22], bladeL: [1, 0, 0.2] }],
      [0.5, {}],
      [0.76, {}],
    ],
    proc: rollProc,
  },
  backstep: {
    dur: 0.52,
    keys: [
      [0.1, { rootY: -0.08, spineX: 0.25, thighLX: -0.3, kneeL: 0.5, thighRX: -0.1, kneeR: 0.6 }],
      [0.22, { rootY: 0.02, thighLX: -0.4, kneeL: 0.6, thighRX: 0.1, kneeR: 0.5 }],
      [0.38, { rootY: -0.12, spineX: 0.2, kneeL: 0.6, kneeR: 0.6 }],
      [0.52, {}],
    ],
    proc: backstepProc,
  },
  estus: {
    dur: 1.55,
    legs: 'loco',
    keys: [
      [0.3, { handR: [-0.08, 0.28, 0.2], bladeR: [0.1, -0.95, -0.2], edgeR: [0, 0, 1], poleR: [-0.7, -0.3, 0], headX: -0.1 }],
      [0.55, { handR: [-0.04, 0.36, 0.16], bladeR: [0.1, -0.9, -0.35], headX: -0.45, chestX: -0.08 }],
      [1.0, {}],
      [1.25, { handR: [-0.25, 0.0, 0.2], headX: -0.05, chestX: 0 }],
      [1.55, {}],
    ],
  },
  hurt,
  knockdown: {
    dur: 1.75,
    keys: [
      [0.1, { spineX: -0.4, pivotX: -0.3, rootY: -0.05, headX: -0.4 }],
      [0.42, { pivotX: -1.45, rootY: -0.8, spineX: -0.1, thighLX: -0.6, kneeL: 0.4, thighRX: -0.4, kneeR: 0.3, headX: 0.25, handR: [-0.46, -0.1, -0.1], handL: [0.46, -0.1, -0.1] }],
      [0.95, {}],
      [1.2, { pivotX: -0.6, rootY: -0.66, spineX: 0.4, thighLX: -1.4, kneeL: 2.0, thighRX: -1.2, kneeR: 1.8, headX: 0.1 }],
      [1.5, { pivotX: 0, rootY: -0.42, spineX: 0.5, thighLX: -1.2, kneeL: 1.9, thighRX: -0.8, kneeR: 1.7, handR: [-0.3, -0.2, 0.22], handL: [0.24, -0.1, 0.26] }],
      [1.75, {}],
    ],
  },
  death,
  rest: {
    dur: 1.2,
    loop: true,
    keys: [
      [0.6, { rootY: -0.6, thighLX: -1.45, thighLZ: 0.75, kneeL: 2.4, thighRX: -1.45, thighRZ: -0.75, kneeR: 2.4, footL: 0.3, footR: 0.3, lowerY: 0, spineX: 0.28, headX: 0.22, handR: [-0.22, -0.32, 0.3], bladeR: [0.2, -0.3, 1], handL: [0.22, -0.32, 0.28], bladeL: [0.3, 1, 0.3] }],
      [1.2, {}],
    ],
  },
  fog: {
    dur: 1.9,
    legs: 'loco',
    keys: [
      [0.3, { handL: [0.12, 0.24, 0.45], bladeL: [0, 0.3, 1], handR: [-0.3, -0.25, 0.12], spineX: 0.1, headX: 0.1 }],
      [1.6, {}],
      [1.9, {}],
    ],
  },
  praise: {
    dur: 2.6,
    keys: [
      [0.35, { handR: [-0.42, 0.62, 0.12], bladeR: [-0.3, 0.9, 0.2], edgeR: [0, 0, 1], handL: [0.42, 0.62, 0.12], bladeL: [0.3, 0.5, 0.6], thighLZ: 0.3, thighRZ: -0.3, kneeL: 0.05, kneeR: 0.05, thighLX: 0, thighRX: 0, lowerY: 0, spineX: -0.12, headX: -0.25, rootY: -0.03, poleR: [-1, 0, -0.3], poleL: [1, 0, -0.3] }],
      [2.2, {}],
      [2.6, {}],
    ],
  },
  bow: {
    dur: 2.0,
    keys: [
      [0.4, { spineX: 0.55, chestX: 0.15, headX: 0.3, handR: [-0.05, 0.05, 0.22], bladeR: [-0.3, -0.9, 0.1], handL: [0.25, -0.2, 0.1], thighLX: 0, thighRX: 0, lowerY: 0 }],
      [1.4, {}],
      [2.0, {}],
    ],
  },
  wave: {
    dur: 2.0,
    keys: [
      [0.3, { handR: [-0.42, 0.55, 0.2], bladeR: [0, 1, 0.1], edgeR: [0, 0, 1], poleR: [-1, -0.2, 0] }],
      [0.6, { handR: [-0.3, 0.56, 0.22] }],
      [0.9, { handR: [-0.48, 0.55, 0.2] }],
      [1.2, { handR: [-0.3, 0.56, 0.22] }],
      [1.5, { handR: [-0.45, 0.55, 0.2] }],
      [2.0, {}],
    ],
  },
  point: {
    dur: 1.6,
    keys: [
      [0.3, { handR: [-0.16, 0.2, 0.55], bladeR: [0, 0.15, 1], edgeR: [0, 1, 0], chestY: 0.1 }],
      [1.2, {}],
      [1.6, {}],
    ],
  },
  pickup: {
    dur: 1.0,
    keys: [
      [0.4, { rootY: -0.42, thighLX: -1.2, kneeL: 1.8, thighRX: -0.5, kneeR: 1.6, spineX: 0.6, headX: 0.2, handL: [0.2, -0.56, 0.32], bladeL: [0, -1, 0.3] }],
      [0.6, {}],
      [1.0, {}],
    ],
  },
}

// ---------------------------------------------------------------------------
// Hollow clips
// ---------------------------------------------------------------------------

const HOLLOW_CLIPS: Record<string, ClipDef> = {
  h_slash: {
    dur: 1.35,
    keys: [
      [0.45, sw([-0.3, 0.48, -0.05], [-0.2, 0.6, -0.8], 'diag', { spineX: 0.0, chestY: -0.35, headX: -0.2, rootY: -0.02 })],
      [0.62, sw([-0.32, 0.52, 0.05], [-0.25, 0.85, -0.4], 'diag')],
      [0.69, sw([-0.22, 0.3, 0.42], [-0.1, 0.55, 0.85], 'diag', { spineX: 0.25 })],
      [0.75, sw([-0.05, -0.05, 0.5], [0.35, -0.35, 1], 'diag', { spineX: 0.5, chestY: 0.15, rootY: -0.12, thighLX: -0.45, kneeL: 0.6 })],
      [0.82, sw([0.15, -0.3, 0.38], [0.7, -0.75, 0.3], 'diag', { spineX: 0.55, chestY: 0.35 })],
      [1.1, {}],
      [1.35, {}],
    ],
  },
  h_backhand: {
    dur: 1.1,
    keys: [
      [0.25, sw([0.15, 0.0, 0.22], [0.9, 0.1, -0.4], 'lr', { chestY: 0.45, spineX: 0.2 })],
      [0.42, sw([0.0, 0.0, 0.48], [0.5, 0, 1], 'lr', { chestY: 0.2 })],
      [0.5, sw([-0.25, 0.0, 0.48], [-0.5, 0, 1], 'lr', { chestY: -0.15 })],
      [0.58, sw([-0.45, 0.0, 0.25], [-1, 0, 0.1], 'lr', { chestY: -0.4 })],
      [0.85, {}],
      [1.1, {}],
    ],
  },
  h_lunge: {
    dur: 1.55,
    keys: [
      [0.55, sw([-0.32, 0.0, -0.15], [0, 0.05, 1], 'rl', { edgeR: [0, 1, 0], rootY: -0.2, spineX: 0.4, thighLX: -0.6, kneeL: 1.0, thighRX: 0.2, kneeR: 0.9 })],
      [0.72, { rootY: -0.24 }],
      [0.86, { handR: [-0.1, 0.05, 0.56], bladeR: [0, 0, 1], rootY: -0.05, spineX: 0.45, thighLX: -0.7, kneeL: 0.6, thighRX: 0.5, kneeR: 0.3 }],
      [0.94, {}],
      [1.3, {}],
      [1.55, {}],
    ],
  },
  idle: {
    dur: 4,
    loop: true,
    keys: [
      [0, { rootY: -0.5, thighLX: -1.35, kneeL: 2.3, thighRX: -0.3, kneeR: 2.35, footR: 0.9, spineX: 0.55, headX: 0.45, handR: [-0.24, -0.4, 0.22], handL: [0.24, -0.42, 0.18], lowerY: 0 }],
    ],
    proc: (out, t) => {
      out[S.spineX] += Math.sin(t * 0.9) * 0.04
      out[S.headZ] += Math.sin(t * 0.5) * 0.1
    },
  },
  wake: {
    dur: 1.3,
    keys: [
      [0, { rootY: -0.5, thighLX: -1.35, kneeL: 2.3, thighRX: -0.3, kneeR: 2.35, footR: 0.9, spineX: 0.55, headX: 0.45, handR: [-0.24, -0.4, 0.22], handL: [0.24, -0.42, 0.18], lowerY: 0 }],
      [0.4, { headX: -0.4, spineX: 0.3 }],
      [0.9, { rootY: -0.2, thighLX: -0.6, kneeL: 1.0, thighRX: 0.1, kneeR: 0.8, footR: 0 }],
      [1.3, {}],
    ],
  },
  hurt,
  stagger: { ...hurt, dur: 0.5 },
  parried,
  riposted,
  death,
}

// ---------------------------------------------------------------------------
// Fallen knight clips
// ---------------------------------------------------------------------------

const FALLEN_CLIPS: Record<string, ClipDef> = {
  k_slash: {
    dur: 1.15,
    keys: [
      [0.3, sw([-0.44, 0.1, -0.02], [-0.75, 0.25, -0.6], 'rl', { chestY: -0.55, spineY: -0.15, rootY: -0.08, thighLX: -0.3, kneeL: 0.4, thighRX: 0.2, kneeR: 0.35, handL: [0.3, -0.05, 0.2] })],
      [0.42, sw([-0.46, 0.12, 0.0], [-0.85, 0.25, -0.45], 'rl')],
      [0.5, sw([-0.32, 0.05, 0.4], [-0.4, 0.05, 1], 'rl', { chestY: -0.2, rootY: -0.1, thighLX: -0.5, kneeL: 0.55 })],
      [0.57, sw([-0.05, 0.02, 0.52], [0.35, -0.02, 1], 'rl', { chestY: 0.2 })],
      [0.64, sw([0.24, -0.02, 0.4], [1, -0.1, 0.25], 'rl', { chestY: 0.5 })],
      [0.85, {}],
      [1.15, {}],
    ],
  },
  k_rising: {
    dur: 1.2,
    keys: [
      [0.3, sw([0.1, -0.3, 0.3], [0.6, -0.7, 0.4], 'rising', { chestY: 0.35, rootY: -0.1, spineX: 0.2 })],
      [0.44, sw([-0.05, -0.1, 0.5], [0.1, -0.2, 1], 'rising')],
      [0.52, sw([-0.25, 0.2, 0.45], [-0.5, 0.5, 0.8], 'rising', { chestY: 0 })],
      [0.6, sw([-0.4, 0.45, 0.2], [-0.6, 0.8, -0.1], 'rising', { chestY: -0.3, spineX: -0.05 })],
      [0.9, {}],
      [1.2, {}],
    ],
  },
  k_overhead: {
    dur: 1.5,
    keys: [
      [0.45, sw([-0.14, 0.5, -0.02], [0.05, 0.45, -1], 'chop', { spineX: -0.15, chestX: -0.1, chestY: -0.15, rootY: 0, poleR: [-0.8, 0.2, -0.3] })],
      [0.68, sw([-0.14, 0.54, 0.08], [0.02, 0.9, -0.35], 'chop')],
      [0.8, sw([-0.1, 0.3, 0.46], [0, 0.55, 0.85], 'chop', { spineX: 0.1, chestY: 0, rootY: -0.08, thighLX: -0.5, kneeL: 0.55, thighRX: 0.3, kneeR: 0.35, poleR: [-0.7, -0.3, -0.3] })],
      [0.86, sw([-0.08, 0.02, 0.56], [0, -0.25, 1], 'chop', { spineX: 0.35, rootY: -0.14 })],
      [0.92, sw([-0.08, -0.24, 0.48], [0, -0.8, 0.6], 'chop', { spineX: 0.45, rootY: -0.18 })],
      [1.2, {}],
      [1.5, {}],
    ],
  },
  k_thrust: {
    dur: 1.45,
    keys: [
      [0.55, sw([-0.32, 0.05, -0.15], [0, 0.05, 1], 'rl', { edgeR: [0, 1, 0], rootY: -0.16, spineX: 0.3, chestY: -0.35, thighLX: -0.55, kneeL: 0.8, thighRX: 0.25, kneeR: 0.7 })],
      [0.68, { rootY: -0.2 }],
      [0.8, { handR: [-0.08, 0.05, 0.56], bladeR: [0, 0, 1], rootY: -0.05, spineX: 0.35, chestY: 0.05, thighLX: -0.7, kneeL: 0.55, thighRX: 0.45, kneeR: 0.3 }],
      [0.88, {}],
      [1.2, {}],
      [1.45, {}],
    ],
  },
  k_bash: {
    dur: 1.0,
    keys: [
      [0.25, { handL: [0.3, 0.05, 0.05], bladeL: [0.3, 0, 1], chestY: 0.4, spineX: 0.05 }],
      [0.45, { handL: [0.05, 0.1, 0.55], bladeL: [0, 0, 1], chestY: -0.3, spineX: 0.25, rootY: -0.08, thighLX: -0.5, kneeL: 0.5 }],
      [0.7, {}],
      [1.0, {}],
    ],
  },
  hurt,
  stagger,
  parried,
  riposted,
  death,
}

// ---------------------------------------------------------------------------
// Boss clips (two-handed greatsword)
// ---------------------------------------------------------------------------

const KNEEL: PoseSpec = {
  rootY: -0.42,
  thighLX: -1.5,
  thighLZ: 0.1,
  kneeL: 1.6,
  footL: 0,
  thighRX: 0.1,
  thighRZ: -0.1,
  kneeR: 2.3,
  footR: 0.9,
  lowerY: 0,
  spineX: 0.35,
  chestY: 0,
  headX: 0.5,
  twoHand: 1,
  handR: [-0.06, -0.12, 0.42],
  bladeR: [0, -1, 0.12],
  edgeR: [0, 0, 1],
}

const plant = sw([-0.05, -0.15, 0.42], [0, -1, 0.15], 'chop')

const BOSS_CLIPS: Record<string, ClipDef> = {
  b_cleave: {
    dur: 2.3,
    keys: [
      [0.5, sw([-0.08, 0.5, 0.0], [0.05, 0.5, -1], 'chop', { spineX: -0.15, chestX: -0.1, chestY: 0, rootY: -0.02, poleR: [-0.8, 0.2, -0.2], poleL: [0.8, 0.2, -0.2] })],
      [0.9, sw([-0.06, 0.56, 0.05], [0.05, 0.75, -0.7], 'chop', { spineX: -0.22 })],
      [1.08, sw([-0.05, 0.3, 0.42], [0, 0.6, 0.8], 'chop', { spineX: 0.15, poleR: [-0.7, -0.5, -0.2], poleL: [0.75, -0.5, -0.2] })],
      [1.15, sw([-0.04, -0.1, 0.5], [0, -0.45, 1], 'chop', { spineX: 0.5, rootY: -0.18, thighLX: -0.55, kneeL: 0.7 })],
      [1.22, sw([-0.04, -0.3, 0.42], [0, -0.75, 0.65], 'chop', { spineX: 0.6, rootY: -0.24 })],
      [1.8, {}],
      [2.3, {}],
    ],
  },
  b_sweep: {
    dur: 1.95,
    keys: [
      [0.55, sw([-0.42, 0.0, -0.05], [-0.9, 0.1, -0.45], 'rl', { chestY: -0.75, spineY: -0.2, rootY: -0.12 })],
      [0.78, sw([-0.44, 0.02, 0.0], [-1, 0.1, -0.2], 'rl')],
      [0.86, sw([-0.3, 0.0, 0.38], [-0.5, 0.0, 1], 'rl', { chestY: -0.3 })],
      [0.96, sw([0.0, -0.02, 0.5], [0.4, -0.05, 1], 'rl', { chestY: 0.25, spineY: 0 })],
      [1.06, sw([0.3, -0.05, 0.35], [1, -0.1, 0.2], 'rl', { chestY: 0.65, spineY: 0.2 })],
      [1.5, {}],
      [1.95, {}],
    ],
  },
  b_thrust: {
    dur: 2.05,
    keys: [
      [0.6, sw([-0.25, 0.05, -0.15], [0.05, 0.05, 1], 'rl', { edgeR: [0, 1, 0], chestY: -0.5, rootY: -0.18, thighRX: 0.4, kneeR: 0.6, thighLX: -0.4, kneeL: 0.7 })],
      [0.9, { rootY: -0.24 }],
      [1.0, { handR: [-0.06, 0.05, 0.56], bladeR: [0, 0, 1], chestY: 0, spineX: 0.3, rootY: -0.12, thighLX: -0.7, kneeL: 0.5, thighRX: 0.5, kneeR: 0.3 }],
      [1.16, {}],
      [1.6, {}],
      [2.05, {}],
    ],
  },
  b_leap: {
    dur: 2.7,
    keys: [
      [0.45, sw([-0.2, 0.1, 0.2], [0.1, 0.2, -1], 'chop', { rootY: -0.3, thighLX: -1.0, kneeL: 1.6, thighRX: -0.6, kneeR: 1.5, spineX: 0.45 })],
      [0.7, sw([-0.08, 0.55, 0.05], [0.05, 0.6, -0.9], 'chop', { rootY: 1.3, thighLX: -0.9, kneeL: 1.4, thighRX: -0.3, kneeR: 1.2, spineX: -0.2 })],
      [1.0, { rootY: 2.0 }],
      [1.25, sw([-0.06, 0.45, 0.35], [0, 0.9, 0.3], 'chop', { rootY: 1.0, spineX: 0.1 })],
      [1.42, sw([-0.04, -0.25, 0.48], [0, -0.8, 0.6], 'chop', { rootY: -0.26, spineX: 0.6, thighLX: -1.0, kneeL: 1.5, thighRX: -0.3, kneeR: 1.3 })],
      [2.1, {}],
      [2.7, {}],
    ],
  },
  b_stomp: {
    dur: 1.35,
    keys: [
      [0.35, { thighRX: -1.1, kneeR: 1.3, rootY: 0.04, spineX: -0.1, chestY: 0.2 }],
      [0.56, { thighRX: -0.2, kneeR: 0.3, rootY: -0.14, spineX: 0.25 }],
      [0.9, {}],
      [1.35, {}],
    ],
  },
  b_nova: {
    dur: 3.1,
    keys: [
      [0.5, { ...plant, rootY: -0.2, spineX: 0.4, headX: 0.3, kneeL: 0.8, kneeR: 0.8, chestY: 0 }],
      [1.5, { rootY: -0.32, spineX: 0.62, headX: 0.45, kneeL: 1.1, kneeR: 1.0 }],
      [1.68, { spineX: -0.35, headX: -0.45, rootY: 0.04, twoHand: 0, handL: [0.5, 0.3, 0.1], bladeL: [1, 0.3, 0.2], edgeL: [0, 1, 0], handR: [-0.45, 0.3, 0.15], bladeR: [-0.5, 0.8, 0.2], kneeL: 0.3, kneeR: 0.3 }],
      [2.4, {}],
      [3.1, {}],
    ],
    proc: (out, t) => {
      if (t > 0.6 && t < 1.66) {
        const s = (t - 0.6) * 8
        out[S.spineZ] += Math.sin(t * 60) * 0.02 * s * 0.2
        out[S.headZ] += Math.sin(t * 47) * 0.04
      }
    },
  },
  b_whirl: {
    dur: 2.9,
    keys: [
      [0.55, sw([-0.44, 0.02, 0.0], [-1, 0.1, -0.2], 'rl', { chestY: -0.75, rootY: -0.12 })],
      [0.8, sw([-0.3, 0.0, 0.38], [-0.5, 0.0, 1], 'rl', { chestY: -0.3 })],
      [0.9, sw([0.05, -0.02, 0.5], [0.5, 0, 1], 'rl', { chestY: 0.3 })],
      [0.98, sw([0.32, -0.05, 0.3], [1, -0.1, 0.1], 'rl', { chestY: 0.7 })],
      [1.3, sw([0.38, 0.0, 0.1], [0.95, 0.1, -0.4], 'lr', { chestY: 0.78 })],
      [1.5, sw([0.2, 0.0, 0.45], [0.6, 0, 1], 'lr', { chestY: 0.35 })],
      [1.6, sw([-0.15, 0, 0.5], [-0.5, 0, 1], 'lr', { chestY: -0.2 })],
      [1.68, sw([-0.42, 0, 0.25], [-1, 0, 0.1], 'lr', { chestY: -0.6 })],
      [1.9, sw([-0.08, 0.55, 0.05], [0.05, 0.75, -0.7], 'chop', { chestY: 0, spineX: -0.15, poleR: [-0.8, 0.2, -0.2], poleL: [0.8, 0.2, -0.2] })],
      [2.08, sw([-0.05, 0.3, 0.42], [0, 0.6, 0.8], 'chop', { spineX: 0.1, poleR: [-0.7, -0.5, -0.2], poleL: [0.75, -0.5, -0.2] })],
      [2.15, sw([-0.04, -0.1, 0.5], [0, -0.45, 1], 'chop', { spineX: 0.5, rootY: -0.18 })],
      [2.2, sw([-0.04, -0.3, 0.42], [0, -0.75, 0.65], 'chop', { spineX: 0.6, rootY: -0.24 })],
      [2.6, {}],
      [2.9, {}],
    ],
  },
  b_roar: {
    dur: 2.8,
    keys: [
      [0.6, { ...plant, rootY: -0.18, spineX: 0.45, headX: 0.4, chestY: 0 }],
      [1.0, { spineX: -0.4, headX: -0.65, chestX: -0.2, rootY: 0.02, twoHand: 0, handL: [0.46, 0.25, 0.1], bladeL: [1, 0.2, 0.2], edgeL: [0, 1, 0], handR: [-0.46, 0.25, 0.15], bladeR: [-0.3, -0.6, 0.6] }],
      [2.2, {}],
      [2.8, {}],
    ],
    proc: (out, t) => {
      if (t > 1 && t < 2.2) out[S.headY] += Math.sin(t * 13) * 0.06
    },
  },
  dormant: { dur: 4, loop: true, keys: [[0, KNEEL]], proc: (out, t) => (out[S.spineX] += Math.sin(t * 0.7) * 0.015) },
  intro: {
    dur: 3.4,
    keys: [
      [0, KNEEL],
      [1.2, { headX: -0.2, spineX: 0.25 }],
      [2.2, { rootY: -0.15, thighLX: -0.6, kneeL: 0.8, thighRX: 0.1, kneeR: 0.6, footR: 0, spineX: 0.0, headX: -0.25 }],
      [2.6, sw([-0.08, 0.5, 0.05], [0.05, 0.9, -0.3], 'chop', { spineX: -0.2, headX: -0.4, poleR: [-0.8, 0.2, -0.2] })],
      [3.4, {}],
    ],
  },
  stagger: {
    dur: 2.6,
    keys: [
      [0.12, { spineX: -0.35, headX: -0.4, rootY: -0.05, twoHand: 0.5 }],
      [0.4, { ...KNEEL, ...plant, twoHand: 0.3, spineX: 0.55, headX: 0.5, handL: [0.3, -0.4, 0.2], bladeL: [0, -1, 0.2] }],
      [2.2, {}],
      [2.6, {}],
    ],
  },
  riposted: {
    dur: 2.4,
    keys: [
      [0, { ...KNEEL, ...plant, twoHand: 0.3, spineX: 0.55, headX: 0.5, handL: [0.3, -0.4, 0.2] }],
      [0.6, { spineX: -0.3, headX: -0.5, chestX: -0.2 }],
      [1.3, { spineX: 0.6, headX: 0.6 }],
      [2.0, {}],
      [2.4, {}],
    ],
  },
  death: {
    dur: 6,
    loop: true,
    keys: [
      [0.3, { spineX: -0.4, headX: -0.6, twoHand: 0.4 }],
      [1.2, { ...KNEEL, ...plant, twoHand: 0, spineX: 0.7, headX: 0.7, handL: [0.3, -0.45, 0.25], bladeL: [0, -1, 0.2] }],
      [2.2, { spineX: 0.9, headX: 0.8 }],
      [6, {}],
    ],
  },
  hurt: { dur: 0.3, keys: [[0.1, { spineX: -0.08 }], [0.3, {}]] },
  parried: { dur: 0.3, keys: [[0.3, {}]] },
}

const ARCHETYPE_CLIPS: Record<Archetype, Record<string, ClipDef>> = {
  knight: KNIGHT_CLIPS,
  hollow: HOLLOW_CLIPS,
  fallen: FALLEN_CLIPS,
  boss: BOSS_CLIPS,
}

// ---------------------------------------------------------------------------
// Compilation: cumulative keys over the stance, cached per archetype.
// ---------------------------------------------------------------------------

export interface CompiledClip {
  def: ClipDef
  keys: Key[]
}

const cache = new Map<string, CompiledClip>()

export function getClip(arche: Archetype, name: string): CompiledClip | null {
  const id = `${arche}:${name}`
  const hit = cache.get(id)
  if (hit) return hit
  const def = ARCHETYPE_CLIPS[arche][name] ?? (arche === 'fallen' ? KNIGHT_CLIPS[name] : undefined)
  if (!def) return null
  const base = STANCES[arche]
  const keys: Key[] = []
  let cur = new Float32Array(base)
  if (def.keys.length === 0 || def.keys[0][0] > 0) keys.push({ t: 0, p: new Float32Array(base) })
  for (const [t, spec] of def.keys) {
    // the last key returns to the stance unless the clip holds its pose
    const isEnd = t >= def.dur - 1e-6 && Object.keys(spec).length === 0 && !def.loop
    cur = isEnd ? new Float32Array(base) : applySpec(new Float32Array(cur), spec)
    keys.push({ t, p: cur })
  }
  const compiled = { def, keys }
  cache.set(id, compiled)
  return compiled
}

const LEG_CHANNELS = [S.thighLX, S.thighLZ, S.kneeL, S.footL, S.thighRX, S.thighRZ, S.kneeR, S.footR, S.lowerY, S.rootY]

export function sampleClip(out: Pose, clip: CompiledClip, t: number, loco: Pose, base: Pose) {
  const def = clip.def
  const tt = def.loop && t > def.dur ? def.dur : t
  sampleKeys(out, clip.keys, tt)
  if (def.legs === 'loco') for (const i of LEG_CHANNELS) out[i] = loco[i]
  def.proc?.(out, t, base)
  return out
}

// ---------------------------------------------------------------------------
// Locomotion
// ---------------------------------------------------------------------------

export interface LocoParams {
  phase: number
  speed: number
  /** Movement direction relative to facing (radians). */
  moveAngle: number
  /** Yaw rate for leaning into turns. */
  turnRate: number
  time: number
  /** Stride scale (relative speed reference for gait). */
  gaitScale: number
}

export function locomotion(out: Pose, arche: Archetype, p: LocoParams) {
  const base = STANCES[arche]
  copyPose(out, base)
  const sp = p.speed / p.gaitScale
  const moving = clamp(sp / 0.8, 0, 1)
  const runW = clamp((sp - 2.4) / 1.6, 0, 1)
  const sprintW = clamp((sp - 5) / 1.6, 0, 1)
  const s = Math.sin(p.phase)
  const c = Math.cos(p.phase)
  const cR = Math.cos(p.phase + Math.PI)

  // strafing / backpedalling: rotate the legs toward travel direction
  let dir = 1
  let lower = 0
  const ma = p.moveAngle
  if (Math.abs(ma) > 1.95) {
    dir = -1
    const back = ma > 0 ? ma - Math.PI : ma + Math.PI
    lower = clamp(back, -0.9, 0.9)
  } else {
    lower = clamp(ma, -1.15, 1.15)
  }

  const amp = (arche === 'hollow' ? 0.32 : 0.4) + 0.32 * runW + 0.18 * sprintW
  const kAmp = 0.55 + 0.75 * runW + 0.35 * sprintW
  const knee0 = arche === 'hollow' ? 0.3 : 0.12

  const tlx = -s * amp * dir
  const trx = s * amp * dir
  out[S.thighLX] = base[S.thighLX] + (tlx - base[S.thighLX]) * moving
  out[S.thighRX] = base[S.thighRX] + (trx - base[S.thighRX]) * moving
  const kl = knee0 + kAmp * Math.pow(Math.max(0, c), 1.3)
  const kr = knee0 + kAmp * Math.pow(Math.max(0, cR), 1.3)
  out[S.kneeL] = base[S.kneeL] + (kl - base[S.kneeL]) * moving
  out[S.kneeR] = base[S.kneeR] + (kr - base[S.kneeR]) * moving
  out[S.footL] = base[S.footL] * (1 - moving) - 0.25 * Math.max(0, c) * moving
  out[S.footR] = base[S.footR] * (1 - moving) - 0.25 * Math.max(0, cR) * moving
  out[S.thighLZ] = base[S.thighLZ] * (1 - moving * 0.7)
  out[S.thighRZ] = base[S.thighRZ] * (1 - moving * 0.7)
  out[S.lowerY] = base[S.lowerY] * (1 - moving) + lower * moving

  const c2 = Math.cos(p.phase * 2)
  const walkBob = (0.022 + (arche === 'boss' ? 0.02 : 0)) * (0.5 - 0.5 * c2)
  const runBob = 0.05 * (0.5 + 0.5 * c2)
  out[S.rootY] += -(walkBob * (1 - runW) + runBob * runW) * moving
  out[S.hipsY] += s * 0.1 * moving
  out[S.hipsZ] += c * 0.035 * moving
  out[S.spineY] -= s * 0.07 * moving
  out[S.chestY] -= s * 0.05 * moving
  const lean = 0.05 * moving + 0.12 * runW + 0.2 * sprintW
  out[S.spineX] += lean * dir
  out[S.headX] -= lean * 0.6
  out[S.pivotZ] = clamp(-p.turnRate * 0.035 * (0.3 + runW), -0.18, 0.18)

  // arm swing (counter to the legs)
  const armSw = (0.06 + 0.08 * runW) * moving * dir
  out[VI.handR + 2] += s * armSw
  out[VI.handL + 2] -= s * armSw * 0.8
  out[VI.handR + 1] += Math.abs(s) * 0.02 * runW

  if (sprintW > 0 && arche === 'knight') {
    const w = sprintW
    const tgtR: V3 = [-0.3, -0.1 + Math.abs(s) * 0.04, -0.08 + s * 0.2]
    const tgtB: V3 = [0.1, 0.55, -0.85]
    for (let i = 0; i < 3; i++) {
      out[VI.handR + i] += (tgtR[i] - out[VI.handR + i]) * w
      out[VI.bladeR + i] += (tgtB[i] - out[VI.bladeR + i]) * w
    }
    out[VI.edgeR] += (0 - out[VI.edgeR]) * w
    out[VI.edgeR + 1] += (1 - out[VI.edgeR + 1]) * w
    out[VI.edgeR + 2] += (0.6 - out[VI.edgeR + 2]) * w
    out[VI.handL + 2] += -s * 0.14 * w
  }

  // idle breathing
  const still = 1 - moving
  const br = Math.sin(p.time * (arche === 'boss' ? 1.1 : 1.7))
  out[S.chestX] += br * 0.02 * still
  out[S.rootY] += br * 0.006 * still
  out[VI.handR + 1] += br * 0.006 * still
  if (arche === 'hollow') {
    out[S.headZ] += Math.sin(p.time * 0.8) * 0.06
    out[S.spineZ] += Math.sin(p.phase * 0.5) * 0.05 * moving
  }
  return out
}

export const scratchPose = () => newPose()
