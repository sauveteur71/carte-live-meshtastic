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
  nav: { etat: 'aucun', ws: null, port: null, lecteur: null, ecrivain: null, ble: null, type: null, erreur: null },
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
  return etat.couches.inactifs || n.statut !== 'inactif' || n.infrastructure;
}

// ---- Choix du réseau affiché : Meshtastic, MeshCore ou les deux ------------------------------------
etat.vueReseau = (() => { try { return localStorage.getItem('gaulix_reseau') || 'les-deux'; } catch { return 'les-deux'; } })();
function appliquerVueReseau() {
  if (!mc.actif) etat.vueReseau = 'meshtastic';
  try { localStorage.setItem('gaulix_reseau', etat.vueReseau); } catch { /* stockage indisponible */ }
  document.body.dataset.reseau = etat.vueReseau;
  document.querySelectorAll('.choix-reseau button').forEach((b) => b.classList.toggle('actif', b.dataset.reseau === etat.vueReseau));
  const ong = document.querySelector('.onglets button[data-onglet="meshcore"]');
  if (ong) ong.hidden = etat.vueReseau === 'meshtastic';
  // Onglets propres à Meshtastic masqués en vue MeshCore seule
  for (const o of ['trafic', 'gestion', 'messages']) {
    const b = document.querySelector(`.onglets button[data-onglet="${o}"]`);
    if (b && !b.dataset.cacheInitial) b.dataset.cacheInitial = b.hidden ? '1' : '0';
    if (b) b.hidden = b.dataset.cacheInitial === '1' || etat.vueReseau === 'meshcore';
  }
  const actif = document.querySelector('.onglets button.actif');
  if (etat.vueReseau === 'meshcore' && (!actif || actif.hidden || ['reseau', 'noeuds'].includes(actif.dataset.onglet))) ong && ong.click();
  if (etat.vueReseau === 'meshtastic' && actif && actif.dataset.onglet === 'meshcore') document.querySelector('.onglets button[data-onglet="reseau"]').click();
  dessinerNoeuds();
  dessinerLiens();
  mcRedessiner();
  rendreLegende();
  mcMajKpis();
  mcMajAlertes();
  mcDessinerChaleur();
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
  for (const [cle, m] of mc.marqueurs) {
    const n = mc.noeuds.get(cle);
    if (!n || !mcVisible(n)) { m.remove(); mc.marqueurs.delete(cle); }
  }
  for (const n of mc.noeuds.values()) {
    if (!mcVisible(n)) continue;
    let m = mc.marqueurs.get(n.cle);
    if (!m) {
      m = L.marker([n.lat, n.lon], { icon: mcIcone(n), riseOnHover: true, zIndexOffset: n.infrastructure ? 600 : 100 });
      m.on('click', () => {
        if (etat.modeProfil) { choisirPointProfil({ lat: n.lat, lon: n.lon, nom: n.nom || n.id, h: n.infrastructure ? 6 : 2 }); return; }
        mcOuvrirFiche(n.cle);
      });
      m.bindTooltip('', { className: 'info', direction: 'top', offset: [0, -8] });
      m.addTo(mc.couche);
      mc.marqueurs.set(n.cle, m);
    } else {
      m.setLatLng([n.lat, n.lon]);
      m.setIcon(mcIcone(n));
    }
    m.setTooltipContent(`<b>${esc(n.nom || n.id)}</b> <small>MeshCore</small><br>${esc(mcRole(n.role).un)}${n.observateur ? ' · observateur' : ''} · ${ilYa(n.dernierVu)}` +
      (n.sautsMin != null ? `<br>${n.sautsMin === 0 ? 'entendu en direct' : n.sautsMin + ' saut' + (n.sautsMin > 1 ? 's' : '') + ' au mieux'}` : '') +
      (n.snr != null ? ` · SNR ${fmt(n.snr, 1, ' dB')}` : ''));
  }
}
function mcDessinerLiens() {
  if (!mc.coucheLiens) return;
  mc.coucheLiens.clearLayers();
  if (!mcAffiche()) return;
  const maintenant = Date.now(), fenetre = Number($('#fenetre').value) * 3600000;
  const fusion = new Map();
  for (const l of mc.liens) {
    if (!mc.couches[l.source]) continue;
    if (maintenant - l.dernierVu > fenetre) continue;
    const a = mc.noeuds.get(l.a), b = mc.noeuds.get(l.b);
    if (!a || !b || a.lat == null || b.lat == null) continue;
    if (etat.zone && !mcDansZone(a) && !mcDansZone(b)) continue;
    const cle = [l.a < l.b ? l.a : l.b, l.a < l.b ? l.b : l.a, l.source].join(':');
    const f = fusion.get(cle);
    if (!f) fusion.set(cle, { ...l, na: a, nbN: b });
    else { f.nb += l.nb; f.dernierVu = Math.max(f.dernierVu, l.dernierVu); if (l.snr != null && (f.snr == null || l.snr > f.snr)) f.snr = l.snr; }
  }
  for (const l of fusion.values()) {
    const age = (maintenant - l.dernierVu) / fenetre;
    const ligne = L.polyline([[l.na.lat, l.na.lon], [l.nbN.lat, l.nbN.lon]], {
      pane: 'liens', color: l.source === 'chemin' && l.snr == null ? '#fb923c' : couleurSnr(l.snr),
      weight: Math.min(1 + Math.log2(1 + l.nb) * 0.6, 4), opacity: Math.max(0.2, 0.85 - age * 0.7),
      dashArray: l.source === 'chemin' ? '5 6' : l.source === 'trace' ? '2 5' : l.source === 'voisinage' ? '9 4 2 4' : null, className: 'lien-mc',
    });
    const d = distanceKm(l.na, l.nbN);
    ligne.bindTooltip(`<b>${esc(l.na.nom || l.na.id)} ↔ ${esc(l.nbN.nom || l.nbN.id)}</b> <small>MeshCore</small><br>` +
      `${{ rf: 'Liaison radio mesurée (dernier saut vers un observateur)', chemin: 'Liaison déduite du chemin d’un paquet', trace: 'Trace (SNR mesuré au saut)', voisinage: 'Voisin déclaré par le répéteur (SNR mesuré par lui)' }[l.source]}` +
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
  const pts = [];
  const ajouter = (cle) => { const n = cle && mc.noeuds.get(cle); if (n && n.lat != null) { pts.push([n.lat, n.lon]); mcFlasher(cle); } };
  if (p.chemin && p.chemin.length && p.cheminResolu) {
    if (p.de) ajouter(p.de);
    for (const c of p.cheminResolu) ajouter(c);
  } else if (p.sauts === 0 && p.de) ajouter(p.de);
  ajouter(p.observateur);
  if (etat.zone && !pts.some(([lat, lon]) => { const z = etat.config.zone; return lat >= z[0] && lat <= z[2] && lon >= z[1] && lon <= z[3]; })) return;
  const coul = mcType(p.type).hex;
  if (pts.length >= 2) {
    const t = L.polyline(pts, { pane: 'traces', color: coul, weight: 3, opacity: 1, className: 'trace' }).addTo(carte);
    setTimeout(() => t.remove(), 1900);
  }
  const fin = pts[pts.length - 1];
  if (fin) {
    const onde = L.marker(fin, { icon: L.divIcon({ className: '', html: `<div class="onde" style="border-color:${coul}"></div>`, iconSize: [10, 10], iconAnchor: [5, 5] }), interactive: false, pane: 'traces' }).addTo(carte);
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
function mcRendreNoeuds() {
  const z = $('#mc-contenu');
  if (!z.querySelector('#mc-recherche')) {
    z.innerHTML = `<div class="recherche"><input id="mc-recherche" type="search" placeholder="Nom ou début de clé…" autocomplete="off">
      <select id="mc-tri"><option value="vu">Dernier entendu</option><option value="nom">Nom</option><option value="role">Type</option><option value="sauts">Sauts</option></select></div>
      <div id="mc-resume" class="note"></div><div id="mc-liste" class="liste"></div>`;
    $('#mc-recherche').oninput = mcRendreNoeuds;
    $('#mc-tri').onchange = mcRendreNoeuds;
  }
  const f = $('#mc-recherche').value.trim().toLowerCase(), tri = $('#mc-tri').value;
  const liste = [...mc.noeuds.values()].filter((n) => mcDansZone(n) && (!f || (n.nom || '').toLowerCase().includes(f) || n.cle.toLowerCase().startsWith(f)));
  const ordreRole = { repeteur: 0, salon: 1, capteur: 2, companion: 3, inconnu: 4 };
  liste.sort({
    vu: (a, b) => (b.dernierVu || 0) - (a.dernierVu || 0),
    nom: (a, b) => (a.nom || a.id).localeCompare(b.nom || b.id),
    role: (a, b) => (ordreRole[a.role] ?? 9) - (ordreRole[b.role] ?? 9) || (b.dernierVu || 0) - (a.dernierVu || 0),
    sauts: (a, b) => (a.sautsMin ?? 99) - (b.sautsMin ?? 99),
  }[tri]);
  const c = (r) => liste.filter((n) => n.role === r).length;
  $('#mc-resume').textContent = `${liste.length} nœud(s) : ${c('repeteur')} répéteur(s), ${c('salon')} room server(s), ${c('companion')} companion(s)${c('capteur') ? `, ${c('capteur')} capteur(s)` : ''}`;
  $('#mc-liste').innerHTML = liste.length ? liste.slice(0, 400).map((n) => {
    const sauts = n.sautsMin == null ? '' : n.sautsMin === 0 ? 'direct · ' : `${n.sautsMin} saut${n.sautsMin > 1 ? 's' : ''} · `;
    return `<div class="ligne" data-mc="${n.cle}"><span class="point ${n.statut}"></span><span class="titre"><i class="role-mc ${n.role}" style="--mcc:${mcRole(n.role).hex}"></i>${esc(n.nom || n.id)}<small>${esc(mcRole(n.role).un)}${n.observateur ? ' · observateur' : ''}</small></span><span class="meta">${sauts}${ilYa(n.dernierVu)}</span></div>`;
  }).join('') : '<div class="vide">Aucun nœud MeshCore pour l’instant : reliez un companion (onglet Companion) ou abonnez la carte à un flux MQTT MeshCore.</div>';
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
  while (flux.children.length > 300) flux.lastElementChild.remove();
}

// ---- Messages : lecture (membres), envoi sur un canal ou en direct (admin, par le companion) ----------
async function mcRendreMessages() {
  const z = $('#mc-contenu');
  if (!etat.membre) { z.innerHTML = '<div class="vide">Connectez-vous pour lire les messages MeshCore.</div>'; return; }
  let l = [];
  try { l = await api('/api/mc/messages?limite=300'); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  if (mc.vue !== 'messages') return;
  const c = (mc.etat && mc.etat.companion) || {};
  const canaux = c.canaux || [];
  const peutEnvoyer = etat.admin && c.connecte;
  const dest = mc.destMessage || (canaux[0] ? 'canal:' + canaux[0].index : '');
  const destDirect = dest.startsWith('direct:') ? dest.slice(7) : null;
  const ancienTexte = $('#mc-texte') ? $('#mc-texte').value : '';
  z.innerHTML = `
    ${peutEnvoyer ? `<form id="mc-envoi" class="envoi">
      <div class="envoi-ligne"><select id="mc-dest" aria-label="Destinataire">
        ${canaux.map((x) => `<option value="canal:${x.index}" ${dest === 'canal:' + x.index ? 'selected' : ''}>Canal ${esc(x.nom)}</option>`).join('')}
        ${destDirect ? `<option value="direct:${destDirect}" selected>✉️ ${esc(mcNom(destDirect))} (direct)</option>` : ''}
        <option value="choisir">✉️ Message direct à…</option>
      </select><span class="compteur" id="mc-compteur">0/140</span></div>
      <div class="envoi-ligne"><textarea id="mc-texte" rows="2" maxlength="140" placeholder="Votre message (envoyé par ${esc(c.nom || 'le companion')})…" required></textarea><button type="submit" class="principal">Envoyer</button></div>
      <div class="note" id="mc-retour-envoi"></div>
    </form>` : `<p class="note">${etat.admin ? 'Reliez un companion (onglet Companion) pour envoyer des messages.' : 'L’envoi est réservé aux administrateurs.'}</p>`}
    <div id="mc-messages" class="flux">${l.length ? l.map(mcLigneMessage).join('') : '<div class="vide">Aucun message pour l’instant.</div>'}</div>`;
  if (!peutEnvoyer) return;
  const ta = $('#mc-texte');
  ta.value = ancienTexte;
  const compter = () => { const n = new TextEncoder().encode(ta.value).length; $('#mc-compteur').textContent = `${n}/140`; $('#mc-compteur').classList.toggle('trop', n > 140); };
  ta.oninput = compter; compter();
  ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#mc-envoi').requestSubmit(); } };
  $('#mc-dest').onchange = (e) => {
    if (e.target.value === 'choisir') {
      const q = prompt('Nom (ou début) du destinataire MeshCore :');
      const n = q && [...mc.noeuds.values()].find((x) => (x.nom || '').toLowerCase().includes(q.toLowerCase().trim()));
      if (q && !n) alert('Aucun nœud MeshCore de ce nom sur la carte.');
      if (n) mc.destMessage = 'direct:' + n.cle;
      mcRendreMessages();
      return;
    }
    mc.destMessage = e.target.value;
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
function mcLigneMessage(m) {
  const qui = m.sens === 'envoye' ? `<b>${esc(m.nomDe || 'moi')}</b>${m.genre === 'direct' ? ` → ${esc(m.nomVers || mcNom(m.vers))}` : ''}` : `<b>${esc(m.nomDe || '?')}</b>${m.genre === 'direct' ? ' → moi' : ''}`;
  const lieu = m.genre === 'direct' ? 'Direct' : m.canal || '';
  return `<div class="paquet mc message-mc ${m.sens}" ${m.genre === 'direct' && m.sens === 'recu' && m.de ? `data-mc-repondre="${m.de}"` : m.genre === 'canal' && m.indexCanal != null ? `data-mc-canal="${m.indexCanal}"` : ''}>
    <div class="entete"><span class="heure">${new Date(m.heure).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span><span class="tag"><i style="background:${m.genre === 'direct' ? MC_TYPES.message.hex : MC_TYPES.canal.hex}"></i>${esc(lieu)}</span>
    ${m.sauts != null ? `<span>${m.sauts === 0 ? 'direct' : m.sauts + ' saut' + (m.sauts > 1 ? 's' : '')}</span>` : ''}${m.sens === 'envoye' ? `<span class="statut-msg ${m.statut || ''}">${STATUTS_MSG[m.statut] || ''}${m.relais > 1 ? ' ×' + m.relais : ''}</span>` : ''}</div>
    <div class="corps">${qui} : ${esc(m.texte)}</div></div>`;
}

// ---- Analyse du trafic MeshCore ----------------------------------------------------------------
async function mcRendreAnalyse() {
  const z = $('#mc-contenu');
  const h = mc.heuresAnalyse || 24;
  z.innerHTML = `<div class="recherche"><select id="mc-periode">${[[1, 'Dernière heure'], [6, '6 dernières heures'], [24, '24 dernières heures'], [168, '7 jours']].map(([v, l]) => `<option value="${v}" ${v === h ? 'selected' : ''}>${l}</option>`).join('')}</select></div><div id="mc-analyse"><div class="vide">Calcul…</div></div>`;
  $('#mc-periode').onchange = (e) => { mc.heuresAnalyse = Number(e.target.value); mcRendreAnalyse(); };
  let a;
  try { a = await api('/api/mc/analyse?heures=' + h); } catch (e) { $('#mc-analyse').innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
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
    <p class="note">Occupation : temps d’émission cumulé des paquets distincts (réglage MeshCore France, SF8 · 62,5 kHz), sans compter les répétitions par les relais.</p>
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
const MC_TACHES = { lire: 'Lire la configuration', statut: 'État', voisins: 'Voisins', verifier: 'Vérification de conformité', modifier: 'Modification', cli: 'Commande', annonce: 'Annonce', horloge: 'Horloge', redemarrer: 'Redémarrage' };
const MC_STATUTS = { en_attente: 'en attente', en_cours: 'en cours…', ok: 'réussi', echec: 'échec', annule: 'arrêté' };
async function mcRendreGestion() {
  const z = $('#mc-contenu');
  if (!etat.admin) { z.innerHTML = '<div class="vide">Réservé aux administrateurs.</div>'; return; }
  try { mcGestion.info = await api('/api/mc/admin'); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  if (mc.vue !== 'gestion') return;
  const i = mcGestion.info;
  const liste = [...mc.noeuds.values()].filter((n) => ['repeteur', 'salon', 'capteur'].includes(n.role) && mcDansZone(n)).sort((a, b) => (a.nom || '').localeCompare(b.nom || ''));
  const sel = mcGestion.selection;
  z.innerHTML = `
    ${i.companion.connecte ? '' : '<div class="alerte attention">Aucun companion relié : l’administration passe par lui (onglet Companion).</div>'}
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
      <details class="elements-mc"><summary>Éléments comparés par la vérification</summary>
        ${i.elements.map((e) => `<label class="case"><input type="checkbox" name="el" value="${e}" ${i.elementsDefaut.includes(e) ? 'checked' : ''}> ${esc((i.params.find((p) => p.cle === e) || {}).nom || e)}</label>`).join('')}
      </details>
      <div class="actions-prop">
        <button type="button" data-mc-op="lire" class="principal">Lire la configuration</button>
        <button type="button" data-mc-op="statut">État</button>
        <button type="button" data-mc-op="voisins">Voisins</button>
        <button type="button" data-mc-op="verifier">Vérifier la conformité</button>
        <button type="button" data-mc-op="horloge">Mettre à l’heure</button>
        <button type="button" data-mc-op="annonce">Annonce</button>
      </div>
      <p class="erreur" id="mc-g-retour"></p>
    </form>
    <div id="mc-g-tache"></div>
    <h4>Dernières opérations</h4>
    <div class="liste">${i.taches.map((t) => `<div class="ligne" data-mc-tache="${t.id}"><span class="point ${t.statut === 'ok' ? 'actif' : t.statut === 'en_cours' || t.statut === 'en_attente' ? 'recent' : 'alerte'}"></span><span class="titre">${esc(MC_TACHES[t.type] || t.type)}<small>${t.cles.map((k) => esc(t.noms[k] || k.slice(0, 6))).join(', ')}</small></span><span class="meta">${MC_STATUTS[t.statut]} · ${ilYa(t.creee)}</span></div>`).join('') || '<div class="vide">Aucune.</div>'}</div>`;
  z.querySelectorAll('[data-mc-sel]').forEach((c) => (c.onchange = () => { if (c.checked) sel.add(c.dataset.mcSel); else sel.delete(c.dataset.mcSel); z.querySelector('.actions-prop .note').textContent = `${sel.size} coché(s)`; }));
  z.querySelector('[data-mc-tout]').onclick = () => { liste.forEach((n) => sel.add(n.cle)); mcRendreGestion(); };
  z.querySelector('[data-mc-rien]').onclick = () => { sel.clear(); mcRendreGestion(); };
  z.querySelectorAll('[data-mc-fiche]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); mcOuvrirFiche(b.dataset.mcFiche, 'admin'); }));
  z.querySelectorAll('[data-mc-tache]').forEach((l) => (l.onclick = () => mcSuivreTache(l.dataset.mcTache, $('#mc-g-tache'))));
  z.querySelectorAll('[data-mc-op]').forEach((b) => (b.onclick = async () => {
    const f = $('#mc-f-gestion');
    const type = b.dataset.mcOp;
    if (!sel.size) { $('#mc-g-retour').textContent = 'Cochez au moins un nœud.'; return; }
    const ordre = [...sel];
    const params = { motDePasse: f.mdp.value || undefined, memoriser: f.memoriser.checked, elements: [...f.querySelectorAll('[name=el]:checked')].map((x) => x.value) };
    if (type === 'annonce') params.inondation = confirm('Annonce relayée par tout le réseau ?\nOK = tout le réseau · Annuler = voisins directs seulement');
    try {
      const t = await postJson('/api/mc/admin/taches', { type, cles: ordre, params });
      f.mdp.value = '';
      mcSuivreTache(t.id, $('#mc-g-tache'));
    } catch (err) { $('#mc-g-retour').textContent = err.message; }
  }));
  if (mcGestion.tache) mcSuivreTache(mcGestion.tache, $('#mc-g-tache'));
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
    if (!['en_cours', 'en_attente'].includes(t.statut)) { clearInterval(mcGestion.suivi); if (apres) apres(t); }
  };
  tour();
  mcGestion.suivi = setInterval(tour, 1500);
}
function mcHtmlTache(t) {
  const enCours = ['en_cours', 'en_attente'].includes(t.statut);
  const r = t.rapport;
  return `<div class="tache-mc ${t.statut}">
    <div class="titre-tache"><b>${esc(MC_TACHES[t.type] || t.type)}</b> · ${MC_STATUTS[t.statut]}${t.courant ? ` · ${esc(t.noms[t.courant] || '')}` : ''}${enCours ? ' <span class="sablier"></span> <button class="mini" data-mc-arreter>Arrêter</button>' : ''}</div>
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
  if (!confirm(`Appliquer à « ${x.nom} » :\n${Object.entries(valeurs).map(([k, v]) => `• ${k} = ${v}`).join('\n')}${radio ? '\n\n⚠ Changer la radio d’un nœud distant peut le rendre injoignable s’il ne parle plus comme les autres. Un redémarrage sera nécessaire.' : ''}`)) return;
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
      </div>
      <div class="actions-prop">
        <button type="button" data-a="lire" class="principal">Lire la configuration</button><button type="button" data-a="statut">État</button><button type="button" data-a="voisins">Voisins</button>
        <button type="button" data-a="horloge">Mettre à l’heure</button><button type="button" data-a="annonce">Annonce</button><button type="button" data-a="redemarrer">Redémarrer</button>
        ${l.memorise ? '<button type="button" data-a="oublier">Oublier le mot de passe</button>' : ''}
      </div>
      ${lu.heure ? `<p class="note">Configuration lue ${ilYa(lu.heure)}${inf.version ? ` · ${esc(inf.version)}` : ''}${inf.carte ? ` · ${esc(inf.carte)}` : ''}</p>` : '<p class="note">Configuration jamais lue : commencez par « Lire la configuration ».</p>'}
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
    <div id="mc-adm-tache"></div>`;
  const f = $('#mc-f-adm');
  const lancer = async (type, params = {}) => {
    try {
      const t = await postJson('/api/mc/admin/taches', { type, cles: [n.cle], params: { ...params, motDePasse: f.mdp.value || undefined, memoriser: f.memoriser.checked } });
      f.mdp.value = '';
      $('#mc-adm-retour').textContent = '';
      mcSuivreTache(t.id, $('#mc-adm-tache'), (fin) => { if (['lire', 'statut', 'voisins', 'modifier'].includes(fin.type) && mc.selection === n.cle) mcRendreAdminFiche(n, z).then(() => { const zt = $('#mc-adm-tache'); if (zt) zt.innerHTML = mcHtmlTache(fin); }); });
    } catch (e) { $('#mc-adm-retour').textContent = e.message; }
  };
  f.querySelectorAll('[data-a]').forEach((b) => (b.onclick = async () => {
    const a = b.dataset.a;
    if (a === 'oublier') { await postJson('/api/mc/admin/mot-de-passe', { cle: n.cle, motDePasse: null }); mcRendreAdminFiche(n, z); return; }
    if (a === 'redemarrer' && !confirm(`Redémarrer « ${n.nom} » à distance ?`)) return;
    if (a === 'annonce') return lancer('annonce', { inondation: confirm('Annonce relayée par tout le réseau ?\nOK = tout le réseau · Annuler = voisins directs seulement') });
    if (a === 'cli') { const c = f.cli.value.trim(); if (c) lancer('cli', { commande: c }); return; }
    if (a === 'appliquer') {
      const valeurs = {};
      f.querySelectorAll('.reglages-mc [name]').forEach((x) => { if (x.value !== '' && x.value !== x.dataset.initial) valeurs[x.name] = x.value.trim(); });
      if (!Object.keys(valeurs).length) { $('#mc-adm-retour').textContent = 'Aucun réglage modifié.'; return; }
      if (!confirm(`Appliquer à « ${n.nom} » :\n${Object.entries(valeurs).map(([k, x]) => `• ${k} = ${x}`).join('\n')}${valeurs.radio ? '\n\n⚠ Changer la radio d’un nœud distant peut le rendre injoignable s’il ne parle plus comme les autres. Un redémarrage sera nécessaire.' : ''}`)) return;
      return lancer('modifier', { valeurs });
    }
    lancer(a);
  }));
  f.cli.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); f.querySelector('[data-a="cli"]').click(); } };
  z.querySelectorAll('tr[data-mc]').forEach((tr) => (tr.onclick = () => mcOuvrirFiche(tr.dataset.mc)));
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
  const a = ((mc.etat && mc.etat.alertes) || []).filter((x) => { const n = x.noeud && mc.noeuds.get(x.noeud); return !n || mcDansZone(n); });
  let z = $('#alertes-mc');
  if (!z) {
    const ref = $('#alertes');
    if (!ref) return;
    ref.insertAdjacentHTML('afterend', '<h3 id="titre-alertes-mc">Alertes MeshCore <span id="nb-alertes-mc" class="pastille">0</span></h3><div id="alertes-mc" class="liste-alertes"></div>');
    z = $('#alertes-mc');
    z.onclick = (e) => { const el = e.target.closest('[data-mc-alerte]'); if (el && el.dataset.mcAlerte) mcOuvrirFiche(el.dataset.mcAlerte); };
  }
  const cache = etat.vueReseau === 'meshtastic';
  $('#titre-alertes-mc').hidden = cache; z.hidden = cache;
  const p = $('#nb-alertes-mc');
  p.textContent = a.length;
  p.className = 'pastille' + (a.some((x) => x.niveau === 'critique') ? ' critique' : a.length ? ' attention' : '');
  z.innerHTML = a.length ? a.map((x) => `<div class="alerte ${x.niveau}" data-mc-alerte="${x.noeud || ''}">${esc(x.message)}<small>${x.niveau === 'critique' ? 'Critique' : 'Attention'} · depuis ${ilYa(x.depuis).replace('il y a ', '')}</small></div>`).join('') : '<div class="vide">Aucune alerte MeshCore.</div>';
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
function mcRendreCompanion() {
  const z = $('#mc-contenu');
  const e = mc.etat;
  if (!e) { z.innerHTML = '<div class="vide">Chargement…</div>'; mcChargerEtat(); return; }
  const c = e.companion, r = c.radio;
  const source = c.navigateur ? `relié par cette page ou une autre (${esc(c.nomNavigateur || '')})` : c.cible ? (c.cible.type === 'agent' ? `agent « ${esc(c.cible.hote.replace(/^agent-/, ''))} »` : `Wi-Fi ${esc(c.cible.hote)}:${c.cible.port}`) : 'aucun';
  const formOuvert = z.querySelector('#mc-f-reglages') && document.activeElement && z.contains(document.activeElement);
  if (formOuvert) return;
  z.innerHTML = `
    <h3>Companion de la carte</h3>
    <div class="bloc-usb ${c.connecte ? 'relie' : ''}">
      <div class="titre-usb"><span class="point ${c.connecte ? 'actif' : c.cible || c.navigateur ? 'recent' : 'inactif'}"></span><b>${esc(c.nom || 'Aucun companion relié')}</b><small>${c.connecte ? 'relié · ' + source : c.erreur ? esc(c.erreur) : source === 'aucun' ? 'choisissez une liaison ci-dessous' : 'en attente · ' + source}</small></div>
      ${c.cle ? `<div class="ident mono" title="Clé publique">${esc(c.cle.slice(0, 16))}… <button class="mini" data-copier="${esc(c.cle)}">Copier la clé</button></div>` : ''}
      ${c.connecte ? `<div class="grille">
        <div class="mesure"><span>Radio</span><b>${r ? `${fmt(r.freq, 3)} MHz` : '–'}</b></div>
        <div class="mesure"><span>BW · SF · CR</span><b>${r ? `${fmt(r.bw, 1)} · ${r.sf} · ${r.cr}` : '–'}</b></div>
        <div class="mesure"><span>Paquets captés</span><b>${c.paquets}</b></div>
        <div class="mesure"><span>Batterie</span><b>${c.batterieMv ? fmt(c.batterieMv / 1000, 2, ' V') : '–'}</b></div>
        <div class="mesure"><span>Contacts</span><b>${c.contacts ?? '–'}</b></div>
        <div class="mesure"><span>Relié depuis</span><b>${c.depuis ? ilYa(c.depuis).replace('il y a ', '') : '–'}</b></div>
      </div>
      <div class="note">${esc([c.modele, c.firmware].filter(Boolean).join(' · '))}${r && !(Math.abs(r.freq - 869.618) < 0.01 && r.bw === 62.5 && r.sf === 8 && r.cr === 8) ? ' · <b style="color:var(--attention)">réglage radio différent du réseau français (869,618 MHz, BW 62,5, SF8, CR8)</b>' : ''}</div>` : ''}
    </div>
    ${etat.admin ? `
    <div class="actions-prop">
      ${c.connecte ? '<button data-mc-act="annonce0" title="Annonce entendue seulement par les voisins directs">Annonce voisins</button><button data-mc-act="annonce1" title="Annonce relayée par les répéteurs">Annonce réseau</button><button data-mc-act="contacts" title="Relire les contacts du companion">Contacts</button>' : ''}
      ${c.cible || c.navigateur ? '<button data-mc-act="stop">Débrancher</button>' : ''}
    </div>
    ${c.canaux && c.canaux.length ? `<h4>Canaux du companion</h4><div class="actions-prop">${c.canaux.map((x) => `<button data-mc-qr-canal="${esc(x.nom)}" title="QR code du canal (avec sa clé)">🔳 ${esc(x.nom)}</button>`).join('')}</div>` : ''}
    <h4>Relier un companion</h4>
    <p class="note">La carte se sert du companion comme <b>observateur</b> : il lui transmet chaque paquet MeshCore qu’il entend, avec le SNR. Il ne peut servir qu’un client à la fois (l’appli du téléphone sera déconnectée).</p>
    <div class="bloc-usb">
      <div class="titre-usb"><b>Branché sur ce PC</b><small>${mc.nav.etat === 'relie' ? 'relayé par cette page · gardez l’onglet ouvert' : mc.nav.erreur ? esc(mc.nav.erreur) : 'USB (firmware « companion USB ») ou Bluetooth'}</small></div>
      <div class="actions-prop">${mc.nav.etat === 'relie' || mc.nav.etat === 'connexion' ? '<button data-mc-act="nav-stop">Débrancher</button>' : '<button data-mc-act="usb" class="principal-usb">🔌 USB</button><button data-mc-act="ble">📶 Bluetooth</button>'}</div>
    </div>
    <form id="mc-f-wifi" class="parametres compact">
      <label>Companion Wi-Fi <input name="hote" placeholder="192.168.1.50" value="${esc(c.cible && c.cible.type === 'tcp' ? c.cible.hote : '')}" required></label>
      <label>Port <input name="port" type="number" value="${c.cible && c.cible.type === 'tcp' ? c.cible.port : 5000}" min="1" max="65535" style="width:80px"></label>
      <button type="submit" class="principal">Relier</button>
    </form>
    <h4>Par un agent (companion USB sur un autre PC)</h4>
    ${(e.agents || []).length ? `<div class="liste">${e.agents.map((a) => `<div class="ligne"><span class="point ${a.occupe ? 'actif' : 'recent'}"></span><span class="titre">${esc(a.nom)}<small>${esc(a.source)}</small></span><span class="meta"><button class="mini" data-mc-agent="${esc(a.hote)}">${c.cible && c.cible.hote === a.hote ? 'Choisi' : 'Utiliser'}</button></span></div>`).join('')}</div>` : '<div class="vide">Aucun agent en ligne. L’agent se télécharge dans Réseau › Modules radio › Module par agent (choisissez le port COM du companion).</div>'}
    <h4>Republication MQTT</h4>
    <div class="note">${e.republication.actif ? `${e.republication.connecte ? '● connecté' : '○ en attente'} · ${e.republication.publies} paquet(s) publié(s) sur <span class="mono">${esc(e.republication.sujet)}</span>${e.republication.refus ? ` · <b style="color:var(--attention)">${esc(e.republication.refus)}</b>` : ''}` : 'désactivée'}</div>
    <form id="mc-f-reglages" class="form-edit">
      <div class="grille-edit">
        <label>Code de zone (IATA) <input name="iata" value="${esc(e.reglages.iata)}" maxlength="8"><small>LPY = Le Puy</small></label>
        <label>Racine des sujets <input name="racine" value="${esc(e.reglages.racine)}"></label>
        <label class="case"><input type="checkbox" name="republier" ${e.reglages.republier ? 'checked' : ''}> Republier les paquets du companion</label>
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
      if (a === 'usb') return mcBrancherUsb();
      if (a === 'ble') return mcBrancherBle();
      if (a === 'nav-stop') return mcDebrancherNav();
      if (a === 'stop') await api('/api/mc/companion', { method: 'DELETE' });
      if (a === 'annonce0' || a === 'annonce1') { await postJson('/api/mc/companion/annonce', { inondation: a === 'annonce1' }); b.textContent = 'Envoyée ✓'; return; }
      if (a === 'contacts') { await postJson('/api/mc/companion/contacts'); b.textContent = 'Demandé ✓'; return; }
      setTimeout(mcChargerEtat, 800);
    } catch (err) { retour(err.message); }
  }));
  z.querySelectorAll('[data-mc-qr-canal]').forEach((b) => (b.onclick = () => mcOuvrirQr({ canal: b.dataset.mcQrCanal })));
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
    if (!confirm('Enregistrer ces réglages MeshCore ? Le service redémarre (quelques secondes).')) return;
    try { await postJson('/api/mc/reglages', { iata: f.iata.value.trim(), racine: f.racine.value.trim(), republier: f.republier.checked, canaux: f.canaux.value }); attendreRedemarrage('Réglages MeshCore enregistrés'); } catch (err) { retour(err.message); }
  };
}

// Companion branché sur ce PC : la page relaie le flux (USB tel quel ; Bluetooth trame par trame)
const MC_BLE_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e', MC_BLE_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e', MC_BLE_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
function mcMajNav(e, erreur) { mc.nav.etat = e; mc.nav.erreur = erreur || null; if (mc.vue === 'companion') mcRendreCompanion(); setTimeout(mcChargerEtat, 2500); }
function mcOuvrirWs(source, versCompanion) {
  return new Promise((ok, ko) => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/meshcore?source=${source}&nom=${encodeURIComponent(source + ' ' + ((etat.config.compte && etat.config.compte.identifiant) || ''))}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ok(ws);
    ws.onerror = () => ko(new Error('connexion au serveur refusée (êtes-vous connecté en admin ?)'));
    ws.onmessage = (ev) => { if (ev.data instanceof ArrayBuffer) versCompanion(new Uint8Array(ev.data)); };
    ws.onclose = () => { if (mc.nav.ws === ws) mcDebrancherNav('liaison avec le serveur fermée'); };
  });
}
async function mcBrancherUsb() {
  if (!('serial' in navigator)) { alert('Ce navigateur ne gère pas l’USB : utilisez Chrome ou Edge, sur la carte en HTTPS.'); return; }
  let port;
  try { port = await navigator.serial.requestPort({}); } catch { return; }
  mc.nav.type = 'usb'; mcMajNav('connexion');
  try {
    await port.open({ baudRate: 115200 });
    try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch { /* pas géré */ }
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
async function mcBrancherBle() {
  if (!navigator.bluetooth) { alert('Ce navigateur ne gère pas le Bluetooth : utilisez Chrome ou Edge, sur la carte en HTTPS.'); return; }
  let app;
  try { app = await navigator.bluetooth.requestDevice({ filters: [{ services: [MC_BLE_SERVICE] }, { namePrefix: 'MeshCore' }], optionalServices: [MC_BLE_SERVICE] }); } catch { return; }
  mc.nav.type = 'ble'; mcMajNav('connexion');
  try {
    const gatt = await app.gatt.connect();
    const svc = await gatt.getPrimaryService(MC_BLE_SERVICE);
    const rx = await svc.getCharacteristic(MC_BLE_RX), tx = await svc.getCharacteristic(MC_BLE_TX);
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
    app.addEventListener('gattserverdisconnected', () => { if (mc.nav.ble && mc.nav.ble.app === app) mcDebrancherNav('Bluetooth déconnecté'); });
    mcMajNav('relie');
  } catch (e) {
    try { app.gatt.disconnect(); } catch { /* déjà */ }
    mcMajNav('aucun', 'Bluetooth : ' + e.message + ' (code PIN demandé ? appairez d’abord le companion dans Windows)');
  }
}
async function mcDebrancherNav(raison) {
  const n = mc.nav;
  const ws = n.ws; n.ws = null;
  try { if (ws) ws.close(); } catch { /* déjà */ }
  try { if (n.lecteur) await n.lecteur.cancel(); } catch { /* déjà */ }
  try { if (n.ecrivain) n.ecrivain.releaseLock(); } catch { /* déjà */ }
  const port = n.port; n.port = null; n.lecteur = null; n.ecrivain = null;
  try { if (port) await port.close(); } catch { /* déjà */ }
  try { if (n.ble) n.ble.gatt.disconnect(); } catch { /* déjà */ }
  n.ble = null;
  mcMajNav('aucun', typeof raison === 'string' ? raison : null);
}
window.addEventListener('beforeunload', (e) => { if (mc.nav.etat === 'relie') { e.preventDefault(); e.returnValue = ''; } });

// Résultat d'une découverte de chemin, avec tracé sur la carte
function mcHtmlChemin(c, n) {
  const etape = (x) => `<span class="saut${x.cle ? ' resolu' : ''}">${esc(x.nom || x.prefixe)}</span>`;
  const moi = (mc.etat && mc.etat.companion && mc.etat.companion.nom) || 'companion';
  return `<div class="chemin-test"><h4>Liaison testée ${c.heure ? ilYa(c.heure) : ''} · ${fmt(c.dureeMs / 1000, 1, ' s')} aller-retour</h4>
    <div class="chemin-mc"><span class="saut obs">${esc(moi)}</span>${c.aller.map((x) => '<i>›</i>' + etape(x)).join('')}<i>›</i><span class="saut obs">${esc(n.nom || n.id)}</span> <small>aller</small></div>
    <div class="chemin-mc"><span class="saut obs">${esc(n.nom || n.id)}</span>${c.retour.map((x) => '<i>›</i>' + etape(x)).join('')}<i>›</i><span class="saut obs">${esc(moi)}</span> <small>retour</small></div></div>`;
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
    <div class="ident">MeshCore · <span class="mono">${esc(n.cle.slice(0, 16))}…</span> <button class="mini" data-copier="${esc(n.cle)}" title="Copier la clé publique complète">Copier la clé</button></div>
    ${blocCoords(n.lat, n.lon, { approx: !etat.membre && !n.infrastructure && etat.config.precisionPublique >= 0 })}
    <div class="badges">
      <span class="badge ${n.statut}">${{ actif: 'Actif', recent: 'Récent', inactif: 'Inactif' }[n.statut]}</span>
      <span class="badge" style="color:${r.hex};border-color:${r.hex}66">${esc(r.un)}</span>
      ${n.observateur ? `<span class="badge passerelle">Observateur${obs.carte ? ' de la carte' : obs.iata ? ' · ' + esc(obs.iata) : ''}</span>` : ''}
      <span class="badge reseau-mc">MeshCore</span>
    </div>
    <nav class="onglets-fiche"><button data-of="infos" class="actif">Informations</button><button data-of="voisins">Voisins (${d.voisins.length})</button><button data-of="trames">Paquets</button>${etat.admin && ['repeteur', 'salon', 'capteur'].includes(n.role) ? '<button data-of="admin">Administration</button>' : ''}</nav>
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
      ${mcHtmlTelemetrie(d.telemetrie)}
      ${d.entenduPar.length ? `<h4>Entendu par (observateurs)</h4><table class="voisins"><thead><tr><th>Observateur</th><th class="num">Paquets</th><th class="num">SNR</th><th class="num">RSSI</th><th class="num">Sauts min.</th></tr></thead><tbody>
        ${d.entenduPar.map((e) => `<tr data-mc="${e.observateur}"><td>${esc(e.nom || e.observateur.slice(0, 8))}</td><td class="num">${e.nb}</td><td class="num">${fmt(e.snr, 1)}</td><td class="num">${fmt(e.rssi, 0)}</td><td class="num">${e.sauts_min ?? '–'}</td></tr>`).join('')}</tbody></table>` : ''}
      <p class="note">Le SNR et le RSSI d’un observateur ne valent que pour les paquets entendus <b>en direct</b> (0 saut). Les « sauts » comptent les répéteurs traversés.</p>
    </div>
    <div data-pf="voisins" hidden>
      ${voisins ? `<table class="voisins"><thead><tr><th>Nœud</th><th class="num">SNR reçu</th><th class="num">SNR émis</th><th class="num">km</th><th class="num">Obs.</th><th>Source</th><th></th></tr></thead><tbody>${voisins}</tbody></table>
      <p class="note">« Mesuré » : dernier saut vers un observateur (SNR réel). « Chemin » : déduit de la liste des répéteurs traversés par un paquet (préfixes de clé, rapprochés par la géographie).</p>` : '<div class="vide">Aucune liaison connue.</div>'}
    </div>
    <div data-pf="admin" hidden><div id="mc-admin-fiche"><div class="vide">Chargement…</div></div></div>
    <div data-pf="trames" hidden><div class="flux">${d.paquets.map((p) => mcLignePaquet(p, false)).join('') || '<div class="vide">Aucun paquet émis par ce nœud (seuls les annonces et les requêtes portent la clé complète de l’émetteur).</div>'}</div></div>`;
  zc.querySelectorAll('[data-of]').forEach((b) => (b.onclick = () => {
    zc.querySelectorAll('[data-of]').forEach((x) => x.classList.toggle('actif', x === b));
    zc.querySelectorAll('[data-pf]').forEach((x) => (x.hidden = x.dataset.pf !== b.dataset.of));
    if (b.dataset.of === 'admin') mcRendreAdminFiche({ cle: n.cle, nom: n.nom || n.id, role: n.role }, $('#mc-admin-fiche'));
  }));
  if (ongletInitial) { const b = zc.querySelector(`[data-of="${ongletInitial}"]`); if (b) b.click(); }
  const bq = $('#mc-qr'); if (bq) bq.onclick = () => mcOuvrirQr({ cle: n.cle });
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
async function mcChargerNoeuds() {
  const l = await api('/api/mc/noeuds');
  mc.noeuds = new Map(l.map((n) => [n.cle, n]));
  mcDessinerNoeuds();
  if ($('#mc-liste') && mc.vue === 'noeuds') mcRendreNoeuds();
  mcMajKpis();
}
async function mcChargerLiens() {
  mc.liens = await api('/api/mc/liens?heures=' + $('#fenetre').value);
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
  mcRafraichir = setTimeout(async () => { mcRafraichir = null; await Promise.all([mcChargerNoeuds(), mcChargerLiens()]).catch(() => {}); rendreLegende(); }, 4000);
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
    if (m.texte && m.premiere && etat.membre) mcMessagesARafraichir();
  } else if (m.genre === 'mc-etat') {
    mc.etat = { ...(mc.etat || {}), stats: m.stats, companion: { ...((mc.etat && mc.etat.companion) || {}), ...m.companion } };
    if (m.alertes) mc.etat.alertes = m.alertes;
    mcMajKpis();
    mcMajSource();
    mcMajAlertes();
    if (etat.admin && mc.vue === 'companion') mcChargerEtat();
  } else if (m.genre === 'mc-noeuds') mcPlanifier();
  else if (m.genre === 'mc-message' && etat.membre) mcMessagesARafraichir();
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
  if (sg) sg.hidden = !etat.admin;
  if (!etat.admin && mc.vue === 'gestion') mc.vue = 'noeuds';
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
  carte.on('zoomend', mcDessinerNoeuds);
  $('#fenetre').addEventListener('change', () => mcChargerLiens().catch(() => {}));
  $('#fermer-fiche').addEventListener('click', () => { mc.selection = null; });
  Promise.all([mcChargerNoeuds(), mcChargerLiens(), mcChargerEtat()]).then(() => { appliquerVueReseau(); }).catch(() => appliquerVueReseau());
  setInterval(() => mcChargerLiens().catch(() => {}), 120000);
  setInterval(mcDessinerChaleur, 20000);
  setInterval(() => { mcChargerNoeuds().catch(() => {}); }, 60000);
}
