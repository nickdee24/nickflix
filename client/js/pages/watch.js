/**
 * Solo watch page: player + Truck Dash-style dashboard underneath
 * (gauge panel, ETA strip, button box tiles, and a "trip" info table).
 */
import { h, Disposer } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { bytes, clock, prettyTitle } from '../lib/format.js'
import { history, settings } from '../state/store.js'
import { api } from '../services/api.js'
import { socket } from '../services/socket.js'
import { PlayerView } from '../player/player-view.js'
import { statsStrip, gaugePanel } from '../components/stats-strip.js'
import { fileBadges } from '../components/torrent-card.js'
import { toast } from '../components/toast.js'
import { startPartyFlow } from './rooms.js'
import { showShortcuts } from '../player/shortcuts.js'

export function watchPage ({ infoHash, fileIndex }, shell) {
  const d = new Disposer()
  const idx = Number(fileIndex)
  const page = h('div.page.watch-layout', h('div.player.skeleton'))
  let pv = null

  shell.setTopbar({ title: 'NickFlix', sub: 'Loading…' })

  ;(async () => {
    let t
    try { t = await api.torrent(infoHash) } catch (e) {
      page.replaceChildren(h('div.panel.empty',
        h('div.empty-icon', icon('alert')), h('h3', 'This torrent isn\'t loaded'),
        h('p', `${e.message} Add it again from the home page.`),
        h('a.btn.primary', { href: '/', 'data-link': '' }, icon('home'), 'Go home')))
      return
    }
    const file = t.files[idx]
    if (!file || file.kind !== 'video') { toast('That file isn\'t a video.', 'danger'); shell.navigate('/'); return }

    const title = prettyTitle(file.name)
    shell.setTopbar({ title: 'NickFlix', sub: title })
    const media = { infoHash, fileIndex: idx, name: file.name, ext: file.ext, playable: file.playable }
    const torrentSubs = t.files.filter((f) => f.kind === 'subtitle')

    pv = new PlayerView({ title, badges: fileBadges(file.name, file.ext), torrentSubs })

    // ---- dashboard
    const gauge = gaugePanel()
    const strip = statsStrip()
    const modeVal = h('span.v', '—')
    const codecVal = h('span.v', '—')
    const resVal = h('span.v', '—')
    const info = h('div.panel',
      h('div.eyebrow', 'Now playing'),
      h('h2', { style: { margin: '6px 0 10px', fontSize: '1.2rem' } }, title),
      h('div.rows',
        h('div.row-kv', h('span.k', 'File'), h('span.v.truncate', { title: file.name }, file.name)),
        h('div.row-kv', h('span.k', 'Size'), h('span.v', bytes(file.length))),
        h('div.row-kv', h('span.k', 'Container'), h('span.v', file.ext.toUpperCase())),
        h('div.row-kv', h('span.k', 'Resolution'), resVal),
        h('div.row-kv', h('span.k', 'Codec'), codecVal),
        h('div.row-kv', h('span.k', 'Playback'), modeVal),
        h('div.row-kv', h('span.k', 'Torrent'), h('span.v.truncate', { title: t.name }, t.name))
      )
    )

    const tile = (iconName, label, onClick) => h('button.tile', { onclick: onClick }, icon(iconName), h('span', label))
    const tiles = {
      subs: tile('cc', 'Subtitles', () => pv.cycleSubtitles()),
      speed: tile('speed', 'Speed', () => { const r = pv.engine.rate(); pv.setRate(r >= 2 ? 0.5 : r + 0.25) }),
      quality: tile('quality', 'Compat mode', () => pv.engine.setQuality(pv.engine.mode === 'compat' ? 'direct' : 'compat-original')),
      pip: tile('pip', 'Picture in picture', () => pv.togglePip()),
      theatre: tile('theatre', 'Theatre', () => pv.toggleTheatre()),
      fs: tile('fullscreen', 'Fullscreen', () => pv.toggleFullscreen()),
      party: tile('rooms', 'Watch party', () => startPartyFlow(shell, { infoHash, fileIndex: idx, title })),
      keys: tile('keyboard', 'Shortcuts', showShortcuts)
    }
    const speedVal = h('span.tile-value', '1×')
    tiles.speed.append(speedVal)

    const refreshTiles = () => {
      tiles.subs.classList.toggle('on', !!pv.engine.activeSub)
      tiles.quality.classList.toggle('on', pv.engine.mode === 'compat')
      tiles.theatre.classList.toggle('on', pv.theatre)
      tiles.pip.classList.toggle('on', document.pictureInPictureElement === pv.engine.el())
      speedVal.textContent = `${pv.engine.rate()}×`
      tiles.speed.classList.toggle('on', pv.engine.rate() !== 1)
      modeVal.textContent = pv.engine.mode === 'compat'
        ? `Compat · ${pv.engine.quality === 'original' ? 'original quality' : pv.engine.quality + 'p'}`
        : 'Direct play'
    }
    pv.engine.on('tracks', refreshTiles)
    pv.engine.on('ratechange', refreshTiles)
    pv.engine.on('modechange', ({ probe }) => {
      refreshTiles()
      if (probe?.video) {
        codecVal.textContent = `${probe.video.codec?.toUpperCase()}${probe.audio?.[0] ? ' / ' + probe.audio[0].codec.toUpperCase() : ''}`
        resVal.textContent = `${probe.video.width}×${probe.video.height}`
      }
    })
    pv.engine.on('loaded', ({ width, height }) => { if (width) resVal.textContent = `${width}×${height}`; refreshTiles() })
    pv.on('theatre', refreshTiles)
    d.listen(document, 'enterpictureinpicture', refreshTiles, true)
    d.listen(document, 'leavepictureinpicture', refreshTiles, true)

    page.replaceChildren(
      pv.el,
      h('div.dash-row',
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--gutter)', minWidth: 0 } },
          gauge.el, strip.el,
          h('div.panel', h('div.tiles', Object.values(tiles)))
        ),
        info
      )
    )

    // ---- live stats
    socket.send('torrent:watch', { infoHash, fileIndex: idx })
    d.add(socket.on('status', (s) => s === 'online' && socket.send('torrent:watch', { infoHash, fileIndex: idx })))
    d.add(socket.listen('torrent:stats', (s) => {
      if (s.infoHash !== infoHash || s.fileIndex !== idx) return
      gauge.update(s); strip.update(s); pv.setStats(s)
    }))

    // ---- resume + history
    const prev = history.get(infoHash, idx)
    const resumeAt = prev && prev.position > 30 && prev.duration && prev.position < prev.duration - 60 ? prev.position : 0
    await pv.load(media, { startAt: resumeAt, autoplay: settings.get('autoplaySolo') })
    if (resumeAt) toast(`Resuming from ${clock(resumeAt)}`, 'info', 2500)

    const save = () => {
      const pos = pv.engine.time()
      const dur = pv.engine.duration()
      if (pos > 5 && dur) history.save({ infoHash, fileIndex: idx, title: file.name, ext: file.ext, position: pos, duration: dur })
    }
    d.interval(save, 5000)
    d.add(save)
  })()

  return {
    el: page,
    title: 'Watching',
    destroy () {
      socket.send('torrent:watch', {})
      d.dispose()
      pv?.destroy()
    }
  }
}
