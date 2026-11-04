// Prépare les messages avant envoi : redimensionne la bannière des embeds à la
// largeur choisie (📏 Largeur dans l'éditeur). Sur Discord, c'est la taille de
// l'image qui fixe la largeur de l'embed : une bannière large = un embed large.
const zlib = require('node:zlib');
const { ComponentType, MessageFlags } = require('discord.js');
const { deepVars, renderTemplate, isUrl, fullSizeImage } = require('./utils');

let sharp = null;
try {
  sharp = require('sharp');
} catch {
  console.warn('[media] Module "sharp" absent : la largeur des bannières ne pourra pas être modifiée (npm install sharp).');
}

const MAX_BYTES = 15 * 1024 * 1024;
const cache = new Map(); // "url|largeur" -> { buffer, ext }

function remember(key, value) {
  cache.set(key, value);
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  return value;
}

// Image PNG transparente de width × 1 px : élargit l'embed quand il n'y a pas de bannière.
function spacer(width) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8; // 8 bits
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(1 + width * 4); // filtre 0 + pixels transparents
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function resized(url, width) {
  const key = `${url}|${width}`;
  if (cache.has(key)) return cache.get(key);
  const res = await fetch(fullSizeImage(url), { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const input = Buffer.from(await res.arrayBuffer());
  if (input.length > MAX_BYTES) throw new Error('image trop lourde');
  const image = sharp(input, { animated: true });
  const { format } = await image.metadata();
  const resize = image.resize({ width, withoutEnlargement: false });
  const out = format === 'gif' ? { buffer: await resize.gif().toBuffer(), ext: 'gif' } : { buffer: await resize.png().toBuffer(), ext: 'png' };
  return remember(key, out);
}

/**
 * Comme renderTemplate, mais applique la largeur choisie (embed.image.width) :
 * renvoie { content, embeds, files } prêt à être envoyé.
 */
async function renderMessage(template, vars) {
  const data = deepVars(structuredClone(template || {}), vars);
  const files = [];
  for (const [i, embed] of (data.embeds || []).entries()) {
    const width = Math.round(Number(embed?.image?.width));
    if (!width || width < 50) continue;
    const target = Math.min(width, 2000);
    const url = embed.image.url;
    try {
      let file;
      if (isUrl(url)) {
        if (!sharp) continue;
        file = await resized(url, target);
      } else {
        file = { buffer: spacer(target), ext: 'png' };
      }
      const name = `banniere-${i + 1}.${file.ext}`;
      files.push({ attachment: file.buffer, name });
      embed.image = { url: `attachment://${name}` };
    } catch (err) {
      console.error(`[media] Bannière non redimensionnée (${url}) :`, err.message);
    }
  }
  return { ...renderTemplate(data, null), files };
}

/**
 * Même message, mais affiché en « carte » (Components V2) comme les gros bots :
 * la carte prend toute la largeur, la bannière s'étire en entier, l'avatar est
 * à droite du texte et les mentions marchent aussi dans les # gros titres.
 * Se configure avec l'éditeur d'embed classique (texte, couleur, images, pied de page…).
 */
async function renderCard(template, vars) {
  const data = structuredClone(template || {});
  // La largeur forcée ne sert à rien ici : la carte est toujours large.
  for (const embed of data.embeds || []) if (embed?.image?.width) delete embed.image.width;
  const { content, embeds, files } = await renderMessage(data, vars);
  const components = [];
  if (content) components.push({ type: ComponentType.TextDisplay, content });

  for (const e of embeds) {
    const text = [];
    if (e.author?.name) text.push(`-# ${e.author.name}`);
    if (e.title) text.push(`## ${e.url ? `[${e.title}](${e.url})` : e.title}`);
    if (e.description) text.push(e.description);
    for (const f of e.fields || []) text.push(`**${f.name}**\n${f.value}`);
    const body = text.join('\n').slice(0, 3800) || '​';

    const inner = [];
    if (e.thumbnail?.url) {
      inner.push({
        type: ComponentType.Section,
        components: [{ type: ComponentType.TextDisplay, content: body }],
        accessory: { type: ComponentType.Thumbnail, media: { url: e.thumbnail.url } },
      });
    } else {
      inner.push({ type: ComponentType.TextDisplay, content: body });
    }
    if (e.image?.url) inner.push({ type: ComponentType.MediaGallery, items: [{ media: { url: e.image.url } }] });
    const foot = [e.footer?.text, e.timestamp ? `<t:${Math.floor(Date.parse(e.timestamp) / 1000)}:f>` : null].filter(Boolean).join(' • ');
    if (foot) inner.push({ type: ComponentType.TextDisplay, content: `-# ${foot}` });

    const container = { type: ComponentType.Container, components: inner };
    if (typeof e.color === 'number') container.accent_color = e.color;
    components.push(container);
  }

  if (!components.length) components.push({ type: ComponentType.TextDisplay, content: '​' });
  return { components, files, flags: MessageFlags.IsComponentsV2 };
}

module.exports = { renderMessage, renderCard, hasSharp: () => !!sharp };
