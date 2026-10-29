'use strict';
// Favoris entre relais (« sauts gratuits », firmware 2.7.11 et plus) :
// un ROUTER, ROUTER_LATE ou CLIENT_BASE ne décompte pas le saut d'un paquet que lui relaie un ROUTER / ROUTER_LATE
// de ses favoris. On propose, pour chaque relais récepteur, les routeurs qu'il entend directement.

const ROUTEURS = ['ROUTER', 'ROUTER_LATE'];
const RECEPTEURS = ['ROUTER', 'ROUTER_LATE', 'CLIENT_BASE'];
const versionTab = (v) => { const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')); return m ? [+m[1], +m[2], +m[3]] : null; };
const auMoins = (v, min) => { const a = versionTab(v), b = versionTab(min); if (!a || !b) return null; for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return true; };

function creerFavoris({ stockage, config, administration }) {
  const id = (num) => '!' + (num >>> 0).toString(16).padStart(8, '0');
  const dansZone = (n) => { const z = config.zone; return !z || (n.lat != null && n.lat >= z[0] && n.lat <= z[2] && n.lon >= z[1] && n.lon <= z[3]); };

  function plan({ jours = 7, snrMin = -15 } = {}) {
    const depuis = Date.now() - jours * 86400000;
    const noeuds = stockage.q.noeuds.all().filter((n) => (n.dernier_vu || 0) >= depuis);
    const parNum = new Map(noeuds.map((n) => [n.num >>> 0, n]));
    const nom = (num) => { const n = parNum.get(num) || stockage.q.noeud.get(num); return n ? n.nom_long || n.nom_court || id(num) : id(num); };
    // entendu.get(b).get(a) : b a entendu a directement (radio, voisinage ou traceroute)
    const entendu = new Map();
    for (const l of stockage.q.liens.all(depuis)) {
      if (l.snr != null && l.snr < snrMin) continue;
      const b = l.b >>> 0, a = l.a >>> 0;
      if (!entendu.has(b)) entendu.set(b, new Map());
      const e = entendu.get(b).get(a);
      if (!e || (l.snr ?? -99) > (e.snr ?? -99)) entendu.get(b).set(a, { snr: l.snr, source: l.source });
    }
    const posesTous = administration.favoris();
    const adm = administration.administrables();
    const routeurs = noeuds.filter((n) => ROUTEURS.includes(n.role) && dansZone(n));
    const sortie = [];
    for (const r of noeuds.filter((n) => RECEPTEURS.includes(n.role) && dansZone(n))) {
      const R = r.num >>> 0;
      const poses = posesTous[String(R)] || {};
      const favs = [];
      for (const s of routeurs) {
        const S = s.num >>> 0;
        if (S === R) continue;
        const direct = entendu.get(R) && entendu.get(R).get(S); // R entend S
        const inverse = entendu.get(S) && entendu.get(S).get(R); // S entend R (liaison sans doute réciproque)
        if (!direct && !inverse) continue;
        favs.push({ num: S, id: id(S), nom: nom(S), role: s.role, snr: direct ? direct.snr : inverse.snr, preuve: direct ? 'entendu' : 'inverse', source: (direct || inverse).source, pose: poses[S] ? poses[S].heure : null });
      }
      if (!favs.length) continue;
      favs.sort((a, b) => (a.preuve === 'entendu' ? 0 : 1) - (b.preuve === 'entendu' ? 0 : 1) || (b.snr ?? -99) - (a.snr ?? -99));
      const fwOk = auMoins(r.firmware, '2.7.11');
      sortie.push({
        num: R, id: id(R), nom: nom(R), role: r.role, firmware: r.firmware || null, firmwareOk: fwOk,
        admin: adm[R] ? !!adm[R].ok : null, favoris: favs.slice(0, 12),
        aPoser: favs.filter((f) => !f.pose).length,
      });
    }
    sortie.sort((a, b) => b.aPoser - a.aPoser || a.nom.localeCompare(b.nom));
    return { jours, recepteurs: sortie, totalAPoser: sortie.reduce((t, x) => t + x.aPoser, 0) };
  }
  return { plan };
}

module.exports = { creerFavoris };
