import { config } from '../config.js'
import { createDiscord, loginDiscord } from './index.js'
import { logger } from '../log.js'

const log = logger('pool')

// A pool of Discord bot connections. The first is the "primary" (text bridge +
// announcements); every connection, primary included, can also be borrowed as a
// voice worker — a Discord bot can only be in one voice channel per guild, so N
// tokens means N concurrent voice bridges.
export class DiscordPool {
  constructor() {
    this.slots = [] // { client, guild, primary, busy: pair|null }
  }

  async init() {
    const tokens = config.discord.botTokens
    for (let i = 0; i < tokens.length; i++) {
      const primary = i === 0
      const client = createDiscord({ worker: !primary })
      let guild
      try {
        guild = await loginDiscord(client, tokens[i])
      } catch (e) {
        log.error(`bot #${i} login failed: ${e.message}`)
        continue
      }
      if (!guild) { log.error(`bot #${i} is not in guild ${config.discord.guildId} — skipped`); continue }
      this.slots.push({ client, guild, primary, busy: null })
    }
    if (!this.slots.length) throw new Error('no usable Discord bots')
    if (!this.slots[0].primary) throw new Error('primary Discord bot failed to start')
    log.info(`pool ready: ${this.slots.length} bot(s) — ${this.slots.length - 1} extra voice worker(s)`)
  }

  get primary() { return this.slots[0] }
  get botIds() { return this.slots.map(s => s.client.user?.id).filter(Boolean) }

  // Claim a free slot for a voice pair. Prefers non-primary slots so the
  // primary stays free for the text bridge's own responsiveness.
  acquire(pair) {
    const free = this.slots.filter(s => !s.busy)
    if (!free.length) return null
    const slot = free.find(s => !s.primary) || free[0]
    slot.busy = pair
    return slot
  }

  release(slot) { if (slot) slot.busy = null }

  slotFor(pair) { return this.slots.find(s => s.busy && s.busy.fluxerId === pair.fluxerId) || null }

  async destroy() {
    for (const s of this.slots) { try { await s.client.destroy() } catch {} }
  }
}
