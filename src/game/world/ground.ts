import * as THREE from 'three'
import { NOISE_GLSL } from '../../engine/gfx/noise'
import { PERTURB_GLSL } from '../../engine/gfx/triplanar'
import type { Quality } from '../../state/settings'
import { MAX_CUTS, MAX_SLICES, NO_CEIL, SLICE_SPEED, type FarField } from './farField'
import { SCORCH_HALF, type ScorchMap } from './scorch'
import type { Terrain } from './terrain'

/** Shared by the vertex and fragment stages: height sampling and the mountains' fine relief. */
const HEIGHT_GLSL = /* glsl */ `
uniform sampler2D uHeight;
uniform sampler2D uFar;
uniform float uScorchHalf;
uniform float uTexel;
uniform float uFarHalf;
uniform float uFarTexel;
uniform vec4 uSliceA[${MAX_SLICES}];
uniform vec4 uSliceB[${MAX_SLICES}];
uniform sampler2D uCeil;
float tSample(vec2 uv) { return textureLod(uHeight, uv, 0.0).r; }
float fSample(vec2 p) { return textureLod(uFar, p / (2.0 * uFarHalf) + 0.5, 0.0).r; }
float mHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float mNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mHash(i), mHash(i + vec2(1, 0)), u.x), mix(mHash(i + vec2(0, 1)), mHash(i + vec2(1, 1)), u.x), u.y);
}
// sharp ridged relief that only grows on raised ground (the plain and canyon floors stay clean)
float mDetail(vec2 p, float h, int oct) {
  float amp = smoothstep(12.0, 160.0, h) * 46.0;
  if (amp <= 0.0) return 0.0;
  float s = 0.0;
  float a = 1.0;
  float f = 1.0 / 210.0;
  for (int i = 0; i < 4; i++) {
    if (i >= oct) break;
    float n = 1.0 - abs(mNoise(p * f) * 2.0 - 1.0);
    s += n * n * a;
    a *= 0.48;
    f *= 2.21;
  }
  return (s - 0.55) * amp;
}
float farH(vec2 p, int oct) { float h = fSample(p); return h + mDetail(p, h, oct); }
// the Horizon Cut: the height it flattened the ground to over p (far above everything where it never cut)
float sliceTop(vec2 p) { return textureLod(uCeil, p / (2.0 * uFarHalf) + 0.5, 0.0).r; }
float farHC(vec2 p, int oct) { return min(farH(p, oct), sliceTop(p)); }
`

/**
 * The battlefield floor and the mountains around it, one material in three
 * modes: NEAR displaces the dense arena grid by the carved field (which
 * already includes the far field under it), FAR displaces the coarse grid that
 * runs out to the horizon by the far field plus procedural ridges (flattened
 * under the Horizon Cut's slices), CAP draws a peak the Horizon Cut took off:
 * the old surface above the slice plane and a flat molten underside, carried
 * by the mesh's own transform while its texture stays glued to the rock. All share
 * the shading: basalt and ash with ember-lit cracks, stratified rock on steep
 * ground, battle scars, and molten rock rendered as procedural crust and
 * cracks so it stays crisp up close no matter how coarse the heat mask is.
 */
export function groundMaterial(scorch: ScorchMap, terrain: Terrain, far: FarField, quality: Quality, mode: 'near' | 'far' | 'cap', shared?: Record<string, THREE.IUniform>) {
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, metalness: 0 })
  const uniforms: Record<string, THREE.IUniform> = shared ?? {
    uBurn: { value: scorch.burnTex },
    uGlow: { value: scorch.glowTex },
    uScorchHalf: { value: SCORCH_HALF },
    uEmber: { value: 1 },
    uTime: { value: 0 },
    uClock: { value: 0 },
    uHeight: { value: terrain.tex },
    uTexel: { value: 1 / terrain.res },
    uFar: { value: far.tex },
    uFarHalf: { value: far.half },
    uFarTexel: { value: 1 / far.res },
    uCutA: { value: far.cutA },
    uCutB: { value: far.cutB },
    uSliceA: { value: far.sliceA },
    uSliceB: { value: far.sliceB },
    uCeil: { value: far.ceilTex },
    uAerial: { value: 0.00052 },
  }
  const detail = quality === 'low' ? 0 : 1
  const isFar = mode === 'far' ? 1 : 0
  const isCap = mode === 'cap' ? 1 : 0
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vGPos;\n${HEIGHT_GLSL}\n#if ${isCap}\nattribute float aLayer;\nattribute float aIn;\nuniform float uCapY;\nvarying float vLayer;\nvarying float vBelow;\nvarying float vIn;\n#endif`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `
        #if ${isCap}
          float fE = 2.0 * uFarHalf * uFarTexel;
          vec3 objectNormal = aLayer > 0.5 ? vec3(0.0, -1.0, 0.0) : normalize(vec3(
            farH(position.xz - vec2(fE, 0.0), 2) - farH(position.xz + vec2(fE, 0.0), 2),
            2.0 * fE,
            farH(position.xz - vec2(0.0, fE), 2) - farH(position.xz + vec2(0.0, fE), 2)));
        #elif ${isFar}
          float fE = 2.0 * uFarHalf * uFarTexel;
          vec3 objectNormal = normalize(vec3(
            farHC(position.xz - vec2(fE, 0.0), 2) - farHC(position.xz + vec2(fE, 0.0), 2),
            2.0 * fE,
            farHC(position.xz - vec2(0.0, fE), 2) - farHC(position.xz + vec2(0.0, fE), 2)));
        #else
          vec2 tUv = position.xz / (2.0 * uScorchHalf) + 0.5;
          float tE = uTexel * 2.0;
          vec3 objectNormal = normalize(vec3(
            tSample(tUv - vec2(tE, 0.0)) - tSample(tUv + vec2(tE, 0.0)),
            4.0 * tE * uScorchHalf,
            tSample(tUv - vec2(0.0, tE)) - tSample(tUv + vec2(0.0, tE))));
        #endif
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
        #endif`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `vec3 transformed = vec3(position);
        #if ${isCap}
          float fh = farH(position.xz, 2);
          vLayer = aLayer;
          vIn = aIn;
          vBelow = uCapY - fh;
          transformed.y = aLayer > 0.5 ? uCapY : max(fh, uCapY);
        #elif ${isFar}
          transformed.y += farHC(position.xz, 2);
        #else
          transformed.y += tSample(tUv);
        #endif`,
      )
      .replace(
        '#include <project_vertex>',
        // a cap is shaded where the rock stood, wherever its transform has carried it
        `#include <project_vertex>\nvGPos = ${isCap ? 'transformed' : '(modelMatrix * vec4(transformed, 1.0)).xyz'};`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vGPos;
        ${HEIGHT_GLSL}
        uniform sampler2D uBurn;
        uniform sampler2D uGlow;
        uniform float uEmber;
        uniform float uTime;
        uniform float uClock;
        uniform float uAerial;
        uniform vec4 uCutA[${MAX_CUTS}];
        uniform vec4 uCutB[${MAX_CUTS}];
        #if ${isCap}
        uniform float uCapY;
        uniform float uCapT0;
        uniform mat3 uCapRot;
        varying float vLayer;
        varying float vBelow;
        varying float vIn;
        #endif
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
        }
        // Molten rock for a heat k (0 cold .. 1+ liquid) at p (metres): a dark crust
        // broken into irregular plates whose seams glow (some open, some nearly
        // shut), finer cracks splitting the plates as it heats, the plates
        // themselves going liquid at the top end. Far away the pattern melts
        // into its average glow instead of shimmering.
        vec3 molten(vec2 p, float k) {
          vec2 q = p * 0.55;
          q += vec2(gNoise(q * 0.45 + uTime * 0.03), gNoise(q * 0.45 + 5.3 - uTime * 0.025)) * 1.3;
          float lod = clamp(length(fwidth(q)) * 2.2 - 0.25, 0.0, 1.0);
          vec3 v = gVoronoi(q);
          float open = gNoise(q * 0.8 + v.z * 13.0);
          float w = mix(0.012, 0.2, clamp(k * k, 0.0, 1.0)) * (0.25 + open * 1.1);
          float seam = smoothstep(w, w * 0.1, v.y - v.x);
          vec3 v2 = gVoronoi(q * 3.3 + 11.0);
          float fine = smoothstep(w * 0.45, 0.0, v2.y - v2.x) * smoothstep(0.5, 0.95, k);
          float liquid = smoothstep(0.95, 1.35, k) * (0.4 + 0.6 * gNoise(q * 1.9 + uTime * 0.3));
          float g = clamp(max(seam, fine * 0.6) + liquid, 0.0, 1.4);
          g = mix(g, 0.12 + 0.3 * k, lod);
          float t = k * (0.6 + 0.4 * fract(v.z * 7.13)) * (0.55 + 0.55 * g);
          vec3 c = mix(vec3(0.45, 0.03, 0.006), vec3(1.9, 0.46, 0.06), smoothstep(0.08, 0.6, t));
          c = mix(c, vec3(3.2, 1.9, 0.75), smoothstep(0.8, 1.35, t));
          return c * g * smoothstep(0.02, 0.12, k);
        }
        // glow left in the walls and floors of the sword's canyons
        float cutHeat(vec3 P, out float depthK) {
          float heat = 0.0;
          depthK = 0.0;
          for (int i = 0; i < ${MAX_CUTS}; i++) {
            vec4 B = uCutB[i];
            if (B.w < 0.5) continue;
            vec4 A = uCutA[i];
            vec2 ab = A.zw - A.xy;
            float L2 = max(dot(ab, ab), 1.0);
            float t = clamp(dot(P.xz - A.xy, ab) / L2, 0.0, 1.0);
            float d = length(P.xz - (A.xy + ab * t));
            float inside = smoothstep(B.x * 1.35, B.x * 0.85, d);
            if (inside <= 0.0) continue;
            float age = max(0.0, uClock - B.y);
            // the floor stays hot for a long time; the walls flash and cool within seconds
            float lowK = exp(-max(0.0, P.y + B.z) / 22.0);
            float h = inside * (exp(-age / 60.0) * (0.1 + 0.95 * lowK) + exp(-age / 2.5) * 0.45);
            depthK = max(depthK, inside * smoothstep(-2.0, -25.0, P.y));
            heat = max(heat, h);
          }
          return heat;
        }
        // the Horizon Cut's line racing across every slope the plane passes through, and the flat stumps it leaves
        float sliceHeat(vec3 P) {
          float heat = 0.0;
          float w = max(4.0, fwidth(P.y) * 2.0);
          for (int i = 0; i < ${MAX_SLICES}; i++) {
            vec4 B = uSliceB[i];
            if (B.y < 0.5) continue;
            vec4 A = uSliceA[i];
            float age = max(0.0, uClock - B.x);
            vec2 rel = P.xz - A.xy;
            float d = length(rel);
            // only the arc it swept, and only on the ground it actually cut
            float off = abs(mod(atan(rel.x, rel.y) - B.z + 3.14159265, 6.2831853) - 3.14159265);
            if (off > B.w || sliceTop(P.xz) > ${(NO_CEIL / 2).toFixed(1)}) continue;
            float reach = min(A.z, age * ${SLICE_SPEED.toFixed(1)});
            if (d > reach) continue;
            float band = exp(-abs(P.y - A.w) / w);
            float front = 1.0 + 2.0 * exp(-(reach - d) / 150.0) * step(reach, A.z - 1.0);
            heat = max(heat, band * (exp(-age / 45.0) * 1.0 + exp(-age / 2.0) * 0.7) * front);
          }
          return heat;
        }`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        #if ${isCap}
          // only this piece's own ground, and only above the cut: where the surface dips below the plane it is open air
          if (vIn < 0.5 || vBelow > 0.0) discard;
        #endif
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
        // battle scars (only on the arena field)
        vec2 suv = gp / (uScorchHalf * 2.0) + 0.5;
        float inside = step(0.0, suv.x) * step(suv.x, 1.0) * step(0.0, suv.y) * step(suv.y, 1.0);
        // the heat mask is coarse: wobble the lookup so its edges follow the rock, not the texels
        vec2 wob = (vec2(gNoise(gp * 0.9), gNoise(gp * 0.9 + 4.1)) - 0.5) * uTexel * 1.6;
        float burn = texture2D(uBurn, suv + wob).a * inside;
        float heat = texture2D(uGlow, suv + wob).r * inside;
        #if ${isCap}
          float pE = 3.0;
          vec3 tN = vLayer > 0.5 ? vec3(0.0, 1.0, 0.0) : normalize(vec3(farH(gp - vec2(pE, 0.0), 4) - farH(gp + vec2(pE, 0.0), 4), 2.0 * pE, farH(gp - vec2(0.0, pE), 4) - farH(gp + vec2(0.0, pE), 4)));
        #elif ${isFar}
          float pE = 3.0;
          vec3 tN = normalize(vec3(farHC(gp - vec2(pE, 0.0), 4) - farHC(gp + vec2(pE, 0.0), 4), 2.0 * pE, farHC(gp - vec2(0.0, pE), 4) - farHC(gp + vec2(0.0, pE), 4)));
        #else
          vec3 tN = normalize(vec3(
            texture2D(uHeight, suv - vec2(uTexel, 0.0)).r - texture2D(uHeight, suv + vec2(uTexel, 0.0)).r,
            4.0 * uTexel * uScorchHalf,
            texture2D(uHeight, suv - vec2(0.0, uTexel)).r - texture2D(uHeight, suv + vec2(0.0, uTexel)).r));
        #endif
        float cliff = smoothstep(0.1, 0.36, 1.0 - tN.y);
        float carved = clamp(-vGPos.y, 0.0, 60.0);
        float cutDeep;
        float cutK = max(cutHeat(vGPos, cutDeep), sliceHeat(vGPos));
        // rims and ejecta: pale crushed rock and ash
        alb = mix(alb, ashCol * 1.3, smoothstep(0.1, 1.2, vGPos.y) * 0.55 * (1.0 - smoothstep(6.0, 30.0, vGPos.y)));
        alb *= 1.0 - burn * 0.82;
        // deep wounds sit in their own shadow
        alb *= 1.0 - 0.35 * smoothstep(0.5, 12.0, carved);
        float rockCrack = 0.0;
        float rlod = clamp(length(fwidth(vGPos)) * 1.4 - 0.15, 0.0, 1.0);
        // the mountains: dark stratified basalt on the steeps, ash lying on the gentler slopes
        float mtn = smoothstep(6.0, 45.0, vGPos.y);
        if (mtn > 0.001) {
          float mc;
          float rk = gRock(vec2(gp.x * 0.35 + gp.y * 0.35, vGPos.y * 0.35), mc);
          vec3 rock = mix(vec3(0.03, 0.022, 0.022), vec3(0.11, 0.075, 0.062), rk) * (1.0 - mc * 0.6 * (1.0 - rlod));
          float lying = smoothstep(0.62, 0.86, tN.y);
          vec3 drift = vec3(0.19, 0.16, 0.145) * (0.75 + 0.5 * gNoise(gp * 0.05));
          vec3 m = mix(rock, drift, lying * (0.55 + 0.45 * smoothstep(80.0, 500.0, vGPos.y)));
          alb = mix(alb, m, mtn);
          gh = mix(gh, rk * 0.5, mtn * (1.0 - lying));
        }
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
        // freshly cut faces are scorched black
        alb *= 1.0 - 0.6 * smoothstep(0.05, 0.5, cutK);
        #if ${isCap}
          // where a ridge broke apart the piece shows its inside: dark rock, still hot
          if (!gl_FrontFacing) alb = vec3(0.025, 0.017, 0.015);
        #endif
        diffuseColor.rgb *= alb;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        #if ${isCap}
          // lit as it tumbles: the rock's normal turns with the cap (the inside of a broken edge faces the other way)
          normal = normalize((viewMatrix * vec4(uCapRot * (vLayer > 0.5 ? vec3(0.0, -1.0, 0.0) : tN), 0.0)).xyz) * (gl_FrontFacing ? 1.0 : -1.0);
        #else
          normal = normalize((viewMatrix * vec4(tN, 0.0)).xyz);
        #endif
        normal = sdPerturb(-vViewPosition, normal, vec2(dFdx(gh), dFdy(gh)) * 2.2, faceDirection);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        float pulse = 0.7 + 0.3 * sin(uTime * 1.3 + cv.z * 30.0);
        vec3 bv = cv;
        float jag = (gNoise(gp * 3.0) - 0.5) * 0.01;
        float lava = smoothstep(0.006, 0.0, bv.y - bv.x + jag) * step(0.82, bv.z) * smoothstep(0.55, 0.8, gNoise(gp * 0.05 + 4.0)) * (1.0 - mtn);
        totalEmissiveRadiance += vec3(1.0, 0.2, 0.03) * lava * 0.3 * pulse * uEmber;
        // molten scars: the coarse heat mask drives crisp procedural crust and cracks
        float mk = max(heat * 1.15, cutK);
        if (mk > 0.015) {
          vec2 mp = mix(gp, vec2(gp.x + gp.y, vGPos.y * 1.3), max(cliff, step(0.01, cutK) * (1.0 - tN.y)));
          vec3 lavaC = molten(mp, mk);
          totalEmissiveRadiance += lavaC * (1.0 + rockCrack * cliff * 1.5);
          // a dull red underglow so the crust between the seams still reads as hot
          totalEmissiveRadiance += vec3(0.35, 0.03, 0.005) * smoothstep(0.05, 0.6, mk) * mk;
        }
        // the floors of the deepest wounds pool lava along their cracks
        float wound = max(smoothstep(6.0, 13.0, carved), cutDeep) * smoothstep(0.45, 0.75, gNoise(gp * 0.06 + 7.0)) * (1.0 - cliff);
        totalEmissiveRadiance += vec3(1.0, 0.22, 0.03) * crack * wound * 0.45 * pulse * uEmber;
        #if ${isCap}
          // the cap's underside is the cut itself: molten, cooling as it falls
          if (vLayer > 0.5 || !gl_FrontFacing) {
            float ck = (vLayer > 0.5 ? 0.12 : 0.06) + 0.6 * exp(-max(0.0, uClock - uCapT0) / 10.0);
            totalEmissiveRadiance += molten(vLayer > 0.5 ? gp : vec2(gp.x + gp.y, vGPos.y * 1.3), ck) * 1.3 + vec3(0.4, 0.04, 0.006) * ck;
          }
        #endif`,
      )
      .replace(
        '#include <fog_fragment>',
        /* glsl */ `#ifdef USE_FOG
        // aerial perspective: gentler than the scene fog so the ranges read as layered silhouettes,
        // and thinner up high so the peaks stand out of the haze
        float fogFactor = 1.0 - exp(-vFogDepth * uAerial);
        fogFactor *= mix(1.0, 0.55, smoothstep(40.0, 700.0, vGPos.y));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
        #endif`,
      )
  }
  mat.customProgramCacheKey = () => `ground-v3-${detail}-${mode}`
  mat.userData.ground = uniforms
  return mat
}

/** Shadow caster with the same displacement, sunk a little so the flat plain never self-shadows. */
function groundDepthMaterial(uniforms: Record<string, THREE.IUniform>) {
  const m = new THREE.MeshDepthMaterial()
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${HEIGHT_GLSL}`)
      .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position);\ntransformed.y += tSample(position.xz / (2.0 * uScorchHalf) + 0.5) - 0.12;')
  }
  m.customProgramCacheKey = () => 'ground-depth-v2'
  return m
}

/**
 * Grid coordinates along one axis: evenly spaced across the arena square
 * (+/- inner), then geometrically wider out to +/- outer, so detail is spent
 * near the player and the mountains still get a few hundred rows.
 */
export function axisPoints(inner: number, innerStep: number, outer: number, n: number) {
  const k = Math.max(1, Math.round(inner / innerStep))
  const s0 = inner / k
  // solve s0 * (r^n - 1) / (r - 1) = outer - inner for the growth ratio
  const span = outer - inner
  let lo = 1.000001
  let hi = 2
  for (let i = 0; i < 60; i++) {
    const r = (lo + hi) / 2
    if ((s0 * (Math.pow(r, n) - 1)) / (r - 1) > span) hi = r
    else lo = r
  }
  const r = (lo + hi) / 2
  const out: number[] = []
  for (let i = -k; i <= k; i++) out.push((i * inner) / k)
  let p = inner
  let s = s0
  for (let i = 0; i < n; i++) {
    p += s
    s *= r
    out.push(Math.min(p, outer), -Math.min(p, outer))
  }
  return out.sort((a, b) => a - b)
}

/** A grid over +/- outer on x and z, with the arena square (+/- inner) left out: the arena has its own dense mesh. */
export function farGrid(inner: number, innerStep: number, outer: number, n: number) {
  const ax = axisPoints(inner, innerStep, outer, n)
  const m = ax.length
  const pos = new Float32Array(m * m * 3)
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const k = (j * m + i) * 3
      pos[k] = ax[i]
      pos[k + 2] = ax[j]
    }
  }
  const idx: number[] = []
  const e = 1e-3
  for (let j = 0; j < m - 1; j++) {
    for (let i = 0; i < m - 1; i++) {
      const inX = ax[i] >= -inner - e && ax[i + 1] <= inner + e
      const inZ = ax[j] >= -inner - e && ax[j + 1] <= inner + e
      if (inX && inZ) continue
      const a = j * m + i
      const b = a + 1
      const c = a + m
      const d = c + 1
      idx.push(a, c, b, b, c, d)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(m * m * 3).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3))
  g.setIndex(idx)
  return g
}

/**
 * The world's floor: a dense displaced grid over the arena field and a coarse
 * one over the far field (mountains included) out to the horizon, meeting
 * seamlessly because both sample the same combined heights at the seam.
 */
export function buildGround(scorch: ScorchMap, terrain: Terrain, far: FarField, quality: Quality) {
  const near = groundMaterial(scorch, terrain, far, quality, 'near')
  const farMat = groundMaterial(scorch, terrain, far, quality, 'far', near.userData.ground)
  const root = new THREE.Group()
  const H = terrain.half
  const seg = quality === 'high' ? 256 : quality === 'medium' ? 192 : 128
  const field = new THREE.Mesh(new THREE.PlaneGeometry(H * 2, H * 2, seg, seg).rotateX(-Math.PI / 2), near)
  field.receiveShadow = true
  field.castShadow = true
  field.customDepthMaterial = groundDepthMaterial(near.userData.ground)
  field.renderOrder = -1
  const rings = quality === 'high' ? 170 : quality === 'medium' ? 130 : 90
  const step = quality === 'high' ? 6 : quality === 'medium' ? 8 : 12
  const outer = new THREE.Mesh(farGrid(H, step, far.half - far.cell, rings), farMat)
  outer.receiveShadow = true
  outer.frustumCulled = false
  outer.renderOrder = -1
  root.add(outer, field)
  root.userData.uniforms = near.userData.ground
  return root
}
