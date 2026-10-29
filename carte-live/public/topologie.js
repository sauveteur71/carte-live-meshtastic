'use strict';
// Topologie du réseau Meshtastic : graphe des liaisons mesurées, analyse (points de rupture, liaisons critiques,
// relais les plus traversés, distance aux passerelles, îlots) et simulation de la propagation d'un paquet
// (public/sim-maillage.js, logique du firmware 2.7).

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 0, u = '') => (v == null || Number.isNaN(v) ? '–' : Number(v).toFixed(d).replace('.', ',') + u);
// Réseau affiché : Meshtastic (par défaut) ou MeshCore (?reseau=mc)
const MC = new URLSearchParams(location.search).get('reseau') === 'mc';
const ROLES = MC ? {
  repeteur: ['Répéteur', 'var(--r-router)'], salon: ['Room server', 'var(--r-base)'], companion: ['Companion', 'var(--r-client)'], capteur: ['Capteur', 'var(--r-muet)'],
} : {
  ROUTER: ['Routeur', 'var(--r-router)'], ROUTER_LATE: ['Routeur tardif', 'var(--r-late)'], CLIENT_BASE: ['Client de base', 'var(--r-base)'],
  CLIENT: ['Client', 'var(--r-client)'], CLIENT_MUTE: ['Client muet', 'var(--r-muet)'], REPEATER: ['Répéteur', 'var(--r-late)'],
};
const PASSERELLE = MC ? 'observateur' : 'passerelle MQTT';
const couleurRole = (r) => (ROLES[r] || [null, 'var(--r-autre)'])[1];
const libRole = (r) => (ROLES[r] || [r || 'inconnu'])[0];
const NE_RELAIENT_PAS = ['CLIENT_MUTE', 'CLIENT_HIDDEN'];
const couleurSnr = (s) => (s == null ? '#8d99ae' : s >= 5 ? '#3ee6c4' : s >= -5 ? '#f4d35e' : s >= -12 ? '#f39a4a' : '#ff5c6c');

const etat = {
  donnees: null, noeuds: [], liens: [], parNum: new Map(), voisins: new Map(), analyse: null,
  choisi: null, rolesSim: {}, essais: [], sim: null, anim: null, montrerRupture: true,
};
const nomDe = (num) => { const n = etat.parNum.get(num); return n ? n.nomLong || n.nomCourt || n.id : '!' + (num >>> 0).toString(16).padStart(8, '0'); };
const courtDe = (num) => { const n = etat.parNum.get(num); return n ? n.nomCourt || n.id.slice(-4) : '?'; };

// ---- Chargement ------------------------------------------------------------------------------
async function charger(recadrer = true) {
  const sources = [...document.querySelectorAll('.source:checked')].map((c) => c.value).join(',');
  const r = await fetch(`/api/${MC ? 'mc/' : ''}topologie?heures=${$('#periode').value}&zone=${$('#zone').value}&sources=${sources}`, { credentials: 'same-origin' });
  if (!r.ok) throw new Error('Données indisponibles');
  const d = await r.json();
  etat.donnees = d;
  const doubleSens = $('#double-sens').checked;
  etat.liens = d.liens.filter((l) => !doubleSens || (l.ab && l.ba)).map((l) => {
    const snrs = [l.ab && l.ab.snr, l.ba && l.ba.snr].filter((x) => x != null);
    return { ...l, source: l.a, target: l.b, unique: !(l.ab && l.ba), meilleur: snrs.length ? Math.max(...snrs) : null };
  });
  const relies = new Set(etat.liens.flatMap((l) => [l.a, l.b]));
  // Garde la position des nœuds déjà dessinés
  const anciens = new Map(etat.noeuds.map((n) => [n.num, n]));
  etat.noeuds = d.noeuds.filter((n) => relies.has(n.num) || n.passerelle).map((n) => { const a = anciens.get(n.num); return a ? { ...n, x: a.x, y: a.y, vx: 0, vy: 0 } : { ...n }; });
  etat.parNum = new Map(etat.noeuds.map((n) => [n.num, n]));
  etat.parCle = new Map(etat.noeuds.filter((n) => n.cle).map((n) => [n.cle, n.num]));
  etat.liens = etat.liens.filter((l) => etat.parNum.has(l.a) && etat.parNum.has(l.b));
  etat.voisins = new Map(etat.noeuds.map((n) => [n.num, []]));
  for (const l of etat.liens) { etat.voisins.get(l.a).push(l); etat.voisins.get(l.b).push(l); }
  $('#titre-zone').textContent = `· ${d.zoneNom || ''} · ${etat.noeuds.length} nœuds · ${etat.liens.length} liaisons · preset ${d.preset}`;
  etat.analyse = analyser();
  dessiner(recadrer);
  rendreAnalyse();
  rendreSimulation();
  if (etat.choisi && etat.parNum.has(etat.choisi)) choisir(etat.choisi, false);
}

// ---- Analyse du graphe -------------------------------------------------------------------------
// Un paquet ne traverse que des nœuds qui relaient (pas les CLIENT_MUTE) ; il atteint « internet » par une passerelle MQTT.
function analyser() {
  const nums = etat.noeuds.map((n) => n.num);
  const adj = new Map(nums.map((n) => [n, []]));
  for (const l of etat.liens) { adj.get(l.a).push(l.b); adj.get(l.b).push(l.a); }
  const relaie = (n) => { const x = etat.parNum.get(n); return x.relaie != null ? x.relaie : !NE_RELAIENT_PAS.includes(x.role); };
  const passerelles = nums.filter((n) => etat.parNum.get(n).passerelle);
  // Parcours en largeur depuis les passerelles (sans traverser `sauf`, ni la liaison `sansLien`)
  const depuisPasserelles = (sauf = null, sansLien = null) => {
    const dist = new Map();
    const file = [];
    for (const g of passerelles) if (g !== sauf) { dist.set(g, 0); file.push(g); }
    for (let i = 0; i < file.length; i++) {
      const u = file[i];
      if (u !== sauf && !relaie(u) && dist.get(u) > 0) continue; // un nœud muet reçoit mais ne relaie pas
      for (const v of adj.get(u)) {
        if (v === sauf || dist.has(v)) continue;
        if (sansLien && ((sansLien.a === u && sansLien.b === v) || (sansLien.a === v && sansLien.b === u))) continue;
        dist.set(v, dist.get(u) + 1); file.push(v);
      }
    }
    return dist;
  };
  const base = depuisPasserelles();
  const relies = new Set(base.keys());
  // Points de rupture : relais dont la panne coupe d'autres nœuds de toute passerelle
  const ruptures = [];
  for (const n of nums) {
    if (!relaie(n) || !relies.has(n)) continue;
    const d = depuisPasserelles(n);
    const coupes = [...relies].filter((x) => x !== n && !d.has(x));
    if (coupes.length) ruptures.push({ num: n, coupes });
  }
  ruptures.sort((a, b) => b.coupes.length - a.coupes.length);
  // Nœuds qui ne tiennent qu'à un seul voisin (feuilles) : leur unique voisin est un point de rupture « trivial »
  const degre = (n) => adj.get(n).length;
  const feuilles = nums.filter((n) => relies.has(n) && degre(n) === 1 && !etat.parNum.get(n).passerelle);
  // Liaisons critiques : leur perte coupe des nœuds de toute passerelle
  const critiques = [];
  for (const l of etat.liens) {
    if (!relies.has(l.a) || !relies.has(l.b)) continue;
    const d = depuisPasserelles(null, l);
    const coupes = [...relies].filter((x) => !d.has(x));
    if (coupes.length) critiques.push({ lien: l, coupes });
  }
  critiques.sort((a, b) => b.coupes.length - a.coupes.length);
  // Une liaison vers une feuille est forcément « critique » : on ne garde que celles qui coupent plus que la feuille
  const critiquesUtiles = critiques.filter((c) => c.coupes.length > 1 || !c.coupes.every((x) => degre(x) === 1));
  const rupturesUtiles = ruptures.filter((r) => r.coupes.some((x) => degre(x) > 1) || r.coupes.length > 1);
  // Îlots : groupes reliés entre eux mais à aucune passerelle
  const vus = new Set(relies);
  const ilots = [];
  for (const n of nums) {
    if (vus.has(n)) continue;
    const c = [n]; vus.add(n);
    for (let i = 0; i < c.length; i++) for (const v of adj.get(c[i])) if (!vus.has(v)) { vus.add(v); c.push(v); }
    ilots.push(c);
  }
  ilots.sort((a, b) => b.length - a.length);
  // Relais les plus traversés (intermédiarité de Brandes, chemins les plus courts en nombre de sauts)
  const inter = new Map(nums.map((n) => [n, 0]));
  for (const s of nums) {
    const pile = [], pred = new Map(), sigma = new Map([[s, 1]]), dist = new Map([[s, 0]]), file = [s];
    for (let i = 0; i < file.length; i++) {
      const v = file[i];
      pile.push(v);
      if (v !== s && !relaie(v)) continue;
      for (const w of adj.get(v)) {
        if (!dist.has(w)) { dist.set(w, dist.get(v) + 1); file.push(w); }
        if (dist.get(w) === dist.get(v) + 1) { sigma.set(w, (sigma.get(w) || 0) + sigma.get(v)); if (!pred.has(w)) pred.set(w, []); pred.get(w).push(v); }
      }
    }
    const delta = new Map();
    while (pile.length) {
      const w = pile.pop();
      for (const v of pred.get(w) || []) delta.set(v, (delta.get(v) || 0) + (sigma.get(v) / sigma.get(w)) * (1 + (delta.get(w) || 0)));
      if (w !== s) inter.set(w, inter.get(w) + (delta.get(w) || 0));
    }
  }
  const maxInter = Math.max(1, ...inter.values());
  for (const n of etat.noeuds) n.inter = inter.get(n.num) / maxInter;
  return { passerelles, dist: base, relies, ruptures: rupturesUtiles, toutesRuptures: ruptures, critiques: critiquesUtiles, feuilles, ilots, inter, maxInter };
}

// ---- Dessin du graphe (d3) ------------------------------------------------------------------------
let svg, racine, gAnneaux, gLiens, gNoeuds, gOndes, simulation, zoom, ajusteFait = false;
function initGraphe() {
  svg = d3.select('#svg');
  const defs = svg.append('defs');
  for (const [id, c] of [['fleche', '#c3d0dc']]) defs.append('marker').attr('id', id).attr('viewBox', '0 -5 10 10').attr('refX', 10).attr('refY', 0).attr('markerUnits', 'userSpaceOnUse').attr('markerWidth', 9).attr('markerHeight', 9).attr('orient', 'auto').append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', c);
  racine = svg.append('g');
  gAnneaux = racine.append('g');
  gLiens = racine.append('g');
  gOndes = racine.append('g');
  gNoeuds = racine.append('g');
  zoom = d3.zoom().scaleExtent([0.15, 6]).on('zoom', (e) => racine.attr('transform', e.transform));
  svg.call(zoom).on('dblclick.zoom', null);
  svg.on('click', (e) => { if (e.target === svg.node()) deselectionner(); });
  simulation = d3.forceSimulation().alphaDecay(0.035)
    .force('charge', d3.forceManyBody().strength(-700).distanceMax(700))
    .force('collide', d3.forceCollide().radius((d) => rayon(d) + 26).strength(0.9))
    .on('tick', positionner)
    .on('end', () => { if (!ajusteFait) { ajusteFait = true; ajuster(); } });
}
// Recadre le graphe sur les nœuds affichés
function ajuster() {
  const v = etat.visibles || [];
  if (!v.length) return;
  const { width, height } = $('#svg').getBoundingClientRect();
  const xs = v.map((n) => n.x), ys = v.map((n) => n.y);
  const x0 = Math.min(...xs) - 60, x1 = Math.max(...xs) + 60, y0 = Math.min(...ys) - 60, y1 = Math.max(...ys) + 70;
  const k = Math.min(2.5, Math.max(0.2, Math.min(width / (x1 - x0), height / (y1 - y0))));
  svg.transition().duration(700).call(zoom.transform, d3.zoomIdentity.translate(width / 2 - ((x0 + x1) / 2) * k, height / 2 - ((y0 + y1) / 2) * k).scale(k));
}
// Nœuds et liaisons affichés : relais et passerelles (les clients regroupés autour de leur meilleur relais), liaisons principales
const ROLES_RELAIS = ['ROUTER', 'ROUTER_LATE', 'CLIENT_BASE', 'REPEATER'];
function calculerVisibles() {
  const tous = $('#affichage').value === 'tous';
  const visible = new Set(etat.noeuds.filter((n) => tous || n.passerelle || n.infra || ROLES_RELAIS.includes(n.role)).map((n) => n.num));
  if (etat.choisi != null && etat.parNum.has(etat.choisi)) visible.add(etat.choisi);
  // Clients masqués : rattachés au relais visible qu'ils entendent le mieux
  const rattaches = new Map();
  etat.parent = new Map(); // client masqué → relais visible auquel il est rattaché
  for (const n of etat.noeuds) {
    if (visible.has(n.num)) continue;
    let meilleur = null, snr = -999;
    for (const l of etat.voisins.get(n.num)) {
      const autre = l.a === n.num ? l.b : l.a;
      if (!visible.has(autre)) continue;
      const s = l.meilleur ?? -40;
      if (s > snr) { snr = s; meilleur = autre; }
    }
    if (meilleur != null) { rattaches.set(meilleur, (rattaches.get(meilleur) || 0) + 1); etat.parent.set(n.num, meilleur); }
  }
  for (const n of etat.noeuds) n.clientsMasques = rattaches.get(n.num) || 0;
  let liens = etat.liens.filter((l) => visible.has(l.a) && visible.has(l.b));
  if ($('#filtre-liens').value === 'principales') {
    const garde = new Set(etat.montrerRupture ? etat.analyse.critiques.map((c) => c.lien) : []);
    const parNoeud = new Map();
    for (const l of liens) for (const x of [l.a, l.b]) { if (!parNoeud.has(x)) parNoeud.set(x, []); parNoeud.get(x).push(l); }
    for (const [, ls] of parNoeud) ls.sort((a, b) => (b.meilleur ?? -40) - (a.meilleur ?? -40)).slice(0, 3).forEach((l) => garde.add(l));
    if (etat.choisi != null) for (const l of liens) if (l.a === etat.choisi || l.b === etat.choisi) garde.add(l);
    liens = liens.filter((l) => garde.has(l));
  }
  etat.visibles = etat.noeuds.filter((n) => visible.has(n.num));
  etat.liensVisibles = liens;
}
const rayon = (n) => 7 + 11 * Math.sqrt(n.inter || 0);
const noeudDe = (x) => (typeof x === 'object' ? x : etat.parNum.get(x));
function dessiner(recadrer = true) {
  calculerVisibles();
  const vis = etat.visibles, lv = etat.liensVisibles;
  const { width, height } = $('#svg').getBoundingClientRect();
  const dispo = $('#disposition').value, geo = dispo === 'geo', anneaux = dispo === 'anneaux';
  const cx = width / 2, cy = height / 2;
  // Disposition géographique : positions fixées (projection), les nœuds sans position restent libres
  const avecPos = vis.filter((n) => n.lat != null);
  if (geo && avecPos.length > 1) {
    const proj = d3.geoMercator().fitExtent([[60, 60], [width - 60, height - 60]], { type: 'MultiPoint', coordinates: avecPos.map((n) => [n.lon, n.lat]) });
    for (const n of vis) { if (n.lat != null) { const [x, y] = proj([n.lon, n.lat]); n.fx = x; n.fy = y; } else { n.fx = null; n.fy = null; } }
  } else for (const n of vis) { n.fx = null; n.fy = null; }
  for (const n of vis) if (n.x == null) { n.x = cx + (Math.random() - 0.5) * 300; n.y = cy + (Math.random() - 0.5) * 300; }
  // Anneaux : passerelles au centre, puis 1 saut, 2 sauts… ; les nœuds coupés tout autour
  const dist = (n) => etat.analyse.dist.get(n.num);
  const maxD = Math.max(1, ...vis.map((n) => dist(n) ?? 0));
  const pasR = Math.max(150, Math.min(260, vis.length * 9));
  const rayonAnneau = (n) => { const d = dist(n); return d == null ? (maxD + 1.4) * pasR : d === 0 ? 0.55 * pasR : (d + 0.3) * pasR; };
  gAnneaux.selectAll('*').remove();
  if (anneaux) {
    const niveaux = [...new Set(vis.map((n) => dist(n) ?? -1))].sort((a, b) => a - b);
    for (const d of niveaux) {
      const r = rayonAnneau({ num: vis.find((n) => (dist(n) ?? -1) === d).num });
      gAnneaux.append('circle').attr('class', 'anneau').attr('cx', cx).attr('cy', cy).attr('r', r);
      // Libellé à droite de l'anneau, hors des nœuds placés dessus
      gAnneaux.append('text').attr('class', 'anneau-lib').attr('x', cx + r * 0.71 + 8).attr('y', cy + r * 0.71 + 16).attr('text-anchor', 'start').text(d === -1 ? 'coupés des passerelles' : d === 0 ? 'passerelles' : `${d} saut${d > 1 ? 's' : ''} d’une passerelle`);
    }
  }

  const l = gLiens.selectAll('line').data(lv, (d) => d.a + '-' + d.b);
  l.exit().remove();
  l.enter().append('line').attr('class', 'lien')
    .merge(l)
    .classed('unique', (d) => d.unique)
    .attr('stroke', (d) => couleurSnr(d.meilleur))
    .attr('stroke-width', (d) => (d.meilleur == null ? 1.2 : 1.2 + Math.max(0, Math.min(2.5, (d.meilleur + 15) / 9))))
    .attr('marker-end', (d) => (d.unique ? 'url(#fleche)' : null));

  const n = gNoeuds.selectAll('g.noeud').data(vis, (d) => d.num);
  n.exit().remove();
  const ne = n.enter().append('g').attr('class', 'noeud')
    .call(d3.drag().on('start', (e, d) => { if (!e.active) simulation.alphaTarget(0.2).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end', (e, d) => { if (!e.active) simulation.alphaTarget(0); if ($('#disposition').value !== 'geo' || d.lat == null) { d.fx = null; d.fy = null; } }))
    .on('mouseenter', (e, d) => survol(d, e)).on('mousemove', (e) => placerInfobulle(e)).on('mouseleave', () => finSurvol())
    .on('click', (e, d) => { e.stopPropagation(); choisir(d.num); });
  ne.append('circle').attr('class', 'halo');
  ne.append('circle').attr('class', 'corps');
  ne.append('text').attr('class', 'nom').attr('text-anchor', 'middle');
  const badge = ne.append('g').attr('class', 'badge-g');
  badge.append('rect').attr('class', 'badge').attr('rx', 7).attr('height', 14);
  badge.append('text').attr('class', 'badge').attr('text-anchor', 'middle').attr('dy', 10.5);
  const tous = ne.merge(n);
  // Pastille « +N » : clients masqués rattachés à ce relais
  tous.select('g.badge-g').style('display', (d) => (d.clientsMasques ? null : 'none'))
    .attr('transform', (d) => `translate(${rayon(d) * 0.75},${-rayon(d) - 10})`);
  tous.select('rect.badge').attr('x', (d) => -(String(d.clientsMasques).length * 6 + 10) / 2).attr('width', (d) => String(d.clientsMasques).length * 6 + 10);
  tous.select('text.badge').text((d) => '+' + d.clientsMasques).append('title').text((d) => `${d.clientsMasques} client(s) masqué(s) rattaché(s) à ce relais`);
  tous.classed('passerelle', (d) => d.passerelle)
    .classed('rupture', (d) => etat.montrerRupture && etat.analyse.ruptures.some((r) => r.num === d.num));
  tous.select('circle.corps').attr('r', rayon).attr('fill', (d) => couleurRole(d.role)).attr('opacity', (d) => (d.statut === 'inactif' ? 0.55 : 1));
  tous.select('circle.halo').attr('r', (d) => rayon(d) + 5);
  tous.select('text.nom').attr('dy', (d) => rayon(d) + 15).text((d) => d.nomCourt || d.id.slice(-4));

  simulation.nodes(vis)
    .force('lien', d3.forceLink(lv).id((d) => d.num).distance((d) => 110 + (10 - Math.max(-20, Math.min(10, d.meilleur ?? -10))) * 5).strength(geo ? 0.03 : anneaux ? 0.08 : 0.4))
    .force('radial', anneaux ? d3.forceRadial(rayonAnneau, cx, cy).strength(1.1) : null)
    .force('x', geo || anneaux ? null : d3.forceX(cx).strength(0.05))
    .force('y', geo || anneaux ? null : d3.forceY(cy).strength(0.05));
  simulation.alpha(recadrer ? 1 : 0.25).restart();
  if (recadrer) ajusteFait = false;
  rendreLegende();
  appliquerCritiques();
}
function positionner() {
  gLiens.selectAll('line').each(function (d) {
    const s = noeudDe(d.source), t = noeudDe(d.target);
    // Sens unique : la flèche pointe vers celui qui a entendu ; la ligne s'arrête au bord du cercle
    let x1 = s.x, y1 = s.y, x2 = t.x, y2 = t.y;
    if (d.unique && d.ba && !d.ab) { [x1, y1, x2, y2] = [t.x, t.y, s.x, s.y]; }
    const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
    const fin = d.unique ? rayon(d.ba && !d.ab ? s : t) + 3 : 0;
    this.setAttribute('x1', x1); this.setAttribute('y1', y1);
    this.setAttribute('x2', x2 - (dx / L) * fin); this.setAttribute('y2', y2 - (dy / L) * fin);
  });
  gNoeuds.selectAll('g.noeud').attr('transform', (d) => `translate(${d.x},${d.y})`);
  gOndes.selectAll('line').each(function (d) { const a = etat.parNum.get(d.de), b = etat.parNum.get(d.vers); if (a && b) { this.setAttribute('x1', a.x); this.setAttribute('y1', a.y); this.setAttribute('x2', b.x); this.setAttribute('y2', b.y); } });
}
function appliquerCritiques() {
  const crit = new Set(etat.montrerRupture ? etat.analyse.critiques.map((c) => c.lien) : []);
  gLiens.selectAll('line').classed('critique', (d) => crit.has(d));
}
function rendreLegende() {
  $('#legende').innerHTML = Object.entries(ROLES).filter(([k]) => k !== 'REPEATER').map(([, [lib, c]]) => `<span><i style="background:${c}"></i>${lib}</span>`).join('')
    + `<span><i style="background:transparent;border:2px solid #fff"></i>${PASSERELLE}</span><span>taille = relais traversé</span><span>- - - sens unique (→ qui entend)</span>`
    + (etat.montrerRupture ? '<span><i style="background:transparent;border:2px solid var(--critique)"></i>point de rupture</span>' : '');
}

// ---- Survol, choix d'un nœud -----------------------------------------------------------------------
function survol(d, e) {
  const vois = new Set([d.num, ...etat.voisins.get(d.num).map((l) => (noeudDe(l.source).num === d.num ? noeudDe(l.target).num : noeudDe(l.source).num))]);
  gNoeuds.selectAll('g.noeud').classed('attenue', (x) => !vois.has(x.num));
  const touche = (l) => noeudDe(l.source).num === d.num || noeudDe(l.target).num === d.num;
  gLiens.selectAll('line').classed('attenue', (l) => !touche(l)).classed('surligne', touche);
  const dist = etat.analyse.dist.get(d.num);
  const r = etat.analyse.toutesRuptures.find((x) => x.num === d.num);
  $('#infobulle').innerHTML = `<b>${esc(d.nomLong || d.id)}</b><br>${esc(libRole(d.role))}${d.passerelle ? ' · ' + PASSERELLE : ''}${d.position ? '' : ' · sans position'}<br>${etat.voisins.get(d.num).length} liaison(s) · ${dist == null ? 'coupé des passerelles' : dist === 0 ? 'passerelle' : `${dist} saut(s) d’une passerelle`}${r ? `<br><b style="color:var(--critique)">sa panne couperait ${r.coupes.length} nœud(s)</b>` : ''}`;
  $('#infobulle').style.display = 'block';
  placerInfobulle(e);
}
function placerInfobulle(e) {
  const b = $('#graphe').getBoundingClientRect(), t = $('#infobulle');
  t.style.left = Math.min(b.width - 290, e.clientX - b.left + 14) + 'px';
  t.style.top = (e.clientY - b.top + 14) + 'px';
}
function finSurvol() {
  $('#infobulle').style.display = 'none';
  gNoeuds.selectAll('g.noeud').classed('attenue', false);
  gLiens.selectAll('line').classed('attenue', false).classed('surligne', false);
}
function deselectionner() {
  etat.choisi = null;
  gNoeuds.selectAll('g.noeud').classed('choisi', false).classed('coupe', false);
}
function centrerSur(num) {
  const n = etat.parNum.get(num);
  if (!n) return;
  const { width, height } = $('#svg').getBoundingClientRect();
  const t = d3.zoomTransform(svg.node());
  const k = Math.max(t.k, 1.2);
  svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity.translate(width / 2 - n.x * k, height / 2 - n.y * k).scale(k));
}
function montrerCoupes(liste) {
  const s = new Set(liste || []);
  gNoeuds.selectAll('g.noeud').classed('coupe', (d) => s.has(d.num));
}
function choisir(num, ouvrir = true) {
  const visible = (etat.visibles || []).some((n) => n.num === num);
  const avant = etat.choisi;
  etat.choisi = num;
  // Un client masqué devient visible avec ses liaisons ; en « liaisons principales », on montre toutes celles du nœud choisi
  if (!visible || ($('#filtre-liens').value === 'principales' && avant !== num)) dessiner(false);
  gNoeuds.selectAll('g.noeud').classed('choisi', (d) => d.num === num);
  const n = etat.parNum.get(num);
  const A = etat.analyse;
  const r = A.toutesRuptures.find((x) => x.num === num);
  montrerCoupes(r ? r.coupes : []);
  const liens = etat.voisins.get(num).map((l) => {
    const autre = l.a === num ? l.b : l.a;
    const entend = l.a === num ? l.ba : l.ab; // num entend l'autre
    const entendu = l.a === num ? l.ab : l.ba; // l'autre entend num
    return { autre, entend, entendu };
  }).sort((x, y) => (Math.max(y.entend?.snr ?? -99, y.entendu?.snr ?? -99)) - (Math.max(x.entend?.snr ?? -99, x.entendu?.snr ?? -99)));
  const rang = [...A.inter.entries()].sort((a, b) => b[1] - a[1]).findIndex(([k]) => k === num) + 1;
  const dist = A.dist.get(num);
  const sensTxt = (d) => (d ? `${d.snr != null ? fmt(d.snr, 1, ' dB') : 'SNR ?'} <small>(${d.sources.join(', ')})</small>` : '<small>—</small>');
  $('#vue-noeud').innerHTML = `<h2>${esc(n.nomLong || n.id)}</h2>
    <div class="note">${esc(n.id)} · ${esc(libRole(n.role))}${n.materiel ? ' · ' + esc(n.materiel) : ''}${n.firmware ? ' · ' + esc(n.firmware) : ''}${n.passerelle ? ' · ' + PASSERELLE : ''}${n.position ? '' : ' · <b>sans position</b> (absent de la carte)'}</div>
    <div class="grille"><div class="mesure"><span>Liaisons</span><b>${liens.length}</b></div><div class="mesure"><span>Vers passerelle</span><b>${dist == null ? 'coupé' : dist === 0 ? 'est passerelle' : dist + ' saut' + (dist > 1 ? 's' : '')}</b></div><div class="mesure"><span>Traversé</span><b>${rang}ᵉ</b></div></div>
    ${r ? `<div class="alerte"><b>Point de rupture</b> : sa panne couperait de toute passerelle ${r.coupes.length} nœud(s) (en rouge) : ${esc(r.coupes.slice(0, 12).map(courtDe).join(', '))}${r.coupes.length > 12 ? '…' : ''}.</div>` : ''}
    ${!MC && dist != null && dist > (etat.donnees.hopLimit || 3) ? `<div class="alerte">À ${dist} sauts de la passerelle la plus proche : avec une limite de ${etat.donnees.hopLimit} sauts, ses paquets n’arrivent pas sur MQTT.</div>` : ''}
    <div class="actions"><button class="principal" id="n-simuler">▶ Simuler depuis ce nœud</button>${MC ? '' : `<a href="./?noeud=${num}" target="_blank" rel="noopener"><button>Ouvrir sur la carte</button></a>`}</div>
    <label class="note">Rôle dans la simulation <select id="n-role">${(MC ? ['', 'repeteur', 'companion'] : ['', 'CLIENT', 'CLIENT_BASE', 'ROUTER', 'ROUTER_LATE', 'CLIENT_MUTE']).map((x) => `<option value="${x}" ${(etat.rolesSim[num] || '') === x ? 'selected' : ''}>${x ? libRole(x) : 'réel (' + libRole(n.role) + ')'}</option>`).join('')}</select></label>
    <h2>Liaisons</h2>
    <table><thead><tr><th>Voisin</th><th>il l’entend</th><th>l’autre l’entend</th></tr></thead><tbody>
    ${liens.map((x) => `<tr data-n="${x.autre}" style="cursor:pointer"><td>${esc(courtDe(x.autre))} <small class="note">${esc(libRole(etat.parNum.get(x.autre).role))}</small></td><td>${sensTxt(x.entend)}</td><td>${sensTxt(x.entendu)}</td></tr>`).join('')}</tbody></table>
    <p class="note">« il l’entend » : ce nœud reçoit le voisin ; « l’autre l’entend » : le voisin le reçoit. Un « — » veut souvent dire que ce nœud ne rapporte pas ce qu’il entend (${MC ? 'seuls les observateurs et les voisins déclarés des répéteurs le disent' : 'ni passerelle MQTT, ni module Voisinage'}).</p>`;
  $('#n-simuler').onclick = () => { etat.emetteur = num; ouvrirVue('simulation'); rendreSimulation(); };
  $('#n-role').onchange = (e) => { if (e.target.value) etat.rolesSim[num] = e.target.value; else delete etat.rolesSim[num]; rendreSimulation(); };
  document.querySelectorAll('#vue-noeud tr[data-n]').forEach((tr) => (tr.onclick = () => { choisir(Number(tr.dataset.n)); centrerSur(Number(tr.dataset.n)); }));
  if (ouvrir) ouvrirVue('noeud');
}

// ---- Onglet Analyse -------------------------------------------------------------------------
function rendreAnalyse() {
  const A = etat.analyse, d = etat.donnees, H = d.hopLimit || 3;
  const double = etat.liens.filter((l) => !l.unique).length;
  const sansPos = etat.noeuds.filter((n) => !n.position);
  const hist = new Map();
  for (const n of etat.noeuds) { const x = A.dist.get(n.num); const k = x == null ? 'coupé' : x >= 6 ? '6+' : String(x); hist.set(k, (hist.get(k) || 0) + 1); }
  const cles = ['0', '1', '2', '3', '4', '5', '6+', 'coupé'].filter((k) => hist.has(k));
  const maxH = Math.max(1, ...hist.values());
  const loin = etat.noeuds.filter((n) => A.dist.get(n.num) > H);
  const top = [...A.inter.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const ligne = (num, droite, attrs = '') => `<div class="ligne" data-n="${num}" ${attrs}><span class="titre">${esc(nomDe(num))} <small>${esc(libRole(etat.parNum.get(num).role))}</small></span><span class="val">${droite}</span></div>`;
  $('#vue-analyse').innerHTML = `
    <div class="grille">
      <div class="mesure"><span>Nœuds</span><b>${etat.noeuds.length}</b></div>
      <div class="mesure"><span>Liaisons</span><b>${etat.liens.length}</b></div>
      <div class="mesure"><span>Double sens</span><b>${etat.liens.length ? Math.round((double / etat.liens.length) * 100) : 0} %</b></div>
      <div class="mesure"><span>Passerelles</span><b>${A.passerelles.length}</b></div>
      <div class="mesure"><span>Îlots</span><b>${A.ilots.length}</b></div>
      <div class="mesure"><span>Sans position</span><b>${sansPos.length}</b></div>
    </div>
    <label class="note"><input type="checkbox" id="a-rupture" ${etat.montrerRupture ? 'checked' : ''}> Montrer sur le graphe les points de rupture (cercle rouge) et les liaisons critiques</label>
    <h2>Distance aux ${MC ? 'observateurs' : 'passerelles MQTT'}</h2>
    ${cles.map((k) => `<div class="barre"><span>${k === 'coupé' ? 'coupé' : k === '0' ? 'passerelle' : k + ' saut' + (k === '1' ? '' : 's')}</span><i class="${k === 'coupé' || (k !== '6+' && Number(k) > H) || k === '6+' ? 'trop' : ''}" style="width:${(hist.get(k) / maxH) * 200}px"></i><b>${hist.get(k)}</b></div>`).join('')}
    <p class="note">Nombre de relais à traverser pour atteindre la passerelle la plus proche (seuls les nœuds qui relaient sont traversés). Au-delà de la limite de sauts (${H}), les paquets n’arrivent pas sur MQTT ni sur la carte.</p>
    ${loin.length ? `<div class="alerte">${loin.length} nœud(s) à plus de ${H} sauts : ${esc(loin.slice(0, 10).map((n) => courtDe(n.num)).join(', '))}${loin.length > 10 ? '…' : ''}. Les favoris entre relais (sauts gratuits) ou une passerelle plus proche les rapprocheraient.</div>` : ''}
    <h2>Points de rupture</h2>
    ${A.ruptures.length ? A.ruptures.slice(0, 12).map((r) => ligne(r.num, `${r.coupes.length} coupé${r.coupes.length > 1 ? 's' : ''}`, `data-coupes="${r.coupes.join(',')}"`)).join('') : '<div class="note">Aucun : la panne d’un seul relais ne coupe qu’au plus un nœud isolé.</div>'}
    <p class="note">Relais dont la panne couperait d’autres nœuds de toute passerelle : à surveiller en priorité (alimentation, antenne) ou à doubler. Un clic montre en rouge les nœuds coupés.</p>
    ${A.feuilles.length ? `<h2>Nœuds qui ne tiennent qu’à un voisin</h2>${A.feuilles.map((f) => { const l = etat.voisins.get(f)[0]; const v = l.a === f ? l.b : l.a; return ligne(f, `via ${esc(courtDe(v))}`); }).join('')}<p class="note">Une seule liaison mesurée : si ce voisin tombe ou si la liaison faiblit, le nœud est coupé.</p>` : ''}
    <h2>Liaisons critiques</h2>
    ${A.critiques.length ? A.critiques.slice(0, 10).map((c) => `<div class="ligne" data-lien="${c.lien.a}-${c.lien.b}" data-coupes="${c.coupes.join(',')}"><span class="titre">${esc(courtDe(c.lien.a))} ↔ ${esc(courtDe(c.lien.b))} <small>${c.lien.meilleur != null ? fmt(c.lien.meilleur, 1, ' dB') : 'SNR ?'}${c.lien.unique ? ' · sens unique' : ''}</small></span><span class="val">${c.coupes.length} coupé${c.coupes.length > 1 ? 's' : ''}</span></div>`).join('') : '<div class="note">Aucune : chaque liaison a une solution de secours (hors nœuds à un seul voisin).</div>'}
    <h2>Relais les plus traversés</h2>
    ${top.map(([num, v]) => ligne(num, Math.round((v / A.maxInter) * 100) + ' %')).join('') || '<div class="note">—</div>'}
    <p class="note">Part des plus courts chemins entre tous les nœuds qui passent par ce relais (100 % = le plus traversé). Un relais très traversé et en point bas, ou sur batterie, est une fragilité.</p>
    ${A.ilots.length ? `<h2>Îlots sans passerelle</h2>${A.ilots.slice(0, 8).map((c) => `<div class="ligne" data-coupes="${c.join(',')}" data-n="${c[0]}"><span class="titre">${esc(c.slice(0, 6).map(courtDe).join(', '))}${c.length > 6 ? '…' : ''}</span><span class="val">${c.length} nœud${c.length > 1 ? 's' : ''}</span></div>`).join('')}<p class="note">Nœuds reliés entre eux mais à aucune passerelle MQTT (d’après les liaisons mesurées sur la période).</p>` : ''}
    ${sansPos.length ? `<h2>Nœuds sans position</h2>${sansPos.map((n) => ligne(n.num, etat.voisins.get(n.num).length + ' liaison(s)')).join('')}<p class="note">Ils n’apparaissent pas sur la carte : donnez-leur une position fixe (Programmer › Position fixe).</p>` : ''}`;
  $('#a-rupture').onchange = (e) => { etat.montrerRupture = e.target.checked; dessiner(); };
  document.querySelectorAll('#vue-analyse [data-n]').forEach((el) => (el.onclick = () => { const n = Number(el.dataset.n); choisir(n, false); centrerSur(n); if (el.dataset.coupes) montrerCoupes(el.dataset.coupes.split(',').map(Number)); }));
  document.querySelectorAll('#vue-analyse [data-lien]').forEach((el) => (el.onclick = () => {
    const [a, b] = el.dataset.lien.split('-').map(Number);
    montrerCoupes(el.dataset.coupes.split(',').map(Number));
    gLiens.selectAll('line').classed('attenue', (l) => !(noeudDe(l.source).num === a && noeudDe(l.target).num === b));
    setTimeout(() => gLiens.selectAll('line').classed('attenue', false), 2500);
    centrerSur(a);
  }));
}

// ---- Onglet Simulation --------------------------------------------------------------------------
const PAQUETS = MC ? {
  canal: ['Message de canal (≈ 60 o)', 60, false], annonce: ['Annonce (≈ 110 o, 8 sauts max par défaut)', 110, false], direct: ['Message direct en inondation (≈ 50 o)', 50, false],
} : { texte: ['Message texte (≈ 40 o, accusé implicite)', 40, true], position: ['Position (≈ 50 o)', 50, false], telemetrie: ['Télémétrie (≈ 45 o)', 45, false], nodeinfo: ['Fiche NodeInfo (≈ 75 o)', 75, false] };
function optsSim() {
  const v = (id) => $(id).value;
  const p = PAQUETS[v('#s-paquet')];
  return {
    emetteur: Number(v('#s-emetteur')), preset: v('#s-preset'), presetMesure: etat.donnees.preset, hopLimit: Number(v('#s-sauts')),
    octets: p[1], texte: p[2], favoris: MC ? 'aucun' : v('#s-favoris'), symetrique: $('#s-sym').checked, roles: { ...etat.rolesSim }, graine: Math.floor(Math.random() * 1e6) + 1,
    protocole: MC ? 'meshcore' : 'meshtastic', txDelayFactor: MC ? Number(v('#s-txdelay')) : undefined,
  };
}
function reseauSim() {
  return { noeuds: etat.noeuds.map((n) => ({ num: n.num, role: n.role, relaie: n.relaie, canal: n.canal || 0, favoris: n.favoris || [] })), liens: etat.liens.map((l) => ({ a: l.a, b: l.b, ab: l.ab, ba: l.ba })) };
}
function rendreSimulation() {
  const d = etat.donnees;
  if (!d) return;
  const anc = $('#s-emetteur') ? optsSim() : null;
  const tri = [...etat.noeuds].sort((a, b) => (a.nomLong || a.id).localeCompare(b.nomLong || b.id));
  const em = etat.emetteur ?? (anc && anc.emetteur) ?? (etat.noeuds.find((n) => n.passerelle) || etat.noeuds[0] || {}).num;
  const modifs = Object.entries(etat.rolesSim);
  $('#vue-simulation').innerHTML = `
    <p class="note">${MC ? 'Simule la diffusion d’un paquet en inondation MeshCore, avec les liaisons mesurées et la logique du firmware répéteur : chaque répéteur réémet une fois ce qu’il entend pour la première fois, après une attente aléatoire de 0 à 5 × (temps d’antenne × tx_delay_factor) ; pas d’annulation sur doublon ; canal occupé → nouvel essai 120 à 360 ms plus tard ; limite flood.max ; collisions. Les companions et room servers ne relaient pas.' : 'Simule la diffusion d’un paquet dans le maillage, avec les liaisons mesurées et la logique du firmware 2.7 : attente avant réémission selon le SNR (un ROUTER passe en premier), annulation par un CLIENT qui entend un autre relais, ROUTER_LATE en fenêtre tardive, sauts gratuits entre favoris, écoute du canal avant d’émettre, collisions.'}</p>
    <div class="form">
      <label style="grid-column:1/-1">Émetteur <select id="s-emetteur">${tri.map((n) => `<option value="${n.num}" ${n.num === em ? 'selected' : ''}>${esc(n.nomLong || n.id)}</option>`).join('')}</select></label>
      <label>Paquet <select id="s-paquet">${Object.entries(PAQUETS).map(([k, [lib]]) => `<option value="${k}" ${anc && PAQUETS[k][1] === anc.octets ? 'selected' : ''}>${lib}</option>`).join('')}</select></label>
      <label>Preset <select id="s-preset">${Object.keys(SimMaillage.PRESETS).filter((k) => MC === k.startsWith('MESHCORE')).map((k) => `<option ${k === ((anc && anc.preset) || d.preset) ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      ${MC ? `<label>Sauts max (flood.max) <select id="s-sauts">${[2, 3, 4, 5, 6, 8, 12, 16, 32, 64].map((k) => `<option ${k === ((anc && anc.hopLimit) || 64) ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      <label>tx_delay_factor <select id="s-txdelay">${[0.25, 0.5, 0.75, 1, 1.5, 2].map((k) => `<option value="${k}" ${k === ((anc && anc.txDelayFactor) || 0.5) ? 'selected' : ''}>${String(k).replace('.', ',')}${k === 0.5 ? ' (défaut)' : ''}</option>`).join('')}</select></label>`
      : `<label>Limite de sauts <select id="s-sauts">${[1, 2, 3, 4, 5, 6, 7].map((k) => `<option ${k === ((anc && anc.hopLimit) || d.hopLimit || 3) ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      <label>Favoris (sauts gratuits) <select id="s-favoris">${[['poses', 'posés par la carte'], ['tous', 'tous ceux possibles'], ['aucun', 'aucun']].map(([k, t]) => `<option value="${k}" ${anc && anc.favoris === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`}
      <label class="case"><input type="checkbox" id="s-sym" ${!anc || anc.symetrique ? 'checked' : ''}> Liaisons mesurées dans un seul sens supposées réciproques</label>
    </div>
    ${modifs.length ? `<div class="note">Rôles modifiés pour la simulation : ${modifs.map(([num, r]) => `<span class="pastille">${esc(courtDe(Number(num)))} → ${esc(libRole(r))}</span>`).join(' ')} <button id="s-raz-roles">Rétablir</button></div>` : '<div class="note">Astuce : onglet Nœud › « Rôle dans la simulation » pour essayer un autre rôle sur un relais.</div>'}
    <div class="actions"><button class="principal" id="s-animer">▶ Animer</button><select id="s-vitesse" title="Vitesse de l’animation">${[[0.5, '× 0,5'], [1, '× 1'], [2, '× 2'], [5, '× 5']].map(([v, t]) => `<option value="${v}" ${v === 1 ? 'selected' : ''}>${t}</option>`).join('')}</select><button id="s-stats">📊 200 tirages</button><button id="s-effacer">Effacer</button></div>
    <div id="s-resultat"></div>
    ${etat.essais.length ? `<h2>Essais comparés</h2><table><thead><tr><th>Réglages</th><th class="n">atteints</th><th class="n">émissions</th><th class="n">pertes</th><th class="n">durée</th></tr></thead><tbody>${etat.essais.map((e) => `<tr><td>${esc(e.lib)}</td><td class="n">${fmt(e.pct, 0, ' %')}</td><td class="n">${fmt(e.emissions, 1)}</td><td class="n">${fmt(e.pertes, 0)}</td><td class="n">${fmt(e.duree, 1, ' s')}</td></tr>`).join('')}</tbody></table><p class="note">Moyennes sur 200 tirages. « Pertes » : réceptions perdues par collision. Changez un réglage puis relancez pour comparer.</p>` : ''}`;
  $('#s-emetteur').onchange = (e) => { etat.emetteur = Number(e.target.value); choisir(etat.emetteur, false); centrerSur(etat.emetteur); };
  $('#s-animer').onclick = animer;
  $('#s-stats').onclick = statistiques;
  $('#s-effacer').onclick = () => { arreterAnim(); colorierProba(null); $('#s-resultat').innerHTML = ''; };
  const rz = $('#s-raz-roles'); if (rz) rz.onclick = () => { etat.rolesSim = {}; rendreSimulation(); };
}
function libelleEssai(o) {
  const modifs = Object.keys(o.roles).length;
  return `${courtDe(o.emetteur)} · ${o.preset} · ${o.hopLimit} saut${o.hopLimit > 1 ? 's' : ''} · ${MC ? 'tx_delay ' + String(o.txDelayFactor).replace('.', ',') : 'favoris ' + (o.favoris === 'poses' ? 'posés' : o.favoris)}${modifs ? ` · ${modifs} rôle(s) modifié(s)` : ''}${o.symetrique ? '' : ' · sens mesurés seulement'}`;
}
function statistiques() {
  arreterAnim();
  const o = optsSim();
  const r = SimMaillage.monteCarlo(reseauSim(), o, 200);
  const m = r.moyenne;
  const pct = (m.atteints / r.total) * 100;
  etat.essais.unshift({ lib: libelleEssai(o), pct, emissions: m.emissions, pertes: m.collisions, duree: m.fin / 1000 });
  etat.essais = etat.essais.slice(0, 8);
  const faibles = Object.entries(r.noeuds).filter(([num, x]) => Number(num) !== o.emetteur && x.proba < 0.5).map(([num, x]) => ({ num: Number(num), ...x })).sort((a, b) => a.proba - b.proba);
  rendreSimulation();
  colorierProba(r.noeuds, o.emetteur);
  $('#s-resultat').innerHTML = `<h2>Résultat moyen (200 tirages)</h2>
    <div class="grille"><div class="mesure"><span>Atteints</span><b>${fmt(m.atteints, 1)} / ${r.total}</b></div><div class="mesure"><span>Émissions</span><b>${fmt(m.emissions, 1)}</b></div><div class="mesure"><span>Pertes</span><b>${fmt(m.collisions, 0)}</b></div>
    <div class="mesure"><span>Durée</span><b>${fmt(m.fin / 1000, 1, ' s')}</b></div><div class="mesure"><span>Temps d’antenne</span><b>${fmt(m.tempsAntenne / 1000, 1, ' s')}</b></div><div class="mesure"><span>Sauts gratuits</span><b>${fmt(m.sautsGratuits, 1)}</b></div></div>
    <p class="note">Un paquet dure ${fmt(r.airtime, 0, ' ms')} en ${esc(o.preset)} (slot ${fmt(r.slot, 1, ' ms')}). Couleur des nœuds : probabilité d’être atteint (rouge 0 %, jaune 50 %, vert 100 %). ${m.annulations ? `${fmt(m.annulations, 1)} réémission(s) annulée(s) en moyenne par des CLIENT qui ont entendu un autre relais.` : ''}${m.retransmissions ? ` ${fmt(m.retransmissions, 1)} renvoi(s) de l’émetteur faute d’accusé implicite.` : ''}</p>
    ${faibles.length ? `<h2>Atteints moins d’une fois sur deux</h2>${faibles.slice(0, 15).map((x) => `<div class="ligne" data-n="${x.num}"><span class="titre">${esc(nomDe(x.num))}</span><span class="val">${fmt(x.proba * 100, 0, ' %')}</span></div>`).join('')}` : '<div class="note">Tous les nœuds reliés sont atteints au moins une fois sur deux.</div>'}`;
  document.querySelectorAll('#s-resultat [data-n]').forEach((el) => (el.onclick = () => { choisir(Number(el.dataset.n)); centrerSur(Number(el.dataset.n)); }));
}
function colorierProba(noeuds, emetteur) {
  const c = d3.scaleLinear().domain([0, 0.5, 1]).range(['#ff5c6c', '#f4d35e', '#3ee6c4']);
  gNoeuds.selectAll('g.noeud').select('circle.corps').attr('fill', (d) => (!noeuds ? couleurRole(d.role) : d.num === emetteur ? '#ffffff' : noeuds[d.num] ? c(noeuds[d.num].proba) : '#555'));
}

// Animation d'un tirage : chaque émission dessine une onde vers ceux qui l'entendent
function arreterAnim() {
  if (etat.anim) cancelAnimationFrame(etat.anim.raf);
  etat.anim = null;
  gOndes.selectAll('*').remove();
  $('#horloge').style.display = 'none';
}
function animer() {
  arreterAnim();
  const o = optsSim();
  const res = SimMaillage.simuler(reseauSim(), o);
  const prep = SimMaillage.preparer(reseauSim(), o);
  const vitesse = Number($('#s-vitesse').value) || 1;
  const ev = res.journal;
  let i = 0;
  const debut = performance.now();
  const recu = new Set([o.emetteur]);
  const vusAnim = new Set((etat.visibles || []).map((x) => x.num)); // clients masqués : ni onde ni éclair
  const actives = []; // ondes en cours { fin, el }
  gNoeuds.selectAll('g.noeud').select('circle.corps').attr('fill', (d) => (d.num === o.emetteur ? '#ffffff' : '#3a4654'));
  const compteurs = { emissions: 0, pertes: 0, annules: 0 };
  $('#horloge').style.display = 'block';
  const pas = (now) => {
    const t = (now - debut) * vitesse;
    while (i < ev.length && ev[i].t <= t) {
      const e = ev[i++];
      const n = etat.parNum.get(e.num);
      if (e.type === 'tx') {
        compteurs.emissions++;
        for (const { rx } of prep.auditeurs.get(e.num)) {
          if (!vusAnim.has(rx) || !vusAnim.has(e.num)) continue; // clients masqués : pas d'onde dessinée
          const el = gOndes.append('line').datum({ de: e.num, vers: rx }).attr('class', 'onde').attr('stroke', recu.has(rx) ? '#8d99ae' : '#ffffff');
          actives.push({ fin: e.t + e.duree, el });
        }
        if (n && vusAnim.has(e.num)) gOndes.append('circle').attr('class', 'pulse').attr('cx', n.x).attr('cy', n.y).attr('r', rayon(n)).transition().duration(Math.max(300, e.duree / vitesse)).attr('r', rayon(n) + 30).style('opacity', 0).remove();
      } else if (e.type === 'recu') {
        recu.add(e.num);
        gNoeuds.selectAll('g.noeud').filter((d) => d.num === e.num).select('circle.corps').attr('fill', '#3ee6c4');
      } else if (e.type === 'perdu' && e.raison === 'collision') {
        compteurs.pertes++;
        if (n && vusAnim.has(e.num)) gOndes.append('circle').attr('cx', n.x).attr('cy', n.y).attr('r', rayon(n) + 4).attr('fill', 'none').attr('stroke', '#ff5c6c').attr('stroke-width', 3).transition().duration(700).style('opacity', 0).remove();
      } else if (e.type === 'annule') {
        compteurs.annules++;
        gNoeuds.selectAll('g.noeud').filter((d) => d.num === e.num).select('circle.corps').attr('fill', '#1f9e86');
      }
    }
    for (let k = actives.length - 1; k >= 0; k--) if (actives[k].fin <= t) { actives[k].el.remove(); actives.splice(k, 1); }
    positionner();
    $('#horloge').innerHTML = `t = <b>${fmt(t / 1000, 1, ' s')}</b> · atteints <b>${recu.size - 1}</b>/${res.total} · émissions ${compteurs.emissions} · pertes ${compteurs.pertes} · annulées ${compteurs.annules}`;
    if (i < ev.length || actives.length) etat.anim.raf = requestAnimationFrame(pas);
    else {
      $('#horloge').innerHTML += ' · <b>terminé</b>';
      etat.anim = null; // le trafic en direct peut reprendre
      $('#s-resultat').innerHTML = `<h2>Ce tirage</h2><p class="note">${res.atteints} nœud(s) atteint(s) sur ${res.total} en ${fmt(res.fin / 1000, 1, ' s')} · ${res.stats.emissions} émission(s), ${res.stats.collisions} réception(s) perdue(s) par collision, ${res.stats.annulations} réémission(s) annulée(s), ${res.stats.reportsCanal} report(s) (canal occupé)${res.stats.sautsGratuits ? `, ${res.stats.sautsGratuits} saut(s) gratuit(s)` : ''}. Chaque tirage est différent : « 200 tirages » donne la moyenne.</p>`;
    }
  };
  etat.anim = { raf: requestAnimationFrame(pas) };
}

// ---- Trafic en direct : paquets reçus par les passerelles, animés sur le graphe ------------------------
const PORTS = {
  position: ['Position', '#4cc9f0'], telemetrie: ['Télémétrie', '#80ed99'], texte: ['Texte', '#f72585'], nodeinfo: ['Infos nœud', '#b8b8ff'],
  routage: ['Routage / ACK', '#8d99ae'], traceroute: ['Traceroute', '#ffd166'], voisinage: ['Voisinage', '#06d6a0'], mapreport: ['Rapport carte', '#a0c4ff'],
  chiffre: ['Chiffré', '#8b95a1'], autre: ['Autre', '#c9a7eb'],
};
const PORTS_MC = {
  ADVERT: ['Annonce', '#22c55e'], GRP_TXT: ['Canal', '#f72585'], TXT_MSG: ['Message direct', '#e879f9'], REQ: ['Requête', '#60a5fa'], RESPONSE: ['Réponse', '#38bdf8'],
  ACK: ['Accusé', '#94a3b8'], PATH: ['Chemin', '#fb923c'], TRACE: ['Trace', '#facc15'], ANON_REQ: ['Connexion', '#a78bfa'], GRP_DATA: ['Données', '#f472b6'], CONTROL: ['Contrôle', '#64748b'],
};
const port = (p) => (MC ? PORTS_MC[p] || PORTS.autre : PORTS[p] || PORTS.autre);
// Paquet MeshCore → même forme que Meshtastic (numéros du graphe) ; le chemin résolu donne les relais
function normaliserMc(m) {
  const n = (cle) => (cle ? etat.parCle.get(String(cle).toUpperCase()) ?? null : null);
  const relais = (m.cheminResolu || []).map(n);
  return { de: n(m.de), passerelle: n(m.observateur), relaisMc: relais, sauts: m.sauts, snr: m.snr, port: m.type, premiere: m.premiere, heure: m.heure, nomMc: m.nom };
}
const direct = { flux: [], comètes: 0, usage: new Map(), parMinute: [], emetteurs: new Map() };
// Trajet probable : liaisons connues, exactement `liens` sauts, en préférant les liaisons les plus observées
function cheminProbable(de, fin, nbLiens) {
  if (nbLiens < 1 || nbLiens > 8) return null;
  let couche = new Map([[de, { score: 0, chemin: [de] }]]);
  for (let k = 1; k <= nbLiens; k++) {
    const suiv = new Map();
    for (const [n, v] of couche) {
      for (const l of etat.voisins.get(n) || []) {
        const m = l.a === n ? l.b : l.a;
        if (v.chemin.includes(m) || (k < nbLiens && m === fin)) continue;
        const poids = Math.log2(1 + ((l.ab ? l.ab.nb : 0) + (l.ba ? l.ba.nb : 0))) + (l.unique ? 0 : 1);
        const sc = v.score + poids, a = suiv.get(m);
        if (!a || sc > a.score) suiv.set(m, { score: sc, chemin: [...v.chemin, m] });
      }
    }
    couche = suiv;
    if (!couche.size) return null;
  }
  const r = couche.get(fin);
  return r ? r.chemin : null;
}
// Position affichée d'un nœud : le sien s'il est visible, sinon celle du relais auquel il est rattaché
function ptAffiche(num) {
  const vis = etat.visibles && etat.visibles.find((n) => n.num === num);
  if (vis) return vis;
  const p = etat.parent && etat.parent.get(num);
  return p != null ? etat.visibles.find((n) => n.num === p) || null : null;
}
function animerComete(chemin, couleur, estime) {
  const pts = chemin.map(ptAffiche);
  // Points consécutifs confondus (client rattaché à son relais) : un seul
  const etapes = pts.filter((x, i) => x && (i === 0 || x !== pts[i - 1]));
  if (etapes.length < 2 || pts.some((x) => !x) || document.hidden || direct.comètes >= 30 || etat.anim) return;
  direct.comètes++;
  const trace = gOndes.append('polyline').attr('class', 'comete-trace' + (estime ? ' estime' : '')).attr('stroke', couleur);
  const tete = gOndes.append('circle').attr('class', 'comete-tete').attr('r', 5).attr('fill', couleur);
  let i = 0, debut = performance.now();
  const faits = [];
  const D = 520;
  const pas = (t) => {
    const a = etapes[i], b = etapes[i + 1];
    const f = Math.min(1, (t - debut) / D), e = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
    const x = a.x + (b.x - a.x) * e, y = a.y + (b.y - a.y) * e;
    tete.attr('cx', x).attr('cy', y);
    trace.attr('points', [...faits.map((p) => p.x + ',' + p.y), a.x + ',' + a.y, x + ',' + y].join(' '));
    if (f < 1) { requestAnimationFrame(pas); return; }
    faits.push(a);
    noterUsage(a.num, b.num);
    i++;
    if (i >= etapes.length - 1) {
      tete.remove();
      trace.transition().duration(900).style('opacity', 0).remove();
      gOndes.append('circle').attr('cx', b.x).attr('cy', b.y).attr('r', rayon(b)).attr('fill', 'none').attr('stroke', couleur).attr('stroke-width', 2.5)
        .transition().duration(1100).attr('r', rayon(b) + 26).style('opacity', 0).remove();
      direct.comètes--;
      return;
    }
    debut = performance.now();
    requestAnimationFrame(pas);
  };
  requestAnimationFrame(pas);
}
// Axes les plus empruntés depuis 10 min : liaisons soulignées
function noterUsage(a, b) {
  const k = a < b ? a + '-' + b : b + '-' + a;
  const l = direct.usage.get(k) || [];
  l.push(Date.now());
  direct.usage.set(k, l);
}
function majAxes() {
  const lim = Date.now() - 600000;
  for (const [k, l] of direct.usage) { const r = l.filter((t) => t >= lim); if (r.length) direct.usage.set(k, r); else direct.usage.delete(k); }
  const max = Math.max(1, ...[...direct.usage.values()].map((l) => l.length));
  gLiens.selectAll('line').classed('axe', (d) => { const n = (direct.usage.get(d.a + '-' + d.b) || []).length; return n >= 3 && n >= max * 0.3; });
}
setInterval(majAxes, 5000);
function recevoirPaquet(m) {
  const filtre = $('#trafic').value;
  if (MC) return recevoirPaquetMc(normaliserMc(m), filtre);
  const n = m.de >>> 0;
  if (!etat.parNum.has(n) && !etat.parNum.has(m.passerelle >>> 0)) return; // hors de la zone affichée
  // Flux et statistiques (une ligne par paquet, à sa première réception)
  if (m.premiere) {
    direct.flux.unshift(m);
    direct.flux = direct.flux.slice(0, 60);
    direct.parMinute.push(Date.now());
    direct.emetteurs.set(n, (direct.emetteurs.get(n) || 0) + 1);
    rendreDirect();
  }
  if (filtre === 'aucun' || (filtre === 'clairs' && m.port === 'chiffre') || (!['tous', 'clairs'].includes(filtre) && m.port !== filtre)) return;
  const gw = m.passerelle >>> 0;
  if (m.passerelle == null || gw === n || !etat.parNum.has(n) || !etat.parNum.has(gw)) return;
  let chemin = null, estime = false;
  if (m.sauts === 0) chemin = [n, gw];
  else if (m.relais != null && m.sauts === 1) chemin = [n, m.relais >>> 0, gw];
  else if (m.sauts > 0) {
    const avant = m.relais != null ? cheminProbable(n, m.relais >>> 0, m.sauts) : cheminProbable(n, gw, m.sauts + 1);
    chemin = avant ? (m.relais != null ? [...avant, gw] : avant) : m.relais != null ? [n, m.relais >>> 0, gw] : [n, gw];
    estime = true;
  }
  if (chemin && chemin.every((x) => etat.parNum.has(x))) animerComete(chemin, port(m.port)[1], estime);
}
function recevoirPaquetMc(m, filtre) {
  const n = m.de, gw = m.passerelle;
  if (n == null && gw == null) return;
  if (m.premiere) {
    direct.flux.unshift({ ...m, de: n ?? m.relaisMc.find((x) => x != null) ?? gw });
    direct.flux = direct.flux.slice(0, 60);
    direct.parMinute.push(Date.now());
    if (n != null) direct.emetteurs.set(n, (direct.emetteurs.get(n) || 0) + 1);
    rendreDirect();
  }
  if (filtre === 'aucun' || (filtre !== 'tous' && m.port !== filtre) || gw == null) return;
  // Chaîne connue : émetteur (s'il est connu), relais résolus, observateur ; les trous rendent le trajet « déduit »
  const chaine = [n, ...m.relaisMc, gw];
  const connus = chaine.filter((x) => x != null);
  const dedoublon = connus.filter((x, i) => i === 0 || x !== connus[i - 1]);
  if (dedoublon.length >= 2) animerComete(dedoublon, port(m.port)[1], chaine.some((x) => x == null));
}
function rendreDirect() {
  const z = $('#vue-direct');
  if (!z.classList.contains('actif')) return;
  const lim = Date.now() - 600000;
  direct.parMinute = direct.parMinute.filter((t) => t >= lim);
  const top = [...direct.emetteurs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const hm = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  z.innerHTML = `<div class="grille"><div class="mesure"><span>Paquets / min</span><b>${fmt(direct.parMinute.length / 10, 1)}</b></div><div class="mesure"><span>Depuis l’ouverture</span><b>${[...direct.emetteurs.values()].reduce((a, b) => a + b, 0)}</b></div><div class="mesure"><span>Émetteurs</span><b>${direct.emetteurs.size}</b></div></div>
    ${top.length ? `<h2>Les plus bavards (depuis l’ouverture)</h2>${top.map(([num, nb]) => `<div class="ligne" data-n="${num}"><span class="titre">${esc(nomDe(num))}</span><span class="val">${nb}</span></div>`).join('')}` : ''}
    <h2>Derniers paquets</h2>
    ${direct.flux.map((m) => `<div class="flux-l" data-n="${m.de >>> 0}"><span class="note">${hm(m.heure || Date.now())}</span><span><i style="background:${port(m.port)[1]}"></i>${esc(port(m.port)[0])} · <b>${esc(courtDe(m.de >>> 0))}</b>${m.passerelle != null ? ` → ${esc(courtDe(m.passerelle >>> 0))}` : ''}</span><span class="note">${m.sauts === 0 ? 'direct' : m.sauts != null ? m.sauts + ' saut' + (m.sauts > 1 ? 's' : '') : ''}${m.snr != null ? ' · ' + fmt(m.snr, 1, ' dB') : ''}</span></div>`).join('') || '<div class="note">En attente de paquets…</div>'}
    <p class="note">${MC ? 'Une comète par réception : émetteur → répéteurs → observateur, d’après le chemin du paquet (pointillé : une partie du chemin n’a pas pu être identifiée, préfixes de clé ambigus).' : 'Une comète par réception : émetteur → relais → passerelle (pointillé : trajet déduit des liaisons connues, Meshtastic ne transmettant que le dernier relais).'} Un client masqué part de son relais. Les liaisons empruntées le plus souvent depuis 10 min sont soulignées.</p>`;
  z.querySelectorAll('[data-n]').forEach((el) => (el.onclick = () => { const k = Number(el.dataset.n); if (etat.parNum.has(k)) { choisir(k); centrerSur(k); } }));
}
function connecterDirect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  const t = $('#temoin-direct');
  ws.onopen = () => { t.textContent = '● en direct'; t.className = 'note ok'; };
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m.genre === (MC ? 'mc-paquet' : 'paquet') && etat.donnees) recevoirPaquet(m); };
  ws.onclose = () => { t.textContent = '○ reconnexion…'; t.className = 'note'; setTimeout(connecterDirect, 4000); };
}

// ---- Interface ------------------------------------------------------------------------------
function ouvrirVue(v) {
  document.querySelectorAll('nav.onglets button').forEach((b) => b.classList.toggle('actif', b.dataset.vue === v));
  document.querySelectorAll('.vue').forEach((s) => s.classList.toggle('actif', s.id === 'vue-' + v));
  if (v === 'direct') rendreDirect();
}
document.querySelectorAll('nav.onglets button').forEach((b) => (b.onclick = () => ouvrirVue(b.dataset.vue)));
for (const id of ['#periode', '#zone', '#double-sens']) $(id).onchange = () => charger().catch(erreur);
document.querySelectorAll('.source').forEach((c) => (c.onchange = () => charger().catch(erreur)));
$('#disposition').onchange = () => dessiner();
$('#affichage').onchange = () => dessiner();
$('#filtre-liens').onchange = () => dessiner();
$('#ajuster').onclick = () => ajuster();
$('#recherche').oninput = (e) => {
  const t = e.target.value.trim().toLowerCase();
  if (t.length < 2) return;
  const n = etat.noeuds.find((x) => [x.nomLong, x.nomCourt, x.id].some((v) => v && v.toLowerCase().includes(t)));
  if (n) { choisir(n.num, false); centrerSur(n.num); }
};
function erreur(e) { $('#vue-analyse').innerHTML = `<div class="alerte">${esc(e.message)}</div>`; }
window.addEventListener('resize', () => { if (etat.noeuds.length) dessiner(); });
// En-tête selon le réseau : sources de liaisons, types de paquets, lien vers l'autre réseau
(function preparerEntete() {
  const autre = document.createElement('a');
  autre.className = 'retour';
  autre.href = MC ? 'topologie.html' : 'topologie.html?reseau=mc';
  autre.textContent = MC ? '⇄ Meshtastic' : '⇄ MeshCore';
  autre.title = 'Topologie de l’autre réseau';
  $('header h1').after(autre);
  document.title = MC ? 'Topologie MeshCore' : 'Topologie Meshtastic';
  $('header h1').firstChild.textContent = MC ? 'Topologie MeshCore ' : 'Topologie Meshtastic ';
  if (!MC) return;
  const src = [...document.querySelectorAll('.source')];
  const lib = [['rf', 'dernier saut mesuré'], ['voisinage', 'voisins déclarés'], ['trace', 'traces'], ['chemin', 'chemins déduits']];
  src.forEach((c, i) => { if (lib[i]) { c.value = lib[i][0]; c.parentNode.lastChild.textContent = ' ' + lib[i][1]; } });
  if (lib.length > src.length) {
    const l = document.createElement('label');
    l.innerHTML = `<input type="checkbox" class="source" value="chemin" checked> chemins déduits`;
    src[src.length - 1].parentNode.after(l);
    l.querySelector('input').onchange = () => charger().catch(erreur);
  }
  $('#trafic').innerHTML = [['tous', 'tous les paquets'], ['ADVERT', 'annonces'], ['GRP_TXT', 'messages de canal'], ['TXT_MSG', 'messages directs'], ['ACK', 'accusés'], ['PATH', 'chemins'], ['TRACE', 'traces'], ['aucun', 'arrêté']].map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
})();
initGraphe();
charger().catch(erreur);
connecterDirect();
setInterval(() => { if (!etat.anim) charger(false).catch(() => {}); }, 300000); // liaisons et nœuds rafraîchis toutes les 5 min
