import {
  Bloom,
  BrightnessContrast,
  ChromaticAberration,
  EffectComposer,
  GodRays,
  HueSaturation,
  N8AO,
  Noise,
  SMAA,
  ToneMapping,
  Vignette,
} from '@react-three/postprocessing'
import { BlendFunction, ToneMappingMode } from 'postprocessing'
import type { ReactElement } from 'react'
import * as THREE from 'three'
import type { Quality } from '../state/save'

export function PostFX({ quality, sun }: { quality: Quality; sun: THREE.Mesh | null }) {
  const effects: ReactElement[] = []
  if (quality !== 'low') {
    effects.push(
      <N8AO
        key="ao"
        halfRes
        aoRadius={1.4}
        distanceFalloff={1.1}
        intensity={quality === 'high' ? 2.6 : 2.0}
        quality={quality === 'high' ? 'medium' : 'performance'}
        color={new THREE.Color('#000000')}
      />,
    )
  }
  if (quality === 'high' && sun) {
    effects.push(
      <GodRays key="rays" sun={sun} samples={40} density={0.96} decay={0.93} weight={0.35} exposure={0.42} clampMax={1} blur />,
    )
  }
  effects.push(
    <Bloom key="bloom" mipmapBlur intensity={0.95} luminanceThreshold={0.85} luminanceSmoothing={0.2} radius={0.75} />,
    <ChromaticAberration key="ca" offset={new THREE.Vector2(0.0006, 0.0005)} radialModulation modulationOffset={0.35} />,
    <ToneMapping key="tm" mode={ToneMappingMode.AGX} />,
    <HueSaturation key="hs" saturation={-0.08} />,
    <BrightnessContrast key="bc" brightness={0.01} contrast={0.08} />,
    <Vignette key="vg" offset={0.26} darkness={0.78} />,
    <Noise key="noise" opacity={0.055} blendFunction={BlendFunction.OVERLAY} premultiply />,
    <SMAA key="smaa" />,
  )
  return (
    <EffectComposer multisampling={0} stencilBuffer={false}>
      {effects}
    </EffectComposer>
  )
}
