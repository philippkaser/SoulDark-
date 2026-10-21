import * as THREE from 'three'

/** The heightfield a decal drapes over (Terrain satisfies it). */
export interface DecalGround {
  readonly tex: THREE.Texture
  readonly half: number
}

/**
 * Vertex shader for a flat grid draped over the terrain heightfield. Vertices
 * sit on the ground mesh's own lattice and sample the same texels, so the
 * decal follows craters and trenches exactly instead of floating or sinking.
 * Fragments get `vRel`: world metres from the decal's true centre.
 */
export const DECAL_VERT = /* glsl */ `
uniform sampler2D uHeight;
uniform float uHalf;
uniform vec3 uCenter;
uniform float uLift;
varying vec2 vRel;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  float h = uHalf > 0.0 ? textureLod(uHeight, w.xz / (2.0 * uHalf) + 0.5, 0.0).r : 0.0;
  w.y = h + uLift;
  vRel = w.xz - uCenter.xz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

export type DecalUniforms = ReturnType<typeof decalUniforms>

export function decalUniforms() {
  return {
    uHeight: { value: null as THREE.Texture | null },
    uHalf: { value: 0 },
    uCenter: { value: new THREE.Vector3() },
    uLift: { value: 0.04 },
  }
}

/** Spacing of the ground mesh's vertex grid (the plane spanning the terrain field), else ~2 m. */
export function groundLattice(ground: THREE.Object3D | null, half: number) {
  let cell = (half * 2) / 256
  ground?.traverse((o) => {
    const g = (o as THREE.Mesh).geometry as THREE.PlaneGeometry | undefined
    const p = g?.parameters
    if (g?.type === 'PlaneGeometry' && p && p.width >= half * 2 - 1e-3 && p.widthSegments > 1) cell = p.width / p.widthSegments
  })
  return cell
}

/**
 * A square grid of `radius` around a point, lying on the ground. place()
 * snaps the grid onto the ground lattice and passes the exact centre to the
 * shader, so patterns stay centred while the triangles match the ground's.
 */
export class TerrainDecal {
  readonly mesh: THREE.Mesh
  readonly uniforms: DecalUniforms
  private cell: number

  /** `material` must use DECAL_VERT and carry decalUniforms(). */
  constructor(radius: number, material: THREE.ShaderMaterial, cell = 2) {
    this.cell = cell
    const n = Math.max(2, Math.ceil((radius * 2) / cell / 2) * 2 + 2)
    const geo = new THREE.PlaneGeometry(n * cell, n * cell, n, n).rotateX(-Math.PI / 2)
    this.uniforms = material.uniforms as unknown as DecalUniforms
    this.mesh = new THREE.Mesh(geo, material)
    this.mesh.frustumCulled = false
    this.mesh.visible = false
  }

  setGround(ground: DecalGround | null) {
    this.uniforms.uHeight.value = ground?.tex ?? null
    this.uniforms.uHalf.value = ground?.tex ? ground.half : 0
  }

  place(x: number, z: number) {
    const c = this.cell
    this.mesh.position.set(Math.round(x / c) * c, 0, Math.round(z / c) * c)
    this.uniforms.uCenter.value.set(x, 0, z)
  }
}
