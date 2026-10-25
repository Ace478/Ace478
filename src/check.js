// Vérifie que tous les modules se chargent et que les commandes sont valides
// (sans se connecter à Discord). Lancer avec : npm run check
const modules = require('./modules');

const names = new Set();
const prefixes = new Set();
let count = 0;
for (const mod of modules) {
  for (const command of mod.commands || []) {
    const json = command.data.toJSON();
    if (names.has(json.name)) throw new Error(`Commande en double : ${json.name}`);
    names.add(json.name);
    count += 1;
  }
  for (const prefix of Object.keys(mod.components || {})) {
    if (prefixes.has(prefix)) throw new Error(`Préfixe de composant en double : ${prefix}`);
    prefixes.add(prefix);
  }
}
if (count > 100) throw new Error('Discord limite à 100 commandes slash.');
console.log(`OK — ${count} commandes : ${[...names].join(', ')}`);
