const { EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');

const COLORS = {
  bleu: 0x3b82f6,
  blue: 0x3b82f6,
  rouge: 0xef4444,
  red: 0xef4444,
  vert: 0x22c55e,
  green: 0x22c55e,
  jaune: 0xeab308,
  yellow: 0xeab308,
  orange: 0xf97316,
  violet: 0x8b5cf6,
  purple: 0x8b5cf6,
  rose: 0xec4899,
  pink: 0xec4899,
  noir: 0x111111,
  black: 0x111111,
  blanc: 0xffffff,
  white: 0xffffff,
  gris: 0x6b7280,
  grey: 0x6b7280,
  blurple: 0x5865f2,
  discord: 0x5865f2,
};

const BRAND = 0x3b82f6;

function parseColor(input) {
  if (input === null || input === undefined || input === '') return null;
  const value = String(input).trim().toLowerCase();
  if (COLORS[value] !== undefined) return COLORS[value];
  const hex = value.replace(/^#|^0x/, '');
  if (/^[0-9a-f]{6}$/.test(hex)) return parseInt(hex, 16);
  if (/^[0-9a-f]{3}$/.test(hex)) return parseInt(hex.split('').map((c) => c + c).join(''), 16);
  return undefined; // invalide
}

function colorToHex(color) {
  if (color === null || color === undefined) return '';
  return `#${Number(color).toString(16).padStart(6, '0')}`;
}

// Variables utilisables dans tous les textes (embeds, bienvenue, tickets…).
function memberVars(member, guild, extra = {}) {
  const user = member?.user ?? member;
  const g = guild ?? member?.guild;
  const vars = {};
  if (user) {
    vars.user = `<@${user.id}>`;
    vars['user.mention'] = `<@${user.id}>`;
    vars['user.name'] = user.username;
    vars['user.displayname'] = member?.displayName ?? user.globalName ?? user.username;
    vars['user.id'] = user.id;
    vars['user.avatar'] = user.displayAvatarURL?.({ size: 512 }) ?? '';
    vars['user.created'] = `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`;
  }
  if (g) {
    vars.server = g.name;
    vars['server.name'] = g.name;
    vars['server.id'] = g.id;
    vars['server.icon'] = g.iconURL?.({ size: 512 }) ?? '';
    vars['server.members'] = String(g.memberCount);
    vars.membercount = String(g.memberCount);
  }
  return { ...vars, ...extra };
}

function applyVars(text, vars) {
  if (typeof text !== 'string' || !vars) return text;
  return text.replace(/\{([a-z0-9_.]+)\}/gi, (match, key) => {
    const value = vars[key.toLowerCase()];
    return value === undefined ? match : value;
  });
}

function deepVars(value, vars) {
  if (typeof value === 'string') return applyVars(value, vars);
  if (Array.isArray(value)) return value.map((v) => deepVars(v, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepVars(v, vars);
    return out;
  }
  return value;
}

function isUrl(value) {
  return typeof value === 'string' && /^https?:\/\/\S+$/i.test(value.trim());
}

// Nettoie un embed (format JSON Discord) pour qu'il soit accepté par l'API.
function cleanEmbed(raw) {
  const e = JSON.parse(JSON.stringify(raw || {}));
  const out = {};
  if (e.title) out.title = String(e.title).slice(0, 256);
  if (e.url && isUrl(e.url)) out.url = e.url;
  if (e.description) out.description = String(e.description).slice(0, 4096);
  if (typeof e.color === 'number') out.color = e.color;
  else if (typeof e.color === 'string' && parseColor(e.color) != null) out.color = parseColor(e.color);
  if (e.author?.name) {
    out.author = { name: String(e.author.name).slice(0, 256) };
    if (isUrl(e.author.icon_url)) out.author.icon_url = e.author.icon_url;
    if (isUrl(e.author.url)) out.author.url = e.author.url;
  }
  if (e.footer?.text) {
    out.footer = { text: String(e.footer.text).slice(0, 2048) };
    if (isUrl(e.footer.icon_url)) out.footer.icon_url = e.footer.icon_url;
  }
  if (isUrl(e.image?.url)) out.image = { url: e.image.url };
  if (isUrl(e.thumbnail?.url)) out.thumbnail = { url: e.thumbnail.url };
  if (Array.isArray(e.fields)) {
    out.fields = e.fields
      .filter((f) => f && f.name && f.value)
      .slice(0, 25)
      .map((f) => ({ name: String(f.name).slice(0, 256), value: String(f.value).slice(0, 1024), inline: !!f.inline }));
    if (!out.fields.length) delete out.fields;
  }
  if (e.timestamp === true) out.timestamp = new Date().toISOString();
  else if (typeof e.timestamp === 'string' && !Number.isNaN(Date.parse(e.timestamp))) out.timestamp = new Date(e.timestamp).toISOString();
  return out;
}

function embedIsEmpty(e) {
  return !e.title && !e.description && !e.author && !e.footer && !e.image && !e.thumbnail && !e.fields;
}

// Transforme un modèle { content, embeds } en options de message prêtes à envoyer.
function renderTemplate(template, vars) {
  const data = deepVars(template || {}, vars);
  const embeds = (data.embeds || [])
    .map(cleanEmbed)
    .filter((e) => !embedIsEmpty(e))
    .slice(0, 10);
  const content = data.content ? String(data.content).slice(0, 2000) : undefined;
  return { content, embeds };
}

function baseEmbed(color = BRAND) {
  return new EmbedBuilder().setColor(color);
}

function success(text) {
  return baseEmbed(0x22c55e).setDescription(`✅ ${text}`);
}

function failure(text) {
  return baseEmbed(0xef4444).setDescription(`❌ ${text}`);
}

function info(text) {
  return baseEmbed(BRAND).setDescription(text);
}

async function replyEphemeral(interaction, payload) {
  const data = typeof payload === 'string' ? { content: payload } : payload;
  data.flags = MessageFlags.Ephemeral;
  if (interaction.deferred || interaction.replied) return interaction.followUp(data);
  return interaction.reply(data);
}

const ok = (interaction, text) => replyEphemeral(interaction, { embeds: [success(text)] });
const fail = (interaction, text) => replyEphemeral(interaction, { embeds: [failure(text)] });

// https://discord.com/channels/<guild>/<channel>/<message>
function parseMessageLink(link) {
  const m = String(link).match(/channels\/(\d+|@me)\/(\d+)\/(\d+)/);
  if (!m) return null;
  return { guildId: m[1], channelId: m[2], messageId: m[3] };
}

async function fetchMessageFromLink(guild, link) {
  const parsed = parseMessageLink(link);
  if (!parsed || parsed.guildId !== guild.id) return null;
  const channel = await guild.channels.fetch(parsed.channelId).catch(() => null);
  if (!channel?.isTextBased()) return null;
  return channel.messages.fetch(parsed.messageId).catch(() => null);
}

function isAdmin(member) {
  return member.permissions.has(PermissionFlagsBits.ManageGuild);
}

function parseDuration(input) {
  const m = String(input).trim().toLowerCase().match(/^(\d+)\s*(s|sec|m|min|h|j|d|w|sem)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] || 'm';
  const mult = { s: 1, sec: 1, m: 60, min: 60, h: 3600, j: 86400, d: 86400, w: 604800, sem: 604800 }[unit];
  return n * mult * 1000;
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  const parts = [];
  const units = [
    ['j', 86400],
    ['h', 3600],
    ['min', 60],
    ['s', 1],
  ];
  let rest = s;
  for (const [label, size] of units) {
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)}${label}`);
      rest %= size;
    }
  }
  return parts.join(' ') || '0s';
}

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Emoji Unicode (📩) ou personnalisé (<:nom:id>) ; du texte simple serait refusé par Discord.
function isValidEmoji(text) {
  const value = String(text).trim();
  return /^<a?:\w+:\d+>$/.test(value) || (!/^[\x00-\x7F]*$/.test(value) && value.length <= 16);
}
const EMOJI_ERROR = 'Emoji invalide : utilisez un emoji Discord (📩) ou personnalisé (`<:nom:id>`).';

const ts = (date, style = 'f') => `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;

module.exports = {
  BRAND,
  parseColor,
  colorToHex,
  memberVars,
  applyVars,
  renderTemplate,
  cleanEmbed,
  embedIsEmpty,
  isUrl,
  baseEmbed,
  success,
  failure,
  info,
  replyEphemeral,
  ok,
  fail,
  parseMessageLink,
  fetchMessageFromLink,
  isAdmin,
  parseDuration,
  formatDuration,
  truncate,
  isValidEmoji,
  EMOJI_ERROR,
  ts,
};
