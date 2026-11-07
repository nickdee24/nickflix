/**
 * Persistent client state (localStorage, always wrapped in try/catch so
 * private windows still work).
 *   identity  — username, a secret clientKey (the server derives your public id
 *               from it) and, on the host's own browser, the host key
 *   settings  — user preferences
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
  get clientKey () { return this.get().clientKey },
  get hostKey () { return this.get().hostKey || '' },
  set hostKey (key) { write('identity', { ...this.get(), hostKey: String(key || '').trim().slice(0, 200) }) }
}

// ------------------------------------------------------------------ settings
const DEFAULTS = {
  volume: 0.9,
  muted: false,
  subtitleSize: 1.6,         // em multiplier
  maxQuality: 0,             // 0 = no cap; otherwise highest height Auto may pick (data saver)
  syncTolerance: 1.5,        // seconds of drift before a hard seek
  showDrift: true,
  reduceMotion: false
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
