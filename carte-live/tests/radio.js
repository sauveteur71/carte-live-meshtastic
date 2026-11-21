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

// Observatoire CoreScope simulé : paquets bruts lus sur l'API REST, nœuds importés, plafond par minute, zones, panne
test('MeshCore : observatoire CoreScope (API REST) intégré comme un flux MQTT, plafonné et filtré par zone', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cs-'));
  process.env.FICHIER_BASE = path.join(dossier, 'x.db');
  const config = require('../src/config');
  const { creerStockage } = require('../src/base');
  const { creerReseauMc } = require('../src/meshcore/reseau');
  const cs = require('../src/meshcore/corescope');
  assert.deepEqual(cs.lireSources('analyzer.on8ar.eu=bru, lgg\nhttps://meshstats.serveurperso.in/ ; pas une adresse'),
    [{ url: 'https://analyzer.on8ar.eu', regions: ['BRU', 'LGG'] }, { url: 'https://meshstats.serveurperso.in', regions: [] }]);
  const st = creerStockage(path.join(dossier, 'x.db'));
  const r = creerReseauMc(st.db, config, PUBLIC);
  const OBS = 'AB'.repeat(32), REP = 'f0f3440c3ca9fc564a3339226d7b6f7add99f8ad434f7c8bc035cecebebc37da';
  let id = 100, panne = false;
  const paquets = [];
  const ajouter = (texte, iata) => paquets.push({ id: ++id, raw_hex: messagePublic(texte).toString('hex'), observer_id: OBS, observer_iata: iata, snr: 6, rssi: -95, direction: 'rx', timestamp: new Date().toISOString() });
  const faux = async (url) => {
    if (panne) throw new Error('connect ECONNREFUSED');
    const u = new URL(url), corps = { '/api/observers': { observers: [{ id: OBS, name: 'BE-BRU-Obs', iata: 'BRU', lat: 50.85, lon: 4.35, nodeRole: 'repeater', last_seen: new Date().toISOString() }] },
      '/api/nodes': { nodes: [{ public_key: REP, name: 'BE-WKD-ON4EA', role: 'repeater', lat: 50.67, lon: 5.93, last_seen: new Date().toISOString(), region_placement: { regions: ['BRU'] } },
        { public_key: 'CD'.repeat(32), name: 'Ailleurs', role: 'companion', lat: 1, lon: 1, region_placement: { regions: ['AUS'] } }] },
      '/api/packets': { packets: paquets.slice().reverse() } }[u.pathname];
    return { ok: !!corps, status: corps ? 200 : 404, json: async () => corps };
  };
  for (let k = 0; k < 5; k++) ajouter('ancien ' + k, 'BRU');
  const recus = [];
  const s = cs.creerCoreScope({ sources: [{ url: 'https://exemple.org', regions: ['BRU'] }], maxParMinute: 4, fetch: faux,
    integrer: (o) => { recus.push(o); return r.integrer(o); }, noterObservateur: r.noterObservateur, importerNoeuds: r.importerContacts });
  s._etats[0].dernierId = null;
  const tourner = async () => { s._etats[0].obsHeure = s._etats[0].obsHeure || 0; await s._tour.call(null, s._etats[0]); clearTimeout(s._etats[0].minuteur); };
  s.demarrer(); clearTimeout(s._etats[0].minuteur); // pas de minuterie pendant le test
  await tourner();
  assert.equal(r.q.noeud.get(REP.toUpperCase()).nom, 'BE-WKD-ON4EA', 'nœud importé depuis /api/nodes');
  assert.equal(r.q.noeud.get('CD'.repeat(32)), undefined, 'nœud d\'une autre zone ignoré');
  assert.equal(r.q.noeud.get(OBS).observateur, 1, 'observateur noté avec sa position');
  assert.equal(recus.length, 4, 'premier tour : plafond de 4 paquets par minute');
  assert.equal(recus[0].via, 'corescope');
  assert.equal(recus[0].snr, 6);
  ajouter('nouveau', 'BRU'); ajouter('hors zone', 'AUS');
  await tourner();
  let e = s.etat().sources[0];
  assert.equal(e.horsZone, 1);
  assert.equal(e.ecartes, 2, 'au-delà du plafond : écarté, pas mis en attente');
  assert.equal(recus.length, 4, 'aucun paquet déjà vu retraité');
  s._etats[0].fenetre.debut = 0; // minute suivante
  ajouter('après la minute', 'BRU');
  await tourner();
  assert.equal(recus[recus.length - 1].brut.toString('hex'), paquets[paquets.length - 1].raw_hex);
  panne = true;
  await tourner();
  e = s.etat().sources[0];
  assert.ok(e.enPanne && /ECONNREFUSED/.test(e.derniereErreur.message), 'panne signalée');
  s.arreter();
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

test('APRS : trames LoRa APRS décodées (non compressée, compressée, objet) et lecture d’APRS-IS en lecture seule', async () => {
  const { lireTrame, creerAprs, lireReglages } = require('../src/aprs');
  // Position non compressée d'un traqueur LoRa (tocall APLRT1), via un iGate
  const t1 = lireTrame('F4ABC-7>APLRT1,WIDE1-1,qAO,F4XYZ-10:!4502.50N/00353.10E>LoRa tracker /A=002625');
  assert.equal(t1.indicatif, 'F4ABC-7');
  assert.ok(Math.abs(t1.lat - 45.04167) < 1e-4 && Math.abs(t1.lon - 3.885) < 1e-4);
  assert.equal(t1.lora, true);
  assert.equal(t1.altitude, 800);
  assert.equal(t1.igate, 'F4XYZ-10');
  // Position compressée (exemple de la spécification APRS 1.01 : 49°30' N, 72°45' W)
  const t2 = lireTrame("F1AAA>APRS,TCPIP*:=/5L!!<*e7>7P[");
  assert.ok(Math.abs(t2.lat - 49.5) < 1e-3 && Math.abs(t2.lon + 72.75) < 1e-3);
  assert.equal(t2.lora, false);
  // Objet
  const t3 = lireTrame('F4ABC>APRS:;RELAIS-1 *111111z4500.00N/00400.00Er433.775MHz');
  assert.equal(t3.indicatif, 'RELAIS-1');
  assert.equal(t3.objet, true);
  // Mic-E (portatif ou mobile) : 45°02,50' N, 3°53,10' E dans la destination « 450RU0 », altitude 800 m en base 91
  const b91 = (n) => [Math.floor(n / 8281), Math.floor(n / 91) % 91, n % 91].map((x) => String.fromCharCode(x + 33)).join('');
  const t4 = lireTrame(`F4DEF-9>450RU0,WIDE1-1,qAR,F4XYZ-10:\`yQ&(((>/${b91(10800)}}Mobile LoRa=`);
  assert.equal(t4.indicatif, 'F4DEF-9');
  assert.ok(Math.abs(t4.lat - 45.04167) < 1e-4 && Math.abs(t4.lon - 3.885) < 1e-4, `${t4.lat} ${t4.lon}`);
  assert.equal(t4.altitude, 800);
  assert.equal(t4.micE, true);
  assert.equal(t4.lora, true);
  assert.equal(t4.commentaire, 'Mobile LoRa');
  // Mic-E à l'ouest (destination « S32U6T » : 33°25,64' N ; données « (_f » : 12°07,74' W, minutes au-delà de 60 ramenées)
  const t5 = lireTrame("N0ABC>S32U6T:`(_fn\"Oj/");
  assert.ok(Math.abs(t5.lat - 33.42733) < 1e-3 && Math.abs(t5.lon + 12.129) < 1e-3, `${t5.lat} ${t5.lon}`);
  // Mic-E au sud et à l'est au-delà de 100° (destination « 3T20P0 » : 34°20,00' S et décalage de 100° ; données « O4# » : 151°24,07' E)
  const t6 = lireTrame("VK2ABC>3T20P0:`O4#l\"Ok/");
  assert.ok(Math.abs(t6.lat + 34.33333) < 1e-4 && Math.abs(t6.lon - 151.40117) < 1e-4, `${t6.lat} ${t6.lon}`);
  // Messages et télémétrie ignorés
  assert.equal(lireTrame('F4ABC>APRS::F4XYZ    :bonjour{1'), null);
  // Indicatif obligatoire : sans lui (ou avec N0CALL), aucune connexion
  const { indicatifValide } = require('../src/aprs');
  assert.ok(indicatifValide('F4GLD') && indicatifValide('F4GLD-7') && indicatifValide('ON4XYZ-10'));
  assert.ok(!indicatifValide('N0CALL') && !indicatifValide('NOCALL') && !indicatifValide('') && !indicatifValide('ABCDEF'));
  let tentatives = 0;
  const sans = creerAprs({ zone: () => [44.7, 3.0, 45.5, 4.5], reglages: lireReglages({ APRS_IS: 'oui' }), connecter: () => { tentatives++; return null; } });
  assert.equal(tentatives, 0);
  assert.match(sans.etat().erreur, /indicatif/);
  sans.arreter();
  // Faux serveur APRS-IS : vérifie la connexion en lecture seule et le filtre de zone
  const { EventEmitter } = require('events');
  const ecrit = [];
  const sock = Object.assign(new EventEmitter(), { setEncoding() {}, setTimeout() {}, write: (x) => ecrit.push(x), destroy() {} });
  const a = creerAprs({ zone: () => [44.7, 3.0, 45.5, 4.5], reglages: lireReglages({ APRS_IS: 'oui', APRS_INDICATIF: 'f4gld' }), connecter: () => sock, version: '2.27.0' });
  sock.emit('connect');
  assert.match(ecrit[0], /^user F4GLD pass -1 vers carte-live 2\.27\.0 filter a\/45\.80\/2\.70\/44\.40\/4\.80\r\n$/);
  sock.emit('data', '# aprsc 2.1\r\nF4ABC-7>APLRT1,WIDE1-1,qAO,F4XYZ-10:!4502.50N/00353.10E>LoRa\r\nF1AAA>APRS,TCP');
  sock.emit('data', 'IP*:=/5L!!<*e7>7P[\r\n');
  const l = a.liste();
  assert.deepEqual(l.map((s) => s.indicatif).sort(), ['F1AAA', 'F4ABC-7']);
  assert.equal(a.etat().connecte, true);
  a.arreter();
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

// Non-régression (17/11) : l'historique d'un canal calme ne doit ni disparaître après 7 jours (purge générale),
// ni être caché par les 300 derniers messages des canaux bavards
test('Messages : conservés plus longtemps que le trafic, historique d’un seul canal', () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-'));
  const { creerStockage } = require('../src/base');
  const st = creerStockage(path.join(dossier, 'x.db'));
  const j = 86400000, t = Date.now();
  const ins = (canal, port, age, texte, vers = 4294967295) => st.db.prepare('INSERT INTO paquets (de, vers, canal, port, heure, texte) VALUES (?, ?, ?, ?, ?, ?)').run(1, vers, canal, port, t - age, texte);
  ins('ADRASEC43', 'texte', 20 * j, 'vieux message du canal calme');
  ins('ADRASEC43', 'position', 20 * j, null);
  ins('ADRASEC43', 'texte', 120 * j, 'trop vieux');
  for (let i = 0; i < 400; i++) ins('Fr_BlaBla', 'texte', i * 60000, 'bavard ' + i);
  ins('Fr_BlaBla', 'texte', 60000, 'direct', 1234);
  st.purger(7, 90);
  const restant = st.db.prepare("SELECT port, texte FROM paquets WHERE canal = 'ADRASEC43'").all();
  assert.deepEqual(restant.map((x) => x.texte), ['vieux message du canal calme']);
  assert.ok(!st.q.messages.all(300).some((m) => m.canal === 'ADRASEC43'), 'noyé dans les 300 derniers');
  assert.equal(st.q.messagesCanal.all('ADRASEC43', 500).length, 1);
  assert.deepEqual(st.q.messagesDirects.all(500).map((m) => m.vers), [1234]);
  st.db.close();
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('Rivières (Hub’Eau) : stations, hauteur, tendance, seuil et alertes', async () => {
  const { creerRivieres, lireReglages, lireSeuils } = require('../src/rivieres');
  assert.deepEqual([...lireSeuils('K0010020=2,5 ; K011402001: 3').entries()], [['K0010020', 2.5], ['K011402001', 3]]);
  const t = Date.now(), iso = (ms) => new Date(t - ms).toISOString();
  const urls = [];
  const recuperer = async (u) => {
    urls.push(u);
    const corps = u.includes('/referentiel/stations')
      ? { data: [{ code_station: 'K001002010', code_site: 'K0010020', libelle_station: 'La Loire à Bas', libelle_cours_eau: 'La Loire', longitude_station: 4.1, latitude_station: 45.2 },
        { code_station: 'K002002010', code_site: 'K0020020', libelle_station: 'La Borne au Puy', libelle_cours_eau: 'La Borne', longitude_station: 3.88, latitude_station: 45.04 }] }
      : { data: [
        { code_station: 'K001002010', grandeur_hydro: 'H', date_obs: iso(65 * 60000), resultat_obs: 1500 },
        { code_station: 'K001002010', grandeur_hydro: 'H', date_obs: iso(5 * 60000), resultat_obs: 1900 },
        { code_station: 'K001002010', grandeur_hydro: 'Q', date_obs: iso(5 * 60000), resultat_obs: 123400 },
        { code_station: 'K002002010', grandeur_hydro: 'H', date_obs: iso(65 * 60000), resultat_obs: 800 },
        { code_station: 'K002002010', grandeur_hydro: 'H', date_obs: iso(5 * 60000), resultat_obs: 810 },
      ] };
    return { ok: true, status: 200, json: async () => corps };
  };
  const r = creerRivieres({ zone: () => [44.7, 3.0, 45.5, 4.5], reglages: lireReglages({ RIVIERES: 'oui', RIVIERES_SEUILS: 'K0020020=0,5' }), recuperer });
  await r.releve();
  r.arreter();
  assert.match(urls[0], /bbox=3\.000,44\.700,4\.500,45\.500/);
  const l = r.liste();
  const loire = l.find((s) => s.code === 'K001002010'), borne = l.find((s) => s.code === 'K002002010');
  assert.equal(loire.h, 1.9); assert.equal(loire.q, 123.4); assert.equal(loire.tendance, 40);
  assert.equal(borne.seuil, 0.5); assert.equal(borne.tendance, 1);
  const a = r.alertes();
  assert.equal(a.find((x) => x.cle === 'riviere:K001002010').niveau, 'critique'); // 40 cm/h = 2 × 20
  assert.match(a.find((x) => x.cle === 'riviere:K002002010').message, /seuil de 0,5 m dépassé/);
  assert.equal(r.serie('K001002010').mesures.length, 2);
  // Un barrage qui « monte » (manœuvre de vannes) ne déclenche pas d'alerte de crue
  const r2 = creerRivieres({ zone: () => [44.7, 3.0, 45.5, 4.5], reglages: lireReglages({ RIVIERES: 'oui' }), recuperer: async (u) => ({ ok: true, json: async () => (u.includes('/referentiel/') ? { data: [{ code_station: 'K043303001', code_site: 'K0433030', libelle_station: 'Le Lignon à Grazac - Barrage de la Chapelette', longitude_station: 4.18, latitude_station: 45.17 }] } : { data: [{ code_station: 'K043303001', grandeur_hydro: 'H', date_obs: iso(65 * 60000), resultat_obs: -2500 }, { code_station: 'K043303001', grandeur_hydro: 'H', date_obs: iso(5 * 60000), resultat_obs: -1900 }] }) }) });
  await r2.releve(); r2.arreter();
  assert.equal(r2.liste()[0].retenue, true);
  assert.equal(r2.alertes().length, 0);
});

test('LoRaWAN : remontées TTN v3 et ChirpStack v4, positions, seuils, abonnement MQTT', () => {
  const { creerLorawan, lireReglages, lireRemontee, lirePositions, lireSeuils } = require('../src/lorawan');
  assert.deepEqual(lirePositions('niveau-borne=45,04;3,88 | meteo=44.92,4.19').get('niveau-borne'), { lat: 45.04, lon: 3.88 });
  assert.deepEqual(lireSeuils('niveau-borne.hauteur > 1,5 ; batterie < 3,3'), [{ capteur: 'niveau-borne', champ: 'hauteur', sens: '>', valeur: 1.5 }, { capteur: null, champ: 'batterie', sens: '<', valeur: 3.3 }]);
  const ttn = JSON.stringify({
    end_device_ids: { device_id: 'niveau-borne', dev_eui: '70B3D57ED0000001', application_ids: { application_id: 'crues-43' } }, received_at: new Date().toISOString(),
    uplink_message: { f_port: 2, decoded_payload: { hauteur: 1.82, batterie: 3.6, meteo: { temperature: 7.5 }, latitude: 45.04, longitude: 3.88 },
      rx_metadata: [{ gateway_ids: { gateway_id: 'gw-puy' }, rssi: -97, snr: 6.5, location: { latitude: 45.05, longitude: 3.9 } }] },
  });
  const t = lireRemontee('v3/crues-43@ttn/devices/niveau-borne/up', ttn);
  assert.equal(t.source, 'ttn'); assert.deepEqual(t.mesures, { hauteur: 1.82, batterie: 3.6, 'meteo.temperature': 7.5 });
  assert.deepEqual(t.position, { lat: 45.04, lon: 3.88 }); assert.equal(t.passerelles[0].snr, 6.5);
  const cs = JSON.stringify({ deviceInfo: { deviceName: 'pluvio-1', devEui: '0011223344556677', applicationName: 'meteo' }, time: new Date().toISOString(), fPort: 1, object: { pluie: 2.4 }, rxInfo: [{ gatewayId: 'aa55', rssi: -110, snr: -3 }] });
  const c = lireRemontee('application/x/device/0011223344556677/event/up', cs);
  assert.equal(c.source, 'chirpstack'); assert.equal(c.id, 'pluvio-1'); assert.equal(c.mesures.pluie, 2.4); assert.equal(c.position, null);
  // Faux client MQTT : abonnement aux sujets, remontées intégrées, seuils
  const evts = {}; let abonne = null, opts = null;
  const faux = { on: (e, f) => { evts[e] = f; }, subscribe: (s) => { abonne = s; }, end() {} };
  const l = creerLorawan({ reglages: lireReglages({ LORAWAN: 'oui', LORAWAN_UTILISATEUR: 'crues-43@ttn', LORAWAN_MOT_DE_PASSE: 'NNSXS.x', LORAWAN_POSITIONS: 'pluvio-1=45,1;3,95', LORAWAN_SEUILS: 'niveau-borne.hauteur > 1,5 ; pluie > 5' }), connecter: (u, o) => { opts = { u, ...o }; return faux; } });
  evts.connect();
  assert.equal(opts.u, 'mqtts://eu1.cloud.thethings.network:8883'); assert.equal(opts.username, 'crues-43@ttn');
  assert.deepEqual(abonne, ['v3/+/devices/+/up', 'application/+/device/+/event/up']);
  evts.message('v3/crues-43@ttn/devices/niveau-borne/up', Buffer.from(ttn));
  evts.message('application/x/device/0011223344556677/event/up', Buffer.from(cs));
  const liste = l.liste();
  assert.equal(liste.length, 2);
  assert.equal(liste.find((x) => x.id === 'pluvio-1').lat, 45.1);
  assert.equal(l.passerelles().length, 1);
  const a = l.alertes();
  assert.equal(a.length, 1); assert.match(a[0].message, /hauteur = 1,82 \(seuil > 1,5\)/);
  assert.equal(l.serie('niveau-borne').series.hauteur.length, 1);
  // Sans identifiant : pas de connexion, erreur explicite
  let tente = false;
  const sans = creerLorawan({ reglages: lireReglages({ LORAWAN: 'oui' }), connecter: () => { tente = true; return faux; } });
  assert.equal(tente, false); assert.match(sans.etat().erreur, /identifiant/);
});

test('MeshCore : sauvegarde du configurateur importée sans secrets, comparée au preset français', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { creerMaintenanceMc } = require('../src/meshcore/maintenance');
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cfg-'));
  const noeuds = [{ cle: 'A'.repeat(64), nom: 'Relais Mezenc', role: 'repeteur', lat: 44.9, lon: 4.19, dernier_vu: Date.now() }];
  const m = creerMaintenanceMc({
    config: { fichierBase: path.join(dossier, 'base.db'), zone: [44, 3, 46, 5] }, journal: () => {},
    reseauMc: { q: { noeuds: { all: () => noeuds } }, annoncesDe: () => ({ annonces: 3, inondations: 9, tailles: [1] }) },
    adminMc: { memorises: () => [], lecture: () => null, ELEMENTS: [], ELEMENTS_DEFAUT: [] }, companion: {},
  });
  assert.throws(() => m.importerConfiguration({ format: 'autre' }), /configurateur/);
  const f = m.importerConfiguration({ format: 'meshcore-config', version: 1, date: '2026-11-17T18:00:00Z', carte: 'Heltec V3', nom: 'Relais Mezenc', firmware: 'v1.16',
    commandes: ['set radio 869.525,250,11,5', 'set name Relais Mezenc', 'set lat 44.9', 'set lon 4.19', 'password secret123', 'set prv.key ABCDEF', 'region put fr', 'region put fr-43'],
    identite: { cle_publique: 'a'.repeat(64) } }, 'admin');
  assert.equal(f.cle, 'A'.repeat(64)); assert.deepEqual(f.regions, ['fr', 'fr-43']); assert.equal(f.radio, '869.525,250,11,5');
  assert.ok(!f.commandes.some((c) => /password|prv\.key/.test(c)), 'aucun secret gardé');
  assert.ok(!fs.readFileSync(path.join(dossier, 'meshcore-configurations.json'), 'utf8').includes('secret123'));
  const n = m.etat().noeuds[0];
  assert.equal(n.configuration.carte, 'Heltec V3');
  assert.ok(n.aFaire.some((t) => /preset français/.test(t)));
  assert.ok(n.aFaire.some((t) => /nom sans numéro de département/.test(t)));
  assert.ok(n.aFaire.some((t) => /path\.hash\.mode 1/.test(t)));
  assert.ok(n.aFaire.some((t) => /9 annonces en inondation/.test(t)));
});

test('Jeux de canaux : placement sur la radio (ajout, déjà présent, place à libérer, canaux gardés groupés)', () => {
  const { planifier } = require('../src/jeux-canaux');
  const K = (n) => Buffer.alloc(32, n).toString('base64');
  const vide = { nom: '', cle: '', role: 'DISABLED' };
  const actuels = [{ nom: '', cle: 'AQ==', role: 'PRIMARY' }, { nom: 'Fr_Balise', cle: 'AQ==', role: 'SECONDARY' }, { nom: 'ADRASEC43', cle: K(1), role: 'SECONDARY', precision: 32 }, { nom: 'Perso', cle: K(2), role: 'SECONDARY', precision: 13 }, vide, vide, vide, vide];
  const ajouts = [{ nom: 'ADRASEC43', psk: Buffer.alloc(32, 1) }, { nom: 'Alerte', psk: Buffer.from([1]) }];
  let r = planifier(actuels, ajouts);
  assert.deepEqual(r.deja, ['ADRASEC43']);
  assert.deepEqual(r.ops.map((o) => [o.index, o.nom]), [[4, 'Alerte']]);
  // Fr_Balise libéré : les suivants remontent d'un cran, avec leurs réglages, et rien d'autre ne bouge
  r = planifier(actuels, ajouts, [1]);
  assert.deepEqual(r.ops.map((o) => [o.index, o.supprimer ? '-' : o.nom]), [[1, 'ADRASEC43'], [2, 'Perso'], [3, 'Alerte']]);
  assert.equal(r.ops[1].precision, 13);
  assert.ok(Buffer.from(r.ops[1].psk).equals(Buffer.alloc(32, 2)));
  // Même nom, autre clé : le canal du jeu le remplace à sa place
  r = planifier(actuels, [{ nom: 'Perso', psk: Buffer.alloc(32, 9) }]);
  assert.deepEqual(r.ops.map((o) => [o.index, o.nom]), [[3, 'Perso']]);
  // Radio pleine : il manque des places tant que rien n'est libéré ; le canal 0 n'apparaît jamais
  const plein = [actuels[0], ...[1, 2, 3, 4, 5, 6, 7].map((i) => ({ nom: 'C' + i, cle: 'AQ==', role: 'SECONDARY' }))];
  assert.equal(planifier(plein, ajouts).manque, 2);
  r = planifier(plein, ajouts, [2, 5]);
  assert.equal(r.manque, 0);
  assert.ok(r.ops.every((o) => o.index >= 1 && o.index <= 7));
  assert.deepEqual(r.final.map((c) => c.nom), ['C1', 'C3', 'C4', 'C6', 'C7', 'ADRASEC43', 'Alerte']);
});

test('Profil de relief hors de France : l’IGN sans altitude → repli mondial, fréquence de la zone', async () => {
  const { creerAnalyse } = require('../src/analyse');
  const fetchAvant = global.fetch, freqAvant = process.env.RADIO_FREQ_MHZ;
  const appels = [];
  global.fetch = async (url) => {
    appels.push(String(url));
    if (/geopf/.test(url)) return { ok: true, json: async () => ({ elevations: Array.from({ length: 60 }, () => ({ lat: 40.6, lon: -74.5, z: -99999 })) }) };
    const n = String(url).match(/latitude=([^&]+)/)[1].split(',').length;
    return { ok: true, json: async () => ({ elevation: Array.from({ length: n }, (_, i) => 20 + i) }) };
  };
  process.env.RADIO_FREQ_MHZ = '906.875';
  try {
    const a = creerAnalyse({ db: { prepare: () => ({ all: () => [], get: () => null, run: () => ({}) }) }, noeud: new Map(), liens: { all: () => [] } }, { retentionJours: 7 }, { vueNoeud: (n) => n }, () => 'LONG_FAST');
    const r = await a.profil({ a: NaN, b: NaN, aLat: 40.6275, aLon: -74.464, bLat: 40.6181, bLon: -74.5271, ha: 3, hb: 3, preset: 'LONG_FAST', membre: true });
    assert.match(r.sourceAltitude, /Open-Meteo/);
    assert.equal(r.serie[0].sol, 20);
    assert.equal(r.parametres.frequenceMHz, 906.875);
    assert.ok(appels.some((u) => /geopf/.test(u)) && appels.some((u) => /open-meteo/.test(u)));
  } finally { global.fetch = fetchAvant; if (freqAvant === undefined) delete process.env.RADIO_FREQ_MHZ; else process.env.RADIO_FREQ_MHZ = freqAvant; }
});

test('Sujet racine MQTT saisi avec « /# » : corrigé (sinon abonnement …/#/# refusé, plus aucun paquet)', () => {
  const { execFileSync } = require('child_process');
  const lire = (racine) => execFileSync(process.execPath, ['-e', "const c=require('./src/config.js');console.log((c.config||c).mqtt.racine)"], { cwd: path.join(__dirname, '..'), env: { ...process.env, MQTT_RACINE: racine } }).toString().trim();
  assert.equal(lire('msh/US/#'), 'msh/US');
  assert.equal(lire('msh/+/2/e/LongFast/#'), 'msh/+/2/e/LongFast');
  assert.equal(lire('msh/EU_868/'), 'msh/EU_868');
  assert.equal(lire('msh/US'), 'msh/US');
});

test('Meshtastic 2.8 : signature XEdDSA d’un paquet vérifiée par la carte (clé Curve25519 du nœud)', () => {
  const sig = require('../src/signature');
  const P = 2n ** 255n - 19n;
  const mp = (b, e) => { let r = 1n; b %= P; while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; };
  const big = (b) => { let x = 0n; for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]); return x; };
  const oct = (x) => { const b = Buffer.alloc(32); for (let i = 0; i < 32; i++) { b[i] = Number(x & 255n); x >>= 8n; } return b; };
  // Paire Ed25519 au bit de signe nul (forme XEdDSA) et clé Curve25519 correspondante (u = (1+y)/(1-y))
  let kp, ed;
  do { kp = crypto.generateKeyPairSync('ed25519'); ed = Buffer.from(kp.publicKey.export({ format: 'jwk' }).x, 'base64url'); } while (ed[31] & 0x80);
  const y = big(ed);
  const curve = oct(((1n + y) * mp((1n - y + P) % P, P - 2n)) % P).toString('base64');
  const de = sig.numDeCle(curve); // numéro 2.8 = CRC32 de la clé
  const idPaquet = 0x1234abcd, cle = cleDe('LongFast');
  const data = { portnum: PORT.TEXTE, payload: Buffer.from('signé par F4GLD'), bitfield: 1 };
  data.xeddsaSignature = crypto.sign(null, sig.messageSigne(de, idPaquet, 0xffffffff, data), kp.privateKey);
  const chiffre = mt.dechiffrer(cle, idPaquet, de, Buffer.from(mt.types.Data.encode(data).finish()));
  const paquet = { from: de, to: 0xffffffff, id: idPaquet, channel: mt.hachageCanal('LongFast', cle), encrypted: chiffre, hopStart: 3, hopLimit: 2 };
  const env = Buffer.from(mt.types.ServiceEnvelope.encode({ packet: paquet, channelId: 'LongFast', gatewayId: '!5a1e0001' }).finish());
  const evt = mt.decoderMessage('msh/EU_868/2/e/LongFast/!5a1e0001', env, CANAUX);
  assert.ok(evt.aVerifier && evt.aVerifier.sig.length === 64, 'signature extraite');
  assert.ok(!Object.keys(evt).includes('aVerifier'), 'jamais sérialisée');
  assert.equal(sig.verifier(curve, evt.aVerifier.msg, evt.aVerifier.sig), true);
  // Autre clé, ou charge modifiée : refusée
  const autre = crypto.randomBytes(32).toString('base64');
  assert.equal(sig.verifier(autre, evt.aVerifier.msg, evt.aVerifier.sig), false);
  const m2 = Buffer.from(evt.aVerifier.msg); m2[m2.length - 1] ^= 1;
  assert.equal(sig.verifier(curve, m2, evt.aVerifier.sig), false);
});

test('Firmware 2.8 : fusion d’un nœud renuméroté puis annulation (historique rendu à l’ancien numéro)', () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'renum-'));
  const { creerStockage } = require('../src/base');
  const { creerRenumerotation } = require('../src/renumerotation');
  const sig = require('../src/signature');
  const st = creerStockage(path.join(dossier, 'x.db'));
  const db = st.db;
  const cle = crypto.randomBytes(32).toString('base64');
  const ancien = 0x0a0b0c0d, nouveau = sig.numDeCle(cle), voisin = 0x11111111;
  const t0 = Date.now() - 86400000;
  db.prepare('INSERT INTO noeuds (num, nom_long, nom_court, materiel, cle_publique, premier_vu, dernier_vu, lat, lon) VALUES (?,?,?,?,?,?,?,?,?)').run(ancien, 'Relais Mézenc', 'MZC', 'HELTEC_V3', cle, t0, t0 + 3600000, 44.91, 4.19);
  db.prepare('INSERT INTO noeuds (num, cle_publique, premier_vu, dernier_vu) VALUES (?,?,?,?)').run(nouveau, cle, t0 + 4000000, Date.now());
  db.prepare('INSERT INTO noeuds (num, premier_vu, dernier_vu) VALUES (?,?,?)').run(voisin, t0, Date.now());
  for (let i = 0; i < 5; i++) db.prepare('INSERT INTO positions (num, heure, lat, lon) VALUES (?,?,?,?)').run(ancien, t0 + i, 44.91, 4.19);
  db.prepare('INSERT INTO telemetrie (num, heure, batterie) VALUES (?,?,?)').run(ancien, t0, 87);
  db.prepare("INSERT INTO paquets (id_paquet, de, vers, heure, port) VALUES (1, ?, 4294967295, ?, 'texte')").run(ancien, t0);
  db.prepare("INSERT INTO paquets (id_paquet, de, vers, heure, port) VALUES (2, ?, ?, ?, 'texte')").run(voisin, ancien, t0);
  db.prepare("INSERT INTO liens (a, b, source, snr, premier_vu, dernier_vu) VALUES (?, ?, 'rf', 5, ?, ?)").run(ancien, voisin, t0, t0);
  db.prepare("INSERT INTO liens (a, b, source, snr, premier_vu, dernier_vu) VALUES (?, ?, 'rf', 2, ?, ?)").run(nouveau, voisin, t0, t0); // conflit : supprimé puis rendu
  const appels = [];
  const espion = (nom) => (a, b) => { appels.push(`${nom} ${a}>${b}`); return 1; };
  const r = creerRenumerotation({
    stockage: st, config: { fichierBase: path.join(dossier, 'x.db') }, journal: () => {},
    installations: { deplacer: espion('fiche') }, comptes: { remplacerNoeud: espion('secteurs') }, administration: { renumeroter: espion('admin') },
    autres: () => ({ equipes: { renumeroter: espion('equipes') }, suivis: { renumeroter: espion('suivis') }, responsables: { remplacerNoeud: espion('resp') } }),
  });
  const d = r.detecter();
  assert.equal(d.renumerotations.length, 1);
  assert.equal(d.renumerotations[0].certain, true, 'numéro dérivé de la clé : certain');
  const h = r.fusionner(ancien, nouveau, 'essai');
  assert.equal(h.lignes.positions, 5);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM noeuds WHERE num = ?').get(ancien).n, 0);
  assert.equal(db.prepare('SELECT nom_long FROM noeuds WHERE num = ?').get(nouveau).nom_long, 'Relais Mézenc');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM paquets WHERE vers = ?').get(nouveau).n, 1);
  assert.ok(appels.includes(`equipes ${ancien}>${nouveau}`) && appels.includes(`suivis ${ancien}>${nouveau}`) && appels.includes(`resp ${ancien}>${nouveau}`));
  assert.equal(r.detecter().historique[0].annulable, true);
  // Après la fusion, le nouveau numéro reçoit encore des positions : elles lui restent après l'annulation
  db.prepare('INSERT INTO positions (num, heure, lat, lon) VALUES (?,?,?,?)').run(nouveau, Date.now(), 44.9, 4.2);
  const a = r.annuler(h.heure, ancien, nouveau, 'essai');
  assert.ok(a.annule);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM positions WHERE num = ?').get(ancien).n, 5);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM positions WHERE num = ?').get(nouveau).n, 1);
  assert.equal(db.prepare('SELECT nom_long FROM noeuds WHERE num = ?').get(ancien).nom_long, 'Relais Mézenc');
  assert.equal(db.prepare('SELECT nom_long FROM noeuds WHERE num = ?').get(nouveau).nom_long, null, 'le nom recopié par la fusion est retiré');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM liens WHERE a = ?').get(ancien).n, 1, 'liaison en conflit rendue');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM paquets WHERE vers = ?').get(ancien).n, 1);
  assert.ok(appels.includes(`fiche ${nouveau}>${ancien}`) && appels.includes(`equipes ${nouveau}>${ancien}`));
  assert.throws(() => r.annuler(h.heure, ancien, nouveau, 'essai'), /déjà annulée/);
  // Clés différentes : refus, sauf fusion forcée avec même nom et même matériel
  const vieux = 0x0e0e0e0e, cle2 = crypto.randomBytes(32).toString('base64'), n2 = sig.numDeCle(cle2);
  db.prepare('INSERT INTO noeuds (num, nom_long, materiel, cle_publique, premier_vu, dernier_vu) VALUES (?,?,?,?,?,?)').run(vieux, 'Relais du Pic', 'RAK4631', crypto.randomBytes(32).toString('base64'), t0, t0 + 1000);
  db.prepare('INSERT INTO noeuds (num, nom_long, materiel, cle_publique, premier_vu, dernier_vu) VALUES (?,?,?,?,?,?)').run(n2, 'Relais du Pic', 'RAK4631', cle2, Date.now(), Date.now());
  assert.ok(r.detecter().probables.some((p) => p.ancien.num === vieux && p.nouveau.num === n2), 'réinitialisé : proposé');
  assert.throws(() => r.fusionner(vieux, n2, 'essai'), /même clé/);
  assert.equal(r.fusionner(vieux, n2, 'essai', { force: true }).force, true);
  db.close();
  fs.rmSync(dossier, { recursive: true, force: true });
});

// ---------- Secteurs d'alerte (géorepérage) et mode urgence ----------
const geo = require('../src/secteurs');
// Point à d mètres au nord (ou au sud si d < 0) d'un point donné
const auNord = (p, d) => ({ lat: p.lat + d / 111195, lon: p.lon });
function secteursEssai(extra = {}) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'secteurs-'));
  const horloge = { t: Date.UTC(2026, 10, 21, 8, 0, 0) };
  const diffuses = [], evenements = [], lora = [];
  const s = geo.creerSecteurs({
    config: { fichierBase: path.join(dossier, 'base.db') }, intervalleMs: 0, maintenant: () => horloge.t,
    membresEquipe: (id) => (id === 'eq1' ? [0x5a1e0001, 0x5a1e0002] : []), nomEquipe: (id) => (id === 'eq1' ? 'Equipe1' : null),
    nomDe: (k) => ({ 'mt:1511915521': 'Alpha' })[k] || null,
    diffuser: (m) => diffuses.push(m), surEvenement: (e) => evenements.push(e), envoyerLora: (t, c) => lora.push([t, c]), ...extra,
  });
  return { s, horloge, diffuses, evenements, lora, dossier };
}
const CENTRE = { lat: 45.0434, lon: 3.8851 };

test('Secteurs : géométrie (point dans polygone, distance signée, précision des positions floutées)', () => {
  const carre = [[45.00, 3.80], [45.00, 3.90], [45.05, 3.90], [45.05, 3.80]];
  assert.equal(geo.pointDansPolygone({ lat: 45.02, lon: 3.85 }, carre), true);
  assert.equal(geo.pointDansPolygone({ lat: 45.06, lon: 3.85 }, carre), false);
  // Polygone concave (en U) : le creux est dehors
  const u = [[45.0, 3.8], [45.0, 3.9], [45.05, 3.9], [45.05, 3.87], [45.01, 3.87], [45.01, 3.83], [45.05, 3.83], [45.05, 3.8]];
  assert.equal(geo.pointDansPolygone({ lat: 45.03, lon: 3.85 }, u), false, 'creux du U');
  assert.equal(geo.pointDansPolygone({ lat: 45.03, lon: 3.81 }, u), true, 'branche du U');
  const d = geo.distanceLimite({ forme: 'polygone', points: carre }, { lat: 45.06, lon: 3.85 });
  assert.ok(Math.abs(d - 1112) < 5, `≈ 1,1 km au nord du bord : ${d}`);
  assert.ok(geo.distanceLimite({ forme: 'polygone', points: carre }, { lat: 45.045, lon: 3.85 }) < 0, 'dedans : distance négative');
  const c = { forme: 'cercle', centre: CENTRE, rayon: 1000 };
  assert.ok(Math.abs(geo.distanceLimite(c, auNord(CENTRE, 1500)) - 500) < 1);
  assert.ok(Math.abs(geo.distanceLimite(c, CENTRE) + 1000) < 1e-6);
  assert.ok(Math.abs(geo.tailleSecteur({ forme: 'polygone', points: carre }) - Math.sqrt(5560 * 7870 / Math.PI)) < 60);
  assert.equal(geo.incertitude(32), 0); assert.equal(geo.incertitude(null), 0); assert.equal(geo.incertitude(0), 0);
  assert.ok(Math.abs(geo.incertitude(13) - 2918) < 2, 'précision 13 bits ≈ 2,9 km');
  assert.ok(Math.abs(geo.incertitude(16) - 365) < 2, 'précision 16 bits ≈ 364 m');
  assert.throws(() => geo.valider({ nom: 'x', forme: 'polygone', points: [[45, 3], [45.0001, 3]], noeuds: [1] }), /3 à 200 sommets/);
  assert.throws(() => geo.valider({ nom: 'x', forme: 'polygone', points: [[45, 3], [45.00001, 3], [45, 3.00001]], noeuds: [1] }), /trop petit/);
  assert.throws(() => geo.valider({ nom: 'x', forme: 'cercle', centre: CENTRE, rayon: 500 }), /équipe ou à des nœuds/);
  assert.throws(() => geo.valider({ nom: 'x', forme: 'cercle', centre: CENTRE, rayon: 10 }), /Rayon/);
  assert.throws(() => geo.valider({ nom: 'x', forme: 'cercle', centre: CENTRE, rayon: 500, noeudsMc: ['AB'] }), /64 caractères/);
});

test('Secteurs : sortie confirmée par 2 positions, bordure et aller-retour sans alerte, anti-rebond, LoRa', () => {
  const { s, horloge, evenements, lora, diffuses, dossier } = secteursEssai();
  const sec = s.creer({ nom: 'Mézenc nord', forme: 'cercle', centre: CENTRE, rayon: 1000, equipe: 'eq1', marge: 50, confirmations: 2, delaiMin: 10, canalLora: 1 }, 'essai');
  assert.equal(sec.membres.length, 2, 'membres de l’équipe suivis');
  const A = 'mt:' + 0x5a1e0001;
  let id = 0;
  const pos = (d, extra = {}) => { horloge.t += 60000; return s.position(A, { ...auNord(CENTRE, 1000 + d), id: ++id, ...extra }); };
  pos(-500); pos(-400);
  assert.equal(s.secteur(sec.id).membres.find((m) => m.cle === A).etat, 'dedans', 'deux positions dedans : état connu');
  assert.equal(evenements.filter((e) => e.notifier).length, 0, 'aucune alerte en entrant au départ');
  pos(30); pos(40); // dans la marge de 50 m : bordure
  assert.equal(s.secteur(sec.id).membres.find((m) => m.cle === A).etat, 'dedans', 'bordure : rien ne change');
  pos(200); pos(-100); pos(200); // aller-retour : jamais deux positions dehors de suite
  assert.equal(evenements.filter((e) => e.type === 'sortie').length, 0, 'aller-retour sans alerte');
  pos(300);
  const sortie = evenements.filter((e) => e.type === 'sortie');
  assert.equal(sortie.length, 1); assert.equal(sortie[0].notifier, true); assert.equal(sortie[0].nom, 'Alpha');
  assert.match(sortie[0].message, /Alpha est sorti du secteur \(300 m au-delà de la limite\)/);
  assert.equal(lora.length, 1); assert.equal(lora[0][1], 1); assert.match(lora[0][0], /Alpha hors secteur Mézenc nord/);
  assert.ok(diffuses.some((m) => m.genre === 'secteur-alerte' && m.type === 'sortie' && m.niveau === 'critique'));
  const al = s.alertes();
  assert.equal(al.length, 1); assert.equal(al[0].niveau, 'critique'); assert.equal(al[0].noeud, 0x5a1e0001);
  assert.equal(al[0].cle, `secteur:${sec.id}:${A}:dehors:${sortie[0].heure}`, 'clé d’alerte = heure de l’événement');
  // Même paquet reçu par une autre passerelle : compté une fois
  const avant = evenements.length;
  s.position(A, { ...auNord(CENTRE, 500), id }); s.position(A, { ...auNord(CENTRE, 500), id });
  assert.equal(evenements.length, avant, 'doublon ignoré');
  // Retour puis nouvelle sortie dans les 10 min : notée, pas notifiée
  pos(-300); pos(-300); pos(400); pos(400);
  const deux = evenements.filter((e) => e.type === 'sortie');
  assert.equal(deux.length, 2); assert.equal(deux[1].notifier, false); assert.match(deux[1].detail, /délai minimal/);
  assert.equal(lora.length, 1, 'pas de second message LoRa');
  // Après le délai : notifiée de nouveau
  pos(-300); pos(-300); horloge.t += 11 * 60000; pos(400); pos(400);
  assert.equal(evenements.filter((e) => e.type === 'sortie' && e.notifier).length, 2);
  // Journal et CSV
  const j = s.journal({ secteur: sec.id });
  assert.equal(j[0].type, 'sortie'); assert.ok(j.some((e) => e.type === 'creation'));
  assert.match(s.csv(), /^heure_utc;heure_locale;secteur;type;noeud;nom;lat;lon/);
  assert.match(s.csv(), /!5a1e0001;Alpha/);
  s.arreter();
  // Rechargé depuis le fichier : secteurs, état et journal conservés
  const r = geo.creerSecteurs({ config: { fichierBase: path.join(dossier, 'base.db') }, intervalleMs: 0, membresEquipe: () => [0x5a1e0001], nomEquipe: () => 'Equipe1' });
  assert.equal(r.liste()[0].membres[0].etat, 'dehors');
  assert.ok(r.journal().length >= 5);
  r.arreter();
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('Secteurs : position floutée trop imprécise ignorée, secteur « entrée », perte de contact, MeshCore', () => {
  const { s, horloge, evenements, dossier } = secteursEssai();
  const sec = s.creer({ nom: 'Petit', forme: 'cercle', centre: CENTRE, rayon: 1000, noeuds: [0x5a1e0009], confirmations: 1 }, 'essai');
  const K = 'mt:' + 0x5a1e0009;
  s.position(K, { ...auNord(CENTRE, 5000), precision: 13, id: 1 }); // ± 2,9 km sur un secteur de 1 km
  s.position(K, { ...auNord(CENTRE, 6000), precision: 13, id: 2 });
  assert.equal(evenements.filter((e) => e.type === 'imprecise').length, 1, 'noté une seule fois');
  assert.equal(evenements.filter((e) => e.type === 'sortie').length, 0, 'pas d’alerte sur une position floue');
  // 16 bits (± 364 m) : utilisable, mais la marge s'élargit d'autant
  s.position(K, { ...auNord(CENTRE, 1000 + 300), precision: 16, id: 3 });
  assert.equal(evenements.filter((e) => e.type === 'sortie').length, 0, '300 m dehors à ± 364 m : bordure');
  s.position(K, { ...auNord(CENTRE, 1000 + 600), precision: 16, id: 4 });
  assert.equal(evenements.filter((e) => e.type === 'sortie').length, 1, '600 m dehors à ± 364 m : sortie');
  // Secteur « entrée » (zone à éviter), nœud MeshCore
  const CLE = 'AB'.repeat(32);
  const z = s.creer({ nom: 'Zone dangereuse', forme: 'polygone', points: [[45.00, 3.80], [45.00, 3.82], [45.02, 3.82], [45.02, 3.80]], noeudsMc: [CLE], sens: 'entree', confirmations: 1, marge: 0, silenceMin: 15, delaiMin: 5 }, 'essai');
  s.position('mc:' + CLE, { lat: 45.05, lon: 3.81, id: 'x1' });
  assert.equal(evenements.filter((e) => e.secteur === z.id && e.notifier).length, 0, 'dehors au départ : rien');
  horloge.t += 60000;
  s.position('mc:' + CLE, { lat: 45.01, lon: 3.81, id: 'x2' });
  const ent = evenements.find((e) => e.secteur === z.id && e.type === 'entree');
  assert.ok(ent && ent.notifier && /est entré dans le secteur/.test(ent.message));
  assert.ok(s.alertes().some((a) => a.secteur === z.id && a.noeudMc === CLE && a.niveau === 'critique'));
  // Perte de contact : 16 min sans position
  horloge.t += 16 * 60000;
  s.verifierSilences();
  const sil = evenements.find((e) => e.type === 'silence');
  assert.ok(sil && sil.notifier && sil.minutes === 16);
  assert.ok(s.alertes().some((a) => a.cle.includes(':silence:') && a.niveau === 'attention'));
  s.verifierSilences();
  assert.equal(evenements.filter((e) => e.type === 'silence').length, 1, 'une seule fois par épisode');
  s.position('mc:' + CLE, { lat: 45.01, lon: 3.81, id: 'x3' });
  assert.ok(evenements.some((e) => e.type === 'contact'));
  assert.ok(!s.alertes().some((a) => a.cle.includes(':silence:')));
  // Renumérotation 2.8 : le nœud garde son secteur
  s.renumeroter(0x5a1e0009, 0x5a1e000a);
  assert.deepEqual(s.secteur(sec.id).noeuds, [0x5a1e000a]);
  assert.equal(s.secteur(sec.id).membres[0].etat, 'dehors');
  s.supprimer(z.id, 'essai');
  assert.equal(s.liste().length, 1);
  s.arreter();
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('Mode urgence : activation, journal sans doublon, note, fin, archive et export CSV', () => {
  const { creerUrgence } = require('../src/urgence');
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'urgence-'));
  const config = { fichierBase: path.join(dossier, 'base.db') };
  const diffuses = [];
  let t = Date.UTC(2026, 10, 21, 9, 0, 0);
  const u = creerUrgence({ config, diffuser: (m) => diffuses.push(m), maintenant: () => t });
  assert.equal(u.actif(), false);
  assert.equal(u.noter({ texte: 'rien' }), null, 'hors crise : rien n’est noté');
  assert.throws(() => u.desactiver('essai'), /pas actif/);
  u.activer({ motif: 'Recherche de personne, Mézenc' }, 'f4gld');
  assert.equal(u.actif(), true);
  assert.throws(() => u.activer({}, 'x'), /déjà actif/);
  assert.ok(diffuses.some((m) => m.genre === 'urgence' && m.actif && m.motif === 'Recherche de personne, Mézenc'));
  t += 60000;
  assert.ok(u.noter({ cle: 'equipe-sos:a:b', type: 'sos', niveau: 'critique', texte: 'Demande d’aide de Alpha', noeud: 0x5a1e0001, lat: 45.1, lon: 4.1 }));
  assert.equal(u.noter({ cle: 'equipe-sos:a:b', type: 'sos', texte: 'Demande d’aide de Alpha' }), null, 'même clé : une seule fois');
  u.note('Équipe 2 partie vers le col', 'f4gld');
  assert.throws(() => u.note('  ', 'f4gld'), /vide/);
  assert.equal(u.evenements()[0].type, 'note');
  // Redémarrage pendant la crise : elle continue
  u.arreter();
  const u2 = creerUrgence({ config, maintenant: () => t });
  assert.equal(u2.actif(), true);
  assert.equal(u2.noter({ cle: 'equipe-sos:a:b', texte: 'x' }), null, 'clés déjà vues reprises au redémarrage');
  t += 3600000;
  const fin = u2.desactiver('f4gld');
  assert.equal(fin.actif, false); assert.equal(fin.derniere.nb, 4);
  assert.equal(u2.actif(), false);
  assert.equal(u2.archives().length, 1);
  const x = u2.csv(fin.derniere.id);
  assert.match(x.nom, /^crise-2026-11-21-09-00\.csv$/);
  const lignes = x.texte.split('\n');
  assert.equal(lignes.length, 5);
  assert.match(lignes[1], /;debut;critique;/); assert.match(x.texte, /!5a1e0001;45\.1;4\.1/); assert.match(lignes[4], /;fin;/);
  u2.arreter();
  fs.rmSync(dossier, { recursive: true, force: true });
});
