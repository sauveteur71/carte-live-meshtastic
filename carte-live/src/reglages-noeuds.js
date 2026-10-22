'use strict';
// Réglages complets des nœuds (canaux + LoRa) : copie du module connecté et des lectures faites par LoRa.
// Sert à produire le QR code « meshtastic.org/e/#… » (ChannelSet) d'un nœud, comme l'appli officielle.
// Le fichier contient les clés des canaux : réservé à l'administrateur (mode 600, API admin uniquement).

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const config = require('./config');
const { racine } = require('./decodeur');

try { racine.lookupType('meshtastic.ChannelSet'); } catch { racine.loadSync(['meshtastic/apponly.proto']); }
const ChannelSet = racine.lookupType('meshtastic.ChannelSet');

const dossier = path.dirname(config.fichierBase);
const fichier = path.join(dossier, 'configs-noeuds.json');
let cache = {};
try { cache = JSON.parse(fs.readFileSync(fichier, 'utf8')); } catch { /* premier lancement */ }

function enregistrer(num, { canaux, lora, source }) {
  num = Number(num) >>> 0;
  if (!num || !Array.isArray(canaux) || !canaux.length) return;
  cache[num] = { heure: Date.now(), source, canaux, lora: lora || null };
  try { fs.writeFileSync(fichier, JSON.stringify(cache), { mode: 0o600 }); } catch { /* volume en lecture seule */ }
}

function obtenir(num) {
  num = Number(num) >>> 0;
  let r = cache[num] || null;
  // Copie écrite par radio.js à chaque connexion du module (versions antérieures)
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dossier, 'config-module.json'), 'utf8'));
    if ((m.noeud >>> 0) === num && (!r || m.heure > r.heure)) r = { heure: m.heure, source: 'module', canaux: (m.canaux || []).filter(Boolean), lora: m.lora };
  } catch { /* absent */ }
  return r;
}

const cleCourte = (psk) => {
  const b = Buffer.from(psk || '', 'base64');
  if (!b.length) return 'aucune (en clair)';
  if (b.length === 1) return b[0] === 1 ? 'par défaut (AQ==)' : `simple n° ${b[0]}`;
  return `personnalisée ${b.length * 8} bits`;
};

// Canaux actifs dans l'ordre des index ; le principal (index 0 / PRIMARY) en premier
function canauxActifs(r) {
  return r.canaux
    .filter((c) => c && c.role && c.role !== 'DISABLED' && c.role !== 0)
    .sort((a, b) => (a.index || 0) - (b.index || 0));
}

async function qr(num, { indices = null, avecLora = true, montants = null, descendants = null } = {}) {
  const r = obtenir(num);
  if (!r) return null;
  const actifs = canauxActifs(r);
  const principal = actifs.find((c) => c.role === 'PRIMARY' || c.role === 1) || actifs[0];
  // Le canal principal est toujours inclus et toujours en tête (il devient le canal 0 du nœud qui scanne)
  const choisis = actifs.filter((c) => c === principal || !indices || indices.includes(c.index || 0));
  // MQTT : valeurs du nœud, sauf si une liste d'index est imposée (montants / descendants)
  const up = (c) => (montants ? montants.includes(c.index || 0) : !!(c.settings && c.settings.uplinkEnabled));
  const down = (c) => (descendants ? descendants.includes(c.index || 0) : !!(c.settings && c.settings.downlinkEnabled));
  const s = (c) => {
    const st = c.settings || {};
    return {
      psk: Buffer.from(st.psk || '', 'base64'), name: st.name || '', id: st.id || 0,
      uplinkEnabled: up(c), downlinkEnabled: down(c),
      moduleSettings: st.moduleSettings ? { positionPrecision: st.moduleSettings.positionPrecision || 0, isClientMuted: !!st.moduleSettings.isClientMuted } : undefined,
    };
  };
  const objet = { settings: [principal, ...choisis.filter((c) => c !== principal)].map(s) };
  if (avecLora && r.lora) objet.loraConfig = r.lora;
  const msg = ChannelSet.fromObject(objet);
  const url = 'https://meshtastic.org/e/#' + Buffer.from(ChannelSet.encode(msg).finish()).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#0b1d26', light: '#ffffff' } });
  const l = r.lora || {};
  return {
    url, svg, heure: r.heure, source: r.source,
    canaux: actifs.map((c) => ({
      index: c.index || 0, nom: (c.settings && c.settings.name) || (c === principal ? '(principal sans nom)' : ''),
      principal: c === principal, inclus: choisis.includes(c), cle: cleCourte(c.settings && c.settings.psk),
      precision: c.settings && c.settings.moduleSettings ? c.settings.moduleSettings.positionPrecision || 0 : 0,
      montant: up(c), descendant: down(c), montantNoeud: !!(c.settings && c.settings.uplinkEnabled), descendantNoeud: !!(c.settings && c.settings.downlinkEnabled),
    })),
    lora: r.lora ? { inclus: !!(avecLora), region: l.region, preset: l.usePreset === false ? 'personnalisé' : l.modemPreset, sauts: l.hopLimit, slot: l.channelNum, frequence: l.overrideFrequency || null, puissance: l.txPower } : null,
  };
}

module.exports = { enregistrer, obtenir, qr };
