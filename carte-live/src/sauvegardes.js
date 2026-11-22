'use strict';
// Sauvegarde des réglages de la carte : fichiers de réglages du volume /data et comptes.
// Une sauvegarde par jour (14 gardées) dans /data/sauvegardes, téléchargeable et restaurable depuis la carte.
// Les données radio (paquets, liens…) ne sont pas sauvegardées : elles se reconstituent toutes seules.
const fs = require('fs');
const path = require('path');

// Tout fichier de réglages ou de saisie humaine du volume /data : ce qui ne se reconstitue pas tout seul.
// Pas les caches ni les téléchargements (relief, communes, feux, sites routiers, geoip, fonds, rapports), qui se
// refont seuls et pèsent lourd ; pas les secrets de session ni la clé maîtresse des équipes (voir plus bas).
const FICHIERS = [
  'reglages.json', 'installations.json', 'traceroutes-reglages.json', 'modules-radio.json', 'config-module.json',
  'configs-noeuds.json', 'lectures-noeuds.json', 'noeuds-administrables.json',
  'meshcore-admin.json', 'meshcore-companion.json', 'meshcore-lectures.json', 'code-agents.txt',
  'federation.json', 'releves/releves.json', 'modules-cles.json', 'passerelle.json', 'equipes.json', 'signalements.json', 'meshcore-capteurs.json', 'maj-auto.json',
  'donateurs.json', // mur des donateurs : liste saisie à la main et réglages (secrets saisis compris, comme equipes.json : sauvegarde en 600, admin seulement)
  // Section ADRASEC : membres, équipes, main courante et recherches de balise d'une ou plusieurs ADRASEC
  // départementales. Données personnelles (noms, indicatifs, fonctions, opérations réelles) : même soin que
  // equipes.json et donateurs.json (fichier en 600, sauvegarde en 600, téléchargement réservé aux administrateurs).
  'adrasec.json',
  'secteurs.json', 'urgence.json', // secteurs d'alerte (géorepérage) et journal des crises : saisis à la main, personnels
  'jeux-canaux.json', // canaux demandés aux membres (clés chiffrées avec la clé maîtresse, comme equipes.json)
  'adhesion.json', // page publique « Rejoindre le réseau », rédigée par l'administrateur
  'noeuds-responsables.json', 'meshcore-proprietaires.json', // qui répond d'un nœud (saisi à la main)
  'modeles-programmation.json', 'meshcore-modeles.json', // modèles de réglages créés à la main
  'meshcore-conformite.json', 'meshcore-configurations.json', // conformité de nuit et sauvegardes du configurateur importées
  'modules-ecoute.json', 'relais-ip.json', // modules en écoute et relais IP déclarés
  'fonctions-masquees.json', 'suivis.json', // fonctions masquées, favoris et « mes nœuds » de chaque compte
  'alertes-bipper.json', // alertes Bipper / GerMaCrise envoyées (numérotation et historique)
  'postgres.json', // réglages de l'archive PostgreSQL (mot de passe saisi compris, fichier déjà en 600)
];
// Volontairement absents : cle-equipes.bin (clé maîtresse : la mettre à côté des clés chiffrées reviendrait à
// sauvegarder les clés de canal en clair ; equipes.js le dit aussi), secret-session.txt (une sauvegarde volée
// permettrait de fabriquer des sessions), code-installation.txt et maj-jeton.txt (jetons à usage unique),
// blocages.json (anti-essais de mot de passe : état du moment), meshcore-taches.json (programmations en cours :
// les rejouer plus tard, sur un autre réseau, serait dangereux), postgres-curseurs.json et
// meshcore-regions-declarees.json (se refont seuls), et les photos des relevés (trop lourdes pour une sauvegarde
// quotidienne ; releves/releves.json garde le texte).
const GARDER = 14;

function creerSauvegardes(dossier, db, journal) {
  const rep = path.join(dossier, 'sauvegardes');
  try { fs.mkdirSync(rep, { recursive: true, mode: 0o700 }); } catch { /* existe */ }

  function contenu() {
    const fichiers = {};
    for (const f of FICHIERS) { try { fichiers[f] = fs.readFileSync(path.join(dossier, f), 'utf8'); } catch { /* absent */ } }
    let comptes = [];
    try { comptes = db.prepare('SELECT * FROM comptes').all(); } catch { /* table absente */ }
    return { format: 'carte-live-sauvegarde', version: 1, date: new Date().toISOString(), fichiers, comptes };
  }
  function nomDuJour(d = new Date()) { return `sauvegarde-${d.toISOString().slice(0, 10)}.json`; }

  function sauvegarder() {
    const c = contenu();
    const nom = nomDuJour();
    fs.writeFileSync(path.join(rep, nom), JSON.stringify(c), { mode: 0o600 });
    // Rotation : on garde les plus récentes
    const liste = fs.readdirSync(rep).filter((x) => /^sauvegarde-\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort();
    for (const x of liste.slice(0, Math.max(0, liste.length - GARDER))) { try { fs.unlinkSync(path.join(rep, x)); } catch { /* ignoré */ } }
    journal(`[Sauvegarde] ${nom} : ${Object.keys(c.fichiers).length} fichiers de réglages, ${c.comptes.length} comptes`);
    return { nom, fichiers: Object.keys(c.fichiers).length, comptes: c.comptes.length };
  }

  function liste() {
    return fs.readdirSync(rep).filter((x) => /^sauvegarde-\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort().reverse()
      .map((nom) => { const st = fs.statSync(path.join(rep, nom)); return { nom, taille: st.size, date: st.mtimeMs }; });
  }
  function lire(nom) {
    if (!/^sauvegarde-\d{4}-\d{2}-\d{2}\.json$/.test(nom)) throw new Error('Nom invalide');
    return fs.readFileSync(path.join(rep, nom));
  }

  // Restauration : fichiers réécrits, comptes remplacés ; le service redémarre ensuite
  function restaurer(s) {
    if (!s || s.format !== 'carte-live-sauvegarde' || typeof s.fichiers !== 'object') throw new Error('Ce fichier n’est pas une sauvegarde de la carte');
    // Sauvegarde de sécurité de l'état actuel avant d'écraser
    const avant = path.join(rep, 'avant-restauration.json');
    fs.writeFileSync(avant, JSON.stringify(contenu()), { mode: 0o600 });
    try { fs.chmodSync(avant, 0o600); } catch { /* fichier déjà présent sur un système sans chmod */ }
    let n = 0;
    const rates = [];
    for (const [f, texte] of Object.entries(s.fichiers)) {
      if (!FICHIERS.includes(f) || typeof texte !== 'string') continue;
      // Un fichier écrit dans un sous-dossier (releves/) peut venir d'une carte où ce dossier existait déjà :
      // on le crée au besoin, et un échec sur un fichier ne fait pas perdre tous les suivants.
      const cible = path.join(dossier, f);
      try {
        fs.mkdirSync(path.dirname(cible), { recursive: true, mode: 0o700 });
        fs.writeFileSync(cible, texte, { mode: 0o600 });
        // writeFileSync n'applique le mode qu'à la création : on le force aussi sur un fichier déjà là
        // (adrasec.json, equipes.json, donateurs.json… contiennent des données personnelles).
        try { fs.chmodSync(cible, 0o600); } catch { /* système de fichiers sans chmod */ }
        n++;
      } catch (e) { rates.push(`${f} (${e.message})`); }
    }
    if (rates.length) journal(`[Sauvegarde] non restauré${rates.length > 1 ? 's' : ''} : ${rates.join(', ')}`);
    let c = 0;
    if (Array.isArray(s.comptes) && s.comptes.length) {
      const cols = ['id', 'identifiant', 'indicatif', 'email', 'hash', 'role', 'statut', 'cree', 'derniere', 'version', 'noeuds', 'totp', 'totp_dernier'];
      const ins = db.prepare(`INSERT INTO comptes (${cols.join(', ')}) VALUES (${cols.map((x) => '@' + x).join(', ')})`);
      db.transaction(() => {
        db.prepare('DELETE FROM comptes').run();
        for (const x of s.comptes) { if (x && x.identifiant && x.hash) { ins.run(Object.fromEntries(cols.map((k) => [k, x[k] ?? null]))); c++; } }
      })();
    }
    journal(`[Sauvegarde] restauration du ${s.date} : ${n} fichiers, ${c} comptes ; redémarrage`);
    return { fichiers: n, comptes: c, date: s.date };
  }

  // Une sauvegarde par jour, vers 3 h 30 (et au démarrage s'il n'y en a pas encore aujourd'hui)
  setInterval(() => { const d = new Date(); if (d.getHours() === 3 && d.getMinutes() >= 30 && d.getMinutes() < 32) { try { sauvegarder(); } catch (e) { journal('[Sauvegarde]', e.message); } } }, 120000).unref();
  setTimeout(() => { try { if (!fs.existsSync(path.join(rep, nomDuJour()))) sauvegarder(); } catch (e) { journal('[Sauvegarde]', e.message); } }, 60000).unref();

  return { sauvegarder, liste, lire, restaurer };
}

module.exports = { creerSauvegardes, FICHIERS };
