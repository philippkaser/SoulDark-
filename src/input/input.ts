/**
 * Keyboard / mouse / gamepad input, collapsed into one per-frame snapshot.
 *
 * Keyboard + mouse: WASD move, mouse aim, LMB slash, RMB parry (hold to guard),
 * Shift dash, Space leap (again in the air: meteor dive), E hold to charge the
 * Heaven Splitter, Q Judgment, Esc pause, 1-0 sandbox spawns.
 * Gamepad (standard): LS move, RS aim, RB / X slash, LB / LT parry, RT charge,
 * B dash, A leap, Y Judgment, Start pause.
 */

export interface InputFrame {
  moveX: number
  moveY: number
  lookX: number
  lookY: number
  slash: boolean
  parry: boolean
  guard: boolean
  dash: boolean
  jump: boolean
  heavy: boolean
  ult: boolean
  menu: boolean
  /** Sandbox spawn hotkey 0-9, or -1. */
  spawn: number
  usingGamepad: boolean
}

export const emptyFrame = (): InputFrame => ({
  moveX: 0,
  moveY: 0,
  lookX: 0,
  lookY: 0,
  slash: false,
  parry: false,
  guard: false,
  dash: false,
  jump: false,
  heavy: false,
  ult: false,
  menu: false,
  spawn: -1,
  usingGamepad: false,
})

class InputManager {
  private keys = new Set<string>()
  private pressed = new Set<string>()
  private mouse = [false, false, false]
  private mousePressed = [false, false, false]
  private mouseDX = 0
  private mouseDY = 0
  private padPrev: boolean[] = []
  private lastPadUse = 0
  private lastKbUse = 0
  private target: HTMLElement | null = null
  frame: InputFrame = emptyFrame()
  /** When false, gameplay input is suppressed (menus). */
  enabled = true
  locked = false
  onLockChange?: (locked: boolean) => void

  attach(el: HTMLElement) {
    this.target = el
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
    el.addEventListener('mousedown', this.onMouseDown)
    window.addEventListener('mouseup', this.onMouseUp)
    window.addEventListener('mousemove', this.onMouseMove)
    el.addEventListener('contextmenu', this.onContext)
    document.addEventListener('pointerlockchange', this.onPointerLock)
  }

  detach() {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    this.target?.removeEventListener('mousedown', this.onMouseDown)
    window.removeEventListener('mouseup', this.onMouseUp)
    window.removeEventListener('mousemove', this.onMouseMove)
    this.target?.removeEventListener('contextmenu', this.onContext)
    document.removeEventListener('pointerlockchange', this.onPointerLock)
    this.target = null
  }

  requestLock() {
    if (!this.target || document.pointerLockElement) return
    try {
      const p = this.target.requestPointerLock() as unknown as Promise<void> | undefined
      p?.catch?.(() => {})
    } catch {
      /* pointer lock unavailable (e.g. headless) */
    }
  }

  releaseLock() {
    if (document.pointerLockElement) document.exitPointerLock()
  }

  private onContext = (e: Event) => e.preventDefault()

  private onPointerLock = () => {
    this.locked = document.pointerLockElement === this.target
    this.onLockChange?.(this.locked)
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    if (e.code === 'Space' || e.code === 'Tab' || e.code.startsWith('Arrow')) e.preventDefault()
    if (!e.repeat) this.pressed.add(e.code)
    this.keys.add(e.code)
    this.lastKbUse = performance.now()
  }

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code)
  }

  private onBlur = () => {
    this.keys.clear()
    this.mouse = [false, false, false]
  }

  private onMouseDown = (e: MouseEvent) => {
    this.lastKbUse = performance.now()
    if (!this.locked) {
      this.requestLock()
      // the click that captures the mouse should not swing the sword
      return
    }
    if (e.button <= 2) {
      this.mouse[e.button] = true
      this.mousePressed[e.button] = true
    }
  }

  private onMouseUp = (e: MouseEvent) => {
    if (e.button <= 2) this.mouse[e.button] = false
  }

  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return
    // guard against the occasional huge jump some browsers report
    if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return
    this.mouseDX += e.movementX
    this.mouseDY += e.movementY
  }

  /** Inject a synthetic press (automation / tests). */
  tap(code: string) {
    if (code === 'Mouse0') this.mousePressed[0] = true
    else if (code === 'Mouse2') this.mousePressed[2] = true
    else this.pressed.add(code)
  }

  /** Hold or release a key or mouse button programmatically (automation). */
  hold(code: string, down: boolean) {
    if (code === 'Mouse0' || code === 'Mouse2') {
      const b = code === 'Mouse0' ? 0 : 2
      if (down && !this.mouse[b]) this.mousePressed[b] = true
      this.mouse[b] = down
      return
    }
    if (down) {
      if (!this.keys.has(code)) this.pressed.add(code)
      this.keys.add(code)
    } else this.keys.delete(code)
  }

  /** Turn the camera programmatically (automation). */
  look(dx: number, dy: number) {
    this.mouseDX += dx
    this.mouseDY += dy
  }

  /** Build this frame's input. Call once per frame before gameplay update. */
  poll(dt: number, sensitivity: number, invertY: boolean): InputFrame {
    const f = emptyFrame()
    const k = this.keys
    const p = this.pressed
    if (this.enabled) {
      f.moveX = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0)
      f.moveY = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0)
      const len = Math.hypot(f.moveX, f.moveY)
      if (len > 1) {
        f.moveX /= len
        f.moveY /= len
      }
      f.slash = this.mousePressed[0] || p.has('KeyJ')
      f.parry = this.mousePressed[2] || p.has('KeyK')
      f.guard = this.mouse[2] || k.has('KeyK')
      f.dash = p.has('ShiftLeft') || p.has('ShiftRight') || p.has('KeyL')
      f.jump = p.has('Space')
      f.heavy = k.has('KeyE') || this.mouse[1]
      f.ult = p.has('KeyQ')
      const ms = 0.0024 * sensitivity
      f.lookX = this.mouseDX * ms
      f.lookY = this.mouseDY * ms * (invertY ? -1 : 1)
      for (let d = 0; d <= 9; d++) if (p.has(`Digit${d}`)) f.spawn = d
    }
    f.menu = p.has('Escape') || p.has('KeyP')

    this.pollGamepad(f, dt, sensitivity, invertY)
    f.usingGamepad = this.lastPadUse > this.lastKbUse

    this.pressed.clear()
    this.mousePressed = [false, false, false]
    this.mouseDX = 0
    this.mouseDY = 0
    this.frame = f
    return f
  }

  private pollGamepad(f: InputFrame, dt: number, sensitivity: number, invertY: boolean) {
    const pads = typeof navigator !== 'undefined' ? (navigator.getGamepads?.() ?? []) : []
    const pad = Array.from(pads).find((g) => g && g.connected)
    if (!pad) return
    const btn = (i: number) => !!pad.buttons[i]?.pressed
    const prev = this.padPrev
    const now = pad.buttons.map((b) => b.pressed)
    const down = (i: number) => btn(i) && !prev[i]
    const dz = (v: number) => (Math.abs(v) < 0.18 ? 0 : (v - Math.sign(v) * 0.18) / 0.82)
    const lx = dz(pad.axes[0] ?? 0)
    const ly = dz(pad.axes[1] ?? 0)
    const rx = dz(pad.axes[2] ?? 0)
    const ry = dz(pad.axes[3] ?? 0)
    if (lx || ly || rx || ry || now.some(Boolean)) this.lastPadUse = performance.now()
    this.padPrev = now
    if (!this.enabled) {
      if (down(9)) f.menu = true
      return
    }
    if (lx || ly) {
      f.moveX = lx
      f.moveY = -ly
    }
    const look = 2.8 * sensitivity * dt
    f.lookX += rx * Math.abs(rx) * look
    f.lookY += ry * Math.abs(ry) * look * (invertY ? -1 : 1)
    if (down(5) || down(2)) f.slash = true
    if (down(4) || down(6)) f.parry = true
    if (btn(4) || btn(6)) f.guard = true
    if (btn(7)) f.heavy = true
    if (down(1)) f.dash = true
    if (down(0)) f.jump = true
    if (down(3)) f.ult = true
    if (down(9)) f.menu = true
  }
}

export const input = new InputManager()
