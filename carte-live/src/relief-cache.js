'use strict';
// Cache du relief sur le disque : espace occupé, date de dernière utilisation de chaque zone, purge à la main
// (tout, zone par zone, zones inutilisées depuis N jours) et plafond facultatif (« garder au plus X Go ») qui
// supprime d'abord les zones les moins récemment utilisées.
// Une zone = ses fichiers « mnt-XX.bin/json », points hauts, voies d'accès, sites, villes et communes. Jamais
// supprimés : la zone de la carte (fichiers sans suffixe), une zone en cours de chargement ou de préparation,
// une zone ouverte en mémoire et utilisée depuis moins de 10 minutes, et le relief grossier mondial (sauf demande).
const fs = require('fs');
const path = require('path');
const { ecrireSur, lireJson } = require('./fichiers');

const RE_ZONE = /^(mnt|sommets-osm|acces-sommets|realisme|villes|communes)-((?:\d{2}|2A|2B)|M[NS]\d{2}[EW]\d{3})\.(bin|json)(\.bak|\.tmp)?$/;
const RECENT_MS = 10 * 60000;

// dossier : données de la carte ; verrous() : codes en cours de chargement ou de préparation ;
// enMemoire() : Map code -> instance de relief ouverte ; liberer(code) : ferme l'instance en mémoire
function creerCacheRelief({ dossier, journal = () => {}, verrous = () => new Set(), enMemoire = () => new Map(), liberer = () => {}, grossier = null, nomZone = () => null }) {
  const fUtil = path.join(dossier, 'relief-utilisation.json');
  let utilisation = {};
  try { utilisation = lireJson(fUtil) || {}; } catch { /* premier lancement */ }
  let modifie = false;
  const enregistrer = () => {
    if (!modifie) return;
    modifie = false;
    try { ecrireSur(fUtil, JSON.stringify(utilisation)); } catch (e) { journal('[Relief] utilisation des zones :', e.message); }
  };
  const minuterie = setInterval(enregistrer, 10 * 60000);
  minuterie.unref();

  // Appelé à chaque calcul : la date n'est écrite sur le disque qu'au plus toutes les 10 minutes
  function noterUtilisation(code) {
    if (!code) return;
    const c = String(code).toUpperCase(), t = Date.now();
    if (!utilisation[c] || t - utilisation[c] > 60000) { utilisation[c] = t; modifie = true; }
  }

  function zones() {
    const parCode = new Map();
    let noms = [];
    try { noms = fs.readdirSync(dossier); } catch { return []; }
    for (const f of noms) {
      const m = RE_ZONE.exec(f);
      if (!m) continue;
      let st;
      try { st = fs.statSync(path.join(dossier, f)); } catch { continue; }
      if (!st.isFile()) continue;
      const code = m[2].toUpperCase();
      if (!parCode.has(code)) parCode.set(code, { code, octets: 0, fichiers: [], mnt: false, mtime: 0 });
      const z = parCode.get(code);
      z.octets += st.size; z.fichiers.push(f);
      if (m[1] === 'mnt' && m[3] === 'bin' && !m[4]) { z.mnt = true; z.mtime = st.mtimeMs; }
    }
    const v = verrous(), mem = enMemoire();
    return [...parCode.values()].map((z) => {
      const ouverte = mem.get(z.code);
      const verrou = v.has(z.code) || !!(ouverte && ouverte.etat && ouverte.etat().mnt !== 'pret' && ouverte.etat().mnt !== 'erreur');
      const derniere = utilisation[z.code] || z.mtime || null;
      return { ...z, nom: nomZone(z.code), derniere, verrou, enMemoire: !!ouverte, recente: !!(ouverte && derniere && Date.now() - derniere < RECENT_MS) };
    }).sort((a, b) => (b.derniere || 0) - (a.derniere || 0));
  }

  // Zone de la carte : fichiers sans suffixe (jamais purgés)
  function principale() {
    let octets = 0;
    for (const f of ['mnt.bin', 'mnt.json', 'sommets-osm.json', 'acces-sommets.json', 'realisme.json']) { try { octets += fs.statSync(path.join(dossier, f)).size; } catch { /* absent */ } }
    return { octets };
  }

  function inventaire(plafondGo = 0) {
    const l = zones(), p = principale();
    const g = grossier ? grossier.etat() : null;
    const totalZones = l.reduce((t, z) => t + z.octets, 0);
    return {
      totalOctets: totalZones + p.octets + (g ? g.octetsDisque : 0),
      zonesOctets: totalZones, nbZones: l.length, principale: p,
      grossier: g && { statut: g.statut, octets: g.octetsDisque, progression: g.progression, erreur: g.erreur, resolutionKm: g.resolutionKm, enCours: g.enCours },
      plafondGo: plafondGo || 0,
      zones: l.map(({ fichiers, mtime, ...z }) => ({ ...z, nbFichiers: fichiers.length })),
    };
  }

  // Pourquoi une zone ne peut pas être supprimée maintenant (null = possible)
  const refus = (z) => (z.verrou ? 'en cours de chargement ou de préparation' : z.recente ? 'utilisée il y a moins de 10 minutes' : null);

  function supprimerZone(z) {
    if (z.enMemoire) { try { liberer(z.code); } catch { /* déjà fermée */ } }
    let octets = 0;
    for (const f of z.fichiers) {
      const p = path.join(dossier, f);
      try { const s = fs.statSync(p).size; fs.unlinkSync(p); octets += s; } catch { /* déjà supprimé */ }
    }
    delete utilisation[z.code]; modifie = true;
    return octets;
  }

  // { codes: [...] } | { tout: true } | { joursInactifs: N } ; grossier: true pour supprimer aussi le relief mondial
  async function purger({ codes = null, tout = false, joursInactifs = null, grossier: avecGrossier = false } = {}, qui = '?') {
    const l = zones();
    let cibles;
    if (tout) cibles = l;
    else if (Number.isFinite(joursInactifs) && joursInactifs >= 0) cibles = l.filter((z) => !z.derniere || Date.now() - z.derniere > joursInactifs * 86400000);
    else if (Array.isArray(codes)) { const s = new Set(codes.map((c) => String(c).toUpperCase())); cibles = l.filter((z) => s.has(z.code)); }
    else cibles = [];
    const supprimees = [], refusees = [];
    let octets = 0;
    for (const z of cibles) {
      const r = refus(z);
      if (r) { refusees.push({ code: z.code, raison: r }); continue; }
      octets += supprimerZone(z);
      supprimees.push(z.code);
    }
    if (avecGrossier && grossier) {
      const avant = grossier.etat().octetsDisque;
      await grossier.supprimer();
      octets += avant;
      supprimees.push('monde');
    }
    enregistrer();
    if (supprimees.length || refusees.length) {
      journal(`[Relief] purge du relief par ${qui} : ${supprimees.length} zone(s) supprimée(s) (${(octets / 1048576).toFixed(1)} Mo libérés)${supprimees.length ? ' : ' + supprimees.slice(0, 20).join(', ') : ''}${refusees.length ? `, ${refusees.length} gardée(s) (en cours d’utilisation)` : ''}`);
    }
    return { supprimees, refusees, octetsLiberes: octets };
  }

  // Plafond : tant que les zones dépassent X Go, supprime la moins récemment utilisée (jamais une zone protégée)
  function appliquerPlafond(plafondGo) {
    const max = Number(plafondGo) * 1e9;
    if (!(max > 0)) return { supprimees: [], octetsLiberes: 0 };
    const l = zones();
    let total = l.reduce((t, z) => t + z.octets, 0);
    const supprimees = [];
    let octets = 0;
    for (const z of [...l].sort((a, b) => (a.derniere || 0) - (b.derniere || 0))) {
      if (total <= max) break;
      if (refus(z)) continue;
      const o = supprimerZone(z);
      total -= z.octets; octets += o;
      supprimees.push(z.code);
    }
    enregistrer();
    if (supprimees.length) journal(`[Relief] plafond de ${plafondGo} Go dépassé : ${supprimees.length} zone(s) la(les) moins utilisée(s) supprimée(s) (${(octets / 1048576).toFixed(1)} Mo) : ${supprimees.slice(0, 20).join(', ')}`);
    return { supprimees, octetsLiberes: octets };
  }

  return { noterUtilisation, inventaire, purger, appliquerPlafond, enregistrer, arreter: () => { clearInterval(minuterie); enregistrer(); } };
}

module.exports = { creerCacheRelief, RE_ZONE };
