# CLAUDE.md — Jarvis (fork autonome d'OpenJarvis)

Lu automatiquement à chaque session dans ce dossier. Garde-le court : le détail
long va dans `docs/` ou dans `.claude/rules/`.

## Ce qu'est ce projet

Jarvis est un **poste de travail de développement piloté par une IA**, qui tourne
sur la machine de Loïc (WSL2 Ubuntu). Le projet est parti d'OpenJarvis (framework
d'IA personnelle locale, Python + Rust + React). **Le lien avec l'upstream est
coupé** : ce dépôt est autonome, on ne synchronise plus avec le projet d'origine.

L'objectif : remplacer l'usage de plusieurs fenêtres VS Code + Claude Code par
**une seule application** qui ressemble à VS Code, où une IA (« Jarvis »)
pilote l'ensemble — y compris depuis un téléphone.

## Vision — l'écran cible

- **Barre verticale à gauche** (icônes seules, comme la barre d'activité de
  VS Code) : Workspace, Chat, Dashboard, Data Sources, Agents, Logs, puis
  Get Started et Settings en bas.
- **Bouton Jarvis** : médaillon rond en haut à droite (voir plus bas).
- **Colonne gauche** :
  - en haut, **un sélecteur de repos** (là où est aujourd'hui « Select model ») :
    on ouvre plusieurs repos et on bascule d'un clic ;
  - dessous, **l'arborescence** des dossiers du repo actif, comme VS Code.
- **Centre, en onglets**, façon VS Code :
  - des **fenêtres Claude Code** (chat) ; un **+** en ouvre une nouvelle ;
  - des **éditeurs de fichiers** (Monaco, le moteur de VS Code) ;
  - des **terminaux**, plusieurs possibles.
- **Séparation redimensionnable** entre la zone chat/éditeur et le terminal
  (agrandir l'un, réduire l'autre).
- **Changer de repo change tout** : terminaux, chats Claude Code, arborescence.
- **Compteurs flottants** (sans fond, superposés au chat et au terminal), en haut
  à droite sous le bouton Jarvis : **% de la session d'abonnement (5 h)** et
  **% de la semaine (7 jours)**. Données lues dans l'évènement
  `rate_limit_event` du flux de `claude` (`lib/planUsage.ts`), branchées à l'étape 4.
- **Bouton Jarvis** : ouvre le chat de l'**IA qui contrôle l'app** (ouvrir un
  repo, lancer une fenêtre Claude Code, ouvrir un terminal, envoyer une
  consigne à un chat). C'est **ce chat-là** qu'on utilisera depuis le téléphone.
  Il remplace l'ancien chat « discussion » comme interface principale de pilotage.

## Direction visuelle

- **Mêmes couleurs** que l'app actuelle (noirs neutres + rouge ; seule la lueur de fond reste cyan, ambre et violet en
  accents). Seules les **surfaces** changent.
- **Concept entièrement futuriste et métallique**, avec du **volume (effet 3D)** :
  plaques d'acier brossé, bords biseautés, zones en creux, lueurs douces.
- **Compteurs de consommation** : cadrans de type « compteur de vitesse » dans un
  boîtier noir métallique, entourés d'un **motif tribal** (anneau de lames
  courbes). Composant : `components/futuristic/MetalGauge.tsx`.
- Les styles réutilisables sont dans `frontend/src/styles/metal.css`
  (`metal-panel`, `metal-well`, `metal-btn`, `metal-tab`, `metal-splitter`).
  Le workbench force le thème sombre (classe `dark` sur `.wb-root`).
- Pas d'image ni de ressource externe pour le décor : tout en SVG et CSS.

## Décisions déjà prises

| Sujet | Décision |
|---|---|
| Fenêtre Claude Code | **Interface de chat faite maison**, façon extension VS Code (messages, outils utilisés, boutons Accepter/Refuser) — pas un simple terminal. |
| Fichiers | **Monaco** (vrai éditeur), pas de lecture seule. |
| Support | **Web en local d'abord** (Vite + API), **Tauri ensuite** si la page web pose problème. |
| Réseau | **Local seulement au début.** Le terminal et le pilotage sont protégés par un jeton, jamais ouverts au réseau sans protection. Le téléphone viendra après. |
| Connexion Claude Code | **L'abonnement Claude Code de Loïc, obligatoirement.** Par clé API ce serait trop cher. |
| Permissions de Jarvis | **Large : il peut tout faire**, mais **validation humaine obligatoire** pour les actions destructrices (voir « Garde-fous »). |
| Upstream | Retiré (`git remote remove upstream`). |
| Kit MyFramework | Éléments utiles copiés dans `framework/` (référence, rien d'actif). |

### Connexion par abonnement — point d'attention

- La voie à privilégier est de **lancer la commande officielle `claude`** en
  sous-processus (mode `--output-format stream-json`), connectée avec
  `claude login`. Même effet que dans un terminal, avec l'abonnement.
- **Ne pas** réutiliser le jeton OAuth de l'abonnement dans un client maison
  (ni le SDK Agent) : les conditions d'Anthropic restreignent ça. À **vérifier
  dans leurs conditions** avant d'aller plus loin, et à noter ici.
- **Conditions vérifiées le 2026-11-21** ([page officielle](https://code.claude.com/docs/en/legal-and-compliance)) :
  l'abonnement sert à l'usage ordinaire du binaire `claude` **non modifié** ;
  interdit de revendre ou d'offrir une connexion Claude.ai à des tiers, ou de
  faire passer des requêtes par les identifiants de l'abonnement pour d'autres.
  Usage **personnel local** (le binaire officiel lancé par Loïc sur son propre
  abonnement) : non traité explicitement par la page, donc **ne jamais ouvrir
  l'app à d'autres comptes**. Une source tierce (page zh-TW) évoque un crédit
  mensuel « Agent SDK » séparé pour `claude -p` depuis le 15 juin 2026 : **non
  confirmé** par les pages anglaises ; à vérifier en lisant `rate_limit_event`
  pendant les premiers essais.
- **Piège local** : le lanceur `~/.local/bin/jarvis` charge `.env.local`, qui
  pointe vers **OpenRouter** (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_API_KEY=""`). Le sous-processus `claude` lancé pour l'abonnement
  doit tourner avec ces variables **retirées**, sinon il utilise OpenRouter.
- L'ancien agent `claude_code` (Node + SDK, `src/openjarvis/agents/claude_code*`)
  reste utilisable avec OpenRouter ; il n'est **pas** la voie de l'abonnement.

## Stack

Python 3.11+ (`src/openjarvis`, serveur FastAPI) · Rust/PyO3 (`rust/`, module
`openjarvis_rust`) · React 19 + Vite + Tailwind 4 + zustand (`frontend/`) · Tauri
(`frontend/src-tauri`) · `uv` · pytest · ruff · vitest.

## Structure

```
src/openjarvis/   cœur Python : agents/, engine/, tools/, connectors/, server/, core/
rust/             extension PyO3 (openjarvis_rust)
frontend/         UI React (pages/, components/, lib/) ; src-tauri/ = bureau
tests/            miroir de src/
docs/  deploy/  scripts/  configs/  desktop/
```

Registres à respecter pour tout nouveau composant : `ToolRegistry`,
`EngineRegistry`, `AgentRegistry`, `ChannelRegistry` (`core/registry.py`),
événements via `EventBus` (`core/events.py`).

## Commandes

| Quoi | Commande |
|---|---|
| Installer | `uv sync --inexact` (garde `openjarvis-rust`) |
| Lancer l'app | `jarvis gui --api-port 8010` (le port 8000 est pris par Docker) |
| Tests Python | `uv run pytest` |
| Lint / format Python | `uv run ruff check src tests` · `uv run ruff format --check src tests` |
| Types front | `cd frontend && npx tsc -b` |
| Tests front | `cd frontend && npm test` |
| Build front | `cd frontend && npm run build` |

Le PATH doit avoir `~/.cargo/bin` en premier (sinon mauvais `cargo`). Le front
exige npm ≥ 11.19 (installé dans le préfixe utilisateur).

## Garde-fous — non négociables

1. **Jamais de push direct sur `main`.** Branche + PR, sauf accord explicite
   de Loïc dans le message en cours.
2. **Rien n'est poussé sans demande explicite** dans le message courant.
3. **Commits sémantiques** : `type(scope): sujet` (feat, fix, docs, refactor,
   test, chore…), impératif, minuscule, sans point final.
4. **Jamais de secret dans le code ni dans un message.** On peut lire `.env.local`
   pour comprendre le branchement, jamais en ressortir une valeur.
5. **Confidentialité : aucune donnée ne part vers un service externe de suivi.**
   Les analyses d'usage, le classement et les balises d'installation ont été
   retirés ; ne pas les réintroduire. Aucun envoi d'identité, d'email ou
   d'usage.
6. **Se relire avant de rendre** : ruff, `tsc -b`, vitest, pytest verts, puis
   relire son propre diff.
7. **Regarder avant de supprimer** : ouvrir le contenu, annoncer ce qui
   disparaît, dans le doute ne pas supprimer.

### Validation humaine pour les actions de Jarvis

Jarvis (l'IA qui pilote l'app) a de larges droits, mais **demande toujours une
validation** avant :

- supprimer un fichier, un dossier, un repo ou une branche ;
- **créer un nouveau repo** (local ou distant) ;
- `git push`, `git reset --hard`, réécriture d'historique, force-push ;
- envoyer un message ou un mail vers l'extérieur ;
- toute commande qui supprime ou écrase en masse.

Ces règles s'appliquent **dans le code de l'app** (un système d'approbation
existe déjà : `approval_store`, `ApprovalBell`) — pas seulement dans ce fichier.
Une règle écrite uniquement ici n'est qu'une consigne ; le contrôle doit être
imposé par le code.

### Sécurité du terminal et du pilotage

Donner un shell à un navigateur est dangereux. Obligatoire :

- écouter **uniquement sur 127.0.0.1** ;
- exiger un **jeton secret** pour la connexion terminal / pilotage ;
- vérifier l'en-tête `Origin` (protection contre les pages web hostiles) ;
- plafonner le coût par tâche lancée à distance ;
- le canal téléphone n'accepte que **le compte de Loïc**.

## Feuille de route

1. ✅ Écran principal : barre gauche, panneau repos, onglets centraux, séparation
   réglable, compteurs flottants, médaillon Jarvis (validé par Loïc).
2. ✅ Terminaux multiples (PTY côté serveur, WebSocket, jeton) — fait, à valider par
   Loïc. Code : `server/terminal_routes.py`, `frontend/.../Workbench/TerminalView.tsx`.
   Le serveur refuse tout terminal sans : bind loopback, Host loopback, Origin
   connu, jeton du processus. Les variables `ANTHROPIC_*`, `OPENJARVIS_*` et les
   clés fournisseurs sont retirées de l'environnement du shell. Limite connue :
   avec `--frontend-port` autre que 5173/5174, ajouter l'origine dans
   `OPENJARVIS_CORS_ORIGINS`, sinon le terminal est refusé.
3. ✅ Sélecteur de repos, arborescence, éditeur Monaco ; le changement de repo
   change tout — fait, à valider par Loïc. Code : `server/workspace_routes.py`
   (mêmes barrières que le terminal + en-tête `X-Jarvis-Token`), front dans
   `frontend/.../Workbench/` (`workspaceModel.ts` état pur, `workspaceStore.ts`
   buffers et sauvegarde, `FileTree`, `RepoSwitcher`, `FolderPicker`,
   `EditorView`). Règles : chemins confinés au dossier personnel (symlinks
   suivis), **aucune suppression ni renommage** (viendront avec les
   approbations), écriture interdite dans `.git`, sauvegarde refusée (409) si le
   fichier a changé sur le disque depuis l'ouverture (Claude Code peut l'avoir
   modifié). Chaque repo a ses onglets et ses terminaux ; le workbench reste
   monté quand on change de page (`PersistentWorkbench` dans `App.tsx`).
   Monaco est embarqué (jamais le CDN du wrapper) et chargé à la demande.
   Limites : terminaux non conservés après rechargement de la page ; fichiers
   texte UTF-8 de 2 Mo maximum. **Terminal en HTTP** (plus de WebSocket, que le
   relais Windows/WSL bloquait) : `server/terminal_http.py`, client
   `lib/terminalApi.ts` ; le WebSocket de `terminal_routes.py` reste en place
   mais n'est plus utilisé par l'écran.
4. ✅ Chats Claude Code maison — fait, à valider par Loïc. Code serveur :
   `server/claude_routes.py` (mêmes barrières que le terminal et les fichiers).
   Un onglet = une session = un sous-processus `claude -p --input-format
   stream-json --output-format stream-json --permission-prompt-tool stdio`,
   lancé avec l'environnement nettoyé (`ANTHROPIC_*` retirés → abonnement,
   `apiKeySource: none` vérifié). Lancé au premier message, arrêté après 10 min
   d'inactivité et repris par `--resume` ; 6 sessions max (la plus ancienne
   inactive est libérée au besoin). Les évènements restent en mémoire serveur :
   un rechargement de page ne perd rien. Transport : HTTP (un POST par action +
   un flux JSON-lignes `GET .../events?after=N`), pas de WebSocket (le relais
   WSL/Windows en bloquait un). Permissions : `claude` envoie `can_use_tool`,
   l'écran affiche Accepter/Refuser ; rien n'est accordé seul ; modes offerts :
   `default`, `acceptEdits`, `plan` (jamais `bypassPermissions`). Front :
   `claudeModel.ts` (réducteur pur), `claudeStore.ts`, `ClaudeChat.tsx`,
   `lib/claudeApi.ts` ; les onglets Claude sont mémorisés (clé `chat`) et
   rattachés à leur conversation au rechargement ; reprise après redémarrage du
   serveur depuis `~/.claude/projects/<dossier>/<id>.jsonl`. Les compteurs
   5 h / 7 j sont alimentés par `rate_limit_event` (`utilization` est une
   **fraction** : 0,03 = 3 %). Limites : pas de diff visuel des modifications,
   pas de pièces jointes, pas de choix du modèle dans l'interface, sous-agents
   masqués, le bouton Stop interrompt le tour (la conversation continue).
5. ✅ Chat « Jarvis » pilote — fait, à valider par Loïc. Le médaillon ouvre un
   tiroir à droite (`JarvisPanel.tsx`) : une session `claude` de type `jarvis`
   (abonnement), **sans aucun outil intégré** (`--tools ""`, pas de Bash ni
   d'écriture) ; elle n'agit que par ses outils MCP (`server/jarvis_mcp.py`,
   table dans `server/jarvis_policy.py`) : `list_workspace`, `find_repos`,
   `open_repo`, `new_claude_tab`, `new_terminal`, `send_prompt`, `read_chat`
   (sûrs) et `create_repo`, `delete_path` (**sensibles**). Tourne toujours en mode `auto` (forcé côté serveur, comme pour le robot téléphone) : sans outil intégré, le vrai contrôle est celui ci-dessous. Règle imposée **en
   code, à deux endroits** : (1) quand `claude` demande un outil, `decide()`
   autorise les outils sûrs, demande à Loïc pour les sensibles (carte
   Accepter/Refuser) et refuse tout le reste ; (2) à l'exécution,
   `POST /v1/jarvis/tool` exige l'accord de Loïc pour *cet appel exact* (usage
   unique, 120 s). `delete_path` ne supprime jamais : déplace vers
   `~/.jarvis-trash` (récupérable) ; dossiers cachés du home protégés. Les
   commandes d'écran passent par un pont (`jarvis_routes.Bridge`) : flux
   `GET /v1/jarvis/commands`, un seul onglet exécute (claim), résultat renvoyé ;
   côté front `JarvisBridge.tsx` + `jarvisBridge.ts`. Le MCP s'authentifie avec
   un secret propre à la session (fichier 0600 dans un dossier 0700, jamais en
   ligne de commande), pas avec le jeton du navigateur. Limites : pas de
   `git push` ni d'envoi de message par Jarvis (à ajouter avec leur
   approbation) ; il ne tape pas dans les terminaux ; une seule fenêtre de
   navigateur doit être ouverte pour que les commandes d'écran aboutissent.
6. ◐ Application de bureau + téléphone — fait en partie, à valider par Loïc.
   **Téléphone** : `server/phone_bridge.py`, robot Telegram privé (appels
   sortants uniquement, aucun port ouvert), réservé à l'identifiant de Loïc
   (expéditeur + conversation privée, sinon ignoré sans réponse), désactivé sans
   `OPENULTRON_PHONE_BOT_TOKEN` et `OPENULTRON_PHONE_OWNER_ID` (anciens noms
   `OPENJARVIS_PHONE_*` acceptés en repli ; les deux préfixes sont retirés des
   enfants, `TELEGRAM_BOT_TOKEN` aussi). Une session
   Jarvis dédiée ; approbations par boutons ; plafonds : 40 messages/h, 2000
   caractères, 15 min par tâche, tâches refusées si l'abonnement dépasse 85 %
   (5 h) ou 95 % (7 j) ; messages reçus hors ligne jetés au démarrage ; jeton
   jamais journalisé (httpx réduit à WARNING). Testé contre un **faux Telegram**
   (40 tests), **jamais contre le vrai** (il faut le jeton de Loïc). **Bureau** :
   choix d'une fenêtre Edge « application » (PWA, `start_url=/workspace`) plutôt
   que Tauri ; commande `jarvis desktop` (`cli/desktop_cmd.py`) : le serveur
   seul sert l'interface construite (sans Node) et ouvre la fenêtre ; lanceur
   `scripts/windows/jarvis.cmd` **non testé sous Windows**.
   Le dossier `frontend/src-tauri` est le bureau **d'origine** (démarre son
   propre serveur, vérifie les mises à jour sur le dépôt d'origine) : **ne pas
   l'utiliser** sans le retravailler. Guide : `docs/windows-et-telephone.md`.

**Journal** (ajouté après l'étape 6) : `server/journal.py`, tout reste local dans
`~/.openjarvis/journal/` — `logs.jsonl` (chaque action : repo ouvert/fermé/changé,
message envoyé à Claude Code, fin de tâche, approbations, terminaux, fichiers
enregistrés, actions de Jarvis ; page Logs, format « 22/11/2026 à 18h52 »),
`memory.jsonl` (un résumé par tâche Claude Code terminée : repo, demande,
fichiers modifiés, réponse ; page Memory) et `usage.json` (dernier 5 h / 7 j vu).
Les compteurs s'affichent dès l'ouverture : valeur enregistrée, puis une lecture
fraîche par **une mini-requête `claude`** (`probe_usage`, modèle `haiku`, sans
outil, au plus toutes les 10 min) car `rate_limit_event` n'arrive qu'avec une
requête. Pas d'appel au jeton OAuth.

**Mémoire par repo** (`server/repo_memory.py`) : un dossier par repo dans
`~/.openjarvis/memory/<repo>/` (`notes.md`, `fonctionne.md`, `ne-fonctionne-pas.md`,
`repo.json`), créé à l'ouverture de la première fenêtre Claude Code du repo. Chaque
fenêtre reçoit (`--append-system-prompt`) la consigne de le lire au début et d'y
noter ce qui marche / ne marche pas (`--add-dir` lui donne accès). **Règle imposée
en code** : la seule action autorisée sans demander est Read/Write/Edit/MultiEdit
d'un fichier *dans le dossier mémoire de son propre repo* (chemin résolu, liens
suivis) ; tout le reste passe par Accepter/Refuser. Page Memory : onglet « Repo
folders » (lecture) + « Task history ». But : un futur agent hebdomadaire en tirera
des skills. Pages Get Started et Settings réécrites : plus rien de l'upstream
(téléchargements, Ollama, clés cloud, mises à jour) ; Settings = compte Claude,
garde-fous, état du robot téléphone (`GET /v1/phone/status`, sans secret), données
locales (`GET /v1/journal/info`).

**Barre de saisie et mode Custom** (`ComposerBar.tsx`, `RulesDialog.tsx`,
`server/custom_rules.py`) : sous la zone de message, une barre façon extension VS
Code : `+` (actions rapides : /compact, /context, /usage, /init), `/` (commandes
annoncées par l'évènement `init` de `claude`), durée de la fenêtre, agents
(sous-agents en cours, types disponibles), modèle + effort (`--model`, `--effort`,
changés par `POST .../settings`, reprise `--resume`), mode de permission. Modes :
**`auto` (par défaut pour les nouvelles fenêtres : `--permission-mode auto`, le contrôle de sécurité de `claude` décide ; ce qu'il escalade passe par Accepter/Refuser ; ce qu'il accepte seul n'est pas interceptable côté serveur)**, `default` (Ask first), `acceptEdits` (Accept edits), **`custom`** (remplace « Plan
only » ; `plan` n'est plus proposé mais reste accepté par le serveur). **Custom
fait tourner `claude` en `default`** (son `acceptEdits` laisse passer `rm`/`mv`/`cp`
sans rien demander) et le serveur décide chaque question : modifications de
fichiers *dans le repo* (jamais `.git`) acceptées ; Bash seulement selon les règles
cochées (lecture seule, tests/builds, git + PR, « toute commande sauf
destructives ») et les listes de l'utilisateur (commandes, suppressions). Une
règle ne s'applique qu'à **une commande simple** (pas de `;` `&&` `|` `$()` hors
guillemets) ; `git push` jamais vers main/master ni avec `--force` ; une
suppression n'est acceptée que si elle est écrite mot pour mot dans la liste.
Règles partagées entre fenêtres (localStorage `jarvis.customRules`, poussées aux
fenêtres Custom ouvertes), tout est décoché par défaut, chaque acceptation
automatique est journalisée (catégorie `rules`). Vérifié avec un vrai `claude`.

**Icône du bureau = démarrer / éteindre** (`server/presence.py`) : `jarvis desktop`
démarre le serveur avec `JARVIS_STOP_WHEN_CLOSED=1` ; la page garde ouverte une
requête `GET /v1/app/presence` (`lib/presence.ts`) ; quand la dernière page est
fermée depuis 30 s, le serveur s'arrête (SIGTERM propre). Jamais d'arrêt : tant
qu'un chat Claude Code travaille ou attend une réponse, si le robot téléphone est
configuré, ni pour un serveur lancé à la main (sans le drapeau). Un serveur dont la
fenêtre ne s'ouvre jamais s'arrête après 3 min. `jarvis desktop` ne remplace
jamais un serveur déjà lancé (arrêt/redémarrage à la main, `jarvis stop`). Vérifié avec un vrai navigateur.

Chaque étape doit être **testable par Loïc** (il fait lui-même les tests
fonctionnels). Ne pas enchaîner l'étape suivante sans qu'il ait pu juger.

## Ce que Claude ne fait jamais ici

- ❌ Pousser sans demande, ou toucher à `main`
- ❌ Réintroduire un suivi d'usage ou un envoi de données vers l'extérieur
- ❌ Ouvrir le terminal ou le pilotage au réseau sans jeton ni restriction
- ❌ Utiliser le jeton de l'abonnement Claude hors de la commande officielle `claude`
- ❌ Inventer un ID, un chemin ou un nom de modèle : en cas de doute, demander
