/* Carte live — animations communes (Meshtastic et MeshCore)
 *  - comète : un point lumineux et sa traînée parcourent le trajet du paquet, saut par saut ;
 *  - éventail : chaque récepteur qui entend le paquet reçoit sa propre comète (une par réception) ;
 *  - liaisons : chaque saut emprunté s'allume au passage, et les axes les plus utilisés
 *    depuis 10 minutes sont soulignés par un halo plus épais. */
'use strict';

const anim = { enCours: 0, max: 30, axes: new Map(), couche: null, coucheAllumes: null, minuterie: null };

// Durée d'un saut (ms) selon sa longueur : rapide pour les sauts courts, plafonnée pour les longs
const dureeSaut = (km) => Math.min(1100, 320 + km * 22);

/**
 * Anime un trajet [{ lat, lon, cle? }, …] : la comète part du premier point et s'arrête à chaque relais.
 * opts : { couleur, estime (trajet déduit : traînée en pointillé), auFil(i) appelé à chaque arrivée }
 */
function animerTrajet(pts, opts = {}) {
  pts = pts.filter((p) => p && p.lat != null && p.lon != null);
  if (pts.length < 2 || document.hidden || anim.enCours >= anim.max) return false;
  anim.enCours++;
  const couleur = opts.couleur || '#3ee6c4';
  const trace = L.polyline([[pts[0].lat, pts[0].lon]], { pane: 'traces', color: couleur, weight: 3, opacity: 0.95, dashArray: opts.estime ? '4 7' : null, className: 'comete-trace', interactive: false }).addTo(carte);
  const tete = L.circleMarker([pts[0].lat, pts[0].lon], { pane: 'traces', radius: 5, color: '#fff', weight: 2, fillColor: couleur, fillOpacity: 1, className: 'comete-tete', interactive: false }).addTo(carte);
  const segments = [];
  for (let i = 0; i + 1 < pts.length; i++) segments.push({ a: pts[i], b: pts[i + 1], duree: dureeSaut(distanceKm(pts[i], pts[i + 1]) || 0) });
  const pause = 140;
  let i = 0, debut = performance.now(), parcourus = [[pts[0].lat, pts[0].lon]];
  const fin = () => {
    tete.remove();
    const el = trace.getElement && trace.getElement();
    if (el) el.classList.add('comete-fin');
    setTimeout(() => trace.remove(), 1200);
    anim.enCours--;
  };
  const etape = (t) => {
    const s = segments[i];
    const f = Math.min(1, (t - debut) / s.duree);
    const e = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2; // accélère puis ralentit
    const lat = s.a.lat + (s.b.lat - s.a.lat) * e, lon = s.a.lon + (s.b.lon - s.a.lon) * e;
    tete.setLatLng([lat, lon]);
    trace.setLatLngs([...parcourus, [lat, lon]]);
    if (f < 1) { requestAnimationFrame(etape); return; }
    parcourus.push([s.b.lat, s.b.lon]);
    allumerLien(s.a, s.b, couleur, opts.estime);
    noterAxe(s.a, s.b);
    if (opts.auFil) opts.auFil(i + 1);
    i++;
    if (i >= segments.length) { fin(); return; }
    setTimeout(() => { debut = performance.now(); requestAnimationFrame(etape); }, pause);
  };
  requestAnimationFrame(etape);
  return true;
}

// Liaison empruntée : halo bref le long du saut
function allumerLien(a, b, couleur, estime) {
  if (!anim.coucheAllumes) anim.coucheAllumes = L.layerGroup().addTo(carte);
  const l = L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { pane: 'liens', color: couleur, weight: estime ? 5 : 8, opacity: estime ? 0.35 : 0.55, className: 'lien-allume', interactive: false }).addTo(anim.coucheAllumes);
  setTimeout(() => l.remove(), 1600);
}

// Axes actifs : nombre de passages par saut sur 10 minutes
const cleAxe = (a, b) => { const x = `${a.lat.toFixed(4)},${a.lon.toFixed(4)}`, y = `${b.lat.toFixed(4)},${b.lon.toFixed(4)}`; return x < y ? x + '|' + y : y + '|' + x; };
function noterAxe(a, b) {
  const k = cleAxe(a, b);
  const x = anim.axes.get(k) || { a: [a.lat, a.lon], b: [b.lat, b.lon], t: [] };
  x.t.push(Date.now());
  anim.axes.set(k, x);
  if (!anim.minuterie) anim.minuterie = setTimeout(() => { anim.minuterie = null; dessinerAxes(); }, 2500);
}
function dessinerAxes() {
  if (!anim.couche) anim.couche = L.layerGroup().addTo(carte);
  anim.couche.clearLayers();
  const limite = Date.now() - 10 * 60000;
  for (const [k, x] of anim.axes) {
    x.t = x.t.filter((t) => t >= limite);
    if (!x.t.length) { anim.axes.delete(k); continue; }
  }
  if (!etat.couches.animations) return;
  for (const x of anim.axes.values()) {
    const n = x.t.length;
    if (n < 2) continue;
    L.polyline([x.a, x.b], { pane: 'couverture', color: '#fde68a', weight: Math.min(4 + Math.log2(n) * 3, 18), opacity: Math.min(0.12 + n * 0.02, 0.35), lineCap: 'round', interactive: false, className: 'axe-actif' })
      .addTo(anim.couche);
  }
}
setInterval(() => { if (typeof carte !== 'undefined' && carte) dessinerAxes(); }, 20000);

/**
 * Meshtastic : trajet le plus probable de « de » jusqu'à « fin » en exactement « sauts » liaisons connues
 * (radio, voisinage, traceroute), en privilégiant les liaisons les plus souvent observées.
 * Renvoie une liste de numéros de nœuds (de … fin) ou null.
 */
function cheminProbableMt(de, fin, sauts) {
  if (de == null || fin == null || sauts == null || sauts < 1 || sauts > 8) return null;
  const voisins = new Map();
  const ajouter = (a, b, poids) => { if (!voisins.has(a)) voisins.set(a, new Map()); const m = voisins.get(a); m.set(b, Math.max(m.get(b) || 0, poids)); };
  for (const l of etat.liens) {
    const na = etat.noeuds.get(l.a), nb = etat.noeuds.get(l.b);
    if (!na || !nb || na.lat == null || nb.lat == null) continue;
    const poids = Math.log2(1 + (l.nb || 1)) + (l.source === 'traceroute' ? 1 : 0);
    ajouter(l.a, l.b, poids); ajouter(l.b, l.a, poids);
  }
  if (!voisins.has(de)) return null;
  // Programmation dynamique : meilleur score pour atteindre chaque nœud en k sauts
  let couche = new Map([[de, { score: 0, chemin: [de] }]]);
  for (let k = 1; k <= sauts; k++) {
    const suivante = new Map();
    for (const [n, v] of couche) {
      for (const [m, p] of voisins.get(n) || []) {
        if (v.chemin.includes(m)) continue;
        if (k < sauts && m === fin) continue;
        const s = v.score + p;
        const actuel = suivante.get(m);
        if (!actuel || s > actuel.score) suivante.set(m, { score: s, chemin: [...v.chemin, m] });
      }
    }
    couche = suivante;
    if (!couche.size) return null;
  }
  const r = couche.get(fin);
  return r ? r.chemin : null;
}

// Paquet Meshtastic reçu par une passerelle : trajet exact si connu, sinon le plus probable, sinon ligne directe estimée
function animerPaquetMt(p, couleur) {
  const gw = etat.noeuds.get(p.passerelle), src = etat.noeuds.get(p.de);
  if (!gw || gw.lat == null || !src || src.lat == null || src.num === gw.num) return false;
  const pt = (num) => { const n = etat.noeuds.get(num); return n && n.lat != null ? { lat: n.lat, lon: n.lon, cle: num } : null; };
  let chemin = null, estime = false;
  if (p.sauts === 0) chemin = [p.de, p.passerelle];
  else if (p.relais != null && p.sauts === 1) chemin = [p.de, p.relais, p.passerelle];
  else if (p.sauts > 0) {
    // « sauts » = nombre de relais traversés, donc sauts + 1 liaisons. Dernier relais connu : trajet probable jusqu'à lui, puis saut final
    const avant = p.relais != null ? cheminProbableMt(p.de, p.relais, p.sauts) : cheminProbableMt(p.de, p.passerelle, p.sauts + 1);
    if (avant) chemin = p.relais != null ? [...avant, p.passerelle] : avant;
    else chemin = p.relais != null ? [p.de, p.relais, p.passerelle] : [p.de, p.passerelle];
    estime = true;
  }
  if (!chemin) return false;
  const pts = chemin.map(pt);
  if (pts.some((x) => !x)) return animerTrajet([pt(p.de), pt(p.passerelle)], { couleur, estime: true });
  return animerTrajet(pts, { couleur, estime, auFil: (i) => flasher(chemin[i]) });
}
