/**
 * Socket.IO wiring.
 *
 * Client → server events (all use acknowledgements: cb({ ok, error, ... }))
 *   time:ping                       clock sync, replies { serverTime }
 *   room:create  { name, username, clientKey, media? }
 *   room:join    { roomId, username, clientKey }
 *   room:leave
 *   room:ready   { ready }
 *   room:status  { status, position }        presence ("Now watching", buffering, away…)
 *   room:media   { infoHash, fileIndex }      host only
 *   room:start                               host only, requires everyone ready
 *   room:settings { controlsLocked }         host only
 *   host:transfer { userId } / host:kick { userId }
 *   playback:play|pause|seek|rate { position, rate }
 *   playback:report { position, playing }    host heartbeat (keeps the clock honest)
 *   chat:send { text } / chat:typing
 *   reaction:send { emoji }
 *   torrent:watch { infoHash, fileIndex }    subscribe to live download stats
 *
 * Server → client
 *   room:state, playback:state, chat:message, chat:typing, reaction, room:kicked, torrent:stats
 */
import crypto from 'node:crypto'
import { clean, userIdFrom } from '../rooms/room-manager.js'
import { bucket } from '../utils/rate-limit.js'

const REACTIONS = new Set(['👍', '❤️', '😂', '😮'])
const START_COUNTDOWN_MS = 3000

export function attachSockets (io, { rooms, engine }) {
  const chatLimit = bucket(6, 5000)
  const reactLimit = bucket(12, 5000)
  const intentLimit = bucket(20, 5000)

  // ---- live torrent stats: one timer for the whole server ----------------
  setInterval(() => {
    for (const [roomName] of io.sockets.adapter.rooms) {
      if (!roomName.startsWith('stats:')) continue
      const [, hash, idx] = roomName.split(':')
      const s = engine.fileStats(hash, idx)
      if (s) io.to(roomName).emit('torrent:stats', { infoHash: hash, fileIndex: Number(idx), ...s })
    }
  }, 1000).unref()

  io.on('connection', (socket) => {
    /** Set once the socket joins a room. */
    let ctx = null // { room, userId }

    const reply = (cb, payload) => typeof cb === 'function' && cb(payload)
    const fail = (cb, error) => reply(cb, { ok: false, error })

    const broadcastState = (room) => io.to(room.id).emit('room:state', rooms.snapshot(room))
    const broadcastPlayback = (room, extra = {}) =>
      io.to(room.id).emit('playback:state', { ...rooms.playbackView(room), ...extra })

    const system = (room, text) => {
      const msg = rooms.addChat(room, { id: crypto.randomUUID(), type: 'system', text, at: Date.now() })
      io.to(room.id).emit('chat:message', msg)
    }

    /** Guard: must be in a room; optionally must be host. */
    const inRoom = (cb, { host = false } = {}) => {
      if (!ctx || !rooms.get(ctx.room.id)) { fail(cb, 'You are not in a room.'); return null }
      if (host && ctx.room.hostId !== ctx.userId) { fail(cb, 'Only the host can do that.'); return null }
      return ctx
    }

    const enter = (room, { username, clientKey }) => {
      if (typeof clientKey !== 'string' || clientKey.length < 16 || clientKey.length > 128) throw new Error('Bad client key')
      const uid = userIdFrom(clientKey)
      // Re-joining the same room on the same socket (e.g. create → navigate) is a no-op re-attach.
      if (ctx && !(ctx.room.id === room.id && ctx.userId === uid)) leave()
      const isNew = !room.members.has(uid)
      const member = rooms.join(room, { clientKey, name: username, socketId: socket.id })
      ctx = { room, userId: member.id }
      socket.join(room.id)
      if (isNew) system(room, `${member.name} joined the room`)
      broadcastState(room)
      return member
    }

    const leave = () => {
      if (!ctx) return
      const { room, userId } = ctx
      socket.leave(room.id)
      const name = room.members.get(userId)?.name
      rooms.remove(room, userId)
      if (name) system(room, `${name} left`)
      broadcastState(room)
      ctx = null
    }

    // ---- clock sync -------------------------------------------------------
    socket.on('time:ping', (cb) => reply(cb, { serverTime: Date.now() }))

    // ---- rooms ------------------------------------------------------------
    socket.on('room:create', (data = {}, cb) => {
      try {
        const room = rooms.create({ name: data.name })
        const me = enter(room, data)
        if (data.media?.infoHash && engine.file(data.media.infoHash, data.media.fileIndex)) {
          setMedia(room, data.media)
        }
        reply(cb, { ok: true, room: rooms.snapshot(room), me: me.id, chat: room.chat })
      } catch (e) { fail(cb, e.message) }
    })

    socket.on('room:join', (data = {}, cb) => {
      const room = rooms.get(data.roomId)
      if (!room) return fail(cb, 'Room not found. It may have expired — ask the host for a new link.')
      try {
        const me = enter(room, data)
        reply(cb, { ok: true, room: rooms.snapshot(room), me: me.id, chat: room.chat })
      } catch (e) { fail(cb, e.message) }
    })

    socket.on('room:leave', (cb) => { leave(); reply(cb, { ok: true }) })

    socket.on('room:ready', ({ ready } = {}, cb) => {
      const c = inRoom(cb); if (!c) return
      rooms.setReady(c.room, c.userId, ready)
      broadcastState(c.room)
      reply(cb, { ok: true })
    })

    socket.on('room:status', ({ status, position } = {}, cb) => {
      const c = inRoom(cb); if (!c) return
      if (rooms.setStatus(c.room, c.userId, status, Number(position))) broadcastState(c.room)
      reply(cb, { ok: true })
    })

    const setMedia = (room, { infoHash, fileIndex }) => {
      const hit = engine.file(infoHash, fileIndex)
      if (!hit) throw new Error('That torrent isn\'t loaded on the server any more.')
      rooms.setMedia(room, {
        infoHash,
        fileIndex: Number(fileIndex),
        title: prettyTitle(hit.file.name),
        fileName: hit.file.name,
        length: hit.file.length,
        torrentName: hit.torrent.name
      })
    }

    socket.on('room:media', (data = {}, cb) => {
      const c = inRoom(cb, { host: true }); if (!c) return
      try {
        setMedia(c.room, data)
        system(c.room, `Now showing: ${c.room.media.title}. Everyone ready up!`)
        broadcastState(c.room)
        broadcastPlayback(c.room, { action: 'load' })
        reply(cb, { ok: true })
      } catch (e) { fail(cb, e.message) }
    })

    socket.on('room:start', (cb) => {
      const c = inRoom(cb, { host: true }); if (!c) return
      if (!c.room.media) return fail(cb, 'Pick something to watch first.')
      if (!rooms.allReady(c.room)) return fail(cb, 'Not everyone is ready yet.')
      rooms.applyPlayback(c.room, { playing: true }, START_COUNTDOWN_MS)
      system(c.room, 'Session starting — enjoy the show! 🍿')
      broadcastPlayback(c.room, { action: 'start', by: c.userId })
      broadcastState(c.room)
      reply(cb, { ok: true })
    })

    socket.on('room:settings', (data = {}, cb) => {
      const c = inRoom(cb, { host: true }); if (!c) return
      if (typeof data.controlsLocked === 'boolean') {
        c.room.settings.controlsLocked = data.controlsLocked
        system(c.room, data.controlsLocked ? 'Host locked playback controls' : 'Everyone can now control playback')
      }
      broadcastState(c.room)
      reply(cb, { ok: true })
    })

    socket.on('host:transfer', ({ userId } = {}, cb) => {
      const c = inRoom(cb, { host: true }); if (!c) return
      const target = c.room.members.get(userId)
      if (!target?.connected) return fail(cb, 'That person isn\'t online.')
      c.room.hostId = target.id
      system(c.room, `${target.name} is now the host 👑`)
      broadcastState(c.room)
      reply(cb, { ok: true })
    })

    socket.on('host:kick', ({ userId } = {}, cb) => {
      const c = inRoom(cb, { host: true }); if (!c) return
      if (userId === c.userId) return fail(cb, 'You can\'t remove yourself.')
      const target = c.room.members.get(userId)
      if (!target) return fail(cb, 'User not found.')
      for (const sid of target.sockets) {
        const s = io.sockets.sockets.get(sid)
        s?.emit('room:kicked', { roomId: c.room.id })
        s?.leave(c.room.id)
      }
      rooms.remove(c.room, userId)
      system(c.room, `${target.name} was removed by the host`)
      broadcastState(c.room)
      reply(cb, { ok: true })
    })

    // ---- playback intents ------------------------------------------------
    const playbackIntent = (action, build) => (data = {}, cb) => {
      const c = inRoom(cb); if (!c) return
      if (!intentLimit(socket.id)) return fail(cb, 'Too many actions.')
      if (!c.room.media) return fail(cb, 'Nothing is loaded.')
      if (!rooms.canControl(c.room, c.userId)) return fail(cb, 'The host has locked playback controls.')
      rooms.applyPlayback(c.room, build(data))
      broadcastPlayback(c.room, { action, by: c.userId })
      reply(cb, { ok: true })
    }
    const pos = (d) => (Number.isFinite(Number(d.position)) ? Number(d.position) : undefined)

    socket.on('playback:play', playbackIntent('play', (d) => ({ playing: true, position: pos(d) })))
    socket.on('playback:pause', playbackIntent('pause', (d) => ({ playing: false, position: pos(d) })))
    socket.on('playback:seek', playbackIntent('seek', (d) => ({ position: pos(d) })))
    socket.on('playback:rate', playbackIntent('rate', (d) => ({ rate: Number(d.rate) })))

    /**
     * Host heartbeat. If the host's real position has drifted from the
     * server clock (e.g. the host was buffering), re-anchor the clock to the
     * host so the whole room follows them.
     */
    socket.on('playback:report', ({ position, playing } = {}) => {
      if (!ctx || ctx.room.hostId !== ctx.userId) return
      const room = ctx.room
      const p = Number(position)
      if (!Number.isFinite(p) || !room.playback.playing || Date.now() < room.playback.updatedAt) return
      const drift = p - rooms.currentPosition(room)
      if (Math.abs(drift) > 1.0 && playing) {
        rooms.applyPlayback(room, { position: p })
        broadcastPlayback(room, { action: 'correct' })
      }
    })

    // ---- chat & reactions --------------------------------------------------
    socket.on('chat:send', ({ text } = {}, cb) => {
      const c = inRoom(cb); if (!c) return
      const body = clean(text, 500)
      if (!body) return fail(cb, 'Empty message')
      if (!chatLimit(socket.id)) return fail(cb, 'You\'re sending messages too quickly.')
      const m = c.room.members.get(c.userId)
      const msg = rooms.addChat(c.room, {
        id: crypto.randomUUID(), type: 'user', userId: m.id, name: m.name, color: m.color, text: body, at: Date.now()
      })
      io.to(c.room.id).emit('chat:message', msg)
      reply(cb, { ok: true })
    })

    socket.on('chat:typing', () => {
      if (!ctx) return
      const m = ctx.room.members.get(ctx.userId)
      if (m) socket.to(ctx.room.id).emit('chat:typing', { userId: m.id, name: m.name })
    })

    socket.on('reaction:send', ({ emoji } = {}, cb) => {
      const c = inRoom(cb); if (!c) return
      if (!REACTIONS.has(emoji)) return fail(cb, 'Unknown reaction')
      if (!reactLimit(socket.id)) return fail(cb, 'Easy there!')
      const m = c.room.members.get(c.userId)
      io.to(c.room.id).emit('reaction', { emoji, userId: m.id, name: m.name, color: m.color, at: Date.now() })
      reply(cb, { ok: true })
    })

    // ---- torrent stats subscription -------------------------------------
    let statsRoom = null
    socket.on('torrent:watch', ({ infoHash, fileIndex } = {}) => {
      if (statsRoom) socket.leave(statsRoom)
      statsRoom = null
      if (!engine.file(infoHash, fileIndex)) return
      statsRoom = `stats:${infoHash}:${Number(fileIndex)}`
      socket.join(statsRoom)
      engine.prioritise(infoHash, fileIndex)
    })

    // ---- disconnect -------------------------------------------------------
    socket.on('disconnect', () => {
      if (!ctx) return
      const { room, userId } = ctx
      const wasHost = room.hostId === userId
      rooms.detach(room, userId, socket.id, () => {
        const name = room.members.get(userId)?.name
        system(room, `${name || 'Someone'} disconnected`)
        if (wasHost && room.hostId) system(room, `${room.members.get(room.hostId)?.name} is now the host 👑`)
        broadcastState(room)
      })
      broadcastState(room)
    })
  })
}

/** "The.Movie.2019.1080p.BluRay.x264-GRP.mkv" → "The Movie (2019)" */
export function prettyTitle (fileName) {
  const base = fileName.replace(/\.[a-z0-9]{2,4}$/i, '')
  const m = base.match(/^(.*?)[ ._(\[-]+((?:19|20)\d{2})(?:[ ._)\]-]|$)/)
  const tidy = (s) => s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (m && m[1]) return `${tidy(m[1])} (${m[2]})`
  const ep = base.match(/^(.*?)[ ._-]+(S\d{1,2}E\d{1,2})/i)
  if (ep) return `${tidy(ep[1])} · ${ep[2].toUpperCase()}`
  return tidy(base.replace(/\b(1080p|720p|2160p|4k|x264|x265|h264|hevc|bluray|web-?dl|webrip|hdrip).*$/i, '')) || tidy(base)
}
