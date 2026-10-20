import * as THREE from 'three'

export const PERTURB_GLSL = /* glsl */ `
vec3 sdPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
  vec3 vSigmaX = normalize(dFdx(surf_pos.xyz));
  vec3 vSigmaY = normalize(dFdy(surf_pos.xyz));
  vec3 R1 = cross(vSigmaY, surf_norm);
  vec3 R2 = cross(surf_norm, vSigmaX);
  float fDet = dot(vSigmaX, R1) * faceDir;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}
`

export interface TriplanarOpts {
  tex: THREE.Texture
  scale: number
  tint?: THREE.ColorRepresentation
  roughness?: number
  bump?: number
  moss?: number
  metalness?: number
  /** Darken + dampen toward the ground. */
  grime?: number
}

/**
 * World-space triplanar texturing with derivative bump mapping, so procedural
 * architecture needs no UVs and keeps a constant texel density.
 */
export function triplanarMaterial(o: TriplanarOpts) {
  const mat = new THREE.MeshStandardMaterial({
    color: o.tint ?? '#ffffff',
    roughness: o.roughness ?? 0.92,
    metalness: o.metalness ?? 0,
  })
  const uniforms = {
    uTriTex: { value: o.tex },
    uTriScale: { value: o.scale },
    uBump: { value: o.bump ?? 2.2 },
    uMoss: { value: o.moss ?? 0.6 },
    uGrime: { value: o.grime ?? 1 },
  }
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTPos;\nvarying vec3 vTNorm;')
      .replace(
        '#include <project_vertex>',
        /* glsl */ `#include <project_vertex>
        vec4 tpw = vec4(transformed, 1.0);
        vec3 tnw = objectNormal;
        #ifdef USE_INSTANCING
          tpw = instanceMatrix * tpw;
          tnw = mat3(instanceMatrix) * tnw;
        #endif
        vTPos = (modelMatrix * tpw).xyz;
        vTNorm = normalize(mat3(modelMatrix) * tnw);`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vTPos;
        varying vec3 vTNorm;
        uniform sampler2D uTriTex;
        uniform float uTriScale;
        uniform float uBump;
        uniform float uMoss;
        uniform float uGrime;
        ${PERTURB_GLSL}
        vec4 triSample(vec3 p, vec3 n) {
          vec3 w = pow(abs(n), vec3(4.0));
          w /= (w.x + w.y + w.z);
          vec4 a = texture2D(uTriTex, p.zy * uTriScale);
          vec4 b = texture2D(uTriTex, p.xz * uTriScale + 0.37);
          vec4 c = texture2D(uTriTex, p.xy * uTriScale + 0.71);
          return a * w.x + b * w.y + c * w.z;
        }`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        vec4 triS = triSample(vTPos, vTNorm);
        float triH = triS.a;
        vec3 triAlb = triS.rgb;
        float tGround = 1.0 - smoothstep(0.0, 1.6, vTPos.y);
        float tUp = smoothstep(0.55, 0.95, vTNorm.y);
        float tN = texture2D(uTriTex, vTPos.xz * 0.05 + vTPos.y * 0.03).a;
        float tMoss = clamp((tGround * 0.9 + tUp * 0.6) * uMoss * (0.4 + 1.2 * (1.0 - triH)) * (0.5 + tN), 0.0, 1.0);
        triAlb = mix(triAlb, vec3(0.13, 0.15, 0.07), tMoss * 0.8);
        triAlb *= mix(1.0, 0.5, tGround * 0.7 * uGrime);
        // vertical rain streaks
        triAlb *= 0.88 + 0.12 * texture2D(uTriTex, vec2(vTPos.x * 0.7 + vTPos.z * 0.7, vTPos.y * 0.04)).r;
        diffuseColor.rgb *= triAlb;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `float roughnessFactor = clamp(roughness * (0.82 + 0.25 * (1.0 - triH)) + tMoss * 0.1, 0.0, 1.0);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `normal = sdPerturb(-vViewPosition, normal, vec2(dFdx(triH), dFdy(triH)) * uBump, faceDirection);`,
      )
  }
  mat.customProgramCacheKey = () => 'triplanar-v1'
  mat.userData.tri = uniforms
  return mat
}
