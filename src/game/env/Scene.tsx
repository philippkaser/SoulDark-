import { Environment, Lightformer } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { ARENA, BONFIRE, CIRCLES, FOG_GATE } from '../../../shared/level'
import { mulberry32, TAU } from '../../../shared/math'
import type { Quality } from '../../state/save'
import { useUI } from '../../state/store'
import { canvasTexture } from '../gfx/textures'
import { bladeGeometry } from '../rig/models'
import { world } from '../world'
import { buildArchitecture, makeMaterials, rockGeometry, type Materials } from './architecture'
import { emberColumn, flameMaterial } from './fire'
import { groundMaterial, NOISE_GLSL, stoneSDF } from './groundMaterial'
import { FOG_COLOR, Sky, SUN_DIR } from './Sky'

// ---------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------

function Lights({ quality }: { quality: Quality }) {
  const light = useRef<THREE.DirectionalLight>(null!)
  const { camera, scene } = useThree()
  const size = quality === 'high' ? 4096 : quality === 'medium' ? 2048 : 1024
  const extent = 32
  useEffect(() => {
    scene.add(light.current.target)
    return () => {
      scene.remove(light.current.target)
    }
  }, [scene])
  useFrame(() => {
    const l = light.current
    const focusX = world.inGame ? world.me.x : camera.position.x
    const focusZ = world.inGame ? world.me.z : camera.position.z
    // snap to shadow texels to avoid shimmering
    const texel = (extent * 2) / size
    const fx = Math.round(focusX / texel) * texel
    const fz = Math.round(focusZ / texel) * texel
    l.target.position.set(fx, 0, fz)
    l.position.set(fx - 38, 62, fz - 34)
    l.target.updateMatrixWorld()
  })
  return (
    <>
      <hemisphereLight args={['#5b6b8c', '#221a12', 1.15]} />
      <directionalLight
        ref={light}
        color="#c4d1ec"
        intensity={1.75}
        castShadow
        shadow-mapSize={[size, size]}
        shadow-bias={-0.00025}
        shadow-normalBias={0.035}
        shadow-camera-left={-extent}
        shadow-camera-right={extent}
        shadow-camera-top={extent}
        shadow-camera-bottom={-extent}
        shadow-camera-near={1}
        shadow-camera-far={160}
      />
      <Environment resolution={128} frames={1} environmentIntensity={0.6}>
        <Lightformer form="rect" intensity={1.4} color="#7f95bf" scale={[80, 30, 1]} position={[0, 40, 0]} rotation-x={Math.PI / 2} />
        <Lightformer form="ring" intensity={2.2} color="#ff8a40" scale={12} position={SUN_DIR.clone().multiplyScalar(60).toArray()} target={[0, 0, 0]} />
        <Lightformer form="rect" intensity={0.5} color="#3a4a6a" scale={[120, 10, 1]} position={[0, 5, 70]} />
        <Lightformer form="rect" intensity={0.5} color="#3a4a6a" scale={[120, 10, 1]} position={[-70, 5, 0]} rotation-y={Math.PI / 2} />
        <Lightformer form="rect" intensity={0.9} color="#9aa8c0" scale={[40, 6, 1]} position={[0, 3, -70]} />
      </Environment>
    </>
  )
}

// ---------------------------------------------------------------------------
// Ground + architecture
// ---------------------------------------------------------------------------

function Ground({ quality }: { quality: Quality }) {
  const mat = useMemo(() => groundMaterial(quality), [quality])
  return (
    <mesh rotation-x={-Math.PI / 2} receiveShadow material={mat} renderOrder={-1}>
      <planeGeometry args={[800, 800]} />
    </mesh>
  )
}

function Architecture({ mats, quality }: { mats: Materials; quality: Quality }) {
  const obj = useMemo(() => buildArchitecture(mats, quality), [mats, quality])
  return <primitive object={obj} />
}

// ---------------------------------------------------------------------------
// Bonfire
// ---------------------------------------------------------------------------

function Bonfire({ mats, quality }: { mats: Materials; quality: Quality }) {
  const light = useRef<THREE.PointLight>(null!)
  const frame = useRef(0)
  const { group, flames, embers } = useMemo(() => {
    const g = new THREE.Group()
    g.position.set(BONFIRE.x, 0, BONFIRE.z)
    const ashMat = new THREE.MeshStandardMaterial({ color: '#3b3836', roughness: 1 })
    const mound = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 12), ashMat)
    mound.scale.set(1.05, 0.32, 1.05)
    mound.receiveShadow = true
    g.add(mound)
    const ember = new THREE.MeshStandardMaterial({ color: '#1a0c06', emissive: '#ff4a10', emissiveIntensity: 2.4, roughness: 1 })
    const coals = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 8), ember)
    coals.scale.set(1, 0.35, 1)
    coals.position.y = 0.22
    g.add(coals)
    const r = mulberry32(7)
    const stoneGeos: THREE.BufferGeometry[] = []
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * TAU
      const g = rockGeometry(30 + i, 1).clone()
      g.scale(0.24 + r() * 0.1, 0.18 + r() * 0.1, 0.24 + r() * 0.1)
      g.translate(Math.sin(a) * 1.25, 0.08, Math.cos(a) * 1.25)
      stoneGeos.push(g)
    }
    const stones = new THREE.Mesh(mergeGeometries(stoneGeos)!, mats.stone)
    stones.receiveShadow = true
    g.add(stones)
    const bone = new THREE.MeshStandardMaterial({ color: '#b7ab93', roughness: 0.8 })
    const boneGeos: THREE.BufferGeometry[] = []
    for (let i = 0; i < 6; i++) {
      const b = new THREE.CylinderGeometry(0.025, 0.03, 0.4 + r() * 0.3, 6).toNonIndexed()
      const a = r() * TAU
      b.rotateX(Math.PI / 2 + (r() - 0.5) * 0.3)
      b.rotateY(a)
      b.translate(Math.sin(a) * (0.7 + r() * 0.5), 0.1, Math.cos(a) * (0.7 + r() * 0.5))
      boneGeos.push(b)
    }
    const skullGeo = new THREE.SphereGeometry(0.11, 12, 10).toNonIndexed()
    skullGeo.translate(0.85, 0.12, 0.5)
    boneGeos.push(skullGeo)
    for (const bg of boneGeos) bg.deleteAttribute('uv')
    g.add(new THREE.Mesh(mergeGeometries(boneGeos)!, bone))
    // the coiled sword
    const blade = bladeGeometry(1.25, 0.05, 0.013)
    const pos = blade.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i)
      const a = z * 7.5
      const x = pos.getX(i)
      const y = pos.getY(i)
      pos.setXY(i, x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a))
    }
    blade.computeVertexNormals()
    const steel = new THREE.MeshStandardMaterial({ color: '#4a4440', metalness: 0.9, roughness: 0.45, emissive: '#ff3a0a', emissiveIntensity: 0.25 })
    const sword = new THREE.Group()
    const bm = new THREE.Mesh(blade, steel)
    sword.add(bm)
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.24, 0.035), steel)
    guard.position.z = -0.02
    sword.add(guard)
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.2, 8), steel)
    grip.rotation.x = Math.PI / 2
    grip.position.z = -0.13
    sword.add(grip)
    sword.position.set(0, 1.05, 0.05)
    sword.rotation.set(Math.PI / 2 + 0.12, 0, 0.2)
    g.add(sword)
    // flames
    const flames: THREE.Mesh[] = []
    const plane = new THREE.PlaneGeometry(1, 1)
    plane.translate(0, 0.5, 0)
    for (let i = 0; i < 3; i++) {
      const f = new THREE.Mesh(plane, flameMaterial(i * 0.37, i === 0 ? 2.6 : 1.8))
      f.position.set((i - 1) * 0.18, 0.15, (i % 2) * 0.12)
      f.scale.set(i === 0 ? 1.15 : 0.8, i === 0 ? 1.9 : 1.4, 1)
      f.renderOrder = 4
      flames.push(f)
      g.add(f)
    }
    const embers = emberColumn(140, 0.8, 5, 0.05)
    embers.position.y = 0.3
    g.add(embers)
    return { group: g, flames, embers }
  }, [mats])

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime
    for (const f of flames) (f.material as THREE.ShaderMaterial).uniforms.uTime.value += dt
    const em = embers.material as THREE.ShaderMaterial
    em.uniforms.uTime.value += dt
    em.uniforms.uScale.value = (state.size.height * state.gl.getPixelRatio()) / (2 * Math.tan(((state.camera as THREE.PerspectiveCamera).fov * Math.PI) / 360))
    const flick = 0.82 + Math.sin(t * 11) * 0.06 + Math.sin(t * 17.3) * 0.05 + Math.sin(t * 5.1) * 0.07
    light.current.intensity = 42 * flick
    // the cube shadow is expensive: refresh it every other frame
    const sh = light.current.shadow
    sh.autoUpdate = false
    if (frame.current % 2 === 0) sh.needsUpdate = true
    frame.current++
    light.current.position.set(BONFIRE.x + Math.sin(t * 7) * 0.05, 1.3 + Math.sin(t * 9) * 0.05, BONFIRE.z)
  })

  return (
    <>
      <primitive object={group} />
      <pointLight
        ref={light}
        color="#ff8a3a"
        intensity={42}
        distance={0}
        decay={2}
        castShadow={quality === 'high'}
        shadow-mapSize={[512, 512]}
        shadow-bias={-0.002}
        shadow-camera-near={0.5}
        shadow-camera-far={22}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Braziers
// ---------------------------------------------------------------------------

interface BrazierSpot {
  x: number
  z: number
  arena: boolean
  light: boolean
}

function Braziers({ mats, quality }: { mats: Materials; quality: Quality }) {
  const spots = useMemo<BrazierSpot[]>(() => {
    const s: BrazierSpot[] = CIRCLES.filter((c) => c.kind === 'brazier').map((c) => ({ x: c.x, z: c.z, arena: false, light: true }))
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + Math.PI / 8
      s.push({ x: ARENA.x + Math.sin(a) * 20.5, z: ARENA.z + Math.cos(a) * 20.5, arena: true, light: i % 2 === 0 })
    }
    return s
  }, [])
  const { group, flames, lights } = useMemo(() => {
    const g = new THREE.Group()
    const bowlGeo = new THREE.LatheGeometry(
      [
        [0.05, 0],
        [0.45, 0.05],
        [0.55, 0.25],
        [0.58, 0.32],
        [0.52, 0.3],
        [0.4, 0.12],
      ].map(([x, y]) => new THREE.Vector2(x, y)),
      16,
    )
    const legGeo = new THREE.CylinderGeometry(0.035, 0.05, 1.15, 6)
    const coalMat = new THREE.MeshStandardMaterial({ color: '#120804', emissive: '#ff4a10', emissiveIntensity: 2, roughness: 1 })
    const plane = new THREE.PlaneGeometry(1, 1)
    plane.translate(0, 0.5, 0)
    const flames: Array<{ mesh: THREE.Mesh; spot: BrazierSpot; coal: THREE.Mesh; i: number }> = []
    const lights: Array<{ light: THREE.PointLight; spot: BrazierSpot }> = []
    // one instanced draw for all the iron stands
    const legParts: THREE.BufferGeometry[] = []
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * TAU
      const leg = legGeo.clone().toNonIndexed()
      leg.rotateX(Math.cos(a) * 0.25)
      leg.rotateZ(-Math.sin(a) * 0.25)
      leg.translate(Math.sin(a) * 0.28, 0.55, Math.cos(a) * 0.28)
      legParts.push(leg)
    }
    const bowl = bowlGeo.clone().toNonIndexed()
    bowl.translate(0, 1.05, 0)
    legParts.push(bowl)
    for (const lp of legParts) lp.deleteAttribute('uv')
    const standGeo = mergeGeometries(legParts)!
    const stands = new THREE.InstancedMesh(standGeo, mats.iron, spots.length)
    stands.castShadow = true
    stands.receiveShadow = true
    const o = new THREE.Object3D()
    spots.forEach((sp, i) => {
      o.position.set(sp.x, 0, sp.z)
      o.updateMatrix()
      stands.setMatrixAt(i, o.matrix)
    })
    g.add(stands)
    spots.forEach((sp, i) => {
      const b = new THREE.Group()
      b.position.set(sp.x, 0, sp.z)
      const coal = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 6), coalMat.clone())
      coal.scale.set(1, 0.3, 1)
      coal.position.y = 1.3
      b.add(coal)
      const f = new THREE.Mesh(plane, flameMaterial(i * 0.61, 2.2))
      f.position.y = 1.25
      f.scale.set(0.9, 1.4, 1)
      f.renderOrder = 4
      b.add(f)
      flames.push({ mesh: f, spot: sp, coal, i })
      if (sp.light && quality !== 'low') {
        const l = new THREE.PointLight('#ff8238', 0, 0, 2)
        l.position.set(sp.x, 2.1, sp.z)
        g.add(l)
        lights.push({ light: l, spot: sp })
      }
      g.add(b)
    })
    return { group: g, flames, lights }
  }, [spots, mats, quality])

  const ignite = useRef(0)
  useFrame((state, dt) => {
    const t = state.clock.elapsedTime
    const fight = world.flags.boss === 1
    ignite.current = fight ? ignite.current + dt : Math.max(0, ignite.current - dt * 0.5)
    for (const f of flames) {
      const u = (f.mesh.material as THREE.ShaderMaterial).uniforms
      u.uTime.value += dt
      let on = 1
      if (f.spot.arena) on = THREE.MathUtils.clamp((ignite.current - (f.i % 8) * 0.25) * 2.5, 0, 1)
      f.mesh.visible = on > 0.01
      f.mesh.scale.set(0.9 * on, 1.4 * on, 1)
      ;(f.coal.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.2 + on * 2
    }
    for (const l of lights) {
      let on = 1
      if (l.spot.arena) on = THREE.MathUtils.clamp(ignite.current * 2 - 0.5, 0, 1)
      l.light.intensity = on * 26 * (0.85 + Math.sin(t * 13 + l.spot.x) * 0.08 + Math.sin(t * 7.7 + l.spot.z) * 0.07)
    }
  })
  return <primitive object={group} />
}

// ---------------------------------------------------------------------------
// Fog gate
// ---------------------------------------------------------------------------

function FogGate() {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uAlpha: { value: 1 } },
        vertexShader: /* glsl */ `
          uniform float uTime;
          varying vec2 vUv;
          void main() {
            vUv = uv;
            vec3 p = position;
            p.z += sin(p.y * 1.3 + uTime * 1.2) * 0.12 + sin(p.x * 2.1 - uTime * 0.9) * 0.08;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          uniform float uAlpha;
          varying vec2 vUv;
          ${NOISE_GLSL}
          void main() {
            vec2 q = vUv * vec2(3.0, 4.0);
            float t = uTime;
            float w = gFbm(q * 1.3 + vec2(t * 0.15, -t * 0.4));
            float f = gFbm(q + vec2(w * 1.8, -t * 0.55) + vec2(0.0, w));
            float edge = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x) * smoothstep(0.0, 0.06, vUv.y);
            float top = smoothstep(1.0, 0.7, vUv.y + (w - 0.5) * 0.2);
            float a = (0.35 + f * 0.75) * edge * top * uAlpha;
            vec3 col = mix(vec3(0.55, 0.62, 0.72), vec3(1.25, 1.25, 1.3), f);
            gl_FragColor = vec4(col, a);
          }`,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    [],
  )
  const ref = useRef<THREE.Mesh>(null!)
  useFrame((_, dt) => {
    mat.uniforms.uTime.value += dt
    const want = world.flags.fog ? 1 : 0
    mat.uniforms.uAlpha.value += (want - mat.uniforms.uAlpha.value) * Math.min(1, dt * 1.5)
    ref.current.visible = mat.uniforms.uAlpha.value > 0.01
  })
  return (
    <group position={[FOG_GATE.x, 0, FOG_GATE.z]}>
      <mesh ref={ref} material={mat} position={[0, 4.0, 0]} renderOrder={3}>
        <planeGeometry args={[7.4, 8.2, 24, 24]} />
      </mesh>
    </group>
  )
}

// ---------------------------------------------------------------------------
// Grass
// ---------------------------------------------------------------------------

function tuftGeometry() {
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  const blades = 6
  const segs = 4
  const r = mulberry32(3)
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * TAU + r() * 0.8
    const lean = 0.15 + r() * 0.3
    const h = 0.32 + r() * 0.35
    const w = 0.035 + r() * 0.02
    const base = pos.length / 3
    const ox = Math.sin(a) * 0.05
    const oz = Math.cos(a) * 0.05
    for (let s = 0; s <= segs; s++) {
      const t = s / segs
      const width = w * (1 - t * 0.9)
      const bend = lean * t * t
      const cx = ox + Math.sin(a) * bend
      const cz = oz + Math.cos(a) * bend
      const px = Math.cos(a) * width
      const pz = -Math.sin(a) * width
      pos.push(cx - px, t * h, cz - pz, cx + px, t * h, cz + pz)
      uv.push(0, t, 1, t)
      if (s < segs) {
        const i = base + s * 2
        idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  const n = new Float32Array(pos.length)
  for (let i = 0; i < n.length; i += 3) n[i + 1] = 1
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3))
  g.setIndex(idx)
  return g
}

function Grass({ quality }: { quality: Quality }) {
  const { mesh, uniforms } = useMemo(() => {
    const count = quality === 'high' ? 14000 : quality === 'medium' ? 8000 : 3000
    const uniforms = { uTime: { value: 0 }, uPlayer: { value: new THREE.Vector3(0, -100, 0) } }
    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, side: THREE.DoubleSide })
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec3 uPlayer;\nvarying float vGH;')
        .replace(
          '#include <project_vertex>',
          /* glsl */ `
          vec4 mvPosition = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            mvPosition = instanceMatrix * mvPosition;
          #endif
          float gh = uv.y;
          vGH = gh;
          float w = sin(uTime * 1.7 + mvPosition.x * 0.31 + mvPosition.z * 0.17) * 0.6 + sin(uTime * 3.3 + mvPosition.x * 1.1) * 0.25;
          mvPosition.x += (0.6 + w) * gh * gh * 0.16;
          mvPosition.z -= (0.4 + w) * gh * gh * 0.08;
          vec2 away = mvPosition.xz - uPlayer.xz;
          float pd = length(away);
          float pf = 1.0 - smoothstep(0.2, 1.3, pd);
          mvPosition.xz += normalize(away + 1e-4) * pf * gh * 0.4;
          mvPosition.y -= pf * gh * 0.18;
          mvPosition = modelViewMatrix * mvPosition;
          gl_Position = projectionMatrix * mvPosition;`,
        )
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vGH;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= mix(vec3(0.18), vec3(1.0), smoothstep(0.0, 0.9, vGH));')
    }
    mat.customProgramCacheKey = () => 'grass-v1'
    const geo = tuftGeometry()
    const inst = new THREE.InstancedMesh(geo, mat, count)
    const r = mulberry32(99)
    const o = new THREE.Object3D()
    const c = new THREE.Color()
    let n = 0
    let tries = 0
    while (n < count && tries < count * 20) {
      tries++
      const x = (r() - 0.5) * 90
      const z = -105 + r() * 185
      const sd = stoneSDF(x, z)
      const clump = Math.sin(x * 0.21) * Math.sin(z * 0.17) + Math.sin(x * 0.07 + z * 0.05)
      if (sd < 0.6 + clump * 0.4) continue
      if (r() > 0.35 + clump * 0.35) continue
      let blocked = false
      for (const ob of CIRCLES) {
        if ((ob.x - x) ** 2 + (ob.z - z) ** 2 < (ob.r + 0.15) ** 2) {
          blocked = true
          break
        }
      }
      if (blocked) continue
      o.position.set(x, 0, z)
      o.rotation.set(0, r() * TAU, 0)
      const s = 0.7 + r() * 0.9
      o.scale.set(s, s * (0.7 + r() * 0.8), s)
      o.updateMatrix()
      inst.setMatrixAt(n, o.matrix)
      const dry = r()
      c.setRGB(0.2 + dry * 0.1, 0.19 + dry * 0.05, 0.09 - dry * 0.03).multiplyScalar(0.55 + r() * 0.25)
      inst.setColorAt(n, c)
      n++
    }
    inst.count = n
    inst.receiveShadow = true
    inst.frustumCulled = false
    return { mesh: inst, uniforms }
  }, [quality])
  useFrame((_, dt) => {
    uniforms.uTime.value += dt
    if (world.inGame) uniforms.uPlayer.value.set(world.me.x, 0, world.me.z)
  })
  return <primitive object={mesh} />
}

// ---------------------------------------------------------------------------
// Atmosphere: drifting embers, falling ash, ground mist
// ---------------------------------------------------------------------------

function Atmosphere({ quality }: { quality: Quality }) {
  const { camera, size, gl } = useThree()
  const { embers, ash, mist } = useMemo(() => {
    const mk = (count: number, color: string, additive: boolean, fall: number, sizeW: number) => {
      const geo = new THREE.BufferGeometry()
      const p = new Float32Array(count * 3)
      for (let i = 0; i < count * 3; i++) p[i] = Math.random()
      geo.setAttribute('position', new THREE.BufferAttribute(p, 3))
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uScale: { value: 600 }, uColor: { value: new THREE.Color(color) } },
        vertexShader: /* glsl */ `
          uniform float uTime; uniform vec3 uCam; uniform float uScale;
          varying float vA;
          void main() {
            vec3 box = vec3(60.0, 22.0, 60.0);
            vec3 p = position * box;
            p.y += ${fall.toFixed(2)} * uTime;
            p.x += sin(uTime * 0.3 + position.z * 30.0) * 2.0 + uTime * 0.6;
            p.z += cos(uTime * 0.27 + position.x * 30.0) * 2.0;
            vec3 rel = mod(p - uCam + box * 0.5, box) - box * 0.5;
            vec3 w = uCam + rel;
            w.y = mod(p.y, box.y);
            vA = smoothstep(30.0, 10.0, length(rel.xz)) * smoothstep(1.5, 5.0, length(rel)) * (0.4 + 0.6 * fract(position.x * 91.7));
            vA *= 0.6 + 0.4 * sin(uTime * 3.0 + position.y * 50.0);
            vec4 mv = viewMatrix * vec4(w, 1.0);
            gl_PointSize = ${sizeW.toFixed(3)} * uScale / -mv.z * (0.5 + fract(position.z * 57.3));
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          varying float vA;
          void main() {
            float d = length(gl_PointCoord - 0.5) * 2.0;
            float a = (1.0 - smoothstep(0.2, 1.0, d)) * vA;
            gl_FragColor = vec4(uColor * ${additive ? 'a' : '1.0'}, a);
          }`,
        transparent: true,
        depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      })
      const pts = new THREE.Points(geo, mat)
      pts.frustumCulled = false
      return pts
    }
    const k = quality === 'low' ? 0.4 : 1
    const embers = mk(Math.floor(700 * k), '#ff7a2a', true, 0.45, 0.028)
    ;(embers.material as THREE.ShaderMaterial).uniforms.uColor.value.multiplyScalar(2.6)
    const ash = mk(Math.floor(1100 * k), '#2a2726', false, -0.35, 0.03)

    const mistMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: FOG_COLOR.clone().multiplyScalar(2.1) }, uCam: { value: new THREE.Vector3() } },
      vertexShader: /* glsl */ `
        varying vec3 vW;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uColor; uniform vec3 uCam;
        varying vec3 vW;
        ${NOISE_GLSL}
        void main() {
          vec2 p = vW.xz * 0.045;
          float n = gFbm(p + vec2(uTime * 0.012, uTime * 0.007) + vW.y * 0.7);
          float n2 = gFbm(p * 2.3 - vec2(uTime * 0.02, 0.0));
          float a = smoothstep(0.38, 0.85, n * 0.7 + n2 * 0.45);
          float d = length(vW - uCam);
          a *= smoothstep(1.5, 9.0, d) * (1.0 - smoothstep(120.0, 220.0, d));
          gl_FragColor = vec4(uColor, a * 0.16);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const mist = new THREE.Group()
    const layers = quality === 'low' ? [0.5] : [0.35, 0.9, 1.6]
    for (const y of layers) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), mistMat)
      m.rotation.x = -Math.PI / 2
      m.position.set(0, y, -10)
      m.renderOrder = 2
      mist.add(m)
    }
    return { embers, ash, mist }
  }, [quality])

  useFrame((_, dt) => {
    for (const pts of [embers, ash]) {
      const u = (pts.material as THREE.ShaderMaterial).uniforms
      u.uTime.value += dt
      u.uCam.value.copy(camera.position)
      u.uScale.value = (size.height * gl.getPixelRatio()) / (2 * Math.tan(((camera as THREE.PerspectiveCamera).fov * Math.PI) / 360))
    }
    const mm = (mist.children[0] as THREE.Mesh).material as THREE.ShaderMaterial
    mm.uniforms.uTime.value += dt
    mm.uniforms.uCam.value.copy(camera.position)
  })
  return (
    <>
      <primitive object={embers} />
      <primitive object={ash} />
      <primitive object={mist} />
    </>
  )
}

// ---------------------------------------------------------------------------
// Messages, bloodstains, and your own lost souls
// ---------------------------------------------------------------------------

const glyphTex = () =>
  canvasTexture(256, 256, (ctx) => {
    ctx.translate(128, 128)
    ctx.strokeStyle = '#ffffff'
    ctx.fillStyle = '#ffffff'
    ctx.lineWidth = 5
    ctx.shadowColor = '#ffffff'
    ctx.shadowBlur = 12
    ctx.beginPath()
    ctx.arc(0, 0, 90, 0, TAU)
    ctx.stroke()
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.arc(0, 0, 74, 0, TAU)
    ctx.stroke()
    const r = mulberry32(5)
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU
      ctx.save()
      ctx.rotate(a)
      ctx.beginPath()
      ctx.moveTo(0, -78)
      ctx.lineTo((r() - 0.5) * 12, -88)
      ctx.lineTo((r() - 0.5) * 8, -84)
      ctx.stroke()
      ctx.restore()
    }
    ctx.font = '600 64px serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('ᚱᛟᚾ', 0, 4)
  })

const stainTex = () =>
  canvasTexture(256, 256, (ctx) => {
    const r = mulberry32(13)
    ctx.translate(128, 128)
    for (let i = 0; i < 40; i++) {
      const a = r() * TAU
      const d = r() * 70
      const s = 10 + r() * 40
      const g = ctx.createRadialGradient(Math.cos(a) * d, Math.sin(a) * d, 0, Math.cos(a) * d, Math.sin(a) * d, s)
      g.addColorStop(0, 'rgba(255,255,255,0.9)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(Math.cos(a) * d, Math.sin(a) * d, s, 0, TAU)
      ctx.fill()
    }
  })

function Markers() {
  const worldVersion = useUI((s) => s.worldVersion)
  const stain = useUI((s) => s.save.stain)
  const res = useMemo(() => {
    const plane = new THREE.PlaneGeometry(1, 1)
    plane.rotateX(-Math.PI / 2)
    return {
      plane,
      msgMat: new THREE.MeshBasicMaterial({ map: glyphTex(), color: new THREE.Color(2.4, 0.9, 0.25), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
      stainMat: new THREE.MeshBasicMaterial({ map: stainTex(), color: new THREE.Color(1.6, 0.05, 0.03), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
      soulMat: new THREE.MeshBasicMaterial({ map: stainTex(), color: new THREE.Color(0.2, 1.6, 0.9), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
    }
  }, [])
  const soulColumn = useMemo(() => {
    const c = emberColumn(60, 0.4, 1.6, 0.06)
    const m = c.material as THREE.ShaderMaterial
    m.fragmentShader = m.fragmentShader.replace('vec3(1.0, 0.45, 0.12) * 3.0', 'vec3(0.25, 1.0, 0.7) * 2.5')
    return c
  }, [])
  const group = useRef<THREE.Group>(null!)
  useFrame((state, dt) => {
    const t = state.clock.elapsedTime
    res.msgMat.opacity = 0.55 + 0.25 * Math.sin(t * 2.2)
    res.stainMat.opacity = 0.6 + 0.3 * Math.sin(t * 3.1)
    res.soulMat.opacity = 0.7 + 0.3 * Math.sin(t * 4.0)
    const m = soulColumn.material as THREE.ShaderMaterial
    m.uniforms.uTime.value += dt
    m.uniforms.uScale.value = (state.size.height * state.gl.getPixelRatio()) / (2 * Math.tan(((state.camera as THREE.PerspectiveCamera).fov * Math.PI) / 360))
  })
  const msgs = world.messages
  const stains = world.stains
  void worldVersion
  return (
    <group ref={group}>
      {msgs.map((m) => (
        <mesh key={`m${m.id}`} geometry={res.plane} material={res.msgMat} position={[m.x, 0.03, m.z]} scale={1.3} renderOrder={1} />
      ))}
      {stains.map((s) => (
        <mesh key={`s${s.id}`} geometry={res.plane} material={res.stainMat} position={[s.x, 0.035, s.z]} scale={1.1} renderOrder={1} />
      ))}
      {stain && (
        <group position={[stain.x, 0, stain.z]}>
          <mesh geometry={res.plane} material={res.soulMat} position={[0, 0.04, 0]} scale={0.9} renderOrder={1} />
          <primitive object={soulColumn} />
        </group>
      )}
    </group>
  )
}

// ---------------------------------------------------------------------------

export function World({ quality }: { quality: Quality }) {
  const mats = useMemo(() => makeMaterials(), [])
  const { scene } = useThree()
  useEffect(() => {
    scene.fog = new THREE.FogExp2(FOG_COLOR, 0.0145)
    scene.background = FOG_COLOR.clone()
  }, [scene])
  return (
    <>
      <Sky />
      <Lights quality={quality} />
      <Ground quality={quality} />
      <Architecture mats={mats} quality={quality} />
      <Bonfire mats={mats} quality={quality} />
      <Braziers mats={mats} quality={quality} />
      <FogGate />
      <Grass quality={quality} />
      <Atmosphere quality={quality} />
      <Markers />
    </>
  )
}
