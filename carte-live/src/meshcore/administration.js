'use strict';
// Administration à distance des répéteurs et room servers MeshCore, par le companion de la carte.
//
// Principe (comme l'appli officielle) : connexion au nœud avec son mot de passe admin, puis commandes CLI
// (« get name », « set tx 20 »…) envoyées en messages chiffrés ; le nœud répond par un message « CLI ».
// Les opérations sont des tâches (une seule à la fois, la radio étant partagée), suivies en direct par la page.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Réglages lus et modifiables (commande get / set)
const PARAMS = [
  { cle: 'name', nom: 'Nom', type: 'texte', max: 31 },
  { cle: 'radio', nom: 'Radio (MHz, kHz, SF, CR)', type: 'radio', redemarrage: true, sensible: true },
  { cle: 'tx', nom: 'Puissance (dBm)', type: 'nombre', min: 1, max: 30 },
  { cle: 'repeat', nom: 'Répétition des paquets', type: 'onoff' },
  { cle: 'flood.max', nom: 'Sauts max. (inondation)', type: 'nombre', min: 0, max: 64 },
  { cle: 'flood.max.advert', nom: 'Sauts max. des annonces', type: 'nombre', min: 0, max: 64 },
  { cle: 'advert.interval', nom: 'Annonce aux voisins (min)', type: 'nombre', min: 0, max: 240 },
  { cle: 'flood.advert.interval', nom: 'Annonce au réseau (h)', type: 'nombre', min: 0, max: 168 },
  { cle: 'path.hash.mode', nom: 'Taille des hachages de chemin', type: 'liste', valeurs: [['0', '1 octet'], ['1', '2 octets'], ['2', '3 octets']] },
  { cle: 'txdelay', nom: 'Délai de relais (inondation)', type: 'nombre', min: 0, max: 2, pas: 0.1 },
  { cle: 'direct.txdelay', nom: 'Délai de relais (direct)', type: 'nombre', min: 0, max: 2, pas: 0.1 },
  { cle: 'dutycycle', nom: 'Cycle d’émission max. (%)', type: 'nombre', min: 1, max: 100 },
  { cle: 'multi.acks', nom: 'Accusés multiples', type: 'nombre', min: 0, max: 1 },
  { cle: 'agc.reset.interval', nom: 'Réinitialisation AGC (s)', type: 'nombre', min: 0, max: 1020, multiple: 4 },
  { cle: 'flood.max.unscoped', nom: 'Sauts max. sans région', type: 'nombre', min: 0, max: 64 },
  { cle: 'loop.detect', nom: 'Détection des boucles', type: 'liste', valeurs: [['off', 'non'], ['minimal', 'minimale'], ['moderate', 'modérée'], ['strict', 'stricte']] },
  { cle: 'lat', nom: 'Latitude', type: 'nombre', min: -90, max: 90, pas: 0.000001 },
  { cle: 'lon', nom: 'Longitude', type: 'nombre', min: -180, max: 180, pas: 0.000001 },
  { cle: 'owner.info', nom: 'Infos propriétaire', type: 'texte', max: 120 },
];
const INFOS = [{ cmd: 'ver', cle: 'version', nom: 'Firmware' }, { cmd: 'board', cle: 'carte', nom: 'Matériel' }, { cmd: 'get role', cle: 'role', nom: 'Rôle' }, { cmd: 'clock', cle: 'horloge', nom: 'Horloge du nœud' },
  { cmd: 'region home', cle: 'regionMaison', nom: 'Région d’attache (v1.10+)' }, { cmd: 'region default', cle: 'regionDefaut', nom: 'Région par défaut des envois (v1.10+)' }];
// Éléments comparables entre nœuds (vérification de conformité)
const ELEMENTS = ['radio', 'tx', 'repeat', 'flood.max', 'flood.max.advert', 'flood.max.unscoped', 'agc.reset.interval', 'advert.interval', 'flood.advert.interval', 'path.hash.mode', 'txdelay', 'direct.txdelay', 'dutycycle', 'multi.acks', 'loop.detect'];
const ELEMENTS_DEFAUT = ['radio', 'repeat', 'flood.max', 'advert.interval', 'flood.advert.interval', 'path.hash.mode'];
// Commandes refusées depuis la console (destructrices ou exposant des secrets)
const INTERDITES = /^(erase|set prv\.key|get prv\.key|start ota)\b/i;

const nettoyer = (r) => String(r || '').replace(/^>\s?/, '').trim();
function normaliser(cle, v) {
  v = nettoyer(v);
  if (cle === 'radio') return v.split(',').map((x, i) => (i < 2 ? String(Number(x)) : String(parseInt(x, 10)))).join(',');
  if (cle === 'dutycycle') return String(Math.round(parseFloat(v) * 10) / 10);
  if (['txdelay', 'direct.txdelay', 'lat', 'lon'].includes(cle)) return String(Number(v));
  return v;
}
function valeurValide(p, v) {
  v = String(v ?? '').trim();
  if (p.type === 'texte') { if (!v || Buffer.byteLength(v) > p.max || /[\r\n]/.test(v)) throw new Error(`${p.nom} : 1 à ${p.max} caractères`); return v; }
  if (p.type === 'onoff') { if (!['on', 'off'].includes(v)) throw new Error(`${p.nom} : on ou off`); return v; }
  if (p.type === 'liste') { if (!p.valeurs.some(([x]) => x === v)) throw new Error(`${p.nom} : valeur inconnue`); return v; }
  if (p.type === 'radio') {
    const m = /^(\d{3}(?:\.\d{1,4})?),(\d+(?:\.\d+)?),(\d{1,2}),(\d)$/.exec(v.replace(/\s/g, ''));
    if (!m || +m[3] < 5 || +m[3] > 12 || +m[4] < 5 || +m[4] > 8) throw new Error('Radio : fréquence,bande,SF,CR (ex. 869.618,62.5,8,8)');
    return `${m[1]},${m[2]},${m[3]},${m[4]}`;
  }
  let n = Number(v.replace(',', '.'));
  if (!Number.isFinite(n) || n < p.min || n > p.max) throw new Error(`${p.nom} : entre ${p.min} et ${p.max}`);
  if (p.multiple) n = Math.round(n / p.multiple) * p.multiple; // le firmware arrondit lui aussi
  return String(n);
}
// Liste « neighbors » : une ligne par voisin « préfixe:horodatage:snr×4 »
function lireVoisins(t) {
  return String(t || '').split(/\r?\n/).map((l) => l.trim().replace(/^>\s?/, '')).map((l) => /^([0-9A-Fa-f]{2,64}):(\d+):(-?\d+)/.exec(l)).filter(Boolean)
    .map((m) => ({ prefixe: m[1].toUpperCase(), vu: Number(m[2]) * 1000 || null, snr: Number(m[3]) / 4 }));
}

// Actions sur les régions (firmware répéteur 1.10+) : put, remove, allowf, denyf, home, default, def (arbre en une ligne)
const NOM_REGION = /^[#\p{L}\p{N}_.-]{1,30}$/u;
function validerRegions(actions) {
  const ops = Array.isArray(actions) ? actions : [];
  if (ops.length > 30) throw new Error('30 actions de région au plus');
  for (const a of ops) {
    if (!['put', 'remove', 'allowf', 'denyf', 'home', 'default', 'def'].includes(a.op)) throw new Error('action de région inconnue : ' + a.op);
    if (a.op === 'def') {
      const toks = String(a.nom || '').trim().split(/\s+/);
      if (!toks[0] || String(a.nom).length > 140 || toks.some((x) => !/^[#\p{L}\p{N}_.-]{1,30}([|,]([#\p{L}\p{N}_.-]{1,30}|\*))?$/u.test(x))) throw new Error('region def : noms séparés par des espaces (nom|saut pour revenir à une région)');
      continue;
    }
    if (!(NOM_REGION.test(String(a.nom || '')) || (['allowf', 'denyf'].includes(a.op) && a.nom === '*') || (a.op === 'default' && a.nom === '<null>'))) throw new Error('nom de région invalide : ' + a.nom);
    if (a.parent && !(NOM_REGION.test(a.parent) || a.parent === '*')) throw new Error('région parente invalide');
  }
  return ops;
}

// Opérations possibles sans mot de passe admin (une connexion est tentée si un mot de passe est connu)
const SANS_ADMIN = ['statut', 'chemin', 'tracer', 'telemetrie'];

function creerAdministrationMc(config, companion, reseauMc, journal, surFin = () => {}) {
  const ecouteursTelemetrie = new Set(); // historique des capteurs
  const dossier = path.dirname(config.fichierBase);
  const fMdp = path.join(dossier, 'meshcore-admin.json');
  const fLectures = path.join(dossier, 'meshcore-lectures.json');
  const lire = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
  const motsDePasse = lire(fMdp); // clé -> mot de passe (fichier lisible seulement par le service)
  const lectures = lire(fLectures); // clé -> { heure, valeurs, infos, statut, voisins }
  const ecrire = (f, o) => { try { fs.writeFileSync(f, JSON.stringify(o), { mode: 0o600 }); } catch (e) { journal('enregistrement impossible :', e.message); } };

  const taches = new Map();
  const file = [];
  let enCours = null;

  function noeud(cle) {
    const n = reseauMc.q.noeud.get(String(cle).toUpperCase());
    if (!n) throw new Error('nœud MeshCore inconnu');
    return { cle: n.cle, nom: n.nom, role: n.role, lat: n.lat, lon: n.lon, horodatageAnnonce: n.horodatage_annonce };
  }

  function lancer(type, cles, params = {}, auteur = '?') {
    if (!Array.isArray(cles) || !cles.length || cles.length > 40) throw new Error('choisissez de 1 à 40 nœuds');
    const liste = cles.map((c) => noeud(c));
    if (type === 'cli') {
      const c = String(params.commande || '').trim();
      if (!c) throw new Error('commande vide');
      if (INTERDITES.test(c)) throw new Error('commande refusée depuis la carte (destructrice ou secrète) : utilisez la console série du nœud');
    }
    if (type === 'modifier') {
      const v = params.valeurs || {};
      if (!Object.keys(v).length) throw new Error('aucun réglage à changer');
      for (const [k, x] of Object.entries(v)) {
        const p = PARAMS.find((y) => y.cle === k);
        if (!p) throw new Error('réglage inconnu : ' + k);
        v[k] = valeurValide(p, x);
      }
    }
    if (type === 'verifier' && liste.length < 2) throw new Error('choisissez au moins 2 nœuds (le premier sert de référence)');
    if (!['lire', 'statut', 'voisins', 'cli', 'modifier', 'verifier', 'annonce', 'horloge', 'redemarrer', 'chemin', 'tracer', 'telemetrie', 'motdepasse', 'regions', 'modele', 'miseEnService'].includes(type)) throw new Error('opération inconnue');
    // Lecture ciblée : seulement les réglages demandés
    if (type === 'lire' && params.cles !== undefined) {
      if (!Array.isArray(params.cles) || !params.cles.length || params.cles.some((k) => !PARAMS.some((p) => p.cle === k))) throw new Error('réglages à lire invalides');
    }
    // Nouveaux mots de passe : gardés hors des paramètres visibles et enregistrés de la tâche
    const secrets = {};
    if (type === 'motdepasse') {
      const ok = (x) => typeof x === 'string' && x.length >= 1 && Buffer.byteLength(x) <= 15 && !/[\s]/.test(x);
      if (params.admin != null && params.admin !== '') { if (!ok(params.admin)) throw new Error('mot de passe admin : 1 à 15 caractères, sans espace'); secrets.admin = params.admin; }
      if (params.invite != null && params.invite !== '') { if (!ok(params.invite)) throw new Error('mot de passe invité : 1 à 15 caractères, sans espace'); secrets.invite = params.invite; }
      if (params.inviteVide) secrets.inviteVide = true;
      if (!secrets.admin && !secrets.invite && !secrets.inviteVide) throw new Error('indiquez au moins un nouveau mot de passe');
      params = { admin: !!secrets.admin, invite: !!secrets.invite || !!secrets.inviteVide, insister: params.insister, motDePasse: params.motDePasse, memoriser: params.memoriser };
    }
    if (type === 'regions') validerRegions(params.actions);
    if (type === 'modele' || type === 'miseEnService') {
      const m = params.modele ? modeles.find((x) => x.id === params.modele) : null;
      if (params.modele && !m) throw new Error('modèle inconnu');
      if (type === 'modele' && !m) throw new Error('choisissez un modèle');
      if (type === 'miseEnService') {
        if (liste.length !== 1) throw new Error('la mise en service se fait répéteur par répéteur');
        const id = params.identite || {};
        const ident = {};
        for (const k of ['name', 'lat', 'lon', 'owner.info']) if (id[k] !== undefined && id[k] !== '') ident[k] = valeurValide(PARAMS.find((p) => p.cle === k), id[k]);
        params = { ...params, identite: ident };
        if (params.admin) {
          if (typeof params.admin !== 'string' || Buffer.byteLength(params.admin) > 15 || /\s/.test(params.admin)) throw new Error('mot de passe admin : 1 à 15 caractères, sans espace');
          secrets.admin = params.admin;
        }
        params = { ...params, admin: !!secrets.admin };
        if (!m && !Object.keys(ident).length && !secrets.admin) throw new Error('rien à appliquer');
      }
    }
    const t = {
      id: crypto.randomBytes(5).toString('hex'), type, cles: liste.map((n) => n.cle), noms: Object.fromEntries(liste.map((n) => [n.cle, n.nom])), params: { ...params, motDePasse: undefined },
      motDePasse: params.motDePasse || null, memoriser: !!params.memoriser, statut: 'en_attente', creee: Date.now(), auteur, etapes: [], resultats: {}, arret: false,
      insister: !!params.insister && !['verifier'].includes(type), secrets,
    };
    taches.set(t.id, t);
    if (taches.size > 60) taches.delete(taches.keys().next().value);
    file.push(t);
    sauverTaches();
    setImmediate(suivante);
    return vue(t);
  }

  const etape = (t, cle, texte, ok = true) => { t.etapes.push({ heure: Date.now(), cle, texte, ok }); if (t.etapes.length > 400) t.etapes.shift(); sauverTaches(); };

  // ---- Tâches persistantes (sans les mots de passe) : reprise après un redémarrage de la carte -----------------
  const fTaches = path.join(dossier, 'meshcore-taches.json');
  let minuterieTaches = null;
  function sauverTaches() {
    clearTimeout(minuterieTaches);
    minuterieTaches = setTimeout(() => ecrire(fTaches, [...taches.values()].filter((t) => t.auteur !== 'supervision').map(({ motDePasse, secrets, ...t }) => t)), 1000);
  }
  function restaurerTaches() {
    let l = [];
    try { l = JSON.parse(fs.readFileSync(fTaches, 'utf8')); } catch { return; }
    const aReprendre = [];
    for (const t of l) {
      t.motDePasse = null;
      if (t.type === 'motdepasse' && ['en_attente', 'en_cours', 'reprise'].includes(t.statut)) {
        t.statut = 'annule'; t.fin = Date.now();
        t.etapes.push({ heure: Date.now(), cle: null, texte: 'interrompue par un redémarrage de la carte : les nouveaux mots de passe ne sont jamais enregistrés, relancez-la', ok: false });
      } else if (t.statut === 'en_attente' || t.statut === 'en_cours' || t.statut === 'reprise') {
        const restants = t.cles.filter((c) => !(t.resultats[c] && t.resultats[c].ok));
        const sansMdp = !SANS_ADMIN.includes(t.type) && restants.some((c) => motsDePasse[c] == null);
        if (Date.now() - (t.creee || 0) > 6 * 3600000 || sansMdp) {
          t.statut = 'annule'; t.fin = Date.now();
          t.etapes.push({ heure: Date.now(), cle: null, texte: sansMdp ? 'interrompue par un redémarrage de la carte : mot de passe non mémorisé, relancez-la' : 'interrompue par un redémarrage de la carte (trop ancienne pour reprendre)', ok: false });
        } else {
          t.statut = 'en_attente'; t.reprises = (t.reprises || 0) + 1;
          t.etapes.push({ heure: Date.now(), cle: null, texte: `reprise après le redémarrage de la carte (${restants.length} nœud(s) restant(s))`, ok: true });
          aReprendre.push(t);
        }
      }
      taches.set(t.id, t);
    }
    if (!aReprendre.length) return;
    journal(`${aReprendre.length} tâche(s) MeshCore interrompue(s) : reprise dès que le companion est relié`);
    const debut = Date.now();
    const attente = setInterval(() => {
      if (companion.etat().pret) { clearInterval(attente); for (const t of aReprendre) file.push(t); setImmediate(suivante); }
      else if (Date.now() - debut > 30 * 60000) { clearInterval(attente); for (const t of aReprendre) { t.statut = 'annule'; t.fin = Date.now(); t.etapes.push({ heure: Date.now(), cle: null, texte: 'companion non relié dans les 30 min après le redémarrage', ok: false }); } sauverTaches(); }
    }, 5000);
    if (attente.unref) attente.unref();
  }

  async function avecReprise(fn, essais = 2) {
    let derniere;
    for (let k = 0; k < essais; k++) {
      try { return await fn(); } catch (e) { derniere = e; if (/refusé|inconnu|invalide|non relié/i.test(e.message)) break; }
    }
    throw derniere;
  }

  async function seConnecter(t, n) {
    const mdp = t.motDePasse || motsDePasse[n.cle];
    if (!mdp && mdp !== '') throw new Error('mot de passe admin inconnu : saisissez-le');
    etape(t, n.cle, 'connexion…');
    const r = await avecReprise(() => companion.connexion(n, mdp));
    if (!r.admin) etape(t, n.cle, 'connecté en invité seulement (mot de passe invité ?) : réglages en lecture limitée', false);
    else etape(t, n.cle, `connecté en admin${r.inondation ? ' (chemin inconnu : envoi en inondation)' : ''}`);
    if (t.motDePasse && t.memoriser) { motsDePasse[n.cle] = t.motDePasse; ecrire(fMdp, motsDePasse); }
    return r;
  }
  const cli = (t, n, c) => avecReprise(() => companion.cli(n, c));

  async function lireConfig(t, n, cles = null) {
    const res = lectures[n.cle] || { valeurs: {}, infos: {} };
    res.valeurs = res.valeurs || {}; res.infos = res.infos || {};
    const aLire = PARAMS.filter((p) => !cles || cles.includes(p.cle));
    for (const p of aLire) {
      if (t.arret) throw new Error('arrêté');
      try {
        const r = await cli(t, n, 'get ' + p.cle);
        if (/^\?\?|unknown|error/i.test(r)) { etape(t, n.cle, `${p.nom} : non géré par ce firmware`, false); continue; }
        res.valeurs[p.cle] = normaliser(p.cle, r);
        etape(t, n.cle, `${p.nom} = ${res.valeurs[p.cle]}`);
      } catch (e) { etape(t, n.cle, `${p.nom} : ${e.message}`, false); }
      t.resultats[n.cle] = { ...(t.resultats[n.cle] || {}), valeurs: { ...res.valeurs } };
    }
    if (!cles) {
      for (const i of INFOS) {
        if (t.arret) throw new Error('arrêté');
        try { res.infos[i.cle] = nettoyer(await cli(t, n, i.cmd)); etape(t, n.cle, `${i.nom} : ${res.infos[i.cle]}`); } catch (e) { etape(t, n.cle, `${i.nom} : ${e.message}`, false); }
      }
    }
    res.heure = Date.now();
    lectures[n.cle] = res;
    ecrire(fLectures, lectures);
    t.resultats[n.cle] = { ...(t.resultats[n.cle] || {}), valeurs: res.valeurs, infos: res.infos };
    return res;
  }

  async function statut(t, n) {
    etape(t, n.cle, 'demande de l’état…');
    const s = await avecReprise(() => companion.statut(n));
    lectures[n.cle] = { ...(lectures[n.cle] || {}), statut: { ...s, heure: Date.now() } };
    ecrire(fLectures, lectures);
    t.resultats[n.cle] = { ...(t.resultats[n.cle] || {}), statut: s };
    if (s.batterieMv != null) reseauMc.noterEtat(n.cle, s);
    etape(t, n.cle, `batterie ${(s.batterieMv / 1000).toFixed(2)} V · bruit ${s.bruitDbm} dBm · émission ${s.occupationEmissionPct ?? '?'} % du temps`);
  }

  // Trace aller-retour vers un nœud par son chemin connu (ou découvert), avec le SNR de chaque saut, sans mot de passe
  async function tracer(t, n) {
    const lu = (lectures[n.cle] || {}).chemin;
    let aller;
    if (lu && Date.now() - (lu.heure || 0) < 12 * 3600000) aller = lu.aller.map((x) => x.prefixe);
    else {
      etape(t, n.cle, 'recherche du chemin (inondation)…');
      const r = await companion.decouvrirChemin(n);
      aller = r.aller;
      const rs = reseauMc.resoudreChemin(r.aller, null, null);
      lectures[n.cle] = { ...(lectures[n.cle] || {}), chemin: { aller: r.aller.map((h, i) => ({ prefixe: h, cle: rs[i] ? rs[i].cle : null, nom: rs[i] ? rs[i].nom : null })), retour: [], dureeMs: r.dureeMs, heure: Date.now() } };
    }
    let taille = aller.length ? aller[0].length / 2 : 1;
    if (taille === 3) { taille = 2; aller = aller.map((h) => h.slice(0, 4)); } // le firmware ne trace qu'en 1, 2, 4 ou 8 octets
    const cible = n.cle.slice(0, taille * 2);
    const chemin = [...aller, cible, ...[...aller].reverse()];
    etape(t, n.cle, `trace aller-retour par ${aller.length ? aller.length + ' relais' : 'liaison directe'}…`);
    const r = await avecReprise(() => companion.tracer(chemin));
    const moi = companion.etat();
    const resolus = reseauMc.resoudreChemin(r.hachages, null, null);
    const etapes = [{ cle: moi.cle, nom: moi.nom || 'companion' }, ...r.hachages.map((h, i) => (h === cible ? { cle: n.cle, nom: n.nom } : { cle: resolus[i] ? resolus[i].cle : null, nom: resolus[i] ? resolus[i].nom : h, prefixe: h })), { cle: moi.cle, nom: moi.nom || 'companion' }];
    const sauts = etapes.slice(0, -1).map((de, i) => ({ de, vers: etapes[i + 1], snr: i < r.snrs.length ? r.snrs[i] : r.final }));
    for (const x of sauts) if (x.de.cle && x.vers.cle) reseauMc.lierMesure(x.de.cle, x.vers.cle, 'trace', x.snr);
    lectures[n.cle] = { ...(lectures[n.cle] || {}), trace: { sauts, dureeMs: r.dureeMs, heure: Date.now() } };
    ecrire(fLectures, lectures);
    t.resultats[n.cle] = { ...(t.resultats[n.cle] || {}), trace: sauts };
    const f = (v) => (v > 0 ? '+' : '') + String(v).replace('.', ',');
    etape(t, n.cle, `${sauts.map((x, i) => (i === 0 ? x.de.nom : '') + ` ─(${f(x.snr)} dB)→ ${x.vers.nom}`).join('')} · ${(r.dureeMs / 1000).toFixed(1)} s`);
  }

  async function voisins(t, n) {
    const brut = await cli(t, n, 'neighbors');
    const v = reseauMc.lierVoisins(n.cle, lireVoisins(brut));
    lectures[n.cle] = { ...(lectures[n.cle] || {}), voisins: v, heureVoisins: Date.now() };
    ecrire(fLectures, lectures);
    t.resultats[n.cle] = { ...(t.resultats[n.cle] || {}), voisins: v };
    etape(t, n.cle, v.length ? `${v.length} voisin(s) : ${v.map((x) => `${x.nom || x.prefixe} (${x.snr} dB)`).join(', ')}` : 'aucun voisin entendu récemment');
  }

  // Réglages « set » envoyés un par un puis relus
  async function appliquerValeurs(t, n, v, { sansErreurRedemarrage = false } = {}) {
    const echecs = [];
    let redemarrage = false;
    for (const [k, x] of Object.entries(v)) {
      if (t.arret) break;
      const p = PARAMS.find((y) => y.cle === k);
      const r = nettoyer(await cli(t, n, `set ${k} ${x}`).catch((e) => 'ERR ' + e.message));
      const ok = /^ok/i.test(r) || (k === 'repeat' && /repeat is now/i.test(r));
      if (/reboot/i.test(r) || p.redemarrage) redemarrage = true;
      etape(t, n.cle, `${p.nom} → ${x} : ${r}`, ok);
      if (!ok) echecs.push(p.nom);
    }
    await lireConfig(t, n, Object.keys(v)).catch(() => {});
    const lu = (lectures[n.cle] || {}).valeurs || {};
    const ecarts = Object.entries(v).filter(([k, x]) => lu[k] !== undefined && normaliser(k, lu[k]) !== normaliser(k, x)).map(([k]) => k);
    t.resultats[n.cle] = { ...(t.resultats[n.cle] || {}), echecs, ecarts, redemarrage };
    if (redemarrage && !sansErreurRedemarrage) etape(t, n.cle, 'un redémarrage du nœud est nécessaire pour appliquer la radio (bouton « Redémarrer »)', false);
    if (echecs.length || ecarts.length) throw new Error('réglages non appliqués : ' + [...new Set([...echecs, ...ecarts])].join(', '));
  }
  // Régions : actions, enregistrement, relecture
  async function appliquerRegions(t, n, ops, enregistrer = true) {
    let modifie = false;
    for (const a of ops) {
      if (t.arret) break;
      const ligne = `region ${a.op} ${a.nom}${a.op === 'put' && a.parent ? ' ' + a.parent : ''}`;
      const r = nettoyer(await cli(t, n, ligne));
      const ok = !/^err/i.test(r);
      etape(t, n.cle, `${ligne} : ${r}`, ok);
      if (!ok) throw new Error(`« ${ligne} » refusée : ${r}`);
      if (!['home', 'default'].includes(a.op)) modifie = true;
    }
    if (modifie && enregistrer) {
      const r = nettoyer(await cli(t, n, 'region save'));
      etape(t, n.cle, 'enregistrement des régions : ' + r, /^ok/i.test(r));
      if (!/^ok/i.test(r)) throw new Error('régions non enregistrées : ' + r);
    }
    const arbre = nettoyer(await cli(t, n, 'region'));
    const home = nettoyer(await cli(t, n, 'region home')).replace(/^home is\s*/i, '');
    const defaut = nettoyer(await cli(t, n, 'region default')).replace(/^default scope is\s*/i, '');
    lectures[n.cle] = { ...(lectures[n.cle] || {}), regions: { arbre, home, defaut, heure: Date.now() } };
    ecrire(fLectures, lectures);
    t.resultats[n.cle] = { ...(t.resultats[n.cle] || {}), regions: { arbre, home, defaut } };
    etape(t, n.cle, `régions :\n${arbre || '(aucune)'}\nattache : ${home} · envois : ${defaut}`);
  }

  async function executer(t) {
    const elements = Array.isArray(t.params.elements) && t.params.elements.length ? t.params.elements.filter((e) => ELEMENTS.includes(e)) : ELEMENTS_DEFAUT;
    for (const cle of t.cles) {
      if (t.arret) break;
      if (t.resultats[cle] && t.resultats[cle].ok) continue; // déjà fait avant un redémarrage de la carte
      const n = noeud(cle);
      t.courant = cle;
      try {
        // L'état et la découverte de chemin ne demandent pas de connexion admin
        if (t.type !== 'tracer' && (!SANS_ADMIN.includes(t.type) || t.motDePasse || motsDePasse[n.cle])) await seConnecter(t, n).catch((e) => { if (!SANS_ADMIN.includes(t.type)) throw e; etape(t, n.cle, 'connexion : ' + e.message + ' (on continue sans)', false); });
        switch (t.type) {
          case 'lire':
            if (Array.isArray(t.params.cles)) { await lireConfig(t, n, t.params.cles); break; }
            await lireConfig(t, n); await statut(t, n).catch((e) => etape(t, n.cle, 'état : ' + e.message, false)); await voisins(t, n).catch((e) => etape(t, n.cle, 'voisins : ' + e.message, false)); break;
          case 'motdepasse': {
            const sec = t.secrets || {};
            if (sec.admin) {
              const r = nettoyer(await cli(t, n, 'password ' + sec.admin));
              if (!/password now/i.test(r)) throw new Error('mot de passe admin non changé : ' + r.replace(sec.admin, '••••'));
              // Le mot de passe mémorisé suit, sinon la prochaine connexion échouerait
              if (motsDePasse[n.cle] != null || t.memoriser) { motsDePasse[n.cle] = sec.admin; ecrire(fMdp, motsDePasse); }
              etape(t, n.cle, 'mot de passe admin changé' + (motsDePasse[n.cle] === sec.admin ? ' (et mémorisé)' : ' : notez-le, il n’est pas mémorisé sur la carte'));
            }
            if (sec.invite || sec.inviteVide) {
              const r = nettoyer(await cli(t, n, 'set guest.password ' + (sec.invite || '')));
              if (!/^ok/i.test(r)) throw new Error('mot de passe invité non changé : ' + r);
              etape(t, n.cle, sec.invite ? 'mot de passe invité changé' : 'mot de passe invité retiré (accès invité libre)');
            }
            break;
          }
          case 'regions': await appliquerRegions(t, n, Array.isArray(t.params.actions) ? t.params.actions : [], t.params.enregistrer !== false); break;
          case 'statut': await statut(t, n); break;
          case 'chemin': {
            etape(t, n.cle, 'découverte du chemin (requête en inondation)…');
            const r = await companion.decouvrirChemin(n);
            const moi = companion.etat();
            const res = (l) => { const rs = reseauMc.resoudreChemin(l, null, null); return l.map((h, i) => ({ prefixe: h, cle: rs[i] ? rs[i].cle : null, nom: rs[i] ? rs[i].nom : null })); };
            const aller = res(r.aller), retour = res(r.retour);
            t.resultats[n.cle] = { ...(t.resultats[n.cle] || {}), chemin: { aller, retour, dureeMs: r.dureeMs, de: moi.nom } };
            lectures[n.cle] = { ...(lectures[n.cle] || {}), chemin: { aller, retour, dureeMs: r.dureeMs, heure: Date.now() } };
            ecrire(fLectures, lectures);
            const txt = (l) => (l.length ? l.map((x) => x.nom || x.prefixe).join(' › ') : 'direct');
            etape(t, n.cle, `aller : ${moi.nom || 'companion'} › ${txt(aller)} › ${n.nom} · retour : ${txt(retour)} · ${(r.dureeMs / 1000).toFixed(1)} s`);
            break;
          }
          case 'voisins': await voisins(t, n); break;
          case 'tracer': await tracer(t, n); break;
          case 'telemetrie': {
            etape(t, n.cle, 'demande de télémétrie…');
            const l = await avecReprise(() => companion.telemetrie(n));
            lectures[n.cle] = { ...(lectures[n.cle] || {}), telemetrie: { mesures: l, heure: Date.now() } };
            ecrire(fLectures, lectures);
            t.resultats[n.cle] = { ...(t.resultats[n.cle] || {}), telemetrie: l };
            const LIB = { tension: 'tension', temperature: 'température', humidite: 'humidité', pression: 'pression', courant: 'courant', pourcentage: 'charge', luminosite: 'luminosité' };
            etape(t, n.cle, l.length ? l.map((m) => `${LIB[m.type] || m.type}${m.canal > 1 ? ' (canal ' + m.canal + ')' : ''} ${typeof m.valeur === 'object' ? JSON.stringify(m.valeur) : String(m.valeur).replace('.', ',')} ${m.unite}`.trim()).join(' · ') : 'aucune mesure renvoyée');
            const v = l.find((m) => m.type === 'tension' && m.canal === 1);
            if (v) reseauMc.noterEtat(n.cle, { batterieMv: Math.round(v.valeur * 1000) });
            for (const f of ecouteursTelemetrie) { try { f(n.cle, l); } catch (e) { journal('télémétrie :', e.message); } }
            break;
          }
          case 'verifier': await lireConfig(t, n, elements); break;
          case 'annonce': etape(t, n.cle, nettoyer(await cli(t, n, t.params.inondation === false ? 'advert.zerohop' : 'advert'))); break;
          case 'horloge': etape(t, n.cle, nettoyer(await cli(t, n, 'clock sync'))); break;
          case 'redemarrer':
            await companion.cli(n, 'reboot', 8000).catch(() => {}); // pas de réponse : le nœud redémarre
            etape(t, n.cle, 'ordre de redémarrage envoyé (pas de réponse attendue)');
            break;
          case 'cli': {
            const r = await cli(t, n, t.params.commande);
            t.resultats[n.cle] = { ...(t.resultats[n.cle] || {}), reponse: r };
            etape(t, n.cle, `> ${t.params.commande}\n${r}`);
            if (/^neighbors$/i.test(t.params.commande.trim())) reseauMc.lierVoisins(n.cle, lireVoisins(r));
            break;
          }
          case 'modifier': await appliquerValeurs(t, n, t.params.valeurs); break;
          case 'modele': case 'miseEnService': {
            const m = t.params.modele ? modeles.find((x) => x.id === t.params.modele) : null;
            if (t.params.modele && !m) throw new Error('modèle supprimé entre-temps');
            const valeurs = { ...(m ? m.valeurs : {}), ...(t.params.identite || {}) };
            if (m) etape(t, n.cle, `modèle « ${m.nom} »`);
            if (Object.keys(valeurs).length) await appliquerValeurs(t, n, valeurs, { sansErreurRedemarrage: true });
            if (m && m.regions && m.regions.length) await appliquerRegions(t, n, m.regions);
            const sec = t.secrets || {};
            if (sec.admin) {
              const r = nettoyer(await cli(t, n, 'password ' + sec.admin));
              if (!/password now/i.test(r)) throw new Error('mot de passe admin non changé');
              if (motsDePasse[n.cle] != null || t.memoriser) { motsDePasse[n.cle] = sec.admin; ecrire(fMdp, motsDePasse); }
              etape(t, n.cle, 'mot de passe admin changé' + (motsDePasse[n.cle] === sec.admin ? ' (et mémorisé)' : ' : notez-le, il n’est pas mémorisé sur la carte'));
            }
            if (!m || m.horloge !== false) etape(t, n.cle, 'horloge : ' + nettoyer(await cli(t, n, 'clock sync')));
            if (m && m.redemarrer) {
              await companion.cli(n, 'reboot', 8000).catch(() => {});
              etape(t, n.cle, 'redémarrage demandé (le répéteur revient dans une minute environ)');
            }
            break;
          }
          default: break;
        }
        t.resultats[n.cle] = { ...(t.resultats[n.cle] || {}), ok: true, heure: Date.now() };
      } catch (e) {
        etape(t, n.cle, e.message, false);
        t.resultats[n.cle] = { ...(t.resultats[n.cle] || {}), ok: false, erreur: e.message, heure: Date.now(), definitif: /refusé|inconnu|invalide|mot de passe|non géré/i.test(e.message), echecs: ((t.resultats[n.cle] || {}).echecs || 0) + 1 };
        // Vérification : sans la référence, inutile de continuer
        if (t.type === 'verifier' && cle === t.cles[0]) { t.arret = true; etape(t, null, 'référence illisible : vérification arrêtée', false); }
      }
    }
    if (t.type === 'verifier') t.rapport = comparer(t, elements);
  }

  function comparer(t, elements) {
    const ref = t.cles[0];
    const vr = (t.resultats[ref] || {}).valeurs || {};
    return {
      reference: ref, elements,
      noeuds: t.cles.slice(1).map((cle) => {
        const r = t.resultats[cle] || {}, v = r.valeurs || {};
        if (!r.ok) return { cle, nom: t.noms[cle], lu: false, erreur: r.erreur || 'non lu' };
        const ecarts = elements.filter((e) => vr[e] !== undefined && v[e] !== undefined && vr[e] !== v[e]).map((e) => ({ element: e, reference: vr[e], valeur: v[e] }));
        return { cle, nom: t.noms[cle], lu: true, conforme: !ecarts.length, ecarts };
      }),
    };
  }

  async function suivante() {
    if (enCours || !file.length) return;
    const t = file.shift();
    if (t.arret) { t.statut = 'annule'; return suivante(); }
    enCours = t;
    t.statut = 'en_cours'; t.debut = Date.now();
    journal(`tâche MeshCore ${t.type} sur ${t.cles.length} nœud(s) (${t.auteur})`);
    try { await executer(t); } catch (e) { etape(t, null, e.message, false); }
    t.fin = Date.now();
    t.courant = null;
    const res = Object.values(t.resultats);
    t.statut = t.arret ? 'annule' : res.length && res.every((r) => r.ok) && res.length === t.cles.length ? 'ok' : 'echec';
    // Bilan dans le journal : nœud par nœud, réussite ou raison de l'échec (dernière étape en erreur)
    if (t.auteur !== 'supervision' || t.statut !== 'ok') {
      const nom = (c) => (t.noms && t.noms[c]) || String(c).slice(0, 8);
      const bilan = t.cles.slice(0, 12).map((c) => {
        const r = t.resultats[c];
        if (r && r.ok) return `${nom(c)} réussie`;
        const err = [...t.etapes].reverse().find((e) => !e.ok && (e.cle === c || e.cle == null));
        return `${nom(c)} ${t.arret ? 'arrêtée' : 'échec'}${err ? ' : ' + String(err.texte).split('\n')[0].slice(0, 140) : ''}`;
      });
      journal(`tâche MeshCore ${t.type} terminée (${t.auteur}) : ${bilan.join(' · ')}${t.cles.length > 12 ? ` · … ${t.cles.length - 12} autre(s)` : ''}`);
    }
    // « Insister » : les nœuds en échec passager sont repris toutes les 10 min, pendant 2 h au plus
    const aReprendre = t.insister && !t.arret ? t.cles.filter((c) => { const r = t.resultats[c]; return !r || (!r.ok && !r.definitif); }) : [];
    if (aReprendre.length && Date.now() - t.creee < 2 * 3600000) {
      t.statut = 'reprise';
      t.prochainEssai = Date.now() + 10 * 60000;
      etape(t, null, `${aReprendre.length} nœud(s) en échec : nouvel essai à ${new Date(t.prochainEssai).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' })}`);
      const minut = setTimeout(() => {
        t.prochainEssai = null;
        if (t.arret) { t.statut = 'annule'; t.motDePasse = null; t.secrets = {}; sauverTaches(); return; }
        t.statut = 'en_attente'; t.reprises = (t.reprises || 0) + 1;
        file.push(t); suivante();
      }, 10 * 60000);
      if (minut.unref) minut.unref();
    } else { t.motDePasse = null; t.secrets = {}; }
    enCours = null;
    sauverTaches();
    try { surFin(vue(t)); } catch { /* ignoré */ }
    setImmediate(suivante);
  }

  function vue(t, complet = true) {
    const v = { reprises: t.reprises || 0, insister: !!t.insister, prochainEssai: t.prochainEssai || null, id: t.id, type: t.type, cles: t.cles, noms: t.noms, params: t.params, statut: t.statut, creee: t.creee, debut: t.debut, fin: t.fin, auteur: t.auteur, courant: t.courant };
    if (complet) Object.assign(v, { etapes: t.etapes, resultats: t.resultats, rapport: t.rapport || null });
    return v;
  }

  restaurerTaches();

  // Supervision : interrogation périodique de l'état des répéteurs surveillés, quand le companion est relié
  let derniereSupervision = 0;
  setInterval(() => {
    const h = config.meshcore.supervisionHeures;
    if (!h || enCours || file.length || !companion.etat().pret || Date.now() - derniereSupervision < h * 3600000) return;
    derniereSupervision = Date.now();
    const contacts = new Set(companion.contacts().map((c) => c.cle));
    const cibles = reseauMc.surveilles(Object.keys(motsDePasse))
      .sort((a, b) => (motsDePasse[b.cle] ? 2 : contacts.has(b.cle) ? 1 : 0) - (motsDePasse[a.cle] ? 2 : contacts.has(a.cle) ? 1 : 0) || (b.dernier_vu || 0) - (a.dernier_vu || 0))
      .slice(0, config.meshcore.supervisionMax).map((n) => n.cle);
    if (cibles.length) { journal(`supervision : état de ${cibles.length} répéteur(s)`); lancer('statut', cibles, {}, 'supervision'); }
  }, 60000);
  // Traces de nuit (vers 3 h) vers les répéteurs surveillés : SNR de chaque liaison, suivi dans le temps
  let derniereTraceNuit = 0;
  setInterval(() => {
    const h = Number(new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }).slice(0, 2));
    if (h !== 3 || enCours || file.length || !companion.etat().pret || Date.now() - derniereTraceNuit < 20 * 3600000) return;
    derniereTraceNuit = Date.now();
    const cibles = reseauMc.surveilles(Object.keys(motsDePasse)).filter((n) => n.role === 'repeteur').slice(0, config.meshcore.supervisionMax).map((n) => n.cle);
    if (cibles.length) { journal(`traces de nuit vers ${cibles.length} répéteur(s)`); lancer('tracer', cibles, {}, 'supervision'); }
  }, 5 * 60000);

  // ---- Modèles de réglages MeshCore (créés depuis un répéteur ou à la main), appliqués à plusieurs nœuds ----
  const fModeles = path.join(dossier, 'meshcore-modeles.json');
  let modeles = [];
  try { modeles = JSON.parse(fs.readFileSync(fModeles, 'utf8')); } catch {
    // Premier lancement : configuration de base d'un répéteur du réseau français (régions eu › fr › fr-ara › fr-43)
    modeles = [{
      id: 'base-repeteur-fr43', nom: 'Répéteur de base (FR-43)', description: 'Configuration de base d’un répéteur : annonces, AGC, accusés, cycle d’émission, hachages 2 octets, détection des boucles, sauts limités hors région, régions eu › fr › fr-ara › fr-43.',
      valeurs: { 'advert.interval': '240', 'flood.advert.interval': '24', 'agc.reset.interval': '4', 'multi.acks': '1', dutycycle: '10', 'path.hash.mode': '1', 'loop.detect': 'minimal', 'flood.max.unscoped': '3', 'flood.max.advert': '5' },
      regions: [{ op: 'def', nom: 'eu fr fr-ara fr-43' }, { op: 'default', nom: 'fr' }, { op: 'home', nom: 'fr' }],
      horloge: true, redemarrer: true, auteur: 'carte', heure: Date.now(),
    }];
  }
  function enregistrerModele(m, auteur) {
    const nom = String(m.nom || '').trim().slice(0, 40);
    if (!nom) throw new Error('nom du modèle manquant');
    const valeurs = {};
    for (const [k, x] of Object.entries(m.valeurs || {})) {
      if (x === '' || x == null) continue;
      if (['name', 'lat', 'lon', 'owner.info'].includes(k)) continue; // propres à chaque nœud
      const p = PARAMS.find((y) => y.cle === k);
      if (!p) throw new Error('réglage inconnu : ' + k);
      valeurs[k] = valeurValide(p, x);
    }
    const regions = validerRegions((m.regions || []).map((a) => ({ op: String(a.op || '').toLowerCase(), nom: a.nom, parent: a.parent })));
    if (!Object.keys(valeurs).length && !regions.length) throw new Error('aucun réglage dans ce modèle');
    const id = m.id && modeles.some((x) => x.id === m.id) ? m.id : crypto.randomBytes(4).toString('hex');
    const nouveau = { id, nom, description: String(m.description || '').slice(0, 200), valeurs, regions, horloge: m.horloge !== false, redemarrer: !!m.redemarrer, auteur, heure: Date.now() };
    modeles = [...modeles.filter((x) => x.id !== id), nouveau];
    ecrire(fModeles, modeles);
    return nouveau;
  }

  return {
    ecouterTelemetrie: (f) => ecouteursTelemetrie.add(f),
    PARAMS, ELEMENTS, ELEMENTS_DEFAUT,
    modeles: () => modeles,
    enregistrerModele,
    supprimerModele(id) { modeles = modeles.filter((x) => x.id !== id); ecrire(fModeles, modeles); },
    supervision: () => ({ derniere: derniereSupervision || null, intervalleHeures: config.meshcore.supervisionHeures }),
    lancer,
    existe: (cle) => !!reseauMc.q.noeud.get(String(cle).toUpperCase()),
    tache: (id) => { const t = taches.get(id); return t ? vue(t) : null; },
    taches: () => [...taches.values()].reverse().slice(0, 30).map((t) => vue(t, false)),
    arreter(id) { const t = taches.get(id); if (!t) throw new Error('tâche inconnue'); t.arret = true; if (t.statut === 'en_attente' || t.statut === 'reprise') { t.statut = 'annule'; t.prochainEssai = null; t.motDePasse = null; t.secrets = {}; sauverTaches(); } },
    lecture: (cle) => lectures[String(cle).toUpperCase()] || null,
    memorises: () => Object.keys(motsDePasse),
    lectures: () => Object.fromEntries(Object.entries(lectures).map(([k, v]) => [k, { heure: v.heure, nom: (v.valeurs || {}).name }])),
    oublierMotDePasse(cle) { delete motsDePasse[String(cle).toUpperCase()]; ecrire(fMdp, motsDePasse); },
    memoriserMotDePasse(cle, mdp) { motsDePasse[String(cle).toUpperCase()] = String(mdp); ecrire(fMdp, motsDePasse); },
  };
}

module.exports = { creerAdministrationMc, lireVoisins, valeurValide, PARAMS, ELEMENTS };
