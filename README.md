# NickFlix — Screen 1

A private cinema for you and your friends. Movies stream from **your own PC**, everyone watches in sync from one link, and each person gets the best quality their internet can handle, like Netflix.

- **One screen, one link.** No rooms or library pages: everyone opens the site and lands on Screen 1.
- **Drag and drop.** Drag a movie from your movie folder onto the screen (or pick it from the list under it) and it loads for everyone.
- **Adaptive quality.** Your PC encodes the movie into 4-second chunks at several qualities (from 360p up to 1080p, or 4K for 4K files). Each viewer's player measures their connection and switches quality on the fly. Switches happen on chunk boundaries in the video already buffered ahead, so the picture just gets sharper or softer and never pauses for it.
- **Anyone can play, pause and skip**, and it happens for everyone. The host can lock that to themselves.
- **Buffer bars for everyone.** The sidebar shows each viewer's buffer, quality, measured connection speed and how many milliseconds they are from the room clock (e.g. `±38ms`).
- **Waits for everyone.** If someone runs out of buffer, the screen pauses until everyone has a few seconds banked, then carries on together.
- **The cinema.** Screen 1 sits at the far end of an auditorium with lights along the walls. When you press play, the lights go down, the screen comes forward to fill the view, you're offered fullscreen, and then the movie starts. Pause it and the screen moves back and the lights come up.
- Chat, reactions, subtitles (picked up from the file or a `.srt` next to it, or drop one onto the player), picture-in-picture and keyboard shortcuts (press `?`).

## How it fits together

```
 Your PC (NickFlix Host)                         nickflix.onrender.com
 ┌──────────────────────────────┐   socket    ┌──────────────────────────┐
 │ D:\Watch Together - Movies   │◀───────────▶│ Screen 1: sync clock,    │
 │ ffmpeg + RTX GPU → HLS chunks│  (control)  │ chat, buffer reports      │
 │ local video server :8787     │             └────────────▲─────────────┘
 └──────────────┬───────────────┘                          │ page + sync
                │ Cloudflare tunnel (https, no port forwarding)
                ▼                                          │
          viewers' browsers  ◀─────────────────────────────┘
          (video comes straight from your PC)
```

The website on Render never touches the video. It runs the room: who's here, the shared play/pause clock, chat. Your PC serves the video directly to viewers through a free Cloudflare tunnel, which gives it a secure https address without opening any ports on your router.

Encoding is per quality, not per viewer: three friends watching at 1080p cost one encode. Segments are made on demand, so a skip just starts a new encode at that point, and the PC stops encoding a few minutes ahead of the furthest viewer (pausing costs nothing).

## Setup

### 1. Start the host app on your PC

You need [Node.js](https://nodejs.org) and ffmpeg. `start-host.bat` installs both with `winget` if they're missing.

1. Get the code onto the PC (download the repo ZIP from GitHub, or `git clone`).
2. Double-click **`host\start-host.bat`**.
3. On first run it creates `host\config.json` and prints a **host secret**. Copy it.

Movies are read from `D:\Watch Together - Movies` (including subfolders). To use another folder, change `mediaDirs` in `host\config.json`.

The app picks the fastest encoder it finds (NVIDIA NVENC, then Intel Quick Sync, then AMD, then CPU) and prints which one it chose.

### 2. Tell the website about your PC

In Render, open the **nickflix** service, go to **Environment**, add `HOST_SECRET` with the secret from step 1, and save (Render redeploys). The host app connects automatically and logs `Screen 1 is ready`.

### 3. Unlock host controls in your browser

On the site, open **Settings → Host key** and paste the same secret. That browser can now put movies on, change or clear what's showing, toggle *waits for everyone* / *anyone controls*, and remove people. Everyone else just needs the link.

### 4. Watch

Open Screen 1, drag a movie from your movie folder onto the screen, and share the link. Browsers don't reveal where a dragged file lives, so the host app finds it in your folder by name and size. Files have to be in the movie folder.

### Letting a friend host instead

Send them **`host/NickFlix Host Setup.bat`** (just that one file). When they double-click it, it installs Node.js and ffmpeg, downloads NickFlix Host into `%USERPROFILE%\NickFlix Host`, asks for the host secret and opens a folder picker for their movies, adds a **NickFlix Host** shortcut to the desktop, and starts it. Running it again later updates the app and keeps their settings. Only one host can be connected at a time; the newest one takes over.

## Host app settings (`host/config.json`)

| key | default | |
|---|---|---|
| `siteUrl` | `https://nickflix.onrender.com` | the website to connect to |
| `secret` | random | must match `HOST_SECRET` on Render |
| `mediaDirs` | `["D:\\Watch Together - Movies"]` | folders to scan |
| `port` | `8787` | local video server |
| `publicUrl` | empty | leave empty for an automatic Cloudflare quick tunnel; set it if you run your own named tunnel or reverse proxy |
| `encoder` | `auto` | or `h264_nvenc` / `h264_qsv` / `h264_amf` / `libx264` |
| `hwDecode` | `true` | decode on the GPU too (NVIDIA) |
| `maxJobs` | `0` (auto) | max simultaneous encodes (6 on NVIDIA) |
| `cacheDir` | temp folder | where encoded chunks are kept |
| `cacheLimitGB` | `40` | oldest movies are cleared past this |

HDR movies are tone-mapped to SDR so they don't look washed out in browsers.

## Website settings (Render environment)

| var | default | |
|---|---|---|
| `HOST_SECRET` | — | required; shared with the host app |
| `SCREEN_NAME` | `Screen 1` | |
| `MAX_MEMBERS` | 24 | |
| `STALL_TRIGGER_MS` | 1200 | someone stalled this long → pause for them |
| `RESUME_BUFFER_SECONDS` | 6 | everyone needs this much buffered to carry on |
| `HOLD_TIMEOUT_MS` | 45000 | stop waiting for someone after this long |

## How sync works

The server owns a playback clock: `{ playing, position, rate, updatedAt }`. Clients estimate the server's time with an NTP-style ping and compute where the movie should be right now:

```
expected = position + (serverNow - updatedAt) × rate
```

Every second each viewer compares that with their own position. Under 150 ms they're in sync. Between 150 ms and the threshold (1.5 s by default) the player speeds up or slows down by 5% to glide back without a visible jump. Beyond that it seeks. The measured offset is what shows next to each person's buffer bar.

Starts are scheduled slightly in the future (`updatedAt` ahead of now) so everyone begins on the same frame. That window is also what the cinema intro plays in.

## Running locally

```bash
npm install
HOST_SECRET=dev-secret npm start                 # website on http://localhost:3000

# in another terminal (on the PC with the movies):
cd host && npm install
NICKFLIX_SITE=http://localhost:3000 NICKFLIX_SECRET=dev-secret npm start
```

For a purely local test without a tunnel, also set `NICKFLIX_PUBLIC_URL=http://localhost:8787`.

## Project structure

```
nickflix/
├── server/                    website (Render)
│   ├── index.js               Express + Socket.IO, security headers, SPA fallback
│   ├── host-link.js           /host namespace: the connection to your PC
│   ├── screen/screen.js       Screen 1 state, playback clock, wait-for-everyone
│   ├── screen/sockets.js      viewer events: join, play/pause/seek, reports, chat
│   └── routes/api.js          /api/health, /api/screen
├── host/                      NickFlix Host (your PC)
│   ├── start-host.bat         double-click to run on Windows
│   └── src/
│       ├── index.js           startup, link to the website
│       ├── library.js         movie folder index, drop matching, sidecar subtitles
│       ├── media.js           ffprobe, encoder detection, quality ladder, ffmpeg args
│       ├── stream.js          on-demand HLS segments, subtitles, thumbnails, cache
│       ├── server.js          local video server
│       └── tunnel.js          Cloudflare quick tunnel
└── client/                    the site
    ├── css/cinema.css         the auditorium, lights and zoom
    └── js/
        ├── pages/screen.js    Screen 1
        ├── player/engine.js   hls.js adaptive playback (native HLS on iPhone)
        ├── player/player-view.js  player UI
        └── services/sync.js   keeps the player locked to the room clock
```

MIT licensed. Only stream content you have the right to watch.
