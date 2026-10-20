/**
 * Fully procedural audio: every sound is synthesized with WebAudio at runtime.
 */

type Vec = { x: number; y?: number; z: number }

const rnd = (a: number, b: number) => a + Math.random() * (b - a)

class AudioEngine {
  ctx: AudioContext | null = null
  private master!: GainNode
  private sfx!: GainNode
  private musicBus!: GainNode
  private amb!: GainNode
  private reverb!: ConvolverNode
  private reverbSend!: GainNode
  private noise!: AudioBuffer
  private comp!: DynamicsCompressorNode
  private listener = { x: 0, z: 0, yaw: 0 }
  private windGain!: GainNode
  private windFilter!: BiquadFilterNode
  private fireGain!: GainNode
  private droneGain!: GainNode
  private crackleTimer = 0
  private bellTimer = 0
  volume = 0.8
  musicVolume = 0.7
  private music: BossMusic | null = null
  titleMode = false

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = new AC()
    this.ctx = ctx
    this.comp = ctx.createDynamicsCompressor()
    this.comp.threshold.value = -14
    this.comp.ratio.value = 4
    this.comp.knee.value = 8
    this.master = ctx.createGain()
    this.master.gain.value = this.volume
    this.master.connect(this.comp).connect(ctx.destination)
    this.sfx = ctx.createGain()
    this.sfx.connect(this.master)
    this.musicBus = ctx.createGain()
    this.musicBus.gain.value = this.musicVolume
    this.musicBus.connect(this.master)
    this.amb = ctx.createGain()
    this.amb.gain.value = 0.9
    this.amb.connect(this.master)

    // shared reverb (generated impulse response: a big stone hall)
    this.reverb = ctx.createConvolver()
    this.reverb.buffer = this.makeImpulse(3.8, 2.4)
    this.reverbSend = ctx.createGain()
    this.reverbSend.gain.value = 0.55
    this.reverbSend.connect(this.reverb).connect(this.master)

    const len = ctx.sampleRate * 2
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = this.noise.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1

    this.startAmbience()
  }

  setVolume(master: number, music: number) {
    this.volume = master
    this.musicVolume = music
    if (!this.ctx) return
    this.master.gain.setTargetAtTime(master, this.ctx.currentTime, 0.05)
    this.musicBus.gain.setTargetAtTime(music, this.ctx.currentTime, 0.05)
  }

  setListener(x: number, z: number, yaw: number) {
    this.listener.x = x
    this.listener.z = z
    this.listener.yaw = yaw
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

  /** Output node for a sound at a world position: distance attenuation + stereo pan. */
  private out(pos?: Vec, wet = 0.25, maxDist = 40): AudioNode | null {
    const ctx = this.ctx!
    const g = ctx.createGain()
    if (pos) {
      const dx = pos.x - this.listener.x
      const dz = pos.z - this.listener.z
      const dist = Math.hypot(dx, dz)
      if (dist > maxDist) return null
      const att = 1 / (1 + (dist / 6) ** 2 * 0.5)
      g.gain.value = att
      // listener's right vector for yaw (camera looks along (sin yaw, cos yaw))
      const yaw = this.listener.yaw
      const rx = -Math.cos(yaw)
      const rz = Math.sin(yaw)
      const pan = dist > 0.01 ? Math.max(-1, Math.min(1, (dx * rx + dz * rz) / dist)) * 0.75 : 0
      const p = ctx.createStereoPanner()
      p.pan.value = pan
      g.connect(p).connect(this.sfx)
      wet *= 1 + Math.min(1, dist / 20)
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

  private noiseSrc(duration: number) {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    src.loop = true
    src.loopStart = Math.random()
    src.start(ctx.currentTime, Math.random() * 1.5)
    src.stop(ctx.currentTime + duration + 0.05)
    return src
  }

  private env(g: GainNode, t0: number, a: number, peak: number, d: number) {
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + a)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d)
  }

  private tone(
    out: AudioNode,
    type: OscillatorType,
    f0: number,
    f1: number,
    t0: number,
    dur: number,
    peak: number,
    attack = 0.005,
  ) {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.setValueAtTime(f0, t0)
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur)
    const g = ctx.createGain()
    this.env(g, t0, attack, peak, dur)
    o.connect(g).connect(out)
    o.start(t0)
    o.stop(t0 + attack + dur + 0.05)
    return o
  }

  private burst(out: AudioNode, t0: number, dur: number, type: BiquadFilterType, f0: number, f1: number, peak: number, q = 1, attack = 0.004) {
    const ctx = this.ctx!
    const src = this.noiseSrc(dur + attack + 0.05)
    const f = ctx.createBiquadFilter()
    f.type = type
    f.Q.value = q
    f.frequency.setValueAtTime(f0, t0)
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + attack + dur)
    const g = ctx.createGain()
    this.env(g, t0, attack, peak, dur)
    src.connect(f).connect(g).connect(out)
  }

  // -------------------------------------------------------------------------
  // Combat
  // -------------------------------------------------------------------------

  swing(kind: 'light' | 'heavy' | 'boss' | 'enemy', pos?: Vec) {
    if (!this.ctx) return
    const o = this.out(pos, 0.15)
    if (!o) return
    const t = this.ctx.currentTime
    if (kind === 'boss') {
      this.burst(o, t, 0.55, 'bandpass', 160, 900, 0.9, 1.2, 0.18)
      this.burst(o, t + 0.05, 0.4, 'lowpass', 300, 80, 0.5, 0.7, 0.12)
    } else if (kind === 'heavy') {
      this.burst(o, t, 0.32, 'bandpass', 300, 1800, 0.65, 1.6, 0.08)
    } else {
      const f = kind === 'enemy' ? rnd(500, 700) : rnd(700, 950)
      this.burst(o, t, 0.2, 'bandpass', f, f * 3.2, 0.55, 2.2, 0.05)
    }
  }

  hit(kind: 'flesh' | 'armor' | 'boss' | 'player', pos?: Vec, heavy = false) {
    if (!this.ctx) return
    const o = this.out(pos, 0.3)
    if (!o) return
    const t = this.ctx.currentTime
    const k = heavy ? 1.4 : 1
    // body thump
    this.tone(o, 'sine', 140 * (heavy ? 0.8 : 1), 45, t, 0.22 * k, 0.9)
    this.burst(o, t, 0.12 * k, 'lowpass', 2400, 300, 0.7)
    if (kind === 'flesh' || kind === 'player') {
      this.burst(o, t + 0.01, 0.16, 'bandpass', 900, 400, 0.5, 2)
    }
    if (kind === 'armor' || kind === 'boss') {
      const base = kind === 'boss' ? 380 : 620
      const partials = [1, 1.59, 2.31, 3.17, 4.2]
      for (const p of partials) this.tone(o, 'sine', base * p * rnd(0.98, 1.02), base * p, t, rnd(0.25, 0.5), 0.12)
    }
    if (kind === 'player') this.tone(o, 'triangle', 90, 50, t, 0.3, 0.5)
  }

  parry(pos?: Vec) {
    if (!this.ctx) return
    const o = this.out(pos, 0.7)
    if (!o) return
    const t = this.ctx.currentTime
    const partials = [1, 1.52, 2.21, 2.98, 3.83, 5.1]
    for (const p of partials) this.tone(o, 'sine', 980 * p, 980 * p * 0.995, t, rnd(0.8, 1.4), 0.16)
    this.burst(o, t, 0.08, 'highpass', 3000, 6000, 0.6)
    this.tone(o, 'sine', 200, 60, t, 0.3, 0.6)
  }

  guardBreak(pos?: Vec) {
    if (!this.ctx) return
    const o = this.out(pos, 0.5)
    if (!o) return
    const t = this.ctx.currentTime
    this.tone(o, 'sawtooth', 160, 60, t, 0.5, 0.25)
    this.burst(o, t, 0.4, 'bandpass', 1200, 200, 0.6, 1.5)
  }

  footstep(pos: Vec, stone: boolean, armored: boolean, heavy = 1) {
    if (!this.ctx) return
    const o = this.out(pos, 0.06, 25)
    if (!o) return
    const t = this.ctx.currentTime
    const v = 0.22 * heavy
    if (heavy > 1.5) {
      this.tone(o, 'sine', 70, 30, t, 0.35, v * 0.9)
      this.burst(o, t, 0.25, 'lowpass', 600, 100, v * 0.6)
      return
    }
    if (stone) this.burst(o, t, 0.05, 'bandpass', rnd(1400, 1900), 700, v, 1.4, 0.002)
    else this.burst(o, t, 0.09, 'lowpass', rnd(700, 900), 200, v * 1.3, 0.8, 0.004)
    this.tone(o, 'sine', 95, 50, t, 0.07, v * 0.5)
    if (armored) {
      // chain mail jingle
      this.burst(o, t + 0.015, 0.06, 'highpass', 6500, 9000, v * 0.25, 1, 0.003)
    }
  }

  roll(pos?: Vec) {
    if (!this.ctx) return
    const o = this.out(pos, 0.08)
    if (!o) return
    const t = this.ctx.currentTime
    this.burst(o, t, 0.32, 'bandpass', 500, 1300, 0.35, 0.9, 0.06)
    this.burst(o, t + 0.28, 0.12, 'lowpass', 900, 150, 0.6)
    this.tone(o, 'sine', 110, 50, t + 0.28, 0.12, 0.4)
    this.burst(o, t + 0.3, 0.08, 'highpass', 6000, 9000, 0.12)
  }

  slam(pos: Vec, size = 1) {
    if (!this.ctx) return
    const o = this.out(pos, 0.5, 80)
    if (!o) return
    const t = this.ctx.currentTime
    this.tone(o, 'sine', 80 * (1 / size), 25, t, 0.9 * size, 1.0)
    this.burst(o, t, 0.6 * size, 'lowpass', 1800, 60, 0.9, 0.7)
    for (let i = 0; i < 6; i++) this.burst(o, t + 0.05 + Math.random() * 0.4, 0.05, 'bandpass', rnd(1500, 3500), 800, 0.15, 2)
  }

  nova(pos: Vec) {
    if (!this.ctx) return
    const o = this.out(pos, 0.6, 90)
    if (!o) return
    const t = this.ctx.currentTime
    this.burst(o, t, 1.6, 'lowpass', 3000, 80, 1.0, 0.6, 0.02)
    this.tone(o, 'sine', 60, 22, t, 1.4, 1.0)
    this.tone(o, 'sawtooth', 110, 40, t, 0.9, 0.18)
    for (let i = 0; i < 18; i++) this.burst(o, t + Math.random() * 1.2, 0.03, 'highpass', rnd(2000, 5000), 2000, 0.18)
  }

  novaCharge(pos: Vec) {
    if (!this.ctx) return
    const o = this.out(pos, 0.5, 90)
    if (!o) return
    const t = this.ctx.currentTime
    this.burst(o, t, 1.5, 'bandpass', 200, 2400, 0.35, 3, 1.2)
    this.tone(o, 'sawtooth', 50, 120, t, 1.5, 0.1, 1.2)
  }

  roar(pos: Vec) {
    if (!this.ctx) return
    const ctx = this.ctx
    const o = this.out(pos, 0.7, 100)
    if (!o) return
    const t = ctx.currentTime
    const dur = 2.2
    const shaper = ctx.createWaveShaper()
    const curve = new Float32Array(1024)
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1
      curve[i] = Math.tanh(x * 4)
    }
    shaper.curve = curve
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.55, t + 0.25)
    g.gain.setValueAtTime(0.55, t + dur - 0.6)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = 900
    shaper.connect(f).connect(g).connect(o)
    for (const base of [55, 82, 111]) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(base * 1.3, t)
      osc.frequency.linearRampToValueAtTime(base, t + 0.4)
      osc.frequency.linearRampToValueAtTime(base * 0.8, t + dur)
      const lfo = ctx.createOscillator()
      lfo.frequency.value = rnd(6, 11)
      const lg = ctx.createGain()
      lg.gain.value = base * 0.06
      lfo.connect(lg).connect(osc.frequency)
      osc.connect(shaper)
      osc.start(t)
      lfo.start(t)
      osc.stop(t + dur + 0.1)
      lfo.stop(t + dur + 0.1)
    }
    this.burst(o, t, dur, 'bandpass', 500, 300, 0.4, 2, 0.2)
  }

  groan(pos: Vec) {
    if (!this.ctx) return
    const o = this.out(pos, 0.3, 30)
    if (!o) return
    const t = this.ctx.currentTime
    const f = rnd(90, 130)
    this.tone(o, 'sawtooth', f, f * 0.7, t, 0.7, 0.05, 0.15)
    this.burst(o, t, 0.7, 'bandpass', 600, 350, 0.15, 4, 0.2)
  }

  enemyDeath(pos: Vec) {
    if (!this.ctx) return
    const o = this.out(pos, 0.4)
    if (!o) return
    const t = this.ctx.currentTime
    this.burst(o, t + 0.2, 1.8, 'highpass', 1500, 4000, 0.18, 0.7, 0.6)
  }

  // -------------------------------------------------------------------------
  // Player feedback
  // -------------------------------------------------------------------------

  estus() {
    if (!this.ctx) return
    const o = this.out(undefined, 0.5)!
    const t = this.ctx.currentTime
    for (let i = 0; i < 3; i++) this.tone(o, 'sine', 180, 120, t + 0.1 + i * 0.16, 0.08, 0.3)
    const notes = [523, 659, 784, 1046]
    notes.forEach((n, i) => this.tone(o, 'sine', n, n, t + 0.55 + i * 0.07, 0.9, 0.08, 0.02))
    this.burst(o, t + 0.5, 0.9, 'bandpass', 2000, 5000, 0.1, 2, 0.2)
  }

  death() {
    if (!this.ctx) return
    const o = this.out(undefined, 0.8)!
    const t = this.ctx.currentTime
    this.tone(o, 'sine', 55, 30, t, 3.5, 0.9, 0.01)
    this.burst(o, t, 2.5, 'lowpass', 800, 60, 0.6, 0.5, 0.01)
    for (const f of [73.4, 87.3, 103.8]) this.tone(o, 'sawtooth', f, f * 0.98, t + 0.3, 3.2, 0.05, 0.8)
  }

  bonfireLit() {
    if (!this.ctx) return
    const o = this.out(undefined, 0.8)!
    const t = this.ctx.currentTime
    this.burst(o, t, 1.2, 'lowpass', 200, 3000, 0.5, 0.7, 0.4)
    for (const f of [220, 277.2, 329.6, 440]) this.tone(o, 'sine', f, f, t + 0.4, 2.6, 0.08, 0.5)
  }

  victory() {
    if (!this.ctx) return
    const o = this.out(undefined, 0.9)!
    const t = this.ctx.currentTime
    this.tone(o, 'sine', 50, 28, t, 4, 0.9)
    const chord = [146.8, 220, 293.7, 370, 440]
    chord.forEach((f, i) => this.tone(o, 'sawtooth', f, f, t + 0.6 + i * 0.05, 4.5, 0.035, 1.2))
    chord.forEach((f) => this.tone(o, 'sine', f * 2, f * 2, t + 0.6, 4.5, 0.05, 1.2))
  }

  souls() {
    if (!this.ctx) return
    const o = this.out(undefined, 0.6)!
    const t = this.ctx.currentTime
    for (let i = 0; i < 6; i++) {
      const f = 700 + i * 140 + Math.random() * 60
      this.tone(o, 'sine', f, f * 1.5, t + i * 0.06, 0.4, 0.04, 0.03)
    }
  }

  fogGate() {
    if (!this.ctx) return
    const o = this.out(undefined, 0.7)!
    const t = this.ctx.currentTime
    this.burst(o, t, 1.8, 'bandpass', 300, 1600, 0.4, 0.8, 0.6)
    this.tone(o, 'sine', 330, 220, t, 1.8, 0.05, 0.6)
  }

  ui(kind: 'move' | 'confirm' | 'back' | 'levelup' | 'error') {
    if (!this.ctx) return
    const o = this.out(undefined, 0.2)!
    const t = this.ctx.currentTime
    if (kind === 'move') this.tone(o, 'triangle', 1400, 1300, t, 0.05, 0.05)
    else if (kind === 'confirm') {
      this.tone(o, 'sine', 880, 880, t, 0.25, 0.08)
      this.tone(o, 'sine', 1320, 1320, t + 0.05, 0.3, 0.05)
    } else if (kind === 'back') this.tone(o, 'triangle', 700, 500, t, 0.12, 0.06)
    else if (kind === 'levelup') {
      for (const [i, f] of [440, 554, 659, 880].entries()) this.tone(o, 'sine', f, f, t + i * 0.06, 0.8, 0.07, 0.01)
    } else this.tone(o, 'square', 140, 120, t, 0.12, 0.05)
  }

  lockOn() {
    if (!this.ctx) return
    const o = this.out(undefined, 0.1)!
    this.tone(o, 'sine', 1800, 1700, this.ctx.currentTime, 0.06, 0.04)
  }

  message() {
    if (!this.ctx) return
    const o = this.out(undefined, 0.6)!
    const t = this.ctx.currentTime
    this.tone(o, 'sine', 1046, 1046, t, 1.2, 0.05, 0.05)
    this.tone(o, 'sine', 1568, 1568, t + 0.1, 1.2, 0.04, 0.05)
  }

  bell(pos?: Vec) {
    if (!this.ctx) return
    const o = this.out(pos, 1.0, 400)
    if (!o) return
    const t = this.ctx.currentTime
    const base = 98
    for (const [p, a, d] of [
      [0.5, 0.25, 7],
      [1, 0.35, 6],
      [1.183, 0.2, 5],
      [1.506, 0.15, 4.5],
      [2, 0.12, 3.5],
      [2.514, 0.08, 3],
      [3.011, 0.05, 2.5],
    ] as const) {
      this.tone(o, 'sine', base * p, base * p * 0.999, t, d, a * 0.4, 0.003)
    }
  }

  // -------------------------------------------------------------------------
  // Ambience + music
  // -------------------------------------------------------------------------

  private startAmbience() {
    const ctx = this.ctx!
    // wind
    const wind = ctx.createBufferSource()
    wind.buffer = this.noise
    wind.loop = true
    this.windFilter = ctx.createBiquadFilter()
    this.windFilter.type = 'bandpass'
    this.windFilter.frequency.value = 400
    this.windFilter.Q.value = 0.6
    this.windGain = ctx.createGain()
    this.windGain.gain.value = 0.12
    wind.connect(this.windFilter).connect(this.windGain).connect(this.amb)
    wind.start()
    // low drone of the world
    this.droneGain = ctx.createGain()
    this.droneGain.gain.value = 0.0
    for (const f of [36.7, 55, 73.4]) {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = f
      o.detune.value = rnd(-8, 8)
      o.connect(this.droneGain)
      o.start()
    }
    this.droneGain.connect(this.amb)
    // bonfire bed
    const fire = ctx.createBufferSource()
    fire.buffer = this.noise
    fire.loop = true
    const ff = ctx.createBiquadFilter()
    ff.type = 'lowpass'
    ff.frequency.value = 500
    this.fireGain = ctx.createGain()
    this.fireGain.gain.value = 0
    fire.connect(ff).connect(this.fireGain).connect(this.amb)
    fire.start()
  }

  /** Per-frame ambience update. */
  update(dt: number, bonfireDist: number, inArena: boolean) {
    if (!this.ctx) return
    const t = this.ctx.currentTime
    const wob = 0.5 + 0.5 * Math.sin(t * 0.21) * Math.sin(t * 0.13 + 1)
    this.windFilter.frequency.setTargetAtTime(250 + wob * 500, t, 0.5)
    this.windGain.gain.setTargetAtTime(0.06 + wob * 0.1, t, 0.5)
    const fireAmt = Math.max(0, 1 - bonfireDist / 14)
    this.fireGain.gain.setTargetAtTime(fireAmt * 0.12, t, 0.3)
    this.droneGain.gain.setTargetAtTime(inArena ? 0.05 : 0.025, t, 1.5)
    // crackles
    this.crackleTimer -= dt
    if (fireAmt > 0.02 && this.crackleTimer <= 0) {
      this.crackleTimer = rnd(0.03, 0.25)
      const o = this.ctx.createGain()
      o.gain.value = fireAmt
      o.connect(this.amb)
      this.burst(o, t, rnd(0.01, 0.04), 'highpass', rnd(1500, 4000), 1200, rnd(0.05, 0.3), 1, 0.001)
    }
    if (this.titleMode) {
      this.bellTimer -= dt
      if (this.bellTimer <= 0) {
        this.bellTimer = 9 + Math.random() * 4
        this.bell({ x: this.listener.x + 30, z: this.listener.z - 80 })
      }
    }
  }

  startBossMusic() {
    if (!this.ctx || this.music) return
    this.music = new BossMusic(this.ctx, this.musicBus, this.reverbSend)
  }

  bossPhase2() {
    this.music?.setIntensity(2)
  }

  stopBossMusic(fade = 3) {
    this.music?.stop(fade)
    this.music = null
  }
}

/** A small generative score: choir pad, driving strings, war drums. */
class BossMusic {
  private ctx: AudioContext
  private out: GainNode
  private timer: ReturnType<typeof setInterval>
  private nextBeat: number
  private beat = 0
  private intensity = 1
  private bpm = 76
  private send: AudioNode

  // D minor: i - VI - iv - V  (Dm, Bb, Gm, A)
  private chords = [
    [62, 65, 69],
    [58, 62, 65],
    [55, 58, 62],
    [57, 61, 64],
  ]

  constructor(ctx: AudioContext, bus: AudioNode, reverbSend: AudioNode) {
    this.ctx = ctx
    this.out = ctx.createGain()
    this.out.gain.setValueAtTime(0.0001, ctx.currentTime)
    this.out.gain.exponentialRampToValueAtTime(0.9, ctx.currentTime + 2)
    this.out.connect(bus)
    const s = ctx.createGain()
    s.gain.value = 0.6
    this.out.connect(s).connect(reverbSend)
    this.send = s
    this.nextBeat = ctx.currentTime + 0.1
    this.timer = setInterval(() => this.schedule(), 80)
  }

  setIntensity(i: number) {
    this.intensity = i
    this.bpm = i > 1 ? 88 : 76
  }

  stop(fade: number) {
    const t = this.ctx.currentTime
    this.out.gain.cancelScheduledValues(t)
    this.out.gain.setValueAtTime(this.out.gain.value, t)
    this.out.gain.exponentialRampToValueAtTime(0.0001, t + fade)
    setTimeout(() => {
      clearInterval(this.timer)
      this.out.disconnect()
      this.send.disconnect()
    }, fade * 1000 + 200)
  }

  private midi(n: number) {
    return 440 * Math.pow(2, (n - 69) / 12)
  }

  private schedule() {
    const ctx = this.ctx
    const spb = 60 / this.bpm
    while (this.nextBeat < ctx.currentTime + 0.3) {
      this.playBeat(this.beat, this.nextBeat, spb)
      this.nextBeat += spb / 2 // eighth notes
      this.beat++
    }
  }

  private playBeat(i: number, t: number, spb: number) {
    const bar = Math.floor(i / 8)
    const chord = this.chords[Math.floor(bar / 2) % 4]
    const inBar = i % 8
    const hot = this.intensity > 1

    // choir pad at the start of each two-bar chord
    if (i % 16 === 0) {
      for (const n of chord) {
        for (const oct of [-12, 0]) this.voice(this.midi(n + oct), t, spb * 8, hot ? 0.05 : 0.04)
      }
    }
    // low string ostinato (eighths), accent on 1
    const root = chord[0] - 24
    const pattern = hot ? [0, 0, 12, 0, 0, 12, 0, 7] : [0, 0, 0, 0, 0, 0, 0, 0]
    this.pluck(this.midi(root + pattern[inBar]), t, spb * 0.45, inBar === 0 ? 0.16 : 0.09)
    // drums
    if (inBar === 0 || inBar === 3 || (hot && inBar === 6)) this.drum(t, inBar === 0 ? 1 : 0.6)
    if (hot && (inBar === 4)) this.drum(t, 0.8, true)
    // brass stab on phrase start in phase 2
    if (hot && i % 32 === 0) for (const n of chord) this.brass(this.midi(n - 12), t, spb * 3)
    // high bell-like motif every other bar
    if (inBar === 0 && bar % 2 === 1) this.chime(this.midi(chord[2] + 12), t)
  }

  private voice(f: number, t: number, dur: number, amp: number) {
    const ctx = this.ctx
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(amp, t + dur * 0.25)
    g.gain.setValueAtTime(amp, t + dur * 0.7)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.05)
    const f1 = ctx.createBiquadFilter()
    f1.type = 'bandpass'
    f1.frequency.value = 760
    f1.Q.value = 3
    const f2 = ctx.createBiquadFilter()
    f2.type = 'bandpass'
    f2.frequency.value = 1150
    f2.Q.value = 4
    const mix = ctx.createGain()
    mix.gain.value = 1.2
    for (const det of [-9, 0, 8]) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = f
      o.detune.value = det
      o.connect(f1)
      o.connect(f2)
      o.start(t)
      o.stop(t + dur * 1.1)
    }
    f1.connect(mix)
    f2.connect(mix)
    mix.connect(g).connect(this.out)
  }

  private pluck(f: number, t: number, dur: number, amp: number) {
    const ctx = this.ctx
    const o = ctx.createOscillator()
    o.type = 'sawtooth'
    o.frequency.value = f
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(1400, t)
    lp.frequency.exponentialRampToValueAtTime(250, t + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(amp, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(lp).connect(g).connect(this.out)
    o.start(t)
    o.stop(t + dur + 0.05)
  }

  private drum(t: number, amp: number, snare = false) {
    const ctx = this.ctx
    if (snare) {
      const src = ctx.createBufferSource()
      const len = ctx.sampleRate * 0.3
      const buf = ctx.createBuffer(1, len, ctx.sampleRate)
      const d = buf.getChannelData(0)
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3)
      src.buffer = buf
      const f = ctx.createBiquadFilter()
      f.type = 'bandpass'
      f.frequency.value = 1800
      const g = ctx.createGain()
      g.gain.value = amp * 0.25
      src.connect(f).connect(g).connect(this.out)
      src.start(t)
      return
    }
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(120, t)
    o.frequency.exponentialRampToValueAtTime(42, t + 0.35)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(amp * 0.7, t + 0.005)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8)
    o.connect(g).connect(this.out)
    o.start(t)
    o.stop(t + 0.9)
  }

  private brass(f: number, t: number, dur: number) {
    const ctx = this.ctx
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(300, t)
    lp.frequency.exponentialRampToValueAtTime(2200, t + 0.15)
    lp.frequency.exponentialRampToValueAtTime(600, t + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.06, t + 0.08)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    for (const det of [-6, 6]) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = f
      o.detune.value = det
      o.connect(lp)
      o.start(t)
      o.stop(t + dur + 0.1)
    }
    lp.connect(g).connect(this.out)
  }

  private chime(f: number, t: number) {
    const ctx = this.ctx
    for (const p of [1, 2.01, 3.03]) {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = f * p
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.03 / p, t + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.5)
      o.connect(g).connect(this.out)
      o.start(t)
      o.stop(t + 2.6)
    }
  }
}

export const audio = new AudioEngine()
