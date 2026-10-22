'use strict';
// Simulateur de companion MeshCore « Wi-Fi » (TCP, port 5000 par défaut) pour essayer la carte sans matériel.
// Il répond aux commandes de base (APP_START, DEVICE_QUERY, GET_CONTACTS, batterie) et envoie des paquets
// bruts (LOG_RX_DATA) : annonces de répéteurs en Haute-Loire, messages du canal Public, traces, requêtes…
//
//   node outils/simulateur-meshcore.js [port]
// puis, dans la carte : MeshCore › Companion › Wi-Fi : 127.0.0.1, port 5000.

const net = require('net');
const crypto = require('crypto');

const PORT = Number(process.argv[2]) || 5000;
const PUBLIC = Buffer.from('8b3387e9c5cdea6ac9e5edbaa115cd72', 'hex');
const cle = (graine) => crypto.createHash('sha256').update(graine).digest();

const NOEUDS = [
  { nom: '43ALAMBRepeaterGaulix', role: 2, lat: 45.0318, lon: 3.9412 },
  { nom: '43-Mezenc-RPT', role: 2, lat: 44.9128, lon: 4.1873 },
  { nom: '43-Puy-Corneille', role: 2, lat: 45.0472, lon: 3.8851 },
  { nom: '43-Yssingeaux-RPT', role: 2, lat: 45.1427, lon: 4.1238 },
  { nom: '43-Brioude-RPT', role: 2, lat: 45.2941, lon: 3.3842 },
  { nom: 'Salon Gaulix', role: 3, lat: 45.0441, lon: 3.8853 },
  { nom: 'F4GLD 📟', role: 1, lat: 45.1105, lon: 3.9201 },
  { nom: 'Marc 43', role: 1, lat: 45.0612, lon: 3.8302 },
  { nom: 'Capteur Loire', role: 4, lat: 45.0963, lon: 3.9558 },
].map((n) => ({ ...n, cle: cle('simu-mc-' + n.nom) }));
const MOI = { nom: 'Companion simulé', cle: cle('simu-mc-companion'), lat: 45.1099, lon: 3.9197 };

const relais = NOEUDS.filter((n) => n.role === 2);
const hasard = (t) => t[Math.floor(Math.random() * t.length)];

function paquet(typeCharge, route, chemin, charge) {
  const t = Buffer.alloc(2 + chemin.length);
  t[0] = (typeCharge << 2) | route;
  t[1] = chemin.length;
  chemin.forEach((h, i) => (t[2 + i] = h));
  return Buffer.concat([t, charge]);
}
function annonce(n) {
  const nom = Buffer.from(n.nom, 'utf8');
  const app = Buffer.alloc(1 + 8);
  app[0] = n.role | 0x10 | 0x80;
  app.writeInt32LE(Math.round(n.lat * 1e6), 1);
  app.writeInt32LE(Math.round(n.lon * 1e6), 5);
  const ts = Buffer.alloc(4); ts.writeUInt32LE(Math.floor(Date.now() / 1000));
  return Buffer.concat([n.cle, ts, crypto.randomBytes(64), app, nom]);
}
function messagePublic(expediteur, texte) {
  const clair = Buffer.concat([Buffer.alloc(5), Buffer.from(`${expediteur}: ${texte}`, 'utf8')]);
  clair.writeUInt32LE(Math.floor(Date.now() / 1000), 0);
  const complet = Buffer.concat([clair, Buffer.alloc((16 - (clair.length % 16)) % 16)]);
  const c = crypto.createCipheriv('aes-128-ecb', PUBLIC, null); c.setAutoPadding(false);
  const chiffre = Buffer.concat([c.update(complet), c.final()]);
  const mac = crypto.createHmac('sha256', Buffer.concat([PUBLIC, Buffer.alloc(16)])).update(chiffre).digest().subarray(0, 2);
  const h = crypto.createHash('sha256').update(PUBLIC).digest()[0];
  return Buffer.concat([Buffer.from([h]), mac, chiffre]);
}
// Chemin plausible : quelques relais tirés au hasard, terminant par l'Alambre (proche du companion)
function chemin(max = 3) {
  const n = Math.floor(Math.random() * (max + 1));
  const l = [];
  for (let k = 0; k < n; k++) { const r = hasard(relais); if (!l.includes(r)) l.push(r); }
  const alambre = relais[0];
  if (l.length && l[l.length - 1] !== alambre) { l.splice(l.indexOf(alambre) >= 0 ? l.indexOf(alambre) : l.length, 1); l.push(alambre); }
  return l.map((r) => r.cle[0]);
}

const MESSAGES = ['Bonjour la Haute-Loire !', 'Test depuis le Mézenc', 'Quelqu’un m’entend à Yssingeaux ?', 'Reçu 5/5', 'Relais Alambre OK', 'Bonne soirée à tous'];

function trame(octets) {
  const t = Buffer.alloc(3 + octets.length);
  t[0] = 0x3e; t.writeUInt16LE(octets.length, 1); octets.copy(t, 3);
  return t;
}
function logRx(brut, snr, rssi) {
  const t = Buffer.alloc(3); t[0] = 0x88; t.writeInt8(Math.round(snr * 4), 1); t.writeInt8(Math.round(rssi), 2);
  return trame(Buffer.concat([t, brut]));
}

function selfInfo() {
  const b = Buffer.alloc(58);
  b[0] = 5; b[1] = 1; b[2] = 22; b[3] = 22; MOI.cle.copy(b, 4);
  b.writeInt32LE(Math.round(MOI.lat * 1e6), 36); b.writeInt32LE(Math.round(MOI.lon * 1e6), 40);
  b.writeUInt32LE(869618, 48); b.writeUInt32LE(62500, 52); b[56] = 8; b[57] = 8;
  return trame(Buffer.concat([b, Buffer.from(MOI.nom)]));
}
function deviceInfo() {
  const b = Buffer.alloc(82);
  b[0] = 13; b[1] = 9; b[2] = 175; b[3] = 8;
  b.write('22-Oct-2026', 8); b.write('Heltec V3 (simulé)', 20); b.write('v1.12.0-simu', 60);
  return trame(b);
}
function contact(n) {
  const b = Buffer.alloc(148);
  b[0] = 3; n.cle.copy(b, 1); b[33] = n.role; b[35] = 0xff; b.write(n.nom.slice(0, 31), 100);
  b.writeUInt32LE(Math.floor(Date.now() / 1000) - 3600, 132);
  b.writeInt32LE(Math.round(n.lat * 1e6), 136); b.writeInt32LE(Math.round(n.lon * 1e6), 140);
  b.writeUInt32LE(Math.floor(Date.now() / 1000) - 600, 144);
  return trame(b);
}

net.createServer((s) => {
  console.log('carte connectée');
  let tampon = Buffer.alloc(0);
  s.on('data', (d) => {
    tampon = Buffer.concat([tampon, d]);
    while (tampon.length >= 3 && tampon[0] === 0x3c) {
      const lg = tampon.readUInt16LE(1);
      if (tampon.length < 3 + lg) break;
      const cmd = tampon.subarray(3, 3 + lg); tampon = tampon.subarray(3 + lg);
      switch (cmd[0]) {
        case 1: s.write(selfInfo()); break;
        case 22: s.write(deviceInfo()); break;
        case 4: {
          const n = Buffer.alloc(5); n[0] = 2; n.writeUInt32LE(4, 1); s.write(trame(n));
          for (const c of NOEUDS.slice(0, 4)) s.write(contact(c));
          s.write(trame(Buffer.from([4, 0, 0, 0, 0])));
          break;
        }
        case 20: { const b = Buffer.alloc(11); b[0] = 12; b.writeUInt16LE(4012, 1); s.write(trame(b)); break; }
        case 7: s.write(trame(Buffer.from([0]))); break;
        default: s.write(trame(Buffer.from([1, 1])));
      }
    }
    if (tampon.length && tampon[0] !== 0x3c) tampon = Buffer.alloc(0);
  });
  const envoyer = () => {
    if (s.destroyed) return;
    const r = Math.random();
    const snr = Math.round((Math.random() * 18 - 10) * 4) / 4, rssi = Math.round(-120 + Math.random() * 50);
    let brut;
    if (r < 0.35) brut = paquet(4, 1, chemin(2), annonce(hasard(NOEUDS)));
    else if (r < 0.6) brut = paquet(5, 1, chemin(3), messagePublic(hasard(['F4GLD', 'Marc 43', 'Julie', 'Pierre 07']), hasard(MESSAGES)));
    else if (r < 0.75) brut = paquet(2, 1, chemin(2), Buffer.concat([Buffer.from([hasard(NOEUDS).cle[0], hasard(NOEUDS).cle[0]]), crypto.randomBytes(18)]));
    else if (r < 0.85) brut = paquet(3, 2, [], crypto.randomBytes(4));
    else if (r < 0.93) brut = paquet(7, 1, chemin(1), Buffer.concat([Buffer.from([relais[1].cle[0]]), MOI.cle, crypto.randomBytes(18)]));
    else {
      // Trace : SNR mesurés à chaque saut, route Alambre → Puy → Mézenc
      const route = [relais[0], relais[2], relais[1]];
      const charge = Buffer.concat([crypto.randomBytes(4), Buffer.alloc(4), Buffer.from([0]), Buffer.from(route.map((x) => x.cle[0]))]);
      const snrs = route.map(() => Math.round((Math.random() * 16 - 6) * 4) & 0xff);
      brut = Buffer.concat([Buffer.from([(9 << 2) | 2, snrs.length]), Buffer.from(snrs), charge]);
    }
    s.write(logRx(brut, snr, rssi));
    // Même paquet parfois entendu une 2e fois par un autre chemin (doublon d'inondation)
    if (Math.random() < 0.2) setTimeout(() => !s.destroyed && s.write(logRx(brut, snr - 3, rssi - 6)), 400);
    setTimeout(envoyer, 1500 + Math.random() * 3000);
  };
  setTimeout(envoyer, 2500);
  s.on('error', () => {});
  s.on('close', () => console.log('carte déconnectée'));
}).listen(PORT, () => console.log(`Companion MeshCore simulé sur le port ${PORT}`));
