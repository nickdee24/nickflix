/** REST client for the NickFlix server. */
async function request (method, url, body) {
  const opts = { method, headers: {} }
  if (body instanceof FormData) opts.body = body
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json' }
  let res
  try {
    res = await fetch(url, opts)
  } catch {
    throw new Error('Can\'t reach the NickFlix server. Check your connection.')
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status })
  return data
}

let caps = null

export const api = {
  capabilities: async () => (caps ||= await request('GET', '/api/capabilities').catch(() => ({ ffmpeg: false }))),
  health: () => request('GET', '/api/health'),
  torrents: () => request('GET', '/api/torrents'),
  torrent: (hash) => request('GET', `/api/torrents/${hash}`),
  removeTorrent: (hash) => request('DELETE', `/api/torrents/${hash}`),
  addMagnet: (magnet) => request('POST', '/api/torrents', { magnet }),
  addTorrentFile: (file) => { const fd = new FormData(); fd.append('torrent', file); return request('POST', '/api/torrents', fd) },
  probe: (hash, idx) => request('GET', `/api/probe/${hash}/${idx}`),
  room: (id) => request('GET', `/api/rooms/${encodeURIComponent(id)}`),

  streamUrl: (hash, idx) => `/api/stream/${hash}/${idx}`,
  transcodeUrl: (hash, idx, start = 0, height = null) =>
    `/api/transcode/${hash}/${idx}?start=${start.toFixed(2)}${height ? `&height=${height}` : ''}`,
  thumbUrl: (hash, idx, t) => `/api/thumb/${hash}/${idx}?t=${Math.round(t)}`
}
