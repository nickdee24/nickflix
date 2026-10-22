/**
 * Socket.IO connection + server clock estimation.
 *
 * Clock sync (NTP-lite): send several pings, keep the sample with the lowest
 * round-trip, and assume the server stamped its time halfway through:
 *     offset = serverTime - (sentAt + rtt / 2)
 * serverNow() then gives every client the same notion of "now" to ±a few ms,
 * which is what makes the synced play/pause/seek line up.
 */
import { Emitter } from '../lib/dom.js'

class SocketService extends Emitter {
  constructor () {
    super()
    this.offset = 0
    this.rtt = 0
    this.connected = false
    /* global io */
    this.io = io({ transports: ['websocket', 'polling'], reconnectionDelayMax: 4000 })
    this.io.on('connect', () => { this.connected = true; this.emit('status', 'online'); this.syncClock() })
    this.io.on('disconnect', () => { this.connected = false; this.emit('status', 'offline') })
    this.io.io.on('reconnect_attempt', () => this.emit('status', 'reconnecting'))
    setInterval(() => this.connected && this.syncClock(3), 30_000)
  }

  /** Emit with acknowledgement → Promise. Rejects with the server's error text. */
  request (event, payload, timeout = 8000) {
    return new Promise((resolve, reject) => {
      if (!this.io.connected) { reject(new Error('Not connected to the server.')); return }
      const args = payload === undefined ? [] : [payload]
      this.io.timeout(timeout).emit(event, ...args, (err, res) => {
        if (err) return reject(new Error('The server didn\'t respond. Try again.'))
        if (res && res.ok === false) return reject(new Error(res.error || 'Something went wrong'))
        resolve(res)
      })
    })
  }

  send (event, payload) { this.io.emit(event, payload) }
  listen (event, fn) { this.io.on(event, fn); return () => this.io.off(event, fn) }

  async syncClock (samples = 6) {
    let best = null
    for (let i = 0; i < samples; i++) {
      const t0 = performance.now()
      const wall0 = Date.now()
      const res = await new Promise((r) => this.io.timeout(3000).emit('time:ping', (err, v) => r(err ? null : v)))
      const rtt = performance.now() - t0
      if (res && (!best || rtt < best.rtt)) best = { rtt, offset: res.serverTime - (wall0 + rtt / 2) }
      await new Promise((r) => setTimeout(r, 60))
    }
    if (best) {
      this.offset = best.offset
      this.rtt = best.rtt
      this.emit('clock', best)
    }
  }

  serverNow () { return Date.now() + this.offset }
}

export const socket = new SocketService()
