import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { Room } from '../shared/room'
import type { ClientMsg, GroundMessage } from '../shared/protocol'

const PORT = Number(process.env.PORT ?? process.env.SOULDARK_PORT ?? 3001)
const DIST = join(import.meta.dir, '..', 'dist')
const DATA = join(import.meta.dir, '..', 'data')
const TICK_MS = 1000 / 30

interface SocketData {
  id: string
  room: string
}

const rooms = new Map<string, Room>()

function roomKey(raw: string | null) {
  const clean = (raw ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24)
  return clean || 'lordran'
}

function loadMessages(name: string): GroundMessage[] | undefined {
  try {
    const file = join(DATA, `messages-${name}.json`)
    if (!existsSync(file)) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>()
function saveMessages(name: string, messages: GroundMessage[]) {
  clearTimeout(pendingSaves.get(name))
  pendingSaves.set(
    name,
    setTimeout(() => {
      try {
        mkdirSync(DATA, { recursive: true })
        writeFileSync(join(DATA, `messages-${name}.json`), JSON.stringify(messages))
      } catch (err) {
        console.warn('[souldark] could not persist messages', err)
      }
    }, 1000),
  )
}

function getRoom(name: string) {
  let room = rooms.get(name)
  if (!room) {
    room = new Room({
      name,
      messages: loadMessages(name),
      onMessagesChanged: (m) => saveMessages(name, m),
    })
    rooms.set(name, room)
    console.log(`[souldark] world "${name}" kindled`)
  }
  return room
}

setInterval(() => {
  for (const room of rooms.values()) room.tick()
}, TICK_MS)

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
}

function serveStatic(pathname: string): Response {
  if (!existsSync(DIST)) {
    return new Response('SoulDark server is running. Build the client with `bun run build`, or use `bun run dev`.', {
      status: 200,
    })
  }
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = join(DIST, safe)
  if (!file.startsWith(DIST) || !existsSync(file) || safe === '/' || safe.endsWith('/')) file = join(DIST, 'index.html')
  const ext = file.slice(file.lastIndexOf('.'))
  const headers: Record<string, string> = { 'Content-Type': MIME[ext] ?? 'application/octet-stream' }
  if (file.includes(`${join(DIST, 'assets')}`)) headers['Cache-Control'] = 'public, max-age=31536000, immutable'
  return new Response(Bun.file(file), { headers })
}

let nextId = 1

const server = Bun.serve<SocketData>({
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === '/ws') {
      const data: SocketData = { id: `p${nextId++}${Math.random().toString(36).slice(2, 6)}`, room: roomKey(url.searchParams.get('room')) }
      if (srv.upgrade(req, { data })) return undefined
      return new Response('Upgrade failed', { status: 400 })
    }
    if (url.pathname === '/api/status') {
      const worlds = [...rooms.entries()].map(([name, r]) => ({ name, players: r.playerCount }))
      return Response.json({ ok: true, worlds })
    }
    return serveStatic(url.pathname)
  },
  websocket: {
    maxPayloadLength: 64 * 1024,
    idleTimeout: 60,
    open(ws: ServerWebSocket<SocketData>) {
      const room = getRoom(ws.data.room)
      room.connect(ws.data.id, (msg) => {
        if (ws.readyState === 1) ws.send(JSON.stringify(msg))
      })
    },
    message(ws: ServerWebSocket<SocketData>, raw) {
      let msg: ClientMsg
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
      } catch {
        return
      }
      rooms.get(ws.data.room)?.handle(ws.data.id, msg)
    },
    close(ws: ServerWebSocket<SocketData>) {
      const room = rooms.get(ws.data.room)
      room?.disconnect(ws.data.id)
    },
  },
})

console.log(`[souldark] server listening on http://localhost:${server.port}  (ws: /ws)`)
