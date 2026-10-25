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
const ui = require('../lib/ui');
const { canUse } = require('../lib/access');
const { registerTarget, openBuilder } = require('./embeds');
const { renderMessage } = require('../lib/media');
const { memberVars, isValidEmoji, fail, info, truncate } = require('../lib/utils');

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

// ---------- Panneau /roles ----------

function canConfigure(member) {
  return canUse(member, 'roles', PermissionFlagsBits.ManageRoles);
}

function roleProblem(guild, role) {
  if (!role || role.managed || role.id === guild.id) return 'ne peut pas être attribué';
  if (role.position >= guild.members.me.roles.highest.position) return 'est au-dessus de mon rôle';
  if (role.permissions.has(PermissionFlagsBits.Administrator)) return 'est un rôle administrateur';
  return null;
}

function menuLink(guildId, msgId, menu) {
  return `https://discord.com/channels/${guildId}/${menu.channelId}/${msgId}`;
}

function homeView(guild) {
  const menus = Object.entries(db.guild(guild.id).roleMenus);
  const embed = info(
    [
      'Les **menus de rôles** permettent aux membres de choisir eux-mêmes leurs rôles (notifications, jeux, couleurs…).',
      '',
      '➕ Pour créer un menu, choisissez le salon dans le menu **Créer un menu dans…**',
      '✏️ Pour en modifier un, sélectionnez-le dans la liste.',
      '',
      `**Menus (${menus.length}) :**`,
      menus.map(([id, m], i) => `\`${i + 1}.\` <#${m.channelId}> — ${m.roles.length} rôle(s) — [voir](${menuLink(guild.id, id, m)})`).join('\n') || '*aucun*',
    ].join('\n'),
  ).setTitle('🎭 Menus de rôles');
  const rows = [];
  if (menus.length) {
    rows.push(
      ui.row(
        new StringSelectMenuBuilder()
          .setCustomId('rmc:pick')
          .setPlaceholder('✏️ Modifier un menu')
          .addOptions(
            menus.slice(0, 25).map(([id, m], i) => ({
              label: `Menu ${i + 1} — #${guild.channels.cache.get(m.channelId)?.name || 'salon supprimé'}`,
              value: id,
              description: truncate(m.roles.map((r) => r.label).join(', ') || 'aucun rôle', 100),
              emoji: '🎭',
            })),
          ),
      ),
    );
  }
  rows.push(ui.channelSelect('rmc:create', '➕ Créer un menu dans…', [ChannelType.GuildText, ChannelType.GuildAnnouncement], null));
  return { embeds: [embed], components: rows };
}

function menuView(guild, msgId) {
  const menu = db.guild(guild.id).roleMenus[msgId];
  const embed = info(
    [
      `**Message :** [voir le menu](${menuLink(guild.id, msgId, menu)}) dans <#${menu.channelId}>`,
      `**Type :** ${menu.type === 'menu' ? '📜 menu déroulant' : '🔘 boutons'}`,
      '',
      `**Rôles (${menu.roles.length}/25) :**`,
      menu.roles.map((r) => `${r.emoji || '•'} **${r.label}** → <@&${r.id}>${r.description ? ` — ${r.description}` : ''}`).join('\n') || '*Aucun — ajoutez-en avec le menu ci-dessous.*',
      '',
      '• **🏷️ Textes & emojis** : changer le texte des boutons/options',
      '• **🎨 Apparence** : modifier l\'embed (titre, description, image…)',
    ].join('\n'),
  ).setTitle('✏️ Menu de rôles');
  return {
    embeds: [embed],
    components: [
      ui.roleSelect(`rmc:roles:${msgId}`, '🎭 Rôles proposés dans ce menu', menu.roles.map((r) => r.id), { max: 25 }),
      ui.row(
        ui.button(`rmc:type:${msgId}`, menu.type === 'menu' ? 'Passer en boutons' : 'Passer en menu déroulant', '🔁'),
        ui.button(`rmc:labels:${msgId}`, 'Textes & emojis', '🏷️', ButtonStyle.Primary).setDisabled(!menu.roles.length),
        ui.button(`rmc:look:${msgId}`, 'Apparence', '🎨', ButtonStyle.Primary),
        ui.button(`rmc:delete:${msgId}`, 'Supprimer', '🗑️', ButtonStyle.Danger),
      ),
      ui.row(ui.backButton('rmc:home', 'Tous les menus')),
    ],
  };
}

async function fetchMenuMessage(guild, msgId) {
  const menu = db.guild(guild.id).roleMenus[msgId];
  const channel = await guild.channels.fetch(menu.channelId).catch(() => null);
  return channel?.messages.fetch(msgId).catch(() => null);
}

registerTarget('rolemenu', {
  load: (guild, msgId) => db.guild(guild.id).roleMenus[msgId]?.message || DEFAULT_TEMPLATE,
  save: async (guild, msgId, data) => {
    const menu = db.guild(guild.id).roleMenus[msgId];
    if (!menu) return;
    menu.message = data;
    db.save(guild.id);
    const message = await fetchMenuMessage(guild, msgId);
    const payload = await renderMessage(data, memberVars(null, guild));
    await message?.edit({ content: payload.content || null, embeds: payload.embeds, files: payload.files, attachments: [] }).catch(() => null);
  },
  title: () => 'apparence du menu de rôles',
  back: (guild, msgId) => (db.guild(guild.id).roleMenus[msgId] ? menuView(guild, msgId) : homeView(guild)),
});

const command = {
  data: new SlashCommandBuilder()
    .setName('roles')
    .setDescription('Créer et gérer les menus de rôles en libre-service')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setDMPermission(false),

  async execute(interaction) {
    return interaction.reply({ ...homeView(interaction.guild), flags: MessageFlags.Ephemeral });
  },
};

const configComponents = {
  async rmc(interaction, [action, msgId]) {
    if (!canConfigure(interaction.member)) return fail(interaction, 'Accès refusé.');
    const { guild } = interaction;
    const data = db.guild(guild.id);

    if (action === 'home') return interaction.update(homeView(guild));

    if (action === 'create') {
      const channel = guild.channels.cache.get(interaction.values[0]);
      if (!channel) return interaction.update(homeView(guild));
      if (!channel.permissionsFor(guild.members.me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
        return fail(interaction, `Je n'ai pas la permission d'écrire dans ${channel}.`);
      }
      const msg = await channel.send(await renderMessage(DEFAULT_TEMPLATE, memberVars(null, guild)));
      data.roleMenus[msg.id] = { channelId: channel.id, type: 'buttons', roles: [], message: structuredClone(DEFAULT_TEMPLATE) };
      db.save(guild.id);
      return interaction.update(menuView(guild, msg.id));
    }

    const id = action === 'pick' ? interaction.values[0] : msgId;
    const menu = data.roleMenus[id];
    if (!menu) return interaction.update(homeView(guild));
    const message = await fetchMenuMessage(guild, id);
    if (!message) {
      delete data.roleMenus[id];
      db.save(guild.id);
      await interaction.update(homeView(guild));
      return fail(interaction, 'Le message de ce menu a été supprimé : le menu a été retiré de la liste.');
    }

    if (action === 'pick') return interaction.update(menuView(guild, id));
    if (action === 'look') return openBuilder(interaction, 'rolemenu', id);

    if (action === 'labels') {
      return interaction.showModal(
        ui.modal(`rmc:mlabels:${id}`, 'Textes & emojis des rôles', [
          {
            id: 'lines',
            label: 'Une ligne par rôle : texte | emoji | description',
            style: 'long',
            max: 4000,
            value: menu.roles.map((r) => [r.label, r.emoji || '', r.description || ''].join(' | ')).join('\n'),
          },
        ]),
      );
    }

    if (action === 'delete') {
      await message.delete().catch(() => null);
      delete data.roleMenus[id];
      db.save(guild.id);
      return interaction.update(homeView(guild));
    }

    const refused = [];
    if (action === 'roles') {
      const previous = new Map(menu.roles.map((r) => [r.id, r]));
      menu.roles = [];
      for (const roleId of interaction.values) {
        const role = guild.roles.cache.get(roleId);
        const problem = roleProblem(guild, role);
        if (problem) {
          refused.push(`<@&${roleId}> ${problem}`);
          continue;
        }
        menu.roles.push(previous.get(roleId) || { id: roleId, label: truncate(role.name, 80), emoji: null, description: null });
      }
    }
    if (action === 'type') menu.type = menu.type === 'menu' ? 'buttons' : 'menu';
    if (action === 'mlabels') {
      const lines = interaction.fields.getTextInputValue('lines').split('\n');
      for (const [i, r] of menu.roles.entries()) {
        const [label, emoji, description] = (lines[i] || '').split('|').map((p) => p.trim());
        if (label) r.label = truncate(label, 80);
        if (emoji && !isValidEmoji(emoji)) refused.push(`Emoji invalide ignoré : \`${emoji}\``);
        r.emoji = emoji && isValidEmoji(emoji) ? emoji : null;
        r.description = description ? truncate(description, 100) : null;
      }
    }
    db.save(guild.id);
    await message.edit({ components: buildComponents(menu) });
    await interaction.update(menuView(guild, id));
    if (refused.length) return fail(interaction, `Certains éléments ont été ignorés :\n${refused.join('\n')}`);
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

module.exports = {
  commands: [command],
  components: { ...components, ...configComponents },
  dashboard: { key: 'roles', label: 'Menus de rôles', emoji: '🎭', canAccess: canConfigure, view: (interaction) => homeView(interaction.guild) },
};
