require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

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
const STATUS_TEXT = clean(process.env.STATUS_TEXT).slice(0, 128) || 'Scrim Board | /scrim post'; // "Playing ..."
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

// ---------- UI helpers ----------
function buildEmbed(s) {
  const cocasters = s.cocasters || [];
  const open = s.casters.length < MAX_CASTERS && !s.cancelled;
  const embed = new EmbedBuilder()
    .setTitle(`${s.game}: ${s.team1} vs ${s.team2}`)
    .setColor(s.cancelled ? 0x808080 : open ? 0x57f287 : 0xed4245)
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
    .setFooter({ text: `Scrim #${s.id}${s.cancelled ? ' · CANCELLED' : ''}` });
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
    .setName('setup')
    .setDescription('Server owner only: configure the scrim board')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((c) =>
      c
        .setName('set')
        .setDescription('Set where scrims are posted, where private threads are made, and who can claim')
        .addChannelOption((o) =>
          o
            .setName('post_channel')
            .setDescription('Channel where scrims are posted')
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
        .addRoleOption((o) =>
          o.setName('caster_role').setDescription('Only this role can use the Claim button').setRequired(true)
        )
    )
    .addSubcommand((c) => c.setName('view').setDescription('Show the current setup'))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Bot owner only: manage the bot itself')
    .addSubcommand((c) => c.setName('status').setDescription('Show uptime, memory and scrim counts'))
    .addSubcommand((c) => c.setName('logs').setDescription('Show the most recent log lines'))
    .addSubcommand((c) => c.setName('restart').setDescription('Restart the bot (needs pm2 to come back by itself)'))
    .addSubcommand((c) => c.setName('shutdown').setDescription('Turn the bot off (under pm2 it stays off until you start it again)'))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('scrim')
    .setDescription('Scrim board')
    .addSubcommand((c) =>
      c
        .setName('post')
        .setDescription('Post a scrim for a caster to claim')
        .addStringOption((o) => o.setName('game').setDescription('Game (e.g. Valorant)').setRequired(true))
        .addStringOption((o) => o.setName('team1').setDescription('Team 1').setRequired(true))
        .addStringOption((o) => o.setName('team2').setDescription('Team 2').setRequired(true))
        .addStringOption((o) =>
          o.setName('time').setDescription('When, e.g. "Sat 25 Oct 7pm AEDT" or <t:1761379200:F>').setRequired(true)
        )
        .addStringOption((o) => o.setName('notes').setDescription('Extra info (maps, format, lobby details)'))
    )
    .addSubcommand((c) =>
      c
        .setName('cancel')
        .setDescription('Cancel a scrim you posted')
        .addIntegerOption((o) => o.setName('id').setDescription('Scrim number').setRequired(true))
    )
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
  if (s.cancelled) {
    await interaction.editReply({ content: 'That scrim was cancelled.' });
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
    const open = all.filter((s) => !s.cancelled && s.casters.length < MAX_CASTERS).length;
    const mb = (n) => (n / 1048576).toFixed(0);
    return interaction.editReply({
      content:
        '**Bot status**\n' +
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
              `**Scrim posts:** <#${c.postChannelId}>\n` +
              `**Private threads are created in:** <#${c.threadChannelId}>\n` +
              `**Role that can claim:** <@&${c.casterRoleId}>`,
          });
        }

        // sub === 'set'
        const post = interaction.options.getChannel('post_channel', true);
        const threads = interaction.options.getChannel('thread_channel', true);
        const role = interaction.options.getRole('caster_role', true);
        db.config[interaction.guildId] = { postChannelId: post.id, threadChannelId: threads.id, casterRoleId: role.id };
        save();

        const me = interaction.guild.members.me || (await interaction.guild.members.fetchMe().catch(() => null));
        const warnings = [];
        if (me) {
          const m1 = missingPerms(post, me, ['ViewChannel', 'SendMessages', 'EmbedLinks']);
          const m2 = missingPerms(threads, me, ['ViewChannel', 'CreatePrivateThreads', 'SendMessagesInThreads', 'ManageThreads']);
          if (m1.length) warnings.push(`I'm missing in <#${post.id}>: ${m1.join(', ')}`);
          if (m2.length) warnings.push(`I'm missing in <#${threads.id}>: ${m2.join(', ')}`);
        }
        return interaction.editReply({
          content:
            'Saved.\n' +
            `**Scrim posts:** <#${post.id}>\n` +
            `**Private threads are created in:** <#${threads.id}>\n` +
            `**Role that can claim:** <@&${role.id}>\n\n` +
            (warnings.length ? `Fix these permissions:\n- ${warnings.join('\n- ')}\n\n` : '') +
            `Everyone who posts scrims or casts must be able to see <#${threads.id}> and send messages in threads there.`,
        });
      }

      // ===== /scrim ... =====
      if (interaction.commandName === 'scrim') {
        const sub = interaction.options.getSubcommand();

        if (sub === 'post') {
          await interaction.deferReply({ flags: EPHEMERAL });

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
            game: interaction.options.getString('game'),
            team1: interaction.options.getString('team1'),
            team2: interaction.options.getString('team2'),
            time: interaction.options.getString('time'),
            notes: interaction.options.getString('notes') || '',
            authorId: interaction.user.id,
            casters: [],
            cocasters: [],
            cancelled: false,
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
                `The caster can add up to ${MAX_COCASTERS} co-casters with \`/scrim addcocaster\`, and ping everyone here with \`/scrim ping\`.`,
              allowedMentions: { parse: [] },
            })
            .catch((e) => console.error('Could not send thread intro:', e.message));

          return interaction.editReply({ content: `Scrim #${s.id} posted in <#${s.channelId}>. Thread: <#${thread.id}>` });
        }

        if (sub === 'cancel') {
          await interaction.deferReply({ flags: EPHEMERAL });
          const id = interaction.options.getInteger('id');
          const s = db.scrims[id];
          if (!s) return interaction.editReply({ content: 'Scrim not found.' });
          if (s.authorId !== interaction.user.id && !isMod(interaction)) {
            return interaction.editReply({ content: 'Only the poster or a moderator can cancel this.' });
          }
          s.cancelled = true;
          save();
          await editScrimMessage(s).catch((e) => console.error('Could not edit scrim message:', e.message));
          const t = await getThread(s);
          if (t) {
            await t.send({ content: 'This scrim was cancelled. Archiving the thread.', allowedMentions: { parse: [] } }).catch(() => {});
            await t.setArchived(true).catch(() => {});
          }
          return interaction.editReply({ content: `Scrim #${id} cancelled.` });
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

    // ----- buttons -----
    if (interaction.isButton()) {
      const [action, idStr] = interaction.customId.split(':');
      if (action !== 'claim' && action !== 'unclaim') return;
      const s = db.scrims[idStr];
      if (!s || s.cancelled) {
        return interaction.reply({ content: 'This scrim is no longer available.', flags: EPHEMERAL });
      }
      const uid = interaction.user.id;

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
