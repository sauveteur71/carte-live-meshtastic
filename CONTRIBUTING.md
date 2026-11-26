# Contribuer à Carte live Meshtastic

Merci de l'intérêt porté à ce projet ! Il est développé et maintenu bénévolement, toute aide est bienvenue.

## Avant d'ouvrir une issue

- Vérifiez d'abord les [issues existantes](https://github.com/sauveteur71/carte-live-meshtastic/issues) et les [discussions](https://github.com/sauveteur71/carte-live-meshtastic/discussions) : votre question ou votre bug a peut-être déjà une réponse.
- Pour une question d'usage, un retour d'expérience ou une idée encore floue → **Discussions** plutôt qu'une issue.
- Pour un bug reproductible ou une demande de fonctionnalité précise → **Issue**, avec le modèle fourni.

## Signaler un bug

Merci d'indiquer :
- la version du programme (`v2.x.x`, visible dans l'interface ou dans `docker compose logs`) ;
- édition France ou édition internationale ;
- les étapes pour reproduire, et ce qui était attendu ;
- les logs pertinents (`docker compose logs -f`), sans oublier de retirer tout identifiant ou donnée personnelle avant de les coller.

## Proposer du code

1. Forkez le dépôt et créez une branche depuis `main` (`git checkout -b ma-fonctionnalite`).
2. Gardez les commits ciblés et les messages explicites.
3. Si le changement touche le décodage radio, la base de données ou l'API, testez-le sur une instance locale avant la pull request.
4. Ouvrez la pull request en décrivant le problème résolu et la façon de tester le changement.
5. Soyez patient⋅e : le projet est maintenu sur du temps bénévole, les retours peuvent prendre quelques jours.

## Traductions

L'interface est traduite dans plusieurs langues (seize sur l'édition internationale). Une correction ou un ajout de traduction est toujours bienvenu via pull request sur les fichiers de langue correspondants.

## Code de conduite

Soyez respectueux⋅ses dans les échanges : ce projet sert aussi des usages de sécurité civile et de secours, la bienveillance et la rigueur y comptent autant que le code.
