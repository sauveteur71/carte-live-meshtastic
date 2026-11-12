'use strict';
// Équipes : un canal Meshtastic chiffré (nom + clé AES-256) par équipe, posé ou retiré à distance sur les nœuds
// des intervenants par le module de la carte (administration PKI, clé du module dans leurs clés d'administration).
//
// - La clé d'une équipe est chiffrée sur disque (AES-256-GCM) avec la clé maîtresse : variable CLE_EQUIPES du .env
//   si elle existe (conseillé : les équipes survivent alors à une restauration de sauvegarde), sinon un fichier
//   cle-equipes.bin créé au premier usage dans /data (jamais inclus dans les sauvegardes).
// - La clé n'est jamais renvoyée par la liste, ni écrite dans les tâches, les journaux ou l'historique ;
//   seul un administrateur peut l'exporter (fichier .cle ou lien de canal), et c'est inscrit dans l'historique.
// - Retirer un nœud d'une équipe n'efface la clé que s'il est joignable : pour un nœud perdu ou volé, changer la clé.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NOM_VALIDE = /^[A-Za-z0-9_+\-.]{1,11}$/;

function creerEquipes({ config, administration, journal, positionDe = () => null }) {
  const { racine } = require('./decodeur');
  try { racine.lookupType('meshtastic.ChannelSet'); } catch { racine.loadSync(['meshtastic/apponly.proto']); }
  const dossier = path.dirname(config.fichierBase);
  const fichier = path.join(dossier, 'equipes.json');
  const fichierMaitre = path.join(dossier, 'cle-equipes.bin');
  let liste = [];
  try { liste = JSON.parse(fs.readFileSync(fichier, 'utf8')).equipes || []; } catch { /* aucune */ }

  let maitre = null;
  function cleMaitre() {
    if (maitre) return maitre;
    const env = process.env.CLE_EQUIPES;
    if (env && env.trim()) maitre = crypto.createHash('sha256').update('carte-live-equipes:' + env.trim()).digest();
    else {
      try { maitre = fs.readFileSync(fichierMaitre); } catch { /* à créer */ }
      if (!maitre || maitre.length !== 32) {
        maitre = crypto.randomBytes(32);
        fs.writeFileSync(fichierMaitre, maitre, { mode: 0o600 });
        journal('[Équipes] clé maîtresse créée (cle-equipes.bin) : pensez à définir CLE_EQUIPES dans le .env pour pouvoir restaurer une sauvegarde');
      }
    }
    return maitre;
  }
  function chiffrer(psk) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', cleMaitre(), iv);
    const data = Buffer.concat([c.update(psk), c.final()]);
    return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  }
  function dechiffrer(e) {
    const d = crypto.createDecipheriv('aes-256-gcm', cleMaitre(), Buffer.from(e.iv, 'base64'));
    d.setAuthTag(Buffer.from(e.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]);
  }
  // Empreinte courte pour reconnaître une clé sans la montrer
  const empreinte = (psk) => crypto.createHash('sha256').update(psk).digest('hex').slice(0, 8).toUpperCase();

  let minuterie = null;
  function sauver(tout = false) {
    clearTimeout(minuterie);
    const ecrire = () => { try { fs.writeFileSync(fichier, JSON.stringify({ equipes: liste }), { mode: 0o600 }); } catch (e) { journal('[Équipes] enregistrement impossible :', e.message); } };
    if (tout) ecrire(); else minuterie = setTimeout(ecrire, 300);
  }
  const trouver = (id) => liste.find((e) => e.id === id);
  function exiger(id) { const e = trouver(id); if (!e) throw new Error('Équipe inconnue'); return e; }

  // Branché sur l'administration : la clé n'est lue qu'au moment d'écrire le canal sur le nœud
  administration.brancherEquipes({
    cle: (id) => {
      const e = trouver(id);
      if (!e) return null;
      return { nom: e.nom, psk: dechiffrer(e.cle), version: e.version, positions: !!e.positions };
    },
    noter: (id, num, r) => {
      const e = trouver(id);
      if (!e) return;
      const m = e.membres[num >>> 0];
      if (!m) return;
      m.dernier = { statut: r.statut, action: r.action, heure: Date.now(), detail: r.detail || null, index: r.index ?? null };
      if (r.statut === 'ok') {
        if (r.action === 'retirer') { if (m.etat === 'retrait') delete e.membres[num >>> 0]; }
        else { m.version = r.version; m.index = r.index; }
      }
      sauver();
    },
  });

  function vue(e) {
    let psk = null;
    try { psk = dechiffrer(e.cle); } catch { /* clé maîtresse changée */ }
    const membres = Object.entries(e.membres).map(([num, m]) => ({
      num: Number(num), etat: m.etat, depuis: m.depuis, index: m.index ?? null,
      aJour: m.etat === 'membre' && m.version === e.version, dernier: m.dernier || null,
      position: positionDe(Number(num)),
    }));
    // Sans nouvelle : position plus vieille que 3 fois l'intervalle de suivi (30 min au moins)
    const limite = e.suiviMin ? Math.max(30, 3 * e.suiviMin) * 60000 : 0;
    for (const m of membres) m.sansNouvelle = !!(limite && m.etat === 'membre' && (!m.position || Date.now() - m.position.heure > limite));
    return {
      id: e.id, nom: e.nom, description: e.description || '', positions: !!e.positions, version: e.version, suiviMin: e.suiviMin || 0, dernierSuivi: e.dernierSuivi || null,
      empreinte: psk ? empreinte(psk) : null, cleLisible: !!psk, creee: e.creee, auteur: e.auteur, cleChangee: e.cleChangee || null,
      membres, nbMembres: membres.filter((m) => m.etat === 'membre').length,
      aJour: membres.filter((m) => m.aJour).length,
    };
  }

  // Lance les tâches par paquets de 30 nœuds (limite de l'administration)
  function exigerModule() { if (!administration.infos().connecte) throw new Error('Module radio non connecté : reliez-le (Réseau › Modules) avant d’envoyer des canaux'); }
  function lancer(e, action, nums, auteur, insister) {
    const ids = [];
    for (let i = 0; i < nums.length; i += 30) {
      const t = administration.lancer('equipe', nums.slice(i, i + 30), { equipe: e.id, action, nom: e.nom }, auteur, { insister });
      ids.push(t.id);
    }
    return ids;
  }

  function creer({ nom, description, cle, positions }, auteur) {
    nom = String(nom || '').trim();
    if (!NOM_VALIDE.test(nom)) throw new Error('Nom du canal : 1 à 11 caractères, lettres sans accent, chiffres, - _ + .');
    if (liste.some((e) => e.nom.toLowerCase() === nom.toLowerCase())) throw new Error('Une équipe porte déjà ce nom de canal');
    let psk;
    if (cle) {
      psk = Buffer.from(String(cle).trim().replace(/^base64:/, '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      if (psk.length !== 32 && psk.length !== 16) throw new Error('Clé importée : 16 ou 32 octets en base64 (AES-128 ou AES-256)');
    } else psk = crypto.randomBytes(32);
    const e = {
      id: crypto.randomBytes(6).toString('hex'), nom, description: String(description || '').slice(0, 120), positions: !!positions,
      cle: chiffrer(psk), version: 1, creee: Date.now(), auteur, membres: {},
    };
    liste.push(e);
    sauver(true);
    journal(`[Équipes] équipe « ${nom} » créée par ${auteur} (clé ${empreinte(psk)})`);
    return vue(e);
  }

  function modifier(id, { description, positions, suiviMin }) {
    const e = exiger(id);
    if (suiviMin !== undefined) { const v = Number(suiviMin); if (![0, 5, 10, 15, 30, 60].includes(v)) throw new Error('Intervalle de suivi invalide'); e.suiviMin = v; }
    if (description != null) e.description = String(description).slice(0, 120);
    if (positions != null) e.positions = !!positions;
    sauver(true);
    return vue(e);
  }

  function membres(id, { ajouter = [], retirer = [], insister = true }, auteur) {
    const e = exiger(id);
    exigerModule();
    const norm = (l) => [...new Set((Array.isArray(l) ? l : []).map((x) => Number(x) >>> 0))].filter(Boolean);
    const aj = norm(ajouter), re = norm(retirer).filter((n) => !aj.includes(n));
    for (const n of aj) e.membres[n] = { ...(e.membres[n] || {}), etat: 'membre', depuis: (e.membres[n] && e.membres[n].etat === 'membre' && e.membres[n].depuis) || Date.now() };
    for (const n of re) if (e.membres[n]) e.membres[n].etat = 'retrait';
    sauver(true);
    const taches = [...(aj.length ? lancer(e, 'ajouter', aj, auteur, insister) : []), ...(re.length ? lancer(e, 'retirer', re, auteur, insister) : [])];
    journal(`[Équipes] « ${e.nom} » : ${aj.length} ajout(s), ${re.length} retrait(s) par ${auteur}`);
    return { equipe: vue(e), taches };
  }

  // Renvoie le canal aux membres pas à jour (ou en retrait non confirmé)
  function reappliquer(id, auteur) {
    const e = exiger(id);
    exigerModule();
    const aj = Object.entries(e.membres).filter(([, m]) => m.etat === 'membre' && m.version !== e.version).map(([n]) => Number(n));
    const re = Object.entries(e.membres).filter(([, m]) => m.etat === 'retrait').map(([n]) => Number(n));
    if (!aj.length && !re.length) throw new Error('Tous les nœuds de l’équipe sont à jour');
    return { equipe: vue(e), taches: [...(aj.length ? lancer(e, 'ajouter', aj, auteur, true) : []), ...(re.length ? lancer(e, 'retirer', re, auteur, true) : [])] };
  }

  // Nouvelle clé : la seule vraie révocation d'un nœud perdu. Les nœuds pas encore mis à jour ne
  // comprennent plus ceux qui le sont, jusqu'à ce qu'ils la reçoivent.
  function nouvelleCle(id, auteur) {
    const e = exiger(id);
    if (Object.values(e.membres).some((m) => m.etat === 'membre')) exigerModule();
    const psk = crypto.randomBytes(32);
    e.cle = chiffrer(psk); e.version += 1; e.cleChangee = Date.now();
    sauver(true);
    const nums = Object.entries(e.membres).filter(([, m]) => m.etat === 'membre').map(([n]) => Number(n));
    journal(`[Équipes] nouvelle clé pour « ${e.nom} » par ${auteur} (${empreinte(psk)}), envoi à ${nums.length} nœud(s)`);
    return { equipe: vue(e), taches: nums.length ? lancer(e, 'ajouter', nums, auteur, true) : [] };
  }

  function supprimer(id, { retirerDesNoeuds = true } = {}, auteur) {
    const e = exiger(id);
    const nums = Object.keys(e.membres).map(Number);
    if (retirerDesNoeuds && nums.length) exigerModule();
    liste = liste.filter((x) => x !== e);
    sauver(true);
    journal(`[Équipes] équipe « ${e.nom} » supprimée par ${auteur}${retirerDesNoeuds && nums.length ? `, canal retiré de ${nums.length} nœud(s)` : ''}`);
    return { taches: retirerDesNoeuds && nums.length ? lancer(e, 'retirer', nums, auteur, true) : [] };
  }

  // Export de la clé (administrateur) : base64 pour la ligne de commande, lien de canal pour l'appli
  function exporter(id) {
    const e = exiger(id);
    const psk = dechiffrer(e.cle);
    const ChannelSet = racine.lookupType('meshtastic.ChannelSet');
    const cs = ChannelSet.encode(ChannelSet.create({ settings: [{ name: e.nom, psk, moduleSettings: { positionPrecision: e.positions ? 32 : 0 } }] })).finish();
    const b64url = Buffer.from(cs).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return { nom: e.nom, cle: psk.toString('base64'), empreinte: empreinte(psk), url: `https://meshtastic.org/e/?add=true#${b64url}` };
  }

  // Suivi : demande de position aux membres à intervalle régulier (3 s entre deux nœuds), module relié
  const minutSuivi = setInterval(() => {
    try {
      if (!administration.infos().connecte) return;
      const t = Date.now();
      for (const e of liste) {
        if (!e.suiviMin || t - (e.dernierSuivi || 0) < e.suiviMin * 60000) continue;
        const nums = Object.entries(e.membres).filter(([, m]) => m.etat === 'membre').map(([n]) => Number(n));
        e.dernierSuivi = t; sauver();
        nums.forEach((n, i) => setTimeout(() => { try { administration.demanderPosition(n, 'suivi ' + e.nom); } catch { /* module coupé */ } }, i * 3000));
      }
    } catch (x) { journal('[Équipes] suivi :', x.message); }
  }, 60000);
  minutSuivi.unref();
  // Alertes : membre sans nouvelle
  function alertes(nomDe = () => null) {
    const l = [];
    for (const e of liste.map(vue)) for (const m of e.membres) if (m.sansNouvelle) l.push({ cle: `equipe:${e.id}:${m.num}`, type: 'equipe', niveau: 'attention', noeud: m.num, depuis: m.position ? m.position.heure : Date.now(), message: `Équipe ${e.nom} : ${nomDe(m.num) || '!' + m.num.toString(16)} sans position depuis ${m.position ? Math.round((Date.now() - m.position.heure) / 60000) + ' min' : 'le début du suivi'}` });
    return l;
  }
  return {
    alertes,
    liste: () => liste.map(vue),
    equipe: (id) => vue(exiger(id)),
    creer, modifier, membres, reappliquer, nouvelleCle, supprimer, exporter,
    sourceCle: () => (process.env.CLE_EQUIPES && process.env.CLE_EQUIPES.trim() ? 'env' : 'fichier'),
  };
}

module.exports = { creerEquipes };
