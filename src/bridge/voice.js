import { config } from '../config.js'
import { FluxerVoice } from '../fluxer/voice.js'
import { DiscordVoice } from '../discord/voice.js'
import { logger } from '../log.js'

const log = logger('voice')
const FRAME_BYTES = 960 * 2 * 2 // 20ms, stereo, s16  (1920 samples * 2 bytes)

// Orchestrates the one active voice pair. A Discord bot can only sit in one
// voice channel per guild, so the bridge follows whichever paired channel has
// people in it first.
export class VoiceBridge {
  constructor({ fluxerGw, discord, discordGuild, pairs }) {
    this.fluxerGw = fluxerGw
    this.discord = discord
    this.discordGuild = discordGuild
    this.pairs = pairs
    this.ignore = new Set([...config.bridge.voiceIgnore, fluxerGw.botUserId, discord.user.id].filter(Boolean))

    this.active = null          // { pair, fl, dc, clock, pending, idleTimer }
    this._evalTimer = null
  }

  start() {
    if (!this.pairs.length) { log.info('no voice pairs — voice bridge idle'); return }
    const kick = () => this._evaluate().catch(e => log.warn(`evaluate: ${e.message}`))
    this.fluxerGw.on('voiceStateUpdate', kick)
    this.discord.on('voiceStateUpdate', kick)
    this._evalTimer = setInterval(kick, 10_000)
    log.info(`voice bridge watching ${this.pairs.length} pair(s)`)
    kick()
  }

  _humans(pair) {
    const fl = this.fluxerGw.usersInVoice(pair.fluxerId).filter(id => !this.ignore.has(id))
    const dcCh = this.discordGuild.channels.cache.get(pair.discordId)
    const dc = dcCh ? [...dcCh.members.values()].filter(m => !m.user.bot && !this.ignore.has(m.id)) : []
    return { fl: fl.length, dc: dc.length, total: fl.length + dc.length }
  }

  async _evaluate() {
    // Is the active pair still populated?
    if (this.active) {
      const n = this._humans(this.active.pair)
      if (n.total === 0) {
        if (!this.active.idleTimer) {
          this.active.idleTimer = setTimeout(() => this._teardown().catch(() => {}), config.bridge.voiceIdleLeaveMs)
        }
      } else if (this.active.idleTimer) {
        clearTimeout(this.active.idleTimer)
        this.active.idleTimer = null
      }
      return
    }

    // Idle — find a pair with someone in it and bring the bridge up there.
    for (const pair of this.pairs) {
      if (this._humans(pair).total > 0) {
        await this._activate(pair)
        return
      }
    }
  }

  async _activate(pair) {
    if (this.active) return
    log.info(`activating voice bridge on "${pair.name}"`)
    const flCh = { guildId: config.fluxer.guildId, channelId: pair.fluxerId }
    const fl = new FluxerVoice(this.fluxerGw, flCh)
    const dcCh = await this.discordGuild.channels.fetch(pair.discordId)
    const dc = new DiscordVoice(dcCh)

    const state = { pair, fl, dc, clock: null, pending: new Map(), idleTimer: null }
    this.active = state

    const bail = where => async () => {
      if (this.active !== state) return
      log.warn(`voice: ${where} closed — tearing down`)
      await this._teardown()
    }
    fl.on('closed', bail('fluxer'))
    dc.on('closed', bail('discord'))

    try {
      await fl.connect()
      await dc.join()
    } catch (e) {
      log.error(`voice activate failed: ${e.message}`)
      await this._teardown()
      return
    }

    // Fluxer mixed audio -> Discord
    fl.on('frame', frame => {
      try {
        const buf = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength)
        dc.writeOut(buf)
      } catch {}
    })

    // Discord per-user audio -> accumulate, then a 20ms clock mixes -> Fluxer
    dc.on('pcm', ({ userId, chunk }) => {
      const prev = state.pending.get(userId)
      state.pending.set(userId, prev ? Buffer.concat([prev, chunk]) : chunk)
    })
    state.clock = setInterval(() => {
      const mix = new Int16Array(FRAME_BYTES / 2)
      let any = false
      for (const [uid, buf] of state.pending) {
        if (buf.length < FRAME_BYTES) continue
        any = true
        const view = new Int16Array(buf.buffer, buf.byteOffset, FRAME_BYTES / 2)
        for (let i = 0; i < mix.length; i++) {
          let v = mix[i] + view[i]
          mix[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v
        }
        const rest = buf.subarray(FRAME_BYTES)
        if (rest.length) state.pending.set(uid, Buffer.from(rest))
        else state.pending.delete(uid)
      }
      if (any) fl.pushFrame(mix)
    }, 20)

    log.info(`voice bridge up on "${pair.name}"`)
    this._evaluate().catch(() => {})
  }

  async _teardown() {
    const state = this.active
    if (!state) return
    this.active = null
    if (state.idleTimer) clearTimeout(state.idleTimer)
    if (state.clock) clearInterval(state.clock)
    try { await state.dc.destroy() } catch {}
    try { await state.fl.destroy() } catch {}
    log.info(`voice bridge left "${state.pair.name}"`)
    // Someone may already be waiting in another pair.
    setTimeout(() => this._evaluate().catch(() => {}), 1000)
  }

  async stop() {
    if (this._evalTimer) clearInterval(this._evalTimer)
    await this._teardown()
  }
}
