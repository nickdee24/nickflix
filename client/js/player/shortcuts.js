/** Keyboard shortcut cheat sheet. */
import { h } from '../lib/dom.js'
import { modal } from '../components/modal.js'

const SHORTCUTS = [
  ['Play / pause', ['Space', 'K']],
  ['Back / forward 10s', ['J', 'L']],
  ['Back / forward 5s', ['←', '→']],
  ['Volume', ['↑', '↓']],
  ['Mute', ['M']],
  ['Fullscreen', ['F']],
  ['Picture in picture', ['P']],
  ['Theatre mode', ['T']],
  ['Cycle subtitles', ['C']],
  ['Speed down / up', ['<', '>']],
  ['Jump to 0–90%', ['0', '…', '9']],
  ['Reactions', ['⇧1', '⇧2', '⇧3', '⇧4']],
  ['This help', ['?']]
]

export function showShortcuts () {
  if (document.querySelector('[aria-label="Keyboard shortcuts"]')) return
  modal({
    title: 'Keyboard shortcuts',
    subtitle: 'Work anywhere on the watch screen, unless you\'re typing.',
    wide: true,
    body: h('div.shortcut-grid', SHORTCUTS.map(([label, keys]) =>
      h('div', h('span', label), h('span', { style: { display: 'flex', gap: '4px' } }, keys.map((k) => h('kbd', k))))
    ))
  })
}
