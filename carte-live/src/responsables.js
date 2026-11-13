'use strict';
// Responsable d'un nœud : la personne qui en répond (nom ou indicatif libre, ou un compte de la carte), avec un
// contact facultatif. Visible des membres connectés seulement (jamais sur la carte publique) ; le contact, des
// seuls gestionnaires. Modifiable par qui peut gérer le nœud. Un administrateur peut en plus donner au compte
// choisi le droit de régler ce nœud (le nœud entre alors dans le secteur du compte).
const path = require('path');
const { ecrireSur, lireJson } = require('./fichiers');

function creerResponsables({ config, comptes, journal = () => {} }) {
  const fichier = path.join(path.dirname(config.fichierBase), 'noeuds-responsables.json');
  let table = {};
  try { const d = lireJson(fichier); if (d && typeof d === 'object') table = d; } catch { /* aucun */ }
  const sauver = () => ecrireSur(fichier, JSON.stringify(table));
  const cle = (id) => (/^[0-9a-f]{64}$/i.test(String(id)) ? String(id).toUpperCase() : String(Number(id) >>> 0));
  const texte = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

  function nomCompte(id) {
    const c = comptes.lister().find((x) => x.id === Number(id));
    return c ? (c.indicatif ? `${c.identifiant} (${c.indicatif})` : c.identifiant) : null;
  }
  // Vue pour un membre (sans contact) ou un gestionnaire (avec contact)
  function liste({ avecContact = false } = {}) {
    const o = {};
    for (const [k, r] of Object.entries(table)) {
      o[k] = { personne: r.personne || nomCompte(r.compteId) || null, compte: r.compteId ? nomCompte(r.compteId) : null, compteId: r.compteId || null, depuis: r.heure, par: r.par };
      if (avecContact && r.contact) o[k].contact = r.contact;
    }
    return o;
  }
  function definir(id, { personne, compteId, contact, droit } = {}, { auteur, admin }) {
    const k = cle(id);
    const p = texte(personne, 60), c = texte(contact, 120);
    const cid = compteId ? Number(compteId) : null;
    if (cid && !comptes.lister().some((x) => x.id === cid)) throw new Error('Compte inconnu');
    if (!p && !cid) {
      if (table[k]) { delete table[k]; sauver(); journal(`[Responsables] ${k} : responsable retiré par ${auteur}`); }
      return null;
    }
    table[k] = { personne: p || null, compteId: cid, contact: c || null, heure: Date.now(), par: auteur };
    sauver();
    let droitDonne = false;
    if (droit && cid) {
      if (!admin) throw new Error('Seul un administrateur peut donner le droit de régler un nœud');
      const compte = comptes.lister().find((x) => x.id === cid);
      if (compte.role !== 'admin') {
        const l = new Set(compte.noeuds || []); l.add(k);
        comptes.changerNoeuds(cid, [...l]);
        droitDonne = true;
      }
    }
    journal(`[Responsables] ${k} : ${p || nomCompte(cid)} par ${auteur}${droitDonne ? ' (droit de réglage donné)' : ''}`);
    return { ...liste({ avecContact: true })[k], droitDonne };
  }
  // Nœud renuméroté : le responsable suit le nouveau numéro
  function remplacerNoeud(ancien, nouveau) {
    const a = cle(ancien), n = cle(nouveau);
    if (table[a] && !table[n]) { table[n] = table[a]; delete table[a]; sauver(); }
  }
  return { liste, definir, remplacerNoeud };
}

module.exports = { creerResponsables };
