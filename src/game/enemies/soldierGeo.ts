import * as THREE from 'three'

/**
 * One merged soldier mesh. Every vertex carries the body part it belongs to
 * (so the vertex shader can swing limbs about their joints), a colour and a
 * glow amount. Parts:
 *  0 torso/head  1 left leg  2 right leg  3 left arm  4 right arm
 *  5 tower shield (spearmen)  6 spear (spearmen)  7 bow (archers)  8 quiver (archers)
 */
export const HIP_L = new THREE.Vector3(0.11, 0.84, 0)
export const HIP_R = new THREE.Vector3(-0.11, 0.84, 0)
export const SH_L = new THREE.Vector3(0.27, 1.43, 0)
export const SH_R = new THREE.Vector3(-0.27, 1.43, 0)

const IRON = new THREE.Color('#2b2a2e')
const IRON_LIGHT = new THREE.Color('#4a4646')
const RED = new THREE.Color('#6e0d10')
const LEATHER = new THREE.Color('#3a2a1e')
const WOOD = new THREE.Color('#4a3420')
const BRASS = new THREE.Color('#8a6a30')
const STEEL = new THREE.Color('#8e939a')

export function soldierGeometry() {
  const geos: THREE.BufferGeometry[] = []
  const put = (g: THREE.BufferGeometry, part: number, color: THREE.Color, glow = 0, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    g = g.index ? g.toNonIndexed() : g
    g.rotateX(rx)
    g.rotateY(ry)
    g.rotateZ(rz)
    g.translate(x, y, z)
    const n = g.attributes.position.count
    const col = new Float32Array(n * 3)
    const parts = new Float32Array(n)
    const glows = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      col[i * 3] = color.r
      col[i * 3 + 1] = color.g
      col[i * 3 + 2] = color.b
      parts[i] = part
      glows[i] = glow
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    g.setAttribute('aPart', new THREE.BufferAttribute(parts, 1))
    g.setAttribute('aGlow', new THREE.BufferAttribute(glows, 1))
    g.deleteAttribute('uv')
    geos.push(g)
  }
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d)
  const cyl = (r0: number, r1: number, h: number, s = 8) => new THREE.CylinderGeometry(r0, r1, h, s)

  // torso
  put(box(0.42, 0.46, 0.27), 0, IRON, 0, 0, 1.24, 0)
  put(box(0.44, 0.08, 0.29), 0, BRASS, 0, 0, 1.44, 0)
  put(box(0.34, 0.24, 0.22), 0, LEATHER, 0, 0, 0.96, 0)
  put(box(0.36, 0.42, 0.04), 0, RED, 0, 0, 0.8, 0.13) // tabard front
  put(box(0.38, 0.46, 0.04), 0, RED, 0, 0, 0.8, -0.13) // tabard back
  put(box(0.16, 0.12, 0.3), 0, IRON_LIGHT, 0, 0.27, 1.47, 0, 0, 0, -0.35) // pauldrons
  put(box(0.16, 0.12, 0.3), 0, IRON_LIGHT, 0, -0.27, 1.47, 0, 0, 0, 0.35)
  // helm with a glowing slit and a crest
  put(cyl(0.125, 0.135, 0.28, 10), 0, IRON, 0, 0, 1.66, 0)
  put(new THREE.SphereGeometry(0.125, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, IRON, 0, 0, 1.8, 0)
  put(box(0.16, 0.025, 0.04), 0, new THREE.Color('#ff3a1a'), 6, 0, 1.68, 0.12)
  put(box(0.04, 0.14, 0.34), 0, RED, 0, 0, 1.9, -0.02)

  // legs (hang from the hips)
  for (const [part, x] of [
    [1, 0.11],
    [2, -0.11],
  ] as const) {
    put(box(0.15, 0.42, 0.16), part, LEATHER, 0, x, 0.6, 0)
    put(box(0.15, 0.36, 0.16), part, IRON, 0, x, 0.22, 0.01)
    put(box(0.14, 0.08, 0.24), part, IRON_LIGHT, 0, x, 0.04, 0.04)
  }
  // arms (hang from the shoulders, forearms angled forward)
  for (const [part, x] of [
    [3, 0.29],
    [4, -0.29],
  ] as const) {
    put(box(0.12, 0.3, 0.13), part, IRON, 0, x, 1.25, 0)
    put(box(0.11, 0.12, 0.3), part, LEATHER, 0, x, 1.06, 0.1)
  }
  // spearman kit
  put(box(0.06, 1.0, 0.56), 5, RED, 0, 0.42, 1.0, 0.18)
  put(box(0.07, 0.86, 0.06), 5, BRASS, 0, 0.45, 1.0, 0.18)
  put(cyl(0.022, 0.022, 2.7, 5), 6, WOOD, 0, -0.29, 1.08, 0.3, Math.PI / 2 - 0.15)
  put(new THREE.ConeGeometry(0.05, 0.3, 4), 6, STEEL, 0, -0.29, 1.28, 1.62, Math.PI / 2 - 0.15)
  // archer kit
  for (let i = 0; i < 5; i++) {
    const a = -0.9 + (i / 4) * 1.8
    put(box(0.035, 0.36, 0.035), 7, WOOD, 0, 0.32, 1.06 + Math.sin(a) * 0.55, 0.32 + Math.cos(a) * 0.12, a * 0.6)
  }
  put(cyl(0.07, 0.06, 0.55, 6), 8, LEATHER, 0, 0.1, 1.3, -0.2, 0.3)

  // merge
  let count = 0
  for (const g of geos) count += g.attributes.position.count
  const pos = new Float32Array(count * 3)
  const nor = new Float32Array(count * 3)
  const col = new Float32Array(count * 3)
  const part = new Float32Array(count)
  const glow = new Float32Array(count)
  let o = 0
  for (const g of geos) {
    const n = g.attributes.position.count
    pos.set(g.attributes.position.array as Float32Array, o * 3)
    nor.set(g.attributes.normal.array as Float32Array, o * 3)
    col.set(g.attributes.color.array as Float32Array, o * 3)
    part.set(g.attributes.aPart.array as Float32Array, o)
    glow.set(g.attributes.aGlow.array as Float32Array, o)
    o += n
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  out.setAttribute('color', new THREE.BufferAttribute(col, 3))
  out.setAttribute('aPart', new THREE.BufferAttribute(part, 1))
  out.setAttribute('aGlow', new THREE.BufferAttribute(glow, 1))
  out.computeBoundingSphere()
  return out
}

/** Pose a vertex: which joint it swings about, by how much, and whether its kit is hidden. */
const ANIM_GLSL = /* glsl */ `
attribute float aPart;
attribute vec4 aAnim; // phase, mode + 8 * variant, progress, burn
mat3 sRotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 sRotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
void sPose(out mat3 rot, out vec3 pivot, out float hide) {
  float ph = aAnim.x;
  float variant = floor(aAnim.y / 8.0);
  float mode = mod(aAnim.y, 8.0);
  float pr = aAnim.z;
  float legA = 0.0, armL = 0.0, armR = 0.0, armRZ = 0.0, armLZ = 0.0;
  if (mode < 0.5) {            // march / run
    legA = sin(ph) * 0.75; armL = -sin(ph) * 0.3 - 0.1; armR = sin(ph) * 0.35 - 0.25;
  } else if (mode < 1.5) {     // spear thrust
    float th = sin(clamp(pr, 0.0, 1.0) * 3.14159);
    armR = -1.1 * th - 0.2; legA = 0.35 * th; armL = -0.3;
  } else if (mode < 2.5) {     // thrown: flailing
    legA = sin(ph * 3.0) * 1.1; armL = sin(ph * 4.1 + 1.0) * 2.2; armR = cos(ph * 3.7) * 2.2;
    armLZ = -0.8; armRZ = 0.8;
  } else if (mode < 3.5) {     // archer drawing (progress 0..1)
    armL = -1.5; armR = -1.3 - pr * 0.2; armRZ = 0.3 * pr; legA = 0.15;
  } else {                     // stand
    armL = -0.15; armR = -0.25;
  }
  int part = int(aPart + 0.5);
  rot = mat3(1.0);
  pivot = vec3(0.0);
  if (part == 1) { rot = sRotX(legA); pivot = vec3(${HIP_L.x}, ${HIP_L.y}, 0.0); }
  else if (part == 2) { rot = sRotX(-legA); pivot = vec3(${HIP_R.x}, ${HIP_R.y}, 0.0); }
  else if (part == 3 || part == 5 || part == 7) { rot = sRotZ(armLZ) * sRotX(armL); pivot = vec3(${SH_L.x}, ${SH_L.y}, 0.0); }
  else if (part == 4 || part == 6) { rot = sRotZ(armRZ) * sRotX(armR); pivot = vec3(${SH_R.x}, ${SH_R.y}, 0.0); }
  hide = 0.0;
  if (variant < 0.5 && (part == 7 || part == 8)) hide = 1.0;
  if (variant > 0.5 && (part == 5 || part == 6)) hide = 1.0;
}
`

const BEGIN = /* glsl */ `
mat3 sRot; vec3 sPivot; float sHide;
sPose(sRot, sPivot, sHide);
vec3 transformed = (sPivot + sRot * (position - sPivot)) * (1.0 - sHide);`

/** Shadow pass with the same limb animation. */
export function soldierDepthMaterial() {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${ANIM_GLSL}`).replace('#include <begin_vertex>', BEGIN)
  }
  m.customProgramCacheKey = () => 'soldier-depth-v1'
  return m
}

/** Vertex-animated material: limbs swing about their joints per instance. */
export function soldierMaterial() {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.4 })
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        ${ANIM_GLSL}
        attribute float aGlow;
        varying float vGlow;
        varying float vBurn;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `
        mat3 nRot; vec3 nPivot; float nHide;
        sPose(nRot, nPivot, nHide);
        vec3 objectNormal = nRot * normal;
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3( tangent.xyz );
        #endif`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `${BEGIN}
        vGlow = aGlow;
        vBurn = aAnim.w;`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;\nvarying float vBurn;')
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.25, 0.08) * vGlow;
        diffuseColor.rgb *= 1.0 - min(vBurn, 1.0) * 0.85;
        totalEmissiveRadiance += vec3(3.0, 1.1, 0.25) * vBurn * vBurn;`,
      )
  }
  mat.customProgramCacheKey = () => 'soldier-v1'
  return mat
}
