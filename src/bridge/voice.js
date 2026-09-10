import { config } from '../config.js'
import { FluxerVoice } from '../fluxer/voice.js'
import { DiscordVoice } from '../discord/voice.js'
import { logger } from '../log.js'

const log = logger('voice')
const FRAME_SAMPLES = 960 * 2      // 20ms stereo
const FRAME_BYTES = FRAME_SAMPLES * 2

// Orchestrates voice bridges across a pool of Discord bots. Each bot can hold
// one Discord voice channel; the shared Fluxer bot can hold many LiveKit rooms
// at once. So N Discord tokens => up to N paired voice channels bridged
// simultaneously — the bridge follows whichever pairs have people in them.
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
    if (!this.pairs.length) { log.info('no voice pairs — voice bridge idle'); return }
    const kick = () => this._evaluate().catch(e => log.warn(`evaluate: ${e.message}`))
    this.fluxerGw.on('voiceStateUpdate', kick)
    for (const s of this.pool.slots) s.client.on('voiceStateUpdate', kick)
    this._evalTimer = setInterval(kick, 10_000)
    log.info(`voice bridge watching ${this.pairs.length} pair(s) with ${this.pool.slots.length} bot(s)`)
    kick()
  }

  _humans(pair) {
    const fl = this.fluxerGw.usersInVoice(pair.fluxerId).filter(id => !this.ignore.has(id))
    const dcCh = this.pool.primary.guild.channels.cache.get(pair.discordId)
    const dc = dcCh ? [...dcCh.members.values()].filter(m => !m.user.bot && !this.ignore.has(m.id)) : []
    return fl.length + dc.length
  }

  async _evaluate() {
    // 1. idle-check active sessions
    for (const session of this.active.values()) {
      const n = this._humans(session.pair)
      if (n === 0 && !session.idleTimer) {
        session.idleTimer = setTimeout(() => this._teardown(session.pair.fluxerId).catch(() => {}), config.bridge.voiceIdleLeaveMs)
      } else if (n > 0 && session.idleTimer) {
        clearTimeout(session.idleTimer); session.idleTimer = null
      }
    }

    // 2. bring up any pair that has people and isn't bridged yet
    const now = Date.now()
    for (const pair of this.pairs) {
      if (this.active.has(pair.fluxerId) || this._activating.has(pair.fluxerId)) continue
      if ((this._cooldown.get(pair.fluxerId) || 0) > now) continue
      if (this._humans(pair) === 0) continue
      const slot = this.pool.acquire(pair)
      if (!slot) { this.announcer?.bridgeBusy(pair, this.pool.slots.length); log.warn(`all ${this.pool.slots.length} bot(s) busy — cannot bridge #${pair.name}`); continue }
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
      log.warn(`voice: ${where} side closed on #${pair.name} — tearing down`)
      await this._teardown(pair.fluxerId)
    }
    fl.on('closed', bail('fluxer'))
    dc.on('closed', bail('discord'))

    try {
      await fl.connect()
      await dc.join()
    } catch (e) {
      log.error(`voice activate #${pair.name} failed: ${e.message} — 60s cooldown`)
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
    log.info(`voice bridge up on "${pair.name}"`)
  }

  async _teardown(fluxerChannelId) {
    const session = this.active.get(fluxerChannelId)
    if (!session) return
    this.active.delete(fluxerChannelId)
    if (session.idleTimer) clearTimeout(session.idleTimer)
    if (session.clock) clearInterval(session.clock)
    try { await session.dc.destroy() } catch {}
    try { await session.fl.destroy() } catch {}
    this.pool.release(session.slot)
    this.announcer?.bridgeDown(session.pair)
    log.info(`voice bridge left "${session.pair.name}"`)
    setTimeout(() => this._evaluate().catch(() => {}), 1000)
  }

  async stop() {
    if (this._evalTimer) clearInterval(this._evalTimer)
    for (const id of [...this.active.keys()]) await this._teardown(id)
  }
}
