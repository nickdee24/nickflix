/**
 * Dropzone for adding a torrent: drag a .torrent, browse for one, or paste a
 * magnet link. Calls onLoaded(summary) once the server has the file list.
 */
import { h } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { api } from '../services/api.js'
import { toast } from './toast.js'

const MAGNET_RE = /^magnet:\?/i
const HASH_RE = /^[a-f0-9]{40}$/i

export function addTorrent ({ onLoaded, compact = false } = {}) {
  const file = h('input', { type: 'file', accept: '.torrent,application/x-bittorrent', hidden: true, onchange: (e) => e.target.files[0] && submitFile(e.target.files[0]) })
  const magnet = h('input.input', {
    placeholder: 'Paste a magnet link…',
    'aria-label': 'Magnet link',
    autocomplete: 'off',
    spellcheck: false,
    onpaste: () => setTimeout(() => { if (MAGNET_RE.test(magnet.value.trim())) submitMagnet() }, 0)
  })
  const loadBtn = h('button.btn.primary', { type: 'submit' }, icon('magnet'), 'Load')
  const status = h('div.loading-row', { hidden: true })

  const form = h('form.input-row', { onsubmit: (e) => { e.preventDefault(); submitMagnet() } }, magnet, loadBtn)

  const zone = h('div.dropzone',
    h('div.dz-head',
      h('div.dz-icon', icon('upload')),
      h('div', h('b', compact ? 'Add something to watch' : 'Drop a .torrent file here'),
        h('span', 'or ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); file.click() } }, 'browse your files'), ' — streaming starts in seconds'))
    ),
    h('div.or', 'OR'),
    form,
    status,
    file
  )

  // Drag & drop (also accepts a dropped magnet link as text)
  const over = (on) => (e) => { e.preventDefault(); zone.classList.toggle('over', on) }
  zone.addEventListener('dragenter', over(true))
  zone.addEventListener('dragover', over(true))
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('over') })
  zone.addEventListener('drop', (e) => {
    e.preventDefault()
    zone.classList.remove('over')
    const f = [...(e.dataTransfer.files || [])].find((x) => x.name.endsWith('.torrent'))
    if (f) return submitFile(f)
    const text = e.dataTransfer.getData('text')
    if (MAGNET_RE.test(text)) { magnet.value = text; submitMagnet() } else toast('Drop a .torrent file or a magnet link.', 'warn')
  })

  function busy (on, label = '') {
    loadBtn.disabled = on
    magnet.disabled = on
    status.hidden = !on
    status.replaceChildren(h('div.spinner.sm'), h('span', label))
  }

  async function run (promise, label) {
    busy(true, label)
    const slow = setTimeout(() => status.lastChild && (status.lastChild.textContent = 'Still searching for peers… magnet links can take up to a minute.'), 8000)
    try {
      const summary = await promise
      magnet.value = ''
      toast(`Loaded "${summary.name}"`, 'success')
      onLoaded?.(summary)
    } catch (e) {
      toast(e.message, 'danger', 6000)
    } finally {
      clearTimeout(slow)
      busy(false)
    }
  }

  function submitMagnet () {
    let v = magnet.value.trim()
    if (!v) return magnet.focus()
    if (HASH_RE.test(v)) v = `magnet:?xt=urn:btih:${v}`
    if (!MAGNET_RE.test(v)) return toast('That isn\'t a magnet link — it should start with "magnet:?"', 'warn')
    run(api.addMagnet(v), 'Fetching file list from peers…')
  }

  function submitFile (f) {
    if (f.size > 5 * 1024 * 1024) return toast('That .torrent file is too large.', 'danger')
    run(api.addTorrentFile(f), `Reading ${f.name}…`)
    file.value = ''
  }

  return zone
}
