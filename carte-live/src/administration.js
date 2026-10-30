'use strict';
// Administration des nœuds Meshtastic par LoRa, à travers le module connecté en TCP.
// Messages AdminMessage (port 6) chiffrés PKI : le nœud distant doit avoir la clé publique du module
// dans « Sécurité > Clé d'administration ». Chaque modification utilise la clé de session (session_passkey)
// renvoyée par la dernière lecture (valable 300 s), comme l'appli officielle.

const crypto = require('crypto');
const { racine, idNoeud, ERREURS_ROUTAGE } = require('./decodeur');

const AdminMessage = racine.lookupType('meshtastic.AdminMessage');
const Routing = racine.lookupType('meshtastic.Routing');
const User = racine.lookupType('meshtastic.User');
const ROLES_ENUM = racine.lookupEnum('meshtastic.Config.DeviceConfig.Role').values;
const REDIFFUSION_ENUM = racine.lookupEnum('meshtastic.Config.DeviceConfig.RebroadcastMode').values;
const REGIONS_ENUM = racine.lookupEnum('meshtastic.Config.LoRaConfig.RegionCode').values;
const PRESETS_ENUM = racine.lookupEnum('meshtastic.Config.LoRaConfig.ModemPreset').values;
const TYPES_CONFIG = { device: 0, position: 1, power: 2, network: 3, display: 4, lora: 5, bluetooth: 6, security: 7 };
const PORT_ADMIN = 6, PORT_ROUTAGE = 5;
const SIGNATURES_ENUM = (() => { try { return racine.lookupEnum('meshtastic.Config.SecurityConfig.PacketSignaturePolicy').values; } catch { return {}; } })();
const MODULE_TELEMETRIE = 5, MODULE_TRAFIC = 14; // AdminMessage.ModuleConfigType
// Version de firmware « a.b.c » → [a, b, c] ; vrai si v ≥ min
const versionTab = (v) => { const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')); return m ? [+m[1], +m[2], +m[3]] : null; };
const auMoins = (v, min) => { const a = versionTab(v), b = versionTab(min); if (!a || !b) return false; for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return true; };

const journal = (...a) => console.log(new Date().toISOString(), '[Administration]', ...a);
const versObjet = (type, m) => type.toObject(m, { longs: Number, enums: String, bytes: String, defaults: true });

function creerAdministration(radio, stockage) {
  const attentes = new Map(); // id du paquet -> { resolve, reject, minuterie, reponse }
  const clesSession = new Map(); // nœud -> { cle (Buffer), heure }
  const taches = new Map();
  let file = Promise.resolve(); // une seule opération radio à la fois (temps d'émission)

  // Nœuds qui ont déjà accepté une commande d'administration du module (donc ont sa clé dans leurs clés d'admin)
  const fAdmin = require('path').join(require('path').dirname(require('./config').fichierBase), 'noeuds-administrables.json');
  let administrables = {};
  try { administrables = JSON.parse(require('fs').readFileSync(fAdmin, 'utf8')); } catch { /* aucun */ }
  function noterAdmin(num, ok) {
    const module = radio.infos().noeudLocal >>> 0;
    const k = String(num >>> 0);
    const e = administrables[k] || {};
    // Résultat global (dernier essai) et par module : un relais peut accepter un module et refuser l'autre
    administrables[k] = { ...e, ok, heure: Date.now(), modules: [...new Set([...(e.modules || []), module])], parModule: { ...(e.parModule || {}), [module]: { ok, heure: Date.now() } } };
    try { require('fs').writeFileSync(fAdmin, JSON.stringify(administrables)); } catch { /* lecture seule */ }
  }
  radio.ecouter((p) => {
    const d = p.decoded;
    if (!d || !d.requestId || !attentes.has(d.requestId)) return;
    const a = attentes.get(d.requestId);
    const de = p.from >>> 0;
    if (d.portnum === PORT_ADMIN) {
      const m = AdminMessage.decode(d.payload);
      if (de !== (radio.infos().noeudLocal >>> 0)) noterAdmin(de, true);
      if (m.sessionPasskey && m.sessionPasskey.length) clesSession.set(de, { cle: Buffer.from(m.sessionPasskey), heure: Date.now() });
      if (a.reponse) { clearTimeout(a.minuterie); attentes.delete(d.requestId); a.resolve(m); }
    } else if (d.portnum === PORT_ROUTAGE) {
      const r = Routing.decode(d.payload);
      const code = r.errorReason || 0;
      if (code) {
        if (code === 33 || code === 37) noterAdmin(de, false);
        // Échec passager (pas d'accusé, pas de route, temps d'émission) : nouvel essai s'il en reste
        if (a.transitoire && ERREURS_PASSAGERES.has(code) && a.transitoire(code)) return;
        clearTimeout(a.minuterie); attentes.delete(d.requestId);
        a.reject(Object.assign(new Error(ERREURS_ROUTAGE[code] || `erreur de routage ${code}`), { code }));
      } else if (!a.reponse && de === a.dest) {
        // Accusé de réception du nœud visé : la commande est appliquée
        clearTimeout(a.minuterie); attentes.delete(d.requestId); a.resolve(null);
      }
    }
  });

  const ERREUR_ARRET = () => Object.assign(new Error('arrêtée à votre demande'), { arret: true });
  const arrets = new Set(); // nœuds dont l'opération en cours doit s'arrêter
  // Erreurs de routage passagères : la liaison a raté, la commande peut être renvoyée telle quelle
  const ERREURS_PASSAGERES = new Set([1, 3, 5, 8, 9, 38]);
  // Suivi des essais par nœud (pour afficher « nouvel essai 2/3 » dans l'opération en cours)
  const suivis = new Map();
  // Attente d'une réponse, par essai : selon la distance du nœud (sauts), au lieu d'un seul essai de 2 min
  function delaiEssai(dest) {
    let sauts = 2;
    try { const n = stockage && stockage.q && stockage.q.noeud && stockage.q.noeud.get(dest); if (n) sauts = Math.max(n.sauts_min ?? 0, n.sauts_dernier ?? 0, 1); } catch { /* inconnu */ }
    return Math.min(85000, 35000 + 15000 * sauts);
  }
  // Message d'absence de réponse : si ce nœud a déjà accepté une commande de ce module, la clé n'est pas en cause
  function messageSansReponse(dest, nbEssais) {
    const e = administrables[String(dest >>> 0)];
    const pm = e && e.parModule && e.parModule[radio.infos().noeudLocal >>> 0];
    const dejaOk = pm ? pm.ok : e && e.ok;
    if (dejaOk) return `pas de réponse après ${nbEssais} essai(s) : liaison radio trop faible ou nœud occupé (il a déjà accepté ce module, la clé d’admin n’est pas en cause)`;
    return `pas de réponse après ${nbEssais} essai(s) : nœud hors de portée, ou clé d’admin du module absente, ou firmware < 2.5`;
  }
  // Une demande d'administration, renvoyée jusqu'à 3 fois si le nœud ne répond pas (même contenu, nouvel identifiant).
  // Une réponse tardive à un essai précédent est acceptée : tous les identifiants restent écoutés jusqu'au bout.
  // Le dernier essai part avec un saut de plus, au cas où le chemin aurait changé.
  function envoyerAdmin(dest, message, { reponse = true, delai = null, essais = 3 } = {}) {
    dest = dest >>> 0;
    if (arrets.has(dest)) return Promise.reject(ERREUR_ARRET());
    const info0 = radio.infos();
    if (!info0.connecte) return Promise.reject(new Error('Module radio non connecté'));
    const local = dest === info0.noeudLocal;
    const nbEssais = local ? 1 : Math.max(1, essais);
    const parEssai = local ? 15000 : delai || delaiEssai(dest);
    return new Promise((resolve, reject) => {
      const ids = [];
      let fini = false, essai = 0, minuterie = null, relance = null;
      const terminer = (f, v) => {
        if (fini) return; fini = true;
        clearTimeout(minuterie); clearTimeout(relance);
        for (const i of ids) attentes.delete(i);
        f(v);
      };
      const ok = (v) => terminer(resolve, v), ko = (e) => terminer(reject, e);
      const suivant = (raison) => {
        if (fini || essai >= nbEssais) return false;
        clearTimeout(minuterie); clearTimeout(relance);
        const s = suivis.get(dest);
        if (s) s(`↻ ${raison}, nouvel essai ${essai + 1}/${nbEssais}…`);
        relance = setTimeout(envoyer, 4000 + Math.floor(Math.random() * 4000)); // laisse passer le trafic en cours
        return true;
      };
      const envoyer = () => {
        if (fini) return;
        if (arrets.has(dest)) return ko(ERREUR_ARRET());
        const info = radio.infos();
        if (!info.connecte) return ko(new Error('Module radio non connecté'));
        essai++;
        const corps = { ...message };
        const cs = clesSession.get(dest);
        if (cs && Date.now() - cs.heure < 280000) corps.sessionPasskey = cs.cle;
        const id = crypto.randomBytes(4).readUInt32LE(0) >>> 0 || 1;
        ids.push(id);
        minuterie = setTimeout(() => {
          if (!suivant('pas de réponse')) ko(new Error(local ? 'pas de réponse du module' : messageSansReponse(dest, nbEssais)));
        }, parEssai);
        attentes.set(id, {
          resolve: ok, reject: ko, minuterie, reponse, dest,
          transitoire: (code) => suivant(ERREURS_ROUTAGE[code] || `erreur ${code}`),
        });
        try {
          const sauts = Math.min(7, (info.hopLimit || 3) + (essai > 1 && essai === nbEssais ? 1 : 0));
          radio.envoyerPaquet({
            to: dest, id, channel: 0, wantAck: !local, hopLimit: sauts, pkiEncrypted: !local,
            decoded: { portnum: PORT_ADMIN, payload: AdminMessage.encode(AdminMessage.create(corps)).finish(), wantResponse: reponse },
          });
          // Commande au module local : pas d'accusé radio, elle est appliquée dès réception
          if (local && !reponse) setTimeout(() => ok(null), 300);
        } catch (e) { ko(e); }
      };
      envoyer();
    });
  }
  // Toutes les opérations passent par une file : une à la fois sur l'air
  const enFile = (f) => { const r = file.then(f, f); file = r.catch(() => {}); return r; };
  const admin = (dest, message, opts) => enFile(() => envoyerAdmin(dest, message, opts));
  // Une modification exige une clé de session récente : lecture légère si besoin
  async function assurerSession(dest) {
    const cs = clesSession.get(dest >>> 0);
    if (dest >>> 0 === radio.infos().noeudLocal) return;
    if (!cs || Date.now() - cs.heure > 240000) await admin(dest, { getDeviceMetadataRequest: true });
  }

  // Envoie la fiche du module (nom + clé publique) à un nœud qui ne la connaît pas encore,
  // comme « Échanger les infos » de l'appli. Le nœud répond avec sa propre fiche.
  function echangerInfos(dest) {
    const info = radio.infos();
    const u = info.utilisateurLocal;
    if (!u) throw new Error('Fiche du module pas encore reçue');
    const user = { ...u, id: idNoeud(info.noeudLocal) };
    if (!user.publicKey || !user.publicKey.length) user.publicKey = Buffer.from(info.clePublique || '', 'base64');
    radio.envoyerPaquet({
      to: dest >>> 0, id: crypto.randomBytes(4).readUInt32LE(0) >>> 0 || 1, channel: 0, wantAck: false, hopLimit: info.hopLimit,
      decoded: { portnum: 4, payload: User.encode(User.create(user)).finish(), wantResponse: true },
    });
    journal(`fiche du module envoyée à ${idNoeud(dest)}`);
  }

  // ---- Opérations ---------------------------------------------------------------------
  // ---- Lecture de la configuration, reprenable étape par étape ------------------------------
  // Chaque élément lu est gardé (fichier du volume, réservé à l'admin car il contient les clés des canaux) :
  // après un échec, « Reprendre la lecture » ne redemande que ce qui manque.
  const fLectures = require('path').join(require('path').dirname(require('./config').fichierBase), 'lectures-noeuds.json');
  const lectures = new Map();
  try { for (const [k, v] of Object.entries(JSON.parse(require('fs').readFileSync(fLectures, 'utf8')))) lectures.set(Number(k), v); } catch { /* aucune */ }
  // Les nœuds déjà lus avec succès ont forcément accepté le module : on les compte comme administrables
  for (const [num, l] of lectures) if (!administrables[num] && (l.materiel || l.lora || l.device || (l.canauxBruts || []).some(Boolean))) administrables[num] = { ok: true, heure: l.heure, modules: [] };
  const sauverLectures = () => { try { require('fs').writeFileSync(fLectures, JSON.stringify(Object.fromEntries(lectures)), { mode: 0o600 }); } catch { /* lecture seule */ } };
  const VALIDITE_LECTURE = 7 * 86400000;
  const ETAPES_FIXES = [
    ['materiel', 'informations matérielles'], ['proprietaire', 'nom du nœud'],
    ['device', 'configuration « appareil »'], ['lora', 'configuration « LoRa »'], ['position', 'configuration « position »'],
  ];
  function etatLecture(num) {
    const l = lectures.get(num >>> 0);
    if (!l || Date.now() - l.heure > VALIDITE_LECTURE) return null;
    const faites = ETAPES_FIXES.filter(([k]) => l[k]).map(([, t]) => t);
    const manquantes = ETAPES_FIXES.filter(([k]) => !l[k]).map(([, t]) => t);
    const nbCanaux = (l.canauxBruts || []).filter(Boolean).length;
    if (!l.canauxFin) manquantes.push(nbCanaux ? `canaux (à partir du n° ${l.canauxBruts.length})` : 'canaux');
    return { heure: l.heure, complete: !manquantes.length, faites, manquantes, nbCanaux };
  }
  const erreurDefinitive = (e) => e.arret || [33, 34, 35, 36, 37, 39].includes(e.code);

  async function lire(dest, journalTache, p = {}) {
    dest = dest >>> 0;
    const ancien = lectures.get(dest);
    const sections = Array.isArray(p.sections) && p.sections.length ? p.sections : null; // null = tout
    let l;
    if (p.reprendre && ancien && Date.now() - ancien.heure < VALIDITE_LECTURE) l = ancien;
    else if (sections && ancien) {
      // Relecture de quelques sections seulement : on garde le reste
      l = ancien;
      for (const k of sections) { if (k === 'canaux') { l.canauxBruts = []; l.canauxFin = false; } else delete l[k]; }
    } else l = { canauxBruts: [], canauxFin: false };
    l.canauxBruts = l.canauxBruts || [];
    l.heure = Date.now();
    lectures.set(dest, l);
    const dejaFaites = ETAPES_FIXES.filter(([k]) => l[k]).length + (l.canauxBruts || []).filter(Boolean).length;
    if (p.reprendre && dejaFaites) journalTache(`reprise : ${dejaFaites} élément(s) déjà lus conservés`);
    const Config = racine.lookupType('meshtastic.Config');
    const Channel = racine.lookupType('meshtastic.Channel');
    // (chaque demande est déjà renvoyée jusqu'à 3 fois par envoyerAdmin)
    const demande = (message) => admin(dest, message);
    const resultatPartiel = () => construireResultat(dest, l);
    try {
      for (const [cle, libelle] of ETAPES_FIXES) {
        if (l[cle] || (sections && !sections.includes(cle))) continue;
        if (cle === 'materiel') l.materiel = versObjet(racine.lookupType('meshtastic.DeviceMetadata'), (await demande({ getDeviceMetadataRequest: true }, libelle)).getDeviceMetadataResponse);
        else if (cle === 'proprietaire') { const o = (await demande({ getOwnerRequest: true }, libelle)).getOwnerResponse; l.proprietaire = { nomLong: o.longName, nomCourt: o.shortName }; }
        else l[cle] = versObjet(Config, (await demande({ getConfigRequest: TYPES_CONFIG[cle] }, libelle)).getConfigResponse)[cle];
        l.heure = Date.now(); sauverLectures();
        journalTache(`${libelle} lu(e)`);
      }
      // Module Voisinage (NeighborInfo) : facultatif, une absence de réponse ne fait pas échouer la lecture
      if (!l.voisinage && (!sections || sections.includes('voisinage'))) {
        try {
          const m = (await demande({ getModuleConfigRequest: MODULE_VOISINAGE }, 'module Voisinage')).getModuleConfigResponse;
          l.voisinage = versObjet(racine.lookupType('meshtastic.ModuleConfig'), m).neighborInfo || { enabled: false };
          l.heure = Date.now(); sauverLectures();
          journalTache(`module Voisinage lu (${l.voisinage.enabled ? 'activé' : 'désactivé'})`);
        } catch (e) { if (e.arret) throw e; journalTache('module Voisinage : non lu (' + e.message.split(' — ')[0] + ')'); }
      }
      // Module Télémétrie (intervalle des mesures de l'appareil ; 2.8 : envoi désactivable)
      if (!l.telemetrie && (!sections || sections.includes('telemetrie'))) {
        try {
          const m = (await demande({ getModuleConfigRequest: MODULE_TELEMETRIE }, 'module Télémétrie')).getModuleConfigResponse;
          const t = versObjet(racine.lookupType('meshtastic.ModuleConfig'), m).telemetry || {};
          l.telemetrie = { deviceUpdateInterval: t.deviceUpdateInterval || 0, deviceTelemetryEnabled: !!t.deviceTelemetryEnabled };
          l.heure = Date.now(); sauverLectures();
          journalTache(`module Télémétrie lu (toutes les ${l.telemetrie.deviceUpdateInterval || 'défaut'} s)`);
        } catch (e) { if (e.arret) throw e; journalTache('module Télémétrie : non lu (' + e.message.split(' — ')[0] + ')'); }
      }
      // Gestion du trafic (firmware 2.8) : seulement si le nœud est en 2.8 ou plus
      const fwLu = l.materiel && l.materiel.firmwareVersion;
      if (!l.trafic && auMoins(fwLu, '2.8.0') && (!sections || sections.includes('trafic'))) {
        try {
          const m = (await demande({ getModuleConfigRequest: MODULE_TRAFIC }, 'gestion du trafic')).getModuleConfigResponse;
          l.trafic = versObjet(racine.lookupType('meshtastic.ModuleConfig'), m).trafficManagement || {};
          l.heure = Date.now(); sauverLectures();
          journalTache('module Gestion du trafic lu');
        } catch (e) { if (e.arret) throw e; journalTache('gestion du trafic : non lue (' + e.message.split(' — ')[0] + ')'); }
      }
      // Sécurité : clés d'administration autorisées (la clé privée n'est jamais gardée)
      if (!l.securite && (!sections || sections.includes('securite'))) {
        try {
          const sc = versObjet(Config, (await demande({ getConfigRequest: TYPES_CONFIG.security }, 'sécurité')).getConfigResponse).security || {};
          const b64 = (x) => (x ? Buffer.from(typeof x === 'string' ? Buffer.from(x, 'base64') : x).toString('base64') : null);
          l.securite = { adminKeys: (sc.adminKey || []).map(b64).filter((x) => x && x !== 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='), clePublique: b64(sc.publicKey), gere: !!sc.isManaged, canalAdmin: !!sc.adminChannelEnabled, signature: sc.packetSignaturePolicy || 'PACKET_SIGNATURE_POLICY_COMPATIBLE' };
          l.heure = Date.now(); sauverLectures();
          noterCles(dest, l.securite);
          journalTache(`sécurité lue (${l.securite.adminKeys.length} clé(s) d’administration)`);
        } catch (e) { if (e.arret) throw e; journalTache('sécurité : non lue (' + e.message.split(' — ')[0] + ')'); }
      }
      for (let i = (l.canauxBruts || []).length; (!sections || sections.includes('canaux')) && !l.canauxFin && i < 8; i++) {
        const ch = versObjet(Channel, (await demande({ getChannelRequest: i + 1 }, `canal ${i}`)).getChannelResponse);
        l.canauxBruts[i] = ch;
        if (ch.role === 'DISABLED' && i > 0) l.canauxFin = true; // canaux contigus : on s'arrête au premier vide
        if (i === 7) l.canauxFin = true;
        l.heure = Date.now(); sauverLectures();
        journalTache(ch.role === 'DISABLED' ? `canal ${i} vide : fin des canaux` : `canal ${i} « ${ch.settings.name || 'défaut'} » lu`);
      }
    } catch (e) {
      sauverLectures();
      const et = etatLecture(dest);
      throw Object.assign(new Error(`${e.message} — déjà lus : ${et ? et.faites.length + (et.nbCanaux ? ' + ' + et.nbCanaux + ' canal(aux)' : '') : 0} ; manquent : ${et ? et.manquantes.join(', ') : 'tout'}. Utilisez « Reprendre la lecture ».`), { code: e.code, partiel: resultatPartiel() });
    }
    const r = resultatPartiel();
    const bruts = l.canauxBruts.filter((c) => c && c.role !== 'DISABLED');
    if (l.canauxFin && l.lora) try { require('./reglages-noeuds').enregistrer(dest, { canaux: bruts, lora: l.lora, source: 'lecture LoRa' }); } catch (e) { journal('réglages :', e.message); }
    journalTache(sections ? `éléments demandés lus (${sections.join(', ')})` : `${r.canaux.length} canal(aux) lus, configuration complète`);
    return r;
  }
  function construireResultat(dest, l) {
    return {
      num: dest, id: idNoeud(dest), heure: l.heure, complet: !!(l.canauxFin && ETAPES_FIXES.every(([k]) => l[k])),
      materiel: l.materiel || null, proprietaire: l.proprietaire || null, device: l.device || null, lora: l.lora || null, position: l.position || null, voisinage: l.voisinage || null,
      telemetrie: l.telemetrie || null, trafic: l.trafic || null, signature: l.securite ? l.securite.signature || null : null,
      firmware: (l.materiel && l.materiel.firmwareVersion) || null,
      canaux: (l.canauxBruts || []).filter((ch) => ch && ch.role !== 'DISABLED').map((ch) => ({ index: ch.index, role: ch.role, nom: ch.settings.name, psk: ch.settings.psk, montant: ch.settings.uplinkEnabled, descendant: ch.settings.downlinkEnabled, precision: ch.settings.moduleSettings ? ch.settings.moduleSettings.positionPrecision : 0 })),
      canauxComplets: !!l.canauxFin,
    };
  }

  // ---- Vérification de conformité ----------------------------------------------------------
  const ELEMENTS = {
    canaux: { nom: 'Canaux (noms, clés, ordre)', sections: ['canaux'] },
    precision: { nom: 'Précision de position', sections: ['canaux'] },
    mqtt: { nom: 'MQTT ↑↓ par canal', sections: ['canaux'] },
    frequence: { nom: 'Région, slot et fréquence', sections: ['lora'] },
    preset: { nom: 'Preset (Long Moderate…)', sections: ['lora'] },
    sauts: { nom: 'Nombre de sauts', sections: ['lora'] },
    puissance: { nom: 'Puissance d’émission', sections: ['lora'] },
    rediffusion: { nom: 'Rediffusion (rebroadcast)', sections: ['device'] },
  };
  const actifs = (l) => (l.canauxBruts || []).filter((c) => c && c.role !== 'DISABLED');
  const cleTexte = (b64) => { const b = Buffer.from(b64 || '', 'base64'); return !b.length ? 'aucune' : b.length === 1 ? (b[0] === 1 ? 'défaut (AQ==)' : 'simple n°' + b[0]) : 'perso ' + crypto.createHash('sha256').update(b).digest('hex').slice(0, 6); };
  const prec = (c) => (c.settings.moduleSettings ? c.settings.moduleSettings.positionPrecision || 0 : 0);
  function comparer(ref, l, elements) {
    const ecarts = [];
    const e = (element, objet, attendu, trouve) => ecarts.push({ element, objet, attendu: String(attendu), trouve: String(trouve) });
    const ra = actifs(ref), la = actifs(l);
    if (elements.includes('canaux')) {
      for (let i = 0; i < Math.max(ra.length, la.length); i++) {
        const a = ra[i], b = la[i];
        const desc = (c) => (c ? `${c.settings.name || '(nom du preset)'} · ${cleTexte(c.settings.psk)}` : 'absent');
        if (!a || !b || (a.settings.name || '') !== (b.settings.name || '') || (a.settings.psk || '') !== (b.settings.psk || '')) e('canaux', `canal ${i}`, desc(a), desc(b));
      }
    }
    const parNom = new Map(la.map((c) => [c.settings.name || '', c]));
    for (const a of ra) {
      const b = parNom.get(a.settings.name || '');
      if (!b) continue; // canal absent : déjà signalé par « canaux »
      const nomc = a.settings.name || 'principal';
      if (elements.includes('precision') && prec(a) !== prec(b)) e('precision', nomc, prec(a) + ' bits', prec(b) + ' bits');
      if (elements.includes('mqtt')) {
        const m = (c) => (c.settings.uplinkEnabled ? '↑' : '–') + (c.settings.downlinkEnabled ? '↓' : '–');
        if (m(a) !== m(b)) e('mqtt', nomc, m(a), m(b));
      }
    }
    const lr = ref.lora || {}, ll = l.lora || {};
    if (elements.includes('frequence')) {
      if (lr.region !== ll.region) e('frequence', 'région', lr.region, ll.region);
      if ((lr.channelNum || 0) !== (ll.channelNum || 0)) e('frequence', 'slot', lr.channelNum || 'auto', ll.channelNum || 'auto');
      if (Math.abs((lr.overrideFrequency || 0) - (ll.overrideFrequency || 0)) > 0.0005) e('frequence', 'fréquence forcée', lr.overrideFrequency ? lr.overrideFrequency.toFixed(4) : 'non', ll.overrideFrequency ? ll.overrideFrequency.toFixed(4) : 'non');
    }
    if (elements.includes('preset')) {
      const pr = (x) => (x.usePreset === false ? 'personnalisé' : x.modemPreset);
      if (pr(lr) !== pr(ll)) e('preset', 'preset', pr(lr), pr(ll));
    }
    if (elements.includes('sauts') && lr.hopLimit !== ll.hopLimit) e('sauts', 'sauts', lr.hopLimit, ll.hopLimit);
    if (elements.includes('puissance') && (lr.txPower || 0) !== (ll.txPower || 0)) e('puissance', 'puissance', lr.txPower ? lr.txPower + ' dBm' : 'défaut', ll.txPower ? ll.txPower + ' dBm' : 'défaut');
    if (elements.includes('rediffusion') && (ref.device || {}).rebroadcastMode !== (l.device || {}).rebroadcastMode) e('rediffusion', 'rebroadcast', (ref.device || {}).rebroadcastMode, (l.device || {}).rebroadcastMode);
    return ecarts;
  }
  const sectionsPour = (elements) => [...new Set(elements.flatMap((k) => (ELEMENTS[k] ? ELEMENTS[k].sections : [])))];
  const lectureFraiche = (num, sections, ageMax) => {
    const l = lectures.get(num >>> 0);
    if (!l || Date.now() - l.heure > ageMax) return false;
    return sections.every((k) => (k === 'canaux' ? l.canauxFin : !!l[k]));
  };
  // Une étape par nœud : la référence d'abord (lue si besoin), puis chaque nœud comparé à elle
  async function verifier(dest, p, journalTache) {
    dest = dest >>> 0;
    const elements = (p.elements || []).filter((k) => ELEMENTS[k]);
    const sections = sectionsPour(elements);
    const ageMax = (Number(p.ageMaxHeures) || 0) * 3600000;
    if (ageMax && lectureFraiche(dest, sections, ageMax)) journalTache('lecture récente réutilisée');
    else await lire(dest, journalTache, { sections, reprendre: false });
    if (dest === (p.reference >>> 0)) return { reference: true, ecarts: [] };
    const ref = lectures.get(p.reference >>> 0);
    if (!ref || !lectureFraiche(p.reference, sections, Math.max(ageMax, 3600000))) throw new Error('référence non lue : relancez la vérification');
    const ecarts = comparer(ref, lectures.get(dest), elements);
    return { conforme: !ecarts.length, ecarts };
  }

  const precisionValide = (v) => {
    if (v === undefined || v === null || v === '') return 17;
    const n = Number(v);
    if (!Number.isInteger(n) || !(n === 0 || n === 32 || (n >= 10 && n <= 19))) throw new Error('Précision de position invalide');
    return n;
  };
  const CONFIRMATION_PRINCIPAL = 'CANAL 0';

  async function definirCanal(dest, p, journalTache = () => {}) {
    const index = Number(p.index);
    if (!Number.isInteger(index) || index < 0 || index > 7) throw new Error('Emplacement de canal invalide (0 à 7)');
    if (index === 0) return definirPrincipal(dest, p, journalTache);
    await assurerSession(dest);
    const settings = p.role === 'DISABLED' ? {} : {
      name: String(p.nom || '').slice(0, 11),
      psk: Buffer.from(p.psk || 'AQ==', 'base64'),
      uplinkEnabled: !!p.montant, downlinkEnabled: !!p.descendant,
      moduleSettings: { positionPrecision: precisionValide(p.precision) },
    };
    await admin(dest, { setChannel: { index, role: p.role === 'DISABLED' ? 0 : 2, settings } }, { reponse: false });
  }

  // Canal principal : garde-fous (confirmation, fréquence fixe, relecture avant/après)
  async function definirPrincipal(dest, p, journalTache) {
    if (p.confirmation !== CONFIRMATION_PRINCIPAL) throw new Error(`Confirmation manquante : tapez « ${CONFIRMATION_PRINCIPAL} »`);
    if (p.role === 'DISABLED') throw new Error('Le canal principal ne peut pas être supprimé');
    const nom = String(p.nom || '').trim().slice(0, 11);
    if (!nom) throw new Error('Le canal principal doit avoir un nom');
    const psk = Buffer.from(p.psk || 'AQ==', 'base64');
    if (![0, 1, 16, 32].includes(psk.length)) throw new Error('Clé invalide (1, 16 ou 32 octets)');
    const Config = racine.lookupType('meshtastic.Config');
    const Channel = racine.lookupType('meshtastic.Channel');

    // 1. Relecture du réglage LoRa : la fréquence ne doit pas dépendre du nom du canal principal
    const c = await admin(dest, { getConfigRequest: TYPES_CONFIG.lora });
    const lora = versObjet(Config, c.getConfigResponse).lora || {};
    const freqFixe = (lora.overrideFrequency || 0) > 0 || (lora.channelNum || 0) > 0 || dest === (radio.infos().noeudLocal >>> 0); // module local : relié en Wi-Fi/USB, pas de risque de perdre le contact
    journalTache(`réglage LoRa lu : ${lora.overrideFrequency ? lora.overrideFrequency.toFixed(4) + ' MHz forcée' : lora.channelNum ? 'slot ' + lora.channelNum : 'slot automatique (calculé depuis le nom du canal 0)'}`);

    // 2. Relecture du canal 0 actuel
    const a = await admin(dest, { getChannelRequest: 1 });
    const actuel = versObjet(Channel, a.getChannelResponse);
    const ancienNom = (actuel.settings && actuel.settings.name) || '';
    journalTache(`canal 0 actuel : « ${ancienNom || '(nom du preset)'} »`);
    if (!freqFixe && nom !== ancienNom) {
      throw Object.assign(new Error(`Refusé : la fréquence de ce nœud est calculée depuis le nom du canal 0 (« ${ancienNom || 'preset'} »). Le renommer en « ${nom} » le ferait changer de fréquence et vous perdriez le contact. Forcez d'abord un slot ou une fréquence (869,4625 MHz) sur ce nœud, sur place ou par QR code.`), { garde: true });
    }
    const settings = {
      name: nom, psk, id: (actuel.settings && actuel.settings.id) || 0,
      uplinkEnabled: !!p.montant, downlinkEnabled: !!p.descendant,
      moduleSettings: { positionPrecision: precisionValide(p.precision) },
    };

    // 3. Écriture
    await admin(dest, { setChannel: { index: 0, role: 1, settings } }, { reponse: false });
    journalTache('canal 0 envoyé, vérification dans 20 s…');

    // 4. Relecture : le nœud répond-il toujours, avec le nouveau canal ?
    await new Promise((r) => setTimeout(r, 20000));
    clesSession.delete(dest);
    let verif = null;
    // (chaque relecture est déjà renvoyée jusqu'à 3 fois)
    for (let essai = 1; essai <= 2 && !verif; essai++) {
      try { verif = versObjet(Channel, (await admin(dest, { getChannelRequest: 1 })).getChannelResponse); } catch (e) {
        if (e.arret) throw e;
        journalTache(`↻ relecture ${essai}/2 impossible (${e.message.split(' : ')[0]}), on patiente…`);
        if (essai < 2) await new Promise((r) => setTimeout(r, 30000));
      }
    }
    if (!verif) throw new Error('Canal 0 envoyé et accusé, mais le nœud ne répond plus à la relecture : vérifiez-le sur la carte dans quelques minutes');
    const nomLu = (verif.settings && verif.settings.name) || '';
    if (nomLu !== nom) throw new Error(`Le nœud répond mais son canal 0 est encore « ${nomLu} »`);
    journalTache(`vérifié : canal 0 = « ${nomLu} », le nœud répond toujours`);
    return { canal0: nomLu, ancien: ancienNom };
  }

  async function definirPosition(dest, p) {
    await assurerSession(dest);
    if (p.retirer) { await admin(dest, { removeFixedPosition: true }, { reponse: false }); return; }
    const lat = Number(p.lat), lon = Number(p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('Coordonnées invalides');
    await admin(dest, { setFixedPosition: { latitudeI: Math.round(lat * 1e7), longitudeI: Math.round(lon * 1e7), altitude: p.alt != null && p.alt !== '' ? Math.round(Number(p.alt)) : 0, time: Math.floor(Date.now() / 1000) } }, { reponse: false });
  }

  async function definirNom(dest, p) {
    await assurerSession(dest);
    const nomLong = String(p.nomLong || '').trim().slice(0, 39), nomCourt = String(p.nomCourt || '').trim().slice(0, 4);
    if (!nomLong && !nomCourt) throw new Error('Nom vide');
    // Le nom complet est relu pour ne rien effacer (clé publique, rôle…)
    const o = await admin(dest, { getOwnerRequest: true });
    const u = { ...o.getOwnerResponse };
    if (nomLong) u.longName = nomLong;
    if (nomCourt) u.shortName = nomCourt;
    await admin(dest, { setOwner: u }, { reponse: false });
  }

  // Modifie quelques champs d'une section de configuration : la section complète est relue puis renvoyée
  const CHAMPS = {
    device: { role: (v) => { if (!(v in ROLES_ENUM)) throw new Error('Rôle inconnu'); return ROLES_ENUM[v]; }, nodeInfoBroadcastSecs: (v) => entier(v, 0, 86400 * 7), rebroadcastMode: (v) => { if (!(v in REDIFFUSION_ENUM)) throw new Error('Mode de rediffusion inconnu'); return REDIFFUSION_ENUM[v]; } },
    lora: {
      hopLimit: (v) => entier(v, 1, 7), modemPreset: (v) => { if (!(v in PRESETS_ENUM)) throw new Error('Preset inconnu'); return PRESETS_ENUM[v]; }, txPower: (v) => entier(v, 0, 30), txEnabled: (v) => !!v,
      region: (v) => { if (!(v in REGIONS_ENUM) || v === 'UNSET') throw new Error('Région inconnue'); return REGIONS_ENUM[v]; },
      channelNum: (v) => entier(v, 0, 200), usePreset: (v) => !!v, sx126xRxBoostedGain: (v) => !!v, configOkToMqtt: (v) => !!v,
      overrideFrequency: (v) => { const f = Number(v); if (!(f === 0 || (f >= 400 && f <= 1000))) throw new Error('Fréquence forcée invalide (0 ou en MHz)'); return f; },
    },
    position: { positionBroadcastSecs: (v) => entier(v, 0, 86400 * 7), positionBroadcastSmartEnabled: (v) => !!v, fixedPosition: (v) => !!v },
  };
  // Module Voisinage (NeighborInfo) : publie la liste des nœuds entendus directement, avec leur SNR
  const MODULE_VOISINAGE = 9; // AdminMessage.ModuleConfigType.NEIGHBORINFO_CONFIG
  function valeursVoisinage(v) {
    const r = {};
    if ('enabled' in v) r.enabled = !!v.enabled;
    if ('transmitOverLora' in v) r.transmitOverLora = !!v.transmitOverLora;
    if ('updateInterval' in v) {
      const n = Number(v.updateInterval);
      // Le firmware impose au moins 4 h entre deux envois sur LoRa (limite du temps d'émission)
      if (!Number.isInteger(n) || n < 14400 || n > 86400 * 7) throw new Error('Intervalle du voisinage : de 4 h (14400 s) à 7 jours');
      r.updateInterval = n;
    }
    return r;
  }
  function entier(v, min, max) { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Valeur hors limites (${min} à ${max})`); return n; }
  // Module Télémétrie : intervalle des mesures de l'appareil, envoi sur le maillage (désactivé par défaut en 2.8 sur canal public)
  function valeursTelemetrie(v) {
    const r = {};
    if ('deviceUpdateInterval' in v) { const n = Number(v.deviceUpdateInterval); if (!Number.isInteger(n) || !(n === 0 || (n >= 900 && n <= 86400 * 7))) throw new Error('Intervalle de télémétrie : 0 (défaut) ou de 15 min (900 s) à 7 jours'); r.deviceUpdateInterval = n; }
    if ('deviceTelemetryEnabled' in v) r.deviceTelemetryEnabled = !!v.deviceTelemetryEnabled;
    return r;
  }
  // Gestion du trafic (2.8) : une valeur à 0 désactive la fonction correspondante
  const CHAMPS_TRAFIC = { positionMinIntervalSecs: [0, 86400 * 7], nodeinfoDirectResponseMaxHops: [0, 7], rateLimitWindowSecs: [0, 86400], rateLimitMaxPackets: [0, 1000], unknownPacketThreshold: [0, 1000] };
  function valeursTrafic(v) {
    const r = {};
    for (const [k, [min, max]] of Object.entries(CHAMPS_TRAFIC)) if (k in v) r[k] = entier(v[k], min, max);
    return r;
  }
  async function definirConfig(dest, p) {
    const section = p.section;
    if (section === 'voisinage') {
      const v = valeursVoisinage(p.valeurs || {});
      if (!Object.keys(v).length) throw new Error('Aucune valeur');
      await assurerSession(dest);
      const ModuleConfig = racine.lookupType('meshtastic.ModuleConfig');
      const actuel = versObjet(ModuleConfig, (await admin(dest, { getModuleConfigRequest: MODULE_VOISINAGE })).getModuleConfigResponse).neighborInfo || {};
      await admin(dest, { setModuleConfig: { neighborInfo: { ...actuel, ...v } } }, { reponse: false });
      return;
    }
    if (!CHAMPS[section]) throw new Error('Section non modifiable');
    const valeurs = {};
    for (const [k, v] of Object.entries(p.valeurs || {})) {
      if (!CHAMPS[section][k]) throw new Error(`Réglage « ${k} » non modifiable`);
      valeurs[k] = CHAMPS[section][k](v);
    }
    if (!Object.keys(valeurs).length) throw new Error('Aucune valeur');
    const c = await admin(dest, { getConfigRequest: TYPES_CONFIG[section] });
    const actuel = c.getConfigResponse[section];
    if (!actuel) throw new Error('Configuration illisible');
    await admin(dest, { setConfig: { [section]: { ...actuel, ...valeurs } } }, { reponse: false });
  }

  // ---- Modification groupée (éditeur de réglages) ---------------------------------------------
  // Tout est envoyé dans une transaction (begin/commit edit settings) : un seul enregistrement, un seul redémarrage.
  async function modifier(dest, p, journalTache) {
    dest = dest >>> 0;
    const local = dest === (radio.infos().noeudLocal >>> 0);
    const Config = racine.lookupType('meshtastic.Config');
    const canaux = Array.isArray(p.canaux) ? p.canaux : [];
    const sections = ['device', 'lora', 'position'].filter((k) => p[k] && Object.keys(p[k]).length);
    const voisinage = p.voisinage && Object.keys(p.voisinage).length ? valeursVoisinage(p.voisinage) : null;
    const telemetrie = p.telemetrie && Object.keys(p.telemetrie).length ? valeursTelemetrie(p.telemetrie) : null;
    const trafic = p.trafic && Object.keys(p.trafic).length ? valeursTrafic(p.trafic) : null;
    let signature = null;
    if (p.securite && p.securite.packetSignaturePolicy) {
      if (!(p.securite.packetSignaturePolicy in SIGNATURES_ENUM)) throw new Error('Politique de signature inconnue');
      signature = p.securite.packetSignaturePolicy;
    }
    if (!canaux.length && !sections.length && !p.nom && !voisinage && !telemetrie && !trafic && !signature) throw new Error('Aucune modification');
    // Valeurs vérifiées avant tout envoi
    const valeurs = {};
    for (const k of sections) {
      valeurs[k] = {};
      for (const [c, v] of Object.entries(p[k])) {
        if (!CHAMPS[k][c]) throw new Error(`Réglage « ${c} » non modifiable`);
        valeurs[k][c] = CHAMPS[k][c](v);
      }
    }
    const c0 = canaux.find((c) => Number(c.index) === 0);
    if (c0 && p.confirmation !== CONFIRMATION_PRINCIPAL) throw new Error(`Confirmation manquante pour le canal 0 : tapez « ${CONFIRMATION_PRINCIPAL} »`);
    await assurerSession(dest);
    // Réglages 2.8 (gestion du trafic, signature) : refusés sur un firmware plus ancien.
    // Sécurité : en 2.7, renvoyer la configuration sécurité sans la clé privée régénère les clés du nœud
    // (nouvelle identité, contact perdu) ; seul le 2.8.1 et plus garde ses clés : on l'exige.
    if (trafic || signature) {
      const meta = (await admin(dest, { getDeviceMetadataRequest: true })).getDeviceMetadataResponse || {};
      const fw = meta.firmwareVersion;
      if (trafic && !auMoins(fw, '2.8.0')) throw new Error(`Gestion du trafic : firmware 2.8 requis (nœud en ${fw || 'version inconnue'})`);
      if (signature && !auMoins(fw, '2.8.1')) throw new Error(`Politique de signature : firmware 2.8.1 requis (nœud en ${fw || 'version inconnue'}) — en dessous, modifier la sécurité à distance changerait ses clés`);
      journalTache(`firmware ${fw} : réglages 2.8 acceptés`);
    }
    // Garde-fou canal 0 : sur un nœud distant, la fréquence ne doit pas dépendre du nom du canal principal
    if (c0 && !local) {
      const lo = versObjet(Config, (await admin(dest, { getConfigRequest: TYPES_CONFIG.lora })).getConfigResponse).lora || {};
      const apres = { ...lo, ...(valeurs.lora || {}) };
      const actuel = versObjet(racine.lookupType('meshtastic.Channel'), (await admin(dest, { getChannelRequest: 1 })).getChannelResponse);
      const fixe = (apres.overrideFrequency || 0) > 0 || (apres.channelNum || 0) > 0;
      if (!fixe && (actuel.settings.name || '') !== String(c0.nom || '').trim()) throw new Error('Refusé : la fréquence de ce nœud dépend du nom du canal 0, le renommer couperait le contact. Forcez d’abord le slot ou la fréquence.');
      journalTache('garde-fou canal 0 : fréquence fixe, OK');
    }
    await admin(dest, { beginEditSettings: true }, { reponse: false });
    journalTache('début des modifications');
    if (p.nom && (p.nom.nomLong || p.nom.nomCourt)) {
      const o = (await admin(dest, { getOwnerRequest: true })).getOwnerResponse;
      const u = { ...o };
      if (p.nom.nomLong) u.longName = String(p.nom.nomLong).trim().slice(0, 39);
      if (p.nom.nomCourt) u.shortName = String(p.nom.nomCourt).trim().slice(0, 4);
      await admin(dest, { setOwner: u }, { reponse: false });
      journalTache(`nom → ${u.longName} / ${u.shortName}`);
    }
    for (const k of sections) {
      const actuel = (await admin(dest, { getConfigRequest: TYPES_CONFIG[k] })).getConfigResponse[k];
      if (!actuel) throw new Error(`Configuration « ${k} » illisible`);
      await admin(dest, { setConfig: { [k]: { ...actuel, ...valeurs[k] } } }, { reponse: false });
      journalTache(`configuration « ${k} » envoyée (${Object.keys(valeurs[k]).join(', ')})`);
    }
    if (voisinage) {
      const ModuleConfig = racine.lookupType('meshtastic.ModuleConfig');
      const actuel = versObjet(ModuleConfig, (await admin(dest, { getModuleConfigRequest: MODULE_VOISINAGE })).getModuleConfigResponse).neighborInfo || {};
      await admin(dest, { setModuleConfig: { neighborInfo: { ...actuel, ...voisinage } } }, { reponse: false });
      journalTache(`module Voisinage envoyé (${Object.entries(voisinage).map(([k, v]) => k + ' = ' + v).join(', ')})`);
    }
    if (telemetrie) {
      const ModuleConfig = racine.lookupType('meshtastic.ModuleConfig');
      const actuel = versObjet(ModuleConfig, (await admin(dest, { getModuleConfigRequest: MODULE_TELEMETRIE })).getModuleConfigResponse).telemetry || {};
      await admin(dest, { setModuleConfig: { telemetry: { ...actuel, ...telemetrie } } }, { reponse: false });
      journalTache(`module Télémétrie envoyé (${Object.entries(telemetrie).map(([k, v]) => k + ' = ' + v).join(', ')})`);
    }
    if (trafic) {
      const ModuleConfig = racine.lookupType('meshtastic.ModuleConfig');
      const actuel = versObjet(ModuleConfig, (await admin(dest, { getModuleConfigRequest: MODULE_TRAFIC })).getModuleConfigResponse).trafficManagement || {};
      await admin(dest, { setModuleConfig: { trafficManagement: { ...actuel, ...trafic } } }, { reponse: false });
      journalTache(`gestion du trafic envoyée (${Object.entries(trafic).map(([k, v]) => k + ' = ' + v).join(', ')})`);
    }
    if (signature) {
      // Configuration sécurité relue juste avant (clés d'admin conservées ; la clé privée n'est pas transmise à distance)
      const sc = (await admin(dest, { getConfigRequest: TYPES_CONFIG.security })).getConfigResponse.security;
      if (!sc) throw new Error('Configuration sécurité illisible');
      await admin(dest, { setConfig: { security: { ...sc, packetSignaturePolicy: SIGNATURES_ENUM[signature] } } }, { reponse: false });
      journalTache(`politique de signature → ${signature.replace('PACKET_SIGNATURE_POLICY_', '').toLowerCase()}`);
    }
    for (const c of canaux.sort((a, b) => b.index - a.index)) { // les canaux supprimés d'abord, en partant de la fin
      const index = Number(c.index);
      if (!Number.isInteger(index) || index < 0 || index > 7) throw new Error('Canal invalide');
      if (c.supprimer && index === 0) throw new Error('Le canal principal ne peut pas être supprimé');
      const settings = c.supprimer ? {} : {
        name: String(c.nom || '').trim().slice(0, 11), psk: Buffer.from(c.psk || 'AQ==', 'base64'), id: Number(c.id) || 0,
        uplinkEnabled: !!c.montant, downlinkEnabled: !!c.descendant, moduleSettings: { positionPrecision: precisionValide(c.precision) },
      };
      if (!c.supprimer && ![0, 1, 16, 32].includes(settings.psk.length)) throw new Error(`Clé du canal ${index} invalide`);
      if (!c.supprimer && index > 0 && !settings.name) throw new Error(`Le canal ${index} doit avoir un nom`);
      await admin(dest, { setChannel: { index, role: c.supprimer ? 0 : index === 0 ? 1 : 2, settings } }, { reponse: false });
      journalTache(c.supprimer ? `canal ${index} supprimé` : `canal ${index} « ${settings.name || 'preset'} » envoyé`);
    }
    // L'enregistrement fait souvent redémarrer le nœud : son accusé peut se perdre (liaison faible, redémarrage immédiat).
    // Sans accusé, on ne conclut pas à l'échec : la relecture dira si les réglages ont bien été appliqués.
    let sansAccuse = false;
    try {
      await admin(dest, { commitEditSettings: true }, { reponse: false });
      journalTache('modifications enregistrées par le nœud (il peut redémarrer)');
    } catch (e) {
      if (erreurDefinitive(e)) throw e;
      sansAccuse = true;
      journalTache('enregistrement envoyé, sans accusé (le nœud redémarre peut-être) : vérification par relecture…');
    }
    // Relecture de contrôle de ce qui a changé
    await new Promise((r) => setTimeout(r, local ? 15000 : 25000));
    clesSession.delete(dest);
    const aRelire = [...sections, ...(canaux.length ? ['canaux'] : []), ...(p.nom ? ['proprietaire'] : []), ...(voisinage ? ['voisinage'] : []), ...(telemetrie ? ['telemetrie'] : []), ...(trafic ? ['trafic'] : []), ...(signature ? ['securite'] : [])];
    for (let essai = 1; essai <= 3; essai++) {
      try {
        await lire(dest, journalTache, { sections: aRelire });
        // Contrôle des valeurs demandées pour le module Voisinage (cas le plus fréquent d'accusé perdu)
        if (voisinage) {
          const lu = (lectures.get(dest) || {}).voisinage || {};
          const ecarts = Object.entries(voisinage).filter(([k, v]) => (k === 'updateInterval' ? Number(lu[k] || 0) !== Number(v) : !!lu[k] !== !!v));
          if (ecarts.length) throw Object.assign(new Error(`le nœud n’a pas appliqué : ${ecarts.map(([k, v]) => `${k} = ${lu[k] ?? '—'} au lieu de ${v}`).join(', ')}${sansAccuse ? ' (enregistrement sans accusé : il ne l’a sans doute pas reçu, réessayez)' : ' (le firmware refuse peut-être ce réglage)'}`), { definitif: true });
        }
        journalTache(sansAccuse ? 'relecture de contrôle faite : réglages bien appliqués malgré l’accusé perdu' : 'relecture de contrôle faite');
        return { modifie: true, relu: aRelire };
      } catch (e) {
        if (e.definitif) throw e;
        if (e.arret) throw e;
        journalTache(`relecture ${essai}/3 impossible (${e.message.split(' — ')[0]})`);
        await new Promise((r) => setTimeout(r, 15000));
      }
    }
    throw new Error(sansAccuse ? 'Modifications envoyées sans accusé, et relecture impossible : relisez la configuration dans quelques minutes pour savoir si elles sont appliquées' : 'Modifications envoyées et accusées, mais la relecture de contrôle a échoué : relisez la configuration dans quelques minutes');
  }

  // ---- Mise à jour du firmware par le Wi-Fi (module connecté en IP à la carte, ESP32, firmware ≥ 2.7.18) ----
  const ota = require('./ota').creerOta(require('path').dirname(require('./config').fichierBase), journal);
  const versionDe = (v) => { const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')); return m ? [+m[1], +m[2], +m[3]] : null; };
  async function mettreAJourFirmware(dest, p, j) {
    const info = radio.infos(), et = radio.etat();
    // Autre module Wi-Fi (pas celui de la carte) : session directe sur son API TCP
    if (p.hote && p.hote !== et.hote) return mettreAJourModuleIp(p.hote, p, j);
    if (dest >>> 0 !== info.noeudLocal >>> 0) throw Object.assign(new Error('la mise à jour par Wi-Fi ne concerne que le module connecté à la carte'), { code: 99 });
    if (!et.hote || !/^[0-9a-z.-]+$/i.test(et.hote) || !/[.]/.test(et.hote)) throw Object.assign(new Error('ce module est relié à la carte par un agent : choisissez d’abord un autre module dans Réseau › Modules, puis lancez la mise à jour depuis Programmer › Firmware Wi-Fi (l’agent relaiera la mise à jour)'), { code: 99 });
    const hote = et.hote;
    const Meta = racine.lookupType('meshtastic.DeviceMetadata');
    const meta = versObjet(Meta, (await admin(dest, { getDeviceMetadataRequest: true })).getDeviceMetadataResponse);
    const actuelle = versionDe(meta.firmwareVersion);
    j(`module : ${meta.hwModel}, firmware ${meta.firmwareVersion}`);
    if (!actuelle || actuelle[0] < 2 || (actuelle[0] === 2 && (actuelle[1] < 7 || (actuelle[1] === 7 && actuelle[2] < 18)))) throw Object.assign(new Error(`firmware ${meta.firmwareVersion} trop ancien pour la mise à jour par Wi-Fi (2.7.18 au minimum) : faites une première mise à jour en USB avec le flasheur`), { code: 99 });
    if (!meta.hasWifi) throw Object.assign(new Error('ce module n’a pas de Wi-Fi'), { code: 99 });
    const mat = await ota.materiel(meta.hwModel);
    if (!/^esp32/.test(mat.architecture || '')) throw Object.assign(new Error(`${mat.displayName} (${mat.architecture}) : la mise à jour par Wi-Fi n’existe que pour les ESP32`), { code: 99 });
    const version = String(p.version || '').replace(/^v/, '');
    if (String(meta.firmwareVersion).startsWith(version) && !p.forcer) throw Object.assign(new Error(`le module est déjà en ${meta.firmwareVersion}`), { code: 99 });
    j(`téléchargement du firmware ${version} pour ${mat.displayName} (${mat.platformioTarget})…`);
    const bin = await ota.binaire(version, mat.platformioTarget);
    j(`firmware prêt : ${Math.round(bin.data.length / 1024)} ko, empreinte ${bin.hash.toString('hex').slice(0, 12)}…`);
    await admin(dest, { otaRequest: { rebootOtaMode: 2, otaHash: bin.hash } }, { reponse: false }).catch((e) => { if (erreurDefinitive(e)) throw e; });
    j('le module redémarre sur son chargeur Wi-Fi…');
    await new Promise((r) => setTimeout(r, 8000));
    let derniere = null, palier = 0;
    for (let essai = 1; essai <= 12; essai++) {
      if (arrets.has(dest >>> 0)) throw ERREUR_ARRET();
      try {
        await ota.televerser(hote, bin.data, bin.hash, (o, t) => { const pc = Math.floor((o / t) * 10) * 10; if (pc > palier) { palier = pc; j(`envoi : ${pc} %`); } }, () => arrets.has(dest >>> 0));
        derniere = null;
        break;
      } catch (e) {
        if (e.arret) throw e;
        derniere = e;
        if (/refuse/.test(e.message)) break;
        if (essai === 1 || essai % 4 === 0) j(`chargeur OTA pas encore joignable (${e.message}), nouvel essai…`);
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    if (derniere) throw Object.assign(new Error(`envoi impossible : ${derniere.message}. Le module garde son ancien firmware ; s’il ne revient pas seul dans quelques minutes, redémarrez-le (bouton ou alimentation). Si le chargeur Wi-Fi n’a jamais été installé, une mise à jour complète en USB avec le flasheur est nécessaire une première fois.`), { code: 99 });
    j('firmware envoyé et vérifié par le module : redémarrage sur la nouvelle version…');
    // Le module redémarre : la carte s'y reconnecte d'elle-même ; on relit sa version
    const debut = Date.now();
    await new Promise((r) => setTimeout(r, 20000));
    while (Date.now() - debut < 4 * 60000 && !radio.infos().connecte) await new Promise((r) => setTimeout(r, 5000));
    if (!radio.infos().connecte) return { version, nouvelle: null, detail: 'envoyé, mais le module n’est pas encore reconnecté à la carte' };
    try {
      const apres = versObjet(Meta, (await admin(dest, { getDeviceMetadataRequest: true })).getDeviceMetadataResponse);
      j(`module reconnecté : firmware ${apres.firmwareVersion}`);
      const l = lectures.get(dest >>> 0); if (l) { l.materiel = apres; sauverLectures(); }
      return { version, nouvelle: apres.firmwareVersion };
    } catch (e) { return { version, nouvelle: null, detail: 'reconnecté, version non relue (' + e.message + ')' }; }
  }

  async function mettreAJourModuleIp(hote, p, j) {
    if (!/^[0-9a-z.-]+$/i.test(hote)) throw Object.assign(new Error('adresse invalide'), { code: 99 });
    j(`connexion à ${hote}…`);
    const m = await ota.infoModule(hote);
    j(`module : ${m.nom || '!' + (m.num >>> 0).toString(16)}, ${m.hwModel}, firmware ${m.firmware}`);
    const actuelle = versionDe(m.firmware);
    if (!actuelle || actuelle[0] < 2 || (actuelle[0] === 2 && (actuelle[1] < 7 || (actuelle[1] === 7 && actuelle[2] < 18)))) throw Object.assign(new Error(`firmware ${m.firmware} trop ancien pour la mise à jour par Wi-Fi (2.7.18 au minimum) : première mise à jour en USB avec le flasheur`), { code: 99 });
    const mat = await ota.materiel(m.hwModel);
    if (!/^esp32/.test(mat.architecture || '')) throw Object.assign(new Error(`${mat.displayName} : la mise à jour par Wi-Fi n’existe que pour les ESP32`), { code: 99 });
    const version = String(p.version || '').replace(/^v/, '');
    if (String(m.firmware).startsWith(version) && !p.forcer) throw Object.assign(new Error(`le module est déjà en ${m.firmware}`), { code: 99 });
    j(`téléchargement du firmware ${version} pour ${mat.displayName}…`);
    const bin = await ota.binaire(version, mat.platformioTarget);
    j(`firmware prêt : ${Math.round(bin.data.length / 1024)} ko`);
    await ota.declencher(hote, bin.hash);
    j('le module redémarre sur son chargeur Wi-Fi…');
    await new Promise((r) => setTimeout(r, 8000));
    let derniere = null, palier = 0;
    for (let essai = 1; essai <= 12; essai++) {
      try {
        await ota.televerser(hote, bin.data, bin.hash, (o, t) => { const pc = Math.floor((o / t) * 10) * 10; if (pc > palier) { palier = pc; j(`envoi : ${pc} %`); } });
        derniere = null; break;
      } catch (e) {
        derniere = e;
        if (/refuse/.test(e.message)) break;
        if (essai === 1 || essai % 4 === 0) j(`chargeur OTA pas encore joignable (${e.message}), nouvel essai…`);
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    if (derniere) throw Object.assign(new Error(`envoi impossible : ${derniere.message}. Le module garde son ancien firmware ; s’il ne revient pas seul, redémarrez-le. Si le chargeur Wi-Fi n’a jamais été installé, une mise à jour complète en USB est nécessaire une première fois.`), { code: 99 });
    j('firmware envoyé et vérifié : redémarrage du module…');
    for (let k = 0; k < 8; k++) {
      await new Promise((r) => setTimeout(r, 15000));
      try { const apres = await ota.infoModule(hote); j(`module revenu : firmware ${apres.firmware}`); return { version, nouvelle: apres.firmware }; } catch { /* pas encore revenu */ }
    }
    return { version, nouvelle: null, detail: 'envoyé, module pas encore revenu sur le Wi-Fi' };
  }

  // ---- Favoris (« sauts gratuits », firmware 2.7.11+) --------------------------------------------
  // Un ROUTER, ROUTER_LATE ou CLIENT_BASE ne décompte pas le saut d'un paquet relayé par un routeur de ses favoris.
  // Le firmware ne permet pas de relire les favoris à distance : on garde ce qui a été posé (/data/favoris.json).
  const fFavoris = require('path').join(require('path').dirname(require('./config').fichierBase), 'favoris.json');
  let favoris = {};
  try { favoris = JSON.parse(require('fs').readFileSync(fFavoris, 'utf8')); } catch { /* aucun */ }
  const sauverFavoris = () => { try { require('fs').writeFileSync(fFavoris, JSON.stringify(favoris)); } catch { /* lecture seule */ } };
  async function definirFavoris(dest, p, journalTache) {
    dest = dest >>> 0;
    const plan = (p.plan || {})[dest] || (p.plan || {})[String(dest)] || {};
    const ajouter = [...new Set((plan.ajouter || []).map((x) => Number(x) >>> 0))].filter((x) => x && x !== dest);
    const retirer = [...new Set((plan.retirer || []).map((x) => Number(x) >>> 0))].filter((x) => x && x !== dest);
    if (!ajouter.length && !retirer.length) throw new Error('Aucun favori à poser pour ce nœud');
    await assurerSession(dest);
    const k = String(dest);
    favoris[k] = favoris[k] || {};
    for (const f of ajouter) {
      await admin(dest, { setFavoriteNode: f }, { reponse: false });
      favoris[k][f] = { heure: Date.now(), par: p.auteur || null };
      sauverFavoris();
      journalTache(`favori ajouté : ${idNoeud(f)}`);
    }
    for (const f of retirer) {
      await admin(dest, { removeFavoriteNode: f }, { reponse: false });
      delete favoris[k][f];
      sauverFavoris();
      journalTache(`favori retiré : ${idNoeud(f)}`);
    }
    return { ajoutes: ajouter.length, retires: retirer.length };
  }

  async function redemarrer(dest) {
    await assurerSession(dest);
    await admin(dest, { rebootSeconds: 5 }, { reponse: false });
  }

  // ---- Tâches (plusieurs nœuds, suivies depuis la carte) ---------------------------------------
  const OPERATIONS = {
    lire: { nom: 'Lecture de la configuration', f: (d, p, j) => lire(d, j, p) },
    verifier: { nom: 'Vérification de conformité', f: (d, p, j) => verifier(d, p, j) },
    modifier: { nom: 'Modification des réglages', f: (d, p, j) => modifier(d, p, j) },
    canal: { nom: 'Canal', f: (d, p, j) => definirCanal(d, p, j) },
    position: { nom: 'Position fixe', f: definirPosition },
    nom: { nom: 'Nom du nœud', f: definirNom },
    config: { nom: 'Configuration', f: definirConfig },
    redemarrer: { nom: 'Redémarrage', f: redemarrer },
    favoris: { nom: 'Favoris entre relais', f: (d, p, j) => definirFavoris(d, p, j) },
    firmware: { nom: 'Mise à jour du firmware (Wi-Fi)', f: (d, p, j) => mettreAJourFirmware(d, p, j) },
    echanger: { nom: 'Envoi de la fiche du module', f: async (d) => { await enFile(async () => { echangerInfos(d); await new Promise((r) => setTimeout(r, 3000)); }); } },
  };
  function lancer(type, cibles, params, auteur, options = {}) {
    const op = OPERATIONS[type];
    if (!op) throw new Error('Opération inconnue');
    if (!radio.infos().connecte && !(type === 'firmware' && params && params.hote)) throw new Error('Module radio non connecté : connectez-le dans Réseau > Modules Wi-Fi');
    cibles = [...new Set((cibles || []).map((x) => Number(x) >>> 0))].filter(Boolean);
    if (!cibles.length) throw new Error('Aucun nœud choisi');
    if (cibles.length > 30) throw new Error('30 nœuds au maximum par opération');
    if (['position', 'nom', 'lire', 'modifier', 'firmware'].includes(type) && cibles.length > 1) throw new Error('Cette opération se fait nœud par nœud');
    if (type === 'verifier') {
      const ref = Number(params && params.reference) >>> 0;
      if (!ref) throw new Error('Référence manquante');
      if (!(params.elements || []).some((k) => ELEMENTS[k])) throw new Error('Choisissez au moins un élément à vérifier');
      cibles = [ref, ...cibles.filter((c) => c !== ref)]; // la référence est lue en premier
      if (cibles.length < 2) throw new Error('Choisissez au moins un nœud à comparer à la référence');
    }
    if (type === 'favoris') params = { ...(params || {}), auteur };
    const id = crypto.randomBytes(6).toString('hex');
    const tache = { id, type, nom: op.nom, auteur, debut: Date.now(), fin: null, params, insister: !!options.insister && type !== 'firmware', noeuds: cibles.map((num) => ({ num, statut: 'en_attente', detail: null, resultat: null })) };
    taches.set(id, tache);
    if (taches.size > 50) taches.delete(taches.keys().next().value);
    journal(`${op.nom} lancée par ${auteur} sur ${cibles.length} nœud(s)`);
    executerTache(tache);
    return tache;
  }

  // Exécution nœud par nœud ; l'état est enregistré à chaque étape pour reprendre après un redémarrage de la carte
  function executerTache(tache) {
    const { type, params } = tache;
    const op = OPERATIONS[type];
    sauverTaches();
    (async () => {
      for (const n of tache.noeuds) {
        if (n.statut === 'ok' || n.statut === 'echec' || n.statut === 'annule') continue; // déjà traité avant le redémarrage
        if (tache.arret) { n.statut = 'annule'; n.detail = 'non traité (opération arrêtée)'; continue; }
        if (type === 'verifier' && n !== tache.noeuds[0] && tache.noeuds[0].statut !== 'ok') { n.statut = 'annule'; n.detail = 'non vérifié : la référence n’a pas pu être lue'; continue; }
        n.statut = 'en_cours';
        const etapes = [];
        try {
          n.etapes = etapes;
          n.debutNoeud = Date.now();
          const suivi = (t) => { etapes.push(t); n.detail = t; };
          suivis.set(n.num >>> 0, suivi);
          const executer = (reprise) => op.f(n.num, reprise && type === 'lire' ? { ...(params || {}), reprendre: true } : params || {}, suivi);
          try {
            n.resultat = await executer();
          } catch (e) {
            if (e.arret || tache.arret) throw e;
            // Le nœud ne connaît pas encore la clé publique du module : on lui envoie la fiche puis on réessaie
            if (e.code === 36) { clesSession.delete(n.num); n.detail = 'clé de session périmée, nouvel essai…'; }
            else if (e.code === 35 || e.code === 39) {
              n.detail = 'échange des fiches (clés publiques) avec le nœud…';
              await enFile(async () => { echangerInfos(n.num); await new Promise((r) => setTimeout(r, 20000)); });
            } else throw e;
            n.detail = 'nouvel essai…';
            n.resultat = await executer(true); // une lecture reprend là où elle s'était arrêtée
          }
          n.statut = 'ok';
          n.detail = type === 'favoris' ? `${n.resultat.ajoutes} favori(s) posé(s)${n.resultat.retires ? `, ${n.resultat.retires} retiré(s)` : ''}` : type === 'firmware' ? (n.resultat && n.resultat.nouvelle ? `firmware ${n.resultat.nouvelle} installé` : (n.resultat && n.resultat.detail) || 'firmware envoyé') : type === 'modifier' ? 'modifié et relu' : type === 'verifier' ? (n.resultat.reference ? 'référence lue' : n.resultat.conforme ? 'conforme' : `${n.resultat.ecarts.length} écart(s)`) : type === 'lire' ? 'configuration lue' : n.resultat && n.resultat.canal0 ? `canal 0 « ${n.resultat.ancien || 'preset'} » → « ${n.resultat.canal0} », vérifié` : 'appliqué (accusé reçu)';
        } catch (e) {
          if (e.partiel) n.resultat = e.partiel;
          n.statut = e.arret || tache.arret ? 'annule' : 'echec';
          n.definitif = !!(e.garde || erreurDefinitive(e) || /invalide|Confirmation|inconnu/i.test(e.message));
          n.detail = e.code === 35 ? 'le nœud ne connaît toujours pas la clé du module (fiche envoyée, réessayez dans une minute)'
            : e.code === 37 ? 'clé du module absente des clés d’administration de ce nœud' : e.message;
          // Où en était-on ? (ex. pour le canal 0 : avant ou après l'écriture)
          const derniere = n.etapes && [...n.etapes].reverse().find((x) => !x.startsWith('↻'));
          if (derniere && type !== 'lire') n.detail += ` — dernière étape réussie : ${derniere}`;
        }
        suivis.delete(n.num >>> 0);
        arrets.delete(n.num >>> 0);
        if (n.statut === 'echec') n.echecs = (n.echecs || 0) + 1;
        journal(`${op.nom} → ${idNoeud(n.num)} : ${n.statut}${n.detail ? ' (' + n.detail + ')' : ''}`);
        sauverTaches();
      }
      // Mode « insister » : les nœuds en échec passager sont repris toutes les 10 min, pendant 2 h au plus
      // (un mobile qui revient à portée, un relais occupé, un chemin qui se rétablit…)
      const reprendre = tache.insister && !tache.arret ? tache.noeuds.filter((n) => n.statut === 'echec' && !n.definitif) : [];
      if (reprendre.length && Date.now() - tache.debut < 2 * 3600000) {
        const quand = Date.now() + 10 * 60000;
        tache.prochainEssai = quand;
        const hh = new Date(quand).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
        for (const n of reprendre) { n.statut = 'en_attente'; n.detail = `${n.detail} — nouvel essai automatique à ${hh} (${n.echecs} échec(s))`; }
        journal(`${tache.nom} : ${reprendre.length} nœud(s) repris à ${hh}`);
        sauverTaches();
        const attente = setInterval(() => {
          if (tache.arret) {
            clearInterval(attente);
            for (const n of reprendre) if (n.statut === 'en_attente') { n.statut = 'annule'; n.detail = 'non retenté (opération arrêtée)'; }
            tache.prochainEssai = null; tache.fin = Date.now(); sauverTaches();
          } else if (Date.now() >= quand && radio.infos().connecte) {
            clearInterval(attente);
            tache.prochainEssai = null;
            executerTache(tache);
          }
        }, 5000);
        if (attente.unref) attente.unref();
        return;
      }
      tache.prochainEssai = null;
      tache.fin = Date.now();
      sauverTaches();
    })();
  }

  // ---- Clés d'administration : quels modules de la carte peuvent programmer quel relais ----------------------
  const fModules = require('path').join(require('path').dirname(require('./config').fichierBase), 'modules-cles.json');
  let modulesCles = {};
  try { modulesCles = JSON.parse(require('fs').readFileSync(fModules, 'utf8')); } catch { /* aucun */ }
  function noterModuleLocal() {
    const i = radio.infos();
    if (!i.connecte || !i.clePublique || !i.noeudLocal) return;
    const k = String(i.noeudLocal >>> 0), u = i.utilisateurLocal || {};
    const e = modulesCles[k];
    if (e && e.cle === i.clePublique && Date.now() - (e.vu || 0) < 3600000) return;
    modulesCles[k] = { cle: i.clePublique, nom: u.longName || u.nomLong || (e && e.nom) || idNoeud(i.noeudLocal), vu: Date.now() };
    try { require('fs').writeFileSync(fModules, JSON.stringify(modulesCles)); } catch { /* lecture seule */ }
  }
  const minuterieModules = setInterval(noterModuleLocal, 30000);
  if (minuterieModules.unref) minuterieModules.unref();
  function noterCles() { noterModuleLocal(); }
  // Pour chaque nœud : modules autorisés (d'après la lecture « sécurité »), essais réussis / refusés, emplacements libres
  function etatCles(nums, nomDe = (num, d) => d) {
    noterModuleLocal();
    const modules = Object.entries(modulesCles).map(([num, m]) => ({ num: Number(num), ...m, nom: nomDe(Number(num), m.nom) }));
    // Modules déjà utilisés pour programmer, mais pas encore reconnectés depuis cette version (clé inconnue)
    for (const e of Object.values(administrables)) for (const num of e.modules || []) if (num && !modules.some((m) => m.num === num)) modules.push({ num, cle: null, nom: nomDe(num, idNoeud(num)) });
    return nums.map((num) => {
      const a = administrables[num] || {}, l = lectures.get(num) || {}, sec = l.securite || null;
      const parModule = modules.map((m) => {
        // Anciennes entrées sans détail par module : le dernier résultat vaut pour les modules qui ont essayé
        const essai = (a.parModule || {})[m.num] || (!a.parModule && (a.modules || []).includes(m.num) && a.ok != null ? { ok: a.ok, heure: a.heure } : null);
        const dansCles = sec && m.cle ? sec.adminKeys.includes(m.cle) : null;
        return { num: m.num, nom: m.nom, autorise: dansCles === true || (essai && essai.ok) ? true : dansCles === false || (essai && !essai.ok) ? false : null, essai, dansCles };
      });
      const inconnues = sec ? sec.adminKeys.filter((k) => !modules.some((m) => m.cle === k)).length : null;
      const aFaire = [];
      const refuses = parModule.filter((m) => m.autorise === false);
      if (sec && sec.adminKeys.length >= 3 && refuses.length) aFaire.push(`les 3 emplacements de clé sont pris : en retirer une pour ajouter ${refuses.map((m) => m.nom).join(', ')}`);
      else if (refuses.length) aFaire.push(`ajouter la clé de ${refuses.map((m) => m.nom).join(', ')} (Sécurité › Clé d’administration, en Bluetooth ou USB)`);
      if (!parModule.some((m) => m.autorise)) aFaire.length || aFaire.push('aucun module n’a encore pu le programmer : tester depuis Programmer, sinon ajouter la clé sur place');
      return { num, securite: sec ? { nbCles: sec.adminKeys.length, libres: Math.max(0, 3 - sec.adminKeys.length), inconnues, gere: sec.gere, lu: l.heure } : null, global: a.ok == null ? null : { ok: a.ok, heure: a.heure }, modules: parModule, aFaire };
    });
  }

  // ---- Conformité automatique : la même vérification chaque nuit (/data/conformite-auto.json) ----------------
  const fConf = require('path').join(require('path').dirname(require('./config').fichierBase), 'conformite-auto.json');
  let conf = { actif: false, heure: 2, reference: null, mode: 'admin', cibles: [], elements: ['canaux', 'precision', 'frequence', 'preset', 'rediffusion'], dernier: null, tache: null };
  try { conf = { ...conf, ...JSON.parse(require('fs').readFileSync(fConf, 'utf8')) }; } catch { /* aucune */ }
  const sauverConf = () => { try { require('fs').writeFileSync(fConf, JSON.stringify(conf)); } catch { /* lecture seule */ } };
  function ciblesConf() {
    const l = conf.mode === 'liste' ? conf.cibles : Object.entries(administrables).filter(([, v]) => v.ok).map(([k]) => Number(k));
    return l.filter((k) => k && k !== (conf.reference >>> 0) && k !== (radio.infos().noeudLocal >>> 0));
  }
  function lancerConformite(auteur = 'automatique') {
    if (!conf.reference) throw new Error('aucune référence choisie');
    const cibles = ciblesConf();
    if (!cibles.length) throw new Error('aucun nœud à vérifier');
    const t = lancer('verifier', cibles, { reference: conf.reference, elements: conf.elements, ageMaxHeures: 0 }, auteur);
    conf.tache = t.id; conf.lancee = Date.now(); sauverConf();
    return t;
  }
  // Résumé de la dernière vérification automatique, une fois terminée
  function resumerConformite() {
    const t = conf.tache && taches.get(conf.tache);
    if (!t || !t.fin || (conf.dernier && conf.dernier.tache === t.id)) return;
    const [ref, ...autres] = t.noeuds;
    conf.dernier = {
      tache: t.id, date: t.fin, reference: ref.num, referenceLue: ref.statut === 'ok',
      conformes: autres.filter((n) => n.statut === 'ok' && n.resultat && n.resultat.conforme).map((n) => n.num),
      ecarts: autres.filter((n) => n.statut === 'ok' && n.resultat && !n.resultat.conforme).map((n) => ({ num: n.num, ecarts: (n.resultat.ecarts || []).slice(0, 12) })),
      nonLus: autres.filter((n) => n.statut !== 'ok').map((n) => ({ num: n.num, raison: n.detail })),
    };
    sauverConf();
    journal(`conformité automatique : ${conf.dernier.conformes.length} conforme(s), ${conf.dernier.ecarts.length} avec écarts, ${conf.dernier.nonLus.length} non lu(s)`);
  }
  const minuterieConf = setInterval(() => {
    resumerConformite();
    if (!conf.actif) return;
    const h = Number(new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }).slice(0, 2));
    if (h !== conf.heure || (conf.lancee && Date.now() - conf.lancee < 20 * 3600000) || !radio.infos().connecte) return;
    try { lancerConformite(); journal('conformité automatique lancée'); } catch (e) { journal('conformité automatique :', e.message); conf.lancee = Date.now(); sauverConf(); }
  }, 5 * 60000);
  if (minuterieConf.unref) minuterieConf.unref();

  // ---- Tâches persistantes : /data/taches-admin.json (les paramètres peuvent contenir des clés de canal : fichier privé)
  const fTaches = require('path').join(require('path').dirname(require('./config').fichierBase), 'taches-admin.json');
  let minuterieSauvegarde = null;
  function sauverTaches() {
    clearTimeout(minuterieSauvegarde);
    minuterieSauvegarde = setTimeout(() => {
      try {
        const l = [...taches.values()].map(({ arret, ...t }) => ({ ...t, noeuds: t.noeuds.map(({ etapes, ...n }) => n) }));
        require('fs').writeFileSync(fTaches, JSON.stringify(l), { mode: 0o600 });
      } catch { /* lecture seule */ }
    }, 500);
  }
  // Au démarrage : les opérations interrompues (moins de 6 h) reprennent dès que le module radio est connecté
  try {
    const l = JSON.parse(require('fs').readFileSync(fTaches, 'utf8'));
    const aReprendre = [];
    for (const t of l) {
      if (!OPERATIONS[t.type]) continue;
      if (!t.fin) {
        if (Date.now() - t.debut < 6 * 3600000 && t.type !== 'firmware') {
          for (const n of t.noeuds) if (n.statut === 'en_cours' || n.statut === 'en_attente') { n.statut = 'en_attente'; n.detail = 'reprise après le redémarrage de la carte…'; }
          t.reprises = (t.reprises || 0) + 1;
          aReprendre.push(t);
        } else {
          for (const n of t.noeuds) if (n.statut === 'en_cours' || n.statut === 'en_attente') { n.statut = 'annule'; n.detail = 'interrompu par un redémarrage de la carte (trop ancien pour reprendre)'; }
          t.fin = Date.now();
        }
      }
      taches.set(t.id, t);
    }
    if (aReprendre.length) {
      journal(`${aReprendre.length} opération(s) interrompue(s) par le redémarrage : reprise dès que le module radio est connecté`);
      const debut = Date.now();
      const attendre = setInterval(() => {
        if (radio.infos().connecte) {
          clearInterval(attendre);
          for (const t of aReprendre) { journal(`${t.nom} reprise (${t.noeuds.filter((n) => n.statut === 'en_attente').length} nœud(s) restant(s))`); executerTache(t); }
        } else if (Date.now() - debut > 30 * 60000) {
          clearInterval(attendre);
          for (const t of aReprendre) { for (const n of t.noeuds) if (n.statut === 'en_attente') { n.statut = 'annule'; n.detail = 'module radio non reconnecté dans les 30 min après le redémarrage'; } t.fin = Date.now(); }
          sauverTaches();
        }
      }, 5000);
      attendre.unref && attendre.unref();
    }
  } catch { /* aucune tâche enregistrée */ }

  function resumeParams(t) {
    const p = t.params || {};
    if (t.type === 'canal') return p.role === 'DISABLED' ? `suppression du canal ${p.index}` : `canal ${p.index} « ${p.nom || ''} »${Number(p.index) === 0 ? ' (principal)' : ''}`;
    if (t.type === 'config') return `${p.section} : ${Object.entries(p.valeurs || {}).map(([k, v]) => k + '=' + v).join(', ')}`;
    if (t.type === 'nom') return [p.nomLong, p.nomCourt].filter(Boolean).join(' / ');
    if (t.type === 'modifier') return [p.modele ? `modèle « ${p.modele} »` : '', p.nom ? 'nom' : '', p.voisinage ? 'voisinage (' + Object.keys(p.voisinage).join(', ') + ')' : '', p.telemetrie ? 'télémétrie' : '', p.trafic ? 'gestion du trafic' : '', p.securite ? 'signature' : '', ...['device', 'lora', 'position'].filter((k) => p[k] && Object.keys(p[k]).length).map((k) => k + ' (' + Object.keys(p[k]).join(', ') + ')'), p.canaux && p.canaux.length ? 'canaux ' + p.canaux.map((c) => c.index).join(', ') : ''].filter(Boolean).join(' · ');
    if (t.type === 'verifier') return `référence ${idNoeud(p.reference)} · ${(p.elements || []).map((k) => (ELEMENTS[k] || {}).nom || k).join(', ')}`;
    if (t.type === 'firmware') return `vers ${p.version}`;
    if (t.type === 'favoris') { const v = Object.values(p.plan || {}); return `${v.reduce((a, x) => a + (x.ajouter || []).length, 0)} favori(s) à poser sur ${v.length} relais`; }
    if (t.type === 'position') return p.retirer ? 'retrait de la position fixe' : `${p.lat}, ${p.lon}`;
    return '';
  }

  // Nouvel essai d'une opération terminée, avec les mêmes réglages, sur les nœuds en échec ou arrêtés seulement.
  // Une lecture reprend là où elle s'était arrêtée.
  function relancer(id, auteur, options = {}) {
    const t = taches.get(id);
    if (!t) throw new Error('Opération introuvable (la carte a peut-être redémarré) : relancez-la depuis le formulaire');
    if (!t.fin) throw new Error('Opération encore en cours');
    const cibles = t.noeuds.filter((n) => n.statut === 'echec' || n.statut === 'annule').map((n) => n.num);
    if (!cibles.length) throw new Error('Aucun nœud en échec à relancer');
    const params = t.type === 'lire' ? { ...(t.params || {}), reprendre: true } : t.params;
    return lancer(t.type, cibles, params, auteur, options);
  }

  // Arrêt d'une opération en cours : la demande radio en attente est abandonnée tout de suite,
  // les nœuds suivants ne sont pas traités. Une lecture garde ce qui a déjà été lu (« Reprendre » plus tard).
  function arreter(id, auteur) {
    const t = taches.get(id);
    if (!t) throw new Error('Opération inconnue');
    if (t.fin) return t;
    t.arret = true;
    journal(`${t.nom} arrêtée par ${auteur}`);
    for (const n of t.noeuds) {
      if (n.statut !== 'en_cours') continue;
      arrets.add(n.num >>> 0);
      n.detail = 'arrêt en cours…';
      for (const [idp, a] of attentes) {
        if (a.dest !== (n.num >>> 0)) continue;
        clearTimeout(a.minuterie); attentes.delete(idp); a.reject(ERREUR_ARRET());
      }
    }
    return t;
  }

  // ---- Messages texte ---------------------------------------------------------------------
  const envois = new Map(); // id -> { statut, dest, heure }
  radio.ecouter((p) => {
    const d = p.decoded;
    if (!d || d.portnum !== PORT_ROUTAGE || !d.requestId || !envois.has(d.requestId)) return;
    const e = envois.get(d.requestId);
    const code = Routing.decode(d.payload).errorReason || 0;
    const de = p.from >>> 0;
    if (code) { e.statut = 'echec'; e.detail = ERREURS_ROUTAGE[code] || `erreur ${code}`; }
    else if (de === e.dest) e.statut = 'recu'; // accusé du destinataire (message direct)
    else if (e.statut !== 'recu') e.statut = 'relaye'; // un voisin a retransmis (accusé implicite)
  });
  function envoyerTexte({ texte, canal, dest }, auteur) {
    const info = radio.infos();
    if (!info.connecte) throw new Error('Module radio non connecté');
    texte = String(texte || '').trim();
    const octets = Buffer.from(texte, 'utf8');
    if (!octets.length) throw new Error('Message vide');
    if (octets.length > 200) throw new Error(`Message trop long (${octets.length} octets, 200 au maximum)`);
    const direct = dest != null && dest !== '' && Number(dest) >>> 0 !== 0xffffffff;
    const vers = direct ? Number(dest) >>> 0 : 0xffffffff;
    const index = direct ? 0 : Number(canal);
    if (!direct && !info.canaux.some((c) => c.index === index)) throw new Error('Canal inconnu du module');
    const id = crypto.randomBytes(4).readUInt32LE(0) >>> 0 || 1;
    const paquet = { from: info.noeudLocal, to: vers, id, channel: index, wantAck: true, hopLimit: info.hopLimit, decoded: { portnum: 1, payload: octets } };
    radio.envoyerPaquet({ to: vers, id, channel: index, wantAck: true, hopLimit: info.hopLimit, decoded: { portnum: 1, payload: octets } });
    envois.set(id, { statut: 'envoye', dest: vers, heure: Date.now() });
    if (envois.size > 200) envois.delete(envois.keys().next().value);
    try { radio.injecter({ ...paquet, rxTime: Math.floor(Date.now() / 1000), hopStart: info.hopLimit }); } catch (e) { journal('enregistrement du message :', e.message); }
    journal(`message ${direct ? 'direct vers ' + idNoeud(vers) : 'sur le canal ' + index} envoyé par ${auteur}`);
    return { id, dest: vers, canal: index };
  }

  return {
    envoyerTexte,
    etatEnvoi: (id) => envois.get(Number(id) >>> 0) || null,
    canaux: () => radio.infos().canaux,
    lancer,
    // Pendant une lecture, le résultat partiel est fourni au fur et à mesure
    tache: (id) => {
      const t = taches.get(id);
      if (!t) return null;
      if (t.type !== 'lire' || t.fin) return t;
      return { ...t, noeuds: t.noeuds.map((n) => (n.statut === 'en_cours' && lectures.has(n.num >>> 0) ? { ...n, resultat: construireResultat(n.num >>> 0, lectures.get(n.num >>> 0)) } : n)) };
    },
    arreter,
    relancer,
    ELEMENTS: Object.fromEntries(Object.entries(ELEMENTS).map(([k, v]) => [k, v.nom])),
    administrables: () => administrables,
    favoris: () => favoris,
    // Nœud renuméroté (2.8) : son état d'administration, sa dernière lecture et ses favoris suivent le nouveau numéro
    renumeroter(ancien, nouveau) {
      const a = String(ancien >>> 0), n = String(nouveau >>> 0);
      if (administrables[a] && !administrables[n]) { administrables[n] = administrables[a]; delete administrables[a]; try { require('fs').writeFileSync(fAdmin, JSON.stringify(administrables)); } catch { /* lecture seule */ } }
      if (lectures.has(ancien >>> 0) && !lectures.has(nouveau >>> 0)) { lectures.set(nouveau >>> 0, lectures.get(ancien >>> 0)); lectures.delete(ancien >>> 0); sauverLectures(); }
      if (favoris[a] && !favoris[n]) { favoris[n] = favoris[a]; delete favoris[a]; }
      for (const f of Object.values(favoris)) if (f[a]) { f[n] = f[a]; delete f[a]; }
      sauverFavoris();
    },
    SIGNATURES: Object.keys(SIGNATURES_ENUM),
    etatCles,
    modulesCles: () => modulesCles,
    lecturesConnues: () => [...lectures.entries()].map(([num, l]) => ({ num, heure: l.heure, complete: !!(l.canauxFin && l.lora && l.device) })),
    taches: () => [...taches.values()].reverse().map((t) => ({ ...t, params: undefined, resume: resumeParams(t), noeuds: t.noeuds.map(({ resultat, etapes, ...n }) => ({ ...n, partiel: !!resultat })) })),
    infoModuleIp: (hote) => ota.infoModule(hote),
    utiliserAgents: (a) => ota.utiliserAgents(a),
    conformite: () => { resumerConformite(); return { ...conf, ciblesEffectives: ciblesConf() }; },
    reglerConformite(b) {
      if (b.reference != null) conf.reference = Number(b.reference) >>> 0;
      if (b.actif != null) conf.actif = !!b.actif;
      if (b.heure != null) conf.heure = Math.min(23, Math.max(0, Number(b.heure) || 2));
      if (b.mode) conf.mode = b.mode === 'liste' ? 'liste' : 'admin';
      if (Array.isArray(b.cibles)) conf.cibles = b.cibles.map((x) => Number(x) >>> 0).filter(Boolean).slice(0, 30);
      if (Array.isArray(b.elements)) conf.elements = b.elements.filter((k) => ELEMENTS[k]);
      sauverConf();
      return conf;
    },
    lancerConformite,
    infos: () => {
      const i = radio.infos();
      return { connecte: i.connecte, noeudLocal: i.noeudLocal, clePublique: i.clePublique, clesConnues: [...i.clesPubliques.keys()] };
    },
    ROLES: Object.keys(ROLES_ENUM),
    PRESETS: Object.keys(PRESETS_ENUM),
    REDIFFUSIONS: Object.keys(REDIFFUSION_ENUM),
    etatLecture,
    detailLecture: (num) => { const l = lectures.get(num >>> 0); return l ? construireResultat(num >>> 0, l) : null; },
    REGIONS: Object.keys(REGIONS_ENUM).filter((r) => r !== 'UNSET'),
  };
}

module.exports = { creerAdministration };
