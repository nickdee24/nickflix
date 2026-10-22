# NickFlix

Stream any torrent in the browser and watch it together in synced watch parties.
The UI borrows the **Truck Dash** look: a near-black canvas, flat charcoal panels, one electric-blue accent (`#3B9EFF`), pill status chips, round floating buttons and chunky tabular numbers.

## Features

**Streaming**
- Add a `.torrent` (drag & drop or browse) or paste a magnet link
- Video files are detected automatically; the main feature is highlighted and samples are flagged
- Playback starts as soon as the first pieces arrive (HTTP byte-range streaming with piece prioritisation)
- Live stats: download/upload speed, peers, progress, time remaining
- MP4 / WebM / MOV play directly. MKV, AVI, WMV, HEVC and other formats switch automatically to **compatibility mode**, where ffmpeg remuxes or transcodes them on the fly
- Quality selection (Original / 1080p / 720p / 480p via transcode)

**Player** (Video.js engine with fully custom controls)
- Play/pause, ±10s, volume, fullscreen, picture-in-picture, theatre mode, playback speed
- Subtitles: picked up automatically from the torrent (`.srt`, `.vtt`, `.ass`), or loaded from your device; four sizes
- Preview thumbnails on the seek bar
- Keyboard shortcuts: press `?` in the app for the list

**Watch parties**
- Private rooms with short codes and shareable `/room/CODE` links
- Choose a username before joining; avatars are generated from initials
- Ready-up: the host can only start once everyone present is ready, followed by a synchronised 3-2-1 countdown
- Host controls: lock or unlock playback controls, change the title, hand over host 👑, remove someone
- Synced play, pause, seek and speed, with continuous drift correction (see below)
- Live participant list with presence ("Now watching · 12:31", buffering, paused, away)
- Live chat with typing indicators, plus 👍 ❤️ 😂 😮 reactions that float over the video
- Refreshing the page or a brief disconnect doesn't kick you, and the host keeps their role

## How sync works

The server owns a playback clock for each room: `{ playing, position, rate, updatedAt }`.
Clients estimate the server's time with an NTP-style ping and compute where the room should be right now:

```
expected = position + (serverNow - updatedAt) × rate
```

Every second each viewer compares the expected position with their own:

| drift | action |
|---|---|
| < 150 ms | in sync |
| 150 ms – threshold | speed up or slow down by 5% to glide back, without a visible jump |
| > threshold (default 1.5 s) | hard seek |

The host is the reference. If the host buffers, the server re-anchors the clock to the host so everyone else waits for them too.

## Project structure

```
nickflix/
├── server/
│   ├── index.js                 Express + Socket.IO bootstrap, security headers, SPA fallback
│   ├── config.js                env-driven settings
│   ├── routes/api.js            REST: torrents, range streaming, probe/transcode/thumbs, rooms
│   ├── sockets/index.js         room events, ready-up, playback intents, chat, reactions, stats
│   ├── rooms/room-manager.js    room state + authoritative playback clock
│   ├── services/
│   │   ├── torrent-engine.js    WebTorrent client (deselect-by-default, LRU + idle sweep)
│   │   └── media-service.js     ffmpeg compatibility mode, ffprobe, thumbnails
│   └── utils/                   media type detection, rate limiting
├── client/
│   ├── index.html
│   ├── public/                  favicon, manifest
│   ├── css/                     tokens · base · layout · components · player · pages
│   └── js/
│       ├── main.js              app shell + router
│       ├── components/          avatar, modal, toast, dropzone, torrent card, stats strip, media card…
│       ├── services/            api, socket (clock sync), sync engine, subtitles, thumbnails
│       ├── player/              engine (direct/compat timeline), player view, shortcuts
│       ├── pages/               home, watch, rooms, room, library, settings
│       ├── state/store.js       identity, settings, history (localStorage)
│       └── lib/                 dom helpers, icons, formatting
├── Dockerfile                   Node 22 + ffmpeg
└── render.yaml                  one-click Render blueprint
```

## Running locally

Requires **Node 22+**. Install **ffmpeg** too if you want compatibility mode.

```bash
npm install
npm start          # http://localhost:3000
```

On Windows, ffmpeg is available with `winget install ffmpeg`.

### Environment variables

| var | default | |
|---|---|---|
| `PORT` | 3000 | |
| `DOWNLOAD_DIR` | OS temp `/nickflix` | where torrent data is cached |
| `MAX_TORRENTS` | 6 | least recently used, unpinned torrents are dropped beyond this |
| `TORRENT_IDLE_MINUTES` | 90 | idle torrents are removed and their data deleted |
| `MAX_TRANSCODES` | 2 | concurrent ffmpeg conversions |
| `TRANSCODE_PRESET` | veryfast | x264 preset |
| `NAT_TRAVERSAL` | off | set to `1` at home to enable UPnP/NAT-PMP |
| `TORRENT_PORT` | random | fixed incoming peer port |

## Deploying to Render

The repo includes `render.yaml`. In Render, choose **New → Blueprint**, pick this repo and deploy. The Docker image bundles ffmpeg.
The free plan sleeps after 15 minutes of inactivity and has very little CPU, so direct play and remuxing work well but full transcodes are slow. A paid instance, or running it on your own PC, gives much better conversion speed.

## Notes

- Why stream on the server? Browser-only WebTorrent can only reach WebRTC peers, and most torrents only have classic TCP/uTP peers. Running WebTorrent in Node reaches all of them, and everyone in a party shares one swarm connection.
- Rooms are kept in memory. To run several instances, swap `RoomManager` for a Redis-backed store and add `@socket.io/redis-adapter`.
- Only stream content you have the right to watch.

MIT licensed.
