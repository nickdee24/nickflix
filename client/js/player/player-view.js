/**
 * PlayerView — the premium player UI.
 *
 * Usage:
 *   const pv = new PlayerView({ title, badges, torrentSubs, controller })
 *   container.append(pv.el)
 *   await pv.load(media, { startAt, autoplay })
 *
 * `controller` decides what a user action *means*. Solo viewing calls the
 * engine directly; in a watch room the SyncService sends the intent to the
 * server and the authoritative state comes back to every client.
 */
import { h, Emitter, Disposer } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { clock, speed as fmtSpeed } from '../lib/format.js'
import { settings } from '../state/store.js'
import { api } from '../services/api.js'
import { parseSubtitles } from '../services/subtitles.js'
import { Thumbnailer } from '../services/thumbnails.js'
import { PlayerEngine } from './engine.js'
import { toast } from '../components/toast.js'
import { showShortcuts } from './shortcuts.js'

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
const SUB_SIZES = [{ v: 1.2, l: 'Small' }, { v: 1.6, l: 'Medium' }, { v: 2.1, l: 'Large' }, { v: 2.7, l: 'Huge' }]

export class PlayerView extends Emitter {
  constructor ({ title = '', badges = [], torrentSubs = [], controller = null, extraTop = null } = {}) {
    super()
    this.d = new Disposer()
    this.torrentSubs = torrentSubs
    this.stats = null
    this.menu = null
    this.dragging = false
    this.hideTimer = null
    this.theatre = false

    this.#build(title, badges, extraTop)
    this.engine = new PlayerEngine(this.videoEl)
    this.controller = controller || {
      play: () => this.engine.play(),
      pause: () => this.engine.pause(),
      seek: (t) => this.engine.seek(t),
      setRate: (r) => this.engine.setRate(r),
      canControl: () => true
    }
    this.thumbs = new Thumbnailer()
    this.#wireEngine()
    this.#wireInput()
    this.#applySubSize()
    this.d.add(settings.on('change:subtitleSize', () => this.#applySubSize()))
    this.d.interval(() => this.#tick(), 250)
  }

  // ================================================================== DOM
  #build (title, badges, extraTop) {
    this.videoEl = h('video-js.vjs-nickflix', { playsinline: true, preload: 'auto' })
    this.titleEl = h('h3.truncate', title)
    this.badgesEl = h('div.t-sub', badges)
    this.netChip = h('div.chip.sm.info', h('span.dot'), h('span.num', 'Connecting…'))

    this.bigPlay = h('button.fab.lg.accent.big-play', { 'aria-label': 'Play', onclick: () => this.togglePlay() }, icon('play'))
    this.centerEl = h('div.player-center', this.bigPlay)

    // Seek bar
    this.playedEl = h('div.played')
    this.bufferedEl = h('div.buffered')
    this.knobEl = h('div.knob')
    this.previewThumb = h('div.thumb.empty')
    this.previewTime = h('div.ptime', '0:00')
    this.previewEl = h('div.seek-preview', this.previewThumb, this.previewTime)
    this.seekEl = h('div.seek', { role: 'slider', tabindex: 0, 'aria-label': 'Seek', 'aria-valuemin': 0 },
      h('div.track', this.bufferedEl, this.playedEl, this.knobEl),
      this.previewEl
    )

    const cb = (name, label, onclick, cls = '') =>
      h(`button.cbtn${cls}`, { 'aria-label': label, title: label, onclick: (e) => { e.stopPropagation(); onclick(e) } }, icon(name))

    this.playBtn = cb('play', 'Play (K)', () => this.togglePlay())
    this.muteBtn = cb('volume', 'Mute (M)', () => this.engine.muted(!this.engine.muted()))
    this.volSlider = h('input.slider', {
      type: 'range', min: 0, max: 1, step: 0.02, value: settings.get('volume'), 'aria-label': 'Volume',
      oninput: (e) => this.engine.volume(Number(e.target.value))
    })
    this.timeEl = h('div.time.num', '0:00', h('span', ' / 0:00'))
    this.syncSlot = h('div.sync-pill')
    this.speedBtn = cb('speed', 'Playback speed', (e) => this.#openMenu('speed', e.currentTarget), '.hide-sm')
    this.ccBtn = cb('cc', 'Subtitles (C)', (e) => this.#openMenu('subs', e.currentTarget))
    this.qualityBtn = cb('quality', 'Quality', (e) => this.#openMenu('quality', e.currentTarget))
    this.pipBtn = cb('pip', 'Picture in picture (P)', () => this.togglePip(), '.hide-sm')
    this.theatreBtn = cb('theatre', 'Theatre mode (T)', () => this.toggleTheatre(), '.hide-sm')
    this.fsBtn = cb('fullscreen', 'Fullscreen (F)', () => this.toggleFullscreen())
    if (!document.pictureInPictureEnabled) this.pipBtn.disabled = true

    this.controlsEl = h('div.controls', { onclick: (e) => e.stopPropagation() },
      this.seekEl,
      h('div.ctrl-row',
        this.playBtn,
        cb('back10', 'Back 10s (J)', () => this.skip(-10), '.hide-sm'),
        cb('fwd10', 'Forward 10s (L)', () => this.skip(10), '.hide-sm'),
        h('div.volume', this.muteBtn, this.volSlider),
        this.timeEl,
        h('div.grow'),
        this.syncSlot,
        this.speedBtn, this.ccBtn, this.qualityBtn, this.pipBtn, this.theatreBtn, this.fsBtn
      )
    )

    this.reactionLayer = h('div.reaction-layer')
    this.topEl = h('div.player-top',
      h('div.t-title', this.titleEl, this.badgesEl),
      h('div.t-right', this.netChip, extraTop)
    )

    this.overlay = h('div.player-overlay', this.topEl, this.centerEl, this.reactionLayer, this.controlsEl)
    this.el = h('div.player', { dataset: { state: 'idle', controls: 'shown' }, tabindex: -1 }, this.videoEl, this.overlay)
    this.fileInput = h('input', { type: 'file', accept: '.srt,.vtt,.ass,.ssa', hidden: true, onchange: (e) => this.#loadSubFile(e.target.files[0]) })
    this.el.append(this.fileInput)
  }

  setTitle (title, badges) {
    this.titleEl.textContent = title
    if (badges) this.badgesEl.replaceChildren(...badges)
  }

  /** Slot for the room's sync indicator. */
  setSyncPill (node) { this.syncSlot.replaceChildren(node || '') }

  // ================================================================== loading
  async load (media, opts = {}) {
    this.media = media
    this.setState('loading')
    this.#clearCenter()
    this.#showBuffering(true)
    await this.engine.load(media, opts)
    this.thumbs.configure({ infoHash: media.infoHash, fileIndex: media.fileIndex, mode: this.engine.mode })
    this.#autoSubtitle()
  }

  /** Automatically pick an English (or the only) subtitle shipped with the torrent. */
  async #autoSubtitle () {
    if (!this.torrentSubs.length || this.autoSubTried) return
    this.autoSubTried = true
    const pick = this.torrentSubs.find((s) => /eng|english|\.en\./i.test(s.name)) || (this.torrentSubs.length === 1 ? this.torrentSubs[0] : null)
    if (pick) this.#loadTorrentSub(pick, true)
  }

  // ================================================================== engine → UI
  #wireEngine () {
    const e = this.engine
    e.on('play', () => this.setState('playing'))
    e.on('pause', () => { if (!e.isWaiting()) this.setState('paused') })
    e.on('ended', () => { this.setState('paused'); this.emit('ended') })
    e.on('waiting', (w) => this.#showBuffering(w))
    e.on('loaded', () => {
      this.#showBuffering(e.isWaiting())
      if (e.paused()) this.setState('ready')
      this.emit('loaded')
    })
    e.on('modechange', ({ mode }) => {
      this.thumbs.configure({ infoHash: this.media.infoHash, fileIndex: this.media.fileIndex, mode })
      this.qualityBtn.classList.toggle('on', mode === 'compat')
    })
    e.on('volumechange', ({ volume, muted }) => {
      const v = muted ? 0 : volume
      this.volSlider.value = v
      this.volSlider.style.setProperty('--fill', `${v * 100}%`)
      this.muteBtn.replaceChildren(icon(muted || v === 0 ? 'mute' : v < 0.5 ? 'volumeLow' : 'volume'))
    })
    e.on('tracks', () => this.ccBtn.classList.toggle('on', !!e.activeSub))
    e.on('notice', (m) => toast(m, 'info', 5000))
    e.on('fatal', (m) => this.#showError(m))
    e.on('autoplay-blocked', () => {
      this.setState('paused')
      toast('Tap play to start — your browser blocked autoplay with sound.', 'warn', 5000)
      this.emit('autoplay-blocked')
    })
    this.volSlider.style.setProperty('--fill', `${(settings.get('muted') ? 0 : settings.get('volume')) * 100}%`)
  }

  setState (s) {
    this.el.dataset.state = s
    const playing = s === 'playing'
    this.playBtn.replaceChildren(icon(playing ? 'pause' : 'play'))
    this.playBtn.setAttribute('aria-label', playing ? 'Pause (K)' : 'Play (K)')
    if (!playing) this.#showControls(true)
    else this.#scheduleHide()
  }

  /** Called ~4×/s: time display, seek bar, buffering text. */
  #tick () {
    const e = this.engine
    const dur = e.duration()
    const t = this.dragging ? this.dragTime : e.time()
    this.timeEl.firstChild.textContent = clock(t)
    this.timeEl.lastChild.textContent = ` / ${clock(dur)}`
    const p = dur ? Math.min(1, t / dur) : 0
    this.playedEl.style.width = `${p * 100}%`
    this.knobEl.style.left = `${p * 100}%`
    this.seekEl.setAttribute('aria-valuemax', Math.round(dur))
    this.seekEl.setAttribute('aria-valuenow', Math.round(t))
    // furthest buffered range that contains the playhead
    const r = e.bufferedRanges().find(([a, b]) => t >= a - 1 && t <= b + 1)
    this.bufferedEl.style.left = r && dur ? `${(r[0] / dur) * 100}%` : '0'
    this.bufferedEl.style.width = r && dur ? `${((r[1] - r[0]) / dur) * 100}%` : '0'
    if (this.bufferMeta && this.stats) this.bufferMeta.textContent = this.#netLine()
  }

  /** Live torrent stats (from the socket) feed the network chip and buffering card. */
  setStats (s) {
    this.stats = s
    const live = s.peers > 0
    this.netChip.className = `chip sm ${live ? 'live' : 'warn'}`
    this.netChip.lastChild.textContent = this.#netLine()
  }

  #netLine () {
    const s = this.stats
    if (!s) return 'Connecting to peers…'
    const sp = fmtSpeed(s.downloadSpeed)
    return `${s.peers} peer${s.peers === 1 ? '' : 's'} · ${sp.value} ${sp.unit}`
  }

  // ================================================================== centre overlays
  #clearCenter () { this.centerEl.replaceChildren(this.bigPlay); this.bufferCard = null; this.bufferMeta = null }

  #showBuffering (on) {
    if (on && !this.bufferCard && !this.errorShown) {
      this.bufferMeta = h('div.b-meta', this.#netLine())
      this.bufferCard = h('div.buffering', h('div.spinner'), h('div.b-title', this.engine.mode === 'compat' ? 'Preparing video…' : 'Buffering…'), this.bufferMeta)
      this.centerEl.append(this.bufferCard)
    } else if (!on && this.bufferCard) {
      this.bufferCard.remove()
      this.bufferCard = null
      this.bufferMeta = null
    }
    this.emit('buffering', on)
  }

  #showError (msg) {
    this.errorShown = true
    this.#showBuffering(false)
    this.setState('error')
    this.centerEl.replaceChildren(h('div.player-error',
      h('div.icon', icon('alert')),
      h('h3', 'Can\'t play this video'),
      h('p.muted', msg),
      h('button.btn.primary', { onclick: () => { this.errorShown = false; this.#clearCenter(); this.load(this.media, { startAt: this.engine.time() }) } }, icon('sync'), 'Try again')
    ))
  }

  /** 3-2-1 countdown for synced session starts. */
  countdown (ms) {
    clearInterval(this.cdTimer)
    let n = Math.ceil(ms / 1000)
    const show = () => {
      this.centerEl.querySelector('.countdown')?.remove()
      if (n <= 0) { clearInterval(this.cdTimer); return }
      this.centerEl.append(h('div.countdown', String(n)))
      n--
    }
    show()
    this.cdTimer = setInterval(show, 1000)
  }

  // ================================================================== reactions
  showReaction ({ emoji, name, color }) {
    const left = 12 + Math.random() * 70
    const node = h('div.float-react', { style: { left: `${left}%`, '--drift': `${(Math.random() - 0.5) * 80}px` } },
      h('span.e', emoji),
      h('span.who', { style: { background: color } }, name)
    )
    this.reactionLayer.append(node)
    setTimeout(() => node.remove(), 3300)
  }

  // ================================================================== actions
  togglePlay () {
    if (!this.controller.canControl()) return toast('The host is controlling playback.', 'info')
    if (this.engine.paused()) this.controller.play(this.engine.time())
    else this.controller.pause(this.engine.time())
  }

  skip (s) { this.seekTo(this.engine.time() + s) }

  seekTo (t) {
    if (!this.controller.canControl()) return toast('The host is controlling playback.', 'info')
    const d = this.engine.duration()
    this.controller.seek(Math.max(0, d ? Math.min(t, d - 0.5) : t))
  }

  setRate (r) {
    if (!this.controller.canControl()) return toast('The host is controlling playback.', 'info')
    this.controller.setRate(r)
  }

  async toggleFullscreen () {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else if (this.el.requestFullscreen) await this.el.requestFullscreen()
      else this.engine.el()?.webkitEnterFullscreen?.() // iOS Safari
    } catch {}
  }

  async togglePip () {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture()
      else await this.engine.el()?.requestPictureInPicture()
    } catch { toast('Picture in picture isn\'t available here.', 'warn') }
  }

  toggleTheatre () {
    this.theatre = !this.theatre
    this.el.classList.toggle('theatre', this.theatre)
    this.theatreBtn.classList.toggle('on', this.theatre)
    this.emit('theatre', this.theatre)
  }

  cycleSubtitles () {
    const list = this.engine.listSubtitles()
    if (!list.length) return this.fileInput.click()
    const i = list.findIndex((s) => s.id === this.engine.activeSub)
    const next = i + 1 < list.length ? list[i + 1].id : null
    this.engine.selectSubtitle(next)
    toast(next ? `Subtitles: ${list[i + 1].label}` : 'Subtitles off', 'info', 1600)
  }

  // ================================================================== input
  #wireInput () {
    const d = this.d
    // Show controls on activity
    const wake = () => { this.#showControls(true); this.#scheduleHide() }
    d.listen(this.el, 'mousemove', wake)
    d.listen(this.el, 'touchstart', wake, { passive: true })
    d.listen(this.el, 'mouseleave', () => { if (!this.engine.paused()) this.#showControls(false) })

    // Click video = play/pause, double click = fullscreen
    let clickTimer
    let lastPointer = 'mouse'
    // Listen on the whole player: empty overlay areas are pointer-events:none, so clicks land on the video.
    d.listen(this.el, 'pointerdown', (e) => { lastPointer = e.pointerType })
    d.listen(this.el, 'click', (e) => {
      if (e.target.closest('.controls, .player-top, .menu, .player-error, button')) return
      if (lastPointer === 'touch') return // touch: a tap only reveals the controls
      clearTimeout(clickTimer)
      clickTimer = setTimeout(() => this.togglePlay(), 200)
    })
    d.listen(this.el, 'dblclick', (e) => {
      if (e.target.closest('.controls, .player-top, .menu, .player-error, button')) return
      clearTimeout(clickTimer)
      this.toggleFullscreen()
    })

    d.listen(document, 'fullscreenchange', () => {
      const fs = document.fullscreenElement === this.el
      this.el.classList.toggle('is-fs', fs)
      this.fsBtn.replaceChildren(icon(fs ? 'exitFullscreen' : 'fullscreen'))
    })
    d.listen(document, 'mousedown', (e) => { if (this.menu && !this.menu.contains(e.target) && !e.target.closest('.cbtn')) this.#closeMenu() })

    this.#wireSeek()
    d.listen(document, 'keydown', (e) => this.#onKey(e))
  }

  #wireSeek () {
    const el = this.seekEl
    const timeAt = (clientX) => {
      const r = el.getBoundingClientRect()
      const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
      return { p, t: p * (this.engine.duration() || 0) }
    }
    const preview = (clientX) => {
      const { p, t } = timeAt(clientX)
      const w = el.getBoundingClientRect().width
      const half = (this.previewThumb.offsetWidth || 176) / 2
      this.previewEl.style.left = `${Math.min(w - half, Math.max(half, p * w))}px`
      this.previewTime.textContent = clock(t)
      const want = Math.floor(t / 10)
      this.previewWant = want
      this.thumbs.get(t, (node) => {
        if (this.previewWant !== want) return
        if (node) { this.previewThumb.classList.remove('empty'); this.previewThumb.replaceChildren(node) } else this.previewThumb.classList.add('empty')
      })
    }
    this.d.listen(el, 'pointermove', (e) => { preview(e.clientX); if (this.dragging) this.dragTime = timeAt(e.clientX).t })
    this.d.listen(el, 'pointerdown', (e) => {
      if (!this.controller.canControl()) return toast('The host is controlling playback.', 'info')
      el.setPointerCapture(e.pointerId)
      this.dragging = true
      this.dragTime = timeAt(e.clientX).t
      el.classList.add('dragging')
    })
    const end = (e) => {
      if (!this.dragging) return
      this.dragging = false
      el.classList.remove('dragging')
      this.seekTo(timeAt(e.clientX).t)
    }
    this.d.listen(el, 'pointerup', end)
    this.d.listen(el, 'pointercancel', () => { this.dragging = false; el.classList.remove('dragging') })
    this.d.listen(el, 'keydown', (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); this.skip(-5) }
      if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); this.skip(5) }
    })
  }

  #onKey (e) {
    if (!this.el.isConnected) return
    const t = e.target
    if (t.closest?.('input, textarea, select, [contenteditable="true"]') || e.ctrlKey || e.metaKey || e.altKey) return
    const k = e.key
    const handled = () => { e.preventDefault(); this.#showControls(true); this.#scheduleHide() }
    switch (k) {
      case ' ': case 'k': case 'K': handled(); this.togglePlay(); break
      case 'j': case 'J': handled(); this.skip(-10); break
      case 'l': case 'L': handled(); this.skip(10); break
      case 'ArrowLeft': handled(); this.skip(-5); break
      case 'ArrowRight': handled(); this.skip(5); break
      case 'ArrowUp': handled(); this.engine.volume(this.engine.volume() + 0.05); break
      case 'ArrowDown': handled(); this.engine.volume(this.engine.volume() - 0.05); break
      case 'm': case 'M': handled(); this.engine.muted(!this.engine.muted()); break
      case 'f': case 'F': handled(); this.toggleFullscreen(); break
      case 'p': case 'P': handled(); this.togglePip(); break
      case 't': case 'T': handled(); this.toggleTheatre(); break
      case 'c': case 'C': handled(); this.cycleSubtitles(); break
      case '>': case '.': if (k === '>' || e.shiftKey) { handled(); this.#stepRate(1) } break
      case '<': case ',': if (k === '<' || e.shiftKey) { handled(); this.#stepRate(-1) } break
      case '?': handled(); showShortcuts(); break
      case 'Escape': this.#closeMenu(); break
      default:
        if (/^[0-9]$/.test(k)) { handled(); this.seekTo((Number(k) / 10) * this.engine.duration()) }
        else if (/^[!@£#$]$/.test(k) || (e.shiftKey && /^Digit[1-4]$/.test(e.code))) {
          // Shift+1..4 → reactions (handled by the room page)
          const idx = Number(e.code.replace('Digit', '')) - 1
          if (idx >= 0 && idx < 4) { handled(); this.emit('reaction-key', idx) }
        }
    }
  }

  #stepRate (dir) {
    const i = RATES.indexOf(this.engine.rate())
    const next = RATES[Math.max(0, Math.min(RATES.length - 1, (i < 0 ? 2 : i) + dir))]
    this.setRate(next)
    toast(`Speed ${next}×`, 'info', 1200)
  }

  #showControls (on) {
    this.el.dataset.controls = on || this.menu ? 'shown' : 'hidden'
  }

  #scheduleHide () {
    clearTimeout(this.hideTimer)
    this.hideTimer = setTimeout(() => {
      if (!this.engine.paused() && !this.menu && !this.dragging) this.#showControls(false)
    }, 2800)
  }

  // ================================================================== menus
  #openMenu (kind, anchor) {
    const same = this.menu?.dataset.kind === kind
    this.#closeMenu()
    if (same) return
    const item = (label, on, onClick, hint) =>
      h(`button${on ? '.on' : ''}`, { onclick: () => { onClick(); this.#closeMenu() } }, icon('check', 'check'), h('span', label), hint ? h('span.hint', hint) : null)

    let content = []
    if (kind === 'speed') {
      const cur = this.engine.rate()
      content = [h('h4', 'Playback speed'), ...RATES.map((r) => item(r === 1 ? 'Normal' : `${r}×`, r === cur, () => this.setRate(r)))]
    }
    if (kind === 'quality') {
      const cur = this.engine.currentQualityId()
      const opts = this.engine.qualityOptions()
      content = [h('h4', 'Quality'), ...opts.map((o) => item(o.label, o.id === cur, () => {
        if (o.id !== cur) { toast(o.id === 'direct' ? 'Switching to direct play' : `Switching to ${o.label} (${o.hint.toLowerCase()})`, 'info', 2200); this.engine.setQuality(o.id) }
      }, o.hint))]
      if (opts.length === 1) content.push(h('h4', 'Server has no ffmpeg — direct only'))
    }
    if (kind === 'subs') {
      const list = this.engine.listSubtitles()
      const cur = this.engine.activeSub
      content = [
        h('h4', 'Subtitles'),
        item('Off', !cur, () => this.engine.selectSubtitle(null)),
        ...list.map((s) => item(s.label, s.id === cur, () => this.engine.selectSubtitle(s.id))),
        ...this.torrentSubs.filter((s) => !list.some((l) => l.label === s.name)).map((s) => item(s.name, false, () => this.#loadTorrentSub(s), 'In torrent')),
        h('button', { onclick: () => { this.fileInput.click(); this.#closeMenu() } }, icon('upload', 'check'), h('span', 'Load from your device…')),
        h('h4', 'Size'),
        ...SUB_SIZES.map((s) => item(s.l, settings.get('subtitleSize') === s.v, () => settings.set('subtitleSize', s.v)))
      ]
    }
    this.menu = h('div.menu', { dataset: { kind }, onclick: (e) => e.stopPropagation() }, content)
    this.el.append(this.menu)
    // position above the anchor, right-aligned
    const pr = this.el.getBoundingClientRect()
    const ar = anchor.getBoundingClientRect()
    this.menu.style.bottom = `${pr.bottom - ar.top + 10}px`
    this.menu.style.right = `${Math.max(8, pr.right - ar.right - 70)}px`
    this.#showControls(true)
  }

  #closeMenu () { this.menu?.remove(); this.menu = null; this.#scheduleHide() }

  // ================================================================== subtitles
  async #loadTorrentSub (s, quiet = false) {
    try {
      const res = await fetch(api.streamUrl(this.media.infoHash, s.index))
      const text = await res.text()
      const cues = parseSubtitles(text, s.ext)
      if (!cues.length) throw new Error('empty')
      this.engine.addSubtitle({ label: s.name.split('/').pop(), cues })
      if (!quiet) toast('Subtitles loaded', 'success', 1800)
    } catch {
      if (!quiet) toast('Couldn\'t read that subtitle file.', 'danger')
    }
  }

  async #loadSubFile (file) {
    if (!file) return
    try {
      const cues = parseSubtitles(await file.text(), file.name.split('.').pop().toLowerCase())
      if (!cues.length) throw new Error('empty')
      this.engine.addSubtitle({ label: file.name, cues })
      toast(`Loaded ${cues.length} subtitle lines`, 'success', 2000)
    } catch {
      toast('That file doesn\'t contain readable subtitles.', 'danger')
    }
    this.fileInput.value = ''
  }

  #applySubSize () { this.el.style.setProperty('--sub-size', settings.get('subtitleSize')) }

  destroy () {
    clearInterval(this.cdTimer)
    clearTimeout(this.hideTimer)
    this.d.dispose()
    this.thumbs.dispose()
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {})
    this.engine.dispose()
    this.el.remove()
  }
}
