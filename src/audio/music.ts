/**
 * A generative, adaptive battle score. Layers enter as intensity rises:
 *   0  ominous drone and distant taiko (title, lulls)
 *   1  low string pulse + war drums
 *   2  sixteenth-note string arpeggios
 *   3  choir and brass stabs
 *   4  the heroic lead, cymbals (high style ranks, bosses)
 * 'victory' switches to a slow D-major chorale.
 */
export type MusicMode = 'none' | 'title' | 'battle' | 'boss' | 'victory'

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12)

// D minor, i - VI - VII - V  (Dm, Bb, C, A)
const CHORDS = [
  [62, 65, 69],
  [58, 62, 65],
  [60, 64, 67],
  [57, 61, 64],
]

// heroic lead over the 16-bar loop: [eighth index, midi, length in eighths]
const LEAD: Array<[number, number, number]> = [
  [0, 69, 2], [2, 74, 2], [4, 76, 1], [5, 77, 1], [6, 76, 1], [7, 74, 1],
  [8, 72, 3], [11, 69, 1], [12, 67, 2], [14, 69, 2],
  [16, 70, 2], [18, 69, 1], [19, 67, 1], [20, 65, 2], [22, 67, 2],
  [24, 69, 8],
  [32, 77, 2], [34, 74, 2], [36, 70, 2], [38, 74, 2],
  [40, 79, 3], [43, 77, 1], [44, 74, 4],
  [48, 75, 2], [50, 74, 2], [52, 72, 2], [54, 70, 2],
  [56, 74, 8],
  [64, 76, 2], [66, 79, 2], [68, 76, 2], [70, 72, 2],
  [72, 79, 3], [75, 77, 1], [76, 76, 2], [78, 72, 2],
  [80, 74, 2], [82, 76, 1], [83, 77, 1], [84, 79, 2], [86, 81, 2],
  [88, 79, 8],
  [96, 81, 3], [99, 79, 1], [100, 77, 2], [102, 76, 2],
  [104, 73, 3], [107, 76, 1], [108, 81, 4],
  [112, 79, 2], [114, 77, 2], [116, 76, 2], [118, 73, 2],
  [120, 74, 8],
]

export class Score {
  private ctx: AudioContext
  private out: GainNode
  private send: GainNode
  private timer: ReturnType<typeof setInterval>
  private nextBeat: number
  private beat = 0
  private mode: MusicMode = 'none'
  private intensity = 0
  private targetGain = 0
  private bpm = 148

  constructor(ctx: AudioContext, bus: AudioNode, reverbSend: AudioNode) {
    this.ctx = ctx
    this.out = ctx.createGain()
    this.out.gain.value = 0.0001
    this.out.connect(bus)
    this.send = ctx.createGain()
    this.send.gain.value = 0.45
    this.out.connect(this.send).connect(reverbSend)
    this.nextBeat = ctx.currentTime + 0.1
    this.timer = setInterval(() => this.schedule(), 60)
  }

  set(mode: MusicMode, intensity: number) {
    const changed = mode !== this.mode
    this.mode = mode
    this.intensity = Math.max(0, Math.min(4, intensity))
    const g = mode === 'none' ? 0.0001 : mode === 'title' ? 0.7 : 0.9
    if (changed || g !== this.targetGain) {
      this.targetGain = g
      const t = this.ctx.currentTime
      this.out.gain.cancelScheduledValues(t)
      this.out.gain.setTargetAtTime(g, t, mode === 'none' ? 1.2 : 0.6)
    }
    if (changed && mode === 'victory') {
      this.beat = 0
      this.nextBeat = this.ctx.currentTime + 0.3
    }
    this.bpm = mode === 'victory' ? 72 : mode === 'boss' ? 156 : 148
  }

  /** A short musical hit layered over whatever is playing. */
  sting(kind: 'parry' | 'big') {
    if (this.mode === 'none') return
    const t = this.ctx.currentTime
    const chord = CHORDS[Math.floor(this.beat / 32) % 4]
    for (const n of chord) this.brass(midi(n - (kind === 'big' ? 12 : 0)), t, kind === 'big' ? 1.6 : 0.5, kind === 'big' ? 0.09 : 0.05)
    if (kind === 'big') this.drum(t, 1.2)
  }

  dispose() {
    clearInterval(this.timer)
    this.out.disconnect()
  }

  private schedule() {
    const ctx = this.ctx
    const spb = 60 / this.bpm
    while (this.nextBeat < ctx.currentTime + 0.25) {
      if (this.mode !== 'none') this.play(this.beat, this.nextBeat, spb)
      this.nextBeat += spb / 2
      this.beat++
    }
  }

  private play(i: number, t: number, spb: number) {
    if (this.mode === 'victory') return this.chorale(i, t, spb)
    if (this.mode === 'title') return this.titleBed(i, t, spb)
    const L = this.intensity
    const loopI = i % 128
    const bar = Math.floor(loopI / 8)
    const chord = CHORDS[Math.floor(bar / 4) % 4]
    const inBar = i % 8
    const root = chord[0] - 24

    if (L >= 0 && i % 16 === 0) {
      for (const n of chord) this.pad(midi(n - 12), t, spb * 8, 0.022)
    }
    if (L >= 1) {
      const pattern = [0, 0, 12, 0, 0, 12, 0, 7]
      this.pluck(midi(root + pattern[inBar]), t, spb * 0.42, inBar === 0 ? 0.17 : 0.1, 900)
      if (inBar === 0 || inBar === 3 || inBar === 6) this.drum(t, inBar === 0 ? 1 : 0.65)
      if (inBar === 2 || inBar === 6) this.snare(t, 0.5)
      if (bar % 4 === 3 && inBar >= 4) this.tom(t, 0.5 + (inBar - 4) * 0.1, 110 - (inBar - 4) * 12)
    }
    if (L >= 2) {
      // sixteenth arpeggio: two notes per eighth
      const arp = [chord[0], chord[1], chord[2], chord[1] + 12, chord[2], chord[1], chord[0] + 12, chord[2]]
      this.pluck(midi(arp[inBar] + 12), t, spb * 0.22, 0.045, 2800)
      this.pluck(midi(arp[(inBar + 3) % 8] + 12), t + spb / 4, spb * 0.2, 0.035, 2600)
    }
    if (L >= 3) {
      if (inBar === 0 && bar % 2 === 0) for (const n of chord) this.brass(midi(n - 12), t, spb * 2.5, 0.05)
      if (i % 32 === 0) this.voices(chord.map((n) => midi(n)), t, spb * 16, 0.045)
    }
    if (L >= 4) {
      for (const [at, n, len] of LEAD) if (at === loopI) this.lead(midi(n), t, spb * 0.5 * len)
      if (inBar === 0 && bar % 4 === 0) this.cymbal(t)
    }
  }

  private titleBed(i: number, t: number, spb: number) {
    if (i % 32 === 0) {
      this.pad(midi(38), t, spb * 18, 0.05)
      this.pad(midi(45), t, spb * 18, 0.035)
      this.voices([midi(62), midi(65), midi(69)], t + spb * 2, spb * 14, 0.025)
    }
    if (i % 16 === 0) this.drum(t, 0.6)
    if (i % 16 === 3) this.drum(t, 0.35)
    if (i % 64 === 40) this.chime(midi(81), t)
  }

  private chorale(i: number, t: number, spb: number) {
    const prog = [
      [62, 66, 69, 74],
      [59, 62, 66, 71],
      [55, 59, 62, 67],
      [57, 61, 64, 69],
      [62, 66, 69, 74],
    ]
    if (i % 8 === 0) {
      const c = prog[Math.min(prog.length - 1, Math.floor(i / 8))]
      if (i / 8 < prog.length) {
        this.voices(c.map(midi), t, spb * 4.5, 0.05)
        for (const n of c) this.brass(midi(n - 12), t, spb * 4, 0.035)
        this.drum(t, 0.7)
      }
    }
    if (i === 40) this.chime(midi(86), t)
  }

  // --- instruments ---------------------------------------------------------

  private pad(f: number, t: number, dur: number, amp: number) {
    const ctx = this.ctx
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(amp, t + dur * 0.3)
    g.gain.setValueAtTime(amp, t + dur * 0.7)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 700
    lp.connect(g).connect(this.out)
    for (const det of [-8, 0, 7]) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = f
      o.detune.value = det
      o.connect(lp)
      o.start(t)
      o.stop(t + dur + 0.05)
    }
  }

  private voices(freqs: number[], t: number, dur: number, amp: number) {
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
    mix.gain.value = 1.3
    for (const f of freqs) {
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
    }
    f1.connect(mix)
    f2.connect(mix)
    mix.connect(g).connect(this.out)
  }

  private pluck(f: number, t: number, dur: number, amp: number, bright: number) {
    const ctx = this.ctx
    const o = ctx.createOscillator()
    o.type = 'sawtooth'
    o.frequency.value = f
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(bright, t)
    lp.frequency.exponentialRampToValueAtTime(220, t + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(amp, t + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(lp).connect(g).connect(this.out)
    o.start(t)
    o.stop(t + dur + 0.05)
  }

  private drum(t: number, amp: number) {
    const ctx = this.ctx
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(130, t)
    o.frequency.exponentialRampToValueAtTime(40, t + 0.3)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(amp * 0.75, t + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7)
    o.connect(g).connect(this.out)
    o.start(t)
    o.stop(t + 0.75)
  }

  private snare(t: number, amp: number) {
    const ctx = this.ctx
    const len = Math.floor(ctx.sampleRate * 0.25)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 4)
    const src = ctx.createBufferSource()
    src.buffer = buf
    const f = ctx.createBiquadFilter()
    f.type = 'bandpass'
    f.frequency.value = 2000
    f.Q.value = 0.8
    const g = ctx.createGain()
    g.gain.value = amp * 0.3
    src.connect(f).connect(g).connect(this.out)
    src.start(t)
  }

  private tom(t: number, amp: number, f0: number) {
    const ctx = this.ctx
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(f0, t)
    o.frequency.exponentialRampToValueAtTime(f0 * 0.5, t + 0.25)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(amp * 0.5, t + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4)
    o.connect(g).connect(this.out)
    o.start(t)
    o.stop(t + 0.45)
  }

  private cymbal(t: number) {
    const ctx = this.ctx
    const len = Math.floor(ctx.sampleRate * 1.6)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5)
    const src = ctx.createBufferSource()
    src.buffer = buf
    const f = ctx.createBiquadFilter()
    f.type = 'highpass'
    f.frequency.value = 5000
    const g = ctx.createGain()
    g.gain.value = 0.06
    src.connect(f).connect(g).connect(this.out)
    src.start(t)
  }

  private brass(f: number, t: number, dur: number, amp: number) {
    const ctx = this.ctx
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(300, t)
    lp.frequency.exponentialRampToValueAtTime(2400, t + 0.1)
    lp.frequency.exponentialRampToValueAtTime(700, t + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(amp, t + 0.05)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    for (const det of [-7, 7]) {
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

  private lead(f: number, t: number, dur: number) {
    const ctx = this.ctx
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(1200, t)
    lp.frequency.linearRampToValueAtTime(3200, t + 0.08)
    lp.frequency.linearRampToValueAtTime(1800, t + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.055, t + 0.04)
    g.gain.setValueAtTime(0.05, t + Math.max(0.05, dur - 0.08))
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.05)
    lp.connect(g).connect(this.out)
    for (const det of [-5, 5]) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = f
      o.detune.value = det
      const vib = ctx.createOscillator()
      vib.frequency.value = 5.5
      const vg = ctx.createGain()
      vg.gain.setValueAtTime(0, t)
      vg.gain.linearRampToValueAtTime(f * 0.008, t + Math.min(0.3, dur))
      vib.connect(vg).connect(o.frequency)
      o.connect(lp)
      o.start(t)
      vib.start(t)
      o.stop(t + dur + 0.1)
      vib.stop(t + dur + 0.1)
    }
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
      g.gain.exponentialRampToValueAtTime(0.0001, t + 3)
      o.connect(g).connect(this.out)
      o.start(t)
      o.stop(t + 3.1)
    }
  }
}
