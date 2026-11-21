'use strict';
// Firmware 2.8 : le numéro d'un nœud est désormais calculé à partir de sa clé publique. À la mise à jour, il change
// de numéro mais garde sa clé : la carte le verrait comme un nœud nouveau, sans historique, et l'ancien deviendrait muet.
// On repère ces cas grâce à la clé publique (fiche NodeInfo) et on propose de fusionner l'historique.
// Deux nœuds ACTIFS en même temps avec la même clé = configuration clonée (problème de sécurité et de routage PKI).

const fs = require('fs');
const { ecrireSur, lireJson } = require('./fichiers');
const path = require('path');
const { numDeCle } = require('./signature');

function creerRenumerotation({ stockage, config, installations, comptes, administration, journal, autres = () => ({}) }) {
  const db = stockage.db;
  const dossier = path.dirname(config.fichierBase);
  const fHisto = path.join(dossier, 'renumerotations.json');
  const dAnnul = path.join(dossier, 'renumerotations');
  let histo = [];
  try { histo = lireJson(fHisto) || []; } catch { /* aucun */ }
  const sauver = () => { try { ecrireSur(fHisto, JSON.stringify(histo.slice(-200))); } catch { /* lecture seule */ } };
  const id = (num) => '!' + (num >>> 0).toString(16).padStart(8, '0');
  const nom = (n) => (n && (n.nom_long || n.nom_court)) || (n ? id(n.num) : '?');
  const q = {
    groupes: db.prepare(`SELECT cle_publique AS cle, COUNT(*) AS nb FROM noeuds WHERE cle_publique IS NOT NULL AND cle_publique <> '' GROUP BY cle_publique HAVING COUNT(*) > 1`),
    parCle: db.prepare('SELECT * FROM noeuds WHERE cle_publique = ? ORDER BY premier_vu'),
    nommes: db.prepare(`SELECT * FROM noeuds WHERE nom_long IS NOT NULL AND nom_long <> '' AND nom_long IN
      (SELECT nom_long FROM noeuds WHERE nom_long IS NOT NULL AND nom_long <> '' GROUP BY nom_long HAVING COUNT(*) > 1) ORDER BY premier_vu`),
  };
  const fiche = (n) => ({ num: n.num >>> 0, id: id(n.num), nom: nom(n), premierVu: n.premier_vu, dernierVu: n.dernier_vu, firmware: n.firmware, role: n.role, materiel: n.materiel });
  // Numéro 2.8 : CRC32 de la clé publique. S'il correspond, la renumérotation est certaine.
  const numero28 = (n) => !!n.cle_publique && numDeCle(n.cle_publique) === (n.num >>> 0);
  const NOM_DEFAUT = /^Meshtastic [0-9a-f]{4}$/i; // nom d'usine, dérivé du numéro : ne prouve rien

  // Renumérotations (même clé : l'ancien s'est tu quand le nouveau est apparu), clés en double (les deux actifs),
  // et nœuds probablement réinitialisés (effacement complet → nouvelle clé : même nom et même matériel seulement)
  function detecter() {
    const renum = [], doublons = [], probables = [];
    const fusionnes = new Set(histo.filter((h) => !h.annule).map((h) => h.ancien));
    const vus = new Set();
    for (const g of q.groupes.all()) {
      const l = q.parCle.all(g.cle);
      for (let i = 0; i < l.length - 1; i++) {
        const a = l[i], b = l[l.length - 1];
        if (fusionnes.has(a.num >>> 0)) continue;
        vus.add(a.num >>> 0);
        const chevauchement = (a.dernier_vu || 0) - (b.premier_vu || 0); // > 0 : l'ancien encore entendu après l'arrivée du nouveau
        const entree = { ancien: fiche(a), nouveau: fiche(b), certain: numero28(b) };
        // Tolérance de 6 h : d'autres nœuds peuvent encore relayer l'ancienne fiche quelque temps
        if (chevauchement < 6 * 3600000) renum.push(entree);
        else doublons.push({ ...entree, chevauchementH: Math.round(chevauchement / 3600000) });
      }
    }
    const parNom = new Map();
    for (const n of q.nommes.all()) { if (NOM_DEFAUT.test(n.nom_long)) continue; const k = n.nom_long + '|' + (n.materiel || ''); (parNom.get(k) || parNom.set(k, []).get(k)).push(n); }
    for (const l of parNom.values()) {
      if (l.length < 2) continue;
      const b = l[l.length - 1];
      if (!numero28(b)) continue; // le nouveau doit être un nœud 2.8
      for (const a of l.slice(0, -1)) {
        if (fusionnes.has(a.num >>> 0) || vus.has(a.num >>> 0) || (a.cle_publique && a.cle_publique === b.cle_publique)) continue;
        if ((a.dernier_vu || 0) - (b.premier_vu || 0) > 6 * 3600000) continue; // les deux actifs : deux nœuds distincts
        probables.push({ ancien: fiche(a), nouveau: fiche(b), raison: 'même nom et même matériel, nouvelle clé (nœud effacé puis reflashé ?)' });
      }
    }
    return { renumerotations: renum, doublons, probables, historique: histo.slice(-20).reverse().map((h) => ({ ...h, annulable: !h.annule && fs.existsSync(fichierAnnul(h)) })) };
  }

  const fichierAnnul = (h) => path.join(dAnnul, `${h.heure}-${h.ancien}-${h.nouveau}.json`);
  const COLS_FICHE = ['nom_long', 'nom_court', 'materiel', 'role', 'lat', 'lon', 'alt', 'heure_position', 'premier_vu', 'est_passerelle'];

  // Fusion : tout l'historique de l'ancien numéro passe au nouveau, l'ancien disparaît de la carte.
  // Ce qui est déplacé est noté (numéros de lignes) pour pouvoir annuler la fusion ensuite.
  // force : nœud réinitialisé (clés différentes), seulement si même nom long et même matériel.
  function fusionner(ancien, nouveau, auteur, { force = false } = {}) {
    ancien >>>= 0; nouveau >>>= 0;
    if (ancien === nouveau) throw new Error('Même nœud');
    const a = stockage.q.noeud.get(ancien), b = stockage.q.noeud.get(nouveau);
    if (!a || !b) throw new Error('Nœud inconnu');
    const memeCle = !!a.cle_publique && a.cle_publique === b.cle_publique;
    if (!memeCle) {
      if (!force) throw new Error('Les deux nœuds n’ont pas la même clé publique : fusion refusée');
      if (!a.nom_long || a.nom_long !== b.nom_long || (a.materiel || '') !== (b.materiel || '') || NOM_DEFAUT.test(a.nom_long)) throw new Error('Fusion forcée refusée : il faut le même nom long et le même matériel');
    }
    const lignes = {}, annul = { ancienNoeud: a, nouveauAvant: Object.fromEntries(COLS_FICHE.map((c) => [c, b[c]])), deplaces: {}, liensSupprimes: [] };
    const run = (sql, ...p) => db.prepare(sql).run(...p).changes;
    const ids = (sql, ...p) => db.prepare(sql).all(...p).map((r) => r.rowid);
    // Déplace les lignes « col = ancien » de la table ; garde les numéros des lignes réellement déplacées
    const deplacer = (table, col, ignorer = false) => {
      const avant = ids(`SELECT rowid FROM ${table} WHERE ${col} = ?`, ancien);
      if (!avant.length) return 0;
      run(`UPDATE ${ignorer ? 'OR IGNORE ' : ''}${table} SET ${col} = ? WHERE ${col} = ?`, nouveau, ancien);
      const restes = new Set(ignorer ? ids(`SELECT rowid FROM ${table} WHERE ${col} = ?`, ancien) : []);
      const faits = avant.filter((r) => !restes.has(r));
      annul.deplaces[table + '.' + col] = faits;
      return faits.length;
    };
    db.transaction(() => {
      lignes.positions = deplacer('positions', 'num');
      lignes.telemetrie = deplacer('telemetrie', 'num');
      lignes.paquets = deplacer('paquets', 'de', true) + deplacer('paquets', 'vers');
      lignes.receptions = deplacer('receptions', 'passerelle', true);
      deplacer('receptions', 'relais_num');
      lignes.liens = deplacer('liens', 'a', true) + deplacer('liens', 'b', true);
      annul.liensSupprimes = db.prepare('SELECT * FROM liens WHERE a = ? OR b = ?').all(ancien, ancien);
      run('DELETE FROM liens WHERE a = ? OR b = ?', ancien, ancien);
      deplacer('traceroutes', 'cible');
      deplacer('traceroutes', 'origine');
      // Fiche du nœud : ce que le nouveau numéro ne sait pas encore (nom, matériel, position d'un relais fixe…)
      run(`UPDATE noeuds SET
        nom_long = COALESCE(nom_long, @nomLong), nom_court = COALESCE(nom_court, @nomCourt), materiel = COALESCE(materiel, @materiel),
        role = COALESCE(role, @role), lat = COALESCE(lat, @lat), lon = COALESCE(lon, @lon), alt = COALESCE(alt, @alt),
        heure_position = COALESCE(heure_position, @heurePosition), premier_vu = MIN(premier_vu, @premierVu),
        est_passerelle = MAX(COALESCE(est_passerelle, 0), @passerelle)
        WHERE num = @num`.replace(/@(\w+)/g, ':$1'), {
        nomLong: a.nom_long, nomCourt: a.nom_court, materiel: a.materiel, role: a.role, lat: a.lat, lon: a.lon, alt: a.alt,
        heurePosition: a.heure_position, premierVu: a.premier_vu || b.premier_vu, passerelle: a.est_passerelle ? 1 : 0, num: nouveau,
      });
      run('DELETE FROM noeuds WHERE num = ?', ancien);
    })();
    const o = autres();
    const autresModules = {
      fiche: installations.deplacer(ancien, nouveau),
      secteurs: comptes.remplacerNoeud(ancien, nouveau),
      equipes: o.equipes ? o.equipes.renumeroter(ancien, nouveau) : 0,
      suivis: o.suivis ? o.suivis.renumeroter(ancien, nouveau) : 0,
    };
    if (o.responsables) o.responsables.remplacerNoeud(ancien, nouveau);
    administration.renumeroter(ancien, nouveau);
    const h = { ancien, nouveau, idAncien: id(ancien), idNouveau: id(nouveau), nom: nom(b) !== id(nouveau) ? nom(b) : nom(a), heure: Date.now(), par: auteur, lignes, ...autresModules, force: !memeCle || undefined };
    try { fs.mkdirSync(dAnnul, { recursive: true }); ecrireSur(fichierAnnul(h), JSON.stringify(annul)); } catch (e) { journal('[2.8] annulation impossible à préparer :', e.message); }
    histo.push(h); sauver();
    // Fichiers d'annulation : les 20 dernières fusions seulement
    try { const l = fs.readdirSync(dAnnul).filter((f) => f.endsWith('.json')).sort(); for (const f of l.slice(0, -20)) fs.unlinkSync(path.join(dAnnul, f)); } catch { /* rien */ }
    journal(`[2.8] ${id(ancien)} → ${id(nouveau)} (${h.nom}) fusionnés par ${auteur}${h.force ? ' (fusion forcée, clés différentes)' : ''} : ${Object.entries(lignes).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    return h;
  }

  // Annuler une fusion : l'ancien numéro revient avec son historique (tel qu'il était à la fusion)
  function annuler(heure, ancien, nouveau, auteur) {
    const h = histo.find((x) => x.heure === Number(heure) && x.ancien === (ancien >>> 0) && x.nouveau === (nouveau >>> 0) && !x.annule);
    if (!h) throw new Error('Fusion introuvable ou déjà annulée');
    let annul;
    try { annul = JSON.parse(fs.readFileSync(fichierAnnul(h), 'utf8')); } catch { throw new Error('Cette fusion ne peut plus être annulée (fichier d’annulation absent : seules les 20 dernières le peuvent)'); }
    if (stockage.q.noeud.get(h.ancien)) throw new Error(`L’ancien numéro ${h.idAncien} a été réentendu depuis : annulation impossible sans écraser ses nouvelles données`);
    const run = (sql, ...p) => db.prepare(sql).run(...p).changes;
    let remis = 0;
    db.transaction(() => {
      const a = annul.ancienNoeud, cols = Object.keys(a);
      db.prepare(`INSERT INTO noeuds (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(a);
      // Fiche du nouveau : seules les valeurs que la fusion avait remplies redeviennent vides
      const av = annul.nouveauAvant;
      for (const c of COLS_FICHE) if (av[c] == null || c === 'premier_vu' || c === 'est_passerelle') run(`UPDATE noeuds SET ${c} = ? WHERE num = ?`, av[c] ?? null, h.nouveau);
      for (const [cle, rowids] of Object.entries(annul.deplaces)) {
        const [table, col] = cle.split('.');
        for (let i = 0; i < rowids.length; i += 500) {
          const lot = rowids.slice(i, i + 500);
          remis += run(`UPDATE OR IGNORE ${table} SET ${col} = ? WHERE ${col} = ? AND rowid IN (${lot.map(() => '?').join(',')})`, h.ancien, h.nouveau, ...lot);
        }
      }
      for (const l of annul.liensSupprimes) { const c = Object.keys(l); db.prepare(`INSERT OR IGNORE INTO liens (${c.join(', ')}) VALUES (${c.map((x) => '@' + x).join(', ')})`).run(l); }
    })();
    const o = autres();
    if (h.fiche) installations.deplacer(h.nouveau, h.ancien);
    if (h.secteurs) comptes.remplacerNoeud(h.nouveau, h.ancien);
    if (h.equipes && o.equipes) o.equipes.renumeroter(h.nouveau, h.ancien);
    if (h.suivis && o.suivis) o.suivis.renumeroter(h.nouveau, h.ancien);
    if (o.responsables) o.responsables.remplacerNoeud(h.nouveau, h.ancien);
    administration.renumeroter(h.nouveau, h.ancien);
    h.annule = { heure: Date.now(), par: auteur, lignes: remis };
    sauver();
    try { fs.unlinkSync(fichierAnnul(h)); } catch { /* déjà absent */ }
    journal(`[2.8] fusion ${h.idAncien} → ${h.idNouveau} annulée par ${auteur} : ${remis} lignes rendues à ${h.idAncien}`);
    return h;
  }

  return { detecter, fusionner, annuler };
}

module.exports = { creerRenumerotation };
