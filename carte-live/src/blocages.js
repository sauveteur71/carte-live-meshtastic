'use strict';
// Protection contre les essais de mots de passe (carte accessible depuis Internet).
//
// - Par adresse IP : 3 échecs de connexion en 15 min → adresse bloquée 15 min. Chaque nouveau blocage de la même
//   adresse dans les 24 h double la durée (15 min, 30 min, 1 h… jusqu'à 24 h).
// - Par compte : 3 échecs en 15 min, quelle que soit l'adresse → connexion à ce compte suspendue 15 min
//   (contre les essais répartis sur plusieurs adresses). Durée fixe, pour qu'un tiers ne puisse pas
//   bloquer durablement un administrateur en se trompant exprès.
// - Un code de double authentification faux compte comme un échec ; un code simplement demandé, non.
// - Une connexion réussie efface les échecs de l'adresse et du compte.
// - Sur le réseau local ou par Tailscale, la suspension d'un compte ne s'applique pas (seul le blocage d'adresse).
// - Les blocages sont gardés sur disque (un redémarrage ne les lève pas) ; un administrateur peut débloquer.

const fs = require('fs');
const path = require('path');

const FENETRE = 15 * 60000;
const MAX_ECHECS = 3;
const BLOCAGE_BASE = 15 * 60000;
const BLOCAGE_MAX = 24 * 3600000;

function creerBlocages(config, journal) {
  const fichier = path.join(path.dirname(config.fichierBase), 'blocages.json');
  // ip:<adresse> ou compte:<identifiant> -> { echecs: [heures], jusqua, niveau, dernierBlocage }
  let etat = {};
  try { etat = JSON.parse(fs.readFileSync(fichier, 'utf8')) || {}; } catch { /* aucun */ }
  let minuterie = null;
  const sauver = () => { clearTimeout(minuterie); minuterie = setTimeout(() => { try { fs.writeFileSync(fichier, JSON.stringify(etat), { mode: 0o600 }); } catch { /* lecture seule */ } }, 500); };
  const ecrireTout = () => { clearTimeout(minuterie); try { fs.writeFileSync(fichier, JSON.stringify(etat), { mode: 0o600 }); } catch { /* lecture seule */ } };
  const cleIp = (ip) => 'ip:' + String(ip || '?');
  // Réseau local et Tailscale : la suspension d'un compte ne s'y applique pas (l'admin chez lui peut toujours
  // se connecter, même si quelqu'un s'acharne sur son compte depuis Internet) ; le blocage par adresse, si.
  const local = (ip) => /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)|^::1$|^f[cd]/i.test(String(ip || ''));
  const cleCompte = (id) => 'compte:' + String(id || '').trim().toLowerCase().slice(0, 64);

  // Blocage en cours : null ou { jusqua, type }
  function bloque(ip, identifiant) {
    const t = Date.now();
    const a = etat[cleIp(ip)];
    if (a && a.jusqua > t) return { jusqua: a.jusqua, type: 'ip' };
    if (identifiant && !local(ip)) {
      const c = etat[cleCompte(identifiant)];
      if (c && c.jusqua > t) return { jusqua: c.jusqua, type: 'compte' };
    }
    return null;
  }

  // Échec : renvoie le nombre d'essais restants avant blocage, et le blocage s'il vient d'être posé
  function echec(ip, identifiant) {
    const t = Date.now();
    let restants = MAX_ECHECS, pose = null;
    for (const [k, progressif] of [[cleIp(ip), true], ...(identifiant ? [[cleCompte(identifiant), false]] : [])]) {
      const e = etat[k] || { echecs: [], jusqua: 0, niveau: 0, dernierBlocage: 0 };
      e.echecs = e.echecs.filter((x) => t - x < FENETRE);
      e.echecs.push(t);
      if (e.echecs.length >= MAX_ECHECS) {
        if (progressif) e.niveau = t - (e.dernierBlocage || 0) < 24 * 3600000 ? e.niveau + 1 : 1;
        const duree = progressif ? Math.min(BLOCAGE_MAX, BLOCAGE_BASE * 2 ** (e.niveau - 1)) : BLOCAGE_BASE;
        e.jusqua = t + duree; e.dernierBlocage = t; e.echecs = [];
        pose = pose || { jusqua: e.jusqua, type: progressif ? 'ip' : 'compte', duree };
        journal(`[Sécurité] ${progressif ? 'adresse ' + ip + ' bloquée' : 'compte « ' + identifiant + ' » suspendu'} ${Math.round(duree / 60000)} min après ${MAX_ECHECS} échecs de connexion`);
      } else restants = Math.min(restants, MAX_ECHECS - e.echecs.length);
      etat[k] = e;
    }
    if (pose) ecrireTout(); else sauver();
    return { restants: pose ? 0 : restants, blocage: pose };
  }

  function reussite(ip, identifiant) {
    let change = false;
    for (const k of [cleIp(ip), cleCompte(identifiant)]) {
      const e = etat[k];
      if (e && e.echecs.length) { e.echecs = []; change = true; }
    }
    if (change) sauver();
  }

  function liste() {
    const t = Date.now();
    return Object.entries(etat).filter(([, e]) => e.jusqua > t || e.echecs.some((x) => t - x < FENETRE))
      .map(([k, e]) => ({ cle: k, type: k.startsWith('ip:') ? 'ip' : 'compte', valeur: k.slice(k.indexOf(':') + 1), bloqueJusqua: e.jusqua > t ? e.jusqua : null, echecs: e.echecs.filter((x) => t - x < FENETRE).length, niveau: e.niveau || 0 }))
      .sort((a, b) => (b.bloqueJusqua || 0) - (a.bloqueJusqua || 0));
  }

  function debloquer(cle) {
    if (!etat[cle]) return false;
    delete etat[cle];
    ecrireTout();
    return true;
  }

  // Ménage : entrées sans blocage ni échec récent, et plus de 24 h après le dernier blocage
  setInterval(() => {
    const t = Date.now();
    let change = false;
    for (const [k, e] of Object.entries(etat)) {
      if (e.jusqua < t && !e.echecs.some((x) => t - x < FENETRE) && t - (e.dernierBlocage || 0) > 24 * 3600000) { delete etat[k]; change = true; }
    }
    if (change) sauver();
  }, 30 * 60000).unref();

  return { bloque, echec, reussite, liste, debloquer, MAX_ECHECS };
}

module.exports = { creerBlocages };
