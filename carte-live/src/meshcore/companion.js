'use strict';
// Liaison avec un companion MeshCore (protocole « companion » de l'appli officielle).
//
// La carte s'en sert :
//   - comme observateur : pour chaque paquet entendu, le firmware envoie PUSH_CODE_LOG_RX_DATA (0x88) avec SNR, RSSI et paquet brut ;
//   - pour envoyer et recevoir des messages (canaux, messages directs) ;
//   - pour administrer les répéteurs et room servers à distance (connexion par mot de passe, commandes CLI, état).
//
// Transports, tous ramenés à un flux d'octets tramé comme l'USB :
//   - Wi-Fi : companion « wifi » joignable en TCP (port 5000 par défaut) ;
//   - agent : companion USB sur un PC, relayé par l'agent (port 4404) ;
//   - navigateur : companion USB ou Bluetooth branché sur le PC qui affiche la carte (WebSocket /ws/meshcore).
// Trame série : '<' (vers le companion) ou '>' (depuis le companion) + longueur (2 octets, petit-boutiste) + données.
// Les commandes sont envoyées une par une : chaque commande attend sa réponse (ou une erreur) avant la suivante.

const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ROLES } = require('./paquet');

const CMD = {
  APP_START: 1, SEND_TXT_MSG: 2, SEND_CHANNEL_TXT_MSG: 3, GET_CONTACTS: 4, SET_DEVICE_TIME: 6, SEND_SELF_ADVERT: 7,
  ADD_UPDATE_CONTACT: 9, SYNC_NEXT_MESSAGE: 10, GET_BATT: 20, DEVICE_QUERY: 22, SEND_LOGIN: 26, SEND_STATUS_REQ: 27,
  LOGOUT: 29, GET_CHANNEL: 31, GET_CONTACT_BY_KEY: 30, RESET_PATH: 13, REMOVE_CONTACT: 15,
};
const RESP = {
  OK: 0, ERR: 1, CONTACTS_START: 2, CONTACT: 3, END_CONTACTS: 4, SELF_INFO: 5, SENT: 6, CONTACT_MSG: 7, CHANNEL_MSG: 8,
  NO_MORE: 10, BATT: 12, DEVICE_INFO: 13, CONTACT_MSG_V3: 16, CHANNEL_MSG_V3: 17, CHANNEL_INFO: 18,
  STATS: 24, ZONE_DEFAUT: 28, REPONSE_CLI: 29,
};
// Commandes récentes (firmware companion v1.10 et plus)
const CMD2 = { TRACE: 36, TELEMETRIE: 39, CONTROLE: 55, STATS: 56, ANON: 57, ZONE_DEFAUT_SET: 63, ZONE_DEFAUT_GET: 64, CLI: 66 };
const int8 = (x) => (x > 127 ? x - 256 : x);

// Télémétrie au format Cayenne LPP (canal, type, valeur), comme le firmware MeshCore l'envoie
const LPP = {
  0: ['entree', 1, (b, i) => b[i]], 1: ['sortie', 1, (b, i) => b[i]], 2: ['analogique', 2, (b, i) => b.readInt16BE(i) / 100],
  3: ['analogique', 2, (b, i) => b.readInt16BE(i) / 100], 100: ['generique', 4, (b, i) => b.readUInt32BE(i)], 101: ['luminosite', 2, (b, i) => b.readUInt16BE(i), 'lx'],
  102: ['presence', 1, (b, i) => b[i]], 103: ['temperature', 2, (b, i) => b.readInt16BE(i) / 10, '°C'], 104: ['humidite', 1, (b, i) => b[i] / 2, '%'],
  113: ['acceleration', 6, (b, i) => [b.readInt16BE(i) / 1000, b.readInt16BE(i + 2) / 1000, b.readInt16BE(i + 4) / 1000], 'g'],
  115: ['pression', 2, (b, i) => b.readUInt16BE(i) / 10, 'hPa'], 116: ['tension', 2, (b, i) => b.readInt16BE(i) / 100, 'V'], 117: ['courant', 2, (b, i) => b.readInt16BE(i) / 1000, 'A'],
  118: ['frequence', 4, (b, i) => b.readUInt32BE(i), 'Hz'], 120: ['pourcentage', 1, (b, i) => b[i], '%'], 121: ['altitude', 2, (b, i) => b.readInt16BE(i), 'm'],
  125: ['concentration', 2, (b, i) => b.readUInt16BE(i), 'ppm'], 128: ['puissance', 2, (b, i) => b.readUInt16BE(i), 'W'], 130: ['distance', 4, (b, i) => b.readUInt32BE(i) / 1000, 'm'],
  131: ['energie', 4, (b, i) => b.readUInt32BE(i) / 1000, 'kWh'], 132: ['direction', 2, (b, i) => b.readUInt16BE(i), '°'], 133: ['heure', 4, (b, i) => b.readUInt32BE(i)],
  134: ['gyroscope', 6, (b, i) => [b.readInt16BE(i) / 100, b.readInt16BE(i + 2) / 100, b.readInt16BE(i + 4) / 100], '°/s'], 135: ['couleur', 3, (b, i) => [b[i], b[i + 1], b[i + 2]]],
  136: ['gps', 9, (b, i) => { const v = (o) => { let x = (b[o] << 16) | (b[o + 1] << 8) | b[o + 2]; if (x & 0x800000) x -= 0x1000000; return x; }; return { lat: v(i) / 1e4, lon: v(i + 3) / 1e4, alt: v(i + 6) / 100 }; }],
  142: ['interrupteur', 1, (b, i) => b[i]],
};
function lireLpp(b) {
  const l = [];
  let i = 0;
  while (i + 2 <= b.length) {
    const canal = b[i], type = b[i + 1];
    if (canal === 0 && type === 0) break;
    const d = LPP[type];
    if (!d || i + 2 + d[1] > b.length) break;
    l.push({ canal, type: d[0], valeur: d[2](b, i + 2), unite: d[3] || '' });
    i += 2 + d[1];
  }
  return l;
}
const PUSH = { TRACE: 0x89, TELEMETRIE: 0x8b, BINAIRE: 0x8c, CONTROLE: 0x8e, CHEMIN: 0x8d, ADVERT: 0x80, PATH_UPDATED: 0x81, SEND_CONFIRMED: 0x82, MSG_WAITING: 0x83, LOGIN_OK: 0x85, LOGIN_FAIL: 0x86, STATUS: 0x87, LOG_RX: 0x88, NEW_ADVERT: 0x8a };
const ERREURS = { 1: 'commande non gérée par ce firmware', 2: 'introuvable (contact ou canal inconnu du companion)', 3: 'table pleine (contacts ou envois en attente)', 4: 'companion occupé', 5: 'erreur de stockage', 6: 'paramètre refusé' };
const TYPES_ROLE = { companion: 1, repeteur: 2, salon: 3, capteur: 4 };
const NOM_APPLI = 'carte-live';

// options.ecoute : companion « en écoute » en plus du companion principal ({ cible }) — il ne sert que d'observateur
// (paquets entendus, SNR, contacts) ; les envois et l'administration passent par le companion principal.
function creerCompanion(config, { agents, surObservation, surContacts, surEtat, surMessage, surConfirmation, surCanaux, journal }, options = {}) {
  const ecoute = options.ecoute || null;
  const fMemo = ecoute ? null : path.join(path.dirname(config.fichierBase), 'meshcore-companion.json');
  let memo = { cible: ecoute ? ecoute.cible || null : null, connus: [] };
  if (fMemo) try { memo = { ...memo, ...JSON.parse(fs.readFileSync(fMemo, 'utf8')) }; } catch { /* premier lancement */ }
  const sauver = () => { if (!fMemo) return; try { fs.writeFileSync(fMemo, JSON.stringify(memo, null, 1)); } catch (e) { journal('sauvegarde impossible :', e.message); } };

  let flux = null; // socket TCP, socket d'agent ou flux WebSocket du navigateur
  let tampon = Buffer.alloc(0);
  let minuterie = null, minuterieVie = null;
  let arret = !memo.cible;
  let contactsEnCours = null;
  let navigateur = null; // { nom, source, flux } quand un navigateur relie le companion
  let generation = 0; // change à chaque nouvelle liaison (annule les commandes en cours)
  let canaux = []; // { index, nom, secret (hex) } lus dans le companion
  let contacts = new Map(); // clé -> contact
  let etat = { connecte: false, cible: memo.cible, depuis: null, erreur: null, paquets: 0, cle: null, nom: null, radio: null, firmware: null, modele: null, batterieMv: null, lat: null, lon: null, contacts: 0, navigateur: false, pret: false };

  // File de commandes : une seule en vol à la fois
  const file = [];
  let enVol = null;
  // Attentes de « pushs » (connexion à un répéteur, réponse d'état, réponse CLI…)
  const attentes = new Set();
  // Collecteurs des données de contrôle (découverte des voisins : plusieurs réponses pour une seule demande)
  const collecteurs = new Set();
  // Messages en attente dans le companion : on les vide dès qu'il prévient
  let vidageEnCours = false;

  const notifier = () => { if (surEtat) setImmediate(surEtat); };

  function ecrire(octets) {
    if (!flux || flux.destroyed) return false;
    const t = Buffer.alloc(3 + octets.length);
    t[0] = 0x3c; t.writeUInt16LE(octets.length, 1); Buffer.from(octets).copy(t, 3);
    flux.write(t);
    return true;
  }

  /** Envoie une commande et attend la première trame dont le code est dans `codes` (ou une erreur). */
  function commande(octets, codes, delai = 8000) {
    const origine = new Error('commande ' + (octets[0] ?? '?')).stack; // pour le diagnostic d'une erreur non traitée
    return new Promise((ok, ko) => {
      file.push({ octets: Buffer.from(octets), codes: new Set(codes), delai, ok, ko, gen: generation, origine });
      pomper();
    });
  }
  function pomper() {
    if (enVol || !file.length) return;
    const c = file.shift();
    if (c.gen !== generation || !flux) { c.ko(new Error('companion non relié')); return pomper(); }
    enVol = c;
    c.minuterie = setTimeout(() => {
      if (enVol !== c) return;
      enVol = null;
      const e = new Error('pas de réponse du companion');
      e.stack += '\n    — ' + String(c.origine || '').split('\n').slice(1, 5).join('\n    — ');
      c.ko(e);
      pomper();
    }, c.delai);
    if (!ecrire(c.octets)) { clearTimeout(c.minuterie); enVol = null; c.ko(new Error('companion non relié')); pomper(); }
  }
  function terminer(t) {
    const c = enVol;
    if (!c) return false;
    const code = t[0];
    if (code === RESP.ERR || c.codes.has(code)) {
      clearTimeout(c.minuterie);
      enVol = null;
      if (code === RESP.ERR && !c.codes.has(RESP.ERR)) c.ko(Object.assign(new Error(ERREURS[t[1]] || 'erreur ' + t[1]), { code: t[1] }));
      else c.ok(t);
      setImmediate(pomper);
      return true;
    }
    return false;
  }
  function toutAnnuler(raison) {
    generation++;
    if (enVol) { clearTimeout(enVol.minuterie); enVol.ko(new Error(raison)); enVol = null; }
    while (file.length) file.shift().ko(new Error(raison));
    for (const a of attentes) { clearTimeout(a.minuterie); a.ko(new Error(raison)); }
    attentes.clear();
  }
  /** Attend un push qui satisfait `filtre(trame)`. */
  function attendre(filtre, delai) {
    return new Promise((ok, ko) => {
      const a = { filtre, ok, ko };
      a.minuterie = setTimeout(() => { attentes.delete(a); ko(new Error('pas de réponse dans le délai (' + Math.round(delai / 1000) + ' s)')); }, delai);
      attentes.add(a);
    });
  }
  function servirAttentes(t) {
    for (const a of attentes) {
      if (a.filtre(t)) { clearTimeout(a.minuterie); attentes.delete(a); a.ok(t); return true; }
    }
    return false;
  }

  function planifier(ms) {
    clearTimeout(minuterie);
    minuterie = setTimeout(connecter, ms);
  }

  const texte = (b) => b.toString('utf8').replace(/\0.*$/s, '').trim();

  async function initialiser(gen, essai = 1) {
    try {
      const b = Buffer.alloc(8 + NOM_APPLI.length);
      b[0] = CMD.APP_START; b[1] = 3; b.write(NOM_APPLI, 8, 'utf8');
      try {
        traiterSelfInfo(await commande(b, [RESP.SELF_INFO], 6000));
      } catch (e) {
        // Companion encore en train de démarrer (l'ouverture du port USB le redémarre souvent) : on redemande
        if (gen === generation && flux && essai < 6 && /pas de réponse/.test(e.message)) {
          journal(`le companion ne répond pas encore (essai ${essai}), nouvel essai dans ${2 * essai} s`);
          etat.erreur = 'le companion ne répond pas encore, nouvel essai…'; notifier();
          await new Promise((r) => setTimeout(r, 2000 * essai));
          if (gen === generation && flux) return initialiser(gen, essai + 1);
          return;
        }
        throw e;
      }
      etat.erreur = null;
      try { traiterDeviceInfo(await commande([CMD.DEVICE_QUERY, 3], [RESP.DEVICE_INFO], 5000)); } catch { /* ancien firmware */ }
      // Horloge : le companion s'en sert pour dater ses envois (les répéteurs refusent les horodatages qui reculent)
      const h = Buffer.alloc(5); h[0] = CMD.SET_DEVICE_TIME; h.writeUInt32LE(Math.floor(Date.now() / 1000), 1);
      await commande(h, [RESP.OK], 4000).catch(() => {});
      await lireContacts().catch((e) => journal('contacts non lus :', e.message));
      await lireCanaux().catch((e) => journal('canaux non lus :', e.message));
      // Région d'envoi par défaut (firmware récent) : étiquette posée sur nos messages en inondation
      try { const z = await commande([CMD2.ZONE_DEFAUT_GET], [RESP.ZONE_DEFAUT], 3000); etat.zoneDefaut = z.length >= 48 ? texte(z.subarray(1, 32)).replace(/^#/, '') || '' : null; } catch { etat.zoneDefaut = null; }
      if (gen !== generation) return;
      etat.pret = true;
      notifier();
      vider();
    } catch (e) {
      if (gen === generation) {
        // Aucun octet reçu : le port ne transmet rien (firmware non « companion USB », port pris par un autre programme…)
        const muet = !etat.octetsRecus;
        const msg = muet ? 'aucun octet reçu du companion : firmware « companion USB » ? port pris par un autre programme (sous Linux : ModemManager) ?' : e.message;
        journal('initialisation du companion impossible :', msg); etat.erreur = msg; notifier();
      }
    }
  }

  async function lireContacts() {
    contactsEnCours = [];
    await commande([CMD.GET_CONTACTS], [RESP.END_CONTACTS], 20000);
  }
  async function lireCanaux() {
    const max = etat.canauxMax || 8;
    const liste = [];
    for (let i = 0; i < max; i++) {
      try {
        const t = await commande([CMD.GET_CHANNEL, i], [RESP.CHANNEL_INFO], 3000);
        const nom = texte(t.subarray(2, 34)), secret = t.subarray(34, 50).toString('hex');
        if (nom && /[^0]/.test(secret)) liste.push({ index: t[1], nom, secret });
      } catch (e) { if (e.code !== 2) throw e; }
    }
    canaux = liste;
    etat.canaux = liste.map((c) => ({ index: c.index, nom: c.nom }));
    if (surCanaux) surCanaux(liste);
  }

  // Vide la file de messages du companion (messages directs, réponses CLI, messages de canal)
  async function vider() {
    if (vidageEnCours || !flux) return;
    vidageEnCours = true;
    try {
      for (let k = 0; k < 50; k++) {
        const t = await commande([CMD.SYNC_NEXT_MESSAGE], [RESP.NO_MORE, RESP.CONTACT_MSG_V3, RESP.CHANNEL_MSG_V3, RESP.CONTACT_MSG, RESP.CHANNEL_MSG], 5000);
        if (t[0] === RESP.NO_MORE) break;
        traiterMessage(t);
      }
    } catch (e) { journal('lecture des messages du companion :', e.message); }
    vidageEnCours = false;
  }

  function traiterMessage(t) {
    const v3 = t[0] === RESP.CONTACT_MSG_V3 || t[0] === RESP.CHANNEL_MSG_V3;
    let i = 1, snr = null;
    if (v3) { snr = (t[1] > 127 ? t[1] - 256 : t[1]) / 4; i = 4; }
    if (t[0] === RESP.CONTACT_MSG_V3 || t[0] === RESP.CONTACT_MSG) {
      const prefixe = t.subarray(i, i + 6).toString('hex').toUpperCase(); i += 6;
      const lgChemin = t[i++], type = t[i++], horodatage = t.readUInt32LE(i); i += 4;
      if (type === 2) i += 4; // message signé : préfixe de l'auteur
      const m = { genre: 'direct', prefixe, sauts: lgChemin === 0xff ? null : lgChemin & 0x3f, type, horodatage, snr, texte: texte(t.subarray(i)) };
      const ct = [...contacts.values()].find((c) => c.cle.startsWith(prefixe));
      if (ct) { m.de = ct.cle; m.nom = ct.nom; }
      // Réponse à une commande CLI d'administration ?
      if (type === 1 && servirAttentes(Buffer.concat([Buffer.from([0xf1]), Buffer.from(prefixe, 'hex'), Buffer.from(m.texte, 'utf8')]))) return;
      if (surMessage) surMessage(m);
    } else {
      const index = t[i++], lgChemin = t[i++]; i++; const horodatage = t.readUInt32LE(i); i += 4;
      const c = canaux.find((x) => x.index === index);
      // Les messages de canal sont déjà décodés depuis les paquets bruts : on ne les garde que si le canal est inconnu du serveur
      if (surMessage) surMessage({ genre: 'canal', index, canal: c ? c.nom : '#' + index, sauts: lgChemin === 0xff ? null : lgChemin & 0x3f, horodatage, snr, texte: texte(t.subarray(i)), dejaDecode: true });
    }
  }

  function traiterSelfInfo(t) {
    if (t.length < 58) return;
    const cle = t.subarray(4, 36).toString('hex').toUpperCase();
    const lat = t.readInt32LE(36) / 1e6, lon = t.readInt32LE(40) / 1e6;
    const freq = t.readUInt32LE(48) / 1000, bw = t.readUInt32LE(52) / 1000, sf = t[56], cr = t[57];
    etat = { ...etat, cle, nom: texte(t.subarray(58)), txPuissance: t[2], txMax: t[3], lat: Math.abs(lat) > 0.0001 ? lat : null, lon: Math.abs(lon) > 0.0001 ? lon : null, radio: { freq, bw, sf, cr } };
    journal(`companion « ${etat.nom} » ${cle.slice(0, 8)}… · ${freq} MHz BW ${bw} kHz SF${sf} CR${cr}`);
    if (!memo.connus.some((x) => x.cle === cle)) { memo.connus.push({ cle, nom: etat.nom }); sauver(); }
    notifier();
  }
  function traiterDeviceInfo(t) {
    if (t.length < 80) return;
    etat = { ...etat, firmwareCode: t[1], canauxMax: t[3] || 8, dateFirmware: texte(t.subarray(8, 20)), modele: texte(t.subarray(20, 60)), firmware: texte(t.subarray(60, 80)) };
    notifier();
  }

  function attacher(f, description, delaiPret) {
    toutAnnuler('nouvelle liaison');
    const gen = generation;
    flux = f;
    tampon = Buffer.alloc(0);
    etat.pret = false; etat.octetsRecus = 0;
    if (f.setNoDelay) f.setNoDelay(true);
    if (f.setKeepAlive) f.setKeepAlive(true, 30000);
    if (f.setTimeout) f.setTimeout(10 * 60000);
    const pret = () => {
      if (gen !== generation) return;
      etat = { ...etat, connecte: true, depuis: Date.now(), erreur: null };
      journal(`companion relié (${description}), lecture des informations`);
      clearInterval(minuterieVie);
      // Interrogation régulière de la batterie : garde la liaison vivante et donne la tension
      minuterieVie = setInterval(() => { commande([CMD.GET_BATT], [RESP.BATT], 5000).then((b) => { etat.batterieMv = b.readUInt16LE(1); }).catch(() => {}); }, 60000);
      initialiser(gen).then(() => commande([CMD.GET_BATT], [RESP.BATT], 5000)).then((b) => { if (b) etat.batterieMv = b.readUInt16LE(1); }).catch(() => {});
      notifier();
    };
    f.on('data', recevoir);
    f.on('timeout', () => { journal('aucune donnée du companion depuis 10 min, reconnexion'); f.destroy(); });
    f.on('error', (e) => { etat.erreur = e.code || e.message; });
    f.on('close', () => {
      clearInterval(minuterieVie);
      if (flux !== f) return;
      flux = null;
      toutAnnuler('liaison avec le companion fermée');
      const etaitConnecte = etat.connecte;
      etat = { ...etat, connecte: false, depuis: null, pret: false };
      if (navigateur && navigateur.flux === f) {
        navigateur = null;
        journal('companion du navigateur débranché');
        if (!arret && memo.cible) planifier(2000);
      } else if (!arret) {
        const attente = etaitConnecte ? 10000 : 30000;
        journal(`liaison avec le companion fermée${etat.erreur ? ' (' + etat.erreur + ')' : ''}, nouvel essai dans ${attente / 1000} s`);
        planifier(attente);
      }
      notifier();
    });
    if (delaiPret === 'connect') f.on('connect', pret); else setTimeout(pret, delaiPret);
  }

  function connecter() {
    clearTimeout(minuterie);
    if (navigateur) return; // le navigateur a la main
    if (arret || !memo.cible || (flux && !flux.destroyed)) return;
    const c = memo.cible;
    if (c.type === 'agent') {
      const s = agents && agents.prendre(c.hote);
      if (!s) { etat = { ...etat, connecte: false, erreur: 'agent hors ligne : lancez l’agent sur le PC du companion' }; planifier(60000); notifier(); return; }
      attacher(s, `agent ${c.hote}`, 3500); // le companion peut redémarrer à l'ouverture du port USB
      s.resume();
      return;
    }
    if (c.type === 'serie') {
      // Companion branché en USB sur la machine de la carte
      let f;
      try { f = require('../serie').ouvrirSerie(c.chemin); } catch (e) { etat = { ...etat, connecte: false, erreur: e.message }; journal(e.message); planifier(30000); notifier(); return; }
      journal(`companion sur le port série du serveur ${c.chemin}`);
      attacher(f, `USB du serveur ${c.chemin}`, 2500);
      return;
    }
    journal(`connexion au companion ${c.hote}:${c.port}…`);
    attacher(net.connect({ host: c.hote, port: c.port }), `Wi-Fi ${c.hote}:${c.port}`, 'connect');
  }

  function recevoir(morceau) {
    etat.octetsRecus = (etat.octetsRecus || 0) + morceau.length;
    tampon = Buffer.concat([tampon, morceau]);
    for (;;) {
      const i = tampon.indexOf(0x3e);
      if (i < 0) { tampon = Buffer.alloc(0); return; }
      if (i > 0) tampon = tampon.subarray(i);
      if (tampon.length < 3) return;
      const lg = tampon.readUInt16LE(1);
      if (lg === 0 || lg > 300) { tampon = tampon.subarray(1); continue; }
      if (tampon.length < 3 + lg) return;
      const trame = Buffer.from(tampon.subarray(3, 3 + lg));
      tampon = tampon.subarray(3 + lg);
      try { traiter(trame); } catch (e) { journal('trame illisible :', e.message); }
    }
  }

  function traiter(t) {
    const code = t[0];
    if (code === PUSH.LOG_RX && t.length > 3) {
      etat.paquets++;
      const snr = (t[1] > 127 ? t[1] - 256 : t[1]) / 4, rssi = t[2] > 127 ? t[2] - 256 : t[2];
      if (surObservation) surObservation({ brut: t.subarray(3), snr, rssi, observateur: etat.cle, heure: Date.now(), via: 'companion' });
      return;
    }
    if (code === RESP.CONTACT && contactsEnCours) {
      if (t.length < 148) return;
      contactsEnCours.push(lireTrameContact(t));
      return;
    }
    if (code === RESP.CONTACTS_START) { contactsEnCours = []; return; }
    if (code === RESP.END_CONTACTS && contactsEnCours) {
      contacts = new Map(contactsEnCours.map((c) => [c.cle, c]));
      etat.contacts = contactsEnCours.length;
      journal(`${contactsEnCours.length} contact(s) lu(s) dans le companion`);
      if (surContacts) surContacts(contactsEnCours);
      contactsEnCours = null;
      notifier();
    }
    if (terminer(t)) return;
    switch (code) {
      case PUSH.MSG_WAITING: setImmediate(vider); break;
      case PUSH.SEND_CONFIRMED:
        if (t.length >= 9 && surConfirmation) surConfirmation({ ack: t.readUInt32LE(1), allerRetourMs: t.readUInt32LE(5) });
        break;
      case PUSH.LOGIN_OK: case PUSH.LOGIN_FAIL: case PUSH.STATUS: case PUSH.CHEMIN: case PUSH.TRACE: case PUSH.TELEMETRIE: case PUSH.BINAIRE:
        servirAttentes(t);
        break;
      case PUSH.CONTROLE: for (const f of collecteurs) { try { f(t); } catch { /* ignoré */ } } break;
      case RESP.SELF_INFO: traiterSelfInfo(t); break;
      default: break;
    }
  }

  function fermer() {
    clearInterval(minuterieVie);
    const f = flux; flux = null;
    navigateur = null;
    etat = { ...etat, connecte: false, depuis: null, pret: false };
    toutAnnuler('companion débranché');
    if (f && !f.destroyed) f.destroy();
  }

  const exigerPret = () => {
    if (!flux || !etat.connecte) throw new Error('aucun companion relié à la carte');
    if (!etat.pret) throw new Error('companion relié mais muet : il ne répond pas encore (firmware « companion », démarrage en cours ?)');
  };
  const cleOctets = (cle) => { if (!/^[0-9A-F]{64}$/i.test(cle)) throw new Error('clé publique invalide'); return Buffer.from(cle, 'hex'); };

  // Trame contact : clé(32) type drapeaux longueur_chemin chemin(64) nom(32) annonce(4) lat lon modif(4)
  // Longueur du chemin : 0xFF = inconnu (envoi en inondation) ; sinon 2 bits de taille d'identifiant (1 à 3 octets)
  // et 6 bits de nombre de relais, comme dans les paquets
  function lireTrameContact(t) {
    const lat = t.readInt32LE(136) / 1e6, lon = t.readInt32LE(140) / 1e6, lc = t[35];
    let chemin = null, tailleSaut = 1;
    if (lc !== 0xff) {
      tailleSaut = (lc >> 6) + 1;
      const nb = lc & 0x3f, o = t.subarray(36, 36 + Math.min(64, nb * tailleSaut));
      chemin = [];
      for (let i = 0; i + tailleSaut <= o.length; i += tailleSaut) chemin.push(o.subarray(i, i + tailleSaut).toString('hex').toUpperCase());
    }
    return {
      cle: t.subarray(1, 33).toString('hex').toUpperCase(), role: ROLES[t[33]] || 'inconnu', type: t[33], drapeaux: t[34], longueurChemin: lc, chemin, tailleSaut,
      nom: texte(t.subarray(100, 132)), horodatage: t.readUInt32LE(132), lat: Math.abs(lat) > 0.0001 ? lat : null, lon: Math.abs(lon) > 0.0001 ? lon : null,
      latBrut: t.readInt32LE(136), lonBrut: t.readInt32LE(140), vu: t.readUInt32LE(144) * 1000 || null,
    };
  }

  // Ajoute (ou met à jour) un nœud dans les contacts du companion : nécessaire pour lui écrire ou l'administrer
  async function assurerContact(n) {
    if (contacts.has(n.cle)) return;
    const b = Buffer.alloc(1 + 32 + 3 + 64 + 32 + 4 + 8);
    b[0] = CMD.ADD_UPDATE_CONTACT;
    cleOctets(n.cle).copy(b, 1);
    b[33] = TYPES_ROLE[n.role] || 0;
    b[34] = 0;
    b[35] = 0xff; // chemin inconnu : envoi en inondation, le companion apprendra le chemin au retour
    b.write(String(n.nom || n.cle.slice(0, 8)).slice(0, 31), 100, 'utf8');
    b.writeUInt32LE(n.horodatageAnnonce || 0, 132);
    b.writeInt32LE(Math.round((n.lat || 0) * 1e6), 136);
    b.writeInt32LE(Math.round((n.lon || 0) * 1e6), 140);
    await commande(b, [RESP.OK], 5000);
    contacts.set(n.cle, { cle: n.cle, nom: n.nom, role: n.role });
    journal(`« ${n.nom || n.cle.slice(0, 8)} » ajouté aux contacts du companion`);
  }

  return {
    etat: () => ({ ...etat, cible: memo.cible, navigateur: !!navigateur, nomNavigateur: navigateur ? navigateur.nom : null }),
    canaux: () => canaux.map((c) => ({ index: c.index, nom: c.nom })),
    secretsCanaux: () => canaux.map((c) => ({ nom: c.nom, secret: c.secret })),
    contacts: () => [...contacts.values()],
    connecterA(cible) {
      memo.cible = cible; sauver();
      arret = false;
      etat = { ...etat, erreur: null, paquets: 0 };
      if (navigateur) return;
      fermer();
      setTimeout(connecter, 300);
    },
    deconnecter() {
      arret = true; memo.cible = null; sauver();
      clearTimeout(minuterie);
      fermer();
      etat = { ...etat, connecte: false, erreur: null };
      notifier();
    },
    reconnecter() { arret = false; fermer(); planifier(500); },
    // Relit les informations du companion sans couper la liaison (companion relié mais resté muet)
    relancer() { if (!flux) throw new Error('aucun companion relié à la carte'); etat.pret = false; initialiser(generation); },
    // Companion relié par la page (USB ou Bluetooth) : il remplace la liaison habituelle tant que la page est ouverte
    brancherNavigateur(f, nom, source) {
      fermer();
      clearTimeout(minuterie);
      navigateur = { nom, source, flux: f };
      etat = { ...etat, paquets: 0, erreur: null };
      attacher(f, `navigateur ${source}`, source === 'USB' ? 2500 : 200);
    },
    agentDisponible(hote) {
      if (!navigateur && !arret && memo.cible && memo.cible.type === 'agent' && memo.cible.hote === hote && (!flux || flux.destroyed)) planifier(500);
    },
    // ---- Chemin d'un contact : lire, réinitialiser (retour à l'inondation), forcer à la main ----
    async contact(cle) {
      exigerPret();
      const t = await commande(Buffer.concat([Buffer.from([CMD.GET_CONTACT_BY_KEY]), cleOctets(cle)]), [RESP.CONTACT], 5000)
        .catch((e) => { if (e.code === 2) return null; throw e; }); // 2 : contact inconnu
      if (!t || t.length < 148) return null;
      const c = lireTrameContact(t);
      contacts.set(c.cle, { ...(contacts.get(c.cle) || {}), ...c });
      return c;
    },
    async reinitialiserChemin(cle) {
      exigerPret();
      await commande(Buffer.concat([Buffer.from([CMD.RESET_PATH]), cleOctets(cle)]), [RESP.OK], 5000);
      const c = contacts.get(cle); if (c) { c.longueurChemin = 0xff; c.chemin = null; }
      journal(`chemin vers ${cle.slice(0, 8)} réinitialisé (prochain envoi en inondation)`);
    },
    // sauts : identifiants hexadécimaux des relais, du premier au dernier (tous de la même taille : 1, 2 ou 3 octets)
    async forcerChemin(cle, sauts) {
      exigerPret();
      const c = await this.contact(cle);
      if (!c) throw new Error('ce nœud n’est pas dans les contacts du companion : écrivez-lui ou administrez-le d’abord');
      const l = (sauts || []).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
      const taille = l.length ? l[0].length / 2 : 1;
      if (l.some((x) => !/^[0-9A-F]+$/.test(x) || x.length !== taille * 2) || ![1, 2, 3].includes(taille)) throw new Error('chemin : identifiants hexadécimaux de même taille (2, 4 ou 6 caractères), ex. A3,7F');
      if (l.length > Math.floor(64 / taille) || l.length > 63) throw new Error('chemin trop long');
      const b = Buffer.alloc(1 + 32 + 3 + 64 + 32 + 4 + 8);
      b[0] = CMD.ADD_UPDATE_CONTACT; cleOctets(cle).copy(b, 1);
      b[33] = c.type; b[34] = c.drapeaux;
      b[35] = ((taille - 1) << 6) | l.length;
      Buffer.from(l.join(''), 'hex').copy(b, 36);
      b.write(String(c.nom || cle.slice(0, 8)).slice(0, 31), 100, 'utf8');
      b.writeUInt32LE(c.horodatage || 0, 132);
      b.writeInt32LE(c.latBrut || 0, 136); b.writeInt32LE(c.lonBrut || 0, 140);
      await commande(b, [RESP.OK], 5000);
      contacts.set(cle, { ...c, longueurChemin: b[35], chemin: l, tailleSaut: taille });
      journal(`chemin vers ${c.nom || cle.slice(0, 8)} forcé : ${l.length ? l.join(' → ') : 'direct (0 saut)'}`);
      return { chemin: l, tailleSaut: taille };
    },
    async supprimerContact(cle) {
      exigerPret();
      await commande(Buffer.concat([Buffer.from([CMD.REMOVE_CONTACT]), cleOctets(cle)]), [RESP.OK], 5000).catch((e) => { if (e.code !== 1 && e.code !== 2) throw e; });
      contacts.delete(cle);
    },
    async annoncer(inondation) { exigerPret(); await commande([CMD.SEND_SELF_ADVERT, inondation ? 1 : 0], [RESP.OK], 5000); },
    async rechargerContacts() { exigerPret(); await lireContacts(); await lireCanaux(); },

    // ---- Messages ----
    async envoyerCanal(index, txt) {
      exigerPret();
      const corps = Buffer.from(String(txt), 'utf8');
      if (!corps.length || corps.length > 140) throw new Error('message de 1 à 140 octets');
      const b = Buffer.alloc(7); b[0] = CMD.SEND_CHANNEL_TXT_MSG; b[1] = 0; b[2] = index; b.writeUInt32LE(Math.floor(Date.now() / 1000), 3);
      await commande(Buffer.concat([b, corps]), [RESP.OK], 6000);
    },
    async envoyerDirect(noeud, txt) {
      exigerPret();
      const corps = Buffer.from(String(txt), 'utf8');
      if (!corps.length || corps.length > 140) throw new Error('message de 1 à 140 octets');
      await assurerContact(noeud);
      const b = Buffer.alloc(13); b[0] = CMD.SEND_TXT_MSG; b[1] = 0; b[2] = 0; b.writeUInt32LE(Math.floor(Date.now() / 1000), 3);
      cleOctets(noeud.cle).copy(b, 7, 0, 6);
      const r = await commande(Buffer.concat([b, corps]), [RESP.SENT], 6000);
      return { inondation: r[1] === 1, ack: r.readUInt32LE(2), delaiMs: r.readUInt32LE(6) };
    },

    // ---- Administration d'un répéteur / room server ----
    async connexion(noeud, motDePasse) {
      exigerPret();
      await assurerContact(noeud);
      const prefixe = noeud.cle.slice(0, 12);
      const attente = attendre((t) => (t[0] === PUSH.LOGIN_OK || t[0] === PUSH.LOGIN_FAIL) && t.subarray(2, 8).toString('hex').toUpperCase() === prefixe, 45000);
      attente.catch(() => {});
      const r = await commande(Buffer.concat([Buffer.from([CMD.SEND_LOGIN]), cleOctets(noeud.cle), Buffer.from(String(motDePasse || ''), 'utf8')]), [RESP.SENT], 6000);
      const t = await attente;
      if (t[0] === PUSH.LOGIN_FAIL) throw new Error('mot de passe refusé par le nœud');
      return { admin: (t[1] & 1) === 1, permissions: t.length > 12 ? t[12] : null, versionFirmware: t.length > 13 ? t[13] : null, inondation: r[1] === 1 };
    },
    async deconnexion(noeud) { exigerPret(); await commande(Buffer.concat([Buffer.from([CMD.LOGOUT]), cleOctets(noeud.cle)]), [RESP.OK], 5000).catch(() => {}); },
    // Commande CLI à distance (il faut être connecté en admin) ; la réponse revient comme un message « CLI »
    async cli(noeud, ligne, delai = 40000) {
      exigerPret();
      await assurerContact(noeud);
      const corps = Buffer.from(String(ligne), 'utf8');
      if (!corps.length || corps.length > 140) throw new Error('commande de 1 à 140 octets');
      const prefixe = Buffer.from(noeud.cle.slice(0, 12), 'hex');
      const attente = attendre((t) => t[0] === 0xf1 && t.subarray(1, 7).equals(prefixe), delai);
      attente.catch(() => {});
      const b = Buffer.alloc(13); b[0] = CMD.SEND_TXT_MSG; b[1] = 1; b[2] = 0; b.writeUInt32LE(Math.floor(Date.now() / 1000), 3);
      prefixe.copy(b, 7);
      await commande(Buffer.concat([b, corps]), [RESP.SENT], 6000);
      const t = await attente;
      return t.subarray(7).toString('utf8').replace(/\0.*$/s, '').trim();
    },
    // État (statistiques) d'un répéteur : batterie, file, bruit, compteurs, temps d'émission
    async statut(noeud) {
      exigerPret();
      await assurerContact(noeud);
      const prefixe = noeud.cle.slice(0, 12);
      const attente = attendre((t) => t[0] === PUSH.STATUS && t.subarray(2, 8).toString('hex').toUpperCase() === prefixe, 45000);
      attente.catch(() => {});
      await commande(Buffer.concat([Buffer.from([CMD.SEND_STATUS_REQ]), cleOctets(noeud.cle)]), [RESP.SENT], 6000);
      const t = await attente;
      const d = t.subarray(8);
      if (d.length < 52) return { brut: d.toString('hex') };
      const s = {
        batterieMv: d.readUInt16LE(0), fileEmission: d.readUInt16LE(2), bruitDbm: d.readInt16LE(4), dernierRssi: d.readInt16LE(6),
        recus: d.readUInt32LE(8), emis: d.readUInt32LE(12), tempsEmissionS: d.readUInt32LE(16), allumeS: d.readUInt32LE(20),
        emisInondation: d.readUInt32LE(24), emisDirect: d.readUInt32LE(28), recusInondation: d.readUInt32LE(32), recusDirect: d.readUInt32LE(36),
        erreurs: d.readUInt16LE(40), dernierSnr: d.readInt16LE(42) / 4, doublonsDirect: d.readUInt16LE(44), doublonsInondation: d.readUInt16LE(46),
        tempsReceptionS: d.readUInt32LE(48), erreursReception: d.length >= 56 ? d.readUInt32LE(52) : null,
      };
      s.occupationEmissionPct = s.allumeS ? Math.round((s.tempsEmissionS / s.allumeS) * 1000) / 10 : null;
      return s;
    },
    // Découverte du chemin (aller et retour) vers un nœud : requête en inondation, réponse avec les deux chemins
    async decouvrirChemin(noeud) {
      exigerPret();
      await assurerContact(noeud);
      const prefixe = noeud.cle.slice(0, 12);
      const debut = Date.now();
      const attente = attendre((t) => t[0] === 0x8d && t.subarray(2, 8).toString('hex').toUpperCase() === prefixe, 60000);
      attente.catch(() => {});
      await commande(Buffer.concat([Buffer.from([52, 0]), cleOctets(noeud.cle)]), [RESP.SENT], 6000);
      const t = await attente;
      const lireChemin = (i) => {
        const lg = t[i], n = lg & 0x3f, taille = (lg >> 6) + 1;
        const h = [];
        for (let k = 0; k < n; k++) h.push(t.subarray(i + 1 + k * taille, i + 1 + (k + 1) * taille).toString('hex').toUpperCase());
        return { chemin: h, fin: i + 1 + n * taille };
      };
      const aller = lireChemin(8), retour = lireChemin(aller.fin);
      return { aller: aller.chemin, retour: retour.chemin, dureeMs: Date.now() - debut };
    },
    // ---- Découverte des répéteurs en direct (0 saut, sans mot de passe) ----
    // Chaque répéteur qui entend l'appel répond avec le SNR auquel il l'a reçu ; le companion mesure le SNR de la réponse.
    // ---- Régions déclarées par un répéteur entendu en direct (requête anonyme, sans mot de passe) ----
    // Le répéteur n'y répond qu'en direct : on fixe le chemin du contact à « voisin direct » (0 saut) avant la demande.
    // Réponse : horloge du répéteur puis noms séparés par des virgules ; « * » = accepte aussi les messages sans région.
    async regionsDeclarees(noeud, delai = 20000) {
      exigerPret();
      const cle = cleOctets(noeud.cle);
      const b = Buffer.alloc(1 + 32 + 3 + 64 + 32 + 4 + 8);
      b[0] = CMD.ADD_UPDATE_CONTACT; cle.copy(b, 1);
      b[33] = TYPES_ROLE[noeud.role] || 2; b[34] = 0; b[35] = 0; // chemin : 0 saut
      b.write(String(noeud.nom || noeud.cle.slice(0, 8)).slice(0, 31), 100, 'utf8');
      b.writeUInt32LE(noeud.horodatageAnnonce || 0, 132);
      b.writeInt32LE(Math.round((noeud.lat || 0) * 1e6), 136); b.writeInt32LE(Math.round((noeud.lon || 0) * 1e6), 140);
      await commande(b, [RESP.OK], 5000);
      contacts.set(noeud.cle, { ...(contacts.get(noeud.cle) || {}), cle: noeud.cle, nom: noeud.nom, role: noeud.role, longueurChemin: 0 });
      const r = await commande(Buffer.concat([Buffer.from([CMD2.ANON]), cle, Buffer.from([0x01, 0x00])]), [RESP.SENT], 6000)
        .catch((e) => { if (e.code === 1) throw new Error('requête anonyme non gérée par ce firmware de companion'); throw e; });
      const tag = r.readUInt32LE(2);
      const t = await attendre((x) => x[0] === PUSH.BINAIRE && x.length >= 6 && x.readUInt32LE(2) === tag, delai);
      const d = t.subarray(6);
      const horloge = d.length >= 4 ? d.readUInt32LE(0) : null;
      const noms = texte(d.subarray(4)).split(',').map((x) => x.trim()).filter(Boolean);
      return { joker: noms.includes('*'), regions: noms.filter((x) => x !== '*'), horlogeRepeteur: horloge };
    },
    async decouvrirVoisins(dureeMs = 15000) {
      exigerPret();
      const tag = crypto.randomBytes(4).readUInt32LE(0) >>> 0;
      const trouves = new Map();
      const f = (t) => {
        if (t.length < 4 + 14) return;
        const p = t.subarray(4);
        if ((p[0] & 0xf0) !== 0x90 || p.readUInt32LE(2) !== tag) return;
        const type = p[0] & 0x0f;
        const cle = p.subarray(6).toString('hex').toUpperCase();
        trouves.set(cle, { cle, complete: cle.length === 64, role: ROLES[type] || 'inconnu', snrAller: int8(p[1]) / 4, snrRetour: int8(t[1]) / 4, rssi: int8(t[2]), heure: Date.now() });
      };
      collecteurs.add(f);
      try {
        const b = Buffer.alloc(11);
        b[0] = CMD2.CONTROLE; b[1] = 0x80; b[2] = (1 << 2) | (1 << 3) | (1 << 4); // répéteurs, room servers, capteurs
        b.writeUInt32LE(tag, 3); b.writeUInt32LE(0, 7);
        await commande(b, [RESP.OK], 5000);
        await new Promise((r) => setTimeout(r, dureeMs));
      } finally { collecteurs.delete(f); }
      return [...trouves.values()].sort((a, b) => b.snrRetour - a.snrRetour);
    },
    // ---- Trace : aller-retour le long d'un chemin, avec le SNR mesuré à chaque saut ----
    // `chemin` : hachages hex (même taille) des nœuds traversés dans l'ordre, cible comprise, retour compris.
    async tracer(chemin, delai = 30000) {
      exigerPret();
      if (!chemin.length) throw new Error('chemin vide');
      const taille = chemin[0].length / 2;
      const drapeaux = { 1: 0, 2: 1, 4: 2, 8: 3 }[taille];
      if (drapeaux == null || chemin.some((h) => h.length !== taille * 2)) throw new Error('chemin invalide');
      const tag = crypto.randomBytes(4).readUInt32LE(0) >>> 0;
      const attente = attendre((t) => t[0] === PUSH.TRACE && t.length >= 12 && t.readUInt32LE(4) === tag, delai);
      attente.catch(() => {});
      const b = Buffer.alloc(10); b[0] = CMD2.TRACE; b.writeUInt32LE(tag, 1); b.writeUInt32LE(0, 5); b[9] = drapeaux;
      const debut = Date.now();
      await commande(Buffer.concat([b, Buffer.from(chemin.join(''), 'hex')]), [RESP.SENT], 6000);
      const t = await attente;
      const lg = t[2], sz = 1 << (t[3] & 3), n = lg / sz;
      const hachages = [], snrs = [];
      for (let k = 0; k < n; k++) hachages.push(t.subarray(12 + k * sz, 12 + (k + 1) * sz).toString('hex').toUpperCase());
      for (let k = 0; k < n; k++) snrs.push(int8(t[12 + lg + k]) / 4);
      return { hachages, snrs, final: int8(t[12 + lg + n]) / 4, dureeMs: Date.now() - debut };
    },
    // ---- Statistiques du companion : bruit radio, temps d'antenne, compteurs ----
    async statistiques() {
      exigerPret();
      const r = {};
      try { const t = await commande([CMD2.STATS, 0], [RESP.STATS], 4000); r.batterieMv = t.readUInt16LE(2); r.allumeS = t.readUInt32LE(4); r.erreurs = t.readUInt16LE(8); r.file = t[10]; } catch (e) { if (e.code === 1) throw new Error('statistiques non gérées par ce firmware (companion v1.10 ou plus requis)'); throw e; }
      try { const t = await commande([CMD2.STATS, 1], [RESP.STATS], 4000); r.bruitDbm = t.readInt16LE(2); r.dernierRssi = int8(t[4]); r.dernierSnr = int8(t[5]) / 4; r.emissionS = t.readUInt32LE(6); r.receptionS = t.readUInt32LE(10); } catch { /* ignoré */ }
      try {
        const t = await commande([CMD2.STATS, 2], [RESP.STATS], 4000);
        Object.assign(r, { recus: t.readUInt32LE(2), emis: t.readUInt32LE(6), emisInondation: t.readUInt32LE(10), emisDirect: t.readUInt32LE(14), recusInondation: t.readUInt32LE(18), recusDirect: t.readUInt32LE(22), erreursReception: t.length >= 30 ? t.readUInt32LE(26) : null });
      } catch { /* ignoré */ }
      if (r.allumeS && r.emissionS != null) r.occupationEmissionPct = Math.round((r.emissionS / r.allumeS) * 1000) / 10;
      if (r.allumeS && r.receptionS != null) r.occupationReceptionPct = Math.round((r.receptionS / r.allumeS) * 1000) / 10;
      etat.stats = { ...r, heure: Date.now() };
      return r;
    },
    // ---- Télémétrie (capteurs) : du companion lui-même (noeud absent) ou d'un nœud distant ----
    async telemetrie(noeud, delai = 40000) {
      exigerPret();
      if (!noeud) {
        const attente = attendre((t) => t[0] === PUSH.TELEMETRIE && t.length >= 8 && t.subarray(2, 8).toString('hex').toUpperCase() === String(etat.cle || '').slice(0, 12), 6000);
        attente.catch(() => {});
        ecrire(Buffer.from([CMD2.TELEMETRIE, 0, 0, 0]));
        return lireLpp((await attente).subarray(8));
      }
      await assurerContact(noeud);
      const prefixe = noeud.cle.slice(0, 12);
      const attente = attendre((t) => t[0] === PUSH.TELEMETRIE && t.length >= 8 && t.subarray(2, 8).toString('hex').toUpperCase() === prefixe, delai);
      attente.catch(() => {});
      await commande(Buffer.concat([Buffer.from([CMD2.TELEMETRIE, 0, 0, 0]), cleOctets(noeud.cle)]), [RESP.SENT], 6000);
      return lireLpp((await attente).subarray(8));
    },
    // ---- Région (zone d'inondation) par défaut du companion : ses envois en inondation ne sortent pas de la région ----
    async lireZone() {
      exigerPret();
      const t = await commande([CMD2.ZONE_DEFAUT_GET], [RESP.ZONE_DEFAUT], 4000);
      const z = t.length >= 48 ? texte(t.subarray(1, 32)) || null : null;
      etat.zoneDefaut = z ? z.replace(/^#/, '') : '';
      return z;
    },
    async definirZone(nom) {
      exigerPret();
      nom = String(nom || '').trim();
      if (!nom) { await commande([CMD2.ZONE_DEFAUT_SET], [RESP.OK], 4000); etat.zoneDefaut = ''; return null; }
      if (!nom.startsWith('#')) nom = '#' + nom;
      if (Buffer.byteLength(nom) > 30 || !/^#[\p{L}\p{N}_.-]+$/u.test(nom)) throw new Error('nom de région invalide (lettres, chiffres, - _ ., 30 caractères au plus)');
      const b = Buffer.alloc(1 + 31 + 16);
      b[0] = CMD2.ZONE_DEFAUT_SET; b.write(nom, 1, 'utf8');
      crypto.createHash('sha256').update(nom, 'utf8').digest().copy(b, 32, 0, 16);
      await commande(b, [RESP.OK], 4000);
      etat.zoneDefaut = nom.replace(/^#/, '');
      return nom;
    },
    // ---- Commande CLI sur le companion lui-même (firmware v1.14+ du companion : nom, Wi-Fi, version…) ----
    async cliLocal(ligne) {
      exigerPret();
      const corps = Buffer.from(String(ligne || '').trim(), 'utf8');
      if (corps.length < 2 || corps.length > 160) throw new Error('commande de 2 à 160 octets');
      try {
        const t = await commande(Buffer.concat([Buffer.from([CMD2.CLI]), corps]), [RESP.REPONSE_CLI], 6000);
        return texte(t.subarray(1));
      } catch (e) { if (e.code === 1) throw new Error('commandes sur le companion non gérées par ce firmware (companion v1.14 ou plus requis)'); throw e; }
    },
    demarrer() { if (!arret) planifier(1500); },
    estEcoute: !!ecoute,
    detruire() { arret = true; clearTimeout(minuterie); fermer(); etat = { ...etat, connecte: false }; notifier(); },
  };
}

module.exports = { creerCompanion, lireLpp };
