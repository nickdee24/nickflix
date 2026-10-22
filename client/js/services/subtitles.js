/**
 * Subtitle parsing (SRT / WebVTT / basic ASS) → cue list.
 * Cues are rebuilt into a Blob VTT with a time shift so they stay aligned in
 * compatibility mode, where the <video> timeline starts at the seek offset.
 */
export function parseSubtitles (text, ext = 'srt') {
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  if (ext === 'ass' || ext === 'ssa' || /^\[Script Info\]/m.test(text)) return parseAss(text)
  const cues = []
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.trim().split('\n')
    const i = lines.findIndex((l) => l.includes('-->'))
    if (i < 0) continue
    const [a, b] = lines[i].split('-->').map((s) => s.trim().split(/\s+/)[0])
    const start = toSec(a)
    const end = toSec(b)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    const body = lines.slice(i + 1).join('\n').trim()
    if (body) cues.push({ start, end, text: body })
  }
  return cues
}

function parseAss (text) {
  const cues = []
  let format = null
  for (const line of text.split('\n')) {
    if (line.startsWith('Format:') && !format) format = line.slice(7).split(',').map((s) => s.trim().toLowerCase())
    if (!line.startsWith('Dialogue:') || !format) continue
    const parts = line.slice(9).split(',')
    const get = (k) => parts[format.indexOf(k)]?.trim()
    const textIdx = format.indexOf('text')
    const body = parts.slice(textIdx).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').trim()
    const start = toSec(get('start'))
    const end = toSec(get('end'))
    if (body && Number.isFinite(start)) cues.push({ start, end, text: body })
  }
  return cues
}

function toSec (t = '') {
  const m = t.replace(',', '.').match(/(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)/)
  if (!m) return NaN
  return (Number(m[1]) || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

function fmt (s) {
  s = Math.max(0, s)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = (s % 60).toFixed(3).padStart(6, '0')
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec}`
}

/** Build a VTT blob URL, shifting all cues by -offset seconds. */
export function cuesToVttUrl (cues, offset = 0) {
  const body = cues
    .filter((c) => c.end - offset > 0)
    .map((c) => `${fmt(c.start - offset)} --> ${fmt(c.end - offset)}\n${c.text.replace(/-->/g, '→')}`)
    .join('\n\n')
  return URL.createObjectURL(new Blob([`WEBVTT\n\n${body}\n`], { type: 'text/vtt' }))
}
