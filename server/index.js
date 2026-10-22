/**
 * NickFlix server
 *   Express  — static client, REST API, byte-range video streaming
 *   Socket.IO — watch rooms, ready-up, synced playback, chat, reactions
 *   WebTorrent — one shared torrent client for the whole server
 */
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import helmet from 'helmet'
import compression from 'compression'
import { Server as SocketServer } from 'socket.io'

import { config } from './config.js'
import { TorrentEngine } from './services/torrent-engine.js'
import { MediaService } from './services/media-service.js'
import { RoomManager } from './rooms/room-manager.js'
import { createApi } from './routes/api.js'
import { attachSockets } from './sockets/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CLIENT = path.join(ROOT, 'client')

const engine = new TorrentEngine()
const media = new MediaService()
const rooms = new RoomManager({ engine })

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1) // Render / reverse proxies

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'img-src': ["'self'", 'data:', 'blob:'],
      'media-src': ["'self'", 'blob:'],
      'connect-src': ["'self'", 'ws:', 'wss:', 'blob:'],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'font-src': ["'self'", 'data:']
    }
  },
  crossOriginEmbedderPolicy: false
}))

// Don't gzip video streams — it breaks range requests and wastes CPU.
app.use(compression({ filter: (req, res) => !req.path.startsWith('/api/stream') && !req.path.startsWith('/api/transcode') && compression.filter(req, res) }))
app.use(express.json({ limit: '32kb' }))

app.use('/api', createApi({ engine, media, rooms }))

// Vendored libraries served from node_modules (no CDN needed — works on a LAN with no internet).
app.use('/vendor/videojs', express.static(path.join(ROOT, 'node_modules/video.js/dist'), { maxAge: '7d' }))

app.use(express.static(CLIENT, {
  maxAge: config.isProd ? '1h' : 0,
  setHeaders: (res, file) => { if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache') }
}))

// SPA fallback: /room/ABC123, /library, /watch/... all serve the app shell.
app.get(/^\/(?!api|socket\.io|vendor).*/, (req, res) => res.sendFile(path.join(CLIENT, 'index.html')))

const server = http.createServer(app)
const io = new SocketServer(server, {
  pingInterval: 10_000,
  pingTimeout: 20_000,
  maxHttpBufferSize: 64 * 1024
})
attachSockets(io, { rooms, engine })

server.listen(config.port, config.host, () => {
  console.log(`\n  ▶ NickFlix running at http://localhost:${config.port}\n`)
})

// Graceful shutdown so torrent data on disk is cleaned up.
let closing = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (closing) return
    closing = true
    console.log('\nShutting down…')
    media.killAll()
    io.close()
    server.close()
    await engine.destroy().catch(() => {})
    process.exit(0)
  })
}
