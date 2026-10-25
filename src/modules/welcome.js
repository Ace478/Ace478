// /bienvenue : panneau de configuration des messages d'arrivée / départ
// et des rôles automatiques. Les messages se personnalisent avec l'éditeur d'embed.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags, ButtonStyle } = require('discord.js');
const db = require('../lib/db');
const ui = require('../lib/ui');
const { canUse } = require('../lib/access');
const { registerTarget, openBuilder } = require('./embeds');
const { renderTemplate, memberVars, fail, info } = require('../lib/utils');

const DEFAULTS = {
  welcome: {
    content: '{user}',
    embeds: [
      {
        color: 0x2b2d31,
        description: [
          '# 👋 Bienvenue sur {server}, {user} !',
          'Ravi de te voir ici, **{user.name}**, tu es notre **{server.members}e membre** !',
          '',
          'Prends le temps de lire {salon:regles} et jette un œil à {salon:infos} pour bien démarrer !',
        ].join('\n'),
        thumbnail: { url: '{user.avatar}' },
      },
    ],
  },
  leave: {
    content: '',
    embeds: [
      {
        color: 0xef4444,
        description: '😢 **{user.name}** a quitté le serveur. Nous sommes maintenant **{server.members}** membres.',
        thumbnail: { url: '{user.avatar}' },
      },
    ],
  },
};

const LABELS = { welcome: 'Message de bienvenue', leave: 'Message de départ' };

// Message configuré (compatible avec l'ancien format modèle + texte).
function messageOf(data, type) {
  const cfg = data[type];
  if (cfg.message) return cfg.message;
  const base = cfg.template && data.embeds[cfg.template] ? structuredClone(data.embeds[cfg.template]) : structuredClone(DEFAULTS[type]);
  if (cfg.content) base.content = cfg.content;
  return base;
}

function buildMessage(data, type, member) {
  return renderTemplate(messageOf(data, type), memberVars(member, member.guild));
}

async function sendWelcome(member, type) {
  const data = db.guild(member.guild.id);
  const cfg = data[type];
  if (!cfg.enabled) return;
  const payload = { ...buildMessage(data, type, member), allowedMentions: { users: [member.id] } };
  if (cfg.channelId) {
    const channel = member.guild.channels.cache.get(cfg.channelId);
    if (channel?.isTextBased()) await channel.send(payload).catch((err) => console.error('[bienvenue]', err.message));
  }
  if (type === 'welcome' && cfg.dm) await member.send(payload).catch(() => null);
}

function canManage(member) {
  return canUse(member, 'bienvenue', PermissionFlagsBits.ManageGuild);
}

function view(guild) {
  const data = db.guild(guild.id);
  const state = (cfg) => `${cfg.enabled ? '🟢 Activé' : '🔴 Désactivé'} • ${cfg.channelId ? `<#${cfg.channelId}>` : '*aucun salon*'}`;
  const embed = info(
    [
      `**👋 Bienvenue :** ${state(data.welcome)}${data.welcome.dm ? ' • 📩 + MP' : ''}`,
      `**😢 Départ :** ${state(data.leave)}`,
      `**🎭 Rôles automatiques :** ${data.autoRoles.map((id) => `<@&${id}>`).join(' ') || '*aucun*'}`,
      '',
      '• Choisissez les salons et rôles avec les menus.',
      '• **🎨 Personnaliser** ouvre l\'éditeur pour changer le texte, la couleur, l\'image (bannière), etc.',
      '• **🧪 Tester** vous montre le message tel que les membres le verront.',
    ].join('\n'),
  ).setTitle('👋 Bienvenue & départs');

  return {
    embeds: [embed],
    components: [
      ui.channelSelect('wel:chan:welcome', '👋 Salon des messages de bienvenue', [ChannelType.GuildText, ChannelType.GuildAnnouncement], data.welcome.channelId),
      ui.channelSelect('wel:chan:leave', '😢 Salon des messages de départ', [ChannelType.GuildText, ChannelType.GuildAnnouncement], data.leave.channelId),
      ui.roleSelect('wel:roles', '🎭 Rôles donnés automatiquement à l\'arrivée', data.autoRoles),
      ui.row(
        ui.toggleButton('wel:toggle:welcome', 'Bienvenue', data.welcome.enabled),
        ui.toggleButton('wel:toggle:leave', 'Départ', data.leave.enabled),
        ui.toggleButton('wel:toggle:dm', 'MP de bienvenue', data.welcome.dm),
      ),
      ui.row(
        ui.button('wel:edit:welcome', 'Personnaliser bienvenue', '🎨', ButtonStyle.Primary),
        ui.button('wel:edit:leave', 'Personnaliser départ', '🎨', ButtonStyle.Primary),
        ui.button('wel:test:welcome', 'Tester', '🧪'),
        ui.button('wel:test:leave', 'Tester départ', '🧪'),
        ui.button('wel:reset:welcome', 'Bienvenue par défaut', '♻️', ButtonStyle.Danger).setDisabled(!data.welcome.message),
      ),
    ],
  };
}

for (const type of ['welcome', 'leave']) {
  registerTarget(type, {
    load: (guild) => messageOf(db.guild(guild.id), type),
    save: (guild, id, data) => {
      db.guild(guild.id)[type].message = data;
      db.save(guild.id);
    },
    title: () => LABELS[type],
    back: (guild) => view(guild),
  });
}

const command = {
  data: new SlashCommandBuilder()
    .setName('bienvenue')
    .setDescription('Configurer les messages de bienvenue, de départ et les rôles automatiques')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),

  async execute(interaction) {
    return interaction.reply({ ...view(interaction.guild), flags: MessageFlags.Ephemeral });
  },
};

const components = {
  async wel(interaction, [action, key]) {
    if (!canManage(interaction.member)) return fail(interaction, 'Accès refusé.');
    const { guild } = interaction;
    const data = db.guild(guild.id);

    if (action === 'chan') {
      data[key].channelId = interaction.values[0] || null;
      if (interaction.values[0]) data[key].enabled = true;
    }

    if (action === 'roles') {
      const me = guild.members.me;
      const refused = [];
      data.autoRoles = interaction.values.filter((id) => {
        const role = guild.roles.cache.get(id);
        const okRole = role && !role.managed && role.position < me.roles.highest.position;
        if (!okRole) refused.push(id);
        return okRole;
      });
      db.save(guild.id);
      await interaction.update(view(guild));
      if (refused.length) {
        return fail(interaction, `Je ne peux pas donner ${refused.map((id) => `<@&${id}>`).join(' ')} : placez mon rôle **au-dessus** dans les paramètres du serveur.`);
      }
      return;
    }

    if (action === 'toggle') {
      if (key === 'dm') data.welcome.dm = !data.welcome.dm;
      else data[key].enabled = !data[key].enabled;
    }

    if (action === 'reset') {
      data[key].message = null;
      data[key].template = null;
      data[key].content = '';
    }

    if (action === 'edit') return openBuilder(interaction, key, null);

    if (action === 'test') {
      return interaction.reply({ ...buildMessage(data, key, interaction.member), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }

    db.save(guild.id);
    return interaction.update(view(guild));
  },
};

const events = {
  async guildMemberAdd(member) {
    const data = db.guild(member.guild.id);
    if (data.autoRoles.length && !member.user.bot) {
      await member.roles.add(data.autoRoles.filter((id) => member.guild.roles.cache.has(id)), 'Rôle automatique').catch((err) => console.error('[autorole]', err.message));
    }
    await sendWelcome(member, 'welcome');
  },
  async guildMemberRemove(member) {
    await sendWelcome(member, 'leave');
  },
};

module.exports = {
  commands: [command],
  components,
  events,
  dashboard: { key: 'bienvenue', label: 'Bienvenue & départs', emoji: '👋', canAccess: canManage, view: (interaction) => view(interaction.guild) },
};
