require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');

// Clean up env values: strip spaces, quotes and an accidental "Bot " prefix
const clean = (v) => (v || '').trim().replace(/^["']|["']$/g, '').trim();
// Optional IDs must be real Discord IDs (digits only); anything else is ignored
const optionalId = (name) => {
  const v = clean(process.env[name]);
  if (!v) return undefined;
  if (!/^\d{15,25}$/.test(v)) {
    console.warn(`${name} is set but is not a valid ID, so it is being ignored.`);
    return undefined;
  }
  return v;
};

const TOKEN = clean(process.env.DISCORD_TOKEN).replace(/^Bot\s+/i, '');
const CLIENT_ID = clean(process.env.CLIENT_ID);
const GUILD_ID = optionalId('GUILD_ID'); // optional: faster command updates for one server
const CASTER_ROLE_ID = optionalId('CASTER_ROLE_ID'); // optional: only this role can claim
const SCRIM_CHANNEL_ID = optionalId('SCRIM_CHANNEL_ID'); // optional: always post here
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

// ---------- tiny JSON storage ----------
let db = { nextId: 1, scrims: {} };
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  /* first run */
}
function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

// ---------- UI helpers ----------
function buildEmbed(s) {
  const open = s.casters.length < s.slots && !s.cancelled;
  const embed = new EmbedBuilder()
    .setTitle(`${s.game}: ${s.team1} vs ${s.team2}`)
    .setColor(s.cancelled ? 0x808080 : open ? 0x57f287 : 0xed4245)
    .addFields(
      { name: 'When', value: s.time, inline: true },
      { name: 'Posted by', value: `<@${s.authorId}>`, inline: true },
      {
        name: `Casters (${s.casters.length}/${s.slots})`,
        value: s.casters.length ? s.casters.map((id) => `<@${id}>`).join('\n') : '*No casters yet*',
      }
    )
    .setFooter({ text: `Scrim #${s.id}${s.cancelled ? ' · CANCELLED' : ''}` });
  if (s.notes) embed.addFields({ name: 'Notes', value: s.notes });
  return embed;
}

function buildButtons(s) {
  const full = s.casters.length >= s.slots;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`claim:${s.id}`)
      .setLabel(full ? 'Full' : 'Claim as Caster')
      .setStyle(ButtonStyle.Success)
      .setDisabled(full || s.cancelled),
    new ButtonBuilder()
      .setCustomId(`unclaim:${s.id}`)
      .setLabel('Unclaim')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(s.cancelled)
  );
}

// ---------- commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName('scrim')
    .setDescription('Scrim board')
    .addSubcommand((c) =>
      c
        .setName('post')
        .setDescription('Post a scrim for casters to claim')
        .addStringOption((o) => o.setName('game').setDescription('Game (e.g. Valorant)').setRequired(true))
        .addStringOption((o) => o.setName('team1').setDescription('Team 1').setRequired(true))
        .addStringOption((o) => o.setName('team2').setDescription('Team 2').setRequired(true))
        .addStringOption((o) =>
          o.setName('time').setDescription('When, e.g. "Sat 25 Oct 7pm AEDT" or <t:1761379200:F>').setRequired(true)
        )
        .addIntegerOption((o) =>
          o.setName('slots').setDescription('Caster slots (default 2)').setMinValue(1).setMaxValue(5)
        )
        .addStringOption((o) => o.setName('notes').setDescription('Extra info (maps, format, lobby details)'))
    )
    .addSubcommand((c) =>
      c
        .setName('cancel')
        .setDescription('Cancel a scrim you posted')
        .addIntegerOption((o) => o.setName('id').setDescription('Scrim number').setRequired(true))
    )
    .toJSON(),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log('Slash commands registered');
}

// ---------- bot ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let started = false;
async function onReady() {
  if (started) return;
  started = true;
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error('Command registration failed:', e);
  }
}
// 'clientReady' is the newer name; 'ready' is the older one. The guard above makes it safe to use both.
client.once('clientReady', onReady);
client.once('ready', onReady);

async function refreshMessage(interaction, s) {
  await interaction.update({ embeds: [buildEmbed(s)], components: [buildButtons(s)] });
}

client.on('interactionCreate', async (interaction) => {
  try {
    // ----- slash commands -----
    if (interaction.isChatInputCommand() && interaction.commandName === 'scrim') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'post') {
        const s = {
          id: db.nextId++,
          game: interaction.options.getString('game'),
          team1: interaction.options.getString('team1'),
          team2: interaction.options.getString('team2'),
          time: interaction.options.getString('time'),
          slots: interaction.options.getInteger('slots') ?? 2,
          notes: interaction.options.getString('notes') || '',
          authorId: interaction.user.id,
          casters: [],
          cancelled: false,
          channelId: null,
          messageId: null,
        };

        let channel = interaction.channel;
        if (SCRIM_CHANNEL_ID) {
          channel = (await client.channels.fetch(SCRIM_CHANNEL_ID).catch(() => null)) || channel;
        }

        const content = CASTER_ROLE_ID ? `<@&${CASTER_ROLE_ID}> new scrim up for casting!` : 'New scrim up for casting!';
        const msg = await channel.send({
          content,
          embeds: [buildEmbed(s)],
          components: [buildButtons(s)],
          allowedMentions: CASTER_ROLE_ID ? { roles: [CASTER_ROLE_ID] } : { parse: [] },
        });
        s.channelId = msg.channelId;
        s.messageId = msg.id;
        db.scrims[s.id] = s;
        save();

        return interaction.reply({
          content: `Scrim #${s.id} posted in <#${s.channelId}>.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'cancel') {
        const id = interaction.options.getInteger('id');
        const s = db.scrims[id];
        if (!s) return interaction.reply({ content: 'Scrim not found.', flags: MessageFlags.Ephemeral });
        const isMod = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);
        if (s.authorId !== interaction.user.id && !isMod) {
          return interaction.reply({
            content: 'Only the poster or a moderator can cancel this.',
            flags: MessageFlags.Ephemeral,
          });
        }
        s.cancelled = true;
        save();
        const ch = await client.channels.fetch(s.channelId).catch(() => null);
        const msg = ch && (await ch.messages.fetch(s.messageId).catch(() => null));
        if (msg) await msg.edit({ embeds: [buildEmbed(s)], components: [buildButtons(s)] });
        return interaction.reply({ content: `Scrim #${id} cancelled.`, flags: MessageFlags.Ephemeral });
      }
    }

    // ----- buttons -----
    if (interaction.isButton()) {
      const [action, idStr] = interaction.customId.split(':');
      if (action !== 'claim' && action !== 'unclaim') return;
      const s = db.scrims[idStr];
      if (!s || s.cancelled) {
        return interaction.reply({ content: 'This scrim is no longer available.', flags: MessageFlags.Ephemeral });
      }
      const uid = interaction.user.id;

      if (action === 'claim') {
        if (CASTER_ROLE_ID && !interaction.member.roles.cache.has(CASTER_ROLE_ID)) {
          return interaction.reply({
            content: 'You need the caster role to claim scrims.',
            flags: MessageFlags.Ephemeral,
          });
        }
        if (s.casters.includes(uid)) {
          return interaction.reply({ content: "You've already claimed this one.", flags: MessageFlags.Ephemeral });
        }
        if (s.casters.length >= s.slots) {
          return interaction.reply({ content: 'All caster slots are taken.', flags: MessageFlags.Ephemeral });
        }
        s.casters.push(uid);
      } else {
        if (!s.casters.includes(uid)) {
          return interaction.reply({ content: "You haven't claimed this scrim.", flags: MessageFlags.Ephemeral });
        }
        s.casters = s.casters.filter((id) => id !== uid);
      }
      save();
      return refreshMessage(interaction, s);
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

// Tiny web server so uptime pingers / "web service" hosts stay happy
http
  .createServer((_, res) => {
    res.writeHead(200);
    res.end('Scrim bot is running');
  })
  .listen(process.env.PORT || 3000);

console.log('DISCORD_TOKEN set:', Boolean(TOKEN), '| length:', TOKEN ? TOKEN.length : 0);
console.log('CLIENT_ID set:', Boolean(CLIENT_ID));
client.on('error', (e) => console.error('Client error:', e));
client.on('warn', (m) => console.warn('Client warn:', m));
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
client.on('debug', (m) => console.log('[debug]', m));
client.rest.on('rateLimited', (info) => console.warn('[rateLimited]', JSON.stringify(info)));
client.rest.on('invalidRequestWarning', (info) => console.warn('[invalidRequestWarning]', JSON.stringify(info)));
client.on('shardError', (e) => console.error('[shardError]', e));
client.on('shardDisconnect', (ev, id) => console.warn('[shardDisconnect]', id, ev && ev.code));
// Ask Discord directly whether this server can reach it, and whether the token is accepted
async function preflight() {
  const show = async (label, url, headers) => {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      const body = (await r.text()).replace(/\s+/g, ' ').slice(0, 160);
      console.log(`[preflight] ${label}: HTTP ${r.status} ${r.statusText} | ${body}`);
      return r.status;
    } catch (e) {
      console.error(`[preflight] ${label}: FAILED (${e.cause?.code || e.name}: ${e.message})`);
      return 0;
    }
  };
  await show('discord api reachable', 'https://discord.com/api/v10/gateway');
  const s = await show('token check', 'https://discord.com/api/v10/users/@me', { Authorization: `Bot ${TOKEN}` });
  if (s === 401) console.error('[preflight] Discord says the token is INVALID. Reset it in the Bot tab and update DISCORD_TOKEN.');
  if (s === 429 || s === 403) console.error('[preflight] Discord is blocking or throttling this server\'s IP address.');
}

// If the bot hasn't connected after 2 minutes, exit so Render restarts it (often on a different IP)
setTimeout(() => {
  if (!client.isReady()) {
    console.error('Not connected after 120s. Exiting so the host restarts the bot.');
    process.exit(1);
  }
}, 120000);

(async () => {
  if (!TOKEN || !CLIENT_ID) {
    console.error('DISCORD_TOKEN and CLIENT_ID must both be set in the environment.');
  }
  await preflight();
  console.log('Logging in...');
  client
    .login(TOKEN)
    .then(() => console.log('Login request accepted'))
    .catch((e) => console.error('LOGIN FAILED:', e.message));
})();
