'use strict';
// Jeux de canaux : la liste des canaux Meshtastic qu'une communauté (la carte entière, ou une ADRASEC) demande à
// ses membres d'avoir sur leur radio. Un membre qui relie sa radio à la carte depuis son navigateur (passerelle)
// les écrit en un clic, en choisissant au besoin les canaux à libérer (8 emplacements au plus, le 0 n'est jamais touché).
//
// - Portées : « carte » (réglée par un administrateur, proposée à tous les membres) et « adrasec:43 » (réglée par le
//   président ou un responsable de l'ADRASEC, proposée à ses seuls membres).
// - Les clés sont chiffrées sur disque avec la clé maîtresse des équipes (CLE_EQUIPES ou cle-equipes.bin). Elles ne
//   sont jamais renvoyées à une page : seule une empreinte courte est montrée à ceux qui règlent le jeu, et la clé
//   n'est lue qu'au moment de l'écrire sur la radio de l'intéressé.
const path = require('path');
const crypto = require('crypto');
const { ecrireSur, lireJson } = require('./fichiers');

const NOM_VALIDE = /^[A-Za-z0-9_+\-.]{1,11}$/;
const MAX_CANAUX = 7;
const PSK_PUBLIQUE = Buffer.from([1]); // clé par défaut « AQ== » : lisible par tous

function creerJeuxCanaux({ config, chiffreur, journal = () => {} }) {
  const fichier = path.join(path.dirname(config.fichierBase), 'jeux-canaux.json');
  let jeux = {};
  try { jeux = lireJson(fichier).jeux || {}; } catch { /* aucun */ }
  const sauver = () => { try { ecrireSur(fichier, JSON.stringify({ jeux }), { mode: 0o600 }); } catch (e) { journal('[Jeux de canaux] enregistrement impossible :', e.message); } };
  const porteeValide = (p) => p === 'carte' || /^adrasec:[0-9A-Z]{1,3}$/.test(p);
  const genre = (c) => (c.cle ? 'prive' : 'public');

  function vue(portee, gestion = false) {
    const j = jeux[portee] || { canaux: [] };
    return {
      portee, maj: j.maj || null, auteur: gestion ? j.auteur || null : undefined,
      canaux: j.canaux.map((c) => ({ id: c.id, nom: c.nom, chiffrement: genre(c), positions: !!c.positions, empreinte: gestion && c.cle ? chiffreur.empreinte(chiffreur.dechiffrer(c.cle)) : undefined })),
    };
  }
  // liste : [{ id?, nom, cle, positions }] ; cle : '' = garder celle du canal existant (même id), 'publique',
  // 'aleatoire' (AES-256 tirée au hasard) ou une clé en base64 de 16 ou 32 octets
  function definir(portee, liste, auteur) {
    if (!porteeValide(portee)) throw new Error('Jeu de canaux inconnu');
    if (!Array.isArray(liste)) throw new Error('Liste de canaux attendue');
    if (liste.length > MAX_CANAUX) throw new Error(`${MAX_CANAUX} canaux au plus (le canal 0 de la radio n’est jamais touché)`);
    const avant = new Map(((jeux[portee] || {}).canaux || []).map((c) => [c.id, c]));
    const noms = new Set();
    const canaux = liste.map((x) => {
      const nom = String(x.nom || '').trim();
      if (!NOM_VALIDE.test(nom)) throw new Error(`Nom de canal « ${nom} » invalide : 1 à 11 caractères (lettres sans accent, chiffres, _ + - .)`);
      if (noms.has(nom.toLowerCase())) throw new Error(`Canal « ${nom} » en double`);
      noms.add(nom.toLowerCase());
      const ancien = x.id ? avant.get(String(x.id)) : null;
      const k = String(x.cle == null ? '' : x.cle).trim();
      let cle;
      if (!k) { if (!ancien) throw new Error(`Clé du canal « ${nom} » manquante`); cle = ancien.cle; }
      else if (k === 'publique') cle = null;
      else if (k === 'aleatoire') cle = chiffreur.chiffrer(crypto.randomBytes(32));
      else {
        const b = Buffer.from(k.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        if (b.length === 1 && b[0] === 1) cle = null;
        else if (b.length === 16 || b.length === 32) cle = chiffreur.chiffrer(b);
        else throw new Error(`Clé du canal « ${nom} » invalide : 16 ou 32 octets en base64 (AES-128 ou AES-256)`);
      }
      return { id: ancien ? ancien.id : crypto.randomBytes(6).toString('hex'), nom, cle, positions: !!x.positions };
    });
    jeux[portee] = { canaux, maj: Date.now(), auteur: auteur || null };
    sauver();
    journal(`[Jeux de canaux] ${portee} : ${canaux.map((c) => c.nom).join(', ') || 'vide'} (${auteur || '?'})`);
    return vue(portee, true);
  }
  // Clé en clair, pour l'écrire sur une radio (jamais renvoyée à une page)
  function canal(portee, id) {
    const c = ((jeux[portee] || {}).canaux || []).find((x) => x.id === String(id));
    if (!c) return null;
    return { nom: c.nom, psk: c.cle ? chiffreur.dechiffrer(c.cle) : PSK_PUBLIQUE, positions: !!c.positions, chiffrement: genre(c) };
  }
  return { vue, definir, canal, porteeValide };
}

// Place des canaux voulus sur une radio : canaux actuels (avec clés, côté serveur), canaux à ajouter, emplacements que
// l'utilisateur accepte de libérer. Les canaux gardés restent groupés à partir de 1 (comme « meshtastic --ch-del »).
// Renvoie { ops, final, deja, manque } ; ops ne contient que les emplacements qui changent.
function planifier(actuels, ajouts, liberer = []) {
  const egal = (a, b) => Buffer.compare(a, b) === 0;
  const psk = (c) => Buffer.from(c.cle || '', 'base64');
  const lib = new Set(liberer.map(Number));
  const gardes = [], deja = [];
  for (let i = 1; i < 8; i++) {
    const c = actuels[i];
    if (!c || c.role === 'DISABLED') continue;
    const meme = ajouts.find((a) => a.nom === c.nom);
    if (meme && egal(psk(c), meme.psk)) { deja.push(meme.nom); gardes.push({ nom: c.nom, psk: psk(c), depuis: i, brut: c }); continue; }
    if (meme) continue; // même nom, autre clé : remplacé par le canal du jeu
    if (lib.has(i)) continue;
    gardes.push({ nom: c.nom, psk: psk(c), depuis: i, brut: c });
  }
  const nouveaux = ajouts.filter((a) => !deja.includes(a.nom));
  const final = [...gardes, ...nouveaux.map((a) => ({ nom: a.nom, psk: a.psk, positions: a.positions }))];
  const manque = Math.max(0, final.length - 7);
  if (manque) return { ops: [], final, deja, manque };
  const ops = [];
  for (let i = 1; i < 8; i++) {
    const v = final[i - 1], c = actuels[i];
    const occupe = c && c.role !== 'DISABLED';
    if (!v) { if (occupe) ops.push({ index: i, supprimer: true }); continue; }
    if (occupe && v.depuis === i) continue; // inchangé
    // canal gardé déplacé : recopié tel quel (précision de position, MQTT montant / descendant)
    if (v.brut) ops.push({ index: i, nom: v.nom, psk: v.psk, precision: v.brut.precision || 0, montant: !!v.brut.montant, descendant: !!v.brut.descendant });
    else ops.push({ index: i, nom: v.nom, psk: v.psk, positions: !!v.positions });
  }
  return { ops, final, deja, manque: 0 };
}

module.exports = { creerJeuxCanaux, planifier, NOM_VALIDE };
