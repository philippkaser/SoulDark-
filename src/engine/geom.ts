import * as THREE from 'three'

const _d1 = new THREE.Vector3()
const _d2 = new THREE.Vector3()
const _r = new THREE.Vector3()

/**
 * Closest distance between segments p1-q1 and p2-q2 (Ericson, RTCD 5.1.9).
 * Writes the closest point on the first segment into `out`.
 */
export function segmentSegmentDist(
  p1: THREE.Vector3,
  q1: THREE.Vector3,
  p2: THREE.Vector3,
  q2: THREE.Vector3,
  out?: THREE.Vector3,
) {
  _d1.subVectors(q1, p1)
  _d2.subVectors(q2, p2)
  _r.subVectors(p1, p2)
  const a = _d1.dot(_d1)
  const e = _d2.dot(_d2)
  const f = _d2.dot(_r)
  let s = 0
  let t = 0
  if (a <= 1e-8 && e <= 1e-8) {
    if (out) out.copy(p1)
    return p1.distanceTo(p2)
  }
  if (a <= 1e-8) {
    s = 0
    t = Math.min(1, Math.max(0, f / e))
  } else {
    const c = _d1.dot(_r)
    if (e <= 1e-8) {
      t = 0
      s = Math.min(1, Math.max(0, -c / a))
    } else {
      const b = _d1.dot(_d2)
      const denom = a * e - b * b
      s = denom !== 0 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0
      t = (b * s + f) / e
      if (t < 0) {
        t = 0
        s = Math.min(1, Math.max(0, -c / a))
      } else if (t > 1) {
        t = 1
        s = Math.min(1, Math.max(0, (b - c) / a))
      }
    }
  }
  const cx = p1.x + _d1.x * s
  const cy = p1.y + _d1.y * s
  const cz = p1.z + _d1.z * s
  const dx = cx - (p2.x + _d2.x * t)
  const dy = cy - (p2.y + _d2.y * t)
  const dz = cz - (p2.z + _d2.z * t)
  if (out) out.set(cx, cy, cz)
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/** Distance from point p to segment a-b (all components as numbers to stay allocation-free). */
export function distPointSegment(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
) {
  const abx = bx - ax
  const aby = by - ay
  const abz = bz - az
  const len2 = abx * abx + aby * aby + abz * abz
  let t = len2 > 1e-9 ? ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / len2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const dx = px - (ax + abx * t)
  const dy = py - (ay + aby * t)
  const dz = pz - (az + abz * t)
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/**
 * Attack volumes. Every damaging thing in the game is one of these, tested
 * against whatever it might touch.
 */
export type Shape =
  | { t: 'sphere'; c: THREE.Vector3; r: number }
  | { t: 'capsule'; a: THREE.Vector3; b: THREE.Vector3; r: number }
  /** Horizontal wedge in front of `c` between heights y0..y1 (melee swings). */
  | { t: 'sector'; c: THREE.Vector3; dir: THREE.Vector3; range: number; cos: number; y0: number; y1: number }
  /** A vertical wall along a-b (xz), half-thickness r, from the ground up to height h (the Heaven Splitter). */
  | { t: 'slab'; a: THREE.Vector3; b: THREE.Vector3; r: number; h: number }
  /** A horizontal band between radii r0..r1 around c, up to height h (expanding shockwaves). */
  | { t: 'ring'; c: THREE.Vector3; r0: number; r1: number; h: number }

/** Does the shape touch a sphere at (x, y, z) with radius r? */
export function shapeHitsSphere(s: Shape, x: number, y: number, z: number, r: number): boolean {
  switch (s.t) {
    case 'sphere': {
      const dx = x - s.c.x
      const dy = y - s.c.y
      const dz = z - s.c.z
      const rr = s.r + r
      return dx * dx + dy * dy + dz * dz <= rr * rr
    }
    case 'capsule':
      return distPointSegment(x, y, z, s.a.x, s.a.y, s.a.z, s.b.x, s.b.y, s.b.z) <= s.r + r
    case 'sector': {
      if (y + r < s.y0 || y - r > s.y1) return false
      const dx = x - s.c.x
      const dz = z - s.c.z
      const d = Math.sqrt(dx * dx + dz * dz)
      if (d > s.range + r) return false
      if (d < r + 0.5) return true
      // widen the cone by the target's angular radius
      const cosT = (dx * s.dir.x + dz * s.dir.z) / d
      const pad = Math.asin(Math.min(1, r / d))
      return Math.acos(Math.max(-1, Math.min(1, cosT))) <= Math.acos(s.cos) + pad
    }
    case 'slab':
      if (y - r > s.h) return false
      return distPointSegment(x, 0, z, s.a.x, 0, s.a.z, s.b.x, 0, s.b.z) <= s.r + r
    case 'ring': {
      if (y - r > s.h) return false
      const d = Math.hypot(x - s.c.x, z - s.c.z)
      return d >= s.r0 - r && d <= s.r1 + r
    }
  }
}

const _sa = new THREE.Vector3()
const _sb = new THREE.Vector3()

/** Does the shape touch a capsule a-b of radius r (e.g. a giant's body)? */
export function shapeHitsCapsule(s: Shape, a: THREE.Vector3, b: THREE.Vector3, r: number): boolean {
  switch (s.t) {
    case 'sphere':
      return distPointSegment(s.c.x, s.c.y, s.c.z, a.x, a.y, a.z, b.x, b.y, b.z) <= s.r + r
    case 'capsule':
      return segmentSegmentDist(s.a, s.b, a, b) <= s.r + r
    case 'sector':
    case 'slab':
    case 'ring': {
      // sample the capsule's axis
      for (let i = 0; i <= 6; i++) {
        _sa.lerpVectors(a, b, i / 6)
        if (shapeHitsSphere(s, _sa.x, _sa.y, _sa.z, r)) return true
      }
      return false
    }
  }
}

/** Closest point on the shape's core to p (for spark placement). */
export function shapeContact(s: Shape, p: THREE.Vector3, out: THREE.Vector3) {
  switch (s.t) {
    case 'sphere':
      return out.copy(p).sub(s.c).setLength(Math.min(s.r, p.distanceTo(s.c))).add(s.c)
    case 'capsule': {
      _sb.subVectors(s.b, s.a)
      const len2 = _sb.lengthSq() || 1e-9
      const t = Math.max(0, Math.min(1, _sa.subVectors(p, s.a).dot(_sb) / len2))
      return out.copy(s.a).addScaledVector(_sb, t)
    }
    case 'slab': {
      _sb.subVectors(s.b, s.a).setY(0)
      const len2 = _sb.lengthSq() || 1e-9
      const t = Math.max(0, Math.min(1, _sa.subVectors(p, s.a).setY(0).dot(_sb) / len2))
      return out.copy(s.a).addScaledVector(_sb, t).setY(Math.min(p.y, s.h))
    }
    case 'sector':
    case 'ring':
      return out.copy(p)
  }
}

/** XZ bounding box of a shape, for grid queries. */
export function shapeBounds(s: Shape): [number, number, number, number] {
  switch (s.t) {
    case 'sphere':
      return [s.c.x - s.r, s.c.z - s.r, s.c.x + s.r, s.c.z + s.r]
    case 'capsule':
      return [Math.min(s.a.x, s.b.x) - s.r, Math.min(s.a.z, s.b.z) - s.r, Math.max(s.a.x, s.b.x) + s.r, Math.max(s.a.z, s.b.z) + s.r]
    case 'sector':
      return [s.c.x - s.range, s.c.z - s.range, s.c.x + s.range, s.c.z + s.range]
    case 'slab':
      return [Math.min(s.a.x, s.b.x) - s.r, Math.min(s.a.z, s.b.z) - s.r, Math.max(s.a.x, s.b.x) + s.r, Math.max(s.a.z, s.b.z) + s.r]
    case 'ring':
      return [s.c.x - s.r1, s.c.z - s.r1, s.c.x + s.r1, s.c.z + s.r1]
  }
}
