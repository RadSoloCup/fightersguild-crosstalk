import { config } from '../config.js'

const base = config.fluxer.apiBase
const H = () => ({
  authorization: `Bot ${config.fluxer.botToken}`,
  'user-agent': config.userAgent,
  accept: 'application/json',
})

async function req(method, path, body, { auth = true } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(auth ? H() : { 'user-agent': config.userAgent, accept: 'application/json' }),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  if (!res.ok) {
    // Never echo a webhook token (it lives in the path).
    const safePath = path.replace(/(\/webhooks\/\d+\/)[^/?]+/, '$1REDACTED')
    throw new Error(`Fluxer ${method} ${safePath} -> ${res.status} ${text.slice(0, 300)}`)
  }
  return text ? JSON.parse(text) : null
}

export const fluxerRest = {
  gatewayUrl: () => req('GET', '/gateway/bot').then(d => d.url),
  me: () => req('GET', '/users/@me'),
  guildChannels: () => req('GET', `/guilds/${config.fluxer.guildId}/channels`),
  guildWebhooks: () => req('GET', `/guilds/${config.fluxer.guildId}/webhooks`),
  channelWebhooks: id => req('GET', `/channels/${id}/webhooks`),
  createWebhook: (channelId, name) => req('POST', `/channels/${channelId}/webhooks`, { name }),

  // Execute a webhook. `wait` returns the created message object.
  executeWebhook: (id, token, payload, wait = true) =>
    req('POST', `/webhooks/${id}/${token}${wait ? '?wait=true' : ''}`, payload, { auth: false }),
  editWebhookMessage: (id, token, messageId, payload) =>
    req('PATCH', `/webhooks/${id}/${token}/messages/${messageId}`, payload, { auth: false }),
  deleteWebhookMessage: (id, token, messageId) =>
    req('DELETE', `/webhooks/${id}/${token}/messages/${messageId}`, null, { auth: false }),

  postMessage: (channelId, payload) => req('POST', `/channels/${channelId}/messages`, payload),
  editMessage: (channelId, messageId, payload) => req('PATCH', `/channels/${channelId}/messages/${messageId}`, payload),
  deleteMessage: (channelId, messageId) => req('DELETE', `/channels/${channelId}/messages/${messageId}`),

  // Set the bot's own nickname in the guild. Fluxer silently ignores this when
  // the bot lacks CHANGE_NICKNAME, so treat any failure as best-effort.
  setSelfNick: nick => req('PATCH', `/guilds/${config.fluxer.guildId}/members/@me`, { nick: nick || null }).catch(() => null),
}

// Resolve a Fluxer avatar URL the same way the clients do.
const DEFAULT_AVATARS = 6n
export function fluxerAvatarUrl(user, size = 128) {
  const id = user?.id
  const hash = user?.avatar
  if (id && hash) {
    const animated = hash.startsWith('a_')
    const bare = animated ? hash.slice(2) : hash
    return `${config.fluxer.origin}/media/avatars/${id}/${bare}.webp?size=${size}${animated ? '&animated=true' : ''}`
  }
  let idx = 0
  try { idx = Number(BigInt(String(id || '0')) % DEFAULT_AVATARS) } catch {}
  return `${config.fluxer.origin}/avatars/${idx}.png?v=1`
}
