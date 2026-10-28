'use strict';
// Mise à jour du firmware Meshtastic par le Wi-Fi (« ESP32 Unified OTA », firmware 2.7.18 ou plus récent).
// Même protocole que le client Python officiel (meshtastic --host … --ota-update) :
//  1. le module reçoit un AdminMessage ota_request { reboot_ota_mode: OTA_WIFI, ota_hash: SHA-256 du binaire } et redémarre sur son chargeur OTA ;
//  2. connexion TCP au port 3232 : « OTA <taille> <sha256> » → ERASING… OK ;
//  3. envoi du binaire par blocs de 1 ko → OK (empreinte vérifiée par le module), puis il redémarre sur le nouveau firmware.
// Binaires : dépôt public meshtastic.github.io (le même que le flasheur web officiel), gardés dans /data/firmware.

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const PORT_OTA = 3232;
const URL_MATERIELS = 'https://api.meshtastic.org/resource/deviceHardware';
const URL_BINAIRE = (version, cible) => `https://raw.githubusercontent.com/meshtastic/meshtastic.github.io/master/firmware-${version}/firmware-${cible}-${version}.bin`;

function creerOta(dossierDonnees, journal) {
  const dossier = path.join(dossierDonnees, 'firmware');
  try { fs.mkdirSync(dossier, { recursive: true }); } catch { /* lecture seule */ }
  let materiels = null, materielsDate = 0;

  async function materiel(hwModel) {
    if (!materiels || Date.now() - materielsDate > 7 * 86400000) {
      const r = await fetch(URL_MATERIELS, { headers: { 'User-Agent': 'carte-live' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('liste des matériels Meshtastic indisponible (HTTP ' + r.status + ')');
      materiels = await r.json(); materielsDate = Date.now();
    }
    const m = materiels.find((x) => x.hwModelSlug === hwModel || x.hwModel === hwModel);
    if (!m) throw new Error(`matériel « ${hwModel} » inconnu de la liste officielle`);
    return m;
  }

  // Binaire du firmware pour ce matériel (téléchargé une fois, vérifié : image ESP32, taille plausible)
  async function binaire(version, cible) {
    version = String(version).replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+\.[0-9a-f]{6,}$/.test(version)) throw new Error('version invalide : ' + version);
    if (!/^[a-z0-9_-]+$/i.test(cible)) throw new Error('cible invalide');
    const f = path.join(dossier, `firmware-${cible}-${version}.bin`);
    if (!fs.existsSync(f)) {
      const r = await fetch(URL_BINAIRE(version, cible), { headers: { 'User-Agent': 'carte-live' }, signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error(`firmware ${version} introuvable pour ${cible} (HTTP ${r.status})`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf[0] !== 0xe9 || buf.length < 500000 || buf.length > 8 * 1048576) throw new Error('fichier téléchargé invalide (pas une image ESP32)');
      fs.writeFileSync(f + '.tmp', buf); fs.renameSync(f + '.tmp', f);
      journal(`[OTA] firmware ${version} pour ${cible} téléchargé (${Math.round(buf.length / 1024)} ko)`);
    }
    const data = fs.readFileSync(f);
    return { data, hash: crypto.createHash('sha256').update(data).digest(), version, fichier: path.basename(f) };
  }

  // Envoi au chargeur OTA du module (une tentative) ; progression(octets, total)
  function televerser(hote, data, hash, progression, signalArret) {
    return new Promise((ok, ko) => {
      const s = net.connect({ host: hote, port: PORT_OTA });
      let tampon = '', etape = 'debut', fini = false;
      const terminer = (err) => { if (fini) return; fini = true; clearTimeout(minuterie); s.destroy(); err ? ko(err) : ok(); };
      let minuterie = setTimeout(() => terminer(new Error('pas de réponse du chargeur OTA')), 20000);
      const relancer = (ms) => { clearTimeout(minuterie); minuterie = setTimeout(() => terminer(new Error(`délai dépassé (${etape})`)), ms); };
      s.on('error', (e) => terminer(e));
      s.on('close', () => terminer(new Error(`connexion fermée par le module (${etape})`)));
      s.on('connect', () => { s.write(`OTA ${data.length} ${hash.toString('hex')}\n`); etape = 'effacement'; relancer(90000); });
      const envoyer = async () => {
        etape = 'envoi';
        for (let i = 0; i < data.length; i += 1024) {
          if (signalArret && signalArret()) return terminer(Object.assign(new Error('arrêtée à votre demande'), { arret: true }));
          if (!s.write(data.subarray(i, i + 1024))) await new Promise((r) => s.once('drain', r));
          relancer(30000);
          if (progression) progression(Math.min(i + 1024, data.length), data.length);
        }
        etape = 'vérification'; relancer(90000);
      };
      s.on('data', (d) => {
        tampon += d.toString('utf8');
        let i;
        while ((i = tampon.indexOf('\n')) >= 0) {
          const ligne = tampon.slice(0, i).trim(); tampon = tampon.slice(i + 1);
          if (!ligne || ligne === 'ACK') continue;
          if (ligne.startsWith('ERR')) return terminer(new Error('le module refuse : ' + ligne.slice(3).trim()));
          if (ligne === 'ERASING') { relancer(90000); continue; }
          if (ligne === 'OK') {
            if (etape === 'effacement') envoyer().catch(terminer);
            else if (etape === 'vérification') return terminer();
          }
        }
      });
    });
  }

  // ---- Session courte avec l'API TCP d'un module Wi-Fi (port 4403), comme l'appli ou le client Python --------
  // Un seul client TCP à la fois sur un module : on ne s'en sert que pour un module qui n'est pas celui de la carte.
  const { racine } = require('./decodeur');
  const ToRadio = racine.lookupType('meshtastic.ToRadio'), FromRadio = racine.lookupType('meshtastic.FromRadio'), Admin = racine.lookupType('meshtastic.AdminMessage');
  function session(hote, port = 4403) {
    return new Promise((ok, ko) => {
      const s = net.connect({ host: hote, port });
      let tampon = Buffer.alloc(0), mon = null, meta = null, nom = null, fini = false;
      const ecouteurs = new Set();
      const minuterie = setTimeout(() => terminer(new Error('le module ne répond pas sur le port ' + port)), 20000);
      const terminer = (err) => { if (fini) return; fini = true; clearTimeout(minuterie); if (err) { s.destroy(); ko(err); } };
      const envoyer = (o) => { const c = ToRadio.encode(ToRadio.create(o)).finish(); const t = Buffer.from([0x94, 0xc3, 0, 0]); t.writeUInt16BE(c.length, 2); s.write(Buffer.concat([t, Buffer.from(c)])); };
      s.on('error', (e) => terminer(new Error(`connexion à ${hote}:${port} impossible (${e.code || e.message})`)));
      s.on('connect', () => { s.write(Buffer.alloc(32, 0xc3)); setTimeout(() => envoyer({ wantConfigId: 4242 }), 100); });
      s.on('data', (d) => {
        tampon = Buffer.concat([tampon, d]);
        while (tampon.length >= 4) {
          if (tampon[0] !== 0x94 || tampon[1] !== 0xc3) { tampon = tampon.subarray(1); continue; }
          const n = tampon.readUInt16BE(2);
          if (tampon.length < 4 + n) break;
          let m; try { m = FromRadio.decode(tampon.subarray(4, 4 + n)); } catch { m = null; }
          tampon = tampon.subarray(4 + n);
          if (!m) continue;
          if (m.myInfo) mon = m.myInfo.myNodeNum >>> 0;
          if (m.metadata) meta = FromRadio.toObject(m, { enums: String, longs: Number }).metadata;
          if (m.nodeInfo && mon != null && (m.nodeInfo.num >>> 0) === mon && m.nodeInfo.user) nom = m.nodeInfo.user.longName;
          if (m.packet) for (const f of ecouteurs) f(m.packet);
          if (m.configCompleteId === 4242 && !fini) {
            fini = true; clearTimeout(minuterie);
            ok({
              num: mon, nom, metadata: meta,
              // AdminMessage au module lui-même ; réponse attendue si wantResponse
              admin: (message, attendre = true) => new Promise((ok2, ko2) => {
                const id = (crypto.randomBytes(4).readUInt32LE(0) >>> 0) || 1;
                const payload = Admin.encode(Admin.fromObject(message)).finish();
                if (!attendre) { envoyer({ packet: { to: mon, id, wantAck: false, decoded: { portnum: 6, payload, wantResponse: false } } }); return setTimeout(() => ok2(null), 1500); }
                const t = setTimeout(() => { ecouteurs.delete(f); ko2(new Error('pas de réponse du module')); }, 15000);
                const f = (p) => { if (p.decoded && p.decoded.portnum === 6 && p.decoded.requestId === id) { clearTimeout(t); ecouteurs.delete(f); ok2(Admin.decode(p.decoded.payload)); } };
                ecouteurs.add(f);
                envoyer({ packet: { to: mon, id, wantAck: false, decoded: { portnum: 6, payload, wantResponse: true } } });
              }),
              fermer: () => { try { envoyer({ disconnect: true }); } catch { /* fermé */ } setTimeout(() => s.destroy(), 300); },
            });
          }
        }
      });
    });
  }
  // Version et matériel d'un module Wi-Fi joignable en IP
  async function infoModule(hote) {
    const c = await session(hote);
    try { return { num: c.num, nom: c.nom, firmware: c.metadata && c.metadata.firmwareVersion, hwModel: c.metadata && c.metadata.hwModel, wifi: c.metadata ? !!c.metadata.hasWifi : null }; } finally { c.fermer(); }
  }
  // Demande au module de redémarrer sur son chargeur OTA Wi-Fi (clé de session obtenue par une première lecture)
  async function declencher(hote, hash) {
    const c = await session(hote);
    try {
      let cle = null;
      try { const r = await c.admin({ getOwnerRequest: true }); cle = r && r.sessionPasskey && r.sessionPasskey.length ? r.sessionPasskey : null; } catch { /* module local : clé facultative */ }
      await c.admin({ otaRequest: { rebootOtaMode: 2, otaHash: hash }, ...(cle ? { sessionPasskey: cle } : {}) }, false);
    } finally { c.fermer(); }
  }

  return { materiel, binaire, televerser, infoModule, declencher, PORT_OTA };
}

module.exports = { creerOta };
