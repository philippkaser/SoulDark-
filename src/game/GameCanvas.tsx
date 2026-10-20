import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useState } from 'react'
import * as THREE from 'three'
import { BONFIRE } from '../../shared/level'
import { audio } from '../audio/audio'
import { input } from '../input/input'
import type { Quality } from '../state/save'
import { useUI } from '../state/store'
import { World } from './env/Scene'
import { SunDisc, SUN_DIR } from './env/Sky'
import { PostFX } from './PostFX'
import type { GameSession } from './session'
import { world } from './world'

function TitleCamera() {
  const { camera } = useThree()
  useFrame((state) => {
    const t = state.clock.elapsedTime
    const a = t * 0.045 + 2.6
    camera.position.set(BONFIRE.x + Math.sin(a) * 9.5, 2.5 + Math.sin(t * 0.2) * 0.3, BONFIRE.z + Math.cos(a) * 9.5)
    camera.lookAt(BONFIRE.x, 1.5, BONFIRE.z)
    world.cameraYaw = a + Math.PI
    audio.setListener(camera.position.x, camera.position.z, world.cameraYaw)
    audio.update(1 / 60, 6, false)
  })
  return null
}

function SessionLayer({ session }: { session: GameSession }) {
  const { camera, size, gl } = useThree()
  useEffect(() => {
    world.camera = camera as THREE.PerspectiveCamera
    input.attach(gl.domElement)
    input.onLockChange = (locked) => {
      const ui = useUI.getState()
      ui.setPointerLocked(locked)
      // losing pointer lock in-game (Esc) opens the pause menu
      if (!locked && ui.screen === 'game' && !ui.menu && !ui.chatOpen && !session.player.dead) ui.setMenu('pause')
    }
    session.showPlayer()
    return () => {
      input.detach()
      input.onLockChange = undefined
    }
  }, [gl, session])

  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 20)
    const ui = useUI.getState()
    const s = ui.save.settings
    input.enabled = !ui.menu && !ui.chatOpen
    const f = input.poll(dt, s.sensitivity, s.invertY)
    const p = session.player

    if (f.menu) {
      if (ui.chatOpen) ui.setChatOpen(false)
      else if (ui.menu === 'bonfire') {
        ui.setMenu(null)
        p.standUp()
      } else if (ui.menu) ui.setMenu(null)
      else ui.setMenu('pause')
    }
    if (input.enabled && !p.dead) {
      if (f.chat) {
        ui.setChatOpen(true)
        input.releaseLock()
      } else if (f.gesture && !p.action) {
        ui.setMenu('gestures')
      } else if (f.compose && !p.action) {
        ui.setMenu('compose')
        input.releaseLock()
      }
    }
    session.update(dt, camera as THREE.PerspectiveCamera, f, { height: size.height * gl.getPixelRatio() })
  })
  return <primitive object={session.root} />
}

export function GameCanvas({ session, quality }: { session: GameSession | null; quality: Quality }) {
  const [sun, setSun] = useState<THREE.Mesh | null>(null)
  const dpr: [number, number] = quality === 'high' ? [1, 1.5] : quality === 'medium' ? [1, 1.25] : [0.75, 1]
  return (
    <Canvas
      shadows="soft"
      dpr={dpr}
      gl={{ antialias: false, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer: false }}
      camera={{ fov: 55, near: 0.1, far: 1600, position: [0, 3, 52] }}
      onCreated={({ gl, camera }) => {
        gl.shadowMap.type = THREE.PCFShadowMap
        if (import.meta.env.DEV) Object.assign(window, { __gl: gl })
        camera.lookAt(SUN_DIR.clone().multiplyScalar(100))
      }}
      style={{ position: 'fixed', inset: 0 }}
    >
      <World quality={quality} />
      <SunDisc ref={setSun} />
      {session ? <SessionLayer session={session} /> : <TitleCamera />}
      <PostFX quality={quality} sun={sun} />
    </Canvas>
  )
}
