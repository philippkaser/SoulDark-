import { angleDiff } from '../math'

/**
 * A pose is a flat Float32Array so blending is cheap.
 * Scalars are joint angles (radians) or small offsets (metres).
 * Arms are driven by IK: hand target, blade direction, edge direction and elbow
 * pole are given in chest space (+x = character's left, +y up, +z forward).
 */
export const SCALARS = [
  'rootY',
  'rootZ',
  'pivotX',
  'pivotZ',
  'hipsX',
  'hipsY',
  'hipsZ',
  'spineX',
  'spineY',
  'spineZ',
  'chestX',
  'chestY',
  'chestZ',
  'headX',
  'headY',
  'headZ',
  'thighLX',
  'thighLZ',
  'kneeL',
  'footL',
  'thighRX',
  'thighRZ',
  'kneeR',
  'footR',
  'twoHand',
  'lowerY',
] as const

export const VECS = ['handR', 'bladeR', 'edgeR', 'poleR', 'handL', 'bladeL', 'edgeL', 'poleL'] as const

export type ScalarKey = (typeof SCALARS)[number]
export type VecKey = (typeof VECS)[number]
export type V3 = readonly [number, number, number]

export type PoseSpec = Partial<Record<ScalarKey, number>> & Partial<Record<VecKey, V3>>

export const POSE_SIZE = SCALARS.length + VECS.length * 3
export const S: Record<ScalarKey, number> = Object.fromEntries(SCALARS.map((k, i) => [k, i])) as Record<ScalarKey, number>
export const VI: Record<VecKey, number> = Object.fromEntries(
  VECS.map((k, i) => [k, SCALARS.length + i * 3]),
) as Record<VecKey, number>

export type Pose = Float32Array<ArrayBuffer>

export const newPose = (): Pose => new Float32Array(POSE_SIZE)

export function applySpec(out: Pose, spec: PoseSpec) {
  for (const k in spec) {
    const v = (spec as Record<string, number | V3>)[k]
    if (typeof v === 'number') out[S[k as ScalarKey]] = v
    else if (v) {
      const i = VI[k as VecKey]
      out[i] = v[0]
      out[i + 1] = v[1]
      out[i + 2] = v[2]
    }
  }
  return out
}

/** Add a spec on top of a pose (for layered offsets). */
export function addSpec(out: Pose, spec: PoseSpec, w = 1) {
  for (const k in spec) {
    const v = (spec as Record<string, number | V3>)[k]
    if (typeof v === 'number') out[S[k as ScalarKey]] += v * w
    else if (v) {
      const i = VI[k as VecKey]
      out[i] += v[0] * w
      out[i + 1] += v[1] * w
      out[i + 2] += v[2] * w
    }
  }
  return out
}

export function makePose(base: Pose | null, spec: PoseSpec) {
  const p = base ? new Float32Array(base) : newPose()
  return applySpec(p, spec)
}

export function copyPose(out: Pose, src: Pose) {
  out.set(src)
  return out
}

/** out = a + (b - a) * t ; angles take the shortest path. */
export function blendPose(out: Pose, a: Pose, b: Pose, t: number) {
  const n = SCALARS.length
  for (let i = 0; i < n; i++) out[i] = a[i] + angleDiff(a[i], b[i]) * t
  for (let i = n; i < POSE_SIZE; i++) out[i] = a[i] + (b[i] - a[i]) * t
  return out
}

/** Catmull-Rom between p1 and p2 (p0/p3 neighbours) for smooth arcs. */
export function catmullPose(out: Pose, p0: Pose, p1: Pose, p2: Pose, p3: Pose, t: number) {
  const t2 = t * t
  const t3 = t2 * t
  for (let i = 0; i < POSE_SIZE; i++) {
    const a = p0[i]
    const b = p1[i]
    const c = p2[i]
    const d = p3[i]
    out[i] = 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
  }
  return out
}

export interface Key {
  t: number
  p: Pose
}

/** Sample keyframes. Times outside the range clamp to the ends. */
export function sampleKeys(out: Pose, keys: Key[], t: number) {
  if (keys.length === 1 || t <= keys[0].t) return copyPose(out, keys[0].p)
  const last = keys[keys.length - 1]
  if (t >= last.t) return copyPose(out, last.p)
  let i = 0
  while (i < keys.length - 2 && keys[i + 1].t < t) i++
  const k1 = keys[i]
  const k2 = keys[i + 1]
  const k0 = keys[Math.max(0, i - 1)]
  const k3 = keys[Math.min(keys.length - 1, i + 2)]
  const u = (t - k1.t) / Math.max(1e-5, k2.t - k1.t)
  return catmullPose(out, k0.p, k1.p, k2.p, k3.p, u)
}
