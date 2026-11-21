'use strict';
// Banc d'essai de réactivité : remplit une base SQLite de test avec un volume réaliste (flux msh/EU_868 entier,
// MeshCore national) puis chronomètre les traitements qui tournent pendant que la carte sert ses visiteurs :
// état toutes les 30 s (alertes, statistiques), liste des nœuds, purge horaire, décodage d'un message MQTT…
//
//   node outils/banc-reactivite.js /chemin/essai.db [--remplir] [--noeuds 12000] [--paquets 400000]
//
// --remplir recrée la base (sinon elle est réutilisée telle quelle). Rien n'est envoyé sur le réseau.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const fichier = args.find((a) => !a.startsWith('--') && /\.db$/.test(a)) || path.join(require('os').tmpdir(), 'banc-reactivite.db');
const opt = (nom, defaut) => { const i = args.indexOf('--' + nom); return i >= 0 ? Number(args[i + 1]) : defaut; };
const remplir = args.includes('--remplir') || !fs.existsSync(fichier);
const NB_NOEUDS = opt('noeuds', 12000), NB_PAQUETS = opt('paquets', 400000);
const NB_MC_NOEUDS = opt('mc-noeuds', 5000), NB_MC_PAQUETS = opt('mc-paquets', 150000);

process.env.FICHIER_BASE = fichier;
process.env.DEPARTEMENT = process.env.DEPARTEMENT || '43';
process.env.MESHCORE = 'oui';
const config = require('../src/config');
if (remplir) for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(fichier + s); } catch { /* absent */ } }
const { creerStockage } = require('../src/base');
const { creerReseau } = require('../src/reseau');
const { creerReseauMc } = require('../src/meshcore/reseau');
const stockage = creerStockage(fichier);
const reseau = creerReseau(stockage, config);
const reseauMc = creerReseauMc(stockage.db, config, []);
const db = stockage.db;

const JOUR = 86400000, maintenant = Date.now();
const alea = (a, b) => a + Math.random() * (b - a);
const entier = (a, b) => Math.floor(alea(a, b + 1));
const choix = (l) => l[Math.floor(Math.random() * l.length)];

function chrono(nom, fn) {
  const t = process.hrtime.bigint();
  const r = fn();
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`${nom.padEnd(58)} ${ms.toFixed(1).padStart(9)} ms`);
  return { r, ms };
}

if (remplir) {
  console.log(`Remplissage de ${fichier} : ${NB_NOEUDS} nœuds, ${NB_PAQUETS} paquets Meshtastic, ${NB_MC_NOEUDS} nœuds et ${NB_MC_PAQUETS} paquets MeshCore…`);
  const retention = config.retentionJours * JOUR;
  const nums = [];
  db.transaction(() => {
    const ins = db.prepare(`INSERT OR IGNORE INTO noeuds (num, id, nom_long, nom_court, role, lat, lon, premier_vu, dernier_vu, batterie, tension, canal, emission, heure_telemetrie, est_passerelle, dernier_vu_passerelle, stats_locales)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < NB_NOEUDS; i++) {
      const num = crypto.randomBytes(4).readUInt32LE(0) >>> 0; nums.push(num);
      const vu = maintenant - Math.random() ** 2 * retention;
      const gw = Math.random() < 0.08 ? 1 : 0;
      ins.run(num, '!' + num.toString(16).padStart(8, '0'), 'Nœud essai ' + i, 'E' + (i % 1000), choix(['CLIENT', 'CLIENT', 'CLIENT_MUTE', 'ROUTER', 'CLIENT_BASE']),
        Math.random() < 0.7 ? alea(42, 52) : null, alea(-5, 15), vu - JOUR, vu, entier(10, 101), alea(3.3, 4.2), alea(0, 40), alea(0, 12), vu, gw, gw ? vu : null,
        Math.random() < 0.1 ? JSON.stringify({ uptimeSeconds: 1000, channelUtilization: 12.3, airUtilTx: 1.2, numPacketsTx: 100, numPacketsRx: 900, numOnlineNodes: 80, numTotalNodes: 300 }) : null);
    }
  })();
  const passerelles = nums.filter(() => Math.random() < 0.08);
  const ports = ['position', 'telemetrie', 'nodeinfo', 'texte', 'voisinage', 'chiffre', 'mapreport'];
  let lot = 0;
  const insP = db.prepare(`INSERT OR IGNORE INTO paquets (id_paquet, de, vers, canal, port, nom_port, portnum, heure, hop_depart, hop_restant, sauts, dechiffre, resume, nb_receptions, taille, via_mqtt)
    VALUES (?, ?, 4294967295, 'LongFast', ?, ?, 1, ?, 3, ?, ?, 1, 'essai', ?, 60, 0)`);
  const insR = db.prepare('INSERT OR IGNORE INTO receptions (paquet, passerelle, heure, snr, rssi, sauts, relais) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insT = db.prepare('INSERT INTO telemetrie (num, heure, batterie, tension, canal, emission) VALUES (?, ?, ?, ?, ?, ?)');
  const insPos = db.prepare('INSERT INTO positions (num, heure, lat, lon, alt) VALUES (?, ?, ?, ?, ?)');
  while (lot < NB_PAQUETS) {
    db.transaction(() => {
      for (let k = 0; k < 20000 && lot < NB_PAQUETS; k++, lot++) {
        // Une heure de plus que la rétention : de quoi mesurer une purge horaire réaliste
        const heure = maintenant - (retention + 3600000) * (1 - lot / NB_PAQUETS);
        const port = choix(ports), sauts = entier(0, 3);
        const nbR = entier(1, 3);
        const r = insP.run(entier(1, 2 ** 31), choix(nums), port, port.toUpperCase(), heure, 3 - sauts, sauts, nbR);
        for (let j = 0; j < nbR; j++) insR.run(r.lastInsertRowid, choix(passerelles), heure, alea(-20, 10), entier(-130, -60), sauts, entier(0, 255));
        if (port === 'telemetrie') insT.run(choix(nums), heure, entier(10, 100), alea(3.3, 4.2), alea(0, 40), alea(0, 10));
        if (port === 'position' && Math.random() < 0.5) insPos.run(choix(nums), heure, alea(42, 52), alea(-5, 15), 300);
      }
    })();
  }
  db.transaction(() => {
    const insL = db.prepare('INSERT OR IGNORE INTO liens (a, b, source, snr, rssi, nb, premier_vu, dernier_vu) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < NB_NOEUDS * 2.5; i++) { const h = maintenant - Math.random() * (retention + 3600000); insL.run(choix(nums), choix(nums), choix(['rf', 'voisinage', 'traceroute']), alea(-20, 10), -100, entier(1, 50), h - JOUR, h); }
  })();
  // MeshCore : nœuds, paquets (2 jours), réceptions par plusieurs observateurs, liens déduits des chemins
  const cles = [];
  db.transaction(() => {
    const ins = db.prepare('INSERT OR IGNORE INTO mc_noeuds (cle, nom, role, lat, lon, premier_vu, dernier_vu, derniere_annonce, observateur, observateur_vu, details_observateur) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < NB_MC_NOEUDS; i++) {
      const cle = crypto.randomBytes(32).toString('hex').toUpperCase(); cles.push(cle);
      const vu = maintenant - Math.random() ** 2 * retention, obs = Math.random() < 0.06 ? 1 : 0;
      ins.run(cle, 'MC essai ' + i, choix(['repeteur', 'companion', 'companion', 'salon', 'capteur']), Math.random() < 0.8 ? alea(42, 51) : null, alea(-4, 8), vu - JOUR, vu, vu, obs, obs ? vu : null, obs ? JSON.stringify({ modele: 'Heltec V3', firmware: '1.9', iata: 'LPY' }) : null);
    }
  })();
  const observateurs = cles.filter(() => Math.random() < 0.06);
  const insMp = db.prepare(`INSERT OR IGNORE INTO mc_paquets (hachage, heure, type, route, de, de_prefixe, taille, chemin, sauts, nb_receptions, brut, resume)
    VALUES (?, ?, ?, 'FLOOD', ?, ?, 80, ?, ?, ?, ?, 'essai')`);
  const insMr = db.prepare('INSERT OR IGNORE INTO mc_receptions (paquet, observateur, heure, snr, rssi, chemin, dernier_saut, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const retMc = config.meshcore.retentionPaquetsJours * JOUR;
  for (let lotMc = 0; lotMc < NB_MC_PAQUETS;) {
    db.transaction(() => {
      for (let k = 0; k < 20000 && lotMc < NB_MC_PAQUETS; k++, lotMc++) {
        const heure = maintenant - (retMc + 3600000) * (1 - lotMc / NB_MC_PAQUETS);
        const chemin = JSON.stringify(Array.from({ length: entier(0, 5) }, () => crypto.randomBytes(1).toString('hex').toUpperCase()));
        const de = choix(cles), nbR = entier(1, 4);
        const r = insMp.run(crypto.randomBytes(8).toString('hex').toUpperCase(), heure, choix(['ADVERT', 'GRP_TXT', 'TXT_MSG', 'ACK', 'PATH', 'REQ']), de, de.slice(0, 2), chemin, entier(0, 5), nbR, crypto.randomBytes(60).toString('hex'));
        for (let j = 0; j < nbR; j++) insMr.run(r.lastInsertRowid, choix(observateurs), heure, alea(-15, 12), entier(-125, -50), chemin, null, 'mqtt');
      }
    })();
  }
  db.transaction(() => {
    const insL = db.prepare('INSERT OR IGNORE INTO mc_liens (a, b, source, snr, rssi, nb, premier_vu, dernier_vu) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < NB_MC_NOEUDS * 3; i++) { const h = maintenant - Math.random() * retention; insL.run(choix(cles), choix(cles), 'chemin', alea(-15, 12), null, entier(1, 40), h - JOUR, h); }
  })();
  db.pragma('wal_checkpoint(TRUNCATE)');
  console.log(`Base remplie : ${Math.round(fs.statSync(fichier).size / 1048576)} Mo`);
}

// ---- Mesures ----
const compte = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
console.log(`\nBase ${fichier} (${Math.round(fs.statSync(fichier).size / 1048576)} Mo) : ${compte('noeuds')} nœuds, ${compte('paquets')} paquets, ${compte('receptions')} réceptions · MeshCore ${compte('mc_noeuds')} nœuds, ${compte('mc_paquets')} paquets, ${compte('mc_receptions')} réceptions\n`);
const resultats = {};
const m = (nom, fn) => { const x = chrono(nom, fn); resultats[nom] = x.ms; return x.r; };
m('Meshtastic : calculerAlertes()', () => reseau.calculerAlertes());
m('Meshtastic : statistiques()', () => reseau.statistiques());
m('MeshCore : statistiques()', () => reseauMc.statistiques());
m('MeshCore : calculerAlertes()', () => reseauMc.calculerAlertes());
const etat = m('Diffusion de l’état : JSON.stringify', () => JSON.stringify({ genre: 'etat', stats: reseau.statistiques(), alertes: reseau.calculerAlertes() }));
console.log(`   (état diffusé : ${Math.round(etat.length / 1024)} ko)`);
const liste = m('GET /api/noeuds : lecture + vue + JSON', () => JSON.stringify(stockage.q.noeuds.all().map((n) => reseau.vueNoeud(n, true, Date.now()))));
console.log(`   (réponse : ${Math.round(liste.length / 1024)} ko)`);
if (reseau.noeudsDepuis) m('GET /api/noeuds?depuis=30 s (incrémental)', () => JSON.stringify(reseau.noeudsDepuis(Date.now() - 30000, true)));
m('GET /api/mc/noeuds : lecture + vue + JSON', () => JSON.stringify(reseauMc.q.noeuds.all().map((n) => reseauMc.vueNoeud(n, true, Date.now()))));
m('GET /api/liens?heures=24', () => JSON.stringify(reseau.liens(24 * 3600000)));
// Écrans interrogés régulièrement par chaque carte ouverte
const nouveaux = require('../src/nouveaux').creerNouveaux(stockage, config, reseau);
m('GET /api/noeuds-nouveaux?jours=7 (toutes les 5 min)', () => JSON.stringify(nouveaux.lister(7)));
const asym = require('../src/asymetrie').creerAsymetrie(stockage, config, {});
m('GET /api/liaisons/asymetrie (toutes les 2 min)', () => JSON.stringify(asym.calculer()));

// Message Meshtastic relayé (relay_node connu) : recherche du relais
const unNum = db.prepare('SELECT num FROM noeuds WHERE est_passerelle = 1 AND lat IS NOT NULL LIMIT 1').get().num;
m('Intégration de 100 paquets relayés (trouverRelais)', () => { for (let i = 0; i < 100; i++) reseau.integrer({ genre: 'paquet', idPaquet: entier(1, 2 ** 31), de: unNum + 1, vers: 0xffffffff, port: 'texte', canal: 'LongFast', sauts: 1, relais: entier(0, 255), numPasserelle: unNum, snr: 1, rssi: -100, heure: Date.now() }); });

// Messages MeshCore hors périmètre : lecture du message MQTT puis rejet
const { lireMessageMc } = require('../src/meshcore/mqtt');
const corps = Buffer.from(JSON.stringify({ origin: 'obs', origin_id: 'AB'.repeat(32), timestamp: new Date().toISOString(), type: 'PACKET', direction: 'rx', raw: crypto.randomBytes(80).toString('hex'), SNR: '5', RSSI: '-90' }));
m('MeshCore : 1000 messages hors périmètre (lecture + test)', () => { for (let i = 0; i < 1000; i++) { const x = lireMessageMc(`meshcore/XXX/${'AB'.repeat(32)}/packets`, corps); reseauMc.positionDe(x.cle); } });

// Purge horaire réaliste : une heure de trafic msh/EU_868 expirée (≈ 50 000 paquets, 2 réceptions chacun) ajoutée
// juste avant la mesure. Temps total, et plus long blocage de la carte pendant la purge.
const EXPIRES = opt('expires', 50000);
db.transaction(() => {
  const vieux = maintenant - (config.retentionJours * JOUR + 1800000);
  const insP = db.prepare("INSERT INTO paquets (id_paquet, de, vers, canal, port, heure, resume) VALUES (?, ?, 4294967295, 'LongFast', 'position', ?, 'vieux')");
  const insR = db.prepare('INSERT OR IGNORE INTO receptions (paquet, passerelle, heure, snr, rssi) VALUES (?, ?, ?, 0, -100)');
  for (let i = 0; i < EXPIRES; i++) { const r = insP.run(2 ** 31 + i, 1 + (i % 5000), vieux); insR.run(r.lastInsertRowid, 1, vieux); insR.run(r.lastInsertRowid, 2, vieux); }
})();
db.pragma('wal_checkpoint(TRUNCATE)');
const { monitorEventLoopDelay } = require('perf_hooks');
(async () => {
  const delai = monitorEventLoopDelay({ resolution: 10 }); delai.enable();
  const t0 = process.hrtime.bigint();
  let bloque = 0;
  const r = stockage.purger(config.retentionJours, config.messagesRetentionJours);
  bloque = Number(process.hrtime.bigint() - t0) / 1e6;
  const n = await r;
  const total = Number(process.hrtime.bigint() - t0) / 1e6;
  delai.disable();
  console.log(`${'Purge Meshtastic (' + n + ' lignes) : durée totale'.padEnd(58)} ${total.toFixed(1).padStart(9)} ms`);
  console.log(`${'   … plus long blocage de la boucle pendant la purge'.padEnd(58)} ${(typeof r.then === 'function' ? delai.max / 1e6 : bloque).toFixed(1).padStart(9)} ms`);
  resultats.purgeTotale = total; resultats.purgeBlocage = typeof r.then === 'function' ? delai.max / 1e6 : bloque;
  m('Purge MeshCore reseauMc.purger() (temps bloquant)', () => reseauMc.purger(config.retentionJours, config.meshcore.retentionPaquetsJours));
  m('Nettoyage reseau.nettoyer()', () => reseau.nettoyer());
  if (args.includes('--json')) console.log(JSON.stringify(resultats));
  // Laisser finir la purge MeshCore par lots avant de fermer la base
  setTimeout(() => { db.close(); }, 15000).unref();
})();
