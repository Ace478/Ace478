// Messages de bienvenue / départ + rôles automatiques à l'arrivée.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const db = require('../lib/db');
const { renderTemplate, memberVars, ok, fail, info } = require('../lib/utils');

const DEFAULTS = {
  welcome: {
    embeds: [
      {
        color: 0x3b82f6,
        author: { name: '{server}', icon_url: '{server.icon}' },
        title: '👋 Bienvenue {user.displayname} !',
        description: 'Bienvenue {user} sur **{server}** !\nNous sommes maintenant **{server.members}** membres.\n\n> Pense à lire le règlement et amuse-toi bien 🎉',
        thumbnail: { url: '{user.avatar}' },
        timestamp: true,
      },
    ],
  },
  leave: {
    embeds: [
      {
        color: 0xef4444,
        description: '😢 **{user.name}** a quitté le serveur. Nous sommes maintenant **{server.members}** membres.',
        thumbnail: { url: '{user.avatar}' },
      },
    ],
  },
};

function buildMessage(guildData, type, member) {
  const cfg = guildData[type];
  const base = cfg.template && guildData.embeds[cfg.template] ? structuredClone(guildData.embeds[cfg.template]) : structuredClone(DEFAULTS[type]);
  if (cfg.content) base.content = cfg.content;
  return renderTemplate(base, memberVars(member, member.guild));
}

async function sendWelcome(member, type, { force = false } = {}) {
  const data = db.guild(member.guild.id);
  const cfg = data[type];
  if (!force && !cfg.enabled) return false;
  const payload = buildMessage(data, type, member);
  payload.allowedMentions = { users: [member.id] };
  let sent = false;
  if (cfg.channelId) {
    const channel = member.guild.channels.cache.get(cfg.channelId);
    if (channel?.isTextBased()) sent = !!(await channel.send(payload).catch((err) => console.error('[accueil]', err.message)));
  }
  if (type === 'welcome' && cfg.dm) {
    await member.send(payload).catch(() => null);
    sent = true;
  }
  return sent;
}

function templateOption(o) {
  return o.setName('modele').setDescription('Modèle d\'embed (/embed creer) — "aucun" pour le message par défaut').setAutocomplete(true);
}

const command = {
  data: new SlashCommandBuilder()
    .setName('accueil')
    .setDescription('Messages de bienvenue, de départ et rôles automatiques')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('bienvenue')
        .setDescription('Configurer le message de bienvenue')
        .addBooleanOption((o) => o.setName('actif').setDescription('Activer / désactiver'))
        .addChannelOption((o) => o.setName('salon').setDescription('Salon').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption((o) => o.setName('texte').setDescription('Texte au-dessus de l\'embed (ex: {user}). "aucun" pour retirer'))
        .addStringOption(templateOption)
        .addBooleanOption((o) => o.setName('mp').setDescription('Envoyer aussi le message en MP au nouveau membre')),
    )
    .addSubcommand((s) =>
      s
        .setName('depart')
        .setDescription('Configurer le message de départ')
        .addBooleanOption((o) => o.setName('actif').setDescription('Activer / désactiver'))
        .addChannelOption((o) => o.setName('salon').setDescription('Salon').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption((o) => o.setName('texte').setDescription('Texte au-dessus de l\'embed. "aucun" pour retirer'))
        .addStringOption(templateOption),
    )
    .addSubcommand((s) =>
      s
        .setName('autorole')
        .setDescription('Ajouter / retirer un rôle donné automatiquement à l\'arrivée')
        .addRoleOption((o) => o.setName('role').setDescription('Rôle').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('test')
        .setDescription('Tester le message sur vous-même')
        .addStringOption((o) =>
          o
            .setName('type')
            .setDescription('Message à tester')
            .setRequired(true)
            .addChoices({ name: 'Bienvenue', value: 'welcome' }, { name: 'Départ', value: 'leave' }),
        ),
    )
    .addSubcommand((s) => s.setName('voir').setDescription('Voir la configuration')),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const names = ['aucun', ...Object.keys(db.guild(interaction.guildId).embeds)];
    await interaction.respond(
      names
        .filter((n) => n.includes(focused))
        .slice(0, 25)
        .map((n) => ({ name: n, value: n })),
    );
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const data = db.guild(interaction.guildId);
    const o = interaction.options;

    if (sub === 'bienvenue' || sub === 'depart') {
      const cfg = data[sub === 'bienvenue' ? 'welcome' : 'leave'];
      if (o.getBoolean('actif') !== null) cfg.enabled = o.getBoolean('actif');
      if (o.getChannel('salon')) {
        cfg.channelId = o.getChannel('salon').id;
        if (o.getBoolean('actif') === null) cfg.enabled = true;
      }
      const text = o.getString('texte');
      if (text !== null) cfg.content = text.toLowerCase() === 'aucun' ? '' : text.replace(/\\n/g, '\n');
      const template = o.getString('modele');
      if (template !== null) {
        if (template === 'aucun') cfg.template = null;
        else if (!data.embeds[template]) return fail(interaction, `Le modèle \`${template}\` n'existe pas. Créez-le avec \`/embed creer\`.`);
        else cfg.template = template;
      }
      if (sub === 'bienvenue' && o.getBoolean('mp') !== null) cfg.dm = o.getBoolean('mp');
      db.save(interaction.guildId);
      return ok(interaction, `Message de ${sub === 'bienvenue' ? 'bienvenue' : 'départ'} ${cfg.enabled ? 'activé' : 'désactivé'}${cfg.channelId ? ` dans <#${cfg.channelId}>` : ''}. Testez avec \`/accueil test\`.`);
    }

    if (sub === 'autorole') {
      const role = o.getRole('role');
      if (role.managed || role.id === interaction.guildId) return fail(interaction, 'Ce rôle ne peut pas être attribué.');
      if (role.position >= interaction.guild.members.me.roles.highest.position) {
        return fail(interaction, `Je ne peux pas donner ${role} : placez mon rôle **au-dessus** dans les paramètres du serveur.`);
      }
      const idx = data.autoRoles.indexOf(role.id);
      if (idx >= 0) data.autoRoles.splice(idx, 1);
      else data.autoRoles.push(role.id);
      db.save(interaction.guildId);
      return ok(interaction, idx >= 0 ? `${role} ne sera plus donné automatiquement.` : `${role} sera donné à chaque nouveau membre.`);
    }

    if (sub === 'test') {
      const type = o.getString('type');
      const payload = buildMessage(data, type, interaction.member);
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      if (!data[type].channelId) await fail(interaction, 'Aucun salon configuré : le message ne sera envoyé nulle part.');
      return;
    }

    if (sub === 'voir') {
      const line = (cfg) =>
        `${cfg.enabled ? '🟢 Actif' : '🔴 Inactif'} • ${cfg.channelId ? `<#${cfg.channelId}>` : '*aucun salon*'} • modèle : ${cfg.template ? `\`${cfg.template}\`` : '*par défaut*'}${cfg.content ? `\nTexte : ${cfg.content}` : ''}`;
      return interaction.reply({
        embeds: [
          info(
            [
              `**Bienvenue :** ${line(data.welcome)}${data.welcome.dm ? ' • + MP' : ''}`,
              `**Départ :** ${line(data.leave)}`,
              `**Rôles automatiques :** ${data.autoRoles.map((id) => `<@&${id}>`).join(' ') || '*aucun*'}`,
            ].join('\n\n'),
          ).setTitle('👋 Accueil'),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }
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

module.exports = { commands: [command], events };
