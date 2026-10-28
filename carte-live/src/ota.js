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

  return { materiel, binaire, televerser, PORT_OTA };
}

module.exports = { creerOta };
