'use strict';
// Service de mise à jour de la carte (conteneur « maj » du docker-compose, même image que la carte).
//
// Il a accès au moteur Docker (socket monté) et ne sait faire qu'une chose : télécharger la nouvelle image de la
// carte puis recréer son conteneur avec exactement les mêmes réglages (volumes, ports, variables, réseaux,
// étiquettes Compose). En cas d'échec au démarrage du nouveau conteneur, l'ancien est remis en route.
//
// - Joignable seulement sur le réseau interne du docker-compose (aucun port publié), port 4405.
// - Protégé par un jeton partagé avec la carte : fichier maj-jeton.txt du dossier de données (créé ici au
//   premier démarrage) ou variable MAJ_JETON.
// - Le conteneur à mettre à jour est trouvé par son service Compose (MAJ_SERVICE, « carte-live » par défaut)
//   dans le même projet Compose que ce service.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const PORT = Number(process.env.MAJ_PORT || 4405);
const SERVICE = process.env.MAJ_SERVICE || 'carte-live';
const DOSSIER = path.dirname(process.env.FICHIER_BASE || '/data/carte-live.db');
const journal = (...a) => console.log(new Date().toISOString(), '[maj]', ...a);

// ---- Jeton partagé ------------------------------------------------------------------------------------------
function lireJeton() {
  if (process.env.MAJ_JETON && process.env.MAJ_JETON.trim()) return process.env.MAJ_JETON.trim();
  const f = path.join(DOSSIER, 'maj-jeton.txt');
  try { const t = fs.readFileSync(f, 'utf8').trim(); if (t.length >= 32) return t; } catch { /* à créer */ }
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(f, t + '\n', { mode: 0o640 });
  try { fs.chownSync(f, 1000, 1000); } catch { /* la carte tourne en « node » (1000) */ }
  journal('jeton créé dans', f);
  return t;
}

// ---- Moteur Docker (API HTTP sur le socket) ------------------------------------------------------------------
function docker(methode, chemin, corps, { flux = false, delai = 120000 } = {}) {
  return new Promise((ok, ko) => {
    const donnees = corps ? Buffer.from(JSON.stringify(corps)) : null;
    const req = http.request({ socketPath: SOCKET, method: methode, path: chemin, headers: { 'Content-Type': 'application/json', ...(donnees ? { 'Content-Length': donnees.length } : {}) }, timeout: delai }, (res) => {
      const morceaux = [];
      res.on('data', (c) => morceaux.push(c));
      res.on('end', () => {
        const brut = Buffer.concat(morceaux).toString('utf8');
        if (res.statusCode >= 400) return ko(new Error(`Docker ${methode} ${chemin.split('?')[0]} : ${res.statusCode} ${(() => { try { return JSON.parse(brut).message; } catch { return brut.slice(0, 200); } })()}`));
        if (flux) {
          // Téléchargement d'image : suite de lignes JSON, une erreur peut arriver en cours de route
          const lignes = brut.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
          const err = lignes.find((l) => l.error);
          return err ? ko(new Error(err.error)) : ok(lignes);
        }
        try { ok(brut ? JSON.parse(brut) : null); } catch { ok(brut); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Docker ne répond pas')));
    req.on('error', ko);
    if (donnees) req.write(donnees);
    req.end();
  });
}
const enc = encodeURIComponent;

async function monProjet() {
  const moi = await docker('GET', `/containers/${enc(require('os').hostname())}/json`).catch(() => null);
  return moi && moi.Config && moi.Config.Labels ? moi.Config.Labels['com.docker.compose.project'] : null;
}
async function trouverCible() {
  const projet = await monProjet();
  const filtres = { label: [`com.docker.compose.service=${SERVICE}`, ...(projet ? [`com.docker.compose.project=${projet}`] : [])] };
  const l = await docker('GET', `/containers/json?all=1&filters=${enc(JSON.stringify(filtres))}`);
  if (!l.length) throw new Error(`conteneur du service « ${SERVICE} » introuvable`);
  return docker('GET', `/containers/${l[0].Id}/json`);
}
function separerImage(ref) {
  const sansDigest = ref.split('@')[0];
  const i = sansDigest.lastIndexOf(':');
  return i > sansDigest.lastIndexOf('/') ? [sansDigest.slice(0, i), sansDigest.slice(i + 1)] : [sansDigest, 'latest'];
}

// Réglages du conteneur sans ce qui venait de l'ancienne image (sinon ses variables ou sa commande
// resteraient figées) : comme le fait Watchtower.
function configSansImage(cfg, img) {
  const c = JSON.parse(JSON.stringify(cfg));
  const i = (img && img.Config) || {};
  const egal = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
  if (i.Env) c.Env = (c.Env || []).filter((e) => !i.Env.includes(e));
  for (const k of ['Cmd', 'Entrypoint', 'WorkingDir', 'User', 'Healthcheck', 'StopSignal']) if (egal(c[k], i[k])) delete c[k];
  if (i.Labels && c.Labels) for (const [k, v] of Object.entries(i.Labels)) if (c.Labels[k] === v) delete c.Labels[k];
  if (i.Volumes && c.Volumes) for (const k of Object.keys(i.Volumes)) delete c.Volumes[k];
  delete c.Hostname; delete c.Image;
  return c;
}

let enCours = null;
const etat = { phase: 'repos', message: '', heure: null, ancienne: null, nouvelle: null };
const noter = (phase, message) => { Object.assign(etat, { phase, message, heure: Date.now() }); journal(message); };

async function mettreAJour() {
  noter('recherche', 'recherche du conteneur de la carte');
  const ancien = await trouverCible();
  const ref = ancien.Config.Image;
  const [depot, tag] = separerImage(ref);
  noter('telechargement', `téléchargement de ${depot}:${tag}`);
  await docker('POST', `/images/create?fromImage=${enc(depot)}&tag=${enc(tag)}`, null, { flux: true, delai: 15 * 60000 });
  const nouvelleImg = await docker('GET', `/images/${enc(`${depot}:${tag}`)}/json`);
  etat.ancienne = ancien.Image; etat.nouvelle = nouvelleImg.Id;
  if (nouvelleImg.Id === ancien.Image) { noter('a-jour', 'la carte utilise déjà la dernière image'); return { aJour: true }; }
  const ancienneImg = await docker('GET', `/images/${enc(ancien.Image)}/json`).catch(() => null);

  const nom = ancien.Name.replace(/^\//, '');
  const config = { ...configSansImage(ancien.Config, ancienneImg), Image: ref, HostConfig: ancien.HostConfig };
  const reseaux = Object.entries((ancien.NetworkSettings && ancien.NetworkSettings.Networks) || {});
  const endpoint = ([, n]) => ({ Aliases: (n.Aliases || []).filter((a) => !ancien.Id.startsWith(a)), IPAMConfig: n.IPAMConfig || undefined, Links: n.Links || undefined, DriverOpts: n.DriverOpts || undefined });
  if (reseaux.length) config.NetworkingConfig = { EndpointsConfig: { [reseaux[0][0]]: endpoint(reseaux[0]) } };

  noter('remplacement', 'arrêt de l’ancienne version');
  const nomAncien = `${nom}-ancien-${Date.now().toString(36)}`;
  await docker('POST', `/containers/${ancien.Id}/stop?t=20`, null, { delai: 60000 }).catch((e) => { if (!/304/.test(e.message)) throw e; });
  await docker('POST', `/containers/${ancien.Id}/rename?name=${enc(nomAncien)}`);
  let nouveau = null;
  try {
    nouveau = await docker('POST', `/containers/create?name=${enc(nom)}`, config);
    for (const r of reseaux.slice(1)) await docker('POST', `/networks/${enc(r[0])}/connect`, { Container: nouveau.Id, EndpointConfig: endpoint(r) });
    noter('demarrage', 'démarrage de la nouvelle version');
    await docker('POST', `/containers/${nouveau.Id}/start`);
    // La nouvelle version doit tenir 20 s (sinon : retour à l'ancienne)
    await new Promise((r) => setTimeout(r, 20000));
    const v = await docker('GET', `/containers/${nouveau.Id}/json`);
    if (!v.State.Running) throw new Error(`la nouvelle version s’est arrêtée (code ${v.State.ExitCode})`);
  } catch (e) {
    noter('retour', 'échec, retour à l’ancienne version : ' + e.message);
    if (nouveau) { await docker('DELETE', `/containers/${nouveau.Id}?force=1`).catch(() => {}); }
    await docker('POST', `/containers/${ancien.Id}/rename?name=${enc(nom)}`).catch(() => {});
    await docker('POST', `/containers/${ancien.Id}/start`).catch(() => {});
    throw e;
  }
  await docker('DELETE', `/containers/${ancien.Id}`).catch((e) => journal('ancien conteneur non supprimé :', e.message));
  // Ménage : l'ancienne image si plus rien ne l'utilise
  if (ancienneImg) await docker('DELETE', `/images/${enc(ancienneImg.Id)}`).catch(() => {});
  noter('termine', 'mise à jour terminée');
  return { aJour: false };
}

const JETON = lireJeton();
http.createServer((req, res) => {
  const repondre = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const fourni = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(fourni), b = Buffer.from(JETON);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return repondre(401, { erreur: 'jeton invalide' });
  if (req.method === 'GET' && req.url === '/etat') return repondre(200, { ...etat, enCours: !!enCours });
  if (req.method === 'POST' && req.url === '/mettre-a-jour') {
    if (enCours) return repondre(409, { erreur: 'mise à jour déjà en cours' });
    enCours = mettreAJour().catch((e) => { noter('echec', 'échec : ' + e.message); }).finally(() => { enCours = null; });
    return repondre(202, { lance: true });
  }
  repondre(404, { erreur: 'inconnu' });
}).listen(PORT, () => journal(`prêt sur le port ${PORT} (service à mettre à jour : ${SERVICE})`));
