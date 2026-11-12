# Versions et compatibilité

La carte suit les **versions stables** des firmwares. Les versions de test (alpha) sont décodées dès que possible, mais ne sont pas conseillées sur un réseau en service.

## Meshtastic
- **Conseillé : la dernière 2.7 stable** (2.7.26 en novembre 2026). Firmware 2.5 au moins pour l'administration à distance chiffrée (clés d'administration, équipes) ; 2.7.11 au moins pour les **favoris entre relais** (sauts gratuits, « Zero-Cost Hops »).
- **Série 2.8 (alpha, en test)** : la carte la reconnaît déjà.
  - **Paquets signés** : quand la passerelle qui reçoit un paquet a vérifié la signature de l'expéditeur, le paquet porte le badge **✍ signé** dans le trafic et dans son détail.
  - **Position privée par défaut** : un nœud passé en 2.8 sans réglage de sa position peut ne plus apparaître à sa place sur la carte. Ce n'est pas une panne de la carte : il faut rendre la position publique sur le nœud (canal principal, précision de position).
  - **Nouveaux presets** connus de la carte (noms, calculs de portée et de temps d'antenne) : MediumTurbo (hors bande EU_868), presets *Lite* de la région EU_866 et *Narrow* (62,5 kHz) de la région **EU_N_868**. NarrowSlow et NarrowFast sont proposés dans l'étude de couverture.
  - *Gérer › Firmware* liste à part les relais déjà en 2.8, et ne propose que la dernière version **stable** par défaut.
  - La 2.8.0 a été retirée par Meshtastic (défaut de signature) : ne pas l'installer, passer à 2.8.1 ou plus si vous testez la série 2.8.
- Les définitions de messages (protobufs) de la carte sont alignées sur celles de Meshtastic de novembre 2026 : les champs nouveaux sont lus, les anciens firmwares restent compris.

## MeshCore
- La carte lit le protocole radio et le protocole companion de MeshCore (répéteurs, room servers, capteurs) et suit les firmwares **1.x** stables. Les versions 1.16 à 1.18 (contrôle du flood en Europe, nouvelle écoute avant émission, configuration en JSON, nœuds capteurs) ne changent pas ce que la carte utilise. Elles n'ont pas encore été essayées une à une avec l'administration à distance de la carte : en cas d'écart, le journal de l'opération montre la réponse du répéteur.
- Réglage français conservé : 869,618 MHz, 62,5 kHz, SF8, CR8 (étude de couverture : « MeshCore France »).

## Ce qui est suivi, pas encore utilisé
- Intégration TAK (ATAK / iTAK) de l'appli Meshtastic iOS.
- pyMC (MeshCore en Python sous Linux), modem KISS, mode « Companion Repeat ».
- Interface embarquée BaseUI des nœuds à écran.

Elles seront prises en compte quand elles seront stables et utiles à la carte.
