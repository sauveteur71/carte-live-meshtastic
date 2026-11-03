# Comptes et sécurité

## Rôles
- **Administrateur** : tout, y compris le module radio, les réglages et les comptes.
- **Gestionnaire de secteur** : programme à distance, remplit la fiche d'installation et teste **uniquement les nœuds de son secteur** (*Gestion › Comptes › Secteur…*).
- **Membre** : voit les messages et les positions exactes.
- **Public** : sans compte, positions des particuliers arrondies, pas de messages.

Inscriptions : fermées, sur validation ou ouvertes (*Gestion › Réglages*).

## Protéger les comptes
- **Double authentification** (application TOTP : Google Authenticator, Aegis, 2FAS…) dans *Mon compte*. Recommandée pour tous ceux qui programment des relais.
- **Déconnecter mes autres appareils** en cas de perte.
- **Journal d'audit** (*Gestion › Journal*) : connexions, refus, programmation, comptes, réglages. Les mots de passe n'y figurent jamais.

## Réseau
- **Port 4404 (agents)** : jamais ouvert sur Internet ; réseau local ou VPN (Tailscale).
- Derrière un proxy inversé, une requête n'est jamais considérée comme « locale » : l'installation demande alors toujours un code.
- Les clés des canaux et les mots de passe MeshCore sont gardés dans des fichiers privés du serveur, et sauvegardés chaque nuit (*Gestion › Sauvegardes*).
