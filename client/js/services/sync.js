/**
 * RoomSync — keeps the local player locked to the room's authoritative clock.
 *
 * 1. Intents (play / pause / seek / rate) go to the server. We apply them
 *    locally straight away so the UI feels instant; the server's echo is the
 *    source of truth and reconciles any race.
 * 2. Every second we compare our position with where the room *should* be:
 *        expected = position + (serverNow - updatedAt) * rate
 *      |drift| < 0.15s   → perfect, run at the room's rate
 *      0.15s – tolerance → nudge playbackRate ±5% to glide back in (no jump)
 *      > tolerance       → hard seek (with a little lead to cover seek latency)
 * 3. The host doesn't self-correct — the host *is* the reference. It reports
 *    its real position; if it stalls, the server re-anchors everybody to it.
 */
import { Emitter, Disposer } from '../lib/dom.js'
import { socket } from './socket.js'
import { settings } from '../state/store.js'
import { toast } from '../components/toast.js'

const FINE = 0.15

export class RoomSync extends Emitter {
  /**
   * @param {object} o { pv: PlayerView, getRoom: () => room snapshot, meId }
   */
  constructor ({ pv, getRoom, meId }) {
    super()
    this.pv = pv
    this.engine = pv.engine
    this.getRoom = getRoom
    this.meId = meId
    this.state = null
    this.quietUntil = 0
    this.lastStatus = null
    this.d = new Disposer()

    this.controller = {
      canControl: () => this.canControl(),
      play: (position) => this.#intent('playback:play', { position }, () => this.engine.play()),
      pause: (position) => this.#intent('playback:pause', { position }, () => this.engine.pause()),
      seek: (position) => this.#intent('playback:seek', { position }, () => this.#localSeek(position)),
      setRate: (rate) => this.#intent('playback:rate', { rate }, () => this.engine.setRate(rate))
    }

    this.d.interval(() => this.#correct(), 1000)
    this.d.interval(() => this.#heartbeat(), 2000)
    this.d.interval(() => this.#reportStatus(true), 5000)
    this.d.add(this.engine.on('waiting', () => this.#reportStatus()))
    this.d.add(this.engine.on('play', () => this.#onNativePlayPause(true)))
    this.d.add(this.engine.on('pause', () => this.#onNativePlayPause(false)))
  }

  get isHost () { return this.getRoom()?.hostId === this.meId }

  canControl () {
    const r = this.getRoom()
    return !!r && (r.hostId === this.meId || !r.settings.controlsLocked)
  }

  /** Expected room position right now (media seconds). */
  expected (now = socket.serverNow()) {
    const s = this.state
    if (!s) return 0
    if (!s.playing || now < s.updatedAt) return s.position
    return s.position + ((now - s.updatedAt) / 1000) * s.rate
  }

  async #intent (event, payload, optimistic) {
    if (!this.canControl()) { toast('The host is controlling playback.', 'info'); return }
    this.quietUntil = Date.now() + 1200
    optimistic()
    try {
      await socket.request(event, payload)
    } catch (e) {
      toast(e.message, 'danger')
      if (this.state) this.apply(this.state) // roll back to the room's state
    }
  }

  #localSeek (t) {
    this.quietUntil = Date.now() + 1500
    this.engine.seek(t)
  }

  /** Apply an authoritative playback state from the server. */
  apply (state) {
    const prev = this.state
    this.state = state
    const now = socket.serverNow()
    const e = this.engine
    this.quietUntil = Date.now() + 1200
    clearTimeout(this.startTimer)

    if (state.playing && now < state.updatedAt) {
      // Synchronised start: hold, count down, then everyone presses play together.
      const wait = state.updatedAt - now
      e.pause()
      if (Math.abs(e.time() - state.position) > 0.3) this.#localSeek(state.position)
      this.pv.countdown(wait)
      this.startTimer = setTimeout(() => { e.setRate(state.rate); e.play() }, wait)
      this.emit('status', 'countdown')
      return
    }

    if (e.rate() !== state.rate) e.setRate(state.rate)
    const target = this.expected(now)
    if (Math.abs(e.time() - target) > (state.playing ? 0.4 : 0.25)) this.#localSeek(target)
    if (state.playing) e.play()
    else e.pause()

    if (prev && state.by && state.by !== this.meId && state.action && state.action !== 'correct') {
      const who = this.getRoom()?.members.find((m) => m.id === state.by)?.name || 'Someone'
      const verb = { play: 'pressed play', pause: 'paused', seek: 'skipped', rate: `set speed to ${state.rate}×` }[state.action]
      if (verb) this.emit('activity', `${who} ${verb}`)
    }
  }

  /** Drift correction loop. */
  #correct () {
    const s = this.state
    const e = this.engine
    if (!s) return
    if (!s.playing) {
      // Paused rooms still hold position: if someone scrubbed locally, snap back.
      if (!e.paused() && Date.now() > this.quietUntil) e.pause()
      if (Math.abs(e.time() - s.position) > 0.5 && Date.now() > this.quietUntil && !e.isWaiting()) this.#localSeek(s.position)
      this.#pill('paused')
      return
    }
    if (socket.serverNow() < s.updatedAt) return
    if (e.isWaiting()) { this.#pill('buffering'); return }
    if (e.paused()) {
      // Room is playing but we're paused (autoplay blocked, tab throttled…)
      if (Date.now() > this.quietUntil) e.play()
      this.#pill('paused')
      return
    }

    const drift = e.time() - this.expected()
    this.lastDrift = drift
    if (this.isHost) { this.#pill('host', drift); return } // host is the reference

    const tol = settings.get('syncTolerance')
    if (Math.abs(drift) > tol && Date.now() > this.quietUntil) {
      this.#localSeek(this.expected() + (e.mode === 'compat' ? 0 : 0.2))
      e.nudgeRate(s.rate)
      this.#pill('resync', drift)
    } else if (Math.abs(drift) > FINE) {
      // Behind → speed up a touch; ahead → slow down a touch.
      e.nudgeRate(s.rate * (drift < 0 ? 1.05 : 0.95))
      this.#pill('catching', drift)
    } else {
      e.nudgeRate(s.rate)
      this.#pill('synced', drift)
    }
  }

  /** Host reports real position so the room follows the host if the host stalls. */
  #heartbeat () {
    if (!this.isHost || !this.state?.playing) return
    socket.send('playback:report', { position: this.engine.time(), playing: !this.engine.paused() && !this.engine.isWaiting() })
  }

  /**
   * Native play/pause that didn't come from our UI (media keys, PiP window,
   * OS controls). Controllers turn it into an intent; viewers get reverted.
   */
  #onNativePlayPause (playing) {
    const s = this.state
    if (!s || Date.now() < this.quietUntil || this.engine.isWaiting()) return
    if (Date.now() - (this.engine.lastSourceChange || 0) < 2500) return
    if (socket.serverNow() < s.updatedAt) return
    if (s.playing === playing) return
    if (this.canControl()) {
      socket.request(playing ? 'playback:play' : 'playback:pause', { position: this.engine.time() }).catch(() => {})
    } else {
      this.quietUntil = Date.now() + 800
      if (s.playing) this.engine.play()
      else this.engine.pause()
    }
    this.#reportStatus()
  }

  #reportStatus (force = false) {
    const e = this.engine
    const status = e.isWaiting() && this.state?.playing ? 'buffering' : !e.paused() ? 'watching' : this.state?.started ? 'paused' : 'idle'
    if (!force && status === this.lastStatus) return
    this.lastStatus = status
    socket.send('room:status', { status, position: e.time() })
  }

  #pill (kind, drift) {
    this.emit('pill', { kind, drift })
    this.#reportStatus()
  }

  /** Manual "Sync now" button. */
  resync () {
    if (!this.state) return
    this.#localSeek(this.expected())
    if (this.state.playing) this.engine.play()
    toast('Re-synced with the room', 'success', 1500)
  }

  destroy () {
    clearTimeout(this.startTimer)
    this.d.dispose()
  }
}
