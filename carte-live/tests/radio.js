// Tests du décodage radio : node --test tests/radio.js
// Meshtastic (enveloppes MQTT chiffrées construites comme par un vrai nœud), MeshCore (trames réelles entendues
// en Haute-Loire, et un message du canal Public chiffré comme par le firmware), carroyage DFCI, passerelle.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mt = require('../src/decodeur');
const mc = require('../src/meshcore/paquet');
const DFCI = require('../public/dfci.js');

// ---------- Meshtastic ----------
const CANAUX = mt.preparerCanaux([{ nom: 'LongFast', cle: 'AQ==' }, { nom: 'Prive', cle: crypto.randomBytes(32).toString('base64') }]);
const cleDe = (nom) => CANAUX.find((c) => c.nom === nom).cle;
function enveloppe(canal, de, portnum, payload, { cle = cleDe(canal), vers = 0xffffffff, sauts = 1 } = {}) {
  const idPaquet = crypto.randomBytes(4).readUInt32LE(0);
  const data = mt.types.Data.encode({ portnum, payload }).finish();
  const chiffre = mt.dechiffrer(cle, idPaquet, de, Buffer.from(data)); // AES-CTR : chiffrer = déchiffrer
  const paquet = { from: de, to: vers, id: idPaquet, channel: mt.hachageCanal(canal, cle), encrypted: chiffre, hopStart: 3, hopLimit: 3 - sauts, rxSnr: 6.25, rxRssi: -97, rxTime: Math.floor(Date.now() / 1000) };
  const env = mt.types.ServiceEnvelope.encode({ packet: paquet, channelId: canal, gatewayId: '!5a1e0001' }).finish();
  return { topic: `msh/EU_868/FR/43/2/e/${canal}/!5a1e0001`, message: Buffer.from(env) };
}
const PORT = { TEXTE: 1, POSITION: 3, TELEMETRIE: 67 }; // numéros de port Meshtastic (portnums.proto)

test('Meshtastic : hachage du canal LongFast par défaut = 8', () => {
  assert.equal(mt.hachageCanal('LongFast', mt.etendreCle('AQ==')), 8);
});

test('Meshtastic : identifiants de nœud', () => {
  assert.equal(mt.idNoeud(0x5a1e0001), '!5a1e0001');
  assert.equal(mt.numDepuisId('!5a1e0001'), 0x5a1e0001);
});

test('Meshtastic : message texte chiffré décodé (expéditeur, canal, texte, SNR, sauts)', () => {
  const { topic, message } = enveloppe('LongFast', 0x5a1e0005, PORT.TEXTE, Buffer.from('Essai Mézenc 73 ✓'));
  const e = mt.decoderMessage(topic, message, CANAUX);
  assert.equal(e.dechiffre, true);
  assert.equal(e.de >>> 0, 0x5a1e0005);
  assert.equal(e.canal, 'LongFast');
  assert.equal(e.texte, 'Essai Mézenc 73 ✓');
  assert.equal(e.snr ?? e.rxSnr, 6.25);
});

test('Meshtastic : position décodée en degrés', () => {
  const pos = mt.types.Position.encode({ latitudeI: 450434000, longitudeI: 38851000, altitude: 630 }).finish();
  const { topic, message } = enveloppe('LongFast', 0x5a1e0005, PORT.POSITION, pos);
  const e = mt.decoderMessage(topic, message, CANAUX);
  assert.equal(e.port, 'position');
  assert.ok(Math.abs(e.position.lat - 45.0434) < 1e-6 && Math.abs(e.position.lon - 3.8851) < 1e-6);
  assert.equal(e.position.alt, 630);
});

test('Meshtastic : télémétrie (batterie, tension, occupation du canal)', () => {
  const t = mt.types.Telemetry.encode({ time: 1, deviceMetrics: { batteryLevel: 77, voltage: 3.95, channelUtilization: 12.5, airUtilTx: 1.5 } }).finish();
  const { topic, message } = enveloppe('LongFast', 0x5a1e0006, PORT.TELEMETRIE, t);
  const e = mt.decoderMessage(topic, message, CANAUX);
  const json = JSON.stringify(e);
  assert.match(json, /77/);
  assert.match(json, /3\.95/);
  assert.match(json, /12\.5/);
});

test('Meshtastic : canal privé lu seulement avec sa clé', () => {
  const autre = crypto.randomBytes(32);
  const { topic, message } = enveloppe('Prive', 0x5a1e0007, PORT.TEXTE, Buffer.from('secret'), { cle: autre });
  const e = mt.decoderMessage(topic, message, CANAUX);
  assert.notEqual(e.texte, 'secret');
  assert.equal(e.dechiffre, false);
});

test('Meshtastic : trames abîmées sans plantage', () => {
  for (const m of [Buffer.alloc(0), Buffer.from('n’importe quoi'), crypto.randomBytes(200)]) {
    assert.doesNotThrow(() => mt.decoderMessage('msh/EU_868/2/e/LongFast/!12345678', m, CANAUX));
  }
  assert.equal(mt.decoderMessage('msh/EU_868/2/json/LongFast/!12345678', Buffer.from('{}'), CANAUX), null);
  assert.equal(mt.decoderMessage('msh/EU_868/2/stat/!5a1e0001', Buffer.from('online'), CANAUX).etat, 'online');
});

// ---------- MeshCore (trames réelles) ----------
const ANNONCE = '1200959584CEE8F2FEB1214ECA9FDBDB00D60B31389DEE492232912C95938529EC476FFFF56A78471B2BD9A733A183675F0FA99B03EA2D32635F854737996601754081651F0AC135D01FD1C5FF407B46082167E84DFA9E0FA19581EE26A16CAA187753AC100693B3F1B902B4254A0036394C594F4E5F4A45444FF09F93A1F09F93A9F09F9088';
const CANAL_INCONNU = '14C59C000040D9C787404A15739B568ACB462FD82667392C780AC65279B4267A5A66C15D3CDD3C2BF4';
const CHEMIN = '20B8920000486F1E9D3E9E976F2B81955781ECF0D81A3EE3F86C64A974BB59967135FAA2B498C24D005E2300A67F9F332658640A9C3C2F4A6AA0DDBEBBAFE8FD77254C0978F9EBE31A55';
const PRIVE = '08B7C2000040162C6186C27A7C2B469D084A9FF250D51A171501ADE4EE3D68935CD8436BFB5A0D065E37';
const PUBLIC = mc.preparerCanauxMc(['Public']);

test('MeshCore : annonce d’un room server (clé, nom avec émojis, position)', () => {
  const p = mc.decoderPaquet(ANNONCE, PUBLIC);
  assert.equal(p.valide, true);
  assert.equal(p.type, 'ADVERT');
  const c = p.contenu;
  assert.equal(String(c.cle).toUpperCase(), '959584CEE8F2FEB1214ECA9FDBDB00D60B31389DEE492232912C95938529EC47');
  assert.equal(c.nom, '69LYON_JEDO📡📩🐈');
  assert.ok(c.lat > 44 && c.lat < 47 && c.lon > 3 && c.lon < 6, `position ${c.lat},${c.lon}`);
});

test('MeshCore : autres types reconnus, canal inconnu non déchiffré', () => {
  assert.equal(mc.decoderPaquet(CHEMIN).type, 'PATH');
  assert.equal(mc.decoderPaquet(PRIVE).type, 'TXT_MSG');
  const g = mc.decoderPaquet(CANAL_INCONNU, PUBLIC);
  assert.equal(g.type, 'GRP_TXT');
  assert.ok(!g.contenu.texte);
});

test('MeshCore : hachage identique pour la même trame', () => {
  assert.equal(mc.decoderPaquet(ANNONCE).hachage, mc.decoderPaquet(ANNONCE).hachage);
  assert.notEqual(mc.decoderPaquet(ANNONCE).hachage, mc.decoderPaquet(CHEMIN).hachage);
});

// Message du canal Public chiffré comme par le firmware : AES-128-ECB, MAC = HMAC-SHA256(secret ‖ 16 zéros)
function messagePublic(texte) {
  const c = PUBLIC[0];
  const clair = Buffer.concat([Buffer.alloc(4), Buffer.from([0]), Buffer.from(texte, 'utf8')]);
  const bourre = Buffer.concat([clair, Buffer.alloc((16 - (clair.length % 16)) % 16)]);
  const ch = crypto.createCipheriv('aes-128-ecb', c.cle, null); ch.setAutoPadding(false);
  const chiffre = Buffer.concat([ch.update(bourre), ch.final()]);
  const mac = crypto.createHmac('sha256', Buffer.concat([c.cle, Buffer.alloc(16)])).update(chiffre).digest().subarray(0, 2);
  const charge = Buffer.concat([Buffer.from([c.hachage]), mac, chiffre]);
  return Buffer.concat([Buffer.from([(5 << 2) | 1, 0]), charge]); // GRP_TXT, inondation, sans chemin
}
test('MeshCore : message du canal Public déchiffré (expéditeur et texte)', () => {
  const p = mc.decoderPaquet(messagePublic('F4GLD: Essai depuis le Mézenc 📡'), PUBLIC);
  assert.equal(p.type, 'GRP_TXT');
  assert.equal(p.contenu.canal, 'Public');
  assert.equal(p.contenu.expediteur, 'F4GLD');
  assert.equal(p.contenu.texte, 'Essai depuis le Mézenc 📡');
});

test('MeshCore : canal #nom dérivé du nom', () => {
  const [c] = mc.preparerCanauxMc(['#velay']);
  assert.equal(c.secret, crypto.createHash('sha256').update('#velay').digest().subarray(0, 16).toString('hex'));
});

test('MeshCore : trames abîmées sans plantage', () => {
  for (const t of ['', '00', 'FF', ANNONCE.slice(0, 40), crypto.randomBytes(80).toString('hex')]) {
    assert.doesNotThrow(() => mc.decoderPaquet(t, PUBLIC));
  }
  assert.equal(mc.decoderPaquet('00').valide, false);
});

// ---------- DFCI ----------
test('DFCI : aller-retour et code connu au Puy-en-Velay', () => {
  const code = DFCI.versDfci(45.0434, 3.8851);
  assert.match(code, /^[A-HK-N]{2}[02468]{2}[A-HK-L]\d\.[1-5]$/);
  const r = DFCI.depuisDfci(code);
  assert.ok(Math.abs(r.lat - 45.0434) < 0.02 && Math.abs(r.lon - 3.8851) < 0.02);
  assert.equal(DFCI.versDfci(48.8566, 2.3522, false).length, 6);
  assert.equal(DFCI.versDfci(40.7, -74), null); // hors de France
  for (const [lat, lon] of [[42.7, 2.9], [50.6, 3.06], [43.3, 5.4], [48.4, -4.5]]) {
    const c = DFCI.depuisDfci(DFCI.versDfci(lat, lon));
    assert.ok(Math.abs(c.lat - lat) < 0.02 && Math.abs(c.lon - lon) < 0.03, `${lat},${lon}`);
  }
  assert.equal(DFCI.estCodeDfci('KD42F7.5'), true);
  assert.equal(DFCI.estCodeDfci('Bonjour'), false);
});

// ---------- Passerelle ----------
test('Passerelle : positions et signalements relayés une fois, sans écho', async () => {
  const { creerPasserelle } = require('../src/passerelle');
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'passerelle-'));
  const envois = [];
  const p = creerPasserelle({
    config: { fichierBase: path.join(dossier, 'x.db'), passerelle: { actif: true }, canaux: [], meshcore: {} }, journal: () => {}, audit: {}, nomMt: () => 'F4XYZ',
    envoyerMt: async (c, t) => envois.push(['MT', t]), envoyerMc: async (c, t) => envois.push(['MC', t]),
    etatMt: () => ({ connecte: true, noeudLocal: 1, canaux: [{ index: 1, nom: 'Crise' }] }), etatMc: () => ({ pret: true, nom: 'BASE', canaux: [{ index: 2, nom: '#crise' }] }),
  });
  p.regler({ ecartEnvoiS: 2 });
  p.ajouterRegle({ mt: 1, mc: 2, sens: 'bi', positions: true, signalements: true }, 'essai');
  p.recevoirPosition({ reseau: 'mt', canal: 'Crise', de: 0x1234, nom: 'F4XYZ', lat: 45.0451, lon: 3.8852 });
  p.recevoirPosition({ reseau: 'mt', canal: 'Crise', de: 0x1234, nom: 'F4XYZ', lat: 45.0452, lon: 3.8852 }); // trop proche
  p.recevoirSignalement({ reseau: 'mt', canal: 'Crise', de: 0x55, nom: 'BIP1', idPoint: 7, titre: 'Route inondée', lat: 45.1, lon: 3.95 });
  p.recevoirSignalement({ reseau: 'mt', canal: 'Crise', de: 0x55, nom: 'BIP1', idPoint: 7, titre: 'Route inondée', lat: 45.1, lon: 3.95 }); // réémis
  p.recevoirPosition({ reseau: 'mc', de: 'BASE', nom: 'BASE', lat: 45.2, lon: 4.0 }); // écho de notre companion
  await new Promise((r) => setTimeout(r, 6000));
  const textes = envois.map((e) => e[1]);
  assert.equal(textes.filter((t) => t.includes('📍')).length, 1, textes.join(' | '));
  assert.equal(textes.filter((t) => t.includes('Route inondée')).length, 1, textes.join(' | '));
  assert.ok(textes.every((t) => /DFCI [A-HK-N]{2}/.test(t)), textes.join(' | '));
  assert.ok(!textes.some((t) => t.includes('BASE')));
  fs.rmSync(dossier, { recursive: true, force: true });
  setImmediate(() => process.exit(0)); // la passerelle garde des minuteries actives
});
