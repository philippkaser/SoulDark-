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
