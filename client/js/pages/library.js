/**
 * Library — torrents currently live on the server (with progress and peers),
 * plus your local watch history.
 */
import { h, Disposer } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { bytes, clock, timeAgo, pct } from '../lib/format.js'
import { history } from '../state/store.js'
import { api } from '../services/api.js'
import { mediaCard } from '../components/media-card.js'
import { torrentCard } from '../components/torrent-card.js'
import { toast } from '../components/toast.js'
import { modal } from '../components/modal.js'
import { startPartyFlow } from './rooms.js'
import { prettyTitle } from '../lib/format.js'

export function libraryPage (params, shell) {
  const d = new Disposer()
  const serverGrid = h('div.media-grid')
  const historyGrid = h('div.media-grid')
  const tab = { v: 'server' }
  const seg = h('div.segmented', { style: { maxWidth: '360px' } })
  const body = h('div')

  shell.setTopbar({ title: 'Library', sub: 'Everything you\'ve loaded' })

  function renderSeg () {
    seg.replaceChildren(
      h(`button${tab.v === 'server' ? '.on' : ''}`, { onclick: () => { tab.v = 'server'; renderSeg(); show() } }, 'On the server'),
      h(`button${tab.v === 'history' ? '.on' : ''}`, { onclick: () => { tab.v = 'history'; renderSeg(); show() } }, 'Watch history')
    )
  }

  function show () { body.replaceChildren(tab.v === 'server' ? serverGrid : historyGrid) }

  async function loadServer () {
    let list = []
    try { list = await api.torrents() } catch (e) { toast(e.message, 'danger') }
    if (!list.length) {
      serverGrid.replaceChildren(h('div.panel.empty', { style: { gridColumn: '1 / -1' } },
        h('div.empty-icon', icon('library')), h('h3', 'Nothing loaded yet'),
        h('p', 'Torrents you add appear here while the server keeps them. Idle torrents are cleaned up automatically to save space.'),
        h('a.btn.primary', { href: '/', 'data-link': '' }, icon('plus'), 'Add a torrent')))
      return
    }
    serverGrid.replaceChildren(...list.map((t) => {
      const main = t.files[t.mainFileIndex] || t.files[0]
      return mediaCard({
        title: main?.name || t.name,
        seed: t.infoHash,
        progress: t.stats.progress,
        badges: [main ? h('span.shield', main.ext) : null, h(`span.tag${t.stats.peers ? '.ok' : '.warn'}`, `${t.stats.peers} peers`)],
        subtitle: [h('span.num', bytes(t.length)), h('span', '·'), h('span.num', `${pct(t.stats.progress)} cached`)],
        onClick: () => openTorrent(t),
        actions: [h('button.icon-btn.sm', { 'aria-label': 'Remove from server', title: 'Remove from server', onclick: () => removeTorrent(t) }, icon('trash'))]
      })
    }))
  }

  function openTorrent (t) {
    const m = modal({
      title: 'Choose a file',
      wide: true,
      body: torrentCard(t, {
        onWatch: (f) => { m.close(); shell.navigate(`/watch/${t.infoHash}/${f.index}`) },
        onParty: (f) => { m.close(); startPartyFlow(shell, { infoHash: t.infoHash, fileIndex: f.index, title: prettyTitle(f.name) }) }
      })
    })
  }

  async function removeTorrent (t) {
    try {
      await api.removeTorrent(t.infoHash)
      toast('Removed from server', 'success', 1800)
      loadServer()
    } catch (e) { toast(e.message, 'danger') }
  }

  function loadHistory () {
    const items = history.list()
    if (!items.length) {
      historyGrid.replaceChildren(h('div.panel.empty', { style: { gridColumn: '1 / -1' } },
        h('div.empty-icon', icon('film')), h('h3', 'No history yet'), h('p', 'Things you watch on this device show up here with your progress.')))
      return
    }
    historyGrid.replaceChildren(...items.map((e) => mediaCard({
      title: e.title,
      seed: e.infoHash,
      progress: e.duration ? e.position / e.duration : 0,
      badges: [h('span.shield', e.ext || 'video')],
      subtitle: [h('span.num', `${clock(e.position)} / ${clock(e.duration)}`), h('span', '·'), h('span', timeAgo(e.at))],
      onClick: () => shell.navigate(`/watch/${e.infoHash}/${e.fileIndex}`),
      actions: [h('button.icon-btn.sm', { 'aria-label': 'Remove', onclick: () => { history.remove(e.infoHash, e.fileIndex); loadHistory() } }, icon('x'))]
    })))
  }

  renderSeg()
  loadServer()
  loadHistory()
  show()
  d.interval(loadServer, 10_000)

  const el = h('div.page',
    h('div.panel', { style: { display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' } },
      h('div', { style: { flex: 1, minWidth: '200px' } }, h('div.eyebrow', 'Library'), h('h2', { style: { marginTop: '4px' } }, 'Your stuff')),
      seg
    ),
    body
  )
  return { el, title: 'Library', destroy: () => d.dispose() }
}
