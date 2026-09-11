import { WebhookClient } from 'discord.js'
import { config } from '../config.js'
import { fluxerRest, fluxerAvatarUrl } from '../fluxer/rest.js'
import { ensureDiscordWebhook } from '../discord/index.js'
import { IdMap } from './idMap.js'
import { logger } from '../log.js'

const log = logger('text')
const MAX = 3800 // stay under both platforms' webhook content limits

const clip = s => (s && s.length > MAX ? s.slice(0, MAX - 1) + '…' : s || '')

// Turn a Fluxer/Discord attachment list into trailing link lines.
function attachmentLines(urls) {
  return urls.length ? '\n' + urls.join('\n') : ''
}

// Render a Discord message as plain markdown for the Fluxer side: resolve
// mentions to readable names, flatten custom emoji and timestamps, and fold in
// any embeds (news bots, PatchBot, etc. post embed-only messages).
function renderDiscordMessage(m) {
  let text = m.cleanContent ?? m.content ?? ''
  text = text
    .replace(/<a?:(\w{2,32}):\d+>/g, ':$1:')                              // custom emoji -> :name:
    .replace(/<t:(\d{1,15})(?::[tTdDfFR])?>/g, (_, s) =>                   // discord timestamp -> date
      new Date(Number(s) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC')
    .replace(/<@!?\d+>/g, '@someone')                                     // any mention cleanContent missed
    .replace(/<@&\d+>/g, '@role')
    .replace(/<#\d+>/g, '#channel')

  const blocks = [text.trim()].filter(Boolean)

  for (const e of m.embeds ?? []) {
    const lines = []
    if (e.author?.name) lines.push(`**${e.author.name}**`)
    if (e.title) lines.push(e.url ? `**[${e.title}](${e.url})**` : `**${e.title}**`)
    if (e.description) lines.push(e.description)
    for (const f of e.fields ?? []) lines.push(`**${f.name}**\n${f.value}`)
    if (e.footer?.text) lines.push(`_${e.footer.text}_`)
    if (lines.length) blocks.push(lines.join('\n'))
  }

  for (const a of m.attachments?.values?.() ?? []) blocks.push(a.url)

  return blocks.join('\n\n')
}

export class TextBridge {
  constructor({ fluxerGw, discord, discordGuild, pairs }) {
    this.fluxerGw = fluxerGw
    this.discord = discord
    this.discordGuild = discordGuild
    this.pairs = pairs
    this.ids = new IdMap()

    // channelId -> webhook creds / clients
    this.flHook = new Map()  // fluxerChannelId -> { id, token }
    this.dcHook = new Map()  // discordChannelId -> WebhookClient
    this.ourFluxerHookIds = new Set()
    this.ourDiscordHookIds = new Set()

    // quick lookups
    this.flToDc = new Map(pairs.map(p => [p.fluxerId, p]))
    this.dcToFl = new Map(pairs.map(p => [p.discordId, p]))
  }

  async init() {
    for (const p of this.pairs) {
      // Fluxer webhook
      try {
        const existing = (await fluxerRest.channelWebhooks(p.fluxerId))
          .find(w => w.name === 'Fighters Guild Bridge')
        const wh = existing || await fluxerRest.createWebhook(p.fluxerId, 'Fighters Guild Bridge')
        this.flHook.set(p.fluxerId, { id: wh.id, token: wh.token })
        this.ourFluxerHookIds.add(wh.id)
      } catch (e) { log.error(`fluxer webhook for #${p.name}: ${e.message}`) }

      // Discord webhook
      try {
        const ch = await this.discordGuild.channels.fetch(p.discordId)
        const wh = await ensureDiscordWebhook(ch)
        this.dcHook.set(p.discordId, new WebhookClient({ id: wh.id, token: wh.token }))
        this.ourDiscordHookIds.add(wh.id)
      } catch (e) { log.error(`discord webhook for #${p.name}: ${e.message}`) }
    }

    this.fluxerGw.on('messageCreate', d => this._fromFluxer(d).catch(e => log.warn(`fl->dc: ${e.message}`)))
    this.discord.on('messageCreate', m => this._fromDiscord(m).catch(e => log.warn(`dc->fl: ${e.message}`)))

    if (config.bridge.syncEdits) {
      this.fluxerGw.on('messageUpdate', d => this._editFromFluxer(d).catch(() => {}))
      this.discord.on('messageUpdate', (_o, m) => this._editFromDiscord(m).catch(() => {}))
    }
    if (config.bridge.syncDeletes) {
      this.fluxerGw.on('messageDelete', d => this._deleteFromFluxer(d).catch(() => {}))
      this.discord.on('messageDelete', m => this._deleteFromDiscord(m).catch(() => {}))
    }

    log.info(`text bridge live for ${this.pairs.length} channel(s)`)
  }

  // ── Fluxer -> Discord ────────────────────────────────────────────────────
  async _fromFluxer(d) {
    const pair = this.flToDc.get(d.channel_id)
    if (!pair) return
    if (d.webhook_id && this.ourFluxerHookIds.has(d.webhook_id)) return       // our own echo
    if (d.author?.id && d.author.id === this.fluxerGw.botUserId) return
    if (d.type && ![0, 19].includes(d.type)) return                           // only default / reply

    const hook = this.dcHook.get(pair.discordId)
    if (!hook) return
    const att = (d.attachments || []).map(a => a.url || a.proxy_url).filter(Boolean)
    const content = clip((d.content || '') + attachmentLines(att)).trim() || '(no content)'
    const name = ((d.author?.global_name || d.author?.username || 'Unknown') + config.bridge.tagFluxer).slice(0, 80)

    const msg = await hook.send({
      username: name,
      avatarURL: fluxerAvatarUrl(d.author),
      content,
      allowedMentions: { parse: [] },
    })
    this.ids.link(`fl:${d.id}`, `dc:${msg.id}`, { discordChannelId: pair.discordId, fluxerChannelId: pair.fluxerId })
  }

  async _editFromFluxer(d) {
    if (!d?.id || d.content == null) return
    const rec = this.ids.bySource(`fl:${d.id}`)
    if (!rec) return
    const pair = this.flToDc.get(d.channel_id)
    const hook = pair && this.dcHook.get(pair.discordId)
    if (!hook) return
    const att = (d.attachments || []).map(a => a.url || a.proxy_url).filter(Boolean)
    await hook.editMessage(rec.peerKey.slice(3), { content: clip((d.content || '') + attachmentLines(att)).trim() || '(no content)' })
  }

  async _deleteFromFluxer(d) {
    const rec = this.ids.bySource(`fl:${d.id}`)
    if (!rec) return
    const pair = this.flToDc.get(d.channel_id)
    const hook = pair && this.dcHook.get(pair.discordId)
    if (hook) await hook.deleteMessage(rec.peerKey.slice(3)).catch(() => {})
  }

  // ── Discord -> Fluxer ────────────────────────────────────────────────────
  async _fromDiscord(m) {
    const pair = this.dcToFl.get(m.channelId)
    if (!pair) return
    if (m.webhookId && this.ourDiscordHookIds.has(m.webhookId)) return
    if (m.author?.id === this.discord.user.id) return
    if (m.system) return

    const hook = this.flHook.get(pair.fluxerId)
    if (!hook) return
    const content = clip(renderDiscordMessage(m)).trim() || '(no content)'
    const member = m.member
    const name = ((member?.displayName || m.author.globalName || m.author.username || 'Unknown') + config.bridge.tagDiscord).slice(0, 80)

    const out = await fluxerRest.executeWebhook(hook.id, hook.token, {
      username: name,
      avatar_url: m.author.displayAvatarURL({ extension: 'png', size: 128 }),
      content,
    })
    if (out?.id) this.ids.link(`dc:${m.id}`, `fl:${out.id}`, { fluxerChannelId: pair.fluxerId, discordChannelId: pair.discordId })
  }

  async _editFromDiscord(m) {
    if (!m?.id) return
    const rec = this.ids.bySource(`dc:${m.id}`)
    if (!rec) return
    const pair = this.dcToFl.get(m.channelId)
    const hook = pair && this.flHook.get(pair.fluxerId)
    if (!hook) return
    await fluxerRest.editWebhookMessage(hook.id, hook.token, rec.peerKey.slice(3), {
      content: clip(renderDiscordMessage(m)).trim() || '(no content)',
    })
  }

  async _deleteFromDiscord(m) {
    const rec = this.ids.bySource(`dc:${m.id}`)
    if (!rec) return
    const pair = this.dcToFl.get(m.channelId)
    const hook = pair && this.flHook.get(pair.fluxerId)
    if (hook) await fluxerRest.deleteWebhookMessage(hook.id, hook.token, rec.peerKey.slice(3)).catch(() => {})
  }
}
