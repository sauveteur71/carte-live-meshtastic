'use strict';
// Connexion directe à un module Meshtastic par TCP (API « stream », port 4403), comme l'appli mobile ou MeshMonitor.
// Trame : 0x94 0xC3 + longueur (2 octets, big-endian) + protobuf (ToRadio vers le module, FromRadio depuis le module).
// Le module transmet sa base de nœuds, ses canaux (noms + clés) puis chaque paquet entendu en radio, déjà déchiffré.
// Attention : un module ESP32 n'accepte qu'un seul client TCP à la fois.

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { racine, types, decoderMessage, preparerCanaux, idNoeud, ROLES, MATERIELS, positionValide } = require('./decodeur');
const RouteDiscovery = racine.lookupType('meshtastic.RouteDiscovery');

const FromRadio = racine.lookupType('meshtastic.FromRadio');
const ToRadio = racine.lookupType('meshtastic.ToRadio');
const PRESETS = racine.lookupEnum('meshtastic.Config.LoRaConfig.ModemPreset').valuesById;
const ROLES_CANAL = racine.lookupEnum('meshtastic.Channel.Role').valuesById;

// Nom affiché d'un canal primaire sans nom, selon le preset LoRa
const NOM_PRESET = {
  LONG_FAST: 'LongFast', LONG_SLOW: 'LongSlow', VERY_LONG_SLOW: 'VLongSlow', MEDIUM_SLOW: 'MediumSlow',
  MEDIUM_FAST: 'MediumFast', SHORT_SLOW: 'ShortSlow', SHORT_FAST: 'ShortFast', LONG_MODERATE: 'LongMod',
  SHORT_TURBO: 'ShortTurbo', LONG_TURBO: 'LongTurbo',
};

const journal = (...a) => console.log(new Date().toISOString(), '[Module radio]', ...a);
const ENTETE = Buffer.from([0x94, 0xc3]);

function creerSourceRadio(stockage, config, canauxGlobaux, rappels, agents = null) {
  const cfg = config.radio;
  // Modules Wi-Fi connus (choisis depuis la carte) et module actif, conservés dans le volume de données
  const fModules = path.join(path.dirname(config.fichierBase), 'modules-radio.json');
  let memo;
  try { memo = JSON.parse(fs.readFileSync(fModules, 'utf8')); } catch {
    memo = { modules: cfg.hote ? [{ hote: cfg.hote, port: cfg.port, nom: null }] : [], actif: cfg.hote ? { hote: cfg.hote, port: cfg.port } : null };
  }
  const sauver = () => { try { fs.writeFileSync(fModules, JSON.stringify(memo, null, 1)); } catch (e) { journal('sauvegarde des modules impossible :', e.message); } };
  let arretVoulu = !memo.actif;
  let minuterieReconnexion = null;
  let repriseAuto = null;
  let minuterieReprise = null;
  const { q } = stockage;
  const { integrerEvenement, apresSynchro, estSurveille } = rappels;

  let socket = null;
  let tampon = Buffer.alloc(0);
  let minuterieVie = null;
  let tentative = 0;
  let evictions = 0;
  let configId = 0;
  let enConfiguration = false;
  const canauxModule = new Map(); // index -> { nom, cle, role }
  let preset = null;
  let hopLimitLora = 3;
  const enAttente = new Map(); // id du paquet traceroute -> { cible, heure }
  const connusEnRadio = new Set(); // nœuds de la base du module entendus en radio
  const clesPubliques = new Map(); // nœud -> clé publique connue du module (administration à distance PKI)
  const ecouteurs = new Set(); // modules intéressés par les paquets bruts (administration)
  let clePubliqueLocale = null;
  let utilisateurLocal = null;
  const configBrute = { canaux: [], lora: null };
  let prochainCycle = Date.now() + 10 * 60000;
  let cycleEnCours = false;
  let etat = { connecte: false, noeudLocal: null, nomLocal: null, noeuds: 0, canaux: [], depuis: null, paquets: 0, erreur: null, firmware: null };

  function envoyer(objet) {
    if (!socket || socket.destroyed) return;
    const charge = ToRadio.encode(ToRadio.create(objet)).finish();
    const tete = Buffer.alloc(4);
    ENTETE.copy(tete);
    tete.writeUInt16BE(charge.length, 2);
    socket.write(Buffer.concat([tete, Buffer.from(charge)]));
  }

  function planifier(attente) {
    clearTimeout(minuterieReconnexion);
    minuterieReconnexion = setTimeout(connecter, attente);
  }

  function connecter() {
    clearTimeout(minuterieReconnexion);
    if (arretVoulu || !memo.actif) return;
    if (socket && !socket.destroyed) return;
    const cible = memo.actif;
    tampon = Buffer.alloc(0);
    enConfiguration = true;
    configId = crypto.randomBytes(4).readUInt32LE(0) || 1;
    const parAgent = !!(agents && agents.estAgent(cible.hote));
    if (parAgent) {
      const s = agents.prendre(cible.hote);
      if (!s) {
        // L'agent n'est pas lancé : on réessaiera dès qu'il se présentera (ou dans 1 min)
        etat = { ...etat, connecte: false, erreur: 'agent hors ligne : lancez l’agent sur le PC du module', reprise: Date.now() + 60000 };
        enConfiguration = false;
        planifier(60000);
        if (apresSynchro) setImmediate(apresSynchro); // jamais pendant la création (le serveur n'est pas encore prêt)
        return;
      }
      journal(`connexion par l'agent « ${cible.hote} »…`);
      socket = s;
    } else {
      journal(`connexion à ${cible.hote}:${cible.port}…`);
      socket = net.connect({ host: cible.hote, port: cible.port });
    }
    const ceSocket = socket;
    ceSocket.setNoDelay(true);
    ceSocket.setKeepAlive(true, 30000);
    ceSocket.setTimeout(10 * 60000); // aucun octet pendant 10 min : on considère la liaison morte
    const surConnexion = () => {
      etat = { ...etat, connecte: true, depuis: Date.now(), erreur: null, evince: false, reprise: null };
      journal('connecté, demande de la configuration');
      // Réveil du module (octets de synchronisation) puis demande de configuration
      ceSocket.write(Buffer.alloc(32, 0xc3));
      setTimeout(() => envoyer({ wantConfigId: configId }), 100);
      clearInterval(minuterieVie);
      minuterieVie = setInterval(() => envoyer({ heartbeat: {} }), 60000);
    };
    if (parAgent) setImmediate(surConnexion); else ceSocket.on('connect', surConnexion);
    ceSocket.on('data', recevoir);
    if (parAgent) ceSocket.resume();
    ceSocket.on('timeout', () => { journal('aucune donnée depuis 10 min, reconnexion'); ceSocket.destroy(); });
    ceSocket.on('error', (e) => { etat.erreur = e.code || e.message; });
    ceSocket.on('close', () => {
      clearInterval(minuterieVie);
      if (socket !== ceSocket) return; // ancienne connexion remplacée
      if (arretVoulu) {
        etat = { ...etat, connecte: false, evince: false, reprise: repriseAuto };
        journal('déconnecté à la demande' + (repriseAuto ? `, reprise à ${new Date(repriseAuto).toLocaleTimeString('fr-FR')}` : ''));
        if (apresSynchro) apresSynchro();
        return;
      }
      const duree = etat.depuis ? Date.now() - etat.depuis : 0;
      const etaitConnecte = etat.connecte;
      let attente;
      if (etaitConnecte && duree < 120000 && !etat.erreur) {
        // Coupure peu après la connexion sans erreur réseau : un autre client (appli téléphone, MeshMonitor…)
        // a pris la place sur le module (un seul client TCP à la fois). On lui laisse la main.
        evictions++;
        attente = Math.min(cfg.pauseMinutes * evictions, 60) * 60000;
        journal(`évincé par un autre client du module, nouvelle tentative dans ${Math.round(attente / 60000)} min`);
        etat = { ...etat, connecte: false, evince: true, reprise: Date.now() + attente };
      } else {
        if (etaitConnecte) journal('déconnecté' + (etat.erreur ? ' (' + etat.erreur + ')' : ''));
        if (duree > 600000) { tentative = 0; evictions = 0; }
        attente = parAgent ? 8000 : Math.min(5000 * 2 ** tentative++, 120000);
        if (parAgent && etaitConnecte) etat.erreur = 'agent déconnecté';
        etat = { ...etat, connecte: false, evince: false, reprise: Date.now() + attente };
      }
      planifier(attente);
      if (apresSynchro) apresSynchro();
    });
  }

  function recevoir(morceau) {
    tampon = Buffer.concat([tampon, morceau]);
    while (tampon.length >= 4) {
      const i = tampon.indexOf(ENTETE);
      if (i < 0) { tampon = tampon.subarray(tampon.length - 1); return; } // texte de débogage du module, ignoré
      if (i > 0) tampon = tampon.subarray(i);
      if (tampon.length < 4) return;
      const taille = tampon.readUInt16BE(2);
      if (taille > 512) { tampon = tampon.subarray(2); continue; } // trame invalide
      if (tampon.length < 4 + taille) return;
      const charge = tampon.subarray(4, 4 + taille);
      tampon = tampon.subarray(4 + taille);
      try {
        traiter(FromRadio.decode(charge));
      } catch (e) {
        journal('trame illisible :', e.message);
      }
    }
  }

  function nomCanal(index) {
    const c = canauxModule.get(index);
    if (c && c.nom) return c.nom;
    if (c && c.role === 'PRIMARY') return NOM_PRESET[preset] || 'LongFast';
    return 'canal ' + index;
  }

  function mettreAJourCanaux() {
    const liste = [...canauxModule.entries()]
      .filter(([, c]) => c.role !== 'DISABLED')
      .map(([i]) => ({ nom: nomCanal(i), cle: canauxModule.get(i).cle }));
    etat.canaux = liste.map((c) => c.nom);
    // Ajoute aux clés de déchiffrement du flux MQTT celles connues du module (sans doublon)
    for (const c of preparerCanaux(liste)) {
      if (c.cle && !canauxGlobaux.some((g) => g.nom === c.nom && g.cle && g.cle.equals(c.cle))) canauxGlobaux.push(c);
    }
  }

  function integrerNodeInfo(n) {
    const num = n.num >>> 0;
    if (!num) return;
    const vu = n.lastHeard ? n.lastHeard * 1000 : null;
    const maintenant = Date.now();
    if (vu && vu < maintenant - config.retentionJours * 86400000) return;
    stockage.assurerNoeud(num, vu || maintenant);
    if (n.user) {
      const u = n.user;
      if (u.publicKey && u.publicKey.length === 32) clesPubliques.set(num, Buffer.from(u.publicKey).toString('base64'));
      if (num === etat.noeudLocal) utilisateurLocal = u; // fiche du module (envoyée aux nœuds qui ne le connaissent pas)
      q.infos.run({
        num,
        nomLong: u.longName || null,
        nomCourt: u.shortName || null,
        materiel: MATERIELS[u.hwModel] || null,
        role: ROLES[u.role || 0] || 'CLIENT',
        firmware: null,
        preset: null,
      });
    }
    const sauts = n.hopsAway != null ? n.hopsAway : null;
    if (!n.viaMqtt && (sauts != null || n.snr)) connusEnRadio.add(num);
    if (vu) q.vu.run({ num, heure: vu, sauts, snr: sauts === 0 ? n.snr ?? null : null, rssi: null });
    const p = n.position;
    if (p && p.latitudeI && p.longitudeI && positionValide(p.latitudeI / 1e7, p.longitudeI / 1e7)) {
      const heurePos = p.time ? p.time * 1000 : vu || maintenant;
      const actuel = q.noeud.get(num);
      if (!actuel || actuel.lat == null || (actuel.heure_position || 0) < heurePos) {
        q.position.run({ num, lat: p.latitudeI / 1e7, lon: p.longitudeI / 1e7, alt: p.altitude || null, precision: p.precisionBits || null, heure: heurePos });
      }
    }
    const m = n.deviceMetrics;
    if (m && vu) {
      const actuel = q.noeud.get(num);
      if ((actuel.heure_telemetrie || 0) < vu) {
        const t = {
          num, heure: vu,
          batterie: m.batteryLevel ?? null,
          tension: m.voltage > 0 ? m.voltage : null,
          canal: m.channelUtilization ?? null,
          emission: m.airUtilTx ?? null,
          uptime: m.uptimeSeconds ?? null,
        };
        q.telemetrie.run(t);
        q.histoTelemetrie.run({ ...t, temperature: null, humidite: null, pression: null });
      }
    }
    // Voisin direct du module, entendu en radio
    const local = etat.noeudLocal;
    if (local != null && num !== local && sauts === 0 && !n.viaMqtt && vu && n.snr) {
      q.lien.run({ a: num, b: local, source: 'rf', snr: n.snr, rssi: null, heure: vu });
    }
  }

  function traiter(fr) {
    if (fr.myInfo) {
      etat.noeudLocal = fr.myInfo.myNodeNum >>> 0;
      stockage.assurerNoeud(etat.noeudLocal, Date.now());
      q.passerelle.run(Date.now(), etat.noeudLocal);
      q.etatPasserelle.run('online', Date.now(), etat.noeudLocal);
      journal(`module local ${idNoeud(etat.noeudLocal)}`);
    } else if (fr.metadata) {
      etat.firmware = fr.metadata.firmwareVersion || null;
      if (etat.noeudLocal != null && etat.firmware) q.infos.run({ num: etat.noeudLocal, nomLong: null, nomCourt: null, materiel: null, role: null, firmware: etat.firmware, preset: null });
    } else if (fr.config && fr.config.security) {
      const k = fr.config.security.publicKey;
      if (k && k.length) clePubliqueLocale = Buffer.from(k).toString('base64');
    } else if (fr.config && fr.config.lora) {
      configBrute.lora = racine.lookupType('meshtastic.Config.LoRaConfig').toObject(fr.config.lora, { enums: String, defaults: true });
      preset = PRESETS[fr.config.lora.modemPreset || 0] || null;
      hopLimitLora = fr.config.lora.hopLimit || 3;
      if (etat.noeudLocal != null && preset) q.infos.run({ num: etat.noeudLocal, nomLong: null, nomCourt: null, materiel: null, role: null, firmware: null, preset });
    } else if (fr.channel) {
      const c = fr.channel;
      const s = c.settings || {};
      configBrute.canaux[c.index || 0] = racine.lookupType('meshtastic.Channel').toObject(c, { enums: String, bytes: String, defaults: true });
      canauxModule.set(c.index || 0, {
        nom: s.name || '',
        cle: s.psk && s.psk.length ? Buffer.from(s.psk).toString('base64') : '',
        role: ROLES_CANAL[c.role || 0],
      });
    } else if (fr.nodeInfo) {
      stockage.transaction(() => integrerNodeInfo(fr.nodeInfo))();
      if (!enConfiguration && apresSynchro) apresSynchro();
    } else if (fr.configCompleteId !== undefined && fr.configCompleteId !== null && fr.configCompleteId !== 0) {
      enConfiguration = false;
      mettreAJourCanaux();
      // Copie de référence des canaux et du réglage LoRa du module (fichier réservé à l'administrateur du NAS)
      try { fs.writeFileSync(path.join(path.dirname(config.fichierBase), 'config-module.json'), JSON.stringify({ heure: Date.now(), noeud: etat.noeudLocal, ...configBrute }, null, 1), { mode: 0o600 }); } catch { /* ignore */ }
      try { require('./reglages-noeuds').enregistrer(etat.noeudLocal, { canaux: configBrute.canaux.filter(Boolean), lora: configBrute.lora, source: 'module' }); } catch (e) { console.error('[Radio] réglages :', e.message); }
      const local = etat.noeudLocal != null ? q.noeud.get(etat.noeudLocal) : null;
      etat.nomLocal = local ? local.nom_long || local.nom_court : null;
      etat.noeuds = q.noeuds.all().length;
      const m = memo.actif && memo.modules.find((x) => x.hote === memo.actif.hote && x.port === memo.actif.port);
      if (m && etat.nomLocal && (m.nom !== etat.nomLocal || m.num !== etat.noeudLocal)) { m.nom = etat.nomLocal; m.num = etat.noeudLocal; sauver(); }
      journal(`configuration reçue : module « ${etat.nomLocal || '?'} », canaux ${etat.canaux.join(', ')}`);
      if (apresSynchro) apresSynchro();
    } else if (fr.packet) {
      etat.paquets++;
      const p = fr.packet;
      for (const f of ecouteurs) { try { f(p); } catch (e) { journal('écouteur :', e.message); } }
      if (etat.noeudLocal == null) return;
      // Le paquet est remis au décodeur commun sous forme d'enveloppe MQTT : le module joue le rôle de passerelle
      const canal = nomCanal(p.channel || 0);
      const env = types.ServiceEnvelope.encode({ packet: p, channelId: canal, gatewayId: idNoeud(etat.noeudLocal) }).finish();
      const evt = decoderMessage(`radio/2/e/${canal}/${idNoeud(etat.noeudLocal)}`, Buffer.from(env), canauxGlobaux);
      if (evt && evt.genre === 'paquet') {
        suivreTraceroute(evt);
        // Paquets émis par le module lui-même : pas de mesure radio
        if (evt.de === etat.noeudLocal) { evt.snr = null; evt.rssi = null; }
        q.passerelle.run(Date.now(), etat.noeudLocal);
        integrerEvenement(evt);
      }
    } else if (fr.rebooted) {
      journal('le module a redémarré, nouvelle demande de configuration');
      enConfiguration = true;
      envoyer({ wantConfigId: (configId = (configId + 1) >>> 0) });
    }
  }

  // ---- Traceroutes ------------------------------------------------------------
  function suivreTraceroute(evt) {
    const id = evt.requeteId;
    if (!id || !enAttente.has(id)) return;
    const attente = enAttente.get(id);
    if (evt.portnum === 70 && evt.traceroute) {
      const t = evt.traceroute;
      q.trMaj.run({
        idPaquet: id, statut: 'repondu', duree: Date.now() - attente.heure, detail: null,
        aller: JSON.stringify(t.aller), snrAller: JSON.stringify(t.snrAller),
        retour: JSON.stringify(t.retour), snrRetour: JSON.stringify(t.snrRetour),
      });
      enAttente.delete(id);
      journal(`traceroute vers ${idNoeud(attente.cible)} : réponse en ${Math.round((Date.now() - attente.heure) / 1000)} s, ${t.aller.length} relais à l'aller`);
      if (apresSynchro) apresSynchro();
    } else if (evt.portnum === 5 && evt.erreurRoutage) {
      q.trMaj.run({ idPaquet: id, statut: 'echec', duree: Date.now() - attente.heure, detail: evt.resume, aller: null, snrAller: null, retour: null, snrRetour: null });
      enAttente.delete(id);
      journal(`traceroute vers ${idNoeud(attente.cible)} : ${evt.resume}`);
      if (apresSynchro) apresSynchro();
    }
  }

  function lancerTraceroute(cible, declencheur = 'manuel') {
    cible = cible >>> 0;
    if (!etat.connecte || etat.noeudLocal == null || enConfiguration) throw new Error('Module radio non connecté');
    if (cible === etat.noeudLocal) throw new Error('Impossible de tracer le module lui-même');
    const id = crypto.randomBytes(4).readUInt32LE(0) >>> 0 || 1;
    envoyer({
      packet: {
        to: cible, id, channel: 0, wantAck: true, hopLimit: hopLimitLora,
        decoded: { portnum: 70, payload: RouteDiscovery.encode({}).finish(), wantResponse: true },
      },
    });
    const heure = Date.now();
    q.trInserer.run(id, etat.noeudLocal, cible, heure, declencheur);
    enAttente.set(id, { cible, heure });
    journal(`traceroute ${declencheur} vers ${idNoeud(cible)} envoyé`);
    return { id, cible: idNoeud(cible) };
  }

  // Sans réponse au bout de 5 minutes : échec
  setInterval(() => {
    const limite = Date.now() - 5 * 60000;
    q.trExpirer.run(limite);
    for (const [id, a] of enAttente) if (a.heure < limite) enAttente.delete(id);
  }, 30000);

  function ciblesAutomatiques() {
    const toutes = q.noeuds.all();
    if (cfg.tracerouteCibles.length) {
      return toutes.filter((n) => cfg.tracerouteCibles.some((x) => x === n.id || x === n.nom_court || x === n.nom_long)).map((n) => n.num);
    }
    const limite = Date.now() - 7 * 86400000;
    return toutes
      .filter((n) => connusEnRadio.has(n.num) && n.num !== etat.noeudLocal && (n.dernier_vu || 0) > limite && estSurveille && estSurveille(n))
      .map((n) => n.num);
  }

  async function cycleTraceroutes() {
    if (cycleEnCours || !etat.connecte || enConfiguration) return;
    const local = etat.noeudLocal != null ? q.noeud.get(etat.noeudLocal) : null;
    if (local && local.emission != null && local.emission > cfg.emissionMaxPourcent) {
      journal(`traceroutes automatiques reportés : le module émet déjà ${local.emission.toFixed(1)} % du temps`);
      prochainCycle = Date.now() + 30 * 60000;
      return;
    }
    const cibles = ciblesAutomatiques();
    prochainCycle = Date.now() + cfg.tracerouteIntervalleMinutes * 60000;
    if (!cibles.length) return;
    cycleEnCours = true;
    journal(`cycle de traceroutes : ${cibles.length} cible(s)`);
    for (const c of cibles) {
      if (!etat.connecte) break;
      try { lancerTraceroute(c, 'auto'); } catch (e) { journal('traceroute impossible :', e.message); }
      await new Promise((r) => setTimeout(r, Math.max(30, cfg.tracerouteEspacementSecondes) * 1000));
    }
    cycleEnCours = false;
  }
  if (cfg.tracerouteIntervalleMinutes > 0) {
    setInterval(() => { if (Date.now() >= prochainCycle) cycleTraceroutes(); }, 60000);
  }

  // ---- Pilotage depuis la carte ------------------------------------------------------
  function couper() {
    clearTimeout(minuterieReconnexion);
    if (socket && !socket.destroyed) socket.destroy();
    else { etat = { ...etat, connecte: false, evince: false, reprise: repriseAuto }; if (apresSynchro) apresSynchro(); }
  }
  function deconnecter(minutes) {
    arretVoulu = true;
    clearTimeout(minuterieReprise);
    repriseAuto = minutes > 0 ? Date.now() + minutes * 60000 : null;
    if (repriseAuto) minuterieReprise = setTimeout(() => { if (arretVoulu && memo.actif) reconnecter(); }, minutes * 60000);
    if (!minutes) { memo.actif = null; sauver(); }
    couper();
  }
  function reconnecter() {
    if (!memo.actif) throw new Error('Aucun module choisi');
    arretVoulu = false;
    repriseAuto = null;
    clearTimeout(minuterieReprise);
    tentative = 0; evictions = 0;
    if (socket && !socket.destroyed) { socket.destroy(); }
    socket = null;
    connecter();
  }
  function connecterA(hote, port = 4403) {
    const changement = !memo.actif || memo.actif.hote !== hote || memo.actif.port !== port;
    if (!memo.modules.some((m) => m.hote === hote && m.port === port)) memo.modules.push({ hote, port, nom: null });
    memo.actif = { hote, port };
    sauver();
    if (changement) {
      // Nouveau module : on repart de zéro (nœud local, canaux, voisins radio)
      if (etat.noeudLocal != null) q.etatPasserelle.run('offline', Date.now(), etat.noeudLocal);
      canauxModule.clear(); connusEnRadio.clear(); enAttente.clear();
      preset = null;
      etat = { connecte: false, noeudLocal: null, nomLocal: null, noeuds: 0, canaux: [], depuis: null, paquets: 0, erreur: null, firmware: null };
    }
    const ancien = socket;
    socket = null;
    if (ancien && !ancien.destroyed) ancien.destroy();
    arretVoulu = false; repriseAuto = null; clearTimeout(minuterieReprise); tentative = 0; evictions = 0;
    connecter();
  }
  function ajouterModule(hote, port = 4403, nom = null) {
    let m = memo.modules.find((x) => x.hote === hote && x.port === port);
    if (!m) { m = { hote, port, nom }; memo.modules.push(m); } else if (nom) m.nom = nom;
    sauver();
    return m;
  }
  function retirerModule(hote, port = 4403) {
    if (memo.actif && memo.actif.hote === hote && memo.actif.port === port) deconnecter(0);
    memo.modules = memo.modules.filter((m) => !(m.hote === hote && m.port === port));
    sauver();
  }
  // Recherche des modules Meshtastic du réseau local (port TCP ouvert). Le module actuellement connecté n'est pas sondé.
  async function scanner(prefixe, port = 4403) {
    const trouves = [];
    const sonder = (ip) => new Promise((res) => {
      const s2 = net.connect({ host: ip, port });
      const fin = (ok) => { s2.destroy(); res(ok); };
      s2.setTimeout(700, () => fin(false));
      s2.on('connect', () => fin(true));
      s2.on('error', () => fin(false));
    });
    const ips = [];
    for (let i = 1; i < 255; i++) {
      const ip = `${prefixe}.${i}`;
      if (memo.actif && memo.actif.hote === ip && etat.connecte) { trouves.push(ip); continue; }
      ips.push(ip);
    }
    for (let k = 0; k < ips.length; k += 64) {
      const lot = ips.slice(k, k + 64);
      const r = await Promise.all(lot.map(sonder));
      lot.forEach((ip, i) => { if (r[i]) trouves.push(ip); });
    }
    for (const ip of trouves) ajouterModule(ip, port);
    return trouves;
  }

  // Un agent vient de se présenter : on l'inscrit et, si c'est le module choisi, on s'y connecte tout de suite
  function agentDisponible(hote, nom) {
    ajouterModule(hote, 1, nom);
    // Le module choisi est un agent hors ligne : on bascule tout seul sur celui qui vient d'arriver
    const actifHorsLigne = memo.actif && memo.actif.hote !== hote && agents && agents.estAgent(memo.actif.hote) && !agents.liste().some((a) => a.hote === memo.actif.hote);
    if (!arretVoulu && actifHorsLigne && !(socket && !socket.destroyed)) {
      journal(`« ${memo.actif.hote} » est hors ligne : bascule sur l'agent « ${nom} » qui vient de se connecter`);
      connecterA(hote, 1);
      return;
    }
    // (sauf si le module vient d'être pris par un autre client, ex. l'appli du téléphone en Wi-Fi : on lui laisse la main)
    if (memo.actif && memo.actif.hote === hote && !arretVoulu && !(socket && !socket.destroyed) && !(etat.evince && etat.reprise > Date.now())) { tentative = 0; connecter(); }
  }

  if (memo.actif) connecter();
  return {
    agentDisponible,
    modules: () => ({
      modules: memo.modules.map((m) => ({ ...m, actif: !!(memo.actif && memo.actif.hote === m.hote && memo.actif.port === m.port) })),
      actif: memo.actif, arret: arretVoulu, reprise: repriseAuto,
    }),
    connecterA, deconnecter, reconnecter, ajouterModule, retirerModule, scanner,
    // Accès bas niveau pour l'administration des nœuds
    envoyerPaquet: (paquet) => {
      if (!etat.connecte || etat.noeudLocal == null || enConfiguration) throw new Error('Module radio non connecté');
      envoyer({ packet: paquet });
    },
    ecouter: (f) => { ecouteurs.add(f); return () => ecouteurs.delete(f); },
    infos: () => ({ connecte: etat.connecte && !enConfiguration, noeudLocal: etat.noeudLocal, hopLimit: hopLimitLora, clePublique: clePubliqueLocale, clesPubliques, utilisateurLocal,
      canaux: [...canauxModule.entries()].filter(([, c]) => c.role !== 'DISABLED').map(([index]) => ({ index, nom: nomCanal(index) })).sort((a, b) => a.index - b.index) }),
    // Un paquet émis par la carte n'est pas renvoyé par le module : on l'enregistre comme s'il avait été entendu
    injecter: (paquet) => traiter({ packet: paquet }),
    etat: () => ({
      ...etat, hote: memo.actif ? memo.actif.hote : null, arret: arretVoulu, repriseAuto, preset, hopLimit: hopLimitLora, traceroutesEnAttente: enAttente.size,
      prochainCycle: cfg.tracerouteIntervalleMinutes > 0 ? prochainCycle : null, cycleEnCours,
      ciblesAuto: cfg.tracerouteIntervalleMinutes > 0 ? ciblesAutomatiques().length : 0,
    }),
    traceroute: lancerTraceroute,
  };
}

module.exports = { creerSourceRadio };
