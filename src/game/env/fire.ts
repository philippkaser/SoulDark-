import * as THREE from 'three'

const vert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  // camera-facing billboard around the Y axis
  vec4 center = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec3 scale = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), 1.0);
  center.xy += position.xy * scale.xy;
  gl_Position = projectionMatrix * center;
}
`

const frag = /* glsl */ `
uniform float uTime;
uniform float uSeed;
uniform float uIntensity;
uniform vec3 uCore;
uniform vec3 uEdge;
varying vec2 vUv;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * n2(p); p *= 2.07; a *= 0.5; } return v; }
void main() {
  vec2 uv = vUv;
  float t = uTime * 1.6 + uSeed * 10.0;
  vec2 q = vec2(uv.x * 2.2, uv.y * 1.6 - t);
  float n = fbm(q + fbm(q * 1.7 + t * 0.3));
  // teardrop shape narrowing upward
  float x = (uv.x - 0.5) * 2.0;
  float width = mix(0.85, 0.05, pow(uv.y, 0.9));
  float body = 1.0 - smoothstep(width * 0.55, width, abs(x) + (n - 0.5) * 0.55);
  float hgt = 1.0 - smoothstep(0.35, 1.0, uv.y + (n - 0.5) * 0.45);
  float base = smoothstep(0.0, 0.08, uv.y);
  float f = clamp(body * hgt * base * (0.65 + n * 0.8), 0.0, 1.0);
  vec3 col = mix(uEdge, uCore, smoothstep(0.35, 0.95, f));
  col = mix(col, vec3(1.0, 0.95, 0.85), smoothstep(0.85, 1.0, f) * (1.0 - uv.y));
  gl_FragColor = vec4(col * f * uIntensity, f);
}
`

export function flameMaterial(seed = 0, intensity = 3, core = '#ffd27a', edge = '#ff3a08') {
  return new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: {
      uTime: { value: 0 },
      uSeed: { value: seed },
      uIntensity: { value: intensity },
      uCore: { value: new THREE.Color(core) },
      uEdge: { value: new THREE.Color(edge) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  })
}

/** Rising ember particles that loop forever. */
export function emberColumn(count: number, radius: number, height: number, size = 0.05) {
  const geo = new THREE.BufferGeometry()
  const pos = new Float32Array(count * 3)
  const seed = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * radius
    pos[i * 3 + 1] = Math.random()
    pos[i * 3 + 2] = (Math.random() - 0.5) * radius
    seed[i] = Math.random()
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uHeight: { value: height }, uSize: { value: size }, uScale: { value: 600 } },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime; uniform float uHeight; uniform float uSize; uniform float uScale;
      varying float vA;
      void main() {
        float life = fract(position.y + uTime * (0.18 + aSeed * 0.25));
        vec3 p = vec3(position.x * (1.0 + life * 2.0), life * uHeight, position.z * (1.0 + life * 2.0));
        p.x += sin(uTime * 2.0 + aSeed * 30.0 + life * 6.0) * 0.25 * life;
        p.z += cos(uTime * 1.7 + aSeed * 21.0 + life * 5.0) * 0.25 * life;
        vA = smoothstep(0.0, 0.1, life) * (1.0 - smoothstep(0.5, 1.0, life)) * (0.5 + aSeed);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = uSize * uScale / -mv.z * (0.6 + aSeed);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = (1.0 - smoothstep(0.0, 1.0, d)) * vA;
        gl_FragColor = vec4(vec3(1.0, 0.45, 0.12) * 3.0 * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const pts = new THREE.Points(geo, mat)
  pts.frustumCulled = false
  return pts
}
