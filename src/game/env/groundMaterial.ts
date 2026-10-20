import * as THREE from 'three'
import { ARENA, BONFIRE, GRAVEYARD, SHRINE } from '../../../shared/level'
import { PERTURB_GLSL } from '../gfx/triplanar'

const f = (n: number) => n.toFixed(3)

export const NOISE_GLSL = /* glsl */ `
float gHash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float gHash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float gNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash12(i), gHash12(i + vec2(1, 0)), u.x), mix(gHash12(i + vec2(0, 1)), gHash12(i + vec2(1, 1)), u.x), u.y);
}
float gFbm(vec2 p) {
  float v = 0.0; float a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * gNoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p; a *= 0.5; }
  return v;
}
// x = F1, y = F2, z = cell id
vec3 gVoronoi(vec2 x) {
  vec2 n = floor(x); vec2 fr = fract(x);
  float f1 = 8.0; float f2 = 8.0; float id = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 o = vec2(gHash12(n + g), gHash12(n + g + 19.19));
    vec2 r = g + o - fr;
    float d = dot(r, r);
    if (d < f1) { f2 = f1; f1 = d; id = gHash12(n + g + 7.7); } else if (d < f2) { f2 = d; }
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}
float sdCircle(vec2 p, vec2 c, float r) { return length(p - c) - r; }
float sdRect(vec2 p, vec2 a, vec2 b) {
  vec2 c = (a + b) * 0.5; vec2 h = (b - a) * 0.5;
  vec2 d = abs(p - c) - h;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
`

const MASK_GLSL = /* glsl */ `
float stoneSDF(vec2 p) {
  float sd = sdCircle(p, vec2(${f(SHRINE.x)}, ${f(SHRINE.z)}), 12.6);
  sd = min(sd, sdRect(p, vec2(-7.4, 13.0), vec2(7.4, 37.0)));
  sd = min(sd, sdRect(p, vec2(-6.2, -26.5), vec2(6.2, -8.0)));
  sd = min(sd, sdRect(p, vec2(-3.4, -37.0), vec2(3.4, -22.0)));
  sd = min(sd, sdCircle(p, vec2(${f(ARENA.x)}, ${f(ARENA.z)}), 25.6));
  sd = min(sd, sdRect(p, vec2(-2.3, -14.0), vec2(2.3, 17.0)));
  sd = min(sd, sdCircle(p, vec2(${f(GRAVEYARD.x)}, ${f(GRAVEYARD.z)}), 3.4));
  return sd;
}
`

/** JS mirror of the stone mask (used to keep grass off the flagstones). */
export function stoneSDF(x: number, z: number) {
  const circle = (cx: number, cz: number, r: number) => Math.hypot(x - cx, z - cz) - r
  const rect = (x0: number, z0: number, x1: number, z1: number) => {
    const cx = (x0 + x1) / 2
    const cz = (z0 + z1) / 2
    const dx = Math.abs(x - cx) - (x1 - x0) / 2
    const dz = Math.abs(z - cz) - (z1 - z0) / 2
    return Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dz), 0)
  }
  return Math.min(
    circle(SHRINE.x, SHRINE.z, 12.6),
    rect(-7.4, 13, 7.4, 37),
    rect(-6.2, -26.5, 6.2, -8),
    rect(-3.4, -37, 3.4, -22),
    circle(ARENA.x, ARENA.z, 25.6),
    rect(-2.3, -14, 2.3, 17),
    circle(GRAVEYARD.x, GRAVEYARD.z, 3.4),
  )
}

export function groundMaterial(quality: 'low' | 'medium' | 'high') {
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, metalness: 0 })
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vGPos;
        ${NOISE_GLSL}
        ${MASK_GLSL}
        ${PERTURB_GLSL}
        // polar flagstones: x = edge distance (m), y = id
        vec2 polarTiles(vec2 p, vec2 c, float ringW, float segLen) {
          vec2 d = p - c;
          float r = length(d);
          float a = atan(d.y, d.x);
          float ring = floor(r / ringW);
          float fr = fract(r / ringW);
          float circ = 6.2831853 * (ring + 0.5) * ringW;
          float segs = max(5.0, floor(circ / segLen));
          float u = (a / 6.2831853 + 0.5) * segs + gHash11(ring + 3.0) * 9.0;
          float seg = floor(u);
          float fu = fract(u);
          float edge = min(min(fr, 1.0 - fr) * ringW, min(fu, 1.0 - fu) * (circ / segs));
          return vec2(edge, gHash12(vec2(ring, mod(seg, segs)) + 0.5));
        }
        vec2 rectTiles(vec2 p, vec2 size) {
          float row = floor(p.y / size.y);
          float x = p.x / size.x + gHash11(row) * 0.6;
          float col = floor(x);
          vec2 fr = vec2(fract(x) * size.x, fract(p.y / size.y) * size.y);
          float edge = min(min(fr.x, size.x - fr.x), min(fr.y, size.y - fr.y));
          return vec2(edge, gHash12(vec2(col, row) + 0.3));
        }`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        vec2 gp = vGPos.xz;
        float fw = length(fwidth(gp));
        float aa = 1.0 - smoothstep(0.02, 0.25, fw);
        float sd = stoneSDF(gp);
        float edgeN = gFbm(gp * 0.45) - 0.5;
        float stoneMask = 1.0 - smoothstep(-0.35, 0.45, sd + edgeN * 2.4);

        // --- flagstones
        vec2 tile;
        float dShrine = length(gp - vec2(${f(SHRINE.x)}, ${f(SHRINE.z)}));
        float dArena = length(gp - vec2(${f(ARENA.x)}, ${f(ARENA.z)}));
        float dGrave = length(gp - vec2(${f(GRAVEYARD.x)}, ${f(GRAVEYARD.z)}));
        if (dShrine < 13.5) tile = polarTiles(gp, vec2(${f(SHRINE.x)}, ${f(SHRINE.z)}), 1.25, 1.7);
        else if (dArena < 27.0) tile = polarTiles(gp, vec2(${f(ARENA.x)}, ${f(ARENA.z)}), 2.1, 2.7);
        else if (dGrave < 15.5) {
          vec3 vc = gVoronoi(gp * 2.2);
          tile = vec2((vc.y - vc.x) * 0.23, vc.z);
        } else tile = rectTiles(gp, vec2(1.35, 0.85));
        float grout = (1.0 - smoothstep(0.012, 0.05, tile.x)) * aa;
        float id = tile.y;
        float n1 = gFbm(gp * 1.9 + id * 17.0);
        float n2 = gFbm(gp * 0.21 + 4.0);
        vec3 stone = vec3(0.37, 0.355, 0.335) * (0.68 + 0.6 * id) * (0.78 + 0.45 * n1);
        stone *= mix(vec3(1.02, 0.98, 0.92), vec3(0.9, 0.95, 1.02), gHash11(id * 91.0));
        vec3 vc2 = gVoronoi(gp * 1.3 + id * 5.0);
        float crack = (1.0 - smoothstep(0.0, 0.03, vc2.y - vc2.x)) * step(0.55, id) * aa;
        float mossAmt = smoothstep(0.35, 0.75, gFbm(gp * 0.55 + 3.0));
        vec3 groutCol = mix(vec3(0.07, 0.065, 0.055), vec3(0.09, 0.12, 0.045), mossAmt);
        // arena: carved concentric rings
        float ringLine = 0.0;
        if (dArena < 26.0) {
          ringLine = (1.0 - smoothstep(0.04, 0.09, abs(dArena - 8.0))) + (1.0 - smoothstep(0.04, 0.09, abs(dArena - 17.5)));
          ringLine *= aa;
        }
        vec3 sCol = mix(stone, groutCol, max(max(grout, crack * 0.85), ringLine * 0.8));
        sCol = mix(sCol, sCol * vec3(0.75, 0.85, 0.6), mossAmt * 0.35 * (1.0 - grout));
        sCol *= 0.75 + 0.35 * n2;
        float sH = (1.0 - grout) * (0.65 + 0.2 * n1) - crack * 0.4 - ringLine * 0.3;

        // --- dirt & dead grass
        float g1 = gFbm(gp * 0.33);
        float g2 = gFbm(gp * 2.7);
        float g3 = gNoise(gp * 11.0);
        vec3 dirt = mix(vec3(0.085, 0.07, 0.055), vec3(0.15, 0.13, 0.095), g1);
        float grassAmt = smoothstep(0.42, 0.68, g1 + g2 * 0.35);
        vec3 dCol = mix(dirt, vec3(0.2, 0.19, 0.11), grassAmt * 0.65) * (0.8 + 0.35 * mix(0.5, g3, aa));
        vec3 pv = gVoronoi(gp * 3.2);
        float pebble = (1.0 - smoothstep(0.1, 0.17, pv.x)) * step(0.8, pv.z) * aa;
        dCol = mix(dCol, vec3(0.28, 0.27, 0.25) * (0.7 + 0.6 * pv.z), pebble);
        float dH = g2 * 0.45 + g3 * 0.2 * aa + pebble * 0.35;

        vec3 gCol = mix(dCol, sCol, stoneMask);
        float gH = mix(dH, sH, stoneMask);
        float gRough = mix(0.97, mix(0.8, 1.0, grout), stoneMask);

        // ash ring around the bonfire
        float dB = length(gp - vec2(${f(BONFIRE.x)}, ${f(BONFIRE.z)}));
        float ash = 1.0 - smoothstep(0.9, 2.6 + edgeN, dB);
        gCol = mix(gCol, vec3(0.16, 0.155, 0.15) * (0.6 + 0.6 * g2), ash * 0.85);

        // puddles reflect the sky
        float puddle = smoothstep(0.6, 0.66, gFbm(gp * 0.11 + 7.0)) * (1.0 - ash) * (0.4 + 0.6 * stoneMask);
        gCol = mix(gCol, gCol * 0.3, puddle);
        gRough = mix(gRough, 0.05, puddle);
        gH = mix(gH, 0.3, puddle);

        diffuseColor.rgb *= gCol;`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace(
        '#include <normal_fragment_maps>',
        quality === 'low'
          ? ''
          : `normal = sdPerturb(-vViewPosition, normal, vec2(dFdx(gH), dFdy(gH)) * 0.9, faceDirection);`,
      )
  }
  mat.customProgramCacheKey = () => `ground-${quality}`
  return mat
}
