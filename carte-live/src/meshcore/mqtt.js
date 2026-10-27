'use strict';
// MeshCore et MQTT, au format de meshcoretomqtt (observateurs « mctomqtt », cartes MeshCore) :
//   meshcore/{IATA}/{CLÉ PUBLIQUE}/packets : { origin, origin_id, timestamp, type:"PACKET", direction, len, packet_type, route, raw, SNR, RSSI, hash… }
//   meshcore/{IATA}/{CLÉ PUBLIQUE}/status  : { status:"online"|"offline", origin, origin_id, radio, model, firmware_version… }
// Lecture : messages reçus du broker → observations. Écriture : republication des paquets captés par le companion.

const crypto = require('crypto');
const mqtt = require('mqtt');

const RE_SUJET = /^([^/]+)\/([^/]+)\/([0-9A-Fa-f]{64})\/(packets|status|internal)$/;

// Message MQTT MeshCore → { genre: 'observation' | 'statut', … } ou null
function lireMessageMc(sujet, message) {
  const m = RE_SUJET.exec(sujet);
  if (!m) return null;
  let o;
  try { o = JSON.parse(message.toString('utf8')); } catch { return { genre: 'erreur' }; }
  const cle = (o.origin_id && /^[0-9A-Fa-f]{64}$/.test(o.origin_id) ? o.origin_id : m[3]).toUpperCase();
  if (m[4] === 'status' || m[4] === 'internal') {
    return { genre: 'statut', cle, iata: m[2], nom: o.origin || null, etat: o.status || (m[4] === 'internal' ? 'online' : null), details: { modele: o.model, firmware: o.firmware_version, radio: o.radio, client: o.client_version, iata: m[2] } };
  }
  if (o.type && o.type !== 'PACKET') return null;
  if (o.direction && String(o.direction).toLowerCase() !== 'rx') return null;
  const brut = String(o.raw || '').replace(/\s+/g, '');
  if (!/^[0-9A-Fa-f]{4,}$/.test(brut)) return null;
  const nb = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const heure = o.timestamp ? Date.parse(o.timestamp) : NaN;
  return { genre: 'observation', cle, nom: o.origin || null, iata: m[2], obs: { brut: Buffer.from(brut, 'hex'), snr: nb(o.SNR), rssi: nb(o.RSSI), observateur: cle, heure: Number.isFinite(heure) && Math.abs(heure - Date.now()) < 10 * 60000 ? heure : Date.now(), via: 'mqtt' } };
}

// Republication des observations du companion sur le broker de la carte
function creerPublicateurMc(config, journal) {
  const cfg = config.meshcore;
  let client = null, cleClient = null, nomClient = null;
  const stats = { publies: 0, erreurs: 0, dernier: null, connecte: false, refus: null };
  const prefixe = (cle) => `${cfg.racine}/${cfg.iata}/${cle}`;
  const statut = (etat, infos) => JSON.stringify({ status: etat, timestamp: new Date().toISOString(), origin: nomClient, origin_id: cleClient, radio: infos && infos.radio ? `${infos.radio.freq},${infos.radio.bw},${infos.radio.sf},${infos.radio.cr}` : 'unknown', model: (infos && infos.modele) || 'unknown', firmware_version: (infos && infos.firmware) || 'unknown', client_version: 'carte-live/1.0' });

  function assurer(cle, nom, infos) {
    if (!cfg.republier || !cle || !config.mqtt.url) return null;
    if (client && cleClient === cle) return client;
    if (client) { try { client.end(true); } catch { /* déjà fermé */ } }
    cleClient = cle; nomClient = nom || cle.slice(0, 8);
    client = mqtt.connect(config.mqtt.url, {
      username: config.mqtt.utilisateur || undefined, password: config.mqtt.motDePasse || undefined,
      clientId: 'carte-live-mc-' + crypto.randomBytes(3).toString('hex'), reconnectPeriod: 10000, rejectUnauthorized: !config.mqtt.tlsNonVerifie,
      will: { topic: prefixe(cle) + '/status', payload: Buffer.from(statut('offline', infos)), qos: 0, retain: true },
    });
    let connecteA = 0, coupuresRapides = 0;
    client.on('connect', () => {
      stats.connecte = true;
      connecteA = Date.now();
      if (!coupuresRapides) journal(`republication MeshCore sur ${prefixe(cle)}/packets`);
      client.publish(prefixe(cle) + '/status', statut('online', infos), { qos: 0, retain: true });
    });
    client.on('close', () => {
      stats.connecte = false;
      // Le broker coupe juste après la connexion : en général, publication refusée (droits ACL sur le sujet)
      if (connecteA && Date.now() - connecteA < 8000) {
        coupuresRapides++;
        if (coupuresRapides === 2) {
          stats.refus = `le broker coupe la connexion à chaque publication : le compte MQTT « ${config.mqtt.utilisateur || '(anonyme)'} » n’a sans doute pas le droit d’écrire sur ${cfg.racine}/#`;
          journal('republication MeshCore : ' + stats.refus + ' — nouvel essai toutes les 10 min');
          client.options.reconnectPeriod = 10 * 60000;
        }
      } else if (connecteA) { coupuresRapides = 0; stats.refus = null; client.options.reconnectPeriod = 10000; }
      connecteA = 0;
    });
    client.on('error', (e) => { stats.erreurs++; stats.refus = e.message; });
    return client;
  }

  return {
    publier(obs, p, companion) {
      const c = assurer(companion.cle, companion.nom, companion);
      if (!c || !c.connected) return;
      const d = new Date(obs.heure || Date.now());
      const deux = (n) => String(n).padStart(2, '0');
      const corps = {
        origin: companion.nom, origin_id: companion.cle, timestamp: d.toISOString(), type: 'PACKET', direction: 'rx',
        time: `${deux(d.getHours())}:${deux(d.getMinutes())}:${deux(d.getSeconds())}`, date: `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`,
        len: String(obs.brut.length), packet_type: String((obs.brut[0] >> 2) & 0x0f), route: (obs.brut[0] & 0x03) === 2 || (obs.brut[0] & 0x03) === 3 ? 'D' : 'F',
        payload_len: String(p ? p.tailleCharge : ''), raw: obs.brut.toString('hex').toUpperCase(),
        SNR: String(Math.round(obs.snr ?? 0)), RSSI: String(obs.rssi ?? 0), score: '1000', hash: p ? p.hachage : undefined,
      };
      c.publish(prefixe(companion.cle) + '/packets', JSON.stringify(corps), { qos: 0 }, (e) => {
        if (e) { stats.erreurs++; stats.refus = e.message; } else { stats.publies++; stats.dernier = Date.now(); }
      });
    },
    etat: () => ({ ...stats, actif: !!cfg.republier, sujet: cleClient ? prefixe(cleClient) + '/packets' : `${cfg.racine}/${cfg.iata}/<clé du companion>/packets` }),
    fermer() { if (client) { try { client.publish(prefixe(cleClient) + '/status', statut('offline'), { qos: 0, retain: true }); client.end(); } catch { /* ignoré */ } } },
  };
}

module.exports = { lireMessageMc, creerPublicateurMc, RE_SUJET };
