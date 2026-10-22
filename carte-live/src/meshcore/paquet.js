'use strict';
// Décodage des paquets MeshCore (format v1, firmware ≥ 1.12) : en-tête, codes de transport, chemin, charge utile.
// Références : docs/packet_format.md et docs/payloads.md du dépôt meshcore-dev/MeshCore (MIT).
//
// [en-tête 1][codes transport 4, facultatif][longueur chemin 1][chemin][charge utile]
// En-tête 0bVVPPPPRR : V = version de charge, P = type de charge, R = type de routage.

const crypto = require('crypto');

const ROUTES = ['TRANSPORT_FLOOD', 'FLOOD', 'DIRECT', 'TRANSPORT_DIRECT'];
const ROUTES_FR = { TRANSPORT_FLOOD: 'Inondation (zone)', FLOOD: 'Inondation', DIRECT: 'Direct', TRANSPORT_DIRECT: 'Direct (zone)' };
const TYPES = ['REQ', 'RESPONSE', 'TXT_MSG', 'ACK', 'ADVERT', 'GRP_TXT', 'GRP_DATA', 'ANON_REQ', 'PATH', 'TRACE', 'MULTIPART', 'CONTROL', 'RES_C', 'RES_D', 'RES_E', 'RAW_CUSTOM'];
// Clé courte utilisée par l'interface (filtres, couleurs)
const CLES = { REQ: 'requete', RESPONSE: 'reponse', TXT_MSG: 'message', ACK: 'ack', ADVERT: 'annonce', GRP_TXT: 'canal', GRP_DATA: 'donnees', ANON_REQ: 'connexion', PATH: 'chemin', TRACE: 'trace', MULTIPART: 'multipart', CONTROL: 'controle', RAW_CUSTOM: 'perso' };
const TYPES_FR = {
  REQ: 'Requête', RESPONSE: 'Réponse', TXT_MSG: 'Message direct', ACK: 'Accusé de réception', ADVERT: 'Annonce',
  GRP_TXT: 'Message de canal', GRP_DATA: 'Données de canal', ANON_REQ: 'Connexion / requête anonyme', PATH: 'Chemin retourné',
  TRACE: 'Trace', MULTIPART: 'Multi-parties', CONTROL: 'Contrôle', RAW_CUSTOM: 'Personnalisé',
};
// Type annoncé (4 bits de poids faible des drapeaux d'annonce)
const ROLES = { 0: 'inconnu', 1: 'companion', 2: 'repeteur', 3: 'salon', 4: 'capteur' };
const ROLES_FR = { inconnu: 'Inconnu', companion: 'Companion', repeteur: 'Répéteur', salon: 'Room server', capteur: 'Capteur' };
const SOUS_TYPES_TEXTE = { 0: 'texte', 1: 'commande CLI', 2: 'texte signé', 3: 'commande CLI' };

const hex = (b) => Buffer.from(b).toString('hex').toUpperCase();

// Canal de groupe : secret de 16 octets ; hachage = 1er octet de SHA-256(secret).
// « Public » a un secret connu ; un canal « #nom » a pour secret les 16 premiers octets de SHA-256("#nom").
const SECRET_PUBLIC = '8b3387e9c5cdea6ac9e5edbaa115cd72';
function preparerCanauxMc(liste) {
  const canaux = [];
  for (const brut of liste || []) {
    let nom = String(brut.nom || brut).trim();
    let secret = brut.secret ? String(brut.secret).trim() : null;
    if (typeof brut === 'string' && brut.indexOf('=') > 0) { secret = brut.slice(brut.indexOf('=') + 1).trim(); nom = brut.slice(0, brut.indexOf('=')).trim(); }
    if (!nom) continue;
    if (!secret) {
      if (/^public$/i.test(nom)) secret = SECRET_PUBLIC;
      else if (nom.startsWith('#')) secret = crypto.createHash('sha256').update(nom.toLowerCase()).digest().subarray(0, 16).toString('hex');
      else continue;
    }
    if (/^[A-Za-z0-9+/=]{22,24}$/.test(secret) && !/^[0-9a-f]{32}$/i.test(secret)) secret = Buffer.from(secret, 'base64').toString('hex');
    if (!/^[0-9a-f]{32}$/i.test(secret)) continue;
    const cle = Buffer.from(secret, 'hex');
    canaux.push({ nom, secret: secret.toLowerCase(), cle, hachage: crypto.createHash('sha256').update(cle).digest()[0] });
  }
  return canaux;
}

// Message de canal : MAC = 2 premiers octets de HMAC-SHA256(secret ‖ 16 zéros, chiffré) ; AES-128-ECB sans bourrage.
function dechiffrerCanal(charge, canaux) {
  if (charge.length < 3 + 16) return null;
  const h = charge[0], mac = charge.subarray(1, 3), chiffre = charge.subarray(3);
  if (chiffre.length % 16) return null;
  for (const c of canaux) {
    if (c.hachage !== h) continue;
    const secret32 = Buffer.concat([c.cle, Buffer.alloc(16)]);
    const calc = crypto.createHmac('sha256', secret32).update(chiffre).digest();
    if (calc[0] !== mac[0] || calc[1] !== mac[1]) continue;
    const d = crypto.createDecipheriv('aes-128-ecb', c.cle, null);
    d.setAutoPadding(false);
    const clair = Buffer.concat([d.update(chiffre), d.final()]);
    const horodatage = clair.readUInt32LE(0);
    const drapeaux = clair[4];
    let texte = clair.subarray(5).toString('utf8');
    const z = texte.indexOf('\0');
    if (z >= 0) texte = texte.slice(0, z);
    let expediteur = null;
    const i = texte.indexOf(': ');
    if (i > 0 && i < 50 && !/[:[\]]/.test(texte.slice(0, i))) { expediteur = texte.slice(0, i); texte = texte.slice(i + 2); }
    return { canal: c.nom, horodatage, sousType: drapeaux >> 2, expediteur, texte };
  }
  return null;
}

// Hachage du paquet (identique au firmware) : SHA-256(type [+ longueur du chemin pour TRACE] + charge), 8 premiers octets
function hachagePaquet(type, octetChemin, charge) {
  const h = crypto.createHash('sha256');
  h.update(Buffer.from([type]));
  if (type === 9) h.update(Buffer.from([octetChemin]));
  h.update(charge);
  return h.digest().subarray(0, 8).toString('hex').toUpperCase();
}

function decoderAnnonce(c) {
  if (c.length < 32 + 4 + 64) return { erreur: 'annonce trop courte' };
  const r = { cle: hex(c.subarray(0, 32)), horodatage: c.readUInt32LE(32), signature: hex(c.subarray(36, 100)) };
  let i = 100;
  if (i < c.length) {
    const f = c[i++];
    r.drapeaux = f;
    r.role = ROLES[f & 0x0f] || 'inconnu';
    if (f & 0x10 && i + 8 <= c.length) {
      const lat = c.readInt32LE(i) / 1e6, lon = c.readInt32LE(i + 4) / 1e6;
      i += 8;
      if (Math.abs(lat) > 0.0001 || Math.abs(lon) > 0.0001) { r.lat = lat; r.lon = lon; }
    }
    if (f & 0x20) i += 2;
    if (f & 0x40) i += 2;
    if (f & 0x80 && i < c.length) r.nom = c.subarray(i).toString('utf8').replace(/\0.*$/s, '').trim();
  }
  return r;
}

/**
 * Décode un paquet brut. canaux : liste préparée par preparerCanauxMc (pour les messages de canal).
 * Renvoie { valide, erreur?, route, type, version, cle (courte), transport, octetsHachage, chemin[], charge, hachage, contenu }.
 */
function decoderPaquet(brut, canaux = []) {
  const b = Buffer.isBuffer(brut) ? brut : Buffer.from(String(brut).replace(/\s+/g, ''), 'hex');
  if (b.length < 2) return { valide: false, erreur: 'paquet trop court', taille: b.length };
  const entete = b[0];
  const routeN = entete & 0x03, typeN = (entete >> 2) & 0x0f, version = (entete >> 6) + 1;
  const route = ROUTES[routeN], type = TYPES[typeN];
  let i = 1;
  let transport = null;
  if (routeN === 0 || routeN === 3) {
    if (b.length < 5 + 1) return { valide: false, erreur: 'codes de transport tronqués', taille: b.length };
    transport = [b.readUInt16LE(1), b.readUInt16LE(3)];
    i = 5;
  }
  const octetChemin = b[i++];
  const nbSauts = octetChemin & 0x3f, codeTaille = octetChemin >> 6;
  if (codeTaille === 3) return { valide: false, erreur: 'taille de hachage réservée', taille: b.length };
  const tailleHachage = codeTaille + 1;
  // TRACE : le champ chemin contient les SNR mesurés à chaque saut (1 octet chacun), pas des hachages
  const octetsChemin = type === 'TRACE' ? nbSauts : nbSauts * tailleHachage;
  if (i + octetsChemin > b.length) return { valide: false, erreur: 'chemin tronqué', taille: b.length };
  const cheminBrut = b.subarray(i, i + octetsChemin);
  i += octetsChemin;
  const charge = b.subarray(i);
  const p = {
    valide: true, taille: b.length, entete, route, routeFr: ROUTES_FR[route], type, typeFr: TYPES_FR[type] || type, cleType: CLES[type] || 'autre', version,
    transport, octetChemin, tailleHachage, chemin: [], charge: hex(charge), tailleCharge: charge.length,
    hachage: hachagePaquet(typeN, octetChemin, charge), contenu: {},
  };
  if (type === 'TRACE') {
    p.snrChemin = [...cheminBrut].map((x) => (x > 127 ? x - 256 : x) / 4);
  } else {
    for (let k = 0; k < nbSauts; k++) p.chemin.push(hex(cheminBrut.subarray(k * tailleHachage, (k + 1) * tailleHachage)));
  }

  try {
    switch (type) {
      case 'ADVERT': p.contenu = decoderAnnonce(charge); break;
      case 'GRP_TXT':
      case 'GRP_DATA': {
        p.contenu = { hachageCanal: charge.length ? hex(charge.subarray(0, 1)) : null };
        if (type === 'GRP_TXT') {
          const d = dechiffrerCanal(charge, canaux);
          if (d) Object.assign(p.contenu, d, { dechiffre: true });
          else p.contenu.dechiffre = false;
        }
        break;
      }
      case 'TXT_MSG': case 'REQ': case 'RESPONSE': case 'PATH':
        if (charge.length >= 4) p.contenu = { vers: hex(charge.subarray(0, 1)), de: hex(charge.subarray(1, 2)), chiffre: true };
        break;
      case 'ANON_REQ':
        if (charge.length >= 35) p.contenu = { vers: hex(charge.subarray(0, 1)), cleExpediteur: hex(charge.subarray(1, 33)), chiffre: true };
        break;
      case 'ACK':
        if (charge.length >= 4) p.contenu = { controle: hex(charge.subarray(0, 4)) };
        break;
      case 'TRACE':
        if (charge.length >= 9) {
          const f = charge[8], t = (f & 0x03) + 1, route = [];
          for (let k = 9; k + t <= charge.length; k += t) route.push(hex(charge.subarray(k, k + t)));
          p.contenu = { etiquette: charge.readUInt32LE(0).toString(16).toUpperCase().padStart(8, '0'), auth: charge.readUInt32LE(4), drapeaux: f, route };
        }
        break;
      case 'CONTROL':
        if (charge.length >= 1) p.contenu = { sousType: charge[0] >> 4, donnees: hex(charge.subarray(1)) };
        break;
      default: break;
    }
  } catch (e) { p.contenu = { erreur: e.message }; }
  return p;
}

// Résumé lisible d'un paquet décodé (une ligne)
function resumer(p) {
  const c = p.contenu || {};
  switch (p.type) {
    case 'ADVERT': return `Annonce ${ROLES_FR[c.role] || ''} « ${c.nom || '?'} »${c.lat != null ? ' (position)' : ''}`;
    case 'GRP_TXT': return c.dechiffre ? `Canal ${c.canal}${c.expediteur ? ' · ' + c.expediteur : ''}` : `Canal chiffré (hachage ${c.hachageCanal})`;
    case 'TXT_MSG': return `Message ${c.de || '?'} → ${c.vers || '?'}`;
    case 'REQ': return `Requête ${c.de || '?'} → ${c.vers || '?'}`;
    case 'RESPONSE': return `Réponse ${c.de || '?'} → ${c.vers || '?'}`;
    case 'PATH': return `Chemin retourné ${c.de || '?'} → ${c.vers || '?'}`;
    case 'ANON_REQ': return `Connexion vers ${c.vers || '?'}`;
    case 'TRACE': return `Trace ${c.route ? c.route.join(' › ') : ''}`;
    case 'ACK': return 'Accusé de réception';
    default: return p.typeFr || p.type;
  }
}

module.exports = { decoderPaquet, preparerCanauxMc, dechiffrerCanal, resumer, SECRET_PUBLIC, ROLES, ROLES_FR, TYPES, TYPES_FR, CLES, ROUTES_FR, SOUS_TYPES_TEXTE };
