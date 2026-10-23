import { Effect, EffectAttribute } from 'postprocessing'
import * as THREE from 'three'

/**
 * What the depth buffer can add to a lit frame, in one HDR pass ahead of the
 * light shafts and bloom:
 *  - ambient occlusion: everything near the camera settles into its contact
 *    shadows (feet on the ground, spires on the plain, crater walls), from a
 *    spiral of depth samples around each pixel with normals rebuilt from the
 *    depth itself, fading out with distance;
 *  - ground haze: exponential height fog integrated along each view ray,
 *    broken into drifting banks by noise and lit warm toward the eclipse, so
 *    the plain and the valleys fill with smoke and the ranges stack in layers.
 */

const frag = /* glsl */ `
uniform mat4 uProjInv;
uniform mat4 uViewInv;
uniform float uProj11;
uniform float uAO;
uniform float uAORadius;
uniform float uFog;
uniform float uFogFall;
uniform float uFogMax;
uniform vec3 uFogColor;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uClock;

vec3 atmView(vec2 uv, float d) {
  vec4 v = uProjInv * vec4(vec3(uv, d) * 2.0 - 1.0, 1.0);
  return v.xyz / v.w;
}
float atmHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float atmNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(atmHash(i), atmHash(i + vec2(1, 0)), f.x), mix(atmHash(i + vec2(0, 1)), atmHash(i + vec2(1, 1)), f.x), f.y);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec3 col = inputColor.rgb;
  // the sky is never written to depth: it keeps its own horizon
  if (depth >= 0.9999995) {
    outputColor = inputColor;
    return;
  }
  vec3 P = atmView(uv, depth);
  float dist = length(P);

  #if AO_SAMPLES > 0
  if (uAO > 0.0 && dist < 140.0) {
    vec3 N = normalize(cross(dFdx(P), dFdy(P)));
    // the search radius in uv, shrinking with distance
    float sr = uAORadius * uProj11 * 0.5 / max(-P.z, 0.5);
    float rot = atmHash(gl_FragCoord.xy) * 6.2831853;
    float occ = 0.0;
    for (int i = 0; i < AO_SAMPLES; i++) {
      float fi = (float(i) + 0.5) / float(AO_SAMPLES);
      float a = rot + float(i) * 2.3999632;
      vec2 suv = uv + vec2(cos(a) / aspect, sin(a)) * sqrt(fi) * sr;
      vec3 S = atmView(suv, readDepth(suv));
      vec3 v = S - P;
      float vv = dot(v, v);
      // only nearby occluders count: a spire a hundred metres behind is not a contact shadow
      float range = 1.0 - smoothstep(uAORadius * uAORadius, uAORadius * uAORadius * 4.0, vv);
      occ += max(0.0, dot(v, N) - 0.03 * dist * 0.05) / (vv + 0.05) * range;
    }
    float ao = clamp(1.0 - occ * uAO * 1.6 / float(AO_SAMPLES), 0.0, 1.0);
    col *= mix(1.0, ao, 1.0 - smoothstep(70.0, 140.0, dist));
  }
  #endif

  if (uFog > 0.0) {
    vec3 W = (uViewInv * vec4(P, 1.0)).xyz;
    vec3 C = uViewInv[3].xyz;
    vec3 ray = W - C;
    float L = max(length(ray), 1e-3);
    vec3 rd = ray / L;
    // density uFog * exp(-y / uFogFall), integrated from the eye to the surface
    float base = uFog * exp(-C.y / uFogFall);
    float k = rd.y * L / uFogFall;
    float amount = abs(k) > 1e-4 ? base * uFogFall * (1.0 - exp(-k)) / rd.y : base * L;
    // banks of smoke drifting over the plain
    vec2 q = W.xz * 0.012 + vec2(uClock * 0.018, uClock * 0.007);
    float bank = 0.35 + 1.1 * atmNoise(q) * (0.6 + 0.4 * atmNoise(q * 3.1 + 7.0));
    float f = (1.0 - exp(-amount * bank)) * uFogMax;
    // forward-scattered toward the eclipse, dim and violet away from it
    float toward = pow(max(dot(rd, uSunDir), 0.0), 5.0);
    vec3 fc = uFogColor * (0.8 + 0.4 * bank) + uSunColor * toward;
    col = mix(col, fc, f);
  }
  outputColor = vec4(col, inputColor.a);
}
`

export interface AtmosphereOptions {
  /** Depth samples per pixel for the ambient occlusion (0 turns it off). */
  aoSamples?: number
}

export class AtmosphereEffect extends Effect {
  camera: THREE.Camera | null = null

  constructor({ aoSamples = 12 }: AtmosphereOptions = {}) {
    super('AtmosphereEffect', frag, {
      attributes: EffectAttribute.DEPTH,
      defines: new Map([['AO_SAMPLES', String(aoSamples)]]),
      uniforms: new Map<string, THREE.Uniform>([
        ['uProjInv', new THREE.Uniform(new THREE.Matrix4())],
        ['uViewInv', new THREE.Uniform(new THREE.Matrix4())],
        ['uProj11', new THREE.Uniform(1)],
        ['uAO', new THREE.Uniform(aoSamples > 0 ? 0.9 : 0)],
        ['uAORadius', new THREE.Uniform(1.6)],
        ['uFog', new THREE.Uniform(0.0011)],
        ['uFogFall', new THREE.Uniform(24)],
        ['uFogMax', new THREE.Uniform(0.6)],
        ['uFogColor', new THREE.Uniform(new THREE.Color(0.2, 0.09, 0.1))],
        ['uSunColor', new THREE.Uniform(new THREE.Color(1.3, 0.55, 0.22))],
        ['uSunDir', new THREE.Uniform(new THREE.Vector3(0, 0.2, -1).normalize())],
        ['uClock', new THREE.Uniform(0)],
      ]),
    })
  }

  set(name: string, value: number) {
    this.uniforms.get(name)!.value = value
  }

  update(_renderer: THREE.WebGLRenderer, _input: THREE.WebGLRenderTarget, dt?: number) {
    const cam = this.camera
    if (!cam) return
    const u = this.uniforms
    u.get('uProjInv')!.value.copy((cam as THREE.PerspectiveCamera).projectionMatrixInverse)
    u.get('uViewInv')!.value.copy(cam.matrixWorld)
    u.get('uProj11')!.value = (cam as THREE.PerspectiveCamera).projectionMatrix.elements[5]
    u.get('uClock')!.value += dt ?? 0
  }
}
