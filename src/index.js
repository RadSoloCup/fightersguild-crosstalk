import { config } from './config.js'
import { logger } from './log.js'
import { FluxerGateway } from './fluxer/gateway.js'
import { fluxerRest } from './fluxer/rest.js'
import { createDiscord, loginDiscord } from './discord/index.js'
import { buildChannelMap } from './bridge/channelMap.js'
import { TextBridge } from './bridge/text.js'
import { VoiceBridge } from './bridge/voice.js'

const log = logger('main')

async function main() {
  log.info('fightersguild-crosstalk starting')

  // ── Discord ──
  const discord = createDiscord()
  const discordGuild = await loginDiscord(discord)
  if (!discordGuild) throw new Error(`Discord guild ${config.discord.guildId} not found (is the bot in it?)`)

  // ── Fluxer gateway ──
  const fluxerGw = new FluxerGateway()
  const ready = new Promise((res, rej) => {
    fluxerGw.once('ready', res)
    fluxerGw.once('fatal', code => rej(new Error(`Fluxer gateway fatal ${code}`)))
  })
  await fluxerGw.start()
  await ready

  // ── Channel map ──
  const me = await fluxerRest.me().catch(() => null)
  log.info(`Fluxer bot: ${me?.username ?? '?'} (${fluxerGw.botUserId})`)
  const fluxerChannels = await fluxerRest.guildChannels()
  const { text, voice } = buildChannelMap(fluxerChannels, discordGuild)

  // ── Text bridge ──
  if (text.length) {
    const tb = new TextBridge({ fluxerGw, discord, discordGuild, pairs: text })
    await tb.init()
  } else {
    log.warn('no matching text channels — text bridge not started')
  }

  // ── Voice bridge ──
  let vb = null
  if (config.bridge.voice && voice.length) {
    vb = new VoiceBridge({ fluxerGw, discord, discordGuild, pairs: voice })
    vb.start()
  } else {
    log.info('voice bridge disabled or no matching voice channels')
  }

  log.info('crosstalk online')

  const shutdown = async () => {
    log.info('shutting down')
    try { await vb?.stop() } catch {}
    try { fluxerGw.stop() } catch {}
    try { await discord.destroy() } catch {}
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('unhandledRejection', e => log.error('unhandledRejection', e?.stack || e))
}

main().catch(e => { log.error('fatal:', e.stack || e.message); process.exit(1) })
