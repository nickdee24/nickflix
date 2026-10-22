/** Settings — profile, playback, watch-party sync and interface preferences. */
import { h } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { identity, settings, history } from '../state/store.js'
import { api } from '../services/api.js'
import { avatar } from '../components/avatar.js'
import { toast } from '../components/toast.js'

export function settingsPage (params, shell) {
  shell.setTopbar({ title: 'Settings' })

  // ---- profile
  const preview = h('div', avatar({ name: identity.username || '?', size: 'lg' }))
  const nameInput = h('input.input', {
    value: identity.username, maxlength: 24, placeholder: 'Your display name', 'aria-label': 'Display name',
    oninput: () => preview.replaceChildren(avatar({ name: nameInput.value.trim() || '?', size: 'lg' }))
  })
  const saveName = (e) => {
    e.preventDefault()
    const v = nameInput.value.trim()
    if (!v) return toast('Name can\'t be empty', 'warn')
    identity.username = v
    toast('Name saved — it\'ll be used next time you join a room', 'success')
  }

  // ---- generic controls
  const toggle = (key, title, desc) => h('label.setting',
    h('div.s-text', h('b', title), h('span', desc)),
    h('span.switch', h('input', { type: 'checkbox', checked: !!settings.get(key), onchange: (e) => settings.set(key, e.target.checked) }), h('span'))
  )
  const select = (key, title, desc, options, cast = (x) => x) => h('div.setting',
    h('div.s-text', h('b', title), h('span', desc)),
    h('select.select.input', { onchange: (e) => settings.set(key, cast(e.target.value)), 'aria-label': title },
      options.map(([v, l]) => h('option', { value: v, selected: String(settings.get(key)) === String(v) }, l)))
  )

  const ffmpegState = h('span.tag', 'Checking…')
  api.capabilities().then((c) => {
    ffmpegState.className = `tag ${c.ffmpeg ? 'ok' : 'warn'}`
    ffmpegState.textContent = c.ffmpeg ? 'ffmpeg available' : 'No ffmpeg — direct play only'
  })

  const el = h('div.page',
    h('div.settings-grid',
      h('section.panel',
        h('div.panel-head', h('div', h('div.eyebrow', 'Profile'), h('h2', 'You'))),
        h('form', { onsubmit: saveName },
          h('div.profile-card', preview, h('div.field', { style: { flex: 1 } }, h('label', 'Display name'), h('div.input-row', nameInput, h('button.btn.primary', { type: 'submit' }, 'Save')))),
        ),
        h('p.muted', { style: { fontSize: '0.84rem', marginTop: '12px' } }, 'Your avatar is generated from your initials. Your identity is a random key stored only in this browser.')
      ),
      h('section.panel',
        h('div.panel-head', h('div', h('div.eyebrow', 'Playback'), h('h2', 'Player')), h('div.right', ffmpegState)),
        select('preferredQuality', 'Default quality', 'Original is direct play; lower qualities are transcoded on the server.',
          [['auto', 'Auto (original)'], ['1080', '1080p'], ['720', '720p'], ['480', '480p']]),
        select('subtitleSize', 'Subtitle size', 'How big captions appear on screen.', [[1.2, 'Small'], [1.6, 'Medium'], [2.1, 'Large'], [2.7, 'Huge']], Number),
        toggle('autoCompat', 'Automatic compatibility mode', 'If your browser can\'t decode a file, convert it on the server automatically.'),
        toggle('autoplaySolo', 'Autoplay', 'Start playing as soon as a video opens.')
      ),
      h('section.panel',
        h('div.panel-head', h('div', h('div.eyebrow', 'Watch parties'), h('h2', 'Sync'))),
        select('syncTolerance', 'Re-sync threshold', 'Small drifts are smoothed by speeding up or slowing down slightly. Beyond this, NickFlix jumps straight to the right spot.',
          [[0.75, '0.75 s (tight)'], [1.5, '1.5 s (balanced)'], [3, '3 s (relaxed, slow connections)']], Number),
        toggle('showDrift', 'Show sync accuracy', 'Display the measured drift (e.g. ±40ms) in the player.')
      ),
      h('section.panel',
        h('div.panel-head', h('div', h('div.eyebrow', 'Interface'), h('h2', 'Display'))),
        select('speedUnits', 'Speed units', 'How download and upload speeds are shown.', [['bytes', 'MB/s'], ['bits', 'Mbit/s']]),
        toggle('reduceMotion', 'Reduce motion', 'Turn off animations and transitions.'),
        h('div.setting',
          h('div.s-text', h('b', 'Clear watch history'), h('span', 'Removes "Continue watching" from this device.')),
          h('button.btn.danger.sm', { onclick: () => { history.clear(); toast('History cleared', 'success') } }, icon('trash'), 'Clear')
        ),
        h('div.setting',
          h('div.s-text', h('b', 'Reset settings'), h('span', 'Put every preference back to its default.')),
          h('button.btn.sm', { onclick: () => { settings.reset(); toast('Settings reset', 'success'); shell.navigate('/settings', { replace: true }); location.reload() } }, 'Reset')
        )
      )
    )
  )
  return { el, title: 'Settings' }
}
