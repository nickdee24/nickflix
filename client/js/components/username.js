/** "Pick a name" dialog with a live avatar preview. Resolves with the name (or null). */
import { h } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { identity } from '../state/store.js'
import { avatar } from './avatar.js'
import { modal } from './modal.js'

export function askUsername ({ title = 'Who\'s watching?', subtitle = 'Pick a name so your friends know who\'s who.', cta = 'Continue' } = {}) {
  return new Promise((resolve) => {
    let done = false
    const preview = h('div', avatar({ name: identity.username || '?', size: 'xl' }))
    const input = h('input.input', {
      value: identity.username || '', maxlength: 24, placeholder: 'Your name', autocomplete: 'nickname', 'aria-label': 'Your name',
      oninput: () => preview.replaceChildren(avatar({ name: input.value.trim() || '?', size: 'xl' }))
    })
    const submit = (e) => {
      e?.preventDefault()
      const name = input.value.trim()
      if (!name) { input.focus(); input.style.borderColor = 'var(--danger)'; return }
      identity.username = name
      done = true
      m.close(name)
    }
    const body = h('form', { onsubmit: submit },
      h('div', { style: { display: 'flex', justifyContent: 'center', margin: '4px 0 18px' } }, preview),
      h('div.field', h('label', 'Display name'), input),
      h('div.modal-foot', h('button.btn.primary.block.lg', { type: 'submit' }, cta, icon('chevron')))
    )
    const m = modal({ title, subtitle, body, onClose: (v) => resolve(done ? v : null) })
  })
}

/** Returns the stored name, or asks for one. */
export async function ensureUsername (opts) {
  return identity.username || askUsername(opts)
}
