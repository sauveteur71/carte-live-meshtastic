'use strict';
// Résumé lisible des opérations de programmation (Gérer › Programmer › Opérations récentes).
// But : retrouver dans l'historique CE QUI A ÉTÉ ENVOYÉ au relais — réglage par réglage, en français,
// avec les unités, et la valeur d'avant quand elle est vraiment connue. C'est la trace de ce qui a été
// fait sur le matériel : elle doit se lire sans connaître les noms de champs du firmware.
//
// SÉCURITÉ : aucun secret ne sort d'ici. Les paramètres d'une opération peuvent contenir une clé de canal,
// une clé d'administration ou un mot de passe ; le résumé part vers le navigateur et s'affiche à l'écran.
// Seuls les réglages connus de la table CHAMPS sont mis en forme ; tout champ inconnu dont le nom évoque
// un secret, ou dont la valeur ressemble à une clé en base64, devient « (masqué) ».

const { ROLES_FR } = require('./reseau');

// ---- Champs dont la valeur ne doit JAMAIS être affichée -------------------------------------------
const SECRET = /psk|cl[eé]|key|pass|secret|jeton|token|mdp|priv|credential|auth|salt|hash|\botp\b|\bpin\b/i;
const CLE_B64 = /^[A-Za-z0-9+/]{16,}={0,2}$/;
const MASQUE = '(masqué)';
const ressembleCle = (v) => typeof v === 'string' && v.length >= 16 && CLE_B64.test(v);
// Contrôle d'un réglage inconnu : son nom évoque un secret, ou sa valeur ressemble à une clé en base64
const sensible = (nom, v) => SECRET.test(String(nom)) || ressembleCle(v);

// ---- Mise en forme des valeurs --------------------------------------------------------------------
// Durée lisible : 3600 s se lit « 1 h », 240 s « 4 min ». 0 = valeur par défaut du firmware.
function duree(s) {
  const n = Number(s);
  if (!Number.isFinite(n)) return String(s);
  if (n === 0) return 'défaut';
  // Jours seulement au-delà de 24 h : le formulaire propose « 24 h », l'historique doit lire pareil (7 jours = « 7 j »)
  if (n % 86400 === 0 && n >= 2 * 86400) return `${n / 86400} j`;
  if (n % 3600 === 0) return `${n / 3600} h`;
  if (n % 60 === 0) return `${n / 60} min`;
  if (n > 3600) return `${Math.round(n / 360) / 10} h`;
  if (n > 90) return `${Math.round(n / 6) / 10} min`;
  return `${n} s`;
}
const toutesLes = (s) => (Number(s) === 0 ? 'défaut' : `toutes les ${duree(s)}`);
const ouiNon = (x) => (x ? 'oui' : 'non');
// Précision de position d'un canal : mêmes paliers que le formulaire des canaux
const PRECISIONS = { 32: 'précise', 19: '≈ 45 m', 18: '≈ 91 m', 17: '≈ 182 m', 16: '≈ 364 m', 15: '≈ 729 m', 14: '≈ 1,5 km', 13: '≈ 2,9 km', 0: 'pas de position' };
const precisionTexte = (b) => PRECISIONS[Number(b) || 0] || `${Number(b) || 0} bits`;
const SIGNATURES_FR = {
  PACKET_SIGNATURE_POLICY_COMPATIBLE: 'Compatible (accepte les nœuds 2.7)',
  PACKET_SIGNATURE_POLICY_BALANCED: 'Équilibrée',
  PACKET_SIGNATURE_POLICY_STRICT: 'Stricte (signés seulement)',
};
// Ancienneté d'une lecture : « il y a 20 min », « il y a 3 h »
function depuis(heure) {
  const m = Math.max(0, Math.round((Date.now() - Number(heure)) / 60000));
  if (m < 60) return `il y a ${m} min`;
  if (m < 48 * 60) return `il y a ${Math.round(m / 60)} h`;
  return `il y a ${Math.round(m / 1440)} j`;
}

// ---- Libellés des réglages -------------------------------------------------------------------------
// Repris mot pour mot des écrans de modification (public/administration.js) pour que l'historique parle
// comme le formulaire. Clé : « section.champ » du firmware ; `v` met la valeur en forme avec son unité.
const CHAMPS = {
  'nom.nomLong': { lib: 'Nom long', brut: true },
  'nom.nomCourt': { lib: 'Nom court', brut: true },
  'device.role': { lib: 'Rôle', v: (x) => ROLES_FR[x] || String(x) },
  'device.rebroadcastMode': { lib: 'Rediffusion', v: String },
  'device.nodeInfoBroadcastSecs': { lib: 'Fiche du nœud', v: toutesLes },
  'lora.region': { lib: 'Région', v: String },
  'lora.modemPreset': { lib: 'Preset', v: String },
  'lora.usePreset': { lib: 'Utiliser le preset', v: ouiNon },
  'lora.channelNum': { lib: 'Slot', v: (x) => (Number(x) === 0 ? 'auto' : String(x)) },
  'lora.overrideFrequency': { lib: 'Fréquence forcée', v: (x) => (Number(x) === 0 ? 'non' : `${Number(x).toFixed(4)} MHz`) },
  'lora.hopLimit': { lib: 'Sauts', v: (x) => String(Number(x)) }, // l'unité est dans le libellé
  'lora.txPower': { lib: 'Puissance d’émission', v: (x) => (Number(x) === 0 ? 'défaut' : `${Number(x)} dBm`) },
  'lora.txEnabled': { lib: 'Émission', v: (x) => (x ? 'activée' : 'désactivée') },
  'lora.sx126xRxBoostedGain': { lib: 'Réception boostée', v: ouiNon },
  'lora.configOkToMqtt': { lib: 'Envoi vers MQTT', v: ouiNon },
  'lora.ignoreMqtt': { lib: 'Ignorer MQTT', v: ouiNon },
  'position.positionBroadcastSecs': { lib: 'Position', v: toutesLes },
  'position.positionBroadcastSmartEnabled': { lib: 'Position intelligente', v: ouiNon },
  'position.fixedPosition': { lib: 'Position fixe', v: ouiNon },
  'voisinage.enabled': { lib: 'Voisinage', v: (x) => (x ? 'activé' : 'désactivé') },
  'voisinage.updateInterval': { lib: 'Voisinage', v: toutesLes },
  'voisinage.transmitOverLora': { lib: 'Voisinage sur LoRa', v: ouiNon },
  'telemetrie.deviceTelemetryEnabled': { lib: 'Télémétrie de l’appareil', v: (x) => (x ? 'activée' : 'désactivée') },
  'telemetrie.deviceUpdateInterval': { lib: 'Télémétrie', v: toutesLes },
  'trafic.positionMinIntervalSecs': { lib: 'Positions d’un même nœud', v: (x) => (Number(x) === 0 ? 'sans limite' : `au plus ${toutesLes(x)}`) },
  'trafic.nodeinfoDirectResponseMaxHops': { lib: 'Réponse aux fiches', v: (x) => (Number(x) === 0 ? 'non' : `jusqu’à ${Number(x)} sauts`) },
  'trafic.rateLimitWindowSecs': { lib: 'Limite de débit', v: (x) => (Number(x) === 0 ? 'non' : `fenêtre de ${Number(x)} s`) },
  'trafic.rateLimitMaxPackets': { lib: 'Paquets max par nœud', v: (x) => (Number(x) === 0 ? 'sans limite' : String(Number(x))) },
  'trafic.unknownPacketThreshold': { lib: 'Paquets illisibles avant blocage', v: (x) => (Number(x) === 0 ? 'non' : String(Number(x))) },
  'securite.packetSignaturePolicy': { lib: 'Signature des paquets', v: (x) => SIGNATURES_FR[x] || String(x) },
};
// Sections de réglages d'une modification, dans l'ordre du formulaire
const SECTIONS = ['nom', 'device', 'lora', 'position', 'voisinage', 'telemetrie', 'trafic', 'securite'];
// Champs des sections connues : sert au contrôle « aucun nom de champ n'est pris pour un secret »
const CHAMPS_CONNUS = Object.keys(CHAMPS);

// Valeur mise en forme d'un champ, ou « (masqué) » si elle peut être un secret
// Un réglage connu de CHAMPS ne porte jamais de secret : seul son nom est contrôlé, pour qu'un nom long
// de nœud fait de lettres et de chiffres (« 43BouchetRelais01 ») ne soit pas pris pour une clé.
const masquer = (cle, champ, v) => (CHAMPS[cle] ? SECRET.test(String(champ)) : sensible(champ, v));

function valeurChamp(cle, champ, v) {
  if (masquer(cle, champ, v)) return { valeur: MASQUE };
  const def = CHAMPS[cle];
  if (def && def.v) return { valeur: def.v(v) };
  if (v && typeof v === 'object') return { valeur: '…' };
  if (typeof v === 'boolean') return { valeur: ouiNon(v), brut: !def };
  return { valeur: String(v), brut: true }; // nom technique conservé : pas de traduction inventée
}

// Valeur d'avant, quand elle est réellement connue :
//  - `t.avant` : dernière configuration LUE sur ce nœud, enregistrée au lancement de l'opération (exacte, datée) ;
//  - `t.mesures` : intervalle MESURÉ sur le trafic (Contrôle du trafic) — ce n'est pas le réglage du nœud,
//    le texte le dit (« mesuré sur 24 h »).
function noteAvant(t, cle, apres) {
  const def = CHAMPS[cle] || {};
  const a = t.avant && t.avant.valeurs ? t.avant.valeurs[cle] : undefined;
  if (a !== undefined && a !== null && !masquer(cle, cle, a)) {
    const txt = def.v ? def.v(a) : String(a);
    return txt === apres ? null : `avant : ${txt} (lu ${depuis(t.avant.heure)})`;
  }
  const m = t.mesures && t.mesures.valeurs ? t.mesures.valeurs[cle] : undefined;
  if (m != null) return `mesuré sur ${Number(t.mesures.heures) || 24} h : ${toutesLes(m)}`;
  return null;
}

// Lignes d'une section de réglages (objet { champ: valeur })
function lignesSection(t, section, objet) {
  const l = [];
  for (const [champ, v] of Object.entries(objet || {})) {
    if (v === undefined) continue;
    const cle = `${section}.${champ}`;
    const def = CHAMPS[cle];
    const { valeur, brut } = valeurChamp(cle, champ, v);
    const note = noteAvant(t, cle, valeur);
    l.push({ lib: def ? def.lib : champ, valeur, ...(brut ? { brut: true } : {}), ...(note ? { notes: [note] } : {}) });
  }
  return l;
}

// Ligne d'un canal : nom et réglages, jamais la clé
function ligneCanal(c) {
  const index = Number(c.index) || 0;
  const lib = `canal ${index}`;
  const notes = index === 0 ? ['principal'] : [];
  if (c.supprimer || c.role === 'DISABLED') return { lib, valeur: 'supprimé', notes };
  if (c.psk) notes.push('clé envoyée (non affichée)');
  if (c.precision != null) notes.push(precisionTexte(c.precision));
  const mqtt = (c.montant ? '↑' : '') + (c.descendant ? '↓' : '');
  notes.push(mqtt ? `MQTT ${mqtt}` : 'sans MQTT');
  return { lib, valeur: String(c.nom || '') || '(nom du preset)', brut: true, notes };
}

const ACTIONS_EQUIPE = { ajouter: 'ajout au canal', retirer: 'retrait du canal', cle: 'nouvelle clé du canal' };

// ---- Détail d'une opération -------------------------------------------------------------------------
// Renvoie une liste de lignes { lib?, valeur, brut?, notes? }. `brut` = donnée de l'utilisateur
// (nom de nœud, nom de canal, nombre) : affichée telle quelle, jamais traduite.
function detailsOperation(t, noms = {}) {
  const p = (t && t.params) || {};
  const type = t && t.type;
  const d = [];
  if (type === 'modifier') {
    if (p.modele) d.push({ lib: 'Modèle de réglages', valeur: String(p.modele), brut: true });
    for (const s of SECTIONS) if (p[s] && typeof p[s] === 'object') d.push(...lignesSection(t, s, p[s]));
    for (const c of Array.isArray(p.canaux) ? p.canaux : []) d.push(ligneCanal(c));
    return d;
  }
  if (type === 'config') {
    const s = String(p.section || '');
    d.push(...lignesSection(t, s, p.valeurs));
    return d;
  }
  if (type === 'canal') return [ligneCanal(p)];
  if (type === 'nom') return lignesSection(t, 'nom', { nomLong: p.nomLong || undefined, nomCourt: p.nomCourt || undefined });
  if (type === 'position') {
    if (p.retirer) return [{ lib: 'Position fixe', valeur: 'retirée (retour au GPS)' }];
    const alt = p.alt != null && p.alt !== '' ? ` · ${Math.round(Number(p.alt))} m` : '';
    return [{ lib: 'Position fixe', valeur: `${p.lat}, ${p.lon}${alt}`, brut: true }];
  }
  if (type === 'verifier') {
    const el = (p.elements || []).map((k) => noms[k] || k);
    return [{ lib: 'Référence', valeur: '!' + ((Number(p.reference) || 0) >>> 0).toString(16).padStart(8, '0'), brut: true, notes: el }];
  }
  if (type === 'firmware') return [{ lib: 'Firmware', valeur: String(p.version || ''), brut: true }];
  if (type === 'favoris') {
    const v = Object.values(p.plan || {});
    return [{ valeur: `${v.reduce((a, x) => a + ((x.ajouter || []).length), 0)} favori(s) à poser sur ${v.length} relais` }];
  }
  if (type === 'equipe') return [{ lib: 'Canal d’équipe', valeur: String(p.nom || ''), brut: true, notes: [ACTIONS_EQUIPE[p.action] || ''].filter(Boolean) }];
  return d;
}

// Résumé sur une ligne : utilisé pour les confirmations et le bouton « ↻ Réessayer »
function resumeOperation(t, noms = {}) {
  return detailsOperation(t, noms)
    .map((x) => [x.lib ? `${x.lib} : ${x.valeur}` : x.valeur, ...(x.notes || [])].join(' · '))
    .join(' · ');
}

// Vrai si l'opération réécrit le canal principal (0) : la confirmation de relance le rappelle
function toucheCanalPrincipal(t) {
  const p = (t && t.params) || {};
  if (t && t.type === 'canal') return Number(p.index) === 0 && p.role !== 'DISABLED';
  if (t && t.type === 'modifier') return (Array.isArray(p.canaux) ? p.canaux : []).some((c) => Number(c.index) === 0 && !c.supprimer);
  return false;
}

module.exports = { detailsOperation, resumeOperation, toucheCanalPrincipal, duree, toutesLes, depuis, CHAMPS, CHAMPS_CONNUS, SECTIONS, MASQUE, sensible, masquer };
