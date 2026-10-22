'use strict';
// Calculs d'analyse : santé des relais, analyse du trafic (temps d'émission LoRa), profil de relief et bilan de liaison, rejeu.

const { idNoeud } = require('./decodeur');

// ---- Paramètres LoRa des presets Meshtastic : facteur d'étalement, bande (kHz), taux de codage (4/x) ----
const PRESETS = {
  LONG_FAST: { sf: 11, bw: 250, cr: 5 },
  LONG_SLOW: { sf: 12, bw: 125, cr: 8 },
  VERY_LONG_SLOW: { sf: 12, bw: 62.5, cr: 8 },
  MEDIUM_SLOW: { sf: 10, bw: 250, cr: 5 },
  MEDIUM_FAST: { sf: 9, bw: 250, cr: 5 },
  SHORT_SLOW: { sf: 8, bw: 250, cr: 5 },
  SHORT_FAST: { sf: 7, bw: 250, cr: 5 },
  LONG_MODERATE: { sf: 11, bw: 125, cr: 8 },
  SHORT_TURBO: { sf: 7, bw: 500, cr: 5 },
  LONG_TURBO: { sf: 11, bw: 500, cr: 8 },
  MESHCORE_FR: { sf: 8, bw: 62.5, cr: 8 },
};
// SNR minimal démodulable par facteur d'étalement (dB)
const SNR_LIMITE = { 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20 };

/** Temps d'émission LoRa (s) d'une trame de `octets` (en-tête Meshtastic de 16 octets inclus), formule Semtech */
function tempsEmission(octets, preset) {
  const p = PRESETS[preset] || PRESETS.LONG_FAST;
  const tsym = 2 ** p.sf / (p.bw * 1000);
  const de = tsym > 0.016 ? 1 : 0;
  const tPreambule = (16 + 4.25) * tsym;
  const cr = p.cr - 4;
  const nb = 8 + Math.max(Math.ceil((8 * octets - 4 * p.sf + 28 + 16) / (4 * (p.sf - 2 * de))) * (cr + 4), 0);
  return tPreambule + nb * tsym;
}

const R_TERRE = 6371000;
function distanceM(a, b) {
  const r = Math.PI / 180;
  const s = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * R_TERRE * Math.asin(Math.sqrt(s));
}

function creerAnalyse(stockage, config, reseau, presetCourant) {
  const { q } = stockage;
  const nom = (num) => {
    const n = q.noeud.get(num >>> 0);
    return n ? n.nom_long || n.nom_court || n.id : idNoeud(num);
  };
  const preset = () => presetCourant() || config.reseauPreset || 'LONG_FAST';

  // ---------------------------------------------------------------------------
  // Santé d'un nœud (relais surtout)
  // ---------------------------------------------------------------------------
  function sante(num) {
    const n = q.noeud.get(num);
    if (!n) return null;
    const maintenant = Date.now();
    const debut = Math.max(n.premier_vu || maintenant, maintenant - 7 * 86400000);
    const heuresPeriode = Math.max(1, Math.ceil((maintenant - debut) / 3600000));
    const heuresActives = q.heuresActives.get(num, debut).n;
    const telem = q.telemetrieUptime.all(num, maintenant - 7 * 86400000);

    // Redémarrages : l'uptime repart à zéro
    let redemarrages = 0;
    let prec = null;
    for (const t of telem) {
      if (t.uptime == null) continue;
      if (prec != null && t.uptime + 600 < prec) redemarrages++;
      prec = t.uptime;
    }

    // Tension min / max par jour (heure locale)
    const jours = new Map();
    for (const t of telem) {
      if (!(t.tension > 0)) continue;
      const j = new Date(t.heure).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: '2-digit', month: '2-digit' });
      const v = jours.get(j) || { jour: j, min: Infinity, max: -Infinity, nb: 0 };
      v.min = Math.min(v.min, t.tension);
      v.max = Math.max(v.max, t.tension);
      v.nb++;
      jours.set(j, v);
    }
    const listeJours = [...jours.values()].map((j) => ({ ...j, min: +j.min.toFixed(2), max: +j.max.toFixed(2), recharge: +(j.max - j.min).toFixed(2) }));

    // Prévision : pente de la tension sur 24 h (régression linéaire), temps restant avant 3,3 V
    const recents = telem.filter((t) => t.tension > 0 && t.heure > maintenant - 24 * 3600000);
    let prevision = null;
    const etendue = recents.length ? recents[recents.length - 1].heure - recents[0].heure : 0;
    if (recents.length >= 4 && etendue >= 3 * 3600000) {
      const xs = recents.map((t) => (t.heure - maintenant) / 3600000);
      const ys = recents.map((t) => t.tension);
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const my = ys.reduce((a, b) => a + b, 0) / ys.length;
      const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
      const pente = sxx > 0 ? xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / sxx : 0;
      const derniere = ys[ys.length - 1];
      const surSecteur = n.batterie != null && n.batterie > 100;
      prevision = {
        penteVoltsParJour: +(pente * 24).toFixed(3),
        derniereTension: +derniere.toFixed(2),
        heuresAvantSeuil: !surSecteur && pente < -0.0005 && derniere > 3.3 ? Math.round((derniere - 3.3) / -pente) : null,
        tendance: surSecteur ? 'secteur' : pente > 0.002 ? 'charge' : pente < -0.002 ? 'décharge' : 'stable',
      };
    }

    const traceroutes = q.trNoeud.all(num, 20).map((t) => {
      const aller = t.aller ? JSON.parse(t.aller) : null;
      const snrA = t.snr_aller ? JSON.parse(t.snr_aller) : [];
      const chemin = aller ? [t.origine, ...aller, t.cible].map((x, i, arr) => ({ num: x >>> 0, nom: nom(x), snr: i > 0 ? snrA[i - 1] ?? null : null })) : null;
      return { heure: t.heure, statut: t.statut, declencheur: t.declencheur, duree: t.duree, detail: t.detail, chemin, sauts: aller ? aller.length : null };
    });
    const repondus = traceroutes.filter((t) => t.statut === 'repondu').length;
    const termines = traceroutes.filter((t) => t.statut !== 'envoye').length;

    return {
      disponibilite: Math.min(100, Math.round((heuresActives / heuresPeriode) * 100)),
      heuresActives,
      heuresPeriode,
      redemarrages,
      jours: listeJours,
      prevision,
      traceroutes,
      tauxReponseTraceroute: termines ? Math.round((repondus / termines) * 100) : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Analyse du trafic
  // ---------------------------------------------------------------------------
  function analyse(heures, zone) {
    const maintenant = Date.now();
    const depuis = maintenant - heures * 3600000;
    const pr = preset();
    const dansZone = (n) => {
      if (!zone) return true;
      if (n && n.lat != null) return n.lat >= zone[0] && n.lat <= zone[2] && n.lon >= zone[1] && n.lon <= zone[3];
      return !!(n && /^43/.test(n.nom_long || n.nom_court || ''));
    };
    const parNoeud = new Map();
    let totalPaquets = 0, totalAirtime = 0;
    for (const r of q.analyse.all(depuis)) {
      const n = q.noeud.get(r.de);
      if (!dansZone(n)) continue;
      const e = parNoeud.get(r.de) || { num: r.de, paquets: 0, airtime: 0, parPort: {}, hopMax: 0, receptions: 0, viaMqtt: 0 };
      const moyenne = r.nb ? r.octets / r.nb : 30;
      const air = r.nb * tempsEmission((moyenne || 30) + 16, pr);
      e.paquets += r.nb;
      e.airtime += air;
      e.parPort[r.port] = (e.parPort[r.port] || 0) + r.nb;
      e.hopMax = Math.max(e.hopMax, r.hop_max || 0);
      e.receptions += r.receptions || 0;
      e.viaMqtt += r.via_mqtt || 0;
      parNoeud.set(r.de, e);
      totalPaquets += r.nb;
      totalAirtime += air;
    }
    const noeuds = [...parNoeud.values()].map((e) => {
      const n = q.noeud.get(e.num) || {};
      const parHeure = e.paquets / heures;
      const airtimePct = (e.airtime / (heures * 3600)) * 100;
      const alertes = [];
      if (parHeure > 20) alertes.push({ niveau: 'attention', texte: `très bavard : ${parHeure.toFixed(0)} paquets/h` });
      if ((e.parPort.position || 0) / heures > 4) alertes.push({ niveau: 'attention', texte: `position toutes les ${Math.round(60 / ((e.parPort.position || 1) / heures))} min (15 min min. conseillées)` });
      if ((e.parPort.telemetrie || 0) / heures > 4) alertes.push({ niveau: 'attention', texte: `télémétrie toutes les ${Math.round(60 / ((e.parPort.telemetrie || 1) / heures))} min (30 min conseillées)` });
      if (e.hopMax > 3) alertes.push({ niveau: e.hopMax > 5 ? 'critique' : 'attention', texte: `limite de sauts ${e.hopMax} (3 recommandé, chaque saut en plus multiplie les réémissions)` });
      if (airtimePct > 1) alertes.push({ niveau: 'attention', texte: `occupe ${airtimePct.toFixed(1)} % du canal à lui seul` });
      if (['ROUTER', 'REPEATER', 'ROUTER_LATE'].includes(n.role)) {
        const pos = q.positionsNoeud24h.all(e.num, depuis);
        if (pos.length > 1) {
          const ref = pos[0];
          const ecart = Math.max(...pos.map((p) => distanceM(ref, p)));
          if (ecart > 1000) alertes.push({ niveau: 'attention', texte: `rôle ${n.role} sur un nœud mobile (${(ecart / 1000).toFixed(1)} km de déplacement)` });
        }
      }
      return {
        num: e.num,
        id: n.id || idNoeud(e.num),
        nom: n.nom_long || n.nom_court || idNoeud(e.num),
        role: n.role || null,
        paquets: e.paquets,
        parHeure: +parHeure.toFixed(1),
        airtimeSecondes: +e.airtime.toFixed(1),
        airtimePct: +airtimePct.toFixed(2),
        parPort: e.parPort,
        hopMax: e.hopMax,
        redondance: e.paquets ? +(e.receptions / e.paquets).toFixed(1) : null,
        partMqtt: e.paquets ? Math.round((e.viaMqtt / e.paquets) * 100) : 0,
        alertes,
      };
    }).sort((a, b) => b.airtimeSecondes - a.airtimeSecondes);

    return {
      heures,
      preset: pr,
      parametres: PRESETS[pr] || PRESETS.LONG_FAST,
      tempsTrame50Octets: +tempsEmission(66, pr).toFixed(3),
      totalPaquets,
      airtimeTotalSecondes: +totalAirtime.toFixed(1),
      occupationEstimeePct: +((totalAirtime / (heures * 3600)) * 100).toFixed(2),
      noeuds,
      sauts: q.histoSauts.all(depuis).map((r) => ({ sauts: r.sauts, nb: r.nb })),
      canaux: q.histoCanaux.all(depuis).map((r) => ({ canal: r.canal, nb: r.nb, dechiffres: r.dechiffres })),
      nbAlertes: noeuds.reduce((t, n) => t + n.alertes.length, 0),
    };
  }

  // ---------------------------------------------------------------------------
  // Profil de relief et bilan de liaison
  // ---------------------------------------------------------------------------
  const cacheAlti = new Map();
  async function altitudes(a, b, n) {
    const cle = [a.lat, a.lon, b.lat, b.lon, n].map((x) => x.toFixed(5)).join(',');
    if (cacheAlti.has(cle)) return cacheAlti.get(cle);
    let points = null, source = null;
    try {
      // API altimétrique IGN (Géoplateforme) : RGE ALTI, précision métrique en France
      const url = `https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevationLine.json?lon=${a.lon}|${b.lon}&lat=${a.lat}|${b.lat}&resource=ign_rge_alti_wld&sampling=${n}&profile_mode=simple&indent=false`;
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('IGN ' + r.status);
      const j = await r.json();
      points = (j.elevations || []).map((e) => ({ lat: e.lat, lon: e.lon, z: e.z > -1000 ? e.z : null }));
      source = 'IGN RGE ALTI';
    } catch (e) {
      // Repli : Open-Meteo (Copernicus DEM 90 m)
      const lats = [], lons = [];
      for (let i = 0; i < n; i++) { const f = i / (n - 1); lats.push((a.lat + (b.lat - a.lat) * f).toFixed(5)); lons.push((a.lon + (b.lon - a.lon) * f).toFixed(5)); }
      const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lats.join(',')}&longitude=${lons.join(',')}`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('Service d\'altitude indisponible');
      const j = await r.json();
      points = j.elevation.map((z, i) => ({ lat: +lats[i], lon: +lons[i], z }));
      source = 'Copernicus DEM 90 m (Open-Meteo)';
    }
    // Comble les trous éventuels
    for (let i = 0; i < points.length; i++) if (points[i].z == null) points[i].z = (points[i - 1] || points[i + 1] || { z: 0 }).z;
    const res = { points, source };
    cacheAlti.set(cle, res);
    if (cacheAlti.size > 300) cacheAlti.delete(cacheAlti.keys().next().value);
    return res;
  }

  async function profil(opts) {
    const point = (num, lat, lon, nom) => {
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { num: null, lat, lon, nom_long: nom || `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
      return q.noeud.get(num >>> 0);
    };
    const A = point(opts.a, opts.aLat, opts.aLon, opts.aNom), B = point(opts.b, opts.bLat, opts.bLon, opts.bNom);
    if (!A || !B || A.lat == null || B.lat == null) throw new Error('Les deux extrémités doivent avoir une position');
    const pr = PRESETS[opts.preset] ? opts.preset : preset();
    const p = PRESETS[pr];
    const f = 869.525e6; // fréquence par défaut EU_868 (slot 1)
    const lambda = 299792458 / f;
    const k = 4 / 3;
    const D = distanceM(A, B);
    const n = Math.min(200, Math.max(30, Math.round(D / 100)));
    const { points, source } = await altitudes(A, B, n);
    const ha = opts.ha ?? 3, hb = opts.hb ?? 3;
    const zA = points[0].z + ha, zB = points[points.length - 1].z + hb;
    let pire = { v: -Infinity, i: 0, degagement: Infinity };
    let degagementMin = Infinity;
    const serie = points.map((pt, i) => {
      const d1 = (D * i) / (points.length - 1), d2 = D - d1;
      const courbure = (d1 * d2) / (2 * k * R_TERRE);
      const sol = pt.z + courbure;
      const visee = zA + ((zB - zA) * d1) / D;
      const rF = d1 > 0 && d2 > 0 ? Math.sqrt((lambda * d1 * d2) / D) : 0;
      const degagement = visee - sol;
      if (i > 0 && i < points.length - 1) {
        const v = rF > 0 ? (-degagement * Math.SQRT2) / rF : -Infinity;
        if (v > pire.v) pire = { v, i, degagement, rF };
        degagementMin = Math.min(degagementMin, degagement / (rF || 1));
      }
      return { d: Math.round(d1), sol: +pt.z.toFixed(1), solCourbe: +sol.toFixed(1), visee: +visee.toFixed(1), fresnel: +rF.toFixed(1) };
    });
    // Perte de diffraction (lame de couteau, ITU-R P.526) sur l'obstacle principal
    const v = pire.v;
    const perteDiffraction = v > -0.78 ? 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1) : 0;
    const fspl = 20 * Math.log10(D / 1000) + 20 * Math.log10(f / 1e6) + 32.44;
    const ptx = opts.ptx ?? 27, ga = opts.ga ?? 2.15, gb = opts.gb ?? 2.15, pertes = opts.pertes ?? 1.5;
    const prx = ptx + ga + gb - pertes - fspl - perteDiffraction;
    const bruit = -174 + 10 * Math.log10(p.bw * 1000) + 6;
    const snrEstime = prx - bruit;
    const snrLimite = SNR_LIMITE[p.sf];
    const sensibilite = bruit + snrLimite;

    // SNR mesuré si le lien est connu
    const liens = A.num == null || B.num == null ? [] : q.liens.all(Date.now() - config.retentionJours * 86400000).filter((l) => (l.a === A.num && l.b === B.num) || (l.a === B.num && l.b === A.num));
    const mesure = (dir) => { const l = liens.find((x) => x.a === dir[0] && x.b === dir[1] && x.snr != null); return l ? { snr: l.snr, source: l.source, nb: l.nb } : null; };

    let verdict;
    const marge = snrEstime - snrLimite;
    if (pire.degagement > 0.6 * (pire.rF || 0)) verdict = 'Visibilité directe dégagée (60 % de la 1re zone de Fresnel libre)';
    else if (pire.degagement > 0) verdict = 'Visibilité directe mais zone de Fresnel partiellement obstruée';
    else verdict = `Obstruée par le relief à ${(serie[pire.i].d / 1000).toFixed(1)} km (${Math.abs(pire.degagement).toFixed(0)} m au-dessus de la ligne de visée)`;

    return {
      a: { num: A.num, nom: A.nom_long || A.nom_court || A.id, lat: A.lat, lon: A.lon, sol: points[0].z, antenne: ha },
      b: { num: B.num, nom: B.nom_long || B.nom_court || B.id, lat: B.lat, lon: B.lon, sol: points[points.length - 1].z, antenne: hb },
      distanceKm: +(D / 1000).toFixed(2),
      sourceAltitude: source,
      preset: pr,
      parametres: { ptx, ga, gb, pertes, frequenceMHz: f / 1e6 },
      serie,
      obstacle: { distanceKm: +(serie[pire.i].d / 1000).toFixed(2), degagementM: +pire.degagement.toFixed(1), v: +v.toFixed(2) },
      verdict,
      bilan: {
        fspl: +fspl.toFixed(1),
        diffraction: +perteDiffraction.toFixed(1),
        puissanceRecue: +prx.toFixed(1),
        bruit: +bruit.toFixed(1),
        sensibilite: +sensibilite.toFixed(1),
        snrEstime: +snrEstime.toFixed(1),
        snrLimite,
        marge: +marge.toFixed(1),
      },
      mesure: { aVersB: mesure([A.num, B.num]), bVersA: mesure([B.num, A.num]) },
    };
  }

  // ---------------------------------------------------------------------------
  // Rejeu
  // ---------------------------------------------------------------------------
  function rejeu(debut, fin) {
    return q.rejeu.all(debut, fin).map((r) => ({ de: r.de, port: r.port, heure: r.heure, sauts: r.sauts, passerelle: r.passerelle, relais: r.relais, snr: r.snr }));
  }

  return { sante, analyse, profil, rejeu, tempsEmission };
}

module.exports = { creerAnalyse, tempsEmission, PRESETS };
