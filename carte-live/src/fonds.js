'use strict';
// Fond de carte hors ligne : un fichier PMTiles (carte vectorielle OpenStreetMap, Protomaps) pour la zone de la carte,
// stocké à côté de la base et servi par la carte elle-même. Il permet d'afficher routes, chemins, noms, eau et forêts
// sans aucun accès à internet (installation autonome sur Raspberry Pi, coupure du réseau).
// Extraction : outil « pmtiles » (go-pmtiles, inclus dans l'image Docker) depuis la carte mondiale publiée chaque
// jour par Protomaps : seuls les morceaux de la zone sont téléchargés (≈ 50 Mo pour un département au zoom 14).
// Données © contributeurs OpenStreetMap (ODbL), carte Protomaps.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { ecrireSur, lireJson } = require('./fichiers');

const BUILDS = process.env.PROTOMAPS_BUILDS || 'https://build-metadata.protomaps.dev/builds.json';
const BASE_BUILDS = process.env.PROTOMAPS_BASE || 'https://build.protomaps.com/';
const FRANCE = [41.3, -5.3, 51.2, 9.7]; // sud, ouest, nord, est (métropole et Corse)

function creerFonds({ config, departements, journal = () => {} }) {
  const dossier = path.join(path.dirname(config.fichierBase), 'fonds');
  const fichier = path.join(dossier, 'fond.pmtiles');
  const fMeta = path.join(dossier, 'fond.json');
  let meta = null;
  try { meta = lireJson(fMeta); } catch { /* pas encore de fond */ }
  if (meta && !fs.existsSync(fichier)) meta = null;
  const enCours = { actif: false, etape: null, debut: null, erreur: null, zone: null };
  let proc = null;

  function outil() {
    for (const b of [process.env.PMTILES_BIN, 'pmtiles', 'go-pmtiles'].filter(Boolean)) {
      try { execFileSync(b, ['version'], { stdio: 'ignore', timeout: 5000 }); return b; } catch { /* suivant */ }
    }
    return null;
  }
  const codeCarte = () => String(config.departement.code).toUpperCase();
  const bboxDep = (code) => { const d = departements().find((x) => x.code === code); return d ? d.bbox : null; };
  // Zone demandée → rectangle [sud, ouest, nord, est] avec une marge (les relais voisins restent sur le fond)
  function rectangle(zone) {
    if (zone === 'france') return FRANCE;
    const b = bboxDep(zone === 'departement' || zone === 'voisins' ? codeCarte() : String(zone).toUpperCase());
    if (!b) return null;
    const m = zone === 'voisins' ? 0.6 : 0.08;
    return [b[0] - m, b[1] - m * 1.4, b[2] + m, b[3] + m * 1.4].map((v) => +v.toFixed(4));
  }

  function etat() {
    return {
      outil: !!outil(),
      fond: meta && { zone: meta.zone, nom: meta.nom, maxzoom: meta.maxzoom, tailleMo: meta.tailleMo, date: meta.date, carte: meta.carte, bbox: meta.bbox },
      enCours: { ...enCours },
    };
  }

  async function derniereCarte() {
    const r = await fetch(BUILDS, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('liste des cartes Protomaps : HTTP ' + r.status);
    const l = (await r.json()).filter((x) => /^\d{8}\.pmtiles$/.test(x.key)).sort((a, b) => a.key.localeCompare(b.key));
    if (!l.length) throw new Error('aucune carte Protomaps publiée');
    return l[l.length - 1].key;
  }

  // Télécharge (ou remplace) le fond : zone = 'departement' | 'voisins' | 'france' | code de département
  async function telecharger({ zone = 'departement', maxzoom = 14 } = {}, auteur = 'automatique') {
    if (enCours.actif) throw new Error('Téléchargement déjà en cours');
    const bin = outil();
    if (!bin) throw new Error('Outil « pmtiles » absent : il est inclus dans l’image Docker de la carte (mettez la carte à jour)');
    const bbox = rectangle(zone);
    if (!bbox) throw new Error('Zone inconnue');
    const z = Math.min(15, Math.max(10, Number(maxzoom) || 14));
    Object.assign(enCours, { actif: true, etape: 'recherche de la dernière carte', debut: Date.now(), erreur: null, zone });
    fs.mkdirSync(dossier, { recursive: true });
    const tmp = fichier + '.part';
    try {
      const cle = await derniereCarte();
      enCours.etape = `extraction (carte du ${cle.slice(6, 8)}/${cle.slice(4, 6)}/${cle.slice(0, 4)})`;
      journal(`[Fond hors ligne] ${zone}, zoom ${z}, carte ${cle} (par ${auteur})`);
      await new Promise((ok, ko) => {
        const args = ['extract', BASE_BUILDS + cle, tmp, `--bbox=${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]}`, `--maxzoom=${z}`];
        proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const lire = (b) => { const t = String(b).trim().split('\n').pop(); const m = /(\d+)%/.exec(t); if (m) enCours.etape = `extraction ${m[1]} %`; };
        proc.stdout.on('data', lire); proc.stderr.on('data', lire);
        const minuterie = setTimeout(() => proc && proc.kill(), 60 * 60000);
        proc.on('close', (code) => { clearTimeout(minuterie); proc = null; code === 0 ? ok() : ko(new Error('extraction interrompue (code ' + code + ')')); });
        proc.on('error', ko);
      });
      fs.renameSync(tmp, fichier);
      const nom = zone === 'france' ? 'France' : zone === 'voisins' ? `${config.departement.nom || codeCarte()} et alentours` : zone === 'departement' ? (config.departement.nom || codeCarte()) : (departements().find((x) => x.code === String(zone).toUpperCase()) || {}).nom || zone;
      meta = { zone, nom, maxzoom: z, bbox, carte: cle, date: Date.now(), tailleMo: Math.round(fs.statSync(fichier).size / 1048576) };
      ecrireSur(fMeta, JSON.stringify(meta));
      journal(`[Fond hors ligne] prêt : ${nom}, ${meta.tailleMo} Mo`);
    } catch (e) {
      enCours.erreur = e.message;
      journal(`[Fond hors ligne] erreur : ${e.message}`);
      try { fs.unlinkSync(tmp); } catch { /* rien */ }
      throw e;
    } finally {
      Object.assign(enCours, { actif: false, etape: null });
    }
    return etat();
  }

  function arreter() { if (proc) proc.kill(); }
  function supprimer() {
    arreter();
    for (const f of [fichier, fMeta]) try { fs.unlinkSync(f); } catch { /* déjà */ }
    meta = null;
  }

  // Mise à jour mensuelle du fond existant (nouvelles routes, chemins…), la nuit
  setInterval(() => {
    if (!meta || enCours.actif || new Date().getHours() !== 3) return;
    if (Date.now() - meta.date > 30 * 86400000) telecharger({ zone: meta.zone, maxzoom: meta.maxzoom }).catch(() => {});
  }, 3600000).unref();

  return { etat, telecharger, arreter, supprimer, fichier: () => (meta ? fichier : null) };
}

module.exports = { creerFonds };
