import { Effect, EffectAttribute } from 'postprocessing'
import * as THREE from 'three'

/** Simultaneous refractive shock rings and heat-haze regions (uniform array sizes). */
export const MAX_SHOCKS = 6
export const MAX_HAZE = 6

/**
 * One full-screen pass for every "power" beat: anime impact frames, radial
 * zoom blur, speed lines, chromatic punches, stacked refractive shock rings,
 * heat haze, lens-edge fringing, time-stop desaturation, damage vignette and
 * white-outs. It samples the input at arbitrary offsets, so it is a
 * convolution effect and must sit in its own pass after tone mapping.
 */
const frag = /* glsl */ `
uniform float uFlash;
uniform vec3 uFlashColor;
uniform float uInvert;
uniform float uZoom;
uniform vec2 uCenter;
uniform float uLines;
uniform float uChroma;
uniform float uDesat;
uniform vec3 uTint;
// xy screen centre, z radius (screen heights), w strength
uniform vec4 uShock[${MAX_SHOCKS}];
uniform float uShockSharp[${MAX_SHOCKS}];
uniform float uShockOn;
// xy screen position of the source, z radius (screen heights), w strength
uniform vec4 uHaze[${MAX_HAZE}];
uniform float uHazeOn;
uniform float uHazeClock;
uniform float uFringe;
uniform float uHurt;
uniform float uClock;

float pfHash(float n) { return fract(sin(n) * 43758.5453123); }

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 st = uv;
  vec2 asp = vec2(aspect, 1.0);
  bool warped = false;

  // refractive shock rings, stacked
  if (uShockOn > 0.0) {
    for (int i = 0; i < ${MAX_SHOCKS}; i++) {
      vec4 s = uShock[i];
      if (s.w <= 0.0) continue;
      vec2 d = (uv - s.xy) * asp;
      float r = length(d);
      float band = exp(-pow((r - s.z) * uShockSharp[i], 2.0));
      st -= (d / max(r, 1e-4)) / asp * band * s.w;
    }
    warped = true;
  }

  // heat haze: a shimmering column rising over each burning source
  if (uHazeOn > 0.0) {
    float t = uHazeClock;
    vec2 q = uv * asp * vec2(64.0, 38.0);
    float wx = sin(q.y - t * 7.0 + sin(q.x * 0.55 + t * 2.3) * 1.9);
    float wy = sin(q.x * 0.8 + t * 1.7 + sin(q.y * 0.9 - t * 5.1) * 1.4);
    for (int i = 0; i < ${MAX_HAZE}; i++) {
      vec4 h = uHaze[i];
      if (h.w <= 0.0) continue;
      vec2 e = ((uv - h.xy) * asp - vec2(0.0, h.z * 0.6)) / vec2(h.z, h.z * 1.6);
      float m = smoothstep(1.0, 0.2, length(e));
      st += vec2(wx, wy * 0.5) * (h.w * m * 0.0045);
    }
    warped = true;
  }

  // lens fringing grows toward the frame edge
  vec2 fc = uv - 0.5;
  vec2 fringe = fc * dot(fc * asp, fc * asp) * uFringe;

  vec3 col;
  if (uZoom > 0.002 || uChroma > 0.002) {
    vec2 dir = st - uCenter;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 10; i++) {
      float k = float(i) / 9.0;
      vec2 o = st - dir * k * uZoom;
      vec2 ca = dir * uChroma * 0.02 * (0.6 + k) + fringe;
      acc.r += texture2D(inputBuffer, o + ca).r;
      acc.g += texture2D(inputBuffer, o).g;
      acc.b += texture2D(inputBuffer, o - ca).b;
    }
    col = acc / 10.0;
  } else if (warped || uFringe > 0.0) {
    col = vec3(texture2D(inputBuffer, st + fringe).r, texture2D(inputBuffer, st).g, texture2D(inputBuffer, st - fringe).b);
  } else {
    col = inputColor.rgb;
  }

  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(lum) * uTint, uDesat);

  // anime speed lines converging on the focus point
  if (uLines > 0.001) {
    vec2 d = (uv - uCenter) * asp;
    float ang = atan(d.y, d.x);
    float r = length(d);
    float seg = floor(ang * 64.0);
    float flick = floor(uClock * 30.0);
    float n = pfHash(seg * 1.7 + flick * 3.1);
    float w = fract(ang * 64.0);
    float thin = smoothstep(0.0, 0.18, w) * smoothstep(0.62, 0.3, w);
    float line = step(0.78, n) * thin * smoothstep(0.32 + n * 0.25, 0.95, r);
    col = mix(col, vec3(1.0, 0.98, 0.94), line * uLines * 0.75);
  }

  // damage vignette
  if (uHurt > 0.0) {
    float v = smoothstep(0.35, 0.95, length((uv - 0.5) * asp * 1.1));
    col = mix(col, vec3(0.5, 0.0, 0.02), v * uHurt);
  }

  // impact frames
  if (uInvert > 0.5) {
    float t = smoothstep(0.2, 0.32, lum);
    if (uInvert < 1.5) col = mix(vec3(1.0, 0.98, 0.93), vec3(0.0), t);
    else col = mix(vec3(0.03, 0.0, 0.01), vec3(1.0, 0.94, 0.8), t);
  }

  col = mix(col, uFlashColor, clamp(uFlash, 0.0, 1.0));
  outputColor = vec4(col, inputColor.a);
}
`

export class PowerFXEffect extends Effect {
  constructor() {
    super('PowerFXEffect', frag, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([
        ['uFlash', new THREE.Uniform(0)],
        ['uFlashColor', new THREE.Uniform(new THREE.Color(1, 1, 1))],
        ['uInvert', new THREE.Uniform(0)],
        ['uZoom', new THREE.Uniform(0)],
        ['uCenter', new THREE.Uniform(new THREE.Vector2(0.5, 0.5))],
        ['uLines', new THREE.Uniform(0)],
        ['uChroma', new THREE.Uniform(0)],
        ['uDesat', new THREE.Uniform(0)],
        ['uTint', new THREE.Uniform(new THREE.Color(1, 1, 1))],
        ['uShock', new THREE.Uniform(Array.from({ length: MAX_SHOCKS }, () => new THREE.Vector4()))],
        ['uShockSharp', new THREE.Uniform(new Array<number>(MAX_SHOCKS).fill(14))],
        ['uShockOn', new THREE.Uniform(0)],
        ['uHaze', new THREE.Uniform(Array.from({ length: MAX_HAZE }, () => new THREE.Vector4()))],
        ['uHazeOn', new THREE.Uniform(0)],
        ['uHazeClock', new THREE.Uniform(0)],
        ['uFringe', new THREE.Uniform(0)],
        ['uHurt', new THREE.Uniform(0)],
        ['uClock', new THREE.Uniform(0)],
      ]),
    })
  }

  set(name: string, value: number) {
    this.uniforms.get(name)!.value = value
  }

  get(name: string) {
    return this.uniforms.get(name)!.value
  }
}
