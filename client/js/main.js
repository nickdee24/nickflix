/**
 * NickFlix client entry: app shell, navigation and router.
 *
 * Pages are plain functions:  (params, shell) => { el, destroy? }
 * The shell lets a page set the top bar and (for rooms) the right rail.
 */
import { h, mount, $ } from './lib/dom.js'
import { icon } from './lib/icons.js'
import { settings } from './state/store.js'
import { socket } from './services/socket.js'
import { showShortcuts } from './player/shortcuts.js'

import { homePage } from './pages/home.js'
import { watchPage } from './pages/watch.js'
import { roomsPage } from './pages/rooms.js'
import { roomPage } from './pages/room.js'
import { libraryPage } from './pages/library.js'
import { settingsPage } from './pages/settings.js'

const ROUTES = [
  { re: /^\/$/, page: homePage, nav: 'home' },
  { re: /^\/watch\/([a-f0-9]{40})\/(\d+)$/, page: watchPage, nav: 'home', keys: ['infoHash', 'fileIndex'] },
  { re: /^\/rooms$/, page: roomsPage, nav: 'rooms' },
  { re: /^\/room\/([A-Za-z0-9]{4,12})$/, page: roomPage, nav: 'rooms', keys: ['roomId'] },
  { re: /^\/library$/, page: libraryPage, nav: 'library' },
  { re: /^\/settings$/, page: settingsPage, nav: 'settings' }
]

const NAV = [
  { id: 'home', label: 'Home', icon: 'home', href: '/' },
  { id: 'rooms', label: 'Watch Rooms', icon: 'rooms', href: '/rooms' },
  { id: 'library', label: 'Library', icon: 'library', href: '/library' },
  { id: 'settings', label: 'Settings', icon: 'settings', href: '/settings' }
]

const app = $('#app')
const view = $('#view')
const rail = $('#rail')
const topbar = $('#topbar')

// ---------------------------------------------------------------- navigation
function navTiles () {
  return NAV.map((n) => h('a.nav-tile', { href: n.href, 'data-link': '', 'data-nav': n.id, 'aria-label': n.label },
    icon(n.icon), h('span', n.label.replace('Watch ', ''))))
}

const serverDot = h('span.dot.info')
const serverLabel = h('span', 'Connecting')
mount($('#sidebar'),
  h('a.brand', { href: '/', 'data-link': '', 'aria-label': 'NickFlix home' }, icon('logo')),
  h('nav', navTiles()),
  h('div.spacer'),
  h('div.server-dot', serverDot, serverLabel)
)
mount($('#bottomnav'), navTiles())

function setActiveNav (id) {
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === id))
}

// Server connection status → sidebar dot + top bar chip
const statusChip = h('div.chip.info', h('span.dot'), h('span', 'Connecting…'))
socket.on('status', (s) => {
  const map = { online: ['live', 'Online'], offline: ['err', 'Offline'], reconnecting: ['warn', 'Reconnecting'] }
  const [cls, label] = map[s] || ['info', s]
  serverDot.className = `dot ${cls}${s === 'online' ? ' pulse' : ''}`
  serverLabel.textContent = label
  if (!shell.customChip) {
    statusChip.className = `chip ${cls}`
    statusChip.lastChild.textContent = s === 'online' ? 'Server online' : label
  }
})

// ---------------------------------------------------------------- shell API
export const shell = {
  customChip: false,
  /** { title, sub, chip (node), actions (nodes) } */
  setTopbar ({ title = 'NickFlix', sub = null, chip = null, actions = [] } = {}) {
    shell.customChip = !!chip
    mount(topbar,
      h('div.title', icon('logo'), h('span.truncate', title), sub ? h('small.truncate', `— ${sub}`) : null),
      chip || statusChip,
      h('div.actions',
        ...actions,
        h('button.icon-btn', { 'aria-label': 'Keyboard shortcuts', title: 'Keyboard shortcuts (?)', onclick: showShortcuts }, '?'),
        h('a.icon-btn', { href: '/settings', 'data-link': '', 'aria-label': 'Settings', title: 'Settings' }, icon('settings'))
      )
    )
  },
  setRail (node) {
    app.dataset.rail = node ? 'on' : 'off'
    mount(rail, node || '')
  },
  navigate
}

// ---------------------------------------------------------------- router
let current = null

export function navigate (path, { replace = false } = {}) {
  if (path === location.pathname + location.search && current) return
  history[replace ? 'replaceState' : 'pushState']({}, '', path)
  render()
}

function render () {
  const path = location.pathname.replace(/\/+$/, '') || '/'
  let route = null
  let params = {}
  for (const r of ROUTES) {
    const m = path.match(r.re)
    if (m) {
      route = r
      params = Object.fromEntries((r.keys || []).map((k, i) => [k, m[i + 1]]))
      break
    }
  }

  try { current?.destroy?.() } catch (e) { console.error(e) }
  current = null
  shell.setRail(null)
  shell.setTopbar({})

  if (!route) {
    setActiveNav(null)
    mount(view, h('div.page', h('div.panel.empty',
      h('div.empty-icon', icon('alert')), h('h3', 'Wrong turn'), h('p', 'That page doesn\'t exist.'),
      h('a.btn.primary', { href: '/', 'data-link': '' }, icon('home'), 'Back home'))))
    return
  }
  setActiveNav(route.nav)
  current = route.page(params, shell) || {}
  mount(view, current.el)
  view.scrollTop = 0
  document.title = current.title ? `${current.title} · NickFlix` : 'NickFlix'
}

// Intercept internal links
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]')
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
  e.preventDefault()
  navigate(a.getAttribute('href'))
})
window.addEventListener('popstate', render)

// Reduced motion preference
const applyMotion = () => { document.documentElement.dataset.motion = settings.get('reduceMotion') ? 'reduced' : '' }
settings.on('change:reduceMotion', applyMotion)
applyMotion()

render()
