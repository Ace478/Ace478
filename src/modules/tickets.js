// Système de tickets complet :
// panel avec menu déroulant -> (formulaire) -> demande validée par le staff (ou ouverture directe)
// -> salon privé avec boutons (prendre en charge, pause, fermer) -> transcript HTML + historique.
const fs = require('node:fs');
const path = require('node:path');
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');
const db = require('../lib/db');
const { sendLog } = require('../lib/logger');
const { createTranscript } = require('../lib/transcript');
const { renderTemplate, memberVars, applyVars, isValidEmoji, EMOJI_ERROR, baseEmbed, ok, fail, info, isAdmin, ts, truncate } = require('../lib/utils');

const TRANSCRIPT_DIR = path.join(db.DATA_DIR, 'transcripts');

const STATUS = {
  pending: '🕓 En attente',
  open: '🟢 Ouvert',
  paused: '⏸️ En pause',
  closed: '🔒 Fermé',
  denied: '⛔ Refusé',
  deleted: '🗑️ Supprimé',
};

const USER_PERMS = ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles', 'EmbedLinks'];
const STAFF_PERMS = [...USER_PERMS, 'ManageMessages'];

// ---------- Helpers ----------

function store(guildId) {
  return db.guild(guildId).tickets;
}

function category(guildId, catId) {
  return store(guildId).categories.find((c) => c.id === catId);
}

function staffRoles(guildId, cat) {
  return [...new Set([...store(guildId).config.staffRoleIds, ...(cat?.staffRoleIds || [])])];
}

function isStaff(member, cat) {
  if (isAdmin(member)) return true;
  return staffRoles(member.guild.id, cat).some((id) => member.roles.cache.has(id));
}

function pad(n) {
  return String(n).padStart(4, '0');
}

function slug(text) {
  return (
    String(text)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 90) || 'ticket'
  );
}

function recordByChannel(guildId, channelId) {
  return Object.values(store(guildId).records).find((r) => r.channelId === channelId && ['open', 'paused', 'closed'].includes(r.status));
}

function activeCount(guildId, userId) {
  return Object.values(store(guildId).records).filter((r) => r.userId === userId && ['pending', 'accepting', 'open', 'paused'].includes(r.status)).length;
}

function summaryEmbed(guild, record, title) {
  const cat = category(guild.id, record.categoryId);
  const embed = baseEmbed()
    .setTitle(title)
    .addFields(
      { name: 'Ticket', value: `#${pad(record.id)}`, inline: true },
      { name: 'Membre', value: `<@${record.userId}>`, inline: true },
      { name: 'Raison', value: cat ? `${cat.emoji || ''} ${cat.label}`.trim() : record.categoryLabel || '—', inline: true },
      { name: 'Statut', value: STATUS[record.status] || record.status, inline: true },
      { name: 'Créé', value: ts(record.createdAt, 'R'), inline: true },
    );
  if (record.claimedBy) embed.addFields({ name: 'Pris en charge par', value: `<@${record.claimedBy}>`, inline: true });
  if (record.answer) embed.addFields({ name: cat?.question || 'Détails', value: truncate(record.answer, 1024) });
  return embed;
}

function controlRow(record) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`tk:claim:${record.id}`)
      .setLabel(record.claimedBy ? 'Pris en charge' : 'Prendre en charge')
      .setEmoji('🙋')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!!record.claimedBy),
    new ButtonBuilder()
      .setCustomId(`tk:pause:${record.id}`)
      .setLabel(record.status === 'paused' ? 'Reprendre' : 'Pause')
      .setEmoji(record.status === 'paused' ? '▶️' : '⏸️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tk:transcript:${record.id}`).setLabel('Transcript').setEmoji('📄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tk:close:${record.id}`).setLabel('Fermer').setEmoji('🔒').setStyle(ButtonStyle.Danger),
  );
}

async function dm(user, payload) {
  try {
    await user.send(payload);
    return true;
  } catch {
    return false;
  }
}

async function updateControlMessage(channel, record) {
  if (!record.controlMessageId) return;
  const msg = await channel.messages.fetch(record.controlMessageId).catch(() => null);
  if (msg) await msg.edit({ components: [controlRow(record)] }).catch(() => null);
}

// ---------- Panel ----------

function defaultPanel() {
  return {
    content: '',
    embeds: [
      {
        title: '🎫 OUVRIR UN TICKET AUPRÈS DU STAFF',
        color: 0x3b82f6,
        description: [
          '## 🧭 COMMENT ÇA MARCHE ?',
          '> **1.** Sélectionnez votre raison dans le menu ci-dessous.',
          '> **2.** Une demande sera envoyée au staff.',
          '> **3.** Vous recevrez un MP quand votre ticket sera accepté.',
          '',
          '## 📘 RÈGLES DE COURTOISIE',
          '> • Merci de rester poli et respectueux.',
          '> • Toute forme de harcèlement est interdite.',
        ].join('\n'),
      },
    ],
  };
}

function panelComponents(guildId, placeholder) {
  const cats = store(guildId).categories;
  const menu = new StringSelectMenuBuilder()
    .setCustomId('tk:open')
    .setPlaceholder(placeholder || 'Choisissez la raison de votre ticket')
    .addOptions(
      cats.slice(0, 25).map((c) => ({
        label: c.label,
        value: c.id,
        description: c.description ? truncate(c.description, 100) : undefined,
        emoji: c.emoji || undefined,
      })),
    );
  return [new ActionRowBuilder().addComponents(menu)];
}

async function refreshPanels(guild) {
  const t = store(guild.id);
  if (!t.categories.length) return;
  t.panels = t.panels || [];
  for (const panel of [...t.panels]) {
    const channel = await guild.channels.fetch(panel.channelId).catch(() => null);
    const msg = await channel?.messages.fetch(panel.messageId).catch(() => null);
    if (!msg) {
      t.panels = t.panels.filter((p) => p !== panel);
      continue;
    }
    await msg.edit({ components: panelComponents(guild.id, panel.placeholder) }).catch(() => null);
  }
  db.save(guild.id);
}

// ---------- Création ----------

async function createTicketChannel(guild, record) {
  const t = store(guild.id);
  const cat = category(guild.id, record.categoryId);
  const member = await guild.members.fetch(record.userId).catch(() => null);
  if (!member) throw new Error('Le membre a quitté le serveur.');

  const overwrites = [
    { id: guild.roles.everyone.id, deny: ['ViewChannel'] },
    { id: member.id, allow: USER_PERMS },
    { id: guild.client.user.id, allow: [...STAFF_PERMS, 'ManageChannels'] },
    ...staffRoles(guild.id, cat)
      .filter((id) => guild.roles.cache.has(id))
      .map((id) => ({ id, allow: STAFF_PERMS })),
  ];

  const name = slug(
    applyVars(t.config.nameFormat || 'ticket-{numero}', {
      numero: pad(record.id),
      user: member.user.username,
      categorie: cat?.label || 'ticket',
    }),
  );

  const parentId = cat?.parentId || t.config.parentId;
  const parent = parentId ? guild.channels.cache.get(parentId) : null;
  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parent?.type === ChannelType.GuildCategory ? parent.id : undefined,
    topic: `Ticket #${pad(record.id)} • ${member.user.tag} • ${cat?.label || ''}`,
    permissionOverwrites: overwrites,
  });

  record.channelId = channel.id;
  record.status = 'open';
  record.openedAt = Date.now();

  const vars = memberVars(member, guild, { numero: pad(record.id), categorie: cat?.label || '' });
  const welcome = cat?.welcome || 'Bonjour {user} 👋\nMerci d\'avoir ouvert un ticket. Un membre du staff va vous répondre rapidement.\nDécrivez votre demande en détail en attendant.';
  const embed = summaryEmbed(guild, record, `${cat?.emoji || '🎫'} Ticket #${pad(record.id)} — ${cat?.label || 'Support'}`).setDescription(applyVars(welcome, vars));

  const ping = [`<@${member.id}>`];
  if (t.config.pingStaff) ping.push(...staffRoles(guild.id, cat).map((id) => `<@&${id}>`));

  const control = await channel.send({ content: ping.join(' '), embeds: [embed], components: [controlRow(record)] });
  record.controlMessageId = control.id;
  await control.pin().catch(() => null);
  db.save(guild.id);
  return channel;
}

async function submitTicket(interaction, cat, answer) {
  const guild = interaction.guild;
  const t = store(guild.id);

  const record = {
    id: ++t.counter,
    userId: interaction.user.id,
    categoryId: cat.id,
    categoryLabel: cat.label,
    answer: answer || null,
    status: 'pending',
    createdAt: Date.now(),
  };
  t.records[record.id] = record;
  db.save(guild.id);

  const requestChannel = t.config.requestChannelId ? guild.channels.cache.get(t.config.requestChannelId) : null;

  if (cat.approval !== false && requestChannel) {
    const roles = staffRoles(guild.id, cat);
    const msg = await requestChannel.send({
      content: t.config.pingStaff && roles.length ? roles.map((id) => `<@&${id}>`).join(' ') : undefined,
      embeds: [summaryEmbed(guild, record, '📨 Nouvelle demande de ticket').setThumbnail(interaction.user.displayAvatarURL())],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`tk:accept:${record.id}`).setLabel('Accepter').setEmoji('✅').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`tk:deny:${record.id}`).setLabel('Refuser').setEmoji('✖️').setStyle(ButtonStyle.Danger),
        ),
      ],
    });
    record.requestChannelId = msg.channelId;
    record.requestMessageId = msg.id;
    db.save(guild.id);
    await sendLog(guild, 'tickets', summaryEmbed(guild, record, '📨 Demande de ticket envoyée'));
    return interaction.followUp({
      embeds: [info(`📨 Votre demande **#${pad(record.id)}** a été envoyée au staff.\nVous recevrez un **MP** dès qu'elle sera acceptée (pensez à autoriser vos MP).`)],
      flags: MessageFlags.Ephemeral,
    });
  }

  const channel = await createTicketChannel(guild, record);
  await sendLog(guild, 'tickets', summaryEmbed(guild, record, '🎫 Ticket ouvert').setDescription(`Salon : ${channel}`));
  return interaction.followUp({ embeds: [info(`🎫 Votre ticket a été créé : ${channel}`)], flags: MessageFlags.Ephemeral });
}

// ---------- Fermeture / réouverture ----------

async function closeTicket(guild, record, closer, reason) {
  const t = store(guild.id);
  const channel = await guild.channels.fetch(record.channelId).catch(() => null);
  record.status = 'closed';
  record.closedAt = Date.now();
  record.closedBy = closer.id;
  record.closeReason = reason || null;
  db.save(guild.id);
  if (!channel) return null;

  await channel.permissionOverwrites.edit(record.userId, { ViewChannel: false, SendMessages: false }).catch(() => null);
  for (const id of record.addedUsers || []) await channel.permissionOverwrites.delete(id).catch(() => null);

  const user = await guild.client.users.fetch(record.userId).catch(() => null);
  const cat = category(guild.id, record.categoryId);
  const { html, count, participants } = await createTranscript(channel, {
    title: `Ticket #${pad(record.id)} — ${cat?.label || record.categoryLabel || ''}`,
    meta: [
      ['Membre :', user?.tag || record.userId],
      ['Ouvert le :', new Date(record.openedAt || record.createdAt).toLocaleString('fr-FR')],
      ['Fermé par :', closer.tag || closer.username],
      ['Raison :', reason || '—'],
    ],
  });
  const dir = path.join(TRANSCRIPT_DIR, guild.id);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `ticket-${pad(record.id)}.html`;
  fs.writeFileSync(path.join(dir, fileName), html);

  const summary = summaryEmbed(guild, record, `🔒 Ticket #${pad(record.id)} fermé`).addFields(
    { name: 'Fermé par', value: `<@${closer.id}>`, inline: true },
    { name: 'Messages', value: String(count), inline: true },
    { name: 'Participants', value: [...participants].map((id) => `<@${id}>`).join(' ') || '—', inline: false },
    { name: 'Raison de fermeture', value: reason || '—' },
  );

  const logMsg = await sendLog(guild, 'tickets', { embeds: [summary], files: [new AttachmentBuilder(Buffer.from(html), { name: fileName })] });
  if (logMsg) record.transcriptUrl = logMsg.url;

  if (user && t.config.dmTranscript) {
    await dm(user, {
      embeds: [
        baseEmbed()
          .setTitle(`🔒 Votre ticket #${pad(record.id)} sur ${guild.name} a été fermé`)
          .setDescription(reason ? `**Raison :** ${reason}` : 'Merci de nous avoir contactés !')
          .setFooter({ text: 'Le transcript de la conversation est joint à ce message.' }),
      ],
      files: [new AttachmentBuilder(Buffer.from(html), { name: fileName })],
    });
  }

  await channel.send({
    embeds: [baseEmbed(0xef4444).setDescription(`🔒 Ticket fermé par <@${closer.id}>${reason ? `\n**Raison :** ${reason}` : ''}`)],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`tk:reopen:${record.id}`).setLabel('Rouvrir').setEmoji('🔓').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`tk:delete:${record.id}`).setLabel('Supprimer').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      ),
    ],
  });
  db.save(guild.id);
  return channel;
}

async function reopenTicket(guild, record, by) {
  const channel = await guild.channels.fetch(record.channelId).catch(() => null);
  if (!channel) return null;
  await channel.permissionOverwrites.edit(record.userId, Object.fromEntries(USER_PERMS.map((p) => [p, true])));
  record.status = 'open';
  record.closedAt = null;
  record.reopenedAt = Date.now();
  db.save(guild.id);
  await updateControlMessage(channel, record);
  await channel.send({ content: `<@${record.userId}>`, embeds: [baseEmbed(0x22c55e).setDescription(`🔓 Ticket rouvert par <@${by.id}>.`)] });
  await sendLog(guild, 'tickets', summaryEmbed(guild, record, '🔓 Ticket rouvert').setDescription(`Par <@${by.id}> • ${channel}`));
  return channel;
}

async function setPaused(guild, record, by, paused) {
  const channel = await guild.channels.fetch(record.channelId).catch(() => null);
  if (!channel) return;
  await channel.permissionOverwrites.edit(record.userId, { SendMessages: !paused });
  record.status = paused ? 'paused' : 'open';
  db.save(guild.id);
  await updateControlMessage(channel, record);
  await channel.send({
    embeds: [
      baseEmbed(paused ? 0xeab308 : 0x22c55e).setDescription(
        paused ? `⏸️ Ticket mis en pause par <@${by.id}>. Le membre ne peut plus écrire pour le moment.` : `▶️ Ticket repris par <@${by.id}>.`,
      ),
    ],
  });
  await sendLog(guild, 'tickets', summaryEmbed(guild, record, paused ? '⏸️ Ticket en pause' : '▶️ Ticket repris').setDescription(`Par <@${by.id}> • ${channel}`));
}

// ---------- Commandes ----------

const configCommand = {
  data: new SlashCommandBuilder()
    .setName('ticket-config')
    .setDescription('Configurer le système de tickets')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('general')
        .setDescription('Réglages généraux')
        .addChannelOption((o) =>
          o
            .setName('salon_demandes')
            .setDescription('Salon staff où arrivent les demandes à accepter/refuser')
            .addChannelTypes(ChannelType.GuildText),
        )
        .addChannelOption((o) =>
          o.setName('categorie_discord').setDescription('Catégorie où créer les salons de tickets').addChannelTypes(ChannelType.GuildCategory),
        )
        .addIntegerOption((o) => o.setName('max_tickets').setDescription('Tickets ouverts max par membre').setMinValue(1).setMaxValue(10))
        .addStringOption((o) => o.setName('format_nom').setDescription('Nom des salons. Variables : {numero} {user} {categorie}'))
        .addBooleanOption((o) => o.setName('transcript_mp').setDescription('Envoyer le transcript en MP au membre à la fermeture'))
        .addBooleanOption((o) => o.setName('mention_staff').setDescription('Mentionner les rôles staff à chaque nouveau ticket')),
    )
    .addSubcommand((s) =>
      s
        .setName('staff')
        .setDescription('Ajouter / retirer un rôle staff (accès à tous les tickets)')
        .addRoleOption((o) => o.setName('role').setDescription('Rôle').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('raison')
        .setDescription('Créer ou modifier une raison de ticket (option du menu)')
        .addStringOption((o) => o.setName('nom').setDescription('Nom affiché (ex: Recrutement)').setRequired(true).setAutocomplete(true).setMaxLength(100))
        .addStringOption((o) => o.setName('emoji').setDescription('Emoji (ex: 📩 ou <:nom:id>)'))
        .addStringOption((o) => o.setName('description').setDescription('Petit texte sous l\'option').setMaxLength(100))
        .addBooleanOption((o) => o.setName('validation').setDescription('Le staff doit accepter la demande avant création (défaut : oui)'))
        .addStringOption((o) => o.setName('question').setDescription('Question posée au membre (formulaire). Vide = aucune').setMaxLength(45))
        .addStringOption((o) => o.setName('message').setDescription('Message d\'accueil dans le ticket. Variables : {user} {numero}… \\n = retour ligne'))
        .addRoleOption((o) => o.setName('role_staff').setDescription('Rôle staff spécifique à cette raison'))
        .addChannelOption((o) =>
          o.setName('categorie_discord').setDescription('Catégorie Discord spécifique').addChannelTypes(ChannelType.GuildCategory),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('raison-supprimer')
        .setDescription('Supprimer une raison de ticket')
        .addStringOption((o) => o.setName('nom').setDescription('Raison').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('voir').setDescription('Voir la configuration actuelle')),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    await interaction.respond(
      store(interaction.guildId)
        .categories.filter((c) => c.label.toLowerCase().includes(focused))
        .slice(0, 25)
        .map((c) => ({ name: c.label, value: c.label })),
    );
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const t = store(interaction.guildId);
    const o = interaction.options;

    if (sub === 'general') {
      const c = t.config;
      if (o.getChannel('salon_demandes')) c.requestChannelId = o.getChannel('salon_demandes').id;
      if (o.getChannel('categorie_discord')) c.parentId = o.getChannel('categorie_discord').id;
      if (o.getInteger('max_tickets')) c.maxOpen = o.getInteger('max_tickets');
      if (o.getString('format_nom')) c.nameFormat = o.getString('format_nom');
      if (o.getBoolean('transcript_mp') !== null) c.dmTranscript = o.getBoolean('transcript_mp');
      if (o.getBoolean('mention_staff') !== null) c.pingStaff = o.getBoolean('mention_staff');
      db.save(interaction.guildId);
      return ok(interaction, 'Configuration des tickets mise à jour. Voir avec `/ticket-config voir`.');
    }

    if (sub === 'staff') {
      const role = o.getRole('role');
      const list = t.config.staffRoleIds;
      const idx = list.indexOf(role.id);
      if (idx >= 0) list.splice(idx, 1);
      else list.push(role.id);
      db.save(interaction.guildId);
      return ok(interaction, idx >= 0 ? `${role} n'est plus staff des tickets.` : `${role} est maintenant staff des tickets.`);
    }

    if (sub === 'raison') {
      const label = o.getString('nom').trim();
      if (o.getString('emoji') && !isValidEmoji(o.getString('emoji'))) return fail(interaction, EMOJI_ERROR);
      let cat = t.categories.find((c) => c.label.toLowerCase() === label.toLowerCase());
      const created = !cat;
      if (!cat) {
        if (t.categories.length >= 25) return fail(interaction, 'Maximum 25 raisons.');
        cat = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, label, approval: true, staffRoleIds: [] };
        t.categories.push(cat);
      }
      cat.label = label;
      if (o.getString('emoji')) cat.emoji = o.getString('emoji').trim();
      if (o.getString('description')) cat.description = o.getString('description');
      if (o.getBoolean('validation') !== null) cat.approval = o.getBoolean('validation');
      if (o.getString('question') !== null) cat.question = o.getString('question').trim() || null;
      if (o.getString('message')) cat.welcome = o.getString('message').replace(/\\n/g, '\n');
      if (o.getRole('role_staff')) cat.staffRoleIds = [o.getRole('role_staff').id];
      if (o.getChannel('categorie_discord')) cat.parentId = o.getChannel('categorie_discord').id;
      db.save(interaction.guildId);
      await ok(interaction, `Raison **${cat.emoji || ''} ${cat.label}** ${created ? 'créée' : 'modifiée'}. Les panels existants sont mis à jour.`);
      return refreshPanels(interaction.guild);
    }

    if (sub === 'raison-supprimer') {
      const label = o.getString('nom').toLowerCase();
      const before = t.categories.length;
      t.categories = t.categories.filter((c) => c.label.toLowerCase() !== label);
      if (before === t.categories.length) return fail(interaction, 'Raison introuvable.');
      db.save(interaction.guildId);
      await ok(interaction, 'Raison supprimée.');
      return refreshPanels(interaction.guild);
    }

    if (sub === 'voir') {
      const c = t.config;
      const cats = t.categories
        .map(
          (cat) =>
            `${cat.emoji || '•'} **${cat.label}** — ${cat.approval !== false ? 'validation staff' : 'ouverture directe'}${cat.question ? ` — ❓ ${cat.question}` : ''}${cat.staffRoleIds?.length ? ` — ${cat.staffRoleIds.map((id) => `<@&${id}>`).join(' ')}` : ''}`,
        )
        .join('\n');
      const embed = info(
        [
          `**Salon des demandes :** ${c.requestChannelId ? `<#${c.requestChannelId}>` : '*aucun (ouverture directe)*'}`,
          `**Catégorie :** ${c.parentId ? `<#${c.parentId}>` : '*aucune*'}`,
          `**Rôles staff :** ${c.staffRoleIds.map((id) => `<@&${id}>`).join(' ') || '*aucun (admins seulement)*'}`,
          `**Max par membre :** ${c.maxOpen}`,
          `**Format du nom :** \`${c.nameFormat}\``,
          `**Transcript en MP :** ${c.dmTranscript ? 'oui' : 'non'} • **Mention staff :** ${c.pingStaff ? 'oui' : 'non'}`,
          `**Logs / transcripts :** ${db.guild(interaction.guildId).logs.tickets ? `<#${db.guild(interaction.guildId).logs.tickets}>` : '*non configuré — `/logs salon type:Tickets`*'}`,
          '',
          `**Raisons (${t.categories.length}) :**`,
          cats || '*Aucune — ajoutez-en avec `/ticket-config raison`*',
        ].join('\n'),
      ).setTitle('🎫 Configuration des tickets');
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
  },
};

const ticketCommand = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Gérer les tickets')
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('panel')
        .setDescription('Envoyer le panel d\'ouverture de tickets (admin)')
        .addChannelOption((o) => o.setName('salon').setDescription('Salon (défaut : ici)').addChannelTypes(ChannelType.GuildText))
        .addStringOption((o) => o.setName('modele').setDescription('Modèle d\'embed (/embed) à utiliser').setAutocomplete(true))
        .addStringOption((o) => o.setName('texte_menu').setDescription('Texte du menu déroulant').setMaxLength(150)),
    )
    .addSubcommand((s) =>
      s
        .setName('fermer')
        .setDescription('Fermer ce ticket')
        .addStringOption((o) => o.setName('raison').setDescription('Raison de la fermeture')),
    )
    .addSubcommand((s) =>
      s
        .setName('ajouter')
        .setDescription('Ajouter un membre à ce ticket')
        .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('retirer')
        .setDescription('Retirer un membre de ce ticket')
        .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('renommer')
        .setDescription('Renommer ce ticket')
        .addStringOption((o) => o.setName('nom').setDescription('Nouveau nom').setRequired(true).setMaxLength(90)),
    )
    .addSubcommand((s) => s.setName('pause').setDescription('Mettre en pause / reprendre ce ticket'))
    .addSubcommand((s) => s.setName('transcript').setDescription('Générer le transcript de ce ticket sans le fermer'))
    .addSubcommand((s) =>
      s
        .setName('historique')
        .setDescription('Historique des tickets d\'un membre (staff)')
        .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('stats').setDescription('Statistiques des tickets (staff)')),

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
    const { guild, member } = interaction;
    const t = store(guild.id);

    if (sub === 'panel') {
      if (!isAdmin(member)) return fail(interaction, 'Réservé aux administrateurs (permission Gérer le serveur).');
      if (!t.categories.length) return fail(interaction, 'Ajoutez d\'abord au moins une raison avec `/ticket-config raison`.');
      const channel = interaction.options.getChannel('salon') || interaction.channel;
      const name = interaction.options.getString('modele');
      const template = name ? db.guild(guild.id).embeds[name] : defaultPanel();
      if (!template) return fail(interaction, `Le modèle \`${name}\` n'existe pas.`);
      const placeholder = interaction.options.getString('texte_menu');
      const msg = await channel.send({ ...renderTemplate(template, memberVars(null, guild)), components: panelComponents(guild.id, placeholder) });
      t.panels = t.panels || [];
      t.panels.push({ channelId: channel.id, messageId: msg.id, placeholder });
      db.save(guild.id);
      return ok(interaction, `Panel envoyé dans ${channel}. Personnalisez-le avec \`/embed modifier lien:${msg.url}\`.`);
    }

    if (sub === 'historique' || sub === 'stats') {
      if (!isStaff(member)) return fail(interaction, 'Réservé au staff.');
      if (sub === 'stats') {
        const records = Object.values(t.records);
        const count = (s) => records.filter((r) => r.status === s).length;
        const closed = records.filter((r) => r.closedAt && r.openedAt);
        const avg = closed.length ? closed.reduce((a, r) => a + (r.closedAt - r.openedAt), 0) / closed.length : 0;
        const claims = {};
        for (const r of records) if (r.claimedBy) claims[r.claimedBy] = (claims[r.claimedBy] || 0) + 1;
        const top = Object.entries(claims)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([id, n], i) => `${i + 1}. <@${id}> — ${n}`)
          .join('\n');
        return interaction.reply({
          embeds: [
            info(
              [
                `**Total :** ${records.length}`,
                `${STATUS.pending} : ${count('pending')} • ${STATUS.open} : ${count('open')} • ${STATUS.paused} : ${count('paused')}`,
                `${STATUS.closed} : ${count('closed') + count('deleted')} • ${STATUS.denied} : ${count('denied')}`,
                `**Durée moyenne :** ${avg ? `${Math.round(avg / 60000)} min` : '—'}`,
                '',
                `**Top staff (prises en charge)**\n${top || '—'}`,
              ].join('\n'),
            ).setTitle('📊 Statistiques des tickets'),
          ],
          flags: MessageFlags.Ephemeral,
        });
      }
      const user = interaction.options.getUser('membre');
      const list = Object.values(t.records)
        .filter((r) => r.userId === user.id)
        .sort((a, b) => b.createdAt - a.createdAt);
      const lines = list.slice(0, 15).map((r) => {
        const link = r.transcriptUrl ? ` • [transcript](${r.transcriptUrl})` : r.channelId && ['open', 'paused'].includes(r.status) ? ` • <#${r.channelId}>` : '';
        return `**#${pad(r.id)}** ${r.categoryLabel || ''} — ${STATUS[r.status] || r.status} — ${ts(r.createdAt, 'd')}${link}${r.closeReason ? `\n> ${truncate(r.closeReason, 80)}` : ''}`;
      });
      return interaction.reply({
        embeds: [
          info(lines.join('\n') || 'Aucun ticket.')
            .setTitle(`📚 Tickets de ${user.username} (${list.length})`)
            .setThumbnail(user.displayAvatarURL()),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    const record = recordByChannel(guild.id, interaction.channelId);
    if (!record) return fail(interaction, 'Cette commande doit être utilisée dans un salon de ticket.');
    const cat = category(guild.id, record.categoryId);
    const staff = isStaff(member, cat);

    if (sub === 'fermer') {
      if (!staff && member.id !== record.userId) return fail(interaction, 'Vous ne pouvez pas fermer ce ticket.');
      if (record.status === 'closed') return fail(interaction, 'Ce ticket est déjà fermé.');
      await interaction.deferReply();
      await closeTicket(guild, record, interaction.user, interaction.options.getString('raison'));
      return interaction.deleteReply().catch(() => null);
    }

    if (!staff) return fail(interaction, 'Réservé au staff.');

    if (sub === 'ajouter' || sub === 'retirer') {
      const user = interaction.options.getUser('membre');
      record.addedUsers = record.addedUsers || [];
      if (sub === 'ajouter') {
        await interaction.channel.permissionOverwrites.edit(user.id, Object.fromEntries(USER_PERMS.map((p) => [p, true])));
        if (!record.addedUsers.includes(user.id)) record.addedUsers.push(user.id);
      } else {
        if (user.id === record.userId) return fail(interaction, 'Impossible de retirer l\'auteur du ticket. Fermez-le plutôt.');
        await interaction.channel.permissionOverwrites.delete(user.id);
        record.addedUsers = record.addedUsers.filter((id) => id !== user.id);
      }
      db.save(guild.id);
      return interaction.reply({ embeds: [info(sub === 'ajouter' ? `➕ ${user} a été ajouté au ticket.` : `➖ ${user} a été retiré du ticket.`)] });
    }

    if (sub === 'renommer') {
      const name = slug(interaction.options.getString('nom'));
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      // Discord limite les renommages à 2 toutes les 10 minutes par salon.
      const result = await Promise.race([
        interaction.channel.setName(name).then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
      ]).catch(() => false);
      return interaction.editReply({
        embeds: [result ? info(`✏️ Salon renommé en \`${name}\`.`) : info('⏳ Discord limite à 2 renommages / 10 min : le nom sera appliqué dès que possible.')],
      });
    }

    if (sub === 'pause') {
      if (record.status === 'closed') return fail(interaction, 'Ce ticket est fermé.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await setPaused(guild, record, interaction.user, record.status !== 'paused');
      return interaction.deleteReply().catch(() => null);
    }

    if (sub === 'transcript') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { html } = await createTranscript(interaction.channel, { title: `Ticket #${pad(record.id)} (en cours)` });
      return interaction.editReply({ files: [new AttachmentBuilder(Buffer.from(html), { name: `ticket-${pad(record.id)}.html` })] });
    }
  },
};

// ---------- Boutons, menus, formulaires ----------

const components = {
  async tk(interaction, [action, arg]) {
    const { guild } = interaction;
    const t = store(guild.id);

    // Sélection d'une raison dans le panel
    if (action === 'open') {
      const cat = category(guild.id, interaction.values[0]);
      if (!cat) return interaction.update({ components: panelComponents(guild.id, interaction.component.placeholder) });
      if (activeCount(guild.id, interaction.user.id) >= (t.config.maxOpen || 1)) {
        await interaction.update({ components: interaction.message.components });
        return fail(interaction, `Vous avez déjà ${t.config.maxOpen > 1 ? `${t.config.maxOpen} tickets` : 'un ticket'} en cours. Attendez sa fermeture.`);
      }
      if (cat.question) {
        return interaction.showModal(
          new ModalBuilder()
            .setCustomId(`tk:form:${cat.id}`)
            .setTitle(truncate(`${cat.label}`, 45))
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('answer').setLabel(cat.question).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000),
              ),
            ),
        );
      }
      await interaction.update({ components: interaction.message.components });
      return submitTicket(interaction, cat, null);
    }

    if (action === 'form') {
      const cat = category(guild.id, arg);
      if (!cat) return fail(interaction, 'Cette raison n\'existe plus.');
      if (interaction.isFromMessage()) await interaction.update({ components: interaction.message.components });
      else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (activeCount(guild.id, interaction.user.id) >= (t.config.maxOpen || 1)) return fail(interaction, 'Vous avez déjà un ticket en cours.');
      return submitTicket(interaction, cat, interaction.fields.getTextInputValue('answer'));
    }

    const record = t.records[arg];
    if (!record) return fail(interaction, 'Ticket introuvable.');
    const cat = category(guild.id, record.categoryId);
    const staff = isStaff(interaction.member, cat);

    if (action === 'accept' || action === 'deny') {
      if (!staff) return fail(interaction, 'Réservé au staff.');
      if (record.status !== 'pending') return fail(interaction, 'Cette demande a déjà été traitée.');
      if (action === 'deny') {
        return interaction.showModal(
          new ModalBuilder()
            .setCustomId(`tk:denyform:${record.id}`)
            .setTitle('Refuser la demande')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('reason').setLabel('Raison (envoyée au membre)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500),
              ),
            ),
        );
      }
      await interaction.deferUpdate();
      record.status = 'accepting';
      let channel;
      try {
        channel = await createTicketChannel(guild, record);
      } catch (err) {
        record.status = 'pending';
        db.save(guild.id);
        return fail(interaction, `Impossible de créer le ticket : ${err.message}`);
      }
      record.acceptedBy = interaction.user.id;
      db.save(guild.id);
      await interaction.editReply({
        embeds: [summaryEmbed(guild, record, '✅ Demande acceptée').setColor(0x22c55e).setDescription(`Acceptée par ${interaction.user} • ${channel}`)],
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Aller au ticket').setStyle(ButtonStyle.Link).setURL(channel.url))],
      });
      const user = await interaction.client.users.fetch(record.userId).catch(() => null);
      const sent =
        user &&
        (await dm(user, {
          embeds: [baseEmbed(0x22c55e).setTitle('✅ Votre ticket a été accepté !').setDescription(`Votre demande **#${pad(record.id)}** sur **${guild.name}** a été acceptée.\nRendez-vous ici : ${channel}`)],
          components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Ouvrir le ticket').setStyle(ButtonStyle.Link).setURL(channel.url))],
        }));
      if (!sent) await channel.send({ content: `<@${record.userId}> *(je n'ai pas pu vous envoyer de MP)*` });
      await sendLog(guild, 'tickets', summaryEmbed(guild, record, '✅ Demande acceptée').setDescription(`Par ${interaction.user} • ${channel}`));
      return;
    }

    if (action === 'denyform') {
      if (record.status !== 'pending') return fail(interaction, 'Cette demande a déjà été traitée.');
      const reason = interaction.fields.getTextInputValue('reason').trim();
      record.status = 'denied';
      record.closedBy = interaction.user.id;
      record.closedAt = Date.now();
      record.closeReason = reason || null;
      db.save(guild.id);
      await interaction.update({
        embeds: [summaryEmbed(guild, record, '⛔ Demande refusée').setColor(0xef4444).setDescription(`Refusée par ${interaction.user}${reason ? `\n**Raison :** ${reason}` : ''}`)],
        components: [],
      });
      const user = await interaction.client.users.fetch(record.userId).catch(() => null);
      if (user) {
        await dm(user, {
          embeds: [
            baseEmbed(0xef4444)
              .setTitle('⛔ Votre demande de ticket a été refusée')
              .setDescription(`Demande **#${pad(record.id)}** sur **${guild.name}**.${reason ? `\n**Raison :** ${reason}` : ''}`),
          ],
        });
      }
      await sendLog(guild, 'tickets', summaryEmbed(guild, record, '⛔ Demande refusée').setDescription(`Par ${interaction.user}${reason ? `\n**Raison :** ${reason}` : ''}`));
      return;
    }

    if (action === 'claim') {
      if (!staff) return fail(interaction, 'Réservé au staff.');
      if (record.claimedBy) return fail(interaction, `Déjà pris en charge par <@${record.claimedBy}>.`);
      record.claimedBy = interaction.user.id;
      db.save(guild.id);
      await interaction.update({ components: [controlRow(record)] });
      await interaction.channel.send({ embeds: [baseEmbed(0x22c55e).setDescription(`🙋 ${interaction.user} prend en charge votre ticket.`)] });
      await sendLog(guild, 'tickets', summaryEmbed(guild, record, '🙋 Ticket pris en charge').setDescription(`${interaction.channel}`));
      return;
    }

    if (action === 'pause') {
      if (!staff) return fail(interaction, 'Réservé au staff.');
      if (record.status === 'closed') return fail(interaction, 'Ce ticket est fermé.');
      await interaction.deferUpdate();
      return setPaused(guild, record, interaction.user, record.status !== 'paused');
    }

    if (action === 'transcript') {
      if (!staff) return fail(interaction, 'Réservé au staff.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { html } = await createTranscript(interaction.channel, { title: `Ticket #${pad(record.id)} (en cours)` });
      return interaction.editReply({ files: [new AttachmentBuilder(Buffer.from(html), { name: `ticket-${pad(record.id)}.html` })] });
    }

    if (action === 'close') {
      if (!staff && interaction.user.id !== record.userId) return fail(interaction, 'Vous ne pouvez pas fermer ce ticket.');
      if (record.status === 'closed') return fail(interaction, 'Ce ticket est déjà fermé.');
      return interaction.showModal(
        new ModalBuilder()
          .setCustomId(`tk:closeform:${record.id}`)
          .setTitle('Fermer le ticket')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('reason').setLabel('Raison (optionnelle)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500),
            ),
          ),
      );
    }

    if (action === 'closeform') {
      if (record.status === 'closed') return fail(interaction, 'Ce ticket est déjà fermé.');
      await interaction.deferUpdate();
      return closeTicket(guild, record, interaction.user, interaction.fields.getTextInputValue('reason').trim());
    }

    if (action === 'reopen') {
      if (!staff) return fail(interaction, 'Réservé au staff.');
      if (record.status !== 'closed') return fail(interaction, 'Ce ticket n\'est pas fermé.');
      await interaction.update({ components: [] });
      return reopenTicket(guild, record, interaction.user);
    }

    if (action === 'delete') {
      if (!staff) return fail(interaction, 'Réservé au staff.');
      await interaction.update({ components: [] });
      await interaction.channel.send({ embeds: [baseEmbed(0xef4444).setDescription('🗑️ Suppression du salon dans 5 secondes…')] });
      record.status = 'deleted';
      record.deletedBy = interaction.user.id;
      db.save(guild.id);
      await sendLog(guild, 'tickets', summaryEmbed(guild, record, '🗑️ Ticket supprimé').setDescription(`Par ${interaction.user}`));
      setTimeout(() => interaction.channel.delete().catch(() => null), 5000);
      return;
    }
  },
};

// Si un salon de ticket est supprimé à la main, on met à jour l'historique.
const events = {
  channelDelete(channel) {
    if (!channel.guild) return;
    const record = recordByChannel(channel.guild.id, channel.id);
    if (!record) return;
    if (record.status !== 'closed') {
      record.closedAt = Date.now();
      record.closeReason = record.closeReason || 'Salon supprimé manuellement';
    }
    record.status = 'deleted';
    db.save(channel.guild.id);
  },
};

module.exports = { commands: [configCommand, ticketCommand], components, events };
