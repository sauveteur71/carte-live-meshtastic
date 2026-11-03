'use strict';
// Contrôle du trafic : nœuds trop bavards (positions, télémétrie, fiches) et paquets réinjectés depuis MQTT.
// Sert à repérer ce qui encombre le canal radio et à le corriger (programmation à distance, « Ignorer MQTT »).

const FIXES = new Set(['ROUTER', 'ROUTER_LATE', 'CLIENT_BASE', 'REPEATER', 'ROUTER_CLIENT']);
// Intervalles minimaux conseillés (secondes)
const SEUILS = {
  positionFixe: 14400, // relais et points fixes : 4 h au moins
  position: 300, // autres : 5 min (un mobile peut descendre en « smart position », pas en dessous)
  telemetrie: 1800, // 30 min (valeur par défaut du firmware)
  nodeinfo: 3600, // 1 h (défaut 3 h)
};
const PORTS = ['position', 'telemetrie', 'nodeinfo'];

function creerControleTrafic({ stockage, config, administration }) {
  const db = stockage.db;
  const q = {
    paquets: db.prepare(`SELECT p.de, p.port, p.heure FROM paquets p WHERE p.heure >= ? AND p.port IN ('position', 'telemetrie', 'nodeinfo') ORDER BY p.de, p.port, p.heure`),
    // Nœuds entendus par une passerelle de la zone (le reste n'arrive que par le broker). Une passerelle qui publie
    // ses propres paquets ne compte pas : sa télémétrie « locale » (toutes les 60 s vers l'appli) ne passe pas en radio.
    passerelles: db.prepare('SELECT num, lat, lon FROM noeuds WHERE est_passerelle = 1'),
    entendus: db.prepare(`SELECT DISTINCT p.de, p.port FROM paquets p JOIN receptions r ON r.paquet = p.rowid WHERE p.heure >= ? AND r.passerelle <> p.de AND r.passerelle IN (SELECT value FROM json_each(?))`),
    noeud: db.prepare('SELECT num, nom_long, nom_court, role, lat, lon, firmware FROM noeuds WHERE num = ?'),
    // Paquets réinjectés depuis MQTT (drapeau via_mqtt) puis entendus en radio
    reinjectes: db.prepare(`SELECT p.de, p.port, r.relais_num AS injecteur, r.passerelle, r.sauts, COUNT(*) AS nb FROM paquets p JOIN receptions r ON r.paquet = p.rowid
      WHERE p.heure >= ? AND p.via_mqtt = 1 GROUP BY p.de, p.port, r.relais_num, r.passerelle`),
    totalRadio: db.prepare(`SELECT COUNT(DISTINCT p.rowid) AS n FROM paquets p JOIN receptions r ON r.paquet = p.rowid WHERE p.heure >= ? AND r.passerelle IN (SELECT value FROM json_each(?))`),
  };
  const dansZone = (n) => { const z = config.zone; return n && n.lat != null && n.lat >= z[0] && n.lat <= z[2] && n.lon >= z[1] && n.lon <= z[3]; };
  const id = (num) => '!' + (num >>> 0).toString(16).padStart(8, '0');

  function analyser(heures = 24) {
    const depuis = Date.now() - heures * 3600000;
    const gwZone = q.passerelles.all().filter(dansZone).map((g) => g.num);
    const entendus = new Set(gwZone.length ? q.entendus.all(depuis, JSON.stringify(gwZone)).map((x) => `${x.de >>> 0}|${x.port}`) : []);
    const admin = administration ? administration.administrables() : {};
    // Intervalle médian entre deux paquets du même type (doublons d'un même paquet déjà fusionnés en base)
    const groupes = new Map();
    for (const p of q.paquets.iterate(depuis)) {
      const k = `${p.de >>> 0}|${p.port}`;
      const g = groupes.get(k) || { de: p.de >>> 0, port: p.port, heures: [] };
      g.heures.push(p.heure);
      groupes.set(k, g);
    }
    const parNoeud = new Map();
    for (const g of groupes.values()) {
      if (g.heures.length < 4) continue;
      const ecarts = [];
      for (let i = 1; i < g.heures.length; i++) ecarts.push((g.heures[i] - g.heures[i - 1]) / 1000);
      ecarts.sort((a, b) => a - b);
      const median = ecarts[Math.floor(ecarts.length / 2)];
      const n = q.noeud.get(g.de) || { num: g.de };
      const fixe = FIXES.has(n.role);
      const seuil = g.port === 'position' ? (fixe ? SEUILS.positionFixe : SEUILS.position) : SEUILS[g.port];
      if (median >= seuil) continue;
      // Ce type de paquet est-il vraiment passé en radio (entendu par une autre passerelle de la zone) ?
      const enRadio = entendus.has(`${g.de}|${g.port}`);
      const e = parNoeud.get(g.de) || {
        num: g.de, id: id(g.de), nom: n.nom_long || n.nom_court || id(g.de), role: n.role || null, fixe,
        zone: dansZone(n), radio: false, administrable: !!(admin[String(g.de)] && admin[String(g.de)].ok), problemes: [], paquetsJour: 0,
      };
      const parJour = Math.round((g.heures.length * 24) / heures);
      e.paquetsJour += parJour;
      e.problemes.push({ port: g.port, nb: g.heures.length, parJour, medianS: Math.round(median), conseilS: seuil, radio: enRadio });
      if (enRadio) e.radio = true;
      parNoeud.set(g.de, e);
    }
    const bavards = [...parNoeud.values()].sort((a, b) => (b.radio - a.radio) || b.paquetsJour - a.paquetsJour);

    // Réinjection MQTT → radio : qui l'émet (injecteur = dernier relais vu par la passerelle), et de qui viennent les paquets
    const inj = new Map(), orig = new Map();
    let totalReinjectes = 0;
    for (const r of q.reinjectes.all(depuis)) {
      totalReinjectes += r.nb;
      const k = r.injecteur != null ? r.injecteur >>> 0 : 'inconnu';
      const x = inj.get(k) || { num: r.injecteur != null ? r.injecteur >>> 0 : null, nb: 0, origines: new Set(), ports: {} };
      x.nb += r.nb; x.origines.add(r.de >>> 0); x.ports[r.port] = (x.ports[r.port] || 0) + r.nb;
      inj.set(k, x);
      const o = orig.get(r.de >>> 0) || { num: r.de >>> 0, nb: 0 };
      o.nb += r.nb; orig.set(r.de >>> 0, o);
    }
    const nomDe = (num) => { const n = num != null && q.noeud.get(num); return n ? n.nom_long || n.nom_court || id(num) : num != null ? id(num) : 'non identifié'; };
    const radioTotal = gwZone.length ? q.totalRadio.get(depuis, JSON.stringify(gwZone)).n : 0;
    return {
      heures, seuils: SEUILS, genere: Date.now(), passerellesZone: gwZone.length,
      bavards,
      reinjection: {
        total: totalReinjectes, partPct: radioTotal ? Math.round((totalReinjectes / radioTotal) * 1000) / 10 : null,
        injecteurs: [...inj.values()].map((x) => ({ num: x.num, nom: nomDe(x.num), nb: x.nb, origines: x.origines.size, ports: x.ports, administrable: !!(x.num != null && admin[String(x.num)] && admin[String(x.num)].ok) })).sort((a, b) => b.nb - a.nb).slice(0, 20),
        origines: [...orig.values()].map((x) => ({ ...x, nom: nomDe(x.num) })).sort((a, b) => b.nb - a.nb).slice(0, 15),
      },
    };
  }

  // Réglages correctifs pour un nœud trop bavard (appliqués par une tâche « modifier »)
  function correctifs(e) {
    const p = {};
    for (const pb of e.problemes) {
      if (pb.port === 'position') p.position = { ...(p.position || {}), positionBroadcastSecs: e.fixe ? 43200 : 900, ...(e.fixe ? { positionBroadcastSmartEnabled: false } : {}) };
      if (pb.port === 'telemetrie') p.telemetrie = { deviceUpdateInterval: 1800 };
      if (pb.port === 'nodeinfo') p.device = { ...(p.device || {}), nodeInfoBroadcastSecs: 10800 };
    }
    return p;
  }

  return { analyser, correctifs, SEUILS };
}

module.exports = { creerControleTrafic, SEUILS };
