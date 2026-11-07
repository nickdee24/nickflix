/**
 * HostLink — the connection to the NickFlix Host app running on Nick's PC.
 *
 * The host connects to the /host Socket.IO namespace with the shared secret.
 * It tells us its public (tunnel) URL and the movies in its folder, and we
 * ask it to prepare a movie when someone with the host key drops one on
 * Screen 1. Video never passes through this server: viewers stream straight
 * from the PC.
 */
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { config } from './config.js'

const LOAD_TIMEOUT_MS = 120_000

export class HostLink extends EventEmitter {
  constructor (io) {
    super()
    this.socket = null
    this.info = null // { version, publicUrl, encoder, folders, missing, library }
    const nsp = io.of('/host')

    nsp.use((socket, next) => {
      if (!config.hostSecret) return next(new Error('HOST_SECRET is not configured on the website'))
      if (!secretMatches(socket.handshake.auth?.secret)) return next(new Error('Wrong host secret'))
      next()
    })

    nsp.on('connection', (socket) => {
      // Newest host wins (e.g. you restarted the app before the old socket timed out).
      if (this.socket && this.socket.id !== socket.id) this.socket.disconnect(true)
      this.socket = socket
      console.log('[host] connected')

      socket.on('host:hello', (info = {}) => {
        const prevUrl = this.info?.publicUrl
        this.info = sanitizeInfo(info)
        this.emit('status', { urlChanged: prevUrl !== this.info.publicUrl })
        this.emit('library', this.info.library)
      })
      socket.on('host:library', (library) => {
        if (!this.info) return
        this.info.library = sanitizeLibrary(library)
        this.emit('library', this.info.library)
      })
      socket.on('disconnect', () => {
        if (this.socket?.id !== socket.id) return
        console.log('[host] disconnected')
        this.socket = null
        this.info = null
        this.emit('status', { urlChanged: true })
      })
    })
  }

  /** Online = connected and reachable from the internet. */
  get online () { return !!(this.socket?.connected && this.info?.publicUrl) }

  status () {
    return {
      configured: !!config.hostSecret,
      connected: !!this.socket?.connected,
      online: this.online,
      encoder: this.info?.encoder || null,
      movies: this.info?.library?.length ?? 0
    }
  }

  /** Admin-only details (folder paths). */
  adminStatus () {
    return { ...this.status(), folders: this.info?.folders || [], missing: this.info?.missing || [], publicUrl: this.info?.publicUrl || null }
  }

  library () { return this.info?.library || [] }

  async refreshLibrary () {
    const res = await this.#ask('host:library', undefined, 20_000)
    if (this.info) this.info.library = sanitizeLibrary(res.library)
    return this.library()
  }

  /** Ask the PC to prepare a movie by id, or by dropped file name + size. */
  async load (req) {
    const res = await this.#ask('host:load', req, LOAD_TIMEOUT_MS)
    return sanitizeMedia(res.media, this.info?.publicUrl)
  }

  unload (key) { this.socket?.emit('host:unload', { key }) }

  async #ask (event, payload, timeout) {
    if (!this.socket?.connected) throw new Error('The host PC is offline. Start NickFlix Host on the PC with the movies.')
    let res
    try {
      res = payload === undefined
        ? await this.socket.timeout(timeout).emitWithAck(event)
        : await this.socket.timeout(timeout).emitWithAck(event, payload)
    } catch {
      throw new Error('The host PC didn\'t respond in time.')
    }
    if (!res?.ok) throw new Error(res?.error || 'The host PC couldn\'t do that.')
    return res
  }
}

function secretMatches (given) {
  const a = Buffer.from(String(given || ''))
  const b = Buffer.from(config.hostSecret)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function isHostKey (key) { return !!config.hostSecret && secretMatches(key) }

// ---- the host is trusted, but keep what we forward to browsers tidy -------
const str = (v, max = 300) => String(v ?? '').slice(0, max)
const httpsUrl = (v) => {
  try {
    const u = new URL(String(v))
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)) ? u.href.replace(/\/+$/, '') : null
  } catch { return null }
}

function sanitizeInfo (i) {
  return {
    version: str(i.version, 20),
    publicUrl: httpsUrl(i.publicUrl),
    encoder: str(i.encoder, 60),
    folders: Array.isArray(i.folders) ? i.folders.slice(0, 10).map((f) => str(f)) : [],
    missing: Array.isArray(i.missing) ? i.missing.slice(0, 10).map((f) => str(f)) : [],
    library: sanitizeLibrary(i.library)
  }
}

function sanitizeLibrary (list) {
  if (!Array.isArray(list)) return []
  return list.slice(0, 5000).map((e) => ({
    id: str(e.id, 40),
    name: str(e.name),
    title: str(e.title, 200),
    size: Number(e.size) || 0,
    mtime: Number(e.mtime) || 0,
    folder: str(e.folder)
  }))
}

function sanitizeMedia (m, publicUrl) {
  if (!m || !publicUrl) throw new Error('The host PC returned an invalid response.')
  const sameOrigin = (u) => { const x = httpsUrl(u); return x && x.startsWith(publicUrl + '/') ? x : null }
  const masterUrl = sameOrigin(m.masterUrl)
  if (!masterUrl) throw new Error('The host PC returned an invalid video address.')
  return {
    key: str(m.key, 64),
    fileId: str(m.fileId, 40),
    title: str(m.title, 200),
    fileName: str(m.fileName),
    size: Number(m.size) || 0,
    duration: Number(m.duration) || 0,
    width: Number(m.width) || 0,
    height: Number(m.height) || 0,
    hdr: !!m.hdr,
    masterUrl,
    thumbUrl: sameOrigin(m.thumbUrl),
    qualities: Array.isArray(m.qualities) ? m.qualities.slice(0, 8).map((q) => ({ name: str(q.name, 10), height: Number(q.height) || 0, kbps: Number(q.kbps) || 0 })) : [],
    subtitles: Array.isArray(m.subtitles)
      ? m.subtitles.slice(0, 30).map((s) => ({ id: Number(s.id) || 0, label: str(s.label, 80), lang: s.lang ? str(s.lang, 10) : null, ext: str(s.ext, 5), url: sameOrigin(s.url) })).filter((s) => s.url)
      : []
  }
}
