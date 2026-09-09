import { config } from './config.js'
import { logger } from './log.js'
import { FluxerGateway } from './fluxer/gateway.js'
import { fluxerRest } from './fluxer/rest.js'
import { DiscordPool } from './discord/pool.js'
import { buildChannelMap } from './bridge/channelMap.js'
import { TextBridge } from './bridge/text.js'
import { VoiceBridge } from './bridge/voice.js'
import { Announcer } from './bridge/announce.js'

const log = logger('main')

async function main() {
  log.info('fightersguild-crosstalk starting')

  // ── Discord (pool) ──
  const pool = new DiscordPool()
  await pool.init()
  const primary = pool.primary

  // ── Fluxer gateway ──
  const fluxerGw = new FluxerGateway()
  const ready = new Promise((res, rej) => {
    fluxerGw.once('ready', res)
    fluxerGw.once('fatal', code => rej(new Error(`Fluxer gateway fatal ${code}`)))
  })
  await fluxerGw.start()
  await ready

  const me = await fluxerRest.me().catch(() => null)
  log.info(`Fluxer bot: ${me?.username ?? '?'} (${fluxerGw.botUserId})`)
  const fluxerChannels = await fluxerRest.guildChannels()
  const { text, voice } = buildChannelMap(fluxerChannels, primary.guild)

  // ── Announcements ──
  const announcer = new Announcer({
    fluxerGw, primaryClient: primary.client, primaryGuild: primary.guild, fluxerChannels,
  })
  announcer.start()

  // ── Text bridge ──
  if (text.length) {
    await new TextBridge({
      fluxerGw, discord: primary.client, discordGuild: primary.guild, pairs: text,
    }).init()
  } else {
    log.warn('no matching text channels — text bridge not started')
  }

  // ── Voice bridge ──
  let vb = null
  if (config.bridge.voice && voice.length) {
    vb = new VoiceBridge({ fluxerGw, pool, announcer, pairs: voice })
    vb.start()
  } else {
    log.info('voice bridge disabled or no matching voice channels')
  }

  log.info('crosstalk online')

  const shutdown = async () => {
    log.info('shutting down')
    try { await vb?.stop() } catch {}
    try { fluxerGw.stop() } catch {}
    try { await pool.destroy() } catch {}
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('unhandledRejection', e => log.error('unhandledRejection', e?.stack || e))
}

main().catch(e => { log.error('fatal:', e.stack || e.message); process.exit(1) })
