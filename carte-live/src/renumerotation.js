'use strict';
// Firmware 2.8 : le numéro d'un nœud est désormais calculé à partir de sa clé publique. À la mise à jour, il change
// de numéro mais garde sa clé : la carte le verrait comme un nœud nouveau, sans historique, et l'ancien deviendrait muet.
// On repère ces cas grâce à la clé publique (fiche NodeInfo) et on propose de fusionner l'historique.
// Deux nœuds ACTIFS en même temps avec la même clé = configuration clonée (problème de sécurité et de routage PKI).

const fs = require('fs');
const path = require('path');

function creerRenumerotation({ stockage, config, installations, comptes, administration, journal }) {
  const db = stockage.db;
  const fHisto = path.join(path.dirname(config.fichierBase), 'renumerotations.json');
  let histo = [];
  try { histo = JSON.parse(fs.readFileSync(fHisto, 'utf8')); } catch { /* aucun */ }
  const sauver = () => { try { fs.writeFileSync(fHisto, JSON.stringify(histo.slice(-200))); } catch { /* lecture seule */ } };
  const id = (num) => '!' + (num >>> 0).toString(16).padStart(8, '0');
  const nom = (n) => (n && (n.nom_long || n.nom_court)) || (n ? id(n.num) : '?');
  const q = {
    groupes: db.prepare(`SELECT cle_publique AS cle, COUNT(*) AS nb FROM noeuds WHERE cle_publique IS NOT NULL AND cle_publique <> '' GROUP BY cle_publique HAVING COUNT(*) > 1`),
    parCle: db.prepare('SELECT * FROM noeuds WHERE cle_publique = ? ORDER BY premier_vu'),
  };

  // Renumérotations probables (l'ancien s'est tu quand le nouveau est apparu) et clés en double (les deux actifs)
  function detecter() {
    const renum = [], doublons = [];
    const fusionnes = new Set(histo.map((h) => h.ancien));
    for (const g of q.groupes.all()) {
      const l = q.parCle.all(g.cle);
      // Paires successives par ordre d'apparition
      for (let i = 0; i < l.length - 1; i++) {
        const a = l[i], b = l[l.length - 1];
        if (fusionnes.has(a.num >>> 0)) continue;
        const chevauchement = (a.dernier_vu || 0) - (b.premier_vu || 0); // > 0 : l'ancien encore entendu après l'arrivée du nouveau
        const entree = {
          ancien: { num: a.num >>> 0, id: id(a.num), nom: nom(a), premierVu: a.premier_vu, dernierVu: a.dernier_vu, firmware: a.firmware, role: a.role },
          nouveau: { num: b.num >>> 0, id: id(b.num), nom: nom(b), premierVu: b.premier_vu, dernierVu: b.dernier_vu, firmware: b.firmware, role: b.role },
        };
        // Tolérance de 6 h : d'autres nœuds peuvent encore relayer l'ancienne fiche quelque temps
        if (chevauchement < 6 * 3600000) renum.push(entree);
        else doublons.push({ ...entree, chevauchementH: Math.round(chevauchement / 3600000) });
      }
    }
    return { renumerotations: renum, doublons, historique: histo.slice(-20).reverse() };
  }

  // Fusion : tout l'historique de l'ancien numéro passe au nouveau, l'ancien disparaît de la carte
  function fusionner(ancien, nouveau, auteur) {
    ancien >>>= 0; nouveau >>>= 0;
    const a = stockage.q.noeud.get(ancien), b = stockage.q.noeud.get(nouveau);
    if (!a || !b) throw new Error('Nœud inconnu');
    if (!a.cle_publique || a.cle_publique !== b.cle_publique) throw new Error('Les deux nœuds n’ont pas la même clé publique : fusion refusée');
    const lignes = {};
    const run = (sql, ...p) => db.prepare(sql).run(...p).changes;
    db.transaction(() => {
      lignes.positions = run('UPDATE positions SET num = ? WHERE num = ?', nouveau, ancien);
      lignes.telemetrie = run('UPDATE telemetrie SET num = ? WHERE num = ?', nouveau, ancien);
      lignes.paquets = run('UPDATE OR IGNORE paquets SET de = ? WHERE de = ?', nouveau, ancien) + run('UPDATE paquets SET vers = ? WHERE vers = ?', nouveau, ancien);
      lignes.receptions = run('UPDATE OR IGNORE receptions SET passerelle = ? WHERE passerelle = ?', nouveau, ancien);
      run('UPDATE receptions SET relais_num = ? WHERE relais_num = ?', nouveau, ancien);
      lignes.liens = run('UPDATE OR IGNORE liens SET a = ? WHERE a = ?', nouveau, ancien) + run('UPDATE OR IGNORE liens SET b = ? WHERE b = ?', nouveau, ancien);
      run('DELETE FROM liens WHERE a = ? OR b = ?', ancien, ancien);
      run('UPDATE traceroutes SET cible = ? WHERE cible = ?', nouveau, ancien);
      run('UPDATE traceroutes SET origine = ? WHERE origine = ?', nouveau, ancien);
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
    const fiche = installations.deplacer(ancien, nouveau);
    const secteurs = comptes.remplacerNoeud(ancien, nouveau);
    administration.renumeroter(ancien, nouveau);
    const h = { ancien, nouveau, idAncien: id(ancien), idNouveau: id(nouveau), nom: nom(b) !== id(nouveau) ? nom(b) : nom(a), heure: Date.now(), par: auteur, lignes, fiche, secteurs };
    histo.push(h); sauver();
    journal(`[2.8] ${id(ancien)} → ${id(nouveau)} (${h.nom}) fusionnés par ${auteur} : ${Object.entries(lignes).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    return h;
  }

  return { detecter, fusionner };
}

module.exports = { creerRenumerotation };
