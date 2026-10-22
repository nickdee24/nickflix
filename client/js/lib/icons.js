/**
 * Inline SVG icon set (24×24, 2px round strokes — same weight as Truck Dash).
 * These are static, trusted strings; user data never goes through here.
 */
const P = {
  logo: '<path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z" fill="currentColor" stroke="none"/><path d="M10.2 7.4v5.2l4.4-2.6z" fill="#0d0f12" stroke="#0d0f12" stroke-width="1.4"/>',
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  rooms: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
  library: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M7 4v14M17 4v14M3 9h4M3 13h4M17 9h4M17 13h4"/><path d="M8 21h8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor"/>',
  back10: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><text x="12" y="15.5" font-size="7.5" font-weight="800" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui">10</text>',
  fwd10: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/><text x="12" y="15.5" font-size="7.5" font-weight="800" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui">10</text>',
  volume: '<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.8 5.7a9 9 0 0 1 0 12.6"/>',
  volumeLow: '<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="m16 9 6 6M22 9l-6 6"/>',
  fullscreen: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>',
  exitFullscreen: '<path d="M9 4v4a1 1 0 0 1-1 1H4M20 9h-4a1 1 0 0 1-1-1V4M15 20v-4a1 1 0 0 1 1-1h4M4 15h4a1 1 0 0 1 1 1v4"/>',
  pip: '<rect x="2.5" y="4.5" width="19" height="15" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor"/>',
  cc: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M10.5 10.2a2.5 2.5 0 1 0 0 3.6M17 10.2a2.5 2.5 0 1 0 0 3.6"/>',
  speed: '<path d="M12 14l4-5"/><path d="M3.5 18a9 9 0 1 1 17 0"/><circle cx="12" cy="14" r="1.5" fill="currentColor"/>',
  quality: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M7 9v6M11 9v6M7 12h4M14 9h2a3 3 0 0 1 0 6h-2z"/>',
  theatre: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 6v12M18 6v12"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.4-4.6L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.4 4.6L20 16"/><path d="M20 20v-4h-4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.1.4l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.1-.4l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  magnet: '<path d="M6 15V9a6 6 0 0 1 12 0v6"/><path d="M6 15a6 6 0 0 0 12 0"/><path d="M6 11h4M14 11h4"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z" fill="currentColor" stroke-linejoin="round"/>',
  kick: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="m17 8 4 4M21 8l-4 4"/>',
  send: '<path d="M21 3 10 14"/><path d="M21 3 14.5 21l-4.5-7-7-4.5z"/>',
  film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 7.5h4M3 12h18M3 16.5h4M17 7.5h4M17 16.5h4"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  subtitle: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M6 13h4M12 13h6M6 16h8M16 16h2"/>',
  down: '<path d="M12 4v13M6 11l6 6 6-6"/><path d="M5 21h14"/>',
  up: '<path d="M12 20V7M6 13l6-6 6 6"/><path d="M5 3h14"/>',
  peers: '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="17" r="2.5"/><circle cx="19" cy="17" r="2.5"/><path d="M10.8 7.2 6.3 14.8M13.2 7.2l4.5 7.6M7.5 17h9"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V4h6v3"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  lock: '<rect x="4" y="10.5" width="16" height="10.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  unlock: '<rect x="4" y="10.5" width="16" height="10.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 7.7-1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  help: '<circle cx="12" cy="12" r="9.5"/><path d="M9.2 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4.5"/><path d="M12 17.5h.01"/>',
  info: '<circle cx="12" cy="12" r="9.5"/><path d="M12 11v6M12 7.5h.01"/>',
  alert: '<path d="M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4.5M12 17h.01"/>',
  checkCircle: '<circle cx="12" cy="12" r="9.5"/><path d="m8 12.5 3 3 5-6"/>',
  gauge: '<circle cx="12" cy="12" r="9.5"/><path d="m12 12 3.5-3.5"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/>',
  popcorn: '<path d="M5 9h14l-1.6 11.2a1 1 0 0 1-1 .8H7.6a1 1 0 0 1-1-.8z"/><path d="M9 9.5 10 21M15 9.5 14 21"/><path d="M6 9a2.5 2.5 0 0 1 2.4-3.6A3 3 0 0 1 14 4.5a2.5 2.5 0 0 1 4 4.5"/>',
  door: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h8"/><path d="M10 12h11M17 8l4 4-4 4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  sparkles: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>'
}

/** Returns an <svg> element. */
export function icon (name, cls = '') {
  const wrap = document.createElement('span')
  wrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="${cls}">${P[name] || P.info}</svg>`
  return wrap.firstChild
}
