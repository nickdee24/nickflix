/**
 * Writes host/config.json from the answers the setup asks for, so nobody has
 * to edit JSON by hand.
 *
 *   node src/setup.js --secret <key> --media "<folder>" [--media "<folder>"]
 *
 * Anything not given keeps its current value (re-running setup to update is safe).
 */
import fs from 'node:fs'
import { loadConfig, saveConfig, CONFIG_FILE } from './config.js'

const args = process.argv.slice(2)
const secret = []
const media = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--secret') secret.push(args[++i])
  else if (args[i] === '--media') media.push(args[++i])
}

const { cfg } = loadConfig()
const key = (secret.pop() || '').trim()
if (key) cfg.secret = key
const dirs = media.map((d) => (d || '').trim().replace(/^"|"$/g, '')).filter(Boolean)
if (dirs.length) cfg.mediaDirs = dirs
saveConfig(cfg)

const missing = cfg.mediaDirs.filter((d) => !fs.existsSync(d))
console.log(`  Saved ${CONFIG_FILE}`)
console.log(`  Movies: ${cfg.mediaDirs.join(', ')}`)
if (missing.length) console.log(`  ⚠ Folder not found: ${missing.join(', ')}`)
