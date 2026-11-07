/**
 * REST API (everything else happens over Socket.IO)
 *
 *  GET /api/health   → { ok, uptime, host }
 *  GET /api/screen   → public info for link previews and the join screen
 */
import express from 'express'

export function createApi ({ screen, hostLink }) {
  const router = express.Router()
  router.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime(), host: hostLink.online }))
  router.get('/screen', (req, res) => res.json(screen.publicInfo()))
  router.use((req, res) => res.status(404).json({ error: 'Not found' }))
  return router
}
