/**
 * Scrub-bar preview thumbnails, rendered by the host PC (/thumb?t=SECONDS).
 *
 * Results are cached in 10-second buckets and only the latest request is
 * served, so dragging quickly across the bar doesn't queue hundreds of frames.
 */
const BUCKET = 10

export class Thumbnailer {
  constructor () {
    this.cache = new Map()
    this.url = null
    this.wanted = null
    this.busy = false
  }

  configure ({ thumbUrl }) {
    this.dispose()
    this.url = thumbUrl || null
  }

  /** Request a thumbnail for `t`; calls `cb(node|null)` when ready. */
  get (t, cb) {
    const key = Math.floor(t / BUCKET) * BUCKET
    if (this.cache.has(key)) return cb(this.cache.get(key))
    if (!this.url) return cb(null)
    this.wanted = { key, cb }
    this.#pump()
  }

  #pump () {
    if (this.busy || !this.wanted) return
    const { key, cb } = this.wanted
    this.wanted = null
    this.busy = true
    const img = new Image()
    img.decoding = 'async'
    const done = (node) => {
      this.busy = false
      if (node) this.cache.set(key, node)
      cb(node)
      this.#pump()
    }
    img.onload = () => done(img)
    img.onerror = () => done(null)
    img.src = `${this.url}?t=${key + BUCKET / 2}`
  }

  dispose () {
    this.cache.clear()
    this.wanted = null
    this.busy = false
  }
}
