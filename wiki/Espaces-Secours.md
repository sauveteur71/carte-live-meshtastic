# Espaces Secours (DPS, PCS)

Des espaces **séparés de tout le reste de la carte**, pour deux usages :

- **DPS — dispositif prévisionnel de secours** : une association agréée de sécurité civile couvre un festival, une course, une fête locale. Postes de secours, équipes mobiles, interventions.
- **PCS — plan communal de sauvegarde**, pour sa partie radio : une commune, en crise, pointe sur la carte les interventions à faire, suit ses équipes et reçoit ce qui remonte du terrain en LoRa.

Dans les deux cas, on y trouve :

- les **interventions pointées sur la carte** (à faire, en cours, terminée, urgente) ;
- les **équipes et les postes**, avec la **position en direct** du nœud LoRa porté par chaque équipe ;
- une **main courante** horodatée, alimentée aussi par les **messages radio** du terrain, exportable en CSV.

Ce n'est pas un logiciel de rédaction du PCS : le document officiel de la commune, validé par le maire, reste ce qu'il est. L'espace sert à s'en servir sur le terrain quand le téléphone ne passe plus.

## Séparé de la carte et de la section ADRASEC

La [[section ADRASEC|Section-ADRASEC]] reste réservée aux radioamateurs. Les espaces Secours n'ont rien de commun avec elle, ni avec le reste de la carte :

| | Ce qui est séparé |
|---|---|
| **Les données** | Un espace = **un fichier à lui** sur le serveur (dossier `secours/` des données). Rien n'est écrit dans la base de la carte ni dans les données de l'ADRASEC. |
| **Les comptes** | Les comptes d'un espace **n'existent que dans cet espace**. Un secouriste ou un agent communal n'a pas de compte sur la carte : il ne voit ni le réseau radio, ni ses réglages, ni l'ADRASEC, ni un autre espace. |
| **Les nœuds** | Un espace ne voit que les nœuds que l'administrateur de la carte lui a **attribués** (leur position, leurs messages). Un nœud n'appartient qu'à un espace à la fois. |
| **L'administrateur de la carte** | Il crée l'espace, attribue les nœuds et nomme le responsable. Il **n'entre pas** dans l'espace : il ne lit ni les interventions ni la main courante. |

Les fichiers des espaces ne partent **pas** dans les sauvegardes de la carte (elles sont faites pour être copiées ailleurs). Chaque espace garde ses propres copies quotidiennes sur le serveur (`secours/copies/`, 7 jours).

## Mise en route

**Administrateur de la carte**
1. **Outils › ⛑️ Espaces Secours (DPS, PCS)** (ou `https://votre-carte/secours`).
2. **Créer un espace** : son nom, son type (DPS ou PCS), son **adresse** (ex. `festival-2027`), l'identifiant et le mot de passe du **premier responsable**.
3. **Nœuds attribués** : les numéros des nœuds que porteront les équipes (ex. `!a1b2c3d4`), un par ligne ou séparés par des espaces.
4. Donner au responsable l'adresse de l'espace (`https://votre-carte/secours/festival-2027`), son identifiant et son mot de passe.

**Responsable de l'espace** (chef de dispositif, élu ou agent chargé du PCS)
1. Ouvrir l'adresse de l'espace et se connecter.
2. **⚙️ Gestion** : régler l'espace (pour un DPS : lieu, dates, public attendu, catégorie), cadrer la carte sur le site puis **Ouvrir la carte sur la vue actuelle**, créer les **comptes** des équipiers.
3. **👥 Équipes** : créer les postes et les équipes. Pour chacun : son type, son effectif prévu, un **emplacement fixe** (clic sur la carte) et/ou le **nœud LoRa** qu'il porte.

**Équipiers** : ils ouvrent la même adresse avec leur compte, sur téléphone ou ordinateur. Ils voient la carte, les interventions, les équipes et la main courante ; ils changent l'état de **leur** équipe.

## Au quotidien

- **📍 Interventions** : *Nouvelle intervention*, sa nature, un intitulé court, **📍 Pointer sur la carte**. Désigner une équipe la passe *en cours* et l'équipe *en intervention* ; **✓ Terminée** libère l'équipe. N'écrivez ni nom de victime ni information médicale nominative.
- **👥 Équipes** : état de chaque équipe (disponible, en poste, en intervention, en pause, indisponible) et âge de sa dernière position. Un rond = position reçue du nœud ; un carré = emplacement fixe.
- **🗒️ Main courante** : faits, décisions, messages. Les entrées ne se modifient pas ; l'export **CSV** sert de trace après l'événement.

Pour un **DPS**, l'onglet Équipes compare l'effectif prévu à la catégorie choisie (PAPS : 2 · DPS-PE : 4 à 12 · DPS-ME : 12 à 36 · DPS-GE : plus de 36 secouristes). C'est un **repère** : le dimensionnement réel sort de la grille d'évaluation des risques de l'association.

## Depuis le terrain, par radio

Un message texte envoyé par le nœud d'une équipe (application Meshtastic, sur un canal que la carte reçoit) arrive dans l'espace :

| Message | Effet |
|---|---|
| `INTER chute au virage 4` | crée une intervention **à la position du nœud**, confiée à l'équipe |
| `FIN` (ou `FIN victime remise aux pompiers`) | termine l'intervention en cours de l'équipe |
| `DISPO` · `POSTE` · `PAUSE` · `INDISPO` | change l'état de l'équipe |
| tout autre message | est noté dans la main courante, marqué 📻 |

Seuls les messages des nœuds attribués à l'espace sont pris en compte ; ceux des autres nœuds du réseau n'y entrent jamais.

## Questions fréquentes

- **Le responsable a perdu son mot de passe** : l'administrateur de la carte en remet un par **Nommer un responsable / remettre son mot de passe** (même identifiant). Pour un équipier, c'est le responsable de l'espace qui le fait (⚙️ Gestion › Comptes).
- **Supprimer un espace** : ses membres n'y ont plus accès ; son fichier est gardé dans `secours/corbeille/` sur le serveur.
- **Combien de temps les données sont-elles gardées ?** Réglable par le responsable (365 jours par défaut, 7 au minimum) : la main courante et les interventions terminées plus anciennes sont effacées.
- **Une équipe n'apparaît pas sur la carte** : elle n'a ni emplacement fixe ni position reçue. Vérifier que son nœud est attribué à l'espace, choisi dans la fiche de l'équipe, et qu'il envoie sa position.
