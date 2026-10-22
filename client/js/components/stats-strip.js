/**
 * Live torrent stats, Truck Dash style:
 *   - a "gauge" panel: peers in a speed-limit sign, big download number
 *   - the ETA strip: progress bar on top, bold value + muted label pairs
 */
import { h } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { speed, eta, bytes, pct } from '../lib/format.js'

export function statsStrip () {
  const bar = h('i')
  const val = {}
  const stat = (key, label) => h('div.stat', (val[key] = h('b', '—')), h('span', label))
  const el = h('div.stat-strip',
    h('div.bar', h('div.progress', bar)),
    stat('down', 'Down'),
    stat('up', 'Up'),
    stat('done', 'Downloaded'),
    stat('eta', 'Remaining')
  )
  return {
    el,
    update (s) {
      if (!s) return
      const d = speed(s.downloadSpeed)
      const u = speed(s.uploadSpeed)
      const p = s.fileProgress ?? s.progress
      val.down.textContent = `${d.value} ${d.unit}`
      val.up.textContent = `${u.value} ${u.unit}`
      val.done.textContent = pct(p)
      val.eta.textContent = p >= 1 ? 'Done' : eta(s.timeRemaining)
      bar.style.width = `${(p || 0) * 100}%`
    }
  }
}

export function gaugePanel () {
  const sign = h('div.sign', '0')
  const big = h('div.big-num', '0.0')
  const unit = h('div.big-unit', 'MB/s')
  const up = h('div.big-num.md.ok', '0')
  const upUnit = h('div.big-unit', 'KB/s up')
  const right = h('div.right-col', 'Waiting for data…')
  const el = h('div.panel.gauge-panel',
    h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' } }, sign, h('span.eyebrow', 'Peers')),
    h('div.speed', big, unit),
    h('div.side', h('span.ring', icon('up')), h('div', up, upUnit)),
    right
  )
  return {
    el,
    update (s) {
      if (!s) return
      sign.textContent = String(s.peers)
      const d = speed(s.downloadSpeed)
      big.textContent = d.value
      unit.textContent = `${d.unit} down`
      const u = speed(s.uploadSpeed)
      up.textContent = u.value
      upUnit.textContent = `${u.unit} up`
      right.replaceChildren(
        h('div', `File ${pct(s.fileProgress)}`),
        h('div', `${bytes(s.downloaded)} fetched`),
        h('div', `Ratio ${s.ratio?.toFixed?.(2) ?? '0.00'}`)
      )
    }
  }
}
