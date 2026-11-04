'use strict';
// Port série du serveur (module branché en USB sur la machine qui fait tourner la carte, ex. /dev/ttyACM0).
// Sans module natif : le port est réglé avec stty (115200 bauds, mode brut) puis ouvert comme un terminal.
// Renvoie un flux Duplex avec les méthodes d'un socket TCP utilisées par le module radio et le companion.
// Docker : passer le périphérique au conteneur (devices: ["/dev/ttyACM0:/dev/ttyACM0"]) et le groupe dialout.

const fs = require('fs');
const tty = require('tty');
const { execFileSync } = require('child_process');
const { Duplex } = require('stream');

const cheminValide = (c) => typeof c === 'string' && /^\/dev\/(tty(ACM|USB|AMA|S|THS)\d{1,3}|pts\/\d{1,4}|serial\/by-id\/[\w.:@+-]{1,120})$/.test(c);

function listerPorts() {
  const l = [];
  try { for (const f of fs.readdirSync('/dev')) if (/^tty(ACM|USB)\d+$/.test(f)) l.push('/dev/' + f); } catch { /* ignoré */ }
  try { for (const f of fs.readdirSync('/dev/serial/by-id')) l.push('/dev/serial/by-id/' + f); } catch { /* aucun */ }
  return l;
}

function ouvrirSerie(chemin, bauds = 115200) {
  if (!cheminValide(chemin)) throw new Error('port série invalide (ex. /dev/ttyACM0, /dev/ttyUSB0 ou /dev/serial/by-id/…)');
  // -hupcl : ne pas baisser DTR à la fermeture (évite de redémarrer certains modules ESP32)
  try { execFileSync('stty', ['-F', chemin, String(bauds), 'raw', '-echo', '-echoe', '-echok', '-hupcl', 'cs8', '-cstopb', '-parenb', 'clocal'], { timeout: 4000, stdio: 'pipe' }); } catch (e) {
    const m = String(e.stderr || e.message);
    if (/Permission denied/i.test(m)) throw new Error(`accès refusé à ${chemin} : ajoutez le groupe du port (dialout) au conteneur`);
    if (/No such file/i.test(m)) throw new Error(`${chemin} introuvable : module débranché, ou port non transmis au conteneur Docker`);
    throw new Error(`réglage de ${chemin} impossible : ${m.trim().slice(0, 120)}`);
  }
  const fd = fs.openSync(chemin, fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
  let lecteur;
  try { lecteur = new tty.ReadStream(fd); } catch (e) { fs.closeSync(fd); throw new Error(`ouverture de ${chemin} impossible : ${e.message}`); }
  try { lecteur.setRawMode(true); } catch { /* déjà réglé par stty */ }
  let delai = 0, minut = null, ferme = false;
  const reveil = () => { if (delai) { clearTimeout(minut); minut = setTimeout(() => f.emit('timeout'), delai); } };
  const f = new Duplex({
    read() {},
    write(morceau, enc, fait) {
      fs.write(fd, morceau, (e) => fait(e && e.code !== 'EAGAIN' ? e : null));
    },
    destroy(err, fait) {
      clearTimeout(minut);
      if (!ferme) { ferme = true; try { lecteur.destroy(); } catch { /* déjà */ } }
      fait(err);
    },
  });
  lecteur.on('data', (d) => { reveil(); f.push(d); });
  lecteur.on('error', (e) => { if (!f.destroyed) f.emit('error', e); });
  lecteur.on('close', () => { ferme = true; clearTimeout(minut); f.push(null); if (!f.destroyed) f.destroy(); });
  f.setNoDelay = () => f;
  f.setKeepAlive = () => f;
  f.setTimeout = (ms) => { delai = ms; reveil(); return f; };
  f.chemin = chemin;
  setImmediate(() => f.emit('connect'));
  return f;
}

// Reconnaît le module branché : question MeshCore (DEVICE_QUERY, réponse « > » code 13) et question Meshtastic
// (want_config_id, réponse 0x94 0xC3), reposées pendant 8 s (le module peut redémarrer à l'ouverture du port)
function sonder(chemin) {
  return new Promise((ok, ko) => {
    let f;
    try { f = ouvrirSerie(chemin); } catch (e) { ko(e); return; }
    let tampon = Buffer.alloc(0), fini = false;
    const finir = (r) => { if (fini) return; fini = true; clearInterval(rel); clearTimeout(minut); try { f.destroy(); } catch { /* déjà */ } setTimeout(() => ok(r), 300); };
    const questionner = () => {
      try {
        f.write(Buffer.from([0x3c, 0x02, 0x00, 22, 3]));
        f.write(Buffer.alloc(32, 0xc3));
        f.write(Buffer.from([0x94, 0xc3, 0x00, 0x03, 0x18, 0xb9, 0x60]));
      } catch { /* fermé */ }
    };
    f.on('data', (d) => {
      tampon = Buffer.concat([tampon, d]).subarray(-8192);
      const i = tampon.indexOf(0x3e);
      // Réponse MeshCore : « > » + longueur, puis DEVICE_INFO (13) ou une erreur (1) des firmwares sans DEVICE_QUERY
      if (i >= 0 && i + 3 < tampon.length && (tampon[i + 3] === 13 || (tampon[i + 3] === 1 && tampon.readUInt16LE(i + 1) <= 4))) return finir('meshcore');
      if (tampon.indexOf(Buffer.from([0x94, 0xc3])) >= 0) return finir('meshtastic');
    });
    f.on('error', () => finir(null));
    f.on('close', () => finir(null));
    questionner();
    const rel = setInterval(questionner, 2500);
    const minut = setTimeout(() => finir(null), 8000);
  });
}

module.exports = { ouvrirSerie, listerPorts, cheminValide, sonder };
