'use strict';
// Ergonomie de la carte : rubriques (5 au lieu de 8 onglets), accueil en tuiles, niveaux d'affichage
// (simple / opérateur / expert), réglages regroupés, aide intégrée, visite guidée, bouton « ＋ » sur la carte,
// raccourcis favoris, confirmations dans l'interface, clavier et lecteurs d'écran.
// Chargé après app.js et meshcore.js : s'appuie sur leurs fonctions, sans changer leur fonctionnement
// (les 8 onglets d'origine existent toujours, rangés en sous-rubriques).

// ---- Confirmation dans l'interface (remplace confirm() du navigateur) -----------------------------------------
function confirmer(texte, { ok = 'Confirmer', annuler = 'Annuler' } = {}) {
  return new Promise((resoudre) => {
    let d = document.getElementById('dlg-confirmer');
    if (!d) {
      d = document.createElement('dialog');
      d.id = 'dlg-confirmer'; d.className = 'dlg-confirmer';
      d.setAttribute('aria-labelledby', 'confirmer-texte');
      document.body.appendChild(d);
    }
    const danger = /supprim|effac|retir|désactiv|termin|forcer|interromp|remettre à zéro|nouvelle clé|seront remplacés/i.test(texte);
    d.innerHTML = `<p id="confirmer-texte"></p><div class="actions-confirmer"><button type="button" data-r="0">${esc(annuler)}</button><button type="button" data-r="1" class="${danger ? 'danger' : 'principal'}">${esc(ok)}</button></div>`;
    d.querySelector('p').textContent = texte;
    const fin = (v) => { d.onclose = null; if (d.open) d.close(); resoudre(v); };
    d.querySelectorAll('[data-r]').forEach((b) => (b.onclick = () => fin(b.dataset.r === '1')));
    d.onclose = () => resoudre(false); // Échap
    d.onclick = (e) => { if (e.target === d) { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) fin(false); } };
    d.showModal();
    d.querySelector('[data-r="1"]').focus();
  });
}
// Saisie dans l'interface (remplace prompt() du navigateur) : renvoie le texte, ou null si annulé
function saisir(texte, defaut = '') {
  return new Promise((resoudre) => {
    let d = document.getElementById('dlg-saisir');
    if (!d) { d = document.createElement('dialog'); d.id = 'dlg-saisir'; d.className = 'dlg-confirmer'; d.setAttribute('aria-labelledby', 'saisir-texte'); document.body.appendChild(d); }
    d.innerHTML = '<form method="dialog"><p id="saisir-texte"></p><input id="saisir-champ" autocomplete="off"><div class="actions-confirmer"><button type="button" data-r="0">Annuler</button><button type="submit" class="principal">Valider</button></div></form>';
    d.querySelector('p').textContent = texte;
    const champ = d.querySelector('input');
    champ.value = defaut == null ? '' : String(defaut);
    let rendu = false;
    const fin = (v) => { if (rendu) return; rendu = true; d.onclose = null; if (d.open) d.close(); resoudre(v); };
    d.querySelector('[data-r="0"]').onclick = () => fin(null);
    d.querySelector('form').onsubmit = (e) => { e.preventDefault(); fin(champ.value); };
    d.onclose = () => fin(null);
    d.showModal();
    champ.focus(); champ.select();
  });
}
// Annonce avec un bouton « Annuler » pendant 6 secondes (actions réversibles)
function annonceAnnulable(texte, annuler) {
  let z = document.getElementById('annonces');
  if (!z) { annonce(texte); z = document.getElementById('annonces'); z.lastChild.remove(); }
  const d = document.createElement('div');
  d.className = 'annonce ok';
  d.innerHTML = `<span></span> <button type="button" class="mini">↩ Annuler</button>`;
  d.querySelector('span').textContent = texte;
  d.querySelector('button').onclick = async () => { d.remove(); try { await annuler(); } catch (e) { annonce('⚠ ' + e.message, 'erreur'); } };
  z.appendChild(d);
  setTimeout(() => d.remove(), 6000);
}
// Les messages d'erreur ou d'information passent par les annonces en bas de l'écran
window.alert = (t) => { try { annonce(String(t), /^\d+ |✔|envoy|enregistr|copi/i.test(String(t)) ? 'ok' : 'erreur'); } catch { console.warn(t); } };

// ---- Niveaux d'affichage -------------------------------------------------------------------------------------
const NIVEAUX = { simple: 'Simple', operateur: 'Opérateur', expert: 'Expert' };
const ergo = { niveau: 'simple', groupe: 'reseau', favoris: [], recents: [] };
function niveauParDefaut() { return etat.admin ? 'expert' : etat.gestion ? 'operateur' : 'simple'; }
function appliquerNiveau(n, memoriser) {
  if (!NIVEAUX[n]) n = niveauParDefaut();
  ergo.niveau = n;
  document.body.dataset.niveau = n;
  if (memoriser) ecrireLs('gaulix_niveau', n);
  // Titres de menu dont toutes les entrées sont masquées
  document.querySelectorAll('.menu-outils .titre-outils').forEach((t) => {
    let e = t.nextElementSibling, visible = false;
    while (e && !e.classList.contains('titre-outils')) { if (!e.hidden && e.tagName !== 'SMALL' && getComputedStyle(e).display !== 'none') visible = true; e = e.nextElementSibling; }
    t.classList.toggle('titre-vide', !visible);
  });
  majGroupes();
  rendreAccueil();
  if (document.querySelector('.vue.actif[data-vue="reglages"]')) rendreHubReglages();
}
// Ce qui n'apparaît qu'à partir d'un niveau (op = opérateur, exp = expert)
function etiqueterNiveaux() {
  const op = ['.onglets [data-onglet="trafic"]', '.onglets [data-onglet="analyse"]', '#btn-couv-mesuree', '#btn-couvrir', '#btn-relier', '#btn-simulation', '#btn-plan-menu', '#btn-rejeu',
    '#outil-usb', '#outil-ble', '#outil-portee', '#outil-rapport', '#outil-partager', '#lien-client', '#lien-flasher',
    '[data-couche="voisinage"]', '[data-couche="traceroute"]', '[data-couche="federation"]', '[data-couche="releves"]', '[data-couche="routiers"]'];
  const exp = ['#outil-passerelle', '#outil-trafic', '#outil-france'];
  for (const s of op) document.querySelectorAll(s).forEach((e) => e.classList.add('niv-op'));
  for (const s of exp) document.querySelectorAll(s).forEach((e) => e.classList.add('niv-exp'));
  // Liens du menu Outils (topologie, configuration des répéteurs…) : opérateur ; ceux de simulation : expert
  document.querySelectorAll('.menu-outils a.bascule').forEach((a) => { if (!a.classList.contains('niv-op')) a.classList.add(/topologie|simulation|configurer/i.test(a.textContent) ? 'niv-exp' : 'niv-op'); });
}

// ---- Rubriques : 5 groupes au-dessus des onglets d'origine ---------------------------------------------------
const GROUPES = { reseau: ['reseau', 'noeuds', 'trafic', 'analyse', 'meshcore'], messages: ['messages', 'meshcore'], couverture: ['sites'], gerer: ['gestion', 'meshcore'], reglages: ['reglages'] };
const LIBELLES = {
  reseau: { reseau: 'Vue d’ensemble', meshcore: 'MeshCore' },
  messages: { messages: 'Meshtastic', meshcore: 'MeshCore' },
  gerer: { gestion: 'Meshtastic', meshcore: 'MeshCore' },
};
const VUE_MC = { messages: 'messages', gerer: 'gestion' };
const bOnglet = (o) => document.querySelector(`.onglets button[data-onglet="${o}"]`);
const ongletVisible = (o) => { const b = bOnglet(o); return !!b && (o === 'reglages' || !b.hidden) && !(b.classList.contains('niv-op') && ergo.niveau === 'simple'); };
function groupeDe(onglet) {
  if (onglet === 'meshcore') { const v = typeof mc !== 'undefined' ? mc.vue : ''; return v === 'messages' ? 'messages' : v === 'gestion' ? 'gerer' : 'reseau'; }
  return Object.keys(GROUPES).find((g) => GROUPES[g].includes(onglet)) || 'reseau';
}
function majGroupes() {
  const actif = (document.querySelector('.onglets button[data-onglet].actif') || {}).dataset;
  if (actif && actif.onglet) { const g = groupeDe(actif.onglet); if (actif.onglet !== 'meshcore' || !GROUPES[ergo.groupe].includes('meshcore')) ergo.groupe = g; }
  const nav = document.querySelector('.onglets');
  let visibles = 0;
  document.querySelectorAll('.onglets button[data-onglet]').forEach((b) => {
    const o = b.dataset.onglet, dans = GROUPES[ergo.groupe].includes(o) && o !== 'reglages';
    b.classList.toggle('hors-groupe', !dans);
    if (dans && ongletVisible(o)) visibles++;
    // Libellé selon la rubrique (le compteur de nouveaux messages est gardé)
    const lib = (LIBELLES[ergo.groupe] || {})[o];
    if (!b.dataset.libelle) b.dataset.libelle = b.firstChild && b.firstChild.nodeType === 3 ? b.firstChild.textContent : b.textContent;
    const texte = lib || b.dataset.libelle;
    if (b.firstChild && b.firstChild.nodeType === 3) { if (b.firstChild.textContent.trim() !== texte.trim()) b.firstChild.textContent = texte + (b.childNodes.length > 1 ? ' ' : ''); } else if (!b.children.length) b.textContent = texte;
  });
  nav.classList.toggle('seul', visibles <= 1);
  document.querySelectorAll('.groupes button[data-groupe]').forEach((b) => {
    const g = b.dataset.groupe;
    b.classList.toggle('actif', g === ergo.groupe);
    b.setAttribute('aria-selected', g === ergo.groupe ? 'true' : 'false');
    b.hidden = g !== 'reglages' && !GROUPES[g].some((o) => ongletVisible(o) && (o !== 'meshcore' || g === 'reseau' || (g === 'messages' && etat.membre) || (g === 'gerer' && etat.gestion)));
    // Nouveaux messages : la pastille de l'onglet Messages remonte sur la rubrique
    if (g === 'messages') { const p = (bOnglet('messages') || document).querySelector('.pastille, .badge, span'); let c = b.querySelector('.pastille-groupe'); const n = p ? p.textContent.trim() : ''; if (n && n !== '0') { if (!c) { c = document.createElement('span'); c.className = 'pastille-groupe'; b.appendChild(c); } c.textContent = n; } else if (c) c.remove(); }
  });
}
function allerGroupe(g) {
  ergo.groupe = g;
  if (g === 'reglages') { bOnglet('reglages').click(); majGroupes(); if ($('#panneau').classList.contains('replie')) { const r = $('#deplier'); if (r) r.click(); } return; }
  const premier = GROUPES[g].find((o) => ongletVisible(o));
  if (!premier) { majGroupes(); return; }
  cliquerOnglet(premier, g);
}
function cliquerOnglet(o, g) {
  const b = bOnglet(o);
  if (!b) return;
  ergo.groupe = g || ergo.groupe;
  b.click();
  if (o === 'meshcore' && VUE_MC[ergo.groupe]) setTimeout(() => { const s = document.querySelector(`.sous-onglets-mc button[data-mc-vue="${VUE_MC[ergo.groupe]}"]`); if (s && !s.hidden) s.click(); majGroupes(); }, 60);
  majGroupes();
  if ($('#panneau').classList.contains('replie')) { const r = $('#deplier'); if (r) r.click(); }
}
function installerGroupes() {
  const g = document.querySelector('.groupes');
  const rep = $('#replier'); if (rep) g.appendChild(rep);
  g.querySelectorAll('button[data-groupe]').forEach((b) => (b.onclick = () => allerGroupe(b.dataset.groupe)));
  // L'onglet « Réglages » n'a pas de chargement propre : il affiche le regroupement des réglages
  const br = bOnglet('reglages');
  br.addEventListener('click', () => { ergo.groupe = 'reglages'; rendreHubReglages(); });
  // Tout changement d'onglet (clic direct, recherche, clic droit…) met la rubrique à jour
  document.querySelector('.onglets').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-onglet]');
    if (!b) return;
    if (e.isTrusted && b.dataset.onglet === 'meshcore' && VUE_MC[ergo.groupe]) setTimeout(() => { const s = document.querySelector(`.sous-onglets-mc button[data-mc-vue="${VUE_MC[ergo.groupe]}"]`); if (s && !s.hidden) s.click(); }, 60);
    if (!e.isTrusted && b.dataset.onglet !== 'meshcore') ergo.groupe = groupeDe(b.dataset.onglet);
    setTimeout(majGroupes, 0); setTimeout(majGroupes, 150);
  });
  document.addEventListener('click', (e) => { if (e.target.closest('.sous-onglets-mc button, .choix-reseau button')) { setTimeout(() => { const a = document.querySelector('.onglets button[data-onglet].actif'); if (a && a.dataset.onglet === 'meshcore') ergo.groupe = groupeDe('meshcore'); majGroupes(); }, 80); } });
  setInterval(majGroupes, 5000); // onglets affichés ou masqués par le reste de l'application (connexion, réseau choisi)
  majGroupes();
}

// ---- Accueil : « Que voulez-vous faire ? » -------------------------------------------------------------------
function choisirPointPuis(texte, action) {
  annonce(texte);
  if (matchMedia('(max-width: 900px)').matches && typeof etat.tiroir !== 'undefined') { const p = document.querySelector('.poignee-tiroir'); if (p && etat.tiroir === 'plein') p.click(); }
  document.body.classList.add('choix-point');
  carte.once('click', (e) => { document.body.classList.remove('choix-point'); action(e.latlng); });
}
function tuilesAccueil() {
  const t = [
    { ic: '👀', nom: 'Voir le réseau', aide: 'Qui est en ligne, alertes, relais', go: () => { const d = $('#pli-tableau'); if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); } } },
    { ic: '✉️', nom: 'Lire et écrire', aide: 'Messages des canaux', go: () => (etat.membre ? allerGroupe('messages') : $('#btn-admin').click()) },
    { ic: '🚩', nom: 'Signaler', aide: 'Route inondée, arbre, accident…', go: () => (etat.membre ? choisirPointPuis('Touchez la carte à l’endroit à signaler.', (ll) => formSignalement(ll.lat, ll.lng)) : $('#btn-admin').click()) },
    { ic: '📡', nom: 'Étudier la couverture', aide: 'Où ça passe, où poser un relais', go: () => allerGroupe('couverture') },
  ];
  // Signalements masqués par l'administrateur : la tuile mène à la vigilance météo
  if (typeof masquee === 'function' && masquee('signalements')) t[2] = { ic: '🌦️', nom: 'Alertes météo', aide: 'Vigilance Météo-France en cours', go: () => ficheAlertesOff() };
  if (etat.gestion) t.push({ ic: '🛠', nom: 'Gérer mes nœuds', aide: 'Programmer, équipes, positions', go: () => allerGroupe('gerer') });
  t.push({ ic: '⚙️', nom: etat.membre ? 'Régler la carte' : 'Se connecter, affichage', aide: etat.admin ? 'Tous les réglages au même endroit' : 'Compte, affichage, aide', go: () => allerGroupe('reglages') });
  return t;
}
function rendreAccueil() {
  const z = $('#accueil');
  if (!z) return;
  const tuiles = tuilesAccueil();
  const index = typeof indexReglages === 'function' ? indexReglages() : [];
  const favoris = ergo.favoris.map((n) => index.find((e) => e.t === n)).filter(Boolean);
  z.innerHTML = `<h2 class="titre-accueil">Que voulez-vous faire ?</h2>
    <div class="tuiles-accueil">${tuiles.map((x, i) => `<button type="button" class="tuile-accueil" data-i="${i}"><span class="ic" aria-hidden="true">${x.ic}</span><b>${esc(x.nom)}</b><small>${esc(x.aide)}</small></button>`).join('')}</div>
    ${favoris.length ? `<div class="raccourcis"><span class="note">⭐ Mes raccourcis</span>${favoris.map((e) => `<button type="button" class="mini" data-fav="${esc(e.t)}">${esc(e.t)}</button>`).join('')}</div>` : ''}
    <div class="pied-accueil"><button type="button" class="mini" id="acc-chercher">🔎 Chercher une fonction</button><label class="note">Affichage <select id="acc-niveau" aria-label="Niveau d’affichage">${Object.entries(NIVEAUX).map(([k, v]) => `<option value="${k}" ${k === ergo.niveau ? 'selected' : ''}>${v}</option>`).join('')}</select></label><label class="note" translate="no">🌐 Langue · Language <select id="acc-langue" aria-label="Langue · Language"><option value="fr" ${window.LANGUE !== 'en' ? 'selected' : ''}>Français</option><option value="en" ${window.LANGUE === 'en' ? 'selected' : ''}>English</option></select></label></div>`;
  z.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => tuiles[Number(b.dataset.i)].go()));
  z.querySelectorAll('[data-fav]').forEach((b) => (b.onclick = () => { const e = index.find((x) => x.t === b.dataset.fav); if (e) e.go(); }));
  $('#acc-chercher').onclick = () => ouvrirRechercheReglages();
  $('#acc-niveau').onchange = (e) => appliquerNiveau(e.target.value, true);
  $('#acc-langue').onchange = (e) => choisirLangue(e.target.value);
}
// Le tableau de bord d'origine devient repliable sous l'accueil (ouvert par défaut hors niveau simple)
function installerPliTableau() {
  const t = $('#tableau-reseau');
  if (!t || $('#pli-tableau')) return;
  const d = document.createElement('details');
  d.id = 'pli-tableau'; d.className = 'pli-tableau';
  d.innerHTML = '<summary>📊 Tableau de bord du réseau</summary>';
  t.parentNode.insertBefore(d, t);
  d.appendChild(t);
  const memo = lireLs('gaulix_pli_tableau', null);
  d.open = memo === null ? ergo.niveau !== 'simple' : !!memo;
  d.addEventListener('toggle', () => ecrireLs('gaulix_pli_tableau', d.open));
}

// ---- Réglages : tout au même endroit -------------------------------------------------------------------------
function rendreHubReglages() {
  const z = $('#hub-reglages');
  if (!z) return;
  const ligne = (ic, nom, aide, id) => `<button type="button" class="ligne-reglage" data-go="${id}"><span class="ic" aria-hidden="true">${ic}</span><span><b>${esc(nom)}</b><small>${esc(aide)}</small></span><span class="chevron" aria-hidden="true">›</span></button>`;
  const actions = {};
  const bloc = (titre, lignes) => (lignes.length ? `<h3>${titre}</h3><div class="liste-reglages">${lignes.map(([ic, nom, aide, go]) => { const id = 'r' + Object.keys(actions).length; actions[id] = go; return ligne(ic, nom, aide, id); }).join('')}</div>` : '');
  const compte = etat.membre
    ? [['👤', 'Mon compte', 'Mot de passe, double authentification, déconnexion', () => ouvrirDlg('moncompte')]]
    : [['🔑', 'Se connecter', 'Messages, signalements et gestion demandent un compte', () => $('#btn-admin').click()]];
  const carteL = !etat.admin ? [] : [
    ['🗺️', 'Carte et réseau', 'Nom, département, canaux Meshtastic à déchiffrer, conservation', () => ouvrirDlg('reglages', '[name=titre]')],
    ['📶', 'Serveur MQTT', 'Adresse, identifiants, sujets', () => ouvrirDlg('reglages', '[name=mqttUrl]')],
    ['👥', 'Comptes des utilisateurs', 'Créer, valider, rôles, secteurs', () => ouvrirDlg('comptes')],
    ['🩺', 'Diagnostic', 'Pourquoi ça ne marche pas ? Vérifie MQTT, canaux, modules, MeshCore, passerelle', () => ficheDiagnostic()],
    ['💾', 'Sauvegardes des réglages', 'Sauvegarder ou restaurer les réglages et les comptes', () => ouvrirDlg('sauvegardes')],
    ['👁️', 'Fonctions affichées', 'Masquer les signalements, Vigipirate, FR-Alert, la main courante ou les alertes Bipper / GerMaCrise (pour ne garder que la vigilance météo, par exemple)', () => dlgFonctionsMasquees()],
    ['📦', 'Sauvegarde complète', 'Tout télécharger en un fichier (base, réglages, comptes) pour changer de serveur', async () => { if (await confirmer('Télécharger la sauvegarde complète ? Le fichier contient les comptes et les clés des canaux : gardez-le en lieu sûr.', { ok: 'Télécharger' })) location.href = '/api/sauvegarde-complete'; }],
    ['♻️', 'Restaurer une sauvegarde complète', 'Reprendre tout depuis le fichier .tar.gz d’un autre serveur (remplace la base, les réglages et les comptes)', () => choisirEtRestaurer()],
    ['📜', 'Journal du serveur', 'Ce que fait la carte, erreurs', () => ouvrirDlg('journal')],
    ['⬆️', 'Mise à jour de la carte', 'Version installée, nouvelle version, mise à jour en un clic', () => ficheMaj()],
    ['🇫🇷', 'Toute la France', 'Télécharger et installer le relief de tous les départements', () => ficheFrance()],
  ];
  // Réglages propres à un réseau : seulement quand ce réseau est affiché (Meshtastic, MeshCore ou les deux)
  const vue = etat.vueReseau || 'les-deux', voitMc = vue !== 'meshtastic', lesDeux = vue === 'les-deux';
  const modules = !etat.membre ? [] : [
    ['🔌', 'Connecter un module', vue === 'meshtastic' ? 'Bluetooth, USB ou adresse IP' : vue === 'meshcore' ? 'Companion MeshCore : Bluetooth, USB ou Wi-Fi' : 'Bluetooth, USB ou adresse IP, Meshtastic ou MeshCore', () => { const b = $('#outil-connecter'); if (b) b.click(); }],
    ...(etat.admin && etat.config.meshcore && voitMc ? [['🟠', 'MeshCore', 'Module (companion), code de zone, canaux, périmètre', () => ouvrirMcVue('companion')]] : []),
    ...(etat.admin && etat.config.passerelleDispo && lesDeux ? [['⇄', 'Passerelle Meshtastic ⇄ MeshCore', 'Activer, choisir les canaux reliés, filtres', () => ouvrirPasserelle()]] : []),
    ...(etat.admin && vue !== 'meshcore' ? [['🔐', 'Équipes', 'Canal chiffré par équipe sur les nœuds des intervenants', () => ouvrirOutilProgrammer('voir-equipes')]] : []),
  ];
  z.innerHTML = `<div class="hub-reglages">
    <p class="note">Tous les réglages sont rangés ici. Vous cherchez autre chose ? <button type="button" class="mini" id="hub-chercher">🔎 Chercher</button></p>
    <h3>Affichage</h3>
    <div class="liste-reglages bloc-affichage">
      <label>Niveau d’affichage <select id="hub-niveau">${Object.entries(NIVEAUX).map(([k, v]) => `<option value="${k}" ${k === ergo.niveau ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <small class="note">Simple : l’essentiel. Opérateur : couverture avancée, trafic, outils de terrain. Expert : tout.</small>
      <label class="case"><input type="checkbox" id="hub-grand" ${document.body.classList.contains('grand-texte') ? 'checked' : ''}> Grand texte</label>
      <label class="case"><input type="checkbox" id="hub-clair" ${document.body.classList.contains('theme-clair') ? 'checked' : ''}> Thème clair (plein soleil)</label>
      <label translate="no">🌐 Langue · Language <select id="hub-langue" aria-label="Langue · Language"><option value="fr" ${window.LANGUE !== 'en' ? 'selected' : ''}>Français</option><option value="en" ${window.LANGUE === 'en' ? 'selected' : ''}>English</option></select></label>
      <div class="actions-prop"><button type="button" class="mini" id="hub-visite">🧭 Revoir la visite guidée</button><button type="button" class="mini" id="hub-aide">❓ Aide</button></div>
    </div>
    ${bloc('Compte', compte)}${bloc('Modules et réseaux', modules)}${etat.admin && etat.config.meshcore && !lesDeux ? `<p class="note">${vue === 'meshtastic' ? 'Réglages MeshCore et passerelle : choisissez « MeshCore » ou « Les deux » en haut du panneau.' : 'Réglages Meshtastic (équipes) et passerelle : choisissez « Meshtastic » ou « Les deux » en haut du panneau.'}</p>` : ''}${bloc('La carte (administrateur)', carteL)}
    <p class="note a-propos">Carte live Meshtastic / MeshCore v${esc((etat.config.version && etat.config.version.version) || '')} · créée par F4GLD · <a href="https://www.helloasso.com/associations/radioclub-du-velay/formulaires/2" target="_blank" rel="noopener">♥ Soutenir le projet</a> (Radio-club du Velay) · <a href="https://github.com/sauveteur71/carte-live-meshtastic" target="_blank" rel="noopener">code source</a></p></div>`;
  z.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => { try { actions[b.dataset.go](); } catch (e) { annonce('⚠ ' + e.message, 'erreur'); } }));
  $('#hub-chercher').onclick = () => ouvrirRechercheReglages();
  $('#hub-niveau').onchange = (e) => appliquerNiveau(e.target.value, true);
  $('#hub-grand').onchange = (e) => { document.body.classList.toggle('grand-texte', e.target.checked); ecrireLs('gaulix_grand_texte', e.target.checked); };
  $('#hub-clair').onchange = (e) => appliquerTheme(e.target.checked);
  $('#hub-langue').onchange = (e) => choisirLangue(e.target.value);
  $('#hub-visite').onclick = () => visiteGuidee(true);
  $('#hub-aide').onclick = () => ouvrirAide('Home');
}

// ---- Diagnostic « Pourquoi ça ne marche pas ? » ----------------------------------------------------------------
async function ficheDiagnostic() {
  $('#fiche').hidden = false; etat.selection = null;
  const z = $('#fiche-contenu');
  z.innerHTML = '<div class="vide">Vérifications en cours…</div>';
  let r;
  try { r = await api('/api/diagnostic'); } catch (x) { z.innerHTML = `<div class="vide">${esc(x.message)}</div>`; return; }
  const ACTIONS = {
    mqtt: ['Régler le serveur MQTT', () => ouvrirDlg('reglages', '[name=mqttUrl]')], canaux: ['Régler les canaux', () => ouvrirDlg('reglages', '[name=canaux]')],
    module: ['Connecter un module', () => { const b = $('#outil-connecter'); if (b) b.click(); }], companion: ['Relier le module MeshCore', () => ouvrirMcVue('companion', '#mc-f-wifi')],
    meshcore: ['Régler MeshCore', () => ouvrirMcVue('companion', '#mc-f-reglages [name=iata]')], passerelle: ['Ouvrir la passerelle', () => ouvrirPasserelle()], maj: ['Mise à jour', () => ficheMaj()],
  };
  const IC = { ok: '✅', attention: '⚠️', ko: '❌', info: 'ℹ️' };
  const pb = r.controles.filter((c) => c.etat === 'ko' || c.etat === 'attention').length;
  const groupes = [...new Set(r.controles.map((c) => c.groupe))];
  z.innerHTML = `<div class="diagnostic"><h2>🩺 Diagnostic</h2>
    <p class="note"><b>${pb ? pb + ' point(s) à regarder' : 'Tout va bien'}</b> · vérifié à ${new Date(r.heure).toLocaleTimeString('fr-FR')} <button type="button" class="mini" id="diag-relancer">↻ Revérifier</button></p>
    ${groupes.map((g) => `<h3>${esc(g)}</h3>${r.controles.filter((c) => c.groupe === g).map((c) => `<div class="controle ${c.etat}"><span class="ic" aria-hidden="true">${IC[c.etat]}</span><div><b>${esc(c.titre)}</b>${c.detail ? `<small>${esc(c.detail)}</small>` : ''}${c.action && ACTIONS[c.action] && c.etat !== 'ok' ? `<button type="button" class="mini principal" data-diag="${c.action}">${esc(ACTIONS[c.action][0])} ›</button>` : ''}</div></div>`).join('')}`).join('')}</div>`;
  $('#diag-relancer').onclick = ficheDiagnostic;
  z.querySelectorAll('[data-diag]').forEach((b) => (b.onclick = () => ACTIONS[b.dataset.diag][1]()));
}

// ---- Aide intégrée (pages du wiki) ---------------------------------------------------------------------------
const AIDE_PAR_ONGLET = { reseau: 'La-carte', noeuds: 'La-carte', trafic: 'Contrôle-du-trafic', analyse: 'La-carte', sites: 'Couverture-et-sites', gestion: 'Programmation-à-distance', messages: 'Messages', meshcore: 'MeshCore', reglages: 'Home' };
function markdownSimple(md) {
  const enLigne = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/!\[([^\]]*)\]\((https:[^)\s]+\.(?:jpg|png|webp))\)/g, '<img class="capture-aide" src="$2" alt="$1" loading="lazy">')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, a, b) => `<a href="#" data-aide="${(b || a).trim().replace(/ /g, '-')}">${a.trim()}</a>`)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let liste = null, code = false;
  const fermerListe = () => { if (liste) { out.push(`</${liste}>`); liste = null; } };
  for (const l of md.split('\n')) {
    if (/^```/.test(l)) { fermerListe(); out.push(code ? '</pre>' : '<pre>'); code = !code; continue; }
    if (code) { out.push(esc(l)); continue; }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { fermerListe(); const n = Math.min(4, m[1].length + 1); out.push(`<h${n}>${enLigne(m[2])}</h${n}>`); }
    else if ((m = l.match(/^\s*[-*]\s+(.*)/))) { if (liste !== 'ul') { fermerListe(); out.push('<ul>'); liste = 'ul'; } out.push(`<li>${enLigne(m[1])}</li>`); }
    else if ((m = l.match(/^\s*\d+\.\s+(.*)/))) { if (liste !== 'ol') { fermerListe(); out.push('<ol>'); liste = 'ol'; } out.push(`<li>${enLigne(m[1])}</li>`); }
    else if (/^\s*\|/.test(l)) { fermerListe(); if (!/^\s*\|[\s:|-]+\|\s*$/.test(l)) out.push(`<p class="ligne-tableau">${enLigne(l.replace(/^\s*\||\|\s*$/g, '').replace(/\|/g, ' · '))}</p>`); }
    else if (!l.trim()) fermerListe();
    else { fermerListe(); out.push(`<p>${enLigne(l)}</p>`); }
  }
  fermerListe();
  if (code) out.push('</pre>');
  return out.join('\n');
}
async function ouvrirAide(page) {
  if (!page) { const a = document.querySelector('.onglets button[data-onglet].actif'); page = AIDE_PAR_ONGLET[a ? a.dataset.onglet : 'reseau'] || 'Home'; }
  $('#fiche').hidden = false; etat.selection = null;
  const z = $('#fiche-contenu');
  z.innerHTML = '<div class="vide">Chargement de l’aide…</div>';
  let r;
  try { r = await api('/api/aide/' + encodeURIComponent(page) + (window.LANGUE === 'en' ? '?langue=en' : '')); } catch (e) { z.innerHTML = `<div class="vide">Aide indisponible sur ce serveur (${esc(e.message)}).</div>`; return; }
  z.innerHTML = `<div class="aide"><div class="actions-prop"><button type="button" class="mini" data-aide="Home">📚 Sommaire</button><button type="button" class="mini" id="aide-chercher">🔎 Chercher une fonction</button></div><div ${r.langue === window.LANGUE ? '' : 'translate="no"'}>${markdownSimple(r.texte)}</div></div>`;
  z.scrollTop = 0;
  z.querySelectorAll('[data-aide]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); ouvrirAide(a.dataset.aide); }));
  $('#aide-chercher').onclick = () => ouvrirRechercheReglages();
}

// ---- Visite guidée (première visite, ou Réglages › Revoir la visite) ------------------------------------------
function visiteGuidee(forcer) {
  if (!forcer && (lireLs('gaulix_visite', false) || etat.config.installation)) return;
  const etapes = [
    ['.groupes', 'Les 5 rubriques', 'Réseau, Messages, Couverture, Gérer et Réglages : tout part d’ici. Les sous-rubriques s’affichent juste dessous.'],
    ['#accueil', 'Que voulez-vous faire ?', 'Les grandes tuiles mènent à l’essentiel. Le tableau de bord complet est replié en dessous.'],
    ['#recherche-lieu', 'Une seule recherche', 'Un lieu, un nœud, des coordonnées… ou une fonction : tapez « mqtt », « équipes », « mise à jour ». Raccourci : Ctrl+K.'],
    ['#fab-plus', 'Le bouton ＋', 'Touchez ＋ puis la carte : signaler un événement, voir la couverture depuis ce point, le partager, tracer un profil.'],
    ['#btn-aide', 'L’aide, sur chaque écran', 'Le « ? » ouvre l’aide de l’écran affiché. Le niveau d’affichage (simple, opérateur, expert) se règle dans Réglages.'],
  ];
  let i = 0;
  let b = document.getElementById('bulle-visite');
  if (!b) { b = document.createElement('div'); b.id = 'bulle-visite'; b.className = 'bulle-visite'; b.setAttribute('role', 'dialog'); b.setAttribute('aria-live', 'polite'); document.body.appendChild(b); }
  const finir = () => { document.querySelectorAll('.cible-visite').forEach((x) => x.classList.remove('cible-visite')); b.remove(); ecrireLs('gaulix_visite', true); };
  const montrer = () => {
    document.querySelectorAll('.cible-visite').forEach((x) => x.classList.remove('cible-visite'));
    const [sel, titre, texte] = etapes[i];
    if (i === 1) allerGroupe('reseau');
    const c = document.querySelector(sel);
    if (c) { c.classList.add('cible-visite'); c.scrollIntoView({ block: 'nearest' }); }
    b.innerHTML = `<b>${esc(titre)}</b><p>${esc(texte)}</p><div class="actions-confirmer"><span class="note">${i + 1}/${etapes.length}</span><button type="button" data-v="fin">Passer</button>${i ? '<button type="button" data-v="prec">‹ Précédent</button>' : ''}<button type="button" class="principal" data-v="suiv">${i === etapes.length - 1 ? 'Terminer' : 'Suivant ›'}</button></div>`;
    b.querySelector('[data-v="fin"]').onclick = finir;
    const p = b.querySelector('[data-v="prec"]'); if (p) p.onclick = () => { i--; montrer(); };
    b.querySelector('[data-v="suiv"]').onclick = () => { if (i === etapes.length - 1) finir(); else { i++; montrer(); } };
    b.querySelector('[data-v="suiv"]').focus();
  };
  montrer();
}

// ---- Bouton ＋ : agir sur un point de la carte sans clic droit ------------------------------------------------
function installerFab() {
  const f = $('#fab-plus');
  if (!f) return;
  f.onclick = () => choisirPointPuis('Touchez la carte à l’endroit voulu : le menu des actions s’ouvrira.', (ll) => carte.fire('contextmenu', { latlng: ll, containerPoint: carte.latLngToContainerPoint(ll), layerPoint: carte.latLngToLayerPoint(ll), originalEvent: { preventDefault() {}, stopPropagation() {} } }));
}

// ---- Favoris et fonctions récentes dans la recherche ⚙️🔎 ------------------------------------------------------
function installerFavoris() {
  ergo.favoris = lireLs('gaulix_favoris_fonctions', []) || [];
  ergo.recents = lireLs('gaulix_fonctions_recentes', []) || [];
  const zr = $('#resultats-reglage');
  if (!zr) return;
  const decorer = () => {
    zr.querySelectorAll('.res-reglage').forEach((b) => {
      if (b.querySelector('.etoile')) return;
      const nom = (b.querySelector('b') || {}).textContent;
      const e = document.createElement('span');
      e.className = 'etoile'; e.setAttribute('role', 'button'); e.tabIndex = 0;
      const maj = () => { const f = ergo.favoris.includes(nom); e.textContent = f ? '⭐' : '☆'; e.title = f ? 'Retirer de mes raccourcis' : 'Ajouter à mes raccourcis (affichés sur l’accueil)'; e.setAttribute('aria-label', e.title); };
      maj();
      const basculer = (ev) => { ev.stopPropagation(); ev.preventDefault(); ergo.favoris = ergo.favoris.includes(nom) ? ergo.favoris.filter((x) => x !== nom) : [...ergo.favoris, nom].slice(-8); ecrireLs('gaulix_favoris_fonctions', ergo.favoris); maj(); rendreAccueil(); };
      e.onclick = basculer;
      e.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') basculer(ev); };
      b.appendChild(e);
    });
  };
  new MutationObserver(decorer).observe(zr, { childList: true });
  // Mémorise les dernières fonctions ouvertes par la recherche (proposées en premier, champ vide)
  zr.addEventListener('click', (ev) => { const b = ev.target.closest('.res-reglage'); if (!b || ev.target.closest('.etoile')) return; const nom = (b.querySelector('b') || {}).textContent; ergo.recents = [nom, ...ergo.recents.filter((x) => x !== nom)].slice(0, 6); ecrireLs('gaulix_fonctions_recentes', ergo.recents); });
}

// ---- Clavier et lecteurs d'écran -----------------------------------------------------------------------------
function installerAccessibilite() {
  document.body.classList.toggle('grand-texte', !!lireLs('gaulix_grand_texte', false));
  const CLIQUABLES = '.ligne[data-num], .ligne[data-cle], .ligne[data-sig], .sig-ligne, .pp-canal, .tuile, .carte-tableau, .message[data-de], tr[data-num], .non-lu, li[data-i]';
  const etiqueter = (racine) => {
    racine.querySelectorAll(CLIQUABLES).forEach((e) => { if (!e.hasAttribute('tabindex')) { e.tabIndex = 0; if (!e.getAttribute('role')) e.setAttribute('role', 'button'); } });
    // Boutons sans texte lisible : le titre sert d'étiquette
    racine.querySelectorAll('button[title]:not([aria-label]), a[title]:not([aria-label])').forEach((b) => { if (b.textContent.trim().length <= 2) b.setAttribute('aria-label', b.title); });
    racine.querySelectorAll('dialog:not([aria-label]):not([aria-labelledby])').forEach((d) => { const t = d.querySelector('h2, h3'); if (t) d.setAttribute('aria-label', t.textContent.trim()); });
  };
  etiqueter(document);
  let attente = null;
  new MutationObserver(() => { clearTimeout(attente); attente = setTimeout(() => etiqueter(document), 400); }).observe(document.body, { childList: true, subtree: true });
  // Entrée ou Espace sur un élément cliquable au clavier
  document.addEventListener('keydown', (e) => {
    if ((e.key !== 'Enter' && e.key !== ' ') || !e.target.matches || !e.target.matches('[role="button"][tabindex]') || e.target.matches('button, a, input, select, textarea')) return;
    e.preventDefault(); e.target.click();
  });
  // Échap : ferme la fiche de droite quand rien d'autre n'est ouvert
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || document.querySelector('dialog[open]') || etat.modeCarte) return;
    const f = $('#fiche'); if (f && !f.hidden) { const x = f.querySelector('.fermer, #fermer-fiche'); if (x) x.click(); else f.hidden = true; }
  });
  const carteEl = $('#carte'); if (carteEl && !carteEl.getAttribute('aria-label')) carteEl.setAttribute('aria-label', 'Carte du réseau');
}

// ---- Démarrage (appelé par app.js une fois la carte prête) ---------------------------------------------------
function demarrerErgonomie() {
  etiqueterNiveaux();
  ergo.niveau = lireLs('gaulix_niveau', null) || niveauParDefaut();
  document.body.dataset.niveau = ergo.niveau;
  installerPliTableau();
  installerGroupes();
  installerFavoris();
  installerFab();
  installerAccessibilite();
  appliquerNiveau(ergo.niveau, false);
  $('#btn-aide').onclick = () => ouvrirAide();
  { const b = $('#outil-affichage'); if (b) b.onclick = () => { const m = b.closest('details'); if (m) m.open = false; allerGroupe('reglages'); }; }
  // La recherche ⚙️🔎 propose d'abord les fonctions récentes (champ vide)
  const origine = window.indexReglages;
  if (typeof origine === 'function') {
    window.indexReglages = function () { const l = origine(); const tete = ergo.recents.map((n) => l.find((e) => e.t === n)).filter(Boolean); return [...tete, ...l.filter((e) => !tete.includes(e))]; };
  }
  setTimeout(() => visiteGuidee(false), 1800);
}

// Réglages › Fonctions affichées : l'administrateur masque des fonctions pour tous les utilisateurs de la carte
function dlgFonctionsMasquees() {
  const LISTE = [
    ['signalements', '🚩 Signalements', 'événements signalés sur la carte (route inondée…), leur couche et « Signaler un événement ici »'],
    ['vigipirate', '🛡️ Vigipirate', 'niveau affiché dans le bandeau et dans les alertes officielles'],
    ['fr-alert', '📢 FR-Alert', 'relais manuel des alertes reçues sur les téléphones'],
    ['main-courante', '📋 Main courante', 'page imprimable des signalements'],
    ['bipper', '📟 Alertes Bipper / GerMaCrise', 'envoi d’alertes aux pagers'],
    ['feux', '🔥 Feux actifs (satellite)', 'couche des foyers NASA FIRMS, alertes sur la zone et envoi radio'],
  ];
  let d = document.getElementById('dlg-fonctions');
  if (!d) { d = document.createElement('dialog'); d.id = 'dlg-fonctions'; document.body.appendChild(d); }
  const m = (etat.config && etat.config.fonctionsMasquees) || [];
  d.innerHTML = `<button class="fermer" type="button" data-fermer title="Fermer">×</button><h3>👁️ Fonctions affichées</h3>
    <p class="note">Décochez ce que les utilisateurs de cette carte ne doivent pas voir. La vigilance Météo-France reste toujours affichée. Valeur de départ possible dans le .env : <span class="mono">FONCTIONS_MASQUEES=signalements,vigipirate,fr-alert,main-courante,bipper</span>.</p>
    <div class="parametres">${LISTE.map(([k, t, x]) => `<label class="case ligne-entiere"><input type="checkbox" data-f="${k}" ${m.includes(k) ? '' : 'checked'}> <b>${t}</b> <small>${esc(x)}</small></label>`).join('')}</div>
    <div class="actions-prop"><button type="button" class="principal" data-ok>Enregistrer</button></div><p class="erreur" data-retour></p>`;
  d.querySelector('[data-fermer]').onclick = () => d.close();
  d.querySelector('[data-ok]').onclick = async () => {
    const masquees = [...d.querySelectorAll('[data-f]')].filter((x) => !x.checked).map((x) => x.dataset.f);
    try { const r = await postJson('/api/fonctions-masquees', { masquees }); etat.config.fonctionsMasquees = r.masquees; appliquerFonctionsMasquees(); d.close(); annonce('✔ Fonctions affichées enregistrées'); } catch (e) { d.querySelector('[data-retour]').textContent = e.message; }
  };
  d.showModal();
}
