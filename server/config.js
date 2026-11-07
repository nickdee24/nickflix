/**
 * Central configuration. Every value can be overridden with an environment
 * variable so the same build runs locally or on Render.
 */
const int = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d)

export const config = {
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  isProd: process.env.NODE_ENV === 'production',

  /**
   * Shared secret between this site and the NickFlix Host app on your PC.
   * The host app prints one on first run; paste it into HOST_SECRET on Render.
   * The same key, entered in Settings → Host key, unlocks host controls
   * (loading movies) in the browser.
   */
  hostSecret: process.env.HOST_SECRET || '',

  /** Screen 1 */
  screenName: process.env.SCREEN_NAME || 'Screen 1',
  memberGraceMs: int(process.env.MEMBER_GRACE_MS, 30_000),
  maxMembers: int(process.env.MAX_MEMBERS, 24),
  chatHistory: 120,

  /** Wait-for-everyone buffering */
  stallTriggerMs: int(process.env.STALL_TRIGGER_MS, 1200), // someone stalled this long → pause for them
  resumeBufferSeconds: int(process.env.RESUME_BUFFER_SECONDS, 6), // everyone needs this much buffered to resume
  holdTimeoutMs: int(process.env.HOLD_TIMEOUT_MS, 45_000) // give up waiting after this long
}
