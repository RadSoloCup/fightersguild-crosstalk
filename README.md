# Fighters Guild Crosstalk

A two-way bridge between a self-hosted **[Fluxer](https://github.com/fluxerapp/fluxer)**
server and a **Discord** server:

- **Text sync** — messages in paired channels are mirrored both ways, each one
  posted under the original author's name and avatar (via webhooks). Edits and
  deletes follow. Attachments are carried as links.
- **Voice bridge** — when someone joins a paired voice channel on either side,
  a bot joins both and relays audio between them. Run more than one Discord bot
  token and concurrent voice channels each get their own bridge.
- **Presence announcements** — an optional channel gets "X joined / left voice
  #channel · Fluxer/Discord" lines, plus a note when the voice bridge picks a
  channel up.

Channels are paired automatically when they share a name on both sides
(case / spacing / emoji-insensitive); odd pairs go in `CHANNEL_OVERRIDES`.

---

## How it works

**Text.** A gateway connection to Fluxer and a `discord.js` client watch both
sides. Each paired channel gets a bridge-owned webhook on each platform; a
message on one side is re-posted through the other side's webhook with the
sender's display name and avatar. The originating `webhook_id` on each message
is how the bridge ignores its own echoes. A bounded in-memory id map lets edits
and deletes find their copy.

**Voice.** Fluxer voice is LiveKit; the bridge joins with `@livekit/rtc-node`,
subscribes to every other participant, and mixes them. Discord voice uses
`@discordjs/voice`; the bridge decodes each speaker and mixes them. The two
mixes are piped to each other.

A Discord bot can only sit in one voice channel per server, but the Fluxer bot
can hold many at once — so the voice pool is `N` Discord tokens (`DISCORD_BOT_TOKENS`)
plus the single Fluxer bot. Each paired voice channel that fills up claims a free
Discord bot; when all bots are busy, an extra active channel is announced but not
bridged until one frees up. A channel is released when both sides are empty for
`VOICE_IDLE_LEAVE_MS`.

> One person joining the **same** conversation on both apps at once will hear
> themselves — the bridge can't tell it's the same human. Pick one app per call.

---

## Running it

Needs a bot account on each side, both in the same-named channels.

### Fluxer bot

Create a bot in Fluxer settings, then invite it to the guild with **View
Channels, Send Messages, Embed Links, Attach Files, Read Message History,
Manage Webhooks, Connect, Speak, Use Voice Activity**:

```
<origin>/api/v1/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=573688832&guild_id=<GUILD_ID>
```

### Discord bot(s)

Create an application at <https://discord.com/developers>, add a bot, and
**enable the Message Content Intent**. Invite it with the same permissions:

```
https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=573688832
```

For concurrent voice channels, repeat for a second (third, …) application and
put every token in `DISCORD_BOT_TOKENS` (comma-separated). The first one runs
the text bridge; the rest are voice workers.

### Config + start

```
cp .env.example crosstalk.env    # fill in tokens + guild ids
docker compose up -d --build
```

See `.env.example` for every option. It runs as one container on the Fluxer
stack's host (host networking, so the LiveKit voice path works the same way the
DJ bot's does).

---

## Layout

```
src/
  index.js              boot: connect both sides, build the map, start the bridges
  config.js  log.js
  fluxer/
    gateway.js           receive-only Fluxer gateway (messages + voice state)
    rest.js              Fluxer REST: channels, webhooks, webhook execution
    voice.js             LiveKit connect / publish / subscribe + mix
  discord/
    index.js             discord.js client + webhook helpers
    pool.js              N bot connections; the voice worker pool
    voice.js             @discordjs/voice join / play / receive
  bridge/
    channelMap.js         name-match text + voice channels
    text.js               two-way message / edit / delete sync
    voice.js              pool-aware voice orchestrator
    announce.js           voice join/leave + bridge-status lines
    idMap.js              bounded bidirectional message-id map
```

## Credits

| Project | Use | License |
| --- | --- | --- |
| [discord.js](https://discord.js.org) / [@discordjs/voice](https://github.com/discordjs/discord.js/tree/main/packages/voice) | Discord gateway + voice | Apache-2.0 |
| [@livekit/rtc-node](https://github.com/livekit/node-sdks) | Fluxer (LiveKit) voice | Apache-2.0 |
| [prism-media](https://github.com/discordjs/prism-media), [opusscript](https://github.com/abalabahaha/opusscript) | Opus decode | MIT |
| [Fluxer](https://github.com/fluxerapp/fluxer) | the chat server this bridges | AGPL-3.0 |

Discord is a trademark of Discord Inc. This project is not affiliated with or
endorsed by Discord.

## License

Copyright © 2026 Fighters Guild

GNU Affero General Public License v3.0 or later — see [LICENSE](LICENSE). If you
run a modified copy as a network service, you must offer its users the source of
your version.
