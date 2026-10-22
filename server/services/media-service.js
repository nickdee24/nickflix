/**
 * MediaService — optional ffmpeg-powered "compatibility mode".
 *
 * Browsers only decode a handful of codec/container combos. For anything else
 * (AVI, WMV, HEVC MKV, AC3/DTS audio…) we pipe the torrent stream through
 * ffmpeg and emit fragmented MP4 the browser can play while it downloads.
 *
 *  - remux:     container change only (H.264 video copied) — cheap, keeps quality
 *  - transcode: re-encode to H.264/AAC at a chosen height — CPU heavy
 *
 * ffmpeg reads from our own HTTP range endpoint, so `-ss` seeks are fast and
 * only the pieces it needs are fetched from the swarm.
 */
import { spawn, spawnSync } from 'node:child_process'
import { config } from '../config.js'

export class MediaService {
  constructor () {
    this.available = probeBinary(config.ffmpegPath) && probeBinary(config.ffprobePath)
    this.active = new Set()
    /** `${hash}:${idx}` -> probe result */
    this.probeCache = new Map()
    /** small LRU of thumbnails */
    this.thumbCache = new Map()
    console.log(`[media] ffmpeg ${this.available ? 'found — compatibility mode on' : 'not found — direct play only'}`)
  }

  /** Internal URL ffmpeg uses to read the file (our own range endpoint). */
  sourceUrl (hash, idx) {
    return `http://127.0.0.1:${config.port}/api/stream/${hash}/${idx}`
  }

  /** Duration / codecs / resolution. Cached per file. */
  async probe (hash, idx) {
    if (!this.available) return null
    const key = `${hash}:${idx}`
    if (this.probeCache.has(key)) return this.probeCache.get(key)

    const result = await new Promise((resolve) => {
      const p = spawn(config.ffprobePath, [
        '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams',
        '-analyzeduration', '20M', '-probesize', '20M',
        this.sourceUrl(hash, idx)
      ])
      let out = ''
      const timer = setTimeout(() => p.kill('SIGKILL'), 45_000)
      p.stdout.on('data', (d) => { out += d })
      p.on('close', () => {
        clearTimeout(timer)
        try {
          const j = JSON.parse(out)
          const v = j.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1)
          const audio = j.streams.filter((s) => s.codec_type === 'audio')
          const subs = j.streams.filter((s) => s.codec_type === 'subtitle')
          resolve({
            duration: Number(j.format?.duration) || null,
            container: j.format?.format_name || null,
            bitrate: Number(j.format?.bit_rate) || null,
            video: v ? { codec: v.codec_name, width: v.width, height: v.height, fps: fps(v.avg_frame_rate) } : null,
            audio: audio.map((a) => ({ codec: a.codec_name, channels: a.channels, language: a.tags?.language || null })),
            subtitles: subs.map((s) => ({ codec: s.codec_name, language: s.tags?.language || null, title: s.tags?.title || null }))
          })
        } catch {
          resolve(null)
        }
      })
    })
    if (result) this.probeCache.set(key, result)
    return result
  }

  /**
   * Stream fragmented MP4 to `res`.
   * @param {object} o  { hash, idx, start (s), height (null = original), res, req }
   */
  async stream ({ hash, idx, start = 0, height = null, res, req }) {
    if (this.active.size >= config.maxTranscodes) {
      res.status(503).json({ error: 'The server is busy converting other videos. Try again in a moment.' })
      return
    }
    const info = await this.probe(hash, idx)
    const vcodec = info?.video?.codec
    const acodec = info?.audio?.[0]?.codec
    const canCopyVideo = !height && vcodec === 'h264'
    const canCopyAudio = acodec === 'aac' || acodec === 'mp3'

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(Math.max(0, start)),
      '-i', this.sourceUrl(hash, idx),
      '-map', '0:v:0', '-map', '0:a:0?',
      '-sn', '-dn'
    ]
    if (canCopyVideo) {
      args.push('-c:v', 'copy')
    } else {
      args.push('-c:v', 'libx264', '-preset', config.transcodePreset, '-crf', '22',
        '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-g', '48')
      if (height) args.push('-vf', `scale=-2:${height}`)
    }
    if (canCopyAudio) args.push('-c:a', 'copy')
    else args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2')

    args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1')

    const ff = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.active.add(ff)
    let stderr = ''
    ff.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000) })

    res.setHeader('Content-Type', 'video/mp4')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-NickFlix-Mode', canCopyVideo ? 'remux' : 'transcode')
    ff.stdout.pipe(res)

    const stop = () => { if (ff.exitCode === null) ff.kill('SIGKILL') }
    req.on('close', stop)
    ff.on('close', (code) => {
      this.active.delete(ff)
      if (code && code !== 255 && stderr) console.warn('[media] ffmpeg exited', code, stderr.trim().split('\n').pop())
      if (!res.writableEnded) res.end()
    })
  }

  /** Single JPEG frame at `t` seconds, used for scrub-bar previews in compat mode. */
  async thumbnail (hash, idx, t) {
    const key = `${hash}:${idx}:${Math.round(t)}`
    if (this.thumbCache.has(key)) return this.thumbCache.get(key)
    const buf = await new Promise((resolve) => {
      const p = spawn(config.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, t)),
        '-i', this.sourceUrl(hash, idx), '-frames:v', '1', '-vf', 'scale=240:-2',
        '-q:v', '6', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'
      ])
      const chunks = []
      const timer = setTimeout(() => p.kill('SIGKILL'), 15_000)
      p.stdout.on('data', (d) => chunks.push(d))
      p.on('close', () => { clearTimeout(timer); resolve(chunks.length ? Buffer.concat(chunks) : null) })
    })
    if (buf) {
      this.thumbCache.set(key, buf)
      if (this.thumbCache.size > 300) this.thumbCache.delete(this.thumbCache.keys().next().value)
    }
    return buf
  }

  killAll () { for (const p of this.active) p.kill('SIGKILL') }
}

function probeBinary (bin) {
  try { return spawnSync(bin, ['-version'], { timeout: 5000 }).status === 0 } catch { return false }
}

function fps (rate) {
  const [a, b] = String(rate || '').split('/').map(Number)
  return a && b ? Math.round((a / b) * 100) / 100 : null
}
