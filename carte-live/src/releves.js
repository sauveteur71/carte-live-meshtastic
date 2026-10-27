'use strict';
// Relevés de terrain (mode terrain) : position GPS, type, note, mesure radio facultative et photo compressée.
// Saisis sur le téléphone, même hors connexion (file d'attente locale), puis envoyés ici quand le réseau revient.
// Stockage : /data/releves/releves.json + une photo JPEG par relevé.

const fs = require('fs');
const path = require('path');

const TYPES = { site: 'Site relais possible', point_haut: 'Point haut', test: 'Test de couverture', probleme: 'Problème / panne', installation: 'Installation réalisée', autre: 'Autre' };
const MAX_RELEVES = 5000;

function creerReleves(dossierDonnees, journal = () => {}) {
  const dossier = path.join(dossierDonnees, 'releves');
  const fichier = path.join(dossier, 'releves.json');
  try { fs.mkdirSync(dossier, { recursive: true }); } catch { /* lecture seule */ }
  let liste = [];
  try { liste = JSON.parse(fs.readFileSync(fichier, 'utf8')); } catch { /* aucun */ }
  const ecrire = () => { const tmp = fichier + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(liste)); fs.renameSync(tmp, fichier); };
  const num = (v, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
  const fichierPhoto = (id) => path.join(dossier, id + '.jpg');

  function ajouter(b, auteur) {
    const id = String(b.id || '').toLowerCase();
    if (!/^[0-9a-z-]{8,40}$/.test(id)) throw new Error('Identifiant de relevé invalide');
    const existant = liste.find((r) => r.id === id);
    if (existant) return existant; // renvoi après une coupure : déjà reçu
    const lat = num(b.lat, -90, 90), lon = num(b.lon, -180, 180);
    if (lat == null || lon == null) throw new Error('Position GPS manquante');
    const r = {
      id, lat, lon,
      alt: num(b.alt, -500, 9000), precision: num(b.precision, 0, 100000),
      type: TYPES[b.type] ? b.type : 'autre',
      note: String(b.note || '').slice(0, 2000),
      noeud: String(b.noeud || '').slice(0, 60) || null,
      snr: num(b.snr, -40, 30), rssi: num(b.rssi, -150, 0),
      heure: num(b.heure, 1.5e12, Date.now() + 86400000) || Date.now(),
      recu: Date.now(), auteur, photo: false,
    };
    if (b.photo) {
      const m = String(b.photo).match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
      if (!m) throw new Error('Photo : JPEG attendu');
      const buf = Buffer.from(m[1], 'base64');
      if (buf.length > 3 * 1024 * 1024) throw new Error('Photo trop lourde (3 Mo maximum)');
      if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('Photo : fichier JPEG invalide');
      fs.writeFileSync(fichierPhoto(id), buf);
      r.photo = true;
    }
    liste.push(r);
    while (liste.length > MAX_RELEVES) { const v = liste.shift(); try { fs.unlinkSync(fichierPhoto(v.id)); } catch { /* sans photo */ } }
    ecrire();
    journal(`Relevé de terrain « ${TYPES[r.type]} » ajouté par ${auteur}`);
    return r;
  }

  return {
    TYPES,
    ajouter,
    liste: () => liste,
    photo: (id) => { const r = liste.find((x) => x.id === String(id)); return r && r.photo ? fichierPhoto(r.id) : null; },
    retirer(id, compte) {
      const i = liste.findIndex((x) => x.id === String(id));
      if (i < 0) throw new Error('Relevé inconnu');
      if (compte.role !== 'admin' && liste[i].auteur !== (compte.indicatif || compte.identifiant)) throw new Error('Seul l’auteur ou un administrateur peut supprimer ce relevé');
      const [r] = liste.splice(i, 1);
      try { fs.unlinkSync(fichierPhoto(r.id)); } catch { /* sans photo */ }
      ecrire();
    },
  };
}

module.exports = { creerReleves };
