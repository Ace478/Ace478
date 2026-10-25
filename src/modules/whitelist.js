// WL owner (accès total, gérée par le propriétaire) et WL normale
// (membres / rôles autorisés à utiliser une liste de commandes choisie).
const { SlashCommandBuilder, MessageFlags, Role } = require('discord.js');
const db = require('../lib/db');
const { isTrueOwner, botOwners } = require('../lib/access');
const { ok, fail, info } = require('../lib/utils');

const PROTECTED = ['owner', 'wl'];

// Toutes les commandes du bot (chargées à la demande pour éviter un require circulaire).
function allCommands() {
  return require('./index')
    .flatMap((m) => m.commands || [])
    .map((c) => c.data)
    .filter((d) => !PROTECTED.includes(d.name));
}

const ownerCommand = {
  access: 'owner',
  data: new SlashCommandBuilder()
    .setName('owner')
    .setDescription('WL owner : membres ayant un accès total au bot')
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('ajouter')
        .setDescription('Donner l\'accès owner à un membre (propriétaire uniquement)')
        .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('retirer')
        .setDescription('Retirer l\'accès owner (propriétaire uniquement)')
        .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('liste').setDescription('Voir la WL owner')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const wl = db.guild(interaction.guildId).whitelist;

    if (sub === 'liste') {
      const lines = [
        `👑 **Propriétaire du serveur :** <@${interaction.guild.ownerId}>`,
        ...botOwners().map((id) => `🤖 **Propriétaire du bot :** <@${id}>`),
        '',
        `**WL owner (${wl.owners.length}) :**`,
        wl.owners.map((id) => `• <@${id}>`).join('\n') || '*vide*',
      ];
      return interaction.reply({ embeds: [info(lines.join('\n')).setTitle('👑 WL owner')], flags: MessageFlags.Ephemeral });
    }

    if (!isTrueOwner(interaction.member)) return fail(interaction, 'Seul le propriétaire du serveur (ou du bot) peut modifier la WL owner.');
    const user = interaction.options.getUser('membre');
    if (user.bot) return fail(interaction, 'Impossible d\'ajouter un bot.');
    const idx = wl.owners.indexOf(user.id);

    if (sub === 'ajouter') {
      if (idx >= 0) return fail(interaction, `${user} est déjà dans la WL owner.`);
      wl.owners.push(user.id);
      db.save(interaction.guildId);
      return ok(interaction, `${user} est maintenant **owner** : accès à toutes les commandes et à la gestion de la WL.`);
    }

    if (idx < 0) return fail(interaction, `${user} n'est pas dans la WL owner.`);
    wl.owners.splice(idx, 1);
    db.save(interaction.guildId);
    return ok(interaction, `${user} n'est plus owner.`);
  },
};

const wlCommand = {
  access: 'owner',
  data: new SlashCommandBuilder()
    .setName('wl')
    .setDescription('WL : membres / rôles autorisés à utiliser certaines commandes')
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('ajouter')
        .setDescription('Ajouter un membre ou un rôle à la WL')
        .addMentionableOption((o) => o.setName('cible').setDescription('Membre ou rôle').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('retirer')
        .setDescription('Retirer un membre ou un rôle de la WL')
        .addMentionableOption((o) => o.setName('cible').setDescription('Membre ou rôle').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('autoriser')
        .setDescription('Autoriser une commande pour la WL')
        .addStringOption((o) => o.setName('commande').setDescription('Commande (ou "toutes")').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('interdire')
        .setDescription('Retirer une commande de la WL')
        .addStringOption((o) => o.setName('commande').setDescription('Commande (ou "toutes")').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('mode')
        .setDescription('Mode strict : les permissions Discord ne suffisent plus, seules la WL et les owners passent')
        .addBooleanOption((o) => o.setName('strict').setDescription('Activer le mode strict').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('liste').setDescription('Voir la WL et les commandes autorisées')),

  async autocomplete(interaction) {
    const sub = interaction.options.getSubcommand();
    const focused = interaction.options.getFocused().toLowerCase();
    const allowed = db.guild(interaction.guildId).whitelist.commands;
    const names = allCommands()
      .map((d) => d.name)
      .filter((n) => (sub === 'interdire' ? allowed.includes(n) : !allowed.includes(n)));
    await interaction.respond(
      ['toutes', ...names]
        .filter((n) => n.includes(focused))
        .slice(0, 25)
        .map((n) => ({ name: n === 'toutes' ? 'toutes (toutes les commandes)' : `/${n}`, value: n })),
    );
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const wl = db.guild(interaction.guildId).whitelist;

    if (sub === 'ajouter' || sub === 'retirer') {
      const target = interaction.options.getMentionable('cible');
      const isRole = target instanceof Role;
      const list = isRole ? wl.roles : wl.users;
      const label = isRole ? `<@&${target.id}>` : `<@${target.id}>`;
      const idx = list.indexOf(target.id);
      if (sub === 'ajouter') {
        if (idx >= 0) return fail(interaction, `${label} est déjà dans la WL.`);
        list.push(target.id);
      } else {
        if (idx < 0) return fail(interaction, `${label} n'est pas dans la WL.`);
        list.splice(idx, 1);
      }
      db.save(interaction.guildId);
      return ok(interaction, sub === 'ajouter' ? `${label} ajouté à la WL.` : `${label} retiré de la WL.`);
    }

    if (sub === 'autoriser' || sub === 'interdire') {
      const name = interaction.options.getString('commande').replace(/^\//, '').toLowerCase();
      const names = allCommands().map((d) => d.name);
      if (name !== 'toutes' && !names.includes(name)) return fail(interaction, `La commande \`/${name}\` n'existe pas.`);
      const targets = name === 'toutes' ? names : [name];
      if (sub === 'autoriser') wl.commands = [...new Set([...wl.commands, ...targets])];
      else wl.commands = wl.commands.filter((n) => !targets.includes(n));
      db.save(interaction.guildId);
      const what = name === 'toutes' ? 'Toutes les commandes' : `\`/${name}\``;
      return ok(interaction, sub === 'autoriser' ? `${what} autorisée(s) pour la WL.` : `${what} retirée(s) de la WL.`);
    }

    if (sub === 'mode') {
      wl.strict = interaction.options.getBoolean('strict');
      db.save(interaction.guildId);
      return ok(
        interaction,
        wl.strict
          ? 'Mode strict **activé** : les commandes de gestion/modération sont réservées aux owners et à la WL (pour les commandes autorisées), même pour les administrateurs.'
          : 'Mode strict **désactivé** : les membres ayant la permission Discord adéquate peuvent aussi utiliser les commandes.',
      );
    }

    if (sub === 'liste') {
      const embed = info(
        [
          `**Mode :** ${wl.strict ? '🔒 strict (WL + owners uniquement)' : '🔓 normal (WL + permissions Discord)'}`,
          '',
          `**Membres (${wl.users.length}) :** ${wl.users.map((id) => `<@${id}>`).join(' ') || '*aucun*'}`,
          `**Rôles (${wl.roles.length}) :** ${wl.roles.map((id) => `<@&${id}>`).join(' ') || '*aucun*'}`,
          '',
          `**Commandes autorisées (${wl.commands.length}) :**`,
          wl.commands.map((n) => `\`/${n}\``).join(' ') || '*aucune — `/wl autoriser`*',
        ].join('\n'),
      ).setTitle('📋 Whitelist');
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
  },
};

module.exports = { commands: [ownerCommand, wlCommand] };
