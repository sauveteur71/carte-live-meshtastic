'use strict';
// Couche APRS : stations APRS du secteur, dont les stations LoRa APRS (433,775 MHz, radioamateurs), lues sur le
// réseau APRS-IS en lecture seule (aucune émission, aucun mot de passe : « pass -1 »), avec un filtre de zone.
// Désactivée par défaut (APRS_IS=oui pour l'activer) : la carte se connecte alors à un serveur APRS-IS public.
const net = require('net');

const SERVEUR_DEFAUT = 'rotate.aprs2.net:14580';
const DUREE_GARDE = 24 * 3600000;

// Destinations (« tocall ») des logiciels LoRa APRS les plus courants : traqueurs, iGates, digipeaters LoRa
const TOCALL_LORA = /^AP(LR|LG|LC|LT|LE|LW|LH|LO|LS|LI|L[0-9])/i;

// ---- Décodage d'une trame APRS (texte TNC2 « SRC>DEST,CHEMIN:données ») ----------------------------------
function lirePositionNonCompressee(s) {
  // DDMM.mmN / DDDMM.mmE, avec symboles table (après la latitude) et code (après la longitude)
  const m = /^(\d{2})([0-9 ]{2}\.[0-9 ]{2})([NS])(.)(\d{3})([0-9 ]{2}\.[0-9 ]{2})([EW])(.)/.exec(s);
  if (!m) return null;
  const n = (x) => Number(String(x).replace(/ /g, '0'));
  let lat = n(m[1]) + n(m[2]) / 60, lon = n(m[5]) + n(m[6]) / 60;
  if (m[3] === 'S') lat = -lat;
  if (m[7] === 'W') lon = -lon;
  return { lat, lon, table: m[4], symbole: m[8], reste: s.slice(m[0].length) };
}
function lirePositionCompressee(s) {
  // Table, 4 car. latitude, 4 car. longitude (base 91), symbole, 3 car. (cap/vitesse/altitude), le tout sur 13 caractères
  if (s.length < 13 || !/^[\/\\A-Za-j]/.test(s)) return null;
  const b91 = (t) => [...t].reduce((v, c) => v * 91 + (c.charCodeAt(0) - 33), 0);
  const lat = 90 - b91(s.slice(1, 5)) / 380926;
  const lon = -180 + b91(s.slice(5, 9)) / 190463;
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  return { lat, lon, table: s[0], symbole: s[9], reste: s.slice(13) };
}
// Mic-E (portatifs et mobiles Kenwood, Yaesu…) : latitude codée dans la destination, longitude dans les données
function lirePositionMicE(dest, d) {
  const dst = String(dest).split('-')[0].toUpperCase();
  if (dst.length !== 6 || d.length < 9) return null;
  const chiffre = (c) => {
    if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
    if (c >= 'A' && c <= 'J') return c.charCodeAt(0) - 65;
    if (c >= 'P' && c <= 'Y') return c.charCodeAt(0) - 80;
    if (c === 'K' || c === 'L' || c === 'Z') return 0; // position volontairement imprécise
    return NaN;
  };
  const ch = [...dst].map(chiffre);
  if (ch.some((x) => Number.isNaN(x))) return null;
  const haut = (c) => c >= 'P' && c <= 'Z';
  let lat = ch[0] * 10 + ch[1] + (ch[2] * 10 + ch[3] + (ch[4] * 10 + ch[5]) / 100) / 60;
  if (!haut(dst[3])) lat = -lat;
  let lonDeg = d.charCodeAt(1) - 28;
  if (haut(dst[4])) lonDeg += 100;
  if (lonDeg >= 180 && lonDeg <= 189) lonDeg -= 80;
  else if (lonDeg >= 190 && lonDeg <= 199) lonDeg -= 190;
  let lonMin = d.charCodeAt(2) - 28;
  if (lonMin >= 60) lonMin -= 60;
  const lonCent = d.charCodeAt(3) - 28;
  let lon = lonDeg + (lonMin + lonCent / 100) / 60;
  if (haut(dst[5])) lon = -lon;
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || lonMin < 0 || lonCent < 0 || lonCent > 99) return null;
  let reste = d.slice(9);
  let altitude = null;
  const a = /^(.{0,1}?)([!-{]{3})\}/.exec(reste); // altitude en base 91, en mètres + 10 000
  if (a) { altitude = [...a[2]].reduce((v, c) => v * 91 + (c.charCodeAt(0) - 33), 0) - 10000; reste = reste.slice(a[0].length); }
  reste = reste.replace(/^[>\]`']/, '').replace(/[=^]$/, '');
  return { lat, lon, table: d[8], symbole: d[7], reste, altitude };
}

function lireTrame(ligne) {
  const i = ligne.indexOf(':');
  const j = ligne.indexOf('>');
  if (i < 0 || j < 0 || j > i) return null;
  const source = ligne.slice(0, j).trim();
  const entete = ligne.slice(j + 1, i).split(',');
  const destination = entete[0];
  const chemin = entete.slice(1);
  let d = ligne.slice(i + 1);
  if (!source || !d) return null;
  let indicatif = source, objet = false;
  const type = d[0];
  if (type === ';' && d.length > 18) { indicatif = d.slice(1, 10).trim(); objet = true; d = d.slice(18); } // objet : nom sur 9 car., *, heure sur 7 car.
  else if (type === ')') { const k = d.slice(1).search(/[!_]/); if (k < 0) return null; indicatif = d.slice(1, k + 1); objet = true; d = d.slice(k + 2); }
  else if (type === '!' || type === '=') d = d.slice(1);
  else if (type === '/' || type === '@') d = d.slice(8); // heure sur 7 caractères
  else if (type !== '`' && type !== "'") return null; // messages, télémétrie… ignorés
  const micE = type === '`' || type === "'";
  const p = micE ? lirePositionMicE(destination, d) : /^\d/.test(d) ? lirePositionNonCompressee(d) : lirePositionCompressee(d);
  if (!p) return null;
  const commentaire = p.reste.replace(/^[0-9.]{3}\/[0-9.]{3}/, '').replace(/\/A=-?\d{6}/, '').trim().slice(0, 120);
  const alt = /\/A=(-?\d{6})/.exec(p.reste);
  const altitude = alt ? Math.round(Number(alt[1]) * 0.3048) : p.altitude != null ? p.altitude : null;
  const via = chemin.filter((x) => !/^(TCPIP\*?|qA.|WIDE\d?-?\d?\*?)$/i.test(x));
  const lora = (!micE && TOCALL_LORA.test(destination)) || /lora/i.test(p.reste) || chemin.some((x) => /lora/i.test(x));
  return {
    indicatif, source, objet, destination, lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), table: p.table, symbole: p.symbole,
    commentaire, altitude, micE, lora, igate: chemin[chemin.length - 1] || null, via: via.slice(0, 4),
  };
}

function lireReglages(env = process.env) {
  const [hote, port] = String(env.APRS_SERVEUR || SERVEUR_DEFAUT).split(':');
  return {
    actif: String(env.APRS_IS || '').toLowerCase() === 'oui',
    hote: hote || 'rotate.aprs2.net', port: Number(port) || 14580,
    indicatif: String(env.APRS_INDICATIF || '').trim().toUpperCase().slice(0, 9),
    loraSeulement: String(env.APRS_LORA_SEULEMENT || '').toLowerCase() === 'oui',
  };
}

// Indicatif radioamateur plausible (F4GLD, F4GLD-7, ON4XYZ, DL1ABC-10) : au moins un chiffre, pas N0CALL ni NOCALL
function indicatifValide(c) {
  return /^(?=[A-Z0-9]*\d)[A-Z0-9]{3,7}(-(\d|1[0-5]))?$/.test(String(c || '')) && !/^N0?CALL/.test(c);
}

function creerAprs({ zone, journal = () => {}, version = '', reglages = lireReglages(), connecter = net.connect }) {
  const r = reglages;
  const stations = new Map(); // indicatif → station
  const etat = { actif: r.actif, connecte: false, serveur: `${r.hote}:${r.port}`, erreur: null, trames: 0, depuis: null, indicatif: indicatifValide(r.indicatif) };
  if (r.actif && !etat.indicatif) {
    etat.erreur = 'indicatif radioamateur requis (Réglages avancés › APRS)';
    journal('[APRS]', 'couche APRS non démarrée : indiquer votre indicatif radioamateur (APRS_INDICATIF)');
  }
  let filtreEnCours = null;
  let sock = null, reprise = null, arret = false, tampon = '';

  function filtre() {
    const [sud, ouest, nord, est] = zone();
    const m = 0.3; // marge autour de la zone (degrés)
    return `a/${(nord + m).toFixed(2)}/${(ouest - m).toFixed(2)}/${(sud - m).toFixed(2)}/${(est + m).toFixed(2)}`;
  }
  function noter(t) {
    if (r.loraSeulement && !t.lora) return;
    const avant = stations.get(t.indicatif);
    stations.set(t.indicatif, { ...t, heure: Date.now(), nb: ((avant && avant.nb) || 0) + 1, lora: t.lora || !!(avant && avant.lora) });
  }
  function demarrer() {
    if (!r.actif || arret || !etat.indicatif) return;
    tampon = '';
    sock = connecter({ host: r.hote, port: r.port });
    sock.setEncoding('latin1');
    sock.setTimeout(300000);
    sock.on('connect', () => {
      etat.connecte = true; etat.erreur = null; etat.depuis = Date.now();
      filtreEnCours = filtre();
      sock.write(`user ${r.indicatif} pass -1 vers carte-live ${version} filter ${filtreEnCours}\r\n`);
      journal('[APRS]', `connecté à ${etat.serveur} (lecture seule, ${filtreEnCours})`);
    });
    sock.on('data', (morceau) => {
      tampon += morceau;
      let k;
      while ((k = tampon.indexOf('\n')) >= 0) {
        const ligne = tampon.slice(0, k).replace(/\r$/, '');
        tampon = tampon.slice(k + 1);
        if (!ligne || ligne[0] === '#') continue; // commentaires du serveur (keepalive, logresp)
        etat.trames++;
        try { const t = lireTrame(ligne); if (t) noter(t); } catch { /* trame illisible */ }
      }
      if (tampon.length > 10000) tampon = '';
    });
    sock.on('timeout', () => sock.destroy(new Error('aucune donnée depuis 5 min')));
    sock.on('error', (e) => { etat.erreur = e.message; });
    sock.on('close', () => {
      etat.connecte = false;
      if (!arret) { clearTimeout(reprise); reprise = setTimeout(demarrer, 60000); if (reprise.unref) reprise.unref(); }
    });
  }
  // Toutes les 10 min : stations trop anciennes oubliées, et zone suivie si le département de la carte a changé
  const menage = setInterval(() => {
    const t = Date.now();
    for (const [k, s] of stations) if (t - s.heure > DUREE_GARDE) stations.delete(k);
    if (etat.connecte && sock) {
      try { const f = filtre(); if (f !== filtreEnCours) { sock.write(`#filter ${f}\r\n`); filtreEnCours = f; journal('[APRS]', `zone suivie : ${f}`); } } catch { /* zone indisponible */ }
    }
  }, 600000);
  if (menage.unref) menage.unref();
  demarrer();

  return {
    etat: () => ({ ...etat, stations: stations.size, loraSeulement: r.loraSeulement }),
    liste(heures = 6) {
      const t = Date.now() - heures * 3600000;
      return [...stations.values()].filter((s) => s.heure >= t).sort((a, b) => b.heure - a.heure).slice(0, 2000);
    },
    arreter() { arret = true; clearTimeout(reprise); clearInterval(menage); if (sock) sock.destroy(); },
  };
}

module.exports = { creerAprs, lireTrame, lireReglages, indicatifValide };
