/**
 * Persistent client state (localStorage, always wrapped in try/catch so
 * private windows still work).
 *   identity  — username + a secret clientKey (server derives your public id from it)
 *   settings  — user preferences
 *   history   — "continue watching"
 *   recentRooms
 */
import { Emitter } from '../lib/dom.js'

const NS = 'nickflix:'
const read = (k, d) => { try { const v = localStorage.getItem(NS + k); return v ? JSON.parse(v) : d } catch { return d } }
const write = (k, v) => { try { localStorage.setItem(NS + k, JSON.stringify(v)) } catch {} }

// ------------------------------------------------------------------ identity
function randomKey () {
  const a = new Uint8Array(24)
  crypto.getRandomValues(a)
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const identity = {
  get () {
    let id = read('identity', null)
    if (!id?.clientKey) { id = { clientKey: randomKey(), username: '' }; write('identity', id) }
    return id
  },
  get username () { return this.get().username },
  set username (name) { write('identity', { ...this.get(), username: String(name || '').trim().slice(0, 24) }) },
  get clientKey () { return this.get().clientKey }
}

// ------------------------------------------------------------------ settings
const DEFAULTS = {
  volume: 0.9,
  muted: false,
  subtitleSize: 1.6,         // em multiplier
  preferredQuality: 'auto',  // auto | original | 1080 | 720 | 480
  autoCompat: true,          // fall back to compatibility mode when the browser can't decode
  syncTolerance: 1.5,        // seconds of drift before a hard seek
  showDrift: true,
  speedUnits: 'bytes',       // bytes | bits
  reduceMotion: false,
  autoplaySolo: true
}

class Settings extends Emitter {
  #v = { ...DEFAULTS, ...read('settings', {}) }
  get (k) { return this.#v[k] }
  all () { return { ...this.#v } }
  set (k, val) {
    this.#v[k] = val
    write('settings', this.#v)
    this.emit('change', k, val)
    this.emit(`change:${k}`, val)
  }
  reset () { this.#v = { ...DEFAULTS }; write('settings', this.#v); this.emit('change') }
}
export const settings = new Settings()

// ------------------------------------------------------------------ history
export const history = {
  list () { return read('history', []) },
  /** Upsert by infoHash+fileIndex. */
  save (entry) {
    const list = this.list().filter((e) => !(e.infoHash === entry.infoHash && e.fileIndex === entry.fileIndex))
    list.unshift({ ...entry, at: Date.now() })
    write('history', list.slice(0, 24))
  },
  get (infoHash, fileIndex) { return this.list().find((e) => e.infoHash === infoHash && e.fileIndex === fileIndex) },
  remove (infoHash, fileIndex) { write('history', this.list().filter((e) => !(e.infoHash === infoHash && e.fileIndex === fileIndex))) },
  clear () { write('history', []) }
}

// ------------------------------------------------------------------ recent rooms
export const recentRooms = {
  list () { return read('rooms', []) },
  save (room) {
    const list = this.list().filter((r) => r.id !== room.id)
    list.unshift({ id: room.id, name: room.name, at: Date.now() })
    write('rooms', list.slice(0, 12))
  },
  remove (id) { write('rooms', this.list().filter((r) => r.id !== id)) }
}
