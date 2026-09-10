const env = process.env

function required(name) {
  const v = env[name]
  if (!v || !v.trim()) throw new Error(`Missing required env var ${name}`)
  return v.trim()
}

// "name=discordId, name2=discordId2" or "fluxerName:discordName, …"
function parseOverrides(raw) {
  const out = []
  for (const pair of String(raw || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const m = pair.match(/^(.+?)\s*[:=]\s*(.+)$/)
    if (m) out.push({ fluxer: m[1].trim(), discord: m[2].trim() })
  }
  return out
}

const fluxerOrigin = required('FLUXER_ORIGIN').replace(/\/$/, '')

// One or more Discord bot tokens. The first runs the text bridge + announcements;
// the rest are a voice pool so concurrent voice channels can each get a bridge.
const discordTokens = (env.DISCORD_BOT_TOKENS || env.DISCORD_BOT_TOKEN || '')
  .split(',').map(s => s.trim()).filter(Boolean)
if (!discordTokens.length) throw new Error('Missing DISCORD_BOT_TOKENS (or DISCORD_BOT_TOKEN)')

export const config = {
  fluxer: {
    origin: fluxerOrigin,
    apiBase: `${fluxerOrigin}/api/v1`,
    botToken: required('FLUXER_BOT_TOKEN'),
    guildId: required('FLUXER_GUILD_ID'),
    // LiveKit signalling override (mirrors the DJ bot's escape hatch).
    livekitEndpointOverride: env.LIVEKIT_ENDPOINT_OVERRIDE || null,
  },

  discord: {
    botTokens: discordTokens,
    botToken: discordTokens[0],
    guildId: required('DISCORD_GUILD_ID'),
  },

  bridge: {
    // Auto-pair text/voice channels that share a (normalised) name on both
    // sides. These override or add to that.
    overrides: parseOverrides(env.CHANNEL_OVERRIDES),
    // Channel names to never bridge (comma-separated, matched loosely).
    exclude: String(env.CHANNEL_EXCLUDE || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    // Sync message edits / deletes across the bridge.
    syncEdits: env.SYNC_EDITS !== 'false',
    syncDeletes: env.SYNC_DELETES !== 'false',
    // Prefix the webhook display name so bridged users are visibly remote.
    tagFluxer: env.TAG_FLUXER ?? '',            // e.g. " (Fluxer)"
    tagDiscord: env.TAG_DISCORD ?? '',          // e.g. " (Discord)"
    // Voice bridge on/off, and how long a voice channel must be idle before the
    // bridge leaves.
    voice: env.VOICE_BRIDGE !== 'false',
    voiceIdleLeaveMs: Number(env.VOICE_IDLE_LEAVE_MS || 20_000),
    // Only bridge a voice channel while there is at least one real person on
    // BOTH sides. Set false to bridge as soon as either side has someone.
    voiceRequireBoth: env.VOICE_REQUIRE_BOTH !== 'false',
    // Bot user ids (either side) that shouldn't count as "someone in the
    // channel", e.g. the DJ / SC-tools bots. Comma-separated.
    voiceIgnore: String(env.VOICE_IGNORE_IDS || '').split(',').map(s => s.trim()).filter(Boolean),

    // Post "X joined / left voice #channel" lines. ANNOUNCE_CHANNEL is a
    // channel name resolved on each side; ANNOUNCE_TO picks where they go.
    announceChannel: (env.ANNOUNCE_CHANNEL || '').trim(),
    announceTo: ['both', 'fluxer', 'discord'].includes(env.ANNOUNCE_TO) ? env.ANNOUNCE_TO : 'both',
    announceJoins: env.ANNOUNCE_JOINS !== 'false',
    announceLeaves: env.ANNOUNCE_LEAVES !== 'false',
    announceBridge: env.ANNOUNCE_BRIDGE !== 'false', // "bridge now covering #x"
  },

  userAgent: env.USER_AGENT || 'fightersguild-crosstalk (+https://github.com/RadSoloCup/fightersguild-crosstalk)',
}

export function normaliseName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^[#🔊🔈📢·•\s]+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
