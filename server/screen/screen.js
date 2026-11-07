/**
 * Screen — the one permanent watch room ("Screen 1").
 *
 * The server owns the *playback clock*:
 *     { playing, position, rate, updatedAt }
 * The true position at any moment is
 *     position + (now - updatedAt) / 1000 * rate      (when playing)
 * Clients estimate the server's clock (NTP-style ping) and steer their local
 * <video> towards it. Only *intent* changes (play / pause / seek / rate) are
 * broadcast, never a stream of timestamps.
 *
 * Wait-for-everyone: every viewer reports how many seconds they have buffered
 * once a second. If someone stalls, the room pauses for them, and resumes
 * (with a short countdown) once everybody has a few seconds in the bank.
 */
import crypto from 'node:crypto'
import { config } from '../config.js'

/** Palette that sits nicely on the dark panels. */
const AVATAR_COLOURS = ['#ff5a5f', '#3b9eff', '#4caf50', '#ffb020', '#ff8a3d', '#a78bfa', '#2dd4bf', '#f472b6', '#93c5fd', '#e8c98a']

export class Screen {
  constructor () {
    this.id = 'SCREEN1'
    this.name = config.screenName
    this.media = null
    /** @type {Map<string, Member>} */
    this.members = new Map()
    this.settings = { waitForAll: true, controlsLocked: false }
    this.playback = { playing: false, position: 0, rate: 1, updatedAt: Date.now(), started: false, seq: 0 }
    this.hold = null // { since, ids: [userId] }
    this.lastSeekAt = 0
    this.chat = []
  }

  // ---------------------------------------------------------------- members
  /**
   * Add (or re-attach) a member. `clientKey` is a secret random string the
   * browser keeps in localStorage; the public user id is a hash of it, so
   * nobody can impersonate someone by copying an id from the member list.
   */
  join ({ clientKey, name, socketId, admin }) {
    const id = userIdFrom(clientKey)
    let m = this.members.get(id)
    if (!m) {
      const online = [...this.members.values()].filter((x) => x.connected).length
      if (online >= config.maxMembers) throw new Error(`${this.name} is full.`)
      m = {
        id,
        name: clean(name, 24) || 'Guest',
        color: AVATAR_COLOURS[hashInt(id) % AVATAR_COLOURS.length],
        joinedAt: Date.now(),
        admin: false,
        sockets: new Set(),
        connected: true,
        removeTimer: null,
        net: emptyNet(),
        waitingSince: 0,
        immuneUntil: 0
      }
      this.members.set(id, m)
    } else if (name) {
      m.name = clean(name, 24) || m.name
    }
    m.admin = !!admin || m.admin
    clearTimeout(m.removeTimer)
    m.removeTimer = null
    m.sockets.add(socketId)
    m.connected = true
    return m
  }

  /** On disconnect: keep the member for a grace period so a refresh doesn't drop them. */
  detach (userId, socketId, onRemoved) {
    const m = this.members.get(userId)
    if (!m) return
    m.sockets.delete(socketId)
    if (m.sockets.size) return
    m.connected = false
    m.net = emptyNet()
    m.removeTimer = setTimeout(() => {
      this.members.delete(userId)
      onRemoved?.()
    }, config.memberGraceMs)
  }

  remove (userId) {
    const m = this.members.get(userId)
    if (!m) return
    clearTimeout(m.removeTimer)
    this.members.delete(userId)
  }

  /** Per-second network/buffer report from a viewer. */
  report (userId, r) {
    const m = this.members.get(userId)
    if (!m) return
    const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : 0)
    const waiting = !!r.waiting
    if (waiting && !m.net.waiting) m.waitingSince = Date.now()
    if (!waiting) m.waitingSince = 0
    m.net = {
      loaded: !!r.loaded && r.key === this.media?.key,
      ahead: num(r.ahead, 0, 3600),
      bw: Math.round(num(r.bw, 0, 1e10)),
      height: Math.round(num(r.height, 0, 4320)),
      quality: typeof r.quality === 'string' ? r.quality.slice(0, 12) : '',
      auto: r.auto !== false,
      drift: Number.isFinite(Number(r.drift)) ? Math.round(num(r.drift, -36e5, 36e5)) : null,
      waiting,
      at: Date.now()
    }
  }

  // ---------------------------------------------------------------- media
  setMedia (media, byName) {
    this.media = media ? { ...media, loadedBy: byName || null, loadedAt: Date.now() } : null
    this.hold = null
    for (const m of this.members.values()) { m.net = emptyNet(); m.waitingSince = 0 }
    this.playback = { playing: false, position: 0, rate: 1, updatedAt: Date.now(), started: false, seq: this.playback.seq + 1 }
  }

  /** The PC restarted or its tunnel URL changed: same movie, new address. Keep the position. */
  replaceMediaSource (media) {
    const pos = this.currentPosition()
    this.media = { ...this.media, ...media }
    for (const m of this.members.values()) m.net = emptyNet()
    this.applyPlayback({ playing: false, position: pos })
  }

  // ---------------------------------------------------------------- playback
  currentPosition (now = Date.now()) {
    const p = this.playback
    if (!p.playing || now < p.updatedAt) return p.position
    const pos = p.position + ((now - p.updatedAt) / 1000) * p.rate
    return this.media?.duration ? Math.min(pos, this.media.duration) : pos
  }

  canControl (userId) {
    const m = this.members.get(userId)
    return !!m && (m.admin || !this.settings.controlsLocked)
  }

  /** `delayMs` schedules a synchronised start: updatedAt lands in the future and everyone begins together. */
  applyPlayback ({ playing, position, rate }, delayMs = 0) {
    const now = Date.now()
    const p = this.playback
    if (Number.isFinite(position) && Math.abs(position - this.currentPosition(now)) > 2) this.lastSeekAt = now
    let pos = Number.isFinite(position) ? Math.max(0, position) : this.currentPosition(now)
    if (this.media?.duration) pos = Math.min(pos, Math.max(0, this.media.duration - 0.5))
    this.playback = {
      playing: typeof playing === 'boolean' ? playing : p.playing,
      position: pos,
      rate: Number.isFinite(rate) ? Math.min(2, Math.max(0.25, rate)) : p.rate,
      updatedAt: now + delayMs,
      started: p.started || !!playing,
      seq: p.seq + 1
    }
    return this.playback
  }

  /** Viewers whose reports count for wait-for-everyone. */
  activeViewers (now = Date.now()) {
    return [...this.members.values()].filter((m) => m.connected && m.net.loaded && now - m.net.at < 5000)
  }

  /**
   * Called every 500ms. Returns { action, names } when it changed playback.
   *   hold   → somebody stalled; the room paused at the current position
   *   resume → everyone has enough buffered again
   */
  tickWaitForAll (now = Date.now()) {
    if (!this.media || !this.settings.waitForAll) { this.hold = null; return null }
    const p = this.playback
    const viewers = this.activeViewers(now)

    if (p.playing && !this.hold && now >= p.updatedAt + 1500) {
      const stalled = viewers.filter((m) => m.net.waiting && m.waitingSince && now - m.waitingSince >= config.stallTriggerMs && now > m.immuneUntil)
      if (stalled.length) {
        this.applyPlayback({ playing: false, position: this.currentPosition(now) })
        this.hold = { since: now, ids: stalled.map((m) => m.id) }
        // Everyone buffering right after a skip is expected: hold quietly.
        return { action: 'hold', names: stalled.map((m) => m.name), quiet: now - this.lastSeekAt < 6000 }
      }
    }

    if (this.hold && !p.playing) {
      const remaining = this.media.duration ? this.media.duration - p.position - 0.5 : Infinity
      const need = Math.max(0, Math.min(config.resumeBufferSeconds, remaining))
      const behind = viewers.filter((m) => m.net.ahead < need)
      this.hold.ids = behind.map((m) => m.id)
      const timedOut = now - this.hold.since > config.holdTimeoutMs
      if (!behind.length || timedOut) {
        // Don't let one hopeless connection hold everyone forever.
        if (timedOut) for (const m of behind) m.immuneUntil = now + 90_000
        this.hold = null
        this.applyPlayback({ playing: true }, 1200)
        return { action: 'resume', names: timedOut ? behind.map((m) => m.name) : [] }
      }
    }
    return null
  }

  clearHold () { this.hold = null }

  // ---------------------------------------------------------------- chat
  addChat (msg) {
    this.chat.push(msg)
    if (this.chat.length > config.chatHistory) this.chat.splice(0, this.chat.length - config.chatHistory)
    return msg
  }

  system (text) {
    return this.addChat({ id: crypto.randomUUID(), type: 'system', text, at: Date.now() })
  }

  // ---------------------------------------------------------------- views
  memberView (m) {
    return { id: m.id, name: m.name, color: m.color, admin: m.admin, connected: m.connected, joinedAt: m.joinedAt }
  }

  snapshot (host) {
    return {
      id: this.id,
      name: this.name,
      settings: this.settings,
      media: this.media,
      members: [...this.members.values()].sort((a, b) => a.joinedAt - b.joinedAt).map((m) => this.memberView(m)),
      playback: this.playbackView(),
      hold: this.hold ? { ids: this.hold.ids, since: this.hold.since } : null,
      host
    }
  }

  playbackView () { return { ...this.playback, serverTime: Date.now() } }

  /** Live buffer / connection stats for every viewer. */
  netView () {
    return [...this.members.values()].filter((m) => m.connected).map((m) => ({ id: m.id, ...m.net }))
  }

  publicInfo () {
    return {
      name: this.name,
      media: this.media ? { title: this.media.title } : null,
      online: [...this.members.values()].filter((m) => m.connected).length
    }
  }
}

// ------------------------------------------------------------------ helpers
function emptyNet () { return { loaded: false, ahead: 0, bw: 0, height: 0, quality: '', auto: true, drift: null, waiting: false, at: 0 } }

export function userIdFrom (clientKey) {
  return crypto.createHash('sha256').update(String(clientKey)).digest('base64url').slice(0, 16)
}

function hashInt (s) {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0
  return Math.abs(h)
}

/** Trim, collapse whitespace, strip control chars, cap length. Rendering is always textContent client-side. */
export function clean (s, max) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}
