// Gestion des accès : propriétaires, WL owner, WL normale et permissions Discord.
const { PermissionFlagsBits } = require('discord.js');
const db = require('./db');

function botOwners() {
  return (process.env.BOT_OWNERS || '').split(/[\s,]+/).filter(Boolean);
}

// Propriétaire du serveur ou propriétaire du bot (BOT_OWNERS dans .env).
function isTrueOwner(member) {
  return member.id === member.guild.ownerId || botOwners().includes(member.id);
}

// Propriétaire ou membre de la WL owner : accès total au bot.
function isOwner(member) {
  return isTrueOwner(member) || db.guild(member.guild.id).whitelist.owners.includes(member.id);
}

function inWhitelist(member) {
  const wl = db.guild(member.guild.id).whitelist;
  return wl.users.includes(member.id) || wl.roles.some((id) => member.roles.cache.has(id));
}

// requiredPerm : permission Discord normalement nécessaire (bigint), ou null si commande publique.
function canUse(member, commandName, requiredPerm) {
  if (isOwner(member)) return true;
  const wl = db.guild(member.guild.id).whitelist;
  if (wl.commands.includes(commandName) && inWhitelist(member)) return true;
  if (!requiredPerm) return true;
  if (wl.strict) return false; // mode strict : seules la WL et les owners passent
  return member.permissions.has(requiredPerm);
}

function isAdmin(member) {
  return isOwner(member) || (!db.guild(member.guild.id).whitelist.strict && member.permissions.has(PermissionFlagsBits.ManageGuild));
}

module.exports = { isTrueOwner, isOwner, inWhitelist, canUse, isAdmin, botOwners };
