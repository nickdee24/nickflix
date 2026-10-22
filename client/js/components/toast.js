/** Truck Dash-style toasts: top-centre, coloured border by type. */
import { h } from '../lib/dom.js'
import { icon } from '../lib/icons.js'

const ICONS = { success: 'checkCircle', danger: 'alert', warn: 'alert', info: 'info' }

export function toast (message, type = 'info', ms = 3600) {
  let root = document.getElementById('toasts')
  if (!root) { root = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(root) }
  const el = h(`div.toast.${type}`, icon(ICONS[type] || 'info'), h('span', message))
  root.append(el)
  requestAnimationFrame(() => el.classList.add('show'))
  setTimeout(() => {
    el.classList.remove('show')
    setTimeout(() => el.remove(), 300)
  }, ms)
}
