// Stockage simple en fichiers JSON (un fichier par serveur dans data/guilds).
// Aucune dépendance native : fonctionne partout (VPS, Pterodactyl, Replit…).
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const GUILD_DIR = path.join(DATA_DIR, 'guilds');
fs.mkdirSync(GUILD_DIR, { recursive: true });

function defaults() {
  return {
    tickets: {
      config: {
        requestChannelId: null, // salon où arrivent les demandes à valider
        parentId: null, // catégorie Discord où créer les tickets
        staffRoleIds: [],
        maxOpen: 1,
        nameFormat: 'ticket-{numero}',
        dmTranscript: true,
        pingStaff: true,
        userCanClose: true,
        placeholder: null,
        panelTemplate: null,
        autoCloseHours: 0,
      },
      categories: [],
      counter: 0,
      records: {},
    },
    embeds: {},
    welcome: { enabled: false, channelId: null, content: '{user}', template: null, dm: false },
    leave: { enabled: false, channelId: null, content: '', template: null },
    autoRoles: [],
    logs: { moderation: null, messages: null, members: null, voice: null, tickets: null, server: null },
    warns: {},
    modCases: 0,
    roleMenus: {},
    suggestions: { channelId: null, counter: 0 },
    whitelist: { owners: [], users: [], roles: [], commands: [], strict: false },
  };
}

// Fusionne les valeurs par défaut sans écraser ce qui existe.
function merge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (!(key in target)) target[key] = value;
    else if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') {
      merge(target[key], value);
    }
  }
  return target;
}

const cache = new Map();
const timers = new Map();

function file(guildId) {
  return path.join(GUILD_DIR, `${guildId}.json`);
}

function guild(guildId) {
  if (cache.has(guildId)) return cache.get(guildId);
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file(guildId), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[db] Lecture impossible pour ${guildId}:`, err);
  }
  merge(data, defaults());
  cache.set(guildId, data);
  return data;
}

function writeNow(guildId) {
  timers.delete(guildId);
  const data = cache.get(guildId);
  if (!data) return;
  const target = file(guildId);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
}

// Sauvegarde différée (regroupe les écritures rapprochées).
function save(guildId) {
  if (timers.has(guildId)) return;
  timers.set(guildId, setTimeout(() => writeNow(guildId), 500));
}

function flush() {
  for (const [guildId, timer] of timers) {
    clearTimeout(timer);
    writeNow(guildId);
  }
}

module.exports = { guild, save, flush, DATA_DIR };
