/** Formatting helpers. */
import { settings } from '../state/store.js'

export function bytes (n, dp = 1) {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : dp)} ${u[i]}`
}

/** Speed as { value, unit } so the number and unit can be styled separately. */
export function speed (bps) {
  if (settings.get('speedUnits') === 'bits') {
    const b = (bps || 0) * 8
    if (b >= 1e6) return { value: (b / 1e6).toFixed(1), unit: 'Mbit/s' }
    return { value: (b / 1e3).toFixed(0), unit: 'kbit/s' }
  }
  if (bps >= 1024 * 1024) return { value: (bps / 1024 / 1024).toFixed(1), unit: 'MB/s' }
  return { value: ((bps || 0) / 1024).toFixed(0), unit: 'KB/s' }
}

export function clock (sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  sec = Math.floor(sec)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

/** "1h 23m" / "4m" — Truck Dash's ETA style */
export function eta (ms) {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const min = Math.round(ms / 60000)
  if (min < 1) return '<1m'
  const h = Math.floor(min / 60)
  return h ? `${h}h ${String(min % 60).padStart(2, '0')}m` : `${min}m`
}

export function pct (p) { return `${Math.round((p || 0) * 100)}%` }

export function timeAgo (t) {
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function timeOfDay (t) {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** "The.Movie.2019.1080p.BluRay.x264.mkv" → "The Movie (2019)" (mirrors the server). */
export function prettyTitle (fileName = '') {
  const base = fileName.split('/').pop().replace(/\.[a-z0-9]{2,4}$/i, '')
  const tidy = (s) => s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim()
  const m = base.match(/^(.*?)[ ._(\[-]+((?:19|20)\d{2})(?:[ ._)\]-]|$)/)
  if (m && m[1]) return `${tidy(m[1])} (${m[2]})`
  const ep = base.match(/^(.*?)[ ._-]+(S\d{1,2}E\d{1,2})/i)
  if (ep) return `${tidy(ep[1])} · ${ep[2].toUpperCase()}`
  return tidy(base.replace(/\b(1080p|720p|2160p|4k|x264|x265|h264|hevc|bluray|web-?dl|webrip|hdrip).*$/i, '')) || tidy(base)
}

/** Pull a resolution tag out of a file name ("1080p", "4K"). */
export function resolutionTag (name = '') {
  const m = name.match(/\b(2160p|4k|1440p|1080p|720p|576p|480p)\b/i)
  return m ? m[1].toUpperCase().replace('2160P', '4K') : null
}

export function initials (name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return [...parts[0]].slice(0, 2).join('').toUpperCase()
  return ([...parts[0]][0] + [...parts[parts.length - 1]][0]).toUpperCase()
}

/** Deterministic gradient for poster-less media cards. */
export function artGradient (seed = '') {
  let h = 0
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) | 0
  const hue = Math.abs(h) % 360
  return `radial-gradient(120% 140% at 15% 10%, hsl(${hue} 70% 42%) 0%, hsl(${(hue + 40) % 360} 60% 18%) 55%, #0d0f12 100%)`
}
