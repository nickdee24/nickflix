/** REST client for the NickFlix server (most things go over the socket). */
async function request (method, url) {
  let res
  try {
    res = await fetch(url, { method })
  } catch {
    throw new Error('Can\'t reach NickFlix. Check your connection.')
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status })
  return data
}

export const api = {
  health: () => request('GET', '/api/health'),
  screen: () => request('GET', '/api/screen')
}
