import * as THREE from 'three'

/** Shared GLSL: 3D value noise + fbm. */
export const NOISE3 = /* glsl */ `
float h31(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float n3(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm3(vec3 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * n3(p); p = p * 2.02 + 7.1; a *= 0.5; } return v; }
`

// ---------------------------------------------------------------------------
// Fireball: a boiling sphere that burns white-hot, then cools into smoke
// ---------------------------------------------------------------------------

export function fireballMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uHeat: { value: 1 }, uAlpha: { value: 1 }, uSeed: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uSeed;
      varying vec3 vN;
      varying vec3 vView;
      varying float vNoise;
      ${NOISE3}
      void main() {
        vec3 p = position;
        float n = fbm3(normal * 2.2 + vec3(0.0, -uTime * 0.9, uSeed));
        vNoise = n;
        p += normal * (n - 0.45) * 0.38;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vView = normalize(-mv.xyz);
        vN = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uHeat;
      uniform float uAlpha;
      uniform float uTime;
      varying vec3 vN;
      varying vec3 vView;
      varying float vNoise;
      void main() {
        float fres = clamp(dot(vN, vView), 0.0, 1.0);
        float t = clamp(uHeat * (0.55 + vNoise * 0.9) * (0.5 + fres * 0.7), 0.0, 1.4);
        vec3 smoke = vec3(0.09, 0.07, 0.065) * (0.6 + vNoise);
        vec3 c = mix(smoke, vec3(1.4, 0.32, 0.05), smoothstep(0.08, 0.4, t));
        c = mix(c, vec3(3.2, 1.6, 0.45), smoothstep(0.4, 0.8, t));
        c = mix(c, vec3(6.0, 5.2, 4.2), smoothstep(0.8, 1.2, t));
        float a = uAlpha * smoothstep(0.0, 0.35, fres) * (0.75 + 0.25 * vNoise);
        gl_FragColor = vec4(c, a);
      }`,
    transparent: true,
    depthWrite: false,
    fog: false,
  })
}

// ---------------------------------------------------------------------------
// Flare: star-shaped glare with an anamorphic streak (impacts, muzzle flashes)
// ---------------------------------------------------------------------------

export function flareMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(1, 0.9, 0.7) }, uAlpha: { value: 0 }, uRot: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv * 2.0 - 1.0;
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec2 sc = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
        mv.xy += position.xy * sc;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uAlpha;
      uniform float uRot;
      varying vec2 vUv;
      void main() {
        float r = length(vUv);
        float cs = cos(uRot), sn = sin(uRot);
        vec2 q = mat2(cs, -sn, sn, cs) * vUv;
        float core = exp(-r * 9.0) * 3.0 + exp(-r * 3.0) * 0.6;
        float star = exp(-abs(q.x) * 60.0) * exp(-abs(q.y) * 2.2) + exp(-abs(q.y) * 60.0) * exp(-abs(q.x) * 2.2);
        float streak = exp(-abs(vUv.y) * 90.0) * exp(-abs(vUv.x) * 0.9) * 1.4;
        float v = (core + star * 0.8 + streak) * smoothstep(1.0, 0.55, r);
        gl_FragColor = vec4(uColor * v * uAlpha, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  })
}

// ---------------------------------------------------------------------------
// Ring: an expanding annulus (ground shockwaves, parry rings)
// ---------------------------------------------------------------------------

export function ringMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() }, uAlpha: { value: 0 }, uThick: { value: 0.3 }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uAlpha;
      uniform float uThick;
      uniform float uTime;
      varying vec2 vUv;
      float h(float n) { return fract(sin(n) * 43758.5453); }
      void main() {
        vec2 d = vUv - 0.5;
        float r = length(d) * 2.0;
        float inner = 1.0 - uThick;
        float band = smoothstep(inner, inner + uThick * 0.6, r) * (1.0 - smoothstep(0.96, 1.0, r));
        float a = atan(d.y, d.x);
        float broken = 0.75 + 0.25 * h(floor(a * 24.0) + floor(uTime * 20.0));
        gl_FragColor = vec4(uColor * band * uAlpha * broken, band * uAlpha);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  })
}

// ---------------------------------------------------------------------------
// Bubble: a fresnel shell (blast spheres, divine barrier flashes)
// ---------------------------------------------------------------------------

export function bubbleMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() }, uAlpha: { value: 0 }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vView; varying vec3 vP;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = normalize(-mv.xyz); vN = normalize(normalMatrix * normal); vP = position;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uAlpha; uniform float uTime;
      varying vec3 vN; varying vec3 vView; varying vec3 vP;
      ${NOISE3}
      void main() {
        float f = 1.0 - abs(dot(vN, vView));
        float n = n3(vP * 3.0 + uTime * 2.0);
        float v = pow(f, 2.5) * (0.7 + n * 0.6);
        gl_FragColor = vec4(uColor * v * uAlpha, v * uAlpha);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  })
}

// ---------------------------------------------------------------------------
// Streak: a long glowing cut in the air (Judgment lines, laser sights, sky cut)
// ---------------------------------------------------------------------------

/** Unit streak along +Y from 0..1, width along X; billboarded around its axis in the vertex shader. */
export function streakMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(1, 0.9, 0.7) }, uAlpha: { value: 0 }, uWidth: { value: 0.1 }, uCore: { value: 1 } },
    vertexShader: /* glsl */ `
      uniform float uWidth;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec3 a = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 b = (modelMatrix * vec4(0.0, 1.0, 0.0, 1.0)).xyz;
        vec3 p = mix(a, b, position.y);
        vec3 axis = normalize(b - a);
        vec3 toCam = normalize(cameraPosition - p);
        vec3 side = normalize(cross(axis, toCam));
        p += side * position.x * uWidth;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uAlpha;
      uniform float uCore;
      varying vec2 vUv;
      void main() {
        float x = abs(vUv.x - 0.5) * 2.0;
        float ends = smoothstep(0.0, 0.06, vUv.y) * smoothstep(1.0, 0.94, vUv.y);
        float glow = exp(-x * 4.0) * 0.8 + exp(-x * 22.0) * 2.5 * uCore;
        gl_FragColor = vec4(mix(uColor, vec3(1.0), exp(-x * 18.0) * uCore) * glow * uAlpha * ends, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  })
}

// ---------------------------------------------------------------------------
// Crescent: the flying slash. An arc band with a white-hot leading edge.
// ---------------------------------------------------------------------------

/**
 * A crescent in the swing plane (XZ), convex toward +Z (the direction of
 * travel), built from two sheets so it reads from any angle: a ribbon lying in
 * the swing plane and a thin curved wall standing across it. Roll the mesh
 * about Z to tilt the swing plane (0 = horizontal cut, PI/2 = vertical chop).
 */
export function crescentGeometry(segments = 40) {
  const pos: number[] = []
  const uv: number[] = []
  const kind: number[] = []
  const idx: number[] = []
  const span = Math.PI * 0.82
  const sheet = (wall: boolean) => {
    const base = pos.length / 3
    for (let i = 0; i <= segments; i++) {
      const u = i / segments
      const a = -span / 2 + span * u
      const taper = Math.pow(Math.sin(u * Math.PI), 0.6)
      for (let j = 0; j <= 1; j++) {
        if (wall) {
          const y = (j - 0.5) * 0.24 * taper
          pos.push(Math.sin(a), y, Math.cos(a) - 1)
        } else {
          const r = j === 0 ? 1 - 0.2 * taper : 1.0
          pos.push(Math.sin(a) * r, 0, Math.cos(a) * r - 1)
        }
        uv.push(u, j)
        kind.push(wall ? 1 : 0)
      }
    }
    for (let i = 0; i < segments; i++) {
      const a = base + i * 2
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  sheet(false)
  sheet(true)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1))
  g.setIndex(idx)
  return g
}

export function crescentMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(1, 0.75, 0.35) }, uAlpha: { value: 1 }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float aKind;
      varying vec2 vUv;
      varying float vKind;
      void main() { vUv = uv; vKind = aKind; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uAlpha;
      uniform float uTime;
      varying vec2 vUv;
      varying float vKind;
      float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
      void main() {
        float ends = pow(sin(vUv.x * 3.14159), 0.7);
        // ribbon: hot along the leading (outer) edge; wall: hot along its middle
        float across = vKind < 0.5 ? vUv.y : 1.0 - abs(vUv.y * 2.0 - 1.0);
        float wisp = n(vec2(vUv.x * 34.0 - uTime * 14.0, across * 5.0));
        float body = pow(across, 2.2) * ends;
        float hot = pow(smoothstep(0.84, 1.0, across) * ends, 2.0);
        vec3 c = uColor * body * (0.55 + wisp * 0.9) + vec3(4.0, 3.6, 3.0) * hot;
        float a = clamp(body * (0.4 + wisp * 0.6) + hot, 0.0, 1.0) * uAlpha;
        gl_FragColor = vec4(c * uAlpha, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  })
}

// ---------------------------------------------------------------------------
// Beam: a column of energy (orbital lance, caught beam, the Eye's gaze)
// ---------------------------------------------------------------------------

/** Cylinder from y=0..1 with radius 1. */
export function beamGeometry() {
  const g = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true)
  g.translate(0, 0.5, 0)
  return g
}

export function beamMaterial(color: THREE.ColorRepresentation) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uAlpha: { value: 0 },
      uTime: { value: 0 },
      uLen: { value: 100 },
      // radius scale at the start and end of the beam: a caught beam narrows into the blade
      uRoot: { value: 1 },
      uTip: { value: 1 },
    },
    vertexShader: /* glsl */ `
      uniform float uRoot; uniform float uTip;
      varying vec2 vUv; varying vec3 vN; varying vec3 vView; varying vec3 vPos;
      void main() {
        vUv = uv;
        vec3 p = position;
        p.xz *= mix(uRoot, uTip, position.y);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vPos = mv.xyz;
        vView = normalize(-mv.xyz); vN = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uAlpha; uniform float uTime; uniform float uLen;
      varying vec2 vUv; varying vec3 vN; varying vec3 vView; varying vec3 vPos;
      ${NOISE3}
      void main() {
        float f = abs(dot(vN, vView));
        float core = pow(f, 3.0);
        float n = n3(vec3(vUv.x * 12.0, vUv.y * uLen * 0.08 - uTime * 18.0, uTime));
        float rings = 0.75 + 0.25 * sin(vUv.y * uLen * 0.6 - uTime * 60.0);
        // don't swallow the camera when it ends up inside the beam
        float near = smoothstep(3.0, 18.0, length(vPos));
        vec3 c = uColor * (0.4 + f * 1.2) * (0.6 + n * 0.8) * rings + vec3(5.0, 4.6, 4.2) * core;
        gl_FragColor = vec4(c * uAlpha * near, uAlpha * (0.25 + f) * near);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  })
}

// ---------------------------------------------------------------------------
// Ghost: afterimages of the hero
// ---------------------------------------------------------------------------

/** Skinning defines are added by the renderer for SkinnedMesh objects. */
export function ghostMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(1.0, 0.75, 0.35) }, uAlpha: { value: 1 } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <skinning_pars_vertex>
      varying vec3 vN; varying vec3 vView;
      void main() {
        #include <skinbase_vertex>
        #include <beginnormal_vertex>
        #include <skinnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
        vView = normalize(-mv.xyz);
        vN = normalize(normalMatrix * objectNormal);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uAlpha;
      varying vec3 vN; varying vec3 vView;
      void main() {
        float f = 1.0 - abs(dot(normalize(vN), vView));
        float v = 0.15 + pow(f, 2.0) * 1.6;
        gl_FragColor = vec4(uColor * v * uAlpha, v * uAlpha);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  })
}
