/**
 * PlayerEngine — adaptive HLS playback of a movie served by the host PC.
 *
 * hls.js measures the connection while it downloads and moves between the
 * quality levels the PC offers (360p … 1080p/4K) so playback doesn't stall.
 * Safari on iPhone (no MediaSource) uses its built-in HLS player instead,
 * which adapts the same way.
 *
 * Video.js provides the tech layer, error normalisation and the subtitle
 * renderer; our own UI sits on top.
 */
/* global videojs, Hls */
import { Emitter } from '../lib/dom.js'
import { settings } from '../state/store.js'
import { cuesToVttUrl } from '../services/subtitles.js'

export class PlayerEngine extends Emitter {
  constructor (videoEl) {
    super()
    this.vjs = videojs(videoEl, {
      controls: false,
      preload: 'auto',
      bigPlayButton: false,
      loadingSpinner: false,
      errorDisplay: false,
      textTrackSettings: false,
      userActions: { doubleClick: false, hotkeys: false },
      html5: { nativeTextTracks: false, nativeAudioTracks: false, nativeVideoTracks: false }
    })
    this.media = null
    this.hls = null
    this.native = false
    this.mode = 'hls'
    this.offset = 0
    this.waiting = false
    this.subs = []            // { id, label, lang, cues, track }
    this.activeSub = null
    this.pendingSeek = null
    this.lastSourceChange = 0

    const v = this.vjs
    v.volume(settings.get('volume'))
    v.muted(settings.get('muted'))

    v.on('timeupdate', () => this.emit('timeupdate', this.time()))
    v.on('play', () => this.emit('play'))
    v.on('pause', () => this.emit('pause'))
    v.on('ended', () => this.emit('ended'))
    v.on('ratechange', () => this.emit('ratechange', v.playbackRate()))
    v.on('volumechange', () => {
      settings.set('volume', v.volume())
      settings.set('muted', v.muted())
      this.emit('volumechange', { volume: v.volume(), muted: v.muted() })
    })
    v.on('progress', () => this.emit('progress'))
    v.on(['waiting', 'stalled'], () => { if (!this.#hasDataAhead()) this.#setWaiting(true) })
    v.on(['playing', 'canplay', 'canplaythrough', 'seeked'], () => { if (!v.seeking()) this.#setWaiting(false) })
    v.on('seeking', () => this.#setWaiting(true))
    v.on('loadedmetadata', () => this.#onMetadata())
    v.on('error', () => this.#onError())
  }

  // ------------------------------------------------------------------ loading
  /**
   * @param {object} media  { masterUrl, duration, title, … } from the server
   * @param {object} o      { startAt, autoplay }
   */
  load (media, o = {}) {
    this.media = media
    this.#destroyHls()
    this.lastSourceChange = Date.now()
    this.pendingSeek = o.startAt > 0 ? o.startAt : null
    this.pendingPlay = !!o.autoplay
    this.#setWaiting(true)
    const el = this.el()

    if (window.Hls && Hls.isSupported()) {
      this.native = false
      const hls = new Hls({
        enableWorker: true,
        startLevel: -1,
        capLevelToPlayerSize: false,
        maxBufferLength: 60,
        maxMaxBufferLength: 180,
        backBufferLength: 90,
        abrEwmaDefaultEstimate: 4_000_000,
        startFragPrefetch: true,
        // The PC may need a second to start encoding after a seek: be patient.
        fragLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 45_000,
            maxLoadTimeMs: 120_000,
            timeoutRetry: { maxNumRetry: 4, retryDelayMs: 500, maxRetryDelayMs: 2000 },
            errorRetry: { maxNumRetry: 8, retryDelayMs: 800, maxRetryDelayMs: 6000 }
          }
        }
      })
      this.hls = hls
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.#applyQualityPreference()
        this.emit('levels', this.qualityOptions())
      })
      hls.on(Hls.Events.LEVEL_SWITCHED, () => this.emit('levelchange', this.levelInfo()))
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          this.emit('notice', 'Connection to the host PC dropped — retrying…')
          setTimeout(() => this.hls === hls && hls.startLoad(), 1500)
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError()
        } else {
          this.emit('fatal', 'The video stream failed. The host PC may be offline.')
        }
      })
      hls.loadSource(media.masterUrl)
      hls.attachMedia(el)
    } else if (el.canPlayType('application/vnd.apple.mpegurl')) {
      this.native = true
      el.src = media.masterUrl
      el.load()
    } else {
      this.emit('fatal', 'This browser can\'t play adaptive video. Try Chrome, Edge, Firefox or Safari.')
      return
    }
    if (o.autoplay) this.#tryPlay()
    this.#rebuildSubs()
  }

  #onMetadata () {
    if (this.pendingSeek != null) { this.vjs.currentTime(this.pendingSeek); this.pendingSeek = null }
    const el = this.el()
    this.emit('loaded', { duration: this.duration(), width: el?.videoWidth, height: el?.videoHeight, mode: this.mode })
  }

  #onError () {
    const err = this.vjs.error()
    if (!err || !this.media) return
    if (this.hls && err.code === 3) { this.vjs.error(null); this.hls.recoverMediaError(); return }
    this.emit('fatal', err.code === 2 ? 'Lost the connection to the host PC.' : err.code === 4 ? 'The video couldn\'t be loaded. Is the host PC online?' : 'Playback failed.')
  }

  #destroyHls () {
    if (this.hls) { this.hls.destroy(); this.hls = null }
    const el = this.el()
    if (el && this.native) { el.removeAttribute('src'); el.load() }
  }

  // ------------------------------------------------------------------ controls
  el () { return this.vjs.tech({ IWillNotUseThisInPlugins: true })?.el() || this.vjs.el().querySelector('video') }

  time () { return this.vjs.currentTime() || 0 }

  duration () {
    const d = this.vjs.duration()
    return Number.isFinite(d) && d > 0 ? d : (this.media?.duration || 0)
  }

  paused () { return this.vjs.paused() }
  isWaiting () { return this.waiting }

  play () { this.pendingPlay = true; return this.#tryPlay() }
  pause () { this.pendingPlay = false; this.vjs.pause() }

  #tryPlay () {
    const p = this.vjs.play()
    if (p?.catch) {
      return p.catch((e) => {
        if (e?.name === 'NotAllowedError') this.emit('autoplay-blocked')
      })
    }
    return Promise.resolve()
  }

  seek (t) {
    t = Math.max(0, Math.min(t, (this.duration() || t + 1) - 0.25))
    this.vjs.currentTime(t)
    this.emit('timeupdate', t)
  }

  rate () { return this.vjs.playbackRate() }
  setRate (r) { this.vjs.playbackRate(r) }
  /** Gentle catch-up rate used by the sync engine without announcing a "rate change". */
  nudgeRate (r) { const el = this.el(); if (el && Math.abs(el.playbackRate - r) > 0.001) el.playbackRate = r }

  volume (v) { if (v === undefined) return this.vjs.volume(); this.vjs.volume(Math.max(0, Math.min(1, v))); if (v > 0) this.vjs.muted(false) }
  muted (m) { if (m === undefined) return this.vjs.muted(); this.vjs.muted(m) }

  /** Buffered ranges: [[start, end], …] */
  bufferedRanges () {
    const b = this.vjs.buffered()
    const out = []
    for (let i = 0; i < (b?.length || 0); i++) out.push([b.start(i), b.end(i)])
    return out
  }

  /** Seconds of video buffered ahead of the playhead. */
  bufferAhead (t = this.time()) {
    const r = this.bufferedRanges().find(([a, b]) => t >= a - 0.3 && t <= b)
    return r ? Math.max(0, r[1] - t) : 0
  }

  #hasDataAhead () { return this.bufferAhead() > 0.5 && !this.vjs.seeking() }

  // ------------------------------------------------------------------ quality
  /** Current level + connection estimate, for the stats line and the buffer bars. */
  levelInfo () {
    const el = this.el()
    const height = el?.videoHeight || 0
    if (!this.hls) return { height, bandwidth: 0, auto: true, name: height ? `${height}p` : '' }
    const lvl = this.hls.levels[this.hls.currentLevel]
    const q = this.media?.qualities?.find((x) => x.height === (lvl?.height || height))
    return {
      height: lvl?.height || height,
      name: lvl?.name || q?.name || (height ? `${height}p` : ''),
      bandwidth: Math.round(this.hls.bandwidthEstimate || 0),
      auto: this.hls.autoLevelEnabled
    }
  }

  qualityOptions () {
    const opts = [{ id: 'auto', label: 'Auto', hint: 'Best for your connection' }]
    if (!this.hls) return opts
    this.hls.levels.forEach((l, i) => opts.push({ id: String(i), label: l.name || `${l.height}p`, hint: `${(l.bitrate / 1e6).toFixed(1)} Mbps` }))
    return opts
  }

  currentQualityId () {
    if (!this.hls || this.hls.autoLevelEnabled) return 'auto'
    return String(this.hls.manualLevel ?? this.hls.currentLevel)
  }

  setQuality (id) {
    if (!this.hls) return
    if (id === 'auto') this.hls.currentLevel = -1
    else this.hls.nextLevel = Number(id) // switch at the next segment, no rebuffer
    this.emit('levelchange', this.levelInfo())
  }

  /** "Max quality" preference from Settings caps Auto (data saver). */
  #applyQualityPreference () {
    const pref = Number(settings.get('maxQuality')) || 0
    if (!pref || !this.hls) return
    const idx = this.hls.levels.reduce((best, l, i) => (l.height <= pref && (best < 0 || l.height > this.hls.levels[best].height) ? i : best), -1)
    if (idx >= 0) this.hls.autoLevelCapping = idx
  }

  // ------------------------------------------------------------------ subtitles
  addSubtitle ({ label, lang = 'en', cues }) {
    const id = `sub${this.subs.length + 1}`
    this.subs.push({ id, label, lang, cues, track: null, url: null })
    this.#rebuildSubs()
    this.selectSubtitle(id)
    this.emit('tracks')
    return id
  }

  listSubtitles () { return this.subs.map(({ id, label, lang }) => ({ id, label, lang })) }

  selectSubtitle (id) {
    this.activeSub = id
    for (const s of this.subs) if (s.track) s.track.mode = s.id === id ? 'showing' : 'disabled'
    this.emit('tracks')
  }

  #rebuildSubs () {
    for (const s of this.subs) {
      if (s.track) { this.vjs.removeRemoteTextTrack(s.track); s.track = null }
      if (s.url) URL.revokeObjectURL(s.url)
      s.url = cuesToVttUrl(s.cues, 0)
      const remote = this.vjs.addRemoteTextTrack({ kind: 'subtitles', label: s.label, srclang: s.lang, src: s.url }, false)
      s.track = remote.track
      s.track.mode = s.id === this.activeSub ? 'showing' : 'disabled'
    }
  }

  #setWaiting (w) {
    if (this.waiting === w) return
    this.waiting = w
    this.emit('waiting', w)
  }

  dispose () {
    this.#destroyHls()
    for (const s of this.subs) if (s.url) URL.revokeObjectURL(s.url)
    this.vjs.dispose()
  }
}
