/**
 * Library — the movies in your media folder(s).
 *
 * Files are found recursively and identified by a short hash of their path,
 * so the website only ever sees ids and names, never your folder layout.
 * A drop onto the player is matched by file name + size (that's all a browser
 * reveals about a dragged file).
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'

const VIDEO = new Set(['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'm2ts', 'mts', 'vob', 'divx', 'ogv', '3gp'])
const SUBS = new Set(['srt', 'vtt', 'ass', 'ssa'])
const MAX_DEPTH = 6

export const extOf = (p) => path.extname(p).slice(1).toLowerCase()

export class Library extends EventEmitter {
  constructor (dirs) {
    super()
    this.dirs = dirs.map((d) => path.resolve(d))
    /** @type {Map<string, Entry>} */
    this.items = new Map()
    this.scanning = null
    this.watchers = []
  }

  async start () {
    await this.scan()
    for (const dir of this.dirs) {
      try {
        let t = null
        const w = fs.watch(dir, { recursive: true }, () => {
          clearTimeout(t)
          t = setTimeout(() => this.scan().catch(() => {}), 1500)
        })
        w.on('error', () => {})
        this.watchers.push(w)
      } catch { /* recursive watch unsupported here; periodic rescans still run */ }
    }
    this.timer = setInterval(() => this.scan().catch(() => {}), 120_000)
    this.timer.unref()
  }

  missingDirs () { return this.dirs.filter((d) => !fs.existsSync(d)) }

  scan () {
    if (this.scanning) return this.scanning
    this.scanning = (async () => {
      const next = new Map()
      for (const root of this.dirs) await walk(root, root, 0, next)
      const before = [...this.items.keys()].sort().join()
      this.items = next
      if ([...next.keys()].sort().join() !== before) this.emit('change')
    })().finally(() => { this.scanning = null })
    return this.scanning
  }

  get (id) { return this.items.get(id) || null }

  /** Match a dropped file. Exact name+size first, then name only. */
  async match ({ name, size }) {
    const find = () => {
      const all = [...this.items.values()]
      const n = String(name || '').toLowerCase()
      return all.find((e) => e.name.toLowerCase() === n && (!size || e.size === Number(size))) ||
        all.find((e) => e.name.toLowerCase() === n) || null
    }
    let hit = find()
    if (!hit) { await this.scan(); hit = find() }
    return hit
  }

  /** What the website gets: no absolute paths. */
  list () {
    return [...this.items.values()]
      .sort((a, b) => a.title.localeCompare(b.title))
      .map(({ id, name, title, size, mtime, folder }) => ({ id, name, title, size, mtime, folder }))
  }

  /** Subtitle files that sit next to a movie (same base name, or a Subs folder). */
  sidecarSubs (entry) {
    const dir = path.dirname(entry.path)
    const base = path.basename(entry.path, path.extname(entry.path)).toLowerCase()
    const out = []
    const look = (folder, requireBase) => {
      let names = []
      try { names = fs.readdirSync(folder) } catch { return }
      for (const n of names) {
        if (!SUBS.has(extOf(n))) continue
        const stem = n.slice(0, -(extOf(n).length + 1)).toLowerCase()
        if (requireBase && !stem.startsWith(base)) continue
        const lang = stem.slice(base.length).replace(/^[ ._-]+/, '') || null
        out.push({ path: path.join(folder, n), label: lang ? `${lang} (file)` : n, lang })
      }
    }
    look(dir, true)
    for (const sub of ['Subs', 'subs', 'Subtitles', 'subtitles']) look(path.join(dir, sub), false)
    return out
  }

  stop () {
    clearInterval(this.timer)
    for (const w of this.watchers) w.close()
  }
}

async function walk (root, dir, depth, out) {
  if (depth > MAX_DEPTH) return
  let entries
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('$')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) { await walk(root, full, depth + 1, out); continue }
    if (!e.isFile() || !VIDEO.has(extOf(e.name))) continue
    if (/(^|[^a-z])sample([^a-z]|$)/i.test(e.name)) continue
    let st
    try { st = await fs.promises.stat(full) } catch { continue }
    if (st.size < 5 * 1024 * 1024) continue // skip tiny clips / extras
    const id = crypto.createHash('sha1').update(full.toLowerCase()).digest('hex').slice(0, 12)
    out.set(id, {
      id,
      path: full,
      name: e.name,
      title: prettyTitle(e.name),
      size: st.size,
      mtime: Math.round(st.mtimeMs),
      folder: path.relative(root, dir) || ''
    })
  }
}

/** "The.Movie.2019.1080p.BluRay.x264-GRP.mkv" → "The Movie (2019)" */
export function prettyTitle (fileName) {
  const base = fileName.replace(/\.[a-z0-9]{2,4}$/i, '')
  const tidy = (s) => s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim()
  const m = base.match(/^(.*?)[ ._(\[-]+((?:19|20)\d{2})(?:[ ._)\]-]|$)/)
  if (m && m[1]) return `${tidy(m[1])} (${m[2]})`
  const ep = base.match(/^(.*?)[ ._-]+(S\d{1,2}E\d{1,2})/i)
  if (ep) return `${tidy(ep[1])} · ${ep[2].toUpperCase()}`
  return tidy(base.replace(/\b(1080p|720p|2160p|4k|x264|x265|h264|hevc|bluray|web-?dl|webrip|hdrip).*$/i, '')) || tidy(base)
}
