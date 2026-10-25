// Briques communes des panneaux de configuration (menus, boutons, formulaires).
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const row = (...components) => new ActionRowBuilder().addComponents(...components);

function button(customId, label, emoji, style = ButtonStyle.Secondary) {
  const b = new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  return b;
}

function backButton(customId, label = 'Retour') {
  return button(customId, label, '↩️');
}

function toggleButton(customId, label, value) {
  return button(customId, label, value ? '✅' : '✖️', value ? ButtonStyle.Success : ButtonStyle.Secondary);
}

function channelSelect(customId, placeholder, types, current, { min = 0, max = 1 } = {}) {
  const menu = new ChannelSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setChannelTypes(...types).setMinValues(min).setMaxValues(max);
  const ids = [].concat(current || []).filter(Boolean);
  if (ids.length) menu.setDefaultChannels(...ids.slice(0, max));
  return row(menu);
}

function roleSelect(customId, placeholder, current, { min = 0, max = 10 } = {}) {
  const menu = new RoleSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMinValues(min).setMaxValues(max);
  const ids = [].concat(current || []).filter(Boolean);
  if (ids.length) menu.setDefaultRoles(...ids.slice(0, max));
  return row(menu);
}

function userSelect(customId, placeholder, current, { min = 0, max = 10, disabled = false } = {}) {
  const menu = new UserSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMinValues(min).setMaxValues(max).setDisabled(disabled);
  const ids = [].concat(current || []).filter(Boolean);
  if (ids.length) menu.setDefaultUsers(...ids.slice(0, max));
  return row(menu);
}

// inputs : [{ id, label, value, style: 'short' | 'long', required, max, placeholder }]
function modal(customId, title, inputs) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title.slice(0, 45))
    .addComponents(
      inputs.map(({ id, label, value, style, required = false, max, placeholder }) => {
        const field = new TextInputBuilder()
          .setCustomId(id)
          .setLabel(label.slice(0, 45))
          .setStyle(style === 'long' ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(required);
        if (max) field.setMaxLength(max);
        if (value !== undefined && value !== null && value !== '') field.setValue(String(value).slice(0, max || 4000));
        if (placeholder) field.setPlaceholder(placeholder.slice(0, 100));
        return row(field);
      }),
    );
}

module.exports = { row, button, backButton, toggleButton, channelSelect, roleSelect, userSelect, modal, ButtonStyle };
