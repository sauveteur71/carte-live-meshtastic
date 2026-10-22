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
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROLES } = require('./paquet');

const CMD = {
  APP_START: 1, SEND_TXT_MSG: 2, SEND_CHANNEL_TXT_MSG: 3, GET_CONTACTS: 4, SET_DEVICE_TIME: 6, SEND_SELF_ADVERT: 7,
  ADD_UPDATE_CONTACT: 9, SYNC_NEXT_MESSAGE: 10, GET_BATT: 20, DEVICE_QUERY: 22, SEND_LOGIN: 26, SEND_STATUS_REQ: 27,
  LOGOUT: 29, GET_CHANNEL: 31, GET_CONTACT_BY_KEY: 30,
};
const RESP = {
  OK: 0, ERR: 1, CONTACTS_START: 2, CONTACT: 3, END_CONTACTS: 4, SELF_INFO: 5, SENT: 6, CONTACT_MSG: 7, CHANNEL_MSG: 8,
  NO_MORE: 10, BATT: 12, DEVICE_INFO: 13, CONTACT_MSG_V3: 16, CHANNEL_MSG_V3: 17, CHANNEL_INFO: 18,
};
const PUSH = { ADVERT: 0x80, PATH_UPDATED: 0x81, SEND_CONFIRMED: 0x82, MSG_WAITING: 0x83, LOGIN_OK: 0x85, LOGIN_FAIL: 0x86, STATUS: 0x87, LOG_RX: 0x88, NEW_ADVERT: 0x8a };
const ERREURS = { 1: 'commande non gérée par ce firmware', 2: 'introuvable (contact ou canal inconnu du companion)', 3: 'table pleine (contacts ou envois en attente)', 4: 'companion occupé', 5: 'erreur de stockage', 6: 'paramètre refusé' };
const TYPES_ROLE = { companion: 1, repeteur: 2, salon: 3, capteur: 4 };
const NOM_APPLI = 'carte-live';

function creerCompanion(config, { agents, surObservation, surContacts, surEtat, surMessage, surConfirmation, surCanaux, journal }) {
  const fMemo = path.join(path.dirname(config.fichierBase), 'meshcore-companion.json');
  let memo = { cible: null, connus: [] };
  try { memo = { ...memo, ...JSON.parse(fs.readFileSync(fMemo, 'utf8')) }; } catch { /* premier lancement */ }
  const sauver = () => { try { fs.writeFileSync(fMemo, JSON.stringify(memo, null, 1)); } catch (e) { journal('sauvegarde impossible :', e.message); } };

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
    return new Promise((ok, ko) => {
      file.push({ octets: Buffer.from(octets), codes: new Set(codes), delai, ok, ko, gen: generation });
      pomper();
    });
  }
  function pomper() {
    if (enVol || !file.length) return;
    const c = file.shift();
    if (c.gen !== generation || !flux) { c.ko(new Error('companion non relié')); return pomper(); }
    enVol = c;
    c.minuterie = setTimeout(() => { if (enVol === c) { enVol = null; c.ko(new Error('pas de réponse du companion')); pomper(); } }, c.delai);
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

  async function initialiser(gen) {
    try {
      const b = Buffer.alloc(8 + NOM_APPLI.length);
      b[0] = CMD.APP_START; b[1] = 3; b.write(NOM_APPLI, 8, 'utf8');
      traiterSelfInfo(await commande(b, [RESP.SELF_INFO], 6000));
      try { traiterDeviceInfo(await commande([CMD.DEVICE_QUERY, 3], [RESP.DEVICE_INFO], 5000)); } catch { /* ancien firmware */ }
      // Horloge : le companion s'en sert pour dater ses envois (les répéteurs refusent les horodatages qui reculent)
      const h = Buffer.alloc(5); h[0] = CMD.SET_DEVICE_TIME; h.writeUInt32LE(Math.floor(Date.now() / 1000), 1);
      await commande(h, [RESP.OK], 4000).catch(() => {});
      await lireContacts().catch((e) => journal('contacts non lus :', e.message));
      await lireCanaux().catch((e) => journal('canaux non lus :', e.message));
      if (gen !== generation) return;
      etat.pret = true;
      notifier();
      vider();
    } catch (e) {
      if (gen === generation) { journal('initialisation du companion impossible :', e.message); etat.erreur = e.message; notifier(); }
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
    etat.pret = false;
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
    journal(`connexion au companion ${c.hote}:${c.port}…`);
    attacher(net.connect({ host: c.hote, port: c.port }), `Wi-Fi ${c.hote}:${c.port}`, 'connect');
  }

  function recevoir(morceau) {
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
      const lat = t.readInt32LE(136) / 1e6, lon = t.readInt32LE(140) / 1e6;
      contactsEnCours.push({
        cle: t.subarray(1, 33).toString('hex').toUpperCase(), role: ROLES[t[33]] || 'inconnu', drapeaux: t[34], longueurChemin: t[35],
        nom: texte(t.subarray(100, 132)), horodatage: t.readUInt32LE(132), lat: Math.abs(lat) > 0.0001 ? lat : null, lon: Math.abs(lon) > 0.0001 ? lon : null,
        vu: t.readUInt32LE(144) * 1000 || null,
      });
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
      case PUSH.LOGIN_OK: case PUSH.LOGIN_FAIL: case PUSH.STATUS:
        servirAttentes(t);
        break;
      case RESP.SELF_INFO: traiterSelfInfo(t); break;
      default: break;
    }
  }

  function fermer() {
    clearInterval(minuterieVie);
    const f = flux; flux = null;
    toutAnnuler('companion débranché');
    if (f && !f.destroyed) f.destroy();
  }

  const exigerPret = () => { if (!flux || !etat.connecte) throw new Error('aucun companion relié à la carte'); };
  const cleOctets = (cle) => { if (!/^[0-9A-F]{64}$/i.test(cle)) throw new Error('clé publique invalide'); return Buffer.from(cle, 'hex'); };

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
    // Companion relié par la page (USB ou Bluetooth) : il remplace la liaison habituelle tant que la page est ouverte
    brancherNavigateur(f, nom, source) {
      fermer();
      clearTimeout(minuterie);
      navigateur = { nom, source, flux: f };
      etat = { ...etat, paquets: 0, erreur: null };
      attacher(f, `navigateur ${source}`, source === 'USB' ? 1500 : 200);
    },
    agentDisponible(hote) {
      if (!navigateur && !arret && memo.cible && memo.cible.type === 'agent' && memo.cible.hote === hote && (!flux || flux.destroyed)) planifier(500);
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
    demarrer() { if (!arret) planifier(1500); },
    _hacher: (t) => crypto.createHash('sha256').update(t).digest('hex'),
  };
}

module.exports = { creerCompanion };
