// Commandes de modération avec MP au membre sanctionné et log automatique.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const db = require('../lib/db');
const { sendLog } = require('../lib/logger');
const { baseEmbed, ok, fail, info, parseDuration, formatDuration, ts, truncate } = require('../lib/utils');

const COLORS = { ban: 0xef4444, unban: 0x22c55e, kick: 0xf97316, mute: 0xeab308, unmute: 0x22c55e, warn: 0xeab308, clear: 0x3b82f6, lock: 0x6b7280 };
const LABELS = { ban: '🔨 Bannissement', unban: '♻️ Débannissement', kick: '👢 Expulsion', mute: '🔇 Mise en sourdine', unmute: '🔊 Fin de sourdine', warn: '⚠️ Avertissement' };

function nextCase(guildId) {
  const data = db.guild(guildId);
  data.modCases += 1;
  db.save(guildId);
  return data.modCases;
}

async function logAction(interaction, type, target, reason, extra = []) {
  const id = nextCase(interaction.guildId);
  const embed = baseEmbed(COLORS[type])
    .setAuthor({ name: `${LABELS[type]} • Cas #${id}`, iconURL: target.displayAvatarURL?.() })
    .addFields(
      { name: 'Membre', value: `${target} (\`${target.id}\`)`, inline: true },
      { name: 'Modérateur', value: `${interaction.user}`, inline: true },
      ...extra,
      { name: 'Raison', value: reason || '*Aucune raison*' },
    )
    .setTimestamp();
  await sendLog(interaction.guild, 'moderation', embed);
  return id;
}

async function notify(user, guild, type, reason, extra = '') {
  await user
    .send({
      embeds: [
        baseEmbed(COLORS[type])
          .setTitle(`${LABELS[type]} — ${guild.name}`)
          .setDescription(`**Raison :** ${reason || 'Aucune raison'}${extra}`),
      ],
    })
    .catch(() => null);
}

// Vérifie que le modérateur ET le bot peuvent agir sur ce membre.
function checkHierarchy(interaction, member) {
  if (!member) return null;
  if (member.id === interaction.user.id) return 'Vous ne pouvez pas vous sanctionner vous-même.';
  if (member.id === interaction.guild.ownerId) return 'Impossible de sanctionner le propriétaire du serveur.';
  if (interaction.member.roles.highest.position <= member.roles.highest.position && interaction.user.id !== interaction.guild.ownerId) {
    return 'Ce membre a un rôle supérieur ou égal au vôtre.';
  }
  if (interaction.guild.members.me.roles.highest.position <= member.roles.highest.position) {
    return 'Ce membre a un rôle supérieur ou égal au mien.';
  }
  return null;
}

const reasonOpt = (o) => o.setName('raison').setDescription('Raison').setMaxLength(500);

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Bannir un membre')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .setDMPermission(false)
      .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
      .addStringOption(reasonOpt)
      .addIntegerOption((o) =>
        o
          .setName('supprimer_messages')
          .setDescription('Supprimer ses messages récents')
          .addChoices({ name: 'Non', value: 0 }, { name: '1 heure', value: 3600 }, { name: '24 heures', value: 86400 }, { name: '7 jours', value: 604800 }),
      ),
    async execute(interaction) {
      const user = interaction.options.getUser('membre');
      const member = interaction.options.getMember('membre');
      const reason = interaction.options.getString('raison');
      const error = checkHierarchy(interaction, member);
      if (error) return fail(interaction, error);
      await notify(user, interaction.guild, 'ban', reason);
      await interaction.guild.members.ban(user, { reason: `${interaction.user.tag}: ${reason || 'Aucune raison'}`, deleteMessageSeconds: interaction.options.getInteger('supprimer_messages') || 0 });
      const id = await logAction(interaction, 'ban', user, reason);
      return interaction.reply({ embeds: [baseEmbed(COLORS.ban).setDescription(`🔨 **${user.tag}** a été banni. (cas #${id})`)] });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('unban')
      .setDescription('Débannir un utilisateur')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .setDMPermission(false)
      .addStringOption((o) => o.setName('id').setDescription('ID de l\'utilisateur').setRequired(true))
      .addStringOption(reasonOpt),
    async execute(interaction) {
      const id = interaction.options.getString('id').replace(/\D/g, '');
      const reason = interaction.options.getString('raison');
      const user = await interaction.guild.members.unban(id, reason || undefined).catch(() => null);
      if (!user) return fail(interaction, 'Cet utilisateur n\'est pas banni (ou ID invalide).');
      await logAction(interaction, 'unban', user, reason);
      return ok(interaction, `**${user.tag}** a été débanni.`);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('kick')
      .setDescription('Expulser un membre')
      .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
      .setDMPermission(false)
      .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
      .addStringOption(reasonOpt),
    async execute(interaction) {
      const member = interaction.options.getMember('membre');
      const reason = interaction.options.getString('raison');
      if (!member) return fail(interaction, 'Membre introuvable sur le serveur.');
      const error = checkHierarchy(interaction, member);
      if (error) return fail(interaction, error);
      await notify(member.user, interaction.guild, 'kick', reason);
      await member.kick(`${interaction.user.tag}: ${reason || 'Aucune raison'}`);
      const id = await logAction(interaction, 'kick', member.user, reason);
      return interaction.reply({ embeds: [baseEmbed(COLORS.kick).setDescription(`👢 **${member.user.tag}** a été expulsé. (cas #${id})`)] });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('mute')
      .setDescription('Rendre muet un membre (timeout)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .setDMPermission(false)
      .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
      .addStringOption((o) => o.setName('duree').setDescription('Durée : 10m, 2h, 1j, 1sem (max 28j)').setRequired(true))
      .addStringOption(reasonOpt),
    async execute(interaction) {
      const member = interaction.options.getMember('membre');
      const reason = interaction.options.getString('raison');
      const duration = parseDuration(interaction.options.getString('duree'));
      if (!member) return fail(interaction, 'Membre introuvable sur le serveur.');
      if (!duration || duration > 28 * 86400000) return fail(interaction, 'Durée invalide (ex : `10m`, `2h`, `1j`, max 28 jours).');
      const error = checkHierarchy(interaction, member);
      if (error) return fail(interaction, error);
      await member.timeout(duration, `${interaction.user.tag}: ${reason || 'Aucune raison'}`);
      await notify(member.user, interaction.guild, 'mute', reason, `\n**Durée :** ${formatDuration(duration)}`);
      const id = await logAction(interaction, 'mute', member.user, reason, [{ name: 'Durée', value: formatDuration(duration), inline: true }]);
      return interaction.reply({ embeds: [baseEmbed(COLORS.mute).setDescription(`🔇 ${member} est muet pour **${formatDuration(duration)}**. (cas #${id})`)] });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('unmute')
      .setDescription('Retirer le mute d\'un membre')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .setDMPermission(false)
      .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
      .addStringOption(reasonOpt),
    async execute(interaction) {
      const member = interaction.options.getMember('membre');
      if (!member) return fail(interaction, 'Membre introuvable sur le serveur.');
      if (!member.isCommunicationDisabled()) return fail(interaction, 'Ce membre n\'est pas muet.');
      await member.timeout(null, interaction.options.getString('raison') || undefined);
      await logAction(interaction, 'unmute', member.user, interaction.options.getString('raison'));
      return ok(interaction, `${member} peut de nouveau parler.`);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('warn')
      .setDescription('Avertir un membre')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .setDMPermission(false)
      .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
      .addStringOption((o) => o.setName('raison').setDescription('Raison').setRequired(true).setMaxLength(500)),
    async execute(interaction) {
      const user = interaction.options.getUser('membre');
      const member = interaction.options.getMember('membre');
      const reason = interaction.options.getString('raison');
      if (user.bot) return fail(interaction, 'Impossible d\'avertir un bot.');
      const error = checkHierarchy(interaction, member);
      if (error) return fail(interaction, error);
      const data = db.guild(interaction.guildId);
      const id = await logAction(interaction, 'warn', user, reason);
      (data.warns[user.id] ||= []).push({ id, modId: interaction.user.id, reason, date: Date.now() });
      db.save(interaction.guildId);
      const total = data.warns[user.id].length;
      await notify(user, interaction.guild, 'warn', reason, `\nVous avez maintenant **${total}** avertissement(s).`);
      return interaction.reply({ embeds: [baseEmbed(COLORS.warn).setDescription(`⚠️ ${user} a reçu un avertissement (**${total}** au total). (cas #${id})\n**Raison :** ${reason}`)] });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('avertissements')
      .setDescription('Gérer les avertissements')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .setDMPermission(false)
      .addSubcommand((s) =>
        s
          .setName('voir')
          .setDescription('Voir les avertissements d\'un membre')
          .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('retirer')
          .setDescription('Retirer un avertissement')
          .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
          .addIntegerOption((o) => o.setName('cas').setDescription('Numéro du cas').setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('effacer')
          .setDescription('Effacer tous les avertissements d\'un membre')
          .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)),
      ),
    async execute(interaction) {
      const sub = interaction.options.getSubcommand();
      const user = interaction.options.getUser('membre');
      const data = db.guild(interaction.guildId);
      const warns = data.warns[user.id] || [];
      if (sub === 'voir') {
        const lines = warns.map((w) => `**Cas #${w.id}** — ${ts(w.date, 'd')} par <@${w.modId}>\n> ${truncate(w.reason, 200)}`);
        return interaction.reply({
          embeds: [info(lines.join('\n') || 'Aucun avertissement.').setTitle(`⚠️ Avertissements de ${user.username} (${warns.length})`)],
          flags: MessageFlags.Ephemeral,
        });
      }
      if (sub === 'retirer') {
        const cas = interaction.options.getInteger('cas');
        const filtered = warns.filter((w) => w.id !== cas);
        if (filtered.length === warns.length) return fail(interaction, 'Avertissement introuvable.');
        data.warns[user.id] = filtered;
        db.save(interaction.guildId);
        return ok(interaction, `Avertissement #${cas} retiré.`);
      }
      delete data.warns[user.id];
      db.save(interaction.guildId);
      return ok(interaction, `Tous les avertissements de ${user} ont été effacés.`);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('clear')
      .setDescription('Supprimer des messages')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .setDMPermission(false)
      .addIntegerOption((o) => o.setName('nombre').setDescription('Nombre (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
      .addUserOption((o) => o.setName('membre').setDescription('Uniquement les messages de ce membre')),
    async execute(interaction) {
      const amount = interaction.options.getInteger('nombre');
      const user = interaction.options.getUser('membre');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      let messages = await interaction.channel.messages.fetch({ limit: 100 });
      if (user) messages = messages.filter((m) => m.author.id === user.id);
      const toDelete = [...messages.values()].slice(0, amount);
      const deleted = await interaction.channel.bulkDelete(toDelete, true);
      await sendLog(
        interaction.guild,
        'moderation',
        baseEmbed(COLORS.clear).setDescription(`🧹 ${interaction.user} a supprimé **${deleted.size}** message(s) dans ${interaction.channel}${user ? ` (de ${user})` : ''}.`),
      );
      return interaction.editReply({ embeds: [info(`🧹 ${deleted.size} message(s) supprimé(s). (Les messages de plus de 14 jours ne peuvent pas être supprimés en masse.)`)] });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('verrouiller')
      .setDescription('Verrouiller / déverrouiller un salon (empêche @everyone d\'écrire)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .setDMPermission(false)
      .addChannelOption((o) => o.setName('salon').setDescription('Salon (défaut : ici)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addStringOption(reasonOpt),
    async execute(interaction) {
      const channel = interaction.options.getChannel('salon') || interaction.channel;
      const everyone = interaction.guild.roles.everyone;
      const locked = channel.permissionOverwrites.cache.get(everyone.id)?.deny.has(PermissionFlagsBits.SendMessages);
      await channel.permissionOverwrites.edit(everyone, { SendMessages: locked ? null : false });
      const reason = interaction.options.getString('raison');
      const text = locked ? `🔓 Salon déverrouillé par ${interaction.user}.` : `🔒 Salon verrouillé par ${interaction.user}.${reason ? `\n**Raison :** ${reason}` : ''}`;
      await channel.send({ embeds: [baseEmbed(COLORS.lock).setDescription(text)] });
      await sendLog(interaction.guild, 'moderation', baseEmbed(COLORS.lock).setDescription(`${text} (${channel})`));
      return ok(interaction, locked ? `${channel} déverrouillé.` : `${channel} verrouillé.`);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('slowmode')
      .setDescription('Définir le mode lent d\'un salon')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .setDMPermission(false)
      .addStringOption((o) => o.setName('duree').setDescription('Ex : 5s, 1m, 1h — 0 pour désactiver').setRequired(true)),
    async execute(interaction) {
      const raw = interaction.options.getString('duree');
      const ms = raw.trim() === '0' ? 0 : parseDuration(raw.match(/^\d+$/) ? `${raw}s` : raw);
      if (ms === null || ms > 6 * 3600000) return fail(interaction, 'Durée invalide (max 6h).');
      await interaction.channel.setRateLimitPerUser(Math.round(ms / 1000));
      return ok(interaction, ms ? `Mode lent : **${formatDuration(ms)}**.` : 'Mode lent désactivé.');
    },
  },
];

module.exports = { commands };
