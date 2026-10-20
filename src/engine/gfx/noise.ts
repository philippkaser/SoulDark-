/** Shared GLSL value noise, fBm and Voronoi. */
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
`
