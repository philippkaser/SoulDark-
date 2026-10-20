import { Room } from '../../shared/room'
import type { ClientMsg, Look, ServerMsg } from '../../shared/protocol'

type Listener = (msg: ServerMsg) => void

/**
 * Talks to a world. Online it is a WebSocket to the Bun server; when no server
 * is reachable the very same Room simulation runs inside the browser instead,
 * so the game is always playable.
 */
export class NetClient {
  mode: 'online' | 'offline' = 'offline'
  id = ''
  room = ''
  offset = 0
  rtt = 0
  private bestRtt = Infinity
  private ws: WebSocket | null = null
  private local: { room: Room; timer: ReturnType<typeof setInterval> } | null = null
  private listeners = new Set<Listener>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private identity: { name: string; look: Look } | null = null
  private closed = false

  on(fn: Listener) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  serverNow() {
    return performance.now() + this.offset
  }

  async connect(name: string, look: Look, room: string, preferOffline = false) {
    this.identity = { name, look }
    this.room = room
    const ok = preferOffline ? false : await this.tryOnline(room)
    if (!ok) this.startLocal()
    this.pingTimer = setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000)
    setTimeout(() => this.send({ t: 'ping', c: performance.now() }), 100)
    return this.mode
  }

  send(msg: ClientMsg) {
    if (this.closed) return
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
    } else if (this.local) {
      this.local.room.handle('local', structuredClone(msg))
    }
  }

  close() {
    this.closed = true
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.ws?.close()
    this.ws = null
    if (this.local) clearInterval(this.local.timer)
    this.local = null
    this.listeners.clear()
  }

  private dispatch(msg: ServerMsg) {
    if (this.closed) return
    if (msg.t === 'pong') {
      const now = performance.now()
      const rtt = now - msg.c
      this.rtt = rtt
      const estimate = msg.s + rtt / 2 - now
      // trust low-latency samples the most
      if (rtt < this.bestRtt * 1.3 || this.bestRtt === Infinity) {
        this.bestRtt = Math.min(this.bestRtt, rtt)
        this.offset = this.offset === 0 ? estimate : this.offset + (estimate - this.offset) * 0.25
      }
      return
    }
    if (msg.t === 'welcome') {
      this.id = msg.id
      if (this.offset === 0) this.offset = msg.time - performance.now()
    }
    for (const fn of this.listeners) fn(msg)
  }

  private tryOnline(room: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(ok)
      }
      let ws: WebSocket
      try {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws'
        ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(room)}`)
      } catch {
        resolve(false)
        return
      }
      const timer = setTimeout(() => {
        ws.close()
        finish(false)
      }, 3500)
      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'join', name: this.identity!.name, look: this.identity!.look }))
      }
      ws.onmessage = (ev) => {
        let msg: ServerMsg
        try {
          msg = JSON.parse(ev.data)
        } catch {
          return
        }
        if (msg.t === 'welcome' && !settled) {
          this.ws = ws
          this.mode = 'online'
          finish(true)
        }
        this.dispatch(msg)
      }
      ws.onclose = () => {
        if (!settled) return finish(false)
        if (this.ws === ws && !this.closed) {
          this.ws = null
          this.dispatch({ t: 'sys', text: 'The connection to the world has faded. You are alone now.' })
          this.startLocal()
        }
      }
    })
  }

  private startLocal() {
    const room = new Room({ name: 'offline' })
    room.connect('local', (msg) => {
      const copy = structuredClone(msg)
      queueMicrotask(() => this.dispatch(copy))
    })
    this.offset = 0
    this.bestRtt = Infinity
    this.local = { room, timer: setInterval(() => room.tick(), 1000 / 30) }
    this.mode = 'offline'
    this.send({ t: 'join', name: this.identity!.name, look: this.identity!.look })
  }
}
