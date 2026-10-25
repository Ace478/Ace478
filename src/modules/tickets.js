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
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  SnowflakeUtil,
} = require('discord.js');
const { canUse } = require('../lib/access');
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
    await msg.edit({ components: panelComponents(guild.id, panel.placeholder || t.config.placeholder) }).catch(() => null);
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

// ---------- Tableau de bord de configuration (/ticket-config) ----------

function canConfigure(member) {
  return canUse(member, 'ticket-config', PermissionFlagsBits.ManageGuild);
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function reasonLine(guildId, cat) {
  const parts = [`${cat.emoji || '•'} **${cat.label}**`, cat.approval !== false ? '✅ validation staff' : '⚡ ouverture directe'];
  const qs = questionsOf(cat);
  if (qs.length) parts.push(`❓ ${qs.length} question(s)`);
  if (cat.staffRoleIds?.length) parts.push(cat.staffRoleIds.map((id) => `<@&${id}>`).join(' '));
  if (cat.parentId) parts.push(`📁 <#${cat.parentId}>`);
  return parts.join(' • ');
}

function backButton(target = 'home', label = 'Retour') {
  return new ButtonBuilder().setCustomId(`tks:${target}`).setLabel(label).setEmoji('↩️').setStyle(ButtonStyle.Secondary);
}

function channelSelect(id, placeholder, types, current) {
  const menu = new ChannelSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).setChannelTypes(...types).setMinValues(0).setMaxValues(1);
  if (current) menu.setDefaultChannels(current);
  return new ActionRowBuilder().addComponents(menu);
}

function roleSelect(id, placeholder, current) {
  const menu = new RoleSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).setMinValues(0).setMaxValues(10);
  if (current?.length) menu.setDefaultRoles(...current);
  return new ActionRowBuilder().addComponents(menu);
}

function homeView(guild) {
  const t = store(guild.id);
  const c = t.config;
  const logs = db.guild(guild.id).logs.tickets;
  const step = (done) => (done ? '✅' : '⬜');
  const embed = info(
    [
      '**Configurez tout depuis ce panneau** (visible par vous seul) :',
      `${step(c.staffRoleIds.length)} **1.** Choisissez les rôles staff et les salons avec les menus ci-dessous`,
      `${step(t.categories.length)} **2.** Ajoutez vos raisons de ticket avec **Raisons**`,
      `${step(t.panels?.length)} **3.** Envoyez le panel avec **Envoyer le panel**`,
      '',
      `📨 **Salon des demandes :** ${c.requestChannelId ? `<#${c.requestChannelId}>` : '*aucun → les tickets s\'ouvrent directement*'}`,
      `📁 **Catégorie des tickets :** ${c.parentId ? `<#${c.parentId}>` : '*aucune*'}`,
      `📜 **Logs & transcripts :** ${logs ? `<#${logs}>` : '*aucun*'}`,
      `🛡️ **Rôles staff :** ${c.staffRoleIds.map((id) => `<@&${id}>`).join(' ') || '*aucun (owners/admins seulement)*'}`,
      '',
      `**Raisons (${t.categories.length}/25)**`,
      t.categories.map((cat) => reasonLine(guild.id, cat)).join('\n') || '*Aucune pour le moment.*',
    ].join('\n'),
  ).setTitle('🎫 Configuration des tickets');

  return {
    embeds: [embed],
    components: [
      channelSelect('tks:set:request', '📨 Salon des demandes staff (vide = ouverture directe)', [ChannelType.GuildText], c.requestChannelId),
      channelSelect('tks:set:parent', '📁 Catégorie où créer les tickets', [ChannelType.GuildCategory], c.parentId),
      channelSelect('tks:set:logs', '📜 Salon des logs et transcripts', [ChannelType.GuildText], logs),
      roleSelect('tks:set:staff', '🛡️ Rôles staff (accès à tous les tickets)', c.staffRoleIds),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tks:reasons').setLabel(`Raisons (${t.categories.length})`).setEmoji('📋').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('tks:options').setLabel('Options').setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('tks:send').setLabel('Envoyer le panel').setEmoji('📤').setStyle(ButtonStyle.Success).setDisabled(!t.categories.length),
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
  const toggle = (key, label, value) =>
    new ButtonBuilder()
      .setCustomId(`tks:toggle:${key}`)
      .setLabel(label)
      .setStyle(value ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setEmoji(value ? '✅' : '✖️');
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        toggle('dmTranscript', 'Transcript en MP', c.dmTranscript),
        toggle('pingStaff', 'Mention staff', c.pingStaff),
        toggle('userCanClose', 'Fermeture par le membre', c.userCanClose !== false),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tks:modal:options').setLabel('Modifier les réglages').setEmoji('✏️').setStyle(ButtonStyle.Primary),
        backButton(),
      ),
    ],
  };
}

function reasonsView(guild) {
  const t = store(guild.id);
  const embed = info(
    [
      'Chaque **raison** est une option du menu déroulant du panel.',
      'Sélectionnez-en une pour la modifier (textes, questions, rôles, catégorie, validation…).',
      '',
      t.categories.map((cat, i) => `\`${i + 1}.\` ${reasonLine(guild.id, cat)}`).join('\n') || '*Aucune raison. Cliquez sur **Ajouter une raison**.*',
    ].join('\n'),
  ).setTitle(`📋 Raisons de ticket (${t.categories.length}/25)`);
  const components = [];
  if (t.categories.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('tks:pick')
          .setPlaceholder('✏️ Choisir une raison à modifier')
          .addOptions(t.categories.map((cat) => ({ label: cat.label, value: cat.id, emoji: cat.emoji || undefined, description: cat.description ? truncate(cat.description, 100) : undefined }))),
      ),
    );
  }
  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tks:modal:new').setLabel('Ajouter une raison').setEmoji('➕').setStyle(ButtonStyle.Success).setDisabled(t.categories.length >= 25),
      backButton(),
    ),
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
      '',
      `**Questions du formulaire (${qs.length}/5) :**`,
      qs.map((q, i) => `${i + 1}. ${q}`).join('\n') || '*aucune — le ticket s\'ouvre sans formulaire*',
      '',
      '**Message d\'accueil dans le ticket :**',
      `>>> ${cat.welcome || '*message par défaut*'}`,
    ].join('\n'),
  ).setTitle(`✏️ Raison : ${cat.label}`);
  return {
    embeds: [embed],
    components: [
      roleSelect(`tks:rstaff:${cat.id}`, '🛡️ Rôles staff spécifiques à cette raison', cat.staffRoleIds),
      channelSelect(`tks:rparent:${cat.id}`, '📁 Catégorie spécifique (vide = générale)', [ChannelType.GuildCategory], cat.parentId),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`tks:modal:edit:${cat.id}`).setLabel('Textes').setEmoji('📝').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`tks:modal:questions:${cat.id}`).setLabel('Questions').setEmoji('❓').setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`tks:rapproval:${cat.id}`)
          .setLabel(cat.approval !== false ? 'Validation : oui' : 'Validation : non')
          .setEmoji(cat.approval !== false ? '✅' : '⚡')
          .setStyle(cat.approval !== false ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`tks:rup:${cat.id}`).setLabel('Monter').setEmoji('⬆️').setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder().addComponents(
        backButton('reasons', 'Raisons'),
        new ButtonBuilder().setCustomId(`tks:rdel:${cat.id}`).setLabel('Supprimer').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      ),
    ],
  };
}

function sendView(guild, status) {
  const t = store(guild.id);
  const templates = Object.keys(db.guild(guild.id).embeds).slice(0, 24);
  const current = t.config.panelTemplate && db.guild(guild.id).embeds[t.config.panelTemplate] ? t.config.panelTemplate : '';
  const embed = info(
    [
      '**1.** Choisissez l\'apparence du panel : le modèle par défaut (comme l\'exemple), ou un modèle créé avec `/embed creer`.',
      '**2.** Choisissez le salon : le panel y est envoyé immédiatement.',
      '',
      `**Modèle :** ${current ? `\`${current}\`` : 'par défaut'}`,
      `**Panels actifs :** ${t.panels?.length || 0} (mis à jour automatiquement quand vous modifiez les raisons)`,
      status ? `\n${status}` : '',
    ].join('\n'),
  ).setTitle('📤 Envoyer le panel');
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('tks:template')
          .setPlaceholder('🎨 Apparence du panel')
          .addOptions(
            { label: 'Modèle par défaut', value: '__default', emoji: '🎫', default: !current },
            ...templates.map((n) => ({ label: truncate(n, 100), value: n, emoji: '💾', default: n === current })),
          ),
      ),
      channelSelect('tks:sendto', '📤 Envoyer le panel dans…', [ChannelType.GuildText, ChannelType.GuildAnnouncement]),
      new ActionRowBuilder().addComponents(backButton()),
    ],
  };
}

async function sendPanel(guild, channel, templateName, placeholder) {
  const t = store(guild.id);
  const template = (templateName && db.guild(guild.id).embeds[templateName]) || defaultPanel();
  const msg = await channel.send({ ...renderTemplate(template, memberVars(null, guild)), components: panelComponents(guild.id, placeholder) });
  t.panels = t.panels || [];
  t.panels.push({ channelId: channel.id, messageId: msg.id, placeholder: placeholder || null });
  db.save(guild.id);
  return msg;
}

function textModal(id, title, inputs) {
  return new ModalBuilder()
    .setCustomId(id)
    .setTitle(title)
    .addComponents(
      inputs.map(({ id: inputId, label, value, style = TextInputStyle.Short, required = false, max, placeholder }) => {
        const field = new TextInputBuilder().setCustomId(inputId).setLabel(label).setStyle(style).setRequired(required);
        if (value) field.setValue(String(value).slice(0, max || 4000));
        if (max) field.setMaxLength(max);
        if (placeholder) field.setPlaceholder(placeholder);
        return new ActionRowBuilder().addComponents(field);
      }),
    );
}

function reasonModal(id, cat) {
  return textModal(id, cat ? 'Modifier la raison' : 'Nouvelle raison', [
    { id: 'label', label: 'Nom (affiché dans le menu)', value: cat?.label, required: true, max: 100, placeholder: 'Recrutement, Support, Partenariat…' },
    { id: 'emoji', label: 'Emoji (📩 ou <:nom:id>)', value: cat?.emoji, max: 80 },
    { id: 'description', label: 'Description (sous l\'option)', value: cat?.description, max: 100 },
    {
      id: 'welcome',
      label: 'Message d\'accueil dans le ticket',
      value: cat?.welcome,
      style: TextInputStyle.Paragraph,
      max: 2000,
      placeholder: 'Bonjour {user} ! Décrivez votre demande… (vide = message par défaut)',
    },
    ...(cat
      ? []
      : [
          {
            id: 'questions',
            label: 'Questions du formulaire (1 par ligne, 5 max)',
            style: TextInputStyle.Paragraph,
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
  cat.welcome = fields.getTextInputValue('welcome').trim() || null;
  return null;
}

const configCommand = {
  data: new SlashCommandBuilder()
    .setName('ticket-config')
    .setDescription('Ouvrir le panneau de configuration des tickets')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),

  async execute(interaction) {
    return interaction.reply({ ...homeView(interaction.guild), flags: MessageFlags.Ephemeral });
  },
};

const setupComponents = {
  async tks(interaction, [action, key, id]) {
    const { guild } = interaction;
    if (!canConfigure(interaction.member)) return fail(interaction, 'Vous n\'avez pas accès à la configuration des tickets.');
    const t = store(guild.id);
    const c = t.config;
    const findCat = (catId) => t.categories.find((cat) => cat.id === catId);

    // Navigation
    if (action === 'home') return interaction.update(homeView(guild));
    if (action === 'options') return interaction.update(optionsView(guild));
    if (action === 'reasons') return interaction.update(reasonsView(guild));
    if (action === 'send') return interaction.update(sendView(guild));
    if (action === 'pick') {
      const cat = findCat(interaction.values[0]);
      return interaction.update(cat ? reasonView(guild, cat) : reasonsView(guild));
    }

    // Réglages généraux (menus de sélection)
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

    // Panel
    if (action === 'template') {
      c.panelTemplate = interaction.values[0] === '__default' ? null : interaction.values[0];
      db.save(guild.id);
      return interaction.update(sendView(guild));
    }
    if (action === 'sendto') {
      const channel = guild.channels.cache.get(interaction.values[0]);
      if (!channel) return interaction.update(sendView(guild));
      if (!channel.permissionsFor(guild.members.me)?.has(['SendMessages', 'EmbedLinks', 'ViewChannel'])) {
        return interaction.update(sendView(guild, `❌ Je n'ai pas la permission d'écrire dans ${channel}.`));
      }
      const msg = await sendPanel(guild, channel, c.panelTemplate);
      return interaction.update(sendView(guild, `✅ Panel envoyé : ${msg.url}\nPour modifier son texte : \`/embed modifier\` avec ce lien.`));
    }

    // Raisons
    if (action === 'rstaff' || action === 'rparent' || action === 'rapproval' || action === 'rup' || action === 'rdel') {
      const cat = findCat(key);
      if (!cat) return interaction.update(reasonsView(guild));
      if (action === 'rstaff') cat.staffRoleIds = [...interaction.values];
      if (action === 'rparent') cat.parentId = interaction.values[0] || null;
      if (action === 'rapproval') cat.approval = cat.approval === false;
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
          textModal('tks:m:options', 'Réglages des tickets', [
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
          textModal(`tks:m:questions:${cat.id}`, 'Questions du formulaire', [
            {
              id: 'questions',
              label: '1 question par ligne (5 max, 45 caractères)',
              value: questionsOf(cat).join('\n'),
              style: TextInputStyle.Paragraph,
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

// Fermeture automatique des tickets inactifs (vérifiée toutes les 10 minutes).
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
      if (!canConfigure(member)) return fail(interaction, 'Vous n\'avez pas accès à la configuration des tickets.');
      if (!t.categories.length) return fail(interaction, 'Ajoutez d\'abord au moins une raison avec `/ticket-config`.');
      const channel = interaction.options.getChannel('salon') || interaction.channel;
      const name = interaction.options.getString('modele');
      if (name && !db.guild(guild.id).embeds[name]) return fail(interaction, `Le modèle \`${name}\` n'existe pas.`);
      const placeholder = interaction.options.getString('texte_menu');
      const msg = await sendPanel(guild, channel, name, placeholder);
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
      if (!staff && (member.id !== record.userId || t.config.userCanClose === false)) return fail(interaction, 'Vous ne pouvez pas fermer ce ticket.');
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
      return submitTicket(interaction, cat, null);
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
      if (!staff && (interaction.user.id !== record.userId || t.config.userCanClose === false)) return fail(interaction, 'Vous ne pouvez pas fermer ce ticket.');
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

module.exports = {
  commands: [configCommand, ticketCommand],
  components: { ...components, ...setupComponents },
  events,
  init: startAutoClose,
};
