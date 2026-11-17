# Radioamateurs, APRS, ATAK et registre des relais

## Stations APRS (dont LoRa APRS)
La couche **Stations APRS** (menu Couches) affiche les stations APRS du secteur : traqueurs, iGates et digipeaters **LoRa APRS** (433,775 MHz) en violet, autres stations APRS (VHF 144,800 MHz, internet) en bleu. Un clic donne l'indicatif, le commentaire, l'altitude, l'iGate qui l'a relayée et un lien vers aprs.fi.

À activer dans *Réglages avancés › APRS (radioamateurs)* :
- **Afficher les stations APRS du secteur** : oui.
- **Indicatif** : le vôtre, **obligatoire** (la couche ne démarre pas sans lui).
- **Serveur** : `rotate.aprs2.net:14580` par défaut.
- **Garder seulement les stations LoRa APRS** : au choix.

La carte se connecte au réseau mondial **APRS-IS en lecture seule** (`pass -1`) : elle n'émet rien et n'a besoin d'aucun mot de passe. Elle ne demande que la zone de la carte (département et voisins). Les positions au format Mic-E (portatifs et mobiles Kenwood, Yaesu…) sont lues ; celles des messages et de la télémétrie ne le sont pas. Si vous changez de département, la zone suivie est mise à jour dans les 10 minutes.

## Nœuds en mode licencié
Un nœud Meshtastic réglé en **mode licencié** (radioamateur) porte le badge **📻 Radioamateur** dans sa fiche. En mode licencié, les messages ne sont **pas chiffrés** (le chiffrement est interdit en radioamateur) et le nœud s'identifie par son indicatif : il ne peut donc pas lire les canaux chiffrés du réseau.

Rappel : **868 MHz n'est pas une bande radioamateur** en Europe. Le LoRa radioamateur se fait en 70 cm (433,775 MHz pour LoRa APRS) ou en 13 cm (2,4 GHz), dans le respect du plan de bande du REF.

## Export pour ATAK
*Exports* (fenêtre Intégrer / exporter) :
- **Réseau pour ATAK et Google Earth (KML)** : relais et passerelles, autres nœuds actifs, liaisons radio des dernières 24 h colorées selon le SNR. Dans ATAK : *Import Manager › Local SD* (ou envoyer le fichier sur le téléphone).
- **Réseau en direct (lien KML)** : petit fichier qui recharge le réseau chaque minute. L'appareil doit pouvoir joindre la carte (même réseau local, ou Tailscale).

Les mêmes règles de confidentialité que la carte publique s'appliquent (positions des particuliers arrondies, aucun message). Si un jeton d'export est réglé, ajouter `?jeton=…` à l'adresse.

## Calculette des pertes de câble
Dans la **fiche d'installation** d'un relais et dans **Profil et bilan de liaison**, le bouton **🧮 Calculer** à côté des pertes de câble donne la perte à partir du **type de câble** (RG58, RG213, LMR-400, Aircell 7, Ecoflex…), de la **longueur**, du **nombre de connecteurs** et d'un éventuel **parafoudre**. « Utiliser » reporte la valeur dans le champ ; elle sert ensuite à la couverture, au plan et à Relier.

Valeurs typiques autour de 870 MHz ; vérifier la fiche du câble. Un câble court et épais vaut souvent mieux qu'une antenne à plus fort gain.

## Registre des relais
*Outils › 🗂️ Registre des relais* rassemble, pour chaque relais et passerelle :
- le **site**, l'**autorisation** (accord écrit, convention, accord oral, demande en cours, aucune, pas nécessaire) et sa date ;
- la **zone protégée** éventuelle (abords d'un monument historique, site classé, littoral, Natura 2000, parc ou réserve) ;
- la **dernière visite** sur place (orange au-delà de 6 mois, rouge au-delà d'un an) ;
- l'**énergie** (alimentation, batterie, panneau), le **firmware** et le dernier paquet entendu.

Les relais sans autorisation écrite et ceux non visités depuis plus d'un an sont comptés en tête. **Exporter le registre (CSV)** l'ouvre dans un tableur ; le propriétaire du site et le contact n'y figurent que pour un administrateur.

Ces informations se saisissent dans la fiche du nœud, rubrique **Installation** › *Site*. Voir aussi [[Couverture et sites]] : un point haut n'est pas un site autorisé.
