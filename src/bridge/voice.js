import { config } from '../config.js'
import { FluxerVoice } from '../fluxer/voice.js'
import { DiscordVoice } from '../discord/voice.js'
import { fluxerRest } from '../fluxer/rest.js'
import { logger } from '../log.js'

const log = logger('voice')
const FRAME_SAMPLES = 960 * 2      // 20ms stereo
const FRAME_BYTES = FRAME_SAMPLES * 2

// Fit a name list into a 32-char Fluxer nickname.
function compactNick(names) {
  if (!names.length) return ''
  let out = '🎧 '
  for (let i = 0; i < names.length; i++) {
    const next = out + (i ? ', ' : '') + names[i]
    if (next.length > 28) { out += ` +${names.length - i}`; return out.slice(0, 32) }
    out = next
  }
  return out.slice(0, 32)
}

// Orchestrates voice bridges across a pool of Discord bots. Each bot can hold
// one Discord voice channel; the shared Fluxer bot can hold many LiveKit rooms
// at once. So N Discord tokens gives up to N paired voice channels bridged at
// once. By default a pair is only bridged while someone is present on BOTH
// sides (VOICE_REQUIRE_BOTH).
export class VoiceBridge {
  constructor({ fluxerGw, pool, announcer, pairs }) {
    this.fluxerGw = fluxerGw
    this.pool = pool
    this.announcer = announcer
    this.pairs = pairs
    this.ignore = new Set([...config.bridge.voiceIgnore, fluxerGw.botUserId, ...pool.botIds].filter(Boolean))
    this.active = new Map()   // fluxerChannelId -> session
    this._activating = new Set()
    this._cooldown = new Map() // fluxerChannelId -> retry-not-before timestamp
    this._evalTimer = null
  }

  start() {
    if (!this.pairs.length) { log.info('no voice pairs, voice bridge idle'); return }
    const kick = () => this._evaluate().catch(e => log.warn(`evaluate: ${e.message}`))
    this.fluxerGw.on('voiceStateUpdate', kick)
    for (const s of this.pool.slots) s.client.on('voiceStateUpdate', kick)
    this._evalTimer = setInterval(kick, 10_000)
    log.info(`voice bridge watching ${this.pairs.length} pair(s) with ${this.pool.slots.length} bot(s)`)
    kick()
  }

  // How many real people are in each side of a pair, and whether that's enough
  // to warrant a bridge.
  _humans(pair) {
    const fl = this.fluxerGw.usersInVoice(pair.fluxerId).filter(id => !this.ignore.has(id))
    const dcCh = this.pool.primary.guild.channels.cache.get(pair.discordId)
    const dc = dcCh ? [...dcCh.members.values()].filter(m => !m.user.bot && !this.ignore.has(m.id)) : []
    const enough = config.bridge.voiceRequireBoth
      ? (fl.length > 0 && dc.length > 0)
      : (fl.length > 0 || dc.length > 0)
    if (fl.length || dc.length) {
      log.debug(`#${pair.name}: fluxer[${fl.join(',')}] discord[${dc.map(m => m.user.username).join(',')}] -> ${enough ? 'bridge' : 'wait'}`)
    }
    return { fl: fl.length, dc: dc.length, enough }
  }

  _discordRoster(pair) {
    const ch = this.pool.primary.guild.channels.cache.get(pair.discordId)
    if (!ch) return []
    return [...ch.members.values()]
      .filter(m => !m.user.bot && !this.ignore.has(m.id))
      .map(m => m.displayName || m.user.username)
  }

  // Post / update / clear the "who is here from Discord" message + bot nickname.
  _scheduleRoster(session) {
    if (!config.bridge.voiceShowDiscordHere) return
    if (session._rosterTimer) return
    session._rosterTimer = setTimeout(() => {
      session._rosterTimer = null
      this._refreshRoster(session).catch(e => log.debug(`roster: ${e.message}`))
    }, 2000)
  }

  async _refreshRoster(session) {
    if (!this.active.has(session.pair.fluxerId)) return
    const names = this._discordRoster(session.pair)
    const key = names.join('|')
    if (key === session._rosterKey) return
    session._rosterKey = key

    const body = names.length
      ? `🎧 **Here from Discord:** ${names.join(', ')}`
      : '🎧 Discord side is empty right now.'
    try {
      if (session._rosterMsg) {
        await fluxerRest.editMessage(session._rosterMsg.channelId, session._rosterMsg.id, { content: body })
      } else {
        const chId = session._rosterChannelId || session.pair.fluxerId
        const msg = await fluxerRest.postMessage(chId, { content: body })
        if (msg?.id) session._rosterMsg = { channelId: chId, id: msg.id }
      }
    } catch (e) {
      // Voice channel might not accept messages; fall back to the announce
      // channel once, if one is configured.
      if (!session._rosterMsg && !session._rosterChannelId && this._announceFluxerChannelId()) {
        session._rosterChannelId = this._announceFluxerChannelId()
        session._rosterKey = null
        return this._refreshRoster(session)
      }
      log.debug(`roster post failed for #${session.pair.name}: ${e.message}`)
    }

    // Nickname: only when this is the single active bridge.
    if (config.bridge.voiceRosterNick) {
      const nick = this.active.size === 1 ? compactNick(names) : ''
      if (nick !== this._nick) { this._nick = nick; fluxerRest.setSelfNick(nick) }
    }
  }

  _announceFluxerChannelId() {
    return this.announcer?.flChannelId || null
  }

  async _evaluate() {
    // 1. idle-check active sessions + keep their Discord roster fresh
    for (const session of this.active.values()) {
      const { enough } = this._humans(session.pair)
      if (!enough && !session.idleTimer) {
        session.idleTimer = setTimeout(() => this._teardown(session.pair.fluxerId).catch(() => {}), config.bridge.voiceIdleLeaveMs)
      } else if (enough && session.idleTimer) {
        clearTimeout(session.idleTimer); session.idleTimer = null
      }
      this._scheduleRoster(session)
    }

    // 2. bring up any pair that has people on both sides and isn't bridged yet
    const now = Date.now()
    for (const pair of this.pairs) {
      if (this.active.has(pair.fluxerId) || this._activating.has(pair.fluxerId)) continue
      if ((this._cooldown.get(pair.fluxerId) || 0) > now) continue
      if (!this._humans(pair).enough) continue
      const slot = this.pool.acquire(pair)
      if (!slot) { this.announcer?.bridgeBusy(pair, this.pool.slots.length); log.warn(`all ${this.pool.slots.length} bot(s) busy, cannot bridge #${pair.name}`); continue }
      await this._activate(pair, slot)
    }
  }

  async _activate(pair, slot) {
    this._activating.add(pair.fluxerId)
    log.info(`activating voice bridge on "${pair.name}" (bot ${slot.client.user.tag})`)
    const fl = new FluxerVoice(this.fluxerGw, { guildId: config.fluxer.guildId, channelId: pair.fluxerId })
    let dcChannel
    try {
      dcChannel = await slot.guild.channels.fetch(pair.discordId)
    } catch (e) {
      log.error(`fetch discord channel #${pair.name}: ${e.message}`)
      this.pool.release(slot); this._activating.delete(pair.fluxerId); return
    }
    const dc = new DiscordVoice(dcChannel)
    const session = { pair, slot, fl, dc, clock: null, pending: new Map(), idleTimer: null }

    const bail = where => async () => {
      if (this.active.get(pair.fluxerId) !== session) return
      log.warn(`voice: ${where} side closed on #${pair.name}, tearing down`)
      await this._teardown(pair.fluxerId)
    }
    fl.on('closed', bail('fluxer'))
    dc.on('closed', bail('discord'))

    try {
      await fl.connect()
      await dc.join()
    } catch (e) {
      log.error(`voice activate #${pair.name} failed: ${e.message}, 60s cooldown`)
      try { await dc.destroy() } catch {}
      try { await fl.destroy() } catch {}
      this._cooldown.set(pair.fluxerId, Date.now() + 60_000)
      this.pool.release(slot); this._activating.delete(pair.fluxerId); return
    }
    this._cooldown.delete(pair.fluxerId)

    // Fluxer mix -> Discord
    fl.on('frame', frame => {
      try { session.dc.writeOut(Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength)) } catch {}
    })
    // Discord per-user -> accumulate; 20ms clock mixes -> Fluxer
    dc.on('pcm', ({ userId, chunk }) => {
      const prev = session.pending.get(userId)
      session.pending.set(userId, prev ? Buffer.concat([prev, chunk]) : chunk)
    })
    session.clock = setInterval(() => {
      const mix = new Int16Array(FRAME_SAMPLES)
      let any = false
      for (const [uid, buf] of session.pending) {
        if (buf.length < FRAME_BYTES) continue
        any = true
        const view = new Int16Array(buf.buffer, buf.byteOffset, FRAME_SAMPLES)
        for (let i = 0; i < mix.length; i++) {
          const v = mix[i] + view[i]
          mix[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v
        }
        const rest = buf.subarray(FRAME_BYTES)
        if (rest.length) session.pending.set(uid, Buffer.from(rest))
        else session.pending.delete(uid)
      }
      if (any) session.fl.pushFrame(mix)
    }, 20)

    this.active.set(pair.fluxerId, session)
    this._activating.delete(pair.fluxerId)
    this.announcer?.bridgeUp(pair)
    this._refreshRoster(session).catch(() => {})
    log.info(`voice bridge up on "${pair.name}"`)
  }

  async _teardown(fluxerChannelId) {
    const session = this.active.get(fluxerChannelId)
    if (!session) return
    this.active.delete(fluxerChannelId)
    if (session.idleTimer) clearTimeout(session.idleTimer)
    if (session._rosterTimer) clearTimeout(session._rosterTimer)
    if (session.clock) clearInterval(session.clock)
    if (session._rosterMsg) {
      fluxerRest.deleteMessage(session._rosterMsg.channelId, session._rosterMsg.id).catch(() => {})
    }
    try { await session.dc.destroy() } catch {}
    try { await session.fl.destroy() } catch {}
    this.pool.release(session.slot)
    this.announcer?.bridgeDown(session.pair)
    log.info(`voice bridge left "${session.pair.name}"`)
    // Drop / recompute the nickname now that a bridge ended.
    if (config.bridge.voiceRosterNick) {
      const only = this.active.size === 1 ? [...this.active.values()][0] : null
      const nick = only ? compactNick(this._discordRoster(only.pair)) : ''
      if (nick !== this._nick) { this._nick = nick; fluxerRest.setSelfNick(nick) }
    }
    setTimeout(() => this._evaluate().catch(() => {}), 1000)
  }

  async stop() {
    if (this._evalTimer) clearInterval(this._evalTimer)
    for (const id of [...this.active.keys()]) await this._teardown(id)
  }
}
