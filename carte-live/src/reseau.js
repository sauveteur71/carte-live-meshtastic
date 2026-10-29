'use strict';
// Logique réseau : intégration des paquets, déduction des liens RF, état des nœuds et alertes

const { idNoeud } = require('./decodeur');

const ROLES_INFRA = new Set(['ROUTER', 'ROUTER_LATE', 'REPEATER', 'ROUTER_CLIENT', 'CLIENT_BASE']);
const NOEUD_INCONNU = 0xffffffff;

const ROLES_FR = {
  CLIENT: 'Client',
  CLIENT_MUTE: 'Client muet',
  CLIENT_HIDDEN: 'Client caché',
  CLIENT_BASE: 'Client base',
  ROUTER: 'Routeur',
  ROUTER_LATE: 'Routeur tardif',
  ROUTER_CLIENT: 'Routeur-client',
  REPEATER: 'Répéteur',
  TRACKER: 'Traceur',
  SENSOR: 'Capteur',
  TAK: 'TAK',
  TAK_TRACKER: 'Traceur TAK',
  LOST_AND_FOUND: 'Objet perdu',
};

function distanceKm(a, b) {
  if (a.lat == null || b.lat == null) return null;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function creerReseau(stockage, config) {
  const { q } = stockage;
  const s = config.seuils;
  const alertesActives = new Map(); // clé -> alerte (avec date de début)

  function estSurveille(n) {
    if (!n) return false;
    if (ROLES_INFRA.has(n.role) || n.est_passerelle) return true;
    return config.noeudsSurveilles.some((x) => x === n.id || x === n.nom_court || x === n.nom_long);
  }

  function lienPlausible(a, b) {
    const na = q.noeud.get(a), nb = q.noeud.get(b);
    if (!na || !nb || na.lat == null || nb.lat == null) return true;
    return distanceKm(na, nb) <= config.lienDistanceMaxKm;
  }

  function lier(a, b, source, snr, rssi, heure) {
    if (a == null || b == null || a === b || a === NOEUD_INCONNU || b === NOEUD_INCONNU) return;
    if (!lienPlausible(a, b)) return;
    stockage.assurerNoeud(a, heure);
    stockage.assurerNoeud(b, heure);
    q.lien.run({ a, b, source, snr: snr ?? null, rssi: rssi ?? null, heure });
  }

  // Retrouve le nœud relais à partir du dernier octet de son identifiant
  function trouverRelais(octet, exclure, passerelle) {
    // Seul le dernier octet de l'identifiant du relais est connu : on ne retient qu'un candidat
    // situé à portée radio plausible de la passerelle, et sans ambiguïté.
    const candidats = q.noeuds.all().filter((n) => (n.num & 0xff) === octet && !exclure.includes(n.num));
    if (candidats.length === 0) return null;
    const gw = q.noeud.get(passerelle);
    if (!gw || gw.lat == null) return null; // passerelle sans position : impossible de vérifier, on s'abstient
    const proches = candidats
      .filter((c) => c.lat != null)
      .map((c) => ({ num: c.num, d: distanceKm(c, gw) }))
      .filter((c) => c.d <= config.lienDistanceMaxKm)
      .sort((x, y) => x.d - y.d);
    if (proches.length === 0) return null;
    // Deux candidats à portée et à distance comparable : ambigu, on s'abstient
    if (proches.length > 1 && proches[1].d < proches[0].d * 1.5) return null;
    return proches[0].num;
  }

  /** Intègre un événement décodé. Retourne l'événement enrichi à diffuser (ou null). */
  function integrer(evt) {
    const maintenant = Date.now();

    if (evt.genre === 'statut') {
      if (evt.num == null) return null;
      stockage.assurerNoeud(evt.num, maintenant);
      q.etatPasserelle.run(evt.etat, maintenant, evt.num);
      return { genre: 'statut', num: evt.num, etat: evt.etat };
    }
    if (evt.genre !== 'paquet') return null;

    const heure = maintenant;
    let sortie = null;

    stockage.transaction(() => {
      stockage.assurerNoeud(evt.de, heure);
      q.vu.run({ num: evt.de, heure, sauts: evt.sauts, snr: evt.sauts === 0 ? evt.snr : null, rssi: evt.sauts === 0 ? evt.rssi : null });

      const gw = evt.numPasserelle;
      if (gw != null) {
        stockage.assurerNoeud(gw, heure);
        q.passerelle.run(heure, gw);
        q.vu.run({ num: gw, heure, sauts: null, snr: null, rssi: null });
      }

      const garderTexte = evt.port === 'texte' && (config.canauxTexte.length === 0 || config.canauxTexte.includes(evt.canal));
      const r = q.insererPaquet.get({
        idPaquet: evt.idPaquet,
        de: evt.de,
        vers: evt.vers,
        canal: evt.canal || evt.canalTopic,
        port: evt.port,
        nomPort: evt.nomPort,
        portnum: evt.portnum,
        heure,
        hopDepart: evt.hopDepart,
        hopRestant: evt.hopRestant,
        sauts: evt.sauts,
        dechiffre: evt.dechiffre ? 1 : 0,
        resume: evt.port === 'texte' ? 'Message texte' : evt.resume,
        texte: garderTexte ? evt.texte : null,
        taille: evt.taille ?? null,
        viaMqtt: evt.viaMqtt ? 1 : 0,
        contenu: evt.contenu ? JSON.stringify(evt.contenu) : null,
        pki: evt.pki ? 1 : 0,
      });
      const premiereReception = r.nb_receptions === 1;

      // Liens radio déduits de la réception par la passerelle
      let relaisNum = null;
      if (gw != null && gw !== evt.de && !evt.viaMqtt) {
        if (evt.sauts === 0) {
          lier(evt.de, gw, 'rf', evt.snr, evt.rssi, heure);
        } else if (evt.relais != null) {
          relaisNum = trouverRelais(evt.relais, [evt.de, gw], gw);
          if (relaisNum != null) lier(relaisNum, gw, 'rf', evt.snr, evt.rssi, heure);
        }
      }
      if (gw != null) {
        const dernierEmetteur = relaisNum != null ? relaisNum : evt.sauts === 0 && gw !== evt.de ? evt.de : null;
        q.reception.run(r.rowid, gw, heure, evt.snr, evt.rssi, evt.sauts, evt.relais, dernierEmetteur, evt.sujet ? `${evt.sujet} · ${evt.canalTopic || ''}` : null);
      }

      // Contenu applicatif (une seule fois par paquet)
      if (premiereReception) {
        if (evt.utilisateur) {
          q.infos.run({ num: evt.de, ...evt.utilisateur, firmware: null, preset: null });
          if (evt.utilisateur.cle) q.clePublique.run(evt.utilisateur.cle, evt.de, evt.utilisateur.cle);
        }
        if (evt.rapportCarte) {
          const m = evt.rapportCarte;
          q.infos.run({ num: evt.de, nomLong: m.nomLong, nomCourt: m.nomCourt, materiel: m.materiel, role: m.role, firmware: m.firmware, preset: m.preset });
          if (m.lat != null) {
            q.position.run({ num: evt.de, lat: m.lat, lon: m.lon, alt: m.alt, precision: m.precision, heure });
          }
        }
        if (evt.position && evt.position.lat != null) {
          const p = evt.position;
          q.position.run({ num: evt.de, lat: p.lat, lon: p.lon, alt: p.alt, precision: p.precision, heure });
          const der = q.derniereHistoPosition.get(evt.de);
          if (!der || Math.abs(der.lat - p.lat) > 1e-4 || Math.abs(der.lon - p.lon) > 1e-4) q.histoPosition.run(evt.de, heure, p.lat, p.lon, p.alt);
        }
        if (evt.telemetrie || evt.environnement) {
          const t = evt.telemetrie || {};
          const e = evt.environnement || {};
          if (evt.telemetrie) q.telemetrie.run({ num: evt.de, heure, batterie: t.batterie ?? null, tension: t.tension ?? null, canal: t.canal ?? null, emission: t.emission ?? null, uptime: t.uptime ?? null });
          if (evt.environnement) q.environnement.run({ num: evt.de, temperature: e.temperature ?? null, humidite: e.humidite ?? null, pression: e.pression ?? null });
          q.histoTelemetrie.run({ num: evt.de, heure, batterie: t.batterie ?? null, tension: t.tension ?? null, canal: t.canal ?? null, emission: t.emission ?? null, temperature: e.temperature ?? null, humidite: e.humidite ?? null, pression: e.pression ?? null, uptime: t.uptime ?? null });
        }
        if (evt.statsLocales) q.statsLocales.run(JSON.stringify(evt.statsLocales), evt.de);
        if (evt.voisinage) {
          const centre = evt.voisinage.noeud || evt.de;
          for (const v of evt.voisinage.voisins) lier(v.num, centre, 'voisinage', v.snr, null, heure);
        }
        if (evt.traceroute && evt.requeteId) {
          // Réponse de traceroute : de = destination, vers = demandeur
          const t = evt.traceroute;
          const aller = [evt.vers, ...t.aller, evt.de];
          aller.slice(1).forEach((b, i) => lier(aller[i], b, 'traceroute', t.snrAller[i] > -32 ? t.snrAller[i] : null, null, heure));
          if (t.retour.length || t.snrRetour.length) {
            const retour = [evt.de, ...t.retour, evt.vers];
            retour.slice(1).forEach((b, i) => lier(retour[i], b, 'traceroute', t.snrRetour[i] > -32 ? t.snrRetour[i] : null, null, heure));
          }
        }
      }

      sortie = {
        genre: 'paquet',
        idPaquet: evt.idPaquet,
        de: evt.de,
        vers: evt.diffusion ? null : evt.vers,
        passerelle: gw,
        relais: relaisNum,
        sauts: evt.sauts,
        snr: evt.snr,
        rssi: evt.rssi,
        canal: evt.canal || evt.canalTopic,
        port: evt.port,
        nomPort: evt.nomPort,
        resume: evt.port === 'texte' ? 'Message texte' : evt.resume,
        texte: garderTexte ? evt.texte : undefined,
        premiere: premiereReception,
        heure,
      };
    })();

    return sortie;
  }

  function statut(n, maintenant) {
    const age = maintenant - (n.dernier_vu || 0);
    if (age < s.actifMinutes * 60000) return 'actif';
    if (age < s.inactifHeures * 3600000) return 'recent';
    return 'inactif';
  }

  function arrondir(v, dec) {
    if (v == null || dec < 0) return v;
    const f = 10 ** dec;
    return Math.round(v * f) / f;
  }

  /** Vue d'un nœud (publique ou admin) */
  /** Trame vue par le public : coordonnées arrondies comme sur la carte (sauf relais et passerelles) */
  function vueTrame(t, admin) {
    const dec = config.precisionPublique;
    if (admin || dec < 0 || !t || (t.port !== 'position' && t.port !== 'mapreport')) return t;
    if (estSurveille(q.noeud.get(t.de))) return t;
    const r = { ...t };
    if (typeof r.resume === 'string') {
      r.resume = r.resume.replace(/^(-?\d+\.\d+), (-?\d+\.\d+)/, (_, a, b) => `${arrondir(+a, dec).toFixed(dec)}, ${arrondir(+b, dec).toFixed(dec)}`);
    }
    if (r.contenu) {
      const brut = typeof r.contenu === 'string';
      let c;
      try { c = brut ? JSON.parse(r.contenu) : { ...r.contenu }; } catch { return { ...r, contenu: null }; }
      for (const k of ['latitudeI', 'longitudeI']) if (c[k] != null) c[k] = Math.round(arrondir(c[k] / 1e7, dec) * 1e7);
      for (const k of ['latitude', 'longitude', 'lat', 'lon']) if (typeof c[k] === 'number') c[k] = arrondir(c[k], dec);
      r.contenu = brut ? JSON.stringify(c) : c;
    }
    return r;
  }

  function vueNoeud(n, admin, maintenant = Date.now()) {
    const infra = estSurveille(n);
    const dec = admin || infra ? -1 : config.precisionPublique;
    return {
      num: n.num,
      id: n.id || idNoeud(n.num),
      nomLong: n.nom_long,
      nomCourt: n.nom_court,
      materiel: n.materiel,
      role: n.role,
      roleFr: ROLES_FR[n.role] || n.role || 'Inconnu',
      firmware: n.firmware,
      preset: n.preset,
      lat: arrondir(n.lat, dec),
      lon: arrondir(n.lon, dec),
      alt: n.alt,
      heurePosition: n.heure_position,
      premierVu: n.premier_vu,
      dernierVu: n.dernier_vu,
      batterie: n.batterie,
      tension: n.tension,
      canal: n.canal,
      emission: n.emission,
      uptime: n.uptime,
      heureTelemetrie: n.heure_telemetrie,
      temperature: n.temperature,
      humidite: n.humidite,
      pression: n.pression,
      sautsMin: n.sauts_min,
      sautsDernier: n.sauts_dernier,
      snr: n.snr_dernier,
      rssi: n.rssi_dernier,
      passerelle: !!n.est_passerelle,
      etatPasserelle: n.etat_passerelle,
      dernierVuPasserelle: n.dernier_vu_passerelle,
      statsLocales: n.stats_locales ? JSON.parse(n.stats_locales) : null,
      infrastructure: infra,
      statut: statut(n, maintenant),
    };
  }

  function calculerAlertes() {
    const maintenant = Date.now();
    const nouvelles = new Map();
    const ajouter = (cle, a) => {
      const ancienne = alertesActives.get(cle);
      nouvelles.set(cle, { cle, depuis: ancienne ? ancienne.depuis : maintenant, ...a });
    };
    for (const n of q.noeuds.all()) {
      const nom = n.nom_long || n.nom_court || n.id;
      const surveille = estSurveille(n);
      const ageMin = (maintenant - (n.dernier_vu || 0)) / 60000;
      const telemRecente = n.heure_telemetrie && maintenant - n.heure_telemetrie < 24 * 3600000;

      if (surveille && ageMin > s.muetMinutes) {
        ajouter('muet:' + n.num, {
          num: n.num, type: 'muet', niveau: 'critique', nom,
          message: `${nom} n'a pas été entendu depuis ${formaterDuree(ageMin)}`,
        });
      }
      if (n.est_passerelle && n.etat_passerelle === 'offline') {
        ajouter('mqtt:' + n.num, {
          num: n.num, type: 'passerelle', niveau: 'attention', nom,
          message: `Passerelle ${nom} déconnectée du broker MQTT`,
        });
      }
      if (telemRecente) {
        const surBatterie = n.batterie == null || n.batterie <= 100;
        if (surBatterie && ((n.tension > 0 && n.tension < s.tensionVolts) || (n.batterie > 0 && n.batterie <= s.batteriePourcent))) {
          const critique = n.tension > 0 && n.tension < s.tensionVolts - 0.2;
          ajouter('batterie:' + n.num, {
            num: n.num, type: 'batterie', niveau: critique ? 'critique' : 'attention', nom,
            message: `Batterie faible sur ${nom} : ${n.tension ? n.tension.toFixed(2) + ' V' : ''}${n.batterie != null ? ' (' + n.batterie + ' %)' : ''}`,
          });
        }
        if (surveille && surBatterie) {
          const t = q.tension24h.get(n.num, maintenant - 24 * 3600000);
          if (t && t.nb >= 6 && t.max < s.chargeSolaireVolts) {
            ajouter('solaire:' + n.num, {
              num: n.num, type: 'solaire', niveau: 'attention', nom,
              message: `Charge solaire insuffisante sur ${nom} : maximum ${t.max.toFixed(2)} V sur 24 h`,
            });
          }
        }
        const recente2h = maintenant - n.heure_telemetrie < 2 * 3600000;
        if (recente2h && n.canal != null && n.canal >= s.canalPourcent) {
          const critique = n.canal >= s.canalCritiquePourcent;
          ajouter('canal:' + n.num, {
            num: n.num, type: 'canal', niveau: critique ? 'critique' : 'attention', nom,
            message: `Canal ${critique ? 'saturé' : 'chargé'} autour de ${nom} : ${n.canal.toFixed(1)} % d'occupation`,
          });
        }
        if (recente2h && n.emission != null && n.emission >= s.emissionPourcent) {
          ajouter('emission:' + n.num, {
            num: n.num, type: 'emission', niveau: 'attention', nom,
            message: `${nom} émet ${n.emission.toFixed(1)} % du temps (limite réglementaire 10 % en 869,4–869,65 MHz)`,
          });
        }
      }
    }
    alertesActives.clear();
    for (const [k, v] of nouvelles) alertesActives.set(k, v);
    const ordre = { critique: 0, attention: 1 };
    return [...alertesActives.values()].sort((a, b) => ordre[a.niveau] - ordre[b.niveau] || a.depuis - b.depuis);
  }

  function statistiques() {
    const maintenant = Date.now();
    const noeuds = q.noeuds.all();
    const actifs = noeuds.filter((n) => statut(n, maintenant) === 'actif').length;
    const passerelles = noeuds.filter((n) => n.est_passerelle);
    const enLigne = passerelles.filter(
      (n) => n.etat_passerelle !== 'offline' && maintenant - (n.dernier_vu_passerelle || 0) < s.muetMinutes * 60000
    ).length;
    const parPort = {};
    for (const r of q.compteParPort.all(maintenant - 3600000)) parPort[r.port] = r.nb;
    const canaux = noeuds.filter((n) => n.canal != null && n.heure_telemetrie && maintenant - n.heure_telemetrie < 2 * 3600000).map((n) => n.canal);
    return {
      noeuds: noeuds.length,
      actifs,
      passerelles: passerelles.length,
      passerellesEnLigne: enLigne,
      liens: q.liens.all(maintenant - 24 * 3600000).length,
      paquetsMinute: Math.round((q.compteMinute.get(maintenant - 5 * 60000).nb / 5) * 10) / 10,
      paquetsHeure: Object.values(parPort).reduce((a, b) => a + b, 0),
      parPort,
      canalMoyen: canaux.length ? Math.round((canaux.reduce((a, b) => a + b, 0) / canaux.length) * 10) / 10 : null,
      canalMax: canaux.length ? Math.max(...canaux) : null,
    };
  }

  function liens(depuisMs) {
    return q.liens.all(Date.now() - depuisMs).map((l) => ({
      a: l.a, b: l.b, source: l.source, snr: l.snr, rssi: l.rssi, nb: l.nb, dernierVu: l.dernier_vu,
    }));
  }

  function detailNoeud(num, admin) {
    const n = q.noeud.get(num);
    if (!n) return null;
    const maintenant = Date.now();
    const depuis = maintenant - config.retentionJours * 86400000;
    const tousLiens = q.liens.all(depuis).filter((l) => l.a === num || l.b === num);
    const totalObs = tousLiens.reduce((t, l) => t + l.nb, 0) || 1;
    const voisins = new Map();
    for (const l of tousLiens) {
      const autre = l.a === num ? l.b : l.a;
      const v = voisins.get(autre) || { num: autre, nb: 0, snrEntendu: null, snrEmis: null, sources: new Set(), dernierVu: 0 };
      v.nb += l.nb;
      v.sources.add(l.source);
      v.dernierVu = Math.max(v.dernierVu, l.dernier_vu);
      if (l.b === num) v.snrEntendu = l.snr; // num a entendu l'autre
      else v.snrEmis = l.snr; // l'autre a entendu num
      voisins.set(autre, v);
    }
    const listeVoisins = [...voisins.values()]
      .map((v) => {
        const o = q.noeud.get(v.num);
        return {
          ...v,
          sources: [...v.sources],
          part: Math.round((v.nb / totalObs) * 1000) / 10,
          nom: o ? o.nom_long || o.nom_court || o.id : idNoeud(v.num),
          distanceKm: o ? distanceKm(n, o) : null,
        };
      })
      .sort((a, b) => b.nb - a.nb);
    return {
      noeud: vueNoeud(n, admin, maintenant),
      voisins: listeVoisins,
      receptions: q.receptionsNoeud.all(num, depuis).map((r) => {
        const g = q.noeud.get(r.passerelle);
        return { ...r, nom: g ? g.nom_long || g.nom_court || g.id : idNoeud(r.passerelle) };
      }),
      telemetrie: q.histoTelemetrieNoeud.all(num, depuis),
      trajet: admin || estSurveille(n) ? q.histoPositionsNoeud.all(num, depuis) : [],
      paquets: q.paquetsNoeud.all(num, 50).map((p) => vueTrame({ ...p, texte: admin ? p.texte : undefined }, admin)),
    };
  }

  // Nettoyage des données invalides déjà enregistrées (positions (0,0), liens à des distances impossibles)
  function nettoyer() {
    const db = stockage.db;
    const pos = db.prepare('UPDATE noeuds SET lat = NULL, lon = NULL WHERE lat IS NOT NULL AND ABS(lat) < 1 AND ABS(lon) < 1').run().changes;
    db.prepare('DELETE FROM positions WHERE ABS(lat) < 1 AND ABS(lon) < 1').run();
    let liens = 0;
    const supprimer = db.prepare('DELETE FROM liens WHERE a = ? AND b = ? AND source = ?');
    for (const l of db.prepare('SELECT a, b, source FROM liens').all()) {
      if (!lienPlausible(l.a, l.b)) { supprimer.run(l.a, l.b, l.source); liens++; }
    }
    return { positions: pos, liens };
  }

  return { nettoyer, integrer, vueNoeud, vueTrame, calculerAlertes, statistiques, liens, detailNoeud, estSurveille, ROLES_FR };
}

function formaterDuree(minutes) {
  if (minutes < 60) return Math.round(minutes) + ' min';
  if (minutes < 48 * 60) return Math.round(minutes / 60) + ' h';
  return Math.round(minutes / 1440) + ' jours';
}

module.exports = { creerReseau, distanceKm };
