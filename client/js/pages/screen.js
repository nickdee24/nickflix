/**
 * Screen 1 — the one and only screen.
 *
 *  main column : a cinema auditorium with the screen at the far end. The
 *                player (synced for everyone) or the empty screen where the
 *                host drops a movie lives on that screen; when the movie
 *                plays the lights go down and the screen comes forward.
 *  right rail  : share link, who's watching (live buffer bars, quality,
 *                connection speed and sync accuracy), reactions, chat
 */
import { h, Disposer, morphChildren } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { bytes, clock, timeOfDay } from '../lib/format.js'
import { identity, settings } from '../state/store.js'
import { api } from '../services/api.js'
import { socket } from '../services/socket.js'
import { RoomSync } from '../services/sync.js'
import { PlayerView } from '../player/player-view.js'
import { avatar } from '../components/avatar.js'
import { toast } from '../components/toast.js'
import { askUsername } from '../components/username.js'
import { modal } from '../components/modal.js'

const REACTIONS = ['👍', '❤️', '😂', '😮']
const VIDEO_EXT = /\.(mp4|m4v|mkv|webm|mov|avi|wmv|flv|mpg|mpeg|ts|m2ts|mts|vob|divx|ogv|3gp)$/i
const SUB_EXT = /\.(srt|vtt|ass|ssa)$/i
const BUFFER_GOAL = 30 // seconds; a full buffer bar

export function screenPage (params, shell) {
  const d = new Disposer()
  const S = {
    state: null, // server snapshot
    me: null,
    admin: false,
    hostAdmin: null,
    library: [],
    pv: null,
    sync: null,
    mediaKey: undefined, // undefined = nothing rendered yet
    lastPlayback: null,
    joined: false,
    playerReady: false,
    preparing: null,
    net: new Map() // userId → live stats
  }
  const page = h('div.page.watch-layout', h('div.panel.empty', h('div.spinner'), h('p', 'Taking your seat…')))
  const mainSlot = h('div.cin-screen')
  const libSlot = h('div')
  const tilesSlot = h('div')
  const cinema = buildCinema(mainSlot)

  shell.setTopbar({ title: 'Screen 1' })

  // ======================================================================
  // Join
  // ======================================================================
  async function join (firstTime) {
    let info = null
    try { info = await api.screen() } catch { /* the socket join will report problems */ }
    let name = identity.username
    if (!name) {
      name = await askUsername({
        title: `Welcome to ${info?.name || 'Screen 1'}`,
        subtitle: info?.media ? `${info.media.title} is on. Pick a name so everyone knows who's here.` : 'Pick a name so everyone knows who\'s here.',
        cta: 'Take a seat'
      })
      if (!name) { page.replaceChildren(h('div.panel.empty', h('div.empty-icon', icon('popcorn')), h('h3', 'You need a name to join'), h('button.btn.primary', { onclick: () => join(true) }, 'Pick a name'))); return }
    }
    try {
      await socket.whenConnected()
      const res = await socket.request('screen:join', { username: name, clientKey: identity.clientKey, hostKey: identity.hostKey || undefined })
      S.me = res.me
      S.admin = res.admin
      S.hostAdmin = res.hostAdmin
      if (res.library) S.library = res.library
      S.joined = true
      sendPresence()
      if (firstTime) buildLayout()
      if (firstTime || res.state.media?.key !== S.mediaKey) S.mediaKey = undefined // (re)render the main column with our role
      onState(res.state)
      chat.reset(res.chat)
      onPlayback(res.state.playback)
    } catch (e) {
      page.replaceChildren(h('div.panel.empty',
        h('div.empty-icon', icon('alert')), h('h3', 'Couldn\'t join'), h('p', e.message),
        h('button.btn.primary', { onclick: () => join(!S.joined) }, icon('sync'), 'Try again')))
    }
  }

  d.add(socket.on('status', (s) => { if (s === 'online' && S.joined) join(false) }))

  // ======================================================================
  // Socket events
  // ======================================================================
  d.add(socket.listen('screen:state', (st) => { if (S.joined) onState(st) }))
  d.add(socket.listen('playback:state', onPlayback))
  d.add(socket.listen('screen:net', onNet))

  // Another tab or minimised → shown as Away; closing the tab removes you (server side).
  const sendPresence = () => { if (S.joined) socket.send('screen:presence', { away: document.hidden }) }
  d.listen(document, 'visibilitychange', sendPresence)
  d.add(socket.listen('screen:library', (lib) => { S.library = lib; renderMain(false) }))
  d.add(socket.listen('host:status', (st) => { S.hostAdmin = st; if (!S.state?.media) renderMain(false) }))
  d.add(socket.listen('screen:preparing', (p) => { S.preparing = p; if (!S.state?.media || p) renderPreparing() }))
  d.add(socket.listen('screen:notice', (n) => toast(n.text, n.kind || 'info', 5000)))
  d.add(socket.listen('chat:message', (m) => chat.add(m)))
  d.add(socket.listen('chat:typing', (t) => chat.typing(t)))
  d.add(socket.listen('reaction', (r) => { if (S.pv) S.pv.showReaction(r); else floatReaction(cinema.el, r) }))
  d.add(socket.listen('screen:kicked', () => {
    S.joined = false
    page.replaceChildren(h('div.panel.empty', h('div.empty-icon', icon('door')), h('h3', 'You were removed from the screen'), h('p', 'Ask the host for the link if that was a mistake.')))
    shell.setRail(null)
  }))

  function onState (state) {
    const prev = S.state
    S.state = state
    if (prev && !!prev.hold !== !!state.hold) updateScene(true)
    const key = state.media?.key || null
    if (key !== S.mediaKey) {
      S.mediaKey = key
      S.preparing = null
      renderMain(true)
    } else if (!state.media && prev && (prev.host?.online !== state.host?.online)) {
      renderMain(false)
    }
    renderRail()
    renderTopbar()
    renderTiles()
  }

  function onPlayback (state) {
    S.lastPlayback = state
    if (!state.playing) clearTitles()
    if (S.sync && S.playerReady) S.sync.apply(state)
    updateScene(true)
  }

  function onNet ({ viewers }) {
    S.net = new Map(viewers.map((v) => [v.id, v]))
    renderPeople()
  }

  // ======================================================================
  // Layout
  // ======================================================================
  const rail = {}
  function buildLayout () {
    page.replaceChildren(cinema.el, libSlot, tilesSlot)
    rail.screenCard = h('section.rail-card')
    rail.people = h('section.rail-card')
    rail.reactions = h('section.rail-card',
      h('div.eyebrow', { style: { marginBottom: '10px' } }, 'Reactions'),
      h('div.reactions', REACTIONS.map((e, i) => h('button', { 'aria-label': `React ${e}`, title: `React (Shift+${i + 1})`, onclick: (ev) => react(e, ev.currentTarget) }, e)))
    )
    rail.chat = h('section.rail-card.grow', chat.el)
    shell.setRail(railRoot())
    wireDrop()
  }
  const railRoot = () => h('div', { style: { display: 'contents' } }, rail.screenCard, rail.people, rail.reactions, rail.chat)

  function renderTopbar () {
    const st = S.state
    const online = st.members.filter((m) => m.connected).length
    shell.setTopbar({
      title: st.name,
      sub: st.media ? st.media.title : 'Nothing showing',
      chip: h('div.chip.live', h('span.dot.pulse'), h('span.num', `${online} watching`)),
      actions: [h('button.icon-btn', { 'aria-label': 'Copy share link', title: 'Copy share link', onclick: copyLink }, icon('link'))]
    })
  }

  // ---------------------------------------------------------------- main
  function renderMain (remount) {
    const st = S.state
    if (!st) return
    libSlot.replaceChildren(...(S.admin && !st.media ? [libraryPanel()] : []))
    if (st.media) { if (remount) mountPlayer(st.media); return }
    S.sync?.destroy(); S.sync = null
    setTheatre(false)
    S.pv?.destroy(); S.pv = null
    S.playerReady = false
    mainSlot.replaceChildren(S.preparing ? preparingView() : emptyScreen())
    updateScene(false)
  }

  function renderPreparing () {
    if (S.state?.media && !S.preparing) return
    if (!S.state?.media) { mainSlot.replaceChildren(S.preparing ? preparingView() : emptyScreen()); return }
    // Switching movie while one is showing: overlay a small notice on the player.
    if (S.preparing) toast(`${S.preparing.by} is putting on ${S.preparing.title}…`, 'info', 4000)
  }

  function preparingView () {
    return h('section.stage', h('div.stage-inner',
      h('div.spinner'),
      h('h3', `Preparing ${S.preparing.title}…`),
      h('p.muted', `${S.preparing.by} picked it. The host PC is getting it ready to stream; this takes a few seconds.`)
    ))
  }

  function hostLine () {
    const host = S.state.host || {}
    if (!host.configured) return h('div.host-line.warn', h('span.dot.warn'), 'Setup needed: add HOST_SECRET on Render (see the README).')
    if (!host.connected) return h('div.host-line.err', h('span.dot.err'), 'The host PC is offline. Start NickFlix Host on it.')
    if (!host.online) return h('div.host-line.warn', h('span.dot.warn.pulse'), 'The host PC is connecting…')
    return h('div.host-line.ok', h('span.dot.live'), `Host PC online · ${host.encoder || 'ready'}${S.admin ? ` · ${host.movies} movie${host.movies === 1 ? '' : 's'}` : ''}`)
  }

  function emptyScreen () {
    if (!S.admin) {
      const host = S.state.members.find((m) => m.admin && m.connected)
      return h('section.stage', h('div.stage-inner',
        host ? avatar({ name: host.name, color: host.color, size: 'xl' }) : h('div.empty-icon', icon('popcorn')),
        h('h3', host ? `Waiting for ${host.name} to put something on` : 'Nothing showing yet'),
        h('p.muted', 'Grab some snacks. When a movie goes on it\'ll load here for everyone, and anyone can press play.'),
        hostLine()
      ))
    }
    const missing = S.hostAdmin?.missing || []
    return h('section.stage.drop-target', h('div.stage-inner',
      h('div.dz-icon', icon('upload')),
      h('h3', 'Drop a movie here'),
      h('p.muted', `Drag a file from ${S.hostAdmin?.folders?.[0] ? `"${S.hostAdmin.folders[0]}"` : 'your movie folder'} onto the screen, or pick one below.`),
      hostLine(),
      missing.length ? h('div.host-line.warn', h('span.dot.warn'), `Folder not found on the PC: ${missing.join(', ')}`) : null
    ))
  }

  function libraryPanel ({ onPicked } = {}) {
    const list = h('div.lib-list')
    const search = h('input.input', { placeholder: 'Search your movies…', 'aria-label': 'Search movies', oninput: () => draw() })
    const draw = () => {
      const q = search.value.trim().toLowerCase()
      const items = S.library.filter((e) => !q || e.title.toLowerCase().includes(q) || e.name.toLowerCase().includes(q))
      if (!S.state.host?.connected) return list.replaceChildren(h('p.muted.lib-empty', 'Your movies show up here when NickFlix Host is running on your PC.'))
      if (!items.length) return list.replaceChildren(h('p.muted.lib-empty', q ? 'No matches.' : 'No movies found in your folder yet. Drop some in and they\'ll appear here.'))
      list.replaceChildren(...items.map((e) => h('button.lib-item', {
        onclick: () => { load({ id: e.id }); onPicked?.() },
        title: e.name
      },
      h('span.lib-icon', icon('film')),
      h('span.lib-text', h('b.truncate', e.title), h('small.truncate', [e.folder, bytes(e.size)].filter(Boolean).join(' · '))),
      h('span.lib-play', icon('play')))))
    }
    draw()
    return h('section.panel.library',
      h('div.panel-head', h('div', h('div.eyebrow', 'On your PC'), h('h2', 'Your movies')),
        h('div.right', h('button.icon-btn.sm', { title: 'Rescan folder', 'aria-label': 'Rescan folder', onclick: refreshLibrary }, icon('sync')))),
      search,
      list
    )
  }

  async function refreshLibrary () {
    try {
      const res = await socket.request('screen:library', undefined, 25_000)
      S.library = res.library
      if (res.warning) toast(res.warning, 'warn')
      if (!S.state.media) renderMain(false)
    } catch (e) { toast(e.message, 'danger') }
  }

  async function load (req) {
    try {
      await socket.request('screen:load', req, 130_000)
    } catch (e) {
      toast(e.message, 'danger', 7000)
    }
  }

  // ---------------------------------------------------------------- drag & drop
  function wireDrop () {
    let depth = 0
    const overlay = h('div.drop-overlay', h('div', icon('upload'), h('b', 'Drop to put it on Screen 1')))
    const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files')
    const zone = cinema.el
    d.listen(zone, 'dragenter', (e) => {
      if (!isFiles(e)) return
      e.preventDefault()
      if (depth++ === 0) zone.append(overlay)
    })
    d.listen(zone, 'dragover', (e) => { if (isFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } })
    d.listen(zone, 'dragleave', () => { if (--depth <= 0) { depth = 0; overlay.remove() } })
    d.listen(zone, 'drop', (e) => {
      if (!isFiles(e)) return
      e.preventDefault()
      depth = 0
      overlay.remove()
      const file = e.dataTransfer.files[0]
      if (!file) return
      if (SUB_EXT.test(file.name)) {
        if (S.pv) S.pv.loadSubtitleFile(file)
        else toast('Put a movie on first, then drop subtitles on it.', 'info')
        return
      }
      if (!VIDEO_EXT.test(file.name)) return toast('That doesn\'t look like a video file.', 'warn')
      if (!S.admin) return toast('Only the host can put movies on. If that\'s you, add your host key in Settings.', 'info', 6000)
      // Browsers don't reveal file paths, so the PC finds it by name and size.
      load({ name: file.name, size: file.size })
    })
  }

  // ---------------------------------------------------------------- theatre mode
  // The screen moves to the middle of the window and everything else goes
  // almost black. Clicking anywhere outside the picture (or Esc) brings the
  // lights back.
  let theatreBackdrop = null
  function setTheatre (on) {
    on = !!on
    if (!on && !theatreBackdrop) return
    if (S.pv && S.pv.theatre !== on) { S.pv.theatre = on; S.pv.el.classList.toggle('theatre', on); S.pv.theatreBtn?.classList.toggle('on', on) }
    cinema.el.classList.toggle('theatre', on)
    document.documentElement.classList.toggle('theatre-on', on)
    shell.setRail(on ? null : railRoot())
    if (on) {
      theatreBackdrop = h('div.theatre-backdrop', { title: 'Click to bring the lights back', onclick: () => setTheatre(false) })
      document.body.append(theatreBackdrop)
    } else {
      theatreBackdrop?.remove()
      theatreBackdrop = null
    }
  }
  d.listen(document, 'keydown', (e) => { if (e.key === 'Escape' && theatreBackdrop && !document.fullscreenElement) setTheatre(false) })

  // ---------------------------------------------------------------- player
  function mountPlayer (m) {
    S.sync?.destroy(); S.sync = null
    setTheatre(false)
    S.pv?.destroy(); S.pv = null
    S.playerReady = false

    const pv = new PlayerView({ title: m.title, badges: mediaBadges(m), subtitles: m.subtitles })
    const sync = new RoomSync({ pv, getRoom: () => S.state, meId: S.me })
    pv.controller = sync.controller
    S.pv = pv
    S.sync = sync

    const pill = h('button.chip.sm.info', { title: 'Click to re-sync', style: { cursor: 'pointer' }, onclick: (e) => { e.stopPropagation(); S.sync?.resync() } }, h('span.dot'), h('span.num', 'Syncing…'))
    pv.setSyncPill(pill)
    sync.on('pill', ({ kind, drift }) => {
      const ms = Math.round(Math.abs(drift || 0) * 1000)
      const map = {
        synced: ['live', settings.get('showDrift') ? `In sync ±${ms}ms` : 'In sync'],
        catching: ['warn', `Catching up ${drift < 0 ? '−' : '+'}${Math.abs(drift).toFixed(1)}s`],
        resync: ['warn', 'Re-synced'],
        buffering: ['warn', 'Buffering'],
        paused: S.state?.hold ? ['warn', 'Waiting for everyone'] : ['info', 'Paused']
      }
      const [cls, label] = map[kind] || ['info', kind]
      pill.className = `chip sm ${cls}`
      pill.lastChild.textContent = label
    })
    sync.on('status', (s) => { if (s === 'countdown') { pill.className = 'chip sm info'; pill.lastChild.textContent = 'Starting…' } })
    sync.on('activity', (text) => toast(text, 'info', 1800))
    sync.on('scheduled', ({ wait, action }) => runIntro(wait, action === 'start'))
    pv.on('reaction-key', (i) => react(REACTIONS[i]))
    pv.on('theatre', (on) => setTheatre(on))
    pv.on('autoplay-blocked', () => {
      pv.engine.muted(true)
      pv.engine.play()
      toast('Muted so you could start in sync. Press M to unmute.', 'warn', 6000)
    })
    pv.on('loaded', () => {
      if (S.playerReady) return
      S.playerReady = true
      if (S.lastPlayback) sync.apply(S.lastPlayback)
    })

    mainSlot.replaceChildren(pv.el)
    updateScene(false)
    renderTiles()
    const p = S.lastPlayback
    pv.load(m, { startAt: p ? sync.expected() || p.position : 0 })
  }

  // Report buffer / connection / sync once a second: drives everyone's buffer bars and wait-for-everyone.
  d.interval(() => {
    if (!S.joined) return
    const pv = S.pv
    if (!pv || !S.state?.media) { socket.send('screen:report', { loaded: false }); return }
    const e = pv.engine
    const lvl = e.levelInfo()
    socket.send('screen:report', {
      key: S.state.media.key,
      loaded: S.playerReady,
      ahead: Math.round(e.bufferAhead() * 10) / 10,
      bw: lvl.bandwidth,
      height: lvl.height,
      quality: lvl.name,
      auto: lvl.auto,
      drift: S.sync?.lastDrift != null ? S.sync.lastDrift * 1000 : null,
      waiting: e.isWaiting()
    })
  }, 1000)

  function mediaBadges (m) {
    const tags = []
    if (m.height) tags.push(h('span.tag', m.width && m.width >= 3800 ? '4K source' : `${m.height >= 1000 || m.width >= 1900 ? '1080p' : `${m.height}p`} source`))
    if (m.hdr) tags.push(h('span.tag', 'HDR → SDR'))
    if (m.duration) tags.push(h('span.tag', clock(m.duration)))
    return tags
  }

  // ---------------------------------------------------------------- the cinema
  /**
   * Which scene the room should be in right now:
   *   playing → lights down, screen forward (also during a brief buffer hold)
   *   paused  → screen back, lights up, picture dimmed
   *   lobby   → nothing started yet
   * Scheduled starts are handled by runIntro().
   */
  function sceneFor () {
    const st = S.state
    const p = S.lastPlayback || st?.playback
    if (!st?.media || !p) return 'lobby'
    if (p.playing && socket.serverNow() < p.updatedAt) return null // intro running
    if (p.playing || st.hold) return 'playing'
    return p.started ? 'paused' : 'lobby'
  }

  function updateScene (animate) {
    const scene = sceneFor()
    if (!scene) return
    clearTimeout(S.introTimer); clearTimeout(S.promptTimer); clearTimeout(S.introEndTimer)
    clearTitles()
    cinema.el.classList.remove('intro')
    if (scene !== 'playing') closePrompt()
    if (scene === cinema.el.dataset.scene) return
    if (scene === 'paused' || scene === 'lobby') cinema.set(scene, { zoom: 1.4, lights: 1.6, lightsDelay: 0.5 }, animate) // zoom out, then lights up
    else cinema.set(scene, { lights: 1.2, zoom: 1.4 }, animate)
  }

  /** Lights down, then the screen comes forward, then (first time) the fullscreen prompt. */
  function runIntro (wait, first) {
    clearTimeout(S.introTimer); clearTimeout(S.promptTimer); clearTimeout(S.introEndTimer)
    const s = wait / 1000
    const lights = first ? Math.min(2.6, s * 0.28) : Math.min(1.3, s * 0.35)
    const zoom = first ? Math.min(3, s * 0.3) : Math.min(1.6, s * 0.45)
    cinema.set('dimming', { lights, zoom }, true)
    cinema.el.classList.add('intro')
    S.introEndTimer = setTimeout(() => cinema.el.classList.remove('intro'), wait)
    S.introTimer = setTimeout(() => cinema.set('playing', { lights: 0.6, zoom }, true), lights * 1000)
    // First play: after the zoom, the fullscreen prompt, then the opening
    // titles ("NickFlix presents", then the movie's name) end as it starts.
    const zoomed = (lights + zoom) * 1000
    const titlesAt = first ? Math.max(zoomed, wait - TITLES_MS) : wait
    if (first && S.pv && !document.fullscreenElement) {
      S.promptTimer = setTimeout(() => openPrompt(titlesAt - zoomed), zoomed)
    }
    if (first && S.pv && wait - titlesAt >= 3000) {
      S.titlesTimer = setTimeout(() => playTitles(wait - titlesAt), titlesAt)
    }
  }

  // ---------------------------------------------------------------- opening titles
  const TITLES_MS = 7000
  function playTitles (ms) {
    clearTitles()
    closePrompt()
    const pv = S.pv
    const media = S.state?.media
    if (!pv || !media) return
    const m = /^(.*?)\s*\((\d{4})\)\s*$/.exec(media.title || '')
    const name = m ? m[1] : (media.title || '')
    const year = m ? m[2] : ''
    // With less time (joined late), only the movie's name is shown.
    const both = ms >= 5000
    const half = both ? ms / 2 : 0
    const card = h('div.title-card', { style: { '--presents': `${half}ms`, '--title': `${ms - half}ms`, '--title-delay': `${half}ms` } },
      both ? h('div.tc-presents', h('img', { src: '/public/nickflix-logo.png', alt: 'NickFlix' }), h('span', 'presents')) : null,
      h('div.tc-title', h('h1', name), year ? h('span', year) : null)
    )
    pv.el.append(card)
    S.titles = card
    S.titlesEnd = setTimeout(clearTitles, ms + 200)
  }
  function clearTitles () {
    clearTimeout(S.titlesTimer); clearTimeout(S.titlesEnd)
    S.titles?.remove(); S.titles = null
  }

  function openPrompt (ms) {
    closePrompt()
    const pv = S.pv
    if (!pv || ms < 1500) return
    const until = Date.now() + ms
    const left = h('p', '')
    const tick = () => {
      const n = Math.max(0, Math.ceil((until - Date.now()) / 1000))
      left.textContent = n ? `The movie starts in ${n}…` : 'Starting…'
      if (!n) closePrompt()
    }
    const box = h('div.fs-prompt', { onclick: (e) => e.stopPropagation() },
      h('h3', 'Go fullscreen?'),
      left,
      h('div.row',
        h('button.btn.primary', { onclick: () => { closePrompt(); pv.toggleFullscreen() } }, icon('fullscreen'), 'Fullscreen'),
        h('button.btn', { onclick: closePrompt }, 'Stay in the cinema')
      )
    )
    tick()
    S.prompt = { box, timer: setInterval(tick, 250) }
    pv.el.append(box)
  }

  function closePrompt () {
    if (!S.prompt) return
    clearInterval(S.prompt.timer)
    S.prompt.box.remove()
    S.prompt = null
  }

  // ---------------------------------------------------------------- tiles under the player
  function renderTiles () {
    const st = S.state
    if (!st) return
    const pv = S.pv
    const tile = (ic, label, fn, on = false) => h(`button.tile${on ? '.on' : ''}`, { onclick: fn }, icon(ic), h('span', label))
    const tiles = []
    if (pv) {
      tiles.push(
        tile('sync', 'Sync now', () => S.sync?.resync()),
        tile('cc', 'Subtitles', () => pv.cycleSubtitles()),
        tile('pip', 'Picture in picture', () => pv.togglePip()),
        tile('theatre', 'Theatre', () => pv.toggleTheatre()),
        tile('fullscreen', 'Fullscreen', () => pv.toggleFullscreen())
      )
    }
    tiles.push(tile('link', 'Share link', copyLink))
    if (S.admin) {
      if (st.media) {
        tiles.push(tile('film', 'Change movie', openLibraryModal))
        tiles.push(tile('x', 'Clear screen', () => socket.request('screen:unload').catch((e) => toast(e.message, 'danger'))))
      }
      tiles.push(tile(st.settings.waitForAll ? 'peers' : 'gauge', st.settings.waitForAll ? 'Waits for everyone' : 'Doesn\'t wait',
        () => socket.request('screen:settings', { waitForAll: !st.settings.waitForAll }).catch((e) => toast(e.message, 'danger')), st.settings.waitForAll))
      tiles.push(tile(st.settings.controlsLocked ? 'lock' : 'unlock', st.settings.controlsLocked ? 'Only you control' : 'Anyone controls',
        () => socket.request('screen:settings', { controlsLocked: !st.settings.controlsLocked }).catch((e) => toast(e.message, 'danger')), st.settings.controlsLocked))
    }
    tilesSlot.replaceChildren(h('div.panel.room-tiles', h('div.tiles', tiles)))
  }

  function openLibraryModal () {
    let m = null
    const body = libraryPanel({ onPicked: () => m?.close() })
    m = modal({ title: 'Change movie', subtitle: 'Everyone switches to it, starting from the beginning. You can also drop a file on the screen.', body, wide: true })
  }

  // ---------------------------------------------------------------- rail
  function renderRail () {
    if (!rail.screenCard) return
    const st = S.state
    rail.screenCard.replaceChildren(
      h('div.room-id',
        h('div', { style: { flex: 1, minWidth: 0 } }, h('h2.truncate', st.name), h('span.muted', { style: { fontSize: '0.8rem' } }, 'Send this link to invite people')),
        S.admin ? h('span.tag.ok', { title: 'You have the host key' }, icon('crown'), 'Host') : null
      ),
      h('div.invite-row',
        h('input.input', { value: shareLink(), readonly: true, 'aria-label': 'Share link', onfocus: (e) => e.target.select() }),
        h('button.btn.primary.sm', { onclick: copyLink }, icon('copy'), 'Copy')
      )
    )
    renderPeople()
  }

  function renderPeople () {
    const st = S.state
    if (!rail.people || !st) return
    const holdIds = new Set(st.hold?.ids || [])
    // People who closed the page drop off the list at once (the server keeps
    // them a few seconds in case it was just a refresh).
    const present = st.members.filter((m) => m.connected)
    const people = present.map((m) => {
      const n = S.net.get(m.id)
      return h(`div.person.viewer${m.connected ? '' : '.offline'}`, { dataset: { key: m.id } },
        avatar({ name: m.name, color: m.color, status: m.away ? 'away' : n?.waiting ? 'buffering' : n?.loaded ? 'watching' : 'idle' }),
        h('div.pinfo',
          h('div.pname', h('span.truncate', m.name), m.admin ? icon('crown', 'crown') : null, m.id === S.me ? h('span.you', 'you') : null),
          viewerStats(m, n, holdIds.has(m.id))
        ),
        S.admin && m.id !== S.me && m.connected
          ? h('button.icon-btn.sm', { title: `Remove ${m.name}`, 'aria-label': `Remove ${m.name}`, onclick: () => confirmKick(m) }, icon('kick'))
          : null
      )
    })
    const hold = st.hold && st.hold.ids.length
      ? h('div.hold-banner', { dataset: { key: 'hold' } }, h('span.dot.warn.pulse'), `Paused for ${st.hold.ids.map((id) => st.members.find((m) => m.id === id)?.name).filter(Boolean).join(', ') || 'someone'} to buffer…`)
      : null
    // Patched in place (not rebuilt) because this runs every second.
    morphChildren(rail.people, [
      h('div.panel-head', { dataset: { key: 'head' }, style: { marginBottom: '6px' } },
        h('div.eyebrow', `Watching · ${present.length}`),
        h('div.right', h('div.avatar-stack', present.slice(0, 5).map((m) => avatar({ name: m.name, color: m.color, size: 'sm' }))))
      ),
      hold,
      h('div.people', { dataset: { key: 'people' } }, people),
      st.media ? null : h('p.muted', { dataset: { key: 'hint' }, style: { fontSize: '0.8rem', margin: '10px 4px 0' } }, 'Buffer bars, quality and sync show here once a movie is on.')
    ].filter(Boolean))
  }

  /** "████░░  28s · 1080p · 24 Mbps · ±38ms" */
  function viewerStats (m, n, held) {
    if (!S.state.media) return h('span.pstatus', m.away ? 'Away' : 'In the lobby')
    if (!n || !n.loaded) return h('div.vstats', bufferBar(0, 'loading'), h('span.pstatus', m.away ? h('b.away-tag', 'Away · ') : null, h('span.dot.info.pulse'), 'Loading…'))
    const pct = Math.min(1, n.ahead / BUFFER_GOAL)
    const state = n.waiting ? 'stalled' : held ? 'low' : pct < 0.2 ? 'low' : 'ok'
    const parts = [`${Math.floor(n.ahead)}s buffered`]
    if (n.height) parts.push(`${n.quality || `${n.height}p`}${n.auto ? '' : ' (fixed)'}`)
    if (n.bw) parts.push(`${(n.bw / 1e6).toFixed(n.bw < 1e7 ? 1 : 0)} Mbps`)
    const sync = n.drift == null ? null : Math.abs(n.drift) < 1000 ? `±${Math.abs(Math.round(n.drift))}ms` : `${n.drift > 0 ? '+' : '−'}${(Math.abs(n.drift) / 1000).toFixed(1)}s`
    return h('div.vstats',
      bufferBar(pct, state),
      h(`span.pstatus${n.waiting ? '.buffering' : ''}`,
        m.away ? h('b.away-tag', 'Away · ') : null,
        n.waiting ? h('span.dot.warn') : null,
        n.waiting ? 'Buffering… ' : null,
        parts.join(' · '),
        sync ? h('span.sync-ms', { title: 'How far this person is from the room clock right now' }, ` · ${sync}`) : null
      )
    )
  }

  const bufferBar = (pct, state) => h(`div.progress.thin.buf.${state}`, { title: `${Math.round(pct * 100)}% of a ${BUFFER_GOAL}s buffer` }, h('i', { style: { width: `${Math.round(pct * 100)}%` } }))

  function confirmKick (m) {
    modal({
      title: `Remove ${m.name}?`,
      subtitle: 'They can come back with the share link.',
      body: h('div'),
      actions: [
        { label: 'Cancel' },
        { label: 'Remove', danger: true, onClick: (close) => { socket.request('screen:kick', { userId: m.id }).catch((e) => toast(e.message, 'danger')); close() } }
      ]
    })
  }

  // ---------------------------------------------------------------- actions
  const shareLink = () => `${location.origin}/`

  async function copyLink () {
    const link = shareLink()
    try {
      if (navigator.share && matchMedia('(hover: none)').matches) await navigator.share({ title: 'Watch with me on NickFlix', url: link })
      else { await navigator.clipboard.writeText(link); toast('Share link copied', 'success', 1800) }
    } catch { /* share cancelled */ }
  }

  function react (emoji, btn) {
    btn?.classList.remove('burst'); void btn?.offsetWidth; btn?.classList.add('burst')
    socket.request('reaction:send', { emoji }).catch((e) => toast(e.message, 'warn', 1500))
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

    const el = h('div.chat', h('div.eyebrow', { style: { marginBottom: '8px' } }, 'Chat'), log, typingEl, form)

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
    title: 'Screen 1',
    destroy () {
      // Stay a member (e.g. while visiting Settings); just stop counting towards wait-for-everyone.
      if (S.joined) socket.send('screen:report', { loaded: false })
      d.dispose()
      clearTimeout(S.introTimer); clearTimeout(S.promptTimer)
      closePrompt()
      clearTitles()
      setTheatre(false)
      S.sync?.destroy()
      S.pv?.destroy()
    }
  }
}

/** The auditorium around the screen: walls with lights, seats, and the darkness. */
function buildCinema (screenEl) {
  // Geometry matches cinema.css: walls meet the screen at x=23%, y=12%…66%.
  const WALL = 23
  const mirror = (side, x) => (side === 'left' ? `${x}%` : `${100 - x}%`)
  // Spot lights along the top of each wall, spaced closer as they recede.
  const LIGHTS = Array.from({ length: 10 }, (_, i) => {
    const x = 1.6 + (WALL - 2.4) * (1 - Math.pow(0.78, i + 0.6))
    const depth = x / WALL
    return [x, (x * 12) / WALL + 4.2 * (1 - depth * 0.7), 2.3 - depth * 1.6]
  })
  const SPEAKERS = [[5.5, 38, 2.1], [12, 39.5, 1.55], [16.8, 40.5, 1.2], [20.2, 41.2, 0.95]]
  const wallBits = (side) => [
    ...LIGHTS.map(([x, y, sz]) => h('span.sconce', { style: { left: mirror(side, x), top: `${y}%`, '--s': sz } })),
    ...SPEAKERS.map(([x, y, sz]) => h('span.speaker', { style: { left: mirror(side, x), top: `${y}%`, '--s': sz } }))
  ]
  const DOWNLIGHTS = [[28, 2.5, 1.6], [50, 3, 1.6], [72, 2.5, 1.6], [37, 7, 1.15], [63, 7, 1.15], [50, 9.6, 0.9], [43, 10.6, 0.75], [57, 10.6, 0.75]]
  const NS = 'http://www.w3.org/2000/svg'
  const lines = document.createElementNS(NS, 'svg')
  lines.setAttribute('viewBox', '0 0 100 100')
  lines.setAttribute('preserveAspectRatio', 'none')
  for (let k = 0; k <= 8; k++) {
    const x0 = (k / 8) * 100
    const l = document.createElementNS(NS, 'line')
    l.setAttribute('x1', x0); l.setAttribute('y1', 0)
    l.setAttribute('x2', WALL + (x0 / 100) * (100 - 2 * WALL)); l.setAttribute('y2', 12)
    lines.append(l)
  }
  const row = (cls, n) => h(`div.seat-row.${cls}`, Array.from({ length: n }, () => h('span')))
  const el = h('div.cinema.no-anim', { dataset: { scene: 'lobby' } },
    h('div.cin-room', { 'aria-hidden': 'true' },
      h('div.cin-ceiling', lines, DOWNLIGHTS.map(([x, y, sz]) => h('span.downlight', { style: { left: `${x}%`, top: `${y}%`, '--s': sz } }))),
      h('div.cin-back'),
      h('div.cin-wall.left', wallBits('left')),
      h('div.cin-wall.right', wallBits('right')),
      h('div.cin-floor'),
      h('div.cin-spill'),
      h('div.cin-seats', row('r1', 18), row('r2', 18), row('r3', 17), row('r4', 16), row('r5', 15), row('r6', 13), row('r7', 11))
    ),
    h('div.cin-dark'),
    screenEl
  )
  // First paint without transitions; animate from then on.
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('no-anim')))
  return {
    el,
    /** Change scene with the given durations in seconds. `animate: false` snaps straight there. */
    set (scene, { lights = 1.5, zoom = 1.5, lightsDelay = 0, zoomDelay = 0 } = {}, animate = true) {
      el.style.setProperty('--lights-dur', `${lights}s`)
      el.style.setProperty('--zoom-dur', `${zoom}s`)
      el.style.setProperty('--lights-delay', `${lightsDelay}s`)
      el.style.setProperty('--zoom-delay', `${zoomDelay}s`)
      if (!animate) {
        el.classList.add('no-anim')
        requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('no-anim')))
      }
      el.dataset.scene = scene
    }
  }
}

/** Reaction float when there's no player on screen. */
function floatReaction (container, { emoji, name, color }) {
  container.style.position = 'relative'
  const n = h('div.float-react', { style: { left: `${15 + Math.random() * 65}%`, bottom: '40px', '--drift': `${(Math.random() - 0.5) * 60}px`, zIndex: 5 } },
    h('span.e', emoji), h('span.who', { style: { background: color } }, name))
  container.append(n)
  setTimeout(() => n.remove(), 3300)
}
