// Regroupe tous les modules. Pour ajouter une fonctionnalité : créer un fichier
// dans ce dossier exportant { commands, components, events } et l'ajouter ici.
module.exports = [
  require('./tickets'),
  require('./embeds'),
  require('./welcome'),
  require('./moderation'),
  require('./logs'),
  require('./rolemenus'),
  require('./utility'),
  require('./whitelist'),
  require('./config'),
];
