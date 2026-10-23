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
- `status_channel` (optional): a channel for **bot status alerts**. The bot posts here when it is:
  overloaded (CPU load, low memory, high Discord ping or stalling for several checks in a row), stopping or restarting
  (`/admin restart`, `/admin update`, `/admin shutdown`, or the host stopping it with `pm2 restart/stop` or a computer shutdown),
  back to normal after an overload, and back online. The "back online" message says why it was away: a planned restart, a crash
  (with the error), or an unclean stop such as power loss or sleep. `/setup statusalerts_off` turns it off.
- `timezone` (optional, e.g. `Australia/Melbourne`): the timezone scrim times are read in (default UTC)
- `server_log_channel` (optional): a **live server log**. The bot keeps one message in this channel and edits it every minute
  with the bot's status (host, uptime, Discord ping, memory, load, scrim counts, version) and the last 20 console log lines.
  Make it a private/staff-only channel. If the message stops updating, the bot or its host is down.
  Leave the option out when you re-run `/setup set` to keep it. `/setup statusalerts_off`, `/setup serverlogs_off` turns it off.

`/setup view` shows the current settings. `/setup panel` posts the panel again if it was deleted.
Running `/setup set` again replaces the old panel. Only the server owner can use `/setup`, and it warns you
if the bot is missing permissions in any of the channels. The channels can be the same one.

## Scrim times, reminders and auto-close
Type the **When** field in one of these ways (read in the server timezone): `2026-10-25 19:00`, `25 Oct 7pm`,
`Oct 25 7:30pm`, `tomorrow 8pm`, or a Discord timestamp like `<t:1761390000>`. The bot replies with how it read the time,
and the scrim shows it in every viewer's own timezone. If the time can't be read the scrim still posts, just without the automation below.
- **Reminders:** the poster, caster and co-casters are pinged in the thread 30 and 5 minutes before the start.
- **Unclaimed alerts:** if nobody has claimed it, the caster role is pinged again in the post channel 60 and 15 minutes before the start.
- **Auto-close:** scrims close automatically 4 hours after the start (48 hours after posting if there's no readable time).
  Change the 4 with `AUTO_CLOSE_HOURS`.

## Editing a scrim
The scrim message has an **Edit** button. The poster or a moderator can change the teams, time and notes in a form that is
pre-filled with the current values. If the time changes, the reminders and alerts are re-armed for the new time. The thread is renamed if the
teams changed, and the poster, caster and co-casters are pinged in the thread with what changed. Closed scrims can't be edited.

## Web dashboard
A read-only page with bot health, open scrims, recently closed scrims, top casters and recent logs. It is **off** unless you set
`DASHBOARD_TOKEN` in `.env` (pick a long random string). It runs on the same port as the bot (`PORT`, default 3000) at `/dashboard`.
Open `http://HOST:3000/dashboard` and type the password (your `DASHBOARD_TOKEN`) into the sign-in form. You stay signed in for 30 days on that browser, and there is a Sign out button. The password is never put in the address or stored in the browser (only a random session code is). Restarting the bot signs everyone out, so you will need to type the password again.
Failed attempts are rate limited. The page is plain HTTP, so don't expose the port to the internet. To reach it from your phone
safely, put the bot's computer and your phone on a private network such as Tailscale, or use a Cloudflare Tunnel, which adds HTTPS.
The page refreshes itself every 30 seconds.

## The /aleisha command
`/aleisha` replies with whatever you put in the `.env` file, so you can change it without touching the code.
Set these in `.env` or with `/admin env_set` (restart afterwards):
- `ALEISHA_MESSAGE`: the reply text (up to 1000 characters). With `/admin env_set` you get a big box and can use line breaks. In the file, write `\n` for a new line. It never pings anyone
- `ALEISHA_IMAGE`: an `https://` image link shown under the message
- `ALEISHA_PRIVATE`: `true` means only the person who used it sees the reply (default: everyone sees it)
- `ALEISHA_DESCRIPTION`: the text Discord shows next to the command (up to 100 characters)
Until `ALEISHA_MESSAGE` or `ALEISHA_IMAGE` is set, it says it isn't customised yet. Message and image changes apply after a restart. The description only updates after the commands are registered again, which happens on every start (restart Discord to see it).

## How it works
1. Anyone presses **Post Scrim** on the panel and fills in the form: Team 1, Team 2, When, and optional Notes.
2. The bot posts the scrim in the post channel with **Claim as Caster** / **Unclaim** buttons and creates a
   private thread for it (linked in the scrim message). The poster is added to the thread.
3. A member with the caster role clicks **Claim**. They become the caster (1 per scrim) and are added to the thread.
4. Members with the caster role can press **Claim as Co-caster** to join as one of up to **4 co-casters**, and they are added to the thread. The caster, poster or a moderator can also add anyone with `/scrim addcocaster`, and remove anyone with `/scrim removecocaster` (for example if someone is causing trouble). A co-caster can leave by pressing **Unclaim**.
5. Anyone in the thread can run `/scrim ping` to ping everyone in it with a message (server details, lobby code...).
6. When the scrim is over, the poster, the caster or a moderator presses **Close Scrim** in the thread. The scrim
   is marked CLOSED, its buttons are disabled, and the thread is locked and archived.

Everything above is also written to the log channel.

## Commands
- `/stats user [user]` shows scrims cast, co-cast and posted. `/stats leaderboard` shows the top 10 casters (only closed scrims that had a caster count)
- `/setup set panel_channel post_channel thread_channel log_channel caster_role [timezone] [status_channel] [server_log_channel]`, `/setup statusalerts_off`, `/setup serverlogs_off`, `/setup view`, `/setup panel` (server owner only)
- `/scrim addcocaster user [id]` adds a co-caster (max 4). Caster, poster or moderators only
- `/scrim removecocaster user [id]` removes a co-caster
- `/scrim ping message [id]` pings everyone in the thread with your message (10 second cooldown)

### Bot owner commands (work from your phone)
Only the bot's owner (the Discord account that owns the application, or `BOT_OWNER_ID` if you set it) can use these,
in any server or in a DM with the bot. Replies are only visible to you.
- `/admin status` shows uptime, ping, memory, server count and scrim counts
- `/admin logs` shows the most recent log lines
- `/admin update [restart]` runs `git pull` (and `npm install` if dependencies changed). Set `restart` to true to restart afterwards so the new code runs. Only works if the bot was cloned with git
- `/admin env_view` shows the settings in the `.env` file (secrets are hidden)
- `/admin env_set key [restart]` changes one setting. A private form opens for the value, so secrets never appear in the channel. Set `restart` to restart afterwards (needs pm2). The old file is kept as `.env.bak`
- `/admin env_unset key [restart]` removes a setting so the default is used again
  Editable: STATUS_TEXT, GUILD_ID, DASHBOARD_TOKEN, AUTO_CLOSE_HOURS and the monitor/overload timing settings. DISCORD_TOKEN, CLIENT_ID and BOT_OWNER_ID can't be changed from Discord, because a typo in them could lock you out. Edit the file on the host for those. Changes take effect after a restart
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

Optional: `OVERLOAD_LOAD_PER_CORE` (default 1.5), `OVERLOAD_MIN_FREE_MEM` (default 0.08), `OVERLOAD_PING_MS` (1500) and `OVERLOAD_LAG_MS` (2000) tune when the overload alert fires. `SERVER_LOG_EVERY_MS` changes the live server log refresh time (default 60000). `GUILD_ID` makes slash commands update instantly in one server. `STATUS_TEXT` sets the "Playing ..." status.
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
