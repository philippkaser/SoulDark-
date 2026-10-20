export const TAU = Math.PI * 2

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const invLerp = (a: number, b: number, v: number) => clamp((v - a) / (b - a), 0, 1)
export const smoothstep = (a: number, b: number, v: number) => {
  const t = invLerp(a, b, v)
  return t * t * (3 - 2 * t)
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number) {
  a = (a + Math.PI) % TAU
  if (a < 0) a += TAU
  return a - Math.PI
}

/** Shortest signed difference b - a between two angles. */
export const angleDiff = (a: number, b: number) => wrapAngle(b - a)

/** Rotate angle `a` toward `b` by at most `maxStep` radians. */
export function turnToward(a: number, b: number, maxStep: number) {
  const d = angleDiff(a, b)
  if (Math.abs(d) <= maxStep) return b
  return wrapAngle(a + Math.sign(d) * maxStep)
}

/** Frame-rate independent exponential smoothing factor. */
export const damp = (lambda: number, dt: number) => 1 - Math.exp(-lambda * dt)

export const dist2 = (ax: number, az: number, bx: number, bz: number) => {
  const dx = bx - ax
  const dz = bz - az
  return Math.sqrt(dx * dx + dz * dz)
}

/** Yaw convention: forward vector is (sin(yaw), cos(yaw)) on the XZ plane. */
export const yawTo = (fromX: number, fromZ: number, toX: number, toZ: number) =>
  Math.atan2(toX - fromX, toZ - fromZ)

/** Sample a piecewise-linear curve given as [t, value] pairs (sorted by t). */
export function sampleCurve(curve: ReadonlyArray<readonly [number, number]>, t: number) {
  if (curve.length === 0) return 0
  if (t <= curve[0][0]) return curve[0][1]
  for (let i = 1; i < curve.length; i++) {
    const [t1, v1] = curve[i]
    if (t <= t1) {
      const [t0, v0] = curve[i - 1]
      const k = (t - t0) / Math.max(1e-6, t1 - t0)
      // smooth the segment so root motion has eased velocity
      const s = k * k * (3 - 2 * k)
      return v0 + (v1 - v0) * s
    }
  }
  return curve[curve.length - 1][1]
}

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashString(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
