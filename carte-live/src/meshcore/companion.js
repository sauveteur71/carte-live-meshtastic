'use strict';
// Liaison avec un companion MeshCore (protocole « companion » de l'appli officielle) : la carte s'en sert
// comme observateur. Le firmware envoie, pour chaque paquet entendu, une trame PUSH_CODE_LOG_RX_DATA (0x88)
// contenant le SNR, le RSSI et le paquet brut.
//
// Transports, tous ramenés à un flux d'octets tramé comme l'USB :
//   - Wi-Fi : companion « wifi » joignable en TCP (port 5000 par défaut) ;
//   - agent : companion USB sur un PC, relayé par l'agent (port 4404) ;
//   - navigateur : companion USB ou Bluetooth branché sur le PC qui affiche la carte (WebSocket /ws/meshcore).
// Trame série : '<' (vers le companion) ou '>' (depuis le companion) + longueur (2 octets, petit-boutiste) + données.

const net = require('net');
const fs = require('fs');
const path = require('path');
const { ROLES } = require('./paquet');

const CMD = { APP_START: 1, GET_CONTACTS: 4, SEND_SELF_ADVERT: 7, DEVICE_QUERY: 22, GET_BATT: 20, GET_CHANNEL: 31 };
const RESP = { OK: 0, ERR: 1, CONTACTS_START: 2, CONTACT: 3, END_CONTACTS: 4, SELF_INFO: 5, BATT: 12, DEVICE_INFO: 13, CHANNEL_INFO: 18 };
const PUSH = { ADVERT: 0x80, PATH_UPDATED: 0x81, SEND_CONFIRMED: 0x82, MSG_WAITING: 0x83, LOG_RX: 0x88, NEW_ADVERT: 0x8a };
const NOM_APPLI = 'carte-live';

function creerCompanion(config, { agents, surObservation, surContacts, surEtat, journal }) {
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
  let etat = { connecte: false, cible: memo.cible, depuis: null, erreur: null, paquets: 0, cle: null, nom: null, radio: null, firmware: null, modele: null, batterieMv: null, lat: null, lon: null, contacts: 0, navigateur: false };

  const notifier = () => { if (surEtat) setImmediate(surEtat); };

  function ecrire(octets) {
    if (!flux || flux.destroyed) return;
    const t = Buffer.alloc(3 + octets.length);
    t[0] = 0x3c; t.writeUInt16LE(octets.length, 1); Buffer.from(octets).copy(t, 3);
    flux.write(t);
  }

  function appStart() {
    const b = Buffer.alloc(8 + NOM_APPLI.length);
    b[0] = CMD.APP_START; b[1] = 3; b.write(NOM_APPLI, 8, 'utf8');
    ecrire(b);
  }

  function planifier(ms) {
    clearTimeout(minuterie);
    minuterie = setTimeout(connecter, ms);
  }

  function attacher(f, description) {
    flux = f;
    tampon = Buffer.alloc(0);
    const ce = f;
    if (ce.setNoDelay) ce.setNoDelay(true);
    if (ce.setKeepAlive) ce.setKeepAlive(true, 30000);
    if (ce.setTimeout) ce.setTimeout(10 * 60000);
    const pret = () => {
      etat = { ...etat, connecte: true, depuis: Date.now(), erreur: null };
      journal(`companion relié (${description}), demande des informations`);
      appStart();
      setTimeout(() => ecrire([CMD.DEVICE_QUERY, 3]), 300);
      setTimeout(() => { contactsEnCours = []; ecrire([CMD.GET_CONTACTS]); }, 900);
      clearInterval(minuterieVie);
      // Interrogation régulière de la batterie : garde la liaison vivante et donne la tension
      minuterieVie = setInterval(() => ecrire([CMD.GET_BATT]), 60000);
      setTimeout(() => ecrire([CMD.GET_BATT]), 1500);
      notifier();
    };
    return { ce, pret };
  }

  function brancherEvenements(ce) {
    ce.on('data', recevoir);
    ce.on('timeout', () => { journal('aucune donnée du companion depuis 10 min, reconnexion'); ce.destroy(); });
    ce.on('error', (e) => { etat.erreur = e.code || e.message; });
    ce.on('close', () => {
      clearInterval(minuterieVie);
      if (flux !== ce) return;
      flux = null;
      const etaitConnecte = etat.connecte;
      etat = { ...etat, connecte: false, depuis: null };
      if (navigateur && navigateur.flux === ce) {
        navigateur = null; etat.navigateur = false;
        journal('companion du navigateur débranché');
        if (!arret && memo.cible) planifier(2000);
      } else if (!arret) {
        const attente = etaitConnecte ? 10000 : 30000;
        journal(`liaison avec le companion fermée${etat.erreur ? ' (' + etat.erreur + ')' : ''}, nouvel essai dans ${attente / 1000} s`);
        planifier(attente);
      }
      notifier();
    });
  }

  function connecter() {
    clearTimeout(minuterie);
    if (navigateur) return; // le navigateur a la main
    if (arret || !memo.cible || (flux && !flux.destroyed)) return;
    const c = memo.cible;
    if (c.type === 'agent') {
      const s = agents && agents.prendre(c.hote);
      if (!s) { etat = { ...etat, connecte: false, erreur: 'agent hors ligne : lancez l’agent sur le PC du companion' }; planifier(60000); notifier(); return; }
      const { ce, pret } = attacher(s, `agent ${c.hote}`);
      brancherEvenements(ce);
      ce.resume();
      setTimeout(pret, 3500); // le companion peut redémarrer à l'ouverture du port USB
      return;
    }
    journal(`connexion au companion ${c.hote}:${c.port}…`);
    const s = net.connect({ host: c.hote, port: c.port });
    const { ce, pret } = attacher(s, `Wi-Fi ${c.hote}:${c.port}`);
    ce.on('connect', pret);
    brancherEvenements(ce);
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

  const texte = (b) => b.toString('utf8').replace(/\0.*$/s, '').trim();

  function traiter(t) {
    const code = t[0];
    if (code === PUSH.LOG_RX && t.length > 3) {
      etat.paquets++;
      const snr = (t[1] > 127 ? t[1] - 256 : t[1]) / 4, rssi = t[2] > 127 ? t[2] - 256 : t[2];
      if (surObservation) surObservation({ brut: t.subarray(3), snr, rssi, observateur: etat.cle, heure: Date.now(), via: 'companion' });
      return;
    }
    switch (code) {
      case RESP.SELF_INFO: {
        if (t.length < 58) return;
        const cle = t.subarray(4, 36).toString('hex').toUpperCase();
        const lat = t.readInt32LE(36) / 1e6, lon = t.readInt32LE(40) / 1e6;
        const freq = t.readUInt32LE(48) / 1000, bw = t.readUInt32LE(52) / 1000, sf = t[56], cr = t[57];
        etat = { ...etat, cle, nom: texte(t.subarray(58)), txPuissance: t[2], txMax: t[3], lat: Math.abs(lat) > 0.0001 ? lat : null, lon: Math.abs(lon) > 0.0001 ? lon : null, radio: { freq, bw, sf, cr } };
        journal(`companion « ${etat.nom} » ${cle.slice(0, 8)}… · ${freq} MHz BW ${bw} kHz SF${sf} CR${cr}`);
        if (!memo.connus.some((x) => x.cle === cle)) { memo.connus.push({ cle, nom: etat.nom }); sauver(); }
        notifier();
        break;
      }
      case RESP.DEVICE_INFO: {
        if (t.length < 80) return;
        etat = { ...etat, firmwareCode: t[1], canauxMax: t[3], dateFirmware: texte(t.subarray(8, 20)), modele: texte(t.subarray(20, 60)), firmware: texte(t.subarray(60, 80)) };
        notifier();
        break;
      }
      case RESP.BATT:
        if (t.length >= 3) { etat.batterieMv = t.readUInt16LE(1); etat.derniereReponse = Date.now(); }
        break;
      case RESP.CONTACTS_START:
        contactsEnCours = [];
        break;
      case RESP.CONTACT: {
        if (t.length < 148 || !contactsEnCours) return;
        const lat = t.readInt32LE(136) / 1e6, lon = t.readInt32LE(140) / 1e6;
        contactsEnCours.push({
          cle: t.subarray(1, 33).toString('hex').toUpperCase(), role: ROLES[t[33]] || 'inconnu', nom: texte(t.subarray(100, 132)),
          horodatage: t.readUInt32LE(132), lat: Math.abs(lat) > 0.0001 ? lat : null, lon: Math.abs(lon) > 0.0001 ? lon : null,
          vu: t.readUInt32LE(144) * 1000 || null,
        });
        break;
      }
      case RESP.END_CONTACTS:
        if (contactsEnCours) {
          etat.contacts = contactsEnCours.length;
          journal(`${contactsEnCours.length} contact(s) importé(s) du companion`);
          if (surContacts) surContacts(contactsEnCours);
          contactsEnCours = null;
          notifier();
        }
        break;
      case PUSH.NEW_ADVERT:
      case PUSH.ADVERT:
        break; // les annonces sont décodées depuis les paquets bruts (LOG_RX)
      default: break;
    }
  }

  function fermer() {
    clearInterval(minuterieVie);
    const f = flux; flux = null;
    if (f && !f.destroyed) f.destroy();
  }

  return {
    etat: () => ({ ...etat, cible: memo.cible, navigateur: !!navigateur, nomNavigateur: navigateur ? navigateur.nom : null }),
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
      const { ce, pret } = attacher(f, `navigateur ${source}`);
      brancherEvenements(ce);
      setTimeout(pret, source === 'USB' ? 1500 : 200);
    },
    agentDisponible(hote) {
      if (!navigateur && !arret && memo.cible && memo.cible.type === 'agent' && memo.cible.hote === hote && (!flux || flux.destroyed)) planifier(500);
    },
    // Demande au companion d'émettre son annonce (1 = en inondation)
    annoncer(inondation) { if (!flux) throw new Error('companion non relié'); ecrire([CMD.SEND_SELF_ADVERT, inondation ? 1 : 0]); },
    rechargerContacts() { if (!flux) throw new Error('companion non relié'); contactsEnCours = []; ecrire([CMD.GET_CONTACTS]); },
    demarrer() { if (!arret) planifier(1500); },
  };
}

module.exports = { creerCompanion };
