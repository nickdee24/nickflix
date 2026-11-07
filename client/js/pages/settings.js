/** Settings — your name, the host key, playback and sync preferences. */
import { h } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { identity, settings } from '../state/store.js'
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
    toast('Name saved. Everyone sees it next time you open Screen 1.', 'success')
  }

  // ---- host key
  const keyInput = h('input.input', {
    type: 'password', value: identity.hostKey, placeholder: 'Paste the host secret', autocomplete: 'off', 'aria-label': 'Host key'
  })
  const saveKey = (e) => {
    e.preventDefault()
    identity.hostKey = keyInput.value
    toast(keyInput.value ? 'Host key saved. Open Screen 1 to put movies on.' : 'Host key removed', 'success')
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

  const el = h('div.page',
    h('div.settings-grid',
      h('section.panel',
        h('div.panel-head', h('div', h('div.eyebrow', 'Profile'), h('h2', 'You'))),
        h('form', { onsubmit: saveName },
          h('div.profile-card', preview, h('div.field', { style: { flex: 1 } }, h('label', 'Display name'), h('div.input-row', nameInput, h('button.btn.primary', { type: 'submit' }, 'Save'))))
        ),
        h('p.muted', { style: { fontSize: '0.84rem', marginTop: '12px' } }, 'Your avatar is made from your initials. Your identity is a random key stored only in this browser.')
      ),
      h('section.panel',
        h('div.panel-head', h('div', h('div.eyebrow', 'For the host'), h('h2', 'Host key'))),
        h('form', { onsubmit: saveKey },
          h('div.field', h('label', 'Host secret'), h('div.input-row', keyInput, h('button.btn.primary', { type: 'submit' }, 'Save')))
        ),
        h('p.muted', { style: { fontSize: '0.84rem', marginTop: '12px' } },
          'Only needed on the host\'s own browser. NickFlix Host prints this secret when it starts on your PC. With it saved here you can drop movies on Screen 1, change or clear what\'s showing, and remove people. Everyone else just needs the share link.')
      ),
      h('section.panel',
        h('div.panel-head', h('div', h('div.eyebrow', 'Playback'), h('h2', 'Player'))),
        select('maxQuality', 'Maximum quality', 'Auto picks the best quality your connection can handle without buffering. Set a cap to save data.',
          [[0, 'No limit (Auto)'], [1080, 'Up to 1080p'], [720, 'Up to 720p'], [480, 'Up to 480p'], [360, 'Up to 360p']], Number),
        select('subtitleSize', 'Subtitle size', 'How big captions appear on screen.', [[1.2, 'Small'], [1.6, 'Medium'], [2.1, 'Large'], [2.7, 'Huge']], Number)
      ),
      h('section.panel',
        h('div.panel-head', h('div', h('div.eyebrow', 'Watching together'), h('h2', 'Sync'))),
        select('syncTolerance', 'Re-sync threshold', 'Small drifts are smoothed out by speeding up or slowing down very slightly. Past this, NickFlix jumps straight to the right moment.',
          [[0.75, '0.75 s (tight)'], [1.5, '1.5 s (balanced)'], [3, '3 s (relaxed, slow connections)']], Number),
        toggle('showDrift', 'Show sync accuracy', 'Show how many milliseconds you are from everyone else (e.g. ±40ms) in the player.')
      ),
      h('section.panel',
        h('div.panel-head', h('div', h('div.eyebrow', 'Interface'), h('h2', 'Display'))),
        toggle('reduceMotion', 'Reduce motion', 'Turn off animations and transitions.'),
        h('div.setting',
          h('div.s-text', h('b', 'Reset settings'), h('span', 'Put every preference back to its default (keeps your name and host key).')),
          h('button.btn.sm', { onclick: () => { settings.reset(); toast('Settings reset', 'success'); location.reload() } }, icon('sync'), 'Reset')
        )
      )
    )
  )
  return { el, title: 'Settings' }
}
