# ☀️ Sun Bot — bot Discord polyvalent

Bot Discord tout-en-un, en français. **Toute la configuration se fait avec des menus et des boutons**, et **chaque message est un embed personnalisable** (titre, texte, couleur, bannière, emojis…).

| Commande | Menu qui s'ouvre |
| --- | --- |
| `/config` | **Menu principal** : accès à tous les panneaux ci-dessous |
| `/ticket` | 🎫 Tickets : salons, staff, raisons, questions, messages, panel, options, stats |
| `/bienvenue` | 👋 Messages de bienvenue / départ, MP, rôles automatiques |
| `/embed` | 🎨 Créer, modifier, sauvegarder et envoyer des embeds |
| `/roles` | 🎭 Menus de rôles en libre-service (boutons ou menu déroulant) |
| `/logs` | 📜 Salon de chaque type de logs |
| `/wl` | 📋 Whitelist (membres/rôles + commandes autorisées) et 👑 owners |

Et aussi : modération (`/ban`, `/kick`, `/mute`, `/warn`, `/clear`…), `/sondage`, `/suggestion`, `/dire`, `/userinfo`, `/serverinfo`, `/aide`.

Aucune base de données à installer : tout est enregistré dans le dossier `data/`.

---

## 1. Créer le bot sur Discord

1. Allez sur <https://discord.com/developers/applications> → **New Application**.
2. Onglet **Bot** :
   - **Reset Token** → copiez le token (ne le partagez **jamais**).
   - Dans **Privileged Gateway Intents**, activez **SERVER MEMBERS INTENT** et **MESSAGE CONTENT INTENT**, puis **Save Changes**.
     *(Sinon le bot plante avec l'erreur `Used disallowed intents`.)*
3. Onglet **General Information** : copiez l'**Application ID**.
4. Invitez le bot (remplacez `CLIENT_ID`) :

   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&permissions=8&scope=bot%20applications.commands
   ```

5. Dans **Paramètres du serveur → Rôles**, placez le rôle du bot **tout en haut**.

## 2. Lancer le bot

Il faut [Node.js](https://nodejs.org) 18 ou plus récent.

```bash
npm install
```

Renommez `.env.example` en `.env`, collez votre token après `DISCORD_TOKEN=`, puis :

```bash
npm start
```

Quand `✅ Connecté` s'affiche, les commandes apparaissent tout de suite sur le serveur.

> 💡 Pour qu'il tourne 24h/24, hébergez-le sur un VPS (`pm2 start src/index.js --name sun-bot`) ou chez un hébergeur de bots Discord. Sauvegardez le dossier `data/`.

---

## 3. Tickets — `/ticket`

Le panneau vous guide en 4 étapes :

1. **Menus de la page d'accueil** : salon des demandes staff (vide = ouverture directe), catégorie des tickets, salon des logs/transcripts, rôles staff.
2. **📋 Raisons** : les options du menu déroulant (25 max). Pour chacune :
   - nom, emoji, description ;
   - **jusqu'à 5 questions** posées dans un formulaire avant l'ouverture ;
   - **🎨 message d'ouverture** propre à cette raison ;
   - rôles staff et catégorie spécifiques ;
   - validation par le staff oui / non ;
   - ordre dans le menu, suppression.
3. **🎨 Messages** : personnalisez avec l'éditeur le panel, le message d'ouverture, les MP « accepté », « refusé » et « fermé ».
4. **📤 Panel** : choisissez le salon. Les panels envoyés **se mettent à jour tout seuls**.

**⚙️ Options** : tickets max par membre, nom des salons, texte du menu, **fermeture automatique après X heures d'inactivité**, transcript en MP, mention du staff, fermeture par le membre.
**📊 Stats** : statistiques, tickets ouverts, classement du staff, **historique de n'importe quel membre**.

### Dans un ticket

- Boutons : **🙋 Prendre en charge**, **⏸️ Pause** (le membre ne peut plus écrire), **⚙️ Gérer**, **🔒 Fermer**.
- **⚙️ Gérer** (ou `/ticket` dans le salon) : ajouter / retirer des membres, renommer, transcript, fermer, rouvrir, supprimer.
- À la fermeture : transcript HTML dans les logs et en MP, puis boutons **Rouvrir** / **Transcript** / **Supprimer**.

Variables utilisables dans les messages de tickets : `{numero}`, `{categorie}`, `{emoji}`, `{salon}`, `{staff}`, `{raison}` + toutes les variables ci-dessous.

## 4. L'éditeur d'embed

Il s'ouvre depuis tous les panneaux (bouton 🎨) ou avec `/embed`. Il affiche un **aperçu en direct** :

- menu **« Que voulez-vous modifier ? »** : titre, description, couleur, auteur, pied de page, image (bannière) et miniature, **📏 largeur de l'embed**, champs, horodatage, texte au-dessus, import JSON (Discohook) ;
- **📏 Largeur** : sur Discord, la largeur d'un embed dépend de la taille de la bannière. Le bot redimensionne donc la bannière à la largeur choisie (ex. `1200` = embed le plus large). Sans bannière, il ajoute une image invisible pour élargir l'embed ;
- **💾 Enregistrer** applique le message, **↩️ Annuler** revient au panneau.

Mise en forme dans la description : `## Titre`, `> citation`, `**gras**`, `-# petit texte`, emojis perso `<:nom:id>` (tapez `\:emoji:` sur Discord pour obtenir le code). Pour une image : clic droit sur l'image dans Discord → *Copier le lien*.

| Variable | Résultat |
| --- | --- |
| `{user}` | mention du membre |
| `{user.name}` / `{user.displayname}` | nom / pseudo |
| `{user.avatar}` | avatar (pour image ou miniature) |
| `{server}`, `{server.icon}`, `{server.members}` | nom, icône, nombre de membres |

## 5. Accès — `/wl`

Par défaut, chaque commande demande la permission Discord habituelle (ex. *Bannir* pour `/ban`, *Gérer le serveur* pour les panneaux).

- **👥 Membres & rôles** : sélectionnez qui fait partie de la WL.
- **✅ Commandes autorisées** : cochez les commandes que la WL peut utiliser.
- **🔒 Mode strict** : les permissions Discord ne suffisent plus, seuls les owners et la WL passent.
- **👑 Owners** : accès **total** au bot. Seul le **propriétaire du serveur** (ou un ID dans `BOT_OWNERS` du `.env`) peut modifier cette liste.

> ℹ️ C'est le bot qui vérifie les accès : toutes les commandes sont visibles dans la liste `/`, un membre sans accès reçoit simplement un refus.

## 6. Le reste

- `/bienvenue` : salons, activer / désactiver, **🎨 personnaliser**, **🧪 tester**, rôles automatiques.
- `/roles` : créez un menu dans un salon, choisissez les rôles, puis modifiez les textes, les emojis et l'apparence.
- `/logs` : un salon par type, ou tout dans le même salon. Les logs sont détaillés :
  - **messages** : contenu, pièces jointes (avec aperçu), qui a supprimé, suppressions en masse (fichier .txt) ;
  - **membres** : âge du compte (⚠️ compte récent), **invitation utilisée et qui l'a créée**, durée passée sur le serveur, rôles, pseudos, boosts ;
  - **modération** : ban / kick / mute faits par le bot *ou* directement dans Discord, avec l'auteur et la raison ;
  - **vocal** : connexions, **temps passé**, déplacements (et par qui), stream, caméra, mute serveur ;
  - **serveur** : salons, rôles et **permissions** (avant → après), emojis, invitations, paramètres du serveur.

  Le bot retrouve « qui a fait l'action » grâce au journal d'audit : il lui faut la permission **Voir les logs du serveur** (incluse dans Administrateur).
- `/config` → **Suggestions** : salon des suggestions (`/suggestion`).

---

## Mettre à jour le bot (hébergeur avec Git)

Le code est cloné depuis ce dépôt dans le dossier `sunbot` de l'hébergeur (fichier principal : `sunbot/src/index.js`).

1. **Fichiers → Git → Dépôts de ce serveur → Mettre à jour**
2. **Redémarrer**

Le token (variable `DISCORD_TOKEN` de l'hébergeur) et la configuration (`sunbot/data`) ne sont jamais sur GitHub et ne sont pas touchés par les mises à jour.
Si une mise à jour ajoute une dépendance, copiez `sunbot/package.json` à la racine avant de redémarrer.

Chaque push sur ce dépôt est annoncé dans le salon Discord des commits (webhook GitHub).

## Structure du code

```
src/
  index.js            démarrage, vérification des accès, routage des interactions
  check.js            vérification sans connexion (npm run check)
  lib/                base de données JSON, accès/WL, composants d'interface, logs, transcripts
  modules/            une fonctionnalité par fichier (tickets, embeds, welcome, config…)
data/                 créé automatiquement : configuration et transcripts
```

Pour ajouter une fonctionnalité : créez un fichier dans `src/modules/` qui exporte `{ commands, components, events, dashboard }` et ajoutez-le dans `src/modules/index.js`.
