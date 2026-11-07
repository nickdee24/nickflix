/**
 * Streamer — turns a movie on disk into adaptive HLS, on demand.
 *
 * Every movie gets a *precomputed* VOD playlist per quality (we know the
 * duration, and segments are exactly SEGMENT_SECONDS long because keyframes
 * are forced). Segments are only encoded when somebody asks for them:
 *
 *   request seg N of 720p
 *     ├─ already on disk?            → send it
 *     ├─ an encode will reach it soon → wait for it
 *     └─ otherwise                    → start a new encode at N (a seek)
 *
 * Encodes stop once they're far ahead of what anyone is watching (pausing
 * costs nothing) or when they run into segments that already exist.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { SEGMENT_SECONDS, probe, ladderFor, encodeArgs, thumbArgs, isTextSub, pickAudio } from './media.js'
import { extOf } from './library.js'

const LOOKAHEAD = 6        // segments: wait for a running encode if it's this close
const AHEAD_LIMIT = 90     // segments (~6 min) beyond the furthest request → stop encoding
const WAIT_MS = 60_000
const IDLE_KILL_MS = 20_000

export class Streamer {
  constructor ({ cfg, encoder, tonemap, log }) {
    this.cfg = cfg
    this.encoder = encoder
    this.tonemap = tonemap
    this.log = log
    this.maxJobs = cfg.maxJobs || (encoder === 'libx264' ? 2 : encoder === 'h264_nvenc' ? 6 : 4)
    /** key → Session */
    this.sessions = new Map()
    this.thumbQueue = Promise.resolve()
    this.thumbCache = new Map()
    fs.mkdirSync(cfg.cacheDir, { recursive: true })
    this.tick = setInterval(() => this.#tick(), 1000)
    this.tick.unref()
  }

  // ------------------------------------------------------------ sessions
  /** Prepare a movie. Reuses the existing session for the same file. */
  async open (entry, sidecars = []) {
    for (const s of this.sessions.values()) if (s.entry.id === entry.id && s.entry.mtime === entry.mtime) { s.lastUsed = Date.now(); return s }

    const info = await probe(this.cfg.ffprobePath, entry.path)
    if (!info.video) throw new Error('That file has no video track.')
    const rungs = ladderFor(info)
    const sig = crypto.createHash('sha1').update(`${entry.path}|${entry.size}|${entry.mtime}|${this.encoder}|${rungs.map((r) => r.name).join()}|v2`).digest('hex').slice(0, 10)
    const dir = path.join(this.cfg.cacheDir, `${entry.id}-${sig}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.utimesSync(dir, new Date(), new Date())

    const s = {
      key: crypto.randomBytes(12).toString('base64url'),
      entry,
      info,
      rungs,
      dir,
      jobs: [],
      want: new Map(), // rung → { seg, at }
      subs: [],
      segments: Math.ceil(info.duration / SEGMENT_SECONDS - 0.05),
      lastUsed: Date.now()
    }
    s.subs = this.#prepareSubs(s, sidecars)

    // Keep at most two movies live (the current one and the previous one).
    const live = [...this.sessions.values()].sort((a, b) => b.lastUsed - a.lastUsed)
    for (const old of live.slice(1)) this.close(old.key)
    this.sessions.set(s.key, s)
    this.#pruneCache(dir)

    // Warm up the first segments of a mid quality so the first frame is quick.
    const warm = s.rungs.find((r) => r.height <= 720) || s.rungs[s.rungs.length - 1]
    this.#startJob(s, warm, 0)

    const audio = pickAudio(info)
    this.log(`Prepared "${entry.title}" — ${Math.round(info.duration / 60)} min, ${info.video.width}×${info.video.height} ${info.video.codec}${info.video.hdr ? ' HDR' : ''}, audio ${audio ? `${audio.codec} ${audio.channels}ch` : 'none'}, qualities ${s.rungs.map((r) => r.name).join(' / ')}`)
    return s
  }

  get (key) { return this.sessions.get(key) || null }

  close (key) {
    const s = this.sessions.get(key)
    if (!s) return
    for (const j of s.jobs) this.#kill(j)
    this.sessions.delete(key)
  }

  /** Public description of a session for the website. */
  describe (s, baseUrl) {
    const root = `${baseUrl}/s/${s.key}`
    return {
      key: s.key,
      fileId: s.entry.id,
      title: s.entry.title,
      fileName: s.entry.name,
      size: s.entry.size,
      duration: s.info.duration,
      width: s.info.video.width,
      height: s.info.video.height,
      hdr: s.info.video.hdr,
      masterUrl: `${root}/master.m3u8`,
      thumbUrl: `${root}/thumb`,
      qualities: s.rungs.map((r) => ({ name: r.name, height: r.outHeight, kbps: r.vbr + r.abr })),
      subtitles: s.subs.map((t, i) => ({ id: i, label: t.label, lang: t.lang, ext: t.ext, url: `${root}/subs/${i}.${t.ext}` }))
    }
  }

  // ------------------------------------------------------------ playlists
  master (s) {
    const { width, height, fps } = s.info.video
    const hasAudio = !!pickAudio(s.info)
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS']
    for (const r of s.rungs) {
      const w = Math.round((width * r.outHeight / height) / 2) * 2
      const level = r.outHeight > 1080 ? '640033' : '640028'
      const bw = Math.round((r.vbr + r.abr) * 1000 * 1.15)
      const codecs = `avc1.${level}${hasAudio ? ',mp4a.40.2' : ''}`
      lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(bw * 1.3)},AVERAGE-BANDWIDTH=${bw},RESOLUTION=${w}x${r.outHeight},CODECS="${codecs}",FRAME-RATE=${fps.toFixed(3)},NAME="${r.name}"`)
      lines.push(`${r.name}/index.m3u8`)
    }
    return lines.join('\n') + '\n'
  }

  variant (s, rungName) {
    if (!s.rungs.some((r) => r.name === rungName)) return null
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS + 1}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS']
    for (let i = 0; i < s.segments; i++) {
      const d = Math.min(SEGMENT_SECONDS, s.info.duration - i * SEGMENT_SECONDS)
      lines.push(`#EXTINF:${Math.max(0.1, d).toFixed(6)},`, `seg${String(i).padStart(5, '0')}.ts`)
    }
    lines.push('#EXT-X-ENDLIST')
    return lines.join('\n') + '\n'
  }

  // ------------------------------------------------------------ segments
  /** Resolve the file for segment `n` of a quality, encoding it if needed. */
  async segment (s, rungName, n) {
    const rung = s.rungs.find((r) => r.name === rungName)
    if (!rung || !Number.isInteger(n) || n < 0 || n >= s.segments) return null
    s.lastUsed = Date.now()
    const w = s.want.get(rung.name)
    if (!w || n > w.seg || Date.now() - w.at > 5000) s.want.set(rung.name, { seg: n, at: Date.now() })
    else w.at = Date.now()

    let file = this.#find(s, rung, n)
    if (file) return file

    let job = s.jobs.find((j) => j.rung === rung && j.running && j.start <= n && n <= this.#frontier(j) + LOOKAHEAD)
    if (!job) job = this.#startJob(s, rung, n)
    job.lastWanted = Date.now()

    const deadline = Date.now() + WAIT_MS
    while (Date.now() < deadline) {
      await sleep(120)
      file = this.#find(s, rung, n)
      if (file) return file
      if (!job.running) {
        // That encode ended (finished the movie, got stopped, or failed).
        if (job.error) throw new Error(job.error)
        const again = s.jobs.find((j) => j.rung === rung && j.running && j.start <= n && n <= this.#frontier(j) + LOOKAHEAD)
        if (again) { job = again; continue }
        if (this.#find(s, rung, n)) continue
        if (job.done && n > this.#frontier(job)) return null // past the real end of the file
        job = this.#startJob(s, rung, n)
      }
    }
    throw new Error('Timed out preparing video')
  }

  #find (s, rung, n) {
    const name = `seg${String(n).padStart(5, '0')}.ts`
    // Newest jobs first: they're the ones most likely to have it.
    for (let i = s.jobs.length - 1; i >= 0; i--) {
      const j = s.jobs[i]
      if (j.rung !== rung || n < j.start) continue
      const f = path.join(j.dir, name)
      if (fs.existsSync(f)) return f
    }
    // Segments from earlier runs of the app (cache on disk).
    const rdir = path.join(s.dir, rung.name)
    let subs = []
    try { subs = fs.readdirSync(rdir) } catch { return null }
    for (const d of subs) {
      const f = path.join(rdir, d, name)
      if (fs.existsSync(f)) return f
    }
    return null
  }

  #frontier (j) {
    while (fs.existsSync(path.join(j.dir, `seg${String(j.produced + 1).padStart(5, '0')}.ts`))) j.produced++
    return j.produced
  }

  #startJob (s, rung, startSeg) {
    // Make room: drop idle encodes of the same quality, then the globally least-wanted one.
    for (const j of s.jobs) if (j.rung === rung && j.running && Date.now() - j.lastWanted > IDLE_KILL_MS) this.#kill(j)
    const running = this.#allJobs().filter((j) => j.running)
    if (running.length >= this.maxJobs) {
      running.sort((a, b) => a.lastWanted - b.lastWanted)
      this.#kill(running[0])
    }

    const dir = path.join(s.dir, rung.name, `j${String(startSeg).padStart(5, '0')}-${Date.now().toString(36)}`)
    fs.mkdirSync(dir, { recursive: true })
    const args = encodeArgs({ input: s.entry.path, info: s.info, rung, encoder: this.encoder, startSeg, outDir: dir, tonemap: this.tonemap, hwDecode: this.cfg.hwDecode !== false, normalize: this.cfg.audioNormalize !== false })
    const proc = spawn(this.cfg.ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    const job = { rung, start: startSeg, produced: startSeg - 1, dir, proc, running: true, done: false, error: null, killed: false, lastWanted: Date.now(), started: Date.now(), session: s }
    let err = ''
    proc.stderr.on('data', (d) => { err = (err + d).slice(-2000) })
    proc.on('error', (e) => { job.error = `ffmpeg failed to start: ${e.message}` })
    proc.on('close', (code) => {
      job.running = false
      this.#frontier(job)
      if (code === 0) job.done = true
      else if (!job.killed) {
        job.error = job.error || `Encoding failed (${rung.name}): ${err.trim().split('\n').slice(-2).join(' ') || `exit ${code}`}`
        this.log(job.error)
      }
    })
    s.jobs.push(job)
    // Forget long-finished jobs (their files stay on disk and are still found).
    if (s.jobs.length > 40) s.jobs = s.jobs.filter((j) => j.running || Date.now() - j.started < 600_000)
    return job
  }

  #kill (j) {
    if (!j.running) return
    j.killed = true
    try { j.proc.kill('SIGKILL') } catch {}
  }

  #allJobs () { return [...this.sessions.values()].flatMap((s) => s.jobs) }

  /** Stop encodes that are far enough ahead, or that ran into existing segments. */
  #tick () {
    for (const s of this.sessions.values()) {
      for (const j of s.jobs) {
        if (!j.running) continue
        const f = this.#frontier(j)
        const want = s.want.get(j.rung.name)
        const wantedSeg = want ? want.seg : j.start
        if (f - wantedSeg > AHEAD_LIMIT) { this.#kill(j); continue }
        if (Date.now() - j.lastWanted > 5 * 60_000 && (!want || Date.now() - want.at > 5 * 60_000)) { this.#kill(j); continue }
        // Another encode already covers what comes next → this one is redundant.
        const next = f + 1
        if (next < s.segments && f >= j.start) {
          const other = s.jobs.find((o) => o !== j && o.rung === j.rung && o.start <= next && fs.existsSync(path.join(o.dir, `seg${String(next).padStart(5, '0')}.ts`)))
          if (other) this.#kill(j)
        }
      }
    }
  }

  // ------------------------------------------------------------ subtitles
  #prepareSubs (s, sidecars) {
    const out = sidecars.map((c) => ({ label: c.label, lang: c.lang, ext: extOf(c.path), file: c.path, ready: Promise.resolve() }))
    const text = s.info.subs.filter(isTextSub)
    if (!text.length) return out
    const sdir = path.join(s.dir, 'subs')
    fs.mkdirSync(sdir, { recursive: true })
    const tracks = text.map((t) => ({
      label: [t.title, t.lang ? t.lang.toUpperCase() : null, t.forced ? 'forced' : null].filter(Boolean).join(' · ') || `Track ${t.index + 1}`,
      lang: t.lang,
      ext: 'srt',
      file: path.join(sdir, `${t.index}.srt`),
      index: t.index
    }))
    const missing = tracks.filter((t) => !fs.existsSync(t.file))
    let ready = Promise.resolve()
    if (missing.length) {
      // One pass over the file extracts every text subtitle track.
      ready = new Promise((resolve) => {
        const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', s.entry.path]
        for (const t of missing) args.push('-map', `0:s:${t.index}`, '-c:s', 'srt', `${t.file}.part.srt`)
        const p = spawn(this.cfg.ffmpegPath, args, { windowsHide: true, stdio: 'ignore' })
        p.on('error', () => resolve())
        p.on('close', () => {
          for (const t of missing) { try { fs.renameSync(`${t.file}.part.srt`, t.file) } catch {} }
          resolve()
        })
      })
    }
    for (const t of tracks) t.ready = ready
    return [...out, ...tracks]
  }

  async subtitle (s, i) {
    const t = s.subs[i]
    if (!t) return null
    await t.ready
    return fs.existsSync(t.file) ? t : null
  }

  // ------------------------------------------------------------ thumbnails
  thumbnail (s, t) {
    const sec = Math.max(0, Math.min(Math.round(t), Math.floor(s.info.duration) - 1))
    const ck = `${s.key}:${sec}`
    if (this.thumbCache.has(ck)) return Promise.resolve(this.thumbCache.get(ck))
    // One at a time so dragging across the bar doesn't spawn dozens of ffmpegs.
    const run = this.thumbQueue.then(() => new Promise((resolve) => {
      if (this.thumbCache.has(ck)) return resolve(this.thumbCache.get(ck))
      const p = spawn(this.cfg.ffmpegPath, thumbArgs(s.entry.path, sec), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      const chunks = []
      const timer = setTimeout(() => p.kill('SIGKILL'), 10_000)
      p.stdout.on('data', (d) => chunks.push(d))
      p.on('error', () => resolve(null))
      p.on('close', () => {
        clearTimeout(timer)
        const buf = chunks.length ? Buffer.concat(chunks) : null
        if (buf) {
          this.thumbCache.set(ck, buf)
          if (this.thumbCache.size > 300) this.thumbCache.delete(this.thumbCache.keys().next().value)
        }
        resolve(buf)
      })
    }))
    this.thumbQueue = run.catch(() => {})
    return run
  }

  // ------------------------------------------------------------ housekeeping
  /** Delete the oldest cached movies once the cache is over its size limit. */
  #pruneCache (keepDir) {
    const limit = (this.cfg.cacheLimitGB || 40) * 1024 ** 3
    let dirs = []
    try {
      dirs = fs.readdirSync(this.cfg.cacheDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
        const full = path.join(this.cfg.cacheDir, d.name)
        return { full, size: dirSize(full), mtime: fs.statSync(full).mtimeMs }
      })
    } catch { return }
    let total = dirs.reduce((a, d) => a + d.size, 0)
    const live = new Set([...this.sessions.values()].map((s) => s.dir).concat(keepDir))
    for (const d of dirs.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= limit) break
      if (live.has(d.full)) continue
      fs.rmSync(d.full, { recursive: true, force: true })
      total -= d.size
      this.log(`Cleared old cache (${(d.size / 1024 ** 3).toFixed(1)} GB)`)
    }
  }

  stats () {
    return {
      sessions: this.sessions.size,
      encodes: this.#allJobs().filter((j) => j.running).map((j) => ({ quality: j.rung.name, from: j.start, at: j.produced }))
    }
  }

  shutdown () {
    clearInterval(this.tick)
    for (const j of this.#allJobs()) this.#kill(j)
  }
}

function dirSize (dir) {
  let total = 0
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) total += dirSize(p)
    else { try { total += fs.statSync(p).size } catch {} }
  }
  return total
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
