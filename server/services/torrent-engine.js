/**
 * TorrentEngine — wraps a single WebTorrent client for the whole server.
 *
 * Why server-side? Browser WebTorrent can only talk to WebRTC peers, and most
 * public torrents only have classic TCP/UDP peers. Running WebTorrent in Node
 * lets us reach every peer (TCP, uTP, DHT, trackers *and* WebRTC), then hand
 * the browser an ordinary HTTP byte-range stream. It also means everyone in a
 * watch party streams from the same swarm connection.
 *
 * Files start deselected; a file is only downloaded once someone watches it,
 * and WebTorrent prioritises the pieces under the current read position so
 * playback starts as soon as the first few MB arrive.
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import WebTorrent from 'webtorrent'
import parseTorrent from 'parse-torrent'
import { config } from '../config.js'
import { classify, isSample } from '../utils/media-types.js'

const HASH_RE = /^[a-f0-9]{40}$/

export class TorrentEngine extends EventEmitter {
  constructor () {
    super()
    fs.mkdirSync(config.downloadDir, { recursive: true })
    this.client = new WebTorrent({
      maxConns: 80,
      // UPnP / NAT-PMP port mapping is pointless on a cloud host and can stall
      // startup; enable it with NAT_TRAVERSAL=1 when running at home.
      natUpnp: process.env.NAT_TRAVERSAL === '1',
      natPmp: process.env.NAT_TRAVERSAL === '1',
      torrentPort: Number(process.env.TORRENT_PORT) || 0
    })
    this.client.on('error', (err) => console.error('[torrent] client error:', err.message))

    /** infoHash -> { addedAt, lastAccess, pins:Set<string> } */
    this.meta = new Map()
    /** infoHash -> Promise resolving when metadata arrives (dedupes concurrent adds) */
    this.pending = new Map()

    this._sweeper = setInterval(() => this.sweep(), 60_000)
    this._sweeper.unref()
  }

  /**
   * Add a torrent from a magnet URI, info hash or .torrent Buffer.
   * Resolves with the public summary once metadata (file list) is known.
   */
  async add (input) {
    let parsed
    try {
      parsed = await parseTorrent(typeof input === 'string' ? input.trim() : input)
    } catch {
      throw httpError(400, 'That doesn\'t look like a valid magnet link or .torrent file.')
    }
    if (!parsed?.infoHash) throw httpError(400, 'Missing info hash.')
    const infoHash = parsed.infoHash.toLowerCase()

    const existing = await this.client.get(infoHash)
    if (existing?.files?.length) {
      this.touch(infoHash)
      return this.summary(existing)
    }
    if (this.pending.has(infoHash)) return this.pending.get(infoHash)

    this.makeRoom()

    const promise = new Promise((resolve, reject) => {
      const torrent = existing || this.client.add(typeof input === 'string' ? input.trim() : input, {
        path: config.downloadDir,
        deselect: true, // nothing downloads until someone presses play
        destroyStoreOnDestroy: true
      })

      const timer = setTimeout(() => {
        cleanup()
        torrent.destroy({ destroyStore: true })
        reject(httpError(504, 'Couldn\'t find any peers with the file list. The torrent may be dead — try another source.'))
      }, config.metadataTimeoutMs)

      const onMeta = () => {
        cleanup()
        // Belt and braces: make sure nothing auto-downloads.
        torrent.files.forEach((f) => f.deselect())
        this.meta.set(infoHash, { addedAt: Date.now(), lastAccess: Date.now(), pins: new Set() })
        console.log(`[torrent] metadata ready: ${torrent.name} (${torrent.files.length} files)`)
        this.emit('added', infoHash)
        resolve(this.summary(torrent))
      }
      const onError = (err) => {
        cleanup()
        reject(httpError(400, err.message || 'Torrent error'))
      }
      const cleanup = () => {
        clearTimeout(timer)
        torrent.removeListener('metadata', onMeta)
        torrent.removeListener('ready', onMeta)
        torrent.removeListener('error', onError)
      }

      if (torrent.files?.length) return onMeta()
      torrent.once('metadata', onMeta)
      torrent.once('ready', onMeta)
      torrent.once('error', onError)
    }).finally(() => this.pending.delete(infoHash))

    this.pending.set(infoHash, promise)
    return promise
  }

  /** Synchronous lookup (torrents array) — avoids the async parse in client.get(). */
  find (infoHash) {
    if (!HASH_RE.test(infoHash || '')) return null
    return this.client.torrents.find((t) => t.infoHash === infoHash && t.files?.length) || null
  }

  file (infoHash, index) {
    const t = this.find(infoHash)
    if (!t) return null
    const f = t.files[Number(index)]
    return f ? { torrent: t, file: f } : null
  }

  /** Mark a torrent as recently used so the sweeper keeps it. */
  touch (infoHash) {
    const m = this.meta.get(infoHash)
    if (m) m.lastAccess = Date.now()
  }

  /** Rooms "pin" the torrent they're watching so it never gets swept mid-party. */
  pin (infoHash, owner) { this.meta.get(infoHash)?.pins.add(owner) }
  unpin (infoHash, owner) { this.meta.get(infoHash)?.pins.delete(owner) }

  /** Start downloading a file fully in the background (makes later seeks instant). */
  prioritise (infoHash, index) {
    const hit = this.file(infoHash, index)
    if (!hit) return
    hit.file.select()
    this.touch(infoHash)
  }

  async remove (infoHash) {
    const t = this.find(infoHash) || (await this.client.get(infoHash))
    this.meta.delete(infoHash)
    if (!t) return false
    await new Promise((r) => t.destroy({ destroyStore: true }, r))
    this.emit('removed', infoHash)
    return true
  }

  list () {
    return this.client.torrents.filter((t) => t.files?.length).map((t) => this.summary(t))
  }

  /** Public, JSON-safe description of a torrent and its files. */
  summary (t) {
    const files = t.files.map((f, index) => {
      const c = classify(f.name)
      return {
        index,
        name: f.name,
        path: f.path,
        length: f.length,
        ext: c.ext,
        kind: c.kind,
        playable: c.playable,
        sample: c.kind === 'video' && isSample(f.path),
        progress: round(f.progress, 4)
      }
    })
    // Best guess at "the movie": largest non-sample video.
    const main = files
      .filter((f) => f.kind === 'video' && !f.sample)
      .sort((a, b) => b.length - a.length)[0] || files.find((f) => f.kind === 'video')

    return {
      infoHash: t.infoHash,
      name: t.name,
      length: t.length,
      magnetURI: t.magnetURI,
      addedAt: this.meta.get(t.infoHash)?.addedAt || Date.now(),
      mainFileIndex: main ? main.index : null,
      files,
      stats: this.stats(t)
    }
  }

  stats (t) {
    return {
      progress: round(t.progress, 4),
      downloaded: t.downloaded,
      uploaded: t.uploaded,
      downloadSpeed: Math.round(t.downloadSpeed),
      uploadSpeed: Math.round(t.uploadSpeed),
      peers: t.numPeers,
      timeRemaining: Number.isFinite(t.timeRemaining) ? Math.round(t.timeRemaining) : null,
      ratio: round(t.ratio, 2),
      done: t.done
    }
  }

  /** Per-file stats for the stats strip. */
  fileStats (infoHash, index) {
    const hit = this.file(infoHash, index)
    if (!hit) return null
    return { ...this.stats(hit.torrent), fileProgress: round(hit.file.progress, 4), fileLength: hit.file.length }
  }

  /** Keep the server under maxTorrents by dropping the least recently used unpinned torrent. */
  makeRoom () {
    const live = this.client.torrents.filter((t) => t.files?.length)
    if (live.length < config.maxTorrents) return
    const victim = live
      .filter((t) => !(this.meta.get(t.infoHash)?.pins.size))
      .sort((a, b) => (this.meta.get(a.infoHash)?.lastAccess || 0) - (this.meta.get(b.infoHash)?.lastAccess || 0))[0]
    if (victim) {
      console.log(`[torrent] evicting ${victim.name} to make room`)
      this.remove(victim.infoHash)
    }
  }

  /** Remove idle, unpinned torrents. */
  sweep () {
    const cutoff = Date.now() - config.torrentIdleMinutes * 60_000
    for (const [hash, m] of this.meta) {
      if (m.pins.size === 0 && m.lastAccess < cutoff) {
        console.log(`[torrent] idle, removing ${hash}`)
        this.remove(hash)
      }
    }
  }

  destroy () {
    clearInterval(this._sweeper)
    return new Promise((r) => this.client.destroy(r))
  }
}

function round (n, dp) {
  const f = 10 ** dp
  return Math.round((n || 0) * f) / f
}

export function httpError (status, message) {
  const err = new Error(message)
  err.status = status
  return err
}
