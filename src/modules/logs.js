// Logs automatiques et détaillés : messages, membres, invitations, modération, vocal, serveur.
// "Par :" est retrouvé dans le journal d'audit (permission « Voir les logs du serveur » nécessaire).
const { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType, MessageFlags, AuditLogEvent, StringSelectMenuBuilder, ButtonStyle } = require('discord.js');
const ui = require('../lib/ui');
const { canUse } = require('../lib/access');
const db = require('../lib/db');
const { sendLog, LOG_TYPES } = require('../lib/logger');
const { baseEmbed, fail, info, ts, truncate, formatDuration } = require('../lib/utils');

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

// ---------- Outils ----------

const COLORS = { red: 0xef4444, green: 0x22c55e, yellow: 0xeab308, blue: 0x3b82f6, purple: 0x8b5cf6, orange: 0xf97316, grey: 0x6b7280 };

// Retrouve qui a fait l'action dans le journal d'audit (si l'entrée est récente).
async function audit(guild, type, targetId, maxAge = 8000) {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;
  const logs = await guild.fetchAuditLogs({ type, limit: 5 }).catch(() => null);
  const entry = logs?.entries.find((e) => (!targetId || e.target?.id === targetId || e.extra?.channel?.id === targetId) && Date.now() - e.createdTimestamp < maxAge);
  return entry ? { executor: entry.executor, reason: entry.reason, entry } : null;
}

function userEmbed(user, color) {
  const embed = baseEmbed(color).setTimestamp();
  if (user) embed.setAuthor({ name: `${user.tag ?? user.username} (${user.id})`, iconURL: user.displayAvatarURL?.() });
  return embed;
}

function byLine(who, reason) {
  if (!who) return '';
  return `\n**Par :** ${who} (\`${who.id}\`)${reason ? `\n**Raison :** ${truncate(reason, 500)}` : ''}`;
}

function quote(text, max = 1000) {
  if (!text) return '*aucun texte*';
  return `\`\`\`\n${truncate(text.replace(/```/g, 'ˋˋˋ'), max)}\n\`\`\``;
}

function age(timestamp) {
  const days = Math.floor((Date.now() - timestamp) / 86400000);
  if (days < 1) return 'moins d\'un jour';
  if (days < 30) return `${days} jour(s)`;
  if (days < 365) return `${Math.floor(days / 30)} mois`;
  return `${Math.floor(days / 365)} an(s) et ${Math.floor((days % 365) / 30)} mois`;
}

function channelInfo(channel) {
  return channel ? `${channel} (\`#${channel.name}\` • \`${channel.id}\`)` : '*inconnu*';
}

const CHANNEL_TYPES = {
  [ChannelType.GuildText]: 'Textuel',
  [ChannelType.GuildVoice]: 'Vocal',
  [ChannelType.GuildCategory]: 'Catégorie',
  [ChannelType.GuildAnnouncement]: 'Annonces',
  [ChannelType.GuildStageVoice]: 'Conférence',
  [ChannelType.GuildForum]: 'Forum',
  [ChannelType.PublicThread]: 'Fil public',
  [ChannelType.PrivateThread]: 'Fil privé',
};

// Suivi des invitations (pour savoir qui a invité un nouveau membre).
const inviteCache = new Map(); // guildId -> Map(code -> { uses, inviterId })

async function cacheInvites(guild) {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) return null;
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return null;
  const map = new Map(invites.map((i) => [i.code, { uses: i.uses, inviterId: i.inviter?.id, maxUses: i.maxUses }]));
  const previous = inviteCache.get(guild.id);
  inviteCache.set(guild.id, map);
  return previous ?? false; // false = pas encore de cache pour comparer
}

// Temps passé en vocal.
const voiceSince = new Map(); // guildId:userId -> timestamp

// ---------- Événements ----------

const events = {
  // ----- Messages -----
  async messageDelete(message) {
    if (!message.guild) return;
    if (message.author?.bot) return;
    const deleter = message.author ? await audit(message.guild, AuditLogEvent.MessageDelete, message.author.id) : null;
    const embed = userEmbed(message.author, COLORS.red)
      .setTitle('🗑️ Message supprimé')
      .setDescription(message.partial ? '*Contenu inconnu : le message a été envoyé avant le démarrage du bot.*' : quote(message.content, 3500))
      .addFields(
        { name: 'Auteur', value: message.author ? `${message.author}` : '*inconnu*', inline: true },
        { name: 'Salon', value: channelInfo(message.channel), inline: true },
        { name: 'Envoyé', value: ts(message.createdTimestamp, 'R'), inline: true },
      )
      .setFooter({ text: `ID message : ${message.id}` });
    if (deleter && deleter.executor.id !== message.author?.id) embed.addFields({ name: 'Supprimé par', value: `${deleter.executor} (\`${deleter.executor.id}\`)`, inline: true });
    else if (!message.partial) embed.addFields({ name: 'Supprimé par', value: 'L\'auteur (ou inconnu)', inline: true });
    if (message.reference?.messageId) embed.addFields({ name: 'En réponse à', value: `[message](https://discord.com/channels/${message.guildId}/${message.reference.channelId}/${message.reference.messageId})`, inline: true });
    if (message.attachments?.size) {
      embed.addFields({ name: `📎 Pièces jointes (${message.attachments.size})`, value: truncate(message.attachments.map((a) => `[${a.name}](${a.url})`).join('\n'), 1024) });
      const image = message.attachments.find((a) => a.contentType?.startsWith('image/'));
      if (image) embed.setImage(image.proxyURL);
    }
    if (message.stickers?.size) embed.addFields({ name: 'Stickers', value: message.stickers.map((s) => s.name).join(', '), inline: true });
    if (message.embeds?.length) embed.addFields({ name: 'Embeds', value: `${message.embeds.length} embed(s)`, inline: true });
    await sendLog(message.guild, 'messages', embed);
  },

  async messageDeleteBulk(messages, channel) {
    if (!channel.guild) return;
    const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const lines = sorted.map((m) => `[${m.createdAt?.toLocaleString('fr-FR') ?? '?'}] ${m.author?.tag ?? 'inconnu'} : ${m.content || (m.attachments?.size ? '[pièce jointe]' : '[vide / inconnu]')}`);
    const who = await audit(channel.guild, AuditLogEvent.MessageBulkDelete, channel.id);
    const authors = new Set(sorted.map((m) => m.author?.id).filter(Boolean));
    await sendLog(channel.guild, 'messages', {
      embeds: [
        baseEmbed(COLORS.red)
          .setTitle('🧹 Suppression de messages en masse')
          .setDescription(`**${messages.size}** message(s) supprimé(s) dans ${channelInfo(channel)}${byLine(who?.executor)}`)
          .addFields({ name: 'Auteurs concernés', value: truncate([...authors].map((id) => `<@${id}>`).join(' ') || '*inconnus*', 1024) })
          .setFooter({ text: 'Le détail est dans le fichier joint.' })
          .setTimestamp(),
      ],
      files: [{ attachment: Buffer.from(lines.join('\n') || 'Aucun contenu en cache.'), name: `messages-supprimes-${channel.name}.txt` }],
    });
  },

  async messageUpdate(oldMessage, newMessage) {
    if (!newMessage.guild || newMessage.author?.bot) return;
    if (!oldMessage.partial && oldMessage.content === newMessage.content) return;
    const embed = userEmbed(newMessage.author, COLORS.yellow)
      .setTitle('✏️ Message modifié')
      .setDescription(`[➜ Aller au message](${newMessage.url})`)
      .addFields(
        { name: 'Avant', value: oldMessage.partial ? '*inconnu (message envoyé avant le démarrage du bot)*' : quote(oldMessage.content) },
        { name: 'Après', value: quote(newMessage.content) },
        { name: 'Auteur', value: `${newMessage.author}`, inline: true },
        { name: 'Salon', value: channelInfo(newMessage.channel), inline: true },
        { name: 'Envoyé', value: ts(newMessage.createdTimestamp, 'R'), inline: true },
      )
      .setFooter({ text: `ID message : ${newMessage.id}` });
    await sendLog(newMessage.guild, 'messages', embed);
  },

  // ----- Membres -----
  async guildMemberAdd(member) {
    const accountAge = Date.now() - member.user.createdTimestamp;
    const previous = await cacheInvites(member.guild);
    let inviteText = previous === null ? '*inconnue (permission « Gérer le serveur » nécessaire)*' : '*inconnue*';
    if (previous) {
      const now = inviteCache.get(member.guild.id);
      const used = [...now.entries()].find(([code, i]) => i.uses > (previous.get(code)?.uses ?? 0));
      const vanished = [...previous.entries()].find(([code, i]) => !now.has(code) && i.maxUses && i.uses + 1 >= i.maxUses);
      const hit = used || vanished;
      if (hit) {
        const [code, i] = hit;
        inviteText = `\`${code}\`${i.inviterId ? ` créée par <@${i.inviterId}>` : ''} (${(used ? i.uses : i.uses + 1) || 1} utilisation(s))`;
      } else if (member.guild.vanityURLCode) inviteText = `lien personnalisé \`${member.guild.vanityURLCode}\``;
      else inviteText = '*inconnue*';
    }
    const embed = userEmbed(member.user, COLORS.green)
      .setTitle('📥 Nouveau membre')
      .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
      .setDescription(`${member} a rejoint le serveur.${accountAge < 7 * 86400000 ? '\n⚠️ **Compte récent** (créé il y a moins de 7 jours)' : ''}${member.user.bot ? '\n🤖 **C\'est un bot.**' : ''}`)
      .addFields(
        { name: 'Compte créé', value: `${ts(member.user.createdTimestamp, 'f')}\n(il y a ${age(member.user.createdTimestamp)})`, inline: true },
        { name: 'Membre n°', value: String(member.guild.memberCount), inline: true },
        { name: 'Invitation', value: inviteText, inline: false },
      )
      .setFooter({ text: `ID : ${member.id}` });
    await sendLog(member.guild, 'members', embed);
  },

  async guildMemberRemove(member) {
    const kick = await audit(member.guild, AuditLogEvent.MemberKick, member.id);
    const ban = kick ? null : await audit(member.guild, AuditLogEvent.MemberBanAdd, member.id);
    const roles = member.roles?.cache
      .filter((r) => r.id !== member.guild.id)
      .sort((a, b) => b.position - a.position)
      .map((r) => `${r}`)
      .join(' ');
    let how = 'est parti(e) de lui-même';
    if (kick) how = `a été **expulsé(e)**${byLine(kick.executor, kick.reason)}`;
    else if (ban) how = `a été **banni(e)**${byLine(ban.executor, ban.reason)}`;
    const embed = userEmbed(member.user, COLORS.red)
      .setTitle('📤 Départ d\'un membre')
      .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
      .setDescription(`${member} (\`${member.user.tag}\`) ${how}`)
      .addFields(
        { name: 'Arrivé', value: member.joinedTimestamp ? `${ts(member.joinedTimestamp, 'f')}\n(resté ${age(member.joinedTimestamp)})` : '*inconnu*', inline: true },
        { name: 'Compte créé', value: ts(member.user.createdTimestamp, 'R'), inline: true },
        { name: 'Membres restants', value: String(member.guild.memberCount), inline: true },
        { name: `Rôles (${member.roles?.cache.size ? member.roles.cache.size - 1 : 0})`, value: truncate(roles, 1024) || '*aucun*' },
      )
      .setFooter({ text: `ID : ${member.id}` });
    await sendLog(member.guild, 'members', embed);
    if (kick) {
      await sendLog(
        member.guild,
        'moderation',
        userEmbed(member.user, COLORS.orange).setTitle('👢 Expulsion').setDescription(`${member.user} (\`${member.id}\`) a été expulsé(e).${byLine(kick.executor, kick.reason)}`),
      );
    }
  },

  async guildMemberUpdate(oldMember, newMember) {
    if (oldMember.partial) return;
    const guild = newMember.guild;
    const changes = [];

    if (oldMember.nickname !== newMember.nickname) {
      const who = await audit(guild, AuditLogEvent.MemberUpdate, newMember.id);
      changes.push({ name: '📝 Pseudo', value: `\`${oldMember.nickname || oldMember.user.username}\` → \`${newMember.nickname || newMember.user.username}\`${who && who.executor.id !== newMember.id ? `\nPar ${who.executor}` : ''}` });
    }

    const added = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id));
    const removed = oldMember.roles.cache.filter((r) => !newMember.roles.cache.has(r.id));
    if (added.size || removed.size) {
      const who = await audit(guild, AuditLogEvent.MemberRoleUpdate, newMember.id);
      const lines = [];
      if (added.size) lines.push(`➕ ${added.map((r) => `${r}`).join(' ')}`);
      if (removed.size) lines.push(`➖ ${removed.map((r) => `${r}`).join(' ')}`);
      if (who) lines.push(`Par ${who.executor.id === newMember.client.user.id ? 'le bot (menu de rôles / rôle auto)' : `${who.executor}`}`);
      changes.push({ name: '🎭 Rôles', value: truncate(lines.join('\n'), 1024) });
    }

    if (oldMember.avatar !== newMember.avatar) changes.push({ name: '🖼️ Avatar de serveur', value: newMember.avatar ? 'modifié' : 'retiré' });
    if (!oldMember.premiumSince && newMember.premiumSince) changes.push({ name: '💎 Boost', value: `${newMember} vient de booster le serveur !` });
    if (oldMember.premiumSince && !newMember.premiumSince) changes.push({ name: '💎 Boost', value: 'a retiré son boost' });

    const wasMuted = oldMember.isCommunicationDisabled();
    const isMuted = newMember.isCommunicationDisabled();
    if (wasMuted !== isMuted || (isMuted && oldMember.communicationDisabledUntilTimestamp !== newMember.communicationDisabledUntilTimestamp)) {
      const who = await audit(guild, AuditLogEvent.MemberUpdate, newMember.id);
      const text = isMuted ? `🔇 Rendu muet jusqu'à ${ts(newMember.communicationDisabledUntilTimestamp, 'f')} (${ts(newMember.communicationDisabledUntilTimestamp, 'R')})` : '🔊 N\'est plus muet';
      changes.push({ name: '⏳ Exclusion temporaire', value: `${text}${byLine(who?.executor, who?.reason)}` });
      if (who && who.executor.id !== newMember.client.user.id) {
        await sendLog(guild, 'moderation', userEmbed(newMember.user, COLORS.yellow).setTitle(isMuted ? '🔇 Mute (via Discord)' : '🔊 Fin du mute (via Discord)').setDescription(`${newMember}\n${text}${byLine(who.executor, who.reason)}`));
      }
    }

    if (!changes.length) return;
    await sendLog(
      guild,
      'members',
      userEmbed(newMember.user, COLORS.blue).setTitle('👤 Membre modifié').setDescription(`${newMember}`).addFields(changes).setFooter({ text: `ID : ${newMember.id}` }),
    );
  },

  async userUpdate(oldUser, newUser) {
    if (oldUser.partial) return;
    const changes = [];
    if (oldUser.username !== newUser.username) changes.push({ name: 'Nom d\'utilisateur', value: `\`${oldUser.username}\` → \`${newUser.username}\`` });
    if (oldUser.globalName !== newUser.globalName) changes.push({ name: 'Nom affiché', value: `\`${oldUser.globalName || '—'}\` → \`${newUser.globalName || '—'}\`` });
    if (oldUser.avatar !== newUser.avatar) changes.push({ name: 'Avatar', value: 'modifié (nouvel avatar en miniature)' });
    if (!changes.length) return;
    for (const guild of newUser.client.guilds.cache.values()) {
      if (!guild.members.cache.has(newUser.id)) continue;
      await sendLog(
        guild,
        'members',
        userEmbed(newUser, COLORS.blue).setTitle('🪪 Profil modifié').setDescription(`${newUser}`).setThumbnail(newUser.displayAvatarURL({ size: 256 })).addFields(changes),
      );
    }
  },

  // ----- Modération -----
  async guildBanAdd(ban) {
    const who = await audit(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    if (who?.executor.id === ban.client.user.id) return; // déjà loggé par /ban
    await sendLog(
      ban.guild,
      'moderation',
      userEmbed(ban.user, COLORS.red)
        .setTitle('🔨 Bannissement')
        .setDescription(`${ban.user} (\`${ban.user.tag}\`) a été banni(e).${byLine(who?.executor, who?.reason || ban.reason)}`)
        .setThumbnail(ban.user.displayAvatarURL({ size: 256 })),
    );
  },

  async guildBanRemove(ban) {
    const who = await audit(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
    if (who?.executor.id === ban.client.user.id) return;
    await sendLog(ban.guild, 'moderation', userEmbed(ban.user, COLORS.green).setTitle('♻️ Débannissement').setDescription(`${ban.user} (\`${ban.user.tag}\`) a été débanni(e).${byLine(who?.executor, who?.reason)}`));
  },

  // ----- Vocal -----
  async voiceStateUpdate(oldState, newState) {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;
    const guild = newState.guild;
    const key = `${guild.id}:${member.id}`;
    const embed = userEmbed(member.user, COLORS.purple).setFooter({ text: `ID : ${member.id}` });

    if (!oldState.channelId && newState.channelId) {
      voiceSince.set(key, Date.now());
      embed.setTitle('🔊 Connexion vocale').setDescription(`${member} a rejoint ${channelInfo(newState.channel)}`).addFields({ name: 'Membres dans le salon', value: String(newState.channel.members.size), inline: true });
      return sendLog(guild, 'voice', embed);
    }

    if (oldState.channelId && !newState.channelId) {
      const since = voiceSince.get(key);
      voiceSince.delete(key);
      const kicked = await audit(guild, AuditLogEvent.MemberDisconnect, null, 5000);
      embed
        .setColor(COLORS.red)
        .setTitle('🔈 Déconnexion vocale')
        .setDescription(`${member} a quitté ${channelInfo(oldState.channel)}${kicked ? `\n**Déconnecté par :** ${kicked.executor}` : ''}`);
      if (since) embed.addFields({ name: 'Temps passé', value: formatDuration(Date.now() - since), inline: true });
      return sendLog(guild, 'voice', embed);
    }

    if (oldState.channelId !== newState.channelId) {
      const moved = await audit(guild, AuditLogEvent.MemberMove, newState.channelId, 5000);
      embed
        .setColor(COLORS.blue)
        .setTitle('🔀 Changement de salon vocal')
        .setDescription(`${member}\n${channelInfo(oldState.channel)}\n➜ ${channelInfo(newState.channel)}${moved ? `\n**Déplacé par :** ${moved.executor}` : ''}`);
      return sendLog(guild, 'voice', embed);
    }

    const flags = [];
    if (oldState.serverMute !== newState.serverMute) flags.push(newState.serverMute ? '🔇 Rendu muet par le serveur' : '🎙️ Plus muet (serveur)');
    if (oldState.serverDeaf !== newState.serverDeaf) flags.push(newState.serverDeaf ? '🔕 Rendu sourd par le serveur' : '🔔 Plus sourd (serveur)');
    if (oldState.streaming !== newState.streaming) flags.push(newState.streaming ? '📺 A lancé un partage d\'écran / stream' : '📺 A arrêté son stream');
    if (oldState.selfVideo !== newState.selfVideo) flags.push(newState.selfVideo ? '📷 A allumé sa caméra' : '📷 A éteint sa caméra');
    if (!flags.length) return;
    let by = '';
    if (oldState.serverMute !== newState.serverMute || oldState.serverDeaf !== newState.serverDeaf) {
      const who = await audit(guild, AuditLogEvent.MemberUpdate, member.id);
      if (who) by = `\n**Par :** ${who.executor}`;
    }
    embed.setTitle('🎙️ État vocal').setDescription(`${member} dans ${channelInfo(newState.channel)}\n${flags.join('\n')}${by}`);
    return sendLog(guild, 'voice', embed);
  },

  // ----- Serveur -----
  async channelCreate(channel) {
    if (!channel.guild) return;
    const who = await audit(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
    if (who?.executor.id === channel.client.user.id) return; // tickets créés par le bot
    await sendLog(
      channel.guild,
      'server',
      baseEmbed(COLORS.green)
        .setTitle('📁 Salon créé')
        .setDescription(`${channelInfo(channel)}${byLine(who?.executor)}`)
        .addFields({ name: 'Type', value: CHANNEL_TYPES[channel.type] || 'Autre', inline: true }, { name: 'Catégorie', value: channel.parent?.name || '*aucune*', inline: true })
        .setTimestamp(),
    );
  },

  async channelDelete(channel) {
    if (!channel.guild) return;
    const who = await audit(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
    if (who?.executor.id === channel.client.user.id) return;
    await sendLog(
      channel.guild,
      'server',
      baseEmbed(COLORS.red)
        .setTitle('🗑️ Salon supprimé')
        .setDescription(`\`#${channel.name}\` (\`${channel.id}\`)${byLine(who?.executor)}`)
        .addFields({ name: 'Type', value: CHANNEL_TYPES[channel.type] || 'Autre', inline: true }, { name: 'Catégorie', value: channel.parent?.name || '*aucune*', inline: true })
        .setTimestamp(),
    );
  },

  async channelUpdate(oldChannel, newChannel) {
    if (!newChannel.guild) return;
    const changes = [];
    if (oldChannel.name !== newChannel.name) changes.push({ name: 'Nom', value: `\`${oldChannel.name}\` → \`${newChannel.name}\`` });
    if (oldChannel.topic !== newChannel.topic) changes.push({ name: 'Sujet', value: `${truncate(oldChannel.topic, 400) || '*vide*'}\n➜ ${truncate(newChannel.topic, 400) || '*vide*'}` });
    if (oldChannel.parentId !== newChannel.parentId) changes.push({ name: 'Catégorie', value: `${oldChannel.parent?.name || '*aucune*'} → ${newChannel.parent?.name || '*aucune*'}` });
    if (oldChannel.nsfw !== newChannel.nsfw) changes.push({ name: 'NSFW', value: newChannel.nsfw ? 'activé' : 'désactivé' });
    if (oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) changes.push({ name: 'Mode lent', value: `${oldChannel.rateLimitPerUser || 0}s → ${newChannel.rateLimitPerUser || 0}s` });
    if (oldChannel.bitrate !== newChannel.bitrate && newChannel.bitrate) changes.push({ name: 'Débit', value: `${oldChannel.bitrate / 1000} → ${newChannel.bitrate / 1000} kbps` });
    if (oldChannel.userLimit !== newChannel.userLimit) changes.push({ name: 'Limite de membres', value: `${oldChannel.userLimit || '∞'} → ${newChannel.userLimit || '∞'}` });
    const oldPerms = oldChannel.permissionOverwrites?.cache;
    const newPerms = newChannel.permissionOverwrites?.cache;
    if (oldPerms && newPerms) {
      const permLines = [];
      for (const [id, ow] of newPerms) {
        const before = oldPerms.get(id);
        if (!before) permLines.push(`➕ ${ow.type === 0 ? `<@&${id}>` : `<@${id}>`} ajouté`);
        else if (before.allow.bitfield !== ow.allow.bitfield || before.deny.bitfield !== ow.deny.bitfield) {
          const allowed = new PermissionsBitField(ow.allow).remove(before.allow).toArray();
          const denied = new PermissionsBitField(ow.deny).remove(before.deny).toArray();
          permLines.push(`✏️ ${ow.type === 0 ? `<@&${id}>` : `<@${id}>`}${allowed.length ? ` ✅ ${allowed.join(', ')}` : ''}${denied.length ? ` ❌ ${denied.join(', ')}` : ''}`);
        }
      }
      for (const [id, ow] of oldPerms) if (!newPerms.has(id)) permLines.push(`➖ ${ow.type === 0 ? `<@&${id}>` : `<@${id}>`} retiré`);
      if (permLines.length) changes.push({ name: '🔐 Permissions', value: truncate(permLines.join('\n'), 1024) });
    }
    if (!changes.length) return;
    // Les salons de tickets changent souvent de permissions : on ne logge pas les actions du bot.
    const who = await audit(newChannel.guild, AuditLogEvent.ChannelUpdate, newChannel.id).then(
      (r) => r || audit(newChannel.guild, AuditLogEvent.ChannelOverwriteUpdate, newChannel.id),
    );
    if (who?.executor.id === newChannel.client.user.id) return;
    await sendLog(
      newChannel.guild,
      'server',
      baseEmbed(COLORS.yellow).setTitle('🛠️ Salon modifié').setDescription(`${channelInfo(newChannel)}${byLine(who?.executor)}`).addFields(changes).setTimestamp(),
    );
  },

  async roleCreate(role) {
    const who = await audit(role.guild, AuditLogEvent.RoleCreate, role.id);
    await sendLog(role.guild, 'server', baseEmbed(COLORS.green).setTitle('🏷️ Rôle créé').setDescription(`${role} (\`${role.name}\` • \`${role.id}\`)${byLine(who?.executor)}`).setTimestamp());
  },

  async roleDelete(role) {
    const who = await audit(role.guild, AuditLogEvent.RoleDelete, role.id);
    await sendLog(
      role.guild,
      'server',
      baseEmbed(COLORS.red)
        .setTitle('🗑️ Rôle supprimé')
        .setDescription(`\`${role.name}\` (\`${role.id}\`)${byLine(who?.executor)}`)
        .addFields({ name: 'Couleur', value: role.hexColor, inline: true }, { name: 'Membres', value: String(role.members.size), inline: true })
        .setTimestamp(),
    );
  },

  async roleUpdate(oldRole, newRole) {
    const changes = [];
    if (oldRole.name !== newRole.name) changes.push({ name: 'Nom', value: `\`${oldRole.name}\` → \`${newRole.name}\`` });
    if (oldRole.color !== newRole.color) changes.push({ name: 'Couleur', value: `${oldRole.hexColor} → ${newRole.hexColor}`, inline: true });
    if (oldRole.hoist !== newRole.hoist) changes.push({ name: 'Affiché séparément', value: newRole.hoist ? 'oui' : 'non', inline: true });
    if (oldRole.mentionable !== newRole.mentionable) changes.push({ name: 'Mentionnable', value: newRole.mentionable ? 'oui' : 'non', inline: true });
    if (oldRole.icon !== newRole.icon || oldRole.unicodeEmoji !== newRole.unicodeEmoji) changes.push({ name: 'Icône', value: 'modifiée', inline: true });
    if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) {
      const added = new PermissionsBitField(newRole.permissions).remove(oldRole.permissions).toArray();
      const removed = new PermissionsBitField(oldRole.permissions).remove(newRole.permissions).toArray();
      changes.push({ name: '🔐 Permissions', value: truncate(`${added.length ? `✅ ${added.join(', ')}` : ''}${added.length && removed.length ? '\n' : ''}${removed.length ? `❌ ${removed.join(', ')}` : ''}`, 1024) });
    }
    if (!changes.length) return;
    const who = await audit(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id);
    await sendLog(newRole.guild, 'server', baseEmbed(COLORS.yellow).setTitle('🛠️ Rôle modifié').setDescription(`${newRole}${byLine(who?.executor)}`).addFields(changes).setTimestamp());
  },

  async emojiCreate(emoji) {
    const who = await audit(emoji.guild, AuditLogEvent.EmojiCreate, emoji.id);
    await sendLog(emoji.guild, 'server', baseEmbed(COLORS.green).setTitle('😀 Emoji ajouté').setDescription(`${emoji} \`:${emoji.name}:\`${byLine(who?.executor)}`).setThumbnail(emoji.imageURL()).setTimestamp());
  },

  async emojiDelete(emoji) {
    const who = await audit(emoji.guild, AuditLogEvent.EmojiDelete, emoji.id);
    await sendLog(emoji.guild, 'server', baseEmbed(COLORS.red).setTitle('😶 Emoji supprimé').setDescription(`\`:${emoji.name}:\`${byLine(who?.executor)}`).setThumbnail(emoji.imageURL()).setTimestamp());
  },

  async inviteCreate(invite) {
    if (!invite.guild) return;
    await cacheInvites(invite.guild);
    await sendLog(
      invite.guild,
      'server',
      baseEmbed(COLORS.green)
        .setTitle('🔗 Invitation créée')
        .setDescription(`\`${invite.code}\` pour ${channelInfo(invite.channel)}${invite.inviter ? `\n**Par :** ${invite.inviter}` : ''}`)
        .addFields(
          { name: 'Expire', value: invite.expiresTimestamp ? ts(invite.expiresTimestamp, 'R') : 'jamais', inline: true },
          { name: 'Utilisations max', value: invite.maxUses ? String(invite.maxUses) : '∞', inline: true },
        )
        .setTimestamp(),
    );
  },

  async inviteDelete(invite) {
    if (!invite.guild) return;
    inviteCache.get(invite.guild.id)?.delete(invite.code);
    await sendLog(invite.guild, 'server', baseEmbed(COLORS.red).setTitle('🔗 Invitation supprimée').setDescription(`\`${invite.code}\` (${channelInfo(invite.channel)})`).setTimestamp());
  },

  async guildUpdate(oldGuild, newGuild) {
    const changes = [];
    if (oldGuild.name !== newGuild.name) changes.push({ name: 'Nom', value: `\`${oldGuild.name}\` → \`${newGuild.name}\`` });
    if (oldGuild.icon !== newGuild.icon) changes.push({ name: 'Icône', value: 'modifiée' });
    if (oldGuild.banner !== newGuild.banner) changes.push({ name: 'Bannière', value: 'modifiée' });
    if (oldGuild.vanityURLCode !== newGuild.vanityURLCode) changes.push({ name: 'Lien personnalisé', value: `${oldGuild.vanityURLCode || '—'} → ${newGuild.vanityURLCode || '—'}` });
    if (oldGuild.verificationLevel !== newGuild.verificationLevel) changes.push({ name: 'Niveau de vérification', value: `${oldGuild.verificationLevel} → ${newGuild.verificationLevel}` });
    if (!changes.length) return;
    const who = await audit(newGuild, AuditLogEvent.GuildUpdate, null);
    await sendLog(
      newGuild,
      'server',
      baseEmbed(COLORS.yellow).setTitle('🏠 Serveur modifié').setDescription(byLine(who?.executor).trim() || null).addFields(changes).setThumbnail(newGuild.iconURL()).setTimestamp(),
    );
  },
};

async function init(client) {
  for (const guild of client.guilds.cache.values()) await cacheInvites(guild);
}

module.exports = {
  commands: [command],
  components,
  events,
  init,
  dashboard: { key: 'logs', label: 'Logs', emoji: '📜', canAccess: canManage, view: (interaction) => view(interaction.guild) },
};
