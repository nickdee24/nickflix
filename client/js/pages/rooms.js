/**
 * Watch Rooms hub: create a private room, join one by code or link, and
 * jump back into recent rooms.
 */
import { h, Disposer } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { timeAgo, prettyTitle } from '../lib/format.js'
import { identity, recentRooms } from '../state/store.js'
import { api } from '../services/api.js'
import { socket } from '../services/socket.js'
import { toast } from '../components/toast.js'
import { modal } from '../components/modal.js'
import { ensureUsername } from '../components/username.js'

/**
 * Create a room (optionally with media already chosen) and go to it.
 * Used from Home, Watch and the Rooms page.
 */
export async function startPartyFlow (shell, media = null) {
  const username = await ensureUsername({ title: 'Start a watch party', subtitle: 'First, what should everyone call you?' })
  if (!username) return
  const nameInput = h('input.input', { value: `${username}'s party`, maxlength: 40, 'aria-label': 'Room name' })
  const body = h('form', { onsubmit: (e) => { e.preventDefault(); go() } },
    media ? h('div.card', { style: { display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '14px' } },
      h('div.fc-icon', { style: { width: '40px', height: '40px', borderRadius: '10px', display: 'grid', placeItems: 'center', background: 'var(--accent-soft)', color: 'var(--accent)' } }, icon('film')),
      h('div', { style: { minWidth: 0 } }, h('div.eyebrow', 'Watching'), h('b.truncate', { style: { display: 'block' } }, media.title))
    ) : null,
    h('div.field', h('label', 'Room name'), nameInput),
    h('p.muted', { style: { fontSize: '0.85rem', marginTop: '10px' } }, 'Rooms are private — only people with the link can join. You\'ll be the host.'),
    h('div.modal-foot', h('button.btn.primary.lg.block', { type: 'submit' }, icon('rooms'), 'Create room'))
  )
  const m = modal({ title: 'New watch party', body })

  async function go () {
    try {
      const res = await socket.request('room:create', {
        name: nameInput.value, username, clientKey: identity.clientKey,
        media: media ? { infoHash: media.infoHash, fileIndex: media.fileIndex } : null
      })
      recentRooms.save(res.room)
      m.close()
      shell.navigate(`/room/${res.room.id}`)
    } catch (e) { toast(e.message, 'danger') }
  }
}

export function roomsPage (params, shell) {
  const d = new Disposer()
  shell.setTopbar({ title: 'Watch Rooms', sub: 'Watch together' })

  const code = h('input.input.code', { placeholder: 'ROOM CODE', maxlength: 64, 'aria-label': 'Room code or link' })
  const join = (e) => {
    e.preventDefault()
    const v = code.value.trim()
    const id = (v.match(/room\/([A-Za-z0-9]{4,12})/) || [null, v])[1].toUpperCase()
    if (!/^[A-Z0-9]{4,12}$/.test(id)) return toast('Enter a room code like 7KQ2CX, or paste the invite link.', 'warn')
    shell.navigate(`/room/${id}`)
  }

  const recentList = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } })
  async function renderRecent () {
    const list = recentRooms.list()
    if (!list.length) {
      recentList.replaceChildren(h('div.empty', { style: { padding: '20px' } }, h('p', 'Rooms you create or join show up here.')))
      return
    }
    recentList.replaceChildren(...list.map((r) => {
      const status = h('span.tag', 'Checking…')
      api.room(r.id).then((info) => {
        status.className = 'tag ok'
        status.textContent = `${info.online} online`
      }).catch(() => { status.className = 'tag'; status.textContent = 'Expired' })
      return h('button.room-row', { onclick: () => shell.navigate(`/room/${r.id}`) },
        h('div.rr-icon', icon('rooms')),
        h('div', { style: { flex: 1, minWidth: 0 } }, h('b.truncate', { style: { display: 'block' } }, r.name), h('span.muted', { style: { fontSize: '0.82rem' } }, `${r.id} · ${timeAgo(r.at)}`)),
        status,
        icon('chevron')
      )
    }))
  }
  renderRecent()

  // Torrents on the server you can start a party with
  const quickStart = h('div.file-list')
  api.torrents().then((list) => {
    const vids = list.flatMap((t) => t.files.filter((f) => f.kind === 'video' && !f.sample).map((f) => ({ t, f }))).slice(0, 6)
    if (!vids.length) {
      quickStart.replaceChildren(h('p.muted', { style: { fontSize: '0.9rem' } }, 'Nothing loaded on the server yet. Create an empty room and pick a title inside, or add a torrent on the Home page.'))
      return
    }
    quickStart.replaceChildren(...vids.map(({ t, f }) => h('div.file-row.video',
      h('div.ficon', icon('film')),
      h('div', { style: { minWidth: 0 } }, h('div.fname', prettyTitle(f.name)), h('div.fmeta', h('span.shield', f.ext), h('span.num', `${t.stats.peers} peers`))),
      h('div.factions', h('button.btn.primary.sm', { onclick: () => startPartyFlow(shell, { infoHash: t.infoHash, fileIndex: f.index, title: prettyTitle(f.name) }) }, icon('rooms'), 'Start party'))
    )))
  }).catch(() => {})

  const el = h('div.page',
    h('section.hero', { style: { gridTemplateColumns: '1fr' } },
      h('div',
        h('div.eyebrow', { style: { color: 'var(--accent)' } }, 'Watch parties'),
        h('h1', { style: { marginTop: '10px' } }, 'Same movie. ', h('em', 'Same second.')),
        h('p.lede', 'Create a private room, send the link, ready up — when everyone\'s in, the host starts the show and every play, pause and skip stays in sync.')
      )
    ),
    h('div.rooms-grid',
      h('section.panel',
        h('div.panel-head', h('div', h('div.eyebrow', 'Host'), h('h2', 'Create a room'))),
        h('p.muted', { style: { marginBottom: '16px' } }, 'You\'ll get a shareable link. Pick what to watch now or once everyone has arrived.'),
        h('button.btn.primary.lg.block', { onclick: () => startPartyFlow(shell) }, icon('plus'), 'New watch party'),
        h('div', { style: { height: '18px' } }),
        h('div.eyebrow', { style: { marginBottom: '10px' } }, 'Quick start with'),
        quickStart
      ),
      h('section.panel',
        h('div.panel-head', h('div', h('div.eyebrow', 'Guest'), h('h2', 'Join a room'))),
        h('form.input-row', { onsubmit: join }, code, h('button.btn.primary', { type: 'submit' }, icon('door'), 'Join')),
        h('div', { style: { height: '22px' } }),
        h('div.eyebrow', { style: { marginBottom: '10px' } }, 'Recent rooms'),
        recentList
      )
    )
  )
  return { el, title: 'Watch Rooms', destroy: () => d.dispose() }
}
