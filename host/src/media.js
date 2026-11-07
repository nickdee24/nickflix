/**
 * ffmpeg / ffprobe helpers: probing files, picking the fastest H.264 encoder
 * on this PC, building the quality ladder and the encode arguments.
 */
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

export const SEGMENT_SECONDS = 4

/**
 * Quality ladder. Each viewer's player measures their connection and moves
 * between these on the fly, so a slow connection gets 480p instead of
 * buffering, and a fast one gets the best picture.
 */
const LADDER = [
  { name: '2160p', height: 2160, vbr: 16000, abr: 256 },
  { name: '1440p', height: 1440, vbr: 10000, abr: 256 },
  { name: '1080p', height: 1080, vbr: 6500, abr: 256 },
  { name: '720p', height: 720, vbr: 3200, abr: 192 },
  { name: '480p', height: 480, vbr: 1400, abr: 160 },
  { name: '360p', height: 360, vbr: 750, abr: 128 }
]

export function hasBinary (bin) {
  try { return spawnSync(bin, ['-version'], { stdio: 'ignore', windowsHide: true }).status === 0 } catch { return false }
}

/** Try each hardware encoder with a tiny test encode; first that works wins. */
export function detectEncoder (ffmpeg, forced = 'auto') {
  const candidates = forced && forced !== 'auto' ? [forced] : ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264']
  for (const enc of candidates) {
    const r = spawnSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=1280x720:d=0.2',
      '-c:v', enc, '-f', 'null', '-'
    ], { stdio: 'ignore', windowsHide: true, timeout: 20_000 })
    if (r.status === 0) return enc
  }
  return 'libx264'
}

export function hasFilter (ffmpeg, name) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8', windowsHide: true })
  return new RegExp(`\\s${name}\\s`).test(r.stdout || '')
}

export function probe (ffprobe, file) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => p.kill('SIGKILL'), 60_000)
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', reject)
    p.on('close', () => {
      clearTimeout(timer)
      try {
        const j = JSON.parse(out)
        const v = j.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1)
        const audio = j.streams.filter((s) => s.codec_type === 'audio')
        const subs = j.streams.filter((s) => s.codec_type === 'subtitle')
        const duration = Number(j.format?.duration) || Number(v?.duration) || 0
        if (!duration) throw new Error('no duration')
        resolve({
          duration,
          video: v ? {
            codec: v.codec_name,
            width: v.width,
            height: v.height,
            hdr: ['smpte2084', 'arib-std-b67'].includes(v.color_transfer),
            fps: fps(v.avg_frame_rate || v.r_frame_rate)
          } : null,
          audio: audio.map((a, i) => ({ index: i, codec: a.codec_name, channels: a.channels, lang: a.tags?.language || null, title: a.tags?.title || null, isDefault: a.disposition?.default === 1 })),
          subs: subs.map((s, i) => ({ index: i, codec: s.codec_name, lang: s.tags?.language || null, title: s.tags?.title || null, forced: s.disposition?.forced === 1 }))
        })
      } catch {
        reject(new Error(`ffprobe couldn't read this file${err ? `: ${err.trim().split('\n').pop()}` : ''}`))
      }
    })
  })
}

function fps (r) {
  const [a, b] = String(r || '').split('/').map(Number)
  return a && b ? a / b : a || 24
}

/** Ladder rungs that make sense for this source (never upscale). */
export function ladderFor (info) {
  const srcH = info.video?.height || 1080
  // Treat 1916×800-style scope films by width too: a 1920-wide file is "1080p".
  const effH = Math.max(srcH, Math.round((info.video?.width || 0) * 9 / 16))
  const rungs = LADDER.filter((r) => r.height <= effH + 8)
  const srcW = info.video?.width || Math.round(srcH * 16 / 9)
  // Fit each rung inside its 16:9 box, so a 1920×800 film's "720p" is 1280×534.
  return (rungs.length ? rungs : [LADDER[LADDER.length - 1]]).map((r) => {
    const k = Math.min(1, (r.height * 16 / 9) / srcW, r.height / srcH)
    return { ...r, outHeight: Math.max(2, Math.round((srcH * k) / 2) * 2) }
  })
}

/** Best audio track: default flag → English → first. */
export function pickAudio (info) {
  if (!info.audio.length) return null
  return info.audio.find((a) => a.isDefault) || info.audio.find((a) => /^en/i.test(a.lang || '')) || info.audio[0]
}

/**
 * Audio filter chain for browsers: always stereo, and loud enough.
 *
 * Any surround layout (5.1, 7.1, …) is folded to stereo with the centre
 * channel at full level. ffmpeg's default downmix drops the centre (where
 * almost all dialogue lives) to ~70% and averages everything, so films come
 * out thin and very quiet. Mono is copied to both sides.
 *
 * With `normalize`, a gentle compressor lifts quiet speech and tames
 * explosions (about +7 dB overall), then a limiter stops anything clipping.
 * These are fixed, non-adaptive filters (unlike loudnorm), so the new encode
 * a seek starts sounds exactly like the one it replaced.
 */
export function audioFilter (channels, normalize = true) {
  const f = []
  if (channels > 2) f.push('aresample=out_chlayout=stereo:center_mix_level=1:surround_mix_level=0.707:lfe_mix_level=0.5')
  else if (channels === 1) f.push('pan=stereo|c0=c0|c1=c0')
  if (normalize) {
    f.push(
      'acompressor=threshold=0.089:ratio=3:attack=15:release=300:knee=4:makeup=2.2',
      'alimiter=limit=0.94:attack=5:release=60:level=disabled'
    )
  }
  f.push('aresample=48000')
  return f.join(',')
}

const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'])
export const isTextSub = (s) => TEXT_SUBS.has(s.codec)

/**
 * ffmpeg arguments to encode one rung starting at segment `startSeg`.
 * Keyframes are forced every SEGMENT_SECONDS, so segments line up exactly
 * with the precomputed playlist no matter where an encode starts. That's
 * what lets anyone seek anywhere instantly: the PC just starts a new encode
 * from that segment.
 */
export function encodeArgs ({ input, info, rung, encoder, startSeg, outDir, tonemap, hwDecode = true, normalizeAudio = true }) {
  const start = startSeg * SEGMENT_SECONDS
  const audio = pickAudio(info)
  const af = audio ? audioFilter(audio.channels || 2, normalizeAudio) : ''
  const vbr = rung.vbr
  const vf = [`scale=-2:${rung.outHeight}:flags=bicubic`]
  if (info.video?.hdr && tonemap) {
    vf.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv')
  }
  vf.push(`format=${encoder === 'h264_qsv' ? 'nv12' : 'yuv420p'}`)

  const enc = {
    h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-forced-idr', '1', '-profile:v', 'high'],
    h264_qsv: ['-c:v', 'h264_qsv', '-preset', 'faster', '-forced_idr', '1', '-profile:v', 'high'],
    h264_amf: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'vbr_peak', '-profile:v', 'high'],
    libx264: ['-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-sc_threshold', '0']
  }[encoder] || []

  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    // NVIDIA: decode on the GPU too (frames come back to system memory for
    // scaling, and ffmpeg quietly falls back to the CPU for unsupported codecs).
    ...(encoder === 'h264_nvenc' && hwDecode ? ['-hwaccel', 'cuda'] : []),
    ...(start > 0 ? ['-ss', String(start)] : []),
    '-i', input,
    '-map', '0:v:0',
    ...(audio ? ['-map', `0:a:${audio.index}`] : []),
    '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-vf', vf.join(','),
    ...enc,
    '-b:v', `${vbr}k`, '-maxrate', `${Math.round(vbr * 1.5)}k`, '-bufsize', `${vbr * 2}k`,
    '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
    ...(af ? ['-af', af] : []),
    ...(audio ? ['-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', `${rung.abr}k`] : []),
    '-output_ts_offset', String(start),
    '-muxdelay', '0',
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_list_size', '0',
    '-hls_segment_type', 'mpegts',
    '-hls_flags', 'temp_file+independent_segments',
    '-start_number', String(startSeg),
    '-hls_segment_filename', path.join(outDir, 'seg%05d.ts'),
    path.join(outDir, 'ffmpeg.m3u8')
  ]
}

/** One JPEG frame for the seek-bar preview. */
export function thumbArgs (input, t) {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(Math.max(0, t)), '-i', input,
    '-frames:v', '1', '-an', '-sn', '-vf', 'scale=320:-2', '-q:v', '6', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']
}
