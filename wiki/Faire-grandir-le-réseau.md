# Faire grandir le réseau

Deux outils pour amener de nouveaux nœuds dans le réseau : repérer ceux qui sont réglés autrement, et leur donner une page claire pour vous rejoindre.

## Nœuds à inviter (autre preset)

*Outils › Réseau › 📣 Nœuds à inviter* (administrateur).

Un nœud réglé sur un autre preset que le vôtre (par exemple LongFast alors que le réseau est en LongModerate) n'entend pas le réseau, et le réseau ne l'entend pas. La carte le connaît quand même par MQTT : par son rapport de carte (preset exact) ou par le nom de son canal principal (preset déduit).

- Sur la carte, ces nœuds ont un **anneau orange en pointillés** ; leur fiche porte un badge du preset.
- Le panneau liste les nœuds vus ces 30 derniers jours, du plus proche au plus lointain.
- **Inviter** : un petit module réglé sur leur preset, relié à la carte **en écoute** (une « sentinelle », *Outils › Connecter un module › en écoute, en plus*), leur envoie un message direct que vous relisez avant l'envoi (200 octets au plus). Quand la page « Rejoindre le réseau » est publiée, l'invitation propose son adresse.

## Page « Rejoindre le réseau »

*Outils › Réseau › 🤝 Page « Rejoindre le réseau »* (administrateur). La page publique s'ouvre à l'adresse `/rejoindre` de votre carte, sans compte. Elle est pensée pour les nouveaux venus et pour l'impression (affiche, flyer). Elle s'inspire de la page de Mesh Hessen.

Elle montre, dans l'ordre :

1. **Le canal Meshtastic** : QR code à scanner dans l'appli, bouton « Ouvrir dans l'appli » sur téléphone, région, preset du réseau (affiché tout seul) et limite de sauts conseillée.
2. **Les rôles recommandés** : par défaut CLIENT, CLIENT_MUTE, et ROUTER seulement aux points hauts après accord.
3. **Les réglages MeshCore** (fréquence, bande passante, SF, CR), si vous les remplissez.
4. **Les règles du réseau**, une par ligne.
5. **Les antennes testées** sur le réseau.
6. **Les relais du secteur** entendus ces 7 derniers jours (Meshtastic ROUTER / REPEATER, répéteurs et room servers MeshCore), avec un lien vers la carte publique.
7. **Contact et dons** : votre texte et un bouton vers votre page de dons.
8. Un **QR code de la page elle-même**, pour l'imprimer.

Le bouton **📡 Prendre le canal principal du module de la carte** remplit le lien du canal (avec les réglages LoRa) depuis le module relié à la carte. Vous pouvez aussi coller un lien `https://meshtastic.org/e/#…` copié depuis l'appli Meshtastic.

> ⚠️ Le lien de canal contient la **clé du canal** : une fois la page publiée, cette clé est publique. C'est le but pour un canal d'accueil, mais ne publiez pas ainsi un canal privé.

La page n'est visible qu'une fois la case **Page publiée** cochée. La carte publique affiche alors un bouton orange **🤝 Rejoindre le réseau**.
