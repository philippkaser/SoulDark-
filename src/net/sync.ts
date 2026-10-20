import type { ServerMsg } from '../../shared/protocol'
import { useUI } from '../state/store'
import { EnemyView, RemotePlayerView, world } from '../game/world'
import type { NetClient } from './client'

/** Mirrors server state into the client-side world. */
export function attachSync(net: NetClient) {
  return net.on((msg: ServerMsg) => {
    const ui = useUI.getState()
    switch (msg.t) {
      case 'welcome': {
        world.localId = msg.id
        world.remotes.clear()
        world.enemies.clear()
        for (const p of msg.players) world.remotes.set(p.id, new RemotePlayerView(p.id, p.name, p.look))
        world.messages = msg.messages
        world.stains = msg.stains
        world.flags = msg.w
        ui.bumpRemotes()
        ui.bumpWorld()
        return
      }
      case 'snap': {
        for (const p of msg.p) {
          if (p.id === world.localId) continue
          const view = world.remotes.get(p.id)
          if (view) view.push(msg.time, p)
        }
        for (const e of msg.e) {
          let view = world.enemies.get(e.id)
          if (!view) {
            view = new EnemyView(e.id, e.ty)
            world.enemies.set(e.id, view)
            ui.bumpWorld()
          }
          view.push(
            msg.time,
            { t: msg.time, x: e.x, z: e.z, yaw: e.yaw, s: e.s, ss: e.ss, at: e.at, r: e.r, ph: e.ph, ld: e.ld },
            e.hp,
            e.mhp,
          )
        }
        world.flags = msg.w
        return
      }
      case 'join': {
        world.remotes.set(msg.p.id, new RemotePlayerView(msg.p.id, msg.p.name, msg.p.look))
        ui.bumpRemotes()
        return
      }
      case 'leave': {
        world.remotes.delete(msg.id)
        ui.bumpRemotes()
        return
      }
      case 'msgs': {
        if (msg.add) world.messages = [...world.messages, ...msg.add]
        if (msg.upd) {
          const m = world.messages.find((x) => x.id === msg.upd!.id)
          if (m) m.rating = msg.upd.rating
        }
        ui.bumpWorld()
        return
      }
      case 'stain': {
        world.stains = [...world.stains.slice(-23), msg.s]
        ui.bumpWorld()
        return
      }
      case 'chat':
        ui.pushChat({ name: msg.name, text: msg.text })
        return
      case 'sys':
        ui.pushChat({ name: '', text: msg.text, system: true })
        return
    }
  })
}
