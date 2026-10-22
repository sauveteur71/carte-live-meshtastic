'use strict';
// Déchiffrement et décodage des paquets Meshtastic reçus par MQTT (ServiceEnvelope protobuf)

const path = require('path');
const crypto = require('crypto');
const protobuf = require('protobufjs');

const racine = new protobuf.Root();
const dossierProtos = path.join(__dirname, '..', 'protobufs');
const dossierGoogle = path.dirname(require.resolve('protobufjs/package.json'));
racine.resolvePath = (_origine, cible) =>
  cible.startsWith('google/') ? path.join(dossierGoogle, cible) : path.join(dossierProtos, cible);
racine.loadSync(['meshtastic/mqtt.proto', 'meshtastic/telemetry.proto', 'meshtastic/mesh.proto', 'meshtastic/admin.proto']);
racine.resolveAll();

const T = (n) => racine.lookupType('meshtastic.' + n);
const ServiceEnvelope = T('ServiceEnvelope');
const Data = T('Data');
const Position = T('Position');
const User = T('User');
const Telemetry = T('Telemetry');
const NeighborInfo = T('NeighborInfo');
const RouteDiscovery = T('RouteDiscovery');
const MapReport = T('MapReport');
const Routing = T('Routing');
const Waypoint = T('Waypoint');

const ROLES = racine.lookupEnum('meshtastic.Config.DeviceConfig.Role').valuesById;
const MATERIELS = racine.lookupEnum('meshtastic.HardwareModel').valuesById;
const PRESETS = racine.lookupEnum('meshtastic.Config.LoRaConfig.ModemPreset').valuesById;
const PORTS_ENUM = racine.lookupEnum('meshtastic.PortNum').valuesById;

// Raisons d'échec du routage Meshtastic (Routing.Error)
const ERREURS_ROUTAGE = {
  1: 'pas de route', 2: 'refusé (NAK)', 3: 'délai dépassé', 4: 'pas d\'interface', 5: 'aucun accusé après réémissions',
  6: 'canal inconnu', 7: 'paquet trop grand', 8: 'pas de réponse', 9: 'limite de temps d\'émission atteinte',
  32: 'requête invalide', 33: 'non autorisé', 34: 'échec du chiffrement PKI', 35: 'clé publique inconnue',
  36: 'clé de session admin périmée', 37: 'clé du module non autorisée comme administrateur sur ce nœud', 38: 'limite de débit atteinte',
  39: 'clé publique du nœud inconnue du module',
};

// Libellés français des types de paquets
const PORTS = {
  1: { cle: 'texte', nom: 'Message texte' },
  3: { cle: 'position', nom: 'Position' },
  4: { cle: 'nodeinfo', nom: 'Infos nœud' },
  5: { cle: 'routage', nom: 'Routage / ACK' },
  6: { cle: 'admin', nom: 'Administration' },
  8: { cle: 'waypoint', nom: 'Point de repère' },
  10: { cle: 'capteur', nom: 'Détection capteur' },
  11: { cle: 'alerte', nom: 'Alerte' },
  34: { cle: 'pax', nom: 'Comptage PAX' },
  65: { cle: 'storeforward', nom: 'Store & Forward' },
  66: { cle: 'rangetest', nom: 'Test de portée' },
  67: { cle: 'telemetrie', nom: 'Télémétrie' },
  70: { cle: 'traceroute', nom: 'Traceroute' },
  71: { cle: 'voisinage', nom: 'Voisinage' },
  73: { cle: 'mapreport', nom: 'Rapport carte' },
};

function infoPort(num) {
  return PORTS[num] || { cle: 'autre', nom: PORTS_ENUM[num] ? PORTS_ENUM[num] : 'Port ' + num };
}

// ---- Clés de canal --------------------------------------------------------
const CLE_DEFAUT = Buffer.from('d4f1bb3a20290759f0bcffabcf4e6901', 'hex');

function etendreCle(base64) {
  const brut = Buffer.from(base64 || '', 'base64');
  if (brut.length === 0) return null; // canal non chiffré
  if (brut.length === 1) {
    const k = Buffer.from(CLE_DEFAUT);
    k[15] = (k[15] + brut[0] - 1) & 0xff;
    return k;
  }
  if (brut.length === 16 || brut.length === 32) return brut;
  const taille = brut.length < 16 ? 16 : 32;
  const k = Buffer.alloc(taille);
  brut.copy(k);
  return k;
}

function xorOctets(buf) {
  let h = 0;
  for (const b of buf) h ^= b;
  return h;
}

// Hachage de canal Meshtastic : xor(nom) ^ xor(clé étendue)
function hachageCanal(nom, cle) {
  return (xorOctets(Buffer.from(nom, 'utf8')) ^ xorOctets(cle || Buffer.alloc(0))) & 0xff;
}

function preparerCanaux(liste) {
  return liste.map((c) => {
    const cle = etendreCle(c.cle);
    return { nom: c.nom, cle, hachage: hachageCanal(c.nom, cle) };
  });
}

function dechiffrer(cle, idPaquet, de, donnees) {
  const nonce = Buffer.alloc(16);
  nonce.writeUInt32LE(idPaquet >>> 0, 0);
  nonce.writeUInt32LE(de >>> 0, 8);
  const algo = cle.length === 32 ? 'aes-256-ctr' : 'aes-128-ctr';
  const d = crypto.createDecipheriv(algo, cle, nonce);
  return Buffer.concat([d.update(donnees), d.final()]);
}

function essayerDecoderData(buf) {
  try {
    const data = Data.decode(buf);
    if (!data.portnum || data.portnum <= 0 || data.portnum > 600) return null;
    return data;
  } catch {
    return null;
  }
}

// ---- Utilitaires ---------------------------------------------------------
const idNoeud = (num) => '!' + (num >>> 0).toString(16).padStart(8, '0');
const numDepuisId = (id) => (typeof id === 'string' && /^![0-9a-f]{8}$/i.test(id) ? parseInt(id.slice(1), 16) >>> 0 : null);
const DIFFUSION = 0xffffffff;

function coord(i) {
  return i === undefined || i === null || i === 0 ? null : i / 1e7;
}

// Position exploitable : coordonnées finies, et pas le « point zéro » (0,0) d'un GPS sans signal
function positionValide(lat, lon) {
  return lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon) &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(Math.abs(lat) < 1 && Math.abs(lon) < 1);
}

function nombreOuNull(v) {
  return v === undefined || v === null || Number.isNaN(v) ? null : Number(v);
}

// Contenu protobuf complet, en JSON (affiché dans la liste des trames). Pas pour le texte (stocké à part).
const TYPES_CONTENU = { 3: 'Position', 4: 'User', 5: 'Routing', 8: 'Waypoint', 67: 'Telemetry', 70: 'RouteDiscovery', 71: 'NeighborInfo', 73: 'MapReport' };
function contenuBrut(portnum, payload) {
  const nom = TYPES_CONTENU[portnum];
  if (!nom) return null;
  try {
    const T = racine.lookupType('meshtastic.' + nom);
    const o = T.toObject(T.decode(payload), { longs: Number, enums: String, bytes: String });
    if (o.publicKey) o.publicKey = '(clé publique)';
    if (o.macaddr) delete o.macaddr;
    return o;
  } catch { return null; }
}

// Décode la charge utile selon le port. Retourne { resume, details }
function decoderCharge(portnum, payload) {
  try {
    switch (portnum) {
      case 1: {
        const t = Buffer.from(payload).toString('utf8');
        return { resume: '« ' + (t.length > 60 ? t.slice(0, 60) + '…' : t) + ' »', texte: t };
      }
      case 3: {
        const p = Position.decode(payload);
        let lat = coord(p.latitudeI), lon = coord(p.longitudeI);
        if (!positionValide(lat, lon)) { lat = null; lon = null; }
        return {
          resume: lat !== null ? `${lat.toFixed(4)}, ${lon.toFixed(4)}` + (p.altitude ? ` · ${p.altitude} m` : '') : 'Position vide',
          position: { lat, lon, alt: nombreOuNull(p.altitude), precision: nombreOuNull(p.precisionBits), sats: nombreOuNull(p.satsInView) },
        };
      }
      case 4: {
        const u = User.decode(payload);
        return {
          resume: `${u.longName || '?'} (${u.shortName || '?'})`,
          utilisateur: {
            nomLong: u.longName || null,
            nomCourt: u.shortName || null,
            materiel: MATERIELS[u.hwModel] || null,
            role: ROLES[u.role || 0] || 'CLIENT',
            licencie: !!u.isLicensed,
          },
        };
      }
      case 5: {
        const r = Routing.decode(payload);
        const code = r.errorReason || 0;
        return { resume: code ? 'Erreur de routage : ' + (ERREURS_ROUTAGE[code] || code) : 'Accusé de réception', erreurRoutage: code };
      }
      case 8: {
        const w = Waypoint.decode(payload);
        return { resume: w.name || 'Point de repère' };
      }
      case 67: {
        const t = Telemetry.decode(payload);
        if (t.deviceMetrics) {
          const m = t.deviceMetrics;
          const parties = [];
          if (m.batteryLevel !== undefined && m.batteryLevel !== null) parties.push(m.batteryLevel > 100 ? 'secteur' : m.batteryLevel + ' %');
          if (m.voltage > 0) parties.push(m.voltage.toFixed(2) + ' V');
          if (m.channelUtilization !== undefined) parties.push('canal ' + (m.channelUtilization || 0).toFixed(1) + ' %');
          if (m.airUtilTx !== undefined) parties.push('émission ' + (m.airUtilTx || 0).toFixed(1) + ' %');
          return {
            resume: parties.join(' · ') || 'Télémétrie appareil',
            telemetrie: {
              batterie: nombreOuNull(m.batteryLevel),
              tension: m.voltage > 0 ? m.voltage : null,
              canal: nombreOuNull(m.channelUtilization),
              emission: nombreOuNull(m.airUtilTx),
              uptime: nombreOuNull(m.uptimeSeconds),
            },
          };
        }
        if (t.environmentMetrics) {
          const e = t.environmentMetrics;
          const parties = [];
          if (e.temperature) parties.push(e.temperature.toFixed(1) + ' °C');
          if (e.relativeHumidity) parties.push(e.relativeHumidity.toFixed(0) + ' %HR');
          if (e.barometricPressure) parties.push(e.barometricPressure.toFixed(0) + ' hPa');
          return {
            resume: parties.join(' · ') || 'Télémétrie environnement',
            environnement: {
              temperature: nombreOuNull(e.temperature),
              humidite: nombreOuNull(e.relativeHumidity),
              pression: nombreOuNull(e.barometricPressure),
            },
          };
        }
        if (t.localStats) {
          const s = t.localStats;
          return {
            resume: `Stats : ${s.numOnlineNodes || 0} nœuds en ligne · canal ${(s.channelUtilization || 0).toFixed(1)} %`,
            telemetrie: { canal: nombreOuNull(s.channelUtilization), emission: nombreOuNull(s.airUtilTx), uptime: nombreOuNull(s.uptimeSeconds) },
            statsLocales: {
              enLigne: nombreOuNull(s.numOnlineNodes),
              total: nombreOuNull(s.numTotalNodes),
              tx: nombreOuNull(s.numPacketsTx),
              rx: nombreOuNull(s.numPacketsRx),
              rxErreur: nombreOuNull(s.numPacketsRxBad),
              rxDoublons: nombreOuNull(s.numRxDupe),
              relais: nombreOuNull(s.numTxRelay),
              bruit: nombreOuNull(s.noiseFloor),
            },
          };
        }
        if (t.powerMetrics) {
          const p = t.powerMetrics;
          return {
            resume: p.ch1Voltage ? `Alim ${p.ch1Voltage.toFixed(2)} V` : 'Télémétrie alimentation',
            alimentation: { tension: nombreOuNull(p.ch1Voltage), courant: nombreOuNull(p.ch1Current) },
          };
        }
        return { resume: 'Télémétrie' };
      }
      case 70: {
        const r = RouteDiscovery.decode(payload);
        const n = (r.route || []).length;
        return {
          resume: `Traceroute · ${n} saut${n > 1 ? 's' : ''} intermédiaire${n > 1 ? 's' : ''}`,
          traceroute: {
            aller: (r.route || []).map((x) => x >>> 0),
            snrAller: (r.snrTowards || []).map((x) => x / 4),
            retour: (r.routeBack || []).map((x) => x >>> 0),
            snrRetour: (r.snrBack || []).map((x) => x / 4),
          },
        };
      }
      case 71: {
        const v = NeighborInfo.decode(payload);
        const voisins = (v.neighbors || []).map((x) => ({ num: x.nodeId >>> 0, snr: nombreOuNull(x.snr) }));
        return { resume: `${voisins.length} voisin${voisins.length > 1 ? 's' : ''} direct${voisins.length > 1 ? 's' : ''}`, voisinage: { noeud: v.nodeId >>> 0, voisins } };
      }
      case 73: {
        const m = MapReport.decode(payload);
        return {
          resume: `${m.longName || '?'} · ${PRESETS[m.modemPreset] || ''} · fw ${m.firmwareVersion || '?'}`,
          rapportCarte: {
            nomLong: m.longName || null,
            nomCourt: m.shortName || null,
            role: ROLES[m.role || 0] || 'CLIENT',
            materiel: MATERIELS[m.hwModel] || null,
            firmware: m.firmwareVersion || null,
            preset: PRESETS[m.modemPreset] || null,
            lat: positionValide(coord(m.latitudeI), coord(m.longitudeI)) ? coord(m.latitudeI) : null,
            lon: positionValide(coord(m.latitudeI), coord(m.longitudeI)) ? coord(m.longitudeI) : null,
            alt: nombreOuNull(m.altitude),
            precision: nombreOuNull(m.positionPrecision),
            voisinsEnLigne: nombreOuNull(m.numOnlineLocalNodes),
          },
        };
      }
      default:
        return { resume: infoPort(portnum).nom };
    }
  } catch (e) {
    return { resume: 'Charge illisible (' + e.message + ')' };
  }
}

/**
 * Décode un message MQTT Meshtastic.
 * @returns {object|null} événement normalisé ou null si ignoré
 */
function decoderMessage(topic, message, canaux) {
  // Topic Meshtastic : <root topic quelconque>/2/<e|map|stat|json>/…  (ex. msh/EU_868/2/e/…, msh/EU_868/FR/43/2/e/…)
  const morceaux = topic.split('/');
  let i2 = -1;
  for (let i = morceaux.length - 2; i >= 0; i--) {
    if (morceaux[i] === '2' && ['e', 'map', 'stat', 'json', 'c'].includes(morceaux[i + 1])) { i2 = i; break; }
  }
  const type = i2 >= 0 ? morceaux[i2 + 1] : null;

  if (type === 'stat') {
    const passerelle = morceaux[morceaux.length - 1];
    return { genre: 'statut', passerelle, num: numDepuisId(passerelle), etat: message.toString().trim() };
  }
  if (type !== 'e' && type !== 'map') return null; // le JSON (/2/json) est ignoré : on décode le protobuf

  let env;
  try {
    env = ServiceEnvelope.decode(message);
  } catch {
    return { genre: 'erreur', raison: 'Enveloppe illisible', topic };
  }
  const p = env.packet;
  if (!p) return null;

  const de = p.from >>> 0;
  const vers = p.to >>> 0;
  const evt = {
    genre: 'paquet',
    idPaquet: p.id >>> 0,
    de,
    vers,
    diffusion: vers === DIFFUSION,
    passerelle: env.gatewayId || null,
    numPasserelle: numDepuisId(env.gatewayId),
    canalTopic: type === 'map' ? 'map' : env.channelId || morceaux[i2 + 2] || null,
    canal: null,
    sujet: i2 >= 0 ? morceaux.slice(0, i2).join('/') : topic,
    pki: !!p.pkiEncrypted,
    demandeAccuse: !!p.wantAck,
    hopDepart: p.hopStart || 0,
    hopRestant: p.hopLimit || 0,
    sauts: p.hopStart ? Math.max(0, p.hopStart - (p.hopLimit || 0)) : null,
    snr: p.rxSnr || p.rxSnr === 0 ? p.rxSnr : null,
    rssi: p.rxRssi || null,
    relais: p.relayNode ? p.relayNode & 0xff : null,
    viaMqtt: !!p.viaMqtt,
    heure: p.rxTime ? p.rxTime * 1000 : Date.now(),
    dechiffre: false,
    portnum: null,
  };
  // Le paquet émis par la passerelle elle-même n'a pas de SNR/RSSI pertinent
  if (evt.numPasserelle === de) {
    evt.snr = null;
    evt.rssi = null;
  }

  let data = null;
  if (p.decoded) {
    data = p.decoded;
    evt.dechiffre = true;
    evt.canal = evt.canalTopic;
  } else if (p.encrypted && p.encrypted.length) {
    if (p.pkiEncrypted) {
      evt.chiffrement = 'PKI (message privé)';
    } else {
      const candidats = canaux.filter((c) => c.cle && c.hachage === (p.channel & 0xff));
      const autres = canaux.filter((c) => c.cle && !candidats.includes(c));
      for (const c of [...candidats, ...autres]) {
        const d = essayerDecoderData(dechiffrer(c.cle, evt.idPaquet, de, Buffer.from(p.encrypted)));
        if (d) {
          data = d;
          evt.dechiffre = true;
          evt.canal = c.nom;
          break;
        }
      }
      if (!data) evt.chiffrement = 'Clé inconnue';
    }
  }

  // Taille utile sur l'air (sans l'en-tête LoRa Meshtastic de 16 octets), pour l'estimation du temps d'émission
  evt.taille = p.encrypted && p.encrypted.length ? p.encrypted.length : data ? Data.encode(data).finish().length : null;

  if (data) {
    evt.portnum = data.portnum;
    const info = infoPort(data.portnum);
    evt.port = info.cle;
    evt.nomPort = info.nom;
    evt.requeteId = data.requestId || null;
    Object.assign(evt, decoderCharge(data.portnum, data.payload || Buffer.alloc(0)));
    evt.contenu = contenuBrut(data.portnum, data.payload || Buffer.alloc(0));
  } else {
    evt.port = 'chiffre';
    evt.nomPort = 'Chiffré';
    evt.resume = evt.chiffrement || 'Chiffré';
  }
  return evt;
}

module.exports = {
  decoderMessage,
  preparerCanaux,
  etendreCle,
  hachageCanal,
  dechiffrer,
  idNoeud,
  numDepuisId,
  PORTS,
  infoPort,
  racine,
  types: { ServiceEnvelope, Data, Position, User, Telemetry, NeighborInfo, RouteDiscovery, MapReport },
  DIFFUSION,
  ROLES,
  MATERIELS,
  ERREURS_ROUTAGE,
  positionValide,
};
