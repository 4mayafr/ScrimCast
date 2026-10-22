require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const os = require('os');

const CODE_VERSION = 'panel-form-6'; // shown in /admin status so you can tell which copy of the bot is answering

// Some home networks / containers have broken IPv6; try IPv4 addresses first so connections don't stall
try {
  require('dns').setDefaultResultOrder('ipv4first');
} catch {
  /* older Node: ignore */
}

// Keep the last few log lines in memory so the owner can read them with /admin logs
const recentLogs = [];
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    try {
      const line = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(' ');
      recentLogs.push(`${new Date().toISOString().slice(11, 19)} ${level === 'log' ? '' : level.toUpperCase() + ' '}${line}`.slice(0, 300));
      if (recentLogs.length > 40) recentLogs.shift();
    } catch {
      /* never let logging break the bot */
    }
  };
}

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
  ChannelType,
  ActivityType,
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

// Short, readable version of an error (network errors can be huge AggregateErrors)
const shortErr = (e) => {
  if (!e) return 'unknown error';
  const code = e.code ? `${e.code}` : '';
  const msg = e.message ? `${e.message}` : '';
  const many = Array.isArray(e.errors) ? ` (${e.errors.length} connection attempts failed)` : '';
  return [code, msg].filter(Boolean).join(': ') + many || String(e);
};

// Clean up env values: strip spaces, quotes and an accidental "Bot " prefix
const clean = (v) => (v || '').trim().replace(/^["']|["']$/g, '').trim();
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
const GUILD_ID = optionalId('GUILD_ID'); // optional: makes slash commands update instantly in one server
const BOT_OWNER_ID = optionalId('BOT_OWNER_ID'); // optional: who may use /admin (default: the bot application's owner)
const STATUS_TEXT = clean(process.env.STATUS_TEXT).slice(0, 128) || 'Scrim Board'; // "Playing ..."
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

for (const old of ['CASTER_ROLE_ID', 'SCRIM_CHANNEL_ID']) {
  if (process.env[old]) console.warn(`${old} is no longer used. Channels and the caster role are set with /setup now.`);
}

const EPHEMERAL = MessageFlags.Ephemeral;
const MAX_CASTERS = 1; // casters per scrim
const MAX_COCASTERS = 4; // co-casters per scrim
const PING_COOLDOWN_MS = 10000;

// ---------- tiny JSON storage ----------
let db = { nextId: 1, scrims: {}, config: {} };
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  /* first run */
}
db.nextId = db.nextId || 1;
db.scrims = db.scrims || {};
db.config = db.config || {}; // per server: { postChannelId, threadChannelId, casterRoleId }
function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

const getConfig = (guildId) => db.config[guildId] || null;
const configComplete = (c) => Boolean(c && c.postChannelId && c.threadChannelId && c.casterRoleId);
const isClosed = (s) => Boolean(s.closed || s.cancelled); // older versions called it "cancelled"

// Writes one line to the server's log channel (if one is set). Returns true if it was sent.
async function logEvent(guildId, title, description, color = 0x5865f2) {
  try {
    const cfg = getConfig(guildId);
    if (!cfg || !cfg.logChannelId) return false;
    const ch = await client.channels.fetch(cfg.logChannelId).catch(() => null);
    if (!ch) return false;
    await ch.send({
      embeds: [new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp()],
      allowedMentions: { parse: [] },
    });
    return true;
  } catch (e) {
    console.error('Could not write to the log channel:', e.message);
    return false;
  }
}

// ---------- UI helpers ----------
function buildEmbed(s) {
  const cocasters = s.cocasters || [];
  const open = s.casters.length < MAX_CASTERS && !isClosed(s);
  const embed = new EmbedBuilder()
    .setTitle(`${s.team1} vs ${s.team2}`)
    .setColor(isClosed(s) ? 0x808080 : open ? 0x57f287 : 0xed4245)
    .addFields(
      { name: 'When', value: s.time, inline: true },
      { name: 'Posted by', value: `<@${s.authorId}>`, inline: true },
      {
        name: `Caster (${s.casters.length}/${MAX_CASTERS})`,
        value: s.casters.length ? s.casters.map((id) => `<@${id}>`).join('\n') : '*No caster yet*',
      },
      {
        name: `Co-casters (${cocasters.length}/${MAX_COCASTERS})`,
        value: cocasters.length ? cocasters.map((id) => `<@${id}>`).join('\n') : '*None yet*',
      }
    )
    .setFooter({ text: `Scrim #${s.id}${isClosed(s) ? ' · CLOSED' : ''}` });
  if (s.threadId) {
    embed.addFields({ name: 'Thread', value: `<#${s.threadId}> (private: poster, caster and co-casters)` });
  }
  if (s.notes) embed.addFields({ name: 'Notes', value: s.notes });
  return embed;
}

function buildButtons(s) {
  const full = s.casters.length >= MAX_CASTERS;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`claim:${s.id}`)
      .setLabel(full ? 'Claimed' : 'Claim as Caster')
      .setStyle(ButtonStyle.Success)
      .setDisabled(full || isClosed(s)),
    new ButtonBuilder()
      .setCustomId(`unclaim:${s.id}`)
      .setLabel('Unclaim')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isClosed(s))
  );
}

// The "Close Scrim" button that lives inside the scrim's private thread
function buildCloseRow(s, closed = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`close:${s.id}`)
      .setLabel(closed ? 'Closed' : 'Close Scrim')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(closed)
  );
}

// ---------- commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Server owner only: configure the scrim board')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((c) =>
      c
        .setName('set')
        .setDescription('Set the panel channel, where scrims are posted, where threads are made, and who can claim')
        .addChannelOption((o) =>
          o
            .setName('panel_channel')
            .setDescription('Channel that gets the "Post Scrim" button panel')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
        .addChannelOption((o) =>
          o
            .setName('post_channel')
            .setDescription('Channel where scrims are posted for casters to claim')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
        .addChannelOption((o) =>
          o
            .setName('thread_channel')
            .setDescription('Channel the private scrim threads are created in')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
        .addChannelOption((o) =>
          o
            .setName('log_channel')
            .setDescription('Channel where scrim activity is logged (posted, claimed, closed...)')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
        .addRoleOption((o) =>
          o.setName('caster_role').setDescription('Only this role can use the Claim button').setRequired(true)
        )
    )
    .addSubcommand((c) => c.setName('view').setDescription('Show the current setup'))
    .addSubcommand((c) => c.setName('panel').setDescription('Post the "Post Scrim" panel again (for example if it was deleted)'))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Bot owner only: manage the bot itself')
    .addSubcommand((c) => c.setName('status').setDescription('Show uptime, memory and scrim counts'))
    .addSubcommand((c) => c.setName('logs').setDescription('Show the most recent log lines'))
    .addSubcommand((c) =>
      c
        .setName('update')
        .setDescription('Download the latest code from GitHub (git pull)')
        .addBooleanOption((o) => o.setName('restart').setDescription('Restart afterwards so the new code runs (needs pm2)'))
    )
    .addSubcommand((c) => c.setName('restart').setDescription('Restart the bot (needs pm2 to come back by itself)'))
    .addSubcommand((c) => c.setName('shutdown').setDescription('Turn the bot off (under pm2 it stays off until you start it again)'))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('scrim')
    .setDescription('Scrim board')
    .addSubcommand((c) =>
      c
        .setName('addcocaster')
        .setDescription('Add a co-caster to the scrim thread (max 4)')
        .addUserOption((o) => o.setName('user').setDescription('Who to add').setRequired(true))
        .addIntegerOption((o) =>
          o.setName('id').setDescription('Scrim number (not needed if you run this inside the scrim thread)')
        )
    )
    .addSubcommand((c) =>
      c
        .setName('removecocaster')
        .setDescription('Remove a co-caster from the scrim thread')
        .addUserOption((o) => o.setName('user').setDescription('Who to remove').setRequired(true))
        .addIntegerOption((o) =>
          o.setName('id').setDescription('Scrim number (not needed if you run this inside the scrim thread)')
        )
    )
    .addSubcommand((c) =>
      c
        .setName('ping')
        .setDescription('Ping everyone in the scrim thread with a message (server, lobby code, etc.)')
        .addStringOption((o) =>
          o.setName('message').setDescription('What to send, e.g. the server or lobby details').setRequired(true).setMaxLength(1000)
        )
        .addIntegerOption((o) =>
          o.setName('id').setDescription('Scrim number (not needed if you run this inside the scrim thread)')
        )
    )
    .toJSON(),
];

let liveCommandsNote = 'not checked yet'; // what Discord says it has registered, shown in /admin status

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  if (GUILD_ID) {
    // Server commands show up instantly. Do this first: if the ID is wrong it throws before anything is removed.
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    // Remove older global copies of the commands so each one isn't listed twice
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] }).catch((e) => console.error('Could not clear global commands:', e.message));
    console.log('Slash commands registered (for your server, instant)');
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Slash commands registered');
  }

  // Ask Discord what it actually has now, so we can tell a registration problem from a Discord-app display problem
  try {
    const live = await rest.get(GUILD_ID ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID) : Routes.applicationCommands(CLIENT_ID));
    const setup = live.find((c) => c.name === 'setup');
    const set = setup && (setup.options || []).find((o) => o.name === 'set');
    const names = set ? (set.options || []).map((o) => o.name).join(', ') : 'no /setup command found';
    liveCommandsNote = `${GUILD_ID ? 'server' : 'global'} commands: ${live.map((c) => c.name).join(', ') || 'none'} | /setup set options: ${names}`;
  } catch (e) {
    liveCommandsNote = `could not check (${e.message})`;
  }
  console.log('Discord now has ->', liveCommandsNote);
}

// ---------- bot ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let started = false;
async function onReady() {
  if (started) return;
  started = true;
  console.log(`Logged in as ${client.user.tag}`);
  try {
    client.user.setPresence({ status: 'online', activities: [{ name: STATUS_TEXT, type: ActivityType.Playing }] });
  } catch (e) {
    console.error('Could not set status:', e.message);
  }
  try {
    await registerCommands();
  } catch (e) {
    console.error('Command registration failed:', e);
  }
}
// Events.ClientReady is 'ready' on older discord.js and 'clientReady' on newer, so no deprecation warning either way
client.once(Events.ClientReady, onReady);

// ---------- thread helpers ----------
async function createScrimThread(channel, s) {
  const base = {
    name: `Scrim #${s.id}: ${s.team1} vs ${s.team2}`.slice(0, 100),
    type: ChannelType.PrivateThread, // private: only people added to it (and moderators) can see it
    invitable: false, // nobody can add people themselves; only the bot, via the commands below
    reason: `Scrim #${s.id}`,
  };
  try {
    return await channel.threads.create({ ...base, autoArchiveDuration: 10080 }); // 7 days
  } catch (e) {
    // Some servers don't allow the 7-day option; retry with 24 hours
    if (e.code === 50035) return channel.threads.create({ ...base, autoArchiveDuration: 1440 });
    throw e;
  }
}

async function getThread(s) {
  if (!s.threadId) return null;
  const t = await client.channels.fetch(s.threadId).catch(() => null);
  if (!t || !t.isThread()) return null;
  if (t.archived) await t.setArchived(false).catch(() => {});
  return t;
}

// Returns true if the user is now in the thread. `note` is posted in the thread (without pinging).
async function addToThread(s, userId, note) {
  try {
    const t = await getThread(s);
    if (!t) return false;
    await t.members.add(userId);
    if (note) await t.send({ content: note, allowedMentions: { parse: [] } });
    return true;
  } catch (e) {
    console.error('Could not add to thread:', e.message);
    return false;
  }
}

async function removeFromThread(s, userId, note) {
  try {
    const t = await getThread(s);
    if (!t) return false;
    await t.members.remove(userId);
    if (note) await t.send({ content: note, allowedMentions: { parse: [] } });
    return true;
  } catch (e) {
    console.error('Could not remove from thread:', e.message);
    return false;
  }
}

async function editScrimMessage(s) {
  const ch = await client.channels.fetch(s.channelId).catch(() => null);
  const msg = ch && (await ch.messages.fetch(s.messageId).catch(() => null));
  if (msg) await msg.edit({ embeds: [buildEmbed(s)], components: [buildButtons(s)] });
}

// Find the scrim a command refers to: the id option, or the scrim whose thread the command was run in
function findScrim(interaction) {
  const id = interaction.options.getInteger('id');
  if (id !== null && id !== undefined) return db.scrims[id];
  return Object.values(db.scrims).find((s) => s.threadId && s.threadId === interaction.channelId);
}

// Look up the scrim for a thread command, replying with an error (and returning null) if it can't be used
async function scrimForThreadCommand(interaction) {
  const s = findScrim(interaction);
  if (!s) {
    await interaction.editReply({
      content: 'Scrim not found. Run this inside the scrim thread, or give the scrim number in the `id` option.',
    });
    return null;
  }
  if (isClosed(s)) {
    await interaction.editReply({ content: 'That scrim is closed.' });
    return null;
  }
  if (!s.threadId) {
    await interaction.editReply({ content: 'This scrim has no thread (it was posted before threads were added).' });
    return null;
  }
  return s;
}

const isMod = (interaction) => Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages));

const prettyPerm = (p) => p.replace(/([A-Z])/g, ' $1').trim();
const missingPerms = (channel, me, perms) => (channel.permissionsFor(me)?.missing(perms) || []).map(prettyPerm);

async function refreshMessage(interaction, s) {
  await interaction.update({ embeds: [buildEmbed(s)], components: [buildButtons(s)] });
}

// ---------- the "Post Scrim" panel and its form ----------
function buildPanelEmbed() {
  return new EmbedBuilder()
    .setTitle('Post a scrim')
    .setColor(0x5865f2)
    .setDescription(
      'Need a caster for your scrim? Press **Post Scrim** and fill in the form.\n\n' +
        'Your scrim is posted for casters to claim, and you get a private thread to talk with the caster and co-casters.'
    );
}

function buildPanelButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('postscrim').setLabel('Post Scrim').setStyle(ButtonStyle.Primary)
  );
}

function textRow(id, label, style, { required = true, max, placeholder }) {
  return new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setStyle(style)
      .setRequired(required)
      .setMaxLength(max)
      .setPlaceholder(placeholder)
  );
}

function buildScrimModal() {
  return new ModalBuilder()
    .setCustomId('scrimform')
    .setTitle('Post a scrim')
    .addComponents(
      textRow('team1', 'Team 1', TextInputStyle.Short, { max: 50, placeholder: 'e.g. Red Dragons' }),
      textRow('team2', 'Team 2', TextInputStyle.Short, { max: 50, placeholder: 'e.g. Blue Wolves' }),
      textRow('time', 'When', TextInputStyle.Short, { max: 100, placeholder: 'e.g. Sat 25 Oct, 7pm AEDT' }),
      textRow('notes', 'Notes (optional)', TextInputStyle.Paragraph, {
        required: false,
        max: 500,
        placeholder: 'Maps, format, lobby details...',
      })
    );
}

// Posts the panel in the configured panel channel, replacing the previous one. Returns { ok, reason }.
async function postPanel(guildId) {
  const cfg = getConfig(guildId);
  if (!cfg || !cfg.panelChannelId) return { ok: false, reason: 'no panel channel is set' };
  const ch = await client.channels.fetch(cfg.panelChannelId).catch(() => null);
  if (!ch) return { ok: false, reason: "I can't find that channel" };

  if (cfg.panelMessage) {
    const oldCh = await client.channels.fetch(cfg.panelMessage.channelId).catch(() => null);
    const old = oldCh && (await oldCh.messages.fetch(cfg.panelMessage.messageId).catch(() => null));
    if (old) await old.delete().catch(() => {});
  }
  try {
    const msg = await ch.send({ embeds: [buildPanelEmbed()], components: [buildPanelButtons()] });
    cfg.panelMessage = { channelId: msg.channelId, messageId: msg.id };
    save();
    return { ok: true };
  } catch (e) {
    console.error('Posting the panel failed:', e.message);
    return { ok: false, reason: 'I need View Channel, Send Messages and Embed Links there' };
  }
}

// Creates the scrim from the submitted form. `interaction` must already be deferred.
async function createScrim(interaction, { team1, team2, time, notes }) {
  const cfg = getConfig(interaction.guildId);
  if (!configComplete(cfg)) {
    return interaction.editReply({ content: 'This server is not set up yet. The server owner needs to run `/setup set` first.' });
  }
  const postChannel = await client.channels.fetch(cfg.postChannelId).catch(() => null);
  const threadChannel = await client.channels.fetch(cfg.threadChannelId).catch(() => null);
  if (!postChannel || !threadChannel) {
    return interaction.editReply({ content: "I can't find the configured channels. The server owner should run `/setup set` again." });
  }

  const s = {
    id: db.nextId,
    guildId: interaction.guildId,
    team1,
    team2,
    time,
    notes,
    authorId: interaction.user.id,
    casters: [],
    cocasters: [],
    closed: false,
    channelId: null,
    messageId: null,
    threadId: null,
    threadParentId: threadChannel.id,
  };

  // 1) create the private thread
  let thread;
  try {
    thread = await createScrimThread(threadChannel, s);
  } catch (e) {
    console.error('Thread creation failed:', e.message);
    return interaction.editReply({
      content:
        `I couldn't create the scrim thread in <#${threadChannel.id}>. Give me **Create Private Threads**, ` +
        '**Send Messages in Threads** and **Manage Threads** there, then try again.',
    });
  }
  s.threadId = thread.id;

  // 2) post the scrim message (it links to the thread)
  let msg;
  try {
    msg = await postChannel.send({
      content: `<@&${cfg.casterRoleId}> new scrim up for casting!`,
      embeds: [buildEmbed(s)],
      components: [buildButtons(s)],
      allowedMentions: { roles: [cfg.casterRoleId] },
    });
  } catch (e) {
    console.error('Posting scrim failed:', e.message);
    await thread.delete().catch(() => {});
    return interaction.editReply({ content: `I couldn't post in <#${postChannel.id}>. Check my permissions there.` });
  }

  s.channelId = msg.channelId;
  s.messageId = msg.id;
  db.nextId += 1;
  db.scrims[s.id] = s;
  save();

  // 3) put the poster in the thread and say hello
  await thread.members.add(s.authorId).catch((e) => console.error('Could not add poster:', e.message));
  await thread
    .send({
      content:
        `**Scrim #${s.id}: ${s.team1} vs ${s.team2}** (${s.time})\n` +
        `Posted by <@${s.authorId}>. The caster who claims this scrim is added here automatically.\n` +
        `The caster can add up to ${MAX_COCASTERS} co-casters with \`/scrim addcocaster\`, and ping everyone here with \`/scrim ping\`.\n` +
        'Press **Close Scrim** below when the scrim is over.',
      components: [buildCloseRow(s)],
      allowedMentions: { parse: [] },
    })
    .catch((e) => console.error('Could not send thread intro:', e.message));
  await logEvent(
    s.guildId,
    `Scrim #${s.id} posted`,
    `**${s.team1} vs ${s.team2}** at ${s.time}\nPosted by <@${s.authorId}> in <#${s.channelId}>. Thread: <#${s.threadId}>`,
    0x5865f2
  );

  return interaction.editReply({ content: `Scrim #${s.id} posted in <#${s.channelId}>. Thread: <#${thread.id}>` });
}

const pingCooldown = new Map();

// The bot owner is the owner of the Discord application (or a member of its team), or BOT_OWNER_ID if set
async function isBotOwner(userId) {
  if (BOT_OWNER_ID) return userId === BOT_OWNER_ID;
  try {
    const app = await client.application.fetch();
    const o = app.owner;
    if (!o) return false;
    if (o.members) return o.ownerId === userId || o.members.has(userId); // a team
    return o.id === userId;
  } catch (e) {
    console.error('Could not look up the bot owner:', e.message);
    return false;
  }
}

// Run a command in the bot's folder and wait for it. `shell` is needed for npm on Windows.
const runCmd = (cmd, args, timeoutMs = 120000, shell = false) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: __dirname, timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024, shell }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = String(stdout || '');
        err.stderr = String(stderr || '');
        return reject(err);
      }
      resolve({ stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    });
  });

const underPm2 = () => process.env.pm_id !== undefined && process.env.pm_id !== '';
const fmtUptime = (sec) => {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return `${d ? d + 'd ' : ''}${h}h ${m}m`;
};

async function handleAdmin(interaction) {
  if (!(await isBotOwner(interaction.user.id))) {
    return interaction.reply({ content: 'Only the bot owner can use `/admin`.', flags: EPHEMERAL });
  }
  await interaction.deferReply({ flags: EPHEMERAL });
  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    const all = Object.values(db.scrims);
    const open = all.filter((s) => !isClosed(s) && s.casters.length < MAX_CASTERS).length;
    const mb = (n) => (n / 1048576).toFixed(0);
    return interaction.editReply({
      content:
        '**Bot status**\n' +
        `Running on: ${os.hostname()} (${process.platform})\n` +
        `Code version: ${CODE_VERSION}\n` +
        `Commands on Discord: ${liveCommandsNote}\n` +
        `Uptime: ${fmtUptime(process.uptime())}\n` +
        `Discord ping: ${Math.round(client.ws.ping)} ms\n` +
        `Memory: ${mb(process.memoryUsage().rss)} MB\n` +
        `Servers: ${client.guilds.cache.size}\n` +
        `Scrims: ${all.length} total, ${open} waiting for a caster\n` +
        `Running under pm2: ${underPm2() ? 'yes (restarts itself if it crashes)' : 'no'}\n` +
        `Node ${process.version}`,
    });
  }

  if (sub === 'logs') {
    let text = recentLogs.slice(-15).join('\n') || '(no logs yet)';
    if (text.length > 1800) text = '...' + text.slice(-1800);
    return interaction.editReply({ content: '```\n' + text.replace(/```/g, "'''") + '\n```' });
  }

  if (sub === 'update') {
    const wantRestart = interaction.options.getBoolean('restart') === true;
    try {
      const before = (await runCmd('git', ['rev-parse', 'HEAD'])).stdout;
      await runCmd('git', ['pull', '--ff-only']);
      const after = (await runCmd('git', ['rev-parse', 'HEAD'])).stdout;
      if (before === after) return interaction.editReply({ content: 'Already up to date. Nothing to download.' });

      const changed = (await runCmd('git', ['diff', '--name-only', before, after])).stdout.split('\n').filter(Boolean);
      const commits = (await runCmd('git', ['log', '--oneline', '-5', `${before}..${after}`])).stdout;
      let npmNote = '';
      if (changed.some((f) => f === 'package.json' || f === 'package-lock.json')) {
        await runCmd(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], 300000, process.platform === 'win32');
        npmNote = '\nDependencies were reinstalled (`npm install`).';
      }

      let text =
        `Updated \`${before.slice(0, 7)}\` to \`${after.slice(0, 7)}\`.\n` +
        `Changed files (${changed.length}): ${changed.slice(0, 10).join(', ')}${changed.length > 10 ? ', ...' : ''}\n` +
        (commits ? '```\n' + commits.slice(0, 600) + '\n```' : '') +
        npmNote;

      if (wantRestart && underPm2()) {
        await interaction.editReply({ content: text + '\nRestarting now to run the new code. Back in a few seconds.' });
        setTimeout(() => {
          client.destroy();
          process.exit(0); // pm2 starts it again with the new code
        }, 500);
        return;
      }
      text += wantRestart
        ? "\nI'm not running under pm2, so I can't restart myself. Restart me by hand to use the new code."
        : '\nRun `/admin restart` (or `/admin update restart:True` next time) to start using the new code.';
      return interaction.editReply({ content: text.slice(0, 1900) });
    } catch (e) {
      const detail = `${e.stderr || ''} ${e.message || ''}`.trim();
      let msg;
      if (e.code === 'ENOENT') msg = 'Git is not installed on this machine, so I can\'t update myself.';
      else if (/not a git repository/i.test(detail)) msg = "This copy of the bot isn't a git checkout (it wasn't cloned from GitHub), so it can't update itself. Copy the new files over by hand.";
      else if (e.killed) msg = 'The update took too long and was stopped.';
      else msg = 'The update failed:\n```\n' + detail.replace(/```/g, "'''").slice(0, 1200) + '\n```';
      console.error('Update failed:', shortErr(e));
      return interaction.editReply({ content: msg });
    }
  }

  if (sub === 'restart') {
    if (!underPm2()) {
      return interaction.editReply({
        content: "I'm not running under pm2, so I wouldn't come back by myself. Start me with `pm2 start index.js --name scrim-bot` first.",
      });
    }
    await interaction.editReply({ content: 'Restarting now. I should be back in a few seconds.' });
    setTimeout(() => {
      client.destroy();
      process.exit(0); // pm2 starts it again
    }, 500);
    return;
  }

  if (sub === 'shutdown') {
    await interaction.editReply({ content: 'Shutting down. Start me again from the Chromebook with `pm2 start scrim-bot`.' });
    setTimeout(() => {
      if (underPm2()) {
        // `pm2 stop` keeps pm2 from restarting the process
        execFile('pm2', ['stop', String(process.env.pm_id)], (err) => {
          if (err) {
            console.error('pm2 stop failed:', err.message);
            client.destroy();
            process.exit(0); // pm2 will restart it; better than leaving it half-dead
          }
        });
      } else {
        client.destroy();
        process.exit(0);
      }
    }, 500);
    return;
  }
}

client.on('interactionCreate', async (interaction) => {
  try {
    // ----- slash commands -----
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'admin') return handleAdmin(interaction);

      if (!interaction.guildId || !interaction.guild) {
        return interaction.reply({ content: 'Use this command in a server.', flags: EPHEMERAL });
      }

      // ===== /setup (server owner only) =====
      if (interaction.commandName === 'setup') {
        if (interaction.user.id !== interaction.guild.ownerId) {
          return interaction.reply({ content: 'Only the server owner can use `/setup`.', flags: EPHEMERAL });
        }
        await interaction.deferReply({ flags: EPHEMERAL });
        const sub = interaction.options.getSubcommand();

        if (sub === 'view') {
          const c = getConfig(interaction.guildId);
          if (!configComplete(c)) return interaction.editReply({ content: 'Not set up yet. Run `/setup set`.' });
          return interaction.editReply({
            content:
              `**Post Scrim panel:** ${c.panelChannelId ? `<#${c.panelChannelId}>` : 'not set, run `/setup set` again'}\n` +
              `**Scrims are posted in:** <#${c.postChannelId}>\n` +
              `**Log channel:** ${c.logChannelId ? `<#${c.logChannelId}>` : 'not set, run `/setup set` again'}\n` +
              `**Private threads are created in:** <#${c.threadChannelId}>\n` +
              `**Role that can claim:** <@&${c.casterRoleId}>`,
          });
        }

        if (sub === 'panel') {
          const c = getConfig(interaction.guildId);
          if (!c || !c.panelChannelId) return interaction.editReply({ content: 'No panel channel is set. Run `/setup set` first.' });
          const r = await postPanel(interaction.guildId);
          return interaction.editReply({
            content: r.ok
              ? `Posted the Post Scrim panel in <#${c.panelChannelId}>.`
              : `I couldn't post the panel in <#${c.panelChannelId}>: ${r.reason}`,
          });
        }

        // sub === 'set'
        const panel = interaction.options.getChannel('panel_channel');
        const logCh = interaction.options.getChannel('log_channel');
        if (!panel || !logCh) {
          // Discord is still showing an older version of this command (missing the newer channel options)
          return interaction.editReply({
            content:
              'Your Discord app is still showing an old version of `/setup`. Restart Discord (Ctrl+R on PC, or close and reopen the app) ' +
              'so it picks up the new options (`panel_channel` and `log_channel`), then run `/setup set` again. Nothing was changed.',
          });
        }
        const post = interaction.options.getChannel('post_channel', true);
        const threads = interaction.options.getChannel('thread_channel', true);
        const role = interaction.options.getRole('caster_role', true);
        const previous = getConfig(interaction.guildId);
        db.config[interaction.guildId] = {
          panelChannelId: panel.id,
          logChannelId: logCh.id,
          postChannelId: post.id,
          threadChannelId: threads.id,
          casterRoleId: role.id,
          panelMessage: previous ? previous.panelMessage : undefined, // so the old panel can be replaced
        };
        save();

        const me = interaction.guild.members.me || (await interaction.guild.members.fetchMe().catch(() => null));
        const warnings = [];
        if (me) {
          const m0 = missingPerms(panel, me, ['ViewChannel', 'SendMessages', 'EmbedLinks']);
          const m1 = missingPerms(post, me, ['ViewChannel', 'SendMessages', 'EmbedLinks']);
          const m2 = missingPerms(threads, me, ['ViewChannel', 'CreatePrivateThreads', 'SendMessagesInThreads', 'ManageThreads']);
          if (m0.length) warnings.push(`I'm missing in <#${panel.id}>: ${m0.join(', ')}`);
          if (m1.length) warnings.push(`I'm missing in <#${post.id}>: ${m1.join(', ')}`);
          if (m2.length) warnings.push(`I'm missing in <#${threads.id}>: ${m2.join(', ')}`);
          const m3 = missingPerms(logCh, me, ['ViewChannel', 'SendMessages', 'EmbedLinks']);
          if (m3.length) warnings.push(`I'm missing in <#${logCh.id}>: ${m3.join(', ')}`);
        }
        const logOk = await logEvent(interaction.guildId, 'Logging enabled', 'Scrim activity (posted, claimed, closed...) will be logged here.', 0x57f287);
        if (!logOk) warnings.push(`I couldn't post in the log channel <#${logCh.id}>. Check my permissions there.`);
        const panelResult = await postPanel(interaction.guildId);
        if (!panelResult.ok) warnings.push(`I couldn't post the panel in <#${panel.id}>: ${panelResult.reason}. Fix it, then run \`/setup panel\`.`);
        return interaction.editReply({
          content:
            'Saved.\n' +
            `**Post Scrim panel:** <#${panel.id}>${panelResult.ok ? ' (posted)' : ''}\n` +
            `**Scrims are posted in:** <#${post.id}>\n` +
            `**Log channel:** <#${logCh.id}>\n` +
            `**Private threads are created in:** <#${threads.id}>\n` +
            `**Role that can claim:** <@&${role.id}>\n\n` +
            (warnings.length ? `Fix these:\n- ${warnings.join('\n- ')}\n\n` : '') +
            `Everyone who posts scrims or casts must be able to see <#${threads.id}> and send messages in threads there.`,
        });
      }

      // ===== /scrim ... =====
      if (interaction.commandName === 'scrim') {
        const sub = interaction.options.getSubcommand();

        if (sub === 'post') {
          // /scrim post was replaced by the Post Scrim button; this only runs if Discord still shows the old command
          const c = getConfig(interaction.guildId);
          return interaction.reply({
            content: c && c.panelChannelId
              ? `Scrims are posted with the **Post Scrim** button in <#${c.panelChannelId}> now. (If you still see \`/scrim post\`, restart Discord to refresh the commands.)`
              : 'Scrims are posted with a **Post Scrim** button now. The server owner needs to run `/setup set` to create it.',
            flags: EPHEMERAL,
          });
        }

        if (sub === 'cancel') {
          // /scrim cancel was replaced by the Close Scrim button; this only runs if Discord still shows the old command
          return interaction.reply({
            content: 'Scrims are closed with the **Close Scrim** button inside the scrim thread now. (If you still see `/scrim cancel`, restart Discord to refresh the commands.)',
            flags: EPHEMERAL,
          });
        }

        if (sub === 'addcocaster' || sub === 'removecocaster') {
          await interaction.deferReply({ flags: EPHEMERAL });
          const s = await scrimForThreadCommand(interaction);
          if (!s) return;

          const uid = interaction.user.id;
          if (!s.casters.includes(uid) && s.authorId !== uid && !isMod(interaction)) {
            return interaction.editReply({ content: 'Only the caster who claimed this scrim (or the poster) can change co-casters.' });
          }

          const target = interaction.options.getUser('user');
          s.cocasters = s.cocasters || [];

          if (sub === 'addcocaster') {
            if (target.bot) return interaction.editReply({ content: "You can't add a bot." });
            if (target.id === s.authorId || s.casters.includes(target.id)) {
              return interaction.editReply({ content: `<@${target.id}> is already in the thread.` });
            }
            if (s.cocasters.includes(target.id)) {
              return interaction.editReply({ content: `<@${target.id}> is already a co-caster on this scrim.` });
            }
            if (s.cocasters.length >= MAX_COCASTERS) {
              return interaction.editReply({ content: `This scrim already has ${MAX_COCASTERS} co-casters, which is the maximum. Remove one first with \`/scrim removecocaster\`.` });
            }
            const ok = await addToThread(s, target.id, `<@${target.id}> was added as a co-caster by <@${uid}>.`);
            if (!ok) {
              return interaction.editReply({
                content:
                  `I couldn't add <@${target.id}>. Check that they can see <#${s.threadParentId || s.channelId}> ` +
                  'and that I have **Manage Threads** there.',
              });
            }
            s.cocasters.push(target.id);
            save();
            await editScrimMessage(s).catch((e) => console.error('Could not edit scrim message:', e.message));
            logEvent(s.guildId || interaction.guildId, `Scrim #${s.id} co-caster added`, `<@${uid}> added <@${target.id}> as a co-caster on **${s.team1} vs ${s.team2}**.`, 0x5865f2);
            return interaction.editReply({ content: `Added <@${target.id}> as a co-caster. Thread: <#${s.threadId}>` });
          }

          // removecocaster
          if (!s.cocasters.includes(target.id)) {
            return interaction.editReply({ content: `<@${target.id}> isn't a co-caster on this scrim.` });
          }
          await removeFromThread(s, target.id, `<@${target.id}> was removed as a co-caster by <@${uid}>.`);
          s.cocasters = s.cocasters.filter((id) => id !== target.id);
          save();
          await editScrimMessage(s).catch((e) => console.error('Could not edit scrim message:', e.message));
          logEvent(s.guildId || interaction.guildId, `Scrim #${s.id} co-caster removed`, `<@${uid}> removed <@${target.id}> as a co-caster on **${s.team1} vs ${s.team2}**.`, 0x5865f2);
          return interaction.editReply({ content: `Removed <@${target.id}> as a co-caster.` });
        }

        if (sub === 'ping') {
          await interaction.deferReply({ flags: EPHEMERAL });
          const s = await scrimForThreadCommand(interaction);
          if (!s) return;

          const uid = interaction.user.id;
          const inThread = s.authorId === uid || s.casters.includes(uid) || (s.cocasters || []).includes(uid);
          if (!inThread && !isMod(interaction)) {
            return interaction.editReply({ content: 'Only people in the scrim thread can ping it.' });
          }
          const wait = PING_COOLDOWN_MS - (Date.now() - (pingCooldown.get(uid) || 0));
          if (wait > 0) {
            return interaction.editReply({ content: `Slow down, you can ping again in ${Math.ceil(wait / 1000)}s.` });
          }

          const others = [...new Set([s.authorId, ...s.casters, ...(s.cocasters || [])])].filter((id) => id !== uid);
          if (!others.length) return interaction.editReply({ content: 'Nobody else is in the thread yet.' });

          const t = await getThread(s);
          if (!t) return interaction.editReply({ content: "I can't find the scrim thread. It may have been deleted." });

          const text = interaction.options.getString('message');
          // Only the thread members are pinged, so @everyone / @here / roles in the text do nothing
          await t.send({
            content: `${others.map((id) => `<@${id}>`).join(' ')}\n**Message from <@${uid}>:** ${text}`,
            allowedMentions: { users: others },
          });
          pingCooldown.set(uid, Date.now());
          return interaction.editReply({ content: `Pinged ${others.length} ${others.length === 1 ? 'person' : 'people'} in <#${s.threadId}>.` });
        }
      }
      return;
    }

    // ----- the "Post Scrim" button opens the form -----
    if (interaction.isButton() && interaction.customId === 'postscrim') {
      if (!interaction.guildId || !configComplete(getConfig(interaction.guildId))) {
        return interaction.reply({
          content: 'This server is not set up yet. The server owner needs to run `/setup set` first.',
          flags: EPHEMERAL,
        });
      }
      return interaction.showModal(buildScrimModal());
    }

    // ----- the submitted form creates the scrim -----
    if (interaction.isModalSubmit && interaction.isModalSubmit() && interaction.customId === 'scrimform') {
      await interaction.deferReply({ flags: EPHEMERAL });
      const team1 = interaction.fields.getTextInputValue('team1').trim();
      const team2 = interaction.fields.getTextInputValue('team2').trim();
      const time = interaction.fields.getTextInputValue('time').trim();
      const notes = (interaction.fields.getTextInputValue('notes') || '').trim();
      if (!team1 || !team2 || !time) {
        return interaction.editReply({ content: 'Team 1, Team 2 and When can\'t be empty. Press **Post Scrim** to try again.' });
      }
      return createScrim(interaction, { team1, team2, time, notes });
    }

    // ----- buttons -----
    if (interaction.isButton()) {
      const [action, idStr] = interaction.customId.split(':');
      if (action !== 'claim' && action !== 'unclaim' && action !== 'close') return;
      const s = db.scrims[idStr];
      if (!s) {
        return interaction.reply({ content: 'This scrim is no longer available.', flags: EPHEMERAL });
      }
      const uid = interaction.user.id;
      const gid = s.guildId || interaction.guildId;

      // ----- Close Scrim (the button inside the thread) -----
      if (action === 'close') {
        if (isClosed(s)) return interaction.reply({ content: 'This scrim is already closed.', flags: EPHEMERAL });
        if (uid !== s.authorId && !s.casters.includes(uid) && !isMod(interaction)) {
          return interaction.reply({ content: 'Only the poster, the caster or a moderator can close this scrim.', flags: EPHEMERAL });
        }
        s.closed = true;
        s.closedBy = uid;
        save();
        await interaction.update({ components: [buildCloseRow(s, true)] }); // greys out the button right away
        await editScrimMessage(s).catch((e) => console.error('Could not edit scrim message:', e.message));
        const t = await getThread(s);
        if (t) {
          await t.send({ content: `<@${uid}> closed this scrim. This thread is now locked.`, allowedMentions: { parse: [] } }).catch(() => {});
          await t.setLocked(true).catch(() => {});
          await t.setArchived(true).catch(() => {});
        }
        await logEvent(gid, `Scrim #${s.id} closed`, `**${s.team1} vs ${s.team2}** was closed by <@${uid}>.`, 0xed4245);
        return;
      }

      if (isClosed(s)) {
        return interaction.reply({ content: 'This scrim is no longer available.', flags: EPHEMERAL });
      }

      if (action === 'claim') {
        // Only members with the configured caster role may claim
        const cfg = getConfig(s.guildId || interaction.guildId);
        if (!cfg || !cfg.casterRoleId) {
          return interaction.reply({ content: 'This server is not set up yet. The server owner needs to run `/setup set`.', flags: EPHEMERAL });
        }
        if (!interaction.member?.roles?.cache?.has(cfg.casterRoleId)) {
          return interaction.reply({ content: `You need the <@&${cfg.casterRoleId}> role to claim scrims.`, flags: EPHEMERAL });
        }
        if (s.casters.includes(uid)) {
          return interaction.reply({ content: "You've already claimed this one.", flags: EPHEMERAL });
        }
        if (s.casters.length >= MAX_CASTERS) {
          return interaction.reply({ content: 'This scrim already has a caster.', flags: EPHEMERAL });
        }
        s.casters.push(uid);
        // A co-caster who claims the scrim becomes the main caster instead
        s.cocasters = (s.cocasters || []).filter((id) => id !== uid);
        save();
        await refreshMessage(interaction, s);
        logEvent(gid, `Scrim #${s.id} claimed`, `<@${uid}> claimed **${s.team1} vs ${s.team2}**.`, 0x57f287);

        if (s.threadId) {
          const ok = await addToThread(s, uid, `<@${uid}> claimed this scrim.`);
          interaction
            .followUp({
              content: ok
                ? `You claimed Scrim #${s.id}. Thread: <#${s.threadId}>`
                : `You claimed Scrim #${s.id}, but I couldn't add you to the thread. Ask the server owner to check my Manage Threads permission.`,
              flags: EPHEMERAL,
            })
            .catch(() => {});
        }
        return;
      }

      // unclaim
      if (!s.casters.includes(uid)) {
        return interaction.reply({ content: "You haven't claimed this scrim.", flags: EPHEMERAL });
      }
      s.casters = s.casters.filter((id) => id !== uid);
      save();
      await refreshMessage(interaction, s);
      logEvent(gid, `Scrim #${s.id} unclaimed`, `<@${uid}> gave up **${s.team1} vs ${s.team2}**. It is open for casters again.`, 0xfee75c);
      // the poster stays in the thread even if they unclaim
      if (s.threadId && uid !== s.authorId) {
        await removeFromThread(s, uid, `<@${uid}> unclaimed this scrim and left the thread.`);
      }
      return;
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      const msg = { content: 'Something went wrong.', flags: EPHEMERAL };
      if (interaction.deferred || interaction.replied) interaction.editReply(msg).catch(() => {});
      else interaction.reply(msg).catch(() => {});
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
client.on('error', (e) => console.error('Client error:', shortErr(e)));
client.on('warn', (m) => console.warn('Client warn:', m));
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', shortErr(e)));
client.rest.on('rateLimited', (info) => console.warn('[rateLimited]', JSON.stringify(info)));
client.rest.on('invalidRequestWarning', (info) => console.warn('[invalidRequestWarning]', JSON.stringify(info)));
client.on('shardError', (e) => console.error('[shardError]', shortErr(e)));
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
  if (s === 429 || s === 403) console.error("[preflight] Discord is blocking or throttling this server's IP address.");
}

const LOGIN_RETRY_MS = Number(process.env.LOGIN_RETRY_MS) || 15000;
const GIVE_UP_AFTER_MS = Number(process.env.GIVE_UP_AFTER_MS) || 300000;

// If the bot still isn't connected after 5 minutes, exit so the host (pm2, Render...) restarts it fresh
setTimeout(() => {
  if (!client.isReady()) {
    console.error(`Not connected after ${Math.round(GIVE_UP_AFTER_MS / 1000)}s. Exiting so the host restarts the bot.`);
    process.exit(1);
  }
}, GIVE_UP_AFTER_MS);

(async () => {
  if (!TOKEN || !CLIENT_ID) {
    console.error('DISCORD_TOKEN and CLIENT_ID must both be set in the environment.');
  }
  await preflight();
  // Flaky networks fail logins now and then, so retry instead of giving up on the first error
  for (let attempt = 1; ; attempt++) {
    console.log(`Logging in (attempt ${attempt})...`);
    try {
      await client.login(TOKEN);
      console.log('Login request accepted');
      break;
    } catch (e) {
      console.error('LOGIN FAILED:', shortErr(e));
      if (e && e.code === 'TokenInvalid') {
        console.error('The token is invalid. Reset it in the Discord Developer Portal and update DISCORD_TOKEN.');
        process.exit(1);
        return;
      }
      console.log(`Trying again in ${Math.round(LOGIN_RETRY_MS / 1000)}s...`);
      await new Promise((r) => setTimeout(r, LOGIN_RETRY_MS));
    }
  }
})();
