/**
 * PlayerEngine — one media timeline over two delivery modes.
 *
 *  direct  <video src="/api/stream/…">         byte-range stream, native seeking
 *  compat  <video src="/api/transcode/…?start=S">  ffmpeg fMP4 that *starts at S*
 *
 * In compat mode the element's currentTime is relative to S, so everything
 * public here (time, duration, seek, subtitles) speaks *media time* and the
 * offset is handled internally. Video.js provides the tech layer, error
 * normalisation and the text-track renderer; our own UI sits on top.
 */
/* global videojs */
import { Emitter } from '../lib/dom.js'
import { api } from '../services/api.js'
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
    this.mode = 'direct'
    this.quality = 'original' // 'original' | 1080 | 720 | 480
    this.offset = 0           // compat-mode start offset (s)
    this.probe = null
    this.caps = { ffmpeg: false }
    this.waiting = false
    this.subs = []            // { id, label, lang, cues, track }
    this.activeSub = null
    this.loadToken = 0

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
    v.on(['waiting', 'stalled'], () => this.#setWaiting(true))
    v.on(['playing', 'canplay', 'seeked'], () => { if (!v.seeking()) this.#setWaiting(false) })
    v.on('seeking', () => this.#setWaiting(true))
    v.on('loadedmetadata', () => this.#onMetadata())
    v.on('error', () => this.#onError())
  }

  // ------------------------------------------------------------------ loading
  /**
   * @param {object} media { infoHash, fileIndex, name, ext, playable }
   * @param {object} o     { startAt, autoplay, mode, quality }
   */
  async load (media, o = {}) {
    this.media = media
    this.probe = null
    this.caps = await api.capabilities()
    const token = ++this.loadToken

    let mode = o.mode
    if (!mode) {
      const pref = settings.get('preferredQuality')
      const wantsCompat = ['1080', '720', '480'].includes(String(pref)) && this.caps.ffmpeg
      mode = media.playable === 'transcode' && this.caps.ffmpeg ? 'compat' : wantsCompat ? 'compat' : 'direct'
      this.quality = wantsCompat ? Number(pref) : 'original'
    } else {
      this.quality = o.quality ?? this.quality
    }

    if (mode === 'compat') {
      this.emit('status', { phase: 'probing' })
      try {
        this.probe = await api.probe(media.infoHash, media.fileIndex)
      } catch (e) {
        if (token !== this.loadToken) return
        this.emit('fatal', e.message)
        return
      }
      if (token !== this.loadToken) return
    }
    this.#setSource(mode, o.startAt || 0, !!o.autoplay)
  }

  #setSource (mode, startAt, autoplay) {
    this.mode = mode
    this.lastSourceChange = Date.now()
    const { infoHash, fileIndex } = this.media
    let src
    if (mode === 'compat') {
      this.offset = Math.max(0, startAt)
      src = api.transcodeUrl(infoHash, fileIndex, this.offset, this.quality === 'original' ? null : this.quality)
    } else {
      this.offset = 0
      src = api.streamUrl(infoHash, fileIndex)
      this.pendingSeek = startAt > 0 ? startAt : null
    }
    this.pendingPlay = autoplay
    this.#setWaiting(true)
    this.vjs.src({ src, type: 'video/mp4' }) // type is a hint only; the browser sniffs the container
    this.vjs.load()
    if (autoplay) this.#tryPlay()
    this.#rebuildSubs()
    this.emit('modechange', { mode, quality: this.quality, probe: this.probe })
  }

  #onMetadata () {
    const el = this.el()
    // Direct mode played audio only (e.g. HEVC/AV1 the browser can't draw) → fall back.
    if (this.mode === 'direct' && el && el.videoWidth === 0 && el.videoHeight === 0 && this.#canCompat()) {
      this.#fallback('This video codec isn\'t supported by your browser — switching to compatibility mode.')
      return
    }
    if (this.pendingSeek != null) { this.vjs.currentTime(this.pendingSeek); this.pendingSeek = null }
    this.emit('loaded', { duration: this.duration(), width: el?.videoWidth, height: el?.videoHeight, mode: this.mode })
  }

  #onError () {
    const err = this.vjs.error()
    if (!err || !this.media) return
    // 3 = decode, 4 = source not supported
    if (this.mode === 'direct' && (err.code === 3 || err.code === 4) && this.#canCompat()) {
      this.vjs.error(null)
      this.#fallback('Your browser can\'t play this format directly — converting it on the server.')
      return
    }
    const msg = err.code === 2
      ? 'Network error while streaming. The torrent may have lost its peers.'
      : err.code === 4
        ? 'This format can\'t be played in the browser and compatibility mode isn\'t available on this server.'
        : 'Playback failed.'
    this.emit('fatal', msg)
  }

  #canCompat () { return this.caps.ffmpeg && settings.get('autoCompat') }

  async #fallback (message) {
    const at = this.time()
    const wasPlaying = !this.vjs.paused() || this.pendingPlay
    this.emit('notice', message)
    await this.load(this.media, { mode: 'compat', quality: 'original', startAt: at, autoplay: wasPlaying })
  }

  // ------------------------------------------------------------------ controls
  el () { return this.vjs.tech({ IWillNotUseThisInPlugins: true })?.el() || this.vjs.el().querySelector('video') }

  time () { return this.offset + (this.vjs.currentTime() || 0) }

  duration () {
    if (this.mode === 'compat') return this.probe?.duration || this.offset + (this.vjs.duration() || 0)
    const d = this.vjs.duration()
    return Number.isFinite(d) ? d : 0
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

  /** Seek in media time. Compat mode reloads only when outside the buffered window. */
  seek (t) {
    t = Math.max(0, Math.min(t, (this.duration() || t + 1) - 0.25))
    if (this.mode === 'compat') {
      const rel = t - this.offset
      const buf = this.vjs.buffered()
      const inBuffer = rel >= 0 && buf.length && rel <= buf.end(buf.length - 1) + 0.5
      if (inBuffer) this.vjs.currentTime(rel)
      else this.#setSource('compat', t, !this.vjs.paused() || this.pendingPlay)
    } else {
      this.vjs.currentTime(t)
    }
    this.emit('timeupdate', t)
  }

  rate () { return this.vjs.playbackRate() }
  setRate (r) { this.vjs.playbackRate(r) }
  /** Gentle catch-up rate used by the sync engine without announcing a "rate change". */
  nudgeRate (r) { const el = this.el(); if (el) el.playbackRate = r }

  volume (v) { if (v === undefined) return this.vjs.volume(); this.vjs.volume(Math.max(0, Math.min(1, v))); if (v > 0) this.vjs.muted(false) }
  muted (m) { if (m === undefined) return this.vjs.muted(); this.vjs.muted(m) }

  /** Buffered ranges in media time: [[start, end], …] */
  bufferedRanges () {
    const b = this.vjs.buffered()
    const out = []
    for (let i = 0; i < (b?.length || 0); i++) out.push([b.start(i) + this.offset, b.end(i) + this.offset])
    return out
  }

  /** Quality / mode options for the menu. */
  qualityOptions () {
    const opts = [{ id: 'direct', label: 'Original', hint: 'Direct play' }]
    if (!this.caps.ffmpeg) return opts
    opts.push({ id: 'compat-original', label: 'Original', hint: 'Compat mode' })
    const srcH = this.probe?.video?.height || this.el()?.videoHeight || 2160
    for (const h of [1080, 720, 480]) if (h < srcH - 10) opts.push({ id: `compat-${h}`, label: `${h}p`, hint: 'Transcode' })
    return opts
  }

  currentQualityId () {
    if (this.mode === 'direct') return 'direct'
    return this.quality === 'original' ? 'compat-original' : `compat-${this.quality}`
  }

  async setQuality (id) {
    const at = this.time()
    const playing = !this.vjs.paused()
    if (id === 'direct') {
      this.quality = 'original'
      this.#setSource('direct', at, playing)
      return
    }
    const q = id === 'compat-original' ? 'original' : Number(id.split('-')[1])
    await this.load(this.media, { mode: 'compat', quality: q, startAt: at, autoplay: playing })
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

  /** (Re)create text tracks with the current offset applied. */
  #rebuildSubs () {
    for (const s of this.subs) {
      if (s.track) { this.vjs.removeRemoteTextTrack(s.track); s.track = null }
      if (s.url) URL.revokeObjectURL(s.url)
      s.url = cuesToVttUrl(s.cues, this.offset)
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
    for (const s of this.subs) if (s.url) URL.revokeObjectURL(s.url)
    this.vjs.dispose()
  }
}
