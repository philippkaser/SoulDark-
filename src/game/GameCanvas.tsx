import { Environment, Lightformer } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Bloom, EffectComposer, SMAA, ToneMapping, Vignette } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import * as THREE from 'three'
import { PowerFXEffect } from '../engine/gfx/powerfx'
import { input } from '../input/input'
import type { Quality } from '../state/settings'
import { useUI } from '../state/store'
import { createGame } from './create'
import type { Game } from './Game'
import { SUN_DIR } from './world/layout'

function CameraFill() {
  const light = useRef<THREE.PointLight>(null!)
  useFrame(({ camera }) => {
    light.current.position.copy(camera.position)
    light.current.position.y += 0.8
  })
  return <pointLight ref={light} color="#ffd2b0" intensity={7} distance={16} decay={2} />
}

function Stage({ quality, onGame }: { quality: Quality; onGame: (g: Game | null) => void }) {
  const { camera, gl, scene, size } = useThree()
  const game = useMemo(() => createGame(quality, camera as THREE.PerspectiveCamera), [quality, camera])

  useEffect(() => {
    game.attach(scene)
    input.attach(gl.domElement)
    input.onLockChange = (locked) => {
      const ui = useUI.getState()
      ui.setPointerLocked(locked)
      if (!locked && ui.screen === 'game' && !ui.paused && !ui.dead) ui.setPaused(true)
    }
    onGame(game)
    if (import.meta.env.DEV) {
      // automation: advance the simulation deterministically at 60 Hz
      const step = (sec: number) => {
        const n = Math.round(sec * 60)
        for (let i = 0; i < n; i++) game.update(1 / 60, input.poll(1 / 60, 1, false), true)
      }
      Object.assign(window, { __sky: { game, input, ui: useUI, THREE, step } })
    }
    return () => {
      input.detach()
      input.onLockChange = undefined
      onGame(null)
    }
  }, [game, gl, scene, onGame])

  useFrame((_, delta) => {
    const ui = useUI.getState()
    const s = ui.save.settings
    const playing = ui.screen === 'game'
    input.enabled = playing && !ui.paused && !ui.dead
    const f = input.poll(Math.min(delta, 1 / 20), s.sensitivity, s.invertY)
    if (f.menu && playing && !ui.dead) {
      if (ui.paused) {
        ui.setPaused(false)
        input.requestLock()
      } else ui.setPaused(true)
    }
    game.viewportH = size.height * gl.getPixelRatio()
    game.post.reduce = s.reduceFlashes
    game.cam.shakeScale = s.shake
    if (ui.paused && playing) return
    game.update(delta, f, input.enabled)
  })

  return <primitive object={game.root} />
}

function PowerPass({ game }: { game: Game | null }) {
  const effect = useMemo(() => new PowerFXEffect(), [])
  useFrame(({ clock }) => {
    if (!game) return
    const p = game.post
    effect.set('uFlash', p.flash)
    effect.uniforms.get('uFlashColor')!.value.copy(p.flashColor)
    effect.set('uInvert', p.invert)
    effect.set('uZoom', p.zoom)
    effect.uniforms.get('uCenter')!.value.copy(p.center)
    effect.set('uLines', p.lines)
    effect.set('uChroma', p.chroma)
    effect.set('uDesat', p.desat)
    effect.uniforms.get('uTint')!.value.copy(p.tint)
    effect.uniforms.get('uShockCenter')!.value.copy(p.shockCenter)
    effect.set('uShockRadius', p.shockRadius)
    effect.set('uShockStrength', p.shockStrength)
    effect.set('uHurt', p.hurt)
    effect.set('uClock', clock.elapsedTime)
  })
  return <primitive object={effect} />
}

function Post({ quality, game }: { quality: Quality; game: Game | null }) {
  const effects: ReactElement[] = [
    <Bloom key="bloom" mipmapBlur intensity={1.15} luminanceThreshold={0.9} luminanceSmoothing={0.25} radius={0.8} />,
    <ToneMapping key="tm" mode={ToneMappingMode.AGX} />,
    <Vignette key="vg" offset={0.24} darkness={0.72} />,
  ]
  if (quality !== 'low') effects.push(<SMAA key="smaa" />)
  effects.push(<PowerPass key="power" game={game} />)
  return (
    <EffectComposer multisampling={0} stencilBuffer={false} autoClear={false}>
      {effects}
    </EffectComposer>
  )
}

export function GameCanvas({ quality, game, onGame }: { quality: Quality; game: Game | null; onGame: (g: Game | null) => void }) {
  const dpr: [number, number] = quality === 'high' ? [1, 1.5] : quality === 'medium' ? [1, 1.25] : [0.75, 1]
  return (
    <Canvas
      shadows
      dpr={dpr}
      gl={{ antialias: false, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer: false }}
      camera={{ fov: 62, near: 0.25, far: 6000, position: [0, 3, 8] }}
      onCreated={({ gl }) => {
        gl.shadowMap.type = THREE.PCFShadowMap
        gl.localClippingEnabled = true
      }}
      style={{ position: 'fixed', inset: 0 }}
    >
      <Environment resolution={128} frames={1} environmentIntensity={0.7}>
        <Lightformer form="rect" intensity={1.1} color="#8a4a6a" scale={[80, 30, 1]} position={[0, 40, 0]} rotation-x={Math.PI / 2} />
        <Lightformer form="ring" intensity={4} color="#ffb070" scale={14} position={SUN_DIR.clone().multiplyScalar(60).toArray()} target={[0, 0, 0]} />
        <Lightformer form="rect" intensity={0.8} color="#ff6a3a" scale={[140, 8, 1]} position={[0, 3, -70]} />
        <Lightformer form="rect" intensity={0.5} color="#5a4a8a" scale={[140, 10, 1]} position={[0, 5, 70]} rotation-y={Math.PI} />
        <Lightformer form="rect" intensity={0.4} color="#3a2a4a" scale={[140, 10, 1]} position={[-70, 5, 0]} rotation-y={Math.PI / 2} />
      </Environment>
      <CameraFill />
      <Stage quality={quality} onGame={onGame} />
      <Post quality={quality} game={game} />
    </Canvas>
  )
}
