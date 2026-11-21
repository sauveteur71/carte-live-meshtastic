'use strict';
// Santé de la carte elle-même : processeur, mémoire, réactivité, disque, base de données, MQTT, clients connectés.
// Un échantillon par minute, gardé 24 h en mémoire, et des alertes quand la carte souffre.
// Registre des tâches : chaque traitement chronométré (tâche périodique, message MQTT, page d'API…) est compté par
// minute (nombre, durée totale, durée maximale). Un gel de la carte est ainsi attribué à la tâche la plus longue
// de la minute, et le tableau de bord montre les tâches les plus lentes de la dernière heure.
const fs = require('fs');
const { monitorEventLoopDelay, performance } = require('perf_hooks');

// ---- Registre des tâches (partagé par tout le serveur, très léger : une entrée par nom et par minute) ----
const NOMS_MAX = 300; // garde-fou : au-delà, les nouveaux noms sont regroupés sous « autres »
const MINUTES_GARDEES = 60;
let minuteTaches = new Map(); // nom -> { n, total, max } pour la minute en cours
const minutesTaches = []; // minutes terminées : [{ heure, taches: Map }]
function noter(nom, ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  let t = minuteTaches.get(nom);
  if (!t) {
    if (minuteTaches.size >= NOMS_MAX) { nom = 'autres'; t = minuteTaches.get(nom); }
    if (!t) { t = { n: 0, total: 0, max: 0 }; minuteTaches.set(nom, t); }
  }
  t.n++; t.total += ms; if (ms > t.max) t.max = ms;
}
// Chronomètre une fonction : temps bloquant (partie synchrone). Une fonction asynchrone n'est mesurée que jusqu'à
// son premier « await » : c'est ce temps-là qui fige la carte, l'attente du réseau ou du disque ne la bloque pas.
function chrono(nom, fn) {
  const t0 = performance.now();
  try { return fn(); } finally { noter(nom, performance.now() - t0); }
}
// Clôture de la minute : renvoie la tâche la plus longue (exécution unique la plus lente) et la plus coûteuse (cumul)
function cloreMinute(heure = Date.now()) {
  const taches = minuteTaches;
  minuteTaches = new Map();
  minutesTaches.push({ heure, taches });
  if (minutesTaches.length > MINUTES_GARDEES) minutesTaches.shift();
  let plusLongue = null, plusCouteuse = null;
  for (const [nom, t] of taches) {
    if (!plusLongue || t.max > plusLongue.max) plusLongue = { nom, max: t.max, n: t.n };
    if (!plusCouteuse || t.total > plusCouteuse.total) plusCouteuse = { nom, total: t.total, n: t.n };
  }
  return {
    tache: plusLongue && plusLongue.max >= 20 ? { nom: plusLongue.nom, ms: Math.round(plusLongue.max), n: plusLongue.n } : null,
    tacheCumul: plusCouteuse && plusCouteuse.total >= 50 ? { nom: plusCouteuse.nom, ms: Math.round(plusCouteuse.total), n: plusCouteuse.n } : null,
  };
}
// Tâches les plus lentes de la dernière heure (minutes closes + minute en cours), par durée maximale décroissante
function tachesLentes(limite = 15) {
  const total = new Map();
  for (const m of [...minutesTaches.map((x) => x.taches), minuteTaches]) {
    for (const [nom, t] of m) {
      const a = total.get(nom) || { nom, n: 0, total: 0, max: 0 };
      a.n += t.n; a.total += t.total; if (t.max > a.max) a.max = t.max;
      total.set(nom, a);
    }
  }
  return [...total.values()].sort((a, b) => b.max - a.max).slice(0, limite)
    .map((t) => ({ nom: t.nom, n: t.n, maxMs: Math.round(t.max), moyMs: Math.round((t.total / t.n) * 10) / 10, totalMs: Math.round(t.total) }));
}

// Minuteries (setInterval) de tout le serveur chronométrées sans les modifier une à une : chaque minuterie est
// nommée d'après sa fonction et l'endroit du code qui l'a créée (ex. « minuterie rafraichirEtat (server.js:3325) »)
let minuteriesInstrumentees = false;
function instrumenterMinuteries() {
  if (minuteriesInstrumentees) return;
  minuteriesInstrumentees = true;
  const origine = global.setInterval;
  global.setInterval = function setIntervalChronometre(fn, delai, ...args) {
    if (typeof fn !== 'function') return origine(fn, delai, ...args);
    const ligne = String(new Error().stack || '').split('\n').slice(2).find((l) => !l.includes('sante-carte.js')) || '';
    const m = /([\w.-]+\.js):(\d+)/.exec(ligne);
    const nom = `minuterie${fn.name && !/^setInterval/.test(fn.name) ? ' ' + fn.name : ''}${m ? ` (${m[1]}:${m[2]})` : ''}`;
    return origine(function minuterieChronometree() {
      const t0 = performance.now();
      try { return fn.apply(this, args); } finally { noter(nom, performance.now() - t0); }
    }, delai);
  };
}

// ---- Seuils de réactivité ----
// p99 : retard habituel ; max : gel ponctuel (une seule tâche qui bloque plusieurs secondes ne bouge pas le p99).
const SEUILS = { p99Attention: 500, p99Critique: 2000, gelAttention: 1500, gelCritique: 5000, gelRepete: 2, fenetreRepetition: 10 };
// Alertes de réactivité d'après les derniers échantillons (le dernier = la minute écoulée)
function alertesReactivite(echantillons, seuils = SEUILS) {
  const alertes = [];
  const e = echantillons[echantillons.length - 1];
  if (!e) return alertes;
  if (e.latenceP99 > seuils.p99Critique) alertes.push({ niveau: 'critique', message: `La carte se fige : jusqu’à ${(e.latenceP99 / 1000).toFixed(1)} s sans répondre (dernière minute)` });
  else if (e.latenceP99 > seuils.p99Attention) alertes.push({ niveau: 'attention', message: `Réactivité dégradée : jusqu’à ${e.latenceP99} ms de retard (dernière minute)` });
  if (alertes.length) return alertes;
  // Gels : critique dès un gel très long ; attention si des gels de plus de 1,5 s se répètent (2 minutes sur les 10 dernières)
  const recents = echantillons.slice(-seuils.fenetreRepetition).filter((x) => x.latenceMax > seuils.gelAttention);
  const pire = recents.reduce((a, x) => (!a || x.latenceMax > a.latenceMax ? x : a), null);
  const s = (ms) => (ms / 1000).toFixed(1);
  if (e.latenceMax > seuils.gelCritique) {
    const t = e.tache;
    alertes.push({ niveau: 'critique', tache: t || null, message: t ? `La carte s’est figée ${s(e.latenceMax)} s (dernière minute), tâche la plus longue : ${t.nom} (${t.ms} ms)` : `La carte s’est figée ${s(e.latenceMax)} s (dernière minute)` });
  } else if (recents.length >= seuils.gelRepete) {
    const t = pire.tache, n = recents.length, g = s(seuils.gelAttention), f = seuils.fenetreRepetition;
    alertes.push({ niveau: 'attention', tache: t || null, message: t ? `Gels répétés : ${n} fois plus de ${g} s sans répondre en ${f} min, jusqu’à ${s(pire.latenceMax)} s, tâche la plus longue : ${t.nom} (${t.ms} ms)` : `Gels répétés : ${n} fois plus de ${g} s sans répondre en ${f} min, jusqu’à ${s(pire.latenceMax)} s` });
  }
  return alertes;
}

function lireLimiteMemoire() {
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try { const v = fs.readFileSync(f, 'utf8').trim(); if (v !== 'max') { const n = Number(v); if (n > 0 && n < 2 ** 52) return n; } } catch { /* absent */ }
  }
  return null;
}

function creerSanteCarte({ dossier, fichierBase, version, sources }) {
  const delai = monitorEventLoopDelay({ resolution: 20 });
  delai.enable();
  const limiteMem = lireLimiteMemoire();
  let cpuAvant = process.cpuUsage(), tAvant = process.hrtime.bigint();
  const echantillons = []; // 24 h, un par minute
  let dernier = null;

  function echantillonner() {
    const t = process.hrtime.bigint(), cpu = process.cpuUsage(cpuAvant);
    const ecouleUs = Number(t - tAvant) / 1000;
    cpuAvant = process.cpuUsage(); tAvant = t;
    const mem = process.memoryUsage();
    const e = {
      heure: Date.now(),
      cpuPct: Math.round(((cpu.user + cpu.system) / ecouleUs) * 1000) / 10,
      memMo: Math.round(mem.rss / 1048576), tasMo: Math.round(mem.heapUsed / 1048576),
      latenceP99: Math.round(delai.percentile(99) / 1e6), latenceMax: Math.round(delai.max / 1e6),
    };
    delai.reset();
    Object.assign(e, cloreMinute(e.heure));
    try { Object.assign(e, sources.mqtt()); } catch { /* ignoré */ }
    echantillons.push(e);
    if (echantillons.length > 1440) echantillons.shift();
    dernier = e;
  }
  setInterval(echantillonner, 60000).unref();
  setTimeout(echantillonner, 5000).unref();

  function etat() {
    const e = dernier || {};
    let disque = null;
    try { const s = fs.statfsSync(dossier); disque = { libreGo: Math.round((s.bavail * s.bsize) / 1e8) / 10, totalGo: Math.round((s.blocks * s.bsize) / 1e8) / 10 }; } catch { /* Node trop ancien */ }
    let base = null;
    try {
      const b = sources.base ? sources.base() : {};
      const wal = fs.existsSync(fichierBase + '-wal') ? Math.round(fs.statSync(fichierBase + '-wal').size / 1048576) : 0;
      base = { ...b, walMo: wal };
    } catch { /* ignoré */ }
    const mqtt = sources.mqttEtat ? sources.mqttEtat() : {};
    const alertes = [];
    const ajout = (niveau, message) => alertes.push({ niveau, message });
    alertes.push(...alertesReactivite(echantillons));
    if (limiteMem && e.memMo > (limiteMem / 1048576) * 0.85) ajout('attention', `Mémoire presque pleine : ${e.memMo} Mo sur ${Math.round(limiteMem / 1048576)} Mo autorisés`);
    if (e.cpuPct > 80) ajout('attention', `Processeur très occupé : ${e.cpuPct} % d’un cœur`);
    if (disque && disque.libreGo / disque.totalGo < 0.1) ajout('critique', `Disque presque plein : ${disque.libreGo} Go libres`);
    if (base && base.totalMo > 2048) ajout('attention', `Base de données volumineuse : ${base.totalMo} Mo`);
    if (!mqtt.connecte) ajout('critique', 'Broker MQTT déconnecté');
    else if (mqtt.dernierMessage && Date.now() - mqtt.dernierMessage > 5 * 60000) ajout('attention', `Aucun message MQTT depuis ${Math.round((Date.now() - mqtt.dernierMessage) / 60000)} min`);
    return {
      version, demarrage: Date.now() - Math.round(process.uptime() * 1000),
      limiteMemMo: limiteMem ? Math.round(limiteMem / 1048576) : null,
      dernier: e, disque, base, mqtt, clients: sources.clients ? sources.clients() : null,
      alertes, niveau: alertes.some((a) => a.niveau === 'critique') ? 'critique' : alertes.length ? 'attention' : 'ok',
      historique: echantillons.slice(-180),
      // Tâches les plus lentes de la dernière heure, et gels des 3 dernières heures avec leur tâche suspecte
      taches: tachesLentes(),
      gels: echantillons.slice(-180).filter((x) => x.latenceMax > SEUILS.gelAttention).slice(-20).reverse().map((x) => ({ heure: x.heure, ms: x.latenceMax, tache: x.tache || null, tacheCumul: x.tacheCumul || null })),
      seuils: SEUILS,
    };
  }
  return { etat };
}

module.exports = { creerSanteCarte, instrumenterMinuteries, chrono, noter, tachesLentes, cloreMinute, alertesReactivite, SEUILS };
