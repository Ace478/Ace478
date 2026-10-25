// Commandes utilitaires : aide, infos, sondages, suggestions, annonces rapides.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const db = require('../lib/db');
const { baseEmbed, ok, fail, info, ts } = require('../lib/utils');

const HELP = [
  ['🎫 Tickets', '`/ticket-config` panneau de configuration\n`/ticket panel` envoyer le panel\n`/ticket fermer · ajouter · retirer · renommer · pause · transcript`\n`/ticket historique · stats`'],
  ['🎨 Embeds', '`/embed creer` éditeur visuel\n`/embed modifier` modifier un message du bot\n`/embed envoyer · modeles · supprimer`'],
  ['👋 Accueil', '`/accueil bienvenue · depart` messages\n`/accueil autorole` rôles à l\'arrivée\n`/accueil test · voir`'],
  ['🛡️ Modération', '`/ban` `/unban` `/kick` `/mute` `/unmute`\n`/warn` `/avertissements`\n`/clear` `/verrouiller` `/slowmode`'],
  ['📜 Logs', '`/logs salon` choisir les salons\n`/logs voir`'],
  ['🎭 Rôles', '`/roles creer · ajouter · retirer`'],
  ['👑 Accès', '`/owner ajouter · retirer · liste`\n`/wl ajouter · retirer` membres/rôles\n`/wl autoriser · interdire` commandes\n`/wl mode · liste`'],
  ['🧰 Utilitaires', '`/sondage` `/suggestion` `/dire`\n`/userinfo` `/serverinfo` `/avatar` `/ping`'],
];

const commands = [
  {
    data: new SlashCommandBuilder().setName('aide').setDescription('Liste des commandes du bot'),
    async execute(interaction) {
      const embed = baseEmbed()
        .setTitle(`📖 Aide — ${interaction.client.user.username}`)
        .setThumbnail(interaction.client.user.displayAvatarURL())
        .addFields(HELP.map(([name, value]) => ({ name, value, inline: true })))
        .setFooter({ text: 'Astuce : dans les textes, utilisez {user}, {server}, {server.members}… (bouton Variables de /embed creer)' });
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
  },
  {
    data: new SlashCommandBuilder().setName('ping').setDescription('Latence du bot'),
    async execute(interaction) {
      return interaction.reply({ embeds: [info(`🏓 Pong ! Latence API : **${interaction.client.ws.ping} ms**`)], flags: MessageFlags.Ephemeral });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('userinfo')
      .setDescription('Informations sur un membre')
      .setDMPermission(false)
      .addUserOption((o) => o.setName('membre').setDescription('Membre')),
    async execute(interaction) {
      const user = interaction.options.getUser('membre') || interaction.user;
      const member = interaction.options.getMember('membre') || (user.id === interaction.user.id ? interaction.member : null);
      const warns = db.guild(interaction.guildId).warns[user.id]?.length || 0;
      const embed = baseEmbed(member?.displayColor || undefined)
        .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL() })
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'ID', value: user.id, inline: true },
          { name: 'Compte créé', value: ts(user.createdTimestamp, 'R'), inline: true },
          { name: 'Arrivé', value: member?.joinedTimestamp ? ts(member.joinedTimestamp, 'R') : '—', inline: true },
          { name: 'Avertissements', value: String(warns), inline: true },
        );
      const roles = member?.roles.cache.filter((r) => r.id !== interaction.guildId).sort((a, b) => b.position - a.position);
      if (roles?.size) embed.addFields({ name: `Rôles (${roles.size})`, value: roles.map((r) => `${r}`).slice(0, 30).join(' ') });
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
  },
  {
    data: new SlashCommandBuilder().setName('serverinfo').setDescription('Informations sur le serveur').setDMPermission(false),
    async execute(interaction) {
      const g = interaction.guild;
      const embed = baseEmbed()
        .setTitle(g.name)
        .setThumbnail(g.iconURL({ size: 256 }))
        .addFields(
          { name: 'Propriétaire', value: `<@${g.ownerId}>`, inline: true },
          { name: 'Membres', value: String(g.memberCount), inline: true },
          { name: 'Créé', value: ts(g.createdTimestamp, 'R'), inline: true },
          { name: 'Salons', value: String(g.channels.cache.size), inline: true },
          { name: 'Rôles', value: String(g.roles.cache.size), inline: true },
          { name: 'Boosts', value: `${g.premiumSubscriptionCount || 0} (niveau ${g.premiumTier})`, inline: true },
        );
      if (g.bannerURL()) embed.setImage(g.bannerURL({ size: 1024 }));
      return interaction.reply({ embeds: [embed] });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('avatar')
      .setDescription('Afficher l\'avatar d\'un membre')
      .addUserOption((o) => o.setName('membre').setDescription('Membre')),
    async execute(interaction) {
      const user = interaction.options.getUser('membre') || interaction.user;
      return interaction.reply({ embeds: [baseEmbed().setTitle(`Avatar de ${user.username}`).setImage(user.displayAvatarURL({ size: 1024 }))] });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('dire')
      .setDescription('Faire parler le bot')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .setDMPermission(false)
      .addStringOption((o) => o.setName('texte').setDescription('Texte (\\n = retour à la ligne)').setRequired(true).setMaxLength(2000))
      .addChannelOption((o) => o.setName('salon').setDescription('Salon (défaut : ici)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    async execute(interaction) {
      const channel = interaction.options.getChannel('salon') || interaction.channel;
      await channel.send({ content: interaction.options.getString('texte').replace(/\\n/g, '\n') });
      return ok(interaction, `Message envoyé dans ${channel}.`);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('sondage')
      .setDescription('Créer un sondage')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .setDMPermission(false)
      .addStringOption((o) => o.setName('question').setDescription('Question').setRequired(true).setMaxLength(256))
      .addStringOption((o) => o.setName('choix').setDescription('Choix séparés par | (ex: Oui | Non | Peut-être). Vide = Oui/Non'))
      .addBooleanOption((o) => o.setName('mention').setDescription('Mentionner @everyone')),
    async execute(interaction) {
      const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
      const raw = interaction.options.getString('choix');
      const choices = raw ? raw.split('|').map((c) => c.trim()).filter(Boolean).slice(0, 10) : [];
      const emojis = choices.length ? NUM.slice(0, choices.length) : ['✅', '❌'];
      const embed = baseEmbed()
        .setAuthor({ name: `Sondage de ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
        .setTitle(`📊 ${interaction.options.getString('question')}`)
        .setDescription(choices.length ? choices.map((c, i) => `${emojis[i]} ${c}`).join('\n\n') : 'Votez avec ✅ ou ❌')
        .setTimestamp();
      const mention = interaction.options.getBoolean('mention');
      await interaction.reply({ content: mention ? '@everyone' : undefined, embeds: [embed], allowedMentions: { parse: mention ? ['everyone'] : [] } });
      const msg = await interaction.fetchReply();
      for (const e of emojis) await msg.react(e).catch(() => null);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('suggestion')
      .setDescription('Proposer une suggestion')
      .setDMPermission(false)
      .addStringOption((o) => o.setName('texte').setDescription('Votre suggestion').setRequired(true).setMaxLength(2000)),
    async execute(interaction) {
      const data = db.guild(interaction.guildId);
      const channel = data.suggestions.channelId && interaction.guild.channels.cache.get(data.suggestions.channelId);
      if (!channel) return fail(interaction, 'Les suggestions ne sont pas configurées (`/suggestions-config`).');
      data.suggestions.counter += 1;
      db.save(interaction.guildId);
      const msg = await channel.send({
        embeds: [
          baseEmbed()
            .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
            .setTitle(`💡 Suggestion #${data.suggestions.counter}`)
            .setDescription(interaction.options.getString('texte'))
            .setTimestamp(),
        ],
      });
      await msg.react('👍').catch(() => null);
      await msg.react('👎').catch(() => null);
      await msg.startThread({ name: `Suggestion #${data.suggestions.counter}` }).catch(() => null);
      return ok(interaction, `Suggestion envoyée dans ${channel} !`);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('suggestions-config')
      .setDescription('Définir le salon des suggestions')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .addChannelOption((o) => o.setName('salon').setDescription('Salon (vide = désactiver)').addChannelTypes(ChannelType.GuildText)),
    async execute(interaction) {
      const channel = interaction.options.getChannel('salon');
      db.guild(interaction.guildId).suggestions.channelId = channel?.id || null;
      db.save(interaction.guildId);
      return ok(interaction, channel ? `Les suggestions arriveront dans ${channel}.` : 'Suggestions désactivées.');
    },
  },
];

module.exports = { commands };
