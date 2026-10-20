import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { useMemo } from 'react'
import * as THREE from 'three'
import { Avatar } from '../game/rig/avatar'
import { buildBoss, buildFallen, buildHollow, buildPlayer } from '../game/rig/models'

/** Debug view: ?debug=poses&clip=light1&t=0.28&who=knight */
function Figure({ who, clip, t, x, yaw }: { who: string; clip: string | null; t: number; x: number; yaw: number }) {
  const avatar = useMemo(() => {
    const m =
      who === 'hollow' ? buildHollow(0) : who === 'hollow1' ? buildHollow(1) : who === 'fallen' ? buildFallen() : who === 'boss' ? buildBoss() : buildPlayer({ cloak: 0, crest: 0 }, who === 'phantom' ? 'gold' : who === 'ghost' ? 'red' : undefined)
    return new Avatar(m)
  }, [who])
  useFrame(() => {
    for (let i = 0; i < 4; i++)
      avatar.update(1 / 60, { x, y: 0, z: 0, yaw, speed: 0, moveAngle: 0, turnRate: 0, action: clip, actionT: t, time: 1, trail: false })
  })
  return <primitive object={avatar.model.container} />
}

export function PoseViewer() {
  const q = new URLSearchParams(location.search)
  const clip = q.get('clip')
  const ts = (q.get('t') ?? '0').split(',').map(Number)
  const who = q.get('who') ?? 'knight'
  const yaw = Number(q.get('yaw') ?? 0)
  const cam = (q.get('cam') ?? '3,1.6,4').split(',').map(Number) as [number, number, number]
  const spacing = who === 'boss' ? 4 : 1.6
  return (
    <Canvas shadows camera={{ position: cam, fov: 45 }} gl={{ preserveDrawingBuffer: true }} style={{ position: 'fixed', inset: 0, background: '#1a1d22' }}>
      <color attach="background" args={['#22262c']} />
      <hemisphereLight args={['#aab4c8', '#3a3028', 1.4]} />
      <directionalLight position={[3, 6, 4]} intensity={2.5} castShadow />
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[40, 40]} />
        <meshStandardMaterial color="#555" />
      </mesh>
      {ts.map((t, i) => (
        <Figure key={i} who={who} clip={clip} t={t} x={(i - (ts.length - 1) / 2) * spacing} yaw={yaw} />
      ))}
      <gridHelper args={[20, 20, '#666', '#444']} position={[0, 0.001, 0]} />
      <OrbitControls target={new THREE.Vector3(0, who === 'boss' ? 2.5 : 1, 0)} />
    </Canvas>
  )
}
