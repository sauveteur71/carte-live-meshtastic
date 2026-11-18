'use strict';
// Section ADRASEC (édition française) : espace réservé aux membres d'une association départementale de
// radiotransmetteurs au service de la sécurité civile, géré par les administrateurs de la carte.
// - Membres : un compte de la carte devient membre quand un administrateur le valide ; l'administrateur coche aussi
//   « radioamateur licencié » avec l'indicatif (vérifié sur pièce par lui : certificat d'opérateur / ANFR), affecte
//   une équipe et, en option, le nœud Meshtastic porté par le membre (sa position devient celle de l'équipe).
// - Main courante : événements horodatés, signés par leur auteur, jamais modifiés (seulement complétés), export CSV.
// - Radiogoniométrie : recherches de balise (121,5 / 243 / 406 MHz ou autre), relevés de gisement des équipes,
//   position la plus probable par moindres carrés (public/gonio.js). Un relevé arrive aussi par radio : message
//   « GONIO 125 » ou « GIS 125/5 » envoyé par le nœud d'un membre (position = celle du nœud).
// - Ce qui transmet sur les bandes radioamateurs (Winlink…) est réservé aux membres cochés « licencié ».
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

function creerAdrasec({ config, journal = () => {}, diffuser = () => {}, positionDe = () => null, nomDe = () => null, radioPoint = null }) {
  const fichier = path.join(path.dirname(config.fichierBase), 'adrasec.json');
  let d = { actif: false, nom: 'ADRASEC', conservationJours: 365, membres: {}, equipes: [], mainCourante: [], recherches: [], releves: [] };
  try { d = { ...d, ...lireJson(fichier) }; } catch { /* première utilisation */ }
  let minuterie = null;
  const sauver = (vite) => {
    clearTimeout(minuterie);
    const f = () => { try { ecrireSur(fichier, JSON.stringify(d)); } catch (e) { journal('[ADRASEC] enregistrement impossible :', e.message); } };
    if (vite) f(); else minuterie = setTimeout(f, 1500);
  };
  const purger = () => {
    const limite = Date.now() - Math.max(7, d.conservationJours || 365) * 86400000;
    const n = d.mainCourante.length + d.releves.length;
    d.mainCourante = d.mainCourante.filter((x) => x.heure >= limite);
    d.releves = d.releves.filter((x) => x.heure >= limite);
    d.recherches = d.recherches.filter((r) => r.statut === 'en-cours' || (r.fin || r.debut) >= limite);
    if (d.mainCourante.length + d.releves.length !== n) sauver();
  };
  purger();
  setInterval(purger, 6 * 3600000).unref();

  // ---- Accès ------------------------------------------------------------------------------------------------
  const membre = (compte) => (compte && d.actif ? d.membres[compte.id] || null : null);
  const estMembre = (compte) => !!compte && d.actif && (compte.role === 'admin' || !!membre(compte));
  const estLicencie = (compte) => { const m = membre(compte); return !!(m && m.licencie && m.indicatif); };
  const signature = (compte) => { const m = membre(compte); return (m && m.indicatif) || compte.indicatif || compte.identifiant; };

  // ---- Réglages et membres (administrateur) -----------------------------------------------------------------
  function reglages(b) {
    if (b.actif !== undefined) d.actif = !!b.actif;
    if (b.nom !== undefined) d.nom = txt(b.nom, 40) || 'ADRASEC';
    if (b.conservationJours !== undefined) d.conservationJours = Math.min(3650, Math.max(7, Math.round(Number(b.conservationJours) || 365)));
    sauver(true);
    return { actif: d.actif, nom: d.nom, conservationJours: d.conservationJours };
  }
  function majMembre(compteId, b, auteur) {
    const cid = Number(compteId);
    if (!Number.isInteger(cid)) throw new Error('Compte inconnu');
    if (b.membre === false) {
      if (d.membres[cid]) { delete d.membres[cid]; journal(`[ADRASEC] compte ${cid} retiré par ${auteur}`); }
      sauver(true);
      return { ok: true };
    }
    const m = d.membres[cid] || { valide: Date.now(), par: auteur };
    if (b.indicatif !== undefined) {
      const ind = txt(b.indicatif, 12).toUpperCase();
      if (ind && !INDICATIF.test(ind)) throw new Error('Indicatif invalide (ex. F4ABC)');
      m.indicatif = ind || null;
    }
    if (b.licencie !== undefined) m.licencie = !!b.licencie;
    if (m.licencie && !m.indicatif) throw new Error('Un licencié doit avoir son indicatif');
    if (b.equipe !== undefined) m.equipe = b.equipe && d.equipes.some((e) => e.id === b.equipe) ? b.equipe : null;
    if (b.noeud !== undefined) { const n = Number(b.noeud); m.noeud = b.noeud === null || b.noeud === '' ? null : Number.isInteger(n) && n > 0 ? n >>> 0 : m.noeud ?? null; }
    if (b.fonction !== undefined) m.fonction = txt(b.fonction, 40) || null;
    d.membres[cid] = m;
    sauver(true);
    journal(`[ADRASEC] membre ${cid} mis à jour par ${auteur}${m.licencie ? ' (licencié ' + m.indicatif + ')' : ''}`);
    return { ok: true, membre: m };
  }
  function majEquipe(eid, b) {
    if (eid) {
      const e = d.equipes.find((x) => x.id === eid);
      if (!e) throw new Error('Équipe inconnue');
      if (b.supprimer) {
        d.equipes = d.equipes.filter((x) => x !== e);
        for (const m of Object.values(d.membres)) if (m.equipe === eid) m.equipe = null;
      } else {
        if (b.nom !== undefined) e.nom = txt(b.nom, 30) || e.nom;
        if (b.couleur !== undefined && /^#[0-9a-f]{6}$/i.test(b.couleur)) e.couleur = b.couleur;
        if (b.mission !== undefined) e.mission = txt(b.mission, 120) || null;
      }
    } else {
      const nom = txt(b.nom, 30);
      if (!nom) throw new Error('Nom d’équipe manquant');
      const couleurs = ['#ff8a1f', '#4cc9f0', '#b48cff', '#3ee68a', '#ff5c6c', '#ffd23f', '#e07bff', '#80ed99'];
      d.equipes.push({ id: id(), nom, couleur: couleurs[d.equipes.length % couleurs.length], mission: txt(b.mission, 120) || null });
    }
    sauver(true);
    return { equipes: d.equipes };
  }

  // ---- Main courante ----------------------------------------------------------------------------------------
  function ajouterMc(compte, b, extra = {}) {
    const texte = txt(b.texte, 1000);
    if (!texte) throw new Error('Texte vide');
    const x = { id: id(), heure: Date.now(), auteur: compte ? signature(compte) : extra.auteur || 'radio', type: TYPES_MC.includes(b.type) ? b.type : 'information',
      equipe: b.equipe && d.equipes.some((e) => e.id === b.equipe) ? b.equipe : (compte && membre(compte) && membre(compte).equipe) || null, texte, complete: b.complete && d.mainCourante.some((y) => y.id === b.complete) ? b.complete : null, ...extra };
    d.mainCourante.push(x);
    if (d.mainCourante.length > 20000) d.mainCourante.splice(0, d.mainCourante.length - 20000);
    sauver();
    diffuser({ genre: 'adrasec', quoi: 'main-courante' });
    return x;
  }
  function csvMc() {
    const eq = new Map(d.equipes.map((e) => [e.id, e.nom]));
    const c = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return '﻿' + ['Date;Heure;Auteur;Équipe;Type;Texte;Complète'].concat(d.mainCourante.map((x) => {
      const t = new Date(x.heure);
      return [t.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }), t.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' }), x.auteur, eq.get(x.equipe) || '', x.type, x.texte, x.complete || ''].map(c).join(';');
    })).join('\r\n');
  }

  // ---- Radiogoniométrie -------------------------------------------------------------------------------------
  function majRecherche(rid, b, compte) {
    if (!rid) {
      const nom = txt(b.nom, 60) || `Recherche du ${new Date().toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' })}`;
      const r = { id: id(), nom, frequence: FREQUENCES.includes(b.frequence) ? b.frequence : '121,5 MHz', detail: txt(b.detail, 120) || null, debut: Date.now(), fin: null, statut: 'en-cours', ouvertePar: signature(compte) };
      d.recherches.unshift(r);
      ajouterMc(compte, { texte: `Ouverture de la recherche « ${r.nom} » (${r.frequence}${r.detail ? ', ' + r.detail : ''})`, type: 'decision' });
      sauver(true);
      return r;
    }
    const r = d.recherches.find((x) => x.id === rid);
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
    const r = d.recherches.find((x) => x.id === b.recherche) || d.recherches.find((x) => x.statut === 'en-cours');
    if (!r || r.statut !== 'en-cours') throw new Error('Aucune recherche en cours : ouvrez-en une d’abord');
    const g = Number(String(b.gisement).replace(',', '.'));
    if (!(g >= 0 && g <= 360)) throw new Error('Gisement entre 0 et 360°');
    const inc = b.incertitude == null || b.incertitude === '' ? 5 : Number(String(b.incertitude).replace(',', '.'));
    if (!(inc >= 0.5 && inc <= 45)) throw new Error('Incertitude entre 0,5 et 45°');
    let pos = null, source = null;
    const m = compte ? membre(compte) : null;
    if (b.locator) { const p = Gonio.depuisLocator(b.locator); if (!p) throw new Error('Locator invalide (ex. JN15XC33)'); pos = p; source = 'locator ' + String(b.locator).toUpperCase(); }
    else if (Number.isFinite(Number(b.lat)) && Number.isFinite(Number(b.lon)) && b.lat !== '' && b.lon !== '') { pos = { lat: Number(b.lat), lon: Number(b.lon) }; source = b.source === 'gps' ? 'GPS' : 'carte'; }
    else if (b.noeud || (m && m.noeud)) { const n = Number(b.noeud || m.noeud) >>> 0; const p = positionDe(n); if (!p || p.lat == null) throw new Error('Position du nœud inconnue'); pos = p; source = 'nœud ' + (nomDe(n) || '!' + n.toString(16)); }
    if (!pos || Math.abs(pos.lat) > 90 || Math.abs(pos.lon) > 180) throw new Error('Position de l’équipe manquante (GPS, locator, clic sur la carte ou nœud)');
    const x = { id: id(), recherche: r.id, heure: Date.now(), auteur: compte ? signature(compte) : b.auteur || 'radio', equipe: b.equipe || (m && m.equipe) || null,
      lat: +pos.lat.toFixed(6), lon: +pos.lon.toFixed(6), source, gisement: +(g % 360).toFixed(1), incertitude: +inc.toFixed(1), force: txt(b.force, 20) || null, note: txt(b.note, 200) || null, origine };
    d.releves.push(x);
    sauver();
    ajouterMc(compte, { texte: `Relevé ${x.gisement}° ±${x.incertitude}° depuis ${Gonio.versLocator(x.lat, x.lon, 8)} (${x.source})${x.force ? ', force ' + x.force : ''}${x.note ? ' — ' + x.note : ''}`, type: 'information', equipe: x.equipe }, compte ? {} : { auteur: x.auteur });
    diffuser({ genre: 'adrasec', quoi: 'releves', recherche: r.id });
    setTimeout(() => diffusionAuto(r.id), 0);
    return x;
  }
  function retirerReleve(compte, rid) {
    const x = d.releves.find((y) => y.id === rid);
    if (!x) throw new Error('Relevé inconnu');
    if (compte.role !== 'admin' && x.auteur !== signature(compte)) throw new Error('Seul l’auteur ou un administrateur peut retirer ce relevé');
    x.retire = { heure: Date.now(), par: signature(compte) }; // gardé pour la main courante, mais hors calcul
    ajouterMc(compte, { texte: `Relevé ${x.gisement}° de ${x.auteur} retiré du calcul`, type: 'decision' });
    sauver();
    diffuser({ genre: 'adrasec', quoi: 'releves', recherche: x.recherche });
    return { ok: true };
  }
  function localiser(rid) {
    return Gonio.localiser(d.releves.filter((x) => x.recherche === rid && !x.retire));
  }

  // Relevé reçu par radio : « GONIO 125 » / « GIS 125/5 » depuis le nœud d'un membre, sur une recherche en cours
  const vus = new Map();
  function texteRecu(evt) {
    if (!d.actif || !evt || !evt.texte) return;
    const lu = Gonio.lireMessage(evt.texte);
    if (!lu) return;
    const de = evt.de >>> 0;
    const entree = Object.entries(d.membres).find(([, m]) => m.noeud === de);
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
    const r = d.recherches.find((x) => x.id === rid);
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
    const r = d.recherches.find((x) => x.id === rid);
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
    const r = d.recherches.find((x) => x.id === rid);
    if (!r || r.statut !== 'en-cours') throw new Error('Recherche en cours inconnue');
    r.lien = { jeton: crypto.randomBytes(16).toString('hex'), expire: Date.now() + 48 * 3600000, cree: Date.now(), par: signature(compte) };
    sauver(true);
    ajouterMc(compte, { texte: `Lien terrain créé pour la recherche « ${r.nom} » (lecture seule, 48 h au plus)`, type: 'information' });
    return { jeton: r.lien.jeton, expire: r.lien.expire };
  }
  function couperLien(rid, compte) {
    const r = d.recherches.find((x) => x.id === rid);
    if (!r) throw new Error('Recherche inconnue');
    if (r.lien) { r.lien = null; sauver(true); ajouterMc(compte, { texte: `Lien terrain de la recherche « ${r.nom} » désactivé`, type: 'information' }); }
    return { ok: true };
  }
  function vueTerrain(jeton) {
    if (!d.actif || !/^[0-9a-f]{32}$/.test(String(jeton || ''))) return null;
    const r = d.recherches.find((x) => x.lien && x.lien.jeton === jeton);
    if (!r || r.statut !== 'en-cours' || r.lien.expire < Date.now()) return null;
    const eq = new Map(d.equipes.map((e) => [e.id, e]));
    return {
      section: d.nom, recherche: { nom: r.nom, frequence: r.frequence, detail: r.detail, debut: r.debut },
      releves: d.releves.filter((x) => x.recherche === r.id && !x.retire).map((x) => ({ id: x.id, heure: x.heure, equipe: x.equipe ? (eq.get(x.equipe) || {}).nom || null : null, couleur: x.equipe ? (eq.get(x.equipe) || {}).couleur || null : null, lat: x.lat, lon: x.lon, gisement: x.gisement, incertitude: x.incertitude, force: x.force })),
      calcul: localiser(r.id),
      // Positions des équipes (nœud porté), sans nom de personne
      equipes: d.equipes.map((e) => ({ nom: e.nom, couleur: e.couleur, mission: e.mission || null, positions: Object.values(d.membres).filter((m) => m.equipe === e.id).map(positionMembre).filter(Boolean).map((p) => ({ lat: p.lat, lon: p.lon, heure: p.heure || null })) })),
      expire: r.lien.expire,
    };
  }

  // ---- Vue complète pour la page ADRASEC --------------------------------------------------------------------
  function vue(compte, comptesListe, admin) {
    const moi = membre(compte);
    const membres = Object.entries(d.membres).map(([cid, m]) => {
      const c = comptesListe.find((x) => x.id === Number(cid));
      const pos = positionMembre(m);
      return { compte: Number(cid), nom: c ? c.identifiant : '(compte supprimé)', indicatif: m.indicatif || null, licencie: !!m.licencie, equipe: m.equipe || null, fonction: m.fonction || null,
        noeud: m.noeud || null, nomNoeud: m.noeud ? nomDe(m.noeud) : null, position: pos ? { lat: pos.lat, lon: pos.lon, heure: pos.heure || null } : null };
    });
    const recherches = d.recherches.slice(0, 30).map((r) => ({ ...r, releves: d.releves.filter((x) => x.recherche === r.id), calcul: localiser(r.id) }));
    return {
      nom: d.nom, actif: d.actif, conservationJours: d.conservationJours,
      moi: { identifiant: compte.identifiant, admin: compte.role === 'admin', membre: !!moi, licencie: estLicencie(compte), indicatif: moi ? moi.indicatif : null, equipe: moi ? moi.equipe : null, noeud: moi ? moi.noeud : null },
      equipes: d.equipes, membres, typesMc: TYPES_MC, frequences: FREQUENCES,
      mainCourante: d.mainCourante.slice(-400),
      recherches,
      comptes: admin ? comptesListe.filter((c) => c.statut === 'actif').map((c) => ({ id: c.id, identifiant: c.identifiant, indicatif: c.indicatif || null, role: c.role, adrasec: !!d.membres[c.id] })) : undefined,
    };
  }

  return {
    actif: () => d.actif, nom: () => d.nom, estMembre, estLicencie, signature,
    reglages, majMembre, majEquipe, ajouterMc, csvMc, majRecherche, ajouterReleve, retirerReleve, localiser, texteRecu, vue,
    diffuserBalise, creerLien, couperLien, vueTerrain,
  };
}

module.exports = { creerAdrasec };
