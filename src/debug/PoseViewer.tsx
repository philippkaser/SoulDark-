import { OrbitControls } from '@react-three/drei'
import { Canvas, useFrame } from '@react-three/fiber'
import { useMemo } from 'react'
import * as THREE from 'three'
import { Avatar } from '../engine/rig/avatar'
import '../game/player/heroClips'
import { buildHero } from '../game/player/heroModel'

/** Debug view: ?debug=poses&clip=slash1&t=0.05,0.1,0.2&speed=0 */
function Figure({ clip, t, x, speed }: { clip: string | null; t: number; x: number; speed: number }) {
  const avatar = useMemo(() => {
    const m = buildHero()
    m.energyBlade.visible = clip === 'charge'
    m.energyU.uPower.value = 1
    m.energyU.uLen.value = 6
    return new Avatar(m)
  }, [clip])
  useFrame((_, dt) => {
    for (let i = 0; i < 4; i++)
      avatar.update(1 / 60, { x, y: 0, z: 0, yaw: 0.5, speed, moveAngle: 0, turnRate: 0, action: clip, actionT: t, time: 1 + i / 60, trail: false })
    ;(avatar.model as ReturnType<typeof buildHero>).halo.rotation.z += dt
  })
  return <primitive object={avatar.model.container} />
}

export function PoseViewer() {
  const q = new URLSearchParams(location.search)
  const clip = q.get('clip')
  const ts = (q.get('t') ?? '0').split(',').map(Number)
  const speed = Number(q.get('speed') ?? 0)
  const cam = (q.get('cam') ?? '3,1.6,4').split(',').map(Number) as [number, number, number]
  return (
    <Canvas shadows camera={{ position: cam, fov: 45 }} gl={{ preserveDrawingBuffer: true }} style={{ position: 'fixed', inset: 0 }}>
      <color attach="background" args={['#3a3440']} />
      <hemisphereLight args={['#c8c4d8', '#3a3028', 1.6]} />
      <directionalLight position={[3, 6, 4]} intensity={2.5} castShadow />
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[40, 40]} />
        <meshStandardMaterial color="#555" />
      </mesh>
      {ts.map((t, i) => (
        <Figure key={i} clip={clip} t={t} speed={speed} x={(i - (ts.length - 1) / 2) * 1.7} />
      ))}
      <OrbitControls target={new THREE.Vector3(0, 1, 0)} />
    </Canvas>
  )
}
