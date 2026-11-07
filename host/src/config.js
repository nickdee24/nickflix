/**
 * Host configuration, stored next to the app in host/config.json.
 *
 * The first run creates the file with sensible defaults and a random secret.
 * The same secret goes into the HOST_SECRET environment variable on Render,
 * which is how the website knows this PC is really yours.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const HOST_ROOT = path.resolve(HERE, '..')
export const CONFIG_FILE = process.env.NICKFLIX_HOST_CONFIG || path.join(HOST_ROOT, 'config.json')

const DEFAULTS = {
  /** The website Screen 1 lives on. */
  siteUrl: 'https://nickflix.onrender.com',
  /** Shared secret; must match HOST_SECRET on the website. */
  secret: '',
  /** Folders scanned (recursively) for movies. */
  mediaDirs: [process.platform === 'win32' ? 'D:\\Watch Together - Movies' : path.join(os.homedir(), 'Videos')],
  /** Local port for the video server. */
  port: 8787,
  /**
   * Public https URL of this PC. Leave empty to open a free Cloudflare quick
   * tunnel automatically (no port forwarding needed). Set it if you run your
   * own named tunnel or reverse proxy.
   */
  publicUrl: '',
  /** Where transcoded segments are cached. */
  cacheDir: path.join(os.tmpdir(), 'nickflix-host'),
  /** 'auto' picks NVIDIA → Intel → AMD → CPU. Or force: h264_nvenc | h264_qsv | h264_amf | libx264 */
  encoder: 'auto',
  /** Decode on the GPU as well (NVIDIA only). Turn off if a file shows green/garbled frames. */
  hwDecode: true,
  normalizeAudio: true,
  /** Max simultaneous ffmpeg encodes. 0 = auto (6 on NVIDIA, 4 on other GPUs, 2 on CPU). */
  maxJobs: 0,
  /** Gigabytes of cache kept on disk before old movies are cleared. */
  cacheLimitGB: 40,
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe'
}

export function loadConfig () {
  let saved = {}
  let created = false
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Couldn't read ${CONFIG_FILE}: ${e.message}`)
    created = true
  }
  const cfg = { ...DEFAULTS, ...saved }
  if (!cfg.secret) cfg.secret = crypto.randomBytes(24).toString('base64url')
  // Environment overrides (handy for testing)
  if (process.env.NICKFLIX_SITE) cfg.siteUrl = process.env.NICKFLIX_SITE
  if (process.env.NICKFLIX_SECRET) cfg.secret = process.env.NICKFLIX_SECRET
  if (process.env.NICKFLIX_MEDIA) cfg.mediaDirs = process.env.NICKFLIX_MEDIA.split(path.delimiter)
  if (process.env.NICKFLIX_PUBLIC_URL) cfg.publicUrl = process.env.NICKFLIX_PUBLIC_URL
  if (process.env.NICKFLIX_PORT) cfg.port = Number(process.env.NICKFLIX_PORT)
  if (created || !saved.secret) saveConfig(cfg)
  cfg.siteUrl = cfg.siteUrl.replace(/\/+$/, '')
  cfg.publicUrl = (cfg.publicUrl || '').replace(/\/+$/, '')
  return { cfg, created }
}

export function saveConfig (cfg) {
  const out = {}
  for (const k of Object.keys(DEFAULTS)) out[k] = cfg[k]
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2) + '\n')
}
