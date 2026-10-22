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

// État simulé des répéteurs administrables (mot de passe « password »)
const reglages = new Map();
const etatRep = (cle) => {
  if (!reglages.has(cle)) {
    const n = NOEUDS.find((x) => x.cle.toString('hex') === cle);
    reglages.set(cle, { name: n ? n.nom : '?', radio: '869.618,62.5,8,8', tx: '22', repeat: 'on', 'flood.max': '64', 'flood.max.advert': '8', 'advert.interval': cle.startsWith(relais[1].cle.toString('hex').slice(0, 4)) ? '0' : '120',
      'flood.advert.interval': '12', 'path.hash.mode': '0', txdelay: '0.5', 'direct.txdelay': '0.3', dutycycle: '50.0%', 'multi.acks': '0', 'loop.detect': 'off', lat: String(n ? n.lat : 0), lon: String(n ? n.lon : 0), 'owner.info': 'F4GLD' });
  }
  return reglages.get(cle);
};
const SECRET_HL = crypto.createHash('sha256').update('#haute-loire').digest().subarray(0, 16);
function repondreCli(cleHex, ligne) {
  const r = etatRep(cleHex);
  let m;
  if ((m = /^get (\S+)$/.exec(ligne))) return r[m[1]] !== undefined ? '> ' + r[m[1]] : '??: ' + m[1];
  if ((m = /^set (\S+) (.+)$/.exec(ligne))) { r[m[1]] = m[1] === 'dutycycle' ? m[2] + '.0%' : m[2]; return m[1] === 'radio' ? 'OK - reboot to apply' : m[1] === 'repeat' ? 'OK - repeat is now ' + m[2].toUpperCase() : 'OK'; }
  if (ligne === 'ver') return 'v1.12.0 (Build: 22-Oct-2026)';
  if (ligne === 'board') return 'Heltec V3';
  if (ligne === 'clock') return '12:00 - 22/10/2026 UTC';
  if (ligne === 'clock sync') return 'OK - clock set: 12:00 - 22/10/2026 UTC';
  if (ligne === 'neighbors') return relais.filter((x) => x.cle.toString('hex') !== cleHex).slice(0, 3).map((x, i) => `${x.cle.toString('hex').slice(0, 8)}:${Math.floor(Date.now() / 1000) - 300 * i}:${(i * 7 - 10) * 4}`).join('\n');
  if (/^advert/.test(ligne)) return 'OK - Advert sent';
  return 'Unknown command';
}

net.createServer((s) => {
  console.log('carte connectée');
  let tampon = Buffer.alloc(0);
  const fileMessages = [];
  const pousser = (trameMsg) => { fileMessages.push(trameMsg); s.write(trame(Buffer.from([0x83]))); };
  const msgContact = (prefixe6, type, texteMsg) => {
    const b = Buffer.alloc(4 + 6 + 2 + 4); b[0] = 16; b[1] = 24; prefixe6.copy(b, 4); b[10] = 1; b[11] = type; b.writeUInt32LE(Math.floor(Date.now() / 1000), 12);
    return trame(Buffer.concat([b, Buffer.from(texteMsg, 'utf8')]));
  };
  const minuterieDm = setInterval(() => { if (!s.destroyed && Math.random() < 0.3) pousser(msgContact(NOEUDS[7].cle.subarray(0, 6), 0, 'Salut, tu me reçois ? ' + new Date().toLocaleTimeString('fr-FR'))); }, 45000);
  s.on('data', (d) => {
    tampon = Buffer.concat([tampon, d]);
    while (tampon.length >= 3 && tampon[0] === 0x3c) {
      const lg = tampon.readUInt16LE(1);
      if (tampon.length < 3 + lg) break;
      const cmd = tampon.subarray(3, 3 + lg); tampon = tampon.subarray(3 + lg);
      const ok = () => s.write(trame(Buffer.from([0])));
      const envoye = (tag) => { const b = Buffer.alloc(10); b[0] = 6; b[1] = 1; b.writeUInt32LE(tag, 2); b.writeUInt32LE(8000, 6); s.write(trame(b)); };
      switch (cmd[0]) {
        case 1: s.write(selfInfo()); break;
        case 22: s.write(deviceInfo()); break;
        case 6: case 9: case 29: case 7: ok(); break;
        case 4: {
          const n = Buffer.alloc(5); n[0] = 2; n.writeUInt32LE(4, 1); s.write(trame(n));
          for (const c of NOEUDS.slice(0, 4)) s.write(contact(c));
          s.write(trame(Buffer.from([4, 0, 0, 0, 0])));
          break;
        }
        case 20: { const b = Buffer.alloc(11); b[0] = 12; b.writeUInt16LE(4012, 1); s.write(trame(b)); break; }
        case 31: {
          const i = cmd[1];
          if (i > 1) { s.write(trame(Buffer.from([1, 2]))); break; }
          const b = Buffer.alloc(50); b[0] = 18; b[1] = i; b.write(i === 0 ? 'Public' : '#haute-loire', 2); (i === 0 ? PUBLIC : SECRET_HL).copy(b, 34);
          s.write(trame(b));
          break;
        }
        case 10: s.write(fileMessages.length ? fileMessages.shift() : trame(Buffer.from([10]))); break;
        case 3: {
          ok();
          const texteMsg = cmd.subarray(7).toString('utf8');
          setTimeout(() => !s.destroyed && s.write(logRx(paquet(5, 1, [relais[0].cle[0]], messagePublic(MOI.nom, texteMsg)), 6, -95)), 2500);
          break;
        }
        case 2: {
          const type = cmd[1], prefixe = cmd.subarray(7, 13), texteMsg = cmd.subarray(13).toString('utf8');
          const tag = crypto.randomBytes(4).readUInt32LE(0);
          envoye(tag);
          if (type === 1) {
            const cible = NOEUDS.find((x) => x.cle.subarray(0, 6).equals(prefixe));
            setTimeout(() => !s.destroyed && pousser(msgContact(prefixe, 1, repondreCli(cible ? cible.cle.toString('hex') : '', texteMsg))), 1200 + Math.random() * 1500);
          } else setTimeout(() => { if (!s.destroyed) { const b = Buffer.alloc(9); b[0] = 0x82; b.writeUInt32LE(tag, 1); b.writeUInt32LE(2400, 5); s.write(trame(b)); } }, 3000);
          break;
        }
        case 26: {
          const cle = cmd.subarray(1, 33), mdp = cmd.subarray(33).toString('utf8');
          envoye(cle.readUInt32LE(0));
          setTimeout(() => {
            if (s.destroyed) return;
            const b = Buffer.alloc(14); b[0] = mdp === 'password' ? 0x85 : 0x86; b[1] = 1; cle.copy(b, 2, 0, 6); b[12] = 3; b[13] = 2;
            s.write(trame(mdp === 'password' ? b : b.subarray(0, 8)));
          }, 1500);
          break;
        }
        case 27: {
          const cle = cmd.subarray(1, 33);
          envoye(cle.readUInt32LE(0));
          setTimeout(() => {
            if (s.destroyed) return;
            const b = Buffer.alloc(8 + 56); b[0] = 0x87; cle.copy(b, 2, 0, 6);
            const d = b.subarray(8);
            d.writeUInt16LE(3950 + Math.round(Math.random() * 200), 0); d.writeInt16LE(-112, 4); d.writeInt16LE(-87, 6);
            d.writeUInt32LE(15230, 8); d.writeUInt32LE(4210, 12); d.writeUInt32LE(3200, 16); d.writeUInt32LE(86400 * 3, 20); d.writeInt16LE(22, 42);
            s.write(trame(b));
          }, 1800);
          break;
        }
        default: s.write(trame(Buffer.from([1, 1])));
      }
    }
    if (tampon.length && tampon[0] !== 0x3c) tampon = Buffer.alloc(0);
  });
  s.on('close', () => clearInterval(minuterieDm));
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
