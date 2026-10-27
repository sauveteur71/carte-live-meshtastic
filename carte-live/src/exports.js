'use strict';
// Exports et intégrations : GeoJSON (nœuds, liaisons), métriques Prometheus/Grafana, résumé JSON (Home Assistant).
// Mêmes règles de confidentialité que la carte publique : positions des clients arrondies, pas de messages.
// Si EXPORT_JETON est défini, chaque export exige ?jeton=… ou l'en-tête « Authorization: Bearer … ».

function creerExports({ config, stockage, reseau, reseauMc, maintenance, santeCarte, relief, alertes }) {
  const jetonOk = (req) => {
    const j = config.exportJeton;
    if (!j) return true;
    const h = String(req.headers.authorization || '');
    return req.query.jeton === j || h === 'Bearer ' + j;
  };
  const noeudsVisibles = () => {
    const maintenant = Date.now();
    return stockage.q.noeuds.all().map((n) => reseau.vueNoeud(n, false, maintenant)).filter((n) => n.lat != null);
  };

  function noeudsGeoJSON() {
    return {
      type: 'FeatureCollection',
      features: noeudsVisibles().map((n) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: [n.lon, n.lat, ...(n.alt != null ? [n.alt] : [])] },
        properties: { id: n.id, nom: n.nomLong, nomCourt: n.nomCourt, role: n.role, infrastructure: !!n.infrastructure, passerelle: !!n.passerelle, statut: n.statut, dernierVu: n.dernierVu ? new Date(n.dernierVu).toISOString() : null, materiel: n.materiel, batterie: n.batterie, tension: n.tension, canal: n.canal, emission: n.emission, reseau: 'meshtastic' },
      })),
    };
  }
  function liensGeoJSON(heures = 24) {
    const pos = new Map(noeudsVisibles().map((n) => [n.num, n]));
    return {
      type: 'FeatureCollection',
      features: reseau.liens(heures * 3600000).filter((l) => pos.has(l.a) && pos.has(l.b)).map((l) => ({
        type: 'Feature', geometry: { type: 'LineString', coordinates: [[pos.get(l.a).lon, pos.get(l.a).lat], [pos.get(l.b).lon, pos.get(l.b).lat]] },
        properties: { de: pos.get(l.a).id, vers: pos.get(l.b).id, source: l.source, snr: l.snr, observations: l.nb, dernierVu: new Date(l.dernierVu).toISOString() },
      })),
    };
  }

  function resume() {
    const st = reseau.statistiques();
    const al = alertes();
    let couverture = null;
    try { const c = relief.classement(); couverture = c && c.reseauActuel ? c.reseauActuel.pct : null; } catch { /* relief pas prêt */ }
    const relais = {};
    try { for (const x of maintenance.chargeRadio()) relais[x.nom] = { emission: x.emission, canal: x.canal, emission24h: x.emission24 }; } catch { /* ignoré */ }
    try { for (const x of maintenance.autonomie()) relais[x.nom] = { ...(relais[x.nom] || {}), tension: x.tension, joursSansSoleil: x.joursSansSoleil, etatBatterie: x.etat }; } catch { /* ignoré */ }
    const s = santeCarte.etat();
    return {
      heure: new Date().toISOString(),
      noeudsActifs: st.actifs, passerellesEnLigne: st.passerellesEnLigne, paquetsMinute: st.paquetsMinute, canalMoyen: st.canalMoyen, canalMax: st.canalMax,
      couverturePct: couverture, alertes: al.length, alertesCritiques: al.filter((a) => a.niveau === 'critique').length,
      meshcoreActifs: config.meshcore.actif ? reseauMc.statistiques().actifs : null,
      carte: { niveau: s.niveau, processeurPct: s.dernier.cpuPct, memoireMo: s.dernier.memMo, mqttConnecte: s.mqtt.connecte },
      relais,
    };
  }

  // Format texte Prometheus (https://prometheus.io/docs/instrumenting/exposition_formats/)
  function metriques() {
    const r = resume();
    const l = [];
    const g = (nom, aide, valeurs) => {
      l.push(`# HELP carte_${nom} ${aide}`, `# TYPE carte_${nom} gauge`);
      for (const [etiq, v] of valeurs) if (v != null && Number.isFinite(Number(v))) l.push(`carte_${nom}${etiq} ${Number(v)}`);
    };
    const e = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
    g('noeuds_actifs', 'Nœuds Meshtastic actifs', [['', r.noeudsActifs]]);
    g('passerelles_en_ligne', 'Passerelles MQTT en ligne', [['', r.passerellesEnLigne]]);
    g('paquets_minute', 'Paquets Meshtastic par minute', [['', r.paquetsMinute]]);
    g('canal_moyen_pourcent', 'Occupation moyenne du canal', [['', r.canalMoyen]]);
    g('couverture_pourcent', 'Couverture calculée du département', [['', r.couverturePct]]);
    g('alertes', 'Alertes actives', [['{niveau="toutes"}', r.alertes], ['{niveau="critique"}', r.alertesCritiques]]);
    g('meshcore_actifs', 'Nœuds MeshCore actifs', [['', r.meshcoreActifs]]);
    g('relais_emission_pourcent', 'Temps d’émission des relais', Object.entries(r.relais).map(([n, x]) => [`{relais="${e(n)}"}`, x.emission]));
    g('relais_canal_pourcent', 'Occupation du canal vue par les relais', Object.entries(r.relais).map(([n, x]) => [`{relais="${e(n)}"}`, x.canal]));
    g('relais_tension_volts', 'Tension des relais', Object.entries(r.relais).map(([n, x]) => [`{relais="${e(n)}"}`, x.tension]));
    g('relais_jours_sans_soleil', 'Autonomie estimée sans recharge', Object.entries(r.relais).map(([n, x]) => [`{relais="${e(n)}"}`, x.joursSansSoleil]));
    g('processeur_pourcent', 'Processeur utilisé par la carte', [['', r.carte.processeurPct]]);
    g('memoire_mo', 'Mémoire utilisée par la carte', [['', r.carte.memoireMo]]);
    g('mqtt_connecte', 'Broker MQTT connecté (1/0)', [['', r.carte.mqttConnecte ? 1 : 0]]);
    return l.join('\n') + '\n';
  }

  // GPX des relais et passerelles (OsmAnd, randonnée, tournée de maintenance)
  function relaisGpx() {
    const x = (t) => String(t ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
    const pts = noeudsVisibles().filter((n) => n.infrastructure || n.passerelle);
    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="carte-live-meshtastic" xmlns="http://www.topografix.com/GPX/1/1">\n`
      + pts.map((n) => `<wpt lat="${n.lat}" lon="${n.lon}">${n.alt != null ? `<ele>${n.alt}</ele>` : ''}<name>${x(n.nomLong || n.id)}</name><desc>${x([n.roleFr || n.role, n.passerelle ? 'passerelle MQTT' : '', n.statut, n.dernierVu ? 'vu ' + new Date(n.dernierVu).toLocaleString('fr-FR') : ''].filter(Boolean).join(' · '))}</desc><sym>${n.passerelle ? 'Radio Beacon' : 'Tower'}</sym></wpt>`).join('\n')
      + '\n</gpx>\n';
  }

  return { jetonOk, noeudsGeoJSON, liensGeoJSON, resume, metriques, relaisGpx };
}

module.exports = { creerExports };
