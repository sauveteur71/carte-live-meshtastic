'use strict';
// Page publique « Rejoindre le réseau » (/rejoindre), sur le modèle de Mesh Hessen : QR du canal, réglages conseillés,
// rôles recommandés, limite de sauts, règles, antennes testées, relais communautaires, contact et dons.
// Le contenu est saisi par l'administrateur et gardé dans adhesion.json (volume de données).
// Le lien de canal publié contient la clé du canal : c'est voulu (la page sert à le partager), l'administrateur le choisit.

const path = require('path');
const QRCode = require('qrcode');
const { ecrireSur, lireJson } = require('./fichiers');

const REGION_DEFAUT = 'EU_868'; // région LoRa quand le module de la carte ne l'a pas encore donnée
const ROLES_DEFAUT = [
  'CLIENT : nœud portable ou fixe chez vous (le bon choix dans presque tous les cas)',
  'CLIENT_MUTE : nœud qui entend déjà bien un relais (il ne relaie pas, le réseau reste fluide)',
  'ROUTER : seulement aux points hauts, après accord de l’équipe du réseau',
].join('\n');
const REGLES_DEFAUT = [
  'Gardez la limite de sauts conseillée : plus de sauts encombre le canal pour tout le monde',
  'Pas de ROUTER ni de REPEATER sans accord : un relais mal placé dégrade le réseau',
  'Position : arrondie si vous le souhaitez, mais utile pour voir la couverture',
  'Messages courts sur le canal public ; les essais se font en message direct',
].join('\n');

const CHAMPS = {
  actif: 'bool', presentation: 2000, lienCanal: 3000, limiteSauts: 'int', roles: 3000, regles: 4000, antennes: 3000,
  mcFrequence: 40, mcBande: 40, mcSf: 10, mcCr: 10, contact: 1000, donsLien: 500, donsTexte: 1000, montrerRelais: 'bool',
};

function creerAdhesion({ config, db, reseauMc, presetDuReseau, journal = () => {} }) {
  const dossier = path.dirname(config.fichierBase);
  const fichier = path.join(dossier, 'adhesion.json');
  const defaut = () => ({ actif: false, presentation: '', lienCanal: '', limiteSauts: 3, roles: ROLES_DEFAUT, regles: REGLES_DEFAUT, antennes: '', mcFrequence: '', mcBande: '', mcSf: '', mcCr: '', contact: '', donsLien: '', donsTexte: '', montrerRelais: true });
  let r = defaut();
  try { r = { ...r, ...lireJson(fichier) }; } catch { /* premier lancement */ }

  const lienValide = (u) => !u || /^https:\/\/meshtastic\.org\/e\/#[A-Za-z0-9_-]+$/.test(u);
  const urlValide = (u) => !u || /^https?:\/\/[^\s"'<>]+$/.test(u);

  function enregistrer(b) {
    const n = { ...r };
    for (const [k, t] of Object.entries(CHAMPS)) {
      if (!(k in b)) continue;
      if (t === 'bool') n[k] = !!b[k];
      else if (t === 'int') n[k] = Math.min(7, Math.max(1, Math.round(Number(b[k]) || 3)));
      else n[k] = String(b[k] ?? '').slice(0, t).trim();
    }
    n.lienCanal = n.lienCanal.replace(/\s+/g, '');
    if (!lienValide(n.lienCanal)) throw new Error('Lien de canal attendu : https://meshtastic.org/e/#… (copié depuis l’appli Meshtastic ou la carte)');
    if (!urlValide(n.donsLien)) throw new Error('Lien des dons : adresse web attendue (https://…)');
    r = n;
    ecrireSur(fichier, JSON.stringify(r, null, 1), { mode: 0o600 });
    journal('Page « Rejoindre le réseau » mise à jour', r.actif ? '(publiée)' : '(masquée)');
    return r;
  }

  // Région LoRa et canal principal du module de la carte, quand ils sont connus
  function moduleCarte() {
    try { return lireJson(path.join(dossier, 'config-module.json')); } catch { return null; }
  }

  function relais() {
    if (!r.montrerRelais) return [];
    const z = config.zone;
    const depuis = Date.now() - 7 * 86400e3;
    const l = [];
    try {
      for (const n of db.prepare(`SELECT nom_long, nom_court, id, role FROM noeuds WHERE role IN ('ROUTER','ROUTER_LATE','REPEATER') AND dernier_vu >= ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? ORDER BY nom_long`).all(depuis, z[0], z[2], z[1], z[3])) {
        l.push({ reseau: 'Meshtastic', nom: n.nom_long || n.nom_court || n.id, role: n.role });
      }
    } catch { /* base vide */ }
    try {
      for (const n of (reseauMc ? reseauMc.surveilles() : [])) {
        if (n.dernierVu && n.dernierVu < depuis) continue;
        l.push({ reseau: 'MeshCore', nom: n.nom || n.cle.slice(0, 8), role: n.role === 'salon' ? 'room server' : 'repeater' });
      }
    } catch { /* MeshCore absent */ }
    return l.slice(0, 300);
  }

  async function publique(adressePage) {
    if (!r.actif) return null;
    const qr = (u) => QRCode.toString(u, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#0b1d26', light: '#ffffff' } });
    const m = moduleCarte();
    const region = m && m.lora && m.lora.region ? String(m.lora.region) : REGION_DEFAUT;
    return {
      titre: config.carte.titre,
      presentation: r.presentation, lienCanal: r.lienCanal, qrCanal: r.lienCanal ? await qr(r.lienCanal) : null,
      preset: presetDuReseau(), region, limiteSauts: r.limiteSauts,
      roles: r.roles, regles: r.regles, antennes: r.antennes,
      meshcore: (r.mcFrequence || r.mcBande || r.mcSf || r.mcCr) ? { frequence: r.mcFrequence, bande: r.mcBande, sf: r.mcSf, cr: r.mcCr } : null,
      relais: relais(), contact: r.contact, donsLien: r.donsLien, donsTexte: r.donsTexte,
      adressePage, qrPage: adressePage ? await qr(adressePage) : null,
    };
  }

  return { lire: () => ({ ...r }), enregistrer, publique, actif: () => !!r.actif, moduleCarte };
}

module.exports = { creerAdhesion };
