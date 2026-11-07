/**
 * Public https address for this PC via a free Cloudflare quick tunnel.
 *
 * No router setup or port forwarding: cloudflared makes an outbound
 * connection and Cloudflare hands out a random https://….trycloudflare.com
 * URL that forwards to our local video server. If cloudflared isn't
 * installed it's downloaded once into host/bin.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { HOST_ROOT } from './config.js'

const DOWNLOADS = {
  win32: { x64: 'cloudflared-windows-amd64.exe', arm64: 'cloudflared-windows-amd64.exe', ia32: 'cloudflared-windows-386.exe' },
  linux: { x64: 'cloudflared-linux-amd64', arm64: 'cloudflared-linux-arm64' },
  darwin: { x64: 'cloudflared-darwin-amd64.tgz', arm64: 'cloudflared-darwin-amd64.tgz' }
}

export class Tunnel extends EventEmitter {
  constructor ({ port, log }) {
    super()
    this.port = port
    this.log = log
    this.url = null
    this.proc = null
    this.stopped = false
    this.restarts = 0
  }

  async start () {
    const bin = await this.#binary()
    this.#spawn(bin)
  }

  #spawn (bin) {
    this.proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${this.port}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const onData = (d) => {
      const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      if (m && m[0] !== this.url) {
        this.url = m[0]
        this.restarts = 0
        this.emit('url', this.url)
      }
    }
    this.proc.stdout.on('data', onData)
    this.proc.stderr.on('data', onData)
    this.proc.on('error', (e) => this.log(`Tunnel error: ${e.message}`))
    this.proc.on('close', (code) => {
      if (this.stopped) return
      this.url = null
      this.emit('down')
      const wait = Math.min(30_000, 2000 * 2 ** this.restarts++)
      this.log(`Tunnel closed (code ${code}); reconnecting in ${Math.round(wait / 1000)}s…`)
      setTimeout(() => !this.stopped && this.#spawn(bin), wait)
    })
  }

  async #binary () {
    if (spawnSync('cloudflared', ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0) return 'cloudflared'
    const dir = path.join(HOST_ROOT, 'bin')
    const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
    const local = path.join(dir, name)
    if (fs.existsSync(local)) return local
    const asset = DOWNLOADS[process.platform]?.[process.arch]
    if (!asset || asset.endsWith('.tgz')) throw new Error('cloudflared not found. Install it (brew install cloudflared) or set publicUrl in config.json.')
    this.log('Downloading cloudflared (one time, ~40 MB)…')
    const res = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`)
    if (!res.ok) throw new Error(`Couldn't download cloudflared (${res.status}). Install it with: winget install Cloudflare.cloudflared`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(local, Buffer.from(await res.arrayBuffer()))
    if (process.platform !== 'win32') fs.chmodSync(local, 0o755)
    return local
  }

  stop () {
    this.stopped = true
    try { this.proc?.kill() } catch {}
  }
}
