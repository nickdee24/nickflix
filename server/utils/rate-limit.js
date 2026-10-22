/**
 * Tiny token bucket used to throttle chat, reactions and API uploads per client.
 *   const allow = bucket(5, 5000)   // 5 actions per 5 seconds
 *   if (!allow(key)) return
 */
export function bucket (capacity, windowMs) {
  const refillPerMs = capacity / windowMs
  const state = new Map()

  // Forget idle keys so the map can't grow forever.
  setInterval(() => {
    const cutoff = Date.now() - windowMs * 4
    for (const [k, v] of state) if (v.at < cutoff) state.delete(k)
  }, windowMs * 4).unref()

  return function allow (key, cost = 1) {
    const now = Date.now()
    const s = state.get(key) || { tokens: capacity, at: now }
    s.tokens = Math.min(capacity, s.tokens + (now - s.at) * refillPerMs)
    s.at = now
    state.set(key, s)
    if (s.tokens < cost) return false
    s.tokens -= cost
    return true
  }
}
