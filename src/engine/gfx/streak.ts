import { Effect, ShaderPass } from 'postprocessing'
import * as THREE from 'three'

/**
 * Anamorphic lens streaks: the brightest pixels smear into long horizontal
 * lines. A bright-pass at quarter resolution, then three horizontal blurs
 * with growing stride (1, 7, 49 texels) that together approximate an
 * exponential falloff hundreds of texels long. Like the god rays, the merged
 * effect only reads its own texture, so it shares a pass with bloom.
 */

const vert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`

const brightFrag = /* glsl */ `
uniform sampler2D inputBuffer;
uniform vec2 uTexel;
uniform float uThreshold;
varying vec2 vUv;

void main() {
  vec3 c = texture2D(inputBuffer, vUv + vec2(-uTexel.x, -uTexel.y)).rgb;
  c += texture2D(inputBuffer, vUv + vec2(uTexel.x, -uTexel.y)).rgb;
  c += texture2D(inputBuffer, vUv + vec2(-uTexel.x, uTexel.y)).rgb;
  c += texture2D(inputBuffer, vUv + vec2(uTexel.x, uTexel.y)).rgb;
  c *= 0.25;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = smoothstep(uThreshold, uThreshold * 2.0, lum);
  gl_FragColor = vec4(min(c * k, vec3(40.0)), 1.0);
}
`

const lineFrag = /* glsl */ `
uniform sampler2D tMap;
uniform float uStep;
uniform float uFall;
varying vec2 vUv;

void main() {
  vec3 s = texture2D(tMap, vUv).rgb;
  float ws = 1.0;
  for (int i = 1; i <= 6; i++) {
    float fi = float(i);
    float w = exp(-fi * uFall);
    vec2 o = vec2(fi * uStep, 0.0);
    s += (texture2D(tMap, vUv + o).rgb + texture2D(tMap, vUv - o).rgb) * w;
    ws += 2.0 * w;
  }
  gl_FragColor = vec4(s / ws, 1.0);
}
`

const composite = /* glsl */ `
uniform sampler2D tStreak;
uniform float uGain;
uniform vec3 uTint;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 s = texture2D(tStreak, uv).rgb;
  float l = dot(s, vec3(0.2126, 0.7152, 0.0722));
  // anamorphic glass pulls the colour toward a cold blue
  s = mix(s, vec3(l), 0.55) * uTint;
  outputColor = vec4(inputColor.rgb + s * uGain, inputColor.a);
}
`

function shader(frag: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false })
}

/** Texel strides of the three blur passes and the per-texel falloff length. */
export const STREAK_STRIDES = [1, 7, 49] as const

export class StreakEffect extends Effect {
  /** Overall streak strength (0 = off, passes skipped). */
  amount = 0
  readonly tint = new THREE.Color(0.55, 0.75, 1.35)
  private rtA: THREE.WebGLRenderTarget
  private rtB: THREE.WebGLRenderTarget
  private brightPass: ShaderPass
  private linePass: ShaderPass
  private brightU: Record<string, THREE.IUniform>
  private lineU: Record<string, THREE.IUniform>
  private texelX = 1
  private scale: number
  /** Falloff length of the streak, in low-res texels. */
  length = 70

  constructor({ quality = 1 }: { quality?: number } = {}) {
    super('StreakEffect', composite, {
      uniforms: new Map<string, THREE.Uniform>([
        ['tStreak', new THREE.Uniform(null)],
        ['uGain', new THREE.Uniform(0)],
        ['uTint', new THREE.Uniform(new THREE.Color())],
      ]),
    })
    this.scale = quality >= 0.75 ? 0.25 : 0.2
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }
    this.rtA = new THREE.WebGLRenderTarget(1, 1, opts)
    this.rtB = new THREE.WebGLRenderTarget(1, 1, opts)
    this.brightU = { inputBuffer: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 2.2 } }
    this.lineU = { tMap: { value: null }, uStep: { value: 0 }, uFall: { value: 0.1 } }
    this.brightPass = new ShaderPass(shader(brightFrag, this.brightU))
    this.linePass = new ShaderPass(shader(lineFrag, this.lineU), 'tMap')
    this.uniforms.get('tStreak')!.value = this.rtB.texture
  }

  /** HDR luminance where streaks start. */
  set threshold(v: number) {
    this.brightU.uThreshold.value = v
  }

  setSize(width: number, height: number) {
    const w = Math.max(1, Math.round(width * this.scale))
    const h = Math.max(1, Math.round(height * this.scale))
    this.rtA.setSize(w, h)
    this.rtB.setSize(w, h)
    this.texelX = 1 / w
    this.brightU.uTexel.value.set(0.5 / width / this.scale, 0.5 / height / this.scale)
  }

  update(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget) {
    const on = this.amount > 0.003
    this.uniforms.get('uGain')!.value = on ? this.amount : 0
    this.uniforms.get('uTint')!.value.copy(this.tint)
    if (!on) return
    this.brightPass.render(renderer, inputBuffer, this.rtA)
    // A -> B -> A -> B: three strides
    let src = this.rtA
    let dst = this.rtB
    for (const stride of STREAK_STRIDES) {
      this.lineU.uStep.value = stride * this.texelX
      this.lineU.uFall.value = stride / this.length
      this.linePass.render(renderer, src, dst)
      const t = src
      src = dst
      dst = t
    }
  }

  dispose() {
    super.dispose()
    this.rtA.dispose()
    this.rtB.dispose()
    this.brightPass.dispose()
    this.linePass.dispose()
  }
}
