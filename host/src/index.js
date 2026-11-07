/**
 * NickFlix Host — run this on the PC that has the movies.
 *
 *  1. Indexes your movie folder.
 *  2. Serves movies as adaptive HLS, encoded on demand with your GPU.
 *  3. Opens a Cloudflare tunnel so viewers can reach it over https.
 *  4. Connects to the website so Screen 1 can load what you drop on it.
 */
import { io } from 'socket.io-client'
import { loadConfig, CONFIG_FILE } from './config.js'
import { Library } from './library.js'
import { Streamer } from './stream.js'
import { createVideoServer } from './server.js'
import { Tunnel } from './tunnel.js'
import { hasBinary, detectEncoder, hasFilter } from './media.js'

const VERSION = '1.0.0'
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a)

const ENCODER_NAMES = { h264_nvenc: 'NVIDIA GPU (NVENC)', h264_qsv: 'Intel GPU (Quick Sync)', h264_amf: 'AMD GPU (AMF)', libx264: 'CPU (x264)' }

async function main () {
  const { cfg, created } = loadConfig()
  console.log('\n  ▶ NickFlix Host\n')

  if (created) {
    console.log(`  First run: settings saved to ${CONFIG_FILE}`)
  }
  console.log('  ┌──────────────────────────────────────────────────────────────')
  console.log('  │ Host secret (put this in HOST_SECRET on Render, and paste it')
  console.log('  │ into Settings → Host key on the site to unlock host controls):')
  console.log(`  │   ${cfg.secret}`)
  console.log('  └──────────────────────────────────────────────────────────────\n')

  if (!hasBinary(cfg.ffmpegPath) || !hasBinary(cfg.ffprobePath)) {
    console.error('  ✖ ffmpeg was not found. Install it, then run this again:')
    console.error('      winget install -e --id Gyan.FFmpeg')
    console.error('    (close and reopen this window afterwards so it\'s on your PATH)\n')
    process.exit(1)
  }

  const encoder = detectEncoder(cfg.ffmpegPath, cfg.encoder)
  const tonemap = hasFilter(cfg.ffmpegPath, 'zscale') && hasFilter(cfg.ffmpegPath, 'tonemap')
  log(`Encoder: ${ENCODER_NAMES[encoder] || encoder}${tonemap ? ' · HDR tone-mapping on' : ''}`)

  const library = new Library(cfg.mediaDirs)
  await library.start()
  for (const d of library.missingDirs()) log(`⚠ Folder not found: ${d}  (edit mediaDirs in ${CONFIG_FILE})`)
  log(`Library: ${library.items.size} movie${library.items.size === 1 ? '' : 's'} in ${cfg.mediaDirs.join(', ')}`)

  const streamer = new Streamer({ cfg, encoder, tonemap, log })
  const server = createVideoServer({ streamer, log })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.port, '127.0.0.1', resolve)
  }).catch((e) => {
    console.error(`  ✖ Port ${cfg.port} is busy (${e.code}). Is the host already running? Change "port" in ${CONFIG_FILE} if needed.`)
    process.exit(1)
  })
  log(`Video server on http://localhost:${cfg.port}`)

  // ---- public URL
  let publicUrl = cfg.publicUrl || null
  let tunnel = null
  if (!publicUrl) {
    tunnel = new Tunnel({ port: cfg.port, log })
    tunnel.on('url', (u) => { publicUrl = u; log(`Public address: ${u}`); announce() })
    tunnel.on('down', () => { publicUrl = null; announce() })
    tunnel.start().catch((e) => { log(`✖ ${e.message}`) })
  } else {
    log(`Public address: ${publicUrl}`)
  }

  // ---- link to the website
  const site = io(`${cfg.siteUrl}/host`, {
    auth: { secret: cfg.secret, version: VERSION },
    transports: ['websocket'],
    reconnectionDelayMax: 10_000
  })
  let warnedAuth = false
  const announce = () => {
    if (!site.connected) return
    site.emit('host:hello', {
      version: VERSION,
      publicUrl,
      encoder: ENCODER_NAMES[encoder] || encoder,
      folders: cfg.mediaDirs,
      missing: library.missingDirs(),
      library: library.list()
    })
  }
  site.on('connect', () => { warnedAuth = false; log(`Connected to ${cfg.siteUrl} — Screen 1 is ready`); announce() })
  site.on('disconnect', (why) => log(`Disconnected from the site (${why}); retrying…`))
  site.on('connect_error', (e) => {
    if (/secret|unauthori[sz]ed|not configured/i.test(e.message)) {
      if (!warnedAuth) log(`✖ The site rejected this host: ${e.message}. Set HOST_SECRET on Render to the secret above.`)
      warnedAuth = true
    } else {
      log(`Can't reach ${cfg.siteUrl} (${e.message}) — retrying… (the free Render plan can take ~1 min to wake up)`)
    }
  })
  library.on('change', () => { log(`Library changed: ${library.items.size} movies`); site.connected && site.emit('host:library', library.list()) })

  site.on('host:library', async (cb) => { await library.scan(); reply(cb, { ok: true, library: library.list() }) })

  site.on('host:load', async (req = {}, cb) => {
    try {
      if (!publicUrl) throw new Error('The host PC is still opening its tunnel. Try again in a few seconds.')
      const entry = req.id ? library.get(req.id) : await library.match(req)
      if (!entry) {
        throw new Error(req.name
          ? `"${req.name}" isn't in your movie folder (${cfg.mediaDirs.join(', ')}). Move it there and drop it again.`
          : 'That movie is no longer in your folder.')
      }
      log(`Loading "${entry.title}"…`)
      const s = await streamer.open(entry, library.sidecarSubs(entry))
      reply(cb, { ok: true, media: streamer.describe(s, publicUrl) })
    } catch (e) {
      log(`✖ ${e.message}`)
      reply(cb, { ok: false, error: e.message })
    }
  })

  site.on('host:unload', ({ key } = {}) => streamer.close(key))

  // ---- shutdown
  const stop = () => {
    log('Shutting down…')
    streamer.shutdown()
    tunnel?.stop()
    library.stop()
    site.close()
    server.close()
    setTimeout(() => process.exit(0), 300)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

const reply = (cb, v) => typeof cb === 'function' && cb(v)

main().catch((e) => { console.error(e); process.exit(1) })
