// Menus de rôles en libre-service (boutons ou menu déroulant).
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelType,
  MessageFlags,
} = require('discord.js');
const db = require('../lib/db');
const { renderTemplate, memberVars, isValidEmoji, EMOJI_ERROR, ok, fail, info, fetchMessageFromLink } = require('../lib/utils');

const DEFAULT_TEMPLATE = {
  embeds: [{ color: 0x3b82f6, title: '🎭 Choisissez vos rôles', description: 'Cliquez ci-dessous pour ajouter ou retirer un rôle.' }],
};

function buildComponents(menu) {
  if (!menu.roles.length) return [];
  if (menu.type === 'menu') {
    return [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('rm:sel')
          .setPlaceholder(menu.placeholder || 'Sélectionnez un rôle pour l\'ajouter ou le retirer')
          .setMinValues(1)
          .setMaxValues(menu.roles.length)
          .addOptions(menu.roles.map((r) => ({ label: r.label, value: r.id, emoji: r.emoji || undefined, description: r.description || undefined }))),
      ),
    ];
  }
  const rows = [];
  menu.roles.forEach((r, i) => {
    if (i % 5 === 0) rows.push(new ActionRowBuilder());
    const button = new ButtonBuilder().setCustomId(`rm:btn:${r.id}`).setLabel(r.label).setStyle(ButtonStyle.Secondary);
    if (r.emoji) button.setEmoji(r.emoji);
    rows[rows.length - 1].addComponents(button);
  });
  return rows;
}

function canManage(interaction, role) {
  if (role.managed || role.id === interaction.guildId) return 'Ce rôle ne peut pas être attribué.';
  if (role.position >= interaction.guild.members.me.roles.highest.position) return `Placez mon rôle **au-dessus** de ${role} dans les paramètres du serveur.`;
  if (role.permissions.has(PermissionFlagsBits.Administrator)) return 'Par sécurité, impossible de proposer un rôle administrateur.';
  return null;
}

const command = {
  data: new SlashCommandBuilder()
    .setName('roles')
    .setDescription('Menus de rôles en libre-service')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('creer')
        .setDescription('Créer un nouveau menu de rôles')
        .addStringOption((o) =>
          o
            .setName('type')
            .setDescription('Boutons ou menu déroulant')
            .setRequired(true)
            .addChoices({ name: 'Boutons', value: 'buttons' }, { name: 'Menu déroulant', value: 'menu' }),
        )
        .addChannelOption((o) => o.setName('salon').setDescription('Salon (défaut : ici)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption((o) => o.setName('modele').setDescription('Modèle d\'embed à afficher').setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('ajouter')
        .setDescription('Ajouter un rôle à un menu')
        .addStringOption((o) => o.setName('lien').setDescription('Lien du message du menu').setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle').setRequired(true))
        .addStringOption((o) => o.setName('texte').setDescription('Texte du bouton/option (défaut : nom du rôle)').setMaxLength(80))
        .addStringOption((o) => o.setName('emoji').setDescription('Emoji'))
        .addStringOption((o) => o.setName('description').setDescription('Description (menu déroulant)').setMaxLength(100)),
    )
    .addSubcommand((s) =>
      s
        .setName('retirer')
        .setDescription('Retirer un rôle d\'un menu')
        .addStringOption((o) => o.setName('lien').setDescription('Lien du message du menu').setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle').setRequired(true)),
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    await interaction.respond(
      Object.keys(db.guild(interaction.guildId).embeds)
        .filter((n) => n.includes(focused))
        .slice(0, 25)
        .map((n) => ({ name: n, value: n })),
    );
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const data = db.guild(interaction.guildId);

    if (sub === 'creer') {
      const channel = interaction.options.getChannel('salon') || interaction.channel;
      const name = interaction.options.getString('modele');
      const template = name ? data.embeds[name] : DEFAULT_TEMPLATE;
      if (!template) return fail(interaction, `Le modèle \`${name}\` n'existe pas.`);
      const msg = await channel.send(renderTemplate(template, memberVars(null, interaction.guild)));
      data.roleMenus[msg.id] = { channelId: channel.id, type: interaction.options.getString('type'), roles: [] };
      db.save(interaction.guildId);
      return ok(interaction, `Menu créé : ${msg.url}\nAjoutez des rôles avec \`/roles ajouter lien:${msg.url}\`.`);
    }

    const message = await fetchMessageFromLink(interaction.guild, interaction.options.getString('lien'));
    const menu = message && data.roleMenus[message.id];
    if (!menu) return fail(interaction, 'Ce message n\'est pas un menu de rôles créé avec `/roles creer`.');
    const role = interaction.options.getRole('role');

    if (sub === 'ajouter') {
      if (interaction.options.getString('emoji') && !isValidEmoji(interaction.options.getString('emoji'))) return fail(interaction, EMOJI_ERROR);
      const error = canManage(interaction, role);
      if (error) return fail(interaction, error);
      if (menu.roles.length >= 25) return fail(interaction, 'Maximum 25 rôles par menu.');
      menu.roles = menu.roles.filter((r) => r.id !== role.id);
      menu.roles.push({
        id: role.id,
        label: interaction.options.getString('texte') || role.name,
        emoji: interaction.options.getString('emoji')?.trim() || null,
        description: interaction.options.getString('description') || null,
      });
    } else {
      menu.roles = menu.roles.filter((r) => r.id !== role.id);
    }
    db.save(interaction.guildId);
    await message.edit({ components: buildComponents(menu) });
    return ok(interaction, sub === 'ajouter' ? `${role} ajouté au menu.` : `${role} retiré du menu.`);
  },
};

const components = {
  async rm(interaction, [action, roleId]) {
    const menu = db.guild(interaction.guildId).roleMenus[interaction.message.id];
    if (!menu) return fail(interaction, 'Ce menu n\'existe plus.');
    const member = interaction.member;

    if (action === 'btn') {
      if (!menu.roles.some((r) => r.id === roleId)) return fail(interaction, 'Ce rôle n\'est plus proposé.');
      const has = member.roles.cache.has(roleId);
      try {
        if (has) await member.roles.remove(roleId, 'Menu de rôles');
        else await member.roles.add(roleId, 'Menu de rôles');
      } catch {
        return fail(interaction, 'Je n\'ai pas pu modifier vos rôles (permissions / hiérarchie).');
      }
      return interaction.reply({ embeds: [info(has ? `➖ Rôle <@&${roleId}> retiré.` : `➕ Rôle <@&${roleId}> ajouté.`)], flags: MessageFlags.Ephemeral });
    }

    if (action === 'sel') {
      // Chaque rôle sélectionné est basculé : ajouté s'il manque, retiré sinon.
      const ids = new Set(menu.roles.map((r) => r.id));
      const picked = interaction.values.filter((id) => ids.has(id));
      const add = picked.filter((id) => !member.roles.cache.has(id));
      const remove = picked.filter((id) => member.roles.cache.has(id));
      try {
        if (add.length) await member.roles.add(add, 'Menu de rôles');
        if (remove.length) await member.roles.remove(remove, 'Menu de rôles');
      } catch {
        return fail(interaction, 'Je n\'ai pas pu modifier vos rôles (permissions / hiérarchie).');
      }
      await interaction.update({ components: buildComponents(menu) });
      const lines = [...add.map((id) => `➕ <@&${id}>`), ...remove.map((id) => `➖ <@&${id}>`)];
      return interaction.followUp({ embeds: [info(lines.join('\n') || 'Aucun changement.')], flags: MessageFlags.Ephemeral });
    }
  },
};

module.exports = { commands: [command], components };
