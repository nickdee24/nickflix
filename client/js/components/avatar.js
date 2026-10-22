/** Auto-generated avatar: initials on a colour derived from the user id/name. */
import { h } from '../lib/dom.js'
import { initials } from '../lib/format.js'

const COLOURS = ['#3b9eff', '#4caf50', '#ffb020', '#ff8a3d', '#ff4d4d', '#a78bfa', '#2dd4bf', '#f472b6', '#93c5fd', '#e8c98a']

export function colourFor (seed = '') {
  let x = 0
  for (const c of seed) x = (x * 31 + c.charCodeAt(0)) | 0
  return COLOURS[Math.abs(x) % COLOURS.length]
}

/**
 * @param {object} o { name, color, size: 'sm'|'md'|'lg'|'xl', status }
 */
export function avatar ({ name = '', color, size = 'md', status } = {}) {
  return h(`div.avatar${size !== 'md' ? '.' + size : ''}`,
    { style: { '--c': color || colourFor(name) }, title: name, 'aria-hidden': 'true' },
    initials(name),
    status ? h(`i.presence.${status}`) : null
  )
}
