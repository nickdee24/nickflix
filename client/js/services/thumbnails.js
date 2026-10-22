/**
 * Scrub-bar preview thumbnails.
 *
 *  direct mode → a hidden, muted second <video> on the same stream URL is
 *                seeked to the hovered time and drawn to a canvas. The torrent
 *                engine fetches just the pieces needed for that frame.
 *  compat mode → the server renders a JPEG with ffmpeg (/api/thumb).
 *
 * Results are cached in 10-second buckets; only the latest request is served
 * so dragging quickly across the bar doesn't queue hundreds of seeks.
 */
import { api } from './api.js'

const BUCKET = 10

export class Thumbnailer {
  constructor () {
    this.cache = new Map()
    this.video = null
    this.busy = false
    this.wanted = null
  }

  configure ({ infoHash, fileIndex, mode }) {
    this.dispose()
    this.infoHash = infoHash
    this.fileIndex = fileIndex
    this.mode = mode
    if (mode === 'direct') {
      const v = document.createElement('video')
      v.muted = true
      v.preload = 'metadata'
      v.crossOrigin = 'anonymous'
      v.src = api.streamUrl(infoHash, fileIndex)
      this.video = v
    }
  }

  /**
   * Request a thumbnail for `t`; calls `cb(node|null)` when ready.
   * Returns cached result synchronously when available.
   */
  get (t, cb) {
    const key = Math.floor(t / BUCKET) * BUCKET
    if (this.cache.has(key)) return cb(this.cache.get(key))
    if (this.mode === 'compat') {
      const img = new Image()
      img.decoding = 'async'
      img.onload = () => { this.cache.set(key, img); cb(img) }
      img.onerror = () => cb(null)
      img.src = api.thumbUrl(this.infoHash, this.fileIndex, key + BUCKET / 2)
      return
    }
    if (!this.video) return cb(null)
    this.wanted = { key, cb }
    this.#pump()
  }

  #pump () {
    if (this.busy || !this.wanted || !this.video) return
    const { key, cb } = this.wanted
    this.wanted = null
    this.busy = true
    const v = this.video
    let done = false
    const finish = (node) => {
      if (done) return
      done = true
      clearTimeout(timer)
      v.removeEventListener('seeked', onSeeked)
      this.busy = false
      if (node) this.cache.set(key, node)
      cb(node)
      this.#pump()
    }
    const onSeeked = () => {
      try {
        const c = document.createElement('canvas')
        c.width = 320
        c.height = Math.round(320 * ((v.videoHeight || 9) / (v.videoWidth || 16)))
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height)
        finish(c)
      } catch { finish(null) }
    }
    const timer = setTimeout(() => finish(null), 5000)
    v.addEventListener('seeked', onSeeked)
    try { v.currentTime = key + BUCKET / 2 } catch { finish(null) }
  }

  dispose () {
    if (this.video) { this.video.removeAttribute('src'); this.video.load() }
    this.video = null
    this.cache.clear()
    this.busy = false
    this.wanted = null
  }
}
