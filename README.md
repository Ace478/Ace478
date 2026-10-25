# ☀️ Sun Bot — bot Discord polyvalent

Bot Discord tout-en-un, entièrement en français et en commandes slash (`/`) :

| Module | Ce qu'il fait |
| --- | --- |
| 🎫 **Tickets** | **Panneau de configuration interactif**, menu déroulant, formulaires jusqu'à 5 questions, **validation par le staff** (accepter / refuser), MP au membre, prise en charge, **pause**, fermeture, réouverture, suppression, **transcripts HTML**, fermeture auto., historique et statistiques |
| 🎨 **Embeds** | Éditeur visuel complet (titre, description, couleurs, images, champs, auteur, pied de page…), aperçu en direct, **modèles sauvegardés**, import/export JSON (Discohook), modification de messages déjà envoyés |
| 👋 **Accueil** | Messages de bienvenue / départ personnalisables (avec vos modèles d'embed), MP de bienvenue, **rôles automatiques** |
| 🛡️ **Modération** | ban, unban, kick, mute, unmute, warn + historique, clear, verrouiller, slowmode — avec MP au membre et numéro de cas |
| 📜 **Logs** | Messages supprimés/modifiés, arrivées/départs, rôles, pseudos, vocal, salons/rôles, modération, tickets — chaque type dans le salon de votre choix |
| 🎭 **Rôles** | Menus de rôles en libre-service (boutons ou menu déroulant) |
| 👑 **Accès** | **WL owner** (accès total) et **WL** (membres/rôles autorisés sur les commandes de votre choix), mode strict |
| 🧰 **Utilitaires** | sondages, suggestions (avec fil de discussion), `/dire`, userinfo, serverinfo, avatar, aide |

Aucune base de données à installer : tout est enregistré dans le dossier `data/`.

---

## 1. Créer le bot sur Discord

1. Allez sur <https://discord.com/developers/applications> → **New Application**, donnez-lui un nom.
2. Onglet **General Information** : copiez l'**Application ID** (c'est le `CLIENT_ID`).
3. Onglet **Bot** :
   - **Reset Token** → copiez le token (c'est le `DISCORD_TOKEN`, ne le partagez **jamais**).
   - Dans **Privileged Gateway Intents**, activez **SERVER MEMBERS INTENT** et **MESSAGE CONTENT INTENT**, puis enregistrez.
4. Invitez le bot sur votre serveur avec ce lien (remplacez `CLIENT_ID`) :

   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&permissions=8&scope=bot%20applications.commands
   ```

   (`permissions=8` = Administrateur, le plus simple. Sinon il lui faut au minimum : gérer les salons, les rôles, les messages, voir les logs d'audit, bannir, expulser, exclure temporairement.)

5. Dans **Paramètres du serveur → Rôles**, placez le rôle du bot **au-dessus** des rôles qu'il doit donner (auto-rôles, menus de rôles).

## 2. Lancer le bot

Il faut [Node.js](https://nodejs.org) **18 ou plus récent**.

```bash
npm install
cp .env.example .env    # puis ouvrez .env et collez votre token
npm start
```

Les commandes apparaissent **instantanément** sur vos serveurs au démarrage. Tapez `/aide` pour la liste.

> 💡 Pour qu'il tourne 24h/24, hébergez-le sur un VPS (avec `pm2 start src/index.js --name sun-bot`) ou chez un hébergeur de bots Discord (Pterodactyl, etc.). Pensez à sauvegarder le dossier `data/`.

---

## 3. Configurer les tickets (comme sur la capture)

Tapez **`/ticket-config`** : un panneau interactif s'ouvre (visible par vous seul), tout se règle avec des menus et des boutons.

**Page d'accueil** — quatre menus de sélection :
- 📨 **Salon des demandes** : où le staff reçoit les demandes à accepter / refuser (vide = les tickets s'ouvrent directement) ;
- 📁 **Catégorie** où créer les salons de tickets ;
- 📜 **Salon des logs** : historique et transcripts ;
- 🛡️ **Rôles staff** (jusqu'à 10).

**📋 Raisons** — chaque raison est une option du menu déroulant (25 max) :
- **➕ Ajouter une raison** : nom, emoji, description, message d'accueil, questions ;
- pour chaque raison : **rôles staff spécifiques**, **catégorie spécifique**, **validation staff oui / non**, **jusqu'à 5 questions** posées dans un formulaire avant l'ouverture, **⬆️ Monter** pour changer l'ordre, **🗑️ Supprimer**.

**⚙️ Options** : tickets max par membre, format du nom des salons (`{categorie}-{numero}`…), texte du menu déroulant, **fermeture automatique après X heures d'inactivité**, transcript en MP, mention du staff, autoriser ou non le membre à fermer son ticket.

**📤 Envoyer le panel** : choisissez l'apparence (modèle par défaut ou votre modèle `/embed`) puis le salon. Les panels déjà envoyés **se mettent à jour tout seuls** quand vous modifiez les raisons.

Fonctionnement :

1. Le membre choisit une **raison** dans le menu (et répond à la question si vous en avez mis une).
2. **Avec validation** (par défaut) : la demande arrive dans `salon_demandes` avec les boutons **Accepter / Refuser**. À l'acceptation, le salon privé est créé et le membre reçoit un **MP** avec le lien. En cas de refus, il reçoit la raison en MP.
   **Sans validation** (`validation:False`) : le salon est créé tout de suite.
3. Dans le ticket : boutons **Prendre en charge**, **Pause** (le membre ne peut plus écrire), **Transcript**, **Fermer**.
4. À la fermeture : le transcript HTML est envoyé dans les logs (et en MP au membre), puis boutons **Rouvrir** / **Supprimer**.

Autres commandes dans un ticket : `/ticket ajouter`, `/ticket retirer`, `/ticket renommer`, `/ticket pause`, `/ticket fermer`.
Historique : `/ticket historique membre:@…` — Statistiques : `/ticket stats`.

**Personnaliser le panel** (texte, bannière « TICKETS », emojis perso…) :

- soit créez un modèle avec `/embed creer`, sauvegardez-le (ex. `ticket-panel`) puis `/ticket panel modele:ticket-panel` ;
- soit modifiez le panel déjà envoyé avec `/embed modifier lien:<lien du message>` (le menu déroulant est conservé).

---

## 4. L'éditeur d'embeds

`/embed creer` ouvre un éditeur visible par vous seul :

- **Menu « Que voulez-vous modifier ? »** : titre, description, couleur, auteur, pied de page, image + miniature, champs, horodatage, texte au-dessus de l'embed, import JSON.
- **Menu « Envoyer dans un salon… »** : envoie le résultat.
- **💾 Sauvegarder** : enregistre un **modèle** réutilisable (`/embed envoyer`, bienvenue, panel de tickets, menus de rôles).
- **📄 JSON** : exporte, et **Importer du JSON** accepte le format Discord / [Discohook](https://discohook.app).

Mise en forme utile dans la description :

```text
## 🧭 COMMENT ÇA MARCHE ?
> **1.** Sélectionnez votre raison dans le menu ci-dessous.
> **2.** Une demande sera envoyée au staff.
```

Emojis personnalisés : tapez `\:nom_emoji:` dans Discord pour obtenir son code `<:nom:id>` et collez-le.
Image (bannière) : collez le lien direct de l'image (clic droit sur une image envoyée dans Discord → *Copier le lien*).

### Variables (utilisables partout)

| Variable | Résultat |
| --- | --- |
| `{user}` | mention du membre |
| `{user.name}` / `{user.displayname}` | nom d'utilisateur / pseudo |
| `{user.avatar}` | lien de l'avatar (pour image ou miniature) |
| `{user.id}`, `{user.created}` | ID, date de création du compte |
| `{server}`, `{server.icon}`, `{server.members}` | nom, icône, nombre de membres |

---

## 5. WL owner et WL

Par défaut, chaque commande demande la permission Discord habituelle (ex. *Bannir des membres* pour `/ban`). Deux listes permettent de donner des accès en plus :

**👑 WL owner** — accès **total** au bot, comme le propriétaire (toutes les commandes et la gestion de la WL).
Seul le **propriétaire du serveur** (ou un ID mis dans `BOT_OWNERS` du `.env`) peut la modifier.

```text
/owner ajouter membre:@Pseudo
/owner retirer membre:@Pseudo
/owner liste
```

**📋 WL** — des membres **ou des rôles** qui peuvent utiliser **uniquement les commandes que vous choisissez** (gérée par les owners).

```text
/wl ajouter cible:@Pseudo              ← un membre ou un rôle
/wl autoriser commande:ban             ← la liste des commandes s'affiche automatiquement
/wl autoriser commande:toutes
/wl interdire commande:ban
/wl retirer cible:@Pseudo
/wl liste
/wl mode strict:True                   ← les permissions Discord ne suffisent plus : seuls owners + WL passent
```

> ℹ️ Comme c'est le bot qui vérifie les accès, toutes les commandes sont visibles dans la liste `/` ; un membre sans accès reçoit simplement un refus.

## 6. Accueil

```text
/accueil bienvenue salon:#bienvenue texte:{user}            ← embed par défaut
/accueil bienvenue modele:bienvenue                          ← votre propre embed
/accueil depart salon:#départs
/accueil autorole role:@Membre
/accueil test type:Bienvenue
```

## 7. Logs, rôles, suggestions

```text
/logs salon type:Tous salon:#logs          ← ou un salon différent par type
/roles creer type:Boutons salon:#rôles
/roles ajouter lien:<lien du menu> role:@Notifications emoji:🔔
/suggestions-config salon:#suggestions
```

---

## Structure du code

```
src/
  index.js            démarrage, chargement des modules, routage des interactions
  check.js            vérification sans connexion (npm run check)
  lib/                base de données JSON, utilitaires, logs, transcripts
  modules/            une fonctionnalité par fichier (tickets, embeds, welcome…)
data/                 créé automatiquement : configuration et transcripts
```

Pour ajouter une fonctionnalité : créez un fichier dans `src/modules/` qui exporte `{ commands, components, events }` et ajoutez-le dans `src/modules/index.js`.
