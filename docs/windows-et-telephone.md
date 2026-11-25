# Jarvis sous Windows et sur téléphone

## 1. Fenêtre d'application sous Windows (léger)

Le serveur Jarvis tourne dans WSL (Ubuntu), l'interface s'affiche dans une
fenêtre Edge « application » : pas d'onglets, pas de barre d'adresse, et
presque aucun surcoût (Edge est déjà là). Les terminaux restent de vrais
terminaux Ubuntu.

**Une fois**, dans WSL :

```
cd ~/OpenJarvis/frontend && npm run build
```

**Icône de bureau** (le plus simple) : depuis WSL, une fois, `jarvis desktop
--create-shortcut` crée l'icône « Jarvis » sur le bureau Windows. Un double-clic
démarre le serveur s'il ne tourne pas, puis ouvre la fenêtre. **Fermer la fenêtre
éteint le serveur** (après 30 secondes, pour laisser passer un rechargement).
Il reste allumé tant qu'un chat Claude Code travaille, et si le robot téléphone est
configuré (le téléphone a besoin du serveur).

**Au quotidien**, depuis WSL, sans icône :

```
jarvis desktop
```

Cela démarre le serveur (un seul processus Python léger, pas de Node ni de
Vite), puis ouvre la fenêtre Edge « application » sur Windows. Un serveur démarré par
`jarvis desktop` s'éteint quand la fenêtre se ferme ; `jarvis stop` l'arrête à tout moment. (`jarvis gui` reste là pour
développer : il lance Vite en plus.)

**Fenêtre sans bande de titre (comme VS Code)** — une seule fois :

1. Lance `jarvis desktop`, puis dans la fenêtre Edge : menu `…` → *Applications* →
   *Installer ce site en tant qu'application* (ou depuis un onglet Edge normal sur
   `http://localhost:8010/workspace`).
2. Ouvre l'application installée « Jarvis » (menu Démarrer ou bureau) : la bande
   bleue disparaît, seuls restent − ▢ ✕ dessinés dans l'app.
3. Pour que `jarvis desktop` ouvre directement cette fenêtre-là : dans
   `edge://apps`, ouvre les détails de Jarvis, copie son **ID** (32 lettres) et ajoute
   `export JARVIS_APP_ID=<l'ID>` à ton `~/.bashrc`.

Autres façons :

* double-cliquer `scripts/windows/jarvis.cmd` (démarre le serveur dans WSL s'il
  ne tourne pas, puis ouvre la fenêtre) — *non testé sur une vraie machine
  Windows*, ajuster `DISTRO` / `PORT` en haut du fichier si besoin ;
* ou, serveur déjà lancé (`jarvis serve --port 8010`), ouvrir
  `http://localhost:8010/workspace` dans Edge, puis menu `…` → *Applications* →
  *Installer ce site en tant qu'application*. L'icône « Jarvis » s'ouvre alors
  directement sur l'espace de travail.

> Le dossier `frontend/src-tauri` est le bureau **d'origine** d'OpenJarvis : il
> démarre son propre serveur (uv, ollama) et vérifie les mises à jour sur le
> dépôt d'origine. Il n'est **pas utilisé** ici. Une coque Tauri minimale reste
> possible plus tard si la fenêtre Edge ne suffit pas.

## 2. Jarvis depuis le téléphone (Telegram)

Le téléphone parle à Jarvis par un robot Telegram **privé**. Principe de
sécurité : le serveur ne fait que des appels **sortants** vers Telegram (aucun
port n'est ouvert sur ton réseau), et seul **ton** compte est écouté.

### Mise en place

1. Dans Telegram, parle à **@BotFather** : `/newbot`, choisis un nom. Il te
   donne un **jeton** (une longue chaîne). Ne le partage pas.
2. Parle à **@userinfobot** : il te donne ton **identifiant numérique**.
3. Ajoute ces deux lignes à ton fichier `.env.local` (celui que lit le lanceur
   `jarvis`), puis relance le serveur :

   ```
   OPENJARVIS_PHONE_BOT_TOKEN=<le jeton>
   OPENJARVIS_PHONE_OWNER_ID=<ton identifiant numérique>
   ```
4. Ouvre ton robot dans Telegram, envoie `/start`. Jarvis répond « online ».

Sans ces deux variables, la fonction est **désactivée**.

### Ce que le téléphone peut faire

Écrire à Jarvis comme dans le tiroir de l'application : ouvrir un projet,
lancer un chat Claude Code, lui envoyer une consigne, lire sa réponse.
Créer un dépôt ou supprimer (déplacer à la corbeille `~/.jarvis-trash`) demande
ton accord par **deux boutons** Accepter / Refuser, que toi seul peux presser.
Les chats Claude Code ouverts par Jarvis demandent toujours leurs propres
autorisations **sur l'écran du PC**.

Commandes : `/status` (état et usage de l'abonnement), `/stop` (interrompre),
`/new` (nouvelle conversation), `/help`.

Les actions « d'écran » (ouvrir un repo, un onglet) exigent que l'application
soit ouverte sur le PC ; sinon Jarvis répond qu'aucun écran n'est ouvert.

### Garde-fous

| Risque | Parade |
|---|---|
| Quelqu'un d'autre écrit au robot | Seuls l'expéditeur **et** la conversation privée portant ton identifiant sont traités ; tout le reste est ignoré **sans réponse**. |
| Ordre ancien exécuté plus tard | À chaque démarrage, les messages reçus pendant que le serveur était éteint sont **jetés**. |
| Abus ou boucle | 40 messages par heure, 2000 caractères par message, une tâche qui dépasse 15 minutes est interrompue. |
| Abonnement vidé à distance | Les nouvelles tâches sont refusées quand la fenêtre de 5 h dépasse 85 % ou la semaine 95 %. |
| Fuite du jeton | Retiré de l'environnement des terminaux et de `claude` ; jamais écrit dans les journaux ; en cas de doute, `/revoke` auprès de @BotFather. |
| Vol du téléphone | La suppression ne fait que déplacer à la corbeille (récupérable) ; `/revoke` coupe l'accès. |

Réglages facultatifs (même fichier) : `OPENJARVIS_PHONE_MAX_PER_HOUR`,
`OPENJARVIS_PHONE_MAX_TEXT`, `OPENJARVIS_PHONE_TURN_SECONDS`.

### Ce que Telegram voit

Le **texte** de tes messages et des réponses de Jarvis passe par les serveurs de
Telegram. Rien d'autre ne sort de la machine à cause de cette fonction. Ne
dicte pas de secret (mot de passe, clé) à Jarvis depuis le téléphone.

### À savoir

* Le robot ne doit tourner que sur **un** serveur à la fois : deux programmes
  qui lisent le même robot se gênent (Telegram renvoie une erreur de conflit).
* Le PC doit être allumé et le serveur lancé.
