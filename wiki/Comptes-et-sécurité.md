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

## Mot de passe oublié

- Sous **Se connecter**, le lien **Mot de passe oublié ?** demande l'identifiant, l'indicatif ou l'e-mail.
- **Avec un serveur d'envoi réglé** (*Réglages › Réglages avancés › E-mail* : adresse publique de la carte, serveur SMTP, compte, mot de passe, expéditeur), un lien valable **1 heure**, à usage unique, part à l'adresse e-mail du compte.
- **Sans e-mail**, la demande s'affiche dans *Gestion › Comptes* (badge « 🔑 mot de passe oublié ») : le bouton **🔑 Lien** crée un lien valable **24 h**, à usage unique, que l'administrateur transmet lui-même (SMS, messagerie).
- La réponse est la même que le compte existe ou non. La double authentification reste demandée après le changement.
- Chacun renseigne son e-mail dans *Mon compte*. L'administrateur peut aussi corriger l'identifiant (pseudo ou « NOM Prénom »), l'indicatif et l'e-mail d'un compte avec le bouton ✏️.

## Fréquentation

*Gestion › Fréquentation* (administrateurs) : visiteurs en ligne, visiteurs et pages ouvertes par jour, **pays**, pages les plus vues (carte, page publique, appli Android, ADRASEC…) et **provenance** (sites d'où viennent les visiteurs : Facebook, RTL-SDR, GitHub…).

- **Aucune adresse IP n'est enregistrée**, aucun cookie n'est posé : un visiteur est reconnu dans la journée par une empreinte chiffrée avec un sel tiré au hasard chaque jour et jamais écrit. Seuls des totaux par jour sont gardés, 400 jours.
- Les robots (moteurs de recherche, aperçus de liens Facebook, WhatsApp…) ne sont pas comptés.
- Le pays vient de la base libre **IP to Country Lite** de [DB-IP](https://db-ip.com) (CC BY 4.0), téléchargée une fois par mois sur le serveur (8 Mo, dossier des données) et consultée sur place. Visiteurs du réseau local et du VPN (Tailscale) : comptés à part.
- Désactivation : *Réglages avancés › Services* : « Statistiques de fréquentation » ou seulement « Pays des visiteurs ».
- Derrière un proxy inversé, régler `PROXY_CONFIANCE` (voir ci-dessus), sinon tous les visiteurs ont l'adresse du proxy et un seul pays.
