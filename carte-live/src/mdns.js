'use strict';
// Découverte des modules Meshtastic en Wi-Fi du réseau local par mDNS (service « _meshtastic._tcp », annoncé par le
// firmware), comme termtastic : pas besoin de connaître l'adresse IP du module, ni de sonder tout le réseau.
// Requête « unicast héritée » (port source ≠ 5353) : les modules répondent directement à notre socket, sans avoir à
// partager le port 5353 avec Avahi / Bonjour déjà présents sur la machine.

const dgram = require('dgram');
const os = require('os');

const GROUPE = '224.0.0.251';
const PORT = 5353;
const SERVICE = '_meshtastic._tcp.local';
const T = { A: 1, PTR: 12, TXT: 16, SRV: 33 };

function encoderNom(nom) {
  const parts = nom.split('.').filter(Boolean).map((p) => { const b = Buffer.from(p, 'utf8'); return Buffer.concat([Buffer.from([b.length]), b]); });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

function requete(service = SERVICE, id = 0) {
  const entete = Buffer.alloc(12);
  entete.writeUInt16BE(id, 0);
  entete.writeUInt16BE(1, 4); // une question
  const q = Buffer.alloc(4);
  q.writeUInt16BE(T.PTR, 0);
  q.writeUInt16BE(1, 2); // classe IN
  return Buffer.concat([entete, encoderNom(service), q]);
}

// Lecture d'un nom DNS (avec compression) ; renvoie [nom, position après le nom]
function lireNom(buf, pos, profondeur = 0) {
  const etiquettes = [];
  let suite = -1;
  while (pos < buf.length) {
    const l = buf[pos];
    if (l === 0) { pos++; break; }
    if ((l & 0xc0) === 0xc0) {
      if (profondeur > 10 || pos + 1 >= buf.length) throw new Error('nom DNS invalide');
      if (suite < 0) suite = pos + 2;
      const [reste] = lireNom(buf, ((l & 0x3f) << 8) | buf[pos + 1], profondeur + 1);
      if (reste) etiquettes.push(reste);
      pos = suite; return [etiquettes.join('.'), pos];
    }
    etiquettes.push(buf.toString('utf8', pos + 1, pos + 1 + l));
    pos += 1 + l;
  }
  return [etiquettes.join('.'), suite >= 0 ? suite : pos];
}

// Toutes les réponses d'un paquet mDNS : [{ nom, type, donnees }]
function lireReponses(buf) {
  if (buf.length < 12) return [];
  const qd = buf.readUInt16BE(4), total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let pos = 12;
  for (let i = 0; i < qd; i++) { [, pos] = lireNom(buf, pos); pos += 4; }
  const l = [];
  for (let i = 0; i < total && pos + 10 <= buf.length; i++) {
    let nom; [nom, pos] = lireNom(buf, pos);
    const type = buf.readUInt16BE(pos), long = buf.readUInt16BE(pos + 8);
    const d = pos + 10;
    pos = d + long;
    if (pos > buf.length) break;
    let donnees = null;
    if (type === T.PTR) donnees = lireNom(buf, d)[0];
    else if (type === T.SRV) donnees = { port: buf.readUInt16BE(d + 4), cible: lireNom(buf, d + 6)[0] };
    else if (type === T.A && long === 4) donnees = [...buf.subarray(d, d + 4)].join('.');
    else if (type === T.TXT) {
      donnees = {};
      for (let p = d; p < d + long;) { const n = buf[p]; const s = buf.toString('utf8', p + 1, p + 1 + n); p += 1 + n; const k = s.indexOf('='); if (k > 0) donnees[s.slice(0, k)] = s.slice(k + 1); else if (s) donnees[s] = ''; }
    }
    l.push({ nom: nom.toLowerCase(), nomBrut: nom, type, donnees });
  }
  return l;
}

// Regroupe les réponses en modules : { nom, hote (IP), port, id, nomCourt }
function assembler(reponses, ipSource) {
  const instances = new Map(), srv = new Map(), txt = new Map(), a = new Map();
  for (const r of reponses) {
    if (r.type === T.PTR && r.nom === SERVICE) instances.set(r.donnees.toLowerCase(), r.donnees);
    else if (r.type === T.SRV) srv.set(r.nom, r.donnees);
    else if (r.type === T.TXT) txt.set(r.nom, r.donnees);
    else if (r.type === T.A) a.set(r.nom, r.donnees);
  }
  for (const k of srv.keys()) if (k.endsWith('.' + SERVICE) && !instances.has(k)) instances.set(k, k);
  const l = [];
  for (const [k, brut] of instances) {
    const s = srv.get(k), t = txt.get(k) || {};
    const instance = String(brut).replace(new RegExp('\\.' + SERVICE.replace(/\./g, '\\.') + '$', 'i'), '');
    l.push({ nom: t.shortname || instance, instance, hote: (s && a.get(s.cible.toLowerCase())) || ipSource, port: (s && s.port) || 4403, id: t.id || null, nomCourt: t.shortname || null });
  }
  return l;
}

function interfacesIpv4() {
  const l = [];
  for (const liste of Object.values(os.networkInterfaces())) for (const i of liste || []) if (i.family === 'IPv4' && !i.internal) l.push(i.address);
  return l;
}

// Envoie la requête sur chaque interface et rassemble les réponses pendant « duree » ms
function chercherMeshtastic({ duree = 2500 } = {}) {
  return new Promise((resolve) => {
    const trouves = new Map();
    const sockets = [];
    const adresses = interfacesIpv4();
    if (!adresses.length) return resolve([]);
    for (const adr of adresses) {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(s);
      s.on('error', () => { try { s.close(); } catch { /* déjà fermée */ } });
      s.on('message', (msg, rinfo) => {
        try {
          for (const m of assembler(lireReponses(msg), rinfo.address)) trouves.set(`${m.hote}:${m.port}`, m);
        } catch { /* paquet illisible ignoré */ }
      });
      s.bind(0, adr, () => {
        try { s.setMulticastInterface(adr); s.setMulticastTTL(255); } catch { /* ignoré */ }
        const q = requete();
        s.send(q, PORT, GROUPE);
        setTimeout(() => { try { s.send(q, PORT, GROUPE); } catch { /* fermée */ } }, 800);
      });
    }
    setTimeout(() => {
      for (const s of sockets) { try { s.close(); } catch { /* déjà fermée */ } }
      resolve([...trouves.values()]);
    }, duree);
  });
}

module.exports = { chercherMeshtastic, requete, lireReponses, assembler, encoderNom, SERVICE };
