/**
 * Torrent summary + file list. Video files get Watch / Watch party actions;
 * everything else is tucked into a collapsible "other files" list.
 */
import { h } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { bytes, pct, resolutionTag } from '../lib/format.js'

export function playableTag (f) {
  if (f.playable === 'direct') return h('span.tag.ok', 'Direct play')
  if (f.playable === 'maybe') return h('span.tag.info', 'Likely plays')
  return h('span.tag.warn', 'Needs convert')
}

export function fileBadges (name, ext) {
  const res = resolutionTag(name)
  return [h('span.shield', ext), res ? h('span.shield.green', res) : null]
}

export function torrentCard (t, { onWatch, onParty, partyLabel = 'Watch party' } = {}) {
  const videos = t.files.filter((f) => f.kind === 'video').sort((a, b) => (b.index === t.mainFileIndex) - (a.index === t.mainFileIndex) || b.length - a.length)
  const subs = t.files.filter((f) => f.kind === 'subtitle')
  const other = t.files.filter((f) => f.kind === 'other')

  const videoRow = (f) => h(`div.file-row.video${f.index === t.mainFileIndex ? '.main' : ''}`,
    h('div.ficon', icon('film')),
    h('div', { style: { minWidth: 0 } },
      h('div.fname', { title: f.path }, f.name),
      h('div.fmeta', fileBadges(f.name, f.ext), h('span.num', bytes(f.length)), playableTag(f), f.sample ? h('span.tag', 'Sample') : null,
        f.progress > 0 ? h('span.num', `${pct(f.progress)} downloaded`) : null)
    ),
    h('div.factions',
      onParty ? h('button.btn', { onclick: () => onParty(f) }, icon('rooms'), partyLabel) : null,
      onWatch ? h('button.btn.primary', { onclick: () => onWatch(f) }, icon('play'), 'Watch') : null
    )
  )

  const smallRow = (f) => h('div.file-row.other',
    h('div.ficon', icon(f.kind === 'subtitle' ? 'subtitle' : 'file')),
    h('div', { style: { minWidth: 0 } }, h('div.fname', { title: f.path }, f.name)),
    h('div.fmeta.num', bytes(f.length))
  )

  return h('section.panel',
    h('div.torrent-head',
      h('div', { style: { minWidth: 0, flex: 1 } },
        h('div.eyebrow', 'Torrent'),
        h('h2', t.name),
      ),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('span.chip.sm', h('span.dot.info'), `${t.files.length} file${t.files.length === 1 ? '' : 's'}`),
        h('span.chip.sm', h('span.num', bytes(t.length))),
        h(`span.chip.sm${t.stats?.peers ? '.live' : '.warn'}`, h('span.dot'), h('span.num', `${t.stats?.peers ?? 0} peers`))
      )
    ),
    h('div', { style: { height: '14px' } }),
    videos.length
      ? h('div.file-list', videos.map(videoRow))
      : h('div.empty', h('div.empty-icon', icon('film')), h('h3', 'No video files'), h('p', 'This torrent doesn\'t contain anything NickFlix can play.')),
    subs.length || other.length
      ? h('details.collapsed-files', { style: { marginTop: '12px' } },
        h('summary', icon('chevron'), `${subs.length ? `${subs.length} subtitle file${subs.length === 1 ? '' : 's'}` : ''}${subs.length && other.length ? ' · ' : ''}${other.length ? `${other.length} other file${other.length === 1 ? '' : 's'}` : ''}`),
        h('div.file-list', [...subs, ...other].map(smallRow))
      )
      : null
  )
}
