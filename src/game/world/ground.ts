import * as THREE from 'three'
import { NOISE_GLSL } from '../../engine/gfx/noise'
import { PERTURB_GLSL } from '../../engine/gfx/triplanar'
import type { Quality } from '../../state/settings'
import { SCORCH_HALF, type ScorchMap } from './scorch'
import type { Terrain } from './terrain'

/** Vertex displacement by the terrain heightfield (geometry lies in XZ, so object space is world space). */
const TERRAIN_VERT = /* glsl */ `
uniform sampler2D uHeight;
uniform float uScorchHalf;
uniform float uTexel;
float tSample(vec2 uv) { return textureLod(uHeight, uv, 0.0).r; }
`

/**
 * The scorched plain: basalt and ash with a network of ember-lit cracks, plus
 * the battle's burns and glowing fissures from the scorch map. The field is
 * displaced by the terrain heightfield; steep crater walls turn to fractured,
 * stratified rock and deep wounds bleed lava.
 */
export function groundMaterial(scorch: ScorchMap, terrain: Terrain, quality: Quality) {
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, metalness: 0 })
  const uniforms = {
    uBurn: { value: scorch.burnTex },
    uGlow: { value: scorch.glowTex },
    uScorchHalf: { value: SCORCH_HALF },
    uEmber: { value: 1 },
    uTime: { value: 0 },
    uHeight: { value: terrain.tex },
    uTexel: { value: 1 / terrain.res },
  }
  const detail = quality === 'low' ? 0 : 1
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vGPos;\n${TERRAIN_VERT}`)
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `
        vec2 tUv = position.xz / (2.0 * uScorchHalf) + 0.5;
        float tE = uTexel * 2.0;
        vec3 objectNormal = normalize(vec3(
          tSample(tUv - vec2(tE, 0.0)) - tSample(tUv + vec2(tE, 0.0)),
          4.0 * tE * uScorchHalf,
          tSample(tUv - vec2(0.0, tE)) - tSample(tUv + vec2(0.0, tE))));
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
        #endif`,
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position);\ntransformed.y += tSample(tUv);')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vGPos;
        uniform sampler2D uBurn;
        uniform sampler2D uGlow;
        uniform sampler2D uHeight;
        uniform float uScorchHalf;
        uniform float uTexel;
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
        }
        // exposed rock on a wall (p = along-wall, height): warped bedded layers split by vertical joints
        float gRock(vec2 p, out float crk) {
          float y = p.y + gFbm(vec2(p.x * 0.05, p.y * 0.1)) * 3.0;
          float ly = y * 0.75;
          float layer = floor(ly);
          float fy = fract(ly);
          float shade = gHash11(layer * 7.13 + 1.7);
          float x = p.x * (0.22 + shade * 0.25) + gHash11(layer + 3.1) * 10.0 + gNoise(vec2(p.x * 0.12, layer)) * 1.6 + gNoise(vec2(p.x * 0.3, y)) * 0.6;
          float fx = fract(x);
          float bed = smoothstep(0.07, 0.0, min(fy, 1.0 - fy)) * (0.3 + 0.7 * gNoise(vec2(p.x * 0.2, layer)));
          float joint = smoothstep(0.05, 0.0, min(fx, 1.0 - fx)) * step(0.45, gHash11(floor(x) + layer * 13.0));
          crk = max(bed, joint);
          return clamp(shade * 0.55 + gNoise(p * vec2(0.6, 2.5)) * 0.3 + fy * 0.15, 0.0, 1.0);
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
        // the carved terrain: per-pixel normal from the heightfield (sharper than the vertex grid)
        vec3 tN = normalize(vec3(
          texture2D(uHeight, suv - vec2(uTexel, 0.0)).r - texture2D(uHeight, suv + vec2(uTexel, 0.0)).r,
          4.0 * uTexel * uScorchHalf,
          texture2D(uHeight, suv - vec2(0.0, uTexel)).r - texture2D(uHeight, suv + vec2(0.0, uTexel)).r));
        float cliff = smoothstep(0.1, 0.36, 1.0 - tN.y);
        float carved = clamp(-vGPos.y, 0.0, 14.0);
        // rims and ejecta: pale crushed rock and ash
        alb = mix(alb, ashCol * 1.3, smoothstep(0.1, 1.2, vGPos.y) * 0.55);
        alb *= 1.0 - burn * 0.82;
        // deep bowls sit in their own shadow
        alb *= 1.0 - 0.35 * smoothstep(0.5, 12.0, carved);
        float rockCrack = 0.0;
        // walls are seen edge-on: fade their fine fractures by the true pixel footprint (derivatives outside the branch)
        float rlod = clamp(length(fwidth(vGPos)) * 1.4 - 0.15, 0.0, 1.0);
        if (cliff > 0.001) {
          float wx = tN.x * tN.x / (tN.x * tN.x + tN.z * tN.z + 1e-5);
          float c1;
          float c2;
          float r1 = gRock(vec2(gp.y, vGPos.y), c1);
          float r2 = gRock(vec2(gp.x, vGPos.y), c2);
          float rk = mix(r2, r1, wx);
          rockCrack = mix(c2, c1, wx) * (1.0 - rlod);
          rk = mix(rk, 0.45, rlod * 0.6);
          vec3 rock = mix(vec3(0.028, 0.02, 0.018), vec3(0.12, 0.085, 0.07), rk);
          rock *= (1.0 - rockCrack * 0.85) * (1.0 - burn * 0.3);
          alb = mix(alb, rock, cliff);
          gh = mix(gh, rk * 0.6 - rockCrack * 0.7, cliff);
        }
        diffuseColor.rgb *= alb;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `normal = normalize((viewMatrix * vec4(tN, 0.0)).xyz);
        normal = sdPerturb(-vViewPosition, normal, vec2(dFdx(gh), dFdy(gh)) * 2.2, faceDirection);`,
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
        totalEmissiveRadiance += mix(vec3(0.9, 0.12, 0.02), vec3(2.2, 0.9, 0.25), hot) * heat * (0.6 + hn * 0.9);
        // fresh walls split open along their fractures
        totalEmissiveRadiance += vec3(2.2, 0.6, 0.12) * rockCrack * cliff * heat * heat * 2.4;
        // the floors of the deepest wounds pool lava along their cracks
        float wound = smoothstep(6.0, 13.0, carved) * smoothstep(0.45, 0.75, gNoise(gp * 0.06 + 7.0)) * (1.0 - cliff);
        totalEmissiveRadiance += vec3(1.0, 0.22, 0.03) * crack * wound * 0.35 * pulse * uEmber;`,
      )
  }
  mat.customProgramCacheKey = () => `ground-v2-${detail}`
  mat.userData.ground = uniforms
  return mat
}

/** Shadow caster with the same displacement, sunk a little so the flat plain never self-shadows. */
function groundDepthMaterial(uniforms: Record<string, THREE.IUniform>) {
  const m = new THREE.MeshDepthMaterial()
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uHeight = uniforms.uHeight
    shader.uniforms.uScorchHalf = uniforms.uScorchHalf
    shader.uniforms.uTexel = uniforms.uTexel
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${TERRAIN_VERT}`)
      .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position);\ntransformed.y += tSample(position.xz / (2.0 * uScorchHalf) + 0.5) - 0.12;')
  }
  m.customProgramCacheKey = () => 'ground-depth-v1'
  return m
}

/**
 * The battlefield floor: a dense displaced grid over the terrain field and a
 * flat outer plain (with a matching square hole) out to the horizon.
 */
export function buildGround(scorch: ScorchMap, terrain: Terrain, quality: Quality) {
  const mat = groundMaterial(scorch, terrain, quality)
  const root = new THREE.Group()
  const H = terrain.half
  const seg = quality === 'high' ? 256 : quality === 'medium' ? 192 : 128
  const field = new THREE.Mesh(new THREE.PlaneGeometry(H * 2, H * 2, seg, seg).rotateX(-Math.PI / 2), mat)
  field.receiveShadow = true
  field.castShadow = true
  field.customDepthMaterial = groundDepthMaterial(mat.userData.ground)
  field.renderOrder = -1
  // the outer plain tucks just under the field's flat border, so there is never a seam
  const S = 3000
  const h = H - 0.75
  const shape = new THREE.Shape().moveTo(-S, -S).lineTo(S, -S).lineTo(S, S).lineTo(-S, S).closePath()
  shape.holes.push(new THREE.Path().moveTo(-h, -h).lineTo(-h, h).lineTo(h, h).lineTo(h, -h).closePath())
  const outer = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, -0.03, 0), mat)
  outer.receiveShadow = true
  outer.renderOrder = -1
  root.add(outer, field)
  return root
}
