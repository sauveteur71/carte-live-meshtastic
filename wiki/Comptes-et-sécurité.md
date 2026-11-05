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

## Blocage après des échecs de connexion
La carte étant accessible depuis Internet, les essais de mots de passe sont freinés :
- **3 échecs en 15 min depuis une même adresse** : l'adresse est bloquée 15 min. Chaque récidive dans les 24 h double la durée (30 min, 1 h… jusqu'à 24 h).
- **3 échecs en 15 min sur un même compte**, d'où qu'ils viennent : la connexion à ce compte est suspendue 15 min (durée fixe). Depuis le réseau local ou Tailscale, cette suspension ne s'applique pas : l'administrateur peut toujours se connecter de chez lui.
- Un code de double authentification faux compte comme un échec. Le message indique les essais restants.
- Les blocages survivent à un redémarrage. *Gestion › Journal* les liste, avec un bouton **Débloquer**. Chaque blocage et déblocage est noté au journal.
- Les agents (port 4404) sont protégés de la même façon : 3 codes faux en 15 min, adresse refusée 15 min.

Derrière un proxy inversé (Caddy, Nginx…), la carte doit voir la vraie adresse des visiteurs : `PROXY_CONFIANCE` (par défaut : adresses locales et privées) doit inclure l'adresse du proxy, sinon tous les visiteurs partagent l'adresse du proxy et un seul acharné bloquerait tout le monde.
