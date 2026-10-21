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
    // only the fireball's core emits, not the sky and ground it lights up, or the shafts melt into a veil
    float d = length((vUv - uBlast) * asp);
    float lum = dot(all, vec3(0.2126, 0.7152, 0.0722));
    o.a = max(lum - 2.5, 0.0) * uBlastOn * exp(-d * d * 8.0);
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

// shafts fade with screen distance from their light, so they reach across the sky without fogging the foreground
const composite = /* glsl */ `
uniform sampler2D tRays;
uniform vec2 uSunUv;
uniform float uSunGain;
uniform float uSunReach;
uniform vec2 uBlastUv;
uniform vec3 uBlastColor;
uniform float uBlastGain;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec4 r = texture2D(tRays, uv);
  vec2 asp = vec2(aspect, 1.0);
  vec2 ds = (uv - uSunUv) * asp;
  vec2 db = (uv - uBlastUv) * asp;
  float fs = uSunGain / (1.0 + dot(ds, ds) * uSunReach);
  float fb = uBlastGain / (1.0 + dot(db, db) * 1.2);
  outputColor = vec4(inputColor.rgb + r.rgb * fs + uBlastColor * (r.a * fb), inputColor.a);
}
`

function shader(frag: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, number> = {}) {
  return new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms, defines, depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false })
}

/** Buffer scale and radial-blur taps per quality factor (1 high, 0.75 medium, 0.5 low). */
export function godRaysBudget(quality: number) {
  return quality >= 1 ? { scale: 0.5, samples: 36 } : quality >= 0.75 ? { scale: 0.4, samples: 28 } : { scale: 0.3, samples: 20 }
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
  /** How fast sun shafts fade with screen distance from the sun (higher = shorter). */
  sunReach = 2.5
  private rtA: THREE.WebGLRenderTarget
  private rtB: THREE.WebGLRenderTarget
  private maskPass: ShaderPass
  private blurPass: ShaderPass
  private maskU: Record<string, THREE.IUniform>
  private blurU: Record<string, THREE.IUniform>
  private scale: number
  private samples: number

  constructor({ quality = 1 }: { quality?: number } = {}) {
    super('GodRaysEffect', composite, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, THREE.Uniform>([
        ['tRays', new THREE.Uniform(null)],
        ['uSunUv', new THREE.Uniform(new THREE.Vector2())],
        ['uSunGain', new THREE.Uniform(0)],
        ['uSunReach', new THREE.Uniform(2.5)],
        ['uBlastUv', new THREE.Uniform(new THREE.Vector2())],
        ['uBlastColor', new THREE.Uniform(new THREE.Color())],
        ['uBlastGain', new THREE.Uniform(0)],
      ]),
    })
    const b = godRaysBudget(quality)
    this.scale = b.scale
    this.samples = b.samples
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
    // four bilinear taps half a low-res texel out cover each low-res texel's whole footprint
    this.maskU.uTexel.value.set(0.5 / w, 0.5 / h)
    this.maskU.uAspect.value = width / Math.max(1, height)
  }

  update(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget) {
    const sunOn = this.sunStrength > 0.002 ? this.sunStrength : 0
    const blastOn = this.blastStrength > 0.002 ? this.blastStrength : 0
    const u = this.uniforms
    u.get('uSunGain')!.value = sunOn > 0 ? this.sunGain : 0
    u.get('uBlastGain')!.value = blastOn > 0 ? this.blastGain : 0
    u.get('uSunUv')!.value.copy(this.sun)
    u.get('uSunReach')!.value = this.sunReach
    u.get('uBlastUv')!.value.copy(this.blast)
    u.get('uBlastColor')!.value.copy(this.blastColor)
    // nothing to shine: skip all three low-res passes
    if (!sunOn && !blastOn) return
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

  dispose() {
    super.dispose()
    this.rtA.dispose()
    this.rtB.dispose()
    this.maskPass.dispose()
    this.blurPass.dispose()
  }
}
