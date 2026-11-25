# Socle du kit — règles et garde-fous

> Doc de référence du noyau installé par `../install.sh`.
> Ce fichier reste dans MyFramework, il ne s'installe pas.

**les règles**, pas les outils. C'est ce qui faisait que Claude créait la branche
et ouvrait la PR sans que tu lances quoi que ce soit.

Version générique, zéro donnée d'entreprise dedans.

## Ce qu'il y a dans le dossier

| Fichier | Va où | Chargé quand |
|---|---|---|
| `CLAUDE.md` | **racine** du projet | À chaque démarrage de session, automatiquement |
| `rules/git-pr.md` | `.claude/rules/` | Quand Claude en a besoin (pointé depuis `CLAUDE.md`) |
| `rules/tickets.md` | `.claude/rules/` | Idem |
| `rules/constitution.md` | `.claude/rules/` | Idem — ce qu'est la constitution du projet et le contrôle qui la fait appliquer |
| `settings.json` | `.claude/` | Au démarrage — c'est lui qui branche le hook |
| `hooks/git-guardrail.py` | `.claude/hooks/` | Avant **chaque** commande bash de Claude |

Les garde-fous critiques sont volontairement **dans `CLAUDE.md`** et pas dans
`rules/` : ce fichier est le seul dont le chargement est garanti à chaque
session. Les fichiers de `rules/` sont ouverts à la demande — parfait pour le
détail et le pourquoi, trop incertain pour une règle non négociable.

## Installation

Ne copie plus les fichiers à la main : l'installeur du kit s'en charge, sans
rien écraser.

```bash
cd MyFramework
./install.sh /chemin/vers/le/projet
```

Il place `CLAUDE.md` à la racine du projet, `rules/`, `hooks/` et
`settings.json` dans `.claude/`, puis lance le `--selftest` du hook.

⚠️ **Si `.claude/settings.json` existe déjà**, il ne l'écrase pas : il affiche
le bloc `hooks` à recopier dedans. Écraser ce fichier ferait sauter les
permissions et la config MCP du projet.

Puis **relance la session Claude Code** : les hooks sont lus au démarrage, et
un hook nouvellement déclaré demande une validation avant de s'activer.

## À remplir avant de s'en servir

Un template à moitié rempli est pire que pas de template : Claude suit des règles
fausses avec la même conviction que des vraies.

1. **`CLAUDE.md`** — tous les `<…>`. En particulier le tableau **Commandes** :
   les noms doivent correspondre à ton `package.json`, sinon Claude « valide »
   dans le vide.
2. **`CLAUDE.md` garde-fou n°6** — ta règle non négociable propre au projet,
   ou supprime la ligne.
3. **`rules/tickets.md`** — le tracker, le projet, les domaines de labels.
   Supprime les sections qui ne s'appliquent pas.
4. **`hooks/git-guardrail.py`**, bloc `CONFIG` en haut :
   - `PROTECTED` — par défaut `main` et `master`
   - `PROMOTIONS` — laisse vide sauf si tu as une branche de déploiement
     (ex. prod en fast-forward de `main` : `PROTECTED` ajoute `"production"`,
     et `PROMOTIONS = {("main", "production")}`)
   - `ENFORCE_CONVENTIONAL_COMMITS` — passe à `False` si tu ne veux pas de
     contrainte sur les messages
   - `BRANCH_HINT` — le format affiché quand un push est refusé

## Ce que le hook bloque

Bloqué (exit 2, Claude reçoit l'explication et se corrige) :

```
git push origin main              git push origin HEAD:main
git push                          (depuis main)
git push --force origin main      git push origin --delete main
git push --all origin             git commit -m "corrige le bug"
```

Autorisé :

```
git push -u origin loic/42-oauth-refresh      git push --force-with-lease
git push -u origin loic/42-fix-main-menu      (le mot "main" dans un slug ne compte pas)
git commit -m "fix: corrige le calcul de TVA"
git commit -m "Merge branch main"             (message généré par git)
echo "git push origin main"                   (une commande citée n'est pas exécutée)
```

Le hook lit les refspecs plutôt que de chercher le mot « main » dans la ligne :
c'est ce qui évite de bloquer une branche nommée `fix-main-menu`. Les 29 cas de
test couvrent ces distinctions — lance `--selftest` après toute modification.

## Limites, dites franchement

- **Ça ne protège que les sessions Claude Code.** Toi, dans ton terminal, tu
  pousses ce que tu veux. La vraie protection reste la *branch protection* côté
  GitHub — le hook évite l'accident, il ne remplace pas le serveur.
- **Entrée illisible = commande autorisée.** Le hook ne bloque jamais sur un
  doute technique (JSON invalide, timeout git). Choix assumé : un garde-fou qui
  bloque au hasard finit désactivé.
- **La vérification des commits est statique.** Un message construit à
  l'exécution (`-m "$(...)"` sans heredoc) n'est pas inspectable, donc passe.
- **Les fichiers de `rules/` ne sont pas garantis chargés.** Ce qui ne peut pas
  être raté va dans `CLAUDE.md`. C'est aussi pourquoi la constitution du projet
  — garde-fous, règles produit, principes — vit dans `CLAUDE.md` et pas dans un
  fichier à part : `rules/constitution.md` ne porte que la **méthode** du
  contrôle, jamais les règles elles-mêmes.
- **Le contrôle constitutionnel n'est pas un hook.** Contrairement au garde-fou
  git, rien ne l'exécute de force : c'est une consigne, et une consigne peut
  être oubliée. Il couvre les décisions — PRD, archi, tâches, plan d'apex — là
  où un hook ne sait rien voir. Les deux se complètent, aucun ne remplace
  l'autre.
