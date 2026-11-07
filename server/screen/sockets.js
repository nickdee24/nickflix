/**
 * Socket.IO wiring for Screen 1.
 *
 * Client → server (acknowledged: cb({ ok, error, ... }))
 *   time:ping                         clock sync → { serverTime }
 *   screen:join   { username, clientKey, hostKey? }
 *   screen:leave
 *   screen:report { key, loaded, ahead, bw, height, auto, drift, waiting }   once a second
 *   screen:presence { away }           switched to another tab or came back
 *   screen:load   { id } | { name, size }      host key only: prepare a movie on the PC
 *   screen:library                               host key only: list the PC's movie folder
 *   screen:unload                                host key only
 *   screen:settings { waitForAll, controlsLocked }   host key only
 *   screen:kick   { userId }                     host key only
 *   playback:play|pause|seek|rate { position, rate }
 *   chat:send { text } / chat:typing / reaction:send { emoji }
 *
 * Server → client
 *   screen:state, playback:state, screen:net, screen:library, host:status,
 *   chat:message, chat:typing, reaction, screen:kicked
 */
import crypto from 'node:crypto'
import { clean, userIdFrom } from './screen.js'
import { isHostKey } from '../host-link.js'
import { bucket } from '../utils/rate-limit.js'

const REACTIONS = new Set(['👍', '❤️', '😂', '😮'])
/** First play of a movie: lights down → screen zooms in → fullscreen prompt → "NickFlix presents" → title. */
const INTRO_MS = 16_000
/** Resuming after a pause: a quicker lights-down + zoom-in. */
const RESUME_MS = 3_500
const ROOM = 'screen'
const ADMINS = 'screen:admins'

export function attachSockets (io, { screen, hostLink }) {
  const chatLimit = bucket(6, 5000)
  const reactLimit = bucket(12, 5000)
  const intentLimit = bucket(20, 5000)
  const loadLimit = bucket(6, 30_000)

  const hostStatus = () => hostLink.status()
  const broadcastState = () => io.to(ROOM).emit('screen:state', screen.snapshot(hostStatus()))
  const broadcastPlayback = (extra = {}) => io.to(ROOM).emit('playback:state', { ...screen.playbackView(), ...extra })
  const system = (text) => io.to(ROOM).emit('chat:message', screen.system(text))
  const pushAdminStatus = () => io.to(ADMINS).emit('host:status', hostLink.adminStatus())

  // ---- wait-for-everyone + live buffer bars ---------------------------------
  setInterval(() => {
    const change = screen.tickWaitForAll()
    if (change?.action === 'hold') {
      if (!change.quiet) system(`Waiting for ${list(change.names)} to catch up…`)
      broadcastPlayback({ action: 'hold' })
      broadcastState()
    } else if (change?.action === 'resume') {
      if (change.names.length) system(`Carrying on without ${list(change.names)} — they'll catch up`)
      broadcastPlayback({ action: 'resume' })
      broadcastState()
    }
  }, 500).unref()

  setInterval(() => {
    if (screen.members.size) io.to(ROOM).emit('screen:net', { at: Date.now(), hold: screen.hold?.ids || null, viewers: screen.netView() })
  }, 1000).unref()

  // ---- the PC came online / went away / restarted ---------------------------
  hostLink.on('status', async ({ urlChanged }) => {
    pushAdminStatus()
    broadcastState()
    if (!screen.media) return
    if (!hostLink.socket) {
      if (screen.playback.playing) {
        screen.applyPlayback({ playing: false })
        broadcastPlayback({ action: 'pause' })
      }
      system('The host PC went offline. Playback will continue when it\'s back.')
      return
    }
    if (urlChanged && hostLink.online) {
      // Same movie, new address: ask the PC to prepare it again and keep everyone's place.
      try {
        const media = await hostLink.load({ id: screen.media.fileId })
        screen.replaceMediaSource(media)
        system('The host PC is back online.')
        broadcastState()
        broadcastPlayback({ action: 'pause' })
      } catch (e) {
        system(`Couldn't reload the movie: ${e.message}`)
      }
    }
  })
  hostLink.on('library', (library) => io.to(ADMINS).emit('screen:library', library))

  io.on('connection', (socket) => {
    let userId = null

    const reply = (cb, payload) => typeof cb === 'function' && cb(payload)
    const fail = (cb, error) => reply(cb, { ok: false, error })
    const me = () => (userId ? screen.members.get(userId) : null)

    /** Guard: must have joined; optionally must hold the host key. */
    const joined = (cb, { admin = false } = {}) => {
      const m = me()
      if (!m) { fail(cb, `You haven't joined ${screen.name}.`); return null }
      if (admin && !m.admin) { fail(cb, 'Only the host can do that. Enter the host key in Settings.'); return null }
      return m
    }

    // ---- clock sync -------------------------------------------------------
    socket.on('time:ping', (cb) => reply(cb, { serverTime: Date.now() }))

    // ---- join / leave -----------------------------------------------------
    socket.on('screen:join', (data = {}, cb) => {
      try {
        const { clientKey } = data
        if (typeof clientKey !== 'string' || clientKey.length < 16 || clientKey.length > 128) throw new Error('Bad client key')
        const isNew = !screen.members.has(userIdFrom(clientKey))
        const admin = isHostKey(data.hostKey)
        if (data.hostKey && !admin) socket.emit('screen:notice', { kind: 'warn', text: 'That host key is wrong; you joined as a viewer.' })
        const m = screen.join({ clientKey, name: data.username, socketId: socket.id, admin })
        userId = m.id
        socket.join(ROOM)
        if (m.admin) socket.join(ADMINS)
        if (isNew) system(`${m.name} joined`)
        broadcastState()
        reply(cb, {
          ok: true,
          me: m.id,
          admin: m.admin,
          state: screen.snapshot(hostStatus()),
          chat: screen.chat,
          hostAdmin: m.admin ? hostLink.adminStatus() : null,
          library: m.admin ? hostLink.library() : null
        })
      } catch (e) { fail(cb, e.message) }
    })

    const leave = () => {
      const m = me()
      if (!m) return
      socket.leave(ROOM)
      socket.leave(ADMINS)
      m.sockets.delete(socket.id)
      if (!m.sockets.size) {
        screen.remove(m.id)
        system(`${m.name} left`)
      }
      userId = null
      broadcastState()
    }
    socket.on('screen:leave', (cb) => { leave(); reply(cb, { ok: true }) })

    socket.on('screen:report', (r = {}) => { if (userId && r && typeof r === 'object') screen.report(userId, r) })

    // Switched to another tab / minimised (away) or came back.
    socket.on('screen:presence', (p = {}) => {
      if (userId && p && typeof p === 'object' && screen.setAway(userId, p.away)) broadcastState()
    })

    // ---- host controls ----------------------------------------------------
    socket.on('screen:library', async (cb) => {
      if (!joined(cb, { admin: true })) return
      try { reply(cb, { ok: true, library: await hostLink.refreshLibrary() }) } catch (e) { reply(cb, { ok: true, library: hostLink.library(), warning: e.message }) }
    })

    socket.on('screen:load', async (data = {}, cb) => {
      const m = joined(cb, { admin: true }); if (!m) return
      if (!loadLimit(socket.id)) return fail(cb, 'Slow down a little.')
      const req = data.id ? { id: String(data.id).slice(0, 40) } : { name: String(data.name || '').slice(0, 300), size: Number(data.size) || 0 }
      if (!req.id && !req.name) return fail(cb, 'Nothing to load.')
      io.to(ROOM).emit('screen:preparing', { title: req.name || hostLink.library().find((e) => e.id === req.id)?.title || 'a movie', by: m.name })
      try {
        const media = await hostLink.load(req)
        const old = screen.media
        screen.setMedia(media, m.name)
        if (old && old.key !== media.key) hostLink.unload(old.key)
        system(`Now showing: ${media.title}`)
        broadcastState()
        broadcastPlayback({ action: 'load' })
        reply(cb, { ok: true, media })
      } catch (e) {
        io.to(ROOM).emit('screen:preparing', null)
        fail(cb, e.message)
      }
    })

    socket.on('screen:unload', (cb) => {
      if (!joined(cb, { admin: true })) return
      if (screen.media) hostLink.unload(screen.media.key)
      screen.setMedia(null)
      system('The screen is clear')
      broadcastState()
      broadcastPlayback({ action: 'load' })
      reply(cb, { ok: true })
    })

    socket.on('screen:settings', (data = {}, cb) => {
      if (!joined(cb, { admin: true })) return
      if (typeof data.controlsLocked === 'boolean' && data.controlsLocked !== screen.settings.controlsLocked) {
        screen.settings.controlsLocked = data.controlsLocked
        system(data.controlsLocked ? 'Only the host can control playback now' : 'Everyone can control playback')
      }
      if (typeof data.waitForAll === 'boolean' && data.waitForAll !== screen.settings.waitForAll) {
        screen.settings.waitForAll = data.waitForAll
        system(data.waitForAll ? 'The screen will pause if anyone is buffering' : 'The screen won\'t wait for people who are buffering')
      }
      broadcastState()
      reply(cb, { ok: true })
    })

    socket.on('screen:kick', ({ userId: target } = {}, cb) => {
      const m = joined(cb, { admin: true }); if (!m) return
      if (target === m.id) return fail(cb, 'You can\'t remove yourself.')
      const t = screen.members.get(target)
      if (!t) return fail(cb, 'User not found.')
      for (const sid of t.sockets) {
        const s = io.sockets.sockets.get(sid)
        s?.emit('screen:kicked')
        s?.leave(ROOM)
      }
      screen.remove(target)
      system(`${t.name} was removed`)
      broadcastState()
      reply(cb, { ok: true })
    })

    // ---- playback intents (anyone, unless the host locked controls) -------
    const playbackIntent = (action, build) => (data = {}, cb) => {
      const m = joined(cb); if (!m) return
      if (!intentLimit(socket.id)) return fail(cb, 'Too many actions.')
      if (!screen.media) return fail(cb, 'Nothing is playing.')
      if (!screen.canControl(m.id)) return fail(cb, 'The host has locked playback controls.')
      const intent = build(data)
      const firstStart = intent.playing === true && !screen.playback.started
      const resuming = intent.playing === true && !screen.playback.playing
      screen.clearHold()
      screen.applyPlayback(intent, firstStart ? INTRO_MS : resuming ? RESUME_MS : 0)
      broadcastPlayback({ action: firstStart ? 'start' : action, by: m.id })
      if (firstStart) system(`${m.name} started the movie 🍿`)
      reply(cb, { ok: true })
    }
    const pos = (d) => (Number.isFinite(Number(d.position)) ? Number(d.position) : undefined)

    socket.on('playback:play', playbackIntent('play', (d) => ({ playing: true, position: pos(d) })))
    socket.on('playback:pause', playbackIntent('pause', (d) => ({ playing: false, position: pos(d) })))
    socket.on('playback:seek', playbackIntent('seek', (d) => ({ position: pos(d) })))
    socket.on('playback:rate', playbackIntent('rate', (d) => ({ rate: Number(d.rate) })))

    // ---- chat & reactions --------------------------------------------------
    socket.on('chat:send', ({ text } = {}, cb) => {
      const m = joined(cb); if (!m) return
      const body = clean(text, 500)
      if (!body) return fail(cb, 'Empty message')
      if (!chatLimit(socket.id)) return fail(cb, 'You\'re sending messages too quickly.')
      const msg = screen.addChat({ id: crypto.randomUUID(), type: 'user', userId: m.id, name: m.name, color: m.color, text: body, at: Date.now() })
      io.to(ROOM).emit('chat:message', msg)
      reply(cb, { ok: true })
    })

    socket.on('chat:typing', () => {
      const m = me()
      if (m) socket.to(ROOM).emit('chat:typing', { userId: m.id, name: m.name })
    })

    socket.on('reaction:send', ({ emoji } = {}, cb) => {
      const m = joined(cb); if (!m) return
      if (!REACTIONS.has(emoji)) return fail(cb, 'Unknown reaction')
      if (!reactLimit(socket.id)) return fail(cb, 'Easy there!')
      io.to(ROOM).emit('reaction', { emoji, userId: m.id, name: m.name, color: m.color, at: Date.now() })
      reply(cb, { ok: true })
    })

    // ---- disconnect -------------------------------------------------------
    socket.on('disconnect', () => {
      const m = me()
      if (!m) return
      screen.detach(m.id, socket.id, () => {
        system(`${m.name} left`)
        broadcastState()
      })
      broadcastState()
    })
  })
}

function list (names) {
  if (names.length <= 1) return names[0] || 'someone'
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
