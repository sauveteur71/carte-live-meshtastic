'use strict';
// Section ADRASEC (édition française) : espaces réservés aux associations départementales de radiotransmetteurs au
// service de la sécurité civile. Une carte peut héberger les ADRASEC de plusieurs départements, chacune séparée
// (membres, équipes, main courante, recherches). L'administrateur de la carte crée les ADRASEC et nomme leurs
// présidents ; le président intègre ses membres, radioamateurs licenciés ou SWL (écouteurs, sans émission).
// - Membres : un compte de la carte demande à rejoindre la section (page /adrasec) ; un administrateur de la carte
//   ou un responsable de la section accepte la demande, ou l'ajoute directement. Les responsables (nommés par un
//   administrateur de la carte) gèrent membres, équipes et réglages de la section sans être administrateurs de la carte.
//   Un compte devient membre quand il est validé ; l'administrateur coche aussi
//   « radioamateur licencié » avec l'indicatif (vérifié sur pièce par lui : certificat d'opérateur / ANFR), affecte
//   une équipe et, en option, le nœud Meshtastic porté par le membre (sa position devient celle de l'équipe).
// - Main courante : événements horodatés, signés par leur auteur, jamais modifiés (seulement complétés), export CSV.
// - Radiogoniométrie : recherches de balise (121,5 / 243 / 406 MHz ou autre), relevés de gisement des équipes,
//   position la plus probable par moindres carrés (public/gonio.js). Un relevé arrive aussi par radio : message
//   « GONIO 125 » ou « GIS 125/5 » envoyé par le nœud d'un membre (position = celle du nœud).
// - Ce qui transmet sur les bandes radioamateurs (Winlink…) est réservé aux membres cochés « licencié ».
// - Transfert vers une autre carte : export d'un fichier (nom, équipes, fiches métier des membres), import là-bas.
//   Jamais de compte, de mot de passe, de condensat ni de jeton : sur la carte d'arrivée chacun crée son compte par
//   le lien d'invitation, et sa fiche l'attend (rattachée par l'indicatif). Main courante et recherches ne partent pas.
// Données dans adrasec.json (dossier des données), incluses dans les sauvegardes ; aucune n'apparaît sur la carte
// publique. Conservation : main courante et relevés effacés au-delà de la durée choisie par l'administrateur.

const path = require('path');
const crypto = require('crypto');
const { ecrireSur, lireJson } = require('./fichiers');
const Gonio = require('../public/gonio.js');

const TYPES_MC = ['information', 'message-recu', 'message-emis', 'decision', 'mouvement', 'incident', 'fin'];
const FREQUENCES = ['121,5 MHz', '243 MHz', '406 MHz', 'autre'];
const INDICATIF = /^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}[A-Z](\/[A-Z0-9]{1,4})?$/;
const id = () => crypto.randomBytes(6).toString('hex');
const txt = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max);
const COULEURS_EQ = ['#ff8a1f', '#4cc9f0', '#b48cff', '#3ee68a', '#ff5c6c', '#ffd23f', '#e07bff', '#80ed99'];
// Transfert d'une section d'une carte à une autre (voir « exporter » / « importer » plus bas)
const FORMAT_TRANSFERT = 'carte-live-adrasec';
const norme = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
// Ce qui identifie une personne entre deux cartes : son indicatif (radioamateur) ou, à défaut, son numéro d'écouteur
const cleAttente = (x) => (x && x.indicatif ? String(x.indicatif).toUpperCase() : x && x.numeroSwl ? 'SWL:' + String(x.numeroSwl).toUpperCase() : '');

function creerAdrasec({ config, journal = () => {}, diffuser = () => {}, positionDe = () => null, nomDe = () => null, radioPoint = null }) {
  // Une carte peut héberger les ADRASEC de plusieurs départements : chacune a ses membres, son président (responsable),
  // ses équipes, sa main courante et ses recherches. L'administrateur de la carte crée les ADRASEC et nomme les présidents.
  const fichier = path.join(path.dirname(config.fichierBase), 'adrasec.json');
  const vide = (code, nom) => ({ code, nom: nom || 'ADRASEC ' + code, conservationJours: 365, membres: {}, demandes: {}, equipes: [], mainCourante: [], recherches: [], releves: [] });
  let racine = { actif: false, groupes: {} };
  try {
    const brut = lireJson(fichier);
    if (brut && brut.groupes) racine = { actif: !!brut.actif, groupes: brut.groupes };
    else if (brut) { // ancien fichier (une seule section) : devient l'ADRASEC du département de la carte
      const code = String((config.departement || {}).code || '00');
      const g = { ...vide(code), ...brut, code, nom: !brut.nom || brut.nom === 'ADRASEC' ? 'ADRASEC ' + code : brut.nom };
      delete g.actif;
      racine = { actif: !!brut.actif, groupes: { [code]: g } };
    }
  } catch { /* première utilisation */ }
  let minuterie = null;
  const sauver = (vite) => {
    clearTimeout(minuterie);
    // Données personnelles (noms, indicatifs, fonctions, main courante d'opérations réelles) : fichier lisible du
    // seul service, comme equipes.json et donateurs.json.
    const f = () => { try { ecrireSur(fichier, JSON.stringify(racine), { mode: 0o600 }); } catch (e) { journal('[ADRASEC] enregistrement impossible :', e.message); } };
    if (vite) f(); else minuterie = setTimeout(f, 1500);
  };
  const groupeDeCompte = (cid) => Object.keys(racine.groupes).find((k) => racine.groupes[k].membres[cid]) || null;
  const nomGroupe = (code) => (racine.groupes[code] || {}).nom || 'ADRASEC ' + code;
  const ctx = { actif: () => racine.actif, sauver, journal, diffuser, positionDe, nomDe, radioPoint, groupeDeCompte, nomGroupe };
  const instances = new Map();
  const inst = (code) => {
    const g = racine.groupes[code];
    if (!g) return null;
    let i = instances.get(code);
    if (!i || i.g !== g) { i = creerGroupe(g, ctx); instances.set(code, i); }
    return i;
  };
  const toutes = () => Object.keys(racine.groupes).sort().map(inst);
  const purgerTout = () => toutes().forEach((i) => i.purger());
  purgerTout();
  setInterval(purgerTout, 6 * 3600000).unref();

  const groupeDe = (compte) => (compte ? groupeDeCompte(compte.id) : null);
  // ADRASEC vue par ce compte : la sienne ; un administrateur de la carte choisit (code) ou voit la première
  function groupePour(compte, code) {
    if (!compte) return null;
    const mien = groupeDe(compte);
    if (code && racine.groupes[code] && (compte.role === 'admin' || mien === code)) return inst(code);
    if (mien) return inst(mien);
    if (compte.role === 'admin') { const dep = String((config.departement || {}).code || ''); const c = racine.groupes[dep] ? dep : Object.keys(racine.groupes).sort()[0]; return c ? inst(c) : null; }
    return null;
  }
  const estMembre = (compte) => !!compte && racine.actif && (compte.role === 'admin' || !!groupeDe(compte));
  const listeGroupes = () => Object.values(racine.groupes).sort((a, b) => a.code.localeCompare(b.code)).map((g) => ({ code: g.code, nom: g.nom, membres: Object.keys(g.membres).length, presidents: Object.values(g.membres).filter((m) => m.responsable).length }));
  // Créer, renommer ou supprimer une ADRASEC (administrateur de la carte)
  function majGroupe(code, b, auteur) {
    const c = txt(code || b.code, 3).toUpperCase();
    if (!/^(\d{2,3}|2A|2B)$/.test(c)) throw new Error('Département : numéro à 2 ou 3 chiffres (ex. 43, 2A, 971)');
    const g = racine.groupes[c];
    if (b.supprimer) {
      if (!g) return { groupes: listeGroupes() };
      if (Object.keys(g.membres).length || g.recherches.length || g.mainCourante.length) throw new Error('Cette ADRASEC a encore des membres ou un historique : retirez d’abord les membres et attendez la fin de la conservation');
      delete racine.groupes[c]; instances.delete(c);
      journal(`[ADRASEC] ${g.nom} supprimée par ${auteur}`);
    } else if (g) { if (b.nom !== undefined) g.nom = txt(b.nom, 40) || g.nom; }
    else { racine.groupes[c] = vide(c, txt(b.nom, 40)); journal(`[ADRASEC] ${racine.groupes[c].nom} créée par ${auteur}`); }
    sauver(true);
    return { groupes: listeGroupes() };
  }
  function reglagesGlobaux(b) {
    if (b.actif !== undefined) racine.actif = !!b.actif;
    sauver(true);
    return { actif: racine.actif };
  }
  function demander(compte, b) {
    const codes = Object.keys(racine.groupes);
    const code = b.groupe ? String(b.groupe) : codes.length === 1 ? codes[0] : null;
    if (!code || !racine.groupes[code]) throw new Error('Choisissez l’ADRASEC de votre département');
    for (const k of codes) if (k !== code) delete racine.groupes[k].demandes[compte.id];
    return inst(code).demander(compte, b);
  }
  function demandeDe(compte) {
    if (!compte) return null;
    for (const g of Object.values(racine.groupes)) { const x = g.demandes && g.demandes[compte.id]; if (x) return { ...x, groupe: g.code, nomGroupe: g.nom }; }
    return null;
  }
  // Gestion des comptes de la carte (administrateur) : case ADRASEC, ADRASEC du compte et président
  function rolesComptes() {
    const roles = {};
    for (const g of Object.values(racine.groupes)) for (const [cid, m] of Object.entries(g.membres)) roles[cid] = { groupe: g.code, president: !!m.responsable };
    return { actif: racine.actif, departement: String((config.departement || {}).code || ''), groupes: listeGroupes(), roles };
  }
  function roleCompte(compteId, b, auteur) {
    const cid = Number(compteId);
    if (!Number.isInteger(cid)) throw new Error('Compte inconnu');
    const actuel = groupeDeCompte(cid);
    if (!b.groupe) {
      if (actuel) { delete racine.groupes[actuel].membres[cid]; journal(`[ADRASEC] compte ${cid} retiré de ${nomGroupe(actuel)} par ${auteur}`); }
      sauver(true);
      return { groupe: null, president: false };
    }
    let code = String(b.groupe).toUpperCase();
    // Première ADRASEC : celle du département de la carte, créée à la première case cochée
    if (code === 'AUTO') code = actuel || String((config.departement || {}).code || '') || Object.keys(racine.groupes)[0];
    if (!racine.groupes[code]) { if (!/^(\d{2,3}|2A|2B)$/.test(code)) throw new Error('ADRASEC inconnue'); racine.groupes[code] = vide(code); journal(`[ADRASEC] ${racine.groupes[code].nom} créée par ${auteur}`); }
    if (!racine.actif) racine.actif = true;
    let m = actuel ? racine.groupes[actuel].membres[cid] : null;
    if (actuel && actuel !== code) { delete racine.groupes[actuel].membres[cid]; m = { ...m, equipe: null }; }
    m = m || { valide: Date.now(), par: auteur };
    if (b.president !== undefined) m.responsable = !!b.president;
    racine.groupes[code].membres[cid] = m;
    delete racine.groupes[code].demandes[cid];
    sauver(true);
    journal(`[ADRASEC] compte ${cid} : ${m.responsable ? 'président' : 'membre'} de ${nomGroupe(code)} (par ${auteur})`);
    return { groupe: code, president: !!m.responsable };
  }
  function vue(compte, comptesListe, G) {
    return { ...G.vue(compte, comptesListe), groupes: compte.role === 'admin' ? listeGroupes() : undefined };
  }

  return {
    actif: () => racine.actif, nom: () => 'ADRASEC', groupes: listeGroupes, groupeDe, groupePour, estMembre, nomGroupe,
    majGroupe, reglagesGlobaux, demander, demandeDe, vue, rolesComptes, roleCompte,
    texteRecu: (evt) => { if (racine.actif) toutes().forEach((i) => i.texteRecu(evt)); },
    vueTerrain: (jeton) => { for (const i of toutes()) { const v = i.vueTerrain(jeton); if (v) return v; } return null; },
  };
}

// ---- Une ADRASEC départementale ----------------------------------------------------------------------------------
function creerGroupe(g, ctx) {
  const { sauver, journal, diffuser, positionDe, nomDe, radioPoint } = ctx;
  for (const k of ['membres', 'demandes']) g[k] = g[k] || {};
  for (const k of ['equipes', 'mainCourante', 'recherches', 'releves', 'attentes']) g[k] = g[k] || [];
  const purger = () => {
    const limite = Date.now() - Math.max(7, g.conservationJours || 365) * 86400000;
    const n = g.mainCourante.length + g.releves.length;
    g.mainCourante = g.mainCourante.filter((x) => x.heure >= limite);
    g.releves = g.releves.filter((x) => x.heure >= limite);
    g.recherches = g.recherches.filter((r) => r.statut === 'en-cours' || (r.fin || r.debut) >= limite);
    if (g.mainCourante.length + g.releves.length !== n) sauver();
  };

  // ---- Accès ------------------------------------------------------------------------------------------------
  const membre = (compte) => (compte && ctx.actif() ? g.membres[compte.id] || null : null);
  const estMembre = (compte) => !!compte && ctx.actif() && (compte.role === 'admin' || !!membre(compte));
  // Responsable : gère la section (membres, équipes, réglages) ; nommé par un administrateur de la carte
  const estResponsable = (compte) => !!compte && (compte.role === 'admin' || !!(membre(compte) && membre(compte).responsable));
  const estLicencie = (compte) => { const m = membre(compte); return !!(m && m.licencie && m.indicatif); };
  const signature = (compte) => { const m = membre(compte); return (m && (m.indicatif || m.numeroSwl)) || compte.indicatif || compte.identifiant; };

  // ---- Réglages et membres (administrateur) -----------------------------------------------------------------
  function reglages(b) {
    if (b.nom !== undefined) g.nom = txt(b.nom, 40) || 'ADRASEC ' + g.code;
    if (b.conservationJours !== undefined) g.conservationJours = Math.min(3650, Math.max(7, Math.round(Number(b.conservationJours) || 365)));
    sauver(true);
    return { nom: g.nom, conservationJours: g.conservationJours };
  }
  function majMembre(compteId, b, auteur, parAdmin = false) {
    const cid = Number(compteId);
    if (!Number.isInteger(cid)) throw new Error('Compte inconnu');
    if (!parAdmin && g.membres[cid] && g.membres[cid].responsable && (b.membre === false || b.responsable === false)) throw new Error('Seul un administrateur de la carte peut retirer un responsable');
    if (b.membre === false) {
      if (g.membres[cid]) { delete g.membres[cid]; journal(`[ADRASEC] compte ${cid} retiré par ${auteur}`); }
      sauver(true);
      return { ok: true };
    }
    if (!g.membres[cid]) { const ailleurs = ctx.groupeDeCompte(cid); if (ailleurs && ailleurs !== g.code) throw new Error(`Ce compte est déjà membre de ${ctx.nomGroupe(ailleurs)}`); }
    const nouveau = !g.membres[cid];
    const m = g.membres[cid] || { valide: Date.now(), par: auteur };
    // Qualité : radioamateur licencié (indicatif vérifié) ou SWL (écouteur, sans émission sur les bandes amateurs)
    if (b.qualite !== undefined) { m.qualite = ['radioamateur', 'swl'].includes(b.qualite) ? b.qualite : null; b.licencie = m.qualite === 'radioamateur'; }
    if (b.numeroSwl !== undefined) m.numeroSwl = txt(b.numeroSwl, 20).toUpperCase() || null;
    if (b.indicatif !== undefined) {
      const ind = txt(b.indicatif, 12).toUpperCase();
      if (ind && !INDICATIF.test(ind)) throw new Error('Indicatif invalide (ex. F4ABC)');
      m.indicatif = ind || null;
    }
    if (b.licencie !== undefined) { m.licencie = !!b.licencie; if (m.licencie) m.qualite = 'radioamateur'; else if (m.qualite === 'radioamateur') m.qualite = null; }
    if (m.licencie && !m.indicatif) throw new Error('Un licencié doit avoir son indicatif');
    if (b.equipe !== undefined) m.equipe = b.equipe && g.equipes.some((e) => e.id === b.equipe) ? b.equipe : null;
    if (b.noeud !== undefined) { const n = Number(b.noeud); m.noeud = b.noeud === null || b.noeud === '' ? null : Number.isInteger(n) && n > 0 ? n >>> 0 : m.noeud ?? null; }
    if (b.fonction !== undefined) m.fonction = txt(b.fonction, 40) || null;
    if (b.responsable !== undefined && !!b.responsable !== !!m.responsable) {
      if (!parAdmin) throw new Error('Seul un administrateur de la carte peut nommer un responsable de la section');
      m.responsable = !!b.responsable;
    }
    // Fiche en attente venue d'une autre carte (import) : reprise quand la personne a enfin son compte ici.
    // Ce qui n'a pas été saisi dans ce formulaire est repris de la fiche ; jamais le rôle de président.
    if (nouveau) {
      const cle = cleAttente(m);
      const i = cle ? g.attentes.findIndex((a) => cleAttente(a) === cle) : -1;
      if (i >= 0) {
        const a = g.attentes[i];
        if (b.qualite === undefined && !m.qualite && a.qualite && (a.qualite !== 'radioamateur' || m.indicatif)) { m.qualite = a.qualite; m.licencie = a.qualite === 'radioamateur'; }
        if (b.numeroSwl === undefined && !m.numeroSwl && a.numeroSwl) m.numeroSwl = a.numeroSwl;
        if (b.equipe === undefined && a.equipe && g.equipes.some((e) => e.id === a.equipe)) m.equipe = a.equipe;
        if (b.fonction === undefined && a.fonction) m.fonction = a.fonction;
        if (b.noeud === undefined && a.noeud) m.noeud = a.noeud;
        m.importe = { de: a.source, heure: a.heure };
        g.attentes.splice(i, 1);
        journal(`[ADRASEC] fiche en attente « ${cle} » rattachée au compte ${cid} (importée de ${a.source})`);
      }
    }
    g.membres[cid] = m;
    if (g.demandes) delete g.demandes[cid]; // demande d'adhésion satisfaite
    sauver(true);
    journal(`[ADRASEC] membre ${cid} mis à jour par ${auteur}${m.licencie ? ' (licencié ' + m.indicatif + ')' : ''}`);
    return { ok: true, membre: m };
  }
  // ---- Demandes d'adhésion (un compte de la carte demande à rejoindre la section) ------------------------------
  function demander(compte, b) {
    if (!ctx.actif()) throw new Error('La section n’est pas encore ouverte');
    if (ctx.groupeDeCompte(compte.id)) throw new Error('Vous êtes déjà membre d’une ADRASEC');
    const ind = txt(b.indicatif, 12).toUpperCase();
    if (ind && !INDICATIF.test(ind)) throw new Error('Indicatif invalide (ex. F4ABC)');
    g.demandes = g.demandes || {};
    const qualite = ['radioamateur', 'swl'].includes(b.qualite) ? b.qualite : null;
    g.demandes[compte.id] = { heure: Date.now(), qualite, indicatif: qualite === 'swl' ? null : ind || null, numeroSwl: qualite === 'swl' ? txt(b.numeroSwl, 20).toUpperCase() || null : null, message: txt(b.message, 300) || null };
    sauver(true);
    journal(`[ADRASEC] demande d'adhésion du compte ${compte.id} (${g.nom})`);
    diffuser({ genre: 'adrasec', quoi: 'demande' });
    return { ok: true };
  }
  function refuserDemande(compteId, auteur) {
    const cid = Number(compteId);
    if (g.demandes && g.demandes[cid]) { delete g.demandes[cid]; sauver(true); journal(`[ADRASEC] demande du compte ${cid} refusée par ${auteur}`); }
    return { ok: true };
  }
  const demandeDe = (compte) => (compte && g.demandes && g.demandes[compte.id]) || null;
  function majEquipe(eid, b) {
    if (eid) {
      const e = g.equipes.find((x) => x.id === eid);
      if (!e) throw new Error('Équipe inconnue');
      if (b.supprimer) {
        g.equipes = g.equipes.filter((x) => x !== e);
        for (const m of Object.values(g.membres)) if (m.equipe === eid) m.equipe = null;
      } else {
        if (b.nom !== undefined) e.nom = txt(b.nom, 30) || e.nom;
        if (b.couleur !== undefined && /^#[0-9a-f]{6}$/i.test(b.couleur)) e.couleur = b.couleur;
        if (b.mission !== undefined) e.mission = txt(b.mission, 120) || null;
      }
    } else {
      const nom = txt(b.nom, 30);
      if (!nom) throw new Error('Nom d’équipe manquant');
      g.equipes.push({ id: id(), nom, couleur: COULEURS_EQ[g.equipes.length % COULEURS_EQ.length], mission: txt(b.mission, 120) || null });
    }
    sauver(true);
    return { equipes: g.equipes };
  }

  // ---- Main courante ----------------------------------------------------------------------------------------
  function ajouterMc(compte, b, extra = {}) {
    const texte = txt(b.texte, 1000);
    if (!texte) throw new Error('Texte vide');
    const x = { id: id(), heure: Date.now(), auteur: compte ? signature(compte) : extra.auteur || 'radio', type: TYPES_MC.includes(b.type) ? b.type : 'information',
      equipe: b.equipe && g.equipes.some((e) => e.id === b.equipe) ? b.equipe : (compte && membre(compte) && membre(compte).equipe) || null, texte, complete: b.complete && g.mainCourante.some((y) => y.id === b.complete) ? b.complete : null, ...extra };
    g.mainCourante.push(x);
    if (g.mainCourante.length > 20000) g.mainCourante.splice(0, g.mainCourante.length - 20000);
    sauver();
    diffuser({ genre: 'adrasec', quoi: 'main-courante' });
    return x;
  }
  function csvMc() {
    const eq = new Map(g.equipes.map((e) => [e.id, e.nom]));
    const c = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return '﻿' + ['Date;Heure;Auteur;Équipe;Type;Texte;Complète'].concat(g.mainCourante.map((x) => {
      const t = new Date(x.heure);
      return [t.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }), t.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' }), x.auteur, eq.get(x.equipe) || '', x.type, x.texte, x.complete || ''].map(c).join(';');
    })).join('\r\n');
  }

  // ---- Radiogoniométrie -------------------------------------------------------------------------------------
  function majRecherche(rid, b, compte) {
    if (!rid) {
      const nom = txt(b.nom, 60) || `Recherche du ${new Date().toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' })}`;
      const r = { id: id(), nom, frequence: FREQUENCES.includes(b.frequence) ? b.frequence : '121,5 MHz', detail: txt(b.detail, 120) || null, debut: Date.now(), fin: null, statut: 'en-cours', ouvertePar: signature(compte) };
      g.recherches.unshift(r);
      ajouterMc(compte, { texte: `Ouverture de la recherche « ${r.nom} » (${r.frequence}${r.detail ? ', ' + r.detail : ''})`, type: 'decision' });
      sauver(true);
      return r;
    }
    const r = g.recherches.find((x) => x.id === rid);
    if (!r) throw new Error('Recherche inconnue');
    if (b.cloturer) {
      r.statut = 'terminee'; r.fin = Date.now();
      r.lien = null;
      if (r.diffusion && r.diffusion.dernier) setTimeout(() => diffuserBalise(r.id, {}, compte, { fin: true }).catch((e) => journal('[ADRASEC] fin de diffusion impossible :', e.message)), 0);
      const loc = localiser(r.id);
      r.resultat = b.resultat ? txt(b.resultat, 200) : null;
      r.positionFinale = loc.estimation ? { ...loc.estimation, locator: Gonio.versLocator(loc.estimation.lat, loc.estimation.lon, 8) } : null;
      ajouterMc(compte, { texte: `Clôture de la recherche « ${r.nom} »${r.resultat ? ' : ' + r.resultat : ''}${r.positionFinale ? ` (dernière estimation ${r.positionFinale.lat.toFixed(5)}, ${r.positionFinale.lon.toFixed(5)} · ${r.positionFinale.locator})` : ''}`, type: 'fin' });
    }
    if (b.nom !== undefined) r.nom = txt(b.nom, 60) || r.nom;
    sauver(true);
    return r;
  }
  function positionMembre(m) {
    if (!m || !m.noeud) return null;
    const p = positionDe(m.noeud);
    return p && p.lat != null ? p : null;
  }
  function ajouterReleve(compte, b, origine = 'saisie') {
    const r = g.recherches.find((x) => x.id === b.recherche) || g.recherches.find((x) => x.statut === 'en-cours');
    if (!r || r.statut !== 'en-cours') throw new Error('Aucune recherche en cours : ouvrez-en une d’abord');
    const gis = Number(String(b.gisement).replace(',', '.'));
    if (!(gis >= 0 && gis <= 360)) throw new Error('Gisement entre 0 et 360°');
    const inc = b.incertitude == null || b.incertitude === '' ? 5 : Number(String(b.incertitude).replace(',', '.'));
    if (!(inc >= 0.5 && inc <= 45)) throw new Error('Incertitude entre 0,5 et 45°');
    let pos = null, source = null;
    const m = compte ? membre(compte) : null;
    if (b.locator) { const p = Gonio.depuisLocator(b.locator); if (!p) throw new Error('Locator invalide (ex. JN15XC33)'); pos = p; source = 'locator ' + String(b.locator).toUpperCase(); }
    else if (Number.isFinite(Number(b.lat)) && Number.isFinite(Number(b.lon)) && b.lat !== '' && b.lon !== '') { pos = { lat: Number(b.lat), lon: Number(b.lon) }; source = b.source === 'gps' ? 'GPS' : 'carte'; }
    else if (b.noeud || (m && m.noeud)) { const n = Number(b.noeud || m.noeud) >>> 0; const p = positionDe(n); if (!p || p.lat == null) throw new Error('Position du nœud inconnue'); pos = p; source = 'nœud ' + (nomDe(n) || '!' + n.toString(16)); }
    if (!pos || Math.abs(pos.lat) > 90 || Math.abs(pos.lon) > 180) throw new Error('Position de l’équipe manquante (GPS, locator, clic sur la carte ou nœud)');
    const x = { id: id(), recherche: r.id, heure: Date.now(), auteur: compte ? signature(compte) : b.auteur || 'radio',
      // Équipe choisie par celui qui saisit (le PC saisit les relevés des équipes), sinon la sienne
      equipe: b.equipe !== undefined ? (b.equipe && g.equipes.some((e) => e.id === b.equipe) ? b.equipe : null) : (m && m.equipe) || null,
      lat: +pos.lat.toFixed(6), lon: +pos.lon.toFixed(6), source, gisement: +(gis % 360).toFixed(1), incertitude: +inc.toFixed(1), force: txt(b.force, 20) || null, note: txt(b.note, 200) || null, origine };
    g.releves.push(x);
    sauver();
    ajouterMc(compte, { texte: `Relevé ${x.gisement}° ±${x.incertitude}° depuis ${Gonio.versLocator(x.lat, x.lon, 8)} (${x.source})${x.force ? ', force ' + x.force : ''}${x.note ? ' — ' + x.note : ''}`, type: 'information', equipe: x.equipe }, compte ? {} : { auteur: x.auteur });
    diffuser({ genre: 'adrasec', quoi: 'releves', recherche: r.id });
    setTimeout(() => diffusionAuto(r.id), 0);
    return x;
  }
  // Corriger l'équipe d'un relevé déjà enregistré (auteur ou responsable) ; noté en main courante
  function majReleve(compte, rid, b) {
    const x = g.releves.find((y) => y.id === rid);
    if (!x) throw new Error('Relevé inconnu');
    if (!estResponsable(compte) && x.auteur !== signature(compte)) throw new Error('Seul l’auteur ou un responsable peut modifier ce relevé');
    if (b.equipe !== undefined) {
      const eq = b.equipe && g.equipes.some((e) => e.id === b.equipe) ? b.equipe : null;
      if (eq !== x.equipe) {
        x.equipe = eq;
        ajouterMc(compte, { texte: `Relevé ${x.gisement}° de ${x.auteur} attribué à ${eq ? (g.equipes.find((e) => e.id === eq) || {}).nom : 'aucune équipe'}`, type: 'information', equipe: eq });
      }
    }
    sauver();
    diffuser({ genre: 'adrasec', quoi: 'releves', recherche: x.recherche });
    return { ok: true };
  }
  function retirerReleve(compte, rid) {
    const x = g.releves.find((y) => y.id === rid);
    if (!x) throw new Error('Relevé inconnu');
    if (!estResponsable(compte) && x.auteur !== signature(compte)) throw new Error('Seul l’auteur ou un responsable peut retirer ce relevé');
    x.retire = { heure: Date.now(), par: signature(compte) }; // gardé pour la main courante, mais hors calcul
    ajouterMc(compte, { texte: `Relevé ${x.gisement}° de ${x.auteur} retiré du calcul`, type: 'decision' });
    sauver();
    diffuser({ genre: 'adrasec', quoi: 'releves', recherche: x.recherche });
    return { ok: true };
  }
  function localiser(rid) {
    return Gonio.localiser(g.releves.filter((x) => x.recherche === rid && !x.retire));
  }

  // Relevé reçu par radio : « GONIO 125 » / « GIS 125/5 » depuis le nœud d'un membre, sur une recherche en cours
  const vus = new Map();
  function texteRecu(evt) {
    if (!ctx.actif() || !evt || !evt.texte) return;
    const lu = Gonio.lireMessage(evt.texte);
    if (!lu) return;
    const de = evt.de >>> 0;
    const entree = Object.entries(g.membres).find(([, m]) => m.noeud === de);
    if (!entree) return;
    const cle = `${de}:${evt.texte}`;
    if (Date.now() - (vus.get(cle) || 0) < 120000) return; // même message reçu par plusieurs sources
    vus.set(cle, Date.now());
    if (vus.size > 500) vus.delete(vus.keys().next().value);
    const m = entree[1];
    try {
      const p = positionDe(de);
      if (!p || p.lat == null) throw new Error('position du nœud inconnue');
      ajouterReleve(null, { gisement: lu.gisement, incertitude: lu.incertitude, lat: p.lat, lon: p.lon, source: 'gps', equipe: m.equipe, auteur: m.indicatif || nomDe(de) || '!' + de.toString(16), note: 'reçu par radio' }, 'radio');
      journal(`[ADRASEC] relevé radio de ${m.indicatif || de} : ${lu.gisement}°`);
    } catch (e) {
      journal(`[ADRASEC] relevé radio de ${m.indicatif || de} ignoré : ${e.message}`);
    }
  }

  // ---- Diffusion radio de la position estimée (équipes en zone blanche) ---------------------------------------
  // Point de passage Meshtastic (toujours le même identifiant par recherche : il se déplace dans les applis au lieu
  // de se multiplier) et message texte, sur le canal choisi (canal chiffré de l'équipe de préférence).
  // Automatique : renvoyé à chaque nouveau relevé si l'estimation bouge de plus de 300 m (au plus une fois par minute).
  const fmtKm = (m) => (m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(m) + ' m');
  function texteBalise(r, loc, fin) {
    const e = loc.estimation;
    if (fin) return `✅ Fin recherche ${r.nom}${r.resultat ? ' : ' + r.resultat : ''}`;
    const dfci = require('../public/dfci.js').versDfci(e.lat, e.lon);
    return `🎯 BALISE ${r.nom} : ${e.lat.toFixed(5)},${e.lon.toFixed(5)} · ${Gonio.versLocator(e.lat, e.lon, 8)}${dfci ? ' · DFCI ' + dfci : ''} · ±${fmtKm(loc.ellipse ? loc.ellipse.grandAxeM : 0)} (${loc.utilises || loc.nb} relevés)`;
  }
  async function diffuserBalise(rid, b = {}, compte = null, { fin = false, auto = false } = {}) {
    const r = g.recherches.find((x) => x.id === rid);
    if (!r) throw new Error('Recherche inconnue');
    if (!radioPoint) throw new Error('Envoi radio indisponible sur cette carte');
    r.diffusion = r.diffusion || { idPoint: (crypto.randomBytes(4).readUInt32LE(0) >>> 0) || 1, canal: 0, auto: false, dernier: null };
    const df = r.diffusion;
    if (b.canal !== undefined) { const c = Number(b.canal); if (!Number.isInteger(c) || c < 0 || c > 7) throw new Error('Canal 0 à 7'); df.canal = c; }
    if (b.auto !== undefined) df.auto = !!b.auto;
    if (b.reglageSeul) { sauver(true); return { diffusion: df }; }
    const loc = localiser(r.id);
    if (!fin && !loc.estimation) throw new Error('Pas encore de position estimée : il faut au moins deux relevés qui se croisent');
    const p = fin ? (df.dernier || loc.estimation) : loc.estimation;
    if (!p) return { diffusion: df };
    const texte = texteBalise(r, loc, fin);
    await radioPoint({ idPoint: df.idPoint, lat: p.lat, lon: p.lon, nom: fin ? '✅ Balise : fin' : '🎯 Balise estimée',
      description: fin ? r.nom : `${r.nom} · ±${fmtKm(loc.ellipse ? loc.ellipse.grandAxeM : 0)} · ${new Date().toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' })}`,
      expireS: fin ? Math.floor(Date.now() / 1000) - 60 : Math.floor(Date.now() / 1000) + 12 * 3600, canal: df.canal, texte });
    df.dernier = { lat: p.lat, lon: p.lon, heure: Date.now() };
    sauver(true);
    ajouterMc(compte, { texte: `${auto ? 'Diffusion radio automatique' : 'Diffusion radio'} (canal ${df.canal}) : ${texte}`, type: 'message-emis' }, compte ? {} : { auteur: 'carte' });
    return { diffusion: df, texte };
  }
  let derniereAuto = 0;
  function diffusionAuto(rid) {
    const r = g.recherches.find((x) => x.id === rid);
    if (!r || r.statut !== 'en-cours' || !r.diffusion || !r.diffusion.auto) return;
    const loc = localiser(rid);
    if (!loc.estimation) return;
    if (r.diffusion.dernier && Gonio.distance(r.diffusion.dernier, loc.estimation) < 300) return;
    if (Date.now() - derniereAuto < 60000) { setTimeout(() => diffusionAuto(rid), 61000 - (Date.now() - derniereAuto)).unref(); return; }
    derniereAuto = Date.now();
    diffuserBalise(rid, {}, null, { auto: true }).catch((e) => journal('[ADRASEC] diffusion automatique impossible :', e.message));
  }

  // ---- Lien terrain : lecture seule, sans compte, une recherche, jusqu'à sa clôture (48 h au plus) ------------
  function creerLien(rid, compte) {
    const r = g.recherches.find((x) => x.id === rid);
    if (!r || r.statut !== 'en-cours') throw new Error('Recherche en cours inconnue');
    r.lien = { jeton: crypto.randomBytes(16).toString('hex'), expire: Date.now() + 48 * 3600000, cree: Date.now(), par: signature(compte) };
    sauver(true);
    ajouterMc(compte, { texte: `Lien terrain créé pour la recherche « ${r.nom} » (lecture seule, 48 h au plus)`, type: 'information' });
    return { jeton: r.lien.jeton, expire: r.lien.expire };
  }
  function couperLien(rid, compte) {
    const r = g.recherches.find((x) => x.id === rid);
    if (!r) throw new Error('Recherche inconnue');
    if (r.lien) { r.lien = null; sauver(true); ajouterMc(compte, { texte: `Lien terrain de la recherche « ${r.nom} » désactivé`, type: 'information' }); }
    return { ok: true };
  }
  function vueTerrain(jeton) {
    if (!ctx.actif() || !/^[0-9a-f]{32}$/.test(String(jeton || ''))) return null;
    const r = g.recherches.find((x) => x.lien && x.lien.jeton === jeton);
    if (!r || r.statut !== 'en-cours' || r.lien.expire < Date.now()) return null;
    const eq = new Map(g.equipes.map((e) => [e.id, e]));
    return {
      section: g.nom, recherche: { nom: r.nom, frequence: r.frequence, detail: r.detail, debut: r.debut },
      releves: g.releves.filter((x) => x.recherche === r.id && !x.retire).map((x) => ({ id: x.id, heure: x.heure, equipe: x.equipe ? (eq.get(x.equipe) || {}).nom || null : null, couleur: x.equipe ? (eq.get(x.equipe) || {}).couleur || null : null, lat: x.lat, lon: x.lon, gisement: x.gisement, incertitude: x.incertitude, force: x.force })),
      calcul: localiser(r.id),
      // Positions des équipes (nœud porté), sans nom de personne
      equipes: g.equipes.map((e) => ({ nom: e.nom, couleur: e.couleur, mission: e.mission || null, positions: Object.values(g.membres).filter((m) => m.equipe === e.id).map(positionMembre).filter(Boolean).map((p) => ({ lat: p.lat, lon: p.lon, heure: p.heure || null })) })),
      expire: r.lien.expire,
    };
  }

  // ---- Transfert de la section vers une autre carte (export / import) ----------------------------------------
  // Ce qui part : la DÉFINITION de la section (nom, équipes, et pour chaque membre sa fiche métier : indicatif,
  // qualité, n° SWL, équipe, fonction, nœud porté). Jamais un compte, un mot de passe, un condensat ni un jeton :
  // les comptes ne se transfèrent pas d'une carte à l'autre. Sur la carte d'arrivée, chacun crée son compte par le
  // lien d'invitation (/adrasec) puis demande à rejoindre la section ; sa fiche l'attend et se rattache alors seule.
  // Ce qui NE part PAS : la main courante, les recherches et les relevés. Ce sont les archives horodatées et
  // signées d'opérations réelles, propres à la carte qui les a enregistrées (export CSV pour les archiver), pas un
  // paramétrage à recopier. Le rôle de président ne part pas non plus : seul un administrateur de la carte le donne.
  function exporter() {
    const avecId = Object.values(g.membres).filter((m) => m.indicatif || m.numeroSwl);
    return {
      format: FORMAT_TRANSFERT, version: 1, date: new Date().toISOString(),
      section: { code: g.code, nom: g.nom },
      equipes: g.equipes.map((e) => ({ id: e.id, nom: e.nom, couleur: e.couleur || null, mission: e.mission || null })),
      membres: avecId.map((m) => ({
        indicatif: m.indicatif || null, qualite: m.qualite || (m.licencie ? 'radioamateur' : null), numeroSwl: m.numeroSwl || null,
        equipe: m.equipe || null, fonction: m.fonction || null, president: !!m.responsable, noeud: m.noeud || null,
      })),
      // Pour le récapitulatif d'import, sans rien révéler : des membres n'ont ni indicatif ni n° SWL, donc rien
      // pour les reconnaître sur l'autre carte ; ils devront y être saisis à la main.
      membresSansIdentifiant: Object.keys(g.membres).length - avecId.length,
    };
  }
  // Lecture d'un fichier d'export (peut venir de n'importe où : tout est vérifié, rien n'est repris tel quel).
  // appliquer = false : simple récapitulatif, aucune écriture. appliquer = true : équipes et fiches créées.
  function importer(doc, comptesListe = [], { appliquer = false } = {}, auteur = 'carte') {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.format !== FORMAT_TRANSFERT) throw new Error('Ce fichier n’est pas l’export d’une section ADRASEC (bouton « Exporter la section » d’une autre carte)');
    if (Number(doc.version) !== 1) throw new Error(`Ce fichier est en version ${txt(doc.version, 10) || '?'} : cette carte lit la version 1`);
    const eqSource = Array.isArray(doc.equipes) ? doc.equipes.slice(0, 200) : [];
    const mbSource = Array.isArray(doc.membres) ? doc.membres.slice(0, 2000) : [];
    const nomSection = txt((doc.section || {}).nom, 40) || 'une autre carte';
    // Équipes : rapprochées par leur nom (accents et casse ignorés) ; une équipe déjà là n'est pas dupliquée
    const parNom = new Map(g.equipes.map((e) => [norme(e.nom), e]));
    const cibleEq = new Map(); // identifiant dans le fichier -> identifiant sur cette carte
    const aCreer = [];
    for (const e of eqSource) {
      const nom = txt(e && e.nom, 30);
      if (!nom || !e.id) continue;
      const deja = parNom.get(norme(nom));
      if (deja) { cibleEq.set(String(e.id), deja.id); continue; }
      const neuve = { id: id(), nom, couleur: /^#[0-9a-f]{6}$/i.test(e.couleur) ? e.couleur : COULEURS_EQ[(g.equipes.length + aCreer.length) % COULEURS_EQ.length], mission: txt(e.mission, 120) || null };
      cibleEq.set(String(e.id), neuve.id);
      parNom.set(norme(nom), neuve);
      aCreer.push(neuve);
    }
    // Comptes de cette carte, par indicatif : c'est le seul rapprochement sûr entre radioamateurs
    const parIndicatif = new Map();
    const nomDeCompte = new Map();
    for (const c of comptesListe) {
      if (!c) continue;
      nomDeCompte.set(Number(c.id), c.identifiant);
      if (c.statut !== 'actif' || !c.indicatif) continue;
      const k = String(c.indicatif).trim().toUpperCase();
      if (!parIndicatif.has(k)) parIndicatif.set(k, []);
      parIndicatif.get(k).push(c);
    }
    // Membres déjà là, reconnus comme dans le fichier (indicatif ou n° SWL) : un second import ne les double pas,
    // même s'ils n'ont pas de compte portant leur indicatif sur cette carte.
    const membresParCle = new Map();
    for (const [cid, m] of Object.entries(g.membres)) { const k = cleAttente(m); if (k) membresParCle.set(k, nomDeCompte.get(Number(cid)) || '(compte supprimé)'); }
    const nomEq = (idLocal) => { const e = [...parNom.values()].find((x) => x.id === idLocal); return e ? e.nom : null; };
    const r = { section: nomSection, appliquer, equipesCreees: aCreer.map((e) => e.nom), equipesExistantes: [...cibleEq.values()].length - aCreer.length,
      rattaches: [], attentes: [], dejaMembres: [], ambigus: [], ignores: [], presidents: 0, sansIdentifiant: Math.max(0, Math.round(Number(doc.membresSansIdentifiant) || 0)) };
    const vues = new Set();
    const aAjouter = [], aAttendre = [];
    for (const src of mbSource) {
      if (!src || typeof src !== 'object') continue;
      let ind = txt(src.indicatif, 12).toUpperCase();
      if (ind && !INDICATIF.test(ind)) { r.ignores.push({ quoi: ind, raison: 'indicatif illisible' }); continue; }
      const swl = txt(src.numeroSwl, 20).toUpperCase() || null;
      const fiche = {
        indicatif: ind || null, numeroSwl: swl,
        qualite: ['radioamateur', 'swl'].includes(src.qualite) ? src.qualite : null,
        equipe: src.equipe != null && cibleEq.has(String(src.equipe)) ? cibleEq.get(String(src.equipe)) : null,
        fonction: txt(src.fonction, 40) || null,
        noeud: Number.isInteger(Number(src.noeud)) && Number(src.noeud) > 0 && Number(src.noeud) <= 0xffffffff ? Number(src.noeud) >>> 0 : null,
      };
      if (fiche.qualite === 'radioamateur' && !fiche.indicatif) fiche.qualite = null; // licencié sans indicatif : impossible
      if (src.president) r.presidents++;
      const cle = cleAttente(fiche);
      if (!cle) { r.ignores.push({ quoi: fiche.fonction || '(sans nom)', raison: 'ni indicatif ni n° SWL : rien pour reconnaître la personne' }); continue; }
      if (vues.has(cle)) { r.ignores.push({ quoi: cle, raison: 'en double dans le fichier' }); continue; }
      vues.add(cle);
      if (membresParCle.has(cle)) { r.dejaMembres.push({ quoi: cle, identifiant: membresParCle.get(cle) }); continue; }
      const comptes = fiche.indicatif ? parIndicatif.get(fiche.indicatif) || [] : [];
      if (comptes.length > 1) { r.ambigus.push({ quoi: fiche.indicatif, raison: `${comptes.length} comptes portent cet indicatif sur cette carte : à rattacher à la main` }); continue; }
      if (comptes.length === 1) {
        const c = comptes[0];
        if (g.membres[c.id]) { r.dejaMembres.push({ quoi: fiche.indicatif, identifiant: c.identifiant }); continue; }
        const ailleurs = ctx.groupeDeCompte(c.id);
        if (ailleurs && ailleurs !== g.code) { r.ignores.push({ quoi: fiche.indicatif, raison: `ce compte est déjà membre de ${ctx.nomGroupe(ailleurs)}` }); continue; }
        r.rattaches.push({ quoi: fiche.indicatif, identifiant: c.identifiant, equipe: nomEq(fiche.equipe) });
        aAjouter.push([c.id, fiche]);
        continue;
      }
      if (g.attentes.some((a) => cleAttente(a) === cle)) { r.ignores.push({ quoi: cle, raison: 'une fiche en attente existe déjà' }); continue; }
      if (g.attentes.length + aAttendre.length >= 2000) { r.ignores.push({ quoi: cle, raison: 'trop de fiches en attente' }); continue; }
      r.attentes.push({ quoi: cle, equipe: nomEq(fiche.equipe) });
      aAttendre.push(fiche);
    }
    if (!appliquer) return r;
    for (const e of aCreer) g.equipes.push(e);
    for (const [cid, f] of aAjouter) {
      g.membres[cid] = { valide: Date.now(), par: auteur, qualite: f.qualite, licencie: f.qualite === 'radioamateur',
        indicatif: f.indicatif, numeroSwl: f.numeroSwl, equipe: f.equipe, fonction: f.fonction, noeud: f.noeud,
        importe: { de: nomSection, heure: Date.now() } };
      delete g.demandes[cid]; // demande d'adhésion éventuelle satisfaite
    }
    for (const f of aAttendre) g.attentes.push({ id: id(), heure: Date.now(), par: auteur, source: nomSection, ...f });
    sauver(true);
    journal(`[ADRASEC] import depuis ${nomSection} par ${auteur} : ${r.rattaches.length} rattaché(s), ${r.attentes.length} en attente, ${aCreer.length} équipe(s) créée(s)`);
    ajouterMc(null, { texte: `Import de la section depuis « ${nomSection} » : ${aCreer.length} équipe(s) créée(s), ${r.rattaches.length} membre(s) rattaché(s) à un compte, ${r.attentes.length} fiche(s) en attente d’activation`, type: 'information' }, { auteur });
    diffuser({ genre: 'adrasec', quoi: 'membres' });
    return r;
  }
  function retirerAttente(aid, auteur) {
    const i = g.attentes.findIndex((a) => a.id === aid);
    if (i < 0) throw new Error('Fiche en attente inconnue');
    const [a] = g.attentes.splice(i, 1);
    sauver(true);
    journal(`[ADRASEC] fiche en attente « ${cleAttente(a)} » retirée par ${auteur}`);
    return { ok: true };
  }

  // ---- Vue complète pour la page ADRASEC --------------------------------------------------------------------
  function vue(compte, comptesListe) {
    const admin = estResponsable(compte);
    const moi = membre(compte);
    const membres = Object.entries(g.membres).map(([cid, m]) => {
      const c = comptesListe.find((x) => x.id === Number(cid));
      const pos = positionMembre(m);
      return { compte: Number(cid), nom: c ? c.identifiant : '(compte supprimé)', indicatif: m.indicatif || null, licencie: !!m.licencie, qualite: m.qualite || (m.licencie ? 'radioamateur' : null), numeroSwl: m.numeroSwl || null, responsable: !!m.responsable, equipe: m.equipe || null, fonction: m.fonction || null,
        noeud: m.noeud || null, nomNoeud: m.noeud ? nomDe(m.noeud) : null, position: pos ? { lat: pos.lat, lon: pos.lon, heure: pos.heure || null } : null };
    });
    const recherches = g.recherches.slice(0, 30).map((r) => ({ ...r, releves: g.releves.filter((x) => x.recherche === r.id), calcul: localiser(r.id) }));
    return {
      nom: g.nom, code: g.code, actif: ctx.actif(), conservationJours: g.conservationJours,
      moi: { identifiant: compte.identifiant, admin: compte.role === 'admin', responsable: admin, membre: !!moi, licencie: estLicencie(compte), qualite: moi ? moi.qualite || (moi.licencie ? 'radioamateur' : null) : null, indicatif: moi ? moi.indicatif : null, equipe: moi ? moi.equipe : null, noeud: moi ? moi.noeud : null },
      equipes: g.equipes, membres, typesMc: TYPES_MC, frequences: FREQUENCES,
      mainCourante: g.mainCourante.slice(-400),
      recherches,
      comptes: admin ? comptesListe.filter((c) => c.statut === 'actif').map((c) => ({ id: c.id, identifiant: c.identifiant, indicatif: c.indicatif || null, role: c.role, adrasec: !!g.membres[c.id], autre: g.membres[c.id] ? null : ctx.groupeDeCompte(c.id) })) : undefined,
      demandes: admin ? Object.entries(g.demandes || {}).map(([cid, x]) => { const c = comptesListe.find((y) => y.id === Number(cid) && y.statut === 'actif'); return c && !g.membres[cid] ? { compte: c.id, identifiant: c.identifiant, indicatifCompte: c.indicatif || null, ...x } : null; }).filter(Boolean) : undefined,
      comptesEnAttente: compte.role === 'admin' ? comptesListe.filter((c) => c.statut === 'en_attente').length : undefined,
      // Fiches importées d'une autre carte, en attente du compte de la personne (président et responsables)
      attentes: admin ? g.attentes.map((a) => {
        const homonymes = a.indicatif ? comptesListe.filter((c) => c.statut === 'actif' && String(c.indicatif || '').toUpperCase() === a.indicatif) : [];
        return { id: a.id, heure: a.heure, source: a.source || null, indicatif: a.indicatif || null, numeroSwl: a.numeroSwl || null,
          qualite: a.qualite || null, fonction: a.fonction || null, equipe: a.equipe || null, noeud: a.noeud || null,
          compte: homonymes.length === 1 ? homonymes[0].id : null, identifiant: homonymes.length === 1 ? homonymes[0].identifiant : null, homonymes: homonymes.length };
      }) : undefined,
    };
  }

  return {
    g, purger, membre, estMembre, estResponsable, estLicencie, signature, demander, refuserDemande, demandeDe,
    reglages, majMembre, majEquipe, ajouterMc, csvMc, majRecherche, ajouterReleve, majReleve, retirerReleve, localiser, texteRecu, vue,
    diffuserBalise, creerLien, couperLien, vueTerrain, exporter, importer, retirerAttente,
  };
}

module.exports = { creerAdrasec };
