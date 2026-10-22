/**
 * Home — hero + add torrent, the loaded torrent's files, continue watching,
 * and what's already on the server.
 */
import { h, Disposer } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { bytes, timeAgo, clock, prettyTitle } from '../lib/format.js'
import { history } from '../state/store.js'
import { api } from '../services/api.js'
import { addTorrent } from '../components/add-torrent.js'
import { torrentCard } from '../components/torrent-card.js'
import { mediaCard } from '../components/media-card.js'
import { startPartyFlow } from './rooms.js'

export function homePage (params, shell) {
  const d = new Disposer()
  shell.setTopbar({ title: 'NickFlix', sub: 'Stream & watch together' })

  const loadedSlot = h('div')
  const continueSlot = h('div')
  const serverSlot = h('div')

  const showTorrent = (t) => {
    loadedSlot.replaceChildren(torrentCard(t, {
      onWatch: (f) => shell.navigate(`/watch/${t.infoHash}/${f.index}`),
      onParty: (f) => startPartyFlow(shell, { infoHash: t.infoHash, fileIndex: f.index, title: prettyTitle(f.name) })
    }))
    loadedSlot.scrollIntoView({ behavior: 'smooth', block: 'start' })
    refreshServer()
  }

  const hero = h('section.hero',
    routesSvg(),
    h('div',
      h('div.eyebrow', { style: { color: 'var(--accent)' } }, 'Torrent streaming · Watch parties'),
      h('h1', { style: { marginTop: '10px' } }, 'Press play on ', h('em', 'anything'), '.', h('br'), 'Watch it ', h('em', 'together'), '.'),
      h('p.lede', 'Drop in a .torrent or magnet link and NickFlix starts streaming as soon as the first pieces arrive. Invite friends and everyone stays on the same frame.'),
      h('div.hero-stats',
        h('div', h('b', '~5s'), h('span', 'to first frame')),
        h('div', h('b', '±150ms'), h('span', 'party sync')),
        h('div', h('b', 'MKV · AVI · MP4'), h('span', 'and more'))
      )
    ),
    addTorrent({ onLoaded: showTorrent })
  )

  const features = h('div.home-grid',
    h('div.panel.feature-card',
      h('div.fc-icon', icon('rooms')),
      h('div', h('h3', 'Watch parties'), h('p', 'Private rooms with a share link, ready-up, synced play/pause/seek, live chat and reactions.'),
        h('a.btn.sm', { href: '/rooms', 'data-link': '', style: { marginTop: '12px' } }, 'Open Watch Rooms', icon('chevron')))
    ),
    h('div.panel.feature-card',
      h('div.fc-icon', icon('sparkles')),
      h('div', h('h3', 'Plays almost anything'), h('p', 'MP4 and WebM play directly. MKV, AVI and odd codecs are converted on the fly when the server has ffmpeg.'),
        h('button.btn.sm', { style: { marginTop: '12px' }, onclick: () => import('../player/shortcuts.js').then((m) => m.showShortcuts()) }, icon('keyboard'), 'Keyboard shortcuts'))
    )
  )

  // ---- continue watching (local history)
  function renderContinue () {
    const items = history.list().slice(0, 8)
    if (!items.length) { continueSlot.replaceChildren(); return }
    continueSlot.replaceChildren(
      h('div.section-title', h('h2', 'Continue watching')),
      h('div', { style: { height: '12px' } }),
      h('div.media-grid', items.map((e) => mediaCard({
        title: e.title,
        seed: e.infoHash,
        progress: e.duration ? e.position / e.duration : 0,
        subtitle: [h('span.num', `${clock(e.position)} / ${clock(e.duration)}`), h('span', '·'), h('span', timeAgo(e.at))],
        badges: [h('span.shield', e.ext || 'video')],
        onClick: () => shell.navigate(`/watch/${e.infoHash}/${e.fileIndex}`),
        actions: [h('button.icon-btn.sm', { 'aria-label': 'Remove', title: 'Remove from history', onclick: () => { history.remove(e.infoHash, e.fileIndex); renderContinue() } }, icon('x'))]
      })))
    )
  }

  // ---- torrents already on the server
  async function refreshServer () {
    let list = []
    try { list = await api.torrents() } catch {}
    if (!list.length) { serverSlot.replaceChildren(); return }
    serverSlot.replaceChildren(
      h('div.section-title', h('h2', 'On the server'), h('a.right', { href: '/library', 'data-link': '' }, 'Library →')),
      h('div', { style: { height: '12px' } }),
      h('div.media-grid', list.slice(0, 8).map((t) => {
        const main = t.files[t.mainFileIndex] || t.files[0]
        return mediaCard({
          title: main ? main.name : t.name,
          seed: t.infoHash,
          progress: t.stats.progress,
          subtitle: [h('span.num', bytes(t.length)), h('span', '·'), h('span.num', `${t.stats.peers} peers`)],
          badges: main ? [h('span.shield', main.ext)] : [],
          onClick: () => showTorrent(t)
        })
      }))
    )
  }

  renderContinue()
  refreshServer()

  const el = h('div.page', hero, loadedSlot, continueSlot, serverSlot, features)
  return { el, title: 'Home', destroy: () => d.dispose() }
}

/** Decorative sat-nav "route lines" behind the hero. */
function routesSvg () {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('class', 'routes')
  svg.setAttribute('viewBox', '0 0 1200 420')
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice')
  const paths = [
    ['M-20 300 C 140 260, 220 360, 380 320 S 560 180, 720 230 S 980 360, 1220 260', '#ff8a3d', 5, 0.35],
    ['M620 -20 C 600 80, 700 120, 690 200 S 610 330, 660 440', '#ff8a3d', 4, 0.25],
    ['M900 -10 C 880 90, 980 140, 1010 220 S 1100 330, 1220 340', '#4a4f58', 2, 0.6],
    ['M-10 120 C 120 140, 200 80, 330 110 S 520 60, 640 120', '#4a4f58', 2, 0.5],
    ['M700 232 C 760 250, 820 300, 860 380', '#3b9eff', 6, 0.8]
  ]
  for (const [d, stroke, w, o] of paths) {
    const p = document.createElementNS(ns, 'path')
    p.setAttribute('d', d)
    p.setAttribute('stroke', stroke)
    p.setAttribute('stroke-width', w)
    p.setAttribute('opacity', o)
    svg.append(p)
  }
  return svg
}
