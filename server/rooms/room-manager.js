/**
 * RoomManager — in-memory state for watch parties.
 *
 * The server owns the *playback clock* for every room:
 *     { playing, position, rate, updatedAt }
 * The true position at any moment is
 *     position + (now - updatedAt) / 1000 * rate      (when playing)
 * Clients estimate the server's clock (NTP-style ping) and continuously steer
 * their local <video> towards that value. Nobody broadcasts "currentTime" ten
 * times a second; only *intent* changes (play / pause / seek / rate) are sent.
 *
 * For a multi-instance deployment swap this class for a Redis-backed store and
 * add the @socket.io/redis-adapter — the public methods stay the same.
 */
import crypto from 'node:crypto'
import { config } from '../config.js'

const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I confusion
const STATUSES = new Set(['idle', 'watching', 'paused', 'buffering', 'away'])

/** Palette lifted from the Truck Dash UI so avatars sit nicely on the dark panels. */
const AVATAR_COLOURS = ['#3b9eff', '#4caf50', '#ffb020', '#ff8a3d', '#ff4d4d', '#a78bfa', '#2dd4bf', '#f472b6', '#93c5fd', '#e8c98a']

export class RoomManager {
  constructor ({ engine }) {
    this.engine = engine
    /** @type {Map<string, Room>} */
    this.rooms = new Map()
    this._gc = setInterval(() => this.collectGarbage(), 60_000)
    this._gc.unref()
  }

  // ---------------------------------------------------------------- lifecycle
  create ({ name }) {
    let id
    do { id = randomId(6) } while (this.rooms.has(id))
    const room = {
      id,
      name: clean(name, 40) || 'Watch party',
      createdAt: Date.now(),
      hostId: null,
      settings: { controlsLocked: true }, // only the host drives playback by default
      media: null,
      members: new Map(),
      playback: { playing: false, position: 0, rate: 1, updatedAt: Date.now(), started: false, seq: 0 },
      chat: [],
      emptySince: Date.now()
    }
    this.rooms.set(id, room)
    return room
  }

  get (id) { return this.rooms.get(String(id || '').toUpperCase()) || null }

  /**
   * Add (or re-attach) a member. `clientKey` is a secret random string the
   * browser keeps in localStorage; the public user id is a hash of it, so
   * nobody can impersonate the host by copying an id from the member list.
   */
  join (room, { clientKey, name, socketId }) {
    const id = userIdFrom(clientKey)
    let m = room.members.get(id)
    if (!m) {
      const connected = [...room.members.values()].filter((x) => x.connected).length
      if (connected >= config.maxRoomMembers) throw new Error('This room is full.')
      m = {
        id,
        name: clean(name, 24) || 'Guest',
        color: AVATAR_COLOURS[hashInt(id) % AVATAR_COLOURS.length],
        joinedAt: Date.now(),
        ready: false,
        status: 'idle',
        position: 0,
        sockets: new Set(),
        connected: true,
        lastSeen: Date.now(),
        removeTimer: null
      }
      room.members.set(id, m)
    } else if (name) {
      m.name = clean(name, 24) || m.name
    }
    clearTimeout(m.removeTimer)
    m.removeTimer = null
    m.sockets.add(socketId)
    m.connected = true
    if (m.status === 'away') m.status = 'idle'
    m.lastSeen = Date.now()
    room.emptySince = null
    if (!room.hostId || !room.members.has(room.hostId)) room.hostId = id
    return m
  }

  /**
   * Called on socket disconnect. The member is kept for a grace period so a
   * page refresh or a flaky phone connection doesn't kick them (or the host).
   */
  detach (room, userId, socketId, onRemoved) {
    const m = room.members.get(userId)
    if (!m) return
    m.sockets.delete(socketId)
    if (m.sockets.size) return
    m.connected = false
    m.status = 'away'
    m.lastSeen = Date.now()
    m.removeTimer = setTimeout(() => {
      this.remove(room, userId)
      onRemoved?.()
    }, config.memberGraceMs)
  }

  remove (room, userId) {
    const m = room.members.get(userId)
    if (!m) return
    clearTimeout(m.removeTimer)
    room.members.delete(userId)
    if (room.hostId === userId) this.promoteNextHost(room)
    if (![...room.members.values()].some((x) => x.connected)) room.emptySince = Date.now()
  }

  promoteNextHost (room) {
    const next = [...room.members.values()]
      .filter((m) => m.connected)
      .sort((a, b) => a.joinedAt - b.joinedAt)[0]
    room.hostId = next ? next.id : null
    return next
  }

  // ---------------------------------------------------------------- ready-up
  setReady (room, userId, ready) {
    const m = room.members.get(userId)
    if (m) m.ready = !!ready
  }

  /** Everyone currently connected is ready (and there is something to watch). */
  allReady (room) {
    const present = [...room.members.values()].filter((m) => m.connected)
    return !!room.media && present.length > 0 && present.every((m) => m.ready)
  }

  setStatus (room, userId, status, position) {
    const m = room.members.get(userId)
    if (!m || !STATUSES.has(status)) return false
    // Broadcast on status change, or when the shown timestamp is ~5s stale.
    const changed = m.status !== status || (Number.isFinite(position) && Math.abs(position - (m.position || 0)) >= 4.5)
    m.status = status
    if (Number.isFinite(position)) m.position = position
    m.lastSeen = Date.now()
    return changed
  }

  // ---------------------------------------------------------------- media
  setMedia (room, media) {
    if (room.media) this.engine.unpin(room.media.infoHash, room.id)
    room.media = media
    if (media) {
      this.engine.pin(media.infoHash, room.id)
      this.engine.prioritise(media.infoHash, media.fileIndex)
    }
    // New title → everyone readies up again and the clock resets.
    for (const m of room.members.values()) m.ready = false
    room.playback = { playing: false, position: 0, rate: 1, updatedAt: Date.now(), started: false, seq: room.playback.seq + 1 }
  }

  isInUse (infoHash) {
    for (const r of this.rooms.values()) if (r.media?.infoHash === infoHash) return true
    return false
  }

  // ---------------------------------------------------------------- playback
  /** The server's best estimate of the room's position right now. */
  currentPosition (room, now = Date.now()) {
    const p = room.playback
    if (!p.playing || now < p.updatedAt) return p.position
    return p.position + ((now - p.updatedAt) / 1000) * p.rate
  }

  canControl (room, userId) {
    return room.hostId === userId || !room.settings.controlsLocked
  }

  /**
   * Apply a playback intent. `delayMs` lets "start" schedule a synchronised
   * countdown: updatedAt lands in the future and every client begins together.
   */
  applyPlayback (room, { playing, position, rate }, delayMs = 0) {
    const now = Date.now()
    const p = room.playback
    const pos = Number.isFinite(position) ? Math.max(0, position) : this.currentPosition(room, now)
    room.playback = {
      playing: typeof playing === 'boolean' ? playing : p.playing,
      position: pos,
      rate: Number.isFinite(rate) ? Math.min(2, Math.max(0.25, rate)) : p.rate,
      updatedAt: now + delayMs,
      started: p.started || !!playing,
      seq: p.seq + 1
    }
    return room.playback
  }

  // ---------------------------------------------------------------- chat
  addChat (room, msg) {
    room.chat.push(msg)
    if (room.chat.length > config.chatHistory) room.chat.splice(0, room.chat.length - config.chatHistory)
    return msg
  }

  // ---------------------------------------------------------------- views
  memberView (room, m) {
    return {
      id: m.id,
      name: m.name,
      color: m.color,
      ready: m.ready,
      status: m.status,
      position: Math.round(m.position || 0),
      connected: m.connected,
      isHost: room.hostId === m.id,
      joinedAt: m.joinedAt
    }
  }

  /** Full room state sent to members. */
  snapshot (room) {
    return {
      id: room.id,
      name: room.name,
      hostId: room.hostId,
      settings: room.settings,
      media: room.media,
      members: [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt).map((m) => this.memberView(room, m)),
      allReady: this.allReady(room),
      playback: this.playbackView(room)
    }
  }

  playbackView (room) {
    return { ...room.playback, serverTime: Date.now() }
  }

  /** Minimal info for the join screen (no member list). */
  publicInfo (id) {
    const room = this.get(id)
    if (!room) return null
    return {
      id: room.id,
      name: room.name,
      media: room.media ? { title: room.media.title } : null,
      online: [...room.members.values()].filter((m) => m.connected).length,
      host: room.members.get(room.hostId)?.name || null
    }
  }

  collectGarbage () {
    const cutoff = Date.now() - config.roomEmptyTtlMinutes * 60_000
    for (const [id, room] of this.rooms) {
      if (room.emptySince && room.emptySince < cutoff) {
        if (room.media) this.engine.unpin(room.media.infoHash, id)
        for (const m of room.members.values()) clearTimeout(m.removeTimer)
        this.rooms.delete(id)
        console.log(`[rooms] expired ${id}`)
      }
    }
  }
}

// ------------------------------------------------------------------ helpers
export function userIdFrom (clientKey) {
  return crypto.createHash('sha256').update(String(clientKey)).digest('base64url').slice(0, 16)
}

function randomId (len) {
  const bytes = crypto.randomBytes(len)
  let s = ''
  for (let i = 0; i < len; i++) s += ROOM_ID_ALPHABET[bytes[i] % ROOM_ID_ALPHABET.length]
  return s
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
