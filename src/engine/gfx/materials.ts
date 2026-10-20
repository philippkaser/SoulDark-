import * as THREE from 'three'

/**
 * Shader patches layered onto MeshStandardMaterial:
 *  - rim light (fresnel) so silhouettes read against the dark world
 *  - dissolve into glowing ash (enemy deaths)
 *  - hit flash
 *  - molten cut faces: when a mesh is sliced by a clipping plane its back
 *    faces show through the cut and glow like the inside of a forge
 */

export interface SDUniforms {
  uDissolve: { value: number }
  uFlash: { value: number }
  uRimColor: { value: THREE.Color }
  uRimStrength: { value: number }
  uRimPower: { value: number }
  uEdgeColor: { value: THREE.Color }
  uCut: { value: number }
  uCutColor: { value: THREE.Color }
}

const NOISE_GLSL = /* glsl */ `
varying vec3 vSDWorld;
uniform float uDissolve;
uniform float uFlash;
uniform vec3 uRimColor;
uniform float uRimStrength;
uniform float uRimPower;
uniform vec3 uEdgeColor;
uniform float uCut;
uniform vec3 uCutColor;
float sdHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float sdNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(sdHash(i), sdHash(i + vec3(1,0,0)), f.x), mix(sdHash(i + vec3(0,1,0)), sdHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(sdHash(i + vec3(0,0,1)), sdHash(i + vec3(1,0,1)), f.x), mix(sdHash(i + vec3(0,1,1)), sdHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
`

export function patchMaterial<T extends THREE.MeshStandardMaterial>(mat: T, rim = 0.35, rimColor = '#8fa6c8'): T {
  const u: SDUniforms = {
    uDissolve: { value: 0 },
    uFlash: { value: 0 },
    uRimColor: { value: new THREE.Color(rimColor) },
    uRimStrength: { value: rim },
    uRimPower: { value: 3.0 },
    uEdgeColor: { value: new THREE.Color(1.0, 0.42, 0.1) },
    uCut: { value: 0 },
    uCutColor: { value: new THREE.Color(1.0, 0.45, 0.12) },
  }
  mat.userData.sd = u
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSDWorld;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvSDWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE_GLSL}`)
      .replace(
        '#include <clipping_planes_fragment>',
        /* glsl */ `#include <clipping_planes_fragment>
        float sdEdge = 0.0;
        if (uDissolve > 0.0) {
          float dn = sdNoise(vSDWorld * 3.1) * 0.65 + sdNoise(vSDWorld * 9.0) * 0.35;
          float th = uDissolve * 1.12 - 0.06;
          if (dn < th) discard;
          sdEdge = 1.0 - smoothstep(0.0, 0.07, dn - th);
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        float sdFres = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), uRimPower);
        totalEmissiveRadiance += uRimColor * sdFres * uRimStrength;
        totalEmissiveRadiance += uEdgeColor * sdEdge * 8.0;
        totalEmissiveRadiance += vec3(1.0, 0.9, 0.8) * uFlash * (0.35 + sdFres);
        if (uCut > 0.0 && !gl_FrontFacing) {
          float cn = sdNoise(vSDWorld * 1.7) * 0.6 + sdNoise(vSDWorld * 6.0) * 0.4;
          totalEmissiveRadiance += uCutColor * uCut * (2.0 + cn * 6.0);
          diffuseColor.rgb *= 0.1;
        }`,
      )
  }
  mat.customProgramCacheKey = () => 'sd-v2'
  return mat
}

export const sdUniforms = (m: THREE.Material) => m.userData.sd as SDUniforms | undefined

export interface MatParams {
  color: THREE.ColorRepresentation
  roughness?: number
  metalness?: number
  map?: THREE.Texture | null
  normalMap?: THREE.Texture | null
  roughnessMap?: THREE.Texture | null
  normalScale?: number
  emissive?: THREE.ColorRepresentation
  emissiveIntensity?: number
  emissiveMap?: THREE.Texture | null
  side?: THREE.Side
  alphaMap?: THREE.Texture | null
  alphaTest?: number
  rim?: number
  rimColor?: string
  transparent?: boolean
  opacity?: number
}

export function standard(p: MatParams) {
  const m = new THREE.MeshStandardMaterial({
    color: p.color,
    roughness: p.roughness ?? 0.6,
    metalness: p.metalness ?? 0,
    map: p.map ?? null,
    normalMap: p.normalMap ?? null,
    roughnessMap: p.roughnessMap ?? null,
    emissive: p.emissive ?? 0x000000,
    emissiveIntensity: p.emissiveIntensity ?? 1,
    emissiveMap: p.emissiveMap ?? null,
    side: p.side ?? THREE.FrontSide,
    alphaMap: p.alphaMap ?? null,
    alphaTest: p.alphaTest ?? 0,
    transparent: p.transparent ?? false,
    opacity: p.opacity ?? 1,
  })
  if (p.normalMap) m.normalScale.setScalar(p.normalScale ?? 1)
  return patchMaterial(m, p.rim ?? 0.3, p.rimColor)
}

/**
 * Clone a patched material with its own uniforms (Material.clone would drop the
 * shader hook and serialise the uniform objects).
 */
export function clonePatched(src: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  const u = sdUniforms(src)
  const saved = src.userData
  src.userData = {}
  const m = src.clone()
  src.userData = saved
  if (!u) return m
  const c = patchMaterial(m, u.uRimStrength.value, '#' + u.uRimColor.value.getHexString())
  const cu = sdUniforms(c)!
  cu.uRimColor.value.copy(u.uRimColor.value)
  cu.uFlash.value = u.uFlash.value
  return c
}
