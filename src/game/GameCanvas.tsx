import { Environment, Lightformer } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Bloom, EffectComposer, ToneMapping, Vignette } from '@react-three/postprocessing'
import { EffectPass, SMAAEffect, ToneMappingMode } from 'postprocessing'
import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import * as THREE from 'three'
import { AtmosphereEffect } from '../engine/gfx/atmosphere'
import { GodRaysEffect } from '../engine/gfx/godrays'
import { PowerFXEffect } from '../engine/gfx/powerfx'
import { StreakEffect } from '../engine/gfx/streak'
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

const QUALITY_K: Record<Quality, number> = { high: 1, medium: 0.75, low: 0.5 }

/** Contact shadows and drifting ground haze from the depth buffer (HDR, ahead of everything that glows). */
function AtmospherePass({ game, quality }: { game: Game | null; quality: Quality }) {
  const { camera } = useThree()
  const effect = useMemo(() => new AtmosphereEffect({ aoSamples: quality === 'high' ? 10 : quality === 'medium' ? 6 : 0 }), [quality])
  useEffect(() => () => effect.dispose(), [effect])
  useFrame(() => {
    effect.camera = camera
    if (!game) return
    // the haze takes the sky's colour, so it follows the dawn
    const fc = effect.uniforms.get('uFogColor')!.value as THREE.Color
    fc.copy(game.sky.fogColor).multiplyScalar(0.55)
    effect.uniforms.get('uSunDir')!.value.copy(SUN_DIR)
  })
  return <primitive object={effect} />
}

/** Eclipse light shafts + blast shafts (HDR, before tone mapping). */
function RaysPass({ game, quality }: { game: Game | null; quality: Quality }) {
  const effect = useMemo(() => new GodRaysEffect({ quality: QUALITY_K[quality] }), [quality])
  useEffect(() => () => effect.dispose(), [effect])
  useFrame(() => {
    if (!game) return
    const p = game.post
    const dawn = game.sky.u.uDawn.value
    effect.sun.copy(p.sunScreen)
    effect.sunStrength = p.sunRays * p.sunVis
    // the dawn sun is a far stronger light than the corona, and its shafts reach further
    effect.sunGain = 0.9 + dawn * 0.8
    effect.sunReach = 2.5 - dawn * 1.2
    effect.threshold = 0.35 + dawn * 0.9
    effect.blast.copy(p.blastScreen)
    effect.blastStrength = p.blastRays
    effect.blastColor.copy(p.blastColor)
  })
  return <primitive object={effect} />
}

/** Anamorphic lens streaks from the hottest pixels (HDR, before tone mapping). */
function StreakPass({ game, quality }: { game: Game | null; quality: Quality }) {
  const effect = useMemo(() => new StreakEffect({ quality: QUALITY_K[quality] }), [quality])
  useEffect(() => () => effect.dispose(), [effect])
  useFrame(() => {
    if (!game) return
    effect.amount = game.post.streakAmount
    // at rest only the hottest cores streak; a kick lets the whole blast flare
    effect.threshold = 2.6 - Math.min(1, game.post.streakKick * 0.6)
  })
  return <primitive object={effect} />
}

/**
 * SMAA on the tone-mapped image, in a pass of its own: merged into the HDR
 * chain it would replace edge pixels with raw, un-tone-mapped input.
 */
function SmaaPass() {
  const camera = useThree((s) => s.camera)
  const pass = useMemo(() => new EffectPass(camera, new SMAAEffect()), [camera])
  useEffect(() => () => pass.dispose(), [pass])
  return <primitive object={pass} />
}

/** PowerFX samples its input at offsets (a convolution), so it always gets a pass of its own. */
function PowerPass({ game, quality }: { game: Game | null; quality: Quality }) {
  const camera = useThree((s) => s.camera)
  const effect = useMemo(() => new PowerFXEffect(), [])
  const pass = useMemo(() => new EffectPass(camera, effect), [camera, effect])
  useEffect(() => () => pass.dispose(), [pass])
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
    effect.uniforms.get('uShock')!.value = p.shockData
    effect.uniforms.get('uShockSharp')!.value = p.shockSharp
    effect.set('uShockOn', p.shockOn ? 1 : 0)
    effect.uniforms.get('uHaze')!.value = p.hazeData
    effect.set('uHazeOn', p.hazeOn ? 1 : 0)
    effect.set('uHazeClock', p.hazeClock)
    effect.set('uFringe', quality === 'low' ? 0 : p.fringe)
    effect.set('uHurt', p.hurt)
    effect.uniforms.get('uCut')!.value = p.cutData
    effect.uniforms.get('uCutGlow')!.value = p.cutGlow
    effect.set('uCutOn', p.cutOn ? 1 : 0)
    effect.set('uClock', clock.elapsedTime)
  })
  return <primitive object={pass} />
}

function Post({ quality, game }: { quality: Quality; game: Game | null }) {
  // shafts and streaks read HDR input and only sample their own low-res buffers, so they merge with bloom + tone mapping
  const effects: ReactElement[] = [
    <AtmospherePass key="atmo" game={game} quality={quality} />,
    <RaysPass key="rays" game={game} quality={quality} />,
    <StreakPass key="streak" game={game} quality={quality} />,
    <Bloom key="bloom" mipmapBlur intensity={1.15} luminanceThreshold={0.9} luminanceSmoothing={0.25} radius={0.8} />,
    <ToneMapping key="tm" mode={ToneMappingMode.AGX} />,
    <Vignette key="vg" offset={0.24} darkness={0.72} />,
  ]
  if (quality !== 'low') effects.push(<SmaaPass key="smaa" />)
  effects.push(<PowerPass key="power" game={game} quality={quality} />)
  return (
    <EffectComposer multisampling={0} stencilBuffer={false} autoClear={false}>
      {effects}
    </EffectComposer>
  )
}

export function GameCanvas({ quality, game, onGame }: { quality: Quality; game: Game | null; onGame: (g: Game | null) => void }) {
  const dpr: [number, number] = quality === 'high' ? [1, 1.75] : quality === 'medium' ? [1, 1.25] : [0.75, 1]
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
      <Environment resolution={256} frames={1} environmentIntensity={0.85}>
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
