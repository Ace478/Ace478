// /wl : panneau de gestion des accès.
// - WL owner : accès total au bot (modifiable uniquement par le propriétaire du serveur / du bot)
// - WL : membres et rôles autorisés à utiliser les commandes cochées
const { SlashCommandBuilder, MessageFlags, StringSelectMenuBuilder, ButtonStyle, MentionableSelectMenuBuilder } = require('discord.js');
const db = require('../lib/db');
const ui = require('../lib/ui');
const { isOwner, isTrueOwner, botOwners } = require('../lib/access');
const { fail, info, truncate } = require('../lib/utils');

// Toutes les commandes du bot sauf /wl (chargées à la demande : évite un require circulaire).
function allCommands() {
  return require('./index')
    .flatMap((m) => m.commands || [])
    .map((c) => c.data)
    .filter((d) => d.name !== 'wl');
}

function mainView(guild) {
  const wl = db.guild(guild.id).whitelist;
  const embed = info(
    [
      'La **WL** permet à des membres ou des rôles d\'utiliser les commandes que vous cochez, même sans la permission Discord.',
      '',
      `**👥 Membres & rôles (${wl.users.length + wl.roles.length}) :** ${[...wl.users.map((id) => `<@${id}>`), ...wl.roles.map((id) => `<@&${id}>`)].join(' ') || '*aucun*'}`,
      `**✅ Commandes autorisées (${wl.commands.length}) :** ${wl.commands.map((n) => `\`/${n}\``).join(' ') || '*aucune*'}`,
      `**🔒 Mode strict :** ${wl.strict ? 'activé — seuls les owners et la WL peuvent utiliser les commandes de gestion/modération' : 'désactivé — les permissions Discord fonctionnent aussi'}`,
      `**👑 Owners :** ${wl.owners.map((id) => `<@${id}>`).join(' ') || '*aucun*'} *(accès total)*`,
    ].join('\n'),
  ).setTitle('📋 Whitelist');

  const mentionable = new MentionableSelectMenuBuilder()
    .setCustomId('wl:members')
    .setPlaceholder('👥 Membres et rôles de la WL')
    .setMinValues(0)
    .setMaxValues(25);
  const defaults = [...wl.users.map((id) => ({ id, type: 'user' })), ...wl.roles.map((id) => ({ id, type: 'role' }))].slice(0, 25);
  if (defaults.length) {
    mentionable.setDefaultValues(...defaults);
  }

  const commands = allCommands().slice(0, 25);
  const cmdMenu = new StringSelectMenuBuilder()
    .setCustomId('wl:cmds')
    .setPlaceholder('✅ Commandes autorisées pour la WL')
    .setMinValues(0)
    .setMaxValues(commands.length)
    .addOptions(commands.map((d) => ({ label: `/${d.name}`, value: d.name, description: truncate(d.description, 100), default: wl.commands.includes(d.name) })));

  return {
    embeds: [embed],
    components: [
      ui.row(mentionable),
      ui.row(cmdMenu),
      ui.row(
        ui.button('wl:all', 'Tout autoriser', '✅', ButtonStyle.Success),
        ui.button('wl:none', 'Tout retirer', '✖️', ButtonStyle.Danger),
        ui.toggleButton('wl:strict', 'Mode strict', wl.strict),
        ui.button('wl:owners', 'Owners', '👑', ButtonStyle.Primary),
      ),
    ],
  };
}

function ownersView(guild, member) {
  const wl = db.guild(guild.id).whitelist;
  const canEdit = isTrueOwner(member);
  const embed = info(
    [
      'Les **owners** ont accès à **toutes** les commandes du bot et peuvent gérer la WL, comme vous.',
      canEdit ? 'Sélectionnez les membres owners dans le menu ci-dessous.' : '🔒 *Seul le propriétaire du serveur peut modifier cette liste.*',
      '',
      `👑 **Propriétaire du serveur :** <@${guild.ownerId}>`,
      ...botOwners().map((id) => `🤖 **Propriétaire du bot :** <@${id}>`),
      `**Owners (${wl.owners.length}) :** ${wl.owners.map((id) => `<@${id}>`).join(' ') || '*aucun*'}`,
    ].join('\n'),
  ).setTitle('👑 WL owner');
  return {
    embeds: [embed],
    components: [ui.userSelect('wl:setowners', '👑 Membres owners', wl.owners, { max: 25, disabled: !canEdit }), ui.row(ui.backButton('wl:home'))],
  };
}

const command = {
  access: 'owner',
  data: new SlashCommandBuilder().setName('wl').setDescription('Gérer la whitelist et les owners du bot').setDMPermission(false),

  async execute(interaction) {
    return interaction.reply({ ...mainView(interaction.guild), flags: MessageFlags.Ephemeral });
  },
};

const components = {
  async wl(interaction, [action]) {
    if (!isOwner(interaction.member)) return fail(interaction, 'Réservé aux owners.');
    const { guild } = interaction;
    const wl = db.guild(guild.id).whitelist;

    if (action === 'owners') return interaction.update(ownersView(guild, interaction.member));
    if (action === 'home') return interaction.update(mainView(guild));

    if (action === 'setowners') {
      if (!isTrueOwner(interaction.member)) return fail(interaction, 'Seul le propriétaire du serveur peut modifier les owners.');
      wl.owners = interaction.users.filter((u) => !u.bot).map((u) => u.id);
      db.save(guild.id);
      return interaction.update(ownersView(guild, interaction.member));
    }

    if (action === 'members') {
      wl.users = [...interaction.users.keys()];
      wl.roles = [...interaction.roles.keys()];
    }
    if (action === 'cmds') wl.commands = [...interaction.values];
    if (action === 'all') wl.commands = allCommands().map((d) => d.name);
    if (action === 'none') wl.commands = [];
    if (action === 'strict') wl.strict = !wl.strict;
    db.save(guild.id);
    return interaction.update(mainView(guild));
  },
};

module.exports = {
  commands: [command],
  components,
  dashboard: { key: 'wl', label: 'Whitelist & owners', emoji: '📋', canAccess: isOwner, view: (interaction) => mainView(interaction.guild) },
};
