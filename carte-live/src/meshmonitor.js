'use strict';
// Source complémentaire : API REST v1 de MeshMonitor.
// Récupère les nœuds connus du nœud local (noms, rôles, positions, télémétrie, sauts)
// et en déduit des liens radio : voisins directs (0 saut) et traceroutes.

const { ROLES, MATERIELS, positionValide } = require('./decodeur');

const journal = (...a) => console.log(new Date().toISOString(), '[MeshMonitor]', ...a);

function lireJsonTableau(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try { return JSON.parse(v); } catch { return null; }
  }
  return null;
}

function creerSourceMeshMonitor(stockage, config, apresMiseAJour) {
  const mm = config.meshmonitor;
  if (!mm.url || !mm.jeton) return null;
  const { q } = stockage;
  const entetes = { Authorization: 'Bearer ' + mm.jeton, Accept: 'application/json' };
  const retentionMs = config.retentionJours * 86400000;
  let etat = { ok: false, derniere: null, noeuds: 0, liens: 0, erreur: null, sources: [] };

  async function appel(chemin) {
    const r = await fetch(mm.url + '/api/v1' + chemin, { headers: entetes, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} sur ${chemin}`);
    const j = await r.json();
    return j && j.data !== undefined ? j.data : j;
  }

  async function listerSources() {
    if (mm.sources.length) return mm.sources.map((id) => ({ id, name: id }));
    const toutes = await appel('/sources');
    const liste = Array.isArray(toutes) ? toutes : toutes.sources || [];
    // Seules les sources reliées à une radio (TCP, série, BLE) donnent une vue RF locale
    return liste.filter((s) => s.enabled !== false && /^meshtastic_/.test(s.type || ''));
  }

  function lier(a, b, snr, rssi, heure) {
    if (a == null || b == null || a === b || a === 0xffffffff || b === 0xffffffff) return 0;
    stockage.assurerNoeud(a, heure);
    stockage.assurerNoeud(b, heure);
    q.lien.run({ a, b, source: 'rf', snr: snr ?? null, rssi: rssi ?? null, heure });
    return 1;
  }

  async function synchroniserSource(src) {
    const [noeuds, traceroutes] = await Promise.all([
      appel(`/sources/${src.id}/nodes`),
      appel(`/sources/${src.id}/traceroutes`).catch(() => []),
    ]);
    const maintenant = Date.now();
    const limite = maintenant - retentionMs;

    // Nœud local : celui qui lance les traceroutes (sinon variable MESHMONITOR_NOEUD_LOCAL)
    const compte = new Map();
    for (const t of traceroutes || []) compte.set(t.fromNodeNum >>> 0, (compte.get(t.fromNodeNum >>> 0) || 0) + 1);
    let local = process.env.MESHMONITOR_NOEUD_LOCAL ? parseInt(process.env.MESHMONITOR_NOEUD_LOCAL.replace('!', ''), 16) >>> 0 : null;
    if (local == null && compte.size) local = [...compte.entries()].sort((a, b) => b[1] - a[1])[0][0];

    let nbNoeuds = 0, nbLiens = 0;
    stockage.transaction(() => {
      for (const n of noeuds || []) {
        const num = n.nodeNum >>> 0;
        if (!num) continue;
        const vu = n.lastHeard ? n.lastHeard * 1000 : null;
        if (vu && vu < limite) continue;
        stockage.assurerNoeud(num, vu || maintenant);
        nbNoeuds++;
        q.infos.run({
          num,
          nomLong: n.longName || null,
          nomCourt: n.shortName || null,
          materiel: n.hwModel != null ? MATERIELS[n.hwModel] || null : null,
          role: n.role != null ? ROLES[n.role] || null : null,
          firmware: n.firmwareVersion || null,
          preset: null,
        });
        if (vu) q.vu.run({ num, heure: vu, sauts: Number.isInteger(n.hopsAway) ? n.hopsAway : null, snr: n.hopsAway === 0 ? n.snr ?? null : null, rssi: n.hopsAway === 0 ? n.rssi ?? null : null });
        const lat = n.latitudeOverride ?? n.latitude, lon = n.longitudeOverride ?? n.longitude;
        if (positionValide(lat, lon) && !n.hideFromMap) {
          const actuel = q.noeud.get(num);
          const heurePos = n.positionTimestamp || vu || maintenant;
          if (!actuel || actuel.lat == null || (actuel.heure_position || 0) < heurePos) {
            q.position.run({ num, lat, lon, alt: n.altitudeOverride ?? n.altitude ?? null, precision: n.positionPrecisionBits ?? null, heure: heurePos });
          }
        }
        const actuel = q.noeud.get(num);
        if (vu && (actuel.heure_telemetrie || 0) < vu && (n.voltage > 0 || n.batteryLevel != null || n.channelUtilization != null)) {
          q.telemetrie.run({
            num,
            heure: vu,
            batterie: n.batteryLevel ?? null,
            tension: n.voltage > 0 ? n.voltage : null,
            canal: n.channelUtilization ?? null,
            emission: n.airUtilTx ?? null,
            uptime: n.uptimeSeconds ?? null,
          });
          q.histoTelemetrie.run({
            num, heure: vu, batterie: n.batteryLevel ?? null, tension: n.voltage > 0 ? n.voltage : null,
            canal: n.channelUtilization ?? null, emission: n.airUtilTx ?? null, temperature: null, humidite: null, pression: null, uptime: n.uptimeSeconds ?? null,
          });
        }
        // Voisin direct du nœud local, entendu en radio (pas via MQTT)
        if (local != null && num !== local && n.hopsAway === 0 && !n.viaMqtt && vu && n.snr != null) {
          nbLiens += lier(num, local, n.snr, n.rssi, vu);
        }
      }
      if (local != null) stockage.assurerNoeud(local, maintenant);

      // Traceroutes : aller (from -> route -> to) et retour (to -> routeBack -> from), SNR en quarts de dB
      for (const t of traceroutes || []) {
        const heure = t.timestamp || t.createdAt || maintenant;
        if (heure < limite) continue;
        const route = lireJsonTableau(t.route);
        if (!route) continue; // pas de réponse reçue
        const de = t.fromNodeNum >>> 0, vers = t.toNodeNum >>> 0;
        const snrA = lireJsonTableau(t.snrTowards) || [];
        const aller = [de, ...route.map((x) => x >>> 0), vers];
        aller.slice(1).forEach((b, i) => {
          const s = snrA[i];
          nbLiens += lier(aller[i], b, s != null && s !== -128 ? s / 4 : null, null, heure);
        });
        const retourRoute = lireJsonTableau(t.routeBack);
        const snrR = lireJsonTableau(t.snrBack) || [];
        if (retourRoute) {
          const retour = [vers, ...retourRoute.map((x) => x >>> 0), de];
          retour.slice(1).forEach((b, i) => {
            const s = snrR[i];
            nbLiens += lier(retour[i], b, s != null && s !== -128 ? s / 4 : null, null, heure);
          });
        }
      }
    })();
    return { nom: src.name || src.id, noeuds: nbNoeuds, liens: nbLiens, local: local != null ? '!' + local.toString(16).padStart(8, '0') : null };
  }

  // Une seule minuterie : la synchronisation suivante est programmée à la fin de chacune (pas de relances cumulées)
  let minuterie = null;
  let enCours = false;
  const planifier = (ms) => { clearTimeout(minuterie); minuterie = setTimeout(synchroniser, ms); };

  async function synchroniser() {
    if (enCours) return;
    enCours = true;
    clearTimeout(minuterie);
    try {
      const sources = await listerSources();
      const resultats = [];
      for (const s of sources) resultats.push(await synchroniserSource(s));
      etat = {
        ok: true,
        derniere: Date.now(),
        noeuds: resultats.reduce((t, r) => t + r.noeuds, 0),
        liens: resultats.reduce((t, r) => t + r.liens, 0),
        erreur: null,
        sources: resultats,
      };
      journal(`synchronisé : ${resultats.map((r) => `${r.nom} (${r.noeuds} nœuds, ${r.liens} liens, local ${r.local || '?'})`).join(' ; ') || 'aucune source radio'}`);
      if (apresMiseAJour) apresMiseAJour();
      planifier(Math.max(60, mm.intervalleSecondes) * 1000);
    } catch (e) {
      etat = { ...etat, ok: false, erreur: e.message === 'The operation was aborted due to timeout' ? 'MeshMonitor ne répond pas (délai dépassé)' : e.message };
      journal('erreur :', e.message, '— nouvelle tentative dans 60 s');
      planifier(60000);
    } finally {
      enCours = false;
    }
  }

  planifier(3000);
  return { etat: () => etat, synchroniser };
}

module.exports = { creerSourceMeshMonitor };
