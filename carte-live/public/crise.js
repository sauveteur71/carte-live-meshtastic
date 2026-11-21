// Secteurs d'alerte (géorepérage) et mode urgence : interface des gestionnaires et administrateurs.
// - Secteurs : cercle ou polygone dessiné sur la carte, rattaché à une équipe ou à des nœuds ; alerte quand un membre
//   en sort (ou y entre), journal des événements, export CSV. Seul un administrateur crée ou modifie un secteur.
// - Mode urgence : bandeau rouge pour tous les comptes connectés, carte simplifiée (le réseau ordinaire passe au second
//   plan, équipes, demandes d'aide et secteurs devant), tableau de crise rafraîchi toutes les 15 s, journal exportable.
// S'appuie sur app.js (etat, carte, api, postJson, esc, annonce, bip, saisir, confirmer, choisirPointPuis…).
'use strict';

const crise = {
  secteurs: [], equipes: [], modifiable: false, couche: null, apercu: null, coucheUrgence: null, rendu: null,
  etat: { actif: false }, tableau: null, minuteur: null, minutDuree: null, minutCharge: null,
  visibles: lireLs('gaulix_secteurs_visibles', true), brouillon: null,
};
const LIB_SENS = { sortie: 'à la sortie', entree: 'à l’entrée', deux: 'à l’entrée et à la sortie' };
const LIB_ETAT = { dedans: ['ok', '✔ dans le secteur'], dehors: ['echec', '⛔ hors du secteur'], inconnu: ['attente', '… pas encore de position'] };
const heureCrise = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const dureeCrise = (t) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };

function demarrerCrise() {
  if (!etat.membre || typeof carte === 'undefined' || !carte) return;
  carte.createPane('secteurs').style.zIndex = 415;
  carte.createPane('urgence').style.zIndex = 645;
  crise.rendu = L.svg({ pane: 'urgence' }); // SVG : les demandes d'aide clignotent (animation CSS)
  const bu = $('#outil-urgence');
  if (bu) { bu.hidden = !etat.gestion; bu.onclick = () => { fermerMenuOutils(); ficheCrise(); }; }
  const bs = $('#outil-secteurs');
  if (bs) { bs.hidden = !etat.gestion; bs.onclick = () => { fermerMenuOutils(); ficheSecteurs(); }; }
  appliquerUrgence(etat.config.urgence || { actif: false });
  if (etat.gestion) chargerSecteurs();
}
function fermerMenuOutils() { const m = document.querySelector('.menu-outils'); if (m) m.open = false; }

// Messages du serveur (WebSocket) : renvoie true quand le message est traité ici
function criseRecevoir(m) {
  if (m.genre === 'bienvenue') { chargerUrgence(); return false; } // reconnexion : état peut-être changé entre-temps
  if (m.genre === 'secteurs') { if (etat.gestion) chargerSecteurs().then(rafraichirFicheSecteurs); return true; }
  if (m.genre === 'secteur-alerte') { alerteSecteur(m); return true; }
  if (m.genre === 'urgence') {
    if (m.actif && !crise.etat.actif) annonce(`🚨 Mode urgence activé par ${m.auteur}${m.motif ? ' : ' + m.motif : ''}`, 'erreur', etat.gestion ? () => ficheCrise() : null, 'Ouvrir le tableau de crise', 20000);
    if (!m.actif && crise.etat.actif) annonce('Mode urgence terminé', 'ok');
    chargerUrgence();
    return true;
  }
  if (m.genre === 'urgence-evt') { planifierUrgence(); return true; }
  return false;
}

// ---- Secteurs : données et couche de la carte ------------------------------------------------------------------
async function chargerSecteurs() {
  try {
    const r = await api('/api/secteurs');
    crise.secteurs = r.secteurs || []; crise.equipes = r.equipes || []; crise.modifiable = !!r.modifiable;
  } catch { crise.secteurs = []; }
  dessinerSecteurs();
}
function formeLeaflet(s, style) {
  return s.forme === 'cercle' ? L.circle([s.centre.lat, s.centre.lon], { radius: s.rayon, ...style }) : L.polygon(s.points, style);
}
function dessinerSecteurs() {
  if (crise.couche) { crise.couche.remove(); crise.couche = null; }
  if (!etat.gestion || (!crise.visibles && !crise.etat.actif)) return;
  crise.couche = L.layerGroup();
  for (const s of crise.secteurs) {
    const couleur = !s.actif ? '#94a3b8' : s.dehors ? '#fb923c' : '#facc15';
    formeLeaflet(s, { pane: 'secteurs', color: couleur, weight: s.dehors ? 4 : 3, dashArray: s.actif ? '10 6' : '2 6', fillColor: couleur, fillOpacity: 0.06 })
      .bindTooltip(`<b>${esc(s.nom)}</b><br>${s.nomEquipe ? 'Équipe ' + esc(s.nomEquipe) + ' · ' : ''}alerte ${LIB_SENS[s.sens] || ''}${s.dehors ? `<br>⛔ ${s.dehors} hors du secteur` : ''}${s.actif ? '' : '<br>désactivé'}`, { sticky: true, className: 'info' })
      .on('click', () => ficheSecteurs({ ouvert: s.id }))
      .addTo(crise.couche);
  }
  crise.couche.addTo(carte);
}
function cadrerSecteur(s) {
  const f = formeLeaflet(s, {});
  carte.fitBounds(f.getBounds(), { padding: [40, 40], maxZoom: 16 });
  if (!crise.visibles) { crise.visibles = true; ecrireLs('gaulix_secteurs_visibles', true); dessinerSecteurs(); }
}
function alerteSecteur(m) {
  if (!etat.gestion) return;
  clearTimeout(crise.minutCharge);
  crise.minutCharge = setTimeout(() => chargerSecteurs().then(rafraichirFicheSecteurs), 800);
  if (crise.etat.actif) planifierUrgence();
  if (!m.notifier) return;
  const centrer = m.lat != null ? () => carte.setView([m.lat, m.lon], Math.max(carte.getZoom(), 15)) : null;
  annonce(m.message, m.niveau === 'critique' ? 'erreur' : 'info', centrer, 'Cliquer pour centrer la carte', 20000);
  try { if (window.Notification && Notification.permission === 'granted') new Notification(m.type === 'silence' ? '📵 Perte de contact' : m.type === 'flux' || m.type === 'flux-retour' ? '📡 Flux de paquets' : '⛔ Secteur d’alerte', { body: m.message, tag: 'secteur-' + m.secteur + '-' + m.noeud }); } catch { /* pas de notification */ }
  try { bip(m.niveau === 'critique' ? [988, 740, 988, 740] : [660, 880], 0.18); } catch { /* pas de son */ }
  if (m.lat != null && (m.type === 'sortie' || m.type === 'entree')) L.popup().setLatLng([m.lat, m.lon]).setContent(`<b>${m.type === 'sortie' ? '⛔' : '⚠'} ${esc(m.nom || '')}</b><br>${esc(m.message)}`).openOn(carte);
}

// ---- Secteurs : fiche ---------------------------------------------------------------------------------------
// Champs communs (création et modification)
function champsSecteur(s = {}) {
  const eq = crise.equipes;
  const noeuds = [...(s.noeuds || []).map(idHex), ...(s.noeudsMc || [])].join(', ');
  const opt = (v, t, c) => `<option value="${v}" ${String(c) === String(v) ? 'selected' : ''}>${t}</option>`;
  return `<div class="parametres compact">
      <label>Nom <input data-c="nom" maxlength="40" value="${esc(s.nom || '')}" placeholder="Secteur nord, vallée de la Loire…"></label>
      <label>Équipe <select data-c="equipe">${opt('', '— aucune —', s.equipe || '')}${eq.map((e) => opt(e.id, esc(e.nom) + ` (${e.nbMembres})`, s.equipe || '')).join('')}${s.equipe && !eq.some((e) => e.id === s.equipe) ? opt(s.equipe, esc(s.nomEquipe || s.equipe), s.equipe) : ''}</select></label>
    </div>
    <label>Autres nœuds suivis <input data-c="noeuds" value="${esc(noeuds)}" placeholder="!a1b2c3d4, clé publique MeshCore (64 caractères)…"></label>
    <small class="note">L’équipe : tous ses membres du moment. Nœuds Meshtastic par identifiant (!a1b2c3d4), nœuds MeshCore par leur clé publique complète.</small>
    <div class="parametres compact">
      <label>Alerte <select data-c="sens">${opt('sortie', 'à la sortie du secteur', s.sens || 'sortie')}${opt('entree', 'à l’entrée (zone à éviter)', s.sens || 'sortie')}${opt('deux', 'à l’entrée et à la sortie', s.sens || 'sortie')}</select></label>
      <label title="Une position à moins de cette distance de la limite ne compte pas : elle évite les fausses alertes en bordure">Marge (m) <input data-c="marge" type="number" min="0" max="2000" step="10" value="${s.marge ?? 30}"></label>
      <label title="Nombre de positions de suite du même côté avant de changer d’état">Positions pour confirmer <select data-c="confirmations">${[1, 2, 3, 4, 5].map((n) => opt(n, n, s.confirmations ?? 2)).join('')}</select></label>
      <label title="Pas deux alertes du même genre pour le même nœud avant ce délai">Délai entre deux alertes <select data-c="delaiMin">${[[1, '1 min'], [5, '5 min'], [10, '10 min'], [15, '15 min'], [30, '30 min'], [60, '1 h']].map(([v, t]) => opt(v, t, s.delaiMin ?? 10)).join('')}</select></label>
      <label title="Alerte si un membre ne donne plus de position pendant ce temps">Perte de contact <select data-c="silenceMin">${[[0, 'pas d’alerte'], [10, 'après 10 min'], [15, 'après 15 min'], [30, 'après 30 min'], [60, 'après 1 h'], [120, 'après 2 h']].map(([v, t]) => opt(v, t, s.silenceMin ?? 30)).join('')}</select></label>
      <label title="Message court envoyé par le module de la carte à chaque alerte (au plus un toutes les 30 s)">Prévenir sur un canal LoRa <select data-c="canalLora">${opt('', 'non', s.canalLora ?? '')}${[0, 1, 2, 3, 4, 5, 6, 7].map((n) => opt(n, 'canal ' + n, s.canalLora ?? '')).join('')}</select></label>
    </div>
    <small class="note">Une alerte part après <b>${s.confirmations ?? 2} positions de suite</b> au-delà de la marge, soit <b>1 à 2 intervalles de suivi</b> après la sortie réelle (la carte demande aussitôt une position au premier signe de sortie). Une seule position dehors suivie d’un silence devient une « sortie probable » après 10 min ou un intervalle de suivi. Une position floutée plus large que le secteur reste surveillée, mais le nœud est signalé « non surveillable précisément ».</small>`;
}
function lireChampsSecteur(bloc) {
  const v = (c) => { const x = bloc.querySelector(`[data-c="${c}"]`); return x ? x.value : undefined; };
  const noeuds = [], noeudsMc = [];
  for (const t of String(v('noeuds') || '').split(/[\s,;]+/).filter(Boolean)) {
    if (/^[0-9a-f]{64}$/i.test(t)) { noeudsMc.push(t.toUpperCase()); continue; }
    const n = lireNumsSaisis(t)[0];
    if (n == null) throw new Error(`Identifiant de nœud non reconnu : ${t}`);
    noeuds.push(n);
  }
  return { nom: v('nom'), equipe: v('equipe') || null, noeuds, noeudsMc, sens: v('sens'), marge: Number(v('marge')), confirmations: Number(v('confirmations')), delaiMin: Number(v('delaiMin')), silenceMin: Number(v('silenceMin')), canalLora: v('canalLora') === '' ? null : Number(v('canalLora')) };
}
function texteForme(g) {
  if (!g) return 'pas encore de forme';
  return g.forme === 'cercle' ? `cercle de ${g.rayon >= 1000 ? (g.rayon / 1000).toLocaleString('fr-FR') + ' km' : g.rayon + ' m'} de rayon` : `polygone à ${g.points.length} sommets`;
}
function montrerApercu(g) {
  if (crise.apercu) { crise.apercu.remove(); crise.apercu = null; }
  if (!g) return;
  crise.apercu = formeLeaflet(g, { pane: 'secteurs', color: '#22d3ee', weight: 3, dashArray: '4 4', fillOpacity: 0.08, interactive: false }).addTo(carte);
}
// Dessin d'un polygone : chaque clic pose un sommet ; Terminer (3 sommets au moins), Annuler le dernier, Abandonner
function dessinerPolygone(fini) {
  const pts = [];
  const ligne = L.polygon([], { pane: 'secteurs', color: '#22d3ee', weight: 3, dashArray: '4 4', fillOpacity: 0.08, interactive: false }).addTo(carte);
  const sommets = L.layerGroup().addTo(carte);
  const barre = document.createElement('div');
  barre.id = 'barre-dessin';
  barre.innerHTML = '<span data-n>Touchez la carte pour poser les sommets du secteur (3 au moins).</span><button type="button" class="mini" data-annuler>↶ Annuler le dernier</button><button type="button" class="mini principal" data-finir disabled>✔ Terminer</button><button type="button" class="mini" data-abandon>✕ Abandonner</button>';
  document.body.appendChild(barre);
  document.body.classList.add('choix-point');
  if (matchMedia('(max-width: 700px)').matches && typeof etat.tiroir !== 'undefined') { const p = document.querySelector('.poignee-tiroir'); if (p && etat.tiroir === 'plein') p.click(); }
  const maj = () => {
    ligne.setLatLngs(pts); sommets.clearLayers();
    pts.forEach((p) => L.circleMarker(p, { pane: 'urgence', radius: 5, color: '#0b1117', weight: 2, fillColor: '#22d3ee', fillOpacity: 1, interactive: false }).addTo(sommets));
    barre.querySelector('[data-n]').textContent = pts.length ? `${pts.length} sommet(s) posé(s)${pts.length < 3 ? ' : encore ' + (3 - pts.length) + ' au moins' : ''}` : 'Touchez la carte pour poser les sommets du secteur (3 au moins).';
    barre.querySelector('[data-finir]').disabled = pts.length < 3;
  };
  const clic = (e) => { const ll = e.latlng.wrap(); if (pts.length < 200) { pts.push([Math.round(ll.lat * 1e6) / 1e6, Math.round(ll.lng * 1e6) / 1e6]); maj(); } };
  const touche = (e) => { if (e.key === 'Escape') terminer(false); };
  function terminer(ok) {
    carte.off('click', clic); document.removeEventListener('keydown', touche);
    ligne.remove(); sommets.remove(); barre.remove(); document.body.classList.remove('choix-point');
    fini(ok && pts.length >= 3 ? { forme: 'polygone', points: pts.slice() } : null);
  }
  barre.querySelector('[data-annuler]').onclick = () => { pts.pop(); maj(); };
  barre.querySelector('[data-finir]').onclick = () => terminer(true);
  barre.querySelector('[data-abandon]').onclick = () => terminer(false);
  carte.on('click', clic); document.addEventListener('keydown', touche);
}
function choisirCercle(fini) {
  choisirPointPuis('Touchez la carte au centre du secteur.', async (ll0) => {
    const ll = ll0 && ll0.wrap ? ll0.wrap() : ll0; // longitude ramenée dans ±180 (carte défilée au-delà de l’antiméridien)
    const r = await saisir('Rayon du secteur, en mètres (50 à 100 000) :', '1000');
    if (r == null) return fini(null);
    const v = Number(String(r).replace(/\s/g, '').replace(',', '.'));
    if (!(v >= 50 && v <= 100000)) { annonce('Rayon invalide : 50 m à 100 km', 'erreur'); return fini(null); }
    fini({ forme: 'cercle', centre: { lat: Math.round(ll.lat * 1e6) / 1e6, lon: Math.round(ll.lng * 1e6) / 1e6 }, rayon: Math.round(v) });
  });
}
function rafraichirFicheSecteurs() {
  const z = $('#fiche-contenu');
  if (z && z.querySelector('.secteurs-alerte') && !$('#fiche').hidden && !z.contains(document.activeElement) && !crise.brouillon) ficheSecteurs({ ouvert: z.dataset.saOuvert || null, garder: true });
}
async function ficheSecteurs(opts = {}) {
  $('#fiche').hidden = false;
  etat.selection = null;
  const z = $('#fiche-contenu');
  if (!z.querySelector('.secteurs-alerte')) z.innerHTML = '<div class="vide">Chargement des secteurs…</div>';
  if (!opts.garder) await chargerSecteurs();
  let j = [];
  try { j = (await api('/api/secteurs/journal?limite=60' + (opts.journal ? '&secteur=' + encodeURIComponent(opts.journal) : ''))).evenements; } catch { /* journal indisponible */ }
  if (opts.equipe && !crise.brouillon) crise.brouillon = { equipe: opts.equipe };
  const mod = crise.modifiable;
  const ligneMembre = (m, s) => {
    const [c, t] = m.silence ? ['echec', '📵 sans nouvelle'] : m.etat === 'dehors' && m.probable ? ['echec', '⛔ sortie probable'] : m.perimee ? ['attente', '⌛ position périmée'] : m.imprecise ? ['attente', '≈ position floutée'] : LIB_ETAT[m.etat] || LIB_ETAT.inconnu;
    const d = m.derniere;
    return `<div class="membre-eq ${c}"><span class="nom">${esc(m.nom)}</span><span class="etat">${t}</span>
      <small class="detail">${d ? `📍 ${ilYa(d.heure)}${d.precision ? ` · ± ${d.precision} m` : ''}${d.d != null && d.d > 0 && m.etat === 'dehors' ? ` · ${d.d} m au-delà` : ''} <a href="#" data-voir-pos="${d.lat},${d.lon}">voir</a>` : '📍 aucune position reçue depuis la création du secteur'}</small></div>`;
  };
  const ligneJournal = (e) => `<div class="evt-sa ${esc(e.type)}"><time>${heureCrise(e.heure)}</time> <span>${esc(e.message)}</span>${e.notifier === false && e.alerte ? ' <small>(non répétée)</small>' : ''}${e.lat != null ? ` <a href="#" data-voir-pos="${e.lat},${e.lon}">voir</a>` : ''}</div>`;
  z.dataset.saOuvert = opts.ouvert || '';
  z.innerHTML = `<div class="secteurs-alerte"><h2>🗺️ Secteurs d’alerte</h2>
    <p class="note">La carte prévient quand un membre d’une équipe <b>sort d’un secteur</b> (ou y entre) : alerte dans Réseau › Alertes, son et notification pour les gestionnaires connectés, domotique, appli Android, et en option un message LoRa. Il faut que les nœuds envoient leur position (suivi des équipes, ou mode recherche).</p>
    <label class="case"><input type="checkbox" id="sa-visibles" ${crise.visibles ? 'checked' : ''}> Afficher les secteurs sur la carte</label>
    ${crise.secteurs.map((s) => `<details class="proposition secteur-sa" data-sa="${esc(s.id)}" ${opts.ouvert === s.id || crise.secteurs.length === 1 ? 'open' : ''}>
      <summary class="entete-prop"><b>${esc(s.nom)}</b><span class="marge">${s.actif ? '' : '⏸ désactivé · '}${texteForme(s)}${s.nomEquipe ? ' · équipe ' + esc(s.nomEquipe) : ''} · ${s.dehors ? `<span class="sa-dehors">⛔ ${s.dehors} hors secteur</span>` : `${s.membres.length} suivi(s)`}</span></summary>
      <div class="meta-longue">Alerte ${LIB_SENS[s.sens] || ''} · marge ${s.marge} m · ${s.confirmations} position(s) pour confirmer · ${s.delaiMin} min entre deux alertes${s.silenceMin ? ` · perte de contact après ${s.silenceMin} min` : ''}${s.canalLora != null ? ` · LoRa canal ${s.canalLora}` : ''}</div>
      <div class="liste-membres">${s.membres.length ? s.membres.map((m) => ligneMembre(m, s)).join('') : '<div class="vide">Aucun nœud suivi : l’équipe est vide.</div>'}</div>
      <div class="actions-prop"><button data-voir>🔍 Voir sur la carte</button><button data-journal>📜 Journal de ce secteur</button>
        ${mod ? `<button data-actif>${s.actif ? '⏸ Désactiver' : '▶ Réactiver'}</button><button data-supprimer class="danger">🗑 Supprimer</button>` : ''}</div>
      ${mod ? `<details class="modif-sa"><summary>Modifier</summary>${champsSecteur(s)}
        <div class="actions-prop"><button data-redessiner-poly>⬠ Redessiner (polygone)</button><button data-redessiner-cercle>◯ Redessiner (cercle)</button><button class="principal" data-enregistrer>Enregistrer</button></div></details>` : ''}
      <p class="erreur" data-retour></p>
    </details>`).join('') || '<div class="vide">Aucun secteur pour l’instant.</div>'}
    ${mod ? `<h3>Nouveau secteur</h3>
    <div class="nouveau-sa">
      <div class="actions-prop"><button data-poly>⬠ Dessiner un polygone</button><button data-cercle>◯ Cercle (centre et rayon)</button><span class="note" data-forme>${texteForme(crise.brouillon && crise.brouillon.geo)}</span></div>
      ${champsSecteur({ equipe: crise.brouillon ? crise.brouillon.equipe : '' })}
      <div class="actions-prop"><button class="principal" data-creer>Créer le secteur</button>${crise.brouillon ? '<button data-oublier>Abandonner</button>' : ''}</div>
      <p class="erreur" id="sa-retour"></p>
    </div>` : '<p class="note">Seul un administrateur crée ou modifie les secteurs.</p>'}
    <h3>📜 Journal${opts.journal ? ` · ${esc((crise.secteurs.find((s) => s.id === opts.journal) || {}).nom || '')} <a href="#" id="sa-tout">tout voir</a>` : ''}</h3>
    <div class="actions-prop"><a class="bouton mini" href="/api/secteurs/journal.csv${opts.journal ? '?secteur=' + encodeURIComponent(opts.journal) : ''}" download>⬇ Exporter le journal (CSV)</a></div>
    <div class="journal-sa">${j.length ? j.map(ligneJournal).join('') : '<div class="vide">Aucun événement.</div>'}</div></div>`;

  $('#sa-visibles').onchange = (e) => { crise.visibles = e.target.checked; ecrireLs('gaulix_secteurs_visibles', crise.visibles); dessinerSecteurs(); };
  { const t = $('#sa-tout'); if (t) t.onclick = (e) => { e.preventDefault(); ficheSecteurs({ garder: true }); }; }
  z.querySelectorAll('[data-voir-pos]').forEach((l) => (l.onclick = (ev) => { ev.preventDefault(); const [la, lo] = l.dataset.voirPos.split(',').map(Number); carte.setView([la, lo], Math.max(carte.getZoom(), 15)); }));
  z.querySelectorAll('[data-sa]').forEach((bloc) => {
    const id = bloc.dataset.sa, s = crise.secteurs.find((x) => x.id === id);
    const retour = (t) => { bloc.querySelector('[data-retour]').textContent = t; };
    bloc.addEventListener('toggle', () => { if (bloc.open) z.dataset.saOuvert = id; });
    bloc.querySelector('[data-voir]').onclick = () => cadrerSecteur(s);
    bloc.querySelector('[data-journal]').onclick = () => ficheSecteurs({ ouvert: id, journal: id, garder: true });
    if (!mod) return;
    bloc.querySelector('[data-actif]').onclick = async () => { try { await postJson(`/api/secteurs/${id}`, { actif: !s.actif }, 'PATCH'); ficheSecteurs({ ouvert: id }); } catch (e) { retour(e.message); } };
    bloc.querySelector('[data-supprimer]').onclick = async () => {
      if (!(await confirmer(`Supprimer le secteur « ${s.nom} » ? Ses alertes en cours disparaissent ; le journal garde la trace.`))) return;
      try { await postJson(`/api/secteurs/${id}`, {}, 'DELETE'); ficheSecteurs(); } catch (e) { retour(e.message); }
    };
    let geo = null;
    const enregistrer = async () => {
      try { await postJson(`/api/secteurs/${id}`, { ...lireChampsSecteur(bloc.querySelector('.modif-sa')), ...(geo || {}) }, 'PATCH'); montrerApercu(null); ficheSecteurs({ ouvert: id }).then(() => { const b = z.querySelector(`[data-sa="${id}"] [data-retour]`); if (b) b.textContent = '✔ Enregistré'; }); } catch (e) { retour(e.message); }
    };
    bloc.querySelector('[data-enregistrer]').onclick = enregistrer;
    const redessiner = (f) => f((g) => { if (!g) return; geo = g; montrerApercu(g); retour(`Nouvelle forme : ${texteForme(g)}. Cliquez sur Enregistrer pour la garder.`); });
    bloc.querySelector('[data-redessiner-poly]').onclick = () => redessiner(dessinerPolygone);
    bloc.querySelector('[data-redessiner-cercle]').onclick = () => redessiner(choisirCercle);
  });
  if (mod) {
    const nv = z.querySelector('.nouveau-sa');
    const retour = (t) => { $('#sa-retour').textContent = t; };
    const garderSaisie = () => { try { crise.brouillon = { ...(crise.brouillon || {}), champs: lireChampsSecteur(nv) }; } catch { /* saisie incomplète */ } };
    const forme = (f) => { garderSaisie(); f((g) => { if (!g) return; crise.brouillon = { ...(crise.brouillon || {}), geo: g }; montrerApercu(g); nv.querySelector('[data-forme]').textContent = '✔ ' + texteForme(g); }); };
    nv.querySelector('[data-poly]').onclick = () => forme(dessinerPolygone);
    nv.querySelector('[data-cercle]').onclick = () => forme(choisirCercle);
    // Saisie gardée pendant le dessin (la fiche peut se fermer sur téléphone)
    if (crise.brouillon && crise.brouillon.champs) {
      const c = crise.brouillon.champs;
      for (const [k, v] of Object.entries({ nom: c.nom, equipe: c.equipe || '', sens: c.sens, marge: c.marge, confirmations: c.confirmations, delaiMin: c.delaiMin, silenceMin: c.silenceMin, canalLora: c.canalLora ?? '', noeuds: [...(c.noeuds || []).map(idHex), ...(c.noeudsMc || [])].join(', ') })) { const x = nv.querySelector(`[data-c="${k}"]`); if (x && v != null) x.value = v; }
    }
    { const b = nv.querySelector('[data-oublier]'); if (b) b.onclick = () => { crise.brouillon = null; montrerApercu(null); ficheSecteurs({ garder: true }); }; }
    nv.querySelector('[data-creer]').onclick = async () => {
      try {
        const g = crise.brouillon && crise.brouillon.geo;
        if (!g) throw new Error('Dessinez d’abord le secteur sur la carte (polygone ou cercle)');
        const s = await postJson('/api/secteurs', { ...lireChampsSecteur(nv), ...g });
        crise.brouillon = null; montrerApercu(null);
        await ficheSecteurs({ ouvert: s.id });
        annonce(`✔ Secteur « ${s.nom} » créé : ${s.membres.length} nœud(s) suivi(s)`, 'ok');
      } catch (e) { retour(e.message); }
    };
  }
}

// ---- Mode urgence ------------------------------------------------------------------------------------------
async function chargerUrgence() {
  if (!etat.membre) return;
  try { appliquerUrgence(await api('/api/urgence')); } catch { /* hors connexion : on garde l'état connu */ }
}
function planifierUrgence() {
  if (!crise.etat.actif || !etat.gestion) return;
  clearTimeout(crise.minutCharge);
  crise.minutCharge = setTimeout(chargerUrgence, 1000);
}
function appliquerUrgence(e) {
  const avant = crise.etat.actif;
  crise.etat = e || { actif: false };
  crise.tableau = e && e.tableau ? e.tableau : null;
  document.body.classList.toggle('mode-urgence', !!crise.etat.actif);
  majBandeauUrgence();
  const bu = $('#outil-urgence');
  if (bu) { bu.textContent = crise.etat.actif ? '🚨 Tableau de crise' : '🚨 Mode urgence'; bu.classList.toggle('actif', !!crise.etat.actif); }
  clearInterval(crise.minuteur);
  if (crise.etat.actif && etat.gestion) crise.minuteur = setInterval(chargerUrgence, 15000);
  if (avant !== !!crise.etat.actif) dessinerSecteurs();
  dessinerUrgence();
  const z = $('#fiche-contenu');
  if (z && z.querySelector('.tableau-crise') && !$('#fiche').hidden && !z.contains(document.activeElement)) ficheCrise(true);
}
function majBandeauUrgence() {
  let b = $('#bandeau-urgence');
  clearInterval(crise.minutDuree);
  if (!crise.etat.actif) { if (b) b.remove(); return; }
  if (!b) {
    b = document.createElement('button');
    b.type = 'button'; b.id = 'bandeau-urgence';
    const chip = $('#chip-alertes');
    if (chip && chip.parentNode) chip.parentNode.insertBefore(b, chip); else document.body.appendChild(b);
  }
  const e = crise.etat;
  const maj = () => { b.innerHTML = `<i aria-hidden="true"></i><b>URGENCE</b> <span class="u-duree">${dureeCrise(e.debut)}</span>${e.motif ? `<span class="u-motif"> · ${esc(e.motif)}</span>` : ''}`; };
  maj();
  crise.minutDuree = setInterval(maj, 30000);
  b.title = `Mode urgence depuis ${heureCrise(e.debut)}${e.auteur ? ', activé par ' + e.auteur : ''}${e.motif ? ' : ' + e.motif : ''}`;
  b.onclick = () => (etat.gestion ? ficheCrise() : annonce(`🚨 Mode urgence en cours depuis ${heureCrise(e.debut)}${e.motif ? ' : ' + e.motif : ''}. Les responsables suivent la crise sur la carte.`, 'erreur'));
}
// Couche de crise : demandes d'aide, intervenants, membres hors secteur (au-dessus du réseau ordinaire, estompé)
function dessinerUrgence() {
  if (crise.coucheUrgence) { crise.coucheUrgence.remove(); crise.coucheUrgence = null; }
  const t = crise.tableau;
  if (!crise.etat.actif || !t || !etat.gestion) return;
  const g = L.layerGroup();
  const r = crise.rendu;
  const horsSecteur = new Set();
  for (const s of t.secteurs || []) for (const m of s.membres) if (m.etat === 'dehors' || m.silence) horsSecteur.add(m.cle);
  for (const m of t.membres || []) {
    if (!m.position) continue;
    const alerte = horsSecteur.has('mt:' + m.num) || m.sansNouvelle;
    L.circleMarker([m.position.lat, m.position.lon], { renderer: r, pane: 'urgence', radius: alerte ? 10 : 8, color: alerte ? '#fb923c' : '#ffffff', weight: 3, fillColor: alerte ? '#7c2d12' : '#1d4ed8', fillOpacity: 1 })
      .bindTooltip(`${esc(m.nom)}${alerte ? ' ⚠' : ''}`, { permanent: true, direction: 'right', offset: [10, 0], className: 'etiq-urgence' })
      .bindPopup(`<b>${esc(m.nom)}</b><br>Équipe ${esc(m.equipe)}<br>📍 ${ilYa(m.position.heure)}${m.sansNouvelle ? '<br>⚠ sans nouvelle' : ''}`)
      .addTo(g);
  }
  // Membres MeshCore ou nœuds hors équipe suivis par un secteur : dernière position connue du secteur
  const vus = new Set((t.membres || []).map((m) => 'mt:' + m.num));
  for (const s of t.secteurs || []) for (const m of s.membres) {
    if (vus.has(m.cle) || !m.derniere) continue;
    vus.add(m.cle);
    const alerte = m.etat === 'dehors' || m.silence;
    L.circleMarker([m.derniere.lat, m.derniere.lon], { renderer: r, pane: 'urgence', radius: alerte ? 10 : 8, color: alerte ? '#fb923c' : '#ffffff', weight: 3, fillColor: alerte ? '#7c2d12' : '#1d4ed8', fillOpacity: 1 })
      .bindTooltip(`${esc(m.nom)}${alerte ? ' ⚠' : ''}`, { permanent: true, direction: 'right', offset: [10, 0], className: 'etiq-urgence' }).addTo(g);
  }
  for (const x of t.sos || []) {
    if (!x.position) continue;
    L.circleMarker([x.position.lat, x.position.lon], { renderer: r, pane: 'urgence', radius: 16, color: '#ef4444', weight: 4, fillColor: '#ef4444', fillOpacity: 0.85, className: 'urg-sos' })
      .bindTooltip(`🆘 ${esc(x.nom)}`, { permanent: true, direction: 'top', offset: [0, -14], className: 'etiq-urgence sos' })
      .bindPopup(`<b>🆘 ${esc(x.nom)}</b> (équipe ${esc(x.nomEquipe)})<br>${esc(x.texte)}<br><small>${ilYa(x.heure)}</small>`)
      .addTo(g);
  }
  crise.coucheUrgence = g.addTo(carte);
}
async function activerUrgence() {
  const motif = await saisir('Mode urgence : motif de la crise (facultatif, visible par tous les comptes connectés). Exemples : recherche de personne, crue de la Loire, exercice ADRASEC.', '');
  if (motif == null) return;
  if (!(await confirmer('Activer le mode urgence ?\n\n• bandeau rouge pour tous les comptes connectés ;\n• carte simplifiée : équipes, demandes d’aide et secteurs au premier plan ;\n• état du réseau rafraîchi toutes les 10 s ;\n• journal horodaté de tout ce qui se passe, exportable.\n\nAucun réglage radio n’est modifié et aucun message LoRa n’est envoyé.', { ok: '🚨 Activer' }))) return;
  try { appliquerUrgence(await postJson('/api/urgence', { actif: true, motif })); await chargerUrgence(); ficheCrise(); } catch (e) { annonce(e.message, 'erreur'); }
}
async function terminerUrgence() {
  if (!(await confirmer('Terminer le mode urgence ? La carte revient à l’affichage habituel. Le journal de la crise est gardé et reste exportable.', { ok: 'Terminer' }))) return;
  try {
    const r = await postJson('/api/urgence', { actif: false });
    appliquerUrgence({ actif: false });
    ficheCrise(true);
    if (r.derniere) annonce(`Mode urgence terminé : ${r.derniere.nb} événement(s) au journal. Cliquez pour l’exporter (CSV).`, 'ok', () => { location.href = '/api/urgence/journal.csv?crise=' + encodeURIComponent(r.derniere.id); }, 'Exporter le journal', 20000);
  } catch (e) { annonce(e.message, 'erreur'); }
}
async function ficheCrise(garder) {
  if (!etat.gestion) return;
  $('#fiche').hidden = false;
  etat.selection = null;
  const z = $('#fiche-contenu');
  if (!garder || !crise.etat.actif) { try { appliquerUrgence(await api('/api/urgence')); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; } }
  const e = crise.etat, t = crise.tableau || {};
  const archives = (t.archives || []).filter((a) => !e.actif || a.id !== e.id);
  const lienPos = (p) => (p ? ` <a href="#" data-voir-pos="${p.lat},${p.lon}">📍 voir</a>` : '');
  const voirNoeud = (num) => (typeof num === 'number' ? ` <a href="#" data-fiche-noeud="${num}">fiche</a>` : '');
  const blocArchives = archives.length ? `<details class="archives-crise"><summary>Crises précédentes (${archives.length})</summary>${archives.map((a) => `<div class="evt-crise"><time>${new Date(a.debut).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</time> <span>${esc(a.motif || 'sans motif')} · ${a.nb} événement(s)${a.fin ? ` · ${dureeEntre(a.debut, a.fin)}` : ''}</span> <a href="/api/urgence/journal.csv?crise=${encodeURIComponent(a.id)}" download>⬇ CSV</a></div>`).join('')}</details>` : '';
  if (!e.actif) {
    z.innerHTML = `<div class="tableau-crise"><h2>🚨 Mode urgence</h2>
      <p class="note">Pour une crise (recherche de personne, crue, panne générale, exercice) : la carte passe en <b>configuration de crise</b> pour tous les comptes connectés. Bandeau rouge, carte simplifiée (le réseau ordinaire passe au second plan, les équipes, demandes d’aide et secteurs d’alerte devant), rafraîchissement plus rapide, signalements et main courante remis en service s’ils étaient masqués, et un <b>journal horodaté</b> de tout ce qui se passe, exportable à la fin.</p>
      <p class="note">Le mode urgence ne change <b>aucun réglage radio</b> et n’envoie <b>aucun message LoRa</b> : demandes de position, mode recherche et envois restent à votre main (fiche Équipes).</p>
      <div class="actions-prop">${etat.admin ? '<button class="principal danger" id="urg-activer">🚨 Activer le mode urgence</button>' : ''}<button id="urg-secteurs">🗺️ Secteurs d’alerte</button></div>
      ${etat.admin ? '' : '<p class="note">Seul un administrateur active ou termine le mode urgence.</p>'}
      ${blocArchives}</div>`;
    { const b = $('#urg-activer'); if (b) b.onclick = activerUrgence; }
    $('#urg-secteurs').onclick = () => ficheSecteurs();
    return;
  }
  const sos = t.sos || [], alS = t.alertesSecteurs || [], membres = t.membres || [], crit = t.critiques || [], evts = t.evenements || [];
  z.innerHTML = `<div class="tableau-crise"><h2>🚨 Tableau de crise</h2>
    <div class="alerte critique">En cours depuis <b>${heureCrise(e.debut)}</b> (${dureeCrise(e.debut)}) · activé par ${esc(e.auteur || '?')}${e.motif ? ` · <b>${esc(e.motif)}</b>` : ''}</div>
    <div class="actions-prop"><button id="urg-note">📝 Ajouter une note au journal</button><a class="bouton" href="/api/urgence/journal.csv?crise=${encodeURIComponent(e.id)}" download>⬇ Journal (CSV)</a><button id="urg-secteurs">🗺️ Secteurs</button><button id="urg-equipes" ${etat.admin ? '' : 'hidden'}>👥 Équipes</button>${etat.admin ? '<button class="danger" id="urg-fin">⏹ Terminer le mode urgence</button>' : ''}</div>
    <h3>🆘 Demandes d’aide${sos.length ? ` (${sos.length})` : ''}</h3>
    ${sos.length ? sos.map((x) => `<div class="alerte critique sos-eq">🆘 <b>${esc(x.nom)}</b> (équipe ${esc(x.nomEquipe)}) ${ilYa(x.heure)} : « ${esc(x.texte)} »${lienPos(x.position)}${etat.admin ? ` <button class="mini principal" data-sos="${esc(x.equipe)}|${esc(x.id)}">✔ Pris en compte</button>` : ''}</div>`).join('') : '<div class="vide">Aucune demande d’aide en attente.</div>'}
    <h3>⛔ Secteurs d’alerte${alS.length ? ` (${alS.length})` : ''}</h3>
    ${alS.length ? alS.map((a) => `<div class="alerte ${a.niveau}">${esc(a.message)}${voirNoeud(a.noeud)}</div>`).join('') : `<div class="vide">${(t.secteurs || []).length ? 'Tous les membres suivis sont dans leur secteur.' : 'Aucun secteur d’alerte actif.'}</div>`}
    <h3>👥 Intervenants${membres.length ? ` (${membres.length})` : ''}</h3>
    <div class="liste-membres">${membres.length ? membres.map((m) => `<div class="membre-eq ${m.sansNouvelle ? 'echec' : m.position ? 'ok' : 'attente'}"><span class="nom">${esc(m.nom)} <small>${esc(m.equipe)}</small></span><span class="etat">${m.position ? '📍 ' + ilYa(m.position.heure) : 'position inconnue'}${m.sansNouvelle ? ' · ⚠ sans nouvelle' : ''}</span>${lienPos(m.position)}</div>`).join('') : '<div class="vide">Aucune équipe : créez-en dans Programmer › 👥 Équipes.</div>'}</div>
    <h3>⚠️ Alertes critiques du réseau${crit.length ? ` (${crit.length})` : ''}</h3>
    ${crit.length ? crit.map((a) => `<div class="alerte critique">${esc(a.message)}</div>`).join('') : '<div class="vide">Aucune.</div>'}
    <h3>📜 Journal de la crise</h3>
    <div class="journal-crise">${evts.map((x) => `<div class="evt-crise ${esc(x.niveau)}"><time>${heureCrise(x.heure)}</time> <span>${esc(x.texte)}</span>${x.auteur && x.type === 'note' ? ` <small>— ${esc(x.auteur)}</small>` : ''}${x.lat != null ? lienPos(x) : ''}</div>`).join('') || '<div class="vide">Rien pour l’instant.</div>'}</div>
    ${blocArchives}</div>`;
  z.querySelectorAll('[data-voir-pos]').forEach((l) => (l.onclick = (ev) => { ev.preventDefault(); const [la, lo] = l.dataset.voirPos.split(',').map(Number); carte.setView([la, lo], Math.max(carte.getZoom(), 15)); }));
  z.querySelectorAll('[data-fiche-noeud]').forEach((l) => (l.onclick = (ev) => { ev.preventDefault(); const n = Number(l.dataset.ficheNoeud) >>> 0; if (etat.noeuds.has(n)) ouvrirFiche(n); }));
  z.querySelectorAll('[data-sos]').forEach((b) => (b.onclick = async () => { const [eq, id] = b.dataset.sos.split('|'); try { await postJson(`/api/equipes/${eq}/sos/${id}`, {}); await chargerUrgence(); ficheCrise(true); } catch (x) { annonce(x.message, 'erreur'); } }));
  $('#urg-note').onclick = async () => { const n = await saisir('Note pour le journal de la crise (heure ajoutée automatiquement) :', ''); if (!n || !n.trim()) return; try { await postJson('/api/urgence/note', { texte: n }); await chargerUrgence(); ficheCrise(true); } catch (x) { annonce(x.message, 'erreur'); } };
  { const b = $('#urg-fin'); if (b) b.onclick = terminerUrgence; }
  $('#urg-secteurs').onclick = () => ficheSecteurs();
  $('#urg-equipes').onclick = () => ficheEquipes();
}
function dureeEntre(a, b) { const m = Math.round((b - a) / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; }
