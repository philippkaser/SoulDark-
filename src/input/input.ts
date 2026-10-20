/**
 * Keyboard / mouse / gamepad input, collapsed into one per-frame snapshot.
 *
 * Keyboard + mouse:  WASD move, Shift sprint, Space roll, LMB light, RMB heavy,
 * F parry, Q / MMB lock-on, R estus, E interact, G gestures, T write message.
 * Gamepad (standard): LS move, RS camera, B roll (hold: sprint), RB light,
 * RT heavy, LT/LB parry, R3 lock-on, X estus, A interact, Y gestures.
 */

export interface InputFrame {
  moveX: number
  moveY: number
  lookX: number
  lookY: number
  sprint: boolean
  roll: boolean
  light: boolean
  heavy: boolean
  parry: boolean
  lock: boolean
  estus: boolean
  interact: boolean
  gesture: boolean
  compose: boolean
  menu: boolean
  chat: boolean
  /** Switch lock-on target (-1 left / +1 right). */
  switchTarget: number
  usingGamepad: boolean
}

const emptyFrame = (): InputFrame => ({
  moveX: 0,
  moveY: 0,
  lookX: 0,
  lookY: 0,
  sprint: false,
  roll: false,
  light: false,
  heavy: false,
  parry: false,
  lock: false,
  estus: false,
  interact: false,
  gesture: false,
  compose: false,
  menu: false,
  chat: false,
  switchTarget: 0,
  usingGamepad: false,
})

class InputManager {
  private keys = new Set<string>()
  private pressed = new Set<string>()
  private mouse = [false, false, false]
  private mousePressed = [false, false, false]
  private mouseDX = 0
  private mouseDY = 0
  private wheel = 0
  private padPrev: boolean[] = []
  private padRollHeld = 0
  private padStickFlick = 0
  private lastPadUse = 0
  private lastKbUse = 0
  private target: HTMLElement | null = null
  frame: InputFrame = emptyFrame()
  /** When false, gameplay input is suppressed (menus, chat). */
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
    el.addEventListener('wheel', this.onWheel, { passive: true })
    el.addEventListener('contextmenu', (e) => e.preventDefault())
    document.addEventListener('pointerlockchange', this.onPointerLock)
  }

  detach() {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    this.target?.removeEventListener('mousedown', this.onMouseDown)
    window.removeEventListener('mouseup', this.onMouseUp)
    window.removeEventListener('mousemove', this.onMouseMove)
    this.target?.removeEventListener('wheel', this.onWheel)
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

  private onPointerLock = () => {
    this.locked = document.pointerLockElement === this.target
    this.onLockChange?.(this.locked)
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    if (e.code === 'Space' || e.code === 'Tab') e.preventDefault()
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

  private onWheel = (e: WheelEvent) => {
    this.wheel += Math.sign(e.deltaY)
  }

  /** Inject a synthetic press (used by tests / automation). */
  tap(code: string) {
    if (code === 'Mouse0') this.mousePressed[0] = true
    else if (code === 'Mouse2') this.mousePressed[2] = true
    else this.pressed.add(code)
  }

  /** Hold or release a key programmatically (automation). */
  hold(code: string, down: boolean) {
    if (down) this.keys.add(code)
    else this.keys.delete(code)
  }

  /** Build this frame's input. Call once per frame before gameplay update. */
  poll(dt: number, sensitivity: number, invertY: boolean): InputFrame {
    const f = emptyFrame()
    const k = this.keys
    const p = this.pressed
    if (this.enabled) {
      f.moveX = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0)
      f.moveY = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0)
      const len = Math.hypot(f.moveX, f.moveY)
      if (len > 1) {
        f.moveX /= len
        f.moveY /= len
      }
      f.sprint = k.has('ShiftLeft') || k.has('ShiftRight')
      f.roll = p.has('Space')
      f.light = this.mousePressed[0]
      f.heavy = this.mousePressed[2]
      f.lock = this.mousePressed[1] || p.has('KeyQ') || p.has('Tab')
      f.parry = p.has('KeyF')
      f.estus = p.has('KeyR')
      f.interact = p.has('KeyE')
      f.gesture = p.has('KeyG')
      f.compose = p.has('KeyT')
      const ms = 0.0024 * sensitivity
      f.lookX = this.mouseDX * ms
      f.lookY = this.mouseDY * ms * (invertY ? -1 : 1)
      if (this.wheel !== 0) f.switchTarget = this.wheel > 0 ? 1 : -1
    }
    f.menu = p.has('Escape')
    f.chat = p.has('Enter')

    this.pollGamepad(f, dt, sensitivity, invertY)
    f.usingGamepad = this.lastPadUse > this.lastKbUse

    this.pressed.clear()
    this.mousePressed = [false, false, false]
    this.mouseDX = 0
    this.mouseDY = 0
    this.wheel = 0
    this.frame = f
    return f
  }

  private pollGamepad(f: InputFrame, dt: number, sensitivity: number, invertY: boolean) {
    const pads = navigator.getGamepads?.() ?? []
    const pad = Array.from(pads).find((g) => g && g.connected)
    if (!pad) return
    const btn = (i: number) => !!pad.buttons[i]?.pressed
    const prev = this.padPrev
    const now = pad.buttons.map((b) => b.pressed)
    const down = (i: number) => btn(i) && !prev[i]
    const up = (i: number) => !btn(i) && prev[i]
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
    const look = 2.6 * sensitivity * dt
    f.lookX += rx * Math.abs(rx) * look
    f.lookY += ry * Math.abs(ry) * look * (invertY ? -1 : 1)

    // B: tap to roll (on release), hold to sprint
    if (btn(1)) this.padRollHeld += dt
    if (up(1) && this.padRollHeld < 0.28) f.roll = true
    if (!btn(1)) this.padRollHeld = 0
    if (this.padRollHeld >= 0.28) f.sprint = true

    if (down(5)) f.light = true
    if (down(7)) f.heavy = true
    if (down(6) || down(4)) f.parry = true
    if (down(11)) f.lock = true
    if (down(2)) f.estus = true
    if (down(0)) f.interact = true
    if (down(3)) f.gesture = true
    if (down(9)) f.menu = true
    if (down(8)) f.compose = true

    // flick the right stick to switch lock targets
    if (Math.abs(rx) > 0.75 && this.padStickFlick === 0) {
      this.padStickFlick = Math.sign(rx)
      f.switchTarget = Math.sign(rx)
    } else if (Math.abs(rx) < 0.3) {
      this.padStickFlick = 0
    }
  }
}

export const input = new InputManager()
