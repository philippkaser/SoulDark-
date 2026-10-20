import { useFrame } from '@react-three/fiber'
import { forwardRef, useImperativeHandle, useMemo } from 'react'
import * as THREE from 'three'

export const FOG_COLOR = new THREE.Color('#1a212c')
/** Direction toward the eclipse (north, low over the Warden's arena). */
export const SUN_DIR = new THREE.Vector3(0.12, 0.27, -1).normalize()

const vert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`

const frag = /* glsl */ `
uniform float uTime;
uniform vec3 uSun;
uniform vec3 uHorizon;
varying vec3 vDir;
float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float n2(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), u.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), u.x), u.y); }
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * n2(p); p = p * 2.03 + 11.7; a *= 0.5; } return v; }

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 zenith = vec3(0.012, 0.016, 0.028);
  vec3 col = mix(uHorizon, zenith, smoothstep(-0.02, 0.55, h));

  // warm haze toward the eclipse
  float toward = max(dot(normalize(d.xz), normalize(uSun.xz)), 0.0);
  col += vec3(0.42, 0.14, 0.05) * pow(toward, 6.0) * exp(-max(h, 0.0) * 5.0) * 0.9;
  col += vec3(0.2, 0.07, 0.03) * pow(toward, 2.0) * exp(-max(h, 0.0) * 9.0) * 0.5;

  // stars
  vec2 sp = d.xz / (abs(h) + 0.4) * 160.0;
  float star = step(0.9965, h21(floor(sp))) * smoothstep(0.1, 0.5, h);
  star *= 0.5 + 0.5 * sin(uTime * 2.0 + h21(floor(sp) + 3.0) * 40.0);
  col += vec3(0.6, 0.7, 0.9) * star * 0.6;

  // the eclipse: black disc with a burning corona
  float ang = acos(clamp(dot(d, uSun), -1.0, 1.0));
  float R = 0.075;
  float x = ang - R;
  vec3 axis1 = normalize(cross(uSun, vec3(0.0, 1.0, 0.0)));
  vec3 axis2 = cross(axis1, uSun);
  float theta = atan(dot(d, axis2), dot(d, axis1));
  float rays = fbm(vec2(theta * 6.0, uTime * 0.05)) * 0.7 + fbm(vec2(theta * 23.0, -uTime * 0.03)) * 0.5;
  vec3 coronaCol = vec3(1.0, 0.42, 0.12);
  float corona = 0.0;
  if (x > 0.0) {
    corona = 6.0 * exp(-x * 120.0) + 1.4 * exp(-x * 22.0) * (0.6 + rays) + 0.35 * exp(-x * 5.0) * rays;
  }
  float rim = smoothstep(0.004, 0.0, abs(x)) * 10.0;
  col += coronaCol * corona + vec3(1.0, 0.75, 0.45) * rim;
  if (x < 0.0) col = vec3(0.004, 0.002, 0.002) + coronaCol * 0.25 * smoothstep(-0.02, 0.0, x);

  // drifting clouds, lit from behind by the corona
  if (h > -0.05) {
    vec2 cp = d.xz / (h + 0.18) * 1.6 + vec2(uTime * 0.008, uTime * 0.004);
    float c = smoothstep(0.45, 0.85, fbm(cp));
    float lit = exp(-ang * 3.0) * 1.5 + 0.08;
    vec3 cloudCol = mix(vec3(0.035, 0.04, 0.05), vec3(0.5, 0.18, 0.07), clamp(lit * 0.6, 0.0, 1.0));
    float fade = smoothstep(-0.05, 0.12, h) * (1.0 - smoothstep(0.55, 0.95, h));
    col = mix(col, cloudCol + coronaCol * lit * 0.15, c * fade * 0.85);
  }

  // below the horizon: fog
  col = mix(col, uHorizon, smoothstep(0.02, -0.08, h));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

export function Sky() {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        uniforms: {
          uTime: { value: 0 },
          uSun: { value: SUN_DIR.clone() },
          uHorizon: { value: FOG_COLOR.clone() },
        },
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    [],
  )
  useFrame((state, dt) => {
    mat.uniforms.uTime.value += dt
    // keep the dome centered on the camera
    const m = state.scene.getObjectByName('skydome')
    if (m) m.position.copy(state.camera.position)
  })
  return (
    <mesh name="skydome" material={mat} renderOrder={-10} frustumCulled={false}>
      <sphereGeometry args={[800, 48, 24]} />
    </mesh>
  )
}

/** A bright ring at the eclipse used as the god-ray source; it rides along with the camera. */
export const SunDisc = forwardRef<THREE.Mesh>(function SunDisc(_, ref) {
  const mesh = useMemo(() => {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(34, 62, 64),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 0.85, 0.3), transparent: true, opacity: 0.9, depthWrite: false, fog: false }),
    )
    m.frustumCulled = false
    m.lookAt(SUN_DIR.clone().negate())
    return m
  }, [])
  useImperativeHandle(ref, () => mesh, [mesh])
  useFrame((state) => {
    mesh.position.copy(state.camera.position).addScaledVector(SUN_DIR, 500)
  })
  return <primitive object={mesh} />
})
