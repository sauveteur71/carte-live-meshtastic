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

// Non-régression (15/11) : un message de canal reçu par MQTT (observateur) doit être signalé une seule fois comme nouveau,
// sinon les cartes n'incrémentent pas le compteur de messages non lus
test('MeshCore : message de canal entendu par un observateur signalé comme nouveau une seule fois', () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-msg-'));
  process.env.FICHIER_BASE = path.join(dossier, 'x.db');
  const config = require('../src/config');
  const { creerStockage } = require('../src/base');
  const { creerReseauMc } = require('../src/meshcore/reseau');
  const st = creerStockage(path.join(dossier, 'x.db'));
  const r = creerReseauMc(st.db, config, PUBLIC);
  const brut = messagePublic('F4XYZ: Coucou le réseau');
  const a = r.integrer({ brut, observateur: 'AB'.repeat(32), snr: 5, rssi: -90, heure: Date.now() });
  const b = r.integrer({ brut, observateur: 'CD'.repeat(32), snr: 3, rssi: -100, heure: Date.now() });
  assert.ok(a && a.nouveauMessage, 'première réception : nouveau message');
  assert.equal(a.texte, 'Coucou le réseau');
  assert.ok(!b || !b.nouveauMessage, 'deuxième observateur : pas un nouveau message');
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('Réglages avancés : une variable réglée sur la carte prime sur le .env, les inconnues sont ignorées', () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'variables-'));
  const avant = { FICHIER_BASE: process.env.FICHIER_BASE, SEUIL_TENSION_VOLTS: process.env.SEUIL_TENSION_VOLTS, PORT: process.env.PORT };
  process.env.FICHIER_BASE = path.join(dossier, 'x.db');
  process.env.SEUIL_TENSION_VOLTS = '3.3';
  fs.writeFileSync(path.join(dossier, 'reglages.json'), JSON.stringify({ variables: { SEUIL_TENSION_VOLTS: '3.7', PORT: '1' } }));
  delete require.cache[require.resolve('../src/variables')];
  const v = require('../src/variables');
  v.appliquer();
  assert.equal(process.env.SEUIL_TENSION_VOLTS, '3.7');
  assert.notEqual(process.env.PORT, '1');
  assert.equal(v.vue().find((x) => x.nom === 'SEUIL_TENSION_VOLTS').origine, 'carte');
  assert.throws(() => v.valider('SEUIL_BATTERIE_POURCENT', '250'));
  assert.equal(v.valider('SEUIL_TENSION_VOLTS', '3,6'), '3.6');
  for (const [k, x] of Object.entries(avant)) { if (x === undefined) delete process.env[k]; else process.env[k] = x; }
  fs.rmSync(dossier, { recursive: true, force: true });
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
test('Meshtastic : paquet d’un module du réseau local reçu par UDP multicast et déchiffré', async (t) => {
  const dgram = require('dgram');
  const { creerUdpMeshtastic } = require('../src/udp-meshtastic');
  const MeshPacket = mt.racine.lookupType('meshtastic.MeshPacket');
  const recus = [];
  const u = creerUdpMeshtastic({ types: { MeshPacket }, journal: () => {}, surPaquet: (p, ip) => recus.push({ p, ip }) });
  u.demarrer();
  await new Promise((r) => setTimeout(r, 300));
  if (!u.etat().actif || !u.etat().groupes.length) { u.arreter(); t.skip('pas de multicast sur cette machine'); return; }
  const cle = mt.etendreCle('AQ==');
  const de = 0x43aabbcc, id = 0x1234abcd;
  const data = mt.types.Data.encode({ portnum: 1, payload: Buffer.from('Bonjour par UDP') }).finish();
  const paquet = MeshPacket.encode({ from: de, to: 0xffffffff, id, channel: mt.hachageCanal('LongFast', cle), encrypted: mt.dechiffrer(cle, id, de, Buffer.from(data)), hopLimit: 3, hopStart: 3 }).finish();
  const s = dgram.createSocket('udp4');
  await new Promise((r) => s.send(Buffer.from(paquet), 4403, '239.0.0.69', r));
  s.close();
  await new Promise((r) => setTimeout(r, 500));
  u.arreter();
  if (!recus.length) { t.skip('multicast non bouclé sur cette machine'); return; }
  const env = mt.types.ServiceEnvelope.encode({ packet: recus[0].p }).finish();
  const evt = mt.decoderMessage('udp/2/e/LAN/x', Buffer.from(env), mt.preparerCanaux([{ nom: 'LongFast', cle: 'AQ==' }]));
  assert.equal(evt.de, de);
  assert.equal(evt.canal, 'LongFast');
  assert.equal(evt.texte, 'Bonjour par UDP');
});

test('Nœuds d’un autre preset : preset déduit du canal MQTT par défaut, listés hors du preset du réseau', () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'presets-'));
  const { creerStockage } = require('../src/base');
  const { creerAutresPresets } = require('../src/autres-presets');
  const st = creerStockage(path.join(dossier, 'x.db'));
  const maintenant = Date.now();
  const ins = st.db.prepare('INSERT INTO noeuds (num, id, nom_long, preset, dernier_vu, premier_vu) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run(1, '!00000001', 'Voisin LongFast', null, maintenant, maintenant);
  ins.run(2, '!00000002', 'Relais du réseau', 'LONG_MODERATE', maintenant, maintenant);
  ins.run(3, '!00000003', 'Canal privé', null, maintenant, maintenant);
  const ap = creerAutresPresets(st.db, () => {});
  ap.noterPaquet({ genre: 'paquet', de: 1, canalTopic: 'LongFast' });
  ap.noterPaquet({ genre: 'paquet', de: 3, canalTopic: 'Fr_Balise' }); // canal nommé : preset inconnu
  ap.noterPaquet({ genre: 'paquet', de: 2, canalTopic: 'LongFast', viaMqtt: true }); // redescendu par MQTT : ignoré
  const l = ap.liste('LONG_MODERATE');
  assert.deepEqual(l.map((n) => n.num), [1]);
  assert.equal(l[0].preset, 'LONG_FAST');
  assert.ok(l[0].presetDeduit);
  assert.equal(st.db.prepare('SELECT preset FROM noeuds WHERE num = 2').get().preset, 'LONG_MODERATE');
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('Alertes officielles : vigilance et foyer déjà envoyés par radio, mémorisés et rechargés', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-'));
  const http = require('http');
  const flux = `<feed><entry><title>Yellow avalanches Warning</title><cap:areaDesc>Haute-Loire</cap:areaDesc><cap:event>Yellow avalanches warning</cap:event>
    <cap:onset>${new Date(Date.now() - 3600000).toISOString()}</cap:onset><cap:expires>${new Date(Date.now() + 86400000).toISOString()}</cap:expires><cap:status>Actual</cap:status></entry></feed>`;
  const srv = http.createServer((q, r) => r.end(flux)).listen(0);
  await new Promise((ok) => srv.once('listening', ok));
  process.env.METEOALARM_URL = `http://127.0.0.1:${srv.address().port}/flux`;
  delete require.cache[require.resolve('../src/alertes-officielles')];
  const { creerAlertesOfficielles } = require('../src/alertes-officielles');
  const envoyes = [];
  const creer = () => creerAlertesOfficielles({
    config: { fichierBase: path.join(dossier, 'base.db') }, journal: () => {},
    departementsSuivis: () => [{ code: '43', nom: 'Haute-Loire' }],
    envoyer: async (canal, texte) => envoyes.push([canal, texte]), envoyerMc: async () => {}, diffuser: () => {},
  });
  const ao = creer();
  await ao.regler({}); // relit la vigilance
  await new Promise((ok) => setTimeout(ok, 300));
  let v = ao.etat().meteo[0];
  assert.equal(v.phenomene, 'avalanches');
  assert.equal(v.envoi, null);
  await ao.envoyerVigilance({ dep: '43', phenomene: 'avalanches', canaux: ['Alerte'] }, 'F4GLD');
  v = ao.etat().meteo[0];
  assert.equal(v.envoi.par, 'F4GLD');
  assert.deepEqual(v.envoi.canaux, ['Alerte']);
  ao.noterEnvoi('feu|F1', 'F4GLD', [{ canal: 'MeshCore #meteo', statut: 'envoye' }]);
  ao.noterEnvoi('feu|F2', 'F4GLD', [{ canal: 'Alerte', statut: 'echec' }]); // échec : pas noté
  assert.deepEqual(Object.keys(ao.etat().envoisFeux), ['F1']);
  // Après relecture du flux et redémarrage, l'envoi est toujours connu
  const ao2 = creer();
  await ao2.regler({});
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal(ao2.etat().meteo[0].envoi.par, 'F4GLD');
  assert.ok(ao2.etat().envoisFeux.F1);
  srv.close();
});

test('Domotique : découverte Home Assistant, état, relais et message LoRa reçu de la domotique', () => {
  const { EventEmitter } = require('events');
  const { creerDomotique, lireReglages } = require('../src/domotique');
  const publies = [];
  const client = Object.assign(new EventEmitter(), {
    publish: (sujet, charge, o) => publies.push({ sujet, charge, garder: !!(o && o.retain) }),
    subscribe: () => {}, end: () => {},
  });
  const envois = [];
  const d = creerDomotique({
    mqtt: { connect: () => client },
    reglages: lireReglages({ DOMOTIQUE_MQTT_URL: 'mqtt://ha.local:1883', DOMOTIQUE_ENVOI_LORA: 'oui', DOMOTIQUE_CANAL_ENVOI: '2' }),
    resume: () => ({ noeudsActifs: 12, passerellesEnLigne: 3, alertes: 1, alertesCritiques: 1 }),
    alertes: () => [{ cle: 'muet:1', type: 'muet', niveau: 'critique', nom: 'Relais Mézenc', message: 'muet' }],
    noeuds: () => [{ id: '!a1b2c3d4', nom: 'Relais Mézenc', reseau: 'meshtastic', role: 'ROUTER', vu: 1763280000000, enLigne: true, batterie: 87, tension: 4.1, lat: 44.9, lon: 4.2 }],
    envoyer: (b) => { envois.push(b); return { id: 42 }; },
  });
  client.emit('connect');
  const sujets = publies.map((p) => p.sujet);
  assert.ok(sujets.includes('carte-live/disponibilite'));
  const etat = publies.find((p) => p.sujet === 'carte-live/etat');
  assert.equal(JSON.parse(etat.charge).noeudsActifs, 12);
  assert.ok(etat.garder);
  assert.ok(sujets.includes('homeassistant/binary_sensor/carte-live/alerte_critique/config'));
  assert.ok(sujets.includes('homeassistant/text/carte-live/message_lora/config'));
  assert.ok(sujets.includes('homeassistant/device_tracker/carte-live/noeud_a1b2c3d4/config'));
  const n = JSON.parse(publies.find((p) => p.sujet === 'carte-live/noeud/a1b2c3d4').charge);
  assert.equal(n.batterie, 87);
  assert.equal(n.enLigne, true);
  // Message de la domotique : envoyé sur le canal réglé ; un second trop tôt est refusé
  client.emit('message', 'carte-live/envoyer', Buffer.from('Test depuis Home Assistant'));
  client.emit('message', 'carte-live/envoyer', Buffer.from('{"texte":"encore"}'));
  assert.deepEqual(envois, [{ texte: 'Test depuis Home Assistant', canal: 2, dest: undefined }]);
  const res = publies.filter((p) => p.sujet === 'carte-live/envoyer/resultat').map((p) => JSON.parse(p.charge));
  assert.equal(res[0].ok, true);
  assert.equal(res[1].ok, false);
  // Rien n'est republié quand rien n'a changé
  const avant = publies.length;
  d.cycle();
  assert.equal(publies.length, avant);
  d.arreter();
});

test('mDNS : modules Meshtastic Wi-Fi retrouvés par leur annonce _meshtastic._tcp', async (t) => {
  const mdns = require('../src/mdns');
  // Réponse construite comme celle du firmware : PTR → instance, SRV (port 4403), TXT (shortname, id), A
  const rr = (nom, type, donnees) => {
    const n = mdns.encoderNom(nom), e = Buffer.alloc(10);
    e.writeUInt16BE(type, 0); e.writeUInt16BE(0x8001, 2); e.writeUInt32BE(120, 4); e.writeUInt16BE(donnees.length, 8);
    return Buffer.concat([n, e, donnees]);
  };
  const srv = Buffer.concat([Buffer.from([0, 0, 0, 0, 0x11, 0x33]), mdns.encoderNom('Meshtastic_c3d4.local')]);
  const txt = Buffer.concat(['shortname=MZNC', 'id=!a1b2c3d4'].map((x) => Buffer.concat([Buffer.from([x.length]), Buffer.from(x)])));
  const entete = Buffer.alloc(12); entete.writeUInt16BE(0x8400, 2); entete.writeUInt16BE(1, 6); entete.writeUInt16BE(3, 10);
  const reponse = Buffer.concat([entete,
    rr(mdns.SERVICE, 12, mdns.encoderNom('Meshtastic_c3d4.' + mdns.SERVICE)),
    rr('Meshtastic_c3d4.' + mdns.SERVICE, 33, srv), rr('Meshtastic_c3d4.' + mdns.SERVICE, 16, txt),
    rr('Meshtastic_c3d4.local', 1, Buffer.from([192, 168, 1, 57]))]);
  const m = mdns.assembler(mdns.lireReponses(reponse), '192.168.1.99');
  assert.deepEqual(m, [{ nom: 'MZNC', instance: 'Meshtastic_c3d4', hote: '192.168.1.57', port: 4403, id: '!a1b2c3d4', nomCourt: 'MZNC' }]);
  // Requête : une question PTR pour _meshtastic._tcp.local
  const q = mdns.requete();
  assert.equal(q.readUInt16BE(4), 1);
  assert.ok(q.includes(Buffer.from('_meshtastic')));
  // Pour de vrai sur la machine : un faux module répond sur 5353 (ignoré si le multicast n'est pas disponible ici)
  const dgram = require('dgram');
  const faux = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const pret = await new Promise((ok) => {
    faux.once('error', () => ok(false));
    faux.bind(5353, () => { try { faux.addMembership('224.0.0.251'); ok(true); } catch { ok(false); } });
  });
  if (!pret) { try { faux.close(); } catch { /* fermée */ } return t.skip('multicast indisponible'); }
  faux.on('message', (msg, r) => { if (msg.includes(Buffer.from('_meshtastic'))) faux.send(reponse, r.port, r.address); });
  const trouves = await mdns.chercherMeshtastic({ duree: 1200 });
  faux.close();
  if (!trouves.length) return t.skip('aucune interface multicast');
  assert.equal(trouves[0].nom, 'MZNC');
  assert.equal(trouves[0].port, 4403);
});

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
