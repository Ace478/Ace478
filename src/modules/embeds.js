// Créateur d'embeds interactif : menus + formulaires, aperçu en direct.
// Il sert aussi à personnaliser tous les messages du bot (bienvenue, tickets,
// menus de rôles…) : chaque module enregistre une "cible" via registerTarget().
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ButtonStyle,
  TextInputBuilder,
  TextInputStyle,
  ModalBuilder,
  ChannelType,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');
const db = require('../lib/db');
const { canUse } = require('../lib/access');
const { renderMessage, hasSharp } = require('../lib/media');
const ui = require('../lib/ui');
const {
  parseColor,
  colorToHex,
  memberVars,
  ok,
  fail,
  info,
  success,
  failure,
  fetchMessageFromLink,
  truncate,
  probeImage,
  channelMention,
} = require('../lib/utils');

const sessions = new Map(); // userId -> { guildId, data, target, editTarget, name, fromHub }
const targets = new Map(); // kind -> { load, save, title, back, vars, allowSend, help }

/**
 * Permet à un module de rendre un de ses messages modifiable avec l'éditeur.
 * def.load(guild, id) -> { content, embeds }       (peut être async)
 * def.save(guild, id, data)                          (peut être async)
 * def.back(guild, id, member) -> payload du panneau à réafficher
 * def.title(guild, id) -> texte affiché en haut de l'éditeur
 * def.vars(member, id) -> variables supplémentaires pour l'aperçu
 * def.help -> variables spécifiques affichées dans l'aide
 */
function registerTarget(kind, def) {
  targets.set(kind, def);
}

const VARIABLES_HELP = [
  '`{user}` mention du membre',
  '`{user.name}` nom d\'utilisateur',
  '`{user.displayname}` pseudo sur le serveur',
  '`{user.id}` identifiant',
  '`{user.avatar}` URL de l\'avatar (utilisable en image/miniature)',
  '`{user.created}` date de création du compte',
  '`{server}` nom du serveur',
  '`{server.icon}` URL de l\'icône du serveur',
  '`{server.members}` nombre de membres',
  '`{salon:regles}` mention du salon dont le nom contient « regles »',
].join('\n');

function emptyData() {
  return { content: '', embeds: [{ color: 0x3b82f6 }] };
}

function current(session) {
  if (!session.data.embeds?.length) session.data.embeds = [{}];
  return session.data.embeds[0];
}

async function builderView(session, member) {
  const def = session.target ? targets.get(session.target.kind) : null;
  const vars = memberVars(member, member.guild, def?.vars?.(member, session.target.id) || {});
  const rendered = await renderMessage(session.data, vars);
  const embeds = rendered.embeds.length
    ? rendered.embeds
    : [info('*Embed vide — utilisez le menu ci-dessous pour ajouter un titre, une description, une image…*').toJSON()];

  const title = def ? def.title(member.guild, session.target.id) : session.name ? `modèle \`${session.name}\`` : session.editTarget ? 'modification d\'un message existant' : 'nouvel embed';
  const header = [`🎨 **Éditeur** — ${title}`, '-# Aperçu ci-dessous. Modifiez avec le menu, puis enregistrez.'];
  if (session.data.content) header.push(`**Texte au-dessus de l'embed :**\n>>> ${truncate(rendered.content, 1500)}`);

  // Contrôles automatiques : salons introuvables, bannière trop petite
  const missing = [...new Set([...JSON.stringify(session.data).matchAll(/\{salon:([^}]+)\}/gi)].map((m) => m[1].trim()))].filter(
    (name) => !channelMention(member.guild, name),
  );
  if (missing.length) {
    header.push(`⚠️ **Salon introuvable :** ${missing.map((n) => `\`{salon:${n}}\``).join(', ')} — mettez un mot présent dans le nom du salon (ex : \`{salon:reglement}\`), ou sa mention \`<#id>\`.`);
  }
  const img = session.imageInfo;
  const forcedWidth = current(session).image?.width;
  if (forcedWidth) {
    header.push(`📏 **Largeur forcée : ${forcedWidth} px**${current(session).image?.url ? '' : ' *(sans bannière : image transparente)*'}${hasSharp() || !current(session).image?.url ? '' : ' — ⚠️ module `sharp` non installé (`npm install`)'}`);
  } else if (img && img.url === current(session).image?.url && img.width < 1000) {
    header.push(`⚠️ **Bannière trop petite (${img.width}×${img.height} px)** : elle s'affiche en petit et rend l'embed étroit. Utilisez une image d'au moins **1200 px de large** (idéal : 1200×400).`);
  }

  const e = current(session);
  const menu = new StringSelectMenuBuilder()
    .setCustomId('emb:edit')
    .setPlaceholder('✏️ Que voulez-vous modifier ?')
    .addOptions(
      { label: 'Titre & lien', value: 'title', emoji: '🔤', description: e.title ? truncate(e.title, 90) : 'Aucun titre' },
      { label: 'Description', value: 'description', emoji: '📝', description: 'Texte principal (markdown, emojis, ## titres…)' },
      { label: 'Couleur', value: 'color', emoji: '🎨', description: e.color != null ? colorToHex(e.color) : 'Par défaut' },
      { label: 'Auteur', value: 'author', emoji: '👤', description: 'Petit texte + icône en haut' },
      { label: 'Pied de page', value: 'footer', emoji: '🔻', description: 'Petit texte + icône en bas' },
      { label: 'Image & miniature', value: 'images', emoji: '🖼️', description: 'Bannière en bas / petite image à droite' },
      { label: 'Largeur de l\'embed', value: 'width', emoji: '📏', description: e.image?.width ? `${e.image.width} px` : 'Automatique (selon la bannière)' },
      { label: 'Ajouter un champ', value: 'field_add', emoji: '➕', description: `${e.fields?.length || 0}/25 champs` },
      { label: 'Modifier / supprimer des champs', value: 'field_remove', emoji: '➖' },
      { label: e.timestamp ? 'Retirer l\'horodatage' : 'Ajouter l\'horodatage', value: 'timestamp', emoji: '🕒' },
      { label: 'Texte au-dessus de l\'embed', value: 'content', emoji: '💬', description: 'Message normal (mentions, @everyone…)' },
      { label: 'Importer du JSON', value: 'json', emoji: '📥', description: 'Compatible Discohook / autres bots' },
    );

  const rows = [new ActionRowBuilder().addComponents(menu)];

  if (!def || def.allowSend) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('emb:send')
          .setPlaceholder('📤 Envoyer dans un salon…')
          .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread),
      ),
    );
  }

  const buttons = new ActionRowBuilder();
  if (def) {
    buttons.addComponents(
      ui.button('emb:commit', 'Enregistrer', '💾', ButtonStyle.Success),
      ui.button('emb:cancel', 'Annuler', '↩️'),
    );
  } else {
    if (session.editTarget) buttons.addComponents(ui.button('emb:apply', 'Appliquer au message', '✏️', ButtonStyle.Success));
    buttons.addComponents(ui.button('emb:save', 'Sauver en modèle', '💾', ButtonStyle.Primary));
  }
  buttons.addComponents(ui.button('emb:export', 'JSON', '📄'), ui.button('emb:vars', 'Variables', '❔'));
  if (buttons.components.length < 5) buttons.addComponents(ui.button('emb:reset', 'Vider', '🗑️', ButtonStyle.Danger));
  rows.push(buttons);
  if (!def && session.fromHub) rows.push(ui.row(ui.backButton('emb:home', 'Liste des embeds')));

  return { content: header.join('\n'), embeds, files: rendered.files, attachments: [], components: rows, allowedMentions: { parse: [] } };
}

// Met à jour l'éditeur (préparer la bannière peut prendre une seconde, d'où le deferUpdate).
async function show(interaction, session) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  const e = current(session);
  const imageUrl = e.image?.url;
  if (imageUrl && !imageUrl.includes('{') && !e.image.width && session.imageInfo?.url !== imageUrl) {
    const size = await probeImage(imageUrl);
    session.imageInfo = size ? { url: imageUrl, ...size } : null;
  }
  return interaction.editReply(await builderView(session, interaction.member));
}

async function openBuilder(interaction, kind, id) {
  const def = targets.get(kind);
  const data = structuredClone((await def.load(interaction.guild, id)) || emptyData());
  if (!data.embeds?.length) data.embeds = [{}];
  const session = { guildId: interaction.guildId, data, target: { kind, id } };
  sessions.set(interaction.user.id, session);
  return show(interaction, session);
}

function input(id, label, value, { style = TextInputStyle.Short, required = false, max, placeholder } = {}) {
  const field = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required);
  if (value) field.setValue(String(value).slice(0, max || 4000));
  if (max) field.setMaxLength(max);
  if (placeholder) field.setPlaceholder(placeholder);
  return new ActionRowBuilder().addComponents(field);
}

function buildModal(kind, session) {
  const e = current(session);
  const modal = new ModalBuilder().setCustomId(`emb:m:${kind}`);
  switch (kind) {
    case 'title':
      return modal.setTitle('Titre').addComponents(
        input('title', 'Titre', e.title, { max: 256 }),
        input('url', 'Lien du titre (optionnel)', e.url, { placeholder: 'https://…' }),
      );
    case 'description':
      return modal.setTitle('Description').addComponents(
        input('description', 'Description', e.description, {
          style: TextInputStyle.Paragraph,
          max: 4000,
          placeholder: '## 🧭 Titre de section\n> Texte…\n**gras**, *italique*, emojis <:nom:id>',
        }),
      );
    case 'color':
      return modal.setTitle('Couleur').addComponents(
        input('color', 'Couleur (hex ou nom)', colorToHex(e.color), { placeholder: '#3b82f6, rouge, vert, violet…', max: 20 }),
      );
    case 'author':
      return modal.setTitle('Auteur').addComponents(
        input('name', 'Texte', e.author?.name, { max: 256 }),
        input('icon', 'Icône (URL ou {user.avatar} / {server.icon})', e.author?.icon_url),
        input('url', 'Lien (optionnel)', e.author?.url),
      );
    case 'footer':
      return modal.setTitle('Pied de page').addComponents(
        input('text', 'Texte', e.footer?.text, { max: 2048 }),
        input('icon', 'Icône (URL ou {server.icon})', e.footer?.icon_url),
      );
    case 'images':
      return modal.setTitle('Images').addComponents(
        input('image', 'Grande image (URL)', e.image?.url, { placeholder: 'https://… .png / .gif' }),
        input('thumbnail', 'Miniature à droite (URL)', e.thumbnail?.url, { placeholder: '{user.avatar}' }),
        input('width', 'Largeur de l\'embed en px (vide = auto)', e.image?.width, { placeholder: '300 = étroit · 450 = moyen · 1200 = le plus large', max: 4 }),
      );
    case 'width':
      return modal.setTitle('Largeur de l\'embed').addComponents(
        input('width', 'Largeur en pixels (vide = automatique)', e.image?.width, { placeholder: '300 = étroit · 450 = moyen · 1200 = le plus large', max: 4 }),
      );
    case 'field_add':
      return modal.setTitle('Ajouter un champ').addComponents(
        input('name', 'Nom du champ', '', { required: true, max: 256 }),
        input('value', 'Valeur', '', { required: true, style: TextInputStyle.Paragraph, max: 1024 }),
        input('inline', 'Sur la même ligne ? (oui/non)', 'non', { max: 3 }),
      );
    case 'field_remove': {
      const list = (e.fields || []).map((f, i) => `${i + 1}. ${truncate(f.name, 40)}`).join('\n') || 'Aucun champ';
      return modal.setTitle('Modifier les champs').addComponents(
        input('remove', 'N° à supprimer (ex: 2 ou 1,3 ou tout)', '', { placeholder: truncate(list.replace(/\n/g, ' | '), 100) }),
        input(
          'json',
          'Ou éditez la liste (nom | valeur | inline)',
          (e.fields || []).map((f) => `${f.name} | ${f.value.replace(/\n/g, '\\n')} | ${f.inline ? 'oui' : 'non'}`).join('\n'),
          { style: TextInputStyle.Paragraph, max: 4000 },
        ),
      );
    }
    case 'content':
      return modal.setTitle('Texte au-dessus de l\'embed').addComponents(
        input('content', 'Message', session.data.content, { style: TextInputStyle.Paragraph, max: 2000, placeholder: '@everyone Nouveau règlement !' }),
      );
    case 'json':
      return modal.setTitle('Importer du JSON').addComponents(
        input('json', 'JSON (format Discord / Discohook)', '', {
          style: TextInputStyle.Paragraph,
          required: true,
          max: 4000,
          placeholder: '{"content": "...", "embeds": [{ "title": "..." }]}',
        }),
      );
    case 'save':
      return modal.setTitle('Sauvegarder comme modèle').addComponents(
        input('name', 'Nom du modèle', session.name, { required: true, max: 50, placeholder: 'bienvenue, reglement, ticket-panel…' }),
      );
    default:
      return null;
  }
}

function applyModal(kind, session, fields) {
  const e = current(session);
  const get = (id) => fields.getTextInputValue(id).trim();
  const setOrDelete = (obj, key, value) => {
    if (value) obj[key] = value;
    else delete obj[key];
  };
  switch (kind) {
    case 'title':
      setOrDelete(e, 'title', get('title'));
      setOrDelete(e, 'url', get('url'));
      break;
    case 'description':
      setOrDelete(e, 'description', fields.getTextInputValue('description'));
      break;
    case 'color': {
      const color = parseColor(get('color'));
      if (color === undefined) return 'Couleur invalide. Exemple : `#ff0000`, `rouge`, `violet`.';
      setOrDelete(e, 'color', color);
      break;
    }
    case 'author':
      e.author = { name: get('name'), icon_url: get('icon'), url: get('url') };
      if (!e.author.name) delete e.author;
      break;
    case 'footer':
      e.footer = { text: get('text'), icon_url: get('icon') };
      if (!e.footer.text) delete e.footer;
      break;
    case 'images':
    case 'width': {
      const raw = get('width');
      const width = raw ? Math.round(Number(raw)) : null;
      if (raw && (!Number.isFinite(width) || width < 100 || width > 2000)) return 'Largeur invalide : un nombre entre 100 et 2000 (ou vide pour automatique).';
      const image = { url: kind === 'images' ? get('image') : e.image?.url };
      if (!image.url) delete image.url;
      if (width) image.width = width;
      if (Object.keys(image).length) e.image = image;
      else delete e.image;
      if (kind === 'images') {
        if (get('thumbnail')) e.thumbnail = { url: get('thumbnail') };
        else delete e.thumbnail;
      }
      break;
    }
    case 'field_add':
      e.fields = e.fields || [];
      if (e.fields.length >= 25) return 'Maximum 25 champs.';
      e.fields.push({ name: get('name'), value: fields.getTextInputValue('value'), inline: /^o|^y|^1|^true/i.test(get('inline')) });
      break;
    case 'field_remove': {
      const remove = get('remove').toLowerCase();
      if (remove) {
        if (remove === 'tout' || remove === 'all') e.fields = [];
        else {
          const idx = new Set(remove.split(/[\s,;]+/).map((n) => Number(n) - 1));
          e.fields = (e.fields || []).filter((_, i) => !idx.has(i));
        }
      } else {
        e.fields = fields
          .getTextInputValue('json')
          .split('\n')
          .map((line) => line.split('|').map((p) => p.trim()))
          .filter((p) => p[0] && p[1])
          .slice(0, 25)
          .map(([name, value, inline]) => ({ name, value: value.replace(/\\n/g, '\n'), inline: /^o|^y|^1|^true/i.test(inline || '') }));
      }
      if (!e.fields.length) delete e.fields;
      break;
    }
    case 'content':
      session.data.content = fields.getTextInputValue('content');
      break;
    case 'json': {
      let parsed;
      try {
        parsed = JSON.parse(get('json'));
      } catch {
        return 'JSON invalide.';
      }
      // Discohook : { messages: [{ data: {...} }] }
      if (parsed.messages?.[0]?.data) parsed = parsed.messages[0].data;
      if (!parsed.embeds && (parsed.title || parsed.description)) parsed = { embeds: [parsed] };
      session.data = { content: parsed.content || '', embeds: (parsed.embeds || []).slice(0, 10) };
      if (!session.data.embeds.length) session.data.embeds = [{}];
      break;
    }
    default:
      break;
  }
  return null;
}


function getSession(interaction) {
  const session = sessions.get(interaction.user.id);
  if (!session || session.guildId !== interaction.guildId) return null;
  return session;
}

async function expired(interaction) {
  return fail(interaction, 'Session expirée (le bot a peut-être redémarré). Rouvrez le menu.');
}

// ---------- Panneau /embed ----------

function canManage(member) {
  return canUse(member, 'embed', PermissionFlagsBits.ManageMessages);
}

function homeView(guild) {
  const names = Object.keys(db.guild(guild.id).embeds);
  const embed = info(
    [
      'Créez des messages personnalisés (règlement, annonces, infos…) et sauvegardez-les comme **modèles**.',
      '',
      '➕ **Nouvel embed** : ouvre l\'éditeur vide',
      '✏️ **Modifier un message** : modifie un message déjà envoyé par le bot (collez son lien)',
      '📂 **Menu ci-dessous** : modifier / envoyer un modèle sauvegardé',
      '',
      `**Modèles (${names.length}) :** ${names.map((n) => `\`${n}\``).join(' ') || '*aucun*'}`,
      '',
      '-# Les messages de bienvenue, de tickets et des menus de rôles se modifient depuis `/bienvenue`, `/ticket` et `/roles`.',
    ].join('\n'),
  ).setTitle('🎨 Embeds');
  const rows = [];
  if (names.length) {
    rows.push(
      ui.row(
        new StringSelectMenuBuilder()
          .setCustomId('emb:open')
          .setPlaceholder('📂 Ouvrir un modèle')
          .addOptions(names.slice(0, 25).map((n) => ({ label: truncate(n, 100), value: n, emoji: '💾' }))),
      ),
      ui.row(
        new StringSelectMenuBuilder()
          .setCustomId('emb:del')
          .setPlaceholder('🗑️ Supprimer un modèle')
          .addOptions(names.slice(0, 25).map((n) => ({ label: truncate(n, 100), value: n, emoji: '🗑️' }))),
      ),
    );
  }
  rows.push(
    ui.row(
      ui.button('emb:new', 'Nouvel embed', '➕', ButtonStyle.Success),
      ui.button('emb:editmsg', 'Modifier un message', '✏️', ButtonStyle.Primary),
    ),
  );
  return { content: '', embeds: [embed], components: rows };
}

registerTarget('template', {
  load: (guild, name) => db.guild(guild.id).embeds[name],
  save: (guild, name, data) => {
    db.guild(guild.id).embeds[name] = data;
    db.save(guild.id);
  },
  title: (guild, name) => `modèle \`${name}\``,
  back: (guild) => homeView(guild),
  allowSend: true,
});

const command = {
  data: new SlashCommandBuilder()
    .setName('embed')
    .setDescription('Créer et gérer des messages personnalisés (embeds)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false),

  async execute(interaction) {
    return interaction.reply({ ...homeView(interaction.guild), flags: MessageFlags.Ephemeral });
  },
};

const components = {
  async emb(interaction, args) {
    const [action, kind] = args;
    const { guild } = interaction;

    // Actions du panneau /embed
    if (['home', 'open', 'del', 'new', 'editmsg'].includes(action) || (action === 'm' && kind === 'editmsg')) {
      if (!canManage(interaction.member)) return fail(interaction, 'Accès refusé.');
      if (action === 'home') return interaction.update(homeView(guild));
      if (action === 'open') return openBuilder(interaction, 'template', interaction.values[0]);
      if (action === 'del') {
        delete db.guild(guild.id).embeds[interaction.values[0]];
        db.save(guild.id);
        return interaction.update(homeView(guild));
      }
      if (action === 'new') {
        const session = { guildId: guild.id, data: emptyData(), fromHub: true };
        sessions.set(interaction.user.id, session);
        return show(interaction, session);
      }
      if (action === 'editmsg') {
        return interaction.showModal(
          ui.modal('emb:m:editmsg', 'Modifier un message du bot', [
            { id: 'link', label: 'Lien du message', required: true, placeholder: 'Clic droit sur le message > Copier le lien du message' },
          ]),
        );
      }
      const message = await fetchMessageFromLink(guild, interaction.fields.getTextInputValue('link').trim());
      if (!message) return fail(interaction, 'Message introuvable. Vérifiez le lien.');
      if (message.author.id !== interaction.client.user.id) return fail(interaction, 'Je ne peux modifier que mes propres messages.');
      const session = {
        guildId: guild.id,
        data: { content: message.content || '', embeds: message.embeds.length ? message.embeds.map((e) => e.toJSON()) : [{}] },
        editTarget: { channelId: message.channelId, messageId: message.id },
        fromHub: true,
      };
      sessions.set(interaction.user.id, session);
      return show(interaction, session);
    }

    const session = getSession(interaction);
    if (!session) return expired(interaction);
    const def = session.target ? targets.get(session.target.kind) : null;

    if (action === 'edit') {
      const choice = interaction.values[0];
      if (choice === 'timestamp') {
        const e = current(session);
        if (e.timestamp) delete e.timestamp;
        else e.timestamp = true;
        return show(interaction, session);
      }
      return interaction.showModal(buildModal(choice, session));
    }

    if (action === 'm') {
      if (kind === 'save') {
        const name = interaction.fields.getTextInputValue('name').trim().toLowerCase().replace(/\s+/g, '-');
        db.guild(guild.id).embeds[name] = structuredClone(session.data);
        db.save(guild.id);
        session.name = name;
        await show(interaction, session);
        return ok(interaction, `Modèle \`${name}\` sauvegardé.`);
      }
      const error = applyModal(kind, session, interaction.fields);
      if (error) return fail(interaction, error);
      return show(interaction, session);
    }

    if (action === 'commit' || action === 'cancel') {
      if (!def) return expired(interaction);
      await interaction.deferUpdate();
      if (action === 'commit') await def.save(guild, session.target.id, structuredClone(session.data));
      sessions.delete(interaction.user.id);
      await interaction.editReply({ content: '', files: [], attachments: [], ...(await def.back(guild, session.target.id, interaction.member)) });
      if (action === 'commit') return ok(interaction, 'Message enregistré !');
      return;
    }

    if (action === 'send') {
      await interaction.deferUpdate();
      const channel = guild.channels.cache.get(interaction.values[0]);
      const payload = await renderMessage(session.data, memberVars(interaction.member, guild));
      if (!payload.content && !payload.embeds.length) return fail(interaction, 'Le message est vide.');
      if (!channel?.permissionsFor(interaction.client.user)?.has(['SendMessages', 'EmbedLinks'])) {
        return fail(interaction, `Je n'ai pas la permission d'écrire dans ${channel}.`);
      }
      const sent = await channel.send(payload);
      await show(interaction, session);
      return ok(interaction, `Message envoyé : ${sent.url}`);
    }

    if (action === 'apply') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const target = session.editTarget;
      const channel = await guild.channels.fetch(target.channelId).catch(() => null);
      const message = await channel?.messages.fetch(target.messageId).catch(() => null);
      if (!message) return interaction.editReply({ embeds: [failure('Le message d\'origine n\'existe plus.')] });
      const payload = await renderMessage(session.data, memberVars(interaction.member, guild));
      await message.edit({ content: payload.content || null, embeds: payload.embeds, files: payload.files, attachments: [] });
      return interaction.editReply({ embeds: [success(`Message modifié : ${message.url}`)] });
    }

    if (action === 'save') return interaction.showModal(buildModal('save', session));

    if (action === 'export') {
      const json = JSON.stringify(session.data, null, 2);
      const file = new AttachmentBuilder(Buffer.from(json), { name: `${session.name || 'embed'}.json` });
      return interaction.reply({ files: [file], flags: MessageFlags.Ephemeral });
    }

    if (action === 'vars') {
      return interaction.reply({
        embeds: [
          info(
            `${VARIABLES_HELP}${def?.help ? `\n\n**Spécifiques à ce message**\n${def.help}` : ''}\n\n**Astuces**\n• **Gros titre avec mention** : commencez la description par \`# Bienvenue {user} !\` (les mentions ne marchent pas dans le champ Titre)\n• Titres : \`# Gros\`, \`## Moyen\`, \`### Petit\`\n• Citation : \`> texte\`  • Liste : \`- élément\`  • Petit texte : \`-# texte\`\n• Emoji perso : \`<:nom:id>\` (tapez \`\\:emoji:\` sur Discord pour l'obtenir)\n• Mention de salon \`<#id>\`, de rôle \`<@&id>\`\n• Bannière : image **large** (ex. 1200×400 px). Lien : ouvrez l'image dans Discord > *Ouvrir dans le navigateur* > copiez l'adresse`,
          ).setTitle('❔ Variables & mise en forme'),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (action === 'reset') {
      session.data = emptyData();
      return show(interaction, session);
    }
  },
};

module.exports = {
  commands: [command],
  components,
  registerTarget,
  openBuilder,
  dashboard: { key: 'embed', label: 'Embeds', emoji: '🎨', canAccess: canManage, view: (interaction) => homeView(interaction.guild) },
};
