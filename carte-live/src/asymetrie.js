'use strict';
// Liaisons à sens unique : « B entend A, mais A n'entend jamais B ».
// Un lien orienté (a → b) signifie que b a entendu a directement (passerelle, voisinage ou traceroute).
// On ne peut conclure que pour des nœuds qui rapportent ce qu'ils entendent (passerelles MQTT, module de la carte,
// voisinage, traceroutes) : c'est le cas de A s'il apparaît comme récepteur d'au moins un lien récent.

function distanceKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const r = Math.PI / 180, s = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(s));
}

// Relais « sourd » : sur une liaison réciproque, SNR(P entend X) − SNR(X entend P) = (Ptx X − Ptx P) + (bruit X − bruit P).
// Une fois l'écart de puissance retiré (fiche d'installation ou configuration lue), il reste le bruit ou la
// désensibilisation propre à X. Médiane sur ses voisins : un écart de 8 dB ou plus est anormal.
// Une liaison que X ne rapporte pas alors que P l'entend fort donne une borne basse (X était sous son seuil de démodulation).
const SEUIL_SOURD_DB = 8;

function creerAsymetrie(stockage, config, opts = {}) {
  const puissance = opts.puissance || (() => null); // dBm d'émission connue d'un nœud, ou null
  const seuilDemod = opts.seuilDemod || (() => -17.5); // SNR minimal démodulable du preset du réseau
  let cache = null, cacheHeure = 0;

  function calculer() {
    if (cache && Date.now() - cacheHeure < 60000) return cache;
    const maintenant = Date.now();
    const recent = maintenant - 24 * 3600000;
    const long = maintenant - Math.min(config.retentionJours, 7) * 86400000;
    const noeuds = new Map(stockage.q.noeuds.all().map((n) => [n.num, n]));
    const liens = stockage.q.liens.all(long);
    // Meilleure observation par sens (toutes sources confondues)
    const sens = new Map(); // "a>b" → { nb, snr, dernierVu, sources }
    const recepteurs = new Map(); // nœud → émetteurs entendus directement depuis 24 h (passerelle ou voisinage)
    const rapportsVoisinage = new Set();
    for (const l of liens) {
      if (l.a === l.b) continue;
      const k = l.a + '>' + l.b;
      const x = sens.get(k) || { a: l.a, b: l.b, nb: 0, snr: null, dernierVu: 0, sources: new Set() };
      x.nb += l.nb || 1;
      x.dernierVu = Math.max(x.dernierVu, l.dernier_vu || 0);
      if (l.snr != null && (x.snr == null || l.snr > x.snr)) x.snr = l.snr;
      x.sources.add(l.source);
      sens.set(k, x);
      // Un nœud « rapporte ce qu'il entend » s'il est passerelle MQTT (rf) ou s'il publie son voisinage (NeighborInfo).
      // Un simple saut de traceroute ne suffit pas : un relais sans voisinage ni MQTT ne dit rien de ce qu'il entend,
      // et tous les nœuds qu'il entend sans le dire apparaîtraient à tort « à sens unique ».
      if ((l.dernier_vu || 0) >= recent && (l.source === 'rf' || l.source === 'voisinage')) recepteurs.set(l.b, (recepteurs.get(l.b) || new Set()).add(l.a));
      if ((l.dernier_vu || 0) >= recent && l.source === 'voisinage') rapportsVoisinage.add(l.b);
    }
    const actif = (num) => { const n = noeuds.get(num); return n && (n.dernier_vu || n.vu || 0) >= recent; };
    const nom = (num) => { const n = noeuds.get(num); return n ? n.nom_long || n.nom_court || n.id : '!' + (num >>> 0).toString(16); };
    const pos = (num) => { const n = noeuds.get(num); return n && n.lat != null ? { lat: n.lat, lon: n.lon } : null; };
    const maxKm = config.lienDistanceMaxKm || 120;
    const passerelles = new Set(liens.filter((l) => l.source === 'rf' && (l.dernier_vu || 0) >= recent).map((l) => l.b));
    const estPasserelle = (num) => passerelles.has(num);

    const sensUnique = [], desequilibres = [];
    const vus = new Set();
    for (const x of sens.values()) {
      if (x.dernierVu < recent || x.nb < 3) continue; // B entend A récemment et régulièrement
      const A = x.a, B = x.b;
      const cle = A < B ? A + '-' + B : B + '-' + A;
      const inverse = sens.get(B + '>' + A);
      const d = distanceKm(pos(A), pos(B));
      if (d != null && d > maxKm) continue;
      if (!inverse) {
        // A rapporte ce qu'il entend, et B émet : A devrait l'entendre
        if (!recepteurs.has(A) || !actif(B)) continue;
        // Voisinage plein (10 voisins au plus dans un rapport Meshtastic) : l'absence de B n'est pas une preuve
        if (!estPasserelle(A) && recepteurs.get(A).size >= 10) continue;
        sensUnique.push({ preuve: estPasserelle(A) ? 'passerelle' : 'voisinage', entend: B, entendu: A, nomEntend: nom(B), nomEntendu: nom(A), snr: x.snr, nb: x.nb, sources: [...x.sources], distanceKm: d != null ? Math.round(d * 10) / 10 : null, a: pos(A), b: pos(B) });
      } else if (!vus.has(cle) && x.snr != null && inverse.snr != null && Math.abs(x.snr - inverse.snr) >= 10 && inverse.dernierVu >= recent) {
        vus.add(cle);
        const fort = x.snr > inverse.snr ? x : inverse, faible = fort === x ? inverse : x;
        desequilibres.push({ a: fort.a, b: fort.b, nomA: nom(fort.a), nomB: nom(fort.b), snrFort: fort.snr, snrFaible: faible.snr, ecart: Math.round((fort.snr - faible.snr) * 10) / 10, distanceKm: d != null ? Math.round(d * 10) / 10 : null, posA: pos(fort.a), posB: pos(fort.b) });
      }
    }
    // Nœuds qui entendent leurs voisins mais que personne n'entend directement
    const entendus = new Set([...sens.values()].map((x) => x.a));
    const inaudibles = [];
    for (const [num, set] of recepteurs) {
      if (set.size < 2 || entendus.has(num) || !actif(num)) continue;
      inaudibles.push({ num, nom: nom(num), entend: set.size, voisins: [...set].slice(0, 8).map(nom), pos: pos(num) });
    }
    // ---- Relais sourds ----
    const sourds = [];
    const parNoeud = new Map(); // X → mesures
    const ajouterMesure = (X, m) => { if (!parNoeud.has(X)) parNoeud.set(X, []); parNoeud.get(X).push(m); };
    const seuil = seuilDemod();
    for (const x of sens.values()) {
      // x : x.b a entendu x.a (SNR mesuré chez x.b)
      const X = x.a, P = x.b; // SNR chez P du signal de X = x.snr
      if (x.snr == null || x.dernierVu < recent) continue;
      const d = distanceKm(pos(X), pos(P));
      if (d != null && d > maxKm) continue;
      const inv = sens.get(P + '>' + X); // X a entendu P
      const pX = puissance(X), pP = puissance(P);
      const corr = pX != null && pP != null ? pX - pP : 0;
      if (inv && inv.snr != null && inv.dernierVu >= recent) {
        ajouterMesure(X, { partenaire: P, entenduChezPartenaire: x.snr, entenduChezLui: inv.snr, ecart: Math.round((x.snr - inv.snr - corr) * 10) / 10, borne: false, corrige: pX != null && pP != null });
      } else if (recepteurs.has(X) && actif(P) && x.nb >= 3 && (estPasserelle(X) || recepteurs.get(X).size < 10)) {
        // X rapporte ce qu'il entend mais jamais P, alors que P l'entend : X a reçu P sous son seuil
        const borne = x.snr - seuil - corr;
        if (borne >= SEUIL_SOURD_DB) ajouterMesure(X, { partenaire: P, entenduChezPartenaire: x.snr, entenduChezLui: null, ecart: Math.round(borne * 10) / 10, borne: true, corrige: pX != null && pP != null });
      }
    }
    for (const [X, l] of parNoeud) {
      const reels = l.filter((m) => !m.borne);
      if (!actif(X) || l.length < 2 || !reels.length) continue; // au moins une mesure réciproque et deux voisins
      const v = l.map((m) => m.ecart).sort((a, b) => a - b);
      const med = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
      const accord = l.filter((m) => m.ecart >= SEUIL_SOURD_DB).length;
      if (med < SEUIL_SOURD_DB || accord < 2) continue;
      sourds.push({
        num: X, nom: nom(X), pos: pos(X), ecartDb: Math.round(med * 10) / 10, nbVoisins: l.length, nbConcordants: accord,
        puissanceConnue: puissance(X) != null,
        mesures: l.sort((a, b) => b.ecart - a.ecart).slice(0, 8).map((m) => ({ ...m, nomPartenaire: nom(m.partenaire) })),
      });
    }
    sourds.sort((a, b) => b.ecartDb - a.ecartDb);
    sensUnique.sort((u, v) => v.nb - u.nb);
    desequilibres.sort((u, v) => v.ecart - u.ecart);
    cache = { heure: maintenant, sourds, sensUnique: sensUnique.slice(0, 100), desequilibres: desequilibres.slice(0, 100), inaudibles };
    cacheHeure = maintenant;
    return cache;
  }
  return { calculer };
}

module.exports = { creerAsymetrie };
