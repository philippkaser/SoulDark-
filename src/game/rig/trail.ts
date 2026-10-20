import * as THREE from 'three'

const MAX = 28
const LIFE = 0.16

const vert = /* glsl */ `
attribute float aAlpha;
attribute float aV;
varying float vAlpha;
varying float vV;
void main() {
  vAlpha = aAlpha;
  vV = aV;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`
const frag = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
varying float vAlpha;
varying float vV;
void main() {
  float a = vAlpha * smoothstep(0.0, 0.85, vV);
  a *= a;
  gl_FragColor = vec4(uColor * uIntensity * a, a);
}
`

/** Ribbon that follows the blade during swings. */
export class SwordTrail {
  readonly mesh: THREE.Mesh
  private base: THREE.Vector3[] = []
  private tip: THREE.Vector3[] = []
  private age: number[] = []
  private geo: THREE.BufferGeometry
  private posAttr: THREE.BufferAttribute
  private alphaAttr: THREE.BufferAttribute
  readonly uniforms: { uColor: { value: THREE.Color }; uIntensity: { value: number } }

  constructor(color = '#cfe0ff', intensity = 1.4) {
    this.geo = new THREE.BufferGeometry()
    this.posAttr = new THREE.BufferAttribute(new Float32Array(MAX * 2 * 3), 3)
    this.posAttr.setUsage(THREE.DynamicDrawUsage)
    this.alphaAttr = new THREE.BufferAttribute(new Float32Array(MAX * 2), 1)
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage)
    const v = new Float32Array(MAX * 2)
    for (let i = 0; i < MAX; i++) {
      v[i * 2] = 0
      v[i * 2 + 1] = 1
    }
    this.geo.setAttribute('position', this.posAttr)
    this.geo.setAttribute('aAlpha', this.alphaAttr)
    this.geo.setAttribute('aV', new THREE.BufferAttribute(v, 1))
    const idx: number[] = []
    for (let i = 0; i < MAX - 1; i++) {
      const a = i * 2
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
    this.geo.setIndex(idx)
    this.geo.setDrawRange(0, 0)
    this.uniforms = { uColor: { value: new THREE.Color(color) }, uIntensity: { value: intensity } }
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    })
    this.mesh = new THREE.Mesh(this.geo, mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 5
  }

  update(dt: number, base: THREE.Vector3, tip: THREE.Vector3, emit: boolean) {
    for (let i = 0; i < this.age.length; i++) this.age[i] += dt
    while (this.age.length && this.age[0] > LIFE) {
      this.age.shift()
      this.base.shift()
      this.tip.shift()
    }
    if (emit) {
      const lastTip = this.tip[this.tip.length - 1]
      if (!lastTip || lastTip.distanceToSquared(tip) > 1e-5) {
        // subdivide fast swings so the ribbon stays smooth at low frame rates
        if (lastTip && this.tip.length >= 2) {
          const pb = this.base[this.base.length - 1]
          const steps = Math.min(3, Math.floor(lastTip.distanceTo(tip) / 0.18))
          for (let s = 1; s <= steps; s++) {
            const k = s / (steps + 1)
            this.push(pb.clone().lerp(base, k), lastTip.clone().lerp(tip, k), 0)
          }
        }
        this.push(base.clone(), tip.clone(), 0)
      }
    }
    const n = this.base.length
    const pos = this.posAttr.array as Float32Array
    const al = this.alphaAttr.array as Float32Array
    for (let i = 0; i < n; i++) {
      const b = this.base[i]
      const t = this.tip[i]
      pos[i * 6] = b.x
      pos[i * 6 + 1] = b.y
      pos[i * 6 + 2] = b.z
      pos[i * 6 + 3] = t.x
      pos[i * 6 + 4] = t.y
      pos[i * 6 + 5] = t.z
      const life = 1 - this.age[i] / LIFE
      const order = (i + 1) / n
      const a = Math.max(0, life) * order
      al[i * 2] = a
      al[i * 2 + 1] = a
    }
    this.posAttr.needsUpdate = true
    this.alphaAttr.needsUpdate = true
    this.geo.setDrawRange(0, n > 1 ? (n - 1) * 6 : 0)
  }

  private push(b: THREE.Vector3, t: THREE.Vector3, age: number) {
    this.base.push(b)
    this.tip.push(t)
    this.age.push(age)
    if (this.base.length > MAX) {
      this.base.shift()
      this.tip.shift()
      this.age.shift()
    }
  }
}
