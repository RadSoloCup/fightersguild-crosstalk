import { Client, GatewayIntentBits, Partials } from 'discord.js'
import { config } from '../config.js'
import { logger } from '../log.js'

const log = logger('discord')

const PRIMARY_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildVoiceStates,
]
// Voice-pool workers only need to see channels + voice state.
const WORKER_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]

export function createDiscord({ worker = false } = {}) {
  const client = new Client({
    intents: worker ? WORKER_INTENTS : PRIMARY_INTENTS,
    partials: [Partials.Channel, Partials.Message],
    allowedMentions: { parse: [] },
  })
  client.on('error', e => log.warn(`client error: ${e.message}`))
  client.on('shardDisconnect', () => log.warn('shard disconnected'))
  client.on('shardResume', () => log.info('shard resumed'))
  return client
}

// Log a client in and resolve its guild object.
export async function loginDiscord(client, token) {
  const ready = new Promise(res => client.once('clientReady', () => res()))
  await client.login(token)
  await ready
  const guild = client.guilds.cache.get(config.discord.guildId)
    ?? await client.guilds.fetch(config.discord.guildId)
  log.info(`ready as ${client.user.tag} (${client.user.id})${guild ? '' : ', NOT in the target guild!'}`)
  return guild
}

// Reuse or create a webhook the bridge owns on a Discord text channel.
export async function ensureDiscordWebhook(channel, name = 'Fighters Guild Bridge') {
  const hooks = await channel.fetchWebhooks()
  const mine = hooks.find(h => h.owner?.id === channel.client.user.id && h.name === name)
  if (mine) return mine
  return channel.createWebhook({ name, reason: 'Fighters Guild <-> Fluxer bridge' })
}
