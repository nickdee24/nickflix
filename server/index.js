/**
 * NickFlix server (runs on Render)
 *   Express   — static client, tiny REST API
 *   Socket.IO — Screen 1: synced playback, buffer reports, chat, reactions
 *   /host     — the link to NickFlix Host on Nick's PC, which does the actual
 *               video serving; viewers stream straight from the PC
 */
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import helmet from 'helmet'
import compression from 'compression'
import { Server as SocketServer } from 'socket.io'

import { config } from './config.js'
import { Screen } from './screen/screen.js'
import { attachSockets } from './screen/sockets.js'
import { HostLink } from './host-link.js'
import { createApi } from './routes/api.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CLIENT = path.join(ROOT, 'client')

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1) // Render / reverse proxies

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      // Video, thumbnails and subtitles come from the host PC's https tunnel.
      'img-src': ["'self'", 'data:', 'blob:', 'https:'],
      'media-src': ["'self'", 'blob:', 'https:'],
      'connect-src': ["'self'", 'ws:', 'wss:', 'blob:', 'https:', 'http://localhost:*', 'http://127.0.0.1:*'],
      'script-src': ["'self'"],
      'worker-src': ["'self'", 'blob:'], // hls.js parses video in a worker
      'style-src': ["'self'", "'unsafe-inline'"],
      'font-src': ["'self'", 'data:']
    }
  },
  crossOriginEmbedderPolicy: false
}))

app.use(compression())
app.use(express.json({ limit: '32kb' }))

const server = http.createServer(app)
const io = new SocketServer(server, {
  pingInterval: 10_000,
  pingTimeout: 20_000,
  maxHttpBufferSize: 64 * 1024
})

const screen = new Screen()
const hostLink = new HostLink(io)
const sockets = attachSockets(io, { screen, hostLink })

app.use('/api', createApi({ screen, hostLink, bye: sockets.bye }))

// Vendored libraries served from node_modules (no CDN needed).
app.use('/vendor/videojs', express.static(path.join(ROOT, 'node_modules/video.js/dist'), { maxAge: '7d' }))
app.use('/vendor/hls', express.static(path.join(ROOT, 'node_modules/hls.js/dist'), { maxAge: '7d' }))

app.use(express.static(CLIENT, {
  maxAge: config.isProd ? '1h' : 0,
  setHeaders: (res, file) => { if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache') }
}))

// SPA fallback: /, /settings, old /room/… links all serve the app shell.
app.get(/^\/(?!api|socket\.io|vendor).*/, (req, res) => res.sendFile(path.join(CLIENT, 'index.html')))

server.listen(config.port, config.host, () => {
  console.log(`\n  ▶ NickFlix running at http://localhost:${config.port}`)
  if (!config.hostSecret) console.log('  ⚠ HOST_SECRET is not set: the host PC can\'t connect until it is.\n')
})

let closing = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (closing) return
    closing = true
    console.log('\nShutting down…')
    io.close()
    server.close()
    setTimeout(() => process.exit(0), 300)
  })
}
