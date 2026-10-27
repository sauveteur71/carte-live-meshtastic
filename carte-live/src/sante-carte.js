'use strict';
// Santé de la carte elle-même : processeur, mémoire, réactivité, disque, base de données, MQTT, clients connectés.
// Un échantillon par minute, gardé 24 h en mémoire, et des alertes quand la carte souffre.
const fs = require('fs');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');

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
    if (e.latenceP99 > 2000) ajout('critique', `La carte se fige : jusqu’à ${(e.latenceP99 / 1000).toFixed(1)} s sans répondre (dernière minute)`);
    else if (e.latenceP99 > 500) ajout('attention', `Réactivité dégradée : jusqu’à ${e.latenceP99} ms de retard (dernière minute)`);
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
    };
  }
  return { etat };
}

module.exports = { creerSanteCarte };
