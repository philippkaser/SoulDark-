import { Effect, EffectAttribute } from 'postprocessing'
import * as THREE from 'three'

/**
 * One full-screen pass for every "power" beat: anime impact frames, radial
 * zoom blur, speed lines, chromatic punches, refractive shock rings,
 * time-stop desaturation, damage vignette and white-outs. It samples the
 * input at arbitrary offsets, so it is a convolution effect and must sit in
 * its own pass after tone mapping.
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
uniform vec2 uShockCenter;
uniform float uShockRadius;
uniform float uShockStrength;
uniform float uHurt;
uniform float uClock;

float pfHash(float n) { return fract(sin(n) * 43758.5453123); }

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 st = uv;
  vec2 asp = vec2(aspect, 1.0);

  // refractive shock ring
  if (uShockStrength > 0.0) {
    vec2 d = (uv - uShockCenter) * asp;
    float r = length(d);
    float band = exp(-pow((r - uShockRadius) * 14.0, 2.0));
    st -= (d / max(r, 1e-4)) / asp * band * uShockStrength;
  }

  vec3 col;
  if (uZoom > 0.002 || uChroma > 0.002 || uShockStrength > 0.0) {
    vec2 dir = st - uCenter;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 10; i++) {
      float k = float(i) / 9.0;
      vec2 o = st - dir * k * uZoom;
      vec2 ca = dir * uChroma * 0.02 * (0.6 + k);
      acc.r += texture2D(inputBuffer, o + ca).r;
      acc.g += texture2D(inputBuffer, o).g;
      acc.b += texture2D(inputBuffer, o - ca).b;
    }
    col = acc / 10.0;
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
        ['uShockCenter', new THREE.Uniform(new THREE.Vector2(0.5, 0.5))],
        ['uShockRadius', new THREE.Uniform(0)],
        ['uShockStrength', new THREE.Uniform(0)],
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
