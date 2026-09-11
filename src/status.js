import { config } from './config.js'
import { logger } from './log.js'

const log = logger('status')

// Periodically POST a health snapshot to the Portal, so its Servers page can
// show the bridge and its parts. No inbound port; the Portal endpoint is
// bearer-authenticated.
export function startStatusPush({ fluxerGw, pool, textBridge, voiceBridge }) {
  if (!config.statusPushUrl || !config.statusPushToken) {
    log.info('status push disabled (no STATUS_PUSH_URL / STATUS_PUSH_TOKEN)')
    return
  }

  const snapshot = () => ({
    ts: new Date().toISOString(),
    fluxer: { connected: !!fluxerGw?.isReady, bot: fluxerGw?.botUserId || null },
    discord: (pool?.slots || []).map(s => ({
      tag: s.client?.user?.tag || null,
      id: s.client?.user?.id || null,
      ready: !!s.client?.isReady?.(),
      primary: !!s.primary,
    })),
    text: { live: !!textBridge, channels: textBridge?.pairs?.length || 0 },
    voice: {
      pairs: voiceBridge?.pairs?.length || 0,
      bots: pool?.slots?.length || 0,
      active: [...(voiceBridge?.active?.values?.() || [])].map(x => x.pair.name),
    },
  })

  const push = async () => {
    try {
      const res = await fetch(config.statusPushUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.statusPushToken}` },
        body: JSON.stringify(snapshot()),
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) log.debug(`push -> ${res.status}`)
    } catch (e) { log.debug(`push: ${e.message}`) }
  }

  setTimeout(push, 5000)
  setInterval(push, 30_000)
  log.info(`status push -> ${config.statusPushUrl}`)
}
