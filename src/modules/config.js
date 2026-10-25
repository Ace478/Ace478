// /config : menu principal qui donne accès à tous les panneaux de configuration.
const { SlashCommandBuilder, MessageFlags, StringSelectMenuBuilder } = require('discord.js');
const ui = require('../lib/ui');
const { fail, info } = require('../lib/utils');

// Panneaux déclarés par les modules (chargés à la demande : évite un require circulaire).
function dashboards(member) {
  return require('./index')
    .map((m) => m.dashboard)
    .filter((d) => d && d.canAccess(member));
}

function hubView(member) {
  const list = dashboards(member);
  const embed = info(
    [
      `Bienvenue dans la configuration de **${member.client.user.username}** !`,
      'Choisissez ce que vous voulez configurer dans le menu ci-dessous.',
      '',
      ...list.map((d) => `${d.emoji} **${d.label}** — \`/${d.key}\``),
      '',
      '-# Chaque panneau est aussi accessible directement avec sa commande.',
    ].join('\n'),
  )
    .setTitle('⚙️ Configuration du bot')
    .setThumbnail(member.client.user.displayAvatarURL());
  return {
    embeds: [embed],
    components: [
      ui.row(
        new StringSelectMenuBuilder()
          .setCustomId('cfg:open')
          .setPlaceholder('⚙️ Que voulez-vous configurer ?')
          .addOptions(list.map((d) => ({ label: d.label, value: d.key, emoji: d.emoji }))),
      ),
    ],
  };
}

const command = {
  data: new SlashCommandBuilder().setName('config').setDescription('Menu principal de configuration du bot').setDMPermission(false),

  async execute(interaction) {
    if (!dashboards(interaction.member).length) return fail(interaction, 'Vous n\'avez accès à aucune configuration.');
    return interaction.reply({ ...hubView(interaction.member), flags: MessageFlags.Ephemeral });
  },
};

const components = {
  async cfg(interaction, [action]) {
    if (action === 'home') return interaction.update(hubView(interaction.member));
    const dash = dashboards(interaction.member).find((d) => d.key === interaction.values[0]);
    if (!dash) return fail(interaction, 'Accès refusé.');
    return interaction.update(await dash.view(interaction));
  },
};

module.exports = { commands: [command], components };
