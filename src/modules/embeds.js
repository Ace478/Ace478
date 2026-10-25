// Créateur d'embeds interactif : menus + formulaires, aperçu en direct,
// modèles sauvegardés réutilisables partout (bienvenue, panels de tickets…).
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
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
const {
  parseColor,
  colorToHex,
  memberVars,
  renderTemplate,
  embedIsEmpty,
  cleanEmbed,
  ok,
  fail,
  info,
  fetchMessageFromLink,
  truncate,
} = require('../lib/utils');

const sessions = new Map(); // userId -> { guildId, data, editTarget, name }

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
].join('\n');

function emptyData() {
  return { content: '', embeds: [{ color: 0x3b82f6 }] };
}

function current(session) {
  if (!session.data.embeds?.length) session.data.embeds = [{}];
  return session.data.embeds[0];
}

function builderView(session, member) {
  const vars = memberVars(member, member.guild);
  const rendered = renderTemplate(session.data, vars);
  const embeds = rendered.embeds.length
    ? rendered.embeds
    : [info('*Embed vide — utilisez le menu ci-dessous pour ajouter un titre, une description, une image…*').toJSON()];

  const header = [`🛠️ **Éditeur d'embed**${session.name ? ` — modèle \`${session.name}\`` : ''}${session.editTarget ? ' — *modification d\'un message existant*' : ''}`];
  if (session.data.content) header.push(`**Texte au-dessus de l'embed :**\n>>> ${truncate(rendered.content, 1500)}`);

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
      { label: 'Image & miniature', value: 'images', emoji: '🖼️', description: 'Grande image / petite image à droite' },
      { label: 'Ajouter un champ', value: 'field_add', emoji: '➕', description: `${e.fields?.length || 0}/25 champs` },
      { label: 'Modifier / supprimer des champs', value: 'field_remove', emoji: '➖' },
      { label: e.timestamp ? 'Retirer l\'horodatage' : 'Ajouter l\'horodatage', value: 'timestamp', emoji: '🕒' },
      { label: 'Texte au-dessus de l\'embed', value: 'content', emoji: '💬', description: 'Message normal (mentions, @everyone…)' },
      { label: 'Importer du JSON', value: 'json', emoji: '📥', description: 'Compatible Discohook / autres bots' },
    );

  const send = new ChannelSelectMenuBuilder()
    .setCustomId('emb:send')
    .setPlaceholder('📤 Envoyer dans un salon…')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread);

  const buttons = new ActionRowBuilder();
  if (session.editTarget) {
    buttons.addComponents(new ButtonBuilder().setCustomId('emb:apply').setLabel('Appliquer au message').setEmoji('✏️').setStyle(ButtonStyle.Success));
  }
  buttons.addComponents(
    new ButtonBuilder().setCustomId('emb:save').setLabel('Sauvegarder').setEmoji('💾').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('emb:export').setLabel('JSON').setEmoji('📄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('emb:vars').setLabel('Variables').setEmoji('❔').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('emb:reset').setLabel('Vider').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
  );

  return {
    content: header.join('\n'),
    embeds,
    components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(send), buttons],
    allowedMentions: { parse: [] },
  };
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
      if (get('image')) e.image = { url: get('image') };
      else delete e.image;
      if (get('thumbnail')) e.thumbnail = { url: get('thumbnail') };
      else delete e.thumbnail;
      break;
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
  return fail(interaction, 'Session expirée (le bot a peut-être redémarré). Relancez `/embed creer`.');
}

function templateChoices(guildId, focused) {
  return Object.keys(db.guild(guildId).embeds)
    .filter((n) => n.toLowerCase().includes(focused.toLowerCase()))
    .slice(0, 25)
    .map((n) => ({ name: n, value: n }));
}

const command = {
  data: new SlashCommandBuilder()
    .setName('embed')
    .setDescription('Créer et gérer des messages personnalisés (embeds)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('creer')
        .setDescription('Ouvrir l\'éditeur d\'embed')
        .addStringOption((o) => o.setName('modele').setDescription('Partir d\'un modèle existant').setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('modifier')
        .setDescription('Modifier un message déjà envoyé par le bot')
        .addStringOption((o) => o.setName('lien').setDescription('Lien du message (clic droit > Copier le lien)').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('envoyer')
        .setDescription('Envoyer directement un modèle')
        .addStringOption((o) => o.setName('modele').setDescription('Nom du modèle').setRequired(true).setAutocomplete(true))
        .addChannelOption((o) =>
          o.setName('salon').setDescription('Salon (par défaut : ici)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((s) => s.setName('modeles').setDescription('Lister les modèles sauvegardés'))
    .addSubcommand((s) =>
      s
        .setName('supprimer')
        .setDescription('Supprimer un modèle')
        .addStringOption((o) => o.setName('modele').setDescription('Nom du modèle').setRequired(true).setAutocomplete(true)),
    ),

  async autocomplete(interaction) {
    await interaction.respond(templateChoices(interaction.guildId, interaction.options.getFocused()));
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const store = db.guild(interaction.guildId);

    if (sub === 'creer') {
      const name = interaction.options.getString('modele');
      if (name && !store.embeds[name]) return fail(interaction, `Le modèle \`${name}\` n'existe pas.`);
      const session = {
        guildId: interaction.guildId,
        data: name ? structuredClone(store.embeds[name]) : emptyData(),
        name,
      };
      sessions.set(interaction.user.id, session);
      return interaction.reply({ ...builderView(session, interaction.member), flags: MessageFlags.Ephemeral });
    }

    if (sub === 'modifier') {
      const message = await fetchMessageFromLink(interaction.guild, interaction.options.getString('lien'));
      if (!message) return fail(interaction, 'Message introuvable. Vérifiez le lien.');
      if (message.author.id !== interaction.client.user.id) return fail(interaction, 'Je ne peux modifier que mes propres messages.');
      const session = {
        guildId: interaction.guildId,
        data: { content: message.content || '', embeds: message.embeds.length ? message.embeds.map((e) => e.toJSON()) : [{}] },
        editTarget: { channelId: message.channelId, messageId: message.id },
      };
      sessions.set(interaction.user.id, session);
      return interaction.reply({ ...builderView(session, interaction.member), flags: MessageFlags.Ephemeral });
    }

    if (sub === 'envoyer') {
      const name = interaction.options.getString('modele');
      const template = store.embeds[name];
      if (!template) return fail(interaction, `Le modèle \`${name}\` n'existe pas.`);
      const channel = interaction.options.getChannel('salon') || interaction.channel;
      const payload = renderTemplate(template, memberVars(interaction.member, interaction.guild));
      if (!payload.content && !payload.embeds.length) return fail(interaction, 'Ce modèle est vide.');
      await channel.send(payload);
      return ok(interaction, `Modèle \`${name}\` envoyé dans ${channel}.`);
    }

    if (sub === 'modeles') {
      const names = Object.keys(store.embeds);
      return interaction.reply({
        embeds: [info(names.length ? names.map((n) => `• \`${n}\``).join('\n') : 'Aucun modèle. Créez-en un avec `/embed creer`.').setTitle('💾 Modèles d\'embed')],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'supprimer') {
      const name = interaction.options.getString('modele');
      if (!store.embeds[name]) return fail(interaction, `Le modèle \`${name}\` n'existe pas.`);
      delete store.embeds[name];
      db.save(interaction.guildId);
      return ok(interaction, `Modèle \`${name}\` supprimé.`);
    }
  },
};

const components = {
  async emb(interaction, args) {
    const [action, kind] = args;
    const session = getSession(interaction);
    if (!session) return expired(interaction);

    // Menu "que modifier"
    if (action === 'edit') {
      const choice = interaction.values[0];
      if (choice === 'timestamp') {
        const e = current(session);
        if (e.timestamp) delete e.timestamp;
        else e.timestamp = true;
        return interaction.update(builderView(session, interaction.member));
      }
      return interaction.showModal(buildModal(choice, session));
    }

    if (action === 'm') {
      if (kind === 'save') {
        const name = interaction.fields.getTextInputValue('name').trim().toLowerCase().replace(/\s+/g, '-');
        const store = db.guild(interaction.guildId);
        const data = structuredClone(session.data);
        data.embeds = (data.embeds || []).filter((e) => !embedIsEmpty(cleanEmbed({ ...e, timestamp: undefined })));
        store.embeds[name] = data;
        db.save(interaction.guildId);
        session.name = name;
        await interaction.update(builderView(session, interaction.member));
        return ok(interaction, `Modèle \`${name}\` sauvegardé. Utilisable avec \`/embed envoyer\`, les messages de bienvenue, les panels de tickets…`);
      }
      const error = applyModal(kind, session, interaction.fields);
      if (error) return fail(interaction, error);
      return interaction.update(builderView(session, interaction.member));
    }

    if (action === 'send') {
      const channel = interaction.guild.channels.cache.get(interaction.values[0]);
      const payload = renderTemplate(session.data, memberVars(interaction.member, interaction.guild));
      if (!payload.content && !payload.embeds.length) return fail(interaction, 'Le message est vide.');
      if (!channel?.permissionsFor(interaction.client.user)?.has(['SendMessages', 'EmbedLinks'])) {
        return fail(interaction, `Je n'ai pas la permission d'écrire dans ${channel}.`);
      }
      const sent = await channel.send(payload);
      await interaction.update(builderView(session, interaction.member));
      return ok(interaction, `Message envoyé : ${sent.url}`);
    }

    if (action === 'apply') {
      const target = session.editTarget;
      const channel = await interaction.guild.channels.fetch(target.channelId).catch(() => null);
      const message = await channel?.messages.fetch(target.messageId).catch(() => null);
      if (!message) return fail(interaction, 'Le message d\'origine n\'existe plus.');
      const payload = renderTemplate(session.data, memberVars(interaction.member, interaction.guild));
      await message.edit({ content: payload.content || null, embeds: payload.embeds });
      return ok(interaction, `Message modifié : ${message.url}`);
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
            `${VARIABLES_HELP}\n\n**Astuces**\n• Titres dans la description : \`# Gros\`, \`## Moyen\`, \`### Petit\`\n• Citation : \`> texte\`  • Liste : \`- élément\`\n• Emoji perso : \`<:nom:id>\` (tapez \`\\:emoji:\` sur Discord pour l'obtenir)\n• Mention de salon \`<#id>\`, de rôle \`<@&id>\``,
          ).setTitle('❔ Variables & mise en forme'),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (action === 'reset') {
      session.data = emptyData();
      return interaction.update(builderView(session, interaction.member));
    }
  },
};

module.exports = { commands: [command], components };
