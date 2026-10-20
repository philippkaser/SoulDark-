import * as THREE from 'three'
import { NOISE_GLSL } from '../../engine/gfx/noise'
import { PERTURB_GLSL } from '../../engine/gfx/triplanar'
import type { Quality } from '../../state/settings'
import { SCORCH_HALF, type ScorchMap } from './scorch'

/**
 * The scorched plain: basalt and ash with a network of ember-lit cracks, plus
 * the battle's burns and glowing fissures from the scorch map.
 */
export function groundMaterial(scorch: ScorchMap, quality: Quality) {
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, metalness: 0 })
  const uniforms = {
    uBurn: { value: scorch.burnTex },
    uGlow: { value: scorch.glowTex },
    uScorchHalf: { value: SCORCH_HALF },
    uEmber: { value: 1 },
    uTime: { value: 0 },
  }
  const detail = quality === 'low' ? 0 : 1
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vGPos;
        uniform sampler2D uBurn;
        uniform sampler2D uGlow;
        uniform float uScorchHalf;
        uniform float uEmber;
        uniform float uTime;
        ${NOISE_GLSL}
        ${PERTURB_GLSL}
        vec2 gWarp(vec2 p) { return p + vec2(gFbm(p * 0.21 + 1.7), gFbm(p * 0.21 + 9.2)) * 2.4; }
        // fine crazing + large fissures, domain-warped so nothing looks tiled
        float gCrack(vec2 p, out vec3 big) {
          vec3 fine = gVoronoi(gWarp(p) * 0.55);
          big = gVoronoi(gWarp(p * 0.5) * 0.07);
          float f = smoothstep(0.045, 0.0, fine.y - fine.x) * smoothstep(0.35, 0.65, gNoise(p * 0.12 + fine.z));
          float b = smoothstep(0.05, 0.0, big.y - big.x);
          return max(f * 0.7, b);
        }
        float gHeight(vec2 p, float cr, float lod) {
          float h = gFbm(p * 0.08) * 0.6 + gFbm(p * 0.7) * 0.3 * (1.0 - lod) - cr * 0.4;
          #if ${detail}
          h += (gNoise(p * 4.0) * 0.08 + gNoise(p * 11.0) * 0.03) * (1.0 - lod);
          #endif
          return h;
        }`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        vec2 gp = vGPos.xz;
        // fade fine detail with distance so the far plain doesn't shimmer
        float lod = clamp(length(fwidth(gp)) * 1.5 - 0.15, 0.0, 1.0);
        vec3 cv;
        float crack = gCrack(gp, cv) * (1.0 - lod * 0.85);
        float gh = gHeight(gp, crack, lod);
        float ash = smoothstep(0.4, 0.8, gFbm(gp * 0.02 + 3.0));
        vec3 basalt = mix(vec3(0.028, 0.022, 0.024), vec3(0.065, 0.048, 0.045), gFbm(gp * 0.25));
        basalt *= 0.8 + 0.4 * mix(gNoise(gp * 1.7), 0.5, lod);
        vec3 ashCol = vec3(0.16, 0.135, 0.12) * (0.8 + gNoise(gp * 2.0) * 0.4);
        vec3 alb = mix(basalt, ashCol, ash * 0.7);
        alb *= 1.0 - crack * 0.6;
        // battle scars
        vec2 suv = gp / (uScorchHalf * 2.0) + 0.5;
        float inside = step(0.0, suv.x) * step(suv.x, 1.0) * step(0.0, suv.y) * step(suv.y, 1.0);
        float burn = texture2D(uBurn, suv).a * inside;
        float heat = texture2D(uGlow, suv).r * inside;
        alb *= 1.0 - burn * 0.82;
        diffuseColor.rgb *= alb;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `normal = sdPerturb(-vViewPosition, normal, vec2(dFdx(gh), dFdy(gh)) * 2.2, faceDirection);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        float pulse = 0.7 + 0.3 * sin(uTime * 1.3 + cv.z * 30.0);
        vec3 bv = cv;
        float jag = (gNoise(gp * 3.0) - 0.5) * 0.01;
        float lava = smoothstep(0.006, 0.0, bv.y - bv.x + jag) * step(0.82, bv.z) * smoothstep(0.55, 0.8, gNoise(gp * 0.05 + 4.0));
        totalEmissiveRadiance += vec3(1.0, 0.2, 0.03) * lava * 0.3 * pulse * uEmber;
        float hn = gNoise(gp * 1.5 - uTime * 0.3);
        float hot = heat * heat;
        totalEmissiveRadiance += mix(vec3(0.9, 0.12, 0.02), vec3(2.2, 0.9, 0.25), hot) * heat * (0.6 + hn * 0.9);`,
      )
  }
  mat.customProgramCacheKey = () => `ground-v1-${detail}`
  mat.userData.ground = uniforms
  return mat
}

export function buildGround(scorch: ScorchMap, quality: Quality) {
  const mat = groundMaterial(scorch, quality)
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000, 1, 1), mat)
  mesh.rotation.x = -Math.PI / 2
  mesh.receiveShadow = true
  mesh.renderOrder = -1
  return mesh
}
