import { Effect, EffectAttribute, ShaderPass } from 'postprocessing'
import * as THREE from 'three'

/**
 * Screen-space volumetric light shafts. Two lights: the sun/eclipse (only
 * sky pixels emit, found through the depth buffer, so every silhouette in
 * front of the corona cuts a shaft) and a transient blast light (every bright
 * pixel near the explosion emits). Both are radially blurred toward their
 * screen position at reduced resolution in two passes (N then N² effective
 * samples), so the merged effect itself only reads its own texture and can
 * share a pass with bloom and tone mapping. Feed it HDR input.
 */

const vert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`

const maskFrag = /* glsl */ `
uniform sampler2D inputBuffer;
uniform sampler2D depthBuffer;
uniform float uHasDepth;
uniform vec2 uTexel;
uniform float uAspect;
uniform vec2 uSun;
uniform float uSunOn;
uniform float uSunThreshold;
uniform vec2 uBlast;
uniform float uBlastOn;
varying vec2 vUv;

void main() {
  vec3 sky = vec3(0.0);
  vec3 all = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 0 || i == 2 ? -1.0 : 1.0, i < 2 ? -1.0 : 1.0) * uTexel;
    vec2 p = vUv + o;
    vec3 c = texture2D(inputBuffer, p).rgb;
    // the sky is never written to depth: anything nearer is an occluder
    float open = uHasDepth > 0.5 ? step(0.9999995, texture2D(depthBuffer, p).r) : 1.0;
    sky += c * open;
    all += c;
  }
  sky *= 0.25;
  all *= 0.25;
  vec2 asp = vec2(uAspect, 1.0);
  vec4 o = vec4(0.0);
  if (uSunOn > 0.0) {
    float d = length((vUv - uSun) * asp);
    o.rgb = max(sky - uSunThreshold, 0.0) * uSunOn / (1.0 + d * d * 30.0);
  }
  if (uBlastOn > 0.0) {
    float d = length((vUv - uBlast) * asp);
    float lum = dot(all, vec3(0.2126, 0.7152, 0.0722));
    o.a = max(lum - 0.9, 0.0) * uBlastOn * exp(-d * d * 5.0);
  }
  gl_FragColor = min(o, vec4(12.0));
}
`

const blurFrag = /* glsl */ `
uniform sampler2D tMap;
uniform vec2 uSun;
uniform float uSunOn;
uniform vec2 uBlast;
uniform float uBlastOn;
uniform float uLen;
uniform float uDecay;
varying vec2 vUv;

float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

void main() {
  float j = ign(gl_FragCoord.xy);
  vec4 acc = vec4(0.0);
  float n = float(SAMPLES);
  if (uSunOn > 0.0) {
    vec2 delta = (vUv - uSun) * (uLen / n);
    vec2 p = vUv - delta * j;
    float w = 1.0;
    vec3 s = vec3(0.0);
    for (int i = 0; i < SAMPLES; i++) {
      s += texture2D(tMap, p).rgb * w;
      w *= uDecay;
      p -= delta;
    }
    acc.rgb = s / n;
  }
  if (uBlastOn > 0.0) {
    vec2 delta = (vUv - uBlast) * (uLen / n);
    vec2 p = vUv - delta * j;
    float w = 1.0;
    float s = 0.0;
    for (int i = 0; i < SAMPLES; i++) {
      s += texture2D(tMap, p).a * w;
      w *= uDecay;
      p -= delta;
    }
    acc.a = s / n;
  }
  gl_FragColor = acc;
}
`

const composite = /* glsl */ `
uniform sampler2D tRays;
uniform float uSunGain;
uniform vec3 uBlastColor;
uniform float uBlastGain;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec4 r = texture2D(tRays, uv);
  outputColor = vec4(inputColor.rgb + r.rgb * uSunGain + uBlastColor * (r.a * uBlastGain), inputColor.a);
}
`

function shader(frag: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, number> = {}) {
  return new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms, defines, depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false })
}

export interface GodRaysOptions {
  /** 0.5 low .. 1 high: sample count and buffer resolution. */
  quality?: number
}

export class GodRaysEffect extends Effect {
  /** Sun / eclipse light: screen uv and strength (0 = off). */
  readonly sun = new THREE.Vector2(0.5, 0.8)
  sunStrength = 0
  /** Transient blast light. */
  readonly blast = new THREE.Vector2(0.5, 0.5)
  blastStrength = 0
  readonly blastColor = new THREE.Color(1, 0.86, 0.66)
  /** Composite gains (exposure of the shafts). */
  sunGain = 1
  blastGain = 1
  private rtA: THREE.WebGLRenderTarget
  private rtB: THREE.WebGLRenderTarget
  private maskPass: ShaderPass
  private blurPass: ShaderPass
  private maskU: Record<string, THREE.IUniform>
  private blurU: Record<string, THREE.IUniform>
  private scale: number
  private samples: number
  private idle = false

  constructor({ quality = 1 }: GodRaysOptions = {}) {
    super('GodRaysEffect', composite, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, THREE.Uniform>([
        ['tRays', new THREE.Uniform(null)],
        ['uSunGain', new THREE.Uniform(0)],
        ['uBlastColor', new THREE.Uniform(new THREE.Color())],
        ['uBlastGain', new THREE.Uniform(0)],
      ]),
    })
    this.scale = quality >= 1 ? 0.5 : quality >= 0.75 ? 0.4 : 0.3
    this.samples = quality >= 1 ? 40 : quality >= 0.75 ? 30 : 20
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }
    this.rtA = new THREE.WebGLRenderTarget(1, 1, opts)
    this.rtB = new THREE.WebGLRenderTarget(1, 1, opts)
    this.maskU = {
      inputBuffer: { value: null },
      depthBuffer: { value: null },
      uHasDepth: { value: 0 },
      uTexel: { value: new THREE.Vector2() },
      uAspect: { value: 1 },
      uSun: { value: this.sun },
      uSunOn: { value: 0 },
      uSunThreshold: { value: 0.35 },
      uBlast: { value: this.blast },
      uBlastOn: { value: 0 },
    }
    this.blurU = {
      tMap: { value: null },
      uSun: { value: this.sun },
      uSunOn: { value: 0 },
      uBlast: { value: this.blast },
      uBlastOn: { value: 0 },
      uLen: { value: 1 },
      uDecay: { value: 1 },
    }
    this.maskPass = new ShaderPass(shader(maskFrag, this.maskU))
    this.blurPass = new ShaderPass(shader(blurFrag, this.blurU, { SAMPLES: this.samples }), 'tMap')
    this.uniforms.get('tRays')!.value = this.rtA.texture
  }

  /** Brightness above which sky pixels emit shafts. */
  set threshold(v: number) {
    this.maskU.uSunThreshold.value = v
  }

  setDepthTexture(depthTexture: THREE.Texture) {
    this.maskU.depthBuffer.value = depthTexture
    this.maskU.uHasDepth.value = depthTexture ? 1 : 0
  }

  setSize(width: number, height: number) {
    const w = Math.max(1, Math.round(width * this.scale))
    const h = Math.max(1, Math.round(height * this.scale))
    this.rtA.setSize(w, h)
    this.rtB.setSize(w, h)
    this.maskU.uTexel.value.set(0.5 / width / this.scale, 0.5 / height / this.scale)
    this.maskU.uAspect.value = width / Math.max(1, height)
  }

  update(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget) {
    const sunOn = this.sunStrength > 0.002 ? this.sunStrength : 0
    const blastOn = this.blastStrength > 0.002 ? this.blastStrength : 0
    this.uniforms.get('uSunGain')!.value = sunOn > 0 ? this.sunGain : 0
    this.uniforms.get('uBlastGain')!.value = blastOn > 0 ? this.blastGain : 0
    this.uniforms.get('uBlastColor')!.value.copy(this.blastColor)
    if (!sunOn && !blastOn) {
      this.idle = true
      return
    }
    this.idle = false
    this.maskU.uSunOn.value = sunOn
    this.maskU.uBlastOn.value = blastOn
    this.blurU.uSunOn.value = sunOn
    this.blurU.uBlastOn.value = blastOn
    this.maskPass.render(renderer, inputBuffer, this.rtA)
    // pass 1 spans the whole way to the light; pass 2 fills the gaps between its taps
    this.blurU.uLen.value = 1
    this.blurU.uDecay.value = Math.pow(0.25, 1 / this.samples)
    this.blurPass.render(renderer, this.rtA, this.rtB)
    this.blurU.uLen.value = 1 / this.samples
    this.blurU.uDecay.value = 1
    this.blurPass.render(renderer, this.rtB, this.rtA)
  }

  /** True when the last frame skipped the shaft passes. */
  get sleeping() {
    return this.idle
  }

  dispose() {
    super.dispose()
    this.rtA.dispose()
    this.rtB.dispose()
    this.maskPass.dispose()
    this.blurPass.dispose()
  }
}
