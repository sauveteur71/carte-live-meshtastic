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
// Des modules (passerelle…) gardent des minuteries actives : arrêt du processus une fois tous les tests passés
test.after(() => setImmediate(() => process.exit(0)));

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
  // Minuteries de la passerelle relevées pour être arrêtées à la fin (avant : process.exit, qui coupait les essais suivants)
  const vraiSetInterval = global.setInterval, minuteries = [];
  global.setInterval = (...x) => { const m = vraiSetInterval(...x); minuteries.push(m); return m; };
  let p;
  try { p = creerPasserelle({
    config: { fichierBase: path.join(dossier, 'x.db'), passerelle: { actif: true }, canaux: [], meshcore: {} }, journal: () => {}, audit: {}, nomMt: () => 'F4XYZ',
    envoyerMt: async (c, t) => envois.push(['MT', t]), envoyerMc: async (c, t) => envois.push(['MC', t]),
    etatMt: () => ({ connecte: true, noeudLocal: 1, canaux: [{ index: 1, nom: 'Crise' }] }), etatMc: () => ({ pret: true, nom: 'BASE', canaux: [{ index: 2, nom: '#crise' }] }),
  }); } finally { global.setInterval = vraiSetInterval; }
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
  minuteries.forEach(clearInterval);
  // la passerelle garde des minuteries actives : le processus est arrêté après le dernier test (test.after)
});

// Non-régression (17/11) : l'historique d'un canal calme ne doit ni disparaître après 7 jours (purge générale),
// ni être caché par les 300 derniers messages des canaux bavards
test('Messages : conservés plus longtemps que le trafic, historique d’un seul canal', async () => {
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
  await st.purger(7, 90);
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

// ---------- Réactivité du serveur (gels de plusieurs secondes relevés en production le 21/11/2026) ----------
test('Santé : un gel isolé ne donne pas d’alerte, des gels répétés ou très longs oui, avec la tâche suspecte', () => {
  const { alertesReactivite } = require('../src/sante-carte');
  const e = (max, tache, p99 = 40) => ({ heure: Date.now(), latenceP99: p99, latenceMax: max, tache });
  assert.deepEqual(alertesReactivite([e(30), e(2000), e(40)]), [], 'gel ancien unique : rien');
  assert.deepEqual(alertesReactivite([e(30), e(2400)]), [], 'un seul gel de 2,4 s : rien');
  const rep = alertesReactivite([e(1600, { nom: 'GET /api/noeuds', ms: 900, n: 3 }), e(20), e(3900, { nom: 'message MQTT Meshtastic', ms: 150, n: 40 })]);
  assert.equal(rep.length, 1); assert.equal(rep[0].niveau, 'attention');
  assert.match(rep[0].message, /2 fois.*3\.9 s.*message MQTT Meshtastic \(150 ms\)/);
  const crit = alertesReactivite([e(20), e(8100, { nom: 'purge Meshtastic (un lot)', ms: 7900, n: 1 })]);
  assert.equal(crit[0].niveau, 'critique'); assert.match(crit[0].message, /8\.1 s.*purge Meshtastic/);
  // Le p99 garde la priorité (retard permanent)
  assert.match(alertesReactivite([e(9000, null, 2500)])[0].message, /se fige/);
});

test('Santé : registre des tâches (maximum, cumul, tâche la plus longue de la minute, dernière heure)', () => {
  const s = require('../src/sante-carte');
  s.cloreMinute(); // minute vierge
  s.noter('message MQTT Meshtastic', 3); s.noter('message MQTT Meshtastic', 140); s.noter('alertes Meshtastic', 90);
  assert.equal(s.chrono('calcul', () => 42), 42);
  assert.throws(() => s.chrono('échec', () => { throw new Error('x'); }));
  const lentes = s.tachesLentes();
  assert.equal(lentes[0].nom, 'message MQTT Meshtastic'); assert.equal(lentes[0].maxMs, 140); assert.equal(lentes[0].n, 2);
  assert.ok(lentes.some((t) => t.nom === 'échec'), 'une tâche en erreur est quand même comptée');
  const m = s.cloreMinute();
  assert.deepEqual(m.tache, { nom: 'message MQTT Meshtastic', ms: 140, n: 2 });
  assert.equal(m.tacheCumul.nom, 'message MQTT Meshtastic');
  assert.ok(s.tachesLentes().some((t) => t.nom === 'alertes Meshtastic'), 'gardée une heure après la fin de la minute');
});

test('Purge par lots : la boucle d’événements reprend la main entre deux lots, purges non cumulées', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-'));
  const { creerStockage } = require('../src/base');
  const st = creerStockage(path.join(dossier, 'x.db'));
  const vieux = Date.now() - 30 * 86400000;
  st.db.transaction(() => {
    const p = st.db.prepare("INSERT INTO paquets (id_paquet, de, port, heure) VALUES (?, 7, 'position', ?)"), r = st.db.prepare('INSERT INTO receptions (paquet, passerelle, heure) VALUES (?, 1, ?)');
    for (let i = 0; i < 5000; i++) { const x = p.run(i, vieux); r.run(x.lastInsertRowid, vieux); }
    st.db.prepare("INSERT INTO paquets (id_paquet, de, port, heure) VALUES (9999999, 7, 'position', ?)").run(Date.now());
  })();
  let tours = 0, fini = false;
  const compter = () => { tours++; if (!fini) setImmediate(compter); };
  setImmediate(compter);
  const p1 = st.purger(7, 90, { lot: 1000 });
  assert.equal(st.purger(7, 90), p1, 'une purge en cours n’est pas relancée');
  const n = await p1; fini = true;
  assert.equal(n, 10000);
  assert.ok(tours >= 8, `la carte doit pouvoir répondre entre les lots (${tours} tours)`);
  assert.equal(st.db.prepare('SELECT COUNT(*) n FROM paquets').get().n, 1, 'le paquet récent reste');
  assert.notEqual(st.purger(7, 90), p1, 'nouvelle purge possible une fois la précédente finie');
  st.db.close();
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('Réseau : relais retrouvé par son dernier octet sans relire toute la table, statistiques et nœuds modifiés', () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'relais-'));
  const { creerStockage } = require('../src/base');
  const { creerReseau } = require('../src/reseau');
  const st = creerStockage(path.join(dossier, 'x.db'));
  const config = { seuils: { actifMinutes: 30, inactifHeures: 24, muetMinutes: 60, tensionVolts: 3.5, batteriePourcent: 20, chargeSolaireVolts: 4, canalPourcent: 25, canalCritiquePourcent: 40, emissionPourcent: 10 }, lienDistanceMaxKm: 120, noeudsSurveilles: [], canauxTexte: [], precisionPublique: 2 };
  const reseau = creerReseau(st, config);
  const t = Date.now();
  const noeud = (num, lat, lon, extra = '') => st.db.prepare(`INSERT INTO noeuds (num, id, lat, lon, premier_vu, dernier_vu, role${extra ? ', est_passerelle' : ''}) VALUES (?, ?, ?, ?, ?, ?, 'ROUTER'${extra ? ', 1' : ''})`).run(num, '!' + num.toString(16), lat, lon, t - 7200000, t - 7200000);
  noeud(0x5a1e00aa, 45.05, 3.9, 'gw'); // passerelle au Puy
  noeud(0x11223344, 45.10, 3.95); // relais proche, octet 0x44
  noeud(0x99887744, 48.85, 2.35); // même octet, à Paris : hors de portée
  st.db.prepare('UPDATE noeuds SET canal = 12, heure_telemetrie = ? WHERE num = ?').run(t, 0x11223344);
  const s0 = reseau.statistiques();
  assert.equal(s0.noeuds, 3); assert.equal(s0.passerelles, 1); assert.equal(s0.actifs, 0); assert.equal(s0.canalMax, 12);
  // Horloge de modification tenue par déclencheur : les fiches viennent d'être écrites, on les vieillit pour le test
  st.db.prepare('UPDATE noeuds SET modifie = ?').run(t - 7200000);
  assert.deepEqual(st.db.prepare('SELECT DISTINCT modifie FROM noeuds').pluck().all(), [t - 7200000], 'une écriture qui fixe modifie elle-même n’est pas réécrite');
  const avant = Date.now();
  reseau.integrer({ genre: 'paquet', idPaquet: 77, de: 0x0badcafe, vers: 0xffffffff, port: 'texte', canal: 'LongFast', sauts: 1, relais: 0x44, numPasserelle: 0x5a1e00aa, snr: 4.5, rssi: -101 });
  const lien = st.db.prepare('SELECT a, b, source FROM liens').all();
  assert.deepEqual(lien, [{ a: 0x11223344, b: 0x5a1e00aa, source: 'rf' }], 'relais proche retenu, homonyme lointain écarté');
  const d1 = reseau.noeudsDepuis(avant - 1000, true);
  assert.deepEqual(d1.noeuds.map((n) => n.num).sort(), [0x0badcafe, 0x5a1e00aa].sort(), 'nœuds écrits par le paquet (émetteur, passerelle)');
  assert.deepEqual(d1.supprimes, []);
  // Synchronisation d'un module : position écrite avec une heure ancienne (horloge du module) → quand même renvoyée
  st.q.position.run({ num: 0x99887744, lat: 48.86, lon: 2.36, alt: null, precision: null, heure: t - 86400000 });
  assert.ok(reseau.noeudsDepuis(avant - 1000, true).noeuds.some((n) => n.num === 0x99887744), 'modification à heure ancienne vue par la liste incrémentale');
  // Suppression (purge, administrateur) : signalée pour que le nœud quitte la carte
  noeud(0x77777777, 44.9, 3.8);
  st.db.prepare('DELETE FROM noeuds WHERE num = ?').run(0x77777777);
  assert.deepEqual(reseau.noeudsDepuis(avant - 1000, true).supprimes, [0x77777777]);
  const modifies = d1.noeuds.map((n) => n.num);
  assert.ok(modifies.includes(0x5a1e00aa));
  assert.equal(reseau.statistiques().actifs, 2, 'émetteur et passerelle entendus à l’instant');
  // Liste complète : objets ordinaires (lecture rapide), mêmes champs qu'avant
  const tous = st.q.noeuds.all();
  assert.equal(tous.length, 4); assert.equal(typeof tous[0].num, 'number'); assert.ok('stats_locales' in tous[0]);
  // Nettoyage : un lien de 400 km est supprimé
  st.db.prepare("INSERT INTO liens (a, b, source, nb, premier_vu, dernier_vu) VALUES (?, ?, 'rf', 1, ?, ?)").run(0x99887744, 0x5a1e00aa, t, t);
  assert.equal(reseau.nettoyer().liens, 1);
  st.db.close();
  fs.rmSync(dossier, { recursive: true, force: true });
});

// ---------- Relief grossier mondial et cache du relief ----------
// Faux service ERDDAP (format ESRI ASCII, lignes du nord vers le sud) : altitude synthétique connue en chaque point
const http = require('http');
const altSynth = (lat, lon) => Math.round(lat * 20 + lon * 3); // négatif = mer → 0 dans la grille
function fauxErddap({ echecs = new Set(), delai = 0 } = {}) {
  const appels = [];
  const srv = http.createServer((req, res) => {
    const q = decodeURIComponent(req.url.split('?')[1] || '');
    const m = /altitude\[\(([-\d.]+)\):(\d+):\(([-\d.]+)\)\]\[\(([-\d.]+)\):(\d+):\(([-\d.]+)\)\]/.exec(q);
    if (!m) { res.statusCode = 400; return res.end('requête invalide'); }
    const [lat0, pas, lat1, lon0, , lon1] = [Number(m[1]), Number(m[2]) / 60, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
    appels.push(lat0);
    if (echecs.has(lat0)) { echecs.delete(lat0); res.statusCode = 503; return res.end('saturé'); }
    const nr = Math.round((lat1 - lat0) / pas) + 1, nc = Math.round((lon1 - lon0) / pas) + 1;
    let t = `ncols ${nc}\nnrows ${nr}\nxllcenter ${lon0}\nyllcenter ${lat0}\ncellsize ${pas}\nnodata_value -9999999\n`;
    for (let r = nr - 1; r >= 0; r--) { const l = []; for (let c = 0; c < nc; c++) l.push(altSynth(lat0 + r * pas, lon0 + c * pas)); t += l.join(' ') + '\n'; }
    setTimeout(() => { res.setHeader('Content-Type', 'text/plain'); res.end(t); }, delai);
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, url: `http://127.0.0.1:${srv.address().port}/erddap`, appels })));
}

test('Relief grossier : téléchargement par bandes, reprise après une panne, lecture interpolée, océans à 0', async () => {
  const { creerReliefGrossier } = require('../src/relief-grossier');
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'grossier-'));
  // Grille de 1° (181 × 360), bandes de 30° ; la bande partant de 30° N échoue sur les deux « miroirs » → erreur
  const f = await fauxErddap({ echecs: new Set([30]) });
  const panne = await fauxErddap({ echecs: new Set([30]) });
  try {
    let g = creerReliefGrossier({ dossier, minutes: 60, degreParBande: 30, serveurs: [f.url, panne.url] });
    assert.equal(g.etat().statut, 'absent');
    assert.equal(g.grille({ sud: 0, ouest: 0, pasLat: 1, pasLon: 1, nLat: 1, nLon: 1 }), null);
    // 1er essai : f échoue sur 30, panne aussi → 2e tour : f répond ; reprise donc dans le même téléchargement
    await g.telecharger();
    assert.equal(g.etat().statut, 'pret', g.etat().erreur);
    assert.equal(fs.statSync(path.join(dossier, 'relief-monde-60m.bin')).size, 181 * 360 * 2);
    assert.ok(!fs.existsSync(path.join(dossier, 'relief-monde-60m.bin.part')));
    // Reprise d'un téléchargement coupé : les bandes déjà écrites ne sont pas redemandées
    fs.renameSync(path.join(dossier, 'relief-monde-60m.bin'), path.join(dossier, 'relief-monde-60m.bin.part'));
    fs.unlinkSync(path.join(dossier, 'relief-monde-60m.json'));
    fs.writeFileSync(path.join(dossier, 'relief-monde-60m.reprise.json'), JSON.stringify({ minutes: 60, bandes: [0, 1, 2, 3, 4] }));
    const avant = f.appels.length;
    g = creerReliefGrossier({ dossier, minutes: 60, degreParBande: 30, serveurs: [f.url] });
    await g.telecharger();
    assert.equal(g.etat().statut, 'pret');
    assert.deepEqual(f.appels.slice(avant), [60, 90].map((x) => x)); // bandes 5 (60° N) et 6 (90° N) seulement
    // Valeurs : points de la grille exacts, interpolation bilinéaire entre eux, mer à 0, passage du méridien 180
    const z = (lat, lon) => g.grille({ sud: lat, ouest: lon, pasLat: 0.1, pasLon: 0.1, nLat: 1, nLon: 1 })[0];
    assert.equal(z(45, 3), altSynth(45, 3));
    assert.ok(Math.abs(z(45.5, 3.5) - (altSynth(45, 3) + altSynth(46, 3) + altSynth(45, 4) + altSynth(46, 4)) / 4) < 1e-3);
    assert.equal(z(-40, 10), 0); // altitude synthétique négative = océan
    assert.ok(Math.abs(z(60, 179.5) - (altSynth(60, 179) + altSynth(60, -180)) / 2) < 1e-3); // 180° E = 180° O
    const grande = g.grille({ sud: 44.6, ouest: 2.6, pasLat: 0.01, pasLon: 0.01, nLat: 180, nLon: 180 });
    assert.equal(grande.length, 180 * 180);
    assert.ok(grande.every(Number.isFinite));
    // Suppression : fichiers effacés, état « absent »
    await g.supprimer();
    assert.equal(g.etat().statut, 'absent');
    assert.deepEqual(g.fichiers(), []);
  } finally { f.srv.close(); panne.srv.close(); }
});

test('Relief grossier : arrêt puis réactivation rapide → nouveau téléchargement enchaîné, sans attendre l’essai horaire', async () => {
  const { creerReliefGrossier } = require('../src/relief-grossier');
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'grossier-'));
  const f = await fauxErddap({ delai: 80 });
  try {
    const g = creerReliefGrossier({ dossier, minutes: 60, degreParBande: 30, serveurs: [f.url] });
    const p1 = g.telecharger();
    await new Promise((r) => setTimeout(r, 120)); // première bande en cours
    g.arreter(); // case décochée…
    const p2 = g.telecharger(); // … puis recochée aussitôt
    assert.ok(g.etat().enCours, 'un téléchargement reste en cours après la réactivation');
    await p1;
    assert.ok(g.etat().enCours, 'la fin du téléchargement arrêté n’efface pas celui qui est enchaîné');
    await p2;
    assert.equal(g.etat().statut, 'pret', g.etat().erreur);
    assert.ok(!g.etat().enCours);
    assert.ok(fs.existsSync(path.join(dossier, 'relief-monde-60m.json')));
    assert.ok(!fs.existsSync(path.join(dossier, 'relief-monde-60m.reprise.json')) && !fs.existsSync(path.join(dossier, 'relief-monde-60m.reprise.json.bak')), 'fichiers de reprise effacés');
  } finally { f.srv.close(); }
});

test('Relief grossier : réponse inattendue (mauvaise grille) refusée, aucun fichier « prêt » laissé', async () => {
  const { creerReliefGrossier } = require('../src/relief-grossier');
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'grossier-'));
  const srv = http.createServer((req, res) => res.end('ncols 3\nnrows 2\nxllcenter -180\nyllcenter -90\ncellsize 1\nnodata_value -9\n1 2 3\n4 5 6\n'));
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    const g = creerReliefGrossier({ dossier, minutes: 60, degreParBande: 30, serveurs: [`http://127.0.0.1:${srv.address().port}/erddap`] });
    const t = Date.now();
    await g.telecharger();
    assert.equal(g.etat().statut, 'erreur');
    assert.match(g.etat().erreur, /inattendue/);
    assert.ok(!fs.existsSync(path.join(dossier, 'relief-monde-60m.bin')));
    assert.ok(Date.now() - t < 40000);
  } finally { srv.close(); }
});

test('Relief : relief grossier pendant le téléchargement du précis, calculs marqués approximatifs, puis bascule', async () => {
  const { creerRelief } = require('../src/relief');
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'relief-'));
  // Points hauts déjà en cache : aucun appel à OpenStreetMap pendant l'essai
  fs.writeFileSync(path.join(dossier, 'sommets-osm-43.json'), JSON.stringify({ date: Date.now(), liste: [] }));
  // Faux service altimétrique IGN : altitude 0 partout ; la réponse est retenue tant que l'essai ne la libère pas
  let liberer;
  const retenue = new Promise((ok) => { liberer = ok; });
  const fetchAvant = global.fetch;
  global.fetch = async (url, o = {}) => {
    if (/geopf/i.test(String(url))) { await retenue; const n = JSON.parse(o.body).lon.split('|').length; return { ok: true, status: 200, json: async () => ({ elevations: new Array(n).fill(0) }) }; }
    throw new Error('hors ligne (essai)');
  };
  // Relief grossier factice : un dôme de 1500 m centré sur 45,1° N 3,9° E (Haute-Loire)
  const grossier = {
    pret: () => true, quandPret: () => () => {}, etat: () => ({ resolutionKm: 9.3, source: 'essai' }),
    grille: ({ sud, ouest, pasLat, pasLon, nLat, nLon }) => {
      const z = new Float32Array(nLat * nLon);
      for (let i = 0; i < nLat; i++) for (let j = 0; j < nLon; j++) { const d = Math.hypot(sud + i * pasLat - 45.1, ouest + j * pasLon - 3.9); z[i * nLon + j] = Math.max(0, 1500 - d * 1500); }
      return z;
    },
  };
  let R;
  const fournisseurs = { presetCourant: () => 'LONG_FAST', noeudsReseau: () => [], liensMesures: () => [], envDefaut: () => 10, reliefGrossier: () => grossier, apresTelechargement: () => R.arreter() };
  try {
    R = creerRelief({ fichierBase: path.join(dossier, 'carte-live.db'), departement: { code: '07' }, zone: [44.2, 3.8, 45.4, 4.9] }, () => {}, fournisseurs, { code: '43' });
    for (let k = 0; k < 100 && !R.utilisable(); k++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(R.pret(), false);
    assert.equal(R.utilisable(), true);
    assert.equal(R.approximatif(), true);
    assert.equal(R.etat().mnt, 'chargement');
    assert.equal(R.etat().approx.resolutionKm, 9.3);
    const a = await R.couverturePng({ lat: 45.1, lon: 3.9 }, { hs: 10 });
    assert.equal(a.approximatif, true);
    assert.equal(a.reliefApprox.resolutionKm, 9.3);
    assert.ok(a.sol > 1450, 'altitude du dôme grossier');
    assert.ok(a.image.subarray(1, 4).toString() === 'PNG');
    // Calculs qui demandent les points hauts : toujours refusés tant que le relief précis manque
    assert.throws(() => R.couvrirPoint({ lat: 45.1, lon: 3.9 }), /en cours de chargement/);
    // Relief précis arrivé (mer partout : 0 m) : il remplace le grossier, plus de mention approximative
    liberer();
    for (let k = 0; k < 200 && !R.pret(); k++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(R.pret(), true);
    assert.equal(R.approximatif(), false);
    assert.equal(R.etat().approx, null);
    const b = await R.couverturePng({ lat: 45.1, lon: 3.9 }, { hs: 10 });
    assert.equal(b.approximatif, undefined);
    assert.equal(b.sol, 0);
    assert.ok(fs.existsSync(path.join(dossier, 'mnt-43.bin')));
  } finally { liberer(); global.fetch = fetchAvant; if (R) R.arreter(); }
});

test('Cache du relief : espace occupé, purge par ancienneté, zone verrouillée ou récente gardée, plafond LRU', async () => {
  const { creerCacheRelief } = require('../src/relief-cache');
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-relief-'));
  const ecrire = (f, n) => fs.writeFileSync(path.join(dossier, f), Buffer.alloc(n));
  const jour = 86400000, maintenant = Date.now();
  ecrire('mnt.bin', 5000); ecrire('mnt.json', 100); // zone de la carte : jamais purgée
  ecrire('villes-43.json', 700); ecrire('communes-43.json', 300); // fichiers suffixés de la zone de la carte : pas une zone purgeable
  ecrire('mnt-07.bin', 3000); ecrire('mnt-07.json', 100); ecrire('sommets-osm-07.json', 50); ecrire('mnt-07.json.bak', 100);
  ecrire('mnt-MN45E003.bin', 2000); ecrire('mnt-MN45E003.json', 100);
  ecrire('mnt-MN46E003.bin', 4000); ecrire('mnt-MN46E003.json', 100);
  ecrire('mnt-15.bin', 1000); ecrire('mnt-15.json', 100);
  ecrire('autre.bin', 999); ecrire('mnt-..-x.bin', 10); // fichiers étrangers : ignorés
  fs.writeFileSync(path.join(dossier, 'relief-utilisation.json'), JSON.stringify({ '07': maintenant - 40 * jour, MN45E003: maintenant - 2 * jour, MN46E003: maintenant - 60 * jour, 15: maintenant - 1000 }));
  const verrous = new Set(['MN46E003']); // en cours de préparation
  const ouvertes = new Map([['15', { etat: () => ({ mnt: 'pret' }) }]]); // ouverte et utilisée à l'instant
  const liberees = [], journalLignes = [];
  let grossierSupprime = false;
  const grossier = { etat: () => ({ statut: 'pret', octetsDisque: grossierSupprime ? 0 : 18e6, resolutionKm: 9.3 }), supprimer: async () => { grossierSupprime = true; } };
  const c = creerCacheRelief({ dossier, journal: (...l) => journalLignes.push(l.join(' ')), verrous: () => verrous, enMemoire: () => ouvertes, liberer: (x) => { liberees.push(x); ouvertes.delete(x); }, grossier, codePrincipal: '43' });
  try {
    let inv = c.inventaire(0);
    assert.deepEqual(inv.zones.map((z) => z.code).sort(), ['07', '15', 'MN45E003', 'MN46E003']);
    assert.equal(inv.zones.find((z) => z.code === '07').octets, 3250);
    assert.equal(inv.zonesOctets, 3250 + 2100 + 4100 + 1100);
    assert.equal(inv.principale.octets, 6100);
    assert.equal(inv.totalOctets, 3250 + 2100 + 4100 + 1100 + 6100 + 18e6);
    assert.equal(inv.zones.find((z) => z.code === 'MN46E003').verrou, true);
    assert.equal(inv.zones.find((z) => z.code === '15').recente, true);
    // Inutilisées depuis 30 jours : 07 supprimée, MN46E003 gardée (en préparation)
    let r = await c.purger({ joursInactifs: 30 }, 'essai');
    assert.deepEqual(r.supprimees, ['07']);
    assert.deepEqual(r.refusees.map((x) => x.code), ['MN46E003']);
    assert.equal(r.octetsLiberes, 3250);
    assert.ok(!fs.existsSync(path.join(dossier, 'mnt-07.bin')) && !fs.existsSync(path.join(dossier, 'mnt-07.json.bak')));
    assert.ok(fs.existsSync(path.join(dossier, 'mnt.bin')) && fs.existsSync(path.join(dossier, 'autre.bin')));
    assert.ok(journalLignes.some((l) => /purge du relief par essai/.test(l)));
    // Tout purger : la zone ouverte à l'instant et la zone en préparation restent, le relief mondial aussi
    r = await c.purger({ tout: true }, 'essai');
    assert.deepEqual(r.supprimees, ['MN45E003']);
    assert.deepEqual(r.refusees.map((x) => x.code).sort(), ['15', 'MN46E003']);
    assert.equal(grossierSupprime, false);
    // Plafond : fin de la préparation, zone 15 plus récente ; LRU supprime d'abord la plus ancienne (MN46E003)
    verrous.clear();
    ecrire('mnt-MN45E003.bin', 2000);
    c.noterUtilisation('MN45E003');
    r = c.appliquerPlafond(3500 / 1e9); // 3,5 ko
    assert.deepEqual(r.supprimees, ['MN46E003']);
    assert.ok(fs.existsSync(path.join(dossier, 'mnt-MN45E003.bin')));
    // Zone ouverte mais plus utilisée depuis longtemps : fermée puis supprimée sur demande
    const u = JSON.parse(fs.readFileSync(path.join(dossier, 'relief-utilisation.json'), 'utf8'));
    assert.ok(u.MN45E003 > maintenant - 5000, 'date de dernière utilisation enregistrée');
    ouvertes.set('MN45E003', { etat: () => ({ mnt: 'pret' }) });
    c.noterUtilisation('MN45E003');
    r = await c.purger({ codes: ['mn45e003'] }, 'essai');
    assert.deepEqual(r.refusees.map((x) => x.code), ['MN45E003']); // utilisée il y a moins de 10 min
    // Relief mondial : seulement sur demande explicite
    r = await c.purger({ grossier: true }, 'essai');
    assert.equal(grossierSupprime, true);
    assert.ok(r.supprimees.includes('monde'));
    assert.equal(liberees.length, 0);
  } finally { c.arreter(); }
});

// Recherche dans les messages : index plein texte rempli depuis l'historique, accents et majuscules ignorés,
// nom ACTUEL de l'expéditeur, identifiant, MeshCore, droits de la démonstration, purge
test('Recherche dans les messages : texte, accents, nom actuel de l’expéditeur, identifiant, démonstration, purge', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'recherche-'));
  process.env.FICHIER_BASE = path.join(dossier, 'x.db');
  const config = require('../src/config');
  const { creerStockage } = require('../src/base');
  const { creerReseauMc } = require('../src/meshcore/reseau');
  const { creerRechercheMessages } = require('../src/recherche-messages');
  const st = creerStockage(path.join(dossier, 'x.db'));
  const r = creerReseauMc(st.db, config, PUBLIC);
  const B = 0xffffffff, t0 = Date.now() - 3600000;
  let idp = 1;
  const message = (de, texte, { vers = B, canal = 'LongFast', heure = t0 + idp * 1000, port = 'texte' } = {}) => st.q.insererPaquet.get({
    idPaquet: idp++, de, vers, canal, port, nomPort: 'TEXT_MESSAGE_APP', portnum: 1, heure, hopDepart: 3, hopRestant: 2, sauts: 1, dechiffre: 1,
    resume: null, texte, taille: 20, viaMqtt: 0, contenu: null, pki: 0, signe: 0, signature: null }).rowid;
  const nommer = (num, nomLong, nomCourt) => { st.assurerNoeud(num, Date.now()); st.q.infos.run({ num, nomLong, nomCourt, materiel: null, role: null, firmware: null, preset: null }); };
  // Historique déjà là avant la création de l'index : il doit être retrouvé (migration)
  const ancien = message(0x5a1e0001, 'Qui a perdu son CHAPEAU au Mézenc ?');
  message(0x5a1e0001, 'position', { port: 'position' });
  const rech = creerRechercheMessages(st.db);
  assert.equal(rech.fts(), true, 'FTS5 disponible');
  const cles = (o) => rech.chercher(o).resultats.map((x) => x.ref);
  assert.deepEqual(cles({ q: 'chapeau' }), ['mt' + ancien], 'historique indexé à la migration');
  // Nouveaux messages : indexés au fil de l'eau (déclencheurs), du plus récent au plus ancien
  nommer(0x5a1e0002, 'Olivier F4GLD', 'GLD');
  const deGld = message(0x5a1e0002, 'Bonjour à tous');
  const versGld = message(0x5a1e0003, 'reçu 5/9', { vers: 0x5a1e0002 });
  const prive = message(0x5a1e0003, 'Été au chapeau', { canal: 'Equipe' });
  const cite = message(0x5a1e0004, 'Merci f4gld pour le relais');
  assert.deepEqual(cles({ q: 'Chapéau' }), ['mt' + prive, 'mt' + ancien], 'majuscules et accents ignorés, plus récent d’abord');
  assert.deepEqual(cles({ q: 'ETE' }), ['mt' + prive]);
  assert.deepEqual(cles({ q: 'chap' }), ['mt' + prive, 'mt' + ancien], 'début de mot');
  const gld = rech.chercher({ q: 'F4GLD' }).resultats;
  assert.deepEqual(gld.map((x) => x.ref), ['mt' + cite, 'mt' + versGld, 'mt' + deGld], 'texte + expéditeur + destinataire d’un direct');
  assert.deepEqual(gld.map((x) => x.trouve), [['texte'], ['destinataire'], ['expediteur']]);
  assert.equal(gld[2].nomDe, 'Olivier F4GLD');
  assert.deepEqual(cles({ q: 'gld' }), ['mt' + versGld, 'mt' + deGld], 'nom court');
  assert.deepEqual(cles({ q: '!5a1e0002' }), ['mt' + versGld, 'mt' + deGld], 'identifiant');
  assert.deepEqual(cles({ q: String(0x5a1e0002) }), ['mt' + versGld, 'mt' + deGld], 'numéro');
  // Nœud renommé : retrouvé sous son nom actuel, plus sous l'ancien (hors texte)
  nommer(0x5a1e0002, 'Relais Mégal', 'MGL');
  assert.deepEqual(cles({ q: 'megal' }), ['mt' + versGld, 'mt' + deGld], 'nom actuel');
  assert.equal(rech.noms(), true, 'index trigram des noms disponible');
  assert.deepEqual(cles({ q: 'égal' }), ['mt' + versGld, 'mt' + deGld], 'partie de nom, accents ignorés (index trigram)');
  nommer(0x5a1e0003, 'Troisième', 'T3');
  assert.deepEqual(cles({ q: 't3' }), ['mt' + prive, 'mt' + versGld], 'deux caractères : nom court exact seulement');
  assert.deepEqual(cles({ q: 'ga' }), [], 'deux caractères : pas de partie de nom');
  assert.deepEqual(cles({ q: 'f4gld' }), ['mt' + cite], 'ancien nom : seulement le texte');
  // MeshCore : texte, nom porté par le message, nom actuel du nœud par sa clé
  const cleMc = 'AB'.repeat(32);
  st.db.prepare('INSERT INTO mc_noeuds (cle, nom, premier_vu, dernier_vu) VALUES (?, ?, ?, ?)').run(cleMc, 'Pic du Lizieux', Date.now(), Date.now());
  const mcCanal = r.noterMessage({ sens: 'recu', genre: 'canal', canal: 'Public', texte: 'Un chapeau trouvé', nomDe: 'Bob' });
  const mcDirect = r.noterMessage({ sens: 'recu', genre: 'direct', de: cleMc, nomDe: 'Ancien nom', texte: 'Coucou en direct' });
  const mcPrive = r.noterMessage({ sens: 'recu', genre: 'canal', canal: 'Club', texte: 'Chapeau du club', nomDe: 'Alice' });
  assert.deepEqual(cles({ q: 'chapeau' }), ['mc' + mcPrive, 'mc' + mcCanal, 'mt' + prive, 'mt' + ancien], 'Meshtastic et MeshCore mêlés');
  assert.deepEqual(cles({ q: 'lizieux' }), ['mc' + mcDirect], 'MeshCore : nom actuel par la clé');
  assert.deepEqual(cles({ q: 'bob' }), ['mc' + mcCanal], 'MeshCore : nom porté par le message');
  assert.deepEqual(cles({ q: 'abab' }), ['mc' + mcDirect], 'MeshCore : début de clé');
  // Démonstration : canaux publics seulement (LongFast, Public, « # »), jamais de message direct
  const demo = (q) => rech.chercher({ q, demo: true, publics: ['LongFast'] }).resultats.map((x) => x.ref);
  assert.deepEqual(demo('chapeau'), ['mc' + mcCanal, 'mt' + ancien], 'canaux privés exclus');
  assert.deepEqual(demo('megal'), ['mt' + deGld], 'message direct exclu');
  assert.deepEqual(demo('lizieux'), [], 'message direct MeshCore exclu');
  // Japonais / chinois / coréen / thaï : pas d'espace entre les mots, le terme est trouvé au milieu d'une suite
  const jp = message(0x5a1e0005, '今日は天気がいいですね');
  const ko = r.noterMessage({ sens: 'recu', genre: 'canal', canal: 'Public', texte: '안녕하세요반갑습니다', nomDe: '山田太郎' });
  assert.deepEqual(cles({ q: '天気' }), ['mt' + jp], 'japonais : au milieu de la phrase');
  assert.deepEqual(cles({ q: '반갑' }), ['mc' + ko], 'coréen : au milieu de la phrase');
  assert.deepEqual(cles({ q: '田太郎' }), ['mc' + ko], 'nom japonais porté par le message (index trigram, 3 caractères au moins)');
  assert.deepEqual(cles({ q: '天気 いい' }), ['mt' + jp], 'deux termes, tous obligatoires');
  assert.deepEqual(cles({ q: '天気 bonjour' }), [], 'terme absent : rien');
  // Recherches vides ou trop courtes, caractères spéciaux de FTS5 et de LIKE sans erreur
  assert.equal(rech.chercher({ q: 'a' }).resultats.length, 0);
  for (const q of ['"', 'chapeau" OR "x', '%', '_*', 'NEAR(a b)', 'é-è', '😀😀']) assert.doesNotThrow(() => rech.chercher({ q }), q);
  // Pagination : la suite reprend juste avant le dernier résultat
  const p1 = rech.chercher({ q: 'chapeau', limite: 2 });
  assert.equal(p1.resultats.length, 2); assert.ok(p1.suite);
  assert.deepEqual(rech.chercher({ q: 'chapeau', limite: 2, avant: p1.suite }).resultats.map((x) => x.ref), ['mt' + prive, 'mt' + ancien]);
  // Purge (rétention) : les messages supprimés disparaissent aussi de l'index
  st.db.prepare('UPDATE paquets SET heure = 1 WHERE rowid = ?').run(ancien);
  st.db.prepare('UPDATE mc_messages SET heure = 1 WHERE id = ?').run(mcPrive);
  await st.purger(1, 1); r.purger(1);
  assert.deepEqual(cles({ q: 'chapeau' }), ['mc' + mcCanal, 'mt' + prive], 'purgés : plus trouvés');
  // Index partiel : pas de vérification du contenu sur recherche_mt (voir l'en-tête de src/recherche-messages.js)
  st.db.exec("INSERT INTO recherche_mt(recherche_mt, rank) VALUES ('integrity-check', 0)");
  st.db.exec("INSERT INTO recherche_mc(recherche_mc) VALUES ('integrity-check')");
  st.db.exec("INSERT INTO recherche_noms_mt(recherche_noms_mt) VALUES ('integrity-check')");
  st.db.exec("INSERT INTO recherche_mc_noms(recherche_mc_noms) VALUES ('integrity-check')");
  // Redémarrage : l'index existant est repris tel quel (pas de doublon)
  const rech2 = creerRechercheMessages(st.db);
  assert.deepEqual(rech2.chercher({ q: 'chapeau' }).resultats.map((x) => x.ref), ['mc' + mcCanal, 'mt' + prive]);
  st.db.close();
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
  // Demi-diagonale de la maille : à l'équateur × √2, à 45° × 1,22 (I7)
  assert.ok(Math.abs(geo.incertitude(13, 0) - 2918 * Math.SQRT2) < 3, 'précision 13 bits à l’équateur ≈ 4,1 km');
  assert.ok(Math.abs(geo.incertitude(13, 45) - 2918 * Math.hypot(1, Math.cos(Math.PI / 4))) < 3, 'précision 13 bits à 45° ≈ 3,6 km');
  assert.ok(Math.abs(geo.incertitude(16, 45) - 365 * Math.hypot(1, Math.cos(Math.PI / 4))) < 3, 'précision 16 bits à 45° ≈ 446 m');
  assert.ok(geo.incertitude(16, 60) < geo.incertitude(16, 10), 'maille moins large vers les pôles');
  // Antiméridien (M2) : un polygone à cheval sur 180° est d'un seul tenant
  const anti = [[10, 179.99], [10, -179.99], [10.02, -179.99], [10.02, 179.99]];
  assert.ok(geo.surfacePolygone(anti) < 1e7 && geo.surfacePolygone(anti) > 4e6, `antiméridien : ≈ 4,9 km², pas 360° de large : ${geo.surfacePolygone(anti)}`);
  assert.equal(geo.pointDansPolygone({ lat: 10.01, lon: 180 }, anti), true);
  assert.equal(geo.pointDansPolygone({ lat: 10.01, lon: 0 }, anti), false);
  assert.doesNotThrow(() => geo.valider({ nom: 'a', forme: 'polygone', points: anti, noeuds: [1] }));
  // Polygone auto-intersecté (M3)
  const papillon = [[45, 4], [45.01, 4.01], [45.01, 4], [45, 4.01]];
  assert.equal(geo.polygoneCroise(papillon), true); assert.equal(geo.polygoneCroise(carre), false); assert.equal(geo.polygoneCroise(u), false);
  assert.throws(() => geo.valider({ nom: 'a', forme: 'polygone', points: papillon, noeuds: [1] }), /se croise/);
  // Marge trop grande pour une alerte à l'entrée (M4)
  assert.throws(() => geo.valider({ nom: 'a', forme: 'cercle', centre: CENTRE, rayon: 100, noeuds: [1], sens: 'entree', marge: 500 }), /Marge trop grande/);
  assert.throws(() => geo.valider({ nom: 'a', forme: 'cercle', centre: CENTRE, rayon: 100, noeuds: [1], sens: 'deux', marge: 50 }), /Marge trop grande/);
  assert.doesNotThrow(() => geo.valider({ nom: 'a', forme: 'cercle', centre: CENTRE, rayon: 100, noeuds: [1], sens: 'sortie', marge: 500 }));
  assert.equal(geo.valider({ nom: 'a', forme: 'cercle', centre: CENTRE, rayon: 100, noeuds: [1] }).silenceMin, 30, 'perte de contact : 30 min par défaut (I1)');
  // Coupe en octets UTF-8 (M12) et cellule CSV (I5)
  assert.equal(Buffer.byteLength(geo.couperOctets('⛔'.repeat(100), 200)), 198, '⛔ = 3 octets : 66 caractères, 198 octets');
  assert.equal(geo.couperOctets('abc', 200), 'abc');
  assert.equal(geo.celluleCsv('=HYPERLINK("http://x","clic")'), `"'=HYPERLINK(""http://x"",""clic"")"`);
  assert.equal(geo.celluleCsv('+33 6'), "'+33 6"); assert.equal(geo.celluleCsv('@SUM'), "'@SUM"); assert.equal(geo.celluleCsv('-1 x'), "'-1 x");
  assert.equal(geo.celluleCsv(-50), '-50', 'un nombre reste un nombre'); assert.equal(geo.celluleCsv('a\rb'), '"a\rb"'); assert.equal(geo.celluleCsv(null), '');
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
  assert.equal(sortie[0].lora, 'envoyé');
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

test('Secteurs : position floutée surveillée quand même (I2), secteur « entrée », perte de contact, MeshCore', () => {
  const { s, horloge, evenements, dossier } = secteursEssai();
  const sec = s.creer({ nom: 'Petit', forme: 'cercle', centre: CENTRE, rayon: 1000, noeuds: [0x5a1e0009], confirmations: 1 }, 'essai');
  const K = 'mt:' + 0x5a1e0009;
  // ± 3,6 km (13 bits à 45°) sur un secteur de 1 km : à 1,5 km du centre, impossible de trancher → signalé, pas ignoré
  s.position(K, { ...auNord(CENTRE, 1500), precision: 13, id: 1 });
  s.position(K, { ...auNord(CENTRE, 1600), precision: 13, id: 2 });
  assert.equal(evenements.filter((e) => e.type === 'imprecise').length, 1, 'noté une seule fois');
  assert.equal(evenements.find((e) => e.type === 'imprecise').niveau, 'attention');
  assert.match(evenements.find((e) => e.type === 'imprecise').message, /non surveillable précisément : position floutée \(± 3,6 km\)/);
  assert.ok(s.alertes().some((a) => a.cle.endsWith(':imprecise') && a.niveau === 'attention'), 'alerte active « non surveillable »');
  assert.equal(evenements.filter((e) => e.type === 'sortie').length, 0, 'pas de sortie : la maille chevauche la limite');
  // La même position floutée, mais à 50 km : toute la maille est dehors → sortie, même floutée
  s.position(K, { ...auNord(CENTRE, 50000), precision: 13, id: 3 });
  assert.equal(evenements.filter((e) => e.type === 'sortie').length, 1, 'floutée mais franchement dehors : sortie');
  assert.ok(!s.alertes().some((a) => a.cle.endsWith(':imprecise')), 'plus « non surveillable » dès qu’on peut trancher');
  s.position(K, { ...auNord(CENTRE, 0), id: 4 }); s.position(K, { ...auNord(CENTRE, 0), id: 5 });
  // 16 bits (± 446 m à 45°) : utilisable, mais la marge s'élargit d'autant
  s.position(K, { ...auNord(CENTRE, 1000 + 300), precision: 16, id: 6 });
  assert.equal(evenements.filter((e) => e.type === 'sortie').length, 1, '300 m dehors à ± 446 m : bordure');
  s.position(K, { ...auNord(CENTRE, 1000 + 600), precision: 16, id: 7 });
  assert.equal(evenements.filter((e) => e.type === 'sortie').length, 2, '600 m dehors à ± 446 m : sortie');
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

// ---------- Mur des donateurs (HelloAsso + GitHub Sponsors) ----------
const { creerDonateurs, anonymiser } = require('../src/donateurs');

test('Secteurs : sortie probable après une position dehors puis silence (I1), expiration (M5), demande de position', () => {
  const demandes = [];
  const { s, horloge, evenements, dossier } = secteursEssai({ demanderPosition: (n, m) => demandes.push([n, m]) });
  const sec = s.creer({ nom: 'Crête', forme: 'cercle', centre: CENTRE, rayon: 1000, noeuds: [0x5a1e0021], confirmations: 2, delaiMin: 10 }, 'essai');
  const K = 'mt:' + 0x5a1e0021;
  s.position(K, { ...CENTRE, id: 1 }); s.position(K, { ...CENTRE, id: 2 });
  horloge.t += 60000;
  s.position(K, { ...auNord(CENTRE, 5000), id: 3 }); // une seule position dehors, puis plus rien
  assert.deepEqual(demandes, [[0x5a1e0021, 'secteur']], 'position demandée tout de suite au premier signe de sortie');
  assert.equal(s.secteur(sec.id).membres[0].etat, 'dedans');
  horloge.t += 5 * 60000; s.verifierSilences();
  assert.equal(evenements.filter((e) => e.type === 'sortie').length, 0, '5 min : trop tôt');
  horloge.t += 5 * 60000; s.verifierSilences();
  const e = evenements.find((e) => e.type === 'sortie');
  assert.ok(e && e.probable && e.notifier && e.alerte, 'sortie probable après 10 min de silence');
  assert.match(e.message, /sortie probable de !5a1e0021 \(une position hors secteur, plus de nouvelles depuis 10 min\)/);
  assert.equal(e.niveau, 'critique');
  const m = s.secteur(sec.id).membres[0];
  assert.equal(m.etat, 'dehors'); assert.ok(m.probable);
  assert.ok(s.alertes().some((a) => a.niveau === 'critique' && /sortie probable/.test(a.message)));
  s.verifierSilences();
  assert.equal(evenements.filter((e) => e.type === 'sortie').length, 1, 'pas répétée');
  // Le nœud redonne des nouvelles : dedans → retour sans alerte (sens « sortie »)
  s.position(K, { ...CENTRE, id: 4 }); s.position(K, { ...CENTRE, id: 5 });
  assert.equal(s.secteur(sec.id).membres[0].etat, 'dedans');
  // Intervalle de suivi de l'équipe (60 min) : le seuil de sortie probable le suit
  const demandes2 = [];
  const r = geo.creerSecteurs({ config: { fichierBase: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'secteurs-')), 'base.db') }, intervalleMs: 0, maintenant: () => horloge.t,
    membresEquipe: () => [0x5a1e0022], nomEquipe: () => 'Eq', suiviMinDe: () => 60, surEvenement: (e) => demandes2.push(e) });
  r.creer({ nom: 'Lent', forme: 'cercle', centre: CENTRE, rayon: 1000, equipe: 'eq', confirmations: 2 }, 'essai');
  const K2 = 'mt:' + 0x5a1e0022;
  r.position(K2, { ...CENTRE, id: 1 }); r.position(K2, { ...CENTRE, id: 2 }); r.position(K2, { ...auNord(CENTRE, 5000), id: 3 });
  horloge.t += 30 * 60000; r.verifierSilences();
  assert.equal(demandes2.filter((e) => e.type === 'sortie').length, 0, 'suivi toutes les 60 min : 30 min de silence ne suffisent pas');
  horloge.t += 31 * 60000; r.verifierSilences();
  assert.equal(demandes2.filter((e) => e.type === 'sortie' && e.probable).length, 1, 'après un intervalle de suivi : sortie probable');
  r.arreter();
  // M5 : un comptage « dehors » non confirmé expire (le nœud continue d'émettre en bordure)
  horloge.t += 60000;
  s.position(K, { ...auNord(CENTRE, 5000), id: 10 }); // candidat dehors
  for (let i = 0; i < 8; i++) { horloge.t += 20 * 60000; s.position(K, { ...auNord(CENTRE, 1010), id: 20 + i }); s.verifierSilences(); } // bordure pendant 2 h 40
  s.position(K, { ...auNord(CENTRE, 5000), id: 30 });
  assert.equal(s.secteur(sec.id).membres[0].etat, 'dedans', 'un « dehors » vieux de 2 h 40 ne compte plus comme première confirmation');
  assert.equal(s.secteur(sec.id).membres[0].candidat, 'dehors');
  s.arreter();
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('Secteurs : pas de rafale de pertes de contact au redémarrage ni quand le flux est coupé (I3)', () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'secteurs-'));
  const horloge = { t: Date.UTC(2026, 10, 21, 8, 0, 0) };
  let reception = horloge.t;
  const evenements = [];
  const fabriquer = () => geo.creerSecteurs({ config: { fichierBase: path.join(dossier, 'base.db') }, intervalleMs: 0, maintenant: () => horloge.t, derniereReception: () => reception, surEvenement: (e) => evenements.push(e) });
  let s = fabriquer();
  s.creer({ nom: 'Col', forme: 'cercle', centre: CENTRE, rayon: 1000, noeuds: [1, 2, 3, 4, 5], silenceMin: 10 }, 'essai');
  for (const n of [1, 2, 3, 4, 5]) s.position('mt:' + n, { ...CENTRE, id: n });
  s.arreter();
  // Redémarrage après 1 h d'arrêt : délai de grâce de silenceMin, aucune alerte en masse
  horloge.t += 3600000; reception = horloge.t;
  s = fabriquer();
  s.verifierSilences();
  assert.equal(evenements.filter((e) => e.type === 'silence').length, 0, 'délai de grâce après le démarrage');
  horloge.t += 11 * 60000; reception = horloge.t;
  s.verifierSilences();
  assert.equal(evenements.filter((e) => e.type === 'silence').length, 5, 'après la grâce, les silences réels sont signalés');
  // Flux coupé (plus rien reçu d'aucune source depuis 10 min) : une seule alerte, surveillance suspendue
  for (const n of [1, 2, 3, 4, 5]) s.position('mt:' + n, { ...CENTRE, id: 100 + n });
  assert.equal(evenements.filter((e) => e.type === 'contact').length, 5);
  horloge.t += 12 * 60000; // reception n'avance pas
  s.verifierSilences(); s.verifierSilences();
  const flux = evenements.filter((e) => e.type === 'flux');
  assert.equal(flux.length, 1, 'une seule alerte « flux interrompu »'); assert.equal(flux[0].niveau, 'attention'); assert.ok(flux[0].notifier);
  assert.match(flux[0].message, /flux interrompu, surveillance des secteurs suspendue/);
  assert.equal(evenements.filter((e) => e.type === 'silence').length, 5, 'aucune nouvelle perte de contact pendant la coupure');
  assert.ok(s.alertes().some((a) => a.cle.startsWith('secteur:flux:') && a.niveau === 'attention'));
  assert.ok(s.fluxCoupe());
  // Retour du flux : alerte levée, puis les silences reprennent
  horloge.t += 60000; reception = horloge.t;
  s.verifierSilences();
  assert.equal(evenements.filter((e) => e.type === 'flux-retour').length, 1);
  assert.ok(!s.alertes().some((a) => a.cle.startsWith('secteur:flux:')));
  assert.equal(evenements.filter((e) => e.type === 'silence').length, 10, 'les silences réels sont signalés au retour du flux');
  s.arreter();
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('Secteurs : envoi LoRa en file (I6) — alertes simultanées regroupées, 30 s, plafond horaire, 200 octets, échec', () => {
  const lora = [];
  let panne = false;
  const { s, horloge, evenements, dossier } = secteursEssai({ envoyerLora: (t, c) => { if (panne) throw new Error('module coupé'); lora.push([horloge.t, t, c]); }, nomDe: (k) => (k === 'mt:' + 0x5a1e0001 ? 'Ω'.repeat(150) : null) });
  const sec = s.creer({ nom: 'Mont Bar', forme: 'cercle', centre: CENTRE, rayon: 1000, noeuds: [1, 2, 3], canalLora: 2, confirmations: 1, delaiMin: 1 }, 'essai');
  s.position('mt:1', { ...auNord(CENTRE, 5000), id: 1 });
  horloge.t += 1000; s.position('mt:2', { ...auNord(CENTRE, 5000), id: 2 });
  horloge.t += 1000; s.position('mt:3', { ...auNord(CENTRE, 5000), id: 3 });
  assert.equal(lora.length, 1, 'le premier part tout de suite');
  assert.match(lora[0][1], /^⛔ !00000001 hors secteur Mont Bar$/);
  // L'état d'envoi est mis à jour sur l'entrée du journal (les copies diffusées gardent l'état du moment)
  const sorties = () => s.journal({ limite: 3000 }).filter((e) => e.type === 'sortie').reverse();
  assert.deepEqual(sorties().map((e) => e.lora), ['envoyé', 'différé', 'différé']);
  horloge.t += 31000; s.viderLora();
  assert.equal(lora.length, 2, 'les deux suivants partent ensemble 30 s plus tard');
  assert.match(lora[1][1], /^⛔ !00000002, !00000003 hors secteur Mont Bar$/);
  assert.deepEqual(sorties().map((e) => e.lora), ['envoyé', 'envoyé (groupé)', 'envoyé (groupé)']);
  // Échec d'envoi : noté, le compteur n'est pas consommé, le message suivant part dès que le module revient
  panne = true;
  horloge.t += 120000; s.position('mt:1', { ...CENTRE, id: 4 }); s.position('mt:1', { ...auNord(CENTRE, 5000), id: 5 });
  horloge.t += 31000; s.viderLora();
  assert.match(sorties().pop().lora, /^échec : module coupé/);
  panne = false;
  s.position('mt:2', { ...CENTRE, id: 6 }); s.position('mt:2', { ...auNord(CENTRE, 5000), id: 7 });
  assert.equal(lora.length, 3, 'après un échec, l’envoi suivant n’attend pas 30 s');
  // Plafond : 20 messages par heure, puis « différé »
  for (let i = 0; i < 25; i++) { horloge.t += 61000; s.position('mt:3', { ...CENTRE, id: 100 + i }); s.position('mt:3', { ...auNord(CENTRE, 5000), id: 200 + i }); s.viderLora(); }
  assert.equal(lora.length, 20, '20 par heure au plus');
  assert.ok(sorties().some((e) => /20 messages par heure/.test(e.lora)));
  // File bornée à 10
  for (let i = 0; i < 15; i++) { horloge.t += 61000; s.position('mt:1', { ...CENTRE, id: 300 + i }); s.position('mt:1', { ...auNord(CENTRE, 5000), id: 400 + i }); }
  assert.ok(sorties().some((e) => /file d’envoi pleine/.test(e.lora)));
  // File vidée (un envoi toutes les 30 s), puis : 200 octets, coupés sans casser un caractère (nom de nœud de 300 octets)
  horloge.t += 3600000 * 2;
  for (let i = 0; i < 12; i++) { horloge.t += 31000; s.viderLora(); }
  const long = s.creer({ nom: 'Éééééééééééééééééééééééééééééééééééééééé', forme: 'cercle', centre: CENTRE, rayon: 1000, noeuds: [0x5a1e0001], canalLora: 1, confirmations: 1 }, 'essai');
  horloge.t += 31000; lora.length = 0;
  s.position('mt:' + 0x5a1e0001, { ...auNord(CENTRE, 5000), id: 'long' });
  assert.equal(lora.length, 1); assert.ok(Buffer.byteLength(lora[0][1]) <= 200 && Buffer.byteLength(lora[0][1]) >= 199, 'coupé à 200 octets : ' + Buffer.byteLength(lora[0][1]));
  assert.equal(Buffer.from(lora[0][1]).toString(), lora[0][1], 'aucun caractère cassé');
  assert.ok(long.id); s.arreter();
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('Secteurs : injection CSV neutralisée (I5), mesure GPS périmée (I9), doublon MeshCore sans horodatage (M6)', () => {
  const { s, horloge, evenements, dossier } = secteursEssai({ nomDe: (k) => ({ 'mt:1': '=HYPERLINK("http://x","clic")', 'mt:2': '-Alpha' })[k] || null });
  const sec = s.creer({ nom: '=1+1', forme: 'cercle', centre: CENTRE, rayon: 1000, noeuds: [1, 2], confirmations: 1 }, 'essai');
  s.position('mt:1', { ...auNord(CENTRE, 5000), id: 1 });
  const csv = s.csv();
  assert.ok(!/;=HYPERLINK/.test(csv) && !/^=1\+1/m.test(csv), 'aucune cellule ne commence par =');
  assert.match(csv, /;"'=HYPERLINK\(""http:\/\/x"",""clic""\)";/);
  assert.match(csv, /;'=1\+1;/);
  assert.match(csv, /;4000;/, 'la distance reste un nombre');
  // GPS périmé : le nœud répète un fix d'il y a 40 min → non compté, signalé
  horloge.t += 60000;
  const fix = horloge.t - 40 * 60000;
  s.position('mt:2', { ...CENTRE, id: 2 }); // dedans, précis
  assert.equal(s.secteur(sec.id).membres[1].etat, 'dedans');
  s.position('mt:2', { ...auNord(CENTRE, 5000), id: 3, heureFix: fix });
  assert.equal(s.secteur(sec.id).membres[1].etat, 'dedans', 'position périmée non comptée');
  const p = evenements.find((e) => e.type === 'perimee');
  assert.ok(p && p.niveau === 'attention' && /périmée \(mesure GPS d’il y a 40 min\)/.test(p.message));
  assert.ok(s.alertes().some((a) => a.cle.endsWith(':perimee')));
  s.position('mt:2', { ...auNord(CENTRE, 5000), id: 4, heureFix: fix });
  assert.equal(evenements.filter((e) => e.type === 'perimee').length, 1, 'signalé une fois par épisode');
  // Un fix vieux mais qui avance (horloge du nœud fausse, GPS vivant) : compté
  s.position('mt:2', { ...auNord(CENTRE, 5000), id: 5, heureFix: fix + 60000 });
  assert.equal(s.secteur(sec.id).membres[1].etat, 'dehors', 'fix qui avance : position comptée');
  assert.ok(!s.alertes().some((a) => a.cle.endsWith(':perimee')));
  // Un fix récent : compté normalement
  s.position('mt:2', { ...CENTRE, id: 6, heureFix: horloge.t - 30000 });
  assert.equal(s.secteur(sec.id).membres[1].etat, 'dedans');
  // MeshCore : annonce sans horodatage (id null) répétée par plusieurs observateurs = une seule position
  const CLE = 'CD'.repeat(32);
  const z = s.creer({ nom: 'MC', forme: 'cercle', centre: CENTRE, rayon: 1000, noeudsMc: [CLE], confirmations: 2 }, 'essai');
  s.position('mc:' + CLE, { ...auNord(CENTRE, 5000), id: null }); s.position('mc:' + CLE, { ...auNord(CENTRE, 5000), id: null });
  assert.equal(s.secteur(z.id).membres[0].etat, 'inconnu', 'même annonce vue deux fois : une seule position');
  s.position('mc:' + CLE, { ...auNord(CENTRE, 5001), id: null });
  assert.equal(s.secteur(z.id).membres[0].etat, 'dehors');
  // Horodatage plus vieux que la dernière position (annonce en retard) : ignoré
  horloge.t += 60000;
  s.position('mc:' + CLE, { ...CENTRE, id: 'vieux', heure: horloge.t - 120000 }); s.position('mc:' + CLE, { ...CENTRE, id: 'vieux2', heure: horloge.t - 120000 });
  assert.equal(s.secteur(z.id).membres[0].etat, 'dehors', 'positions en retard ignorées');
  s.arreter();
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('Secteurs : forme modifiée → états remis à inconnu (M13), équipe supprimée → secteur désactivé (M8), renumérotation (M7)', () => {
  const { s, horloge, evenements, dossier } = secteursEssai();
  const sec = s.creer({ nom: 'Plateau', forme: 'cercle', centre: CENTRE, rayon: 1000, equipe: 'eq1', noeuds: [7], confirmations: 1 }, 'essai');
  s.position('mt:7', { ...CENTRE, id: 1 });
  assert.equal(s.secteur(sec.id).membres.find((m) => m.cle === 'mt:7').etat, 'dedans');
  s.modifier(sec.id, { forme: 'cercle', centre: auNord(CENTRE, 10000), rayon: 1000 }, 'essai');
  assert.equal(s.secteur(sec.id).membres.find((m) => m.cle === 'mt:7').etat, 'inconnu', 'nouvelle forme : l’ancien état ne vaut plus');
  s.modifier(sec.id, { marge: 60 }, 'essai');
  // Renumérotation : l'état du nouveau numéro, plus récent, n'est pas écrasé
  s.position('mt:7', { ...auNord(CENTRE, 10000), id: 2 });
  horloge.t += 60000;
  s.position('mt:8', { ...CENTRE, id: 3 });
  const avant = s.secteur(sec.id).membres.length;
  s.renumeroter(7, 8);
  assert.deepEqual(s.secteur(sec.id).noeuds, [8]);
  assert.equal(s.secteur(sec.id).membres.length, avant, '7 devient 8');
  assert.equal(s.renumeroter(7, 7), 0);
  // Équipe supprimée : le secteur garde ses nœuds explicites → reste actif ; un secteur lié seulement à l'équipe est désactivé
  const seul = s.creer({ nom: 'Équipe seule', forme: 'cercle', centre: CENTRE, rayon: 1000, equipe: 'eq1' }, 'essai');
  assert.equal(s.equipeSupprimee('eq1'), 1);
  assert.equal(s.secteur(seul.id).actif, false); assert.equal(s.secteur(sec.id).actif, true); assert.equal(s.secteur(sec.id).equipe, null);
  assert.ok(evenements.some((e) => e.type === 'desactivation' && e.secteur === seul.id && e.notifier));
  s.arreter();
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('Mode urgence : message de détresse — motif élargi, mots entiers, pas d’explosion (I8), export CSV sans formule (I5)', () => {
  const { RE_SOS } = require('../src/equipes');
  for (const t of ['SOS', 'S.O.S', 's.o.s au col', 'Mayday mayday', 'au secours', 'help', 'aidez moi', 'aidez-moi', 'A L\'AIDE', 'à l’aide !', 'besoin d’aide', 'test \u0007']) assert.ok(RE_SOS.test(t), 'détresse : ' + t);
  for (const t of ['sosie', 'isostatique', 'helpdesk', 'URGENT blessé', 'mayday2', 'xhelp']) assert.ok(!RE_SOS.test(t), 'pas une détresse : ' + t);
  const t0 = Date.now(); RE_SOS.test('besoin d'.repeat(130000)); assert.ok(Date.now() - t0 < 500, '1 Mo de texte analysé sans explosion');
  const { creerUrgence } = require('../src/urgence');
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'urgence-'));
  const u = creerUrgence({ config: { fichierBase: path.join(dossier, 'base.db') } });
  u.activer({ motif: 'essai' }, 'admin');
  u.note('=HYPERLINK("http://x")', 'gest'); u.note('+33 6 12', 'gest'); u.note('@SUM(1)\tfoo\r\nbar', 'gest');
  u.noter({ type: 'alerte', niveau: 'critique', texte: '=cmd|x muet', noeud: 0x5a1e0001 });
  const csv = u.csv().texte;
  assert.ok(!/;[=+@]/.test(csv.replace(/;"'/g, ';x')), 'aucune cellule ne commence par = + @ : ' + csv);
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/x""\)"/); assert.match(csv, /;'\+33 6 12$/m); assert.match(csv, /"'@SUM\(1\)\tfoo \nbar"/, 'le retour chariot est remplacé par une espace à la saisie'); assert.match(csv, /;'=cmd\|x muet$/m);
  u.arreter();
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('Mur des donateurs : anonymisation du nom (jamais le nom complet, au plus la moitié)', () => {
  assert.equal(anonymiser(''), 'Un donateur');
  assert.notEqual(anonymiser('Jean Dupont'), 'Jean Dupont');
  assert.ok(anonymiser('Jean Dupont').endsWith('***'));
  assert.ok(anonymiser('Jean Dupont').length < 'Jean Dupont'.length);
  assert.equal(anonymiser('42BARBE'), '42B***', 'au plus la moitié des caractères');
  assert.equal(anonymiser('Jo'), 'J***', 'nom court : un seul caractère visible');
  assert.equal(anonymiser('Bob'), 'B***');
  assert.equal(anonymiser('F4GLD'), 'F4***');
  assert.equal(anonymiser('Un nom vraiment très long'), 'Un nom***', 'six caractères au plus');
  assert.equal(anonymiser('😀😀'), '😀***', 'émoji jamais coupé en deux');
  assert.equal(anonymiser('🇫🇷🇫🇷🇫🇷🇫🇷🇫🇷🇫🇷'), '🇫🇷🇫🇷🇫🇷***', 'drapeaux (2 points de code chacun) jamais coupés');
});

test('Mur des donateurs : fichier en 600, seul ce qui est saisi dans la page est enregistré, effacement, plafond, pays, liens', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'don-'));
  const fichier = path.join(dossier, 'donateurs.json');
  fs.writeFileSync(fichier, JSON.stringify({ reglages: {}, manuel: [] }), { mode: 0o644 });
  const cfg = configDonateurs(dossier, { helloasso: { actif: true, clientId: 'id-env', clientSecret: 'secret-env', organisation: 'radioclub-du-velay', formulaire: '2', type: 'Donation' }, githubSponsors: { actif: false, jeton: 'jeton-env', compte: 'sauveteur71' } });
  const urls = [];
  const fauxFetch = async (url, opt = {}) => {
    urls.push(String(url));
    if (/oauth2\/token/.test(url)) return { ok: true, status: 200, json: async () => ({ access_token: 'jeton-oauth', expires_in: 1800 }) };
    if (/\/v5\/organizations\/radioclub-du-velay\/forms\?formTypes=Donation/.test(url)) return { ok: true, status: 200, json: async () => ({ data: [{ formSlug: '2', formType: 'Donation' }] }) };
    throw new Error('URL inattendue : ' + url);
  };
  const don = creerDonateurs({ config: cfg, journal: () => {}, fetch: fauxFetch });
  if (process.platform !== 'win32') assert.equal(fs.statSync(fichier).mode & 0o777, 0o600, 'fichier existant resserré en 600 au démarrage');
  // Vérification HelloAsso : jeton puis liste des formulaires, jamais la page des paiements
  await don.rafraichir();
  assert.equal(don.etat().erreurs.helloasso, null);
  assert.ok(urls.some((u) => /\/forms\?formTypes=Donation/.test(u)) && !urls.some((u) => /payments/.test(u)), 'vérification sans lire de paiement');
  assert.match(don.urlPaiementsHelloAsso(), /\/forms\/Donation\/2\/payments$/, 'adresse des paiements : type de formulaire réglable');
  // Réglage depuis la page : seul ce qui est saisi va sur disque, jamais les secrets du .env
  don.regler({ montantVisible: true, helloasso: { formulaire: '3', clientId: 'id-page' } });
  const disque = JSON.parse(fs.readFileSync(fichier, 'utf8'));
  assert.deepEqual(disque.reglages.helloasso, { formulaire: '3', clientId: 'id-page' });
  assert.ok(!JSON.stringify(disque).includes('secret-env') && !JSON.stringify(disque).includes('jeton-env'), 'secrets du .env jamais recopiés');
  if (process.platform !== 'win32') assert.equal(fs.statSync(fichier).mode & 0o777, 0o600, 'écrit en 600');
  let e = don.etat().reglages.helloasso;
  assert.equal(e.clientIdSaisi, true); assert.equal(e.clientSecretSaisi, false); assert.equal(e.clientSecretDefini, true);
  // Effacer un secret saisi : le .env reprend la main
  don.regler({ helloasso: { clientIdEffacer: true } });
  e = don.etat().reglages.helloasso;
  assert.equal(e.clientIdSaisi, false); assert.equal(e.clientIdDefini, true, 'le .env reprend la main');
  assert.throws(() => don.regler({ helloasso: { type: 'Pirate' } }), /type de formulaire/);
  assert.throws(() => don.regler({ helloasso: { organisation: '../x' } }), /slug/);
  // Liens « Faire un don » : tirés des réglages, absents quand la source est désactivée
  assert.deepEqual(don.liens(), { helloasso: 'https://www.helloasso.com/associations/radioclub-du-velay/formulaires/3', github: null });
  don.regler({ helloasso: { actif: false }, githubSponsors: { actif: true, compte: 'f4xyz' } });
  assert.deepEqual(don.liens(), { helloasso: null, github: 'https://github.com/sponsors/f4xyz' });
  // Pays : code à 2 lettres ou rien ; pas de date dans la liste publique
  assert.throws(() => don.manuelAjouter({ nom: 'X', pays: 'France', accord: true }), /Pays/);
  assert.throws(() => don.manuelAjouter({ nom: 'X', pays: 'f1', accord: true }), /Pays/);
  don.manuelAjouter({ nom: 'Jo', pays: 'fr', montant: '12.5', accord: true });
  assert.deepEqual(Object.keys(don.liste()[0]).sort(), ['devise', 'montant', 'nom', 'pays', 'source']);
  assert.equal(don.liste()[0].montant, 12.5);
  // Plafond : refus explicite au-delà, jamais de suppression silencieuse
  for (let k = don.etat().manuel.length; k < 200; k++) don.manuelAjouter({ nom: 'D' + k, accord: true });
  assert.throws(() => don.manuelAjouter({ nom: 'Trop', accord: true }), /Liste pleine/);
  assert.equal(don.etat().manuel.length, 200);
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('Mur des donateurs : GitHub paginé, parrainages publics seulement, données extérieures vérifiées', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'don-'));
  const corps = [];
  const fauxFetch = async (url, opt = {}) => {
    const b = JSON.parse(opt.body); corps.push(b);
    assert.match(b.query, /includePrivate:false/);
    const page2 = b.variables.apres === 'curseur-1';
    return { ok: true, json: async () => ({ data: { user: { sponsorshipsAsMaintainer: {
      pageInfo: { hasNextPage: !page2, endCursor: page2 ? null : 'curseur-1' },
      nodes: page2 ? [
        { privacyLevel: 'PUBLIC', createdAt: 'pas une date', sponsorEntity: { login: 'sansdate', name: 42 }, tier: { monthlyPriceInDollars: 'abc', isOneTime: false } },
        { privacyLevel: 'PUBLIC', createdAt: '2026-01-02T00:00:00Z', sponsorEntity: null },
        'n’importe quoi', null,
      ] : [
        { privacyLevel: 'PUBLIC', createdAt: '2026-01-03T00:00:00Z', sponsorEntity: { login: 'public1', name: 'Public Un' }, tier: { monthlyPriceInDollars: 3, isOneTime: false } },
        { privacyLevel: 'PRIVATE', createdAt: '2026-01-04T00:00:00Z', sponsorEntity: { login: 'prive1', name: 'Jamais Montré' }, tier: { monthlyPriceInDollars: 100, isOneTime: false } },
      ],
    } } } }) };
  };
  const don = creerDonateurs({ config: configDonateurs(dossier, { githubSponsors: { actif: true, jeton: 'jeton-test', compte: 'sauveteur71' } }), journal: () => {}, fetch: fauxFetch });
  don.regler({ montantVisible: true });
  await don.rafraichir();
  assert.ok(corps.length >= 2 && corps[1].variables.apres === 'curseur-1', 'deux pages lues');
  const l = don.liste();
  assert.deepEqual(l.map((x) => [x.nom, x.montant]), [['Publ***', 3], ['sans***', null]], 'nom de repli (login), montant non numérique → null, entrée sans sponsor ignorée');
  assert.ok(!JSON.stringify(l).includes('Jamais'), 'sponsor privé jamais affiché');
  // Réglage pendant une actualisation : une autre est relancée juste après (pas de réglage ignoré)
  let bloque; const attente = new Promise((r) => { bloque = r; });
  const donLent = creerDonateurs({ config: configDonateurs(dossier, { githubSponsors: { actif: true, jeton: 'jeton-test', compte: 'sauveteur71' } }), journal: () => {}, fetch: async (url, opt) => { await attente; return fauxFetch(url, opt); } });
  const p = donLent.rafraichir();
  donLent.regler({ githubSponsors: { actif: false } });
  bloque(); await p;
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(donLent.liste(), [], 'la source désactivée pendant l’actualisation ne laisse rien sur le mur');
  fs.rmSync(dossier, { recursive: true, force: true });
});

function configDonateurs(dossier, extra = {}) {
  return {
    fichierBase: path.join(dossier, 'base.db'),
    donateurs: {
      helloasso: { actif: false, clientId: '', clientSecret: '', organisation: 'radioclub-du-velay', formulaire: '2' },
      githubSponsors: { actif: false, jeton: '', compte: 'sauveteur71' },
      intervalleHeures: 1,
      ...extra,
    },
  };
}

test('Mur des donateurs : fusion HelloAsso (manuel, consenti) + GitHub Sponsors (publics), triés par date', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'don-'));
  const appels = [];
  const fauxFetch = async (url) => {
    appels.push(String(url));
    if (/graphql/.test(url)) {
      return { ok: true, json: async () => ({ data: { user: { sponsorshipsAsMaintainer: { nodes: [
        { privacyLevel: 'PUBLIC', createdAt: '2026-01-01T00:00:00Z', sponsorEntity: { login: 'f4abc', name: 'F4ABC' }, tier: { monthlyPriceInDollars: 5, isOneTime: false } },
      ] } } } }) };
    }
    throw new Error('URL inattendue : ' + url);
  };
  const don = creerDonateurs({ config: configDonateurs(dossier, { githubSponsors: { actif: true, jeton: 'jeton-test', compte: 'sauveteur71' } }), journal: () => {}, fetch: fauxFetch });
  don.manuelAjouter({ nom: '42BARBE', pays: 'fr', montant: 20, accord: true });
  await don.rafraichir();
  const l = don.liste();
  assert.equal(l.length, 2);
  assert.ok(l.every((x) => !x.nom.includes('Dupont') && x.nom.endsWith('***') || x.nom === 'Un donateur'));
  assert.ok(l.some((x) => x.source === 'helloasso' && x.pays === 'FR'));
  assert.ok(l.some((x) => x.source === 'github'));
  // Montant masqué par défaut (seul l'administrateur l'active)
  assert.ok(l.every((x) => x.montant == null));
  assert.ok(appels.some((u) => /graphql/.test(u)));
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('Mur des donateurs : filtrage des non-consentants (accord manquant, sponsor GitHub privé)', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'don-'));
  // Donnée existante (restauration après redémarrage) comportant une entrée jamais consentie : ne doit jamais apparaître
  fs.writeFileSync(path.join(dossier, 'donateurs.json'), JSON.stringify({
    reglages: {},
    manuel: [
      { id: 'a1', nom: 'Accord donné', pays: 'FR', montant: 10, date: '2026-01-01T00:00:00Z', accord: true },
      { id: 'a2', nom: 'Jamais consenti', pays: 'FR', montant: 50, date: '2026-01-02T00:00:00Z', accord: false },
    ],
  }));
  const fauxFetch = async (url) => {
    if (/graphql/.test(url)) {
      return { ok: true, json: async () => ({ data: { user: { sponsorshipsAsMaintainer: { nodes: [
        { privacyLevel: 'PUBLIC', createdAt: '2026-01-03T00:00:00Z', sponsorEntity: { login: 'public1', name: 'Public Un' }, tier: { monthlyPriceInDollars: 3, isOneTime: false } },
        { privacyLevel: 'PRIVATE', createdAt: '2026-01-04T00:00:00Z', sponsorEntity: { login: 'prive1', name: 'Jamais Montré' }, tier: { monthlyPriceInDollars: 100, isOneTime: false } },
      ] } } } }) };
    }
    throw new Error('URL inattendue : ' + url);
  };
  const don = creerDonateurs({ config: configDonateurs(dossier, { githubSponsors: { actif: true, jeton: 'jeton-test', compte: 'sauveteur71' } }), journal: () => {}, fetch: fauxFetch });
  await don.rafraichir();
  const l = don.liste();
  assert.equal(l.length, 2, 'seuls les deux consentants (1 manuel + 1 sponsor public) apparaissent');
  assert.ok(!l.some((x) => x.source === 'helloasso' && x.montant === 50), 'entrée sans accord jamais affichée');
  // Sans accord, l'ajout manuel est carrément refusé (jamais enregistré silencieusement)
  assert.throws(() => don.manuelAjouter({ nom: 'Sans case cochée' }), /accord du donateur/);
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('Mur des donateurs : repli si une source devient indisponible (le cache précédent est gardé)', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'don-'));
  let enPanne = false;
  const fauxFetch = async (url) => {
    if (/graphql/.test(url)) {
      if (enPanne) throw new Error('GitHub injoignable (essai)');
      return { ok: true, json: async () => ({ data: { user: { sponsorshipsAsMaintainer: { nodes: [
        { privacyLevel: 'PUBLIC', createdAt: '2026-01-01T00:00:00Z', sponsorEntity: { login: 'stable', name: 'Sponsor Stable' }, tier: { monthlyPriceInDollars: 5, isOneTime: false } },
      ] } } } }) };
    }
    throw new Error('URL inattendue : ' + url);
  };
  const don = creerDonateurs({ config: configDonateurs(dossier, { githubSponsors: { actif: true, jeton: 'jeton-test', compte: 'sauveteur71' } }), journal: () => {}, fetch: fauxFetch });
  await don.rafraichir();
  assert.equal(don.liste().length, 1);
  assert.equal(don.etat().erreurs.githubSponsors, null);
  enPanne = true;
  await don.rafraichir();
  assert.ok(don.etat().erreurs.githubSponsors, 'la panne est signalée');
  assert.equal(don.liste().length, 1, 'le mur garde la dernière liste connue plutôt que de se vider');
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('Mur des donateurs : source désactivée = liste vide pour cette source, réglages jamais renvoyés en clair', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'don-'));
  const don = creerDonateurs({ config: configDonateurs(dossier), journal: () => {}, fetch: async () => { throw new Error('ne doit pas être appelé'); } });
  await don.rafraichir();
  assert.deepEqual(don.liste(), []);
  const e = don.etat();
  assert.equal(e.reglages.githubSponsors.jetonDefini, false);
  assert.ok(!('jeton' in e.reglages.githubSponsors));
  assert.ok(!('clientSecret' in e.reglages.helloasso));
  don.regler({ githubSponsors: { jeton: 'secret-abc' } });
  assert.equal(don.etat().reglages.githubSponsors.jetonDefini, true);
  assert.ok(!JSON.stringify(don.etat()).includes('secret-abc'), 'le jeton n’est jamais renvoyé en clair');
  fs.rmSync(dossier, { recursive: true, force: true });
});

// ---------- Calculs de couverture partagés : 5 demandes simultanées = 1 calcul ----------
test('Calcul partagé par clé : demandes simultanées servies par une seule exécution, promesse retirée ensuite', async () => {
  const { creerCalculPartage } = require('../src/calcul-partage');
  const c = creerCalculPartage();
  let lances = 0;
  const calcul = () => new Promise((ok) => { lances++; setTimeout(() => ok({ valeur: lances }), 30); });
  const r = await Promise.all([1, 2, 3, 4, 5].map(() => c.partager('a', calcul)));
  assert.equal(lances, 1, 'un seul calcul pour cinq demandes identiques');
  assert.ok(r.every((x) => x === r[0]), 'tous reçoivent le même résultat');
  assert.equal(c.nombre(), 0, 'promesse retirée une fois réglée');
  await c.partager('a', calcul);
  assert.equal(lances, 2, 'après règlement, une nouvelle demande relance le calcul');
  // Une autre clé est un autre calcul ; un échec est propagé puis oublié
  await Promise.all([c.partager('b', calcul), c.partager('a', calcul)]);
  assert.equal(lances, 4);
  await assert.rejects(c.partager('c', () => Promise.reject(new Error('relief absent'))), /relief absent/);
  assert.equal(c.nombre(), 0);
});

// ---------- Résumé des opérations de programmation (Gérer › Programmer › Opérations récentes) ----------
// Ce résumé est la seule trace de ce qui a été envoyé à un relais : il doit dire les valeurs, en français,
// avec les unités, sans jamais laisser sortir une clé.
const resumeOps = require('../src/resume-operations');
const resumeDe = (t) => resumeOps.resumeOperation(t, { canaux: 'Canaux (noms, clés, ordre)', frequence: 'Région, slot et fréquence' });

test('Résumé d’une modification : les valeurs envoyées, en français et avec les unités', () => {
  // Le cas d'Olivier : avant, l'historique n'affichait que « télémétrie · device (nodeInfoBroadcastSecs) »
  const t = { type: 'modifier', params: { device: { nodeInfoBroadcastSecs: 10800 }, telemetrie: { deviceUpdateInterval: 1800 } } };
  const d = resumeOps.detailsOperation(t);
  assert.deepEqual(d.map((x) => `${x.lib} : ${x.valeur}`), ['Fiche du nœud : toutes les 3 h', 'Télémétrie : toutes les 30 min']);
  assert.ok(!resumeDe(t).includes('nodeInfoBroadcastSecs'), 'aucun nom de champ du firmware dans le résumé');
  // Unités : secondes, minutes, heures, dBm, sauts, mètres
  const t2 = { type: 'modifier', params: { device: { nodeInfoBroadcastSecs: 86400 }, lora: { hopLimit: 4, txPower: 20, txEnabled: true, channelNum: 0, overrideFrequency: 869.618 }, position: { positionBroadcastSecs: 43200, positionBroadcastSmartEnabled: false }, voisinage: { updateInterval: 604800 } } };
  const r2 = resumeDe(t2);
  assert.match(r2, /Sauts : 4(?! sauts)/);
  assert.match(r2, /Puissance d’émission : 20 dBm/);
  assert.match(r2, /Slot : auto/);
  assert.match(r2, /Fréquence forcée : 869\.6180 MHz/);
  assert.match(r2, /Position : toutes les 12 h/);
  assert.match(r2, /Position intelligente : non/);
  // Durées : jours seulement au-delà de 24 h, pour lire comme les menus déroulants du formulaire
  assert.match(r2, /Voisinage : toutes les 7 j/);
  assert.match(r2, /Fiche du nœud : toutes les 24 h/);
  assert.deepEqual([0, 45, 900, 3600, 43200, 86400, 129600, 172800, 604800].map(resumeOps.toutesLes),
    ['défaut', 'toutes les 45 s', 'toutes les 15 min', 'toutes les 1 h', 'toutes les 12 h', 'toutes les 24 h', 'toutes les 36 h', 'toutes les 2 j', 'toutes les 7 j']);
  // Rôle et politique de signature : noms lisibles, pas les constantes du protobuf
  const t3 = { type: 'modifier', params: { device: { role: 'ROUTER_LATE' }, securite: { packetSignaturePolicy: 'PACKET_SIGNATURE_POLICY_STRICT' } } };
  assert.match(resumeDe(t3), /Rôle : Routeur tardif/);
  assert.match(resumeDe(t3), /Signature des paquets : Stricte \(signés seulement\)/);
  assert.ok(!resumeDe(t3).includes('PACKET_SIGNATURE_POLICY'));
});

test('Résumé : aucun secret ne sort (clé de canal, clé d’administration, mot de passe, jeton)', () => {
  const pskCanal = 'c2VjcmV0ZGVjYW5hbDEyMzQ1Njc4OTBhYmNk';
  const t = {
    type: 'modifier',
    params: {
      canaux: [{ index: 0, nom: 'LongFast', psk: 'AQ==', precision: 16, montant: true, descendant: true }, { index: 2, nom: 'Secours', psk: pskCanal, precision: 32 }],
      securite: { adminKey: 'Q0xFREFETUlOMTIzNDU2Nzg5MA==', privateKey: 'cHJpdmVlMTIzNDU2Nzg5MGFiY2RlZg==' },
      lora: { wifiPsk: 'motDePasseWifi123', hopLimit: 3 },
      device: { motDePasse: 'secret-du-relais', jetonMqtt: 'jeton-abcdef' },
      // Champ inconnu dont la valeur ressemble à une clé en base64 : masqué par précaution
      inventeDemain: { quelqueChose: 'QUJDREVGR0hJSktMTU5PUFFSUw==' },
    },
  };
  const r = resumeDe(t);
  for (const secret of [pskCanal, 'Q0xFREFETUlOMTIzNDU2Nzg5MA==', 'cHJpdmVlMTIzNDU2Nzg5MGFiY2RlZg==', 'motDePasseWifi123', 'secret-du-relais', 'jeton-abcdef', 'QUJDREVGR0hJSktMTU5PUFFSUw==', 'AQ=='].sort()) {
    assert.ok(!r.includes(secret), `« ${secret} » ne doit pas apparaître dans le résumé`);
  }
  assert.match(r, /canal 0 : LongFast/);
  assert.match(r, /clé envoyée \(non affichée\)/);
  assert.match(r, /Sauts : 3/, 'les réglages non sensibles de la même section restent lisibles');
  assert.match(r, /\(masqué\)/, 'un champ sensible est signalé comme masqué, pas oublié en silence');
  // Le détail renvoyé au navigateur ne contient aucun secret non plus
  assert.ok(!JSON.stringify(resumeOps.detailsOperation(t)).includes(pskCanal));
  // La fonction de détection reconnaît les noms de champs sensibles usuels
  for (const nom of ['psk', 'adminKey', 'wifiPsk', 'motDePasse', 'jeton', 'mqttPassword', 'privateKey', 'cleCanal', 'authToken']) {
    assert.ok(resumeOps.sensible(nom, 'x'), `${nom} doit être traité comme sensible`);
  }
  // …et ne masque aucun réglage normal (sinon le résumé perdrait de l'information)
  for (const cle of resumeOps.CHAMPS_CONNUS) assert.ok(!resumeOps.masquer(cle, cle, 1), `${cle} ne doit pas être pris pour un secret`);
  // Un nom de nœud long, fait de lettres et de chiffres, n'est pas pris pour une clé
  assert.equal(resumeDe({ type: 'nom', params: { nomLong: '43BouchetRelais01' } }), 'Nom long : 43BouchetRelais01');
});

test('Résumé : valeur mesurée avant correction (Contrôle du trafic) affichée comme une mesure, pas comme un réglage', () => {
  const t = {
    type: 'modifier',
    params: { device: { nodeInfoBroadcastSecs: 10800 }, telemetrie: { deviceUpdateInterval: 1800 } },
    mesures: { heures: 24, valeurs: { 'device.nodeInfoBroadcastSecs': 360, 'telemetrie.deviceUpdateInterval': 240 } },
  };
  const d = resumeOps.detailsOperation(t);
  assert.deepEqual(d[0].notes, ['mesuré sur 24 h : toutes les 6 min']);
  assert.deepEqual(d[1].notes, ['mesuré sur 24 h : toutes les 4 min']);
  assert.match(resumeDe(t), /Fiche du nœud : toutes les 3 h · mesuré sur 24 h : toutes les 6 min/);
  // Le mot « mesuré » est obligatoire : ce n'est pas le réglage précédent du nœud
  assert.ok(!resumeDe(t).includes('avant :'));
});

test('Résumé : valeur précédente réellement lue sur le nœud, avec l’âge de la lecture', () => {
  const t = {
    type: 'modifier',
    params: { lora: { hopLimit: 4 }, position: { positionBroadcastSecs: 43200 }, nom: { nomLong: 'Bouchet' } },
    avant: { heure: Date.now() - 20 * 60000, valeurs: { 'lora.hopLimit': 3, 'position.positionBroadcastSecs': 900, 'nom.nomLong': '43Bouchet' } },
  };
  const r = resumeDe(t);
  assert.match(r, /Sauts : 4 · avant : 3 \(lu il y a 20 min\)/);
  assert.match(r, /Position : toutes les 12 h · avant : toutes les 15 min \(lu il y a 20 min\)/);
  assert.match(r, /Nom long : Bouchet · avant : 43Bouchet \(lu il y a 20 min\)/);
  // Valeur identique : pas de « avant → après » inutile
  const t2 = { type: 'modifier', params: { lora: { hopLimit: 3 } }, avant: { heure: Date.now(), valeurs: { 'lora.hopLimit': 3 } } };
  assert.equal(resumeDe(t2), 'Sauts : 3');
  // Sans lecture précédente ni mesure : seule la valeur envoyée, rien d'inventé
  const t3 = { type: 'modifier', params: { lora: { hopLimit: 4 } } };
  assert.equal(resumeDe(t3), 'Sauts : 4');
});

test('Résumé : canaux, nom, position fixe, équipe, firmware, favoris et vérification', () => {
  const canal = { type: 'canal', params: { index: 0, nom: 'LongFast', psk: 'AQ==', precision: 16, montant: true, descendant: false, role: 'PRIMARY' } };
  assert.equal(resumeDe(canal), 'canal 0 : LongFast · principal · clé envoyée (non affichée) · ≈ 364 m · MQTT ↑');
  assert.equal(resumeOps.toucheCanalPrincipal(canal), true);
  const suppr = { type: 'canal', params: { index: 3, role: 'DISABLED' } };
  assert.equal(resumeDe(suppr), 'canal 3 : supprimé');
  assert.equal(resumeOps.toucheCanalPrincipal(suppr), false);
  assert.equal(resumeDe({ type: 'nom', params: { nomLong: 'Le Bouchet', nomCourt: 'BCH' } }), 'Nom long : Le Bouchet · Nom court : BCH');
  assert.equal(resumeDe({ type: 'position', params: { lat: 45.12345, lon: 3.98765, alt: 1120 } }), 'Position fixe : 45.12345, 3.98765 · 1120 m');
  assert.equal(resumeDe({ type: 'position', params: { retirer: true } }), 'Position fixe : retirée (retour au GPS)');
  assert.equal(resumeDe({ type: 'equipe', params: { action: 'cle', nom: 'SDIS43' } }), 'Canal d’équipe : SDIS43 · nouvelle clé du canal');
  assert.equal(resumeDe({ type: 'firmware', params: { version: '2.8.1' } }), 'Firmware : 2.8.1');
  assert.equal(resumeDe({ type: 'favoris', params: { plan: { 1: { ajouter: [2, 3] }, 4: { ajouter: [5] } } } }), '3 favori(s) à poser sur 2 relais');
  assert.equal(resumeDe({ type: 'verifier', params: { reference: 0x43abcdef, elements: ['canaux', 'frequence'] } }), 'Référence : !43abcdef · Canaux (noms, clés, ordre) · Région, slot et fréquence');
  // Réglage rapide (Autres actions) : mêmes libellés que l'éditeur complet
  assert.equal(resumeDe({ type: 'config', params: { section: 'voisinage', valeurs: { enabled: true, updateInterval: 21600 } } }), 'Voisinage : activé · Voisinage : toutes les 6 h');
  // Opération sans réglage : résumé vide (la carte d'opération n'affiche alors rien)
  assert.equal(resumeDe({ type: 'redemarrer', params: {} }), '');
});

test('Résumé : tous les réglages modifiables à distance ont un libellé lisible', () => {
  // Liste à tenir à jour avec CHAMPS / CHAMPS_TRAFIC / valeursVoisinage / valeursTelemetrie de src/administration.js
  const attendus = [
    'device.role', 'device.nodeInfoBroadcastSecs', 'device.rebroadcastMode',
    'lora.hopLimit', 'lora.modemPreset', 'lora.txPower', 'lora.txEnabled', 'lora.region', 'lora.channelNum', 'lora.usePreset',
    'lora.sx126xRxBoostedGain', 'lora.configOkToMqtt', 'lora.ignoreMqtt', 'lora.overrideFrequency',
    'position.positionBroadcastSecs', 'position.positionBroadcastSmartEnabled', 'position.fixedPosition',
    'voisinage.enabled', 'voisinage.transmitOverLora', 'voisinage.updateInterval',
    'telemetrie.deviceUpdateInterval', 'telemetrie.deviceTelemetryEnabled',
    'trafic.positionMinIntervalSecs', 'trafic.nodeinfoDirectResponseMaxHops', 'trafic.rateLimitWindowSecs', 'trafic.rateLimitMaxPackets', 'trafic.unknownPacketThreshold',
    'securite.packetSignaturePolicy', 'nom.nomLong', 'nom.nomCourt',
  ];
  for (const cle of attendus) {
    assert.ok(resumeOps.CHAMPS[cle], `pas de libellé lisible pour ${cle}`);
    const lib = resumeOps.CHAMPS[cle].lib;
    assert.ok(/^[A-ZÀ-Ý]/.test(lib) && lib !== cle.slice(cle.indexOf('.') + 1), `le libellé de ${cle} doit être du français, pas un nom de champ`);
  }
  // Un champ inconnu garde son nom technique plutôt qu'une traduction inventée
  const d = resumeOps.detailsOperation({ type: 'modifier', params: { device: { champPasEncoreConnu: 7 } } });
  assert.deepEqual(d, [{ lib: 'champPasEncoreConnu', valeur: '7', brut: true }]);
});

test('Contrôle du trafic : la correction et la mesure d’avant portent sur les mêmes réglages', () => {
  const fausseDb = { prepare: () => ({ all: () => [], get: () => ({ n: 0 }), iterate: () => [] }) };
  const ct = require('../src/trafic').creerControleTrafic({ stockage: { db: fausseDb }, config: { zone: [44, 3, 46, 5] }, administration: null });
  const e = { num: 1, fixe: true, problemes: [{ port: 'nodeinfo', medianS: 360 }, { port: 'telemetrie', medianS: 240 }, { port: 'position', medianS: 120 }] };
  const params = ct.correctifs(e);
  const mesures = ct.mesures(e, 24);
  assert.deepEqual(mesures, { heures: 24, valeurs: { 'device.nodeInfoBroadcastSecs': 360, 'telemetrie.deviceUpdateInterval': 240, 'position.positionBroadcastSecs': 120 } });
  // Chaque réglage corrigé a bien sa mesure d'avant
  for (const cle of Object.keys(mesures.valeurs)) {
    const [sec, champ] = [cle.slice(0, cle.indexOf('.')), cle.slice(cle.indexOf('.') + 1)];
    assert.ok(params[sec] && params[sec][champ] != null, `${cle} corrigé`);
  }
  const r = resumeDe({ type: 'modifier', params, mesures });
  assert.match(r, /Fiche du nœud : toutes les 3 h · mesuré sur 24 h : toutes les 6 min/);
  assert.match(r, /Télémétrie : toutes les 30 min · mesuré sur 24 h : toutes les 4 min/);
  assert.match(r, /Position : toutes les 12 h · mesuré sur 24 h : toutes les 2 min/);
  // Une mesure n'est jamais envoyée au module : elle ne doit pas se retrouver dans les paramètres
  assert.ok(!JSON.stringify(params).includes('360'));
  assert.equal(ct.mesures({ problemes: [] }, 24), null);
});

// ---------- Relevé automatique des capteurs MeshCore : il doit repartir tout seul et se signaler ----------
// Banc : vrai module de relevé + vraie file de tâches d'administration, avec un faux companion et une horloge
// simulée (on avance de plusieurs heures en quelques millisecondes).
function bancCapteursMc(t, { intervalleMin = 180, nb = 3, reglagesMc = null } = {}) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'setImmediate', 'Date'], now: Date.parse('2026-11-21T20:00:00Z') });
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-capteurs-'));
  const { creerStockage } = require('../src/base');
  const { creerAdministrationMc } = require('../src/meshcore/administration');
  const { creerCapteursMc } = require('../src/meshcore/capteurs');
  const st = creerStockage(path.join(dossier, 'x.db'));
  const config = { fichierBase: path.join(dossier, 'x.db'), meshcore: { supervisionHeures: 0, supervisionMax: 8, ...(reglagesMc || {}) } };
  const CLES = ['A', 'B', 'C', 'D'].slice(0, nb).map((c) => c.repeat(64));
  const noeuds = new Map(CLES.map((c, i) => [c, { cle: c, nom: 'Capteur ' + i, role: 'capteur', lat: 45, lon: 4, horodatage_annonce: 0 }]));
  const reseauMc = { q: { noeud: { get: (c) => noeuds.get(String(c).toUpperCase()) } }, noterEtat: () => {}, resoudreChemin: () => [], surveilles: () => [] };
  const cas = { muets: new Set(), echecs: new Map(), pret: true }; // muets : ne répondent jamais ; echecs : n échecs puis ça marche
  const lectures = [];
  const companion = {
    etat: () => ({ pret: cas.pret, cle: 'FF'.repeat(32), nom: 'companion', connecte: cas.pret }),
    contacts: () => [],
    async telemetrie(n) {
      if (cas.muets.has(n.cle)) return new Promise(() => {}); // aucune réponse, jamais
      const reste = cas.echecs.get(n.cle) || 0;
      if (reste > 0) { cas.echecs.set(n.cle, reste - 1); throw new Error('pas de réponse dans le délai (40 s)'); }
      lectures.push({ cle: n.cle, heure: Date.now() });
      return [{ type: 'tension', canal: 1, valeur: 4.09, unite: 'V' }];
    },
    async connexion() { return { admin: true }; },
    async cli() { return 'ok'; },
  };
  const journal = [];
  const adminMc = creerAdministrationMc(config, companion, reseauMc, (...a) => journal.push(a.join(' ')));
  const capteurs = creerCapteursMc({ db: st.db, config, adminMc, companion, journal: (...a) => journal.push(a.join(' ')) });
  adminMc.ecouterTelemetrie((cle, m) => capteurs.noter(cle, m));
  for (const c of CLES) capteurs.regler(c, { intervalleMin, nom: noeuds.get(c).nom });
  const avancer = async (ms) => { for (let k = 0; k < ms; k += 60000) { t.mock.timers.tick(60000); for (let j = 0; j < 40; j++) await Promise.resolve(); } };
  const releves = (cle) => lectures.filter((l) => l.cle === cle).length;
  t.after(() => { capteurs.arreter(); fs.rmSync(dossier, { recursive: true, force: true }); });
  return { capteurs, adminMc, CLES, cas, journal, avancer, releves, lectures };
}

test('MeshCore capteurs : un nœud qui ne répond jamais ne prive plus les autres de relevé, et son retard est signalé', async (t) => {
  const b = bancCapteursMc(t);
  b.cas.muets.add(b.CLES[0]); // sa télémétrie ne rend jamais la main : avant, la tâche ne finissait pas
  await b.avancer(14 * 3600000);
  assert.ok(b.releves(b.CLES[1]) >= 4, `nœud sain relevé toutes les 3 h : ${b.releves(b.CLES[1])} relevé(s) en 14 h`);
  assert.ok(b.releves(b.CLES[2]) >= 4, `nœud sain relevé toutes les 3 h : ${b.releves(b.CLES[2])} relevé(s) en 14 h`);
  assert.equal(b.releves(b.CLES[0]), 0, 'le nœud muet ne donne rien, c’est normal');
  // Aucune tâche ne reste « en cours » pour toujours : sinon les relevés s’arrêtent en silence
  assert.ok(b.adminMc.taches().every((x) => x.fin), 'toutes les tâches sont terminées (heure de fin posée)');
  const retard = b.capteurs.alertes().filter((a) => a.type === 'releve');
  assert.equal(retard.length, 1, 'une alerte « relevés en retard », pour le nœud muet seulement');
  assert.match(retard[0].message, /aucun relevé automatique reçu/);
  // Un relevé lancé à la main passe toujours (la file n’est pas bloquée)
  b.adminMc.lancer('telemetrie', [b.CLES[1]], {}, 'olivier');
  const avant = b.releves(b.CLES[1]);
  await b.avancer(5 * 60000);
  assert.equal(b.releves(b.CLES[1]), avant + 1, 'relevé manuel exécuté');
});

test('MeshCore capteurs : une demande sans réponse est relancée dans le quart d’heure, pas à l’intervalle suivant', async (t) => {
  const b = bancCapteursMc(t, { intervalleMin: 180, nb: 1 });
  b.cas.echecs.set(b.CLES[0], 1); // le premier essai échoue, le suivant passe
  await b.avancer(40 * 60000);
  assert.equal(b.releves(b.CLES[0]), 1, 'relevé obtenu dans les 40 min, sans attendre les 3 h');
});

test('MeshCore capteurs : une tâche arrêtée pendant qu’elle attend est marquée terminée (sinon ses nœuds ne sont plus relevés)', async (t) => {
  const b = bancCapteursMc(t, { nb: 2 });
  b.cas.muets.add(b.CLES[0]);
  await b.avancer(60000);
  const enAttente = b.adminMc.lancer('telemetrie', [b.CLES[1]], {}, 'olivier');
  assert.equal(enAttente.statut, 'en_attente');
  b.adminMc.arreter(enAttente.id);
  assert.ok(b.adminMc.tache(enAttente.id).fin, 'heure de fin posée dès l’arrêt');
  b.cas.muets.clear();
  await b.avancer(8 * 3600000);
  assert.ok(b.releves(b.CLES[1]) >= 2, `le nœud de la tâche arrêtée est relevé de nouveau : ${b.releves(b.CLES[1])}`);
});

// Le délai maximal par nœud se règle dans Module MeshCore : un plafond court lâche vite un nœud muet,
// un plafond long le garde. (Une horloge simulée par test : un banc par test.)
test('MeshCore capteurs : délai maximal réglé à 1 min, le nœud muet est lâché tout de suite', async (t) => {
  const b = bancCapteursMc(t, { nb: 2, reglagesMc: { plafondReleveMin: 1 } });
  b.cas.muets.add(b.CLES[0]);
  await b.avancer(4 * 60000);
  assert.equal(b.releves(b.CLES[1]), 1, 'le nœud sain est relevé dans les 4 min');
});

test('MeshCore capteurs : délai maximal réglé à 30 min, la carte laisse sa chance à un répéteur lent', async (t) => {
  const b = bancCapteursMc(t, { nb: 2, reglagesMc: { plafondReleveMin: 30 } });
  b.cas.muets.add(b.CLES[0]);
  await b.avancer(4 * 60000);
  assert.equal(b.releves(b.CLES[1]), 0, 'au bout de 4 min, le nœud sain attend encore son tour');
});

test('MeshCore capteurs : un délai maximal absurde dans le fichier de réglages est borné, jamais nul', async (t) => {
  const b = bancCapteursMc(t, { nb: 2, reglagesMc: { plafondReleveMin: 0 } });
  b.cas.muets.add(b.CLES[0]);
  await b.avancer(4 * 60000);
  assert.equal(b.releves(b.CLES[1]), 1, 'réglage à 0 : ramené à 1 min');
});

// ---------- Sauvegardes des réglages : rien d'important ne doit manquer à la liste ----------
// Section ADRASEC : membres, équipes, main courante et recherches de balise. Une restauration qui l'oublierait
// effacerait en silence le travail d'une association de sécurité civile.
const SECTION_ADRASEC = {
  actif: true,
  groupes: {
    43: {
      code: '43', nom: 'ADRASEC 43', conservationJours: 365,
      membres: { 7: { valide: 1764000000000, par: 'olivier', qualite: 'radioamateur', indicatif: 'F4GLD', licencie: true, equipe: 'eq-1', fonction: 'chef d’équipe', responsable: true, noeud: 1518338049 } },
      demandes: {},
      equipes: [{ id: 'eq-1', nom: 'Gonio 1', couleur: '#ff8a1f', mission: 'Secteur Mézenc' }],
      mainCourante: [{ id: 'mc-1', heure: 1764000001000, auteur: 'F4GLD', type: 'decision', texte: 'Ouverture de la recherche « Balise 121,5 »', equipe: 'eq-1', complete: null }],
      recherches: [{ id: 'r-1', nom: 'Balise 121,5', frequence: '121,5 MHz', detail: null, debut: 1764000001000, fin: 1764000900000, statut: 'terminee', ouvertePar: 'F4GLD' }],
      releves: [{ id: 'rl-1', recherche: 'r-1', heure: 1764000002000, auteur: 'F4GLD', equipe: 'eq-1', lat: 45.05, lon: 3.9, source: 'GPS', gisement: 120.5, incertitude: 5, force: null, note: null, origine: 'saisie' }],
    },
  },
};

test('Sauvegardes : la section ADRASEC survit à une sauvegarde puis une restauration', () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'sauve-adrasec-'));
  const { creerStockage } = require('../src/base');
  const { creerSauvegardes } = require('../src/sauvegardes');
  const st = creerStockage(path.join(dossier, 'carte-live.db'));
  const fAdrasec = path.join(dossier, 'adrasec.json');
  fs.writeFileSync(fAdrasec, JSON.stringify(SECTION_ADRASEC), { mode: 0o600 });
  fs.writeFileSync(path.join(dossier, 'reglages.json'), JSON.stringify({ nom: 'Carte d’essai' }));
  const s = creerSauvegardes(dossier, st.db, () => {});

  const faite = s.sauvegarder();
  const copie = JSON.parse(s.lire(faite.nom).toString('utf8'));
  assert.ok(copie.fichiers['adrasec.json'], 'adrasec.json doit figurer dans la sauvegarde');
  assert.ok(copie.fichiers['reglages.json'], 'reglages.json doit figurer dans la sauvegarde');

  // La section est écrasée (panne, mauvaise manipulation) : la restauration doit la rendre intacte
  fs.writeFileSync(fAdrasec, JSON.stringify({ actif: false, groupes: {} }));
  s.restaurer(copie);
  const relu = JSON.parse(fs.readFileSync(fAdrasec, 'utf8'));
  assert.deepEqual(relu, SECTION_ADRASEC, 'membres, équipes, main courante, recherches et relevés doivent revenir à l’identique');
  assert.equal(fs.statSync(fAdrasec).mode & 0o777, 0o600, 'données personnelles : fichier restauré lisible du seul service');
  st.db.close();
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('Sauvegardes : un fichier dans un sous-dossier absent n’interrompt pas la restauration', () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'sauve-sous-'));
  const { creerStockage } = require('../src/base');
  const { creerSauvegardes } = require('../src/sauvegardes');
  const st = creerStockage(path.join(dossier, 'carte-live.db'));
  const s = creerSauvegardes(dossier, st.db, () => {});
  // Sauvegarde venue d'une autre carte : le sous-dossier « releves » n'existe pas encore ici
  const copie = { format: 'carte-live-sauvegarde', version: 1, date: new Date().toISOString(),
    fichiers: { 'releves/releves.json': '[]', 'adrasec.json': JSON.stringify(SECTION_ADRASEC) }, comptes: [] };
  const r = s.restaurer(copie);
  assert.equal(r.fichiers, 2, 'les deux fichiers doivent être écrits');
  assert.ok(fs.existsSync(path.join(dossier, 'releves', 'releves.json')), 'le sous-dossier doit être créé');
  assert.ok(fs.existsSync(path.join(dossier, 'adrasec.json')), 'les fichiers suivants ne doivent pas être perdus');
  st.db.close();
  fs.rmSync(dossier, { recursive: true, force: true });
});

// ---------- Transfert d'une section ADRASEC d'une carte à une autre ----------
// Le fichier d'export ne doit contenir AUCUN secret : ni compte, ni mot de passe, ni condensat, ni jeton.
// L'import ne doit rien effacer et ne doit jamais donner d'accès à quelqu'un qui ne s'est pas authentifié.
function sectionDeDepart() {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'adrasec-source-'));
  const { creerAdrasec } = require('../src/adrasec');
  const A = creerAdrasec({ config: { fichierBase: path.join(dossier, 'carte-live.db'), departement: { code: '43' } }, journal: () => {} });
  A.reglagesGlobaux({ actif: true });
  A.majGroupe('43', { nom: 'ADRASEC 43' }, 'olivier');
  const admin = { id: 1, identifiant: 'olivier', role: 'admin' };
  const G = A.groupePour(admin, '43');
  const eq = G.majEquipe(null, { nom: 'Gonio 1', mission: 'Secteur Mézenc' }).equipes[0];
  G.majEquipe(null, { nom: 'Transmissions' });
  G.majMembre(2, { membre: true, qualite: 'radioamateur', indicatif: 'F4GLD', equipe: eq.id, fonction: 'chef d’équipe', noeud: 1518338049, responsable: true }, 'olivier', true);
  G.majMembre(3, { membre: true, qualite: 'radioamateur', indicatif: 'F4ISE', equipe: eq.id }, 'olivier', true);
  G.majMembre(4, { membre: true, qualite: 'radioamateur', indicatif: 'F4ASS', fonction: 'opérateur gonio' }, 'olivier', true);
  G.majMembre(5, { membre: true, qualite: 'swl', numeroSwl: 'F-12345', equipe: eq.id }, 'olivier', true);
  G.majMembre(6, { membre: true, qualite: 'radioamateur', indicatif: 'F1ABC' }, 'olivier', true);
  G.majMembre(7, { membre: true, qualite: '' }, 'olivier', true); // ni indicatif ni n° SWL
  return { dossier, G, doc: G.exporter() };
}
function sectionArrivee() {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'adrasec-cible-'));
  const { creerAdrasec } = require('../src/adrasec');
  const A = creerAdrasec({ config: { fichierBase: path.join(dossier, 'carte-live.db'), departement: { code: '43' } }, journal: () => {} });
  A.reglagesGlobaux({ actif: true });
  A.majGroupe('43', { nom: 'ADRASEC 43 (Saint-Appo)' }, 'sebastien');
  const G = A.groupePour({ id: 1, identifiant: 'sebastien', role: 'admin' }, '43');
  G.majEquipe(null, { nom: 'gonio 1' }); // même équipe, écrite autrement : à réutiliser, pas à dupliquer
  G.majMembre(15, { membre: true, qualite: 'radioamateur', indicatif: 'F1ABC' }, 'sebastien', true); // déjà là
  return { dossier, G };
}
// Comptes de la carte d'arrivée (comme comptes.lister())
const COMPTES_ARRIVEE = [
  { id: 11, identifiant: 'olivier', indicatif: 'F4GLD', role: 'membre', statut: 'actif', hash: '$2b$10$condensatsecret', totp: 'SECRETTOTP' },
  { id: 12, identifiant: 'nicolas', indicatif: 'F4ISE', role: 'membre', statut: 'actif' },
  { id: 13, identifiant: 'nicolas-bis', indicatif: 'F4ISE', role: 'membre', statut: 'actif' }, // deux comptes, même indicatif
  { id: 14, identifiant: 'dormant', indicatif: 'F4ASS', role: 'membre', statut: 'en_attente' }, // pas encore validé : ne compte pas
  { id: 15, identifiant: 'bernard', indicatif: 'F1ABC', role: 'membre', statut: 'actif' },
];

test('ADRASEC : le fichier d’export ne contient aucun secret ni aucun identifiant de compte', () => {
  const src = sectionDeDepart();
  const doc = src.doc;
  // Champs autorisés, et eux seuls
  const cles = new Set();
  (function parcourir(x) { if (Array.isArray(x)) x.forEach(parcourir); else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { cles.add(k); parcourir(v); } })(doc);
  assert.deepEqual([...cles].sort(), ['code', 'couleur', 'date', 'equipe', 'equipes', 'fonction', 'format', 'id', 'indicatif', 'membres', 'membresSansIdentifiant', 'mission', 'noeud', 'nom', 'numeroSwl', 'president', 'qualite', 'section', 'version']);
  const brut = JSON.stringify(doc);
  for (const interdit of ['hash', 'motDePasse', 'password', 'condensat', 'totp', 'jeton', 'token', 'session', 'cookie', 'psk', 'secret'])
    assert.ok(!new RegExp(interdit, 'i').test(brut), `le mot « ${interdit} » ne doit pas apparaître dans l’export : ${brut.slice(0, 200)}`);
  // Les identifiants de compte de la carte d'origine (clés de « membres ») ne doivent pas sortir
  assert.ok(Array.isArray(doc.membres), 'les membres sortent en liste, sans leur numéro de compte');
  assert.ok(!doc.membres.some((m) => 'compte' in m || 'par' in m || 'valide' in m), 'ni numéro de compte, ni qui a validé, ni quand');
  assert.equal(doc.membres.length, 5, 'les 5 membres identifiables partent ; celui sans indicatif ni n° SWL reste');
  assert.equal(doc.membresSansIdentifiant, 1);
  assert.equal(doc.format, 'carte-live-adrasec');
  assert.deepEqual(doc.membres.find((m) => m.indicatif === 'F4GLD'), { indicatif: 'F4GLD', qualite: 'radioamateur', numeroSwl: null, equipe: doc.equipes[0].id, fonction: 'chef d’équipe', president: true, noeud: 1518338049 });
  fs.rmSync(src.dossier, { recursive: true, force: true });
});

test('ADRASEC : import non destructeur, rattachement par l’indicatif, fiche en attente, récapitulatif juste', () => {
  const src = sectionDeDepart();
  const cible = sectionArrivee();
  const G = cible.G;
  const avant = { membres: Object.keys(G.g.membres).length, equipes: G.g.equipes.length };

  // 1) Récapitulatif seul : rien ne doit être écrit
  const vu = G.importer(src.doc, COMPTES_ARRIVEE, { appliquer: false }, 'sebastien');
  assert.equal(Object.keys(G.g.membres).length, avant.membres, 'l’aperçu n’ajoute aucun membre');
  assert.equal(G.g.equipes.length, avant.equipes, 'l’aperçu ne crée aucune équipe');
  assert.equal(G.g.attentes.length, 0, 'l’aperçu ne crée aucune fiche en attente');
  assert.deepEqual(vu.rattaches.map((x) => x.quoi), ['F4GLD'], 'un seul compte rapprochable de façon certaine');
  assert.deepEqual(vu.rattaches[0].identifiant, 'olivier');
  assert.deepEqual(vu.attentes.map((x) => x.quoi).sort(), ['F4ASS', 'SWL:F-12345'], 'indicatif sans compte actif et SWL : fiches en attente');
  assert.deepEqual(vu.ambigus.map((x) => x.quoi), ['F4ISE'], 'deux comptes au même indicatif : à la main');
  assert.deepEqual(vu.dejaMembres.map((x) => x.quoi), ['F1ABC']);
  assert.deepEqual(vu.equipesCreees, ['Transmissions'], '« Gonio 1 » existe déjà sous la forme « gonio 1 »');
  assert.equal(vu.equipesExistantes, 1);
  assert.equal(vu.presidents, 1, 'le président de la carte d’origine est signalé, pas repris');
  assert.equal(vu.sansIdentifiant, 1);

  // 2) Application : non destructeur
  const fait = G.importer(src.doc, COMPTES_ARRIVEE, { appliquer: true }, 'sebastien');
  assert.deepEqual([fait.rattaches.length, fait.attentes.length, fait.equipesCreees.length], [1, 2, 1]);
  assert.ok(G.g.membres[15] && G.g.membres[15].indicatif === 'F1ABC', 'le membre déjà présent n’est pas touché');
  assert.equal(G.g.equipes.length, 2, 'l’équipe homonyme est réutilisée');
  assert.equal(G.g.equipes.filter((e) => /gonio/i.test(e.nom)).length, 1);
  const m11 = G.g.membres[11];
  assert.ok(m11, 'le compte rapproché par l’indicatif devient membre');
  assert.equal(m11.indicatif, 'F4GLD');
  assert.equal(m11.fonction, 'chef d’équipe');
  assert.equal(m11.noeud, 1518338049);
  assert.equal(m11.equipe, G.g.equipes.find((e) => /gonio/i.test(e.nom)).id, 'rattaché à l’équipe locale de même nom');
  assert.ok(!m11.responsable, 'le rôle de président n’est jamais importé');
  assert.ok(!G.g.membres[14], 'un compte encore en attente de validation ne devient pas membre');
  assert.ok(!G.g.membres[12] && !G.g.membres[13], 'indicatif en double : aucun compte n’est rattaché au hasard');

  // 3) La personne sans compte crée le sien puis demande à rejoindre : sa fiche se rattache seule
  const att = G.g.attentes.find((a) => a.indicatif === 'F4ASS');
  assert.ok(att && att.fonction === 'opérateur gonio');
  G.majMembre(16, { membre: true, qualite: 'radioamateur', indicatif: 'F4ASS' }, 'sebastien', false);
  const m16 = G.g.membres[16];
  assert.equal(m16.fonction, 'opérateur gonio', 'la fiche en attente complète le nouveau membre');
  assert.ok(!m16.responsable, 'toujours pas de président par import');
  assert.ok(m16.importe && /ADRASEC 43/.test(m16.importe.de), 'la provenance est notée');
  assert.ok(!G.g.attentes.some((a) => a.indicatif === 'F4ASS'), 'la fiche en attente est consommée');

  // 4) Deuxième import du même fichier : rien en double
  const encore = G.importer(src.doc, COMPTES_ARRIVEE, { appliquer: true }, 'sebastien');
  assert.deepEqual([encore.rattaches.length, encore.attentes.length, encore.equipesCreees.length], [0, 0, 0]);
  assert.equal(G.g.equipes.length, 2);
  assert.equal(G.g.attentes.length, 1, 'la fiche SWL reste la seule en attente');

  // 5) Main courante : l'import est tracé, mais aucune main courante n'est venue du fichier
  assert.ok(G.g.mainCourante.some((x) => /Import de la section/.test(x.texte)), 'l’import est inscrit à la main courante');
  assert.ok(!G.g.recherches.length && !G.g.releves.length, 'ni recherche ni relevé ne sont importés');
  fs.rmSync(src.dossier, { recursive: true, force: true });
  fs.rmSync(cible.dossier, { recursive: true, force: true });
});

test('ADRASEC : fichier malformé ou trafiqué refusé sans plantage et sans donner d’accès', () => {
  const cible = sectionArrivee();
  const G = cible.G;
  for (const [mauvais, motif] of [
    [null, /export d’une section ADRASEC/],
    ['pas un objet', /export d’une section ADRASEC/],
    [[1, 2, 3], /export d’une section ADRASEC/],
    [{ format: 'autre-chose', version: 1 }, /export d’une section ADRASEC/],
    [{ format: 'carte-live-adrasec', version: 2 }, /version 2/],
  ]) assert.throws(() => G.importer(mauvais, COMPTES_ARRIVEE, { appliquer: true }, 'sebastien'), motif);

  // Champs du mauvais type : ignorés, pas de plantage
  const bizarre = { format: 'carte-live-adrasec', version: 1, section: 42, equipes: 'pas un tableau', membres: { a: 1 }, membresSansIdentifiant: 'beaucoup' };
  const r = G.importer(bizarre, COMPTES_ARRIVEE, { appliquer: true }, 'sebastien');
  assert.deepEqual([r.rattaches.length, r.attentes.length, r.equipesCreees.length, r.sansIdentifiant], [0, 0, 0, 0]);

  // Fichier trafiqué : on essaie de se faire nommer président, de se faire passer pour un compte, d'injecter des champs
  const truque = { format: 'carte-live-adrasec', version: 1, section: { code: '43', nom: 'ADRASEC 43' },
    equipes: [{ id: 'e', nom: 'Gonio 1' }],
    membres: [
      { indicatif: 'F4GLD', president: true, responsable: true, licencie: true, compte: 15, valide: 1, par: 'pirate', hash: '$2b$10$x', totp: 'ABC', role: 'admin', equipe: 'e' },
      { indicatif: '<script>alert(1)</script>', qualite: 'radioamateur' },
      { indicatif: 'F4GLD' }, // en double dans le fichier
      { qualite: 'radioamateur', numeroSwl: null }, // rien pour reconnaître la personne
      { indicatif: 'F4ZZZ', equipe: 'equipe-qui-nexiste-pas', noeud: -3, qualite: 'president' },
    ] };
  const t = G.importer(truque, COMPTES_ARRIVEE, { appliquer: true }, 'sebastien');
  const m11 = G.g.membres[11];
  assert.ok(m11, 'F4GLD est rattaché à son compte, par son indicatif seulement');
  assert.ok(!m11.responsable, 'pas de président par import, même demandé dans le fichier');
  assert.equal(m11.par, 'sebastien', 'c’est celui qui importe qui signe, pas le fichier');
  for (const k of ['hash', 'totp', 'role', 'compte']) assert.ok(!(k in m11), `le champ « ${k} » du fichier est ignoré`);
  assert.ok(t.ignores.some((x) => /illisible/.test(x.raison)), 'indicatif illisible refusé');
  assert.ok(t.ignores.some((x) => /double/.test(x.raison)), 'doublon du fichier signalé');
  assert.ok(t.ignores.some((x) => /ni indicatif ni/.test(x.raison)), 'membre sans identifiant signalé');
  const zzz = G.g.attentes.find((a) => a.indicatif === 'F4ZZZ');
  assert.ok(zzz && zzz.equipe === null && zzz.noeud === null && zqualite(zzz) === null, 'équipe inconnue, nœud invalide et qualité inventée mis à zéro');
  function zqualite(a) { return a.qualite; }
  // Trop de fiches : le fichier est borné, la carte ne gonfle pas sans fin
  const enorme = { format: 'carte-live-adrasec', version: 1, section: { code: '43', nom: 'X' }, equipes: [],
    membres: Array.from({ length: 2500 }, (_, i) => ({ indicatif: 'F4A' + String(i).padStart(2, '0') + 'B' })) };
  const e = G.importer(enorme, [], { appliquer: false }, 'sebastien');
  assert.ok(e.attentes.length <= 2000, 'au plus 2 000 fiches lues dans un fichier : ' + e.attentes.length);
  fs.rmSync(cible.dossier, { recursive: true, force: true });
});

test('Sauvegardes : les secrets saisis dans la console ne partent jamais dans une sauvegarde', () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'sauve-secrets-'));
  const { creerStockage } = require('../src/base');
  const { creerSauvegardes, FICHIERS } = require('../src/sauvegardes');
  const st = creerStockage(path.join(dossier, 'carte-live.db'));
  // Une sauvegarde est faite pour être copiée ailleurs (clé USB, pièce jointe) : elle ne doit emporter
  // ni le mot de passe PostgreSQL ni les identifiants HelloAsso / GitHub saisis dans la console.
  const SECRETS = {
    'postgres.json': 'MotDePassePostgres-NePasSauvegarder',
    'donateurs.json': 'SecretHelloAsso-NePasSauvegarder',
  };
  for (const [f, secret] of Object.entries(SECRETS)) fs.writeFileSync(path.join(dossier, f), JSON.stringify({ motDePasse: secret, clientSecret: secret }));
  for (const f of FICHIERS) { const c = path.join(dossier, f); fs.mkdirSync(path.dirname(c), { recursive: true }); if (!fs.existsSync(c)) fs.writeFileSync(c, `contenu de ${f}`); }
  const s = creerSauvegardes(dossier, st.db, () => {});
  const brut = s.lire(s.sauvegarder().nom).toString('utf8');
  for (const [f, secret] of Object.entries(SECRETS)) {
    assert.ok(!FICHIERS.includes(f), `${f} ne doit pas figurer dans la liste des fichiers sauvegardés`);
    assert.ok(!brut.includes(secret), `le secret de ${f} ne doit apparaître nulle part dans la sauvegarde`);
  }
  // Le fichier reste bien sur le disque : on ne sauvegarde pas, on ne supprime pas
  for (const f of Object.keys(SECRETS)) assert.ok(fs.existsSync(path.join(dossier, f)), `${f} doit rester sur le serveur`);
  st.db.close();
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('Sauvegardes : chaque fichier de réglages listé est bien repris, puis remis à l’identique', () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'sauve-liste-'));
  const { creerStockage } = require('../src/base');
  const { creerSauvegardes, FICHIERS } = require('../src/sauvegardes');
  const st = creerStockage(path.join(dossier, 'carte-live.db'));
  // Un contenu reconnaissable par fichier
  const attendu = {};
  for (const f of FICHIERS) {
    attendu[f] = `contenu de ${f}`;
    const cible = path.join(dossier, f);
    fs.mkdirSync(path.dirname(cible), { recursive: true });
    fs.writeFileSync(cible, attendu[f]);
  }
  const s = creerSauvegardes(dossier, st.db, () => {});
  const copie = JSON.parse(s.lire(s.sauvegarder().nom).toString('utf8'));
  assert.deepEqual(Object.keys(copie.fichiers).sort(), [...FICHIERS].sort(), 'tous les fichiers listés doivent être dans la sauvegarde');
  for (const f of FICHIERS) fs.writeFileSync(path.join(dossier, f), 'écrasé');
  s.restaurer(copie);
  for (const f of FICHIERS) assert.equal(fs.readFileSync(path.join(dossier, f), 'utf8'), attendu[f], `${f} doit revenir à l’identique`);
  // Aucun fichier binaire dans la liste : la sauvegarde les lit en UTF-8 et les abîmerait
  assert.ok(!FICHIERS.some((f) => /\.(bin|db|jpg|png|tar\.gz)$/.test(f)), 'la liste ne doit contenir que du texte');
  st.db.close();
  fs.rmSync(dossier, { recursive: true, force: true });
});
