import * as THREE from 'three'
import { PERTURB_GLSL } from './triplanar'

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

/** Optional surface programs layered into the patch. */
export interface PatchOpts {
  /**
   * Procedural basalt in world space: bedded strata in banded tones, cracks
   * that glow near the ground, ash lying on every ledge, and a relief bump.
   */
  rock?: boolean
}

/** World-space rock for a patched material (see PatchOpts.rock). */
const ROCK_GLSL = /* glsl */ `
float rkLayer(float y) { return sdNoise(vec3(floor(y * 0.55) * 1.37, 0.5, 0.5)); }
float rkHeight(vec3 p) {
  float bed = sin(p.y * 2.2 + sdNoise(p * 0.12) * 5.0) * 0.5 + 0.5;
  return bed * 0.35 + sdNoise(p * 1.3) * 0.45 + sdNoise(p * 5.0) * 0.2;
}
float rkCrack(vec3 p) {
  // a few long fissures in patches, not a web over everything
  float n = sdNoise(p * vec3(0.35, 1.1, 0.35) + sdNoise(p * 0.25) * 1.2);
  float zone = smoothstep(0.55, 0.75, sdNoise(p * 0.18 + 3.1));
  return smoothstep(0.018, 0.0, abs(n - 0.5)) * zone;
}
`

export function patchMaterial<T extends THREE.MeshStandardMaterial>(mat: T, rim = 0.35, rimColor = '#8fa6c8', opts: PatchOpts = {}): T {
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
  mat.userData.sdOpts = opts
  const rock = opts.rock ? 1 : 0
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSDWorld;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvSDWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE_GLSL}\n${rock ? ROCK_GLSL + PERTURB_GLSL : ''}`)
      .replace(
        '#include <map_fragment>',
        rock
          ? /* glsl */ `
        vec3 rkP = vSDWorld;
        float rkN1 = sdNoise(rkP * 0.7);
        float rkN2 = sdNoise(rkP * 3.3);
        float rkL = rkLayer(rkP.y + rkN1 * 1.5);
        vec3 rkAlb = mix(vec3(0.075, 0.055, 0.05), vec3(0.2, 0.15, 0.125), rkL * 0.7 + rkN1 * 0.3);
        rkAlb *= 0.8 + 0.4 * rkN2;
        float rkC = rkCrack(rkP);
        rkAlb *= 1.0 - 0.55 * rkC;
        diffuseColor.rgb *= rkAlb * 4.0;`
          : '#include <map_fragment>',
      )
      .replace(
        '#include <normal_fragment_maps>',
        rock
          ? /* glsl */ `#include <normal_fragment_maps>
        float rkH = rkHeight(vSDWorld);
        normal = sdPerturb(-vViewPosition, normal, vec2(dFdx(rkH), dFdy(rkH)) * 3.0, faceDirection);
        // ash settles on whatever faces the sky
        vec3 rkWN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
        float rkUp = smoothstep(0.45, 0.85, rkWN.y) * (0.6 + 0.4 * sdNoise(vSDWorld * 0.8));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3, 0.255, 0.225), rkUp * 0.75);`
          : '#include <normal_fragment_maps>',
      )
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
        #if ${rock}
          // the cracks still glow where the rock meets the burning plain
          totalEmissiveRadiance += vec3(1.0, 0.24, 0.04) * rkC * smoothstep(7.0, 0.5, vSDWorld.y) * 1.2;
        #endif
        if (uCut > 0.0 && !gl_FrontFacing) {
          float cn = sdNoise(vSDWorld * 1.7) * 0.6 + sdNoise(vSDWorld * 6.0) * 0.4;
          totalEmissiveRadiance += uCutColor * uCut * (2.0 + cn * 6.0);
          diffuseColor.rgb *= 0.1;
        }`,
      )
  }
  mat.customProgramCacheKey = () => `sd-v3-${rock}`
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
  rock?: boolean
  /** Physical extras (any of them makes it a MeshPhysicalMaterial). */
  clearcoat?: number
  clearcoatRoughness?: number
  sheen?: number
  sheenColor?: THREE.ColorRepresentation
  sheenRoughness?: number
  envMapIntensity?: number
}

export function standard(p: MatParams) {
  const physical = p.clearcoat !== undefined || p.sheen !== undefined
  const m = new (physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial)({
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
  if (p.envMapIntensity !== undefined) m.envMapIntensity = p.envMapIntensity
  if (m instanceof THREE.MeshPhysicalMaterial) {
    m.clearcoat = p.clearcoat ?? 0
    m.clearcoatRoughness = p.clearcoatRoughness ?? 0.1
    m.sheen = p.sheen ?? 0
    if (p.sheenColor !== undefined) m.sheenColor.set(p.sheenColor)
    m.sheenRoughness = p.sheenRoughness ?? 0.5
  }
  return patchMaterial(m, p.rim ?? 0.3, p.rimColor, { rock: p.rock })
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
  const c = patchMaterial(m, u.uRimStrength.value, '#' + u.uRimColor.value.getHexString(), saved.sdOpts as PatchOpts | undefined)
  const cu = sdUniforms(c)!
  cu.uRimColor.value.copy(u.uRimColor.value)
  cu.uFlash.value = u.uFlash.value
  return c
}
