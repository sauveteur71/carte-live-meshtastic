# Capteurs LoRaWAN

Couche **en option** qui affiche sur la carte les capteurs LoRaWAN d'une application **The Things Network (v3)** ou **ChirpStack (v4)** : dernières mesures, courbe sur 24 h, passerelles qui les ont reçus et qualité du signal. La carte **s'abonne en lecture seule** au MQTT de l'application : elle n'envoie rien aux capteurs.

LoRaWAN et Meshtastic utilisent la même modulation LoRa mais ne se parlent pas : un capteur LoRaWAN passe par une passerelle et un serveur réseau (TTN, ChirpStack), pas par le maillage. Cette couche réunit les deux sur la même carte, par exemple une sonde de niveau de rivière, une station météo ou un pluviomètre à côté des relais Meshtastic.

## Sans matériel ?

Il faut au moins **une application TTN qui reçoit des capteurs**. Créer un compte et une application sur TTN est gratuit, mais sans capteur il n'y a rien à afficher. Pour voir l'eau des rivières sans matériel, utiliser plutôt la couche [[Rivières|Rivières-et-alerte-crue]].

## Mise en route (The Things Network)

1. Sur la console TTN, ouvrir l'application › **Intégrations › MQTT** : noter l'identifiant (`mon-appli@ttn`).
2. **Clés d'API** › ajouter une clé avec le droit **« Read application traffic »** seulement. Copier la clé (`NNSXS.…`), elle ne s'affiche qu'une fois.
3. Dans la carte : **Réglages avancés › LoRaWAN (capteurs)** :
   - *Afficher les capteurs LoRaWAN* : oui ;
   - *Serveur MQTT* : `mqtts://eu1.cloud.thethings.network:8883` (par défaut) ;
   - *Identifiant MQTT* : `mon-appli@ttn` ;
   - *Clé d'API* : la clé créée (enregistrée comme secret, jamais réaffichée).
4. Les capteurs apparaissent à leur prochaine remontée (bouton **Capteurs LoRaWAN** de la carte).

Les mesures viennent du **formateur de charge utile** (*payload formatter*) de l'application : sans lui, la fiche indique « Aucune mesure décodée ».

## ChirpStack

Serveur MQTT : l'adresse du broker de ChirpStack (ex. `mqtt://192.168.0.10:1883`), avec son identifiant et son mot de passe. Les sujets `application/+/device/+/event/up` sont écoutés par défaut. Les mesures viennent du codec de l'application.

## Position des capteurs

Un capteur qui envoie `latitude`/`longitude` dans ses mesures, ou dont la position est saisie dans TTN, est placé automatiquement. Pour les autres, réglage *Position des capteurs fixes* :

```
niveau-borne=45,04;3,88 | meteo-mezenc=44,92;4,19
```

## Alertes

Réglage *Seuils d'alerte* : `capteur.mesure > valeur` ou `< valeur`, séparés par des points-virgules. Sans nom de capteur, le seuil vaut pour tous.

```
niveau-borne.hauteur > 150 ; batterie < 3,3
```

Une alerte apparaît dans la carte (et sur Home Assistant / Prometheus si branchés) tant que la dernière mesure, de moins de 6 h, dépasse le seuil. Une alerte « serveur MQTT injoignable » apparaît après 30 min de coupure.

## Qui voit la couche

Par défaut, **seuls les membres connectés**. Réglage *Montrer les capteurs aux visiteurs* : oui pour l'ouvrir à tous.
