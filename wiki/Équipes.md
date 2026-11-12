# Équipes

*Programmer › 👥 Équipes* (administrateur). Pour une institution qui déploie et gère elle-même ses nœuds (secours, association, île…) : chaque équipe a son **canal chiffré**, que le module de la carte **pose ou retire à distance** sur les nœuds des intervenants. Quand un intervenant entre dans une équipe, son nœud reçoit le canal ; quand il en sort, le canal lui est retiré.

## Principe
- Le module de la carte (relié en USB, Wi-Fi ou par l'agent) administre les nœuds **par la radio**, avec l'administration chiffrée du firmware 2.5+ : la **clé publique du module** doit figurer dans les **clés d'administration** de chaque nœud (Programmer › 🔑 Clés d'administration). À faire une fois, à la préparation du nœud.
- Le canal d'équipe est créé avec `uplink` et `downlink` MQTT **désactivés** : les messages de l'équipe ne remontent jamais sur le broker et restent chiffrés (AES-256) entre les nœuds de l'équipe. La carte ne les voit pas : c'est voulu (données personnelles des victimes).
- Le module n'a pas besoin d'avoir le canal de l'équipe : il n'écrit que la configuration des nœuds.

## Créer une équipe
Nom du canal (11 caractères au plus, sans accent ni espace), description, et option **positions des membres sur le canal d'équipe**. La carte génère une clé AES-256 ; on peut aussi importer une clé existante (16 ou 32 octets en base64).

## Ajouter ou retirer des nœuds
- **➕ Ajouter** : identifiants saisis (`!a1b2c3d4, !e5f6a7b8`) et/ou nœuds cochés dans Programmer. Pour chaque nœud, la carte lit ses canaux, pose le canal dans le premier emplacement libre (ou met à jour celui qui porte déjà ce nom), puis **relit pour vérifier** le nom et la clé.
- **Retirer** : le canal est supprimé et les canaux suivants remontent d'un cran (comme `meshtastic --ch-del`), puis relecture.
- Un nœud absent (éteint, hors de portée) est repris **toutes les 10 min pendant 2 h** ; ensuite **↻ Renvoyer aux nœuds pas à jour**.
- Chaque nœud affiche son état : ✔ à jour (emplacement du canal), ⏳ en attente, ⚠ échec avec la raison.

## Demander les positions
**📍 Demander les positions** : chaque nœud de l'équipe renvoie sa position (une demande toutes les 3 s pour ne pas saturer le canal). Les réponses s'affichent en bas de l'écran ; un clic centre la carte sur le nœud. Pour un seul nœud : clic droit sur le nœud › **📍 Demander sa position** (gestionnaire), comme « Demander la position » dans l'appli. Le nœud doit avoir sa position activée et recevoir le module de la carte (canal principal en commun, ou clé publique échangée).

### Suivi automatique
**Suivi des positions** (à la demande, ou toutes les 5, 10, 15, 30 ou 60 min) : la carte demande leur position aux membres à cet intervalle. Chaque membre affiche l'âge de sa dernière position (« voir » centre la carte). Un membre **sans nouvelle** (position plus vieille que 3 intervalles, 30 min au moins) est signalé en rouge et dans les alertes du réseau. Chaque demande est un paquet radio : gardez un intervalle raisonnable.

## Nœud perdu ou volé : nouvelle clé
Retirer un nœud n'efface le canal **que s'il est joignable**. Pour un nœud perdu, volé ou qui ne répond plus : retirez-le de l'équipe, puis **🔑 Nouvelle clé** (taper `NOUVELLE CLE`). Tous les membres reçoivent la nouvelle clé ; l'ancien nœud ne comprend plus rien. Tant qu'un membre n'a pas reçu la nouvelle clé, il ne comprend plus les autres : renvoyez-la jusqu'à ce que tous soient à jour.

## Exporter la clé
**⬇ Exporter la clé** (inscrit dans l'historique des opérations) :
- **fichier `NOM.cle`** (clé en base64) pour la ligne de commande ;
- **lien de canal** pour l'appli Meshtastic (ajoute le canal sans toucher aux autres), pour un nœud préparé à la main.

## Équivalent en ligne de commande (meshtastic CLI)
Depuis le module (`--port /dev/ttyUSB0` ou `--host IP`), vers le nœud d'un intervenant :
```
# poser le canal avec la clé de l'équipe (ne pas utiliser --ch-add : il tire une clé au hasard sur chaque nœud)
meshtastic --host 192.168.1.50 --dest '!a1b2c3d4' --ch-index 1 \
  --ch-set name Equipe1 --ch-set psk base64:$(cat Equipe1.cle) \
  --ch-set uplink_enabled false --ch-set downlink_enabled false
# ou avec le lien de canal exporté
meshtastic --host 192.168.1.50 --dest '!a1b2c3d4' --ch-add-url 'https://meshtastic.org/e/?add=true#…'
# retirer (les canaux suivants remontent d'un cran)
meshtastic --host 192.168.1.50 --dest '!a1b2c3d4' --ch-index 1 --ch-del
# verrouiller le nœud : seule l'administration à distance peut le modifier
meshtastic --host 192.168.1.50 --dest '!a1b2c3d4' --set security.is_managed true
```

## Sécurité des clés sur le serveur
- Les clés des équipes sont **chiffrées** (AES-256-GCM) dans `equipes.json` avec une clé maîtresse : la variable **`CLE_EQUIPES`** du `.env` (une phrase longue ou une valeur aléatoire, par ex. `openssl rand -base64 32`), sinon un fichier `cle-equipes.bin` créé automatiquement dans le dossier de données.
- `equipes.json` est inclus dans les sauvegardes, **pas** `cle-equipes.bin` : pour pouvoir restaurer les équipes sur une autre installation, définissez `CLE_EQUIPES` **avant** de créer la première équipe et conservez-la à part. Changer `CLE_EQUIPES` ensuite rend les clés illisibles (la carte le signale : créez une nouvelle clé).
- La clé n'apparaît jamais dans la liste des équipes, les opérations enregistrées, les journaux ni l'historique ; seul l'export (administrateur) la montre.
- Les lectures de configuration gardées par la carte (Programmer › Lire) contiennent les canaux lus, clés comprises, comme pour les autres canaux : protégez le dossier de données.
