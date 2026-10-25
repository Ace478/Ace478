// Génère un transcript HTML autonome d'un salon (lisible dans n'importe quel navigateur).
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

async function fetchAllMessages(channel, limit = 5000) {
  const all = [];
  let before;
  while (all.length < limit) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return all.reverse();
}

function formatContent(text, guild) {
  let html = esc(text);
  html = html.replace(/(https?:\/\/(?:[^\s<&]|&amp;)+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/&lt;@!?(\d+)&gt;/g, (_, id) => {
    const m = guild.members.cache.get(id);
    return `<span class="mention">@${esc(m?.displayName ?? id)}</span>`;
  });
  html = html.replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) => `<span class="mention">@${esc(guild.roles.cache.get(id)?.name ?? id)}</span>`);
  html = html.replace(/&lt;#(\d+)&gt;/g, (_, id) => `<span class="mention">#${esc(guild.channels.cache.get(id)?.name ?? id)}</span>`);
  html = html.replace(/&lt;a?:(\w+):(\d+)&gt;/g, (_, name, id) => `<img class="emoji" alt=":${name}:" src="https://cdn.discordapp.com/emojis/${id}.webp?size=32">`);
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  return html.replace(/\n/g, '<br>');
}

function renderEmbed(embed, guild) {
  const color = embed.hexColor || '#3b82f6';
  const parts = [];
  if (embed.author?.name) parts.push(`<div class="e-author">${esc(embed.author.name)}</div>`);
  if (embed.title) parts.push(`<div class="e-title">${esc(embed.title)}</div>`);
  if (embed.description) parts.push(`<div class="e-desc">${formatContent(embed.description, guild)}</div>`);
  for (const f of embed.fields || []) {
    parts.push(`<div class="e-field"><div class="e-fname">${esc(f.name)}</div><div>${formatContent(f.value, guild)}</div></div>`);
  }
  if (embed.image?.url) parts.push(`<img class="e-img" src="${esc(embed.image.url)}">`);
  if (embed.footer?.text) parts.push(`<div class="e-footer">${esc(embed.footer.text)}</div>`);
  return `<div class="embed" style="border-color:${esc(color)}">${parts.join('')}</div>`;
}

async function createTranscript(channel, { title, meta = [] } = {}) {
  const messages = await fetchAllMessages(channel);
  const guild = channel.guild;
  const rows = messages.map((m) => {
    const attachments = [...m.attachments.values()]
      .map((a) =>
        a.contentType?.startsWith('image/')
          ? `<a href="${esc(a.url)}" target="_blank"><img class="att" src="${esc(a.url)}"></a>`
          : `<a class="file" href="${esc(a.url)}" target="_blank">📎 ${esc(a.name)}</a>`,
      )
      .join('');
    const embeds = m.embeds.map((e) => renderEmbed(e, guild)).join('');
    const bot = m.author.bot ? '<span class="bot">BOT</span>' : '';
    const name = m.member?.displayName ?? m.author.globalName ?? m.author.username;
    const color = m.member?.displayHexColor && m.member.displayHexColor !== '#000000' ? m.member.displayHexColor : '#f2f3f5';
    return `<div class="msg">
<img class="avatar" src="${esc(m.author.displayAvatarURL({ size: 64 }))}">
<div class="body"><div class="head"><span class="name" style="color:${esc(color)}">${esc(name)}</span>${bot}<span class="time">${esc(m.createdAt.toLocaleString('fr-FR'))}</span></div>
<div class="content">${formatContent(m.content, guild)}</div>${embeds}${attachments}</div></div>`;
  });

  const metaHtml = meta.map(([k, v]) => `<div><span>${esc(k)}</span> ${esc(v)}</div>`).join('');
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title || channel.name)}</title><style>
body{margin:0;background:#313338;color:#dbdee1;font-family:"gg sans","Segoe UI",Helvetica,Arial,sans-serif;font-size:15px}
header{background:#2b2d31;padding:20px 24px;border-bottom:1px solid #1f2023}
header h1{margin:0 0 8px;font-size:20px;color:#fff}header .meta{display:flex;flex-wrap:wrap;gap:6px 20px;font-size:13px;color:#b5bac1}
header .meta span{color:#949ba4}main{padding:12px 0}
.msg{display:flex;gap:14px;padding:6px 24px}.msg:hover{background:#2e3035}
.avatar{width:40px;height:40px;border-radius:50%;flex-shrink:0}.body{min-width:0;flex:1}
.head{display:flex;align-items:center;gap:8px}.name{font-weight:600}.time{color:#949ba4;font-size:12px}
.bot{background:#5865f2;color:#fff;font-size:10px;padding:1px 4px;border-radius:3px;font-weight:600}
.content{word-wrap:break-word;line-height:1.4}.mention{background:rgba(88,101,242,.3);color:#c9cdfb;border-radius:3px;padding:0 2px}
code{background:#2b2d31;padding:1px 4px;border-radius:4px}a{color:#00a8fc}.emoji{width:20px;height:20px;vertical-align:middle}
.embed{background:#2b2d31;border-left:4px solid;border-radius:4px;padding:10px 14px;margin-top:6px;max-width:520px}
.e-author{font-size:13px;font-weight:600}.e-title{font-weight:700;color:#fff;margin:4px 0}.e-desc{font-size:14px}
.e-field{margin-top:8px;font-size:14px}.e-fname{font-weight:700}.e-img{max-width:100%;border-radius:4px;margin-top:8px}
.e-footer{font-size:12px;color:#b5bac1;margin-top:8px}.att{max-width:400px;max-height:300px;border-radius:6px;margin-top:6px;display:block}
.file{display:inline-block;margin-top:6px;background:#2b2d31;padding:8px 12px;border-radius:6px}
</style></head><body><header><h1>${esc(title || `#${channel.name}`)}</h1><div class="meta">${metaHtml}<div><span>Messages :</span> ${messages.length}</div></div></header>
<main>${rows.join('\n')}</main></body></html>`;
  return { html, count: messages.length, participants: new Set(messages.map((m) => m.author.id)) };
}

module.exports = { createTranscript };
