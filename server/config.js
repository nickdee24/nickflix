/**
 * Central configuration. Every value can be overridden with an environment
 * variable so the same build runs locally, on a LAN box or on Render.
 */
import os from 'node:os'
import path from 'node:path'

const int = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d)

export const config = {
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  isProd: process.env.NODE_ENV === 'production',

  /** Where torrent data is written while streaming. */
  downloadDir: process.env.DOWNLOAD_DIR || path.join(os.tmpdir(), 'nickflix'),

  /** Max simultaneous torrents kept alive on the server. Oldest idle ones are dropped first. */
  maxTorrents: int(process.env.MAX_TORRENTS, 6),

  /** Torrents not streamed and not used by any room for this long are removed (and their data deleted). */
  torrentIdleMinutes: int(process.env.TORRENT_IDLE_MINUTES, 90),

  /** How long to wait for magnet metadata before giving up. */
  metadataTimeoutMs: int(process.env.METADATA_TIMEOUT_MS, 90_000),

  /** Max .torrent upload size. */
  maxTorrentFileBytes: 5 * 1024 * 1024,

  /** ffmpeg compatibility mode (remux / transcode for MKV, AVI, etc). */
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  maxTranscodes: int(process.env.MAX_TRANSCODES, 2),
  transcodePreset: process.env.TRANSCODE_PRESET || 'veryfast',

  /** Watch rooms */
  roomEmptyTtlMinutes: int(process.env.ROOM_EMPTY_TTL_MINUTES, 30),
  memberGraceMs: int(process.env.MEMBER_GRACE_MS, 30_000),
  maxRoomMembers: int(process.env.MAX_ROOM_MEMBERS, 24),
  chatHistory: 120
}
