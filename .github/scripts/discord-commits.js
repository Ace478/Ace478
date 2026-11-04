// Construit et envoie le message "mises à jour" dans Discord à partir de l'événement push GitHub.
const fs = require('node:fs');

// ----- Personnalisation -----
const SERVER_LABEL = 'Serveur principal';
const NOTE = 'appliqué au prochain redémarrage';
const COLOR = 0x3b82f6;
// Bannière en bas du message. Mettez une image dans le dépôt (.github/update-banner.png)
// pour un lien qui n'expire jamais ; sinon le lien ci-dessous est utilisé.
const BANNER_URL =
  'https://cdn.discordapp.com/attachments/1307019389031284826/1564575300011171850/Frame_42.png?ex=6aec4fcb&is=6aeafe4b&hm=fc6d8254aaecd74daa43d03a3319881544f2bcfb975f466e327f1795328f56fc';
// Nom affiché pour chaque branche (à la place du nom technique).
const BRANCH_LABELS = { 'claude/discord-bot-tickets-soto1o': 'production' };
const WEBHOOK_NAME = 'Mises à jour';
// ----------------------------

const webhook = process.env.DISCORD_WEBHOOK_URL;
if (!webhook) {
  console.error('Secret DISCORD_WEBHOOK_URL manquant : Settings > Secrets and variables > Actions.');
  process.exit(1);
}

const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const commits = event.commits || [];
if (!commits.length) {
  console.log('Aucun commit (suppression de branche ou tag) : rien à envoyer.');
  process.exit(0);
}

const repo = event.repository;
const rawBranch = (event.ref || '').replace(/^refs\/heads\//, '');
const branch = BRANCH_LABELS[rawBranch] || rawBranch;
const pusher = event.sender?.login || event.pusher?.name || 'inconnu';

const bannerInRepo = fs.existsSync('.github/update-banner.png');
const banner = bannerInRepo ? `https://raw.githubusercontent.com/${repo.full_name}/${event.after}/.github/update-banner.png` : BANNER_URL;

const user = (c) => c.author?.username || c.author?.name || 'inconnu';
const lines = commits.map((c) => {
  const sha = `[\`${c.id.slice(0, 7)}\`](${c.url})`;
  const [title, ...rest] = c.message.split('\n');
  const mergedBranch = title.match(/^Merge (?:remote-tracking )?branch '([^']+)'/);
  if (mergedBranch) return `-# ↳ ${sha} merge de ${mergedBranch[1]} par **${user(c)}**`;
  const body = [title, ...rest.filter((l) => l.trim())].map((l) => `> ${l}`).join('\n');
  return `${sha} **${user(c)}**\n${body}`;
});

const header = `Poussé par [${pusher}](https://github.com/${pusher}) · ${SERVER_LABEL} · ${NOTE}\n─────────────────────────\n`;
let description = header;
for (const line of lines) {
  if (description.length + line.length + 40 > 4000) {
    description += `\n*… et ${lines.length - lines.indexOf(line)} autre(s)*`;
    break;
  }
  description += `${line}\n\n`;
}

const count = commits.length;
const payload = {
  username: WEBHOOK_NAME,
  embeds: [
    {
      color: COLOR,
      title: `[${repo.name}] (${branch}) — ${count} nouvelle${count > 1 ? 's' : ''} mise${count > 1 ? 's' : ''} à jour`,
      url: event.compare,
      description: description.trim(),
      image: { url: banner },
      footer: { text: `${count} commit${count > 1 ? 's' : ''} sur ${branch}` },
      timestamp: event.head_commit?.timestamp || new Date().toISOString(),
    },
  ],
};

fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  .then(async (res) => {
    if (!res.ok) throw new Error(`Discord a répondu ${res.status} : ${await res.text()}`);
    console.log(`Message envoyé (${count} commit(s)).`);
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
