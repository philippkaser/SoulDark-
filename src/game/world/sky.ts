import * as THREE from 'three'
import { smoothstep } from '../../engine/math'
import { FOG_COLOR, SUN_DIR } from './layout'

const vert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`

const frag = /* glsl */ `
uniform float uTime;
uniform vec3 uSun;
uniform vec3 uHorizon;
uniform float uEye;
uniform float uCrack;
uniform vec3 uCrackN;
uniform vec3 uCrackA;
uniform float uSplit;
uniform float uDawn;
uniform float uDoom;
uniform float uFlash;
uniform vec3 uFlashDir;
uniform vec3 uFlashCol;
uniform float uBolt;
uniform vec3 uBoltDir;
uniform float uShatter;
uniform float uPartOn;
uniform vec2 uPartDir;
uniform vec4 uPart;
uniform vec2 uPartRing;
uniform float uPartAge;
uniform float uVortex;
uniform float uSpin;
varying vec3 vDir;

float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float n2(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), u.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), u.x), u.y); }
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * n2(p); p = p * 2.03 + 11.7; a *= 0.5; } return v; }

vec3 baseSky(vec3 d) {
  float h = d.y;
  vec3 zen = mix(vec3(0.012, 0.005, 0.02), vec3(0.02, 0.0, 0.004), uDoom);
  vec3 mid = mix(vec3(0.11, 0.03, 0.06), vec3(0.16, 0.01, 0.02), uDoom);
  vec3 hor = mix(vec3(0.5, 0.11, 0.06), vec3(0.6, 0.04, 0.02), uDoom);
  vec3 col = mix(hor, mid, smoothstep(0.0, 0.2, h));
  col = mix(col, zen, smoothstep(0.16, 0.75, h));
  vec3 dz = vec3(0.1, 0.26, 0.58), dm = vec3(0.42, 0.58, 0.86), dh = vec3(1.25, 0.8, 0.46);
  vec3 dcol = mix(dh, dm, smoothstep(0.0, 0.25, h));
  dcol = mix(dcol, dz, smoothstep(0.2, 0.85, h));
  col = mix(col, dcol, uDawn);
  vec2 dxz = normalize(d.xz + vec2(1e-5));
  float toward = max(dot(dxz, normalize(uSun.xz)), 0.0);
  col += mix(vec3(1.1, 0.3, 0.08), vec3(1.6, 1.0, 0.55), uDawn) * pow(toward, 5.0) * exp(-max(h, 0.0) * 6.0) * 0.9;
  col += vec3(0.25, 0.05, 0.03) * pow(toward, 1.5) * exp(-max(h, 0.0) * 12.0) * (1.0 - uDawn);
  return col;
}

void main() {
  vec3 d0 = normalize(vDir);
  vec3 d = d0;

  // the sky, cut in two: everything on either side of the cut is pushed apart
  float s = dot(d0, uCrackN);
  if (uSplit > 0.0) {
    d = normalize(d0 - uCrackN * sign(s) * uSplit * 0.22);
  }

  float h = d.y;
  vec3 col = baseSky(d);

  // the atmosphere split by the Worldsplitter, worked out on the cloud plane: a straight
  // canyon along uPartDir and a ring blasted out around the hero
  float pClear = 0.0;
  float pWall = 0.0;
  float pComp = 0.0;
  float pRoll = 0.0;
  vec2 pShift = vec2(0.0);
  if (uPartOn > 0.0 && h > -0.05) {
    vec2 q = d.xz / (h + 0.16);
    vec2 perp = vec2(-uPartDir.y, uPartDir.x);
    float along = dot(q, uPartDir);
    float side = dot(q, perp);
    float a = abs(side);
    // the cut tapers to a point where it is still tearing open (ahead, and behind the hero)
    float lim = along >= 0.0 ? uPart.x : uPart.y;
    float tip = smoothstep(lim, lim - 1.0 - lim * 0.2, abs(along));
    float rag = n2(vec2(along * 2.1, side > 0.0 ? 1.0 : 9.0));
    float w = uPart.z * tip * (0.75 + 0.5 * rag);
    float has = step(0.001, w);
    float inC = (1.0 - smoothstep(w * 0.55, w, a)) * has;
    float o = a - w;
    float wb = 0.06 + w * 0.22;
    float bankC = exp(-o * o / (wb * wb)) * has;
    // the deck shoved out of the cut piles up behind the walls
    float compC = (1.0 - smoothstep(0.0, w * 2.2 + 0.25, max(o, 0.0))) * step(-wb, o) * has;
    float r = length(q);
    float R = uPartRing.x;
    float hasR = uPartRing.y * step(0.01, R);
    float inR = (1.0 - smoothstep(R * 0.7, R, r)) * hasR;
    float oR = r - R;
    float rb = 0.08 + R * 0.1;
    float bankR = exp(-oR * oR / (rb * rb)) * hasR;
    float compR = (1.0 - smoothstep(0.0, R * 0.8 + 0.3, max(oR, 0.0))) * step(-rb, oR) * hasR;
    pClear = max(inC, inR);
    pWall = max(bankC, bankR) * (1.0 - pClear * 0.8);
    pComp = max(compC, compR) * (1.0 - pClear);
    // sample the deck from nearer the cut, so it looks squeezed against the walls
    pShift = -perp * sign(side) * w * exp(-max(o, 0.0) / (w * 1.2 + 0.05));
    pShift -= q / max(r, 1e-3) * R * exp(-max(oR, 0.0) / (R * 0.8 + 0.05)) * uPartRing.y * 0.7;
    // the banks roll outward (the ring's noise runs on the unit circle: no seam)
    float rollC = fbm(vec2(along * 2.6, o * 7.0 - uPartAge * 0.8));
    float rollR = fbm(q / max(r, 1e-3) * 3.0 + vec2(oR * 7.0 - uPartAge * 0.8, 5.0));
    pRoll = bankR > bankC ? rollR : rollC;
    // what was above the smoke: deep clear sky full of stars, blue at dawn
    float hz = smoothstep(-0.02, 0.16, h);
    vec3 deep = mix(vec3(0.008, 0.005, 0.022), vec3(0.06, 0.2, 0.55), uDawn);
    col = mix(col, deep, pClear * hz * 0.93);
    vec2 sp2 = d.xz / (abs(h) + 0.4) * 260.0;
    float st2 = step(0.992, h21(floor(sp2))) * (0.55 + 0.45 * sin(uTime * 3.0 + h21(floor(sp2) + 5.0) * 30.0));
    col += vec3(0.8, 0.85, 1.0) * st2 * pClear * hz * (1.0 - uDawn) * 0.9;
    // light spilling down the inside of the walls
    col += mix(vec3(0.5, 0.17, 0.06), vec3(0.6, 0.45, 0.3), uDawn) * inC * smoothstep(0.35, 1.0, a / max(w, 1e-3)) * hz * 0.35 * uPart.w;
  }

  // stars (thin through the smoke)
  vec2 sp = d.xz / (abs(h) + 0.4) * 170.0;
  float star = step(0.9975, h21(floor(sp))) * smoothstep(0.15, 0.55, h) * (1.0 - uDawn);
  star *= 0.5 + 0.5 * sin(uTime * 2.0 + h21(floor(sp) + 3.0) * 40.0);
  col += vec3(0.7, 0.75, 0.95) * star * 0.5;

  // the eclipse: a black sun with a white-gold corona; at dawn, a true sun
  float ang = acos(clamp(dot(d, uSun), -1.0, 1.0));
  float R = 0.085;
  float x = ang - R;
  vec3 a1 = normalize(cross(uSun, vec3(0.0, 1.0, 0.0)));
  vec3 a2 = cross(a1, uSun);
  vec2 local = vec2(dot(d, a1), dot(d, a2)) / R;
  float theta = atan(local.y, local.x);
  float rays = fbm(vec2(theta * 6.0, uTime * 0.06)) * 0.7 + fbm(vec2(theta * 23.0, -uTime * 0.04)) * 0.5;
  vec3 corona = mix(vec3(1.0, 0.55, 0.18), vec3(1.0, 0.25, 0.08), uDoom);
  float c = 0.0;
  // where the split blew the smoke away the corona's haze goes with it: a crisp ring on clear sky
  if (x > 0.0) c = 7.0 * exp(-x * 110.0) + (1.6 * exp(-x * 20.0) * (0.6 + rays) + 0.4 * exp(-x * 4.0) * rays) * (1.0 - 0.55 * pClear);
  float rim = smoothstep(0.004, 0.0, abs(x)) * 12.0;
  vec3 ecl = corona * c + vec3(1.0, 0.85, 0.6) * rim;
  if (x < 0.0) {
    ecl = vec3(0.003, 0.001, 0.002) + corona * 0.3 * smoothstep(-0.02, 0.0, x);
    // the eye opens
    if (uEye > 0.001) {
      float open = uEye * 0.62 * pow(max(0.0, 1.0 - local.x * local.x), 0.9);
      float lid = smoothstep(open, open - 0.04, abs(local.y));
      vec2 pc = local + vec2(sin(uTime * 0.7) * 0.05, cos(uTime * 0.53) * 0.03);
      float ir = length(pc);
      float stri = fbm(vec2(atan(pc.y, pc.x) * 9.0, ir * 6.0 - uTime * 0.3));
      vec3 iris = mix(vec3(2.2, 0.35, 0.05), vec3(4.0, 2.6, 0.9), smoothstep(0.42, 0.05, ir) * stri);
      iris *= smoothstep(0.5, 0.42, ir);
      float pupil = smoothstep(0.075, 0.05, abs(pc.x) / max(0.05, 1.0 - pow(pc.y / 0.42, 2.0)));
      vec3 sclera = vec3(0.12, 0.0, 0.01) + vec3(0.6, 0.02, 0.01) * fbm(local * 8.0) * 0.6;
      vec3 eye = mix(sclera, iris, smoothstep(0.5, 0.44, ir));
      eye = mix(eye, vec3(0.0), pupil * smoothstep(0.46, 0.4, ir));
      float lidGlow = smoothstep(0.08, 0.0, abs(abs(local.y) - open)) * step(abs(local.x), 0.98) * uEye;
      ecl = mix(ecl, eye, lid) + vec3(3.0, 0.6, 0.1) * lidGlow;
    }
  }
  // dawn: a blazing white sun replaces it
  vec3 sun = vec3(6.0, 5.0, 3.6) * smoothstep(0.012, -0.004, ang - R * 0.6) + vec3(1.6, 1.1, 0.6) * exp(-ang * 9.0) + vec3(0.6, 0.4, 0.2) * exp(-ang * 2.5);
  // the shattered eclipse blows apart into a ring of light
  ecl += corona * uShatter * 6.0 * exp(-abs(ang - R * (1.0 + uShatter * 3.0)) * 60.0);
  // the disc occludes the sky behind it; the corona adds light around it
  float disc = (x < 0.0 ? 1.0 : 0.0) * (1.0 - uDawn) * (1.0 - uShatter);
  col = mix(col + mix(ecl, sun, uDawn), ecl, disc);

  // clouds lit by the corona
  if (h > -0.05) {
    // gathering power drags the deck into a spiral over the hero: inner turns faster, so arms wind up
    vec2 q0 = d.xz / (h + 0.16);
    float rv = length(q0);
    if (uVortex > 0.001) {
      float va = (uSpin * exp(-rv * 0.45) + 1.4 * log(rv + 0.25)) * uVortex;
      float vc = cos(va);
      float vs = sin(va);
      q0 = mat2(vc, -vs, vs, vc) * q0;
    }
    vec2 cp = (q0 + pShift) * 1.4 + vec2(uTime * 0.01, uTime * 0.004);
    float cl = smoothstep(0.42, 0.85, fbm(cp));
    float streak = smoothstep(0.5, 0.9, fbm(vec2(cp.x * 0.35, cp.y * 3.0) + 4.0));
    cl = max(cl, streak * 0.6) * (1.0 - pClear);
    // the split: the shoved-aside deck piled thick, and the walls as dense rolling banks
    cl = max(cl, pComp * 0.85 * smoothstep(0.3, 0.7, fbm(cp * 1.25 + vec2(uPartAge * 0.03, 0.0)) + pComp * 0.3));
    cl = max(cl, pWall * smoothstep(0.2, 0.65, pRoll + pWall * 0.4));
    // the spiral: heavy arms wound round a clear eye over the hero
    float vArms = 0.0;
    if (uVortex > 0.001) {
      float th = atan(d.z, d.x);
      float arms = 0.5 + 0.5 * sin(3.0 * th + 5.0 * log(rv + 0.2) - uSpin * 1.6);
      vArms = smoothstep(0.45, 0.85, arms * (0.6 + 0.65 * fbm(cp * 1.3 + 2.0))) * smoothstep(0.12, 0.45, rv);
      cl = mix(cl * (1.0 - smoothstep(0.3, 0.1, rv) * uVortex), vArms, uVortex * 0.85);
    }
    float lit = exp(-ang * 2.6) * 1.6 + 0.06;
    vec3 cloudDark = mix(vec3(0.03, 0.012, 0.02), vec3(0.32, 0.36, 0.45), uDawn);
    vec3 cloudLit = mix(vec3(0.75, 0.22, 0.07), vec3(1.4, 0.95, 0.65), uDawn);
    vec3 cc = mix(cloudDark, cloudLit, clamp(lit * 0.6, 0.0, 1.0));
    // the piled deck sits in shadow; the wall faces are lit edge-on by the light pouring through the cut
    cc *= 1.0 - pComp * 0.5 * (1.0 - pWall);
    cc = mix(cc, cloudLit * (0.55 + 0.35 * pRoll) * (0.6 + uPart.w) * (0.5 + 0.5 * clamp(lit, 0.0, 1.0)), clamp(pWall * 1.3, 0.0, 1.0));
    float fade = smoothstep(-0.05, 0.12, h) * (1.0 - smoothstep(0.6, 0.97, h));
    // the split's banks stay visible higher up, so the cut runs on overhead (and so does a vortex)
    fade = max(fade, smoothstep(-0.05, 0.12, h) * (1.0 - smoothstep(0.85, 0.99, h)) * max(max(pWall, pComp), uVortex));
    // thin the cloud deck in front of the black disc so it stays a void
    fade *= 1.0 - 0.85 * smoothstep(0.02, -0.01, x) * (1.0 - uDawn);
    col = mix(col, cc + corona * lit * 0.12 * (1.0 - uDawn), cl * fade * 0.88);
    // the eye of the vortex: light pouring down onto the hero, the arms' edges lit by it
    col += vec3(1.5, 0.95, 0.45) * uVortex * exp(-rv * 6.0) * smoothstep(0.3, 0.95, h) * 1.4;
    col += vec3(1.0, 0.5, 0.18) * uVortex * vArms * exp(-rv * 1.2) * 0.12;
  }

  // distant lightning and explosion flashes light the sky from a direction
  col += uFlashCol * uFlash * (0.25 + 2.5 * pow(max(dot(d0, uFlashDir), 0.0), 6.0));
  col += vec3(0.7, 0.6, 1.0) * uBolt * pow(max(dot(d0, uBoltDir), 0.0), 18.0) * 3.0;

  // the cut itself, and the light pouring through it
  if (uCrack > 0.0) {
    vec3 e1 = normalize(uCrackA);
    vec3 e2 = cross(uCrackN, e1);
    float phi = atan(dot(d0, e2), dot(d0, e1));
    float reveal = smoothstep(-1.6, -1.6 + uCrack * 3.4, -phi) * step(-1.6, -phi);
    float w = 0.0025 + uSplit * 0.22;
    float core = smoothstep(w + 0.004, w * 0.3, abs(s)) * reveal;
    float glow = exp(-abs(s) * (60.0 - uSplit * 40.0)) * reveal;
    float strands = fbm(vec2(phi * 40.0, uTime * 2.0));
    col = mix(col, vec3(4.0, 3.5, 2.6) * (0.8 + strands * 0.6), core);
    col += vec3(1.8, 1.2, 0.6) * glow * 0.8;
  }

  // below the horizon: fog colour
  col = mix(col, uHorizon, smoothstep(0.03, -0.06, h));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`

const DAWN_FOG = new THREE.Color('#c39478')

export interface PartOpts {
  /** Canyon half-width on the cloud plane (the deck is at d.xz / (h + 0.16)). */
  width?: number
  /** Final radius of the ring blasted out around the hero (cloud-plane units; 0 for none). */
  ring?: number
  /** Seconds for the split to tear from overhead to the horizon. */
  tear?: number
  /** Seconds until the deck has closed again. */
  heal?: number
}

const PART_DEFAULTS: Required<PartOpts> = { width: 0.5, ring: 1.5, tear: 1.5, heal: 90 }
/** How far the tear runs on the cloud plane: past the horizon (|q| = 6.25 at h = 0). */
const PART_REACH = 9

/** The cloud split's shape at `age` seconds: how far it has torn ahead and behind, its width, the ring, the wall glow. */
export function partState(age: number, o: Required<PartOpts> = PART_DEFAULTS) {
  const u = Math.min(1, Math.max(0, age) / o.tear)
  const heal = 1 - smoothstep(o.heal * 0.3, o.heal, age)
  const reach = PART_REACH * Math.pow(u, 1.25)
  const ru = Math.min(1, Math.max(0, age) / (o.tear * 1.5))
  return {
    on: heal > 0.001 ? 1 : 0,
    reach,
    back: reach * 0.45,
    // the canyon keeps opening after the front has passed, then slowly closes
    width: o.width * (0.4 + 0.6 * smoothstep(0, o.tear * 1.8, age)) * heal,
    ring: o.ring * (1 - (1 - ru) * (1 - ru)) * heal,
    ringAmt: heal,
    // fresh walls blaze, then settle into lit banks
    glow: (0.6 + 2.2 * Math.exp(-age / 2.5)) * heal,
  }
}

export class Sky {
  readonly mesh: THREE.Mesh
  readonly u = {
    uTime: { value: 0 },
    uSun: { value: SUN_DIR.clone() },
    uHorizon: { value: FOG_COLOR.clone() },
    uEye: { value: 0 },
    uCrack: { value: 0 },
    uCrackN: { value: new THREE.Vector3(0, 0, 1) },
    uCrackA: { value: new THREE.Vector3(1, 0, 0) },
    uSplit: { value: 0 },
    uDawn: { value: 0 },
    uDoom: { value: 0 },
    uFlash: { value: 0 },
    uFlashDir: { value: new THREE.Vector3(0, 0.2, -1).normalize() },
    uFlashCol: { value: new THREE.Color(1, 0.7, 0.4) },
    uBolt: { value: 0 },
    uBoltDir: { value: new THREE.Vector3(1, 0.1, 0).normalize() },
    uShatter: { value: 0 },
    uPartOn: { value: 0 },
    uPartDir: { value: new THREE.Vector2(0, -1) },
    uPart: { value: new THREE.Vector4() },
    uPartRing: { value: new THREE.Vector2() },
    uPartAge: { value: 0 },
    uVortex: { value: 0 },
    uSpin: { value: 0 },
  }
  readonly fogColor = FOG_COLOR.clone()
  private boltTimer = 4
  /** The cloud split: seconds since it began (< 0: none), and its shape. */
  private partAge = -1
  private partOpts: Required<PartOpts> = { ...PART_DEFAULTS }
  /** How hard the clouds are being drawn into a spiral this frame (set by whatever gathers power). */
  private swirlTarget = 0

  constructor() {
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: this.u,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    })
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 64, 32), mat)
    this.mesh.renderOrder = -10
    this.mesh.frustumCulled = false
  }

  /** Light the sky from a direction (explosions on the horizon). */
  flash(dir: THREE.Vector3, amount: number, color: THREE.ColorRepresentation = '#ffb070') {
    if (amount < this.u.uFlash.value) return
    this.u.uFlash.value = amount
    this.u.uFlashDir.value.copy(dir).normalize()
    this.u.uFlashCol.value.set(color)
  }

  /**
   * Split the atmosphere: the cloud deck is blown apart in a straight canyon
   * along `dir` (xz) from overhead to the horizon, and a ring of cloud is
   * blasted outward around the hero. The split tears open over ~1.5 s and
   * heals over ~90 s.
   */
  part(dir: THREE.Vector3, opts: PartOpts = {}) {
    const l = Math.hypot(dir.x, dir.z)
    if (l < 1e-4) return
    this.u.uPartDir.value.set(dir.x / l, dir.z / l)
    this.partOpts = { ...PART_DEFAULTS, ...opts }
    this.partAge = 0
  }

  /** Gathering power drags the clouds into a vortex over the hero; call every frame it should hold (0..1). */
  swirl(k: number) {
    this.swirlTarget = Math.max(this.swirlTarget, k)
  }

  /** Is the sky split open right now? */
  get parted() {
    return this.partAge >= 0
  }

  reset() {
    this.partAge = -1
    this.u.uPartOn.value = 0
    this.u.uEye.value = 0
    this.u.uCrack.value = 0
    this.u.uSplit.value = 0
    this.u.uDawn.value = 0
    this.u.uDoom.value = 0
    this.u.uShatter.value = 0
    this.u.uVortex.value = 0
    this.swirlTarget = 0
  }

  update(dt: number, camera: THREE.Camera, lightning: boolean) {
    const u = this.u
    u.uTime.value += dt
    this.mesh.position.copy(camera.position)
    u.uFlash.value *= Math.exp(-dt * 2.5)
    u.uBolt.value *= Math.exp(-dt * 14)
    // the vortex winds up quickly and unwinds slowly once the power is spent
    const vt = this.swirlTarget
    this.swirlTarget = 0
    u.uVortex.value += (vt - u.uVortex.value) * (1 - Math.exp(-dt * (vt > u.uVortex.value ? 2.5 : 0.6)))
    u.uSpin.value = u.uVortex.value < 0.005 ? 0 : u.uSpin.value + dt * (0.3 + u.uVortex.value * 2.2)
    if (lightning && u.uDawn.value < 0.5) {
      this.boltTimer -= dt
      if (this.boltTimer <= 0) {
        this.boltTimer = 2 + Math.random() * 7
        const a = Math.random() * Math.PI * 2
        u.uBoltDir.value.set(Math.sin(a), 0.05 + Math.random() * 0.15, Math.cos(a)).normalize()
        u.uBolt.value = 0.6 + Math.random() * 0.8
      }
    }
    if (this.partAge >= 0) {
      this.partAge += dt
      const st = partState(this.partAge, this.partOpts)
      u.uPartOn.value = st.on
      u.uPart.value.set(st.reach, st.back, st.width, st.glow)
      u.uPartRing.value.set(st.ring, st.ringAmt)
      u.uPartAge.value = this.partAge
      if (!st.on) this.partAge = -1
    }
    this.fogColor.copy(FOG_COLOR).lerp(DAWN_FOG, u.uDawn.value)
    u.uHorizon.value.copy(this.fogColor)
  }
}
