# Scrim Board Bot

Discord bot where people post scrims and casters claim them with a button.

## Commands
- `/scrim post game team1 team2 time [slots] [notes]` posts a scrim embed with **Claim as Caster** / **Unclaim** buttons
- `/scrim cancel id` cancels a scrim (poster or anyone with Manage Messages)

## Setup
1. https://discord.com/developers/applications -> New Application -> **Bot** tab -> Reset Token (copy it).
2. Copy your **Application ID** (General Information tab).
3. Invite the bot: OAuth2 -> URL Generator -> scopes `bot` + `applications.commands`,
   permissions: View Channels, Send Messages, Embed Links, Read Message History.
4. Copy `.env.example` to `.env` and fill it in (never commit `.env`).
5. `npm install` then `npm start`.

Optional env vars: `CASTER_ROLE_ID` (only that role can claim, and gets pinged on new scrims),
`SCRIM_CHANNEL_ID` (always post in one channel), `GUILD_ID` (instant command updates).

## Free hosting
The bot needs to run 24/7, so it needs a host that doesn't sleep.

1. **Oracle Cloud Always Free VM** (most reliable free option; needs a card for verification).
   Create an Ubuntu ARM VM, then:
   ```
   sudo apt update && sudo apt install -y nodejs npm git
   git clone <your repo> && cd <repo> && npm install
   sudo npm i -g pm2 && pm2 start index.js --name scrim-bot && pm2 save && pm2 startup
   ```
   Disk is persistent, so `data.json` survives restarts.
2. **Home PC / Raspberry Pi / old laptop** with pm2. Free and simple if you can leave it on.
3. **Render / Koyeb / similar free web services.** The built-in web server on `PORT` makes them
   work, but free tiers can sleep without traffic (ping the URL with UptimeRobot every 5 min) and
   have an ephemeral disk, so `data.json` can be wiped on redeploy. Fine for testing, weak for production.

Free tier terms change often, so check each provider's current limits before committing.
