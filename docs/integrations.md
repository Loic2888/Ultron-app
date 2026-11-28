# Intégrations d'Ultron

Deux façons d'atteindre tes comptes, selon qui parle.

## 1. Les fenêtres Claude Code (déjà branchées)

Chaque fenêtre lance `claude` avec ton abonnement, sans `--strict-mcp-config` :
elle voit donc **tous les connecteurs de ton compte Claude** (Gmail, Google
Calendar, Drive, Docs, Linear, Slack, Vercel, Supabase, Figma, ClickUp,
Granola…) et les serveurs MCP de `~/.claude.json` (par projet : Linear, Vercel,
Supabase). Vérifié avec l'environnement nettoyé de l'app (`claude mcp list`).
GitHub : `gh` est déjà connecté, les fenêtres l'utilisent par Bash.

Les validations restent celles du mode choisi (Accepter/Refuser). Rien à coder.

## 2. L'assistant Ultron (bouton médaillon et téléphone)

Il n'a aucun outil intégré ; il agit par les outils de `server/jarvis_policy.py`,
exécutés par `server/integrations.py`.

| Outil | Risque | Ce qu'il fait |
|---|---|---|
| `github_overview` | lecture | mes PR ouvertes, celles à relire |
| `github_list` | lecture | PR ou tickets d'un repo |
| `github_pr` | lecture | état d'une PR et de ses vérifications |
| `ask_connectors` | lecture | question sur mail, agenda, Linear, Slack, Vercel, Drive, réunions (liste fixe d'outils en lecture seule ; peut laisser un **brouillon** Gmail) |
| `github_comment` | **approbation** | commentaire sur une PR ou un ticket |
| `git_push` | **approbation** | pousse la branche de travail (jamais main/master, jamais forcé) |
| `github_create_pr` | **approbation** | ouvre une PR depuis la branche poussée |
| `mail_send` | **approbation** | envoie un mail en texte simple (1 à 5 destinataires) |
| `calendar_create_event` | **approbation** | crée un évènement Google Agenda (connecteur déjà branché ; les invités reçoivent une invitation) |

Garde-fous, imposés en code (comme `create_repo` / `delete_path`) :
- l'approbation porte sur **l'appel exact** (usage unique, 120 s) ; la carte
  Accepter/Refuser montre le texte complet du mail, du commentaire, la branche ;
- `git_push` refuse `main`/`master`, refuse si le repo n'est pas sur la branche
  approuvée, n'utilise jamais `--force` ;
- aucun argument ne passe par un shell ; le texte des commentaires/PR passe par
  l'entrée standard ; `owner/name` est validé (pas de tiret en tête) ;
- le jeton GitHub reste dans `gh` ; le mot de passe mail reste dans l'environnement
  du serveur et est retiré des processus enfants (préfixe `OPENULTRON_`) ;
- les textes lus dans un mail ou une PR sont des **données**, jamais des ordres
  (consigne + liste d'outils sans écriture).

État visible dans Settings → « Accounts Ultron can use » (`GET /v1/integrations/status`).

## Actions manuelles pour toi (guide pas à pas : `docs/guide-mail-et-agenda.md`)

1. **Redémarrer** le serveur : `jarvis stop`, puis rouvrir l'app (le code Python
   n'est lu qu'au démarrage) ; reconstruire l'interface : `cd frontend && npm run build`.
2. **GitHub** : rien si `gh auth status` est vert (c'est le cas). Pour pouvoir
   commenter et ouvrir des PR : le jeton de `gh` doit avoir le droit `repo`
   (`gh auth refresh -s repo`).
3. **Envoi de mail** (optionnel) : créer un mot de passe d'application chez ton
   fournisseur (Google : compte → Sécurité → validation en 2 étapes → mots de
   passe d'application), puis dans `.env.local` :
   ```
   OPENULTRON_MAIL_SMTP_HOST=smtp.gmail.com
   OPENULTRON_MAIL_SMTP_PORT=587
   OPENULTRON_MAIL_USER=loic.cerqueira@youno.fr
   OPENULTRON_MAIL_PASSWORD=<mot de passe d'application>
   ```
   Sans cela, Ultron lit le mail par le connecteur Gmail et prépare des brouillons
   (tu envoies depuis Gmail).
4. **Connecteurs à autoriser** (claude.ai → Paramètres → Connecteurs) si tu les
   utilises : Notion, Atlassian, Asana, Todoist, HubSpot, Canva, Airtable,
   monday.com… sont « à authentifier ». Une fois autorisés, les fenêtres Claude
   Code les voient aussitôt. Pour qu'Ultron les lise aussi, il faut ajouter leurs
   outils en lecture dans `READ_ONLY_CONNECTOR_TOOLS` (volontairement une liste
   fermée).
