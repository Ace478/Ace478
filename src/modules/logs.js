// Logs automatiques du serveur : messages, membres, vocal, salons/rôles.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags, AuditLogEvent, StringSelectMenuBuilder, ButtonStyle } = require('discord.js');
const ui = require('../lib/ui');
const { canUse } = require('../lib/access');
const db = require('../lib/db');
const { sendLog, LOG_TYPES } = require('../lib/logger');
const { baseEmbed, fail, info, ts, truncate } = require('../lib/utils');

function canManage(member) {
  return canUse(member, 'logs', PermissionFlagsBits.ManageGuild);
}

const ICONS = { moderation: '🛡️', messages: '💬', members: '👥', voice: '🔊', tickets: '🎫', server: '🏗️' };

function view(guild, selected = 'moderation') {
  const logs = db.guild(guild.id).logs;
  const embed = info(
    [
      'Chaque type de log peut aller dans un salon différent.',
      '1️⃣ Choisissez un **type** dans le premier menu, 2️⃣ choisissez son **salon** dans le second.',
      'Ou mettez **tout** dans un seul salon avec le troisième menu.',
      '',
      ...Object.entries(LOG_TYPES).map(([key, label]) => `${ICONS[key]} **${label}**
${logs[key] ? `<#${logs[key]}>` : '*désactivé*'}`),
    ].join('\n'),
  ).setTitle('📜 Logs');
  return {
    embeds: [embed],
    components: [
      ui.row(
        new StringSelectMenuBuilder()
          .setCustomId('lg:type')
          .setPlaceholder('1️⃣ Type de logs à configurer')
          .addOptions(
            Object.entries(LOG_TYPES).map(([value, label]) => ({
              label: truncate(label, 100),
              value,
              emoji: ICONS[value],
              default: value === selected,
              description: logs[value] ? 'Activé' : 'Désactivé',
            })),
          ),
      ),
      ui.channelSelect(`lg:set:${selected}`, `2️⃣ Salon pour : ${truncate(LOG_TYPES[selected], 80)} (vide = désactiver)`, [ChannelType.GuildText], logs[selected]),
      ui.channelSelect('lg:all', '📦 Mettre TOUS les logs dans ce salon…', [ChannelType.GuildText], null),
      ui.row(ui.button('lg:off', 'Tout désactiver', '🔕', ButtonStyle.Danger)),
    ],
  };
}

const command = {
  data: new SlashCommandBuilder()
    .setName('logs')
    .setDescription('Configurer les salons de logs')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),

  async execute(interaction) {
    return interaction.reply({ ...view(interaction.guild), flags: MessageFlags.Ephemeral });
  },
};

const components = {
  async lg(interaction, [action, key]) {
    if (!canManage(interaction.member)) return fail(interaction, 'Accès refusé.');
    const logs = db.guild(interaction.guildId).logs;
    if (action === 'type') return interaction.update(view(interaction.guild, interaction.values[0]));
    if (action === 'set') logs[key] = interaction.values[0] || null;
    if (action === 'all') for (const type of Object.keys(LOG_TYPES)) logs[type] = interaction.values[0] || null;
    if (action === 'off') for (const type of Object.keys(LOG_TYPES)) logs[type] = null;
    db.save(interaction.guildId);
    return interaction.update(view(interaction.guild, action === 'set' ? key : 'moderation'));
  },
};

async function executor(guild, type, targetId) {
  const logs = await guild.fetchAuditLogs({ type, limit: 1 }).catch(() => null);
  const entry = logs?.entries.first();
  if (!entry || (targetId && entry.target?.id !== targetId) || Date.now() - entry.createdTimestamp > 10000) return null;
  return entry.executor;
}

const events = {
  async messageDelete(message) {
    if (!message.guild || message.author?.bot || message.partial) return;
    const embed = baseEmbed(0xef4444)
      .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
      .setDescription(`🗑️ **Message supprimé dans ${message.channel}**\n${truncate(message.content, 3800) || '*sans texte*'}`)
      .setFooter({ text: `Auteur : ${message.author.id}` })
      .setTimestamp();
    if (message.attachments.size) embed.addFields({ name: 'Pièces jointes', value: truncate(message.attachments.map((a) => a.name).join(', '), 1024) });
    await sendLog(message.guild, 'messages', embed);
  },

  async messageUpdate(oldMessage, newMessage) {
    if (!newMessage.guild || newMessage.author?.bot || oldMessage.partial || oldMessage.content === newMessage.content) return;
    const embed = baseEmbed(0xeab308)
      .setAuthor({ name: newMessage.author.tag, iconURL: newMessage.author.displayAvatarURL() })
      .setDescription(`✏️ **Message modifié dans ${newMessage.channel}** — [voir](${newMessage.url})`)
      .addFields({ name: 'Avant', value: truncate(oldMessage.content, 1024) || '*vide*' }, { name: 'Après', value: truncate(newMessage.content, 1024) || '*vide*' })
      .setFooter({ text: `Auteur : ${newMessage.author.id}` })
      .setTimestamp();
    await sendLog(newMessage.guild, 'messages', embed);
  },

  async guildMemberAdd(member) {
    await sendLog(
      member.guild,
      'members',
      baseEmbed(0x22c55e)
        .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() })
        .setDescription(`📥 ${member} a rejoint le serveur.\nCompte créé ${ts(member.user.createdTimestamp, 'R')}`)
        .setFooter({ text: `ID : ${member.id} • ${member.guild.memberCount} membres` })
        .setTimestamp(),
    );
  },

  async guildMemberRemove(member) {
    const roles = member.roles?.cache.filter((r) => r.id !== member.guild.id).map((r) => `${r}`).join(' ');
    const kicker = await executor(member.guild, AuditLogEvent.MemberKick, member.id);
    await sendLog(
      member.guild,
      'members',
      baseEmbed(0xef4444)
        .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() })
        .setDescription(`📤 ${member} a quitté le serveur${kicker ? ` (expulsé par ${kicker})` : ''}.${member.joinedTimestamp ? `\nArrivé ${ts(member.joinedTimestamp, 'R')}` : ''}${roles ? `\n**Rôles :** ${truncate(roles, 1000)}` : ''}`)
        .setFooter({ text: `ID : ${member.id}` })
        .setTimestamp(),
    );
  },

  async guildMemberUpdate(oldMember, newMember) {
    if (oldMember.partial) return;
    const lines = [];
    if (oldMember.nickname !== newMember.nickname) lines.push(`📝 Pseudo : \`${oldMember.nickname || 'aucun'}\` → \`${newMember.nickname || 'aucun'}\``);
    const added = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id));
    const removed = oldMember.roles.cache.filter((r) => !newMember.roles.cache.has(r.id));
    if (added.size) lines.push(`➕ Rôles ajoutés : ${added.map((r) => `${r}`).join(' ')}`);
    if (removed.size) lines.push(`➖ Rôles retirés : ${removed.map((r) => `${r}`).join(' ')}`);
    if (!oldMember.isCommunicationDisabled() && newMember.isCommunicationDisabled()) lines.push(`🔇 Muet jusqu'à ${ts(newMember.communicationDisabledUntil, 'f')}`);
    if (!lines.length) return;
    await sendLog(
      newMember.guild,
      'members',
      baseEmbed()
        .setAuthor({ name: newMember.user.tag, iconURL: newMember.user.displayAvatarURL() })
        .setDescription(`${newMember}\n${lines.join('\n')}`)
        .setTimestamp(),
    );
  },

  async guildBanAdd(ban) {
    const by = await executor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    if (by?.id === ban.client.user.id) return; // déjà loggé par /ban
    await sendLog(ban.guild, 'moderation', baseEmbed(0xef4444).setDescription(`🔨 **${ban.user.tag}** a été banni${by ? ` par ${by}` : ''}.${ban.reason ? `\n**Raison :** ${ban.reason}` : ''}`).setTimestamp());
  },

  async voiceStateUpdate(oldState, newState) {
    const member = newState.member;
    if (!member || member.user.bot) return;
    let text;
    if (!oldState.channelId && newState.channelId) text = `🔊 ${member} a rejoint ${newState.channel}`;
    else if (oldState.channelId && !newState.channelId) text = `🔈 ${member} a quitté ${oldState.channel}`;
    else if (oldState.channelId !== newState.channelId) text = `🔀 ${member} : ${oldState.channel} → ${newState.channel}`;
    if (!text) return;
    await sendLog(newState.guild, 'voice', baseEmbed(0x8b5cf6).setDescription(text).setTimestamp());
  },

  async channelCreate(channel) {
    if (!channel.guild) return;
    await sendLog(channel.guild, 'server', baseEmbed(0x22c55e).setDescription(`📁 Salon créé : ${channel} (\`${channel.name}\`)`).setTimestamp());
  },

  async channelDelete(channel) {
    if (!channel.guild) return;
    await sendLog(channel.guild, 'server', baseEmbed(0xef4444).setDescription(`🗑️ Salon supprimé : \`${channel.name}\``).setTimestamp());
  },

  async roleCreate(role) {
    await sendLog(role.guild, 'server', baseEmbed(0x22c55e).setDescription(`🏷️ Rôle créé : ${role}`).setTimestamp());
  },

  async roleDelete(role) {
    await sendLog(role.guild, 'server', baseEmbed(0xef4444).setDescription(`🗑️ Rôle supprimé : \`${role.name}\``).setTimestamp());
  },
};

module.exports = {
  commands: [command],
  components,
  events,
  dashboard: { key: 'logs', label: 'Logs', emoji: '📜', canAccess: canManage, view: (interaction) => view(interaction.guild) },
};
