import { EventEmitter } from 'node:events'
import {
  AudioFrame, AudioSource, AudioStream, AudioMixer,
  LocalAudioTrack, Room, RoomEvent, TrackPublishOptions, TrackKind, TrackSource,
} from '@livekit/rtc-node'
import { config } from '../config.js'
import { randomId } from './gateway.js'
import { logger } from '../log.js'

const log = logger('fluxer-voice')
const RATE = 48_000
const CH = 2
const SAMPLES = (RATE * 20) / 1000 // 960 per channel per 20ms

// A live connection to one Fluxer (LiveKit) voice channel.
//  - .source     an AudioSource — push Discord audio into Fluxer with pushFrame()
//  - emits 'frame' (AudioFrame) — mixed audio of every *other* participant
export class FluxerVoice extends EventEmitter {
  constructor(gateway, { guildId, channelId }) {
    super()
    this.gw = gateway
    this.guildId = guildId
    this.channelId = channelId
    this.connectionId = null
    this.room = null
    this.source = null
    this.track = null
    this.mixer = null
    this._streams = new Map() // trackSid -> AudioStream
    this._pumpAbort = null
    this._destroyed = false
  }

  async connect() {
    const mutationId = randomId()
    const grant = await this._handshake(mutationId)
    this.connectionId = grant.connection_id
    const endpoint = config.fluxer.livekitEndpointOverride || grant.endpoint
    log.info(`connecting LiveKit ${endpoint} (conn ${this.connectionId})`)

    const room = new Room()
    this.room = room
    room.on(RoomEvent.Disconnected, () => { if (!this._destroyed) this.emit('closed') })
    room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => this._onTrack(track, pub, participant))
    room.on(RoomEvent.TrackUnsubscribed, (track, pub) => this._dropStream(pub?.sid))

    await room.connect(endpoint, grant.token, { autoSubscribe: true, dynacast: false })

    this.source = new AudioSource(RATE, CH)
    this.track = LocalAudioTrack.createAudioTrack('bridge', this.source)
    const opts = new TrackPublishOptions()
    opts.source = TrackSource.SOURCE_MICROPHONE
    await room.localParticipant.publishTrack(this.track, opts)

    this.mixer = new AudioMixer(RATE, CH, { blocksize: SAMPLES })
    this._startPump()
    log.info('connected — track published, mixing remote audio')
  }

  // Feed one 20ms stereo s16 frame (Int16Array of 1920) toward Fluxer.
  async pushFrame(int16) {
    if (!this.source || this._destroyed) return
    try { await this.source.captureFrame(new AudioFrame(int16, RATE, CH, int16.length / CH)) }
    catch (e) { log.debug(`pushFrame: ${e.message}`) }
  }

  _onTrack(track, pub, participant) {
    if (track.kind !== TrackKind.KIND_AUDIO) return
    // Never mix our own published track back out.
    if (participant?.identity && this.room?.localParticipant?.identity &&
        participant.identity === this.room.localParticipant.identity) return
    const sid = pub?.sid || participant?.identity + ':' + (pub?.trackName || 'a')
    if (this._streams.has(sid)) return
    const stream = new AudioStream(track, RATE, CH)
    this._streams.set(sid, stream)
    this.mixer?.addStream(stream)
    log.debug(`mixing participant ${participant?.identity} (${this._streams.size} streams)`)
  }

  _dropStream(sid) {
    const s = sid && this._streams.get(sid)
    if (!s) return
    try { this.mixer?.removeStream(s) } catch {}
    this._streams.delete(sid)
  }

  async _startPump() {
    const abort = { stop: false }
    this._pumpAbort = abort
    try {
      for await (const frame of this.mixer) {
        if (abort.stop || this._destroyed) break
        this.emit('frame', frame)
      }
    } catch (e) {
      if (!this._destroyed) log.warn(`mixer pump ended: ${e.message}`)
    }
  }

  _handshake(mutationId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('timed out waiting for VOICE_SERVER_UPDATE')) }, 15_000)
      const onServer = d => { if (d.channel_id !== this.channelId) return; cleanup(); resolve(d) }
      const onAck = d => {
        if (d.mutation_id !== mutationId) return
        if (d.status === 'rejected') { cleanup(); reject(new Error(d.error_code || d.error_message || 'voice state rejected')) }
      }
      const cleanup = () => {
        clearTimeout(timer)
        this.gw.off('voiceServerUpdate', onServer)
        this.gw.off('voiceStateAck', onAck)
      }
      this.gw.on('voiceServerUpdate', onServer)
      this.gw.on('voiceStateAck', onAck)
      this.gw.updateVoiceState({ guildId: this.guildId, channelId: this.channelId, mutationId })
    })
  }

  async destroy() {
    if (this._destroyed) return
    this._destroyed = true
    if (this._pumpAbort) this._pumpAbort.stop = true
    try { await this.mixer?.aclose() } catch {}
    if (this.connectionId) {
      try { this.gw.updateVoiceState({ guildId: this.guildId, channelId: null, connectionId: this.connectionId }) } catch {}
    }
    try { await this.track?.close() } catch {}
    try { await this.room?.disconnect() } catch {}
    this.room = this.source = this.track = this.mixer = null
    this._streams.clear()
  }
}
