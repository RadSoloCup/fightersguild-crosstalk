import { config, normaliseName } from '../config.js'
import { logger } from '../log.js'

const log = logger('map')

// Fluxer channel types (Discord-compatible): 0 = text, 2 = voice.
const FLUXER_TEXT = 0
const FLUXER_VOICE = 2

// Build the text and voice channel pairings by matching (normalised) names on
// both sides, then applying the operator overrides.
//
//   fluxerChannels: raw Fluxer guild channel objects
//   discordGuild:   a discord.js Guild
// returns { text: [{ name, fluxerId, discordId }], voice: [...] }
export function buildChannelMap(fluxerChannels, discordGuild) {
  const exclude = new Set(config.bridge.exclude.map(normaliseName))

  const dcText = new Map()
  const dcVoice = new Map()
  for (const ch of discordGuild.channels.cache.values()) {
    if (ch.type === 0) dcText.set(normaliseName(ch.name), ch)          // GuildText
    else if (ch.type === 2) dcVoice.set(normaliseName(ch.name), ch)    // GuildVoice
  }

  const flText = new Map()
  const flVoice = new Map()
  for (const ch of fluxerChannels) {
    if (ch.type === FLUXER_TEXT) flText.set(normaliseName(ch.name), ch)
    else if (ch.type === FLUXER_VOICE) flVoice.set(normaliseName(ch.name), ch)
  }

  const pairUp = (flMap, dcMap, kind) => {
    const pairs = []
    const seen = new Set()

    for (const ov of config.bridge.overrides) {
      const fl = flMap.get(normaliseName(ov.fluxer))
      const dc = dcMap.get(normaliseName(ov.discord)) ?? dcMap.get(ov.discord)
      if (fl && dc) { pairs.push({ name: fl.name, fluxerId: fl.id, discordId: dc.id }); seen.add(normaliseName(fl.name)) }
      else log.warn(`${kind} override "${ov.fluxer}" <-> "${ov.discord}", one side not found`)
    }

    for (const [key, fl] of flMap) {
      if (seen.has(key) || exclude.has(key)) continue
      const dc = dcMap.get(key)
      if (dc) { pairs.push({ name: fl.name, fluxerId: fl.id, discordId: dc.id }); seen.add(key) }
      else log.info(`${kind} "${fl.name}" has no Discord match, not bridged`)
    }
    for (const [key, dc] of dcMap) {
      if (!seen.has(key) && !exclude.has(key)) log.info(`${kind} "${dc.name}" has no Fluxer match, not bridged`)
    }
    return pairs
  }

  const text = pairUp(flText, dcText, 'text')
  const voice = pairUp(flVoice, dcVoice, 'voice')
  log.info(`paired ${text.length} text channel(s), ${voice.length} voice channel(s)`)
  return { text, voice }
}
