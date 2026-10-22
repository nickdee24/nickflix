/**
 * File classification helpers shared by the torrent engine and the API.
 */
import path from 'node:path'

const VIDEO = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'm2ts', 'mts', '3gp', 'ogv', 'vob', 'divx'])
const SUBTITLE = new Set(['srt', 'vtt', 'ass', 'ssa'])

/** Formats the browser can usually decode straight from the stream. */
const DIRECT = new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv'])
/** Containers that often play directly (H.264/AAC MKV in Chromium) but may need remuxing. */
const MAYBE = new Set(['mkv'])

const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', flv: 'video/x-flv',
  mpg: 'video/mpeg', mpeg: 'video/mpeg', ts: 'video/mp2t', m2ts: 'video/mp2t', mts: 'video/mp2t',
  '3gp': 'video/3gpp', vob: 'video/mpeg', divx: 'video/x-msvideo',
  srt: 'text/plain; charset=utf-8', vtt: 'text/vtt; charset=utf-8', ass: 'text/plain; charset=utf-8', ssa: 'text/plain; charset=utf-8'
}

export const extOf = (name) => path.extname(name).slice(1).toLowerCase()

export function classify (name) {
  const ext = extOf(name)
  if (VIDEO.has(ext)) {
    // Skip obvious samples so the "main feature" is picked first.
    return {
      ext,
      kind: 'video',
      playable: DIRECT.has(ext) ? 'direct' : MAYBE.has(ext) ? 'maybe' : 'transcode'
    }
  }
  if (SUBTITLE.has(ext)) return { ext, kind: 'subtitle', playable: null }
  return { ext, kind: 'other', playable: null }
}

export const mimeOf = (name) => MIME[extOf(name)] || 'application/octet-stream'

export const isSample = (name) => /(^|[^a-z])sample([^a-z]|$)/i.test(name)
