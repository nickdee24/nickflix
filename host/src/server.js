/**
 * Local video server. Everything lives under /s/<key>/…, where <key> is a
 * random token minted per movie and only handed to people in Screen 1, so
 * nobody can browse your files through the tunnel.
 *
 *   /s/<key>/master.m3u8             quality ladder
 *   /s/<key>/<quality>/index.m3u8     segment list
 *   /s/<key>/<quality>/segNNNNN.ts    video
 *   /s/<key>/subs/<i>.<ext>           subtitles
 *   /s/<key>/thumb?t=SECONDS          seek-bar preview frame
 */
import fs from 'node:fs'
import http from 'node:http'

const SAFE_Q = /^[0-9]{3,4}p$/

export function createVideoServer ({ streamer, log }) {
  return http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type')
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
    res.setHeader('Timing-Allow-Origin', '*')
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed')

    const url = new URL(req.url, 'http://x')
    const parts = url.pathname.split('/').filter(Boolean)

    if (parts[0] === 'health') return send(res, 200, JSON.stringify({ ok: true, ...streamer.stats() }), 'application/json')
    if (parts[0] !== 's' || !parts[1]) return send(res, 404, 'Not found')

    const s = streamer.get(parts[1])
    if (!s) return send(res, 404, 'This video link has expired', 'text/plain', { 'Cache-Control': 'no-store' })
    const rest = parts.slice(2)

    try {
      if (rest.length === 1 && rest[0] === 'master.m3u8') {
        return send(res, 200, streamer.master(s), 'application/vnd.apple.mpegurl', { 'Cache-Control': 'no-cache' })
      }
      if (rest.length === 2 && SAFE_Q.test(rest[0]) && rest[1] === 'index.m3u8') {
        const body = streamer.variant(s, rest[0])
        return body ? send(res, 200, body, 'application/vnd.apple.mpegurl', { 'Cache-Control': 'no-cache' }) : send(res, 404, 'No such quality')
      }
      if (rest.length === 2 && SAFE_Q.test(rest[0]) && /^seg\d{5}\.ts$/.test(rest[1])) {
        const n = Number(rest[1].slice(3, 8))
        const file = await streamer.segment(s, rest[0], n)
        if (!file) return send(res, 404, 'No such segment')
        return sendFile(req, res, file, 'video/mp2t', 'public, max-age=86400, immutable')
      }
      if (rest.length === 2 && rest[0] === 'subs') {
        const t = await streamer.subtitle(s, Number(rest[1].split('.')[0]))
        if (!t) return send(res, 404, 'Subtitle not available')
        return sendFile(req, res, t.file, 'text/plain; charset=utf-8', 'public, max-age=3600')
      }
      if (rest.length === 1 && rest[0] === 'thumb') {
        const buf = await streamer.thumbnail(s, Number(url.searchParams.get('t')) || 0)
        if (!buf) return send(res, 404, 'No frame')
        return send(res, 200, buf, 'image/jpeg', { 'Cache-Control': 'public, max-age=86400' })
      }
    } catch (e) {
      log(`Request failed ${url.pathname}: ${e.message}`)
      return send(res, 503, e.message, 'text/plain', { 'Retry-After': '1' })
    }
    return send(res, 404, 'Not found')
  })
}

function send (res, status, body, type = 'text/plain', headers = {}) {
  if (res.headersSent) return res.end()
  res.writeHead(status, { 'Content-Type': type, ...headers })
  res.end(body)
}

function sendFile (req, res, file, type, cache) {
  let st
  try { st = fs.statSync(file) } catch { return send(res, 404, 'Gone') }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': cache })
  if (req.method === 'HEAD') return res.end()
  const stream = fs.createReadStream(file)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}
