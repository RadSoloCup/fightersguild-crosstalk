import { Client, GatewayIntentBits, Partials } from 'discord.js'
import { config } from '../config.js'
import { logger } from '../log.js'

const log = logger('discord')

export function createDiscord() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Channel, Partials.Message],
    allowedMentions: { parse: [] },
  })

  client.on('error', e => log.warn(`client error: ${e.message}`))
  client.on('shardDisconnect', () => log.warn('shard disconnected'))
  client.on('shardResume', () => log.info('shard resumed'))

  return client
}

export async function loginDiscord(client) {
  const ready = new Promise(res => client.once('clientReady', () => res()))
  await client.login(config.discord.botToken)
  await ready
  log.info(`ready as ${client.user.tag} (${client.user.id})`)
  return client.guilds.cache.get(config.discord.guildId)
    ?? await client.guilds.fetch(config.discord.guildId)
}

// Reuse or create a webhook the bridge owns on a Discord text channel.
export async function ensureDiscordWebhook(channel, name = 'Fighters Guild Bridge') {
  const hooks = await channel.fetchWebhooks()
  const mine = hooks.find(h => h.owner?.id === channel.client.user.id && h.name === name)
  if (mine) return mine
  return channel.createWebhook({ name, reason: 'Fighters Guild <-> Fluxer bridge' })
}
