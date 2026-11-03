# Archive PostgreSQL

La carte garde quelques jours d'historique dans sa base SQLite. L'archive PostgreSQL, **facultative**, recopie **tout le trafic** pour des statistiques longues, Grafana ou des requêtes SQL.

## Activer
*Gestion › Archive PostgreSQL* (administrateur) :
1. Serveur, port, base, utilisateur, mot de passe, SSL.
2. **Tester la connexion** : version de PostgreSQL et taille actuelle de la base, sans rien enregistrer.
3. **Conserver** : toujours, 10 ans, 5 ans, 2 ans, 1 an, 6 mois, 3 mois, 1 mois ou 1 semaine.
4. **Taille maximale** : sans limite, 100, 50, 20, 10, 5, 2 ou 1 Go. Au-delà, les plus anciennes données partent d'abord et les tables sont compactées.
5. Cocher **Activer l'archive**, puis **Enregistrer**. Pas besoin de redémarrer.

Le mot de passe est gardé dans un fichier privé du serveur et n'est jamais renvoyé à la page.

## Le conteneur PostgreSQL fourni
Dans `.env` :
```
POSTGRES_MOT_DE_PASSE=un-mot-de-passe-long
```
puis :
```bash
docker compose --profile postgres up -d
```
Dans la carte : serveur **postgres**, port 5432, base **carte**, utilisateur **carte** et ce mot de passe. La carte ne peut pas démarrer le conteneur elle-même.

`POSTGRES_URL=postgres://utilisateur:motdepasse@hote:5432/base` dans `.env` sert de valeur de départ.

## Ce qui est copié
Toutes les 20 s : `noeuds`, `paquets`, `receptions`, `positions`, `telemetrie`, `traceroutes`, `liens`, et pour MeshCore `mc_noeuds`, `mc_paquets`, `mc_receptions`, `mc_messages`, `mc_telemetrie`, `mc_liens`. Les noms de tables et de colonnes sont ceux de la carte. Les 10 dernières minutes sont recopiées à chaque tour (mises à jour tardives).

Exemple :
```sql
SELECT date_trunc('day', to_timestamp(heure / 1000)) AS jour, port, count(*)
FROM paquets GROUP BY 1, 2 ORDER BY 1 DESC;
```
