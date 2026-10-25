// Envoi des logs serveur dans le salon configuré pour chaque type.
const db = require('./db');

const LOG_TYPES = {
  moderation: 'Modération (ban, kick, mute, warn, clear)',
  messages: 'Messages (supprimés, modifiés, suppressions en masse)',
  members: 'Membres (arrivées + invitation, départs, rôles, pseudos, boosts)',
  voice: 'Vocal (connexions, temps passé, déplacements, stream, caméra)',
  tickets: 'Tickets (ouvertures, fermetures, transcripts)',
  server: 'Serveur (salons, rôles, permissions, emojis, invitations)',
};

async function sendLog(guild, type, payload) {
  const channelId = db.guild(guild.id).logs[type];
  if (!channelId) return null;
  const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel?.isTextBased()) return null;
  const data = payload?.data || payload?.toJSON ? { embeds: [payload] } : payload;
  return channel.send({ allowedMentions: { parse: [] }, ...data }).catch((err) => {
    console.error(`[logs] Envoi impossible (${type}):`, err.message);
    return null;
  });
}

module.exports = { sendLog, LOG_TYPES };
