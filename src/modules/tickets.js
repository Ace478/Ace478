// Système de tickets complet, entièrement configurable depuis /ticket :
// panel avec menu déroulant -> formulaire (jusqu'à 5 questions) -> validation staff (ou ouverture directe)
// -> salon privé (prise en charge, pause, membres, renommage, transcript, fermeture)
// -> transcript HTML, historique, statistiques, fermeture automatique.
// Tous les messages (panel, accueil dans le ticket, MP) se personnalisent avec l'éditeur d'embed.
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
  SnowflakeUtil,
} = require('discord.js');
const db = require('../lib/db');
const ui = require('../lib/ui');
const { canUse } = require('../lib/access');
const { sendLog } = require('../lib/logger');
const { createTranscript } = require('../lib/transcript');
const { registerTarget, openBuilder } = require('./embeds');
const { renderTemplate, memberVars, applyVars, isValidEmoji, EMOJI_ERROR, baseEmbed, fail, info, isAdmin, ts, truncate } = require('../lib/utils');

const TRANSCRIPT_DIR = path.join(db.DATA_DIR, 'transcripts');

const STATUS = {
  pending: '🕓 En attente',
  accepting: '🕓 En cours d\'acceptation',
  open: '🟢 Ouvert',
  paused: '⏸️ En pause',
  closed: '🔒 Fermé',
  denied: '⛔ Refusé',
  deleted: '🗑️ Supprimé',
};

const USER_PERMS = ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles', 'EmbedLinks'];
const STAFF_PERMS = [...USER_PERMS, 'ManageMessages'];

// ---------- Messages personnalisables ----------

const DEFAULT_MESSAGES = {
  panel: {
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
  },
  open: {
    content: '',
    embeds: [
      {
        color: 0x3b82f6,
        title: '{emoji} Ticket #{numero} — {categorie}',
        description: 'Bonjour {user} 👋\nMerci d\'avoir ouvert un ticket. Un membre du staff va vous répondre rapidement.\nDécrivez votre demande en détail en attendant.',
        thumbnail: { url: '{user.avatar}' },
      },
    ],
  },
  dmAccept: {
    content: '',
    embeds: [
      {
        color: 0x22c55e,
        title: '✅ Votre ticket a été accepté !',
        description: 'Votre demande **#{numero}** ({categorie}) sur **{server}** a été acceptée par {staff}.\nRendez-vous ici : {salon}',
      },
    ],
  },
  dmDeny: {
    content: '',
    embeds: [
      {
        color: 0xef4444,
        title: '⛔ Votre demande de ticket a été refusée',
        description: 'Demande **#{numero}** ({categorie}) sur **{server}**.\n**Raison :** {raison}',
      },
    ],
  },
  dmClose: {
    content: '',
    embeds: [
      {
        color: 0x3b82f6,
        title: '🔒 Votre ticket #{numero} a été fermé',
        description: 'Votre ticket **{categorie}** sur **{server}** a été fermé par {staff}.\n**Raison :** {raison}\n\nMerci de nous avoir contactés !',
        footer: { text: 'Le transcript de la conversation est joint à ce message.' },
      },
    ],
  },
};

const MESSAGE_LABELS = {
  panel: { label: 'Panel (message avec le menu)', emoji: '🎫', description: 'Le message où les membres choisissent leur raison' },
  open: { label: 'Message d\'ouverture du ticket', emoji: '👋', description: 'Envoyé dans le ticket (par défaut pour toutes les raisons)' },
  dmAccept: { label: 'MP : ticket accepté', emoji: '✅', description: 'Envoyé au membre quand le staff accepte' },
  dmDeny: { label: 'MP : demande refusée', emoji: '⛔', description: 'Envoyé au membre quand le staff refuse' },
  dmClose: { label: 'MP : ticket fermé', emoji: '🔒', description: 'Envoyé au membre avec le transcript' },
};

const TICKET_VARS_HELP = [
  '`{numero}` numéro du ticket',
  '`{categorie}` raison choisie • `{emoji}` son emoji',
  '`{salon}` lien du salon du ticket',
  '`{staff}` membre du staff (accepté / fermé par)',
  '`{raison}` raison du refus / de la fermeture',
  '`{user}` etc. désignent le membre qui a ouvert le ticket',
].join('\n');

function messageOf(guildId, key) {
  const c = store(guildId).config;
  if (c.messages?.[key]) return c.messages[key];
  if (key === 'panel' && c.panelTemplate && db.guild(guildId).embeds[c.panelTemplate]) return db.guild(guildId).embeds[c.panelTemplate];
  return DEFAULT_MESSAGES[key];
}

function openMessageOf(guildId, cat) {
  if (cat?.openMessage) return cat.openMessage;
  if (cat?.welcome) {
    // ancien format : simple texte d'accueil
    const msg = structuredClone(messageOf(guildId, 'open'));
    if (msg.embeds?.[0]) msg.embeds[0].description = cat.welcome;
    return msg;
  }
  return messageOf(guildId, 'open');
}

function ticketVars(guild, record, member, extra = {}) {
  const cat = category(guild.id, record?.categoryId);
  return memberVars(member, guild, {
    numero: record ? pad(record.id) : '0001',
    categorie: cat?.label || record?.categoryLabel || 'Support',
    emoji: cat?.emoji || '🎫',
    salon: record?.channelId ? `<#${record.channelId}>` : '#ticket-0001',
    staff: '—',
    raison: 'Aucune raison précisée',
    ...extra,
  });
}

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

function canConfigure(member) {
  return canUse(member, 'ticket', PermissionFlagsBits.ManageGuild);
}

// Questions du formulaire (5 max). Compatible avec l'ancien champ "question".
function questionsOf(cat) {
  if (Array.isArray(cat?.questions)) return cat.questions.slice(0, 5);
  return cat?.question ? [cat.question] : [];
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

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function recordByChannel(guildId, channelId) {
  return Object.values(store(guildId).records).find((r) => r.channelId === channelId && ['open', 'paused', 'closed'].includes(r.status));
}

function activeCount(guildId, userId) {
  return Object.values(store(guildId).records).filter((r) => r.userId === userId && ['pending', 'accepting', 'open', 'paused'].includes(r.status)).length;
}

async function dm(user, payload) {
  try {
    await user.send(payload);
    return true;
  } catch {
    return false;
  }
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
  for (const { q, a } of record.answers || []) embed.addFields({ name: truncate(q, 256), value: truncate(a, 1024) || '—' });
  if (record.answer) embed.addFields({ name: cat?.question || 'Détails', value: truncate(record.answer, 1024) });
  return embed;
}

// Petit encart d'infos ajouté sous le message d'ouverture personnalisé.
function infoEmbed(guild, record) {
  const cat = category(guild.id, record.categoryId);
  const embed = baseEmbed(0x2b2d31).addFields(
    { name: 'Statut', value: STATUS[record.status] || record.status, inline: true },
    { name: 'Pris en charge par', value: record.claimedBy ? `<@${record.claimedBy}>` : '*personne*', inline: true },
  );
  for (const { q, a } of record.answers || []) embed.addFields({ name: truncate(q, 256), value: truncate(a, 1024) || '—' });
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
    new ButtonBuilder().setCustomId(`tk:manage:${record.id}`).setLabel('Gérer').setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tk:close:${record.id}`).setLabel('Fermer').setEmoji('🔒').setStyle(ButtonStyle.Danger),
  );
}

async function updateControlMessage(guild, record) {
  if (!record.controlMessageId || !record.channelId) return;
  const channel = guild.channels.cache.get(record.channelId);
  const msg = await channel?.messages.fetch(record.controlMessageId).catch(() => null);
  if (!msg) return;
  const embeds = msg.embeds.map((e) => e.toJSON());
  if (embeds.length) embeds[embeds.length - 1] = infoEmbed(guild, record).toJSON();
  await msg.edit({ embeds, components: [controlRow(record)] }).catch(() => null);
}

// ---------- Panel ----------

function panelComponents(guildId, placeholder) {
  const cats = store(guildId).categories;
  const menu = new StringSelectMenuBuilder()
    .setCustomId('tk:open')
    .setPlaceholder(placeholder || store(guildId).config.placeholder || 'Choisissez la raison de votre ticket')
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

async function sendPanel(guild, channel) {
  const t = store(guild.id);
  const msg = await channel.send({ ...renderTemplate(messageOf(guild.id, 'panel'), memberVars(null, guild)), components: panelComponents(guild.id) });
  t.panels = t.panels || [];
  t.panels.push({ channelId: channel.id, messageId: msg.id });
  db.save(guild.id);
  return msg;
}

// Met à jour les panels déjà envoyés (menu, et apparence si demandé).
async function refreshPanels(guild, { appearance = false } = {}) {
  const t = store(guild.id);
  if (!t.categories.length || !t.panels?.length) return;
  const look = appearance ? renderTemplate(messageOf(guild.id, 'panel'), memberVars(null, guild)) : {};
  for (const panel of [...t.panels]) {
    const channel = await guild.channels.fetch(panel.channelId).catch(() => null);
    const msg = await channel?.messages.fetch(panel.messageId).catch(() => null);
    if (!msg) {
      t.panels = t.panels.filter((p) => p !== panel);
      continue;
    }
    const payload = { components: panelComponents(guild.id, panel.placeholder) };
    if (appearance) Object.assign(payload, { content: look.content || null, embeds: look.embeds });
    await msg.edit(payload).catch(() => null);
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

  const staffId = record.acceptedBy;
  const rendered = renderTemplate(openMessageOf(guild.id, cat), ticketVars(guild, record, member, { staff: staffId ? `<@${staffId}>` : '—' }));
  const ping = [`<@${member.id}>`];
  if (t.config.pingStaff) ping.push(...staffRoles(guild.id, cat).map((id) => `<@&${id}>`));
  const content = [ping.join(' '), rendered.content].filter(Boolean).join('\n');

  const control = await channel.send({ content, embeds: [...rendered.embeds.slice(0, 9), infoEmbed(guild, record)], components: [controlRow(record)] });
  record.controlMessageId = control.id;
  await control.pin().catch(() => null);
  db.save(guild.id);
  return channel;
}

async function submitTicket(interaction, cat, answers) {
  const guild = interaction.guild;
  const t = store(guild.id);

  const record = {
    id: ++t.counter,
    userId: interaction.user.id,
    categoryId: cat.id,
    categoryLabel: cat.label,
    answers: answers || [],
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
        ui.row(
          ui.button(`tk:accept:${record.id}`, 'Accepter', '✅', ButtonStyle.Success),
          ui.button(`tk:deny:${record.id}`, 'Refuser', '✖️', ButtonStyle.Danger),
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

// ---------- Fermeture / réouverture / pause ----------

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
    const member = await guild.members.fetch(user.id).catch(() => null);
    const payload = renderTemplate(messageOf(guild.id, 'dmClose'), ticketVars(guild, record, member || user, { staff: `<@${closer.id}>`, raison: reason || 'Aucune raison précisée' }));
    await dm(user, { ...payload, files: [new AttachmentBuilder(Buffer.from(html), { name: fileName })] });
  }

  await channel.send({
    embeds: [baseEmbed(0xef4444).setDescription(`🔒 Ticket fermé par <@${closer.id}>${reason ? `\n**Raison :** ${reason}` : ''}`)],
    components: [
      ui.row(
        ui.button(`tk:reopen:${record.id}`, 'Rouvrir', '🔓', ButtonStyle.Success),
        ui.button(`tk:transcript:${record.id}`, 'Transcript', '📄'),
        ui.button(`tk:delete:${record.id}`, 'Supprimer', '🗑️', ButtonStyle.Danger),
      ),
    ],
  });
  await updateControlMessage(guild, record);
  db.save(guild.id);
  return channel;
}

async function reopenTicket(guild, record, by) {
  const channel = await guild.channels.fetch(record.channelId).catch(() => null);
  if (!channel) return null;
  await channel.permissionOverwrites.edit(record.userId, Object.fromEntries(USER_PERMS.map((p) => [p, true])));
  for (const id of record.addedUsers || []) await channel.permissionOverwrites.edit(id, Object.fromEntries(USER_PERMS.map((p) => [p, true]))).catch(() => null);
  record.status = 'open';
  record.closedAt = null;
  record.reopenedAt = Date.now();
  db.save(guild.id);
  await updateControlMessage(guild, record);
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
  await updateControlMessage(guild, record);
  await channel.send({
    embeds: [
      baseEmbed(paused ? 0xeab308 : 0x22c55e).setDescription(
        paused ? `⏸️ Ticket mis en pause par <@${by.id}>. Le membre ne peut plus écrire pour le moment.` : `▶️ Ticket repris par <@${by.id}>.`,
      ),
    ],
  });
  await sendLog(guild, 'tickets', summaryEmbed(guild, record, paused ? '⏸️ Ticket en pause' : '▶️ Ticket repris').setDescription(`Par <@${by.id}> • ${channel}`));
}

async function claimTicket(guild, record, by) {
  record.claimedBy = by.id;
  db.save(guild.id);
  await updateControlMessage(guild, record);
  const channel = guild.channels.cache.get(record.channelId);
  await channel?.send({ embeds: [baseEmbed(0x22c55e).setDescription(`🙋 ${by} prend en charge votre ticket.`)] });
  await sendLog(guild, 'tickets', summaryEmbed(guild, record, '🙋 Ticket pris en charge').setDescription(`${channel}`));
}

// ---------- Panneaux de configuration ----------

function reasonLine(cat) {
  const parts = [`${cat.emoji || '•'} **${cat.label}**`, cat.approval !== false ? '✅ validation staff' : '⚡ ouverture directe'];
  const qs = questionsOf(cat);
  if (qs.length) parts.push(`❓ ${qs.length} question(s)`);
  if (cat.openMessage) parts.push('🎨 message perso');
  if (cat.staffRoleIds?.length) parts.push(cat.staffRoleIds.map((id) => `<@&${id}>`).join(' '));
  if (cat.parentId) parts.push(`📁 <#${cat.parentId}>`);
  return parts.join(' • ');
}

function homeView(guild) {
  const t = store(guild.id);
  const c = t.config;
  const logs = db.guild(guild.id).logs.tickets;
  const step = (done) => (done ? '✅' : '⬜');
  const embed = info(
    [
      '**Tout se configure ici**, avec les menus et les boutons :',
      `${step(c.staffRoleIds.length)} **1.** Choisissez les rôles staff et les salons avec les menus ci-dessous`,
      `${step(t.categories.length)} **2.** Ajoutez vos raisons de ticket avec **📋 Raisons**`,
      `${step(c.messages && Object.keys(c.messages).length)} **3.** Personnalisez les messages avec **🎨 Messages** *(facultatif)*`,
      `${step(t.panels?.length)} **4.** Envoyez le panel avec **📤 Panel**`,
      '',
      `📨 **Salon des demandes :** ${c.requestChannelId ? `<#${c.requestChannelId}>` : '*aucun → les tickets s\'ouvrent directement*'}`,
      `📁 **Catégorie des tickets :** ${c.parentId ? `<#${c.parentId}>` : '*aucune*'}`,
      `📜 **Logs & transcripts :** ${logs ? `<#${logs}>` : '*aucun*'}`,
      `🛡️ **Rôles staff :** ${c.staffRoleIds.map((id) => `<@&${id}>`).join(' ') || '*aucun (owners/admins seulement)*'}`,
      '',
      `**Raisons (${t.categories.length}/25)**`,
      t.categories.map(reasonLine).join('\n') || '*Aucune pour le moment.*',
    ].join('\n'),
  ).setTitle('🎫 Configuration des tickets');

  return {
    embeds: [embed],
    components: [
      ui.channelSelect('tks:set:request', '📨 Salon des demandes staff (vide = ouverture directe)', [ChannelType.GuildText], c.requestChannelId),
      ui.channelSelect('tks:set:parent', '📁 Catégorie où créer les tickets', [ChannelType.GuildCategory], c.parentId),
      ui.channelSelect('tks:set:logs', '📜 Salon des logs et transcripts', [ChannelType.GuildText], logs),
      ui.roleSelect('tks:set:staff', '🛡️ Rôles staff (accès à tous les tickets)', c.staffRoleIds),
      ui.row(
        ui.button('tks:reasons', `Raisons (${t.categories.length})`, '📋', ButtonStyle.Primary),
        ui.button('tks:messages', 'Messages', '🎨', ButtonStyle.Primary),
        ui.button('tks:options', 'Options', '⚙️'),
        ui.button('tks:send', 'Panel', '📤', ButtonStyle.Success).setDisabled(!t.categories.length),
        ui.button('tks:stats', 'Stats', '📊'),
      ),
    ],
  };
}

function optionsView(guild) {
  const c = store(guild.id).config;
  const onOff = (v) => (v ? '🟢 activé' : '🔴 désactivé');
  const embed = info(
    [
      `**Tickets max par membre :** ${c.maxOpen}`,
      `**Nom des salons :** \`${c.nameFormat}\` *(variables : {numero} {user} {categorie})*`,
      `**Texte du menu déroulant :** ${c.placeholder || 'Choisissez la raison de votre ticket'}`,
      `**Fermeture auto. après inactivité :** ${c.autoCloseHours ? `${c.autoCloseHours} h` : 'désactivée'}`,
      '',
      `**Transcript en MP à la fermeture :** ${onOff(c.dmTranscript)}`,
      `**Mentionner le staff :** ${onOff(c.pingStaff)}`,
      `**Le membre peut fermer son ticket :** ${onOff(c.userCanClose !== false)}`,
    ].join('\n'),
  ).setTitle('⚙️ Options des tickets');
  return {
    embeds: [embed],
    components: [
      ui.row(
        ui.toggleButton('tks:toggle:dmTranscript', 'Transcript en MP', c.dmTranscript),
        ui.toggleButton('tks:toggle:pingStaff', 'Mention staff', c.pingStaff),
        ui.toggleButton('tks:toggle:userCanClose', 'Fermeture par le membre', c.userCanClose !== false),
      ),
      ui.row(ui.button('tks:modal:options', 'Modifier les réglages', '✏️', ButtonStyle.Primary), ui.backButton('tks:home')),
    ],
  };
}

function reasonsView(guild) {
  const t = store(guild.id);
  const embed = info(
    [
      'Chaque **raison** est une option du menu déroulant du panel.',
      'Sélectionnez-en une pour la modifier : textes, questions, message d\'ouverture, rôles, catégorie, validation…',
      '',
      t.categories.map((cat, i) => `\`${i + 1}.\` ${reasonLine(cat)}`).join('\n') || '*Aucune raison. Cliquez sur **Ajouter une raison**.*',
    ].join('\n'),
  ).setTitle(`📋 Raisons de ticket (${t.categories.length}/25)`);
  const components = [];
  if (t.categories.length) {
    components.push(
      ui.row(
        new StringSelectMenuBuilder()
          .setCustomId('tks:pick')
          .setPlaceholder('✏️ Choisir une raison à modifier')
          .addOptions(t.categories.map((cat) => ({ label: cat.label, value: cat.id, emoji: cat.emoji || undefined, description: cat.description ? truncate(cat.description, 100) : undefined }))),
      ),
    );
  }
  components.push(
    ui.row(ui.button('tks:modal:new', 'Ajouter une raison', '➕', ButtonStyle.Success).setDisabled(t.categories.length >= 25), ui.backButton('tks:home')),
  );
  return { embeds: [embed], components };
}

function reasonView(guild, cat) {
  const qs = questionsOf(cat);
  const embed = info(
    [
      `**Nom :** ${cat.emoji || ''} ${cat.label}`,
      `**Description :** ${cat.description || '*aucune*'}`,
      `**Validation par le staff :** ${cat.approval !== false ? '✅ oui (demande à accepter)' : '⚡ non (ouverture directe)'}`,
      `**Rôles staff spécifiques :** ${cat.staffRoleIds?.map((id) => `<@&${id}>`).join(' ') || '*aucun (rôles généraux)*'}`,
      `**Catégorie spécifique :** ${cat.parentId ? `<#${cat.parentId}>` : '*catégorie générale*'}`,
      `**Message d'ouverture :** ${cat.openMessage ? '🎨 personnalisé' : '*message par défaut*'}`,
      '',
      `**Questions du formulaire (${qs.length}/5) :**`,
      qs.map((q, i) => `${i + 1}. ${q}`).join('\n') || '*aucune — le ticket s\'ouvre sans formulaire*',
    ].join('\n'),
  ).setTitle(`✏️ Raison : ${cat.label}`);
  return {
    embeds: [embed],
    components: [
      ui.roleSelect(`tks:rstaff:${cat.id}`, '🛡️ Rôles staff spécifiques à cette raison', cat.staffRoleIds),
      ui.channelSelect(`tks:rparent:${cat.id}`, '📁 Catégorie spécifique (vide = générale)', [ChannelType.GuildCategory], cat.parentId),
      ui.row(
        ui.button(`tks:modal:edit:${cat.id}`, 'Nom & emoji', '📝', ButtonStyle.Primary),
        ui.button(`tks:modal:questions:${cat.id}`, 'Questions', '❓', ButtonStyle.Primary),
        ui.button(`tks:ropen:${cat.id}`, 'Message d\'ouverture', '🎨', ButtonStyle.Primary),
        ui.toggleButton(`tks:rapproval:${cat.id}`, cat.approval !== false ? 'Validation : oui' : 'Validation : non', cat.approval !== false),
      ),
      ui.row(
        ui.backButton('tks:reasons', 'Raisons'),
        ui.button(`tks:rup:${cat.id}`, 'Monter', '⬆️'),
        ui.button(`tks:rreset:${cat.id}`, 'Message par défaut', '♻️').setDisabled(!cat.openMessage && !cat.welcome),
        ui.button(`tks:rdel:${cat.id}`, 'Supprimer', '🗑️', ButtonStyle.Danger),
      ),
    ],
  };
}

function messagesView(guild) {
  const custom = store(guild.id).config.messages || {};
  const embed = info(
    [
      'Personnalisez **chaque message** du système de tickets avec l\'éditeur d\'embed (titre, texte, couleur, bannière, emojis…).',
      '',
      ...Object.entries(MESSAGE_LABELS).map(([key, m]) => `${m.emoji} **${m.label}** — ${custom[key] ? '🎨 personnalisé' : '*par défaut*'}\n-# ${m.description}`),
      '',
      '-# Le message d\'ouverture peut aussi être personnalisé pour chaque raison (📋 Raisons > 🎨).',
    ].join('\n'),
  ).setTitle('🎨 Messages des tickets');
  const options = (prefix) => Object.entries(MESSAGE_LABELS).map(([key, m]) => ({ label: m.label, value: key, emoji: m.emoji, description: prefix }));
  return {
    embeds: [embed],
    components: [
      ui.row(new StringSelectMenuBuilder().setCustomId('tks:msg').setPlaceholder('🎨 Modifier un message').addOptions(options('Ouvrir l\'éditeur'))),
      ui.row(new StringSelectMenuBuilder().setCustomId('tks:msgreset').setPlaceholder('♻️ Remettre un message par défaut').addOptions(options('Revenir au message d\'origine'))),
      ui.row(ui.backButton('tks:home')),
    ],
  };
}

function sendView(guild, status) {
  const t = store(guild.id);
  const embed = info(
    [
      '**1.** *(facultatif)* Personnalisez l\'apparence avec **🎨 Apparence du panel**.',
      '**2.** Choisissez le salon dans le menu : le panel y est envoyé immédiatement.',
      '',
      `**Panels actifs :** ${t.panels?.length || 0}`,
      '-# Ils se mettent à jour automatiquement quand vous modifiez les raisons ou l\'apparence.',
      status ? `\n${status}` : '',
    ].join('\n'),
  ).setTitle('📤 Envoyer le panel');
  return {
    embeds: [embed],
    components: [
      ui.channelSelect('tks:sendto', '📤 Envoyer le panel dans…', [ChannelType.GuildText, ChannelType.GuildAnnouncement], null),
      ui.row(ui.button('tks:look', 'Apparence du panel', '🎨', ButtonStyle.Primary), ui.backButton('tks:home')),
    ],
  };
}

function statsView(guild, historyUserId, back = true) {
  const t = store(guild.id);
  const records = Object.values(t.records);
  let embed;
  if (historyUserId) {
    const list = records.filter((r) => r.userId === historyUserId).sort((a, b) => b.createdAt - a.createdAt);
    const lines = list.slice(0, 15).map((r) => {
      const link = r.transcriptUrl ? ` • [transcript](${r.transcriptUrl})` : r.channelId && ['open', 'paused', 'closed'].includes(r.status) ? ` • <#${r.channelId}>` : '';
      return `**#${pad(r.id)}** ${r.categoryLabel || ''} — ${STATUS[r.status] || r.status} — ${ts(r.createdAt, 'd')}${link}${r.closeReason ? `\n> ${truncate(r.closeReason, 80)}` : ''}`;
    });
    embed = info(`<@${historyUserId}>\n\n${lines.join('\n') || 'Aucun ticket.'}`).setTitle(`📚 Historique (${list.length} ticket(s))`);
  } else {
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
    const open = records.filter((r) => ['open', 'paused'].includes(r.status) && r.channelId);
    embed = info(
      [
        `**Total :** ${records.length}`,
        `${STATUS.pending} : ${count('pending')} • ${STATUS.open} : ${count('open')} • ${STATUS.paused} : ${count('paused')}`,
        `${STATUS.closed} : ${count('closed') + count('deleted')} • ${STATUS.denied} : ${count('denied')}`,
        `**Durée moyenne :** ${avg ? `${Math.round(avg / 60000)} min` : '—'}`,
        '',
        `**Tickets ouverts :** ${open.map((r) => `<#${r.channelId}>`).join(' ') || '*aucun*'}`,
        '',
        `**Top staff (prises en charge)**\n${top || '—'}`,
        '',
        '-# Choisissez un membre ci-dessous pour voir son historique.',
      ].join('\n'),
    ).setTitle('📊 Statistiques des tickets');
  }
  const rows = [ui.userSelect('tks:history', '📚 Voir l\'historique d\'un membre', historyUserId, { max: 1 })];
  const buttons = [];
  if (historyUserId) buttons.push(ui.button('tks:stats', 'Statistiques', '📊'));
  if (back) buttons.push(ui.backButton('tks:home'));
  if (buttons.length) rows.push(ui.row(...buttons));
  return { embeds: [embed], components: rows };
}

// Menu de gestion d'un ticket (staff), ouvert avec /ticket ou le bouton ⚙️ Gérer.
function manageView(guild, record) {
  const embed = summaryEmbed(guild, record, `⚙️ Gestion du ticket #${pad(record.id)}`).setDescription(
    [
      `**Salon :** <#${record.channelId}>`,
      `**Membres ajoutés :** ${record.addedUsers?.map((id) => `<@${id}>`).join(' ') || '*aucun*'}`,
      '',
      '-# Sélectionnez dans le menu les membres qui doivent avoir accès au ticket (en plus de l\'auteur et du staff).',
    ].join('\n'),
  );
  const closed = record.status === 'closed';
  return {
    embeds: [embed],
    components: [
      ui.userSelect(`tk:members:${record.id}`, '👥 Membres ajoutés au ticket', record.addedUsers, { max: 10 }),
      ui.row(
        ui.button(`tk:claim:${record.id}`, record.claimedBy ? 'Pris en charge' : 'Prendre en charge', '🙋', ButtonStyle.Success).setDisabled(!!record.claimedBy || closed),
        ui.button(`tk:pause:${record.id}`, record.status === 'paused' ? 'Reprendre' : 'Pause', record.status === 'paused' ? '▶️' : '⏸️').setDisabled(closed),
        ui.button(`tk:rename:${record.id}`, 'Renommer', '✏️'),
        ui.button(`tk:transcript:${record.id}`, 'Transcript', '📄'),
      ),
      ui.row(
        closed ? ui.button(`tk:reopen:${record.id}`, 'Rouvrir', '🔓', ButtonStyle.Success) : ui.button(`tk:close:${record.id}`, 'Fermer', '🔒', ButtonStyle.Danger),
        ui.button(`tk:delete:${record.id}`, 'Supprimer le salon', '🗑️', ButtonStyle.Danger),
      ),
    ],
  };
}

function reasonModal(id, cat) {
  return ui.modal(id, cat ? 'Modifier la raison' : 'Nouvelle raison', [
    { id: 'label', label: 'Nom (affiché dans le menu)', value: cat?.label, required: true, max: 100, placeholder: 'Recrutement, Support, Partenariat…' },
    { id: 'emoji', label: 'Emoji (📩 ou <:nom:id>)', value: cat?.emoji, max: 80 },
    { id: 'description', label: 'Description (sous l\'option)', value: cat?.description, max: 100 },
    ...(cat
      ? []
      : [
          {
            id: 'questions',
            label: 'Questions du formulaire (1 par ligne, 5 max)',
            style: 'long',
            max: 500,
            placeholder: 'Quel est votre pseudo en jeu ?\nExpliquez votre problème',
          },
        ]),
  ]);
}

function parseQuestions(text) {
  const qs = String(text || '')
    .split('\n')
    .map((q) => q.trim())
    .filter(Boolean);
  if (qs.length > 5) return { error: 'Maximum 5 questions (limite Discord des formulaires).' };
  const tooLong = qs.find((q) => q.length > 45);
  if (tooLong) return { error: `Question trop longue (45 caractères max) : « ${truncate(tooLong, 60)} »` };
  return { questions: qs };
}

function applyReasonFields(cat, fields) {
  const emoji = fields.getTextInputValue('emoji').trim();
  if (emoji && !isValidEmoji(emoji)) return EMOJI_ERROR;
  cat.label = fields.getTextInputValue('label').trim();
  cat.emoji = emoji || null;
  cat.description = fields.getTextInputValue('description').trim() || null;
  return null;
}

// Messages modifiables avec l'éditeur d'embed
registerTarget('tkmsg', {
  load: (guild, key) => messageOf(guild.id, key),
  save: async (guild, key, data) => {
    const c = store(guild.id).config;
    c.messages = c.messages || {};
    c.messages[key] = data;
    db.save(guild.id);
    if (key === 'panel') await refreshPanels(guild, { appearance: true });
  },
  title: (guild, key) => MESSAGE_LABELS[key].label,
  back: (guild, key) => (key === 'panel' ? sendView(guild) : messagesView(guild)),
  vars: (member) => ticketVars(member.guild, null, member, { staff: `${member}` }),
  help: TICKET_VARS_HELP,
});

registerTarget('tkopen', {
  load: (guild, catId) => openMessageOf(guild.id, category(guild.id, catId)),
  save: (guild, catId, data) => {
    const cat = category(guild.id, catId);
    if (!cat) return;
    cat.openMessage = data;
    delete cat.welcome;
    db.save(guild.id);
  },
  title: (guild, catId) => `message d'ouverture — ${category(guild.id, catId)?.label || ''}`,
  back: (guild, catId) => {
    const cat = category(guild.id, catId);
    return cat ? reasonView(guild, cat) : reasonsView(guild);
  },
  vars: (member, catId) => ticketVars(member.guild, { id: 1, categoryId: catId }, member),
  help: TICKET_VARS_HELP,
});

// ---------- Commande ----------

const ticketCommand = {
  data: new SlashCommandBuilder().setName('ticket').setDescription('Configurer les tickets, ou gérer le ticket actuel').setDMPermission(false),

  async execute(interaction) {
    const { guild, member } = interaction;
    const record = recordByChannel(guild.id, interaction.channelId);
    if (record) {
      if (isStaff(member, category(guild.id, record.categoryId))) return interaction.reply({ ...manageView(guild, record), flags: MessageFlags.Ephemeral });
      return fail(interaction, 'Seul le staff peut gérer ce ticket. Utilisez le bouton 🔒 Fermer pour le fermer.');
    }
    if (canConfigure(member)) return interaction.reply({ ...homeView(guild), flags: MessageFlags.Ephemeral });
    if (isStaff(member)) return interaction.reply({ ...statsView(guild, null, false), flags: MessageFlags.Ephemeral });
    return fail(interaction, 'Pour ouvrir un ticket, utilisez le menu du panel de tickets.');
  },
};

// ---------- Interactions : configuration ----------

const setupComponents = {
  async tks(interaction, [action, key, id]) {
    const { guild, member } = interaction;
    const t = store(guild.id);
    const c = t.config;

    // Stats & historique : accessibles au staff
    if (action === 'stats' || action === 'history') {
      if (!isStaff(member) && !canConfigure(member)) return fail(interaction, 'Réservé au staff.');
      return interaction.update(statsView(guild, action === 'history' ? interaction.values[0] : null, canConfigure(member)));
    }

    if (!canConfigure(member)) return fail(interaction, 'Vous n\'avez pas accès à la configuration des tickets.');
    const findCat = (catId) => t.categories.find((cat) => cat.id === catId);

    // Navigation
    if (action === 'home') return interaction.update(homeView(guild));
    if (action === 'options') return interaction.update(optionsView(guild));
    if (action === 'reasons') return interaction.update(reasonsView(guild));
    if (action === 'messages') return interaction.update(messagesView(guild));
    if (action === 'send') return interaction.update(sendView(guild));
    if (action === 'pick') {
      const cat = findCat(interaction.values[0]);
      return interaction.update(cat ? reasonView(guild, cat) : reasonsView(guild));
    }

    // Réglages généraux
    if (action === 'set') {
      const value = interaction.values[0] || null;
      if (key === 'request') c.requestChannelId = value;
      if (key === 'parent') c.parentId = value;
      if (key === 'logs') db.guild(guild.id).logs.tickets = value;
      if (key === 'staff') c.staffRoleIds = [...interaction.values];
      db.save(guild.id);
      return interaction.update(homeView(guild));
    }

    if (action === 'toggle') {
      if (key === 'userCanClose') c.userCanClose = c.userCanClose === false;
      else c[key] = !c[key];
      db.save(guild.id);
      return interaction.update(optionsView(guild));
    }

    // Messages
    if (action === 'msg') return openBuilder(interaction, 'tkmsg', interaction.values[0]);
    if (action === 'look') return openBuilder(interaction, 'tkmsg', 'panel');
    if (action === 'msgreset') {
      const k = interaction.values[0];
      if (c.messages) delete c.messages[k];
      if (k === 'panel') c.panelTemplate = null;
      db.save(guild.id);
      await interaction.update(messagesView(guild));
      if (k === 'panel') await refreshPanels(guild, { appearance: true });
      return;
    }

    // Panel
    if (action === 'sendto') {
      const channel = guild.channels.cache.get(interaction.values[0]);
      if (!channel) return interaction.update(sendView(guild));
      if (!channel.permissionsFor(guild.members.me)?.has(['SendMessages', 'EmbedLinks', 'ViewChannel'])) {
        return interaction.update(sendView(guild, `❌ Je n'ai pas la permission d'écrire dans ${channel}.`));
      }
      const msg = await sendPanel(guild, channel);
      return interaction.update(sendView(guild, `✅ Panel envoyé : ${msg.url}`));
    }

    // Raisons
    if (['rstaff', 'rparent', 'rapproval', 'rup', 'rdel', 'rreset', 'ropen'].includes(action)) {
      const cat = findCat(key);
      if (!cat) return interaction.update(reasonsView(guild));
      if (action === 'ropen') return openBuilder(interaction, 'tkopen', cat.id);
      if (action === 'rstaff') cat.staffRoleIds = [...interaction.values];
      if (action === 'rparent') cat.parentId = interaction.values[0] || null;
      if (action === 'rapproval') cat.approval = cat.approval === false;
      if (action === 'rreset') {
        delete cat.openMessage;
        delete cat.welcome;
      }
      if (action === 'rup') {
        const idx = t.categories.indexOf(cat);
        if (idx > 0) [t.categories[idx - 1], t.categories[idx]] = [t.categories[idx], t.categories[idx - 1]];
      }
      if (action === 'rdel') t.categories = t.categories.filter((x) => x !== cat);
      db.save(guild.id);
      await interaction.update(action === 'rdel' ? reasonsView(guild) : reasonView(guild, cat));
      if (['rup', 'rdel'].includes(action)) await refreshPanels(guild);
      return;
    }

    // Ouverture des formulaires
    if (action === 'modal') {
      if (key === 'options') {
        return interaction.showModal(
          ui.modal('tks:m:options', 'Réglages des tickets', [
            { id: 'max', label: 'Tickets ouverts max par membre (1-10)', value: String(c.maxOpen), required: true, max: 2 },
            { id: 'name', label: 'Nom des salons ({numero} {user} {categorie})', value: c.nameFormat, required: true, max: 80 },
            { id: 'placeholder', label: 'Texte du menu déroulant', value: c.placeholder, max: 150, placeholder: 'Choisissez la raison de votre ticket' },
            { id: 'autoclose', label: 'Fermeture auto. après X heures (0 = jamais)', value: String(c.autoCloseHours || 0), max: 4 },
          ]),
        );
      }
      if (key === 'new') return interaction.showModal(reasonModal('tks:m:new', null));
      const cat = findCat(id);
      if (!cat) return interaction.update(reasonsView(guild));
      if (key === 'edit') return interaction.showModal(reasonModal(`tks:m:edit:${cat.id}`, cat));
      if (key === 'questions') {
        return interaction.showModal(
          ui.modal(`tks:m:questions:${cat.id}`, 'Questions du formulaire', [
            {
              id: 'questions',
              label: '1 question par ligne (5 max, 45 caractères)',
              value: questionsOf(cat).join('\n'),
              style: 'long',
              max: 500,
              placeholder: 'Quel est votre pseudo ?\nExpliquez votre demande\n(vide = pas de formulaire)',
            },
          ]),
        );
      }
    }

    // Validation des formulaires
    if (action === 'm') {
      if (key === 'options') {
        const max = Number(interaction.fields.getTextInputValue('max'));
        const hours = Number(interaction.fields.getTextInputValue('autoclose') || 0);
        if (!Number.isInteger(max) || max < 1 || max > 10) return fail(interaction, 'Le nombre max doit être entre 1 et 10.');
        if (!Number.isFinite(hours) || hours < 0 || hours > 720) return fail(interaction, 'La fermeture automatique doit être entre 0 et 720 heures.');
        c.maxOpen = max;
        c.nameFormat = interaction.fields.getTextInputValue('name').trim() || 'ticket-{numero}';
        c.placeholder = interaction.fields.getTextInputValue('placeholder').trim() || null;
        c.autoCloseHours = hours;
        db.save(guild.id);
        await interaction.update(optionsView(guild));
        return refreshPanels(guild);
      }

      if (key === 'new') {
        if (t.categories.length >= 25) return fail(interaction, 'Maximum 25 raisons.');
        const cat = { id: newId(), approval: true, staffRoleIds: [] };
        const error = applyReasonFields(cat, interaction.fields);
        if (error) return fail(interaction, error);
        const parsed = parseQuestions(interaction.fields.getTextInputValue('questions'));
        if (parsed.error) return fail(interaction, parsed.error);
        cat.questions = parsed.questions;
        t.categories.push(cat);
        db.save(guild.id);
        await interaction.update(reasonView(guild, cat));
        return refreshPanels(guild);
      }

      const cat = findCat(id);
      if (!cat) return fail(interaction, 'Cette raison n\'existe plus.');
      if (key === 'edit') {
        const error = applyReasonFields(cat, interaction.fields);
        if (error) return fail(interaction, error);
      }
      if (key === 'questions') {
        const parsed = parseQuestions(interaction.fields.getTextInputValue('questions'));
        if (parsed.error) return fail(interaction, parsed.error);
        cat.questions = parsed.questions;
        delete cat.question;
      }
      db.save(guild.id);
      await interaction.update(reasonView(guild, cat));
      return refreshPanels(guild);
    }
  },
};

// ---------- Interactions : membres & staff ----------

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
      const qs = questionsOf(cat);
      if (qs.length) {
        return interaction.showModal(
          new ModalBuilder()
            .setCustomId(`tk:form:${cat.id}`)
            .setTitle(truncate(`${cat.label}`, 45))
            .addComponents(
              qs.map((q, i) =>
                new ActionRowBuilder().addComponents(
                  new TextInputBuilder()
                    .setCustomId(`q${i}`)
                    .setLabel(truncate(q, 45))
                    .setStyle(qs.length > 2 ? TextInputStyle.Short : TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMaxLength(qs.length > 2 ? 400 : 1000),
                ),
              ),
            ),
        );
      }
      await interaction.update({ components: interaction.message.components });
      return submitTicket(interaction, cat, []);
    }

    if (action === 'form') {
      const cat = category(guild.id, arg);
      if (!cat) return fail(interaction, 'Cette raison n\'existe plus.');
      if (interaction.isFromMessage()) await interaction.update({ components: interaction.message.components });
      else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (activeCount(guild.id, interaction.user.id) >= (t.config.maxOpen || 1)) return fail(interaction, 'Vous avez déjà un ticket en cours.');
      const answers = questionsOf(cat).map((q, i) => ({ q, a: interaction.fields.fields.has(`q${i}`) ? interaction.fields.getTextInputValue(`q${i}`) : '' }));
      return submitTicket(interaction, cat, answers);
    }

    const record = t.records[arg];
    if (!record) return fail(interaction, 'Ticket introuvable.');
    const cat = category(guild.id, record.categoryId);
    const staff = isStaff(interaction.member, cat);
    const fromManage = interaction.message?.flags?.has(MessageFlags.Ephemeral);
    // Rafraîchit le menu de gestion (s'il a été utilisé) après une action.
    const refreshManage = () => (fromManage ? interaction.editReply(manageView(guild, record)).catch(() => null) : null);

    if (action === 'accept' || action === 'deny') {
      if (!staff) return fail(interaction, 'Réservé au staff.');
      if (record.status !== 'pending') return fail(interaction, 'Cette demande a déjà été traitée.');
      if (action === 'deny') {
        return interaction.showModal(
          ui.modal(`tk:denyform:${record.id}`, 'Refuser la demande', [{ id: 'reason', label: 'Raison (envoyée au membre)', style: 'long', max: 500 }]),
        );
      }
      await interaction.deferUpdate();
      record.status = 'accepting';
      record.acceptedBy = interaction.user.id;
      let channel;
      try {
        channel = await createTicketChannel(guild, record);
      } catch (err) {
        record.status = 'pending';
        db.save(guild.id);
        return fail(interaction, `Impossible de créer le ticket : ${err.message}`);
      }
      db.save(guild.id);
      await interaction.editReply({
        embeds: [summaryEmbed(guild, record, '✅ Demande acceptée').setColor(0x22c55e).setDescription(`Acceptée par ${interaction.user} • ${channel}`)],
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Aller au ticket').setStyle(ButtonStyle.Link).setURL(channel.url))],
      });
      const member = await guild.members.fetch(record.userId).catch(() => null);
      const payload = renderTemplate(messageOf(guild.id, 'dmAccept'), ticketVars(guild, record, member, { staff: `${interaction.user}` }));
      const sent =
        member &&
        (await dm(member.user, {
          ...payload,
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
      const member = await guild.members.fetch(record.userId).catch(() => null);
      if (member) {
        await dm(member.user, renderTemplate(messageOf(guild.id, 'dmDeny'), ticketVars(guild, record, member, { staff: `${interaction.user}`, raison: reason || 'Aucune raison précisée' })));
      }
      await sendLog(guild, 'tickets', summaryEmbed(guild, record, '⛔ Demande refusée').setDescription(`Par ${interaction.user}${reason ? `\n**Raison :** ${reason}` : ''}`));
      return;
    }

    if (action === 'close') {
      if (!staff && (interaction.user.id !== record.userId || t.config.userCanClose === false)) return fail(interaction, 'Vous ne pouvez pas fermer ce ticket.');
      if (record.status === 'closed') return fail(interaction, 'Ce ticket est déjà fermé.');
      return interaction.showModal(ui.modal(`tk:closeform:${record.id}`, 'Fermer le ticket', [{ id: 'reason', label: 'Raison (optionnelle)', style: 'long', max: 500 }]));
    }

    if (action === 'closeform') {
      if (record.status === 'closed') return fail(interaction, 'Ce ticket est déjà fermé.');
      await interaction.deferUpdate();
      await closeTicket(guild, record, interaction.user, interaction.fields.getTextInputValue('reason').trim());
      return refreshManage();
    }

    // Tout le reste est réservé au staff
    if (!staff) return fail(interaction, 'Réservé au staff.');

    if (action === 'manage') return interaction.reply({ ...manageView(guild, record), flags: MessageFlags.Ephemeral });

    if (action === 'claim') {
      if (record.claimedBy) return fail(interaction, `Déjà pris en charge par <@${record.claimedBy}>.`);
      await interaction.deferUpdate();
      await claimTicket(guild, record, interaction.user);
      return refreshManage();
    }

    if (action === 'pause') {
      if (record.status === 'closed') return fail(interaction, 'Ce ticket est fermé.');
      await interaction.deferUpdate();
      await setPaused(guild, record, interaction.user, record.status !== 'paused');
      return refreshManage();
    }

    if (action === 'members') {
      const channel = guild.channels.cache.get(record.channelId);
      if (!channel) return fail(interaction, 'Salon introuvable.');
      const wanted = [...interaction.users.filter((u) => !u.bot && u.id !== record.userId).keys()];
      const before = record.addedUsers || [];
      const added = wanted.filter((id) => !before.includes(id));
      const removed = before.filter((id) => !wanted.includes(id));
      await interaction.deferUpdate();
      if (record.status !== 'closed') {
        for (const id of added) await channel.permissionOverwrites.edit(id, Object.fromEntries(USER_PERMS.map((p) => [p, true]))).catch(() => null);
      }
      for (const id of removed) await channel.permissionOverwrites.delete(id).catch(() => null);
      record.addedUsers = wanted;
      db.save(guild.id);
      const lines = [...added.map((id) => `➕ <@${id}> a été ajouté au ticket.`), ...removed.map((id) => `➖ <@${id}> a été retiré du ticket.`)];
      if (lines.length) await channel.send({ embeds: [info(lines.join('\n'))], allowedMentions: { parse: [] } });
      return refreshManage();
    }

    if (action === 'rename') {
      return interaction.showModal(
        ui.modal(`tk:renameform:${record.id}`, 'Renommer le ticket', [
          { id: 'name', label: 'Nouveau nom du salon', value: guild.channels.cache.get(record.channelId)?.name, required: true, max: 90 },
        ]),
      );
    }

    if (action === 'renameform') {
      const channel = guild.channels.cache.get(record.channelId);
      const name = slug(interaction.fields.getTextInputValue('name'));
      await interaction.deferUpdate();
      // Discord limite les renommages à 2 toutes les 10 minutes par salon.
      const done = await Promise.race([channel.setName(name).then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5000))]).catch(() => false);
      await interaction
        .followUp({
          embeds: [info(done ? `✏️ Salon renommé en \`${name}\`.` : '⏳ Discord limite à 2 renommages toutes les 10 minutes : le nom sera appliqué dès que possible.')],
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => null);
      return refreshManage();
    }

    if (action === 'transcript') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const channel = guild.channels.cache.get(record.channelId);
      const { html } = await createTranscript(channel, { title: `Ticket #${pad(record.id)}` });
      return interaction.editReply({ files: [new AttachmentBuilder(Buffer.from(html), { name: `ticket-${pad(record.id)}.html` })] });
    }

    if (action === 'reopen') {
      if (record.status !== 'closed') return fail(interaction, 'Ce ticket n\'est pas fermé.');
      if (fromManage) await interaction.deferUpdate();
      else await interaction.update({ components: [] });
      await reopenTicket(guild, record, interaction.user);
      return refreshManage();
    }

    if (action === 'delete') {
      const channel = guild.channels.cache.get(record.channelId);
      if (fromManage) await interaction.update({ embeds: [info('🗑️ Le salon va être supprimé.')], components: [] });
      else await interaction.update({ components: [] });
      await channel?.send({ embeds: [baseEmbed(0xef4444).setDescription('🗑️ Suppression du salon dans 5 secondes…')] });
      record.status = 'deleted';
      record.deletedBy = interaction.user.id;
      db.save(guild.id);
      await sendLog(guild, 'tickets', summaryEmbed(guild, record, '🗑️ Ticket supprimé').setDescription(`Par ${interaction.user}`));
      setTimeout(() => channel?.delete().catch(() => null), 5000);
      return;
    }
  },
};

// ---------- Fermeture automatique & événements ----------

function startAutoClose(client) {
  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      const t = store(guild.id);
      const hours = t.config.autoCloseHours;
      if (!hours) continue;
      for (const record of Object.values(t.records)) {
        if (record.status !== 'open' || !record.channelId) continue;
        const channel = guild.channels.cache.get(record.channelId);
        if (!channel) continue;
        const last = channel.lastMessageId ? SnowflakeUtil.timestampFrom(channel.lastMessageId) : record.openedAt;
        if (Date.now() - last < hours * 3600000) continue;
        await closeTicket(guild, record, client.user, `Fermeture automatique après ${hours} h d'inactivité`).catch((err) => console.error('[tickets] auto-close', err.message));
      }
    }
  }, 10 * 60 * 1000);
}

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

module.exports = {
  commands: [ticketCommand],
  components: { ...components, ...setupComponents },
  events,
  init: startAutoClose,
  dashboard: { key: 'ticket', label: 'Tickets', emoji: '🎫', canAccess: canConfigure, view: (interaction) => homeView(interaction.guild) },
};
