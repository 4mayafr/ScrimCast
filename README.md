# Scrim Board Bot

Discord bot where people post scrims through a button and form, and a caster claims them with a button.
Every scrim gets its own **private** thread for the poster, the caster and up to 4 co-casters.

## First-time setup (server owner only)
Run `/setup set` and fill in:
- `panel_channel`: where the **Post Scrim** button panel is posted (the bot posts it for you)
- `post_channel`: where scrims are posted for casters to claim
- `thread_channel`: the channel the private scrim threads are created in
- `log_channel`: where scrim activity is logged (scrim posted, claimed, unclaimed, co-caster added/removed, closed)
- `caster_role`: only members with this role can use the **Claim** button (it is also pinged on new scrims)
- `server_log_channel` (optional): a **live server log**. The bot keeps one message in this channel and edits it every minute
  with the bot's status (host, uptime, Discord ping, memory, load, scrim counts, version) and the last 20 console log lines.
  Make it a private/staff-only channel. If the message stops updating, the bot or its host is down.
  Leave the option out when you re-run `/setup set` to keep it. `/setup serverlogs_off` turns it off.

`/setup view` shows the current settings. `/setup panel` posts the panel again if it was deleted.
Running `/setup set` again replaces the old panel. Only the server owner can use `/setup`, and it warns you
if the bot is missing permissions in any of the channels. The channels can be the same one.

## How it works
1. Anyone presses **Post Scrim** on the panel and fills in the form: Team 1, Team 2, When, and optional Notes.
2. The bot posts the scrim in the post channel with **Claim as Caster** / **Unclaim** buttons and creates a
   private thread for it (linked in the scrim message). The poster is added to the thread.
3. A member with the caster role clicks **Claim**. They become the caster (1 per scrim) and are added to the thread.
4. The caster can add up to **4 co-casters** with `/scrim addcocaster`. Co-casters join the thread.
5. Anyone in the thread can run `/scrim ping` to ping everyone in it with a message (server details, lobby code...).
6. When the scrim is over, the poster, the caster or a moderator presses **Close Scrim** in the thread. The scrim
   is marked CLOSED, its buttons are disabled, and the thread is locked and archived.

Everything above is also written to the log channel.

## Commands
- `/setup set panel_channel post_channel thread_channel log_channel caster_role [server_log_channel]`, `/setup serverlogs_off`, `/setup view`, `/setup panel` (server owner only)
- `/scrim addcocaster user [id]` adds a co-caster (max 4). Caster, poster or moderators only
- `/scrim removecocaster user [id]` removes a co-caster
- `/scrim ping message [id]` pings everyone in the thread with your message (10 second cooldown)

### Bot owner commands (work from your phone)
Only the bot's owner (the Discord account that owns the application, or `BOT_OWNER_ID` if you set it) can use these,
in any server or in a DM with the bot. Replies are only visible to you.
- `/admin status` shows uptime, ping, memory, server count and scrim counts
- `/admin logs` shows the most recent log lines
- `/admin update [restart]` runs `git pull` (and `npm install` if dependencies changed). Set `restart` to true to restart afterwards so the new code runs. Only works if the bot was cloned with git
- `/admin restart` restarts the bot (needs pm2 so it comes back by itself)
- `/admin shutdown` turns the bot off. Under pm2 it stays off until you run `pm2 start scrim-bot` again

`id` is the scrim number in the scrim message footer. Leave it out when you run a command inside the scrim's thread.

## Bot permissions
Invite the bot with scopes `bot` + `applications.commands` and these permissions:
View Channels, Send Messages, Embed Links, Read Message History, **Create Private Threads,
Send Messages in Threads, Manage Threads**. Make sure the bot's role has them in the configured channels.
People who post scrims or cast need to be able to see the panel channel and the thread channel.

## Running it
1. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` and `CLIENT_ID` (never commit `.env`).
2. `npm install` then `npm start`.

Optional: `SERVER_LOG_EVERY_MS` changes the live server log refresh time (default 60000). `GUILD_ID` makes slash commands update instantly in one server. `STATUS_TEXT` sets the "Playing ..." status.
`BOT_OWNER_ID` picks who can use `/admin` (default: the application's owner).

## Updating
```
git pull
npm install
pm2 restart scrim-bot
```
Settings and scrims are saved in `data.json` (not in git). After updating from an older version, run `/setup set`
once to choose the panel channel. Scrims posted by older versions keep working.

## Hosting
Run it somewhere with its own IP and keep it on: a Chromebook (Linux), PC or Raspberry Pi with pm2,
or an Oracle Cloud Always Free VM. Shared free hosts such as Render may get blocked or throttled by Discord.
