'use strict';
// Service de mise à jour de la carte (conteneur « maj » du docker-compose, même image que la carte).
//
// Il a accès au moteur Docker (socket monté) et ne sait faire qu'une chose : télécharger la nouvelle image de la
// carte puis recréer son conteneur avec exactement les mêmes réglages (volumes, ports, variables, réseaux,
// étiquettes Compose). En cas d'échec (arrêt de l'ancien, création ou démarrage du nouveau, moteur Docker qui ne
// répond plus), l'ancien est remis en route ; un témoin « maj-en-cours » permet aussi de le relancer au prochain
// démarrage de ce service si l'opération a été interrompue en plein milieu.
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

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const temoin = path.join(DOSSIER, 'maj-en-cours.json');
const poserTemoin = (o) => { try { fs.writeFileSync(temoin, JSON.stringify({ ...o, heure: Date.now() })); } catch { /* dossier en lecture seule */ } };
const retirerTemoin = () => { try { fs.unlinkSync(temoin); } catch { /* absent */ } };

// Remet en route un conteneur arrêté, en insistant : juste après un blocage le moteur peut mettre des minutes à répondre.
async function relancer(id, tentatives = 12) {
  for (let i = 0; i < tentatives; i++) {
    try {
      const v = await docker('GET', `/containers/${id}/json`, null, { delai: 30000 });
      if (v.State && v.State.Running) return true;
      await docker('POST', `/containers/${id}/start`, null, { delai: 60000 }).catch((e) => { if (!/304/.test(e.message)) throw e; });
      return true;
    } catch (e) { journal(`relance de l’ancienne version : tentative ${i + 1}/${tentatives} : ${e.message}`); await attendre(10000); }
  }
  return false;
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
  poserTemoin({ ancien: ancien.Id, nom });
  let nouveau = null, renomme = false;
  try {
    // L'appel d'arrêt peut ne jamais revenir alors que le conteneur est bien éteint (constaté : le moteur attend
    // 20 s de plus après la sortie du conteneur, ou se bloque) : on lance l'arrêt sans l'attendre et on suit l'état réel.
    docker('POST', `/containers/${ancien.Id}/stop?t=20`, null, { delai: 180000 }).catch((e) => { if (!/304/.test(e.message)) journal('arrêt : ' + e.message); });
    for (let i = 0; ; i++) {
      const v = await docker('GET', `/containers/${ancien.Id}/json`, null, { delai: 30000 }).catch(() => null);
      if (v && !v.State.Running) break;
      if (i >= 60) throw new Error('l’ancienne version ne s’arrête pas');
      await attendre(2000);
    }
    await docker('POST', `/containers/${ancien.Id}/rename?name=${enc(nomAncien)}`, null, { delai: 60000 });
    renomme = true;
    nouveau = await docker('POST', `/containers/create?name=${enc(nom)}`, config, { delai: 180000 });
    for (const r of reseaux.slice(1)) await docker('POST', `/networks/${enc(r[0])}/connect`, { Container: nouveau.Id, EndpointConfig: endpoint(r) });
    noter('demarrage', 'démarrage de la nouvelle version');
    await docker('POST', `/containers/${nouveau.Id}/start`, null, { delai: 180000 });
    // La nouvelle version doit tenir 20 s (sinon : retour à l'ancienne)
    await attendre(20000);
    const v = await docker('GET', `/containers/${nouveau.Id}/json`);
    if (!v.State.Running) throw new Error(`la nouvelle version s’est arrêtée (code ${v.State.ExitCode})`);
  } catch (e) {
    noter('retour', 'échec, retour à l’ancienne version : ' + e.message);
    if (nouveau) { await docker('DELETE', `/containers/${nouveau.Id}?force=1`, null, { delai: 120000 }).catch(() => {}); }
    if (renomme) await docker('POST', `/containers/${ancien.Id}/rename?name=${enc(nom)}`, null, { delai: 60000 }).catch(() => {});
    const repart = await relancer(ancien.Id);
    if (repart) retirerTemoin(); else journal('l’ancienne version n’a pas pu être relancée : le témoin est gardé, nouvel essai au prochain démarrage du service de mise à jour');
    throw e;
  }
  retirerTemoin();
  await docker('DELETE', `/containers/${ancien.Id}`).catch((e) => journal('ancien conteneur non supprimé :', e.message));
  // Ménage : l'ancienne image si plus rien ne l'utilise
  if (ancienneImg) await docker('DELETE', `/images/${enc(ancienneImg.Id)}`).catch(() => {});
  noter('termine', 'mise à jour terminée');
  return { aJour: false };
}

// Reprise : si le service a été interrompu (ou redémarré) en pleine mise à jour, l'ancienne version reste éteinte.
// Le témoin dit qu'on l'avait arrêtée nous-mêmes : on la relance.
async function reprise() {
  let t = null;
  try { t = JSON.parse(fs.readFileSync(temoin, 'utf8')); } catch { return; }
  if (!t || !t.ancien) return retirerTemoin();
  for (let i = 0; i < 30; i++) {
    try {
      const cible = await trouverCible().catch(() => null);
      const id = cible ? cible.Id : t.ancien;
      journal('reprise : une mise à jour a été interrompue, relance de la carte');
      if (await relancer(id, 3)) { retirerTemoin(); journal('reprise : carte relancée'); return; }
    } catch (e) { journal('reprise : ' + e.message); }
    await attendre(10000);
  }
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
}).listen(PORT, () => { journal(`prêt sur le port ${PORT} (service à mettre à jour : ${SERVICE})`); reprise().catch(() => {}); });
