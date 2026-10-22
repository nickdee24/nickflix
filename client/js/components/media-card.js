/** Poster-style card for library / continue-watching rows. */
import { h } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { artGradient, initials, prettyTitle } from '../lib/format.js'

/**
 * @param {object} o { title, subtitle, seed, progress (0-1), badges, onClick, actions }
 */
export function mediaCard ({ title, subtitle, seed, progress, badges = [], onClick, actions = [] }) {
  const t = prettyTitle(title)
  // A div with button semantics, because the card can contain its own action buttons.
  return h('div.media-card', {
    role: 'button',
    tabindex: 0,
    title: t,
    onclick: (e) => { if (!e.target.closest('.card-actions')) onClick?.() },
    onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onClick?.() } }
  },
    h('div.art', { style: { '--art': artGradient(seed || title) } },
      h('div.initials', initials(t.replace(/\(.*\)/, ''))),
      h('div.corner', badges),
      h('span.play', icon('play')),
      progress > 0 ? h('div.progress.accent', h('i', { style: { width: `${Math.min(100, progress * 100)}%` } })) : null
    ),
    h('div.body', h('b', t), h('div.meta', subtitle)),
    actions.length ? h('div.card-actions', actions) : null
  )
}
