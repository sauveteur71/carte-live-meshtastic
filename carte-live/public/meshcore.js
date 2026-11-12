/* Carte live — réseau MeshCore : nœuds, liens déduits des chemins, analyseur de paquets, companion */
'use strict';

// Couleurs par type de paquet MeshCore (clé courte renvoyée par le serveur)
const MC_TYPES = {
  annonce: { nom: 'Annonce', hex: '#22c55e', type: 'ADVERT' },
  canal: { nom: 'Canal', hex: '#f72585', type: 'GRP_TXT' },
  message: { nom: 'Message direct', hex: '#e879f9', type: 'TXT_MSG' },
  requete: { nom: 'Requête', hex: '#60a5fa', type: 'REQ' },
  reponse: { nom: 'Réponse', hex: '#38bdf8', type: 'RESPONSE' },
  ack: { nom: 'Accusé', hex: '#94a3b8', type: 'ACK' },
  chemin: { nom: 'Chemin', hex: '#fb923c', type: 'PATH' },
  trace: { nom: 'Trace', hex: '#facc15', type: 'TRACE' },
  connexion: { nom: 'Connexion', hex: '#a78bfa', type: 'ANON_REQ' },
  donnees: { nom: 'Données', hex: '#f472b6', type: 'GRP_DATA' },
  controle: { nom: 'Contrôle', hex: '#64748b', type: 'CONTROL' },
  autre: { nom: 'Autre', hex: '#c9a7eb', type: null },
};
const MC_CLE_TYPE = Object.fromEntries(Object.entries(MC_TYPES).filter(([, v]) => v.type).map(([k, v]) => [v.type, k]));
const mcType = (t) => MC_TYPES[MC_CLE_TYPE[t] || t] || MC_TYPES.autre;
const MC_ROLES = {
  repeteur: { nom: 'Répéteurs', un: 'Répéteur', hex: '#f97316' },
  salon: { nom: 'Room servers', un: 'Room server', hex: '#eab308' },
  companion: { nom: 'Companions', un: 'Companion', hex: '#22d3ee' },
  capteur: { nom: 'Capteurs', un: 'Capteur', hex: '#84cc16' },
  inconnu: { nom: 'Inconnus', un: 'Inconnu', hex: '#9ca3af' },
};
const mcRole = (r) => MC_ROLES[r] || MC_ROLES.inconnu;

const mc = {
  actif: false,
  noeuds: new Map(),
  marqueurs: new Map(),
  liens: [],
  couche: null,
  coucheLiens: null,
  etat: null,
  vue: (() => { try { return localStorage.getItem('gaulix_mc_vue') || 'noeuds'; } catch { return 'noeuds'; } })(),
  filtresTypes: new Set(Object.keys(MC_TYPES)),
  roles: (() => { try { return { ...Object.fromEntries(Object.keys(MC_ROLES).map((k) => [k, true])), ...JSON.parse(localStorage.getItem('gaulix_mc_roles') || '{}') }; } catch { return Object.fromEntries(Object.keys(MC_ROLES).map((k) => [k, true])); } })(),
  couches: { rf: true, chemin: true, trace: true, voisinage: true },
  selection: null,
  nav: { etat: 'aucun', ws: null, port: null, lecteur: null, ecrivain: null, ble: null, type: null, erreur: null, role: 'principal' },
};

const mcNom = (cle) => { const n = cle && mc.noeuds.get(cle); return n ? n.nom || n.id : cle ? cle.slice(0, 8) : '?'; };
const mcCourt = (cle) => { const n = cle && mc.noeuds.get(cle); return n && n.nom ? n.nom.slice(0, 14) : cle ? cle.slice(0, 4) : '?'; };
function mcDansZone(n) {
  if (!etat.zone || !n) return true;
  const z = etat.config.zone;
  if (n.lat != null && n.lon != null) return n.lat >= z[0] && n.lat <= z[2] && n.lon >= z[1] && n.lon <= z[3];
  return n.observateur || /^43/.test(n.nom || '');
}
const mcAffiche = () => mc.actif && etat.vueReseau !== 'meshtastic';
function mcVisible(n) {
  if (!mcAffiche() || n.lat == null || n.lon == null) return false;
  if (!mc.roles[n.role in MC_ROLES ? n.role : 'inconnu']) return false;
  if (!mcDansZone(n)) return false;
  if (!mcDansVue(n)) return false;
  // Répéteurs inactifs : gardés seulement dans la zone surveillée (sinon, flux national = des milliers de points morts)
  return etat.couches.inactifs || n.statut !== 'inactif' || (n.infrastructure && !!etat.zone);
}
// Avec beaucoup de nœuds (flux national), on ne dessine que ce qui est autour de la vue
function mcDansVue(n) {
  if (mc.noeuds.size < 400 || typeof carte === 'undefined' || !carte) return true;
  if (!mc.emprise) mc.emprise = carte.getBounds().pad(0.3);
  return mc.emprise.contains([n.lat, n.lon]);
}
// Liaisons invraisemblables : un chemin déduit des empreintes de répéteurs (1 octet = collisions fréquentes)
// au-delà de 60 km est presque toujours une mauvaise identification ; au-delà de 150 km pour une mesure.
const MC_DIST_MAX = { chemin: 60, rf: 150, trace: 150, voisinage: 150 };
const MC_LIENS_MAX = 500;

// ---- Choix du réseau affiché : Meshtastic, MeshCore ou les deux ------------------------------------
etat.vueReseau = (() => { try { return localStorage.getItem('gaulix_reseau') || 'les-deux'; } catch { return 'les-deux'; } })();
function appliquerVueReseau() {
  // Carte limitée à un seul réseau (CARTE_RESEAUX) : pas de choix
  const seul = etat.config && etat.config.reseaux && etat.config.reseaux !== 'les-deux' ? etat.config.reseaux : null;
  if (seul) etat.vueReseau = seul;
  document.querySelectorAll('.choix-reseau').forEach((el) => (el.hidden = !!seul));
  // Menu Outils : outils Meshtastic et/ou MeshCore selon le réseau affiché
  document.querySelectorAll('.outils-mc').forEach((el) => (el.hidden = !etat.config.meshcore || etat.vueReseau === 'meshtastic'));
  document.querySelectorAll('.outils-mt').forEach((el) => (el.hidden = etat.vueReseau === 'meshcore'));
  if (!mc.actif) etat.vueReseau = 'meshtastic';
  try { localStorage.setItem('gaulix_reseau', etat.vueReseau); } catch { /* stockage indisponible */ }
  document.body.dataset.reseau = etat.vueReseau;
  document.querySelectorAll('.choix-reseau button').forEach((b) => b.classList.toggle('actif', b.dataset.reseau === etat.vueReseau));
  const ong = document.querySelector('.onglets button[data-onglet="meshcore"]');
  if (ong) ong.hidden = etat.vueReseau === 'meshtastic';
  // Onglets propres à Meshtastic masqués en vue MeshCore seule
  for (const o of ['noeuds', 'trafic', 'analyse', 'gestion', 'messages']) {
    const b = document.querySelector(`.onglets button[data-onglet="${o}"]`);
    if (b && !b.dataset.cacheInitial) b.dataset.cacheInitial = b.hidden ? '1' : '0';
    if (b) b.hidden = b.dataset.cacheInitial === '1' || etat.vueReseau === 'meshcore';
  }
  const actif = document.querySelector('.onglets button.actif');
  if (etat.vueReseau === 'meshcore' && (!actif || actif.hidden)) ong && ong.click();
  if (etat.vueReseau === 'meshtastic' && actif && actif.dataset.onglet === 'meshcore') document.querySelector('.onglets button[data-onglet="reseau"]').click();
  dessinerNoeuds();
  dessinerLiens();
  mcRedessiner();
  rendreLegende();
  mcMajKpis();
  mcMajAlertes();
  mcDessinerChaleur();
  // Traces de l'autre réseau : axes de trafic, liaisons allumées, parcours d'un message affiché
  if (typeof dessinerAxes === 'function') dessinerAxes();
  if (typeof anim !== 'undefined' && anim.coucheAllumes) anim.coucheAllumes.clearLayers();
  if (etat.parcoursReseau && etat.parcoursReseau !== etat.vueReseau && etat.vueReseau !== 'les-deux' && typeof effacerParcours === 'function') effacerParcours();
}

// ---- Carte ---------------------------------------------------------------------------------
function mcIcone(n) {
  const r = n.role in MC_ROLES ? n.role : 'inconnu';
  const classes = ['mkc', r, n.statut];
  if (n.observateur) classes.push('observateur');
  const montrerNom = n.infrastructure || carte.getZoom() >= 11;
  return L.divIcon({
    className: '',
    html: `<div class="${classes.join(' ')}" style="--mcc:${mcRole(r).hex}"><div class="c"></div>${montrerNom ? `<div class="lbl">${esc((n.nom || n.id).slice(0, 18))}</div>` : ''}</div>`,
    iconSize: [14, 14], iconAnchor: [7, 7],
  });
}
function mcDessinerNoeuds() {
  if (!mc.couche) return;
  // Companions et nœuds proches regroupés aux faibles zooms (répéteurs et room servers toujours visibles)
  if (!mc.coucheGroupes) mc.coucheGroupes = L.layerGroup().addTo(mc.couche);
  const seuls = typeof regrouper === 'function' ? regrouper([...mc.noeuds.values()].filter((n) => mcVisible(n) && !n.infrastructure && mc.selection !== n.cle), mc.coucheGroupes, (n) => n.cle) : null;
  const affiche = (n) => mcVisible(n) && (!seuls || n.infrastructure || mc.selection === n.cle || seuls.has(n.cle));
  for (const [cle, m] of mc.marqueurs) {
    const n = mc.noeuds.get(cle);
    if (!n || !affiche(n)) { m.remove(); mc.marqueurs.delete(cle); }
  }
  for (const n of mc.noeuds.values()) {
    if (!affiche(n)) continue;
    let m = mc.marqueurs.get(n.cle);
    if (!m) {
      m = L.marker([n.lat, n.lon], { icon: mcIcone(n), riseOnHover: true, zIndexOffset: n.infrastructure ? 600 : 100 });
      m.on('click', () => {
        if (etat.modeProfil) { choisirPointProfil({ lat: n.lat, lon: n.lon, nom: n.nom || n.id, h: n.infrastructure ? 6 : 2 }); return; }
        mcOuvrirFiche(n.cle);
      });
      m.on('contextmenu', (ev) => { L.DomEvent.stop(ev); const o = ev.originalEvent; if (typeof menuNoeud === 'function') menuNoeud(o.clientX, o.clientY, n.cle); });
      m.bindTooltip('', { className: 'info', direction: 'top', offset: [0, -8] });
      m.addTo(mc.couche);
      mc.marqueurs.set(n.cle, m);
    } else {
      m.setLatLng([n.lat, n.lon]);
      m.setIcon(mcIcone(n));
    }
    m.setTooltipContent(`<b>${esc(n.nom || n.id)}</b> <small>MeshCore</small><br>${esc(mcRole(n.role).un)}${n.observateur ? ' · ' + esc(mcLibObservateur(n)) : ''} · ${ilYa(n.dernierVu)}` +
      (n.sautsMin != null ? `<br>${n.sautsMin === 0 ? 'entendu en direct' : n.sautsMin + ' saut' + (n.sautsMin > 1 ? 's' : '') + ' au mieux'}` : '') +
      (n.snr != null ? ` · SNR ${fmt(n.snr, 1, ' dB')}` : ''));
  }
}
function mcDessinerLiens() {
  if (!mc.coucheLiens) return;
  mc.coucheLiens.clearLayers();
  if (!mcAffiche()) return;
  const maintenant = Date.now(), fenetre = mcFenetreHeures() * 3600000;
  const fusion = new Map();
  for (const l of mc.liens) {
    if (!mc.couches[l.source]) continue;
    if (maintenant - l.dernierVu > fenetre) continue;
    const a = mc.noeuds.get(l.a), b = mc.noeuds.get(l.b);
    if (!a || !b || a.lat == null || b.lat == null) continue;
    if (etat.zone && !mcDansZone(a) && !mcDansZone(b)) continue;
    if (!mcDansVue(a) && !mcDansVue(b)) continue;
    // Vue large : seulement les liaisons mesurées (les chemins déduits surchargent la carte)
    if (l.source === 'chemin' && carte.getZoom() < 9) continue;
    const dkm = distanceKm(a, b);
    if (dkm != null && dkm > (MC_DIST_MAX[l.source] || 150)) continue;
    const cle = [l.a < l.b ? l.a : l.b, l.a < l.b ? l.b : l.a, l.source].join(':');
    const f = fusion.get(cle);
    if (!f) fusion.set(cle, { ...l, na: a, nbN: b });
    else { f.nb += l.nb; f.dernierVu = Math.max(f.dernierVu, l.dernierVu); if (l.snr != null && (f.snr == null || l.snr > f.snr)) f.snr = l.snr; }
  }
  // Au plus MC_LIENS_MAX liaisons : les plus observées d'abord
  const retenus = [...fusion.values()].sort((x, y) => y.nb - x.nb).slice(0, MC_LIENS_MAX);
  for (const l of retenus) {
    const age = (maintenant - l.dernierVu) / fenetre;
    const ligne = L.polyline([[l.na.lat, l.na.lon], [l.nbN.lat, l.nbN.lon]], {
      pane: 'liens', color: l.source === 'chemin' && l.snr == null ? '#fb923c' : couleurSnr(l.snr),
      weight: epaisseurLien(Math.min(1 + Math.log2(1 + l.nb) * 0.6, 4)), opacity: opaciteLien(Math.max(0.2, 0.85 - age * 0.7)),
      dashArray: l.source === 'chemin' ? '5 6' : l.source === 'trace' ? '2 5' : l.source === 'voisinage' ? '9 4 2 4' : null, className: 'lien-mc',
    });
    const d = distanceKm(l.na, l.nbN);
    ligne.bindTooltip(`<b>${esc(l.na.nom || l.na.id)} ↔ ${esc(l.nbN.nom || l.nbN.id)}</b> <small>MeshCore</small><br>` +
      `${{ rf: 'Liaison radio mesurée (dernier saut vers un observateur)', chemin: 'Liaison déduite du chemin d’un paquet', trace: 'Mesure directe (trace ou découverte, SNR mesuré)', voisinage: 'Voisin déclaré par le répéteur (SNR mesuré par lui)' }[l.source]}` +
      `${l.snr != null ? '<br>SNR ' + fmt(l.snr, 1, ' dB') : ''}${l.rssi != null ? ' · RSSI ' + fmt(l.rssi, 0, ' dBm') : ''}` +
      `<br>${l.nb} observation${l.nb > 1 ? 's' : ''}${d != null ? ' · ' + fmt(d, 1, ' km') : ''} · ${ilYa(l.dernierVu)}`, { className: 'info', sticky: true });
    ligne.addTo(mc.coucheLiens);
  }
}
function mcRedessiner() { mcDessinerNoeuds(); mcDessinerLiens(); }

// Animation : trajet du paquet, de l'origine (si connue) jusqu'à l'observateur, par les relais résolus
function mcAnimer(p) {
  if (!mcAffiche() || !etat.couches.animations || !mc.filtresTypes.has(MC_CLE_TYPE[p.type] || 'autre')) return;
  if (etat.rejeu && etat.rejeu.actif) return;
  const pt = (cle) => { const n = cle && mc.noeuds.get(cle); return n && n.lat != null ? { lat: n.lat, lon: n.lon, cle } : null; };
  // Trajet : origine (si connue) → répéteurs identifiés → observateur. Un répéteur non identifié interrompt le tracé.
  const cles = [];
  if (p.chemin && p.chemin.length && p.cheminResolu) { if (p.de) cles.push(p.de); cles.push(...p.cheminResolu); }
  else if (p.sauts === 0 && p.de) cles.push(p.de);
  cles.push(p.observateur);
  const pts = cles.map(pt);
  const estime = pts.some((x) => !x);
  const connus = pts.filter(Boolean);
  if (etat.zone && !connus.some((x) => { const z = etat.config.zone; return x.lat >= z[0] && x.lat <= z[2] && x.lon >= z[1] && x.lon <= z[3]; })) return;
  const coul = mcType(p.type).hex;
  if (connus[0]) mcFlasher(connus[0].cle);
  animerTrajet(connus, { couleur: coul, estime, reseau: 'mc', auFil: (i) => mcFlasher(connus[i].cle) });
  const fin = connus[connus.length - 1];
  if (fin) {
    const onde = L.marker([fin.lat, fin.lon], { icon: L.divIcon({ className: '', html: `<div class="onde" style="border-color:${coul}"></div>`, iconSize: [10, 10], iconAnchor: [5, 5] }), interactive: false, pane: 'traces' }).addTo(carte);
    setTimeout(() => onde.remove(), 1500);
  }
}
function mcFlasher(cle) {
  const m = mc.marqueurs.get(cle);
  const el = m && m.getElement() && m.getElement().querySelector('.mkc');
  if (!el) return;
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

// ---- Légende (insérée dans la légende commune) -------------------------------------------------
function mcHtmlLegende() {
  if (!mcAffiche()) return '';
  const nb = (r) => [...mc.noeuds.values()].filter((n) => n.lat != null && (n.role in MC_ROLES ? n.role : 'inconnu') === r && mcDansZone(n) && (etat.couches.inactifs || n.statut !== 'inactif' || n.infrastructure)).length;
  const b = (actif, attr, txt) => `<button class="pilule ${actif ? 'on' : ''}" ${attr}>${txt}</button>`;
  return `<div class="leg-sep"></div><div class="leg-titre-mc">MeshCore</div>
    ${Object.entries(MC_ROLES).map(([k, r]) => `<div class="leg-ligne"><span class="pastille-leg mc ${k}" style="--mcc:${r.hex}"></span><span class="leg-nom">${r.nom} <small>${nb(k)}</small></span>${b(mc.roles[k], `data-mc-role="${k}"`, mc.roles[k] ? 'Affiché' : 'Masqué')}</div>`).join('')}
    <div class="leg-ligne"><span class="leg-nom">Liens vus depuis</span><select id="mc-fenetre" class="mini-select" title="Durée pendant laquelle un lien MeshCore reste affiché après sa dernière observation">${[[0.25, '15 min'], [0.5, '30 min'], [1, '1 h'], [3, '3 h'], [6, '6 h'], [24, '24 h']].map(([v, t]) => `<option value="${v}" ${mcFenetreHeures() === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    <div class="leg-ligne"><span class="leg-nom">Liens</span>${b(mc.couches.rf, 'data-mc-couche="rf"', 'Mesurés')}${b(mc.couches.chemin, 'data-mc-couche="chemin"', 'Chemins')}${b(mc.couches.trace, 'data-mc-couche="trace"', 'Traces')}${b(mc.couches.voisinage, 'data-mc-couche="voisinage"', 'Voisins')}</div>
    <div class="rang">◆ répéteur · ■ room server · ◯ companion · ▲ capteur · anneau = observateur</div>
    <div class="rang">— mesuré (SNR) · - - chemin d’un paquet · ··· trace · -·- voisin déclaré</div>`;
}
function mcBrancherLegende(z) {
  z.querySelectorAll('[data-mc-role]').forEach((b) => (b.onclick = () => {
    mc.roles[b.dataset.mcRole] = !mc.roles[b.dataset.mcRole];
    try { localStorage.setItem('gaulix_mc_roles', JSON.stringify(mc.roles)); } catch { /* idem */ }
    mcDessinerNoeuds(); rendreLegende();
  }));
  const sf = z.querySelector('#mc-fenetre');
  if (sf) sf.onchange = () => { try { localStorage.setItem('gaulix_mc_fenetre', sf.value); } catch { /* ignoré */ } mcChargerLiens().catch(() => {}); };
  z.querySelectorAll('[data-mc-couche]').forEach((b) => (b.onclick = () => { mc.couches[b.dataset.mcCouche] = !mc.couches[b.dataset.mcCouche]; mcDessinerLiens(); rendreLegende(); }));
}

// ---- Indicateurs du bandeau ---------------------------------------------------------------------
function mcMajKpis() {
  const s = mc.etat && mc.etat.stats;
  const z = [...mc.noeuds.values()].filter(mcDansZone);
  const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  set('#k-mc-actifs', z.length ? `${z.filter((n) => n.statut === 'actif').length}/${z.length}` : '–');
  set('#k-mc-repeteurs', z.filter((n) => n.role === 'repeteur').length || '–');
  set('#k-mc-obs', s ? `${s.observateursEnLigne}/${s.observateurs}` : '–');
  set('#k-mc-liens', s ? s.liens : '–');
  set('#k-mc-debit', s ? fmt(s.paquetsMinute, 1) : '–');
}

// ---- Panneau MeshCore ---------------------------------------------------------------------------
function mcRendrePanneau() {
  document.querySelectorAll('.sous-onglets-mc button').forEach((b) => b.classList.toggle('actif', b.dataset.mcVue === mc.vue));
  const z = $('#mc-contenu');
  if (!z) return;
  if (mc.vue === 'noeuds') mcRendreNoeuds();
  else if (mc.vue === 'paquets') mcRendrePaquets();
  else if (mc.vue === 'messages') mcRendreMessages();
  else if (mc.vue === 'gestion') mcRendreGestion();
  else if (mc.vue === 'analyse') mcRendreAnalyse();
  else mcRendreCompanion();
}
// D'où viennent les réceptions d'un observateur : companion relié à la carte (principal ou en écoute), ou broker MQTT
function mcLibObservateur(n, majuscule) {
  const d = n.detailsObservateur || {};
  const t = d.carte ? (d.ecoute ? 'observateur de la carte (écoute)' : 'observateur de la carte') : `observateur MQTT${d.iata ? ' · ' + d.iata : ''}`;
  return majuscule ? t[0].toUpperCase() + t.slice(1) : t;
}
function mcRendreNoeuds() {
  const z = $('#mc-contenu');
  if (!z.querySelector('#mc-recherche')) {
    z.innerHTML = `<div class="recherche"><input id="mc-recherche" type="search" placeholder="Nom ou début de clé…" autocomplete="off">
      ${etat.membre ? '<select id="mc-groupe" title="Groupe de nœuds"><option value="">Tous</option><option value="favoris">⭐ Favoris</option><option value="administres">🛠 Mes nœuds</option></select>' : ''}
      <select id="mc-tri"><option value="vu">Dernier entendu</option><option value="nom">Nom</option><option value="role">Type</option><option value="sauts">Sauts</option></select>
      <button type="button" class="mini" id="mc-par-type" title="Ranger la liste par type (répéteurs, companions…), chaque groupe se replie">▦ Par type</button></div>
      <div id="mc-resume" class="note"></div><div id="mc-liste" class="liste"></div>`;
    $('#mc-recherche').oninput = mcRendreNoeuds;
    $('#mc-tri').onchange = mcRendreNoeuds;
    $('#mc-par-type').onclick = () => { ecrireLs('gaulix_mc_par_type', !lireLs('gaulix_mc_par_type', true)); mcRendreNoeuds(); };
    const g = $('#mc-groupe');
    if (g) { try { g.value = localStorage.getItem('gaulix_mc_groupe') || ''; } catch { /* ignoré */ } g.onchange = () => { try { localStorage.setItem('gaulix_mc_groupe', g.value); } catch { /* ignoré */ } mcRendreNoeuds(); }; }
  }
  const f = $('#mc-recherche').value.trim().toLowerCase(), tri = $('#mc-tri').value;
  const groupe = $('#mc-groupe') ? $('#mc-groupe').value : '';
  const liste = [...mc.noeuds.values()].filter((n) => (groupe ? true : mcDansZone(n)) && (!f || (n.nom || '').toLowerCase().includes(f) || (f.length >= 4 && n.cle.toLowerCase().startsWith(f)))
    && (groupe !== 'favoris' || estFavori(n.cle)) && (groupe !== 'administres' || estAdministre(n.cle)));
  const ordreRole = { repeteur: 0, salon: 1, capteur: 2, companion: 3, inconnu: 4 };
  liste.sort({
    vu: (a, b) => (b.dernierVu || 0) - (a.dernierVu || 0),
    nom: (a, b) => (a.nom || a.id).localeCompare(b.nom || b.id),
    role: (a, b) => (ordreRole[a.role] ?? 9) - (ordreRole[b.role] ?? 9) || (b.dernierVu || 0) - (a.dernierVu || 0),
    sauts: (a, b) => (a.sautsMin ?? 99) - (b.sautsMin ?? 99),
  }[tri]);
  liste.sort((a, b) => estFavori(b.cle) - estFavori(a.cle)); // favoris en tête (tri stable)
  const c = (r) => liste.filter((n) => n.role === r).length;
  $('#mc-resume').textContent = `${liste.length} nœud(s) : ${c('repeteur')} répéteur(s), ${c('salon')} room server(s), ${c('companion')} companion(s)${c('capteur') ? `, ${c('capteur')} capteur(s)` : ''}`;
  const parType = lireLs('gaulix_mc_par_type', true);
  $('#mc-par-type').classList.toggle('actif', parType);
  const ligneNoeudMc = (n) => {
    const sauts = n.sautsMin == null ? '' : n.sautsMin === 0 ? 'direct · ' : `${n.sautsMin} saut${n.sautsMin > 1 ? 's' : ''} · `;
    return `<div class="ligne" data-mc="${n.cle}"><span class="point ${n.statut}"></span><span class="titre"><i class="role-mc ${n.role}" style="--mcc:${mcRole(n.role).hex}"></i>${estFavori(n.cle) ? '⭐ ' : ''}${estAdministre(n.cle) ? '🛠 ' : ''}${esc(n.nom || n.id)}<small>${esc(mcRole(n.role).un)}${n.observateur ? ' · ' + mcLibObservateur(n) : ''}</small></span><span class="meta">${sauts}${ilYa(n.dernierVu)}</span></div>`;
  };
  const vide = '<div class="vide">Aucun nœud MeshCore pour l’instant : reliez un companion (onglet Companion) ou abonnez la carte à un flux MQTT MeshCore.</div>';
  if (!parType) { $('#mc-liste').innerHTML = liste.length ? liste.slice(0, 400).map(ligneNoeudMc).join('') : vide; return; }
  // Rangement par type : un groupe repliable par rôle, état (ouvert / replié) gardé dans ce navigateur
  const replies = lireLs('gaulix_mc_replies', {});
  const html = ['repeteur', 'salon', 'capteur', 'companion', 'inconnu'].map((r) => {
    const l = liste.filter((n) => (MC_ROLES[n.role] ? n.role : 'inconnu') === r);
    if (!l.length) return '';
    const actifs = l.filter((n) => n.statut === 'actif').length;
    return `<details class="groupe-mc" data-role="${r}" ${replies[r] ? '' : 'open'}><summary><i class="role-mc ${r}" style="--mcc:${mcRole(r).hex}"></i><b>${esc(mcRole(r).nom)}</b> <span class="pastille">${l.length}</span> <small>${actifs} actif${actifs > 1 ? 's' : ''}</small></summary>${l.slice(0, 300).map(ligneNoeudMc).join('')}</details>`;
  }).join('');
  $('#mc-liste').innerHTML = html || vide;
  $('#mc-liste').querySelectorAll('details.groupe-mc').forEach((d) => d.addEventListener('toggle', () => { const x = lireLs('gaulix_mc_replies', {}); x[d.dataset.role] = !d.open; ecrireLs('gaulix_mc_replies', x); }));
}

// Analyseur de paquets : filtres par type, liste en direct
function mcLignePaquet(p, nouveau) {
  const t = mcType(p.type);
  const de = p.de ? `<b>${esc(mcNom(p.de))}</b>` : p.expediteur && p.expediteur !== '…' ? `<b>${esc(p.expediteur)}</b>` : '';
  const vers = '';
  const resume = p.expediteur ? String(p.resume || '').replace(' · ' + p.expediteur, '') : p.resume;
  const resolu = p.cheminResolu || [];
  const chemin = p.chemin && p.chemin.length
    ? `<div class="chemin-mc">${p.chemin.map((h, i) => `<span class="saut${resolu[i] ? ' resolu' : ''}" title="${esc(resolu[i] ? mcNom(resolu[i]) : 'relais non identifié')}">${esc(h)}${resolu[i] ? ' ' + esc(mcCourt(resolu[i])) : ''}</span>`).join('<i>›</i>')}${p.observateur ? `<i>›</i><span class="saut obs" title="observateur">${esc(mcCourt(p.observateur))}</span>` : ''}</div>` : '';
  const radio = [p.route ? { FLOOD: 'inondation', TRANSPORT_FLOOD: 'inondation (zone)', DIRECT: 'direct', TRANSPORT_DIRECT: 'direct (zone)' }[p.route] : null,
    p.sauts != null ? (p.sauts === 0 ? 'entendu en direct' : `${p.sauts} saut${p.sauts > 1 ? 's' : ''}`) : null,
    p.snr != null ? `SNR ${fmt(p.snr, 1)} dB` : null, p.rssi != null ? `RSSI ${p.rssi} dBm` : null,
    p.nbObservateurs > 1 ? `${p.nbObservateurs} observateurs` : p.nbReceptions > 1 ? `${p.nbReceptions} réceptions` : null].filter(Boolean).join(' · ');
  return `<div class="paquet mc${nouveau ? ' nouveau' : ''}" data-mc-paquet="${p.rowid}">
    <div class="entete"><span class="heure">${heure(p.heure)}</span><span class="tag"><i style="background:${t.hex}"></i>${esc(t.nom)}</span>${p.canal ? `<span>${esc(p.canal)}</span>` : ''}<span class="hach mono">${esc((p.hachage || '').slice(0, 8))}</span></div>
    <div class="corps">${de}${vers} <span class="radio">${esc(resume || '')}</span></div>
    ${p.texte ? `<div class="corps">💬 ${esc(p.texte)}</div>` : ''}${chemin}
    ${radio ? `<div class="radio">${radio}</div>` : ''}</div>`;
}
async function mcRendrePaquets() {
  const z = $('#mc-contenu');
  z.innerHTML = `<div class="filtres" id="mc-filtres">${Object.entries(MC_TYPES).map(([k, t]) => `<button data-mc-type="${k}" class="${mc.filtresTypes.has(k) ? 'actif' : ''}"><i style="background:${t.hex}"></i>${esc(t.nom)}</button>`).join('')}</div>
    <div id="mc-flux" class="flux"><div class="vide">Chargement…</div></div>`;
  $('#mc-filtres').onclick = (e) => {
    const b = e.target.closest('[data-mc-type]');
    if (!b) return;
    const k = b.dataset.mcType;
    if (e.detail === 2 || e.altKey) { mc.filtresTypes = new Set([k]); } else if (mc.filtresTypes.has(k)) mc.filtresTypes.delete(k); else mc.filtresTypes.add(k);
    mcRendrePaquets();
  };
  let liste = [];
  try { liste = await api('/api/mc/paquets?limite=300'); } catch (e) { $('#mc-flux').innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  if (mc.vue !== 'paquets' || !$('#mc-flux')) return;
  const f = liste.filter((p) => mc.filtresTypes.has(MC_CLE_TYPE[p.type] || 'autre'));
  $('#mc-flux').innerHTML = f.length ? f.map((p) => mcLignePaquet({ ...p, cheminResolu: null }, false)).join('') : '<div class="vide">Aucun paquet MeshCore pour ces filtres.</div>';
}
function mcAjouterAuFlux(p) {
  const flux = $('#mc-flux');
  if (!flux || !p.premiere || !mc.filtresTypes.has(MC_CLE_TYPE[p.type] || 'autre')) return;
  const vide = flux.querySelector('.vide'); if (vide) vide.remove();
  flux.insertAdjacentHTML('afterbegin', mcLignePaquet(p, true));
  while (flux.children.length > (typeof MOBILE !== 'undefined' && MOBILE ? 80 : 300)) flux.lastElementChild.remove();
}

// ---- Messages : lecture (membres), envoi sur un canal ou en direct (admin, par le companion) ----------
// Filtre des messages MeshCore : tous, un canal, ou les messages directs (retenu dans le navigateur)
let mcFiltreMsg = (() => { try { return localStorage.getItem('mcFiltreMessages') || ''; } catch { return ''; } })();
const memeCanalMc = (a, b) => String(a || '').replace(/^#/, '').toLowerCase() === String(b || '').replace(/^#/, '').toLowerCase();
function choisirFiltreMc(v) { mcFiltreMsg = v || ''; try { localStorage.setItem('mcFiltreMessages', mcFiltreMsg); } catch { /* navigation privée */ } }
// Canaux MeshCore connus (companion relié, ou canaux vus dans les messages) : proposés aussi dans le menu Meshtastic
function canauxMcConnus() {
  const l = [];
  for (const x of [...(((mc.etat || {}).companion || {}).canaux || []).map((k) => k.nom), ...(mc.canauxVus || [])]) if (x && !l.some((y) => memeCanalMc(x, y))) l.push(x);
  return l;
}
async function mcRendreMessages() {
  const z = $('#mc-contenu');
  if (!etat.membre) { z.innerHTML = '<div class="vide">Connectez-vous pour lire les messages MeshCore.</div>'; return; }
  let l = [];
  try { l = await api('/api/mc/messages?limite=300'); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  if (mc.vue !== 'messages') return;
  const avantLecture = !document.hidden && typeof nonLus !== 'undefined' ? { ...nonLus } : {};
  mcMarquerLus();
  const cleMc = (m) => (m.genre === 'direct' ? 'mcdirect' : 'mc:' + String(m.canal || '?').toLowerCase());
  if (typeof marquerNouveaux === 'function') marquerNouveaux(l.filter((m) => mcFiltreVoit(cleMc(m))), cleMc, (m) => 'mc' + (m.id != null ? m.id : m.heure + (m.nomDe || '')), (m) => m.sens === 'recu', avantLecture);
  const c = (mc.etat && mc.etat.companion) || {};
  const canaux = c.canaux || [];
  const peutEnvoyer = etat.admin && c.connecte;
  // Une demande d'écriture (répondre, message direct depuis une fiche) choisit le canal ou la vue « directs »
  if (mc.destMessage && mc.destMessage.startsWith('canal:')) { const k = canaux.find((x) => 'canal:' + x.index === mc.destMessage); if (k) choisirFiltreMc('c:' + k.nom); mc.destMessage = null; }
  else if (mc.destMessage && mc.destMessage.startsWith('direct:') && mc.dernierDirect !== mc.destMessage) { choisirFiltreMc('direct'); mc.dernierDirect = mc.destMessage; }
  const kf = mcFiltreMsg.startsWith('c:') ? canaux.find((x) => memeCanalMc(x.nom, mcFiltreMsg.slice(2))) : null;
  // Un seul choix pour lire et écrire : le canal affiché est celui où l'on écrit
  const enDirect = mcFiltreMsg === 'direct';
  const dest = enDirect ? (mc.destMessage && mc.destMessage.startsWith('direct:') ? mc.destMessage : '') : kf ? 'canal:' + kf.index : '';
  const lectureSeule = !dest ? (enDirect ? 'Choisissez un destinataire dans la liste (« Message direct à… »).' : mcFiltreMsg.startsWith('c:') ? `Le canal « ${mcFiltreMsg.slice(2)} » n’est pas sur le companion : lecture seule.` : 'Choisissez un canal ci-dessus pour y écrire.') : '';
  const destDirect = dest.startsWith('direct:') ? dest.slice(7) : null;
  const ancienTexte = $('#mc-texte') ? $('#mc-texte').value : '';
  // Filtre : canaux du companion et canaux vus dans les messages
  const filtreCanaux = [];
  for (const x of [...canaux.map((k) => k.nom), ...l.filter((m) => m.genre !== 'direct').map((m) => m.canal)]) if (x && !filtreCanaux.some((y) => memeCanalMc(x, y))) filtreCanaux.push(x);
  const vus = !mcFiltreMsg ? l : mcFiltreMsg === 'passerelle' ? l.filter((m) => estRelaye(m.texte)) : mcFiltreMsg === 'direct' ? l.filter((m) => m.genre === 'direct') : l.filter((m) => m.genre !== 'direct' && memeCanalMc(m.canal, mcFiltreMsg.slice(2)));
  z.innerHTML = `
    <div class="filtre-messages">${typeof barreCanauxHtml === 'function' ? barreCanauxHtml('mc', mcFiltreMsg) : ''}<label title="Le canal choisi est celui que vous lisez et celui où vous écrivez">Canal <select id="mc-filtre-msg">
      ${(() => { const nl = (k) => (typeof nonLus !== 'undefined' && nonLus[k]) || 0, tx = (n) => (n ? ` · ${n} nouveau${n > 1 ? 'x' : ''}` : ''); const tot = typeof nonLus !== 'undefined' ? Object.entries(nonLus).filter(([k]) => k.startsWith('mc')).reduce((a, [, n]) => a + n, 0) : 0;
        return `<option value="">Tous${tx(tot)}</option>
      ${filtreCanaux.map((x) => `<option value="c:${esc(x)}" ${mcFiltreMsg === 'c:' + x ? 'selected' : ''}>📢 ${esc(x)}${tx(nl('mc:' + String(x).toLowerCase()))}</option>`).join('')}
      <option value="direct" ${mcFiltreMsg === 'direct' ? 'selected' : ''}>✉️ Messages directs${tx(nl('mcdirect'))}</option>
      ${etat.config.passerelle || l.some((m) => estRelaye(m.texte)) ? `<option value="passerelle" ${mcFiltreMsg === 'passerelle' ? 'selected' : ''}>⇄ Relayés par la passerelle</option>` : ''}
      ${typeof envoi !== 'undefined' && (envoi.canaux || []).length ? `<optgroup label="Meshtastic">${envoi.canaux.map((k) => `<option value="mt:${esc(k.nom)}">📢 ${esc(k.nom)}</option>`).join('')}</optgroup>` : ''}`; })()}
    </select></label></div>
    ${peutEnvoyer ? `<form id="mc-envoi" class="envoi">
      <div class="envoi-ligne"><select id="mc-dest" aria-label="Destinataire" ${enDirect ? '' : 'hidden'}>${!dest ? '<option value="" selected disabled>— destinataire —</option>' : ''}
        ${canaux.map((x) => `<option value="canal:${x.index}" hidden ${dest === 'canal:' + x.index ? 'selected' : ''}>Canal ${esc(x.nom)}</option>`).join('')}
        ${destDirect ? `<option value="direct:${destDirect}" selected>✉️ ${esc(mcNom(destDirect))} (direct)</option>` : ''}
        <option value="choisir">✉️ Message direct à…</option>
      </select><span class="compteur" id="mc-compteur">0/140</span></div>
      <div class="envoi-ligne"><textarea id="mc-texte" rows="2" maxlength="140" placeholder="${dest ? (enDirect ? 'Message direct' : 'Message sur ' + esc(kf.nom)) + ' (envoyé par ' + esc(c.nom || 'le companion') + ')…' : 'Choisissez un canal pour écrire'}" required></textarea><button type="submit" class="principal" ${dest ? '' : 'disabled'}>Envoyer</button></div>
      <div class="envoi-ligne"><button type="button" class="mini" id="mc-btn-position" title="Ajoute au message la position du centre de la carte ; clic droit sur la carte : n’importe quel point">📍 Joindre le centre de la carte</button></div>
      <div class="note" id="mc-retour-envoi">${esc(lectureSeule)}</div>
    </form>` : `<p class="note">${etat.admin ? 'Reliez un companion (onglet Companion) pour envoyer des messages.' : 'L’envoi est réservé aux administrateurs.'}</p>`}
    <div id="mc-messages" class="flux">${vus.length ? vus.map(mcLigneMessage).join('') : `<div class="vide">${mcFiltreMsg ? 'Aucun message dans ce choix.' : 'Aucun message pour l’instant.'}</div>`}</div>`;
  mc.canauxVus = filtreCanaux;
  if (typeof brancherBarreCanaux === 'function') brancherBarreCanaux(z.querySelector('.filtre-messages'));
  $('#mc-filtre-msg').onchange = (e) => {
    const v = e.target.value;
    // Canal Meshtastic choisi : on passe aux messages Meshtastic, sur ce canal
    if (v.startsWith('mt:')) { choisirFiltreMessages('c:' + v.slice(3)); if (typeof cliquerOnglet === 'function') { ergo.groupe = 'messages'; cliquerOnglet('messages', 'messages'); } return; }
    choisirFiltreMc(v); mcRendreMessages();
  };
  epinglerMessages(vus.map((m) => ({ texte: m.texte, heure: m.heure, qui: m.nomDe })));
  if (!peutEnvoyer) return;
  { const bp = $('#mc-btn-position'); if (bp) bp.onclick = () => { const c = carte.getCenter(); insererPosition($('#mc-texte'), c.lat, c.lng); }; }
  const ta = $('#mc-texte');
  ta.value = ancienTexte;
  const compter = () => { const n = new TextEncoder().encode(ta.value).length; $('#mc-compteur').textContent = `${n}/140`; $('#mc-compteur').classList.toggle('trop', n > 140); };
  ta.oninput = compter; compter();
  ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#mc-envoi').requestSubmit(); } };
  $('#mc-dest').onchange = async (e) => {
    if (e.target.value === 'choisir') {
      const q = (await saisir('Nom (ou début) du destinataire MeshCore :'));
      const n = q && [...mc.noeuds.values()].find((x) => (x.nom || '').toLowerCase().includes(q.toLowerCase().trim()));
      if (q && !n) alert('Aucun nœud MeshCore de ce nom sur la carte.');
      if (n) mc.destMessage = 'direct:' + n.cle;
      mcRendreMessages();
      return;
    }
    mc.destMessage = e.target.value;
    // Choisir un canal (ou un message direct) filtre aussi la liste
    const k = canaux.find((x) => 'canal:' + x.index === e.target.value);
    choisirFiltreMc(k ? 'c:' + k.nom : e.target.value.startsWith('direct:') ? 'direct' : mcFiltreMsg);
    mcRendreMessages();
  };
  $('#mc-envoi').onsubmit = async (e) => {
    e.preventDefault();
    const v = $('#mc-dest').value, texte = ta.value.trim();
    if (!texte) return;
    const b = e.target.querySelector('button[type=submit]');
    b.disabled = true; $('#mc-retour-envoi').textContent = 'Envoi…';
    try {
      const corps = v.startsWith('direct:') ? { vers: v.slice(7), texte } : { canal: Number(v.slice(6)), texte };
      const r = await postJson('/api/mc/messages', corps);
      ta.value = ''; compter();
      $('#mc-retour-envoi').textContent = corps.vers ? `Envoyé${r.inondation ? ' (en inondation : chemin pas encore connu)' : ''}, en attente de l’accusé de réception…` : 'Envoyé sur le canal.';
      mcRendreMessages();
    } catch (err) { $('#mc-retour-envoi').textContent = err.message; }
    b.disabled = false;
  };
}
const STATUTS_MSG = { envoye: '⏳ envoyé', confirme: '✔ reçu', relaye: '✔ relayé', sans_accuse: '⚠ pas d’accusé' };
// Étiquette de région portée par le message : seuls les répéteurs dont l'arbre de régions la contient le relaient
function mcTagRegion(r) {
  if (!r) return '';
  if (r === '-') return '<span class="tag-region sans" title="Inondation sans région : relayé par les répéteurs qui acceptent les messages sans région (flood.max.unscoped)">sans région</span>';
  if (r === '?') return '<span class="tag-region inconnue" title="Région inconnue de la carte (ajoutez-la à MESHCORE_REGIONS dans le .env)">🏷 région ?</span>';
  return `<span class="tag-region" title="Région « ${esc(r)} » : relayé par les répéteurs qui ont ${esc(r)} dans leur arbre de régions">🏷 ${esc(r)}</span>`;
}
function mcLigneMessage(m) {
  const qui = m.sens === 'envoye' ? `<b>${esc(m.nomDe || 'moi')}</b>${m.genre === 'direct' ? ` → ${esc(m.nomVers || mcNom(m.vers))}` : ''}` : `<b>${esc(m.nomDe || '?')}</b>${m.genre === 'direct' ? ' → moi' : ''}`;
  const lieu = m.genre === 'direct' ? 'Direct' : m.canal || '';
  const nouv = typeof msgNouveaux !== 'undefined' && msgNouveaux.has('mc' + (m.id != null ? m.id : m.heure + (m.nomDe || '')));
  return `<div class="paquet mc message-mc ${m.sens}${nouv ? ' nouveau' : ''}" ${m.genre === 'direct' && m.sens === 'recu' && m.de ? `data-mc-repondre="${m.de}"` : m.genre === 'canal' && m.indexCanal != null ? `data-mc-canal="${m.indexCanal}"` : ''}>
    <div class="entete"><span class="heure">${new Date(m.heure).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span><span class="tag canal-msg${m.genre === 'direct' ? ' direct' : ''}" ${m.genre !== 'direct' && typeof couleurCanal === 'function' ? `style="--coul:${couleurCanal(m.canal)}"` : ''}><i style="background:${m.genre === 'direct' ? MC_TYPES.message.hex : MC_TYPES.canal.hex}"></i>${esc(lieu)}</span>${nouv ? '<span class="etiquette-nouveau">nouveau</span>' : ''}${mcTagRegion(m.region)}${estRelaye(m.texte) ? '<span class="badge-passerelle" title="Relayé par une passerelle inter-réseaux">⇄ passerelle</span>' : ''}
    ${m.sauts != null ? `<span>${m.sauts === 0 ? 'direct' : m.sauts + ' saut' + (m.sauts > 1 ? 's' : '')}</span>` : ''}${m.sens === 'envoye' ? `<span class="statut-msg ${m.statut || ''}">${STATUTS_MSG[m.statut] || ''}${m.relais > 1 ? ' ×' + m.relais : ''}</span>` : ''}</div>
    <div class="corps">${qui} : <span translate="no">${texteMessageHtml(m.texte, m.sens === 'envoye' ? m.nomDe || 'moi' : m.nomDe, m.heure)}</span></div></div>`;
}

// ---- Analyse du trafic MeshCore ----------------------------------------------------------------
async function mcRendreAnalyse() {
  const z = $('#mc-contenu');
  const h = mc.heuresAnalyse || 24;
  z.innerHTML = `<div class="recherche"><select id="mc-periode">${[[1, 'Dernière heure'], [6, '6 dernières heures'], [24, '24 dernières heures'], [168, '7 jours']].map(([v, l]) => `<option value="${v}" ${v === h ? 'selected' : ''}>${l}</option>`).join('')}</select></div><div id="mc-analyse"><div class="vide">Calcul…</div></div>`;
  $('#mc-periode').onchange = (e) => { mc.heuresAnalyse = Number(e.target.value); mcRendreAnalyse(); };
  let a;
  try { a = await api('/api/mc/analyse?heures=' + h + (paramZone() ? '&zone=' + paramZone() : '')); } catch (e) { $('#mc-analyse').innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  if (mc.vue !== 'analyse' || !$('#mc-analyse')) return;
  const max = Math.max(1, ...a.parType.map((t) => t.nb));
  const maxH = Math.max(1, ...a.parHeure.map((x) => x.nb));
  const maxS = Math.max(1, ...a.sauts.map((x) => x.nb));
  $('#mc-analyse').innerHTML = `
    <div class="grille">
      <div class="mesure"><span>Paquets</span><b>${a.total}</b></div>
      <div class="mesure"><span>Temps d’antenne</span><b>${a.airtimeS} s</b></div>
      <div class="mesure"><span>Occupation</span><b>${fmt(a.occupationPct, 1, ' %')}</b></div>
    </div>
    <p class="note">${a.zone ? `Paquets entendus par les observateurs de la zone (${esc(regionChoisie() ? regionChoisie().nom : etat.config.zoneNom)}${etat.zoneMode === 'voisins' ? ' + voisins' : ''}).` : 'Tous les paquets reçus (toutes zones) : l’occupation n’a de sens que pour une zone.'} Occupation : temps d’émission cumulé des paquets distincts (SF8 · 62,5 kHz), sans compter les répétitions par les relais.</p>
    <h4>Par type</h4><div class="repartition">
    ${a.parType.map((t) => { const x = mcType(t.type); return `<div class="barre-port"><span>${esc(x.nom)}</span><div class="piste"><i style="width:${(t.nb / max) * 100}%;background:${x.hex}"></i></div><span class="nb">${t.nb}</span></div>`; }).join('') || '<div class="vide">Aucun paquet.</div>'}</div>
    <h4>Activité par heure</h4>
    <div class="histo-mc">${a.parHeure.map((x) => `<i style="height:${Math.max(4, (x.nb / maxH) * 100)}%" title="${new Date(x.h).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit' })} h : ${x.nb} paquets"></i>`).join('')}</div>
    <h4>Nombre de sauts (paquets en inondation)</h4><div class="repartition">
    ${a.sauts.map((x) => `<div class="barre-port"><span>${x.sauts === 0 ? 'direct' : x.sauts + ' saut' + (x.sauts > 1 ? 's' : '')}</span><div class="piste"><i style="width:${(x.nb / maxS) * 100}%;background:#fb923c"></i></div><span class="nb">${x.nb}</span></div>`).join('')}</div>
    <h4>Émetteurs identifiés les plus actifs</h4>
    <table class="voisins petit"><thead><tr><th>Nœud</th><th class="num">Paquets</th><th class="num">Annonces</th><th class="num">Sauts min.</th></tr></thead><tbody>
      ${a.emetteurs.map((e) => `<tr data-mc="${e.de}"><td><i class="role-mc ${e.role || 'inconnu'}" style="--mcc:${mcRole(e.role).hex}"></i>${esc(e.nom || e.de.slice(0, 8))}</td><td class="num">${e.nb}</td><td class="num">${e.annonces}</td><td class="num">${e.sauts_min ?? '–'}</td></tr>`).join('')}</tbody></table>
    <h4>Répéteurs les plus traversés</h4>
    <table class="voisins petit"><thead><tr><th>Préfixe</th><th>Répéteur(s) possible(s)</th><th class="num">Passages</th></tr></thead><tbody>
      ${a.topRelais.map((r) => `<tr ${r.candidats.length === 1 ? `data-mc="${r.candidats[0].cle}"` : ''}><td class="mono">${esc(r.prefixe)}</td><td>${r.candidats.length ? r.candidats.map((c) => esc(c.nom || c.cle.slice(0, 8))).join(' / ') : '<small>inconnu</small>'}${r.candidats.length > 1 ? ' <small>(préfixe partagé)</small>' : ''}</td><td class="num">${r.nb}</td></tr>`).join('')}</tbody></table>
    <h4>Observateurs</h4>
    <table class="voisins petit"><thead><tr><th>Observateur</th><th class="num">Réceptions</th><th class="num">SNR moy.</th><th>Dernière</th></tr></thead><tbody>
      ${a.observateurs.map((o) => `<tr data-mc="${o.observateur}"><td>${esc(o.nom || o.observateur.slice(0, 8))}</td><td class="num">${o.nb}</td><td class="num">${fmt(o.snr, 1)}</td><td>${ilYa(o.dernier)}</td></tr>`).join('')}</tbody></table>`;
  $('#mc-analyse').querySelectorAll('tr[data-mc]').forEach((tr) => (tr.onclick = () => mcOuvrirFiche(tr.dataset.mc)));
}

// ---- Gestion : administration des répéteurs et room servers (admin) ---------------------------
const mcGestion = { selection: new Set(), suivi: null, tache: null, info: null };
const MC_LPP = { tension: 'Tension', temperature: 'Température', humidite: 'Humidité', pression: 'Pression', courant: 'Courant', pourcentage: 'Charge', luminosite: 'Luminosité', altitude: 'Altitude', puissance: 'Puissance', energie: 'Énergie', concentration: 'Concentration', gps: 'Position', analogique: 'Entrée analogique', entree: 'Entrée', sortie: 'Sortie', generique: 'Capteur', presence: 'Présence', interrupteur: 'Interrupteur' };
// Dernière opération lancée (par nœud, « * » pour le panneau Programmer) : son bouton est le bouton principal
const mcDerniereAction = {};
const mcActionActive = (cle, a) => ((mcDerniereAction[cle] || 'lire') === a ? 'class="principal"' : '');
const MC_TACHES = { lire: 'Lire la configuration', statut: 'État', voisins: 'Voisins', verifier: 'Vérification de conformité', modifier: 'Modification', cli: 'Commande', annonce: 'Annonce', horloge: 'Horloge', redemarrer: 'Redémarrage', chemin: 'Chemin', tracer: 'Trace (SNR par saut)', telemetrie: 'Télémétrie', motdepasse: 'Mots de passe', regions: 'Régions', modele: 'Application d’un modèle', miseEnService: 'Mise en service' };
const MC_STATUTS = { en_attente: 'en attente', en_cours: 'en cours…', ok: 'réussi', echec: 'échec', annule: 'arrêté', reprise: 'insiste : nouvel essai prévu' };
// ---- Maintenance MeshCore : firmwares, accès administrateur, conformité automatique ---------------------
async function mcFicheMaintenance() {
  $('#fiche').hidden = false;
  etat.selection = null;
  const z = $('#fiche-contenu');
  z.innerHTML = '<h2>🛠️ Maintenance MeshCore</h2><div class="vide">Chargement…</div>';
  let r;
  try { r = await api('/api/mc/maintenance'); } catch (e) { z.innerHTML = `<h2>🛠️ Maintenance MeshCore</h2><div class="vide">${esc(e.message)}</div>`; return; }
  const v = r.versions || {}, c = r.conformite, d = c.dernier;
  const badge = (n) => n.etatFw === 'a-jour' ? '<span class="badge actif">à jour</span>' : n.etatFw === 'retard' ? `<span class="badge attente">${esc(n.derniereVersion)} disponible</span>` : '';
  const memo = r.noeuds.filter((n) => n.motDePasse);
  z.innerHTML = `<h2>🛠️ Maintenance MeshCore</h2>
    <p class="note">Dernières versions : répéteur <b>${esc(v.repeater ? v.repeater.version : '?')}</b> · room server <b>${esc(v['room-server'] ? v['room-server'].version : '?')}</b> · companion <b>${esc(v.companion ? v.companion.version : '?')}</b>. La version d’un nœud est connue après une lecture de sa configuration (mot de passe admin nécessaire). Mise à jour : en USB avec le flasheur MeshCore, ou sur place (« start ota » puis le Wi-Fi du nœud).</p>
    ${r.noeuds.map((n) => `<div class="carte-cle"><div class="ligne-cle"><b>${esc(n.nom)}</b> <small>${n.role === 'salon' ? 'room server' : 'répéteur'} · vu ${ilYa(n.dernierVu)}</small></div>
      <div class="puces-cle">${n.motDePasse ? '<span class="badge actif">🔑 mot de passe mémorisé</span>' : '<span class="badge refus">pas de mot de passe</span>'} ${n.firmware ? `<span class="badge">${esc(n.firmware)}</span> ${badge(n)}` : '<span class="badge attente">version inconnue</span>'}${n.materiel ? ` <span class="badge">${esc(n.materiel)}</span>` : ''}${n.lu ? ` <small>lu ${ilYa(n.lu)}</small>` : ''}</div>
      ${n.aFaire.length ? `<ul class="a-faire">${n.aFaire.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}</div>`).join('') || '<div class="vide">Aucun répéteur MeshCore dans la zone.</div>'}
    <h3>🌙 Conformité automatique chaque nuit</h3>
    ${etat.admin ? `<form id="f-mc-conf" class="form-gestion">
      <label>Référence <select name="reference"><option value="">—</option>${memo.map((n) => `<option value="${n.cle}" ${n.cle === c.reference ? 'selected' : ''}>${esc(n.nom)}</option>`).join('')}</select></label>
      <fieldset class="elements-verif"><legend>Réglages comparés</legend>${c.elementsPossibles.map((e) => `<label class="case"><input type="checkbox" name="el" value="${e}" ${(c.elements || c.elementsDefaut).includes(e) ? 'checked' : ''}> ${esc(e)}</label>`).join('')}</fieldset>
      <label class="case"><input type="checkbox" name="actif" ${c.actif ? 'checked' : ''}> Vérifier chaque nuit vers 3 h les répéteurs à mot de passe mémorisé (${memo.length})</label>
      <div class="actions-prop"><button type="submit" class="principal">Enregistrer</button><button type="button" id="mc-conf-maintenant">Vérifier maintenant</button></div>
      <p class="erreur" id="mc-conf-retour"></p></form>` : ''}
    ${d ? `<p>Dernière vérification le ${new Date(d.date).toLocaleString('fr-FR')} : <b>${d.conformes.length} conforme(s)</b>, ${d.ecarts.length} avec écarts, ${d.nonLus.length} non lu(s).</p>${d.ecarts.map((e) => `<div class="alerte attention">${esc(e.nom)} : ${esc(e.ecarts.map((x) => `${x.element} = ${x.valeur} au lieu de ${x.reference}`).join(' ; '))}</div>`).join('')}${d.nonLus.length ? `<p class="note">Non lus : ${esc(d.nonLus.map((x) => x.nom).join(', '))}</p>` : ''}` : '<p class="note">Pas encore de vérification automatique.</p>'}`;
  const f = $('#f-mc-conf');
  if (!f) return;
  const valeurs = () => ({ reference: f.reference.value || null, actif: f.actif.checked, elements: [...f.querySelectorAll('input[name="el"]:checked')].map((x) => x.value) });
  f.onsubmit = async (e) => { e.preventDefault(); try { await postJson('/api/mc/maintenance/conformite', valeurs()); $('#mc-conf-retour').textContent = '✔ Enregistré'; } catch (x) { $('#mc-conf-retour').textContent = x.message; } };
  $('#mc-conf-maintenant').onclick = async () => { try { await postJson('/api/mc/maintenance/conformite', { ...valeurs(), maintenant: true }); $('#mc-conf-retour').textContent = 'Vérification lancée : suivez-la dans la liste des tâches MeshCore.'; } catch (x) { $('#mc-conf-retour').textContent = x.message; } };
}

// ---- Audit des régions : déclarées (requête anonyme aux répéteurs entendus en direct) / relayées (paquets) ----
async function mcFicheAuditRegions(jours = 2) {
  $('#fiche').hidden = false; etat.selection = null; mc.selection = null;
  const z = $('#fiche-contenu');
  z.dataset.fiche = 'audit-regions';
  if (!z.querySelector('.audit-regions')) z.innerHTML = '<h2>🏷 Audit des régions</h2><div class="vide">Analyse des paquets…</div>';
  let r;
  try { r = await api(`/api/mc/audit/regions?jours=${jours}&zone=${(typeof paramZone === 'function' && paramZone()) || '1'}`); } catch (e) { z.innerHTML = `<h2>🏷 Audit des régions</h2><div class="vide">${esc(e.message)}</div>`; return; }
  if (z.dataset.fiche !== 'audit-regions') return;
  const it = r.interrogation || {};
  const tag = (x, n) => `<span class="tag-region${x === '-' ? ' sans' : x === '?' ? ' inconnue' : ''}">${x === '-' ? 'sans région' : x === '?' ? 'inconnue' : esc(x)}${n != null ? ` <b>${n}</b>` : ''}</span>`;
  const pr = Object.entries(r.parRegion || {});
  const ligne = (x) => `<div class="proposition audit-rep ${x.alertes.length ? 'attention' : ''}">
      <div class="titre-rep"><a href="#" data-mc-fiche-audit="${x.cle}">${esc(x.nom)}</a> <small>${x.role === 'salon' ? 'room server' : 'répéteur'}</small></div>
      <div class="audit-ligne"><span class="lib">Déclare</span>${x.declare ? `${x.declare.regions.map((g) => tag(g)).join(' ') || '<small>aucune région</small>'}${x.declare.joker ? ' ' + tag('-') : ''} <small>${ilYa(x.declare.heure)}</small>` : '<small>pas encore demandé (il faut l’entendre en direct)</small>'}</div>
      <div class="audit-ligne"><span class="lib">Relaie</span>${Object.entries(x.relaie).map(([g, n]) => tag(g, n)).join(' ') || '<small>rien vu passer</small>'}</div>
      ${x.alertes.map((a) => `<div class="diag attention">⚠️ ${esc(a)}</div>`).join('')}</div>`;
  z.innerHTML = `<div class="audit-regions"><h2>🏷 Audit des régions</h2>
    <div class="actions-prop">${[1, 2, 7].map((j) => `<button class="mini ${j === r.jours ? 'actif' : ''}" data-j="${j}">${j} j</button>`).join('')}
      ${etat.admin ? `<button class="mini principal" id="audit-interroger" ${it.enCours ? 'disabled' : ''}>${it.enCours ? `⏳ Demande en cours (${it.faits}/${it.total})…` : '📡 Demander leurs régions aux répéteurs entendus en direct'}</button>` : ''}</div>
    <p class="note">« Déclare » : les régions réglées sur le répéteur, qu’il annonce sans mot de passe à un companion qui l’entend en direct. « Relaie » : les étiquettes des paquets en inondation dont le chemin passe par lui, sur ${r.jours} jour(s). Un répéteur ne relaie un paquet étiqueté que si la région figure dans son arbre ; « sans région » ne passe que s’il accepte les messages sans région.</p>
    <h3>Étiquettes vues (${r.total} paquets en inondation, ${r.zone} avec région)</h3>
    <div class="audit-ligne">${pr.map(([g, n]) => tag(g, n)).join(' ') || '<small>aucun</small>'}</div>
    ${it.resultats && it.resultats.some((x) => !x.ok) && !it.enCours ? `<p class="note">Sans réponse : ${it.resultats.filter((x) => !x.ok).map((x) => esc(x.nom || x.cle.slice(0, 8))).join(', ')} (firmware trop ancien, ou pas entendu en direct à ce moment).</p>` : ''}
    <h3>Répéteurs (${r.repeteurs.length})</h3>
    ${r.repeteurs.map(ligne).join('') || '<div class="vide">Aucun répéteur de la zone vu relayer en inondation.</div>'}
    <p class="note">Calculé en ${(r.dureeMs / 1000).toFixed(1)} s ; résultat gardé 10 min.</p></div>`;
  z.querySelectorAll('[data-j]').forEach((b) => (b.onclick = () => mcFicheAuditRegions(Number(b.dataset.j))));
  z.querySelectorAll('[data-mc-fiche-audit]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); mcOuvrirFiche(a.dataset.mcFicheAudit); }));
  const bi = $('#audit-interroger');
  if (bi) bi.onclick = async () => {
    bi.disabled = true;
    try { await postJson('/api/mc/audit/interroger', {}); } catch (e) { alert(e.message); bi.disabled = false; return; }
    const suivre = async () => { if (z.dataset.fiche !== 'audit-regions') return; await mcFicheAuditRegions(jours); const x = $('#audit-interroger'); if (x && x.disabled) setTimeout(suivre, 5000); };
    setTimeout(suivre, 4000);
  };
  if (it.enCours) setTimeout(() => { if (z.dataset.fiche === 'audit-regions') mcFicheAuditRegions(jours); }, 5000);
}
// ---- Collisions d'identifiants courts entre répéteurs de la zone ----
async function mcFicheCollisions() {
  $('#fiche').hidden = false; etat.selection = null; mc.selection = null;
  const z = $('#fiche-contenu');
  z.dataset.fiche = 'collisions';
  z.innerHTML = '<h2>🔀 Collisions d’identifiants</h2><div class="vide">Calcul…</div>';
  let r;
  try { r = await api(`/api/mc/audit/collisions?zone=${(typeof paramZone === 'function' && paramZone()) || '1'}`); } catch (e) { z.innerHTML = `<h2>🔀 Collisions d’identifiants</h2><div class="vide">${esc(e.message)}</div>`; return; }
  const c = r.chemins;
  const groupe = (g, octets) => `<div class="proposition audit-rep ${!g.doublon && g.distanceMinKm != null && g.distanceMinKm < 60 ? 'attention' : ''}">
      <div class="titre-rep"><span class="mono">${esc(g.prefixe)}</span> <small>${g.doublon ? 'même lieu : sans doute <b>un seul répéteur</b> enregistré deux fois sous une clé abîmée (annonce mal reçue), pas une vraie collision' : `${g.noeuds.length} répéteurs${g.distanceMinKm != null ? ` · ${fmt(g.distanceMinKm, 1, ' km')} entre les plus proches` : ''}`}</small></div>
      ${g.noeuds.map((n) => `<div class="audit-ligne"><a href="#" data-mc-fiche-audit="${n.cle}">${esc(n.nom)}</a> <small class="mono">${esc(n.cle.slice(0, octets * 2 + 4))}…</small> <small>${ilYa(n.dernierVu)}</small></div>`).join('')}</div>`;
  z.innerHTML = `<h2>🔀 Collisions d’identifiants</h2>
    <p class="note">Dans un chemin, chaque relais n’est noté que par le début de sa clé : 1 octet (réglage d’usine), 2 ou 3 octets avec <span class="mono">set path.hash.mode 1</span> ou <span class="mono">2</span>. Deux répéteurs proches qui commencent pareil rendent le chemin ambigu : la carte ne sait plus par lequel le message est passé.</p>
    <div class="grille">
      <div class="mesure"><span>Répéteurs actifs (14 j)</span><b>${r.repeteurs}</b></div>
      <div class="mesure"><span>Collisions à 1 octet</span><b>${r.un.filter((g) => !g.doublon).length}</b></div>
      <div class="mesure"><span>Collisions à 2 octets</span><b>${r.deux.filter((g) => !g.doublon).length}</b></div>
      <div class="mesure"><span>Chemins à 1 octet</span><b>${c.partUnOctetPct == null ? '–' : fmt(c.partUnOctetPct, 0, ' %')}</b></div>
    </div>
    <p class="note">${c.total ? `Sur les paquets relayés des 2 derniers jours : ${c.parTaille[1]} chemins à 1 octet, ${c.parTaille[2]} à 2 octets, ${c.parTaille[3]} à 3 octets.` : ''} ${r.un.length ? 'Passer ces répéteurs en <span class="mono">path.hash.mode 1</span> (2 octets) lève l’ambiguïté, comme le modèle « Répéteur de base (FR-43) ».' : ''}</p>
    <h3>Même premier octet (${r.un.filter((g) => !g.doublon).length} vraie${r.un.filter((g) => !g.doublon).length > 1 ? 's' : ''}${r.un.some((g) => g.doublon) ? ` · ${r.un.filter((g) => g.doublon).length} doublon(s)` : ''})</h3>
    ${r.un.map((g) => groupe(g, 1)).join('') || '<div class="vide">Aucune collision à 1 octet dans la zone. 👍</div>'}
    ${r.deux.length ? `<h3>Mêmes deux premiers octets (${r.deux.length})</h3>${r.deux.map((g) => groupe(g, 2)).join('')}` : ''}`;
  z.querySelectorAll('[data-mc-fiche-audit]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); mcOuvrirFiche(a.dataset.mcFicheAudit); }));
}

async function mcRendreGestion() {
  const z = $('#mc-contenu');
  if (!etat.gestion) { z.innerHTML = '<div class="vide">Réservé aux administrateurs.</div>'; return; }
  try { mcGestion.info = await api('/api/mc/admin'); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  if (mc.vue !== 'gestion') return;
  const i = mcGestion.info;
  const liste = [...mc.noeuds.values()].filter((n) => (etat.admin ? ['repeteur', 'salon', 'capteur'].includes(n.role) && mcDansZone(n) : gerable(n.cle))).sort((a, b) => (a.nom || '').localeCompare(b.nom || ''));
  const sel = mcGestion.selection;
  z.innerHTML = `
    ${i.companion.connecte ? '' : '<div class="alerte attention">Aucun companion relié : l’administration passe par lui (onglet Companion).</div>'}
    <div class="actions-prop"><button class="mini" id="mc-maintenance">🛠️ Maintenance : firmwares, accès, conformité</button><button class="mini" id="mc-audit-regions" title="Régions déclarées par chaque répéteur et régions qu’il relaie vraiment">🏷 Audit des régions</button><button class="mini" id="mc-collisions" title="Répéteurs dont la clé commence par le même octet : chemins ambigus">🔀 Collisions d’identifiants</button></div>
    <p class="note">Cochez les nœuds, puis choisissez l’opération. Il faut le <b>mot de passe admin</b> de chaque nœud (mémorisable sur le serveur). Pour une vérification, le <b>premier coché</b> sert de référence.</p>
    <div class="liste liste-mc-gestion">${liste.map((n) => `<label class="ligne-coche"><input type="checkbox" data-mc-sel="${n.cle}" ${sel.has(n.cle) ? 'checked' : ''}>
      <span class="point ${n.statut}"></span><span class="titre"><i class="role-mc ${n.role}" style="--mcc:${mcRole(n.role).hex}"></i>${esc(n.nom || n.id)}
      ${i.memorises.includes(n.cle) ? '<small title="mot de passe mémorisé">🔑</small>' : ''}${i.lectures[n.cle] ? `<small>lu ${ilYa(i.lectures[n.cle].heure)}</small>` : ''}</span>
      <button class="mini" data-mc-fiche="${n.cle}" title="Fiche et administration">›</button></label>`).join('') || '<div class="vide">Aucun répéteur MeshCore connu.</div>'}</div>
    <div class="actions-prop"><button data-mc-tout>Tout cocher</button><button data-mc-rien>Rien</button><span class="note">${sel.size} coché(s)</span></div>
    <form id="mc-f-gestion" class="form-edit">
      <div class="grille-edit">
        <label>Mot de passe admin <input name="mdp" type="password" autocomplete="off" placeholder="vide = mots de passe mémorisés"></label>
        <label class="case"><input type="checkbox" name="memoriser"> Mémoriser sur le serveur</label>
      </div>
      <label class="case"><input type="checkbox" name="insister"> Insister en cas d’échec : nouvel essai toutes les 10 min pendant 2 h</label>
      <details class="elements-mc"><summary>Lecture ciblée : seulement ces réglages</summary>
        ${i.params.map((p) => `<label class="case"><input type="checkbox" name="lc" value="${p.cle}"> ${esc(p.nom)}</label>`).join('')}
        <p class="note">Rien de coché : « Lire la configuration » relit tout (réglages, informations, état et voisins).</p>
      </details>
      <details class="elements-mc"><summary>Éléments comparés par la vérification</summary>
        ${i.elements.map((e) => `<label class="case"><input type="checkbox" name="el" value="${e}" ${i.elementsDefaut.includes(e) ? 'checked' : ''}> ${esc((i.params.find((p) => p.cle === e) || {}).nom || e)}</label>`).join('')}
      </details>
      <div class="actions-prop">
        <button type="button" data-mc-op="lire" ${mcActionActive('*', 'lire')}>Lire la configuration</button>
        <button type="button" data-mc-op="statut" ${mcActionActive('*', 'statut')}>État</button>
        <button type="button" data-mc-op="voisins" ${mcActionActive('*', 'voisins')}>Voisins</button>
        <button type="button" data-mc-op="verifier" ${mcActionActive('*', 'verifier')}>Vérifier la conformité</button>
        <button type="button" data-mc-op="horloge" ${mcActionActive('*', 'horloge')}>Mettre à l’heure</button>
        <button type="button" data-mc-op="annonce" ${mcActionActive('*', 'annonce')}>Annonce</button>
        <button type="button" data-mc-op="tracer" ${mcActionActive('*', 'tracer')} title="Aller-retour le long du chemin, avec le SNR de chaque saut (sans mot de passe)">Tracer</button>
        <button type="button" data-mc-op="telemetrie" ${mcActionActive('*', 'telemetrie')} title="Batterie, température, capteurs (selon les droits du nœud)">Télémétrie</button>
        <button type="button" data-mc-outil-adm="motdepasse" title="Changer le mot de passe admin ou invité">🔑 Mots de passe…</button>
        <button type="button" data-mc-outil-adm="regions" title="Régions (zones d’inondation) : lire, créer, autoriser, bloquer, attache">🗺️ Régions…</button>
        <button type="button" data-mc-outil-adm="modeles" title="Réglages types appliqués à plusieurs répéteurs">📋 Modèles…</button>
      </div>
      <p class="erreur" id="mc-g-retour"></p>
    </form>
    <div id="mc-g-outil"></div>
    <div id="mc-g-tache"></div>
    <h4>Dernières opérations</h4>
    <div class="liste">${i.taches.map((t) => `<div class="ligne" data-mc-tache="${t.id}"><span class="point ${t.statut === 'ok' ? 'actif' : t.statut === 'en_cours' || t.statut === 'en_attente' ? 'recent' : 'alerte'}"></span><span class="titre">${esc(MC_TACHES[t.type] || t.type)}<small>${t.cles.map((k) => esc(t.noms[k] || k.slice(0, 6))).join(', ')}${t.reprises ? ' · reprise après redémarrage' : ''}</small></span><span class="meta">${MC_STATUTS[t.statut]} · ${ilYa(t.creee)}</span></div>`).join('') || '<div class="vide">Aucune.</div>'}</div>`;
  z.querySelectorAll('[data-mc-sel]').forEach((c) => (c.onchange = () => { if (c.checked) sel.add(c.dataset.mcSel); else sel.delete(c.dataset.mcSel); z.querySelector('.actions-prop .note').textContent = `${sel.size} coché(s)`; }));
  z.querySelector('[data-mc-tout]').onclick = () => { liste.forEach((n) => sel.add(n.cle)); mcRendreGestion(); };
  z.querySelector('[data-mc-rien]').onclick = () => { sel.clear(); mcRendreGestion(); };
  z.querySelectorAll('[data-mc-fiche]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); mcOuvrirFiche(b.dataset.mcFiche, 'admin'); }));
  { const bm = $('#mc-maintenance'); if (bm) bm.onclick = mcFicheMaintenance; }
  { const b1 = $('#mc-audit-regions'); if (b1) b1.onclick = () => mcFicheAuditRegions(); }
  { const b2 = $('#mc-collisions'); if (b2) b2.onclick = () => mcFicheCollisions(); }
  z.querySelectorAll('[data-mc-tache]').forEach((l) => (l.onclick = () => mcSuivreTache(l.dataset.mcTache, $('#mc-g-tache'))));
  z.querySelectorAll('[data-mc-op]').forEach((b) => (b.onclick = async () => {
    const f = $('#mc-f-gestion');
    const type = b.dataset.mcOp;
    mcDerniereAction['*'] = type; z.querySelectorAll('[data-mc-op].principal').forEach((x) => x.classList.remove('principal')); b.classList.add('principal');
    if (!sel.size) { $('#mc-g-retour').textContent = 'Cochez au moins un nœud.'; return; }
    const ordre = [...sel];
    const params = { motDePasse: f.mdp.value || undefined, memoriser: f.memoriser.checked, insister: f.insister.checked, elements: [...f.querySelectorAll('[name=el]:checked')].map((x) => x.value) };
    const lc = [...f.querySelectorAll('[name=lc]:checked')].map((x) => x.value);
    if (type === 'lire' && lc.length) params.cles = lc;
    if (type === 'annonce') params.inondation = (await confirmer('Annonce relayée par tout le réseau ?\nOK = tout le réseau · Annuler = voisins directs seulement'));
    try {
      const t = await postJson('/api/mc/admin/taches', { type, cles: ordre, params });
      f.mdp.value = '';
      mcSuivreTache(t.id, $('#mc-g-tache'));
    } catch (err) { $('#mc-g-retour').textContent = err.message; }
  }));
  z.querySelectorAll('[data-mc-outil-adm]').forEach((b) => (b.onclick = () => {
    if (!sel.size && b.dataset.mcOutilAdm !== 'modeles') { $('#mc-g-retour').textContent = 'Cochez au moins un nœud.'; return; }
    const f = $('#mc-f-gestion');
    mcOutilAdmin(b.dataset.mcOutilAdm, [...sel], $('#mc-g-outil'), { mdp: () => f.mdp.value, memoriser: () => f.memoriser.checked, insister: () => f.insister.checked, viderMdp: () => { f.mdp.value = ''; }, zoneTache: $('#mc-g-tache') });
  }));
  if (mcGestion.tache) mcSuivreTache(mcGestion.tache, $('#mc-g-tache'));
}

// « put nom [parent] », « def a b c », « default <null> »… : une action de région par ligne
function mcLireActionsRegions(texte) {
  return String(texte || '').split('\n').map((l) => l.trim().replace(/^region\s+/i, '')).filter((l) => l && !l.startsWith('#')).map((l) => {
    const [op, ...reste] = l.split(/\s+/);
    const o = (op || '').toLowerCase();
    if (o === 'def') return { op: o, nom: reste.join(' ') };
    return { op: o, nom: reste[0], parent: reste[1] };
  }).filter((a) => a.op && a.op !== 'save');
}
// ---- Mots de passe, régions, modèles : formulaires communs à « Programmer » et à la fiche d'un répéteur ----------
async function mcOutilAdmin(type, cles, zone, ctx) {
  const noms = cles.map((c) => { const n = mc.noeuds.get(c); return n ? n.nom || c.slice(0, 8) : c.slice(0, 8); });
  const lancer = async (t, params) => {
    try {
      const r = await postJson('/api/mc/admin/taches', { type: t, cles, params: { ...params, motDePasse: ctx.mdp() || undefined, memoriser: ctx.memoriser(), insister: ctx.insister() } });
      ctx.viderMdp(); zone.innerHTML = '';
      mcSuivreTache(r.id, ctx.zoneTache, ctx.apres);
    } catch (e) { const x = zone.querySelector('.erreur'); if (x) x.textContent = e.message; }
  };
  const pied = '<p class="erreur"></p>';
  if (type === 'motdepasse') {
    zone.innerHTML = `<form class="form-edit outil-mc"><h4>🔑 Mots de passe · ${esc(noms.join(', '))}</h4>
      <p class="note">Le mot de passe admin actuel est celui du formulaire ci-dessus (ou celui mémorisé). Les nouveaux ne sont jamais enregistrés dans l’historique des opérations ; s’il était mémorisé, la carte mémorise le nouveau.</p>
      <div class="grille-edit">
        <label>Nouveau mot de passe admin <input name="admin" type="password" autocomplete="new-password" maxlength="15"></label>
        <label>Confirmation <input name="admin2" type="password" autocomplete="new-password" maxlength="15"></label>
        <label>Nouveau mot de passe invité <input name="invite" type="password" autocomplete="new-password" maxlength="15"></label>
        <label class="case"><input type="checkbox" name="inviteVide"> Retirer le mot de passe invité (accès invité libre)</label>
      </div>
      <div class="actions-prop"><button class="principal">Changer</button><button type="button" data-fermer>Annuler</button></div>${pied}</form>`;
    const f = zone.querySelector('form');
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (f.admin.value !== f.admin2.value) { f.querySelector('.erreur').textContent = 'Les deux mots de passe admin sont différents.'; return; }
      if (f.admin.value && !(await confirmer(`Changer le mot de passe admin de ${noms.length} nœud(s) ?
Notez-le : sans lui, il faudra repasser par l’USB.`))) return;
      lancer('motdepasse', { admin: f.admin.value || undefined, invite: f.invite.value || undefined, inviteVide: f.inviteVide.checked && !f.invite.value });
    };
  } else if (type === 'regions') {
    let lu = null;
    if (cles.length === 1) { try { lu = (await api('/api/mc/admin/lecture/' + cles[0])).lecture; } catch { /* aucune */ } }
    const rg = lu && lu.regions;
    zone.innerHTML = `<form class="form-edit outil-mc"><h4>🗺️ Régions · ${esc(noms.join(', '))}</h4>
      ${rg ? `<p class="note">Lu ${ilYa(rg.heure)} · attache : <b>${esc(rg.home || '?')}</b> · envois limités à : <b>${esc(rg.defaut || '?')}</b></p><pre class="cli-mc">${esc(rg.arbre || '(aucune région)')}</pre>` : '<p class="note">Régions jamais lues sur ce nœud : « Lire » d’abord.</p>'}
      <p class="note">Une action par ligne (firmware répéteur 1.10 et plus) :<br>
        <span class="mono">put haute-loire</span> créer (parent facultatif : <span class="mono">put lpy haute-loire</span>) ·
        <span class="mono">allowf haute-loire</span> / <span class="mono">denyf haute-loire</span> relayer ou bloquer ses inondations (<span class="mono">*</span> = paquets sans région) ·
        <span class="mono">home haute-loire</span> région d’attache · <span class="mono">default haute-loire</span> limiter ses propres envois (<span class="mono">default &lt;null&gt;</span> pour retirer) ·
        <span class="mono">remove nom</span> supprimer · <span class="mono">def eu fr fr-ara fr-43</span> créer un arbre en une ligne. Les changements sont enregistrés (<span class="mono">region save</span>) puis relus.</p>
      <textarea name="actions" rows="4" placeholder="put haute-loire&#10;allowf haute-loire&#10;home haute-loire"></textarea>
      <div class="actions-prop"><button class="principal">Appliquer et relire</button><button type="button" data-lire>Lire seulement</button><button type="button" data-fermer>Annuler</button></div>${pied}</form>`;
    const f = zone.querySelector('form');
    const actions = () => mcLireActionsRegions(f.actions.value);
    f.querySelector('[data-lire]').onclick = () => lancer('regions', { actions: [] });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const a = actions();
      if (!a.length) return lancer('regions', { actions: [] });
      if (!(await confirmer(`Appliquer à ${noms.length} nœud(s) :\n${a.map((x) => `• region ${x.op} ${x.nom}${x.parent ? ' ' + x.parent : ''}`).join('\n')}\n\nUne région bloquée (denyf) ne sera plus relayée par ces répéteurs.`))) return;
      lancer('regions', { actions: a });
    };
  } else if (type === 'service') {
    let l = [];
    try { l = await api('/api/mc/admin/modeles'); } catch { /* aucun */ }
    const n = mc.noeuds.get(cles[0]) || {};
    let lu = null;
    try { lu = (await api('/api/mc/admin/lecture/' + cles[0])).lecture; } catch { /* aucune */ }
    const v = (lu && lu.valeurs) || {};
    zone.innerHTML = `<form class="form-edit outil-mc"><h4>🚀 Mise en service · ${esc(noms[0])}</h4>
      <p class="note">Applique un modèle, l’identification du répéteur et un nouveau mot de passe admin en une seule opération, puis met à l’heure (et redémarre si le modèle le prévoit).</p>
      <div class="grille-edit">
        <label>Modèle <select name="modele"><option value="">(aucun : identification seulement)</option>${l.map((m) => `<option value="${m.id}">${esc(m.nom)}</option>`).join('')}</select></label>
        <label>Nom <input name="name" maxlength="31" value="${esc(v.name || n.nom || '')}" placeholder="ex. FR43PYVE_Rep"></label>
        <label>Latitude <input name="lat" inputmode="decimal" value="${esc(v.lat || (n.lat != null ? n.lat.toFixed(6) : ''))}"></label>
        <label>Longitude <input name="lon" inputmode="decimal" value="${esc(v.lon || (n.lon != null ? n.lon.toFixed(6) : ''))}"></label>
        <label style="grid-column:1/-1">Contact (infos propriétaire) <input name="owner" maxlength="120" value="${esc(v['owner.info'] || '')}" placeholder="E-Mail|Telegram|INDICATIF"></label>
        <label>Nouveau mot de passe admin <input name="admin" type="password" autocomplete="new-password" maxlength="15" placeholder="vide = inchangé"></label>
        <label>Confirmation <input name="admin2" type="password" autocomplete="new-password" maxlength="15"></label>
      </div>
      <div class="actions-prop"><button class="principal">Mettre en service</button><button type="button" data-fermer>Annuler</button></div>${pied}</form>`;
    const f = zone.querySelector('form');
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (f.admin.value !== f.admin2.value) { f.querySelector('.erreur').textContent = 'Les deux mots de passe sont différents.'; return; }
      const m = l.find((x) => x.id === f.modele.value);
      const identite = { name: f.name.value.trim(), lat: f.lat.value.trim(), lon: f.lon.value.trim(), 'owner.info': f.owner.value.trim() };
      if (!(await confirmer(`Mettre en service « ${noms[0]} » ?${m ? `\n• modèle « ${m.nom} »${m.redemarrer ? ' (redémarrage à la fin)' : ''}` : ''}\n• nom ${identite.name || 'inchangé'}, position ${identite.lat && identite.lon ? identite.lat + ', ' + identite.lon : 'inchangée'}${f.admin.value ? '\n• nouveau mot de passe admin : notez-le' : ''}`))) return;
      lancer('miseEnService', { modele: f.modele.value || undefined, identite, admin: f.admin.value || undefined });
    };
  } else if (type === 'modeles') {
    let l = [], info = mcGestion.info;
    try { l = await api('/api/mc/admin/modeles'); if (!info) info = mcGestion.info = await api('/api/mc/admin'); } catch (e) { zone.innerHTML = `<p class="erreur">${esc(e.message)}</p>`; return; }
    const lib = (k) => (info.params.find((p) => p.cle === k) || {}).nom || k;
    let source = null;
    if (cles.length === 1) { try { source = (await api('/api/mc/admin/lecture/' + cles[0])).lecture; } catch { /* aucune */ } }
    zone.innerHTML = `<div class="outil-mc"><h4>📋 Modèles de réglages</h4>
      ${l.length ? l.map((m) => `<div class="proposition"><b>${esc(m.nom)}</b>${m.description ? `<div class="note">${esc(m.description)}</div>` : ''}<div class="meta-longue">${Object.entries(m.valeurs).map(([k, v]) => `${esc(lib(k))} = <b>${esc(v)}</b>`).join(' · ')}</div>
        ${(m.regions || []).length ? `<div class="meta-longue">Régions : ${m.regions.map((a) => `<span class="mono">region ${esc(a.op)} ${esc(a.nom)}${a.parent ? ' ' + esc(a.parent) : ''}</span>`).join(' · ')}</div>` : ''}
        <div class="meta-longue">${m.horloge !== false ? 'mise à l’heure' : ''}${m.redemarrer ? ' · redémarrage à la fin' : ''}</div>
        <div class="actions-prop">${cles.length ? `<button class="mini principal" data-appliquer="${m.id}">Appliquer à ${cles.length} nœud(s)</button>` : ''}<button class="mini" data-supprimer="${m.id}">Supprimer</button></div></div>`).join('') : '<div class="vide">Aucun modèle.</div>'}
      <form class="form-edit"><h4>Nouveau modèle${source && source.valeurs ? ` <small>(prérempli avec ${esc(noms[0])})</small>` : ''}</h4>
        <div class="grille-edit"><label>Nom <input name="nom" required maxlength="40" placeholder="ex. Répéteur point haut"></label><label>Description <input name="description" maxlength="200"></label></div>
        <div class="grille-edit reglages-modele">${info.params.filter((p) => !['name', 'lat', 'lon', 'owner.info'].includes(p.cle)).map((p) => `<label>${esc(p.nom)}${p.redemarrage ? ' <small>(redémarrage)</small>' : ''} <input name="${p.cle}" value="${esc(source && source.valeurs && source.valeurs[p.cle] != null ? source.valeurs[p.cle] : '')}" placeholder="non inclus"></label>`).join('')}</div>
        <label>Régions (une action par ligne, facultatif)<textarea name="regions" rows="3" placeholder="def eu fr fr-ara fr-43&#10;default fr&#10;home fr"></textarea></label>
        <label class="case"><input type="checkbox" name="horloge" checked> Mettre à l’heure</label>
        <label class="case"><input type="checkbox" name="redemarrer"> Redémarrer à la fin (nécessaire pour certains réglages)</label>
        <p class="note">Laissez vide ce qui ne doit pas être changé. Nom, position, infos propriétaire et mot de passe ne font jamais partie d’un modèle : ils se règlent avec « Mise en service ».</p>
        <div class="actions-prop"><button class="principal">Enregistrer le modèle</button><button type="button" data-fermer>Fermer</button></div>${pied}</form></div>`;
    zone.querySelectorAll('[data-appliquer]').forEach((b) => (b.onclick = async () => {
      const m = l.find((x) => x.id === b.dataset.appliquer);
      if (!(await confirmer(`Appliquer « ${m.nom} » à ${noms.join(', ')} ?\n${Object.entries(m.valeurs).map(([k, v]) => `• ${lib(k)} = ${v}`).join('\n')}${(m.regions || []).map((a) => `\n• region ${a.op} ${a.nom}`).join('')}${m.redemarrer ? '\n• redémarrage à la fin' : ''}${m.valeurs.radio ? '\n\n⚠ Changer la radio d’un nœud distant peut le rendre injoignable.' : ''}`))) return;
      lancer('modele', { modele: m.id });
    }));
    zone.querySelectorAll('[data-supprimer]').forEach((b) => (b.onclick = async () => { if (!(await confirmer('Supprimer ce modèle ?'))) return; await api('/api/mc/admin/modeles/' + b.dataset.supprimer, { method: 'DELETE' }); mcOutilAdmin('modeles', cles, zone, ctx); }));
    const f = zone.querySelector('form');
    f.onsubmit = async (e) => {
      e.preventDefault();
      const valeurs = {};
      f.querySelectorAll('.reglages-modele input').forEach((x) => { if (x.value.trim()) valeurs[x.name] = x.value.trim(); });
      try { await postJson('/api/mc/admin/modeles', { nom: f.nom.value, description: f.description.value, valeurs, regions: mcLireActionsRegions(f.regions.value), horloge: f.horloge.checked, redemarrer: f.redemarrer.checked }); mcOutilAdmin('modeles', cles, zone, ctx); } catch (x) { f.querySelector('.erreur').textContent = x.message; }
    };
  }
  zone.querySelectorAll('[data-fermer]').forEach((b) => (b.onclick = () => { zone.innerHTML = ''; }));
}

// Suivi en direct d'une tâche (étapes, résultats, rapport de conformité)
function mcSuivreTache(id, zone, apres) {
  mcGestion.tache = id;
  clearInterval(mcGestion.suivi);
  const tour = async () => {
    if (!zone.isConnected) { clearInterval(mcGestion.suivi); return; }
    let t;
    try { t = await api('/api/mc/admin/taches/' + id); } catch { clearInterval(mcGestion.suivi); return; }
    zone.innerHTML = mcHtmlTache(t);
    const st = zone.querySelector('[data-mc-arreter]');
    if (st) st.onclick = () => postJson(`/api/mc/admin/taches/${id}/arreter`).catch(() => {});
    zone.querySelectorAll('[data-mc-aligner]').forEach((b) => (b.onclick = () => mcAligner(t, b.dataset.mcAligner, zone)));
    const j = zone.querySelector('.journal-mc'); if (j) j.scrollTop = j.scrollHeight;
    if (!['en_cours', 'en_attente', 'reprise'].includes(t.statut)) { clearInterval(mcGestion.suivi); if (apres) apres(t); }
  };
  tour();
  mcGestion.suivi = setInterval(tour, 1500);
}
function mcHtmlTache(t) {
  const enCours = ['en_cours', 'en_attente', 'reprise'].includes(t.statut);
  const r = t.rapport;
  const hm = (x) => new Date(x).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const res = t.resultats || {};
  return `<div class="tache-mc ${t.statut}">
    <div class="titre-tache"><b>${esc(MC_TACHES[t.type] || t.type)}</b> · ${MC_STATUTS[t.statut] || t.statut}${t.prochainEssai ? ` à ${hm(t.prochainEssai)}` : ''}${t.insister && t.statut !== 'reprise' ? ' · insiste 2 h' : ''}${t.courant ? ` · ${esc(t.noms[t.courant] || '')}` : ''}${enCours ? ' <span class="sablier"></span> <button class="mini" data-mc-arreter>Arrêter</button>' : ''}</div>
    ${t.cles.length > 1 || Object.keys(res).length ? `<div class="noeuds-tache-mc">${t.cles.map((c) => { const x = res[c]; return `<div class="${x ? (x.ok ? 'ok' : 'ko') : ''}"><span>${esc(t.noms[c] || c.slice(0, 8))}</span><span>${!x ? (t.courant === c ? 'en cours…' : 'en attente') : x.ok ? '✔ réussi' : '✗ ' + esc(x.erreur || 'échec')}${x && x.heure ? ` <small>à ${hm(x.heure)}</small>` : ''}${x && x.echecs > 1 ? ` <small>(${x.echecs} échecs)</small>` : ''}</span></div>`; }).join('')}</div>` : ''}
    ${r ? `<table class="voisins petit"><thead><tr><th>Nœud</th><th>Résultat</th></tr></thead><tbody>
      <tr><td><b>${esc(t.noms[r.reference] || '')}</b></td><td>référence</td></tr>
      ${r.noeuds.map((x) => `<tr><td>${esc(x.nom || x.cle.slice(0, 8))}</td><td>${!x.lu ? `<span class="ko">non lu : ${esc(x.erreur)}</span>` : x.conforme ? '<span class="ok">✔ conforme</span>' : `${x.ecarts.map((e) => `<div><b>${esc(e.element)}</b> : ${esc(e.valeur)} <small>(réf. ${esc(e.reference)})</small></div>`).join('')}<button class="mini" data-mc-aligner="${x.cle}">Aligner sur la référence</button>`}</td></tr>`).join('')}
    </tbody></table>` : ''}
    <div class="journal-mc">${t.etapes.map((e) => `<div class="${e.ok ? '' : 'ko'}"><span class="heure">${heure(e.heure)}</span> ${e.cle ? `<b>${esc((t.noms[e.cle] || e.cle.slice(0, 6)).slice(0, 18))}</b> ` : ''}${esc(e.texte).replace(/\n/g, '<br>')}</div>`).join('')}</div>
  </div>`;
}
async function mcAligner(t, cle, zone) {
  const x = t.rapport.noeuds.find((n) => n.cle === cle);
  if (!x) return;
  const valeurs = Object.fromEntries(x.ecarts.map((e) => [e.element, e.reference]));
  const radio = valeurs.radio !== undefined;
  if (!(await confirmer(`Appliquer à « ${x.nom} » :\n${Object.entries(valeurs).map(([k, v]) => `• ${k} = ${v}`).join('\n')}${radio ? '\n\n⚠ Changer la radio d’un nœud distant peut le rendre injoignable s’il ne parle plus comme les autres. Un redémarrage sera nécessaire.' : ''}`))) return;
  try { const n = await postJson('/api/mc/admin/taches', { type: 'modifier', cles: [cle], params: { valeurs } }); mcSuivreTache(n.id, zone); } catch (e) { alert(e.message); }
}

// Panneau d'administration dans la fiche d'un répéteur / room server
async function mcRendreAdminFiche(n, z) {
  let l;
  try { l = await api('/api/mc/admin/lecture/' + n.cle); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  const info = mcGestion.info || await api('/api/mc/admin').catch(() => null);
  mcGestion.info = info;
  const lu = l.lecture || {}, v = lu.valeurs || {}, inf = lu.infos || {}, st = lu.statut;
  const champ = (p) => {
    const val = v[p.cle] ?? '';
    const attrs = `name="${p.cle}" data-initial="${esc(val)}"`;
    if (p.type === 'onoff') return `<select ${attrs}>${['on', 'off'].map((o) => `<option ${val === o ? 'selected' : ''}>${o}</option>`).join('')}${val ? '' : '<option value="" selected>?</option>'}</select>`;
    if (p.type === 'liste') return `<select ${attrs}>${p.valeurs.map(([o, lib]) => `<option value="${o}" ${val === o ? 'selected' : ''}>${esc(lib)}</option>`).join('')}${val ? '' : '<option value="" selected>?</option>'}</select>`;
    return `<input ${attrs} value="${esc(val)}" ${p.type === 'nombre' ? `inputmode="decimal"` : ''} placeholder="${val ? '' : 'non lu'}">`;
  };
  z.innerHTML = `
    <form id="mc-f-adm" class="form-edit">
      <div class="grille-edit">
        <label>Mot de passe admin <input name="mdp" type="password" autocomplete="off" placeholder="${l.memorise ? '🔑 mémorisé (laisser vide)' : 'mot de passe du nœud'}"></label>
        <label class="case"><input type="checkbox" name="memoriser" ${l.memorise ? 'checked' : ''}> Mémoriser sur le serveur</label>
        <label class="case"><input type="checkbox" name="insister"> Insister 2 h en cas d’échec</label>
      </div>
      <div class="actions-prop">
        <button type="button" data-a="lire" ${mcActionActive(n.cle, 'lire')}>Lire la configuration</button><button type="button" data-a="statut" ${mcActionActive(n.cle, 'statut')}>État</button><button type="button" data-a="voisins" ${mcActionActive(n.cle, 'voisins')}>Voisins</button>
        <button type="button" data-a="horloge" ${mcActionActive(n.cle, 'horloge')}>Mettre à l’heure</button><button type="button" data-a="annonce" ${mcActionActive(n.cle, 'annonce')}>Annonce</button><button type="button" data-a="redemarrer" ${mcActionActive(n.cle, 'redemarrer')}>Redémarrer</button>
        <button type="button" data-a="tracer" ${mcActionActive(n.cle, 'tracer')} title="Aller-retour le long du chemin, SNR de chaque saut (sans mot de passe)">Tracer</button><button type="button" data-a="telemetrie" ${mcActionActive(n.cle, 'telemetrie')} title="Batterie, température, capteurs">Télémétrie</button>
        <button type="button" data-a="service" title="Modèle, nom, position, contact et mot de passe en une seule opération">🚀 Mise en service…</button><button type="button" data-a="motdepasse">🔑 Mots de passe…</button><button type="button" data-a="regions">🗺️ Régions…</button><button type="button" data-a="modeles">📋 Modèles…</button>
        ${l.memorise ? '<button type="button" data-a="oublier">Oublier le mot de passe</button>' : ''}
      </div>
      ${lu.heure ? `<p class="note">Configuration lue ${ilYa(lu.heure)}${inf.version ? ` · ${esc(inf.version)}` : ''}${inf.carte ? ` · ${esc(inf.carte)}` : ''}</p>` : '<p class="note">Configuration jamais lue : commencez par « Lire la configuration ».</p>'}
      ${inf.regionMaison && !/unknown|err|\?/i.test(inf.regionMaison) ? `<p class="note">Région d’attache : <b>${esc(inf.regionMaison)}</b>${inf.regionDefaut && !/unknown|err|\?/i.test(inf.regionDefaut) ? ` · envois limités à : <b>${esc(inf.regionDefaut)}</b>` : ''}</p>` : ''}
      ${lu.regions ? `<h4>Régions <small>${ilYa(lu.regions.heure)}</small></h4><p class="note">attache : <b>${esc(lu.regions.home || '?')}</b> · envois limités à : <b>${esc(lu.regions.defaut || '?')}</b></p><pre class="cli-mc">${esc(lu.regions.arbre || '(aucune)')}</pre>` : ''}
      ${lu.trace ? `<h4>Dernière trace <small>${ilYa(lu.trace.heure)}</small></h4><div class="trace-mc">${lu.trace.sauts.map((x, i) => `${i === 0 ? `<span>${esc(x.de.nom || '?')}</span>` : ''}<span class="saut-mc" style="color:${couleurSnr(x.snr)}">─ ${fmt(x.snr, 1)} dB →</span><span>${esc(x.vers.nom || x.vers.prefixe || '?')}</span>`).join('')}</div>` : ''}
      ${lu.telemetrie ? `<h4>Télémétrie <small>${ilYa(lu.telemetrie.heure)}</small></h4><div class="grille">${lu.telemetrie.mesures.map((m) => `<div class="mesure"><span>${esc(MC_LPP[m.type] || m.type)}${m.canal > 1 ? ' · ' + m.canal : ''}</span><b>${typeof m.valeur === 'number' ? fmt(m.valeur, m.unite === 'V' ? 2 : 1) : esc(JSON.stringify(m.valeur))} ${esc(m.unite)}</b></div>`).join('') || '<div class="vide">Aucune mesure.</div>'}</div>` : ''}
      ${st ? `<div class="grille">
        <div class="mesure"><span>Batterie</span><b>${fmt(st.batterieMv / 1000, 2, ' V')}</b></div>
        <div class="mesure"><span>Bruit de fond</span><b>${st.bruitDbm} dBm</b></div>
        <div class="mesure"><span>Émission</span><b>${fmt(st.occupationEmissionPct, 1, ' %')}</b></div>
        <div class="mesure"><span>Allumé depuis</span><b>${duree(st.allumeS)}</b></div>
        <div class="mesure"><span>Reçus · émis</span><b>${st.recus} · ${st.emis}</b></div>
        <div class="mesure"><span>Dernier SNR</span><b>${fmt(st.dernierSnr, 1, ' dB')}</b></div>
      </div><p class="note">État lu ${ilYa(st.heure)} · ${st.doublonsInondation ?? 0} doublons · ${st.erreurs ?? 0} erreurs</p>` : ''}
      <h4>Réglages</h4>
      <div class="grille-edit reglages-mc">${(info ? info.params : []).map((p) => `<label>${esc(p.nom)}${p.redemarrage ? ' <small>(redémarrage)</small>' : ''} ${champ(p)}</label>`).join('')}</div>
      <div class="actions-prop"><button type="button" data-a="appliquer" class="principal">Appliquer les changements</button></div>
      ${lu.voisins ? `<h4>Voisins déclarés (${lu.voisins.length})</h4><table class="voisins petit"><thead><tr><th>Nœud</th><th class="num">SNR</th><th class="num">km</th><th>Entendu</th></tr></thead><tbody>
        ${lu.voisins.map((x) => `<tr ${x.cle ? `data-mc="${x.cle}"` : ''}><td>${esc(x.nom || x.prefixe)}</td><td class="num" style="color:${couleurSnr(x.snr)}">${fmt(x.snr, 1)}</td><td class="num">${x.distanceKm != null ? fmt(x.distanceKm, 1) : '–'}</td><td>${x.vu ? ilYa(x.vu) : '–'}</td></tr>`).join('')}</tbody></table>` : ''}
      <h4>Console</h4>
      <div class="envoi-ligne"><input name="cli" placeholder="commande CLI, ex. get radio, neighbors, clock" autocomplete="off"><button type="button" data-a="cli">Envoyer</button></div>
      <p class="erreur" id="mc-adm-retour"></p>
    </form>
    <div id="mc-adm-outil"></div>
    <div id="mc-adm-tache"></div>`;
  const f = $('#mc-f-adm');
  const lancer = async (type, params = {}) => {
    try {
      const t = await postJson('/api/mc/admin/taches', { type, cles: [n.cle], params: { ...params, motDePasse: f.mdp.value || undefined, memoriser: f.memoriser.checked, insister: f.insister.checked } });
      f.mdp.value = '';
      $('#mc-adm-retour').textContent = '';
      mcSuivreTache(t.id, $('#mc-adm-tache'), (fin) => { if (['lire', 'statut', 'voisins', 'modifier', 'tracer', 'telemetrie'].includes(fin.type) && mc.selection === n.cle) mcRendreAdminFiche(n, z).then(() => { const zt = $('#mc-adm-tache'); if (zt) zt.innerHTML = mcHtmlTache(fin); }); });
    } catch (e) { $('#mc-adm-retour').textContent = e.message; }
  };
  f.querySelectorAll('[data-a]').forEach((b) => (b.onclick = async () => {
    const a = b.dataset.a;
    // Le bouton de la dernière opération lancée devient le bouton principal (vert), celui qu'on relance d'un clic
    if (!['oublier', 'motdepasse', 'regions', 'modeles', 'service'].includes(a)) { mcDerniereAction[n.cle] = a; f.querySelectorAll('[data-a].principal').forEach((x) => x.classList.remove('principal')); b.classList.add('principal'); }
    if (a === 'oublier') { await postJson('/api/mc/admin/mot-de-passe', { cle: n.cle, motDePasse: null }); mcRendreAdminFiche(n, z); return; }
    if (['motdepasse', 'regions', 'modeles', 'service'].includes(a)) {
      return mcOutilAdmin(a, [n.cle], $('#mc-adm-outil'), { mdp: () => f.mdp.value, memoriser: () => f.memoriser.checked, insister: () => f.insister.checked, viderMdp: () => { f.mdp.value = ''; }, zoneTache: $('#mc-adm-tache'),
        apres: (fin) => { if (mc.selection === n.cle) mcRendreAdminFiche(n, z).then(() => { const zt = $('#mc-adm-tache'); if (zt) zt.innerHTML = mcHtmlTache(fin); }); } });
    }
    if (a === 'redemarrer' && !(await confirmer(`Redémarrer « ${n.nom} » à distance ?`))) return;
    if (a === 'annonce') return lancer('annonce', { inondation: (await confirmer('Annonce relayée par tout le réseau ?\nOK = tout le réseau · Annuler = voisins directs seulement')) });
    if (a === 'cli') { const c = f.cli.value.trim(); if (c) lancer('cli', { commande: c }); return; }
    if (a === 'appliquer') {
      const valeurs = {};
      f.querySelectorAll('.reglages-mc [name]').forEach((x) => { if (x.value !== '' && x.value !== x.dataset.initial) valeurs[x.name] = x.value.trim(); });
      if (!Object.keys(valeurs).length) { $('#mc-adm-retour').textContent = 'Aucun réglage modifié.'; return; }
      if (!(await confirmer(`Appliquer à « ${n.nom} » :\n${Object.entries(valeurs).map(([k, x]) => `• ${k} = ${x}`).join('\n')}${valeurs.radio ? '\n\n⚠ Changer la radio d’un nœud distant peut le rendre injoignable s’il ne parle plus comme les autres. Un redémarrage sera nécessaire.' : ''}`))) return;
      return lancer('modifier', { valeurs });
    }
    lancer(a);
  }));
  f.cli.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); f.querySelector('[data-a="cli"]').click(); } };
  z.querySelectorAll('tr[data-mc]').forEach((tr) => (tr.onclick = () => mcOuvrirFiche(tr.dataset.mc)));
}

// ---- Outils du companion : qui m'entend, bruit radio, télémétrie, région, commandes ---------------------------
// Les résultats sont gardés dans mc.outils : la vue est redessinée souvent (état du companion).
function mcHtmlOutils() {
  const o = mc.outils || (mc.outils = {});
  const d = o.decouverte, st = o.stats;
  const val = (x, n = 1, u = '') => (x == null ? '–' : fmt(x, n, u));
  return `<h4>Outils du companion</h4>
    <div class="actions-prop">
      <button data-mc-outil="decouvrir" title="Appel à 0 saut : chaque répéteur qui l’entend répond. Liaison mesurée dans les deux sens, sans mot de passe (15 s)">${o.enCours === 'decouvrir' ? '⏳ Écoute des réponses…' : '📡 Qui m’entend en direct ?'}</button>
      <button data-mc-outil="stats" title="Bruit radio, temps d’antenne, erreurs de réception">📊 Bruit et statistiques</button>
      <button data-mc-outil="telemetrie" title="Batterie et capteurs du companion">🌡️ Télémétrie</button>
    </div>
    ${o.erreur ? `<p class="erreur">${esc(o.erreur)}</p>` : ''}
    ${d && d.liste ? `<div class="note">Découverte ${ilYa(d.heure)} : ${d.liste.length} nœud(s) entendu(s) en direct${d.liste.length ? '' : ' (aucun répéteur à portée directe, ou répéteurs masqués / firmware ancien)'}</div>
      ${d.liste.length ? `<table class="voisins petit"><thead><tr><th>Nœud</th><th class="num" title="SNR auquel le nœud entend le companion">Il m’entend</th><th class="num" title="SNR auquel le companion entend le nœud">Je l’entends</th><th class="num">km</th></tr></thead><tbody>
        ${d.liste.map((x) => `<tr ${x.nom ? `data-mc="${x.cle}"` : ''}><td>${esc(x.nom || x.cle.slice(0, 8) + '…')}<small> ${esc({ repeteur: 'répéteur', salon: 'room server', capteur: 'capteur' }[x.role] || '')}</small></td><td class="num" style="color:${couleurSnr(x.snrAller)}">${fmt(x.snrAller, 1, ' dB')}</td><td class="num" style="color:${couleurSnr(x.snrRetour)}">${fmt(x.snrRetour, 1, ' dB')}</td><td class="num">${x.distanceKm != null ? fmt(x.distanceKm, 1) : '–'}</td></tr>`).join('')}</tbody></table>` : ''}` : ''}
    ${st ? `<div class="grille">
        <div class="mesure"><span>Bruit de fond</span><b style="color:${st.bruitDbm > -100 ? 'var(--attention)' : 'inherit'}">${val(st.bruitDbm, 0, ' dBm')}</b></div>
        <div class="mesure"><span>Dernier SNR · RSSI</span><b>${val(st.dernierSnr, 1)} · ${val(st.dernierRssi, 0)}</b></div>
        <div class="mesure"><span>Émission · réception</span><b>${val(st.occupationEmissionPct, 1, ' %')} · ${val(st.occupationReceptionPct, 1, ' %')}</b></div>
        <div class="mesure"><span>Reçus · émis</span><b>${st.recus ?? '–'} · ${st.emis ?? '–'}</b></div>
        <div class="mesure"><span>Erreurs de réception</span><b>${st.erreursReception ?? '–'}</b></div>
        <div class="mesure"><span>Allumé depuis</span><b>${st.allumeS ? duree(st.allumeS) : '–'}</b></div>
      </div>
      ${st.historique && st.historique.length > 2 ? mcCourbeBruit(st.historique) : '<p class="note">La courbe du bruit se remplit toute seule (un relevé toutes les 15 min).</p>'}
      <p class="note">Bruit de fond : vers −115 à −120 dBm sur un site calme ; au-dessus de −100 dBm, une source proche (antenne relais, alimentation, électronique) gêne la réception.</p>` : ''}
    ${o.telemetrie ? `<div class="grille">${o.telemetrie.map((m) => `<div class="mesure"><span>${esc(MC_LPP[m.type] || m.type)}${m.canal > 1 ? ' · ' + m.canal : ''}</span><b>${typeof m.valeur === 'number' ? fmt(m.valeur, m.unite === 'V' ? 2 : 1) : esc(JSON.stringify(m.valeur))} ${esc(m.unite)}</b></div>`).join('') || '<div class="vide">Aucune mesure.</div>'}</div>` : ''}
    <details class="outils-mc"${o.ouvert ? ' open' : ''}><summary>Région et réglages du companion</summary>
      <form id="mc-f-zone" class="envoi-ligne" title="Les messages envoyés en inondation par le companion ne seront relayés que par les répéteurs qui acceptent cette région (firmware 1.10+)">
        <input name="zone" placeholder="${o.zone === undefined ? 'région (ex. haute-loire), vide = aucune' : o.zone ? esc(o.zone) : 'aucune région'}" autocomplete="off"><button>Définir la région</button><button type="button" data-mc-outil="zone-lire">Lire</button>
      </form>
      <p class="note">Région actuelle : <b>${o.zone === undefined ? 'non lue' : o.zone ? esc(o.zone) : 'aucune (envois sans limite de région)'}</b>. Le nom doit être celui que les répéteurs connaissent (<span class="mono">region home</span> / <span class="mono">region put</span>).</p>
      <div class="envoi-ligne"><input id="mc-cli-local" placeholder="commande sur le companion : ver, board, get name, get wifi.status, get wifi.ip…" autocomplete="off"><button data-mc-outil="cli">Envoyer</button></div>
      <div class="actions-prop">${['ver', 'board', 'get name', 'get wifi.status', 'get wifi.ip', 'get wifi.ssid', 'get tz.offset'].map((c) => `<button class="mini" data-mc-cli="${c}">${c}</button>`).join('')}</div>
      <form id="mc-f-wifi-comp" class="grille-edit">
        <label>Wi-Fi du companion : réseau (SSID) <input name="ssid" autocomplete="off"></label>
        <label>Mot de passe <input name="mdp" type="password" autocomplete="new-password"></label>
        <label class="case"><input type="checkbox" name="actif" checked> Wi-Fi activé</label>
        <div class="actions-prop"><button>Enregistrer le Wi-Fi</button></div>
      </form>
      ${o.cli ? `<pre class="cli-mc">${o.cli.map((x) => `&gt; ${esc(x.c)}\n${esc(x.r)}`).join('\n')}</pre>` : ''}
      <p class="note">Commandes sur le companion : firmware 1.14 ou plus. Le Wi-Fi et le Bluetooth ensemble : Heltec V3/V4, RAK3112, Xiao S3 en firmware 1.18.</p>
    </details>`;
}
function mcCourbeBruit(h) {
  const pts = h.filter((x) => x.bruit != null);
  if (pts.length < 3) return '';
  const W = 300, H = 70, t0 = pts[0].heure, t1 = pts[pts.length - 1].heure || t0 + 1;
  const mn = Math.min(...pts.map((p) => p.bruit), -125), mx = Math.max(...pts.map((p) => p.bruit), -95);
  const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * W, y = (v) => H - ((v - mn) / Math.max(1, mx - mn)) * H;
  return `<svg class="courbe-bruit" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Bruit de fond sur 7 jours">
    <line x1="0" x2="${W}" y1="${y(-100)}" y2="${y(-100)}" stroke="var(--attention)" stroke-dasharray="3 3" stroke-width="1"/>
    <polyline fill="none" stroke="var(--ok)" stroke-width="1.5" points="${pts.map((p) => `${x(p.heure).toFixed(1)},${y(p.bruit).toFixed(1)}`).join(' ')}"/></svg>
    <div class="note">Bruit de fond, 7 jours : ${fmt(Math.min(...pts.map((p) => p.bruit)), 0)} à ${fmt(Math.max(...pts.map((p) => p.bruit)), 0)} dBm (pointillé : −100 dBm)</div>`;
}
function mcBrancherOutils(z) {
  const o = mc.outils || (mc.outils = {});
  const redessiner = () => { if (mc.vue === 'companion') { mcRendreCompanion.force = true; mcRendreCompanion(); } };
  const det = z.querySelector('details.outils-mc');
  if (det) det.ontoggle = () => { o.ouvert = det.open; };
  const cliLocal = async (c) => {
    o.ouvert = true;
    try { const r = await postJson('/api/mc/companion/cli', { commande: c }); o.cli = [...(o.cli || []), { c: /^set wifi\.pwd/i.test(c) ? 'set wifi.pwd ••••' : c, r: r.reponse }].slice(-12); o.erreur = null; } catch (e) { o.erreur = e.message; }
    redessiner();
  };
  z.querySelectorAll('[data-mc-outil]').forEach((b) => (b.onclick = async (ev) => {
    ev.preventDefault();
    const a = b.dataset.mcOutil;
    o.erreur = null;
    try {
      if (a === 'decouvrir') { o.enCours = 'decouvrir'; redessiner(); o.decouverte = await postJson('/api/mc/companion/decouvrir'); }
      else if (a === 'stats') o.stats = await api('/api/mc/companion/stats');
      else if (a === 'telemetrie') o.telemetrie = (await api('/api/mc/companion/telemetrie')).mesures;
      else if (a === 'zone-lire') { o.ouvert = true; o.zone = (await api('/api/mc/companion/zone')).zone; }
      else if (a === 'cli') { const i = $('#mc-cli-local'); if (i && i.value.trim()) return cliLocal(i.value.trim()); return; }
    } catch (e) { o.erreur = e.message; }
    o.enCours = null;
    redessiner();
  }));
  z.querySelectorAll('[data-mc-cli]').forEach((b) => (b.onclick = () => cliLocal(b.dataset.mcCli)));
  const ci = $('#mc-cli-local'); if (ci) ci.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); if (ci.value.trim()) cliLocal(ci.value.trim()); } };
  const fz = $('#mc-f-zone');
  if (fz) fz.onsubmit = async (ev) => {
    ev.preventDefault();
    o.ouvert = true;
    const v = fz.zone.value.trim();
    if (!(await confirmer(v ? `Limiter les envois en inondation du companion à la région « ${v} » ?\nSeuls les répéteurs qui acceptent cette région relaieront ses messages.` : 'Retirer la région : les envois du companion ne seront plus limités ?'))) return;
    try { o.zone = (await postJson('/api/mc/companion/zone', { zone: v })).zone; o.erreur = null; } catch (e) { o.erreur = e.message; }
    redessiner();
  };
  const fw = $('#mc-f-wifi-comp');
  if (fw) fw.onsubmit = async (ev) => {
    ev.preventDefault();
    const ssid = fw.ssid.value.trim(), mdp = fw.mdp.value;
    if (!ssid && fw.actif.checked) { o.erreur = 'Indiquez le réseau Wi-Fi (SSID).'; return redessiner(); }
    if (!(await confirmer('Enregistrer ce Wi-Fi dans le companion ? Il peut redémarrer ou changer d’adresse.'))) return;
    if (ssid) await cliLocal('set wifi.ssid ' + ssid);
    if (mdp) await cliLocal('set wifi.pwd ' + mdp);
    await cliLocal('set wifi.enabled ' + (fw.actif.checked ? 'on' : 'off'));
  };
  z.querySelectorAll('.voisins tr[data-mc]').forEach((tr) => (tr.onclick = () => mcOuvrirFiche(tr.dataset.mc)));
}

// ---- Companion : liaison de la carte avec un companion MeshCore -----------------------------------
async function mcChargerEtat() {
  try { mc.etat = await api('/api/mc/etat'); } catch { return; }
  mcMajKpis();
  mcMajSource();
  mcMajAlertes();
  if (mc.vue === 'companion' && $('[data-vue="meshcore"]').classList.contains('actif')) mcRendreCompanion();
}
function mcMajAlertes() {
  const z = $('#alertes-mc');
  if (!z) return;
  if (!z.dataset.branche) {
    z.dataset.branche = '1';
    z.onclick = (e) => { const el = e.target.closest('[data-mc-alerte]'); if (el && el.dataset.mcAlerte) mcOuvrirFiche(el.dataset.mcAlerte); };
  }
  document.querySelectorAll('.mc-seul-bloc').forEach((b) => (b.hidden = !mcAffiche()));
  const a = ((mc.etat && mc.etat.alertes) || []).filter((x) => { const n = x.noeud && mc.noeuds.get(x.noeud); return !n || mcDansZone(n); });
  const p = $('#nb-alertes-mc');
  p.textContent = a.length;
  p.className = 'pastille' + (a.some((x) => x.niveau === 'critique') ? ' critique' : a.length ? ' attention' : '');
  $('#resume-alertes-mc').textContent = resumeAlertes(a);
  // Capteurs hors seuil : notification du navigateur, une fois par alerte
  try {
    const vues = JSON.parse(localStorage.getItem('gaulix_capteurs_notifies') || '{}');
    let change = false;
    for (const x of a.filter((y) => y.type === 'capteur')) {
      if (vues[x.cle] === x.depuis) continue;
      vues[x.cle] = x.depuis; change = true;
      if ('Notification' in window && Notification.permission === 'granted') { try { new Notification('Capteur hors seuil', { body: x.message, tag: x.cle }); } catch { /* ignoré */ } }
    }
    if (change) localStorage.setItem('gaulix_capteurs_notifies', JSON.stringify(vues));
  } catch { /* stockage indisponible */ }
  z.innerHTML = a.length ? a.map((x) => `<div class="alerte ${x.niveau}" data-mc-alerte="${x.noeud || ''}">${esc(x.message)}<small>${x.niveau === 'critique' ? 'Critique' : 'Attention'} · depuis ${ilYa(x.depuis).replace('il y a ', '')}</small></div>`).join('') : '<div class="vide">Aucune alerte MeshCore.</div>';
  // Répéteurs et room servers de la zone
  const vueCarte = !etat.zone && typeof carte !== 'undefined' && carte ? carte.getBounds() : null;
  const titreInfra = $('#titre-infra-mc'); if (titreInfra) titreInfra.textContent = vueCarte ? 'Répéteurs (vue)' : 'Répéteurs';
  const rep = [...mc.noeuds.values()].filter((n) => ['repeteur', 'salon'].includes(n.role) && mcDansZone(n) && (!vueCarte || (n.lat != null && vueCarte.contains([n.lat, n.lon])))).sort((x, y) => (x.nom || '').localeCompare(y.nom || ''));
  const enAlerte = new Set(a.map((x) => x.noeud));
  const nbActifsMc = rep.filter((n) => n.statut !== 'inactif').length;
  $('#resume-infra-mc').textContent = rep.length ? `${nbActifsMc} actif${nbActifsMc > 1 ? 's' : ''} / ${rep.length}` : 'aucun';
  $('#infra-mc').innerHTML = rep.length ? rep.map((n) => `<div class="ligne" data-mc="${n.cle}"><span class="point ${enAlerte.has(n.cle) ? 'alerte' : n.statut}"></span><span class="titre"><i class="role-mc ${n.role}" style="--mcc:${mcRole(n.role).hex}"></i>${esc(n.nom || n.id)}<small>${esc(mcRole(n.role).un)}</small></span><span class="meta">${ilYa(n.dernierVu)}</span></div>`).join('')
    : '<div class="vide">Aucun répéteur MeshCore connu dans la zone (reliez votre companion pour entendre ceux du coin).</div>';
}
// Chaleur d'activité MeshCore (paquets des 10 dernières minutes, par nœud émetteur ou relais)
const mcActivite = [];
function mcNoterActivite(cle) { if (cle) mcActivite.push({ cle, heure: Date.now() }); }
function mcDessinerChaleur() {
  if (!mc.coucheChaleur) mc.coucheChaleur = L.layerGroup().addTo(carte);
  mc.coucheChaleur.clearLayers();
  const limite = Date.now() - 10 * 60000;
  while (mcActivite.length && mcActivite[0].heure < limite) mcActivite.shift();
  if (!etat.legende.chaleur || !mcAffiche()) return;
  const compte = new Map();
  for (const a of mcActivite) compte.set(a.cle, (compte.get(a.cle) || 0) + 1);
  for (const [cle, c] of compte) {
    const n = mc.noeuds.get(cle);
    if (!n || n.lat == null || !mcDansZone(n)) continue;
    const f = Math.min(1, c / 12);
    for (const [r, o] of [[4500, 0.05], [2600, 0.08], [1200, 0.13]]) L.circle([n.lat, n.lon], { radius: r * (0.7 + f * 0.6), stroke: false, fillColor: f > 0.6 ? '#ff3b3b' : f > 0.25 ? '#ff8a3b' : '#ffd23b', fillOpacity: o + f * 0.08, pane: 'couverture', interactive: false }).addTo(mc.coucheChaleur);
  }
}
function mcMajSource() {
  const z = $('#sources');
  if (!z || !mc.etat) return;
  let l = $('#ligne-mc');
  if (!l) { z.insertAdjacentHTML('beforeend', '<div class="ligne cliquable" id="ligne-mc"></div>'); l = $('#ligne-mc'); l.onclick = () => { mc.vue = 'companion'; document.querySelector('.onglets button[data-onglet="meshcore"]').click(); }; }
  const c = mc.etat.companion;
  l.innerHTML = `<span class="point ${c.connecte ? 'actif' : 'inactif'}"></span><span class="titre">Companion MeshCore${c.nom ? `<small>${esc(c.nom)}</small>` : ''}</span><span class="meta">${c.connecte ? `${c.paquets} paquets` : 'non relié'} ›</span>`;
}
// Avertissement « réglage radio différent » : réglage attendu de cette carte (MESHCORE_RADIO_ATTENDUE, « non » pour aucun),
// et masquable dans ce navigateur pour un réglage donné (✕) ; il revient si le réglage du companion change.
function mcAvertRadio(r) {
  const a = etat.config.mcRadioAttendue;
  if (!r || !a) return '';
  if (Math.abs(r.freq - a.freq) < 0.01 && r.bw === a.bw && r.sf === a.sf && r.cr === a.cr) return '';
  const sig = `${r.freq}|${r.bw}|${r.sf}|${r.cr}`;
  if (lireLs('gaulix_mc_radio_ok', null) === sig) return '';
  return ` · <b style="color:var(--attention)">réglage radio différent du réseau (${fmt(a.freq, 3)} MHz, BW ${fmt(a.bw, 1)}, SF${a.sf}, CR${a.cr})</b> <button class="mini" data-mc-radio-ok="${esc(sig)}" title="Ne plus afficher pour ce réglage, dans ce navigateur">✕</button>`;
}
function mcRendreCompanion() {
  const z = $('#mc-contenu');
  const e = mc.etat;
  if (!e) { z.innerHTML = '<div class="vide">Chargement…</div>'; mcChargerEtat(); return; }
  const c = e.companion, r = c.radio;
  const source = c.navigateur ? `relié par cette page ou une autre (${esc(c.nomNavigateur || '')})` : c.cible ? (c.cible.type === 'agent' ? `agent « ${esc(c.cible.hote.replace(/^agent-/, ''))} »` : c.cible.type === 'serie' ? `USB du serveur ${esc(c.cible.chemin)}` : `Wi-Fi ${esc(c.cible.hote)}:${c.cible.port}`) : 'aucun';
  // Saisie en cours (réglages, région, commande, Wi-Fi) : on ne redessine pas sous les doigts
  const ae = document.activeElement;
  const formOuvert = ae && z.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName);
  if (formOuvert && !mcRendreCompanion.force) return;
  mcRendreCompanion.force = false;
  z.innerHTML = `
    <h3>Companion de la carte</h3>
    <div class="bloc-usb ${c.connecte ? 'relie' : ''}">
      <div class="titre-usb"><span class="point ${c.connecte ? 'actif' : c.cible || c.navigateur ? 'recent' : 'inactif'}"></span><b>${esc(c.nom || (c.connecte ? 'Companion relié, mais muet' : 'Aucun companion relié'))}</b><small>${c.connecte && !c.nom ? `${c.erreur ? esc(c.erreur) + ' · ' : ''}${source} · vérifiez le firmware (« companion USB » pour l’USB) puis « Relancer »` : c.connecte ? 'relié · ' + source : c.erreur ? esc(c.erreur) : source === 'aucun' ? 'choisissez une liaison ci-dessous' : 'en attente · ' + source}</small></div>
      ${c.cle ? `<div class="ident mono" title="Clé publique">${esc(c.cle.slice(0, 16))}… <button class="mini" data-copier="${esc(c.cle)}">Copier la clé</button></div>` : ''}
      ${c.connecte ? `<div class="grille">
        <div class="mesure"><span>Radio</span><b>${r ? `${fmt(r.freq, 3)} MHz` : '–'}</b></div>
        <div class="mesure"><span>BW · SF · CR</span><b>${r ? `${fmt(r.bw, 1)} · ${r.sf} · ${r.cr}` : '–'}</b></div>
        <div class="mesure"><span>Paquets captés</span><b>${c.paquets}</b></div>
        <div class="mesure"><span>Batterie</span><b>${c.batterieMv ? fmt(c.batterieMv / 1000, 2, ' V') : '–'}</b></div>
        <div class="mesure"><span>Contacts</span><b>${c.contacts ?? '–'}</b></div>
        <div class="mesure"><span>Relié depuis</span><b>${c.depuis ? ilYa(c.depuis).replace('il y a ', '') : '–'}</b></div>
      </div>
      <div class="note">${esc([c.modele, c.firmware].filter(Boolean).join(' · '))}${mcAvertRadio(r)}</div>` : ''}
    </div>
    ${etat.admin ? `
    <div class="actions-prop">
      ${c.connecte ? '<button data-mc-act="annonce0" title="Annonce entendue seulement par les voisins directs">Annonce voisins</button><button data-mc-act="annonce1" title="Annonce relayée par les répéteurs">Annonce réseau</button><button data-mc-act="contacts" title="Relire les contacts du companion">Contacts</button>' : ''}
      ${c.connecte && !c.pret ? '<button data-mc-act="relancer" title="Redemander ses informations au companion, sans couper la liaison">↻ Relancer</button>' : ''}
      ${c.cible || c.navigateur ? '<button data-mc-act="stop">Débrancher</button>' : ''}
    </div>
    ${c.connecte && c.pret ? mcHtmlOutils() : ''}
    ${mcHtmlEcoutes(e)}
    ${c.canaux && c.canaux.length ? `<h4>Canaux du companion</h4><div class="actions-prop">${c.canaux.map((x) => `<button data-mc-qr-canal="${esc(x.nom)}" title="QR code du canal (avec sa clé)">🔳 ${esc(x.nom)}</button>`).join('')}</div>` : ''}
    <h4>Relier un companion</h4>
    <div class="actions-prop"><button class="principal" data-mc-act="connecter" title="Bluetooth, USB ou adresse IP, Meshtastic ou MeshCore reconnu tout seul">🔌 Connecter un module…</button></div>
    <p class="note">La carte se sert du companion comme <b>observateur</b> : il lui transmet chaque paquet MeshCore qu’il entend, avec le SNR. Il ne peut servir qu’un client à la fois (l’appli du téléphone sera déconnectée).</p>
    <div class="bloc-usb">
      <div class="titre-usb"><b>Branché sur ce PC</b><small>${mc.nav.etat === 'relie' ? `relayé par cette page${mc.nav.role === 'ecoute' ? ' · 👂 en écoute' : ''} · gardez l’onglet ouvert` : mc.nav.erreur ? esc(mc.nav.erreur) : 'USB (firmware « companion USB ») ou Bluetooth'}</small></div>
      <div class="actions-prop">${mc.nav.etat === 'relie' || mc.nav.etat === 'connexion' || mc.nav.etat === 'reconnexion' ? '<button data-mc-act="nav-stop">Débrancher</button>' : '<button data-mc-act="usb" class="principal-usb">🔌 USB</button><button data-mc-act="ble">📶 Bluetooth</button>'}</div>
    </div>
    <form id="mc-f-wifi" class="parametres compact">
      <label>Companion Wi-Fi <input name="hote" placeholder="192.168.1.50" value="${esc(c.cible && c.cible.type === 'tcp' ? c.cible.hote : '')}" required></label>
      <label>Port <input name="port" type="number" value="${c.cible && c.cible.type === 'tcp' ? c.cible.port : 5000}" min="1" max="65535" style="width:80px"></label>
      <button type="submit" class="principal">Relier</button>
      <button type="button" id="mc-wifi-ecoute" title="En plus du companion principal, pour l'écoute seulement">👂 En écoute</button>
    </form>
    <h4>Par un agent (companion USB sur un autre PC)</h4>
    ${(e.agents || []).length ? `<div class="liste">${e.agents.map((a) => `<div class="ligne"><span class="point ${a.occupe ? 'actif' : 'recent'}"></span><span class="titre">${esc(a.nom)}<small>${esc(a.source)}</small></span><span class="meta"><button class="mini" data-mc-agent="${esc(a.hote)}">${c.cible && c.cible.hote === a.hote ? 'Choisi' : 'Utiliser'}</button>${!a.occupe && !(c.cible && c.cible.hote === a.hote) ? ` <button class="mini" data-mc-agent-ecoute="${esc(a.hote)}" title="En plus du companion principal, pour l'écoute">👂</button>` : ''}</span></div>`).join('')}</div>` : '<div class="vide">Aucun agent en ligne. L’agent se télécharge dans Réseau › Modules radio › Module par agent (choisissez le port COM du companion).</div>'}
    <h4>Republication MQTT</h4>
    <div class="note">${e.republication.actif ? `${e.republication.connecte ? '● connecté' : '○ en attente'} · ${e.republication.publies} paquet(s) publié(s) sur <span class="mono">${esc(e.republication.sujet)}</span>${e.republication.refus ? ` · <b style="color:var(--attention)">${esc(e.republication.refus)}</b>` : ''}` : 'désactivée'}</div>
    <form id="mc-f-reglages" class="form-edit">
      <div class="grille-edit">
        <label>Code de zone (IATA) <input name="iata" value="${esc(e.reglages.iata)}" maxlength="8"><small>LPY = Le Puy</small></label>
        <label>Racine des sujets <input name="racine" value="${esc(e.reglages.racine)}"></label>
        <label class="case"><input type="checkbox" name="republier" ${e.reglages.republier ? 'checked' : ''}> Republier les paquets du companion</label>
        <label>Paquets conservés <select name="perimetre">${[['departement', 'captés dans le département'], ['voisins', 'captés dans le département et ses voisins'], ['national', 'tout le flux national (lourd)']].map(([v, t]) => `<option value="${v}" ${e.reglages.perimetre === v ? 'selected' : ''}>${t}</option>`).join('')}</select><small>${e.reglages.horsPerimetre ? `${e.reglages.horsPerimetre} paquets ignorés depuis le démarrage` : 'selon la position de l’observateur qui les capte'}</small></label>
        <label>Codes de zone voisins <input name="iataVoisins" value="${esc(e.reglages.iataVoisins || '')}" placeholder="ex. CFE, LYS, EBU"><small>pour les observateurs sans position connue</small></label>
        <label style="grid-column:1/-1">Canaux à déchiffrer (un par ligne) <textarea name="canaux" rows="3">${esc(e.reglages.canaux)}</textarea><small>Public · #nom (canal « hashtag ») · nom=secret (32 caractères hexadécimaux)</small></label>
      </div>
      <div class="actions-prop"><button type="submit" class="principal">Enregistrer et redémarrer</button></div>
      <p class="erreur" id="mc-retour"></p>
    </form>` : '<p class="note">Connectez-vous en administrateur pour relier un companion.</p>'}`;
  if (!etat.admin) return;
  const retour = (t) => { const x = $('#mc-retour'); if (x) x.textContent = t; };
  z.querySelectorAll('[data-mc-act]').forEach((b) => (b.onclick = async () => {
    const a = b.dataset.mcAct;
    try {
      if (a === 'connecter') return ouvrirConnexion();
      if (a === 'usb') { mc.nav.role = 'principal'; return mcBrancherUsb(); }
      if (a === 'ble') { mc.nav.role = 'principal'; return mcBrancherBle(); }
      if (a === 'nav-stop') return mcDebrancherNav();
      if (a === 'relancer') { await postJson('/api/mc/companion/relancer'); b.textContent = 'Relancé…'; setTimeout(mcChargerEtat, 4000); return; }
      if (a === 'stop') await api('/api/mc/companion', { method: 'DELETE' });
      if (a === 'annonce0' || a === 'annonce1') { await postJson('/api/mc/companion/annonce', { inondation: a === 'annonce1' }); b.textContent = 'Envoyée ✓'; return; }
      if (a === 'contacts') { await postJson('/api/mc/companion/contacts'); b.textContent = 'Demandé ✓'; return; }
      setTimeout(mcChargerEtat, 800);
    } catch (err) { retour(err.message); }
  }));
  z.querySelectorAll('[data-mc-radio-ok]').forEach((b) => (b.onclick = () => { ecrireLs('gaulix_mc_radio_ok', b.dataset.mcRadioOk); mcRendreCompanion.force = true; mcRendreCompanion(); }));
  z.querySelectorAll('[data-mc-qr-canal]').forEach((b) => (b.onclick = () => mcOuvrirQr({ canal: b.dataset.mcQrCanal })));
  mcBrancherOutils(z);
  mcBrancherEcoutes(z, retour);
  z.querySelectorAll('[data-mc-agent-ecoute]').forEach((b) => (b.onclick = async () => {
    try { await postJson('/api/ecoutes', { protocole: 'meshcore', type: 'agent', hote: b.dataset.mcAgentEcoute }); setTimeout(mcChargerEtat, 4500); b.textContent = '…'; } catch (err) { retour(err.message); }
  }));
  const be = $('#mc-wifi-ecoute');
  if (be) be.onclick = async () => {
    const f = $('#mc-f-wifi');
    if (!f.hote.value.trim()) return retour('Adresse IP du companion Wi-Fi ?');
    try { await postJson('/api/ecoutes', { protocole: 'meshcore', type: 'tcp', hote: f.hote.value.trim(), port: Number(f.port.value) || 5000 }); setTimeout(mcChargerEtat, 3000); } catch (err) { retour(err.message); }
  };
  z.querySelectorAll('[data-mc-agent]').forEach((b) => (b.onclick = async () => {
    try { await postJson('/api/mc/companion', { type: 'agent', hote: b.dataset.mcAgent }); setTimeout(mcChargerEtat, 4500); b.textContent = 'Connexion…'; } catch (err) { retour(err.message); }
  }));
  $('#mc-f-wifi').onsubmit = async (ev) => {
    ev.preventDefault();
    try { await postJson('/api/mc/companion', { type: 'tcp', hote: ev.target.hote.value.trim(), port: Number(ev.target.port.value) || 5000 }); setTimeout(mcChargerEtat, 2500); } catch (err) { retour(err.message); }
  };
  $('#mc-f-reglages').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    if (!(await confirmer('Enregistrer ces réglages MeshCore ? Le service redémarre (quelques secondes).'))) return;
    try { await postJson('/api/mc/reglages', { iata: f.iata.value.trim(), racine: f.racine.value.trim(), republier: f.republier.checked, canaux: f.canaux.value, perimetre: f.perimetre.value, iataVoisins: f.iataVoisins.value }); attendreRedemarrage('Réglages MeshCore enregistrés'); } catch (err) { retour(err.message); }
  };
}

// Companion branché sur ce PC : la page relaie le flux (USB tel quel ; Bluetooth trame par trame)
const MC_BLE_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e', MC_BLE_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e', MC_BLE_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
function mcMajNav(e, erreur) { mc.nav.etat = e; mc.nav.erreur = erreur || null; if (mc.vue === 'companion') mcRendreCompanion(); setTimeout(mcChargerEtat, 2500); }
function mcOuvrirWs(source, versCompanion) {
  return new Promise((ok, ko) => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/meshcore?role=${mc.nav.role === 'ecoute' ? 'ecoute' : 'principal'}&source=${source}&nom=${encodeURIComponent(source + ' ' + ((etat.config.compte && etat.config.compte.identifiant) || ''))}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ok(ws);
    ws.onerror = () => ko(new Error('connexion au serveur refusée (êtes-vous connecté en admin ?)'));
    ws.onmessage = (ev) => { if (ev.data instanceof ArrayBuffer) versCompanion(new Uint8Array(ev.data)); };
    ws.onclose = () => {
      if (mc.nav.ws !== ws) return;
      // Liaison avec le serveur coupée (redémarrage, proxy) : le companion est toujours là, on se reconnecte
      const app = mc.nav.type === 'ble' && mc.nav.ble ? mc.nav.ble.app : null;
      const port = mc.nav.type === 'usb' ? mc.nav.port : null;
      mcDebrancherNav('liaison avec le serveur fermée', !!(app || port));
      if (app) planifierReconnexionBle(mc.nav, app, mcBrancherBle, mcMajNav, 'liaison avec le serveur fermée');
      else if (port) planifierReconnexionBle(mc.nav, port, mcBrancherUsb, mcMajNav, 'liaison avec le serveur fermée');
    };
  });
}
async function mcBrancherUsb(portDonne) {
  if (!('serial' in navigator)) { alert('Ce navigateur ne gère pas l’USB : utilisez Chrome ou Edge, sur la carte en HTTPS.'); return; }
  let port = portDonne;
  if (!port) try { port = await navigator.serial.requestPort({}); } catch { return; }
  mc.nav.type = 'usb'; mcMajNav('connexion');
  try {
    await port.open({ baudRate: 115200 });
    await reglerSignauxUsb(port);
    mc.nav.port = port;
    const ecrivain = port.writable.getWriter();
    mc.nav.ecrivain = ecrivain;
    mc.nav.ws = await mcOuvrirWs('USB', (o) => ecrivain.write(o).catch(() => {}));
    mcMajNav('relie');
    (async () => {
      const lecteur = port.readable.getReader();
      mc.nav.lecteur = lecteur;
      try { for (;;) { const { value, done } = await lecteur.read(); if (done) break; if (value && mc.nav.ws && mc.nav.ws.readyState === 1) mc.nav.ws.send(value); } } catch { /* débranché */ }
      if (mc.nav.port === port) mcDebrancherNav('companion débranché');
    })();
  } catch (e) {
    try { await port.close(); } catch { /* déjà */ }
    mcMajNav('aucun', e.name === 'NetworkError' || /open/i.test(e.message) ? 'port déjà utilisé (fermez l’appli MeshCore ou l’agent)' : e.message);
  }
}
async function mcBrancherBle(appareilDonne, reprise = false) {
  if (!navigator.bluetooth) { alert('Ce navigateur ne gère pas le Bluetooth : utilisez Chrome ou Edge, sur la carte en HTTPS.'); return; }
  let app = appareilDonne;
  if (!app) try { app = await navigator.bluetooth.requestDevice({ filters: [{ services: [MC_BLE_SERVICE] }, { namePrefix: 'MeshCore' }], optionalServices: [MC_BLE_SERVICE] }); } catch { return; }
  if (!reprise) arreterReconnexionBle(mc.nav);
  mc.nav.type = 'ble'; mcMajNav(reprise ? 'reconnexion' : 'connexion', reprise ? 'reconnexion Bluetooth…' : null);
  try {
    const gatt = await app.gatt.connect();
    const svc = await gatt.getPrimaryService(MC_BLE_SERVICE);
    const rx = await svc.getCharacteristic(MC_BLE_RX), tx = await svc.getCharacteristic(MC_BLE_TX);
    if (reprise && mc.nav.appareilBle !== app) { try { app.gatt.disconnect(); } catch { /* déjà */ } return; } // débranché à la main entre-temps
    mc.nav.ble = { app, gatt };
    // Bluetooth : une notification = une trame ; on ajoute l'en-tête série « > + longueur »
    let tampon = new Uint8Array(0);
    const versCompanion = async (o) => {
      const n = new Uint8Array(tampon.length + o.length); n.set(tampon); n.set(o, tampon.length); tampon = n;
      for (;;) {
        let i = 0; while (i < tampon.length && tampon[i] !== 0x3c) i++;
        if (i + 3 > tampon.length) { tampon = tampon.slice(i); return; }
        const lg = tampon[i + 1] | (tampon[i + 2] << 8);
        if (i + 3 + lg > tampon.length) { tampon = tampon.slice(i); return; }
        const trame = tampon.slice(i + 3, i + 3 + lg); tampon = tampon.slice(i + 3 + lg);
        try { await rx.writeValue(trame); } catch { /* ignoré */ }
      }
    };
    mc.nav.ws = await mcOuvrirWs('Bluetooth', versCompanion);
    tx.addEventListener('characteristicvaluechanged', (ev) => {
      const v = ev.target.value;
      const t = new Uint8Array(3 + v.byteLength);
      t[0] = 0x3e; t[1] = v.byteLength & 255; t[2] = v.byteLength >> 8; t.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), 3);
      if (mc.nav.ws && mc.nav.ws.readyState === 1) mc.nav.ws.send(t);
    });
    await tx.startNotifications();
    if (!app.gardeReco) {
      app.gardeReco = true;
      app.addEventListener('gattserverdisconnected', () => {
        if (!mc.nav.ble || mc.nav.ble.app !== app) return;
        mcDebrancherNav('Bluetooth déconnecté', true);
        planifierReconnexionBle(mc.nav, app, mcBrancherBle, mcMajNav, 'Bluetooth coupé');
      });
    }
    arreterReconnexionBle(mc.nav);
    mcMajNav('relie');
  } catch (e) {
    try { app.gatt.disconnect(); } catch { /* déjà */ }
    mc.nav.ble = null;
    mcMajNav(reprise ? 'reconnexion' : 'aucun', 'Bluetooth : ' + e.message + (reprise ? '' : ' (code PIN demandé ? appairez d’abord le companion dans Windows)'));
  }
}
// auto : coupure subie (la reconnexion automatique suit) ; sinon débranchement voulu
async function mcDebrancherNav(raison, auto = false) {
  const n = mc.nav;
  if (auto !== true) arreterReconnexionBle(n);
  const ws = n.ws; n.ws = null;
  try { if (ws) ws.close(); } catch { /* déjà */ }
  try { if (n.lecteur) await n.lecteur.cancel(); } catch { /* déjà */ }
  try { if (n.ecrivain) n.ecrivain.releaseLock(); } catch { /* déjà */ }
  const port = n.port; n.port = null; n.lecteur = null; n.ecrivain = null;
  try { if (port) await port.close(); } catch { /* déjà */ }
  try { if (n.ble) n.ble.gatt.disconnect(); } catch { /* déjà */ }
  n.ble = null;
  mcMajNav(auto === true ? 'reconnexion' : 'aucun', typeof raison === 'string' ? raison : null);
}
window.addEventListener('beforeunload', (e) => { if (mc.nav.etat === 'relie' || mc.nav.etat === 'reconnexion') { e.preventDefault(); e.returnValue = ''; } });

// Companions en écoute (en plus du principal) : observateurs supplémentaires
function mcHtmlEcoutes(e) {
  const l = e.ecoutes || [];
  if (!l.length) return '';
  return `<h4>Companions en écoute (${l.length})</h4><div class="liste">${l.map((x) => {
    const sous = x.navigateur ? `${esc(x.source || 'navigateur')} d’une page de la carte` : x.cible.type === 'agent' ? `agent « ${esc(x.cible.hote.replace(/^agent-/, ''))} »` : x.cible.type === 'serie' ? `USB du serveur ${esc(x.cible.chemin)}` : `Wi-Fi ${esc(x.cible.hote)}:${x.cible.port}`;
    return `<div class="ligne"><span class="point ${x.connecte ? 'actif' : 'alerte'}"></span><span class="titre">${esc(x.nom || 'companion')} <span class="badge">👂 écoute</span><small>${sous} · ${x.connecte ? `${x.paquets} paquets` : x.erreur ? esc(x.erreur) : 'connexion…'}</small></span>
      <span class="meta">${!x.navigateur ? `<button class="mini" data-mc-ec-princ="${esc(x.cle)}" title="En faire le companion principal (envois, administration) ; l’actuel passe en écoute">⭐</button> ` : ''}<button class="mini" data-mc-ec-off="${esc(x.cle)}" title="Arrêter l'écoute">✕</button></span></div>`;
  }).join('')}</div><p class="note">Chaque companion en écoute transmet ce qu’il entend, avec son SNR : plus de liaisons mesurées et de parcours. Envois et administration passent par le companion principal.</p>`;
}
function mcBrancherEcoutes(z, retour) {
  z.querySelectorAll('[data-mc-ec-off]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try { await api('/api/ecoutes', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ protocole: 'meshcore', cle: b.dataset.mcEcOff }) }); } catch (err) { retour(err.message); }
    setTimeout(mcChargerEtat, 800);
  }));
  z.querySelectorAll('[data-mc-ec-princ]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try { await postJson('/api/ecoutes/principal', { protocole: 'meshcore', cle: b.dataset.mcEcPrinc, echanger: true }); } catch (err) { retour(err.message); }
    setTimeout(mcChargerEtat, 3500);
  }));
}

// Résultat d'une découverte de chemin, avec tracé sur la carte
function mcHtmlChemin(c, n) {
  const etape = (x) => `<span class="saut${x.cle ? ' resolu' : ''}">${esc(x.nom || x.prefixe)}</span>`;
  const moi = (mc.etat && mc.etat.companion && mc.etat.companion.nom) || 'companion';
  return `<div class="chemin-test"><h4>Liaison testée ${c.heure ? ilYa(c.heure) : ''} · ${fmt(c.dureeMs / 1000, 1, ' s')} aller-retour</h4>
    <div class="chemin-mc"><span class="saut obs">${esc(moi)}</span>${c.aller.map((x) => '<i>›</i>' + etape(x)).join('')}<i>›</i><span class="saut obs">${esc(n.nom || n.id)}</span> <small>aller</small></div>
    <div class="chemin-mc"><span class="saut obs">${esc(n.nom || n.id)}</span>${c.retour.map((x) => '<i>›</i>' + etape(x)).join('')}<i>›</i><span class="saut obs">${esc(moi)}</span> <small>retour</small></div></div>`;
}
// ---- Capteurs d'un nœud : relevé périodique, courbes, libellés personnalisés ----
const MC_LIB_CAPTEUR = { tension: 'Tension', temperature: 'Température', humidite: 'Humidité', pression: 'Pression', courant: 'Courant', pourcentage: 'Charge', luminosite: 'Luminosité', puissance: 'Puissance', energie: 'Énergie', altitude: 'Altitude', distance: 'Distance', concentration: 'Concentration', frequence: 'Fréquence', analogique: 'Entrée analogique', generique: 'Valeur', entree: 'Entrée', sortie: 'Sortie', presence: 'Présence', interrupteur: 'Interrupteur', direction: 'Direction' };
const libelleCapteur = (r, mesure) => {
  if (r.libelles && r.libelles[mesure]) return r.libelles[mesure];
  const [type, canal] = mesure.split(':');
  return `${MC_LIB_CAPTEUR[type] || type} ${canal}`;
};
// Chemin enregistré dans le companion pour joindre ce nœud : le voir, le réinitialiser (inondation), le forcer
async function mcRendreChemin(n) {
  const z = $('#mc-chemin');
  if (!z) return;
  const titre = '<h4>🧭 Chemin depuis le companion</h4>';
  if (!(mc.etat && mc.etat.companion && mc.etat.companion.pret)) { z.innerHTML = titre + '<p class="note">Companion de la carte non relié.</p>'; return; }
  let r;
  try { r = await api(`/api/mc/noeuds/${n.cle}/chemin`); } catch (e) { z.innerHTML = titre + `<p class="note">${esc(e.message)}</p>`; return; }
  const gerer = typeof estGestionnaire !== 'undefined' ? estGestionnaire() : (etat.admin || (etat.compte && etat.compte.role === 'gestionnaire'));
  const etatTxt = !r.contact ? 'Ce nœud n’est pas dans les contacts du companion : le premier envoi part en inondation, le chemin sera appris au retour.'
    : r.inondation ? '<b>Inondation</b> : aucun chemin enregistré, le prochain envoi passe par tous les répéteurs et le chemin sera appris au retour.'
    : !r.chemin.length ? '<b>Direct</b> (0 saut) : le companion lui écrit sans relais.'
    : `<b>${r.chemin.length} relais</b> : ${r.chemin.map((x) => `<span class="saut-chemin" title="${esc(x.cle || '')}">${esc(x.nom || '?')} <code>${esc(x.id)}</code></span>`).join(' → ')} → ${esc(n.nom || 'nœud')}`;
  z.innerHTML = `${titre}<p>${etatTxt}</p>
    ${gerer && r.contact ? `<div class="boutons"><button class="mini" id="mc-chemin-reset" title="Oublie le chemin : le prochain envoi part en inondation et le chemin est réappris">↺ Réinitialiser (inondation)</button>
      <button class="mini" id="mc-chemin-direct" title="Le nœud est entendu en direct par le companion">Forcer en direct</button></div>
      <label class="champ-chemin">Forcer un chemin <input id="mc-chemin-saisie" placeholder="ex. A3,7F (identifiants des relais, du companion vers le nœud)" value="${r.chemin && r.chemin.length ? esc(r.chemin.map((x) => x.id).join(',')) : ''}"></label>
      <button class="mini principal" id="mc-chemin-forcer">Appliquer ce chemin</button><p class="erreur" id="mc-chemin-retour"></p>
      <p class="note">Un chemin faux empêche de joindre le nœud : en cas de doute, réinitialisez. Les identifiants des répéteurs sont les premiers octets de leur clé (voir leur fiche).</p>` : ''}`;
  const act = async (corps) => {
    try { await postJson(`/api/mc/noeuds/${n.cle}/chemin`, corps); mcRendreChemin(n); } catch (e) { const x = $('#mc-chemin-retour'); if (x) x.textContent = e.message; else alert(e.message); }
  };
  const b1 = $('#mc-chemin-reset'); if (b1) b1.onclick = () => act({ action: 'reinitialiser' });
  const b2 = $('#mc-chemin-direct'); if (b2) b2.onclick = () => act({ action: 'forcer', chemin: '' });
  const b3 = $('#mc-chemin-forcer'); if (b3) b3.onclick = () => act({ action: 'forcer', chemin: $('#mc-chemin-saisie').value });
}

async function mcRendreCapteurs(n, z, jours = 7) {
  if (!z) return;
  let r;
  try { r = await api(`/api/mc/capteurs/${n.cle}?jours=${jours}`); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  const dec = (u) => (u === 'V' ? 2 : u === '°C' || u === '%' || u === 'hPa' ? 1 : 2);
  const lib = (m) => ({ 15: '15 min', 30: '30 min', 60: '1 h', 180: '3 h', 360: '6 h', 720: '12 h', 1440: '24 h' }[m] || 'jamais');
  z.innerHTML = `
    <div class="actions-prop">${[1, 7, 30, 90].map((j) => `<button class="mini ${j === jours ? 'actif' : ''}" data-cj="${j}">${j} j</button>`).join('')}${r.series.length ? `<a class="mini bouton-lien" href="/api/mc/capteurs/${n.cle}/csv?jours=${jours}" download>⬇ CSV (${jours} j)</a>` : ''}</div>
    ${r.peutRegler ? `<div class="reglage-capteurs"><label>Relever toutes les <select id="cap-int">${r.intervalles.map((m) => `<option value="${m}" ${m === r.intervalleMin ? 'selected' : ''}>${lib(m)}</option>`).join('')}</select></label>
      <button class="mini principal" id="cap-maintenant">Relever maintenant</button></div>
      <p class="note">Le relevé passe par le companion de la carte (tâche « télémétrie »). Le nœud doit autoriser la télémétrie : mot de passe invité ou admin mémorisé, ou télémétrie ouverte. Chaque relevé envoie un paquet : 1 h ou plus suffit pour un abri ou une batterie.</p>` : ''}
    ${r.dernier ? `<p class="note">Dernier relevé ${ilYa(r.dernier)}.</p>` : ''}
    ${r.series.length ? r.series.filter((sr) => !(r.masquees || []).includes(sr.mesure)).map((sr) => {
      const pts = sr.points.map(([h, v]) => ({ heure: h, v }));
      const der = sr.points[sr.points.length - 1];
      const se = (r.seuils || {})[sr.mesure] || {};
      const hors = (se.min != null && der[1] < se.min) || (se.max != null && der[1] > se.max);
      const txtSeuil = se.min != null || se.max != null ? `alerte ${se.min != null ? 'sous ' + fmt(se.min, dec(sr.unite), ' ' + sr.unite) : ''}${se.min != null && se.max != null ? ' ou ' : ''}${se.max != null ? 'au-dessus de ' + fmt(se.max, dec(sr.unite), ' ' + sr.unite) : ''}` : '';
      return `<div class="serie-capteur${hors ? ' hors-seuil' : ''}"><div class="titre-serie"><b>${esc(libelleCapteur(r, sr.mesure))}</b> <span class="valeur">${fmt(der[1], dec(sr.unite), ' ' + sr.unite)}</span>${hors ? ' <span class="alerte-seuil">⚠ hors seuil</span>' : ''}
        ${r.peutRegler ? `<button class="mini" data-cap-lib="${esc(sr.mesure)}" title="Renommer cette mesure">✏️</button><button class="mini" data-cap-effacer="${esc(sr.mesure)}" title="Effacer cette mesure : tout son historique, son nom et son alerte">🗑</button><button class="mini" data-cap-masquer="${esc(sr.mesure)}" title="Masquer cette mesure (non pertinente) : elle reste enregistrée et dans l’export CSV">🙈 Masquer</button>` : ''}<small>${esc(sr.mesure.replace(':', ' · canal '))} · ${sr.points.length} relevé${sr.points.length > 1 ? 's' : ''}${txtSeuil ? ' · ' + txtSeuil : ''}</small></div>
        ${pts.length >= 2 ? courbe(pts, 'v', '', ' ' + sr.unite, dec(sr.unite), se.min != null ? se.min : undefined) : '<p class="note">Une seule valeur pour l’instant : la courbe apparaîtra au relevé suivant.</p>'}
        ${r.peutRegler ? `<details class="seuils-capteur"><summary>🔔 Alerte${txtSeuil ? ' (réglée)' : ''}</summary><div class="ligne-seuils" data-cap-seuil="${esc(sr.mesure)}">
          <label>sous <input type="number" step="any" data-s="min" value="${se.min ?? ''}" placeholder="—"></label>
          <label>au-dessus de <input type="number" step="any" data-s="max" value="${se.max ?? ''}" placeholder="—"></label>
          <span>${esc(sr.unite || '')}</span><button class="mini principal" data-s-ok>Enregistrer</button></div>
          <p class="note">Alerte MeshCore (et notification du navigateur, carte ouverte) quand le dernier relevé sort de ces limites. Laissez vide pour ne pas surveiller.</p></details>` : ''}</div>`;
    }).join('') : '<div class="vide">Aucune mesure enregistrée. Choisissez un intervalle de relevé, ou « Relever maintenant ».</div>'}
    ${(() => { const m = r.series.filter((sr) => (r.masquees || []).includes(sr.mesure)); return m.length ? `<details class="mesures-masquees"><summary>🙈 Mesures masquées (${m.length})</summary>${m.map((sr) => { const d = sr.points[sr.points.length - 1]; return `<div class="ligne-masquee"><span>${esc(libelleCapteur(r, sr.mesure))} <small>${esc(sr.mesure.replace(':', ' · canal '))} · dernier ${fmt(d[1], 2, ' ' + sr.unite)}</small></span>${r.peutRegler ? `<button class="mini" data-cap-afficher="${esc(sr.mesure)}">👁 Réafficher</button>` : ''}</div>`; }).join('')}</details>` : ''; })()}    ${r.peutRegler && (r.series.length || Object.keys(r.libelles || {}).length) ? `<details class="reinit-capteurs"><summary>♻ Remettre à zéro</summary>
      <p class="note">Après un renommage, un recâblage ou une mise à jour du capteur, les canaux peuvent changer de sens : les anciens noms et l’historique ne correspondent plus. Repartez de zéro :</p>
      <label class="case"><input type="radio" name="cap-hist" value="tout" checked> Effacer tout l’historique des mesures</label>
      <label class="case"><input type="radio" name="cap-hist" value="avant"> Effacer les relevés antérieurs au <input type="date" id="cap-avant" value="${new Date().toISOString().slice(0, 10)}"></label>
      <label class="case"><input type="radio" name="cap-hist" value=""> Garder l’historique</label>
      <label class="case"><input type="checkbox" id="cap-reglages" checked> Effacer aussi les noms des mesures, les alertes et le masquage (l’intervalle de relevé est gardé)</label>
      <div class="actions-prop"><button class="mini danger" id="cap-reinit">♻ Remettre à zéro</button></div></details>` : ''}
`;
  z.querySelectorAll('[data-cj]').forEach((b) => (b.onclick = () => mcRendreCapteurs(n, z, Number(b.dataset.cj))));
  z.querySelectorAll('[data-cap-effacer]').forEach((b) => (b.onclick = async () => {
    const m = b.dataset.capEffacer;
    if (!(await confirmer(`Effacer la mesure « ${libelleCapteur(r, m)} » : tout son historique, son nom et son alerte ? Elle réapparaîtra au prochain relevé si le capteur l’envoie encore.`))) return;
    try { await postJson(`/api/mc/capteurs/${n.cle}/reinitialiser`, { mesure: m }); } catch (e) { alert(e.message); return; }
    mcRendreCapteurs(n, z, jours);
  }));
  const bri = $('#cap-reinit');
  if (bri) bri.onclick = async () => {
    const h = (z.querySelector('input[name="cap-hist"]:checked') || {}).value || null, avecReglages = $('#cap-reglages').checked;
    const avant = h === 'avant' ? new Date($('#cap-avant').value + 'T00:00:00').getTime() : null;
    if (!h && !avecReglages) return alert('Rien à remettre à zéro : cochez au moins une option.');
    if (!(await confirmer(`Remettre à zéro les capteurs de ${n.nom || 'ce nœud'} ?${h === 'tout' ? '\nTout l’historique sera effacé.' : h === 'avant' ? '\nLes relevés antérieurs à cette date seront effacés.' : ''}${avecReglages ? '\nLes noms des mesures, les alertes et le masquage seront effacés.' : ''}`))) return;
    try { const x = await postJson(`/api/mc/capteurs/${n.cle}/reinitialiser`, { historique: h, avant, reglages: avecReglages }); alert(`${x.lignes} relevé(s) effacé(s).`); } catch (e) { alert(e.message); return; }
    mcRendreCapteurs(n, z, jours);
  };
  const si = $('#cap-int');
  if (si) si.onchange = async () => { try { await postJson(`/api/mc/capteurs/${n.cle}`, { intervalleMin: Number(si.value) }); } catch (e) { alert(e.message); } };
  const bm = $('#cap-maintenant');
  if (bm) bm.onclick = async () => {
    bm.disabled = true; bm.textContent = 'Demande envoyée…';
    try { await postJson('/api/mc/admin/taches', { type: 'telemetrie', cles: [n.cle] }); } catch (e) { alert(e.message); bm.disabled = false; bm.textContent = 'Relever maintenant'; return; }
    setTimeout(() => mcRendreCapteurs(n, z, jours), 25000);
  };
  const masquer = async (m, v) => { try { await postJson(`/api/mc/capteurs/${n.cle}`, { masquees: { [m]: v } }); } catch (e) { alert(e.message); return; } mcRendreCapteurs(n, z, jours); };
  z.querySelectorAll('[data-cap-masquer]').forEach((b) => (b.onclick = async () => { const m = b.dataset.capMasquer; await masquer(m, true); if (typeof annonceAnnulable === 'function') annonceAnnulable('Mesure masquée.', () => masquer(m, false)); }));
  z.querySelectorAll('[data-cap-afficher]').forEach((b) => (b.onclick = () => masquer(b.dataset.capAfficher, false)));
  z.querySelectorAll('[data-cap-seuil]').forEach((l) => (l.querySelector('[data-s-ok]').onclick = async () => {
    const v = (k) => l.querySelector(`[data-s="${k}"]`).value.replace(',', '.');
    try { await postJson(`/api/mc/capteurs/${n.cle}`, { nom: n.nom || '', seuils: { [l.dataset.capSeuil]: { min: v('min'), max: v('max') } } }); } catch (e) { alert(e.message); return; }
    if ('Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch { /* refus */ } }
    mcRendreCapteurs(n, z, jours);
  }));
  z.querySelectorAll('[data-cap-lib]').forEach((b) => (b.onclick = async () => {
    const m = b.dataset.capLib;
    const v = (await saisir(`Nom de la mesure « ${m.replace(':', ' · canal ')} » (vide = nom par défaut) :`, (r.libelles || {})[m] || ''));
    if (v === null) return;
    try { await postJson(`/api/mc/capteurs/${n.cle}`, { libelles: { [m]: v } }); } catch (e) { alert(e.message); return; }
    mcRendreCapteurs(n, z, jours);
  }));
}
function mcHtmlTelemetrie(t) {
  if (!t || !t.length) return '';
  const pts = t.map((x) => ({ heure: x.heure, tension: x.batterie_mv ? x.batterie_mv / 1000 : null, emission: x.emission_pct, bruit: x.bruit }));
  const der = t[t.length - 1];
  return `<h4>État du répéteur (${t.length} relevé${t.length > 1 ? 's' : ''}, dernier ${ilYa(der.heure)})</h4>
    <div class="grille"><div class="mesure"><span>Batterie</span><b>${fmt(der.batterie_mv / 1000, 2, ' V')}</b></div><div class="mesure"><span>Bruit</span><b>${der.bruit ?? '–'} dBm</b></div><div class="mesure"><span>Émission</span><b>${fmt(der.emission_pct, 1, ' %')}</b></div></div>
    ${courbe(pts, 'tension', 'Tension', ' V', 2, etat.config.seuils.tensionVolts)}${courbe(pts, 'emission', 'Temps d’émission', ' %', 1)}${courbe(pts, 'bruit', 'Bruit de fond', ' dBm', 0)}`;
}
async function mcOuvrirQr(q) {
  const dlg = $('#dlg-qr'), z = $('#qr-contenu');
  z.innerHTML = '<div class="vide">Chargement…</div>';
  if (!dlg.open) dlg.showModal();
  try {
    const r = await api('/api/mc/qr?' + new URLSearchParams(q));
    z.innerHTML = `<h3>${esc(r.titre)}</h3><div class="qr-mc">${r.svg}</div>
      <p class="note">À scanner dans l’appli MeshCore (${q.canal ? 'ajout du canal, avec sa clé : ne le diffusez qu’aux personnes autorisées' : 'ajout du contact'}).</p>
      <div class="boutons"><button data-copier="${esc(r.url)}">Copier le lien</button></div>`;
  } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; }
}

// ---- Fiche d'un nœud MeshCore ------------------------------------------------------------------
async function mcOuvrirFiche(cle, ongletInitial) {
  mc.selection = cle;
  etat.selection = null;
  $('#fiche').hidden = false;
  const zc = $('#fiche-contenu');
  zc.innerHTML = '<div class="vide">Chargement…</div>';
  let d;
  try { d = await api('/api/mc/noeuds/' + cle); } catch (e) { zc.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  if (mc.selection !== cle) return;
  const n = d.noeud, r = mcRole(n.role);
  const obs = n.detailsObservateur || {};
  const mesures = [
    ['Dernier entendu', ilYa(n.dernierVu)], ['Dernière annonce', n.derniereAnnonce ? ilYa(n.derniereAnnonce) : '–'],
    ['Sauts (min.)', n.sautsMin == null ? '–' : n.sautsMin === 0 ? 'Direct' : n.sautsMin],
    ['SNR direct', fmt(n.snr, 1, ' dB')], ['RSSI direct', fmt(n.rssi, 0, ' dBm')],
    ['Vu la 1re fois', n.premierVu ? new Date(n.premierVu).toLocaleDateString('fr-FR') : '–'],
  ];
  if (n.observateur) mesures.push(['Observateur', n.etatObservateur === 'offline' ? 'hors ligne' : 'en ligne'], ['Matériel', obs.modele || '–'], ['Firmware', obs.firmware || '–']);
  const voisins = d.voisins.slice(0, 40).map((v) => `<tr data-mc="${v.cle}"><td><span style="color:${v.snrEntendu ?? v.snrEmis != null ? couleurSnr(v.snrEntendu ?? v.snrEmis) : '#fb923c'}">●</span> ${esc(v.nom || v.cle.slice(0, 8))}</td>
    <td class="num">${fmt(v.snrEntendu, 1)}</td><td class="num">${fmt(v.snrEmis, 1)}</td><td class="num">${v.distanceKm != null ? fmt(v.distanceKm, 1) : '–'}</td><td class="num">${v.nb}</td>
    <td>${esc(v.sources.map((s) => ({ rf: 'mesuré', chemin: 'chemin', trace: 'trace', voisinage: 'voisin déclaré' }[s])).join(', '))}</td>
    <td class="num">${n.lat != null && mc.noeuds.get(v.cle) && mc.noeuds.get(v.cle).lat != null ? `<button class="mini" data-mc-profil="${v.cle}" title="Profil de relief">⛰</button>` : ''}</td></tr>`).join('');
  zc.innerHTML = `
    <h2>${esc(n.nom || n.id)}</h2>
    <div class="ident">MeshCore · <span class="mono">${esc(n.cle.slice(0, 16))}…</span> <button class="mini" data-copier="${esc(n.cle)}" title="Copier la clé publique complète">Copier la clé</button> ${boutonsSuivi(n.cle)}</div>
    ${blocCoords(n.lat, n.lon, { approx: !etat.membre && !n.infrastructure && etat.config.precisionPublique >= 0 })}
    <div class="badges">
      <span class="badge ${n.statut}">${{ actif: 'Actif', recent: 'Récent', inactif: 'Inactif' }[n.statut]}</span>
      <span class="badge" style="color:${r.hex};border-color:${r.hex}66">${esc(r.un)}</span>
      ${n.observateur ? `<span class="badge passerelle" title="${obs.carte ? 'Relié à cette carte : il lui transmet ce qu’il entend (indépendant de la republication MQTT)' : 'Publie ce qu’il entend sur le broker MQTT, où la carte le lit'}">${esc(mcLibObservateur(n, true))}</span>` : ''}
      <span class="badge reseau-mc">MeshCore</span>
    </div>
    <nav class="onglets-fiche"><button data-of="infos" class="actif">Informations</button><button data-of="voisins">Voisins (${d.voisins.length})</button><button data-of="trames">Paquets</button>${etat.membre && ['repeteur', 'salon', 'capteur'].includes(n.role) ? '<button data-of="capteurs">Capteurs</button>' : ''}${gerable(n.cle) && ['repeteur', 'salon', 'capteur'].includes(n.role) ? '<button data-of="admin">Administration</button>' : ''}</nav>
    <div data-pf="infos">
      <div class="grille">${mesures.map(([l, v]) => `<div class="mesure"><span>${l}</span><b>${esc(v)}</b></div>`).join('')}</div>
      <div class="boutons">
        ${n.lat != null ? '<button id="mc-centrer">Centrer</button>' : ''}
        ${etat.admin && n.role !== 'repeteur' && !(mc.etat && mc.etat.companion && mc.etat.companion.cle === n.cle) ? '<button id="mc-ecrire">✉️ Message direct</button>' : ''}
        ${etat.admin && mc.etat && mc.etat.companion && mc.etat.companion.connecte && mc.etat.companion.cle !== n.cle ? '<button id="mc-tester" title="Découverte du chemin aller et retour depuis le companion de la carte">Tester la liaison</button>' : ''}
        <button id="mc-qr" title="QR code à scanner dans l’appli MeshCore pour ajouter ce contact">🔳 QR code</button>
        ${n.lat != null ? `<button id="mc-couv">Couverture selon le relief</button><label class="champ-mini">antenne <input id="mc-h" type="number" min="0.5" max="80" step="0.5" value="${n.infrastructure ? 6 : 2}"> m</label>` : ''}
      </div>
      <div id="mc-test-zone">${d.chemin ? mcHtmlChemin(d.chemin, n) : ''}</div>
      ${etat.membre && mc.etat && mc.etat.companion && mc.etat.companion.cle !== n.cle ? '<div id="mc-chemin" class="bloc-chemin"><h4>🧭 Chemin depuis le companion</h4><div class="vide">…</div></div>' : ''}
      ${mcHtmlTelemetrie(d.telemetrie)}
      ${d.entenduPar.length ? `<h4>Entendu par (observateurs)</h4><table class="voisins"><thead><tr><th>Observateur</th><th class="num">Paquets</th><th class="num">SNR</th><th class="num">RSSI</th><th class="num">Sauts min.</th></tr></thead><tbody>
        ${d.entenduPar.map((e) => `<tr data-mc="${e.observateur}"><td>${esc(e.nom || e.observateur.slice(0, 8))}</td><td class="num">${e.nb}</td><td class="num">${fmt(e.snr, 1)}</td><td class="num">${fmt(e.rssi, 0)}</td><td class="num">${e.sauts_min ?? '–'}</td></tr>`).join('')}</tbody></table>` : ''}
      <p class="note">Le SNR et le RSSI d’un observateur ne valent que pour les paquets entendus <b>en direct</b> (0 saut). Les « sauts » comptent les répéteurs traversés.</p>
    </div>
    <div data-pf="voisins" hidden>
      ${voisins ? `<table class="voisins"><thead><tr><th>Nœud</th><th class="num">SNR reçu</th><th class="num">SNR émis</th><th class="num">km</th><th class="num">Obs.</th><th>Source</th><th></th></tr></thead><tbody>${voisins}</tbody></table>
      <p class="note">« Mesuré » : dernier saut vers un observateur (SNR réel). « Chemin » : déduit de la liste des répéteurs traversés par un paquet (préfixes de clé, rapprochés par la géographie).</p>` : '<div class="vide">Aucune liaison connue.</div>'}
    </div>
    <div data-pf="capteurs" hidden><div id="mc-capteurs-fiche"><div class="vide">Chargement…</div></div></div>
    <div data-pf="admin" hidden><div id="mc-admin-fiche"><div class="vide">Chargement…</div></div></div>
    <div data-pf="trames" hidden><div class="flux">${d.paquets.map((p) => mcLignePaquet(p, false)).join('') || '<div class="vide">Aucun paquet émis par ce nœud (seuls les annonces et les requêtes portent la clé complète de l’émetteur).</div>'}</div></div>`;
  zc.querySelectorAll('[data-of]').forEach((b) => (b.onclick = () => {
    zc.querySelectorAll('[data-of]').forEach((x) => x.classList.toggle('actif', x === b));
    zc.querySelectorAll('[data-pf]').forEach((x) => (x.hidden = x.dataset.pf !== b.dataset.of));
    if (b.dataset.of === 'capteurs') mcRendreCapteurs(n, $('#mc-capteurs-fiche'));
    if (b.dataset.of === 'admin') mcRendreAdminFiche({ cle: n.cle, nom: n.nom || n.id, role: n.role }, $('#mc-admin-fiche'));
  }));
  if (ongletInitial) { const b = zc.querySelector(`[data-of="${ongletInitial}"]`); if (b) b.click(); }
  const bq = $('#mc-qr'); if (bq) bq.onclick = () => mcOuvrirQr({ cle: n.cle });
  if ($('#mc-chemin')) mcRendreChemin(n);
  const bt = $('#mc-tester');
  if (bt) bt.onclick = async () => {
    bt.disabled = true;
    try {
      const t = await postJson('/api/mc/admin/taches', { type: 'chemin', cles: [n.cle] });
      mcSuivreTache(t.id, $('#mc-test-zone'), (fin) => {
        const r = fin.resultats[n.cle];
        if (r && r.chemin && $('#mc-test-zone')) $('#mc-test-zone').insertAdjacentHTML('afterbegin', mcHtmlChemin(r.chemin, n));
        bt.disabled = false;
      });
    } catch (e) { alert(e.message); bt.disabled = false; }
  };
  const ec = $('#mc-ecrire');
  if (ec) ec.onclick = () => {
    mc.destMessage = 'direct:' + n.cle; mc.vue = 'messages';
    $('#panneau').classList.remove('replie'); $('#deplier').hidden = true;
    document.querySelector('.onglets button[data-onglet="meshcore"]').click();
    mcRendrePanneau();
    setTimeout(() => { const t = $('#mc-texte'); if (t) t.focus(); }, 400);
  };
  const c = $('#mc-centrer'); if (c) c.onclick = () => carte.flyTo([n.lat, n.lon], Math.max(carte.getZoom(), 12));
  const cv = $('#mc-couv'); if (cv) cv.onclick = () => voirCouvertureSite({ lat: n.lat, lon: n.lon }, n.nom || n.id, Number($('#mc-h').value) || 2, { cadrer: true, preset: 'MESHCORE_FR' });
  zc.querySelectorAll('tr[data-mc]').forEach((tr) => (tr.onclick = (e) => { if (!e.target.closest('[data-mc-profil]')) mcOuvrirFiche(tr.dataset.mc); }));
  zc.querySelectorAll('[data-mc-profil]').forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const o = mc.noeuds.get(b.dataset.mcProfil);
    ouvrirProfilCoords({ lat: n.lat, lon: n.lon, nom: n.nom || n.id, h: n.infrastructure ? 6 : 2 }, { lat: o.lat, lon: o.lon, nom: o.nom || o.id, h: o.infrastructure ? 6 : 2 }, 'MESHCORE_FR');
  }));
}

// ---- Détail d'un paquet : champs, octets, réceptions --------------------------------------------
async function mcOuvrirPaquet(id) {
  const dlg = $('#dlg-trame'), z = $('#trame-contenu');
  z.innerHTML = '<div class="vide">Chargement…</div>';
  if (!dlg.open) dlg.showModal();
  let d;
  try { d = await api('/api/mc/paquets/' + id); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  const p = d.decode, t = mcType(d.type), c = p.contenu || {};
  // Découpage des octets par champ
  const o = (d.brut || '').match(/../g) || [];
  const seg = [];
  let i = 0;
  seg.push(['entete', 'En-tête', o.slice(0, 1)]); i = 1;
  if (p.transport) { seg.push(['transport', 'Codes de transport', o.slice(1, 5)]); i = 5; }
  seg.push(['lgchemin', 'Longueur du chemin', o.slice(i, i + 1)]); i++;
  const lc = p.type === 'TRACE' ? (p.snrChemin || []).length : p.chemin.length * p.tailleHachage;
  if (lc) { seg.push(['chemin', p.type === 'TRACE' ? 'SNR des sauts' : 'Chemin', o.slice(i, i + lc)]); i += lc; }
  seg.push(['charge', 'Charge utile', o.slice(i)]);
  const champs = [
    ['Hachage', d.hachage], ['Type', `${p.typeFr} (${p.type}, ${(p.entete >> 2) & 15})`], ['Routage', p.routeFr], ['Version', 'v' + p.version],
    ['Taille', `${p.taille} octets (charge ${p.tailleCharge})`], ['Chemin', p.chemin.length ? `${p.chemin.length} saut(s), hachages de ${p.tailleHachage} octet(s)` : p.type === 'TRACE' ? 'trace' : 'aucun (0 saut)'],
    ['Reçu', `${d.nbReceptions} fois · ${new Date(d.heure).toLocaleString('fr-FR')}`],
  ];
  if (p.transport) champs.push(['Codes de transport', p.transport.join(', ')]);
  if (p.region) champs.push(['Région (étiquette)', p.region === '-' ? 'aucune (inondation sans région)' : p.region === '?' ? 'inconnue de la carte' : p.region]);
  const contenu = Object.entries(c).filter(([k, v]) => v != null && v !== '' && !['signature'].includes(k)).map(([k, v]) => [{
    cle: 'Clé publique', horodatage: 'Horodatage', drapeaux: 'Drapeaux', role: 'Type de nœud', lat: 'Latitude', lon: 'Longitude', nom: 'Nom',
    hachageCanal: 'Hachage du canal', canal: 'Canal', expediteur: 'Expéditeur', texte: 'Texte', dechiffre: 'Déchiffré', sousType: 'Sous-type',
    vers: 'Destinataire (préfixe)', de: 'Émetteur (préfixe)', chiffre: 'Chiffré', cleExpediteur: 'Clé de l’émetteur', controle: 'Contrôle',
    etiquette: 'Étiquette', auth: 'Code d’auth.', route: 'Route', donnees: 'Données',
  }[k] || k, k === 'horodatage' ? `${v} (${new Date(v * 1000).toLocaleString('fr-FR')})` : typeof v === 'boolean' ? (v ? 'oui' : 'non') : Array.isArray(v) ? v.join(' › ') : k === 'drapeaux' ? '0x' + Number(v).toString(16).toUpperCase() : String(v)]);
  z.innerHTML = `
    <h3><span class="tag"><i style="background:${t.hex}"></i>${esc(t.nom)}</span> ${esc(d.resume || '')}</h3>
    <div class="grille">${champs.map(([l, v]) => `<div class="mesure"><span>${esc(l)}</span><b class="${l === 'Hachage' ? 'mono' : ''}">${esc(v)}</b></div>`).join('')}</div>
    ${contenu.length ? `<h4>Contenu décodé</h4><table class="voisins"><tbody>${contenu.map(([l, v]) => `<tr><td>${esc(l)}</td><td class="mono petit" style="word-break:break-all">${esc(v)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${p.type === 'TRACE' && p.snrChemin ? `<p class="note">SNR mesurés à chaque saut : ${p.snrChemin.map((s) => fmt(s, 2, ' dB')).join(' · ')}</p>` : ''}
    <h4>Réceptions (${d.receptions.length})</h4>
    <table class="voisins"><thead><tr><th>Observateur</th><th>Heure</th><th class="num">SNR</th><th class="num">RSSI</th><th>Chemin (relais identifiés)</th></tr></thead><tbody>
    ${d.receptions.map((r) => `<tr data-mc="${r.observateur}"><td>${esc(r.nomObservateur || r.observateur.slice(0, 8))}<br><small>${esc(r.via || '')}</small></td><td>${heure(r.heure)}</td><td class="num">${fmt(r.snr, 2)}</td><td class="num">${fmt(r.rssi, 0)}</td>
      <td>${r.chemin.length ? r.chemin.map((h, k) => `<span class="saut${r.cheminResolu[k] ? ' resolu' : ''}">${esc(h)}${r.cheminResolu[k] ? ' ' + esc(r.cheminResolu[k].nom || '') : ''}</span>`).join(' › ') : '<small>direct</small>'}</td></tr>`).join('')}</tbody></table>
    <h4>Octets</h4>
    <div class="octets-mc">${seg.filter((s) => s[2].length).map(([k, l, b]) => `<div class="seg ${k}"><span>${esc(l)}</span><code>${b.join(' ')}</code></div>`).join('')}</div>
    <div class="boutons"><button data-copier="${esc(d.brut)}">Copier le paquet (hexa)</button></div>`;
  z.querySelectorAll('tr[data-mc]').forEach((tr) => (tr.onclick = () => { dlg.close(); mcOuvrirFiche(tr.dataset.mc); }));
}

// ---- Données et temps réel ---------------------------------------------------------------------------
// Chargement complet au démarrage et toutes les 10 min ; entre-temps, seulement les nœuds modifiés
async function mcChargerNoeuds(complet) {
  if (complet || !mc.heureNoeuds || Date.now() - mc.completNoeuds > 600000) {
    const l = await api('/api/mc/noeuds');
    mc.noeuds = new Map(l.map((n) => [n.cle, n]));
    mc.heureNoeuds = mc.completNoeuds = Date.now();
  } else {
    const r = await api('/api/mc/noeuds?depuis=' + mc.heureNoeuds);
    for (const n of r.noeuds) mc.noeuds.set(n.cle, n);
    mc.heureNoeuds = r.heure;
  }
  mcDessinerNoeuds();
  if ($('#mc-liste') && mc.vue === 'noeuds') mcRendreNoeuds();
  mcMajKpis();
  mcMajAlertes();
}
// Durée d'affichage des liens MeshCore, distincte de celle de Meshtastic (le flux national accumule vite) : 1 h par défaut
function mcFenetreHeures() { try { return Number(localStorage.getItem('gaulix_mc_fenetre')) || 1; } catch { return 1; } }
async function mcChargerLiens(complet) {
  const h = mcFenetreHeures();
  if (complet || !mc.heureLiens || mc.fenetreLiens !== h || Date.now() - mc.completLiens > 600000) {
    mc.liens = await api('/api/mc/liens?heures=' + h);
    mc.heureLiens = mc.completLiens = Date.now(); mc.fenetreLiens = h;
  } else {
    const r = await api(`/api/mc/liens?heures=${h}&depuis=${mc.heureLiens}`);
    const cle = (l) => `${l.a}|${l.b}|${l.source}`;
    const m = new Map(mc.liens.map((l) => [cle(l), l]));
    for (const l of r.liens) m.set(cle(l), l);
    const limite = Date.now() - h * 3600000;
    mc.liens = [...m.values()].filter((l) => l.dernierVu >= limite);
    mc.heureLiens = r.heure;
  }
  mcDessinerLiens();
}
let mcRafraichir = null, mcMinuterieMsg = null;
function mcMessagesARafraichir() {
  if (mc.vue !== 'messages' || !$('[data-vue="meshcore"]').classList.contains('actif')) { const b = document.querySelector('.sous-onglets-mc button[data-mc-vue="messages"]'); if (b && mc.vue !== 'messages') b.classList.add('nouveau'); return; }
  if (document.activeElement && document.activeElement.id === 'mc-texte' && $('#mc-texte').value) return setTimeout(mcMessagesARafraichir, 4000);
  clearTimeout(mcMinuterieMsg);
  mcMinuterieMsg = setTimeout(() => { if (mc.vue === 'messages') mcRendreMessages(); }, 600);
}
function mcPlanifier() {
  if (mcRafraichir) return;
  mcRafraichir = setTimeout(async () => { mcRafraichir = null; await Promise.all([mcChargerNoeuds(), mcChargerLiens()]).catch(() => {}); rendreLegende(); }, 10000);
}
function mcRecevoir(m) {
  if (m.genre === 'mc-paquet') {
    const inconnu = (k) => k && !mc.noeuds.has(k);
    if (m.nouveauNoeud || inconnu(m.de) || inconnu(m.observateur)) mcPlanifier();
    else {
      const n = m.de && mc.noeuds.get(m.de);
      if (n) { n.dernierVu = m.heure; if (n.statut !== 'actif') { n.statut = 'actif'; mcDessinerNoeuds(); } }
      if (m.chemin && m.chemin.length && Math.random() < 0.2) mcPlanifier();
    }
    mcAnimer(m);
    mcAjouterAuFlux(m);
    mcNoterActivite(m.de); (m.cheminResolu || []).forEach(mcNoterActivite);
    if (m.texte && m.premiere && etat.membre) { mcNoterMessageRecu({ canal: m.canal }); mcMessagesARafraichir(); }
  } else if (m.genre === 'mc-etat') {
    mc.etat = { ...(mc.etat || {}), stats: m.stats, companion: { ...((mc.etat && mc.etat.companion) || {}), ...m.companion } };
    if (m.alertes) mc.etat.alertes = m.alertes;
    mcMajKpis();
    mcMajSource();
    mcMajAlertes();
    if (etat.admin && mc.vue === 'companion') mcChargerEtat();
  } else if (m.genre === 'mc-noeuds') mcPlanifier();
  else if (m.genre === 'mc-message' && etat.membre) { if (m.sens === 'recu') mcNoterMessageRecu(m); mcMessagesARafraichir(); }
}
// Messages MeshCore non lus (même réglage de sons que Meshtastic : bip par nom de canal, alerte des messages directs)
function mcNoterMessageRecu(m) {
  if (typeof nonLus === 'undefined') return;
  const k = m.direct ? 'mcdirect' : 'mc:' + String(m.canal || '?').toLowerCase();
  const vu = !document.hidden && mc.vue === 'messages' && $('[data-vue="meshcore"]') && $('[data-vue="meshcore"]').classList.contains('actif') && mcFiltreVoit(k);
  if (typeof noterDernierRecu === 'function') noterDernierRecu(k);
  if (!vu) { nonLus[k] = (nonLus[k] || 0) + 1; ecrireLs('gaulix_non_lus', nonLus); }
  if (m.direct) { if (sons.direct) bip([880, 1320, 1760], 0.12); afficherAlerteDirect(`✉️ Message direct MeshCore de ${m.nomDe || 'inconnu'}`, m.texte); }
  else if (sons.canaux[String(m.canal || '').toLowerCase()]) bip([noteCanal(String(m.canal).toLowerCase())], 0.18);
  majBadgesMessages();
}
function mcMajBadgeMessages() {
  const n = Object.entries(nonLus).filter(([k]) => k.startsWith('mc')).reduce((a, [, x]) => a + x, 0);
  const b = document.querySelector('.sous-onglets-mc button[data-mc-vue="messages"]');
  if (b) {
    let s = b.querySelector('.badge-non-lus');
    if (!s) { b.insertAdjacentHTML('beforeend', ' <span class="badge-non-lus"></span>'); s = b.querySelector('.badge-non-lus'); }
    s.textContent = n ? String(n) : ''; s.hidden = !n; s.classList.toggle('direct', !!nonLus.mcdirect);
  }
  const o = document.querySelector('.onglets button[data-onglet="meshcore"]');
  if (o) {
    let s = o.querySelector('.badge-non-lus');
    if (!s) { o.insertAdjacentHTML('beforeend', ' <span class="badge-non-lus"></span>'); s = o.querySelector('.badge-non-lus'); }
    s.textContent = n ? String(n) : ''; s.hidden = !n; s.classList.toggle('direct', !!nonLus.mcdirect);
  }
}
// Ce que la liste MeshCore affichée montre : tout, les directs ou un canal (« Relayés » ne vaut pas lecture)
const mcFiltreVoit = (k) => !mcFiltreMsg || (mcFiltreMsg === 'direct' ? k === 'mcdirect' : mcFiltreMsg.startsWith('c:') && k === 'mc:' + mcFiltreMsg.slice(2).toLowerCase());
function mcMarquerLus() {
  if (typeof nonLus === 'undefined' || document.hidden) return;
  let ch = false;
  for (const k of Object.keys(nonLus)) if (k.startsWith('mc') && mcFiltreVoit(k)) { delete nonLus[k]; ch = true; }
  if (ch) { ecrireLs('gaulix_non_lus', nonLus); majBadgesMessages(); }
}

function demarrerMeshcore() {
  mc.actif = !!etat.config.meshcore;
  if (!mc.actif) { appliquerVueReseau(); return; }
  mc.coucheLiens = L.layerGroup().addTo(carte);
  mc.couche = L.layerGroup().addTo(carte);
  // Bandeau : choix du réseau et indicateurs MeshCore
  $('#panneau').insertAdjacentHTML('afterbegin', `<div class="choix-reseau" role="group" aria-label="Réseau affiché"><span>Réseau</span>
    <button data-reseau="meshtastic" title="Afficher seulement le réseau Meshtastic">Meshtastic</button>
    <button data-reseau="meshcore" title="Afficher seulement le réseau MeshCore">MeshCore</button>
    <button data-reseau="les-deux" title="Superposer les deux réseaux">Les deux</button></div>`);
  document.querySelectorAll('.choix-reseau button').forEach((b) => (b.onclick = () => { etat.vueReseau = b.dataset.reseau; appliquerVueReseau(); }));
  $('.kpis').insertAdjacentHTML('beforeend', `
    <div class="kpi kpi-mc"><b id="k-mc-actifs">–</b><span>MeshCore actifs</span></div>
    <div class="kpi kpi-mc mc-seul"><b id="k-mc-repeteurs">–</b><span>répéteurs</span></div>
    <div class="kpi kpi-mc mc-seul"><b id="k-mc-obs">–</b><span>observateurs</span></div>
    <div class="kpi kpi-mc mc-seul"><b id="k-mc-liens">–</b><span>liens</span></div>
    <div class="kpi kpi-mc"><b id="k-mc-debit">–</b><span>MC paquets / min</span></div>`);
  // Onglet du panneau
  document.querySelectorAll('.sous-onglets-mc button').forEach((b) => (b.onclick = () => {
    mc.vue = b.dataset.mcVue;
    b.classList.remove('nouveau');
    try { localStorage.setItem('gaulix_mc_vue', mc.vue); } catch { /* idem */ }
    if (mc.vue === 'companion') mcChargerEtat();
    $('#mc-contenu').innerHTML = '';
    mcRendrePanneau();
  }));
  const ong = document.querySelector('.onglets button[data-onglet="meshcore"]');
  ong.addEventListener('click', () => mcRendrePanneau());
  const sv = document.querySelector('.sous-onglets-mc button[data-mc-vue="messages"]');
  if (sv) sv.hidden = !etat.membre;
  if (!etat.membre && mc.vue === 'messages') mc.vue = 'noeuds';
  const sg = document.querySelector('.sous-onglets-mc button[data-mc-vue="gestion"]');
  if (sg) sg.hidden = !etat.gestion;
  if (!etat.gestion && mc.vue === 'gestion') mc.vue = 'noeuds';
  // Clic sur un message : répondre (message direct reçu) ou écrire sur son canal
  document.body.addEventListener('click', (e) => {
    const r = e.target.closest('[data-mc-repondre], [data-mc-canal]');
    if (!r || !etat.admin) return;
    mc.destMessage = r.dataset.mcRepondre ? 'direct:' + r.dataset.mcRepondre : 'canal:' + r.dataset.mcCanal;
    mcRendreMessages().then(() => { const t = $('#mc-texte'); if (t) t.focus(); });
  });
  // Clics dans les listes (nœuds, paquets) : délégation
  document.body.addEventListener('click', (e) => {
    const p = e.target.closest('[data-mc-paquet]');
    if (p && !e.target.closest('dialog')) { mcOuvrirPaquet(p.dataset.mcPaquet); return; }
    const l = e.target.closest('.ligne[data-mc]');
    if (l && !l.closest('#fiche')) {
      const n = mc.noeuds.get(l.dataset.mc);
      if (n && n.lat != null) carte.flyTo([n.lat, n.lon], Math.max(carte.getZoom(), 11), { duration: 0.6 });
      mcOuvrirFiche(l.dataset.mc);
    }
  });
  let minuterieVue = null;
  carte.on('moveend', () => { clearTimeout(minuterieVue); minuterieVue = setTimeout(() => { mc.emprise = null; mcDessinerNoeuds(); mcDessinerLiens(); if (!etat.zone) mcMajAlertes(); }, 250); });
  $('#fermer-fiche').addEventListener('click', () => { mc.selection = null; });
  Promise.all([mcChargerNoeuds(), mcChargerLiens(), mcChargerEtat()]).then(() => { appliquerVueReseau(); }).catch(() => appliquerVueReseau());
  setInterval(() => mcChargerLiens().catch(() => {}), 120000);
  setInterval(mcDessinerChaleur, 20000);
  setInterval(() => { mcChargerNoeuds().catch(() => {}); }, 60000);
}
