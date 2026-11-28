# Guide : envoi de mail et écriture dans l'agenda

## A. Écriture dans Google Agenda — rien à configurer

Le connecteur « Google Calendar » est déjà connecté à ton compte Claude
(`claude mcp list` : ✔ Connected). Ultron crée l'évènement par ce connecteur ;
**tu valides avant** : la carte (écran ou Telegram) montre le titre, les heures,
le lieu et les invités.

Pour essayer, après `jarvis stop` et réouverture de l'app, écris à Ultron :
« Ajoute demain à 14h30 un point projet d'une demi-heure. »
Un évènement avec invités envoie une invitation : vérifie la liste sur la carte.

Si l'évènement n'apparaît pas : ouvre claude.ai → Paramètres → Connecteurs et
vérifie que Google Calendar est bien connecté.

## B. Envoi de mail — 5 minutes

Répartition choisie : **lecture = boîte pro** (connecteur Gmail déjà branché sur
`loic.cerqueira@youno.fr`), **envoi = Gmail perso** `cerqueira.loic88@gmail.com`
(SMTP). Ultron envoie avec **un mot de passe d'application** (jamais ton vrai
mot de passe). Sans cela, il lit tes mails et prépare des **brouillons** ; tu
envoies toi-même.

### Compte Google (perso)
1. Va sur https://myaccount.google.com/security avec `cerqueira.loic88@gmail.com`.
2. Active la **validation en 2 étapes** si ce n'est pas fait.
3. Ouvre https://myaccount.google.com/apppasswords, nom : `Ultron`, puis
   **Créer**. Copie les 16 caractères (sans espaces).
4. Si la page n'existe pas, la validation en 2 étapes n'est pas active : active-la
   d'abord (étape 2).

### `.env.local` (dans /home/alkemia/Ultron-app)
```
OPENULTRON_MAIL_SMTP_HOST=smtp.gmail.com
OPENULTRON_MAIL_SMTP_PORT=587
OPENULTRON_MAIL_USER=cerqueira.loic88@gmail.com
OPENULTRON_MAIL_PASSWORD=<les 16 caractères>
```
Facultatif : `OPENULTRON_MAIL_FROM=<adresse d'expédition>`.

### Mise en route
1. `jarvis stop`, puis rouvre l'app (les variables ne sont lues qu'au démarrage).
2. Settings → « Accounts Ultron can use » → **Sending mail : Ready**.
3. Essai : « Envoie-moi un mail de test avec l'objet Essai. » Vérifie le texte sur
   la carte avant d'accepter.

### À savoir
- Un seul compte d'envoi est géré : le perso. Les mails partent donc de
  `cerqueira.loic88@gmail.com`.
- Les **brouillons** préparés par Ultron passent par le connecteur : ils arrivent
  dans la boîte **pro**. Dis « envoie » (mail parti du perso) ou « prépare un
  brouillon » (dans le pro, tu envoies toi-même).
- Le mot de passe n'est jamais affiché ni transmis aux fenêtres Claude Code
  (préfixe `OPENULTRON_` retiré de leur environnement).
- Max 5 destinataires, texte simple, pas de pièce jointe.
- Pour révoquer : supprime le mot de passe d'application dans ton compte Google.
