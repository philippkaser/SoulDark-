import * as THREE from 'three'
import { standard } from '../../engine/gfx/materials'
import { armorTextures, canvasTexture, clothTextures, tatteredAlpha } from '../../engine/gfx/textures'
import type { CharacterModel } from '../../engine/rig/avatar'
import { add, bladeGeometry, mergeStatic, taperTube } from '../../engine/rig/build'
import { Cape, type Capsule } from '../../engine/rig/cape'
import { HUMAN_DIMS, Rig } from '../../engine/rig/rig'
import { SwordTrail } from '../../engine/rig/trail'

export interface HeroModel extends CharacterModel {
  halo: THREE.Group
  energyBlade: THREE.Mesh
  energyU: { uTime: { value: number }; uLen: { value: number }; uPower: { value: number } }
  glowMat: THREE.MeshStandardMaterial
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

/** Ivory coat with a gold hem. */
function coatTexture() {
  return canvasTexture(128, 256, (ctx) => {
    ctx.fillStyle = '#ddd5c6'
    ctx.fillRect(0, 0, 128, 256)
    for (let i = 0; i < 600; i++) {
      ctx.fillStyle = `rgba(90,70,50,${Math.random() * 0.05})`
      ctx.fillRect(Math.random() * 128, Math.random() * 256, 1 + Math.random() * 3, 1 + Math.random() * 8)
    }
    ctx.fillStyle = '#b8892f'
    ctx.fillRect(0, 222, 128, 10)
    ctx.fillRect(0, 238, 128, 3)
    ctx.fillRect(0, 0, 4, 256)
    ctx.fillRect(124, 0, 4, 256)
  })
}

function scarfTexture() {
  return canvasTexture(64, 256, (ctx) => {
    ctx.fillStyle = '#7d0d16'
    ctx.fillRect(0, 0, 64, 256)
    ctx.fillStyle = '#c99a3a'
    ctx.fillRect(0, 0, 3, 256)
    ctx.fillRect(61, 0, 3, 256)
    for (let i = 0; i < 300; i++) {
      ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.08})`
      ctx.fillRect(Math.random() * 64, Math.random() * 256, 2, 6)
    }
  })
}

const energyVert = /* glsl */ `
varying vec2 vUv;
uniform float uLen;
void main() {
  vUv = uv;
  vec3 p = position;
  p.z *= uLen;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`
const energyFrag = /* glsl */ `
varying vec2 vUv;
uniform float uTime;
uniform float uPower;
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
void main() {
  float across = abs(vUv.x - 0.5) * 2.0;
  float along = 1.0 - vUv.y;
  float flow = n(vec2(vUv.x * 6.0, along * 30.0 - uTime * 14.0)) * 0.6 + n(vec2(vUv.x * 14.0, along * 70.0 - uTime * 25.0)) * 0.4;
  float taper = smoothstep(1.0, 0.82, along) * smoothstep(0.0, 0.02, along);
  float core = smoothstep(0.35, 0.0, across) * taper;
  float halo = smoothstep(1.0, 0.0, across + flow * 0.35) * taper;
  vec3 col = vec3(1.0, 0.7, 0.3) * halo * 1.5 + vec3(3.0, 2.8, 2.4) * core;
  float a = clamp(halo * 0.8 + core, 0.0, 1.0) * uPower;
  gl_FragColor = vec4(col * uPower, a);
}
`

export function buildHero(): HeroModel {
  const rig = new Rig({ ...HUMAN_DIMS, shoulderX: 0.21 })
  const A = armorTextures()
  const C = clothTextures()
  const mats: THREE.MeshStandardMaterial[] = []
  const reg = <T extends THREE.MeshStandardMaterial>(m: T) => {
    mats.push(m)
    return m
  }
  const rimGold = '#ffcf7a'
  const armor = reg(
    standard({ color: '#4a4b55', metalness: 0.82, roughness: 0.75, map: A.map, normalMap: A.normalMap, roughnessMap: A.roughnessMap, normalScale: 0.45, rim: 0.55, rimColor: rimGold }),
  )
  const under = reg(standard({ color: '#2b2a30', roughness: 0.85, normalMap: C.normalMap, normalScale: 0.8, rim: 0.35, rimColor: rimGold }))
  const gold = reg(standard({ color: '#c9a04a', metalness: 1, roughness: 0.28, emissive: '#ff9a30', emissiveIntensity: 0.12, rim: 0.5, rimColor: rimGold }))
  const glow = reg(standard({ color: '#000000', emissive: '#ffe1a0', emissiveIntensity: 7, rim: 0 }))
  const blade = reg(standard({ color: '#eef2f8', metalness: 1, roughness: 0.14, rim: 0.7, rimColor: '#fff2d0' }))

  // --- pelvis + tassets
  add(rig.hips, new THREE.CylinderGeometry(0.16, 0.16, 0.07, 18), gold, [0, 0.02, 0], [0, 0, 0], [1, 1, 0.8])
  add(rig.hips, new THREE.CylinderGeometry(0.162, 0.2, 0.16, 18, 1, true), under, [0, -0.08, 0], [0, 0, 0], [1, 1, 0.8])
  for (const [x, z, ry] of [
    [0.1, 0.11, 0.25],
    [-0.1, 0.11, -0.25],
    [0.13, -0.07, 2.4],
    [-0.13, -0.07, -2.4],
  ] as const) {
    add(rig.hips, new THREE.BoxGeometry(0.13, 0.2, 0.018), armor, [x, -0.1, z], [0.18, ry, 0])
    add(rig.hips, new THREE.BoxGeometry(0.13, 0.014, 0.022), gold, [x, -0.2, z + Math.sign(z) * 0.018], [0.18, ry, 0])
  }

  // --- torso
  add(rig.spine, new THREE.CylinderGeometry(0.14, 0.155, 0.19, 16), under, [0, 0.04, 0], [0, 0, 0], [1, 1, 0.78])
  const profile = [
    [0.12, -0.2],
    [0.16, -0.12],
    [0.19, -0.02],
    [0.205, 0.08],
    [0.195, 0.16],
    [0.15, 0.215],
    [0.09, 0.24],
    [0.06, 0.245],
  ].map(([r, y]) => new THREE.Vector2(r, y))
  add(rig.chest, new THREE.LatheGeometry(profile, 24), armor, [0, 0, 0], [0, 0, 0], [1, 1, 0.72])
  // gold filigree ribs + chest sigil
  for (let i = 0; i < 3; i++) add(rig.chest, new THREE.TorusGeometry(0.19 - i * 0.012, 0.005, 5, 28, Math.PI * 0.7), gold, [0, -0.02 + i * 0.06, 0.005], [0, 0, Math.PI * 0.15], [1, 1, 0.74])
  add(rig.chest, new THREE.OctahedronGeometry(0.04), glow, [0, 0.07, 0.152], [0, 0, 0], [0.8, 1.2, 0.5])
  add(rig.chest, new THREE.CylinderGeometry(0.08, 0.11, 0.08, 16), armor, [0, 0.25, 0])
  add(rig.chest, new THREE.TorusGeometry(0.095, 0.009, 6, 24), gold, [0, 0.225, 0], [Math.PI / 2, 0, 0], [1, 0.8, 1])

  // --- head
  const H = rig.head
  add(H, new THREE.CylinderGeometry(0.108, 0.112, 0.18, 20), armor, [0, 0.085, 0], [0, 0, 0], [1, 1, 1.06])
  add(H, new THREE.SphereGeometry(0.108, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), armor, [0, 0.175, 0], [0, 0, 0], [1, 0.9, 1.06])
  // glowing T-visor
  add(H, new THREE.BoxGeometry(0.13, 0.016, 0.02), glow, [0, 0.12, 0.108])
  add(H, new THREE.BoxGeometry(0.016, 0.07, 0.02), glow, [0, 0.085, 0.112])
  // swept-back gold fins
  for (const s of [1, -1]) {
    add(H, taperTube([V(0.09 * s, 0.13, 0.04), V(0.13 * s, 0.19, -0.04), V(0.15 * s, 0.27, -0.14), V(0.12 * s, 0.36, -0.26)], 0.022, 0.003), gold)
  }
  add(H, new THREE.TorusGeometry(0.111, 0.007, 6, 26), gold, [0, 0.165, 0], [Math.PI / 2, 0, 0], [1, 1.06, 1])
  // the halo floats behind the head (kept as its own mesh so it can spin)
  const halo = new THREE.Group()
  halo.position.set(0, 0.2, -0.17)
  const haloMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 2.9, 1.4), toneMapped: true, fog: false })
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.007, 6, 48), haloMat)
  halo.add(ring)
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.008, i % 3 === 0 ? 0.09 : 0.05, 4), haloMat)
    spike.position.set(Math.cos(a) * 0.245, Math.sin(a) * 0.245, 0)
    spike.rotation.z = a - Math.PI / 2
    halo.add(spike)
  }
  halo.traverse((o) => {
    o.userData.keep = true
    o.castShadow = false
  })
  H.add(halo)

  // --- arms
  for (const side of [1, -1]) {
    const sh = side > 0 ? rig.shoulderL : rig.shoulderR
    const el = side > 0 ? rig.elbowL : rig.elbowR
    const ha = side > 0 ? rig.handL : rig.handR
    // layered pauldron with a raised gold edge
    add(sh, new THREE.SphereGeometry(0.12, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), armor, [0.012 * side, 0.035, 0], [0, 0, -0.42 * side], [1.25, 0.85, 1.1])
    add(sh, new THREE.SphereGeometry(0.105, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.45), armor, [0.03 * side, -0.02, 0], [0, 0, -0.55 * side], [1.2, 0.8, 1.05])
    add(sh, new THREE.TorusGeometry(0.11, 0.008, 6, 22, Math.PI * 1.2), gold, [0.02 * side, 0.02, 0], [Math.PI / 2, -0.42 * side, Math.PI * 0.9])
    add(sh, new THREE.ConeGeometry(0.03, 0.12, 4), gold, [0.07 * side, 0.12, -0.02], [0, 0, -0.5 * side])
    add(sh, new THREE.CylinderGeometry(0.052, 0.046, 0.22, 12), under, [0, -0.15, 0])
    add(el, new THREE.SphereGeometry(0.052, 12, 10), armor, [0, 0, -0.008])
    add(el, new THREE.CylinderGeometry(0.058, 0.045, 0.2, 12), armor, [0, -0.13, 0])
    add(el, new THREE.TorusGeometry(0.052, 0.006, 6, 18), gold, [0, -0.05, 0], [Math.PI / 2, 0, 0])
    add(el, new THREE.CylinderGeometry(0.064, 0.05, 0.05, 12, 1, true), gold, [0, -0.235, 0])
    add(ha, new THREE.BoxGeometry(0.068, 0.085, 0.095), armor, [0, -0.01, 0])
    add(ha, new THREE.BoxGeometry(0.072, 0.02, 0.1), gold, [0, 0.03, 0])
  }

  // --- legs
  for (const side of [1, -1]) {
    const th = side > 0 ? rig.thighL : rig.thighR
    const kn = side > 0 ? rig.kneeL : rig.kneeR
    const ft = side > 0 ? rig.footL : rig.footR
    add(th, new THREE.CylinderGeometry(0.082, 0.066, 0.4, 12), under, [0, -0.2, 0])
    add(th, new THREE.CylinderGeometry(0.088, 0.072, 0.26, 12, 1, true, -1.2, 2.4), armor, [0, -0.18, 0.004])
    add(kn, new THREE.SphereGeometry(0.06, 12, 10), armor, [0, 0, 0.014])
    add(kn, new THREE.ConeGeometry(0.035, 0.1, 4), gold, [0, 0.02, 0.075], [Math.PI / 2 - 0.4, 0, 0])
    add(kn, new THREE.CylinderGeometry(0.064, 0.05, 0.38, 12), armor, [0, -0.21, 0.004])
    add(kn, new THREE.TorusGeometry(0.06, 0.006, 6, 18), gold, [0, -0.36, 0], [Math.PI / 2, 0, 0])
    add(ft, new THREE.BoxGeometry(0.094, 0.07, 0.25), armor, [0, -0.035, 0.055])
    add(ft, new THREE.BoxGeometry(0.098, 0.016, 0.1), gold, [0, -0.0, 0.12])
  }

  // --- the sword: long single blade, glowing fuller, gold guard
  const len = 1.22
  add(rig.handR, bladeGeometry(len, 0.04, 0.0105), blade, [0, 0, 0.09])
  for (const s of [1, -1]) add(rig.handR, new THREE.BoxGeometry(0.003, 0.011, len * 0.8), glow, [0.0085 * s, 0, 0.09 + len * 0.42])
  add(rig.handR, new THREE.CylinderGeometry(0.052, 0.052, 0.014, 20), gold, [0, 0, 0.085], [Math.PI / 2, 0, 0])
  add(rig.handR, new THREE.CylinderGeometry(0.017, 0.017, 0.2, 10), under, [0, 0, -0.02], [Math.PI / 2, 0, 0])
  add(rig.handR, new THREE.SphereGeometry(0.024, 10, 8), gold, [0, 0, -0.13])
  const swordBase = new THREE.Object3D()
  const swordTip = new THREE.Object3D()
  swordBase.position.set(0, 0, 0.14)
  swordTip.position.set(0, 0, 0.09 + len)
  rig.handR.add(swordBase, swordTip)

  // Heaven Splitter energy blade (grows from the sword while charging)
  const energyU = { uTime: { value: 0 }, uLen: { value: 1 }, uPower: { value: 0 } }
  const eg1 = new THREE.PlaneGeometry(0.9, 1)
  eg1.rotateX(-Math.PI / 2)
  eg1.translate(0, 0, 0.5)
  const eg2 = eg1.clone().rotateZ(Math.PI / 2)
  const eg = new THREE.BufferGeometry()
  {
    const p1 = eg1.attributes.position.array as Float32Array
    const p2 = eg2.attributes.position.array as Float32Array
    const pos = new Float32Array(p1.length + p2.length)
    pos.set(p1)
    pos.set(p2, p1.length)
    const u1 = eg1.attributes.uv.array as Float32Array
    const uv = new Float32Array(u1.length * 2)
    uv.set(u1)
    uv.set(u1, u1.length)
    const i1 = Array.from(eg1.index!.array)
    const idx = [...i1, ...i1.map((i) => i + p1.length / 3)]
    eg.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    eg.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    eg.setIndex(idx)
  }
  const energyBlade = new THREE.Mesh(
    eg,
    new THREE.ShaderMaterial({
      vertexShader: energyVert,
      fragmentShader: energyFrag,
      uniforms: energyU,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    }),
  )
  energyBlade.position.set(0, 0, 0.1)
  energyBlade.frustumCulled = false
  energyBlade.renderOrder = 6
  energyBlade.visible = false
  energyBlade.userData.keep = true
  rig.handR.add(energyBlade)

  const body = mergeStatic(rig, new THREE.Sphere(new THREE.Vector3(0, 1.1, 0), 3))

  // --- coat + scarf (verlet cloth)
  const container = new THREE.Group()
  container.add(rig.root)
  const colliders: Capsule[] = [
    { a: rig.hips, b: rig.neck, r: 0.21 },
    { a: rig.thighL, b: rig.kneeL, r: 0.11 },
    { a: rig.thighR, b: rig.kneeR, r: 0.11 },
    { a: rig.kneeL, b: rig.footL, r: 0.085 },
    { a: rig.kneeR, b: rig.footR, r: 0.085 },
  ]
  const coatMat = standard({
    color: '#ffffff',
    roughness: 0.95,
    map: coatTexture(),
    normalMap: C.normalMap,
    normalScale: 0.6,
    side: THREE.DoubleSide,
    alphaMap: tatteredAlpha(5, 0.35),
    alphaTest: 0.5,
    rim: 0.4,
    rimColor: rimGold,
  })
  const scarfMat = standard({ color: '#ffffff', roughness: 0.9, map: scarfTexture(), side: THREE.DoubleSide, alphaMap: tatteredAlpha(8, 0.5), alphaTest: 0.5, rim: 0.5, rimColor: '#ff6040' })
  mats.push(coatMat, scarfMat)
  const coat = new Cape({
    width: 0.46,
    length: 1.18,
    cols: 8,
    rows: 12,
    material: coatMat,
    anchor: rig.chest,
    left: V(0.18, 0.17, -0.12),
    right: V(-0.18, 0.17, -0.12),
    colliders,
  })
  const scarf = new Cape({
    width: 0.16,
    length: 1.5,
    cols: 3,
    rows: 14,
    material: scarfMat,
    anchor: rig.chest,
    left: V(0.07, 0.29, -0.09),
    right: V(-0.07, 0.29, -0.09),
    colliders,
  })
  container.add(coat.mesh, scarf.mesh)

  const trail = new SwordTrail('#ffe6b0', 2.4)
  container.add(trail.mesh)

  return {
    set: 'hero',
    rig,
    container,
    materials: mats,
    skeleton: body.skeleton,
    meshes: body.meshes,
    swordBase,
    swordTip,
    capes: [coat, scarf],
    trail,
    scale: 1,
    stepLen: 0.8,
    halo,
    energyBlade,
    energyU,
    glowMat: glow,
  }
}
