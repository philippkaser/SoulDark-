import { BOXES, CIRCLES, ZONES, type Zone } from './level'

export interface CollideOpts {
  /** Is the fog wall currently solid? */
  fogClosed: boolean
  /** Entity is walking through the fog (traversal animation). */
  ignoreFog?: boolean
  /** Additional dynamic circles (other characters). */
  extra?: ReadonlyArray<{ x: number; z: number; r: number }>
  /** Expand the walkable zones by this much (used for the camera). */
  zoneMargin?: number
  /** Skip static obstacles (camera uses its own ray test). */
  skipObstacles?: boolean
}

const out: [number, number] = [0, 0]

function projectIntoZone(zone: Zone, x: number, z: number, r: number): [boolean, number, number, number] {
  if (zone.kind === 'circle') {
    const dx = x - zone.x
    const dz = z - zone.z
    const d = Math.sqrt(dx * dx + dz * dz)
    const R = zone.r - r
    if (d <= R) return [true, x, z, 0]
    const k = R / Math.max(d, 1e-6)
    return [false, zone.x + dx * k, zone.z + dz * k, d - R]
  }
  const x0 = zone.x0 + r
  const x1 = zone.x1 - r
  const z0 = zone.z0 + r
  const z1 = zone.z1 - r
  if (x >= x0 && x <= x1 && z >= z0 && z <= z1) return [true, x, z, 0]
  const cx = Math.min(Math.max(x, x0), x1)
  const cz = Math.min(Math.max(z, z0), z1)
  return [false, cx, cz, Math.hypot(cx - x, cz - z)]
}

/** Keep a point inside the union of walkable zones. */
export function clampToZones(x: number, z: number, r: number): [number, number] {
  let bx = x
  let bz = z
  let best = Infinity
  for (const zone of ZONES) {
    const [inside, px, pz, d] = projectIntoZone(zone, x, z, r)
    if (inside) return [x, z]
    if (d < best) {
      best = d
      bx = px
      bz = pz
    }
  }
  return [bx, bz]
}

export function insideZones(x: number, z: number, margin = 0) {
  for (const zone of ZONES) {
    if (projectIntoZone(zone, x, z, -margin)[0]) return true
  }
  return false
}

function pushOutCircle(x: number, z: number, r: number, cx: number, cz: number, cr: number) {
  const dx = x - cx
  const dz = z - cz
  const min = r + cr
  const d2 = dx * dx + dz * dz
  if (d2 >= min * min) return false
  const d = Math.sqrt(d2)
  if (d < 1e-5) {
    out[0] = cx + min
    out[1] = cz
  } else {
    out[0] = cx + (dx / d) * min
    out[1] = cz + (dz / d) * min
  }
  return true
}

function pushOutBox(x: number, z: number, r: number, b: (typeof BOXES)[number]) {
  const c = Math.cos(b.rot)
  const s = Math.sin(b.rot)
  // into box local space
  const dx = x - b.x
  const dz = z - b.z
  const lx = dx * c - dz * s
  const lz = dx * s + dz * c
  const qx = Math.min(Math.max(lx, -b.hw), b.hw)
  const qz = Math.min(Math.max(lz, -b.hd), b.hd)
  let ex = lx - qx
  let ez = lz - qz
  const d2 = ex * ex + ez * ez
  let nx: number
  let nz: number
  if (d2 > 1e-8) {
    if (d2 >= r * r) return false
    const d = Math.sqrt(d2)
    ex /= d
    ez /= d
    nx = qx + ex * r
    nz = qz + ez * r
  } else {
    // center inside the box: push along the axis of least penetration
    const px = b.hw - Math.abs(lx)
    const pz = b.hd - Math.abs(lz)
    if (px < pz) {
      nx = Math.sign(lx || 1) * (b.hw + r)
      nz = lz
    } else {
      nx = lx
      nz = Math.sign(lz || 1) * (b.hd + r)
    }
  }
  // back to world space
  out[0] = b.x + nx * c + nz * s
  out[1] = b.z - nx * s + nz * c
  return true
}

/** Resolve a character's position against the level. Returns a new [x, z]. */
export function collide(x: number, z: number, r: number, opts: CollideOpts): [number, number] {
  for (let iter = 0; iter < 3; iter++) {
    let moved = false
    if (!opts.skipObstacles) {
      for (const c of CIRCLES) {
        if (pushOutCircle(x, z, r, c.x, c.z, c.r)) {
          x = out[0]
          z = out[1]
          moved = true
        }
      }
      for (const b of BOXES) {
        if (b.kind === 'fog' && (!opts.fogClosed || opts.ignoreFog)) continue
        if (pushOutBox(x, z, r, b)) {
          x = out[0]
          z = out[1]
          moved = true
        }
      }
    }
    if (opts.extra) {
      for (const c of opts.extra) {
        if (pushOutCircle(x, z, r, c.x, c.z, c.r)) {
          x = out[0]
          z = out[1]
          moved = true
        }
      }
    }
    const [cx, cz] = clampToZones(x, z, r - (opts.zoneMargin ?? 0))
    if (cx !== x || cz !== z) moved = true
    x = cx
    z = cz
    if (!moved) break
  }
  return [x, z]
}

/**
 * 2D ray march against tall obstacles, used to keep the camera from clipping
 * into pillars. Returns the fraction [0..1] of the ray that is free.
 */
export function raycastTall(ax: number, az: number, bx: number, bz: number, pad: number) {
  let tMin = 1
  const dx = bx - ax
  const dz = bz - az
  const len2 = dx * dx + dz * dz
  if (len2 < 1e-8) return 1
  for (const c of CIRCLES) {
    if (!c.tall) continue
    // ray-circle intersection
    const fx = ax - c.x
    const fz = az - c.z
    const R = c.r + pad
    const b = fx * dx + fz * dz
    const cc = fx * fx + fz * fz - R * R
    const disc = b * b - len2 * cc
    if (disc < 0) continue
    const t = (-b - Math.sqrt(disc)) / len2
    if (t > 0 && t < tMin) tMin = t
  }
  for (const box of BOXES) {
    if (!box.tall) continue
    const R = Math.max(box.hw, box.hd) + pad
    const fx = ax - box.x
    const fz = az - box.z
    const b = fx * dx + fz * dz
    const cc = fx * fx + fz * fz - R * R
    const disc = b * b - len2 * cc
    if (disc < 0) continue
    const t = (-b - Math.sqrt(disc)) / len2
    if (t > 0 && t < tMin) tMin = t
  }
  return tMin
}
