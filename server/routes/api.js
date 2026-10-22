/**
 * REST API
 *
 *  GET    /api/health
 *  GET    /api/capabilities                 → { ffmpeg }
 *  GET    /api/torrents                     → library (torrents live on the server)
 *  POST   /api/torrents                     → add (multipart "torrent" file, or JSON { magnet })
 *  GET    /api/torrents/:hash               → summary + stats
 *  DELETE /api/torrents/:hash
 *  GET    /api/stream/:hash/:idx            → HTTP range stream of a file (video or subtitle)
 *  GET    /api/probe/:hash/:idx             → ffprobe info (compat mode)
 *  GET    /api/transcode/:hash/:idx?start=&height=   → fragmented MP4 (compat mode)
 *  GET    /api/thumb/:hash/:idx?t=          → JPEG preview frame (compat mode)
 *  GET    /api/rooms/:id                    → public room info (for join screens)
 */
import express from 'express'
import multer from 'multer'
import { config } from '../config.js'
import { mimeOf } from '../utils/media-types.js'
import { bucket } from '../utils/rate-limit.js'

export function createApi ({ engine, media, rooms }) {
  const router = express.Router()
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxTorrentFileBytes, files: 1 } })
  const addLimiter = bucket(10, 60_000)

  // Async error wrapper so thrown httpErrors become JSON responses.
  const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

  router.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }))

  router.get('/capabilities', (req, res) => res.json({
    ffmpeg: media.available,
    maxTranscodes: config.maxTranscodes
  }))

  router.get('/torrents', (req, res) => res.json(engine.list()))

  router.post('/torrents', upload.single('torrent'), h(async (req, res) => {
    if (!addLimiter(req.ip)) return res.status(429).json({ error: 'Slow down a little — too many torrents added.' })
    const input = req.file?.buffer || req.body?.magnet
    if (!input) return res.status(400).json({ error: 'Upload a .torrent file or paste a magnet link.' })
    if (typeof input === 'string' && input.length > 8000) return res.status(400).json({ error: 'Magnet link is too long.' })
    const summary = await engine.add(input)
    res.json(summary)
  }))

  router.get('/torrents/:hash', (req, res) => {
    const t = engine.find(req.params.hash)
    if (!t) return res.status(404).json({ error: 'Torrent not found on the server (it may have been cleaned up).' })
    res.json(engine.summary(t))
  })

  router.delete('/torrents/:hash', h(async (req, res) => {
    if (rooms.isInUse(req.params.hash)) return res.status(409).json({ error: 'A watch room is using this torrent.' })
    await engine.remove(req.params.hash)
    res.json({ ok: true })
  }))

  // ---- Streaming -----------------------------------------------------------
  router.get('/stream/:hash/:idx', (req, res) => {
    const hit = engine.file(req.params.hash, req.params.idx)
    if (!hit) return res.status(404).end()
    const { file } = hit
    engine.touch(req.params.hash)

    const size = file.length
    let start = 0
    let end = size - 1
    const range = req.headers.range

    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', mimeOf(file.name))
    res.setHeader('Cache-Control', 'no-store')

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      if (!m) return res.status(416).end()
      if (m[1] === '' && m[2] !== '') { // suffix range: last N bytes
        start = Math.max(0, size - Number(m[2]))
      } else {
        start = Number(m[1] || 0)
        if (m[2] !== '') end = Math.min(Number(m[2]), size - 1)
      }
      if (start >= size || start > end) {
        res.setHeader('Content-Range', `bytes */${size}`)
        return res.status(416).end()
      }
      res.status(206)
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
    }
    res.setHeader('Content-Length', end - start + 1)
    if (req.method === 'HEAD') return res.end()

    const stream = file.createReadStream({ start, end })
    stream.on('error', () => res.destroy())
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  })

  // ---- Compatibility mode (ffmpeg) ----------------------------------------
  const needFfmpeg = (req, res, next) =>
    media.available ? next() : res.status(501).json({ error: 'Compatibility mode needs ffmpeg on the server.' })

  router.get('/probe/:hash/:idx', needFfmpeg, h(async (req, res) => {
    if (!engine.file(req.params.hash, req.params.idx)) return res.status(404).json({ error: 'File not found' })
    const info = await media.probe(req.params.hash, req.params.idx)
    if (!info) return res.status(502).json({ error: 'Couldn\'t read this video yet — not enough data downloaded.' })
    res.json(info)
  }))

  router.get('/transcode/:hash/:idx', needFfmpeg, h(async (req, res) => {
    if (!engine.file(req.params.hash, req.params.idx)) return res.status(404).end()
    engine.touch(req.params.hash)
    const start = clamp(Number(req.query.start) || 0, 0, 60 * 60 * 24)
    const height = [360, 480, 720, 1080].includes(Number(req.query.height)) ? Number(req.query.height) : null
    await media.stream({ hash: req.params.hash, idx: req.params.idx, start, height, req, res })
  }))

  router.get('/thumb/:hash/:idx', needFfmpeg, h(async (req, res) => {
    if (!engine.file(req.params.hash, req.params.idx)) return res.status(404).end()
    const buf = await media.thumbnail(req.params.hash, req.params.idx, clamp(Number(req.query.t) || 0, 0, 86400))
    if (!buf) return res.status(204).end()
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.end(buf)
  }))

  // ---- Rooms (read-only; everything live goes over Socket.IO) -------------
  router.get('/rooms/:id', (req, res) => {
    const info = rooms.publicInfo(req.params.id)
    if (!info) return res.status(404).json({ error: 'Room not found. It may have expired.' })
    res.json(info)
  })

  // JSON error handler for this router
  router.use((err, req, res, next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500)
    if (status >= 500) console.error('[api]', err)
    if (res.headersSent) return res.end()
    res.status(status).json({ error: status === 413 ? 'That .torrent file is too large.' : err.message || 'Server error' })
  })

  return router
}

const clamp = (n, a, b) => Math.min(b, Math.max(a, n))
