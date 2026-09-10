import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { config } from '../config.js'
import { fluxerRest } from './rest.js'
import { logger } from '../log.js'

const log = logger('fluxer-gw')

const OP = {
  DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, VOICE_STATE_UPDATE: 4, RESUME: 6,
  RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11,
}

export const randomId = () => randomBytes(12).toString('hex')

// Fluxer gateway: message events for the text bridge, voice state + voice
// server events for the voice bridge.
export class FluxerGateway extends EventEmitter {
  constructor() {
    super()
    this.ws = null
    this.seq = null
    this.sessionId = null
    this.resumeUrl = null
    this.hbTimer = null
    this.awaitingAck = false
    this.reconnectDelay = 1000
    this.botUserId = null
    this.closed = false
    this.connected = false
    // userId -> { guildId, channelId, connectionId }
    this.voiceStates = new Map()
  }

  get isReady() { return this.connected && this.ws?.readyState === 1 }

  async start() { this.closed = false; await this._connect() }
  stop() { this.closed = true; this._clearHb(); try { this.ws?.close(1000) } catch {} }

  // op 4. channelId null + connectionId leaves.
  updateVoiceState({ guildId, channelId, connectionId = null, mutationId = null }) {
    this._send(OP.VOICE_STATE_UPDATE, {
      guild_id: guildId ?? null,
      channel_id: channelId ?? null,
      connection_id: connectionId,
      self_mute: false, self_deaf: false, self_video: false, self_stream: false,
      ...(mutationId ? { mutation_id: mutationId } : {}),
    })
  }

  async _connect(resume = false) {
    let base
    try {
      base = resume && this.resumeUrl ? this.resumeUrl : await fluxerRest.gatewayUrl()
    } catch (e) {
      log.warn(`gateway lookup failed (${e.message}); retry in 15s`)
      return void setTimeout(() => this._connect(), 15_000)
    }
    const url = `${base}${base.includes('?') ? '&' : '?'}v=1&encoding=json`
    log.info(`connecting ${resume ? '(resume) ' : ''}${base}`)
    const ws = new WebSocket(url)
    this.ws = ws
    ws.addEventListener('message', ev => this._onMessage(ev.data, resume))
    ws.addEventListener('error', () => {})
    ws.addEventListener('close', ev => {
      this._clearHb()
      this.connected = false
      if (this.closed) return
      const fatal = [4004, 4010, 4011, 4012, 4013, 4014].includes(ev.code)
      log.warn(`socket closed ${ev.code} ${ev.reason || ''}${fatal ? ', FATAL' : ''}`)
      if (fatal) return void this.emit('fatal', ev.code)
      const delay = Math.min(this.reconnectDelay, 30_000)
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000)
      setTimeout(() => this._connect(!!this.sessionId), delay + Math.random() * 500)
    })
  }

  _onMessage(raw, wasResume) {
    let msg
    try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) } catch { return }
    if (msg.s != null) this.seq = msg.s
    switch (msg.op) {
      case OP.HELLO:
        this._startHb(msg.d.heartbeat_interval)
        if (wasResume && this.sessionId) {
          this._send(OP.RESUME, { token: config.fluxer.botToken, session_id: this.sessionId, seq: this.seq })
        } else this._identify()
        break
      case OP.HEARTBEAT: this._send(OP.HEARTBEAT, this.seq); break
      case OP.HEARTBEAT_ACK: this.awaitingAck = false; break
      case OP.INVALID_SESSION:
        this.sessionId = null
        setTimeout(() => this._identify(), 1500 + Math.random() * 3000)
        break
      case OP.RECONNECT: try { this.ws.close(4900) } catch {}; break
      case OP.DISPATCH: this._onDispatch(msg.t, msg.d); break
    }
  }

  _onDispatch(type, d) {
    switch (type) {
      case 'READY':
        this.reconnectDelay = 1000
        this.connected = true
        this.sessionId = d.session_id || this.sessionId
        this.resumeUrl = d.resume_gateway_url || this.resumeUrl
        this.botUserId = d.user?.id ?? this.botUserId
        this._seedVoice(d.guilds || [])
        log.info(`READY as ${d.user?.username} (${this.botUserId})`)
        this.emit('ready', d)
        break
      case 'RESUMED': this.connected = true; break
      case 'GUILD_CREATE': this._seedVoice([d]); this.emit('guildCreate', d); break
      case 'MESSAGE_CREATE': this.emit('messageCreate', d); break
      case 'MESSAGE_UPDATE': this.emit('messageUpdate', d); break
      case 'MESSAGE_DELETE': this.emit('messageDelete', d); break
      case 'MESSAGE_DELETE_BULK': this.emit('messageDeleteBulk', d); break
      case 'VOICE_STATE_UPDATE': this._trackVoice(d); this.emit('voiceStateUpdate', d); break
      case 'VOICE_SERVER_UPDATE': this.emit('voiceServerUpdate', d); break
      case 'VOICE_STATE_ACK': this.emit('voiceStateAck', d); break
    }
  }

  _seedVoice(guilds) {
    for (const g of guilds)
      for (const vs of g.voice_states || [])
        this._trackVoice({ ...vs, guild_id: vs.guild_id ?? g.id })
  }

  _trackVoice(vs) {
    if (!vs?.user_id) return
    if (!vs.channel_id) { this.voiceStates.delete(vs.user_id); return }
    this.voiceStates.set(vs.user_id, {
      guildId: vs.guild_id ?? null,
      channelId: vs.channel_id,
      connectionId: vs.connection_id ?? null,
    })
  }

  // userIds currently in a given voice channel (excluding bots we know about).
  usersInVoice(channelId) {
    const ids = []
    for (const [uid, s] of this.voiceStates) if (s.channelId === channelId) ids.push(uid)
    return ids
  }

  _identify() {
    this._send(OP.IDENTIFY, {
      token: config.fluxer.botToken,
      properties: { os: process.platform, browser: 'fightersguild-crosstalk', device: 'fightersguild-crosstalk' },
      presence: { status: 'online', afk: false },
      ignored_events: ['TYPING_START', 'PRESENCE_UPDATE', 'CHANNEL_PINS_UPDATE',
        'MESSAGE_REACTION_ADD', 'MESSAGE_REACTION_REMOVE',
        'GUILD_MEMBER_ADD', 'GUILD_MEMBER_UPDATE', 'GUILD_MEMBER_REMOVE'],
    })
  }

  _startHb(interval) {
    this._clearHb()
    setTimeout(() => { this._beat(); this.hbTimer = setInterval(() => this._beat(), interval) }, interval * Math.random())
  }
  _beat() {
    if (this.awaitingAck) { try { this.ws.close(4900) } catch {}; return }
    this.awaitingAck = true
    this._send(OP.HEARTBEAT, this.seq)
  }
  _clearHb() { if (this.hbTimer) clearInterval(this.hbTimer); this.hbTimer = null; this.awaitingAck = false }

  _send(op, d) {
    try { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ op, d })) }
    catch (e) { log.warn(`send failed (op ${op}): ${e.message}`) }
  }
}
