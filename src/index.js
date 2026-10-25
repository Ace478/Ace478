require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Events, ActivityType, MessageFlags } = require('discord.js');
const db = require('./lib/db');
const { fail } = require('./lib/utils');
const { canUse, isOwner } = require('./lib/access');
const modules = require('./modules');

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN manquant. Copiez .env.example en .env et remplissez-le.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // intent privilégié : à activer dans le Developer Portal
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // intent privilégié : à activer dans le Developer Portal
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildExpressions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User],
});

const commands = new Map();
const components = new Map();
const events = new Map();

for (const mod of modules) {
  for (const command of mod.commands || []) commands.set(command.data.name, command);
  for (const [prefix, handler] of Object.entries(mod.components || {})) components.set(prefix, handler);
  for (const [name, handler] of Object.entries(mod.events || {})) {
    if (!events.has(name)) events.set(name, []);
    events.get(name).push(handler);
  }
}

for (const [name, handlers] of events) {
  client.on(name, async (...args) => {
    for (const handler of handlers) {
      try {
        await handler(...args);
      } catch (err) {
        console.error(`[event ${name}]`, err);
      }
    }
  });
}

// Les commandes sont enregistrées par serveur : elles apparaissent instantanément.
async function registerCommands(guild) {
  try {
    // Les permissions sont vérifiées par le bot (WL / owners) : toutes les commandes
    // sont donc visibles côté Discord, et refusées si le membre n'y a pas accès.
    await guild.commands.set([...commands.values()].map((c) => ({ ...c.data.toJSON(), default_member_permissions: null })));
  } catch (err) {
    console.error(`[commandes] Échec sur ${guild.name}:`, err.message);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag} sur ${client.guilds.cache.size} serveur(s).`);
  client.user.setActivity(process.env.STATUS || '/aide', { type: ActivityType.Watching });
  for (const mod of modules) mod.init?.(client);
  for (const guild of client.guilds.cache.values()) await registerCommands(guild);
  console.log(`✅ ${commands.size} commandes enregistrées.`);
});

client.on(Events.GuildCreate, registerCommands);

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.inGuild()) {
    if (interaction.isRepliable()) await interaction.reply({ content: 'Utilisez-moi sur un serveur 🙂', flags: MessageFlags.Ephemeral }).catch(() => null);
    return;
  }
  try {
    if (interaction.isAutocomplete()) {
      const command = commands.get(interaction.commandName);
      if (command?.autocomplete) await command.autocomplete(interaction);
      return;
    }
    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      if (!command) return;
      const allowed =
        command.access === 'owner'
          ? isOwner(interaction.member)
          : canUse(interaction.member, command.data.name, command.data.default_member_permissions ? BigInt(command.data.default_member_permissions) : null);
      if (!allowed) {
        return fail(interaction, command.access === 'owner' ? 'Commande réservée aux owners.' : 'Vous n\'avez pas accès à cette commande (permission ou WL manquante).');
      }
      await command.execute(interaction);
      return;
    }
    if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
      const [prefix, ...args] = interaction.customId.split(':');
      const handler = components.get(prefix);
      if (handler) await handler(interaction, args);
    }
  } catch (err) {
    console.error('[interaction]', err);
    if (interaction.isRepliable()) {
      await fail(interaction, `Une erreur est survenue : \`${String(err.message).slice(0, 300)}\``).catch(() => null);
    }
  }
});

function shutdown() {
  db.flush();
  client.destroy();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  if (/disallowed intents/i.test(err.message)) {
    console.error('❌ Intents manquants : sur https://discord.com/developers/applications > votre bot > Bot,');
    console.error('   activez SERVER MEMBERS INTENT et MESSAGE CONTENT INTENT, cliquez sur Save Changes puis relancez.');
  } else if (/token/i.test(err.message)) {
    console.error('❌ Token invalide : vérifiez DISCORD_TOKEN dans le fichier .env.');
  } else {
    console.error('❌ Connexion impossible :', err.message);
  }
  process.exit(1);
});
