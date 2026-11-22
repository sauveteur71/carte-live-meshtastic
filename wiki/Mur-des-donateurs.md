# Mur des donateurs

Un bandeau discret sur la carte (et sur la carte publique) remercie ceux qui ont soutenu le projet : « 42B*** 🇫🇷 a donné pour soutenir le projet ». Il se ferme d'une croix (mémorisé dans le navigateur) et disparaît de lui-même en mode urgence. Tout est désactivé par défaut.

## Deux sources, chacune activable séparément
Réglages › **Mur des donateurs** (administrateur) :

- **HelloAsso** (dons à une association). HelloAsso ne dit pas si un donateur a accepté d'être montré publiquement : le mur n'affiche **jamais** un paiement automatiquement. Chaque don est **saisi à la main**, avec la case « le donateur a accepté » obligatoire. 200 dons au plus ; au-delà, l'ajout est refusé (retirez d'anciennes entrées). Les identifiants API (facultatifs) servent seulement à vérifier l'accès depuis la page : la carte lit la **liste des formulaires** de l'association, jamais un paiement nominatif.
- **GitHub Sponsors** : seuls les parrainages que GitHub marque **publics** sont lus (les privés ne sont jamais demandés), 500 au plus. Ces versements vont sur le compte GitHub personnel du titulaire (revenus à déclarer).

Les liens **« Faire un don »** et **« GitHub Sponsors »** du bandeau viennent de ces réglages (organisation et formulaire HelloAsso, compte GitHub) ; une source désactivée n'affiche pas son lien.

## Ce que voit le public
- Le nom est toujours abrégé : au plus la moitié des caractères (1 seul pour un nom de 3 caractères ou moins, 6 au plus), le reste en `***`. « 42BARBE » → « 42B*** », « Jo » → « J*** ».
- Le montant est masqué, sauf si la case « Montant des dons affiché » est cochée.
- Pas de date, pas d'e-mail, pas d'adresse, jamais de clé.

## Secrets et fichiers
- Dans le `.env` : `HELLOASSO_ACTIF`, `HELLOASSO_CLIENT_ID`, `HELLOASSO_CLIENT_SECRET`, `HELLOASSO_ORGANISATION`, `HELLOASSO_FORMULAIRE`, `HELLOASSO_TYPE` (type du formulaire : `Donation` par défaut ; `CrowdFunding`, `Membership`, `Event`, `PaymentForm`, `Checkout`, `Shop`), `GITHUB_SPONSORS_ACTIF`, `GITHUB_SPONSORS_JETON`, `GITHUB_SPONSORS_COMPTE`, `DONATEURS_INTERVALLE_HEURES`.
- Depuis la page : seul ce qui est **saisi dans la page** est enregistré dans `/data/donateurs.json` (droits 600, **volontairement absent des sauvegardes** :
  une sauvegarde est faite pour être copiée ailleurs, elle n'emporte pas vos identifiants. Après une restauration, ressaisissez-les ici, ou
  mettez-les dans le `.env` du serveur — qui, lui, ne quitte jamais la machine — pour qu'ils reviennent seuls. Les dons déjà affichés sont
  relus chez HelloAsso et GitHub : rien n'est perdu). Un secret du `.env` n'y est jamais recopié. Un secret saisi prime sur le `.env` jusqu'au bouton **Effacer**, qui lui rend la main. Un champ laissé vide ne change rien.
- Le journal d'audit note l'ajout d'un don sans le nom du donateur.
