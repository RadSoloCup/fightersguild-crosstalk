# Fighters Guild Crosstalk

A two way bridge between a self hosted
[Fluxer](https://github.com/fluxerapp/fluxer) server and a Discord server. It
mirrors text channels and relays live voice, so a guild split across both
platforms can talk as one.

Part of the Fighters Guild toolset alongside the
[desktop client](https://github.com/RadSoloCup/fightersguild-app),
[Portal](https://github.com/RadSoloCup/fightersguild-portal),
[Star Citizen tools](https://github.com/RadSoloCup/fightersguild-sc-tools), and
[DJ bot](https://github.com/RadSoloCup/fightersguild-dj).

## What it does

- **Text sync.** Messages in paired channels are mirrored both ways. Each one is
  posted under the original author's name and avatar through a webhook, so it
  reads as the real person, not a bot. Edits and deletes follow. Attachments are
  carried as links.
- **Voice bridge.** When someone joins a paired voice channel on either side, a
  bot joins both and relays mixed audio between them. Run more than one Discord
  bot token and concurrent voice channels each get their own bridge.
- **Presence announcements.** An optional channel gets lines like "Alice joined
  #operations, Fluxer" and "Bob left voice, Discord", plus a note when the voice
  bridge picks a channel up or lets it go.

Channels are paired automatically when they share a name on both sides
(case, spacing, and emoji are ignored). Odd pairs go in `CHANNEL_OVERRIDES`,
channels to skip go in `CHANNEL_EXCLUDE`.

---

## How it works

### Text

A gateway connection to Fluxer and a `discord.js` client watch both sides. Each
paired channel gets a bridge owned webhook on each platform. A message on one
side is re posted through the other side's webhook with the sender's display name
and avatar. The originating `webhook_id` on each message is how the bridge
ignores its own echoes. A bounded in memory id map lets edits and deletes find
their copy on the far side.

### Voice

Fluxer voice is LiveKit. The bridge joins with `@livekit/rtc-node`, subscribes to
every other participant, and mixes them. Discord voice uses `@discordjs/voice`
(with the DAVE end to end encryption module), decodes each speaker, and mixes
them. The two mixes are piped to each other, at 48 kHz both ways.

A Discord bot can only sit in one voice channel per server, but one Fluxer bot
can hold several LiveKit rooms at once. So the voice pool is N Discord tokens
(`DISCORD_BOT_TOKENS`) plus the single Fluxer bot. Each paired voice channel that
fills up claims a free Discord bot. When every bot is busy an extra active
channel is announced but not bridged until one frees up. A channel is released
when both sides have been empty for `VOICE_IDLE_LEAVE_MS`.

> If one person is in the same call on both apps at once they will hear
> themselves, because the bridge cannot tell it is the same human. Use one app
> per call.

---

## Running it

You need a bot account on each side, both in the same named channels.

### Fluxer bot

Create a bot in the chat server's settings, then invite it to the guild with
View Channels, Send Messages, Embed Links, Attach Files, Read Message History,
Manage Webhooks, Connect, Speak, and Use Voice Activity:

```
<origin>/api/v1/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=573688832&guild_id=<GUILD_ID>
```

### Discord bots

Create an application at <https://discord.com/developers>, add a bot, and enable
the Message Content Intent. Invite it with the same permission set:

```
https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=573688832
```

For concurrent voice channels, repeat for a second or third application and put
every token in `DISCORD_BOT_TOKENS`, comma separated. The first token runs the
text bridge and the announcements, the rest are voice workers.

### Config and start

```bash
cp .env.example crosstalk.env    # fill in tokens and guild ids
docker compose up -d --build
```

See `.env.example` for every option. It runs as one container on the Fluxer
stack's host with host networking, so the LiveKit voice path works the same way
the DJ bot's does.

---

## Layout

```
src/
  index.js              boot: connect both sides, build the map, start the bridges
  config.js  log.js
  fluxer/
    gateway.js           receive only Fluxer gateway (messages plus voice state)
    rest.js              Fluxer REST: channels, webhooks, webhook execution
    voice.js             LiveKit connect, publish, subscribe, mix
  discord/
    index.js             discord.js client and webhook helpers
    pool.js              N bot connections, the voice worker pool
    voice.js             @discordjs/voice join, play, receive
  bridge/
    channelMap.js         name match text and voice channels
    text.js               two way message, edit, and delete sync
    voice.js              pool aware voice orchestrator
    announce.js           voice join and leave, plus bridge status lines
    idMap.js              bounded bidirectional message id map
```

## Credits

| Project | Use | License |
|---|---|---|
| [discord.js](https://discord.js.org) and [@discordjs/voice](https://github.com/discordjs/discord.js/tree/main/packages/voice) | Discord gateway and voice | Apache-2.0 |
| [@snazzah/davey](https://github.com/snazzah/davey) | Discord DAVE end to end voice encryption | MIT |
| [@livekit/rtc-node](https://github.com/livekit/node-sdks) | Fluxer (LiveKit) voice | Apache-2.0 |
| [prism-media](https://github.com/discordjs/prism-media), [opusscript](https://github.com/abalabahaha/opusscript) | Opus decode | MIT |
| [Fluxer](https://github.com/fluxerapp/fluxer) | the chat server this bridges | AGPL-3.0 |

Discord is a trademark of Discord Inc. This project is not affiliated with or
endorsed by Discord.

## License

Copyright &copy; 2026 Fighters Guild.

GNU Affero General Public License v3.0 or later, see [LICENSE](LICENSE). If you
run a modified copy as a network service, you must offer its users the source of
your version.
