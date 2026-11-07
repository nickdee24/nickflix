/**
 * REST API (everything else happens over Socket.IO)
 *
 *  GET /api/health   → { ok, uptime, host }
 *  GET /api/screen   → public info for link previews and the join screen
 *  POST /api/screen/bye { clientKey }  → sendBeacon from a closing tab: drop that viewer
 */
import express from 'express'
import { userIdFrom } from '../screen/screen.js'

export function createApi ({ screen, hostLink, bye }) {
  const router = express.Router()
  router.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime(), host: hostLink.online }))
  router.get('/screen', (req, res) => res.json(screen.publicInfo()))
  // sendBeacon posts text/plain unless given a typed Blob; accept either.
  router.post('/screen/bye', express.text({ limit: '1kb', type: 'text/plain' }), (req, res) => {
    let key = req.body?.clientKey
    if (typeof req.body === 'string') { try { key = JSON.parse(req.body).clientKey } catch { key = null } }
    if (typeof key === 'string' && key.length >= 16 && key.length <= 128) bye?.(userIdFrom(key))
    res.status(204).end()
  })
  router.use((req, res) => res.status(404).json({ error: 'Not found' }))
  return router
}
