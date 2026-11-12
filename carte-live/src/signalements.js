'use strict';
// Signalements : un événement posé sur la carte (route inondée, arbre tombé…) et diffusé en LoRa.
// - Meshtastic : point de passage (WAYPOINT_APP, visible sur la carte des applis et des Bipper / GerMaCrise), sur un ou
//   plusieurs canaux du module (Fr_Balise puis Alerte, comme GerMaCrise), et en option un message texte ;
// - MeshCore : message sur un canal du companion ;
// - « Terminé » : le point de passage est retiré des applis (expiration immédiate) et un message de fin est envoyé ;
// - Réception : les points de passage captés (MQTT ou module) deviennent des signalements sur la carte.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Types alignés sur GerMaCrise / Bipper (F4EED) : même identifiant, même emoji, même code d'icône du point de passage
const TYPES = {
  axe_inonde: { icone: '🌊', nom: 'Axe inondé', code: 0x1F30A, cat: ['routes', 'crise', 'secourisme', 'adrasec', 'sdis'] },
  axe_barre: { icone: '🚫', nom: 'Axe barré', code: 0x1F6AB, cat: ['routes', 'crise', 'secourisme', 'adrasec', 'sdis'] },
  objet_sur_axe: { icone: '📦', nom: 'Objet sur axe', code: 0x1F4E6, cat: ['routes', 'crise', 'secourisme', 'adrasec', 'sdis'] },
  arbre_sur_axe: { icone: '🌳', nom: 'Arbre sur axe', code: 0x1F333, cat: ['routes', 'crise', 'secourisme', 'adrasec', 'sdis'] },
  animal_sur_axe: { icone: '🦌', nom: 'Animal sur axe', code: 0x1F98C, cat: ['routes', 'crise', 'adrasec', 'sdis'] },
  accident_sur_axe: { icone: '🚨', nom: 'Accident sur axe', code: 0x1F6A8, cat: ['routes', 'crise', 'secourisme', 'adrasec', 'sdis'] },
  incendie: { icone: '🔥', nom: 'Incendie', code: 0x1F525, cat: ['routes', 'crise', 'secourisme', 'adrasec', 'sdis'] },
  inondation: { icone: '🌊', nom: 'Inondation', code: 0x1F30A, cat: ['routes', 'crise', 'secourisme', 'adrasec', 'sdis'] },
  parti: { icone: '🚶', nom: 'PARTI', code: 0x1F6B6, cat: ['statut', 'sdis'] },
  sur_les_lieux: { icone: '📍', nom: 'SUR LES LIEUX', code: 0x1F4CD, cat: ['statut', 'sdis'] },
  alerte_recue: { icone: '✅', nom: 'Alerte bien reçus et lu', code: 0x2705, cat: ['routes', 'crise', 'secourisme', 'statut', 'adrasec', 'sdis'] },
  depart_hopital: { icone: '🚑', nom: 'DEPART HOPITAL', code: 0x1F691, cat: ['crise', 'secourisme', 'statut', 'sdis'] },
  arrivee_hopital: { icone: '🏥', nom: 'ARRIVEE HOPITAL', code: 0x1F3E5, cat: ['crise', 'secourisme', 'statut', 'sdis'] },
  disponible: { icone: '🟢', nom: 'DISPONIBLE', code: 0x1F7E2, cat: ['statut', 'sdis'] },
  indisponible: { icone: '🔴', nom: 'INDISPONIBLE', code: 0x1F534, cat: ['statut', 'sdis'] },
  rentre: { icone: '🏠', nom: 'RENTRE', code: 0x1F3E0, cat: ['statut', 'sdis'] },
  police_ssl: { icone: '👮', nom: 'POLICE SSL', code: 0x1F46E, cat: ['statut', 'sdis'] },
  gendarmerie_ssl: { icone: '🏛️', nom: 'GENDARMERIE SSL', code: 0x1F3DB, cat: ['statut', 'sdis'] },
  smur_ssl: { icone: '🚑', nom: 'SMUR SSL', code: 0x1F691, cat: ['statut', 'sdis'] },
  gdf_ssl: { icone: '⛽', nom: 'GDF SSL', code: 0x26FD, cat: ['statut', 'sdis'] },
  cg_ssl: { icone: '🏗️', nom: 'CG SSL', code: 0x1F3D7, cat: ['statut', 'sdis'] },
  dtt_ssl: { icone: '📋', nom: 'DTT SSL', code: 0x1F4CB, cat: ['statut', 'sdis'] },
  dir_ssl: { icone: '🛣️', nom: 'DIR SSL', code: 0x1F6E3, cat: ['statut', 'sdis'] },
  brig_verte_ssl: { icone: '🌿', nom: 'Brig. Verte SSL', code: 0x1F33F, cat: ['statut', 'sdis'] },
  pol_muni_ssl: { icone: '🚨', nom: 'Pol. Muni. SSL', code: 0x1F6A8, cat: ['statut', 'sdis'] },
  mairie_ssl: { icone: '🏛️', nom: 'Mairie SSL', code: 0x1F3DB, cat: ['statut', 'sdis'] },
  releve_sar: { icone: '🛟', nom: 'Relève SAR', code: 0x1F6DF, cat: ['statut', 'sdis'] },
  dispo_hors_secteur: { icone: '📡', nom: 'Dispo hors secteur', code: 0x1F4E1, cat: ['statut', 'sdis'] },
  cai_chu: { icone: '🏥', nom: 'CAI/CHU', code: 0x1F3E5, cat: ['crise', 'secourisme'] },
  equipes_secouriste: { icone: '🚑', nom: 'Équipes secouriste', code: 0x1F691, cat: ['crise', 'secourisme'] },
  releve_sater_sans_signal: { icone: '📡', nom: 'Relevé SATER (sans signal)', code: 0x1F4E1, cat: ['crise', 'adrasec'] },
  releve_sater_avec_signal: { icone: '📶', nom: 'Relevé SATER (avec signal)', code: 0x1F4F6, cat: ['crise', 'adrasec'] },
  point_sar: { icone: '🛟', nom: 'Point SAR', code: 0x1F6DF, cat: ['crise', 'secourisme', 'adrasec', 'sdis'] },
  poste_secours: { icone: '🏥', nom: 'Poste secours', code: 0x1F3E5, cat: ['secourisme'] },
  pma: { icone: '🚑', nom: 'PMA', code: 0x1F691, cat: ['secourisme', 'crise'] },
  dps: { icone: '📋', nom: 'DPS', code: 0x1F4CB, cat: ['secourisme'] },
  zone_triage: { icone: '🏷️', nom: 'Zone triage', code: 0x1F3F7, cat: ['secourisme', 'crise'] },
  zav: { icone: '📍', nom: 'ZAV', code: 0x1F4CD, cat: ['secourisme'] },
  victimes: { icone: '🚶', nom: 'Victime(s)', code: 0x1F6B6, cat: ['secourisme'] },
  blesse_leger: { icone: '🩹', nom: 'Blessé léger', code: 0x1FA79, cat: ['secourisme'] },
  blesse_grave: { icone: '🩸', nom: 'Blessé grave', code: 0x1FA78, cat: ['secourisme'] },
  demande_renfort: { icone: '📢', nom: 'Demande renfort', code: 0x1F4E2, cat: ['secourisme', 'crise'] },
  fin_intervention: { icone: '✅', nom: 'Fin d’intervention', code: 0x2705, cat: ['secourisme'] },
  pluie: { icone: '🌧️', nom: 'Pluie', code: 0x1F327, cat: ['meteo'] },
  pluie_forte: { icone: '💧', nom: 'Pluie forte', code: 0x1F4A7, cat: ['meteo'] },
  orage: { icone: '⛈️', nom: 'Orage', code: 0x26C8, cat: ['meteo'] },
  fort_orage: { icone: '⚡', nom: 'Fort orage', code: 0x26A1, cat: ['meteo'] },
  brouillard: { icone: '🌫️', nom: 'Brouillard', code: 0x1F32B, cat: ['meteo'] },
  neige: { icone: '❄️', nom: 'Neige', code: 0x2744, cat: ['meteo'] },
  grele: { icone: '🧊', nom: 'Grêle', code: 0x1F9CA, cat: ['meteo'] },
  vent_fort: { icone: '💨', nom: 'Vent fort', code: 0x1F4A8, cat: ['meteo'] },
  canicule: { icone: '🥵', nom: 'Canicule', code: 0x1F975, cat: ['meteo'] },
  gel: { icone: '🥶', nom: 'Gel', code: 0x1F976, cat: ['meteo'] },
  verglas: { icone: '⚠️', nom: 'Verglas', code: 0x26A0, cat: ['meteo'] },
  autre: { icone: '❗', nom: 'Signalement', code: 0x2757, cat: ['routes', 'crise'] },
};
const CATEGORIES = { routes: 'Routes', crise: 'Crise', secourisme: 'Secourisme', meteo: 'Météo', statut: 'Statut', sdis: 'SDIS', adrasec: 'ADRASEC' };
const DUREES = [2, 6, 24, 72, 168]; // heures
const PRIORITE_ALERTE = 110; // MeshPacket.Priority.ALERT
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function creerSignalements({ config, radio, administration, companion, reseauMc, racine, journal, diffuser, nomNoeud = () => null }) {
  const fichier = path.join(path.dirname(config.fichierBase), 'signalements.json');
  let liste = [];
  try { liste = JSON.parse(fs.readFileSync(fichier, 'utf8')).signalements || []; } catch { /* aucun */ }
  let minuterie = null;
  const sauver = () => { clearTimeout(minuterie); minuterie = setTimeout(() => { try { fs.writeFileSync(fichier, JSON.stringify({ signalements: liste })); } catch (e) { journal('[Signalements] enregistrement impossible :', e.message); } }, 300); };
  const Waypoint = racine.lookupType('meshtastic.Waypoint');

  // Coupe une chaîne à n octets UTF-8 sans casser un caractère
  function couper(t, n) {
    t = String(t || '');
    while (Buffer.byteLength(t) > n) t = [...t].slice(0, -1).join('');
    return t;
  }
  const coords = (s) => `${s.lat.toFixed(5)},${s.lon.toFixed(5)}`;
  const actif = (s) => !s.fin && s.expire > Date.now();

  function canaux() {
    const i = radio.infos();
    let mc = { pret: false, canaux: [] };
    try { mc = { pret: !!companion.etat().pret, canaux: (companion.canaux() || []).map((c) => ({ index: c.index, nom: c.nom })) }; } catch { /* pas de companion */ }
    return {
      mt: { connecte: !!i.connecte, canaux: (i.canaux || []).map((c) => ({ index: c.index, nom: c.nom || (c.index === 0 ? 'principal' : 'canal ' + c.index) })) },
      mc, types: TYPES, categories: CATEGORIES, durees: DUREES,
    };
  }

  function paquetPoint(s, expireS) {
    const t = TYPES[s.type] || TYPES.autre;
    return Waypoint.encode(Waypoint.create({
      id: s.idPoint, latitudeI: Math.round(s.lat * 1e7), longitudeI: Math.round(s.lon * 1e7), expire: expireS, lockedTo: 0,
      name: couper(`${t.icone} ${s.titre || t.nom}`, 30), description: couper(s.details || t.nom, 100), icon: t.code,
    })).finish();
  }
  function envoyerPointMt(s, canal, expireS) {
    const i = radio.infos();
    if (!i.connecte) throw new Error('module radio non connecté');
    if (!(i.canaux || []).some((c) => c.index === canal)) throw new Error(`canal ${canal} inconnu du module`);
    const id = crypto.randomBytes(4).readUInt32LE(0) >>> 0 || 1;
    // wantAck=false : un broadcast avec accusé sature la file radio et fait perdre le paquet suivant (constat GerMaCrise)
    const paquet = { to: 0xffffffff, id, channel: canal, wantAck: false, priority: PRIORITE_ALERTE, hopLimit: i.hopLimit, decoded: { portnum: 8, payload: paquetPoint(s, expireS) } };
    radio.envoyerPaquet(paquet);
    try { radio.injecter({ ...paquet, from: i.noeudLocal, rxTime: Math.floor(Date.now() / 1000), hopStart: i.hopLimit }); } catch { /* historique seulement */ }
  }

  function texteAnnonce(s, fin) {
    const t = TYPES[s.type] || TYPES.autre;
    if (fin) return `✅ Fin : ${t.icone} ${s.titre || t.nom} · ${coords(s)}`;
    const suite = s.trace && s.forme === 'ligne' ? ` → ${s.trace[s.trace.length - 1][0].toFixed(5)},${s.trace[s.trace.length - 1][1].toFixed(5)}` : s.forme === 'zone' ? ' (zone)' : '';
    return `${t.icone} ${s.titre || t.nom}${s.details ? ' : ' + s.details : ''} · ${coords(s)}${suite} · ${s.auteur}`;
  }

  // Envoie sur les réseaux demandés ; chaque canal a son propre état (une panne n'empêche pas les autres)
  async function diffuserLora(s, fin = false) {
    const texte = texteAnnonce(s, fin);
    for (const [k, e] of (s.envois.mt || []).entries()) {
      if (k) await pause(500); // comme GerMaCrise : 500 ms entre deux canaux
      try {
        envoyerPointMt(s, e.canal, fin ? Math.floor(Date.now() / 1000) - 60 : Math.floor(s.expire / 1000));
        if (s.texte) { await pause(300); administration.envoyerTexte({ texte: couper(texte, 200), canal: e.canal }, s.auteur); }
        Object.assign(e, { statut: 'envoye', heure: Date.now(), erreur: null });
      } catch (err) { Object.assign(e, { statut: 'echec', heure: Date.now(), erreur: err.message }); }
    }
    if (s.envois.mc) {
      const e = s.envois.mc;
      try {
        const c = companion.etat();
        if (!c.pret) throw new Error('companion MeshCore non relié');
        const canal = (companion.canaux() || []).find((x) => x.index === e.canal);
        if (!canal) throw new Error('canal inconnu du companion');
        const tx = couper(texte, 140);
        await companion.envoyerCanal(e.canal, tx);
        try { reseauMc.noterMessage({ sens: 'envoye', genre: 'canal', canal: canal.nom, indexCanal: e.canal, de: c.cle, nomDe: c.nom, texte: tx, statut: 'envoye', auteur: s.auteur, region: c.zoneDefaut == null ? null : c.zoneDefaut || '-' }); } catch { /* historique seulement */ }
        Object.assign(e, { statut: 'envoye', heure: Date.now(), erreur: null });
      } catch (err) { Object.assign(e, { statut: 'echec', heure: Date.now(), erreur: err.message }); }
    }
    sauver();
    diffuser({ genre: 'signalement', id: s.id });
    if (s.envois.mc) diffuser({ genre: 'mc-message', confirmation: true });
  }

  async function creer(b, auteur) {
    const lat = Number(b.lat), lon = Number(b.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('position invalide');
    const type = TYPES[b.type] ? b.type : 'autre';
    const heures = DUREES.includes(Number(b.dureeH)) ? Number(b.dureeH) : 24;
    const titre = String(b.titre || '').trim().slice(0, 60) || TYPES[type].nom;
    const details = String(b.details || '').trim().slice(0, 140);
    const mt = [...new Set((Array.isArray(b.mt) ? b.mt : b.mt != null && b.mt !== '' ? [b.mt] : []).map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x < 8))];
    const envois = {};
    if (mt.length) envois.mt = mt.map((canal) => ({ canal, statut: 'attente' }));
    if (b.mc != null && b.mc !== '') envois.mc = { canal: Number(b.mc), statut: 'attente' };
    // Tronçon (ligne) ou zone (polygone) : liste de points ; le point de passage LoRa reste au premier point
    let forme = 'point', trace = null;
    if (Array.isArray(b.trace) && b.trace.length >= 2 && ['ligne', 'zone'].includes(b.forme)) {
      trace = b.trace.slice(0, 40).map((p) => [Number(p[0]), Number(p[1])]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180);
      if (trace.length >= (b.forme === 'zone' ? 3 : 2)) forme = b.forme; else trace = null;
    }
    const s = {
      forme, trace,
      id: crypto.randomBytes(5).toString('hex'), idPoint: crypto.randomBytes(4).readUInt32LE(0) >>> 0 || 1, source: 'carte',
      type, titre, details, lat, lon, auteur, cree: Date.now(), expire: Date.now() + heures * 3600000, fin: null, envois, texte: b.texte !== false,
    };
    liste.push(s);
    if (liste.length > 500) liste = liste.slice(-500);
    journal(`[Signalements] ${TYPES[type].nom} signalé par ${auteur} en ${coords(s)}`);
    await diffuserLora(s);
    return vue(s);
  }

  async function terminer(id, auteur, { annoncer = true } = {}) {
    const s = liste.find((x) => x.id === id);
    if (!s) throw new Error('signalement inconnu');
    if (s.fin) throw new Error('signalement déjà terminé');
    s.fin = Date.now(); s.finPar = auteur;
    journal(`[Signalements] ${s.titre} terminé par ${auteur}`);
    if (annoncer && s.source === 'carte') await diffuserLora(s, true); else { sauver(); diffuser({ genre: 'signalement', id: s.id }); }
    return vue(s);
  }

  async function renvoyer(id) {
    const s = liste.find((x) => x.id === id);
    if (!s || !actif(s)) throw new Error('signalement terminé ou expiré');
    if (s.source !== 'carte') throw new Error('signalement reçu par radio : il ne se renvoie pas d’ici');
    await diffuserLora(s);
    return vue(s);
  }

  // Point de passage capté (MQTT ou module) : Bipper, GerMaCrise, appli Meshtastic…
  const typeParCode = (code, nom) => {
    const parNom = Object.entries(TYPES).find(([, t]) => nom && nom.replace(/^\S+\s+/, '').toLowerCase() === t.nom.toLowerCase());
    if (parNom) return parNom[0];
    const parCode = Object.entries(TYPES).find(([, t]) => t.code === code);
    return parCode ? parCode[0] : 'autre';
  };
  function recu(evt) {
    const w = evt.pointRepere;
    if (!w || w.lat == null || w.lon == null || !w.id) return;
    const de = evt.de >>> 0;
    if (liste.some((x) => x.source === 'carte' && x.idPoint === w.id)) return; // notre propre envoi
    const maintenant = Date.now();
    const expire = w.expire ? w.expire * 1000 : null;
    let s = liste.find((x) => x.source === 'radio' && x.idPoint === w.id && x.de === de);
    if (s) {
      if (expire && expire <= maintenant) { if (!s.fin) { s.fin = maintenant; s.finPar = s.auteur; } }
      else Object.assign(s, { lat: w.lat, lon: w.lon, titre: w.nom.replace(/^\p{Extended_Pictographic}️?\s*/u, '') || s.titre, details: w.description, expire: expire || Math.max(s.expire, maintenant + 24 * 3600000) });
    } else {
      if (expire && expire <= maintenant) return; // retrait d'un point jamais vu
      const type = typeParCode(w.icone, w.nom);
      s = {
        id: crypto.randomBytes(5).toString('hex'), idPoint: w.id, source: 'radio', de, canal: evt.canal || evt.canalTopic || null,
        type, titre: w.nom.replace(/^\p{Extended_Pictographic}️?\s*/u, '').slice(0, 60) || TYPES[type].nom, details: String(w.description || '').slice(0, 140),
        icone: w.icone ? String.fromCodePoint(w.icone) : null,
        lat: w.lat, lon: w.lon, auteur: nomNoeud(de) || '!' + de.toString(16).padStart(8, '0'),
        cree: maintenant, expire: expire || maintenant + 24 * 3600000, fin: null, envois: {},
      };
      liste.push(s);
      if (liste.length > 500) liste = liste.slice(-500);
      journal(`[Signalements] reçu de ${s.auteur} : ${s.titre} en ${coords(s)}`);
    }
    sauver();
    diffuser({ genre: 'signalement', id: s.id });
  }

  function vue(s) {
    const t = TYPES[s.type] || TYPES.autre;
    return { ...s, icone: s.icone || t.icone, nomType: t.nom, actif: actif(s) };
  }
  // Actifs + terminés ou expirés depuis moins de 7 jours
  function lister() {
    const limite = Date.now() - 7 * 86400000;
    return liste.filter((s) => actif(s) || (s.fin || s.expire) > limite).map(vue).sort((a, b) => b.cree - a.cree);
  }

  // ---- Alertes Bipper / GerMaCrise (F4EED) : « #alerte N texte #entité », « #fin N », accusés « Pager ACK alerte #N … » ----
  const fAlertes = path.join(path.dirname(config.fichierBase), 'alertes-bipper.json');
  let alertes = { prochain: 1, liste: [] };
  try { alertes = { ...alertes, ...JSON.parse(fs.readFileSync(fAlertes, 'utf8')) }; } catch { /* aucune */ }
  const sauverAlertes = () => { try { fs.writeFileSync(fAlertes, JSON.stringify(alertes)); } catch { /* lecture seule */ } };
  const GENRES = { alerte: '#alerte', secours: '#secours', vigilance: '#vigilance', info: '#info' };
  function envoyerAlerte(b, auteur) {
    const genre = GENRES[b.genre] ? b.genre : 'alerte';
    const texte = String(b.texte || '').trim().replace(/\s+/g, ' ');
    if (!texte) throw new Error('Texte de l’alerte vide');
    const entites = String(b.entites || '').split(/[\s,;]+/).map((x) => x.replace(/^#/, '').trim()).filter((x) => /^[\p{L}\p{N}_-]{1,20}$/u.test(x)).slice(0, 6);
    const canal = Number(b.canal);
    const n = alertes.prochain;
    const message = couper(`${GENRES[genre]} ${n} ${texte}${entites.length ? ' ' + entites.map((x) => '#' + x).join(' ') : ''}`, 200);
    administration.envoyerTexte({ texte: message, canal }, auteur);
    alertes.prochain = n >= 9999 ? 1 : n + 1;
    const a = { n, genre, texte, entites, canal, message, heure: Date.now(), auteur, fin: null, acks: [] };
    alertes.liste.push(a);
    if (alertes.liste.length > 200) alertes.liste = alertes.liste.slice(-200);
    sauverAlertes();
    journal(`[Alertes] ${GENRES[genre]} ${n} envoyée par ${auteur} sur le canal ${canal}`);
    diffuser({ genre: 'signalement', alerte: n });
    return a;
  }
  function finAlerte(n, auteur) {
    const a = alertes.liste.find((x) => x.n === Number(n) && !x.fin);
    if (!a) throw new Error('Alerte inconnue ou déjà clôturée');
    administration.envoyerTexte({ texte: `#fin ${a.n}${a.entites.length ? ' ' + a.entites.map((x) => '#' + x).join(' ') : ''}`, canal: a.canal }, auteur);
    a.fin = Date.now(); a.finPar = auteur;
    sauverAlertes();
    diffuser({ genre: 'signalement', alerte: a.n });
    return a;
  }
  // Message texte capté : accusé de lecture d'un pager (« Pager ACK alerte #42 31/07 10:35 — texte | 45.1N 4.5E »)
  function texteRecu(evt) {
    const m = String(evt.texte || '').match(/^Pager ACK alerte\s+#?(\d+)?/i);
    if (!m) return;
    const de = evt.de >>> 0;
    const a = m[1] ? [...alertes.liste].reverse().find((x) => x.n === Number(m[1])) : [...alertes.liste].reverse().find((x) => !x.fin);
    if (!a || a.acks.some((k) => k.de === de)) return;
    a.acks.push({ de, nom: nomNoeud(de) || '!' + de.toString(16).padStart(8, '0'), heure: Date.now(), texte: String(evt.texte).slice(0, 160) });
    sauverAlertes();
    diffuser({ genre: 'signalement', alerte: a.n });
  }
  const listerAlertes = () => alertes.liste.filter((a) => Date.now() - a.heure < 7 * 86400000).slice().reverse();

  return { canaux, creer, terminer, renvoyer, recu, lister, TYPES, envoyerAlerte, finAlerte, texteRecu, listerAlertes, GENRES };
}

module.exports = { creerSignalements, TYPES, CATEGORIES };
