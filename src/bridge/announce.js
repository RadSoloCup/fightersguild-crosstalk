import { config, normaliseName } from '../config.js'
import { fluxerRest } from '../fluxer/rest.js'
import { logger } from '../log.js'

const log = logger('announce')
const DEBOUNCE_MS = 2500

// Posts "X joined / left voice #channel" lines (and bridge status) to a chosen
// channel on each side.
export class Announcer {
  constructor({ fluxerGw, primaryClient, primaryGuild, fluxerChannels }) {
    this.fluxerGw = fluxerGw
    this.client = primaryClient
    this.guild = primaryGuild
    this.enabled = !!config.bridge.announceChannel
    this.ignore = new Set(config.bridge.voiceIgnore)

    const wanted = normaliseName(config.bridge.announceChannel)
    this.flChannelId = fluxerChannels.find(c => c.type === 0 && normaliseName(c.name) === wanted)?.id || null
    this.dcChannel = [...primaryGuild.channels.cache.values()].find(c => c.type === 0 && normaliseName(c.name) === wanted) || null
    this._flNames = new Map(fluxerChannels.map(c => [c.id, c.name]))

    // userId -> { channelId, name, announced, timer }
    this._fl = new Map()
    this._dc = new Map()
  }

  start() {
    if (!this.enabled) { log.info('announcements disabled (no ANNOUNCE_CHANNEL)'); return }
    if (!this.flChannelId && !this.dcChannel) {
      log.warn(`announce channel "${config.bridge.announceChannel}" not found on either side`)
      return
    }
    log.info(`announcing to ${[this.flChannelId && 'Fluxer', this.dcChannel && `#${this.dcChannel.name}`].filter(Boolean).join(' + ')}`)

    this.fluxerGw.on('voiceStateUpdate', d => {
      if (this.ignore.has(d.user_id) || d.user_id === this.fluxerGw.botUserId) return
      if (d.member?.user?.bot) return
      const name = d.member?.user?.global_name || d.member?.user?.username || 'Someone'
      this._change(this._fl, 'Fluxer', d.user_id, d.channel_id, name, id => this._flNames.get(id) || 'a channel')
    })

    this.client.on('voiceStateUpdate', (oldS, newS) => {
      const m = newS.member || oldS.member
      const uid = m?.id || newS.id
      if (this.ignore.has(uid) || m?.user?.bot) return
      const name = m?.displayName || m?.user?.globalName || m?.user?.username || 'Someone'
      this._change(this._dc, 'Discord', uid, newS.channelId, name, id => this.guild.channels.cache.get(id)?.name || 'a channel')
    })
  }

  _change(map, platform, uid, channelId, name, resolveName) {
    const prev = map.get(uid)
    if (prev?.timer) clearTimeout(prev.timer)
    const entry = { channelId, name, announced: prev?.announced ?? null }
    entry.timer = setTimeout(() => {
      const from = entry.announced
      const to = channelId
      entry.announced = to
      if (from === to) return
      if (!to && from) {
        if (config.bridge.announceLeaves) this._post(`**${name}** left voice · ${platform}`)
      } else if (to && !from) {
        if (config.bridge.announceJoins) this._post(`**${name}** joined **#${resolveName(to)}** · ${platform}`)
      } else if (to && from) {
        if (config.bridge.announceJoins) this._post(`**${name}** moved to **#${resolveName(to)}** · ${platform}`)
      }
    }, DEBOUNCE_MS)
    map.set(uid, entry)
  }

  bridgeUp(pair) {
    if (config.bridge.announceBridge) this._post(`Voice bridge now connecting **#${pair.name}** between Fluxer and Discord`)
  }
  bridgeDown(pair) {
    if (config.bridge.announceBridge) this._post(`Voice bridge left **#${pair.name}**`)
  }
  bridgeBusy(pair, max) {
    if (config.bridge.announceBridge) this._post(`**#${pair.name}** voice is active on both apps but all ${max} bridge${max === 1 ? '' : 's'} are busy`)
  }

  _post(text) {
    const to = config.bridge.announceTo
    if ((to === 'both' || to === 'fluxer') && this.flChannelId) {
      fluxerRest.postMessage(this.flChannelId, { content: text }).catch(e => log.debug(`fl post: ${e.message}`))
    }
    if ((to === 'both' || to === 'discord') && this.dcChannel) {
      this.dcChannel.send({ content: text, allowedMentions: { parse: [] } }).catch(e => log.debug(`dc post: ${e.message}`))
    }
  }
}
