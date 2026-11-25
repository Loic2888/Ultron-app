# framework/

Éléments repris de MyFramework (kit personnel) et utiles au développement de Jarvis.
Ce dossier est une **réserve de référence**, rien ici n'est actif automatiquement.

| Élément | Sert à |
|---|---|
| `hooks/git-guardrail.py` | Logique de blocage des `git push` risqués (lit les destinations, pas le mot « main »). Modèle pour la classification des actions qui demandent une validation dans l'app. `python3 hooks/git-guardrail.py --selftest` → 29 cas. |
| `settings.json` | Liste noire d'opérations irréversibles (`rm -rf`, `git reset --hard`, force-push…). Point de départ pour les règles de Jarvis. |
| `AGENTS.md.template`, `GUARDRAILS.md` | Contrat d'autonomie : se relire, regarder avant de supprimer, ne jamais toucher `main`. |
| `rules/` | Flux git/PR, tickets, constitution du projet, routage. |
| `commands/myteam.md` | Orchestrateur + spécialistes à périmètre de fichiers strict : modèle pour Jarvis (chef) pilotant plusieurs chats Claude Code. |
| `commands/apex-converge.md` | Vérifie que le code correspond aux critères des tâches (verdict binaire). |
| `skills/apex/` | Méthode Analyze · Plan · Execute · eXamine. |

Volontairement non repris : règles produit (français, RGPD, UE, multi-tenant), commandes `saas-*`,
module HubSpot — hors sujet pour un outil local mono-utilisateur.
