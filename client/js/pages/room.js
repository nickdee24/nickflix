/**
 * Watch room.
 *
 *  main column : player (synced) + torrent dashboard, or a picker / lobby
 *  right rail  : room card + invite, participants & ready-up, reactions, chat
 */
import { h, Disposer } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { clock, timeOfDay } from '../lib/format.js'
import { identity, recentRooms, settings } from '../state/store.js'
import { api } from '../services/api.js'
import { socket } from '../services/socket.js'
import { RoomSync } from '../services/sync.js'
import { PlayerView } from '../player/player-view.js'
import { statsStrip } from '../components/stats-strip.js'
import { fileBadges } from '../components/torrent-card.js'
import { addTorrent } from '../components/add-torrent.js'
import { torrentCard } from '../components/torrent-card.js'
import { avatar } from '../components/avatar.js'
import { toast } from '../components/toast.js'
import { askUsername } from '../components/username.js'
import { modal } from '../components/modal.js'

const REACTIONS = ['👍', '❤️', '😂', '😮']

export function roomPage ({ roomId }, shell) {
  roomId = roomId.toUpperCase()
  const d = new Disposer()
  const S = { room: null, me: null, pv: null, sync: null, mediaKey: null, lastPlayback: null, joined: false }
  const page = h('div.page.watch-layout', h('div.panel.empty', h('div.spinner'), h('p', 'Joining room…')))
  const mainSlot = h('div.watch-layout')
  const dashSlot = h('div')

  shell.setTopbar({ title: 'Watch room', sub: roomId })

  // ======================================================================
  // Join
  // ======================================================================
  async function join (firstTime) {
    let info = null
    try { info = await api.room(roomId) } catch (e) { return showGone(e.message) }
    let name = identity.username
    if (!name || firstTime === 'ask') {
      name = await askUsername({
        title: `Join "${info.name}"`,
        subtitle: info.host ? `${info.host} invited you${info.media ? ` to watch ${info.media.title}` : ''}. Pick a display name.` : 'Pick a display name.',
        cta: 'Join room'
      })
      if (!name) { shell.navigate('/rooms'); return }
    }
    try {
      const res = await socket.request('room:join', { roomId, username: name, clientKey: identity.clientKey })
      S.me = res.me
      S.joined = true
      recentRooms.save(res.room)
      if (firstTime) buildLayout()
      onState(res.room)
      chat.reset(res.chat)
      onPlayback(res.room.playback)
    } catch (e) {
      showGone(e.message)
    }
  }

  function showGone (msg) {
    recentRooms.remove(roomId)
    page.replaceChildren(h('div.panel.empty',
      h('div.empty-icon', icon('door')), h('h3', 'Can\'t join this room'), h('p', msg),
      h('a.btn.primary', { href: '/rooms', 'data-link': '' }, icon('rooms'), 'Watch Rooms')))
  }

  // Reconnect → silently rejoin
  d.add(socket.on('status', (s) => { if (s === 'online' && S.joined) join(false) }))

  // ======================================================================
  // Socket events
  // ======================================================================
  d.add(socket.listen('room:state', (room) => room.id === roomId && onState(room)))
  d.add(socket.listen('playback:state', onPlayback))
  d.add(socket.listen('chat:message', (m) => chat.add(m)))
  d.add(socket.listen('chat:typing', (t) => chat.typing(t)))
  d.add(socket.listen('reaction', (r) => {
    if (S.pv) S.pv.showReaction(r)
    else floatReaction(mainSlot, r)
  }))
  d.add(socket.listen('room:kicked', () => {
    S.joined = false
    toast('The host removed you from the room.', 'warn', 5000)
    shell.navigate('/rooms')
  }))
  d.add(socket.listen('torrent:stats', (s) => {
    if (!S.room?.media || s.infoHash !== S.room.media.infoHash) return
    S.pv?.setStats(s)
    strip.update(s)
  }))

  function onState (room) {
    const prevHost = S.room?.hostId
    S.room = room
    if (prevHost && prevHost !== room.hostId && room.hostId === S.me) toast('You\'re now the host 👑', 'success')
    const key = room.media ? `${room.media.infoHash}:${room.media.fileIndex}` : null
    if (key !== S.mediaKey) { S.mediaKey = key; renderMain() }
    renderRail()
    renderTopbar()
  }

  function onPlayback (state) {
    S.lastPlayback = state
    if (S.sync && S.playerReady) S.sync.apply(state)
    if (state.action === 'start') toast('Starting in 3…', 'info', 2500)
    renderReady()
  }

  // ======================================================================
  // Layout
  // ======================================================================
  const strip = statsStrip()
  const rail = {}
  function buildLayout () {
    page.replaceChildren(mainSlot, dashSlot)
    rail.roomCard = h('section.rail-card')
    rail.people = h('section.rail-card')
    rail.reactions = h('section.rail-card',
      h('div.eyebrow', { style: { marginBottom: '10px' } }, 'Reactions'),
      h('div.reactions', REACTIONS.map((e, i) => h('button', { 'aria-label': `React ${e}`, title: `React (Shift+${i + 1})`, onclick: (ev) => react(e, ev.currentTarget) }, e)))
    )
    rail.chat = h('section.rail-card.grow', chat.el)
    shell.setRail(h('div', { style: { display: 'contents' } }, rail.roomCard, rail.people, rail.reactions, rail.chat))
  }

  function renderTopbar () {
    const r = S.room
    const online = r.members.filter((m) => m.connected).length
    shell.setTopbar({
      title: r.name,
      sub: r.media ? r.media.title : 'Lobby',
      chip: h('div.chip.live', h('span.dot.pulse'), h('span.num', `${online} watching`)),
      actions: [h('button.icon-btn', { 'aria-label': 'Copy invite link', title: 'Copy invite link', onclick: copyInvite }, icon('link'))]
    })
  }

  // ---------------------------------------------------------------- main
  function renderMain () {
    S.sync?.destroy(); S.sync = null
    S.pv?.destroy(); S.pv = null
    S.playerReady = false
    const r = S.room
    if (!r.media) {
      socket.send('torrent:watch', {})
      dashSlot.replaceChildren()
      mainSlot.replaceChildren(isHost() ? pickerView() : lobbyView())
      return
    }
    mountPlayer(r.media)
  }

  async function mountPlayer (m) {
    mainSlot.replaceChildren(h('div.player.skeleton'))
    let t
    try { t = await api.torrent(m.infoHash) } catch (e) {
      mainSlot.replaceChildren(h('div.panel.empty', h('div.empty-icon', icon('alert')), h('h3', 'Media unavailable'), h('p', e.message)))
      return
    }
    if (S.mediaKey !== `${m.infoHash}:${m.fileIndex}`) return // changed while loading
    const file = t.files[m.fileIndex]
    const pv = new PlayerView({
      title: m.title,
      badges: fileBadges(file.name, file.ext),
      torrentSubs: t.files.filter((f) => f.kind === 'subtitle')
    })
    const sync = new RoomSync({ pv, getRoom: () => S.room, meId: S.me })
    pv.controller = sync.controller
    S.pv = pv
    S.sync = sync

    const pill = h('button.chip.sm.info', { title: 'Click to re-sync', style: { cursor: 'pointer' }, onclick: (e) => { e.stopPropagation(); S.sync?.resync() } }, h('span.dot'), h('span.num', 'Syncing…'))
    pv.setSyncPill(pill)
    sync.on('pill', ({ kind, drift }) => {
      const ms = Math.round(Math.abs(drift || 0) * 1000)
      const show = settings.get('showDrift')
      const map = {
        synced: ['live', show ? `In sync ±${ms}ms` : 'In sync'],
        catching: ['warn', `Catching up ${drift < 0 ? '−' : '+'}${(Math.abs(drift)).toFixed(1)}s`],
        resync: ['warn', 'Re-synced'],
        buffering: ['warn', 'Buffering'],
        paused: ['info', 'Paused'],
        host: ['info', 'Host · reference']
      }
      const [cls, label] = map[kind] || ['info', kind]
      pill.className = `chip sm ${cls}`
      pill.lastChild.textContent = label
    })
    sync.on('status', (s) => { if (s === 'countdown') { pill.className = 'chip sm info'; pill.lastChild.textContent = 'Starting…' } })
    sync.on('activity', (text) => toast(text, 'info', 1800))
    pv.on('reaction-key', (i) => react(REACTIONS[i]))
    pv.on('theatre', (on) => shell.setRail(on ? null : railRoot()))
    pv.on('autoplay-blocked', () => {
      pv.engine.muted(true)
      pv.engine.play()
      toast('Muted so you could start in sync — press M to unmute.', 'warn', 6000)
    })
    pv.on('loaded', () => {
      if (!S.playerReady) {
        S.playerReady = true
        if (S.lastPlayback) sync.apply(S.lastPlayback)
        renderReady()
      }
    })

    mainSlot.replaceChildren(pv.el)
    renderDash()
    socket.send('torrent:watch', { infoHash: m.infoHash, fileIndex: m.fileIndex })
    await pv.load({ infoHash: m.infoHash, fileIndex: m.fileIndex, name: file.name, ext: file.ext, playable: file.playable }, {})
  }

  const railRoot = () => h('div', { style: { display: 'contents' } }, rail.roomCard, rail.people, rail.reactions, rail.chat)

  function renderDash () {
    const pv = S.pv
    const tile = (ic, label, fn, on = false) => h(`button.tile${on ? '.on' : ''}`, { onclick: fn }, icon(ic), h('span', label))
    const tiles = [
      tile('sync', 'Sync now', () => S.sync?.resync()),
      tile('cc', 'Subtitles', () => pv.cycleSubtitles()),
      tile('quality', 'Compat mode', () => pv.engine.setQuality(pv.engine.mode === 'compat' ? 'direct' : 'compat-original')),
      tile('pip', 'Picture in picture', () => pv.togglePip()),
      tile('theatre', 'Theatre', () => pv.toggleTheatre()),
      tile('fullscreen', 'Fullscreen', () => pv.toggleFullscreen()),
      tile('link', 'Invite', copyInvite)
    ]
    if (isHost()) {
      tiles.push(tile('film', 'Change title', () => openPickerModal()))
      tiles.push(tile(S.room.settings.controlsLocked ? 'lock' : 'unlock', S.room.settings.controlsLocked ? 'Controls locked' : 'Anyone controls',
        () => socket.request('room:settings', { controlsLocked: !S.room.settings.controlsLocked }).catch((e) => toast(e.message, 'danger')),
        S.room.settings.controlsLocked))
    }
    dashSlot.replaceChildren(h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--gutter)' } },
      strip.el,
      h('div.panel.room-tiles', h('div.tiles', tiles))
    ))
  }

  // Host without media: choose something
  function pickerView () {
    const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--gutter)' } })
    const choose = (t, f) => socket.request('room:media', { infoHash: t.infoHash, fileIndex: f.index }).catch((e) => toast(e.message, 'danger'))
    const show = (t) => list.prepend(torrentCard(t, { onWatch: null, onParty: (f) => choose(t, f), partyLabel: 'Show this' }))
    api.torrents().then((ts) => ts.forEach(show)).catch(() => {})
    return h('div.picker',
      h('section.panel',
        h('div.panel-head', h('div', h('div.eyebrow', 'You\'re the host'), h('h2', 'What are we watching?'))),
        addTorrent({ onLoaded: show, compact: true })
      ),
      h('div', { style: { height: 'var(--gutter)' } }),
      list
    )
  }

  function openPickerModal () {
    const body = pickerView()
    body.style.maxWidth = 'none'
    const m = modal({ title: 'Change title', subtitle: 'Everyone will need to ready up again.', body, wide: true })
    const off = socket.listen('room:state', (r) => { if (r.media && `${r.media.infoHash}:${r.media.fileIndex}` !== S.mediaKey) { m.close(); off() } })
    m.closed.then(off)
  }

  function lobbyView () {
    const host = S.room.members.find((m) => m.isHost)
    return h('section.panel.empty', { style: { minHeight: '360px', position: 'relative', overflow: 'hidden' } },
      host ? avatar({ name: host.name, color: host.color, size: 'xl' }) : h('div.empty-icon', icon('popcorn')),
      h('h3', host ? `Waiting for ${host.name} to pick something` : 'Waiting for the host'),
      h('p', 'Grab some snacks. As soon as a title is chosen it\'ll load here and you can ready up.'),
      h('div.spinner.sm')
    )
  }

  // ---------------------------------------------------------------- rail
  function renderRail () {
    if (!rail.roomCard) return
    const r = S.room
    const link = `${location.origin}/room/${r.id}`
    rail.roomCard.replaceChildren(
      h('div.room-id',
        h('div', { style: { flex: 1, minWidth: 0 } }, h('h2.truncate', r.name), h('span.code', r.id)),
        h('button.icon-btn.sm', { 'aria-label': 'Leave room', title: 'Leave room', onclick: leaveRoom }, icon('door'))
      ),
      h('div.invite-row',
        h('input.input', { value: link, readonly: true, 'aria-label': 'Invite link', onfocus: (e) => e.target.select() }),
        h('button.btn.primary.sm', { onclick: copyInvite }, icon('copy'), 'Copy')
      )
    )
    renderPeople()
    renderReady()
  }

  function renderPeople () {
    const r = S.room
    const host = isHost()
    const statusLine = (m) => {
      if (!m.connected) return h('span.pstatus', 'Away')
      if (m.status === 'watching') return h('span.pstatus.watching', h('span.dot.live'), `Now watching · ${clock(m.position)}`)
      if (m.status === 'buffering') return h('span.pstatus.buffering', h('span.dot.warn'), 'Buffering…')
      if (m.status === 'paused') return h('span.pstatus', `Paused · ${clock(m.position)}`)
      return h('span.pstatus', 'In the lobby')
    }
    const people = r.members.map((m) => h(`div.person${m.connected ? '' : '.offline'}`,
      avatar({ name: m.name, color: m.color, status: m.connected ? m.status : 'away' }),
      h('div.pinfo',
        h('div.pname', h('span.truncate', m.name), m.isHost ? icon('crown', 'crown') : null, m.id === S.me ? h('span.you', 'you') : null),
        statusLine(m)
      ),
      !r.playback.started
        ? h(`span.ready-badge${m.ready ? '.yes' : ''}`, m.ready ? icon('check') : null, m.ready ? 'READY' : 'NOT READY')
        : null,
      host && m.id !== S.me && m.connected
        ? h('div', { style: { display: 'flex', gap: '4px' } },
          h('button.icon-btn.sm', { title: `Make ${m.name} host`, 'aria-label': `Make ${m.name} host`, onclick: () => socket.request('host:transfer', { userId: m.id }).catch((e) => toast(e.message, 'danger')) }, icon('crown')),
          h('button.icon-btn.sm', { title: `Remove ${m.name}`, 'aria-label': `Remove ${m.name}`, onclick: () => confirmKick(m) }, icon('kick')))
        : null
    ))
    rail.readySlot = rail.readySlot || h('div.ready-cta')
    rail.people.replaceChildren(
      h('div.panel-head', { style: { marginBottom: '6px' } },
        h('div.eyebrow', `Participants · ${r.members.filter((m) => m.connected).length}`),
        h('div.right', h('div.avatar-stack', r.members.filter((m) => m.connected).slice(0, 5).map((m) => avatar({ name: m.name, color: m.color, size: 'sm' }))))
      ),
      h('div.people', people),
      rail.readySlot
    )
  }

  function renderReady () {
    const slot = rail.readySlot
    if (!slot || !S.room) return
    const r = S.room
    const me = r.members.find((m) => m.id === S.me)
    const present = r.members.filter((m) => m.connected)
    const readyCount = present.filter((m) => m.ready).length
    const started = r.playback.started

    if (started) {
      slot.replaceChildren(h('div.card', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        h('span.dot.live.pulse'), h('b', 'Session live'), h('span.muted', { style: { marginLeft: 'auto', fontSize: '0.85rem' } }, r.settings.controlsLocked ? 'Host controls playback' : 'Anyone can control')))
      return
    }
    const canReady = !!r.media && S.playerReady
    const readyBtn = h(`button.btn.lg.block.ready-btn${me?.ready ? '.is-ready' : ''}`, {
      disabled: !canReady,
      onclick: () => socket.request('room:ready', { ready: !me?.ready }).catch((e) => toast(e.message, 'danger'))
    }, icon(me?.ready ? 'checkCircle' : 'check'), !r.media ? 'Waiting for a title' : !S.playerReady ? 'Loading video…' : me?.ready ? 'Ready! (tap to undo)' : 'I\'m ready')

    const parts = [
      h('div.meter', h('span.num', `${readyCount}/${present.length} ready`), h('div.progress', h('i', { style: { width: `${present.length ? (readyCount / present.length) * 100 : 0}%` } }))),
      readyBtn
    ]
    if (isHost()) {
      const waiting = present.length - readyCount
      parts.push(h('button.btn.primary.lg.block', {
        disabled: !r.allReady,
        onclick: () => socket.request('room:start').catch((e) => toast(e.message, 'danger'))
      }, icon('play'), r.allReady ? 'Start session' : `Waiting for ${waiting} ${waiting === 1 ? 'person' : 'people'}…`))
    }
    slot.replaceChildren(...parts)
  }

  function confirmKick (m) {
    modal({
      title: `Remove ${m.name}?`,
      subtitle: 'They can rejoin with the invite link.',
      body: h('div'),
      actions: [
        { label: 'Cancel' },
        { label: 'Remove', danger: true, onClick: (close) => { socket.request('host:kick', { userId: m.id }).catch((e) => toast(e.message, 'danger')); close() } }
      ]
    })
  }

  // ---------------------------------------------------------------- actions
  const isHost = () => S.room?.hostId === S.me

  async function copyInvite () {
    const link = `${location.origin}/room/${roomId}`
    try {
      if (navigator.share && matchMedia('(hover: none)').matches) await navigator.share({ title: `Join my NickFlix party`, url: link })
      else { await navigator.clipboard.writeText(link); toast('Invite link copied', 'success', 1800) }
    } catch { /* share cancelled */ }
  }

  function react (emoji, btn) {
    btn?.classList.remove('burst'); void btn?.offsetWidth; btn?.classList.add('burst')
    socket.request('reaction:send', { emoji }).catch((e) => toast(e.message, 'warn', 1500))
  }

  function leaveRoom () {
    S.joined = false
    socket.request('room:leave').catch(() => {})
    shell.navigate('/rooms')
  }

  // ======================================================================
  // Chat component
  // ======================================================================
  const chat = (() => {
    const log = h('div.chat-log', { 'aria-live': 'polite' })
    const typingEl = h('div.typing')
    const input = h('input.input', { placeholder: 'Say something…', maxlength: 500, 'aria-label': 'Chat message', autocomplete: 'off' })
    const typers = new Map()
    let lastTypingSent = 0
    let last = null

    input.addEventListener('input', () => {
      if (Date.now() - lastTypingSent > 2000) { lastTypingSent = Date.now(); socket.send('chat:typing') }
    })
    const form = h('form.chat-form', {
      onsubmit: async (e) => {
        e.preventDefault()
        const text = input.value.trim()
        if (!text) return
        input.value = ''
        try { await socket.request('chat:send', { text }) } catch (err) { toast(err.message, 'warn'); input.value = text }
      }
    }, input, h('button.btn.primary', { type: 'submit', 'aria-label': 'Send', style: { width: '48px', padding: 0 } }, icon('send')))

    const el = h('div.chat', h('div.eyebrow', { style: { marginBottom: '8px' } }, 'Live chat'), log, typingEl, form)

    function node (m) {
      if (m.type === 'system') { last = null; return h('div.msg.system', h('span.mtext', m.text)) }
      const cont = last && last.userId === m.userId && m.at - last.at < 120_000
      last = m
      return h(`div.msg${cont ? '.cont' : ''}${m.userId === S.me ? '.mine' : ''}`,
        avatar({ name: m.name, color: m.color, size: 'sm' }),
        h('div.mbody',
          cont ? null : h('div.mhead', h('b', { style: { color: m.color } }, m.name), h('time', timeOfDay(m.at))),
          h('div.mtext', m.text)
        )
      )
    }
    function add (m) {
      const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80
      log.append(node(m))
      typers.delete(m.userId); renderTyping()
      if (nearBottom || m.userId === S.me) log.scrollTop = log.scrollHeight
    }
    function reset (list = []) {
      last = null
      log.replaceChildren(...list.map(node))
      requestAnimationFrame(() => { log.scrollTop = log.scrollHeight })
    }
    function typing ({ userId, name }) {
      clearTimeout(typers.get(userId)?.t)
      typers.set(userId, { name, t: setTimeout(() => { typers.delete(userId); renderTyping() }, 3000) })
      renderTyping()
    }
    function renderTyping () {
      const names = [...typers.values()].map((x) => x.name)
      typingEl.replaceChildren(...(names.length
        ? [h('span.dots', h('i'), h('i'), h('i')), `${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''} ${names.length === 1 ? 'is' : 'are'} typing`]
        : []))
    }
    return { el, add, reset, typing }
  })()

  // ======================================================================
  join(true)

  return {
    el: page,
    title: 'Watch room',
    destroy () {
      if (S.joined) socket.request('room:leave').catch(() => {})
      socket.send('torrent:watch', {})
      d.dispose()
      S.sync?.destroy()
      S.pv?.destroy()
    }
  }
}

/** Reaction float when there's no player on screen (lobby). */
function floatReaction (container, { emoji, name, color }) {
  container.style.position = 'relative'
  const n = h('div.float-react', { style: { left: `${15 + Math.random() * 65}%`, bottom: '40px', '--drift': `${(Math.random() - 0.5) * 60}px`, zIndex: 5 } },
    h('span.e', emoji), h('span.who', { style: { background: color } }, name))
  container.append(n)
  setTimeout(() => n.remove(), 3300)
}
