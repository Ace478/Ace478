# ☀️ Sun Bot — bot Discord polyvalent

Bot Discord tout-en-un, entièrement en français et en commandes slash (`/`) :

| Module | Ce qu'il fait |
| --- | --- |
| 🎫 **Tickets** | Panel avec menu déroulant, formulaire, **validation par le staff** (accepter / refuser), MP au membre, prise en charge, **pause**, fermeture, réouverture, suppression, **transcripts HTML**, historique et statistiques |
| 🎨 **Embeds** | Éditeur visuel complet (titre, description, couleurs, images, champs, auteur, pied de page…), aperçu en direct, **modèles sauvegardés**, import/export JSON (Discohook), modification de messages déjà envoyés |
| 👋 **Accueil** | Messages de bienvenue / départ personnalisables (avec vos modèles d'embed), MP de bienvenue, **rôles automatiques** |
| 🛡️ **Modération** | ban, unban, kick, mute, unmute, warn + historique, clear, verrouiller, slowmode — avec MP au membre et numéro de cas |
| 📜 **Logs** | Messages supprimés/modifiés, arrivées/départs, rôles, pseudos, vocal, salons/rôles, modération, tickets — chaque type dans le salon de votre choix |
| 🎭 **Rôles** | Menus de rôles en libre-service (boutons ou menu déroulant) |
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

```text
/logs salon type:Tickets salon:#logs-tickets              ← transcripts + historique
/ticket-config general salon_demandes:#demandes-staff categorie_discord:Tickets
/ticket-config staff role:@Staff
/ticket-config raison nom:Recrutement emoji:📩 description:Rejoindre l'équipe question:Présentez-vous
/ticket-config raison nom:Support emoji:🛠️ description:Un problème ? validation:False
/ticket panel salon:#tickets
```

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

Quand vous ajoutez / modifiez une raison, **les panels existants se mettent à jour tout seuls**.

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

## 5. Accueil

```text
/accueil bienvenue salon:#bienvenue texte:{user}            ← embed par défaut
/accueil bienvenue modele:bienvenue                          ← votre propre embed
/accueil depart salon:#départs
/accueil autorole role:@Membre
/accueil test type:Bienvenue
```

## 6. Logs, rôles, suggestions

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
