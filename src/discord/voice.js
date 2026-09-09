import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import prism from 'prism-media'
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType,
  EndBehaviorType, VoiceConnectionStatus, entersState, NoSubscriberBehavior,
} from '@discordjs/voice'
import { logger } from '../log.js'

const log = logger('discord-voice')
const RATE = 48_000
const CH = 2

// A live connection to one Discord voice channel.
//  - playStream(readable): pipe s16le 48k stereo PCM in (Fluxer -> Discord)
//  - emits 'pcm' { userId, chunk } : decoded s16le 48k stereo (Discord -> Fluxer)
export class DiscordVoice extends EventEmitter {
  constructor(channel) {
    super()
    this.channel = channel
    this.connection = null
    this.player = null
    this._out = null
    this._decoders = new Map() // userId -> { opus, pcm, sub }
    this._destroyed = false
  }

  async join() {
    this.connection = joinVoiceChannel({
      channelId: this.channel.id,
      guildId: this.channel.guild.id,
      adapterCreator: this.channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    })
    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000)

    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } })
    this.connection.subscribe(this.player)
    this._out = new PassThrough()
    const resource = createAudioResource(this._out, { inputType: StreamType.Raw })
    this.player.play(resource)

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ])
      } catch { if (!this._destroyed) this.emit('closed') }
    })

    const receiver = this.connection.receiver
    receiver.speaking.on('start', userId => this._listen(userId))
    log.info(`joined #${this.channel.name}`)
  }

  // Write mixed Fluxer audio out to Discord.
  writeOut(buf) { if (this._out && !this._out.destroyed) this._out.write(buf) }

  _listen(userId) {
    if (this._decoders.has(userId) || this._destroyed) return
    const sub = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
    })
    const opus = new prism.opus.Decoder({ rate: RATE, channels: CH, frameSize: 960 })
    const entry = { sub, opus }
    this._decoders.set(userId, entry)

    sub.pipe(opus)
    opus.on('data', chunk => this.emit('pcm', { userId, chunk }))
    const cleanup = () => {
      if (this._decoders.get(userId) !== entry) return
      this._decoders.delete(userId)
      try { opus.destroy() } catch {}
    }
    sub.on('end', cleanup)
    sub.on('error', cleanup)
    opus.on('error', cleanup)
  }

  destroy() {
    if (this._destroyed) return
    this._destroyed = true
    for (const { sub, opus } of this._decoders.values()) {
      try { sub.destroy() } catch {}
      try { opus.destroy() } catch {}
    }
    this._decoders.clear()
    try { this.player?.stop(true) } catch {}
    try { this._out?.end() } catch {}
    try { this.connection?.destroy() } catch {}
    this.connection = this.player = this._out = null
  }
}
