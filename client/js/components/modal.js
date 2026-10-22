/**
 * Modal dialog. Returns { close } and resolves `closed` when dismissed.
 *   const m = modal({ title, subtitle, body, actions:[{label, primary, onClick}], dismissable })
 */
import { h } from '../lib/dom.js'
import { icon } from '../lib/icons.js'

export function modal ({ title, subtitle, body, actions = [], dismissable = true, wide = false, onClose }) {
  const prevFocus = document.activeElement
  let resolveClosed
  const closed = new Promise((r) => { resolveClosed = r })

  const close = (value) => {
    backdrop.remove()
    document.removeEventListener('keydown', onKey, true)
    prevFocus?.focus?.()
    onClose?.(value)
    resolveClosed(value)
  }
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissable) { e.stopPropagation(); close() }
  }

  const foot = actions.length
    ? h('div.modal-foot', actions.map((a) => h(`button.btn${a.primary ? '.primary' : ''}${a.danger ? '.danger' : ''}`, {
      type: a.submit ? 'submit' : 'button',
      onclick: a.submit ? null : () => a.onClick ? a.onClick(close) : close()
    }, a.icon ? icon(a.icon) : null, a.label)))
    : null

  const box = h(`div.modal${wide ? '.wide' : ''}`, { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div.modal-head',
      h('div', h('h2', title), subtitle ? h('p', subtitle) : null),
      dismissable ? h('button.icon-btn.sm', { 'aria-label': 'Close', onclick: () => close() }, icon('x')) : null
    ),
    body,
    foot
  )
  const backdrop = h('div.modal-backdrop', { onmousedown: (e) => { if (e.target === backdrop && dismissable) close() } }, box)
  document.body.append(backdrop)
  document.addEventListener('keydown', onKey, true)
  setTimeout(() => (box.querySelector('input, select, textarea, button.primary') || box).focus(), 30)

  return { close, closed, el: box }
}
