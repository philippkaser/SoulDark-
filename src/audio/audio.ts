/**
 * Fully procedural audio: every sound is synthesized with WebAudio at runtime.
 */
import { Score, type MusicMode } from './music'

export type Vec = { x: number; y?: number; z: number }

const rnd = (a: number, b: number) => a + Math.random() * (b - a)

export interface LoopHandle {
  set(level: number, pos?: Vec): void
  stop(fade?: number): void
}

const NOOP: LoopHandle = { set() {}, stop() {} }

class AudioEngine {
  ctx: AudioContext | null = null
  private master!: GainNode
  private sfx!: GainNode
  private warpFilter!: BiquadFilterNode
  private musicBus!: GainNode
  private amb!: GainNode
  private reverb!: ConvolverNode
  private reverbSend!: GainNode
  private noise!: AudioBuffer
  private comp!: DynamicsCompressorNode
  private listener = { x: 0, y: 0, z: 0, yaw: 0 }
  private windGain!: GainNode
  private windFilter!: BiquadFilterNode
  private rumbleGain!: GainNode
  volume = 0.8
  musicVolume = 0.65
  private score: Score | null = null
  private limits = new Map<string, number>()
  /** Feel buses: a brick-wall limiter after the glue compressor, the music's ducker, the deafened low-pass, a wide outdoor reverb. */
  private limiter!: DynamicsCompressorNode
  private duckGain!: GainNode
  private deafFilter!: BiquadFilterNode
  private bigVerb!: ConvolverNode
  private bigSend!: GainNode

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return
    }
    const AC = typeof window !== 'undefined' ? window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext : undefined
    if (!AC) return
    const ctx = new AC()
    this.ctx = ctx
    this.comp = ctx.createDynamicsCompressor()
    this.comp.threshold.value = -12
    this.comp.ratio.value = 5
    this.comp.knee.value = 10
    this.comp.attack.value = 0.003
    this.comp.release.value = 0.2
    this.master = ctx.createGain()
    this.master.gain.value = this.volume
    // the glue compressor, then a brick wall: a nuke on top of a nuke never clips
    this.limiter = ctx.createDynamicsCompressor()
    this.limiter.threshold.value = -1.5
    this.limiter.knee.value = 0
    this.limiter.ratio.value = 20
    this.limiter.attack.value = 0.001
    this.limiter.release.value = 0.12
    this.master.connect(this.comp).connect(this.limiter).connect(ctx.destination)
    // the world's sound goes deaf after a near blast; the music ducks under huge booms
    this.deafFilter = ctx.createBiquadFilter()
    this.deafFilter.type = 'lowpass'
    this.deafFilter.frequency.value = 20000
    this.deafFilter.Q.value = 0.9
    this.deafFilter.connect(this.master)
    this.duckGain = ctx.createGain()
    this.duckGain.connect(this.master)
    // the time-warp filter: everything muffles in divine time
    this.warpFilter = ctx.createBiquadFilter()
    this.warpFilter.type = 'lowpass'
    this.warpFilter.frequency.value = 20000
    this.warpFilter.Q.value = 0.8
    this.warpFilter.connect(this.deafFilter)
    this.sfx = ctx.createGain()
    this.sfx.connect(this.warpFilter)
    this.musicBus = ctx.createGain()
    this.musicBus.gain.value = this.musicVolume
    this.musicBus.connect(this.duckGain)
    this.amb = ctx.createGain()
    this.amb.gain.value = 0.9
    this.amb.connect(this.warpFilter)

    this.reverb = ctx.createConvolver()
    this.reverb.buffer = this.makeImpulse(4.5, 2.2)
    this.reverbSend = ctx.createGain()
    this.reverbSend.gain.value = 0.5
    this.reverbSend.connect(this.reverb).connect(this.warpFilter)
    // explosions and big hits roll out across a wide plain and come back off the ridges
    this.bigVerb = ctx.createConvolver()
    this.bigVerb.buffer = this.makeWideImpulse(6.5)
    this.bigSend = ctx.createGain()
    this.bigSend.gain.value = 0.55
    this.bigSend.connect(this.bigVerb).connect(this.warpFilter)

    const len = ctx.sampleRate * 2
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = this.noise.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1

    this.startAmbience()
    this.score = new Score(ctx, this.musicBus, this.reverbSend)
  }

  setVolume(master: number, music: number) {
    this.volume = master
    this.musicVolume = music
    if (!this.ctx) return
    this.master.gain.setTargetAtTime(master, this.ctx.currentTime, 0.05)
    this.musicBus.gain.setTargetAtTime(music, this.ctx.currentTime, 0.05)
  }

  setListener(x: number, y: number, z: number, yaw: number) {
    this.listener.x = x
    this.listener.y = y
    this.listener.z = z
    this.listener.yaw = yaw
  }

  /** 0 = normal, 1 = deep in slowed time. */
  setWarp(amount: number) {
    if (!this.ctx) return
    const f = 20000 * Math.pow(0.03, amount)
    this.warpFilter.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.04)
  }

  music(mode: MusicMode, intensity = 1) {
    this.score?.set(mode, intensity)
  }

  musicSting(kind: 'parry' | 'big') {
    this.score?.sting(kind)
  }

  private makeImpulse(seconds: number, decay: number) {
    const ctx = this.ctx!
    const rate = ctx.sampleRate
    const len = Math.floor(rate * seconds)
    const buf = ctx.createBuffer(2, len, rate)
    for (let c = 0; c < 2; c++) {
      const ch = buf.getChannelData(c)
      for (let i = 0; i < len; i++) {
        const t = i / len
        ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (i < rate * 0.01 ? i / (rate * 0.01) : 1)
      }
    }
    return buf
  }

  /** Rate limiter so a hundred deaths in one frame don't make a hundred sounds. */
  private allow(key: string, gap: number) {
    if (!this.ctx) return false
    const t = this.ctx.currentTime
    const last = this.limits.get(key) ?? -1
    if (t - last < gap) return false
    this.limits.set(key, t)
    return true
  }

  private dist(pos: Vec) {
    const dx = pos.x - this.listener.x
    const dy = (pos.y ?? this.listener.y) - this.listener.y
    const dz = pos.z - this.listener.z
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  /** Output node for a sound at a world position: distance attenuation + stereo pan. */
  private out(pos?: Vec, wet = 0.25, ref = 8, maxDist = 400): GainNode | null {
    const ctx = this.ctx!
    const g = ctx.createGain()
    if (pos) {
      const dx = pos.x - this.listener.x
      const dz = pos.z - this.listener.z
      const dist = this.dist(pos)
      if (dist > maxDist) return null
      g.gain.value = 1 / (1 + Math.pow(dist / ref, 2) * 0.35)
      const yaw = this.listener.yaw
      const rx = -Math.cos(yaw)
      const rz = Math.sin(yaw)
      const pan = dist > 0.01 ? Math.max(-1, Math.min(1, (dx * rx + dz * rz) / Math.max(dist, 1))) * 0.7 : 0
      const p = ctx.createStereoPanner()
      p.pan.value = pan
      g.connect(p).connect(this.sfx)
      wet *= 1 + Math.min(1.5, dist / 40)
    } else {
      g.connect(this.sfx)
    }
    if (wet > 0) {
      const w = ctx.createGain()
      w.gain.value = wet
      g.connect(w).connect(this.reverbSend)
    }
    return g
  }

  private noiseSrc(duration: number, t0?: number) {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    src.loop = true
    const start = t0 ?? ctx.currentTime
    src.start(start, Math.random() * 1.5)
    src.stop(start + duration + 0.05)
    return src
  }

  private env(g: GainNode, t0: number, a: number, peak: number, d: number) {
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + a)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d)
  }

  private tone(out: AudioNode, type: OscillatorType, f0: number, f1: number, t0: number, dur: number, peak: number, attack = 0.005) {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.setValueAtTime(f0, t0)
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + attack + dur)
    const g = ctx.createGain()
    this.env(g, t0, attack, peak, dur)
    o.connect(g).connect(out)
    o.start(t0)
    o.stop(t0 + attack + dur + 0.05)
    return o
  }

  private burst(out: AudioNode, t0: number, dur: number, type: BiquadFilterType, f0: number, f1: number, peak: number, q = 1, attack = 0.004) {
    const ctx = this.ctx!
    const src = this.noiseSrc(dur + attack + 0.05, t0)
    const f = ctx.createBiquadFilter()
    f.type = type
    f.Q.value = q
    f.frequency.setValueAtTime(f0, t0)
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + attack + dur)
    const g = ctx.createGain()
    this.env(g, t0, attack, peak, dur)
    src.connect(f).connect(g).connect(out)
  }

  /** Bell / blade ring from inharmonic partials. */
  private ring(out: AudioNode, t0: number, base: number, partials: number[], dur: number, peak: number) {
    partials.forEach((p, i) => this.tone(out, 'sine', base * p * rnd(0.995, 1.005), base * p * 0.985, t0, dur * (1 - i * 0.08), peak / (1 + i * 0.35), 0.002))
  }

  /** Formant "choir" voice on a set of frequencies. */
  private choir(out: AudioNode, t0: number, freqs: number[], dur: number, amp: number, attack = 0.02) {
    const ctx = this.ctx!
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(amp, t0 + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + dur)
    const f1 = ctx.createBiquadFilter()
    f1.type = 'bandpass'
    f1.frequency.value = 800
    f1.Q.value = 3
    const f2 = ctx.createBiquadFilter()
    f2.type = 'bandpass'
    f2.frequency.value = 1150
    f2.Q.value = 4
    for (const f of freqs) {
      for (const det of [-10, 0, 9]) {
        const o = ctx.createOscillator()
        o.type = 'sawtooth'
        o.frequency.value = f
        o.detune.value = det
        o.connect(f1)
        o.connect(f2)
        o.start(t0)
        o.stop(t0 + attack + dur + 0.1)
      }
    }
    const mix = ctx.createGain()
    mix.gain.value = 1.4
    f1.connect(mix)
    f2.connect(mix)
    mix.connect(g).connect(out)
  }

  // -------------------------------------------------------------------------
  // The hero
  // -------------------------------------------------------------------------

  slash(power = 1) {
    if (!this.ctx) return
    const o = this.out(undefined, 0.18)!
    const t = this.ctx.currentTime
    const f = rnd(700, 900)
    this.burst(o, t, 0.16 + power * 0.04, 'bandpass', f, f * 4, 0.5 + power * 0.1, 1.8, 0.03)
    this.ring(o, t + 0.02, rnd(1900, 2300), [1, 1.41, 2.03], 0.25 + power * 0.1, 0.035)
    if (power >= 2) {
      this.tone(o, 'sine', 120, 40, t, 0.3, 0.6)
      this.burst(o, t, 0.4, 'lowpass', 1200, 120, 0.4, 0.7, 0.02)
    }
  }

  /** The flying crescent tears away. */
  airSlash() {
    if (!this.ctx || !this.allow('air', 0.04)) return
    const o = this.out(undefined, 0.3)!
    const t = this.ctx.currentTime
    this.burst(o, t, 0.5, 'bandpass', 2400, 500, 0.25, 3, 0.02)
    this.tone(o, 'sawtooth', 600, 180, t, 0.35, 0.03)
  }

  /** Something big gets cut. */
  cut(pos?: Vec, big = false) {
    if (!this.ctx || !this.allow('cut', 0.05)) return
    const o = this.out(pos, 0.4, 20)
    if (!o) return
    const t = this.ctx.currentTime
    this.burst(o, t, 0.08, 'highpass', 3000, 9000, 0.6, 1, 0.001)
    this.ring(o, t, big ? 820 : 1500, [1, 1.52, 2.21, 3.1], big ? 1.6 : 0.6, 0.08)
    if (big) this.tone(o, 'sine', 90, 30, t, 1.2, 0.7)
  }

  dash() {
    if (!this.ctx) return
    const o = this.out(undefined, 0.2)!
    const t = this.ctx.currentTime
    this.burst(o, t, 0.22, 'bandpass', 600, 3800, 0.55, 1.5, 0.02)
    this.tone(o, 'sine', 300, 1400, t, 0.14, 0.06)
    this.ring(o, t + 0.05, 2800, [1, 1.5], 0.3, 0.025)
  }

  leap() {
    if (!this.ctx) return
    const o = this.out(undefined, 0.15)!
    const t = this.ctx.currentTime
    this.burst(o, t, 0.35, 'bandpass', 300, 1500, 0.4, 1, 0.05)
    this.tone(o, 'sine', 110, 50, t, 0.2, 0.5)
  }

  dive() {
    if (!this.ctx) return
    const o = this.out(undefined, 0.2)!
    const t = this.ctx.currentTime
    this.burst(o, t, 0.6, 'bandpass', 4000, 600, 0.35, 4, 0.1)
  }

  landing(size: number) {
    if (!this.ctx) return
    const o = this.out(undefined, 0.5)!
    const t = this.ctx.currentTime
    if (size >= 2) this.wide(o, Math.min(0.6, size * 0.12))
    this.tone(o, 'sine', 90, 25, t, 0.5 + size * 0.15, 1)
    this.burst(o, t, 0.5 + size * 0.2, 'lowpass', 2500, 80, 0.9, 0.7, 0.003)
    for (let i = 0; i < 8; i++) this.burst(o, t + 0.05 + Math.random() * 0.5, 0.05, 'bandpass', rnd(1200, 3000), 800, 0.12, 2)
  }

  parry(tier: number, perfect: boolean) {
    if (!this.ctx) return
    const o = this.out(undefined, 0.9)!
    const t = this.ctx.currentTime
    const base = 1250 / (1 + tier * 0.35)
    this.burst(o, t, 0.06, 'highpass', 4000, 12000, 0.9, 1, 0.001)
    this.ring(o, t, base, [1, 1.48, 2.17, 2.93, 3.81, 5.07], perfect ? 1.8 + tier * 0.5 : 0.9, perfect ? 0.22 : 0.15)
    this.tone(o, 'sine', 220, 55, t, 0.3, 0.8)
    if (perfect) {
      // a choir stab in D major: triumph
      this.choir(o, t + 0.005, [293.7, 370, 440, 587.3].map((f) => f * (tier >= 2 ? 0.5 : 1)), 1.1 + tier * 0.4, 0.06 + tier * 0.015, 0.008)
      this.burst(o, t + 0.02, 0.9, 'bandpass', 6000, 2000, 0.12, 2, 0.01)
    }
    if (tier >= 2) {
      this.wide(o, 0.25 + (tier - 2) * 0.3)
      this.tone(o, 'sine', 70, 22, t, 1.6, 1)
      this.ring(o, t, 160, [1, 1.33, 1.98, 2.7], 3.5, 0.25)
    }
  }

  block() {
    if (!this.ctx || !this.allow('block', 0.04)) return
    const o = this.out(undefined, 0.4)!
    const t = this.ctx.currentTime
    this.ring(o, t, 700, [1, 1.6, 2.4], 0.5, 0.1)
    this.burst(o, t, 0.15, 'lowpass', 3000, 400, 0.6, 0.8, 0.002)
    this.tone(o, 'sine', 150, 50, t, 0.25, 0.6)
  }

  /** The Heaven Splitter charging: returns a handle driven by charge level 0..1. */
  charge(): LoopHandle {
    if (!this.ctx) return NOOP
    const ctx = this.ctx
    const t = ctx.currentTime
    const out = this.out(undefined, 0.4)!
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.15)
    g.connect(out)
    const f = ctx.createBiquadFilter()
    f.type = 'bandpass'
    f.Q.value = 2.5
    f.frequency.value = 300
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    src.loop = true
    src.connect(f).connect(g)
    src.start()
    const oscs: OscillatorNode[] = []
    const og = ctx.createGain()
    og.gain.value = 0.05
    og.connect(g)
    for (const m of [1, 1.5, 2, 3.01]) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = 80 * m
      o.connect(og)
      o.start()
      oscs.push(o)
    }
    let stopped = false
    return {
      set: (k) => {
        if (stopped) return
        const now = ctx.currentTime
        f.frequency.setTargetAtTime(300 + k * k * 5000, now, 0.05)
        oscs.forEach((o, i) => o.frequency.setTargetAtTime(80 * [1, 1.5, 2, 3.01][i] * (1 + k * 2.2), now, 0.05))
        g.gain.setTargetAtTime(0.25 + k * 0.4, now, 0.05)
      },
      stop: (fade = 0.08) => {
        if (stopped) return
        stopped = true
        const now = ctx.currentTime
        g.gain.cancelScheduledValues(now)
        g.gain.setValueAtTime(g.gain.value, now)
        g.gain.exponentialRampToValueAtTime(0.0001, now + fade)
        src.stop(now + fade + 0.05)
        for (const o of oscs) o.stop(now + fade + 0.05)
      },
    }
  }

  /** The Heaven Splitter falls. */
  cleave(charge: number) {
    if (!this.ctx) return
    const o = this.out(undefined, 0.9)!
    const t = this.ctx.currentTime
    this.wide(o, 0.2 + charge * 0.6)
    if (charge > 0.6) this.duck(0.5 * charge, 2)
    this.burst(o, t, 0.12, 'highpass', 2000, 9000, 1, 1, 0.001)
    this.burst(o, t, 0.5, 'bandpass', 3000, 300, 0.8, 1.2, 0.01)
    this.tone(o, 'sine', 80, 20, t, 1.5 + charge * 2, 1)
    this.burst(o, t + 0.05, 2 + charge * 2.5, 'lowpass', 900, 40, 0.9, 0.6, 0.05)
    this.ring(o, t, 600, [1, 1.52, 2.21, 3.1, 4.4], 2.5, 0.12)
    for (let i = 0; i < 20; i++) this.burst(o, t + 0.1 + Math.random() * 1.6, 0.06, 'bandpass', rnd(800, 2600), 500, 0.18, 2)
  }

  /** Arrows burning up in the hero's aura: a hiss and a few crackles. */
  sizzle(k: number) {
    if (!this.ctx || !this.allow('sizzle', 0.12)) return
    const o = this.out(undefined, 0.25)!
    const t = this.ctx.currentTime
    this.burst(o, t, 0.25 + k * 0.3, 'highpass', 3500, 6000, 0.12 + k * 0.2, 0.7, 0.01)
    for (let i = 0; i < 2 + k * 6; i++) this.burst(o, t + Math.random() * 0.3, 0.02, 'bandpass', rnd(1500, 4000), 800, 0.1, 2)
  }

  /** The blade flicked clean: a whip of air and a thin ring. */
  chiburi() {
    if (!this.ctx) return
    const o = this.out(undefined, 0.4)!
    const t = this.ctx.currentTime
    this.burst(o, t, 0.18, 'bandpass', 900, 3200, 0.35, 1.6, 0.03)
    this.ring(o, t + 0.12, 2200, [1, 1.5, 2.3], 0.9, 0.05)
  }

  /** The Iai's draw: steel singing out of the scabbard, the air split flat across the front. */
  iaiDraw() {
    if (!this.ctx) return
    const o = this.out(undefined, 0.5)!
    const t = this.ctx.currentTime
    this.wide(o, 0.25)
    this.burst(o, t, 0.09, 'bandpass', 3500, 9000, 0.5, 4, 0.004)
    this.ring(o, t + 0.01, 3100, [1, 1.41, 2.13, 2.9], 1.1, 0.07)
    this.burst(o, t + 0.02, 0.025, 'highpass', 4000, 11000, 0.9, 0.8, 0.0005)
    this.burst(o, t + 0.03, 0.5, 'bandpass', 2500, 300, 0.4, 1.5, 0.01)
    this.tone(o, 'sine', 120, 40, t + 0.02, 0.3, 0.5, 0.002)
  }

  /** The Worldsplitter's charge: a rumble rising from the ground and a tightening whine, driven by charge 0..1. */
  worldCharge(): LoopHandle {
    if (!this.ctx) return NOOP
    const ctx = this.ctx
    const t = ctx.currentTime
    const out = this.out(undefined, 0.35)!
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.4, t + 0.25)
    g.connect(out)
    // the ground: low noise, throbbing faster as the power builds
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    src.loop = true
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 90
    const throb = ctx.createGain()
    throb.gain.value = 0.6
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 5
    const lfoAmt = ctx.createGain()
    lfoAmt.gain.value = 0.4
    lfo.connect(lfoAmt).connect(throb.gain)
    src.connect(lp).connect(throb).connect(g)
    // a sub tone underneath, and a whine tightening over the top
    const sub = ctx.createOscillator()
    sub.type = 'sine'
    sub.frequency.value = 30
    const subG = ctx.createGain()
    subG.gain.value = 0.5
    sub.connect(subG).connect(g)
    const whine = ctx.createOscillator()
    whine.type = 'triangle'
    whine.frequency.value = 180
    const whineG = ctx.createGain()
    whineG.gain.value = 0.0001
    whine.connect(whineG).connect(g)
    for (const n of [src, lfo, sub, whine]) n.start(t)
    let stopped = false
    return {
      set: (k) => {
        if (stopped) return
        const now = ctx.currentTime
        lp.frequency.setTargetAtTime(90 + k * 320, now, 0.08)
        lfo.frequency.setTargetAtTime(5 + k * 16, now, 0.08)
        sub.frequency.setTargetAtTime(30 + k * 24, now, 0.08)
        whine.frequency.setTargetAtTime(180 + k * k * 900, now, 0.08)
        whineG.gain.setTargetAtTime(0.0001 + k * k * 0.05, now, 0.08)
        g.gain.setTargetAtTime(0.35 + k * 0.55, now, 0.08)
      },
      stop: (fade = 0.1) => {
        if (stopped) return
        stopped = true
        const now = ctx.currentTime
        g.gain.cancelScheduledValues(now)
        g.gain.setValueAtTime(Math.max(0.0002, g.gain.value), now)
        g.gain.exponentialRampToValueAtTime(0.0001, now + fade)
        for (const n of [src, lfo, sub, whine]) n.stop(now + fade + 0.05)
      },
    }
  }

  /** The Worldsplitter coming down: a kilometre of light falling through the air. */
  worldSwing() {
    if (!this.ctx) return
    const o = this.out(undefined, 0.8)!
    const t = this.ctx.currentTime
    this.wide(o, 0.5)
    this.burst(o, t, 0.5, 'bandpass', 300, 1800, 0.6, 2, 0.25)
    this.burst(o, t + 0.05, 0.45, 'lowpass', 400, 2400, 0.5, 0.8, 0.3)
    this.tone(o, 'sawtooth', 55, 110, t, 0.4, 0.12, 0.3)
  }

  /** The Worldsplitter lands: the air cracks, the steel rings, a sub-bass boom, thunder chasing the cut to the horizon. */
  worldSplit() {
    if (!this.ctx) return
    const o = this.out(undefined, 1.1)!
    const t = this.ctx.currentTime
    this.wide(o, 0.9)
    this.ring(o, t, 900, [1, 1.52, 2.21, 3.1], 3, 0.1)
    this.burst(o, t, 0.05, 'highpass', 3000, 10000, 1, 0.8, 0.0005)
    this.tone(o, 'sine', 62, 18, t, 3.5, 1, 0.004)
    this.tone(o, 'sine', 38, 16, t + 0.03, 4.5, 0.8, 0.02)
    this.burst(o, t + 0.01, 1.1, 'bandpass', 5200, 240, 0.85, 2.2, 0.01)
    this.burst(o, t, 2.2, 'lowpass', 2400, 50, 0.9, 0.6, 0.005)
    for (let i = 0; i < 9; i++) this.burst(o, t + 0.35 + i * 0.32 + Math.random() * 0.2, 0.8 + Math.random() * 0.8, 'lowpass', rnd(500, 900), 40, 0.5 * (1 - i / 11), 0.7, 0.03)
    this.rumble(1, 4)
  }

  /** The atmosphere tearing open overhead: a long rip sweeping across the sky, crackle, then the hush of clear air. */
  skyRip() {
    if (!this.ctx) return
    const o = this.out(undefined, 1.4)!
    const t = this.ctx.currentTime
    this.burst(o, t, 1.6, 'bandpass', 300, 4200, 0.5, 3, 0.25)
    this.burst(o, t + 0.1, 2.4, 'highpass', 1200, 6000, 0.18, 0.7, 0.6)
    for (let i = 0; i < 26; i++) this.burst(o, t + Math.random() * 1.8, 0.04 + Math.random() * 0.05, 'bandpass', rnd(900, 4200), 600, 0.12, 2)
    this.tone(o, 'sine', 48, 24, t + 0.2, 3, 0.5, 0.4)
    this.choir(o, t + 0.6, [146.8, 220, 293.7], 3.5, 0.03, 1.2)
  }

  hurt(heavy: boolean) {
    if (!this.ctx || !this.allow('hurt', 0.08)) return
    const o = this.out(undefined, 0.2)!
    const t = this.ctx.currentTime
    this.tone(o, 'sine', 160, 60, t, 0.2, heavy ? 0.9 : 0.4)
    this.burst(o, t, 0.12, 'lowpass', 2500, 300, heavy ? 0.7 : 0.35)
    this.ring(o, t, 520, [1, 1.7], 0.3, 0.06)
  }

  timeStop() {
    if (!this.ctx) return
    const o = this.out(undefined, 1.2)!
    const t = this.ctx.currentTime
    this.burst(o, t, 0.7, 'highpass', 800, 9000, 0.4, 1, 0.65)
    this.tone(o, 'sine', 55, 30, t + 0.6, 2.5, 0.8, 0.05)
    this.ring(o, t + 0.6, 220, [1, 2, 3.01, 4.2], 3, 0.12)
  }

  judgmentCut(i: number) {
    if (!this.ctx) return
    const o = this.out(undefined, 0.6)!
    const t = this.ctx.currentTime
    this.burst(o, t, 0.05, 'highpass', 5000, 12000, 0.35, 1, 0.001)
    this.ring(o, t, 1800 + (i % 7) * 140, [1, 1.47, 2.1], 0.4, 0.05)
  }

  /** The blade sliding home, and the click of the guard against the scabbard `delay` seconds later. */
  sheathe(delay = 0.42) {
    if (!this.ctx) return
    const o = this.out(undefined, 0.8)!
    const t = this.ctx.currentTime
    if (delay > 0.05) this.burst(o, t, delay - 0.02, 'bandpass', 1200, 4000, 0.15, 3, Math.min(0.3, delay * 0.7))
    this.ring(o, t + delay, 2600, [1, 1.33, 2.6], 0.5, 0.12)
    this.burst(o, t + delay, 0.03, 'highpass', 3000, 8000, 0.6, 1, 0.001)
  }

  // -------------------------------------------------------------------------
  // The battlefield
  // -------------------------------------------------------------------------

  /** Soldiers cut down (aggregated). */
  felled(pos: Vec, count: number) {
    if (!this.ctx || !this.allow('felled', 0.05)) return
    const o = this.out(pos, 0.25, 15)
    if (!o) return
    const t = this.ctx.currentTime
    const k = Math.min(1, 0.3 + count * 0.08)
    this.tone(o, 'sine', 140, 50, t, 0.18, 0.6 * k)
    this.burst(o, t, 0.1, 'bandpass', 1800, 600, 0.45 * k, 1.4, 0.002)
    for (let i = 0; i < Math.min(6, count); i++) this.ring(o, t + Math.random() * 0.08, rnd(900, 1600), [1, 1.6], 0.2, 0.03)
  }

  spearHit() {
    if (!this.ctx || !this.allow('spear', 0.07)) return
    const o = this.out(undefined, 0.1)!
    const t = this.ctx.currentTime
    this.burst(o, t, 0.06, 'bandpass', 2400, 1200, 0.3, 2, 0.002)
    this.tone(o, 'sine', 180, 80, t, 0.08, 0.25)
  }

  volley(pos: Vec) {
    if (!this.ctx || !this.allow('volley', 0.3)) return
    const o = this.out(pos, 0.3, 40)
    if (!o) return
    const t = this.ctx.currentTime
    for (let i = 0; i < 24; i++) this.burst(o, t + Math.random() * 0.5, 0.06, 'bandpass', rnd(600, 1400), 300, 0.12, 4, 0.002)
  }

  arrowsIncoming() {
    if (!this.ctx || !this.allow('arrowsin', 0.8)) return
    const o = this.out(undefined, 0.3)!
    const t = this.ctx.currentTime
    for (let i = 0; i < 10; i++) this.burst(o, t + Math.random() * 0.5, 0.35, 'bandpass', rnd(3000, 5000), 1500, 0.06, 6, 0.15)
  }

  arrowHit(pos: Vec) {
    if (!this.ctx || !this.allow('arrowhit', 0.03)) return
    const o = this.out(pos, 0.05, 6, 60)
    if (!o) return
    const t = this.ctx.currentTime
    this.burst(o, t, 0.04, 'bandpass', rnd(1500, 2500), 800, 0.25, 2, 0.001)
  }

  cannon(pos: Vec) {
    if (!this.ctx) return
    const o = this.out(pos, 0.5, 60, 900)
    if (!o) return
    const delay = Math.min(0.6, this.dist(pos) / 340 * 0.5)
    const t = this.ctx.currentTime + delay
    this.tone(o, 'sine', 70, 28, t, 0.9, 1)
    this.burst(o, t, 0.8, 'lowpass', 1500, 70, 0.9, 0.7, 0.002)
  }

  whistle(pos: Vec, dur = 1.2) {
    if (!this.ctx || !this.allow('whistle', 0.15)) return
    const o = this.out(pos, 0.1, 30, 200)
    if (!o) return
    const t = this.ctx.currentTime
    this.tone(o, 'sine', 1800, 700, t, dur, 0.07, 0.3)
  }

  missileLaunch(pos: Vec) {
    if (!this.ctx || !this.allow('mlaunch', 0.08)) return
    const o = this.out(pos, 0.3, 40, 600)
    if (!o) return
    const t = this.ctx.currentTime
    this.burst(o, t, 0.9, 'bandpass', 900, 2500, 0.5, 1, 0.02)
    this.tone(o, 'sawtooth', 90, 140, t, 0.8, 0.04)
  }

  /** Duck the music under a huge boom: down by `amount` (0..1) almost at once, back up over `dur` seconds. */
  duck(amount: number, dur = 2, delay = 0) {
    if (!this.ctx) return
    const t = this.ctx.currentTime + delay
    const g = this.duckGain.gain
    const to = Math.max(0.04, 1 - Math.min(0.96, amount))
    const cur = Math.max(0.04, g.value)
    // a deeper duck already playing is never lifted early
    if (to >= cur && t < this.duckUntil) return
    g.cancelScheduledValues(t)
    g.setValueAtTime(cur, t)
    g.linearRampToValueAtTime(Math.min(cur, to), t + 0.05)
    g.setTargetAtTime(1, t + 0.05 + dur * 0.3, dur * 0.25)
    this.duckUntil = t + dur * 0.5
  }

  private duckUntil = 0

  /**
   * Ears ringing after a near blast: the world muffles to a thud, a thin tone
   * sings over it, and the sound comes back over `sec` seconds. `level` 0..1
   * scales how deaf.
   */
  deafen(sec = 2, level = 1) {
    if (!this.ctx || !this.allow('deafen', 0.4)) return
    const ctx = this.ctx
    const t = ctx.currentTime
    const k = Math.min(1, Math.max(0.1, level))
    const f = this.deafFilter.frequency
    const low = 220 + (1 - k) * 2200
    f.cancelScheduledValues(t)
    f.setValueAtTime(Math.min(Math.max(low, f.value), 20000), t)
    f.exponentialRampToValueAtTime(low, t + 0.03)
    f.setValueAtTime(low, t + sec * 0.3)
    f.exponentialRampToValueAtTime(20000, t + sec)
    // the ringing is in the ears, not the world: straight to the master, past the muffle
    const g = ctx.createGain()
    g.connect(this.master)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.022 * k, t + 0.08)
    g.gain.setValueAtTime(0.022 * k, t + sec * 0.4)
    g.gain.exponentialRampToValueAtTime(0.0001, t + sec * 1.15)
    const base = rnd(6200, 7400)
    for (const [m, a] of [
      [1, 1],
      [1.0035, 0.6],
    ] as const) {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.setValueAtTime(base * m, t)
      o.frequency.exponentialRampToValueAtTime(base * m * 0.94, t + sec * 1.15)
      const og = ctx.createGain()
      og.gain.value = a
      o.connect(og).connect(g)
      o.start(t)
      o.stop(t + sec * 1.2)
    }
    this.duck(0.9 * k, sec * 1.1)
  }

  /** The flash-step breaks the sound barrier: the double crack of an N-wave, a thump, the boom rolling off. `big` for a chain. */
  sonicBoom(big = false) {
    if (!this.ctx || !this.allow('sboom', 0.06)) return
    const o = this.out(undefined, big ? 0.7 : 0.35)!
    const t = this.ctx.currentTime
    const k = big ? 1.4 : 1
    this.wide(o, big ? 0.7 : 0.25)
    this.burst(o, t, 0.025, 'highpass', 1800, 6000, 0.75 * k, 0.7, 0.0005)
    this.burst(o, t + 0.075, 0.03, 'highpass', 1500, 5000, 0.6 * k, 0.7, 0.0005)
    this.tone(o, 'sine', 95, 30, t, 0.28 * k, 0.8, 0.002)
    this.burst(o, t + 0.01, 0.5 * k, 'lowpass', 1400, 60, 0.45 * k, 0.7, 0.008)
    if (big) {
      this.tone(o, 'sine', 48, 20, t + 0.02, 1.4, 0.8, 0.01)
      this.burst(o, t + 0.2, 1.6, 'lowpass', 500, 35, 0.35, 0.5, 0.05)
    }
  }

  /** Send a sound into the wide outdoor space too (explosions, big hits). */
  private wide(o: AudioNode, amount: number) {
    if (!this.bigSend || amount <= 0) return
    const s = this.ctx!.createGain()
    s.gain.value = amount
    o.connect(s).connect(this.bigSend)
  }

  /**
   * A wide outdoor space, generated: a short pre-delay, a diffuse tail whose
   * highs die first (a running low-pass that closes as it decays), and late
   * slap-backs off far ridges, offset left and right so the space is wide.
   */
  private makeWideImpulse(seconds: number) {
    const ctx = this.ctx!
    const rate = ctx.sampleRate
    const len = Math.floor(rate * seconds)
    const buf = ctx.createBuffer(2, len, rate)
    const pre = Math.floor(rate * 0.035)
    const echoes = [0.42, 0.97, 1.65, 2.6, 3.7]
    for (let c = 0; c < 2; c++) {
      const ch = buf.getChannelData(c)
      let y = 0
      for (let i = pre; i < len; i++) {
        const t = (i - pre) / rate
        const env = Math.exp(-t / 1.25) * Math.min(1, t / 0.06)
        // the low-pass closes as the tail decays: from bright to a distant roar
        const a = 0.75 * Math.exp(-t * 1.6) + 0.025
        y += a * ((Math.random() * 2 - 1) - y)
        ch[i] = y * env * 1.6
      }
      for (const [j, e] of echoes.entries()) {
        const at = Math.floor(rate * (e + (c ? 0.023 : -0.017) * (j + 1)))
        const n = Math.floor(rate * (0.25 + j * 0.12))
        const amp = 0.38 * Math.pow(0.62, j)
        let z = 0
        for (let i = 0; i < n && at + i < len; i++) {
          z += 0.08 * ((Math.random() * 2 - 1) - z)
          ch[at + i] += z * amp * 3 * Math.exp(-i / (rate * 0.12)) * Math.min(1, i / (rate * 0.02))
        }
      }
    }
    return buf
  }

  explosion(pos: Vec, size: number) {
    if (!this.ctx || !this.allow(`ex${Math.round(size)}`, 0.03)) return
    const o = this.out(pos, 0.5 + Math.min(0.6, size * 0.03), 18 + size * 6, 1400)
    if (!o) return
    const d = this.dist(pos)
    const delay = d > 60 ? Math.min(1.8, (d / 340) * 0.5) : 0
    const t = this.ctx.currentTime + delay
    const s = Math.min(4, Math.sqrt(size))
    this.wide(o, Math.min(0.9, 0.15 + size * 0.03))
    if (size >= 14) this.duck(Math.min(0.75, size / 50), 1 + Math.min(3, size * 0.04), delay)
    this.burst(o, t, 0.12 + s * 0.05, 'lowpass', 7000, 300, 0.9, 0.7, 0.001)
    this.tone(o, 'sine', 100 / s, 22, t, 0.5 + s * 0.4, 1)
    this.burst(o, t + 0.02, 1 + s * 0.8, 'lowpass', 700, 45, 0.8, 0.6, 0.02)
    for (let i = 0; i < 4 + s * 3; i++) this.burst(o, t + 0.1 + Math.random() * (0.6 + s * 0.4), 0.05, 'highpass', rnd(1500, 4000), 1200, 0.1, 1)
  }

  siren(): LoopHandle {
    if (!this.ctx) return NOOP
    const ctx = this.ctx
    const t = ctx.currentTime
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.6)
    g.connect(this.sfx)
    const send = ctx.createGain()
    send.gain.value = 0.6
    g.connect(send).connect(this.reverbSend)
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 900
    bp.Q.value = 0.8
    bp.connect(g)
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.35
    const lg = ctx.createGain()
    lg.gain.value = 180
    lfo.connect(lg)
    const oscs: OscillatorNode[] = []
    for (const [type, f] of [
      ['sawtooth', 620],
      ['square', 623],
    ] as const) {
      const o = ctx.createOscillator()
      o.type = type
      o.frequency.value = f
      lg.connect(o.frequency)
      o.connect(bp)
      o.start()
      oscs.push(o)
    }
    lfo.start()
    let stopped = false
    return {
      set: (level) => g.gain.setTargetAtTime(0.12 * level, ctx.currentTime, 0.1),
      stop: (fade = 0.6) => {
        if (stopped) return
        stopped = true
        const now = ctx.currentTime
        g.gain.cancelScheduledValues(now)
        g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), now)
        g.gain.exponentialRampToValueAtTime(0.0001, now + fade)
        for (const o of oscs) o.stop(now + fade + 0.05)
        lfo.stop(now + fade + 0.05)
      },
    }
  }

  nukeLaunch(pos: Vec) {
    if (!this.ctx) return
    const o = this.out(pos, 0.6, 200, 3000)
    if (!o) return
    const t = this.ctx.currentTime + 0.8
    this.burst(o, t, 3, 'lowpass', 600, 80, 0.8, 0.6, 0.3)
    this.tone(o, 'sine', 40, 30, t, 3, 0.6, 0.3)
  }

  /** The flash: a pressure thump, then near silence before the shock arrives. */
  nukeFlash() {
    if (!this.ctx) return
    const o = this.out(undefined, 1)!
    const t = this.ctx.currentTime
    this.wide(o, 0.6)
    this.duck(0.85, 3)
    this.tone(o, 'sine', 45, 20, t, 1.2, 0.9)
    this.burst(o, t, 1.6, 'highpass', 6000, 1500, 0.25, 0.7, 0.01)
    this.choir(o, t, [146.8, 220, 293.7], 3.5, 0.03, 0.3)
  }

  /** The shockwave arrives. */
  nukeShock() {
    if (!this.ctx) return
    const o = this.out(undefined, 1)!
    const t = this.ctx.currentTime
    this.wide(o, 0.9)
    this.duck(0.8, 4)
    this.burst(o, t, 0.25, 'lowpass', 9000, 500, 1, 0.7, 0.001)
    this.tone(o, 'sine', 50, 16, t, 4, 1)
    this.burst(o, t, 7, 'lowpass', 500, 30, 1, 0.5, 0.05)
    for (let i = 0; i < 40; i++) this.burst(o, t + Math.random() * 5, 0.07, 'bandpass', rnd(600, 3000), 400, 0.15, 1.5)
    this.rumble(1, 8)
  }

  /** A sustained ground rumble on the ambience bus. */
  rumble(level: number, dur: number) {
    if (!this.ctx) return
    const t = this.ctx.currentTime
    this.rumbleGain.gain.cancelScheduledValues(t)
    this.rumbleGain.gain.setTargetAtTime(0.5 * level, t, 0.1)
    this.rumbleGain.gain.setTargetAtTime(0, t + dur * 0.5, dur * 0.3)
  }

  laserCharge(pos?: Vec) {
    if (!this.ctx) return
    const o = this.out(pos, 0.5, 300, 4000) ?? this.out(undefined, 0.5)!
    const t = this.ctx.currentTime
    this.tone(o, 'sine', 200, 1800, t, 2.4, 0.08, 1.5)
    this.tone(o, 'sawtooth', 50, 220, t, 2.4, 0.04, 1.5)
    this.burst(o, t, 2.4, 'bandpass', 500, 7000, 0.15, 5, 1.8)
  }

  /** A sustained beam; set(level, pos) to move it. */
  beam(color: 'gold' | 'red' = 'red'): LoopHandle {
    if (!this.ctx) return NOOP
    const ctx = this.ctx
    const t = ctx.currentTime
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.1)
    const pan = ctx.createStereoPanner()
    g.connect(pan).connect(this.sfx)
    const send = ctx.createGain()
    send.gain.value = 0.5
    g.connect(send).connect(this.reverbSend)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = color === 'gold' ? 3200 : 1800
    lp.connect(g)
    const oscs: AudioScheduledSourceNode[] = []
    const base = color === 'gold' ? 82 : 55
    for (const m of [1, 2.01, 3.98, 6.02]) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = base * m
      const og = ctx.createGain()
      og.gain.value = 0.12 / m
      o.connect(og).connect(lp)
      o.start()
      oscs.push(o)
    }
    const n = ctx.createBufferSource()
    n.buffer = this.noise
    n.loop = true
    const nf = ctx.createBiquadFilter()
    nf.type = 'bandpass'
    nf.frequency.value = 2400
    nf.Q.value = 0.7
    const ng = ctx.createGain()
    ng.gain.value = 0.4
    n.connect(nf).connect(ng).connect(g)
    n.start()
    oscs.push(n)
    const trem = ctx.createOscillator()
    trem.frequency.value = 23
    const tg = ctx.createGain()
    tg.gain.value = 0.08
    trem.connect(tg).connect(g.gain)
    trem.start()
    oscs.push(trem)
    let stopped = false
    return {
      set: (level, pos) => {
        if (stopped) return
        let att = 1
        if (pos) {
          const d = this.dist(pos)
          att = 1 / (1 + Math.pow(d / 80, 2) * 0.35)
          const yaw = this.listener.yaw
          const p = d > 0.1 ? ((pos.x - this.listener.x) * -Math.cos(yaw) + (pos.z - this.listener.z) * Math.sin(yaw)) / Math.max(1, d) : 0
          pan.pan.setTargetAtTime(Math.max(-0.8, Math.min(0.8, p)), ctx.currentTime, 0.05)
        }
        g.gain.setTargetAtTime(0.35 * level * att, ctx.currentTime, 0.05)
      },
      stop: (fade = 0.3) => {
        if (stopped) return
        stopped = true
        const now = ctx.currentTime
        g.gain.cancelScheduledValues(now)
        g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), now)
        g.gain.exponentialRampToValueAtTime(0.0001, now + fade)
        for (const o of oscs) o.stop(now + fade + 0.05)
      },
    }
  }

  titanStep(pos: Vec) {
    if (!this.ctx) return
    const o = this.out(pos, 0.5, 60, 900)
    if (!o) return
    const t = this.ctx.currentTime
    this.tone(o, 'sine', 55, 22, t, 0.9, 1)
    this.burst(o, t, 0.7, 'lowpass', 900, 50, 0.8, 0.6, 0.003)
    for (let i = 0; i < 5; i++) this.burst(o, t + 0.05 + Math.random() * 0.5, 0.05, 'bandpass', rnd(800, 2400), 600, 0.12, 2)
  }

  roar(pos: Vec, pitch = 1) {
    if (!this.ctx) return
    const ctx = this.ctx
    const o = this.out(pos, 0.8, 120, 2000)
    if (!o) return
    const t = ctx.currentTime
    const dur = 2.6
    const shaper = ctx.createWaveShaper()
    const curve = new Float32Array(1024)
    for (let i = 0; i < 1024; i++) curve[i] = Math.tanh(((i / 1023) * 2 - 1) * 4)
    shaper.curve = curve
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.3)
    g.gain.setValueAtTime(0.5, t + dur - 0.7)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = 800
    shaper.connect(f).connect(g).connect(o)
    for (const base of [38, 57, 76]) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(base * 1.3 * pitch, t)
      osc.frequency.linearRampToValueAtTime(base * pitch, t + 0.5)
      osc.frequency.linearRampToValueAtTime(base * 0.75 * pitch, t + dur)
      const lfo = ctx.createOscillator()
      lfo.frequency.value = rnd(5, 9)
      const lg = ctx.createGain()
      lg.gain.value = base * 0.07
      lfo.connect(lg).connect(osc.frequency)
      osc.connect(shaper)
      osc.start(t)
      lfo.start(t)
      osc.stop(t + dur + 0.1)
      lfo.stop(t + dur + 0.1)
    }
    this.burst(o, t, dur, 'bandpass', 400, 250, 0.35, 2, 0.25)
  }

  heavySwing(pos: Vec) {
    if (!this.ctx) return
    const o = this.out(pos, 0.4, 60, 600)
    if (!o) return
    const t = this.ctx.currentTime
    this.burst(o, t, 0.9, 'bandpass', 120, 700, 0.9, 1.2, 0.35)
  }

  meteor(pos: Vec) {
    if (!this.ctx || !this.allow('meteor', 0.2)) return
    const o = this.out(pos, 0.4, 80, 1500)
    if (!o) return
    const t = this.ctx.currentTime
    this.burst(o, t, 2.2, 'bandpass', 300, 1800, 0.35, 1, 1.5)
    this.tone(o, 'sawtooth', 70, 160, t, 2.2, 0.04, 1.5)
  }

  warHorn() {
    if (!this.ctx) return
    const ctx = this.ctx
    const o = this.out({ x: this.listener.x, z: this.listener.z - 200 }, 1, 400, 5000) ?? this.out(undefined, 1)!
    const t = ctx.currentTime
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(300, t)
    lp.frequency.linearRampToValueAtTime(1400, t + 0.6)
    lp.frequency.linearRampToValueAtTime(700, t + 3)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.4)
    g.gain.setValueAtTime(0.3, t + 2.4)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.4)
    lp.connect(g).connect(o)
    for (const [f, det] of [
      [73.4, -6],
      [73.4, 6],
      [110, 0],
      [146.8, 3],
    ] as const) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(f * 0.94, t)
      osc.frequency.linearRampToValueAtTime(f, t + 0.3)
      osc.detune.value = det
      const vib = ctx.createOscillator()
      vib.frequency.value = 5
      const vg = ctx.createGain()
      vg.gain.value = f * 0.006
      vib.connect(vg).connect(osc.frequency)
      osc.connect(lp)
      osc.start(t)
      vib.start(t)
      osc.stop(t + 3.5)
      vib.stop(t + 3.5)
    }
  }

  skySplit() {
    if (!this.ctx) return
    const o = this.out(undefined, 1.2)!
    const t = this.ctx.currentTime
    this.burst(o, t, 0.2, 'highpass', 3000, 12000, 1, 1, 0.001)
    this.ring(o, t, 440, [1, 1.5, 2, 2.5, 3, 4, 5], 6, 0.15)
    this.choir(o, t + 0.2, [146.8, 220, 293.7, 370, 440, 587.3], 6, 0.08, 1.5)
    this.tone(o, 'sine', 60, 20, t, 4, 1)
  }

  // -------------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------------

  ui(kind: 'move' | 'confirm' | 'back' | 'error') {
    if (!this.ctx) return
    const o = this.out(undefined, 0.2)!
    const t = this.ctx.currentTime
    if (kind === 'move') this.tone(o, 'triangle', 1400, 1300, t, 0.05, 0.05)
    else if (kind === 'confirm') {
      this.ring(o, t, 880, [1, 1.5, 2], 0.6, 0.06)
      this.burst(o, t, 0.08, 'highpass', 4000, 9000, 0.15, 1, 0.001)
    } else if (kind === 'back') this.tone(o, 'triangle', 700, 500, t, 0.12, 0.06)
    else this.tone(o, 'square', 140, 120, t, 0.12, 0.05)
  }

  stamp(big: boolean) {
    if (!this.ctx) return
    const o = this.out(undefined, 0.3)!
    const t = this.ctx.currentTime
    this.tone(o, 'sine', big ? 90 : 140, 40, t, 0.25, big ? 0.6 : 0.35)
    this.burst(o, t, 0.08, 'lowpass', 4000, 500, big ? 0.5 : 0.3, 0.8, 0.001)
  }

  rankUp(rank: number) {
    if (!this.ctx) return
    const o = this.out(undefined, 0.6)!
    const t = this.ctx.currentTime
    const notes = [293.7, 370, 440, 587.3, 740, 880, 1174.7]
    for (let i = 0; i <= Math.min(rank, 6); i++) this.ring(o, t + i * 0.035, notes[i], [1, 2.01], 0.7, 0.05)
  }

  victory() {
    if (!this.ctx) return
    const o = this.out(undefined, 1)!
    const t = this.ctx.currentTime
    this.choir(o, t, [146.8, 220, 293.7, 370, 440], 6, 0.08, 1)
    this.ring(o, t, 587.3, [1, 2, 3, 4.2], 5, 0.1)
  }

  defeat() {
    if (!this.ctx) return
    const o = this.out(undefined, 0.9)!
    const t = this.ctx.currentTime
    this.tone(o, 'sine', 55, 28, t, 3.5, 0.9, 0.01)
    for (const f of [73.4, 87.3, 103.8]) this.tone(o, 'sawtooth', f, f * 0.97, t + 0.3, 3, 0.04, 0.8)
  }

  // -------------------------------------------------------------------------
  // Ambience
  // -------------------------------------------------------------------------

  private startAmbience() {
    const ctx = this.ctx!
    const wind = ctx.createBufferSource()
    wind.buffer = this.noise
    wind.loop = true
    this.windFilter = ctx.createBiquadFilter()
    this.windFilter.type = 'bandpass'
    this.windFilter.frequency.value = 400
    this.windFilter.Q.value = 0.6
    this.windGain = ctx.createGain()
    this.windGain.gain.value = 0.1
    wind.connect(this.windFilter).connect(this.windGain).connect(this.amb)
    wind.start()
    const rum = ctx.createBufferSource()
    rum.buffer = this.noise
    rum.loop = true
    const rf = ctx.createBiquadFilter()
    rf.type = 'lowpass'
    rf.frequency.value = 90
    this.rumbleGain = ctx.createGain()
    this.rumbleGain.gain.value = 0
    rum.connect(rf).connect(this.rumbleGain).connect(this.amb)
    rum.start()
  }

  /** Per-frame ambience update. */
  update(windiness: number) {
    if (!this.ctx) return
    const t = this.ctx.currentTime
    const wob = 0.5 + 0.5 * Math.sin(t * 0.21) * Math.sin(t * 0.13 + 1)
    this.windFilter.frequency.setTargetAtTime(250 + wob * 500 + windiness * 600, t, 0.5)
    this.windGain.gain.setTargetAtTime(0.05 + wob * 0.08 + windiness * 0.25, t, 0.3)
  }

  // -------------------------------------------------------------------------
  // The mountains (call when the sound arrives: the distance delay is the caller's)
  // -------------------------------------------------------------------------

  /** A mountain face blown open kilometres away: distance has eaten the crack, leaving a deep, rolling boom. */
  mountainBoom(pos: Vec, size = 1) {
    if (!this.ctx || !this.allow('mtnBoom', 0.15)) return
    const o = this.out(pos, 1.2, 900, 8000) ?? this.out(undefined, 1.2)!
    const t = this.ctx.currentTime
    const s = Math.min(2, Math.max(0.3, size))
    this.wide(o, 0.5 * s)
    this.burst(o, t, 0.35, 'lowpass', 1800, 200, 0.7 * s, 0.7, 0.01)
    this.tone(o, 'sine', 46, 17, t, 3 + s * 1.5, 0.9 * Math.min(1, s), 0.02)
    this.burst(o, t + 0.05, 5 + s * 3, 'lowpass', 420, 28, 0.9, 0.5, 0.08)
    // the echo off the other ridges
    this.burst(o, t + 1.1, 3, 'lowpass', 300, 40, 0.35 * s, 0.5, 0.3)
    this.rumble(Math.min(1, 0.6 * s), 6 + s * 2)
  }

  /** A mountaintop sheared off by the Heaven Splitter: a cracking shear and a long grinding fall. */
  mountainCleave(pos: Vec, size = 1) {
    if (!this.ctx || !this.allow('mtnCleave', 0.2)) return
    const o = this.out(pos, 1.2, 900, 8000) ?? this.out(undefined, 1.2)!
    const t = this.ctx.currentTime
    const s = Math.min(2, Math.max(0.3, size))
    this.burst(o, t, 0.12, 'bandpass', 1400, 500, 0.5 * s, 1.2, 0.002)
    this.tone(o, 'sine', 60, 22, t, 2.5 + s, 0.7 * Math.min(1, s), 0.01)
    this.burst(o, t + 0.1, 4 + s * 2, 'lowpass', 600, 40, 0.75, 0.6, 0.2)
    for (let i = 0; i < 6; i++) this.burst(o, t + 0.15 + i * rnd(0.12, 0.3), 0.18, 'lowpass', rnd(500, 900), 120, 0.25, 1)
    this.rumble(Math.min(1, 0.5 * s), 5 + s * 2)
  }

  /** Rock pouring down a slope far away: a gravel roar with boulders knocking in it. */
  rockslide(pos: Vec, dur = 5, level = 1) {
    if (!this.ctx || !this.allow('rockslide', 0.3)) return
    const o = this.out(pos, 1, 900, 8000) ?? this.out(undefined, 1)!
    const t = this.ctx.currentTime
    const l = Math.min(1.5, Math.max(0.2, level))
    this.burst(o, t + 0.2, dur, 'lowpass', 700, 90, 0.3 * l, 0.6, dur * 0.25)
    const n = Math.round(10 + dur * 4)
    for (let i = 0; i < n; i++) {
      const at = t + 0.3 + Math.random() * dur * 0.9
      this.burst(o, at, rnd(0.08, 0.25), 'bandpass', rnd(120, 420), 80, rnd(0.1, 0.3) * l, 2)
      if (Math.random() < 0.3) this.tone(o, 'sine', rnd(55, 90), 30, at, 0.3, 0.12 * l)
    }
  }
}

export const audio = new AudioEngine()
