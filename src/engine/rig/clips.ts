import { clamp } from '../math'
import { applySpec, copyPose, makePose, newPose, S, sampleKeys, VI, type Key, type Pose, type PoseSpec, type V3 } from './pose'

// ---------------------------------------------------------------------------
// Helpers for authoring swings: the sword's edge should lead the motion, so
// it is derived from the swing's rotation axis: edge = axis × blade.
// ---------------------------------------------------------------------------

export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const AX = {
  rl: [0, 1, 0] as V3, // horizontal, right to left
  lr: [0, -1, 0] as V3, // horizontal, left to right
  chop: [1, 0, 0] as V3, // overhead downward
  rise: [-1, 0, 0] as V3,
  diag: [0.6, 0.8, 0] as V3, // upper right to lower left
  rising: [-0.8, -0.6, 0] as V3, // lower left to upper right
}
export type AxisName = keyof typeof AX

/** Sword key: hand position, blade direction, swing axis. */
export const sw = (hand: V3, blade: V3, axis: AxisName = 'rl', extra: PoseSpec = {}): PoseSpec => ({
  handR: hand,
  bladeR: blade,
  edgeR: cross(AX[axis], blade),
  ...extra,
})

export interface ClipDef {
  dur: number
  keys: Array<[number, PoseSpec]>
  /** Keep locomotion legs while playing. */
  legs?: 'loco'
  /** Procedural layer applied after keys. */
  proc?: (out: Pose, t: number, base: Pose) => void
  /** Hold the final pose instead of returning to the stance. */
  hold?: boolean
  loop?: boolean
}

/** How a body walks and runs. */
export interface LocoStyle {
  /** Thigh swing amplitude when walking (radians). */
  amp: number
  /** Resting knee bend. */
  knee0: number
  /** Extra bob for heavy bodies. */
  bob: number
  /** Breathing rate. */
  breath: number
  /** Speed (m/s, in rig units) treated as a full run. */
  gait: number
  /** Optional run pose layered in at high speed (w = 0..1). */
  sprint?: (out: Pose, w: number, s: number) => void
}

export interface ClipSet {
  stance: Pose
  clips: Record<string, ClipDef>
  loco: LocoStyle
}

export interface CompiledClip {
  def: ClipDef
  keys: Key[]
}

const sets = new Map<string, ClipSet>()
const cache = new Map<string, CompiledClip>()

export function registerClipSet(name: string, stance: PoseSpec, clips: Record<string, ClipDef>, loco: LocoStyle) {
  sets.set(name, { stance: makePose(null, stance), clips, loco })
  for (const k of [...cache.keys()]) if (k.startsWith(`${name}:`)) cache.delete(k)
}

export function getClipSet(name: string) {
  const s = sets.get(name)
  if (!s) throw new Error(`unknown clip set ${name}`)
  return s
}

/** Keys accumulate over the stance; the last key returns to the stance unless the clip holds. */
export function getClip(set: string, name: string): CompiledClip | null {
  const id = `${set}:${name}`
  const hit = cache.get(id)
  if (hit) return hit
  const cs = getClipSet(set)
  const def = cs.clips[name]
  if (!def) return null
  const base = cs.stance
  const keys: Key[] = []
  let cur = new Float32Array(base)
  if (def.keys.length === 0 || def.keys[0][0] > 0) keys.push({ t: 0, p: new Float32Array(base) })
  for (const [t, spec] of def.keys) {
    const isEnd = t >= def.dur - 1e-6 && Object.keys(spec).length === 0 && !def.loop && !def.hold
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
  const tt = def.loop ? t % def.dur : Math.min(t, def.dur)
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
}

export function locomotion(out: Pose, set: string, p: LocoParams) {
  const cs = getClipSet(set)
  const L = cs.loco
  const base = cs.stance
  copyPose(out, base)
  const sp = p.speed / L.gait
  const moving = clamp(sp / 0.15, 0, 1)
  const runW = clamp((sp - 0.35) / 0.3, 0, 1)
  const sprintW = clamp((sp - 0.75) / 0.25, 0, 1)
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

  const amp = L.amp + 0.32 * runW + 0.28 * sprintW
  const kAmp = 0.55 + 0.75 * runW + 0.55 * sprintW
  const tlx = -s * amp * dir
  const trx = s * amp * dir
  out[S.thighLX] = base[S.thighLX] + (tlx - base[S.thighLX]) * moving
  out[S.thighRX] = base[S.thighRX] + (trx - base[S.thighRX]) * moving
  const kl = L.knee0 + kAmp * Math.pow(Math.max(0, c), 1.3)
  const kr = L.knee0 + kAmp * Math.pow(Math.max(0, cR), 1.3)
  out[S.kneeL] = base[S.kneeL] + (kl - base[S.kneeL]) * moving
  out[S.kneeR] = base[S.kneeR] + (kr - base[S.kneeR]) * moving
  out[S.footL] = base[S.footL] * (1 - moving) - 0.25 * Math.max(0, c) * moving
  out[S.footR] = base[S.footR] * (1 - moving) - 0.25 * Math.max(0, cR) * moving
  out[S.thighLZ] = base[S.thighLZ] * (1 - moving * 0.7)
  out[S.thighRZ] = base[S.thighRZ] * (1 - moving * 0.7)
  out[S.lowerY] = base[S.lowerY] * (1 - moving) + lower * moving

  const c2 = Math.cos(p.phase * 2)
  const walkBob = (0.022 + L.bob) * (0.5 - 0.5 * c2)
  const runBob = 0.05 * (0.5 + 0.5 * c2)
  out[S.rootY] += -(walkBob * (1 - runW) + runBob * runW) * moving
  out[S.hipsY] += s * 0.1 * moving
  out[S.hipsZ] += c * 0.035 * moving
  out[S.spineY] -= s * 0.07 * moving
  out[S.chestY] -= s * 0.05 * moving
  const lean = 0.05 * moving + 0.12 * runW + 0.3 * sprintW
  out[S.spineX] += lean * dir
  out[S.headX] -= lean * 0.6
  out[S.pivotZ] = clamp(-p.turnRate * 0.035 * (0.3 + runW), -0.22, 0.22)

  // arm swing (counter to the legs)
  const armSw = (0.06 + 0.08 * runW) * moving * dir
  out[VI.handR + 2] += s * armSw
  out[VI.handL + 2] -= s * armSw * 0.8
  out[VI.handR + 1] += Math.abs(s) * 0.02 * runW

  if (sprintW > 0 && L.sprint) L.sprint(out, sprintW, s)

  // idle breathing
  const still = 1 - moving
  const br = Math.sin(p.time * L.breath)
  out[S.chestX] += br * 0.02 * still
  out[S.rootY] += br * 0.006 * still
  out[VI.handR + 1] += br * 0.006 * still
  return out
}

/** Blend a target vector channel toward a value (for procedural layers). */
export function pullVec(out: Pose, key: keyof typeof VI, v: V3, w: number) {
  const i = VI[key]
  out[i] += (v[0] - out[i]) * w
  out[i + 1] += (v[1] - out[i + 1]) * w
  out[i + 2] += (v[2] - out[i + 2]) * w
}

export const scratchPose = () => newPose()
