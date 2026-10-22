/**
 * Tiny DOM toolkit — hyperscript-style element builder.
 *
 *   h('button.btn.primary', { onclick: go, title: 'Play' }, icon('play'), 'Play')
 *
 * Strings become *text nodes*, never HTML, so user content (chat, names,
 * file names) can't inject markup. Only `icon()` uses trusted static SVG.
 */
export function h (tag, props, ...children) {
  if (props instanceof Node || typeof props !== 'object' || props === null || Array.isArray(props)) {
    children.unshift(props)
    props = {}
  }
  const [name, ...classes] = tag.split('.')
  const el = document.createElement(name || 'div')
  if (classes.length) el.className = classes.join(' ')

  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ')
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv)
        else el.style[sk] = sv
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
    else if (k === 'ref' && typeof v === 'function') v(el)
    else if (k in el && k !== 'list' && k !== 'form' && typeof v !== 'string') el[k] = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  append(el, children)
  return el
}

export function append (el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === true) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

/** Replace all children. */
export function mount (el, ...children) {
  el.replaceChildren()
  return append(el, children)
}

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

/** Simple event emitter used by services and components. */
export class Emitter {
  #map = new Map()
  on (ev, fn) { (this.#map.get(ev) || this.#map.set(ev, new Set()).get(ev)).add(fn); return () => this.off(ev, fn) }
  off (ev, fn) { this.#map.get(ev)?.delete(fn) }
  emit (ev, ...args) { for (const fn of [...(this.#map.get(ev) || [])]) { try { fn(...args) } catch (e) { console.error(e) } } }
}

/** Collects teardown functions so pages can clean up listeners/timers on navigation. */
export class Disposer {
  #fns = []
  add (fn) { if (typeof fn === 'function') this.#fns.push(fn); return fn }
  listen (target, ev, fn, opts) { target.addEventListener(ev, fn, opts); this.add(() => target.removeEventListener(ev, fn, opts)) }
  interval (fn, ms) { const id = setInterval(fn, ms); this.add(() => clearInterval(id)); return id }
  timeout (fn, ms) { const id = setTimeout(fn, ms); this.add(() => clearTimeout(id)); return id }
  dispose () { while (this.#fns.length) { try { this.#fns.pop()() } catch (e) { console.error(e) } } }
}
