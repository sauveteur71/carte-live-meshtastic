# PostgreSQL archive

The map keeps a few days of history in its SQLite database. The **optional** PostgreSQL archive copies **all traffic** for long-term statistics, Grafana or SQL queries.

## Enable
*Manage › PostgreSQL archive* (administrator):
1. Server, port, database, user, password, SSL.
2. **Test the connection**: PostgreSQL version and current database size, without saving anything.
3. **Keep**: always, 10 years, 5 years, 2 years, 1 year, 6 months, 3 months, 1 month or 1 week.
4. **Maximum size**: no limit, 100, 50, 20, 10, 5, 2 or 1 GB. Beyond that, the oldest data goes first and the tables are compacted.
5. Tick **Enable the archive**, then **Save**. No restart needed.

The password is kept in a private file on the server and is never sent back to the page.

## The provided PostgreSQL container
In `.env`:
```
POSTGRES_MOT_DE_PASSE=a-long-password
```
then:
```bash
docker compose --profile postgres up -d
```
In the map: server **postgres**, port 5432, database **carte**, user **carte** and this password. The map cannot start the container itself.

`POSTGRES_URL=postgres://user:password@host:5432/database` in `.env` is used as a starting value.

## What is copied
Every 20 s: `noeuds`, `paquets`, `receptions`, `positions`, `telemetrie`, `traceroutes`, `liens`, and for MeshCore `mc_noeuds`, `mc_paquets`, `mc_receptions`, `mc_messages`, `mc_telemetrie`, `mc_liens`. Table and column names are the map's own (French). The last 10 minutes are copied again each round (late updates).

Example:
```sql
SELECT date_trunc('day', to_timestamp(heure / 1000)) AS day, port, count(*)
FROM paquets GROUP BY 1, 2 ORDER BY 1 DESC;
```
