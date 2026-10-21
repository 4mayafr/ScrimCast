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
  ChannelType,
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

const EPHEMERAL = MessageFlags.Ephemeral;

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
  const cocasters = s.cocasters || [];
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
  if (cocasters.length) {
    embed.addFields({ name: 'Co-casters', value: cocasters.map((id) => `<@${id}>`).join('\n') });
  }
  if (s.threadId) {
    embed.addFields({ name: 'Thread', value: `<#${s.threadId}> (private: poster, casters and co-casters)` });
  }
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
    .addSubcommand((c) =>
      c
        .setName('addcocaster')
        .setDescription('Add a co-caster to the scrim thread (for casters who claimed it)')
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

// ---------- thread helpers ----------
async function createScrimThread(channel, s) {
  const base = {
    name: `Scrim #${s.id}: ${s.team1} vs ${s.team2}`.slice(0, 100),
    type: ChannelType.PrivateThread,
    invitable: false, // only the bot (via the commands below) can add people
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

async function refreshMessage(interaction, s) {
  await interaction.update({ embeds: [buildEmbed(s)], components: [buildButtons(s)] });
}

client.on('interactionCreate', async (interaction) => {
  try {
    // ----- slash commands -----
    if (interaction.isChatInputCommand() && interaction.commandName === 'scrim') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'post') {
        await interaction.deferReply({ flags: EPHEMERAL });

        const s = {
          id: db.nextId,
          game: interaction.options.getString('game'),
          team1: interaction.options.getString('team1'),
          team2: interaction.options.getString('team2'),
          time: interaction.options.getString('time'),
          slots: interaction.options.getInteger('slots') ?? 2,
          notes: interaction.options.getString('notes') || '',
          authorId: interaction.user.id,
          casters: [],
          cocasters: [],
          cancelled: false,
          channelId: null,
          messageId: null,
          threadId: null,
        };

        let channel = interaction.channel;
        if (SCRIM_CHANNEL_ID) {
          channel = (await client.channels.fetch(SCRIM_CHANNEL_ID).catch(() => null)) || channel;
        }
        if (channel && channel.isThread()) channel = channel.parent; // threads can't hold threads

        // 1) create the private thread
        let thread;
        try {
          thread = await createScrimThread(channel, s);
        } catch (e) {
          console.error('Thread creation failed:', e.message);
          return interaction.editReply({
            content:
              `I couldn't create the scrim thread in <#${channel.id}>. Give me **Create Private Threads**, ` +
              '**Send Messages in Threads** and **Manage Threads** in that channel, then try again.',
          });
        }
        s.threadId = thread.id;

        // 2) post the scrim message (it links to the thread)
        let msg;
        try {
          const content = CASTER_ROLE_ID
            ? `<@&${CASTER_ROLE_ID}> new scrim up for casting!`
            : 'New scrim up for casting!';
          msg = await channel.send({
            content,
            embeds: [buildEmbed(s)],
            components: [buildButtons(s)],
            allowedMentions: CASTER_ROLE_ID ? { roles: [CASTER_ROLE_ID] } : { parse: [] },
          });
        } catch (e) {
          console.error('Posting scrim failed:', e.message);
          await thread.delete().catch(() => {});
          return interaction.editReply({ content: "I couldn't post the scrim in that channel. Check my permissions there." });
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
              `Posted by <@${s.authorId}>. Casters who claim this scrim are added here automatically.\n` +
              'Claimed casters can add helpers with `/scrim addcocaster`, or remove them with `/scrim removecocaster`.',
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
        const isMod = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);
        if (s.authorId !== interaction.user.id && !isMod) {
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
        const s = findScrim(interaction);
        if (!s) {
          return interaction.editReply({
            content: 'Scrim not found. Run this inside the scrim thread, or give the scrim number in the `id` option.',
          });
        }
        if (s.cancelled) return interaction.editReply({ content: 'That scrim was cancelled.' });
        if (!s.threadId) {
          return interaction.editReply({ content: 'This scrim has no thread (it was posted before threads were added).' });
        }

        const uid = interaction.user.id;
        const isMod = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);
        if (!s.casters.includes(uid) && s.authorId !== uid && !isMod) {
          return interaction.editReply({ content: 'Only casters who claimed this scrim (or the poster) can change co-casters.' });
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
          const ok = await addToThread(s, target.id, `<@${target.id}> was added as a co-caster by <@${uid}>.`);
          if (!ok) {
            return interaction.editReply({
              content:
                `I couldn't add <@${target.id}>. Check that they can see <#${s.channelId}> and that I have ` +
                '**Manage Threads** there.',
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
        if (CASTER_ROLE_ID && !interaction.member.roles.cache.has(CASTER_ROLE_ID)) {
          return interaction.reply({ content: 'You need the caster role to claim scrims.', flags: EPHEMERAL });
        }
        if (s.casters.includes(uid)) {
          return interaction.reply({ content: "You've already claimed this one.", flags: EPHEMERAL });
        }
        if (s.casters.length >= s.slots) {
          return interaction.reply({ content: 'All caster slots are taken.', flags: EPHEMERAL });
        }
        s.casters.push(uid);
        // A co-caster who claims a slot becomes a main caster instead
        s.cocasters = (s.cocasters || []).filter((id) => id !== uid);
        save();
        await refreshMessage(interaction, s);

        if (s.threadId) {
          const ok = await addToThread(s, uid, `<@${uid}> claimed this scrim.`);
          interaction
            .followUp({
              content: ok
                ? `You claimed Scrim #${s.id}. Thread: <#${s.threadId}>`
                : `You claimed Scrim #${s.id}, but I couldn't add you to the thread. Ask a moderator to check my Manage Threads permission.`,
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
client.on('error', (e) => console.error('Client error:', e));
client.on('warn', (m) => console.warn('Client warn:', m));
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
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
  if (s === 429 || s === 403) console.error("[preflight] Discord is blocking or throttling this server's IP address.");
}

// If the bot hasn't connected after 2 minutes, exit so the host (pm2, Render...) restarts it
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
