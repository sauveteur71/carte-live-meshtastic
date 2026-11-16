// Tests automatiques de l'interface : node tests/interface.js
// Lance une carte vide (dossier de données temporaire, MQTT injoignable), crée le compte administrateur,
// puis ouvre la page dans Chromium (Playwright) et vérifie que l'essentiel marche : aucune erreur JavaScript,
// styles appliqués, onglets, aide, recherche (Ctrl+K, code DFCI), mode anglais sans restes de français,
// carte publique et graphe des liens. Code de sortie 1 au premier problème, avec une capture d'écran.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.error('Playwright manquant : npm i --no-save playwright && npx playwright install --with-deps chromium'); process.exit(2); }

const PORT = Number(process.env.PORT_ESSAI || 8399);
const BASE = `http://127.0.0.1:${PORT}`;
const donnees = fs.mkdtempSync(path.join(os.tmpdir(), 'carte-essai-'));
const sorties = path.join(__dirname, 'resultats');
fs.mkdirSync(sorties, { recursive: true });
const ADMIN = { identifiant: 'essai', motDePasse: 'essai-' + Math.random().toString(36).slice(2, 12) };

let serveur, navigateur, echecs = 0;
const ok = (m) => console.log('  ✓ ' + m);
const ko = (m) => { echecs++; console.log('  ✗ ' + m); };

// Foyers satellites de démonstration (la carte ne lit pas NASA FIRMS pendant l'essai)
fs.writeFileSync(path.join(donnees, 'feux.json'), JSON.stringify({ maj: Date.now(), foyers: [
  { lat: 45.05, lon: 3.9, heure: Date.now() - 3600000, source: 'VIIRS NOAA-20', confiance: 'haute', frp: 9.5, nuit: false },
  { lat: 43.5, lon: 5.2, heure: Date.now() - 20 * 3600000, source: 'MODIS', confiance: 'normale', frp: 3, nuit: true },
  { lat: 44.9, lon: 4.1, heure: Date.now() - 1800000, source: 'Meteosat SEVIRI', geo: true, confiance: 'haute', frp: 20, nuit: null },
] }));
function demarrerServeur() {
  serveur = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), FICHIER_BASE: path.join(donnees, 'carte-live.db'), MQTT_URL: 'mqtt://127.0.0.1:1', DEPARTEMENT: '43', MESHCORE: 'oui', ADMIN_MOT_DE_PASSE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = fs.createWriteStream(path.join(sorties, 'serveur.log'));
  serveur.stdout.pipe(log); serveur.stderr.pipe(log);
}
async function attendreServeur() {
  for (let k = 0; k < 60; k++) {
    try { const r = await fetch(BASE + '/api/installation'); if (r.ok) return; } catch { /* pas encore prêt */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('le serveur ne répond pas (voir tests/resultats/serveur.log)');
}
async function creerAdmin() {
  const r = await fetch(BASE + '/api/installation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ compte: ADMIN }) });
  if (!r.ok) throw new Error('installation : ' + (await r.text()));
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie.includes('=')) throw new Error('installation : pas de cookie de session');
  const [nom, valeur] = cookie.split('=');
  return { name: nom, value: valeur, domain: '127.0.0.1', path: '/' };
}

// Page ouverte avec surveillance des erreurs JavaScript et des réponses 5xx
async function ouvrir(contexte, url) {
  const page = await contexte.newPage();
  const erreurs = [];
  page.on('pageerror', (e) => erreurs.push('JS : ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_|net::|tile|tuile/i.test(m.text())) erreurs.push('console : ' + m.text()); });
  page.on('response', (r) => { if (r.status() >= 500 && r.url().startsWith(BASE)) erreurs.push(`HTTP ${r.status()} : ${r.url().slice(BASE.length)}`); });
  await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  return { page, erreurs };
}
async function capture(page, nom) { try { await page.screenshot({ path: path.join(sorties, nom + '.png') }); } catch { /* page fermée */ } }
function bilanErreurs(erreurs, quoi) {
  if (erreurs.length) ko(`${quoi} : ${erreurs.length} erreur(s)\n      ` + [...new Set(erreurs)].slice(0, 8).join('\n      '));
  else ok(`${quoi} : aucune erreur JavaScript`);
}

async function essaiCarteFrancais(contexte) {
  console.log('Carte (administrateur, français)');
  const { page, erreurs } = await ouvrir(contexte, '/');
  // Styles chargés : le bandeau du haut n'a pas le fond blanc par défaut et les boutons sont stylés
  const styles = await page.evaluate(() => {
    const b = document.querySelector('.onglets button') || document.querySelector('button');
    const cs = b && getComputedStyle(b);
    return { fond: getComputedStyle(document.body).backgroundColor, bouton: cs && cs.backgroundColor, bord: cs && cs.borderTopStyle, feuilles: document.styleSheets.length };
  });
  if (styles.feuilles && styles.fond !== 'rgba(0, 0, 0, 0)' && styles.fond !== 'rgb(255, 255, 255)' && styles.bouton && styles.bouton !== 'rgb(239, 239, 239)') ok('feuille de style appliquée');
  else ko('feuille de style non appliquée : ' + JSON.stringify(styles));
  if (await page.locator('#carte .leaflet-pane').count()) ok('carte Leaflet affichée'); else ko('carte Leaflet absente');
  if (await page.locator('#dlg-installation[open]').count()) ko('l’assistant d’installation s’ouvre alors que le compte existe');
  // Rubriques (barre du haut du panneau) puis onglets de la rubrique Réseau
  const groupe = async (g) => { const b = page.locator(`.groupes [data-groupe="${g}"]`); if (!(await b.count()) || !(await b.isVisible())) return false; await b.click(); await page.waitForTimeout(400); return true; };
  for (const [g, vue] of [['messages', 'messages'], ['couverture', 'sites'], ['gerer', 'gestion'], ['reglages', 'reglages'], ['reseau', 'reseau']]) {
    if (!(await groupe(g))) { ko(`rubrique ${g} invisible pour l’administrateur`); continue; }
    if (await page.locator(`section[data-vue="${vue}"].actif`).count()) ok(`rubrique ${g}`); else ko(`rubrique ${g} : la vue ${vue} ne s’affiche pas`);
  }
  for (const o of ['noeuds', 'trafic', 'analyse', 'reseau']) {
    const b = page.locator(`.onglets [data-onglet="${o}"]`);
    if (!(await b.count()) || !(await b.isVisible())) { ko(`onglet ${o} invisible`); continue; }
    await b.click();
    await page.waitForTimeout(300);
    if (await page.locator(`section[data-vue="${o}"].actif`).count()) ok(`onglet ${o}`); else ko(`onglet ${o} : la vue ne s’affiche pas`);
  }
  // Hub Réglages : la sauvegarde complète et la restauration y sont
  await groupe('reglages');
  const hub = await page.locator('#hub-reglages').innerText();
  if (/Sauvegarde complète/.test(hub) && /Restaurer une sauvegarde complète/.test(hub)) ok('Réglages : sauvegarde et restauration complètes'); else ko('Réglages : lignes de sauvegarde complète absentes');
  await groupe('reseau');
  // Aide : fiche ouverte avec la page du wiki
  await page.locator('#btn-aide').click();
  await page.waitForTimeout(1500);
  const aide = (await page.locator('#fiche:not([hidden]) #fiche-contenu').innerText().catch(() => '')).trim();
  if (aide.length > 200 && !/indisponible|Chargement/.test(aide.slice(0, 80))) ok('aide ouverte'); else ko('l’aide ne s’ouvre pas : ' + JSON.stringify(aide.slice(0, 100)));
  await capture(page, 'aide-fr');
  // Ctrl+K : recherche d'un réglage
  await page.locator('#carte').click({ position: { x: 300, y: 300 } }).catch(() => {});
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(400);
  if (await page.locator('#dlg-chercher[open]').count()) {
    await page.locator('#chercher-reglage').fill('mqtt');
    await page.waitForTimeout(300);
    const n = await page.locator('#resultats-reglage > *').count();
    if (n) ok(`Ctrl+K : ${n} résultat(s) pour « mqtt »`); else ko('Ctrl+K : aucun résultat pour « mqtt »');
  } else ko('Ctrl+K n’ouvre pas la recherche');
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  // Recherche d'un code DFCI : carreau dessiné sur la carte
  await page.locator('#recherche-lieu').fill('KD42F7.5');
  await page.waitForTimeout(400);
  const r = await page.locator('#resultats-lieu li').first().innerText().catch(() => '');
  if (/DFCI/.test(r) && /KD42F7\.5/.test(r)) {
    await page.locator('#recherche-lieu').press('Enter');
    await page.waitForTimeout(800);
    const poly = await page.locator('#carte path[stroke="#ff5a1f"]').count();
    if (poly) ok('recherche DFCI : carreau tracé'); else ko('recherche DFCI : aucun contour sur la carte');
  } else ko('recherche DFCI : pas de résultat « DFCI » (obtenu : ' + JSON.stringify(r) + ')');
  // Couche des feux actifs
  const f = await page.evaluate(() => fetch('/api/feux').then((x) => x.json())).catch(() => ({}));
  if ((f.foyers || []).some((x) => x.lat === 45.05 && x.dfci)) ok(`feux actifs : ${f.foyers.length} foyer(s) servi(s), avec code DFCI`); else ko('feux actifs : ' + JSON.stringify(f).slice(0, 200));
  await page.evaluate(() => { const b = document.querySelector('.bascule[data-couche="feux"]'); if (b) b.click(); });
  await page.waitForTimeout(800);
  const nf = await page.locator('#carte path[fill="#ff1f1f"], #carte path[fill="#a0522d"]').count();
  const ng = await page.locator('#carte path[stroke-dasharray="5 4"]').count();
  if (ng >= 1) ok('feux actifs : foyer Meteosat dessiné (cercle de 2 km)'); else ko('feux actifs : foyer Meteosat absent');
  if (nf >= 2) ok(`feux actifs : couche affichée (${nf} foyers)`); else ko('feux actifs : ' + nf + ' foyer(s) dessiné(s)');
  await page.evaluate(() => { const b = document.querySelector('.bascule[data-couche="feux"]'); if (b) b.click(); });
  // Responsable d'un nœud et « pour le joindre »
  const rp = await page.evaluate(async () => {
    const post = await fetch('/api/noeuds/305419896/responsable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ personne: 'F4XYZ Essai', contact: '06 00 00 00 00' }) }).then((x) => x.json());
    const l = await fetch('/api/responsables').then((x) => x.json());
    const j = await fetch('/api/noeuds/305419896/joindre').then((x) => x.json());
    return { post, l: l['305419896'], j };
  }).catch((e) => ({ erreur: e.message }));
  if (rp.l && rp.l.personne === 'F4XYZ Essai' && rp.l.contact) ok('responsable d’un nœud enregistré'); else ko('responsable : ' + JSON.stringify(rp).slice(0, 200));
  if (rp.j && Array.isArray(rp.j.lignes)) ok('pour le joindre : réponse valide'); else ko('pour le joindre : ' + JSON.stringify(rp.j).slice(0, 200));
  // Auteur d'un message cliquable : menu fiche / message direct / carte
  const menu = await page.evaluate(() => {
    const d = document.createElement('div'); d.innerHTML = boutonAuteur(305419896); document.body.appendChild(d);
    d.querySelector('[data-auteur]').click();
    const m = document.querySelector('.menu-noeud'); const t = m ? m.textContent : '';
    if (m) m.remove(); d.remove(); return t;
  }).catch((e) => 'erreur ' + e.message);
  if (/Fiche du nœud/.test(menu) && /Message direct/.test(menu)) ok('auteur de message : menu fiche et message direct'); else ko('auteur de message : ' + menu);
  // --- Non-régression : bugs signalés le 15/11 ---
  // 1. « Alertes météo » : la fiche s'affiche même sans choix de canaux mémorisé (et ne garde pas l'ancienne fiche)
  const ao = await page.evaluate(async () => {
    try { localStorage.removeItem('gaulix_canaux_envoi'); } catch { /* */ }
    $('#fiche-contenu').innerHTML = '<div id="ancienne-fiche">fiche d’un nœud supprimé</div>';
    ao.info = await fetch('/api/alertes-officielles').then((x) => x.json());
    let err = null; try { ficheAlertesOff(); } catch (e) { err = e.message; }
    return { err, ancienne: !!document.getElementById('ancienne-fiche'), alertes: !!document.querySelector('#fiche-contenu .alertes-off'), cache: $('#fiche').hidden };
  }).catch((e) => ({ err: e.message }));
  if (!ao.err && !ao.ancienne && ao.alertes && !ao.cache) ok('alertes météo : fiche affichée, l’ancienne fiche est remplacée'); else ko('alertes météo : ' + JSON.stringify(ao));
  // 2. Nouveaux messages : la pastille de la rubrique « Messages » suit le compteur aussitôt
  const nl = await page.evaluate(() => {
    nonLus['mc:public'] = 3; majBadgesMessages();
    const g = document.querySelector('.groupes button[data-groupe="messages"] .pastille-groupe');
    const t = g ? g.textContent : '';
    delete nonLus['mc:public']; majBadgesMessages();
    return { t, apres: !!document.querySelector('.groupes button[data-groupe="messages"] .pastille-groupe') };
  }).catch((e) => ({ t: 'erreur ' + e.message }));
  if (nl.t === '3' && !nl.apres) ok('nouveaux messages : pastille de la rubrique Messages'); else ko('pastille Messages : ' + JSON.stringify(nl));
  // 3. Programmer (MeshCore) : les opérations lancées par la carte elle-même sont marquées « automatique »
  const auto = await page.evaluate(async () => {
    const src = await fetch('/meshcore.js').then((x) => x.text());
    return /etiquette-auto/.test(src) && /🤖 automatique/.test(src);
  }).catch(() => false);
  if (auto) ok('programmer : opérations automatiques signalées'); else ko('programmer : étiquette « automatique » absente');
  // 4. Réglages avancés (variables du .env) : liste, fiche, refus d'une valeur hors bornes (sans redémarrer)
  const va = await page.evaluate(async () => {
    const l = await fetch('/api/reglages/variables').then((x) => x.json());
    const secretVisible = l.variables.some((v) => v.type === 'secret' && v.valeur !== undefined);
    const refus = await fetch('/api/reglages/variables', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ variables: { SEUIL_BATTERIE_POURCENT: '250' } }) });
    const inconnu = await fetch('/api/reglages/variables', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ variables: { PORT: '80' } }) });
    await ficheReglagesAvances();
    const n = document.querySelectorAll('#f-avances [data-va]').length;
    return { nb: l.variables.length, secretVisible, refus: refus.status, inconnu: inconnu.status, champs: n };
  }).catch((e) => ({ erreur: e.message }));
  if (va.nb > 30 && !va.secretVisible && va.refus === 400 && va.inconnu === 400 && va.champs === va.nb) ok(`réglages avancés : ${va.nb} réglages, secrets jamais renvoyés, valeurs hors bornes refusées`); else ko('réglages avancés : ' + JSON.stringify(va));
  // 5. Brokers supplémentaires réglables dans la fenêtre Broker MQTT ; adresse invalide refusée (sans redémarrer)
  const bk = await page.evaluate(async () => {
    const m = await fetch('/api/mqtt').then((x) => x.json());
    const refus = await fetch('/api/reglages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mqtt: { brokers: 'http://pas-un-broker' } }) });
    const masque = await fetch('/api/reglages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mqtt: { brokers: 'mqtts://nom:***@inconnu:8883' } }) });
    return { champ: typeof m.brokersReglage === 'string', refus: refus.status, masque: masque.status };
  }).catch((e) => ({ erreur: e.message }));
  if (bk.champ && bk.refus === 400 && bk.masque === 400) ok('brokers supplémentaires : réglables, adresses invalides refusées'); else ko('brokers supplémentaires : ' + JSON.stringify(bk));
  await capture(page, 'carte-fr');
  bilanErreurs(erreurs, 'carte en français');
  await page.close();
}

// En anglais : textes d'interface sans morceaux de français (hors noms et contenus des utilisateurs, translate="no")
const RESTES_FRANCAIS = /\bà day\b|\b(les|des|aucun|aucune|avec|pour|depuis|réglages|nœuds?|réseau|carte|signalements?|équipes?|couverture|télécharger|envoyer|supprimer|enregistrer|liens|passerelles?|dernières?|heures|jours|vus?|sauts?|reçus?|émis)\b/i;
async function textesVisibles(page, selecteur) {
  return page.evaluate((sel) => {
    const out = [];
    const racine = document.querySelector(sel) || document.body;
    const w = document.createTreeWalker(racine, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = n.nodeValue.replace(/\s+/g, ' ').trim();
      if (t.length < 3) continue;
      const el = n.parentElement;
      if (!el || el.closest('[translate="no"], script, style, .leaflet-control-attribution, .leaflet-map-pane, .mono, code')) continue;
      if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue; // caché
      out.push(t);
    }
    return out;
  }, selecteur);
}
async function essaiAnglais(contexte) {
  console.log('Carte en anglais');
  const { page, erreurs } = await ouvrir(contexte, '/');
  await page.evaluate(() => { localStorage.setItem('gaulix_langue', 'en'); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  if ((await page.evaluate(() => document.documentElement.lang)) === 'en') ok('interface passée en anglais'); else ko('la langue anglaise ne s’applique pas');
  const restes = new Set();
  const relever = async () => { for (const t of await textesVisibles(page, 'body')) if (RESTES_FRANCAIS.test(t)) restes.add(t.slice(0, 120)); };
  for (const g of ['reseau', 'messages', 'couverture', 'gerer', 'reglages']) {
    const b = page.locator(`.groupes [data-groupe="${g}"]`);
    if (!(await b.count()) || !(await b.isVisible())) continue;
    await b.click();
    await page.waitForTimeout(700);
    await relever();
    if (g === 'reseau') for (const o of ['noeuds', 'trafic', 'analyse']) { const t = page.locator(`.onglets [data-onglet="${o}"]`); if (await t.isVisible().catch(() => false)) { await t.click(); await page.waitForTimeout(600); await relever(); } }
  }
  if (restes.size) ko(`${restes.size} texte(s) restés en français :\n      ` + [...restes].slice(0, 15).join('\n      '));
  else ok('aucun reste de français dans les onglets');
  await capture(page, 'carte-en');
  bilanErreurs(erreurs, 'carte en anglais');
  await page.evaluate(() => { localStorage.setItem('gaulix_langue', 'fr'); });
  await page.close();
}

// Mode consultation (lien « Explorer en détail ») : même connecté en administrateur, rien à modifier ni à émettre
async function essaiConsultation(contexte) {
  console.log('Carte détaillée en consultation (compte administrateur connecté)');
  const { page, erreurs } = await ouvrir(contexte, '/?consultation&vue=45.1,3.9,12');
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  const r = await page.evaluate(() => ({
    bandeau: !!document.querySelector('.bandeau-consultation'),
    admin: etat.admin || etat.gestion || etat.membre,
    gerer: !!document.querySelector('[data-groupe="gerer"]') && !!document.querySelector('[data-groupe="gerer"]').offsetParent,
    connecter: !!document.querySelector('#outil-connecter') && !!document.querySelector('#outil-connecter').offsetParent,
    zoom: carte.getZoom(),
  }));
  if (r.bandeau && r.gerer && !r.connecter) ok('consultation : bandeau affiché, tous les écrans, pas de module à relier'); else ko('consultation : ' + JSON.stringify(r));
  if (r.zoom === 12) ok('consultation : même vue que la carte publique'); else ko('consultation : zoom ' + r.zoom + ' au lieu de 12');
  await capture(page, 'consultation');
  bilanErreurs(erreurs, 'consultation');
  await page.close();
}

// Démonstration pour tout visiteur, sans compte : tous les écrans, secrets masqués, aucune écriture
async function essaiDemoVisiteur(navig) {
  console.log('Démonstration (visiteur sans compte)');
  const contexte = await navig.newContext({ viewport: { width: 1400, height: 900 }, locale: 'fr-FR' });
  await contexte.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  const { page, erreurs } = await ouvrir(contexte, '/?consultation');
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  const r = await page.evaluate(async () => {
    const vis = (q) => { const e = document.querySelector(q); return !!e && !!e.offsetParent; };
    const reg = await fetch('/api/reglages').then((x) => x.status === 200 ? x.json() : x.status);
    const sansDemo = await fetch('/api/reglages', { headers: { 'X-Demo': '' } }).then((x) => x.status).catch(() => 0);
    const comptes = await fetch('/api/comptes').then((x) => x.status);
    let ecriture = 'acceptée';
    try { await fetch('/api/reglages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (e) { ecriture = e.message; }
    return { messages: vis('[data-groupe="messages"]'), gerer: vis('[data-groupe="gerer"]'), connexion: vis('#btn-admin'), canaux: reg && reg.canaux, mqttUtil: reg && reg.mqtt && reg.mqtt.utilisateur, sansDemo, comptes, ecriture };
  });
  if (r.messages && r.gerer && !r.connexion) ok('démonstration : Messages et Gérer visibles, pas de connexion ni d’inscription'); else ko('démonstration : ' + JSON.stringify(r));
  if (typeof r.canaux === 'string' && !/AQ==/.test(r.canaux) && [401, 403].includes(r.comptes)) ok('démonstration : réglages lisibles, clés masquées, comptes refusés'); else ko('démonstration (lecture) : ' + JSON.stringify(r));
  if (/Démonstration/.test(r.ecriture)) ok('démonstration : écriture bloquée'); else ko('démonstration : écriture ' + r.ecriture);
  await capture(page, 'demo');
  bilanErreurs(erreurs.filter((e) => !/HTTP 401|401/.test(e)), 'démonstration');
  await contexte.close();
}

// Modules USB simulés (Web Serial) : un module Meshtastic répond 0x94 0xC3, un companion MeshCore répond « > » code 13
function simulerUsb() {
  const ecoutes = { connect: [], disconnect: [] };
  class Port {
    constructor(genre) { this.genre = genre; this.readable = null; this.writable = null; }
    getInfo() { return { usbVendorId: 0x10c4, usbProductId: 0xea60 }; }
    async open() {
      if (this.readable) throw new DOMException('port already open', 'InvalidStateError');
      const p = this; let ctl;
      this.readable = new ReadableStream({ start(c) { ctl = c; } });
      this.fermer = () => { try { ctl.close(); } catch { /* déjà */ } };
      this.writable = new WritableStream({ write(o) {
        try {
          if (p.genre === 'mt' && o[0] === 0x94) ctl.enqueue(new Uint8Array([0x94, 0xc3, 0, 2, 8, 1]));
          if (p.genre === 'mc' && o[0] === 0x3c) ctl.enqueue(new Uint8Array([0x3e, 4, 0, 13, 9, 1, 2, 3]));
        } catch { /* flux fermé */ }
      } });
    }
    async close() { if (this.fermer) this.fermer(); this.readable = null; this.writable = null; }
    async setSignals() {}
  }
  const ports = [new Port('mt')];
  const serie = { getPorts: async () => ports.slice(), requestPort: async () => { throw new DOMException('aucun', 'NotFoundError'); }, addEventListener: (t, f) => ecoutes[t] && ecoutes[t].push(f) };
  Object.defineProperty(Navigator.prototype, 'serial', { get: () => serie, configurable: true });
  window.__usb = {
    brancher(genre) { const p = new Port(genre); ports.push(p); ecoutes.connect.forEach((f) => f({ target: p })); },
    debrancher(genre) { const i = ports.findIndex((p) => p.genre === genre); if (i < 0) return; const p = ports.splice(i, 1)[0]; ecoutes.disconnect.forEach((f) => f({ target: p })); },
  };
}

async function essaiUsbAuto(navig, cookie) {
  console.log('Modules USB de ce PC reliés tout seuls (simulés)');
  const contexte = await navig.newContext({ viewport: { width: 1400, height: 900 }, locale: 'fr-FR' });
  await contexte.addCookies([cookie]);
  await contexte.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  await contexte.addInitScript(simulerUsb);
  const { page, erreurs } = await ouvrir(contexte, '/');
  const attendre = async (f, ms = 15000) => { const fin = Date.now() + ms; while (Date.now() < fin) { if (await page.evaluate(f)) return true; await page.waitForTimeout(300); } return false; };
  if (await attendre(() => moduleNav.etat === 'relie')) ok('module Meshtastic déjà autorisé : relié tout seul au chargement'); else ko('module Meshtastic non relié au chargement (état ' + await page.evaluate(() => moduleNav.etat + ' ' + moduleNav.erreur) + ')');
  await page.evaluate(() => window.__usb.debrancher('mt'));
  if (await attendre(() => moduleNav.etat === 'aucun', 5000)) ok('module débranché : libéré tout de suite, sans reconnexion'); else ko('module débranché toujours occupé (' + await page.evaluate(() => moduleNav.etat) + ')');
  await page.evaluate(() => window.__usb.brancher('mc'));
  if (await attendre(() => mc.nav.etat === 'relie')) ok('companion MeshCore branché : reconnu et relié tout seul'); else ko('companion MeshCore non relié (' + await page.evaluate(() => mc.nav.etat + ' ' + mc.nav.erreur) + ')');
  await page.evaluate(() => window.__usb.brancher('mt'));
  if (await attendre(() => moduleNav.etat === 'relie')) ok('nouveau module Meshtastic branché : relié à côté du companion'); else ko('nouveau module Meshtastic non relié');
  const annonces = await page.evaluate(() => [...document.querySelectorAll('#annonces .annonce')].map((d) => d.textContent).join(' | '));
  if (/Meshtastic relié/.test(annonces) && /MeshCore relié/.test(annonces)) ok('annonces « relié » affichées'); else ko('annonces manquantes : ' + annonces);
  await page.evaluate(() => { debrancherModuleNav(); mcDebrancherNav(); });
  bilanErreurs(erreurs.filter((e) => !/HTTP 401|401|WebSocket/.test(e)), 'USB automatique');
  await contexte.close();
}

async function essaiEcran150(navig) {
  console.log('Ordinateur à 150 % (1280 × 620)');
  const contexte = await navig.newContext({ viewport: { width: 1280, height: 620 }, locale: 'fr-FR' });
  await contexte.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  const { page, erreurs } = await ouvrir(contexte, '/');
  await page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); const v = document.querySelector('.marque .version'); if (v) v.textContent = 'v2.22.0 · v2.22.1 disponible'; });
  await page.waitForTimeout(400);
  const g = await page.evaluate(() => {
    const b = (q) => { const e = document.querySelector(q); return e && e.offsetParent !== null ? e.getBoundingClientRect() : null; };
    const croise = (x, y) => !!x && !!y && x.left < y.right && y.left < x.right && x.top < y.bottom && y.top < x.bottom;
    const barre = b('.barre'), outils = b('.outils'), rech = b('.recherche-lieu'), pan = b('.panneau'), leg = b('.legende');
    return { barreOutils: croise(barre, outils), rechOutils: croise(rech, outils), rechBarre: croise(rech, barre), panOutils: croise(pan, outils), legOutils: croise(leg, outils) };
  });
  if (!Object.values(g).some(Boolean)) ok('écran à 150 % : barre, outils, recherche, panneau et légende sans chevauchement'); else ko('écran à 150 % : chevauchement ' + JSON.stringify(g));
  await capture(page, 'ecran-150');
  bilanErreurs(erreurs.filter((e) => !/HTTP 401|401/.test(e)), 'écran à 150 %');
  await contexte.close();
}

async function essaiTelephone(navig) {
  console.log('Téléphone (portrait)');
  const contexte = await navig.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR' });
  await contexte.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  const { page, erreurs } = await ouvrir(contexte, '/');
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  // Badge « vX disponible » sur une 2e ligne : la barre grandit, la recherche et le bouton ◎ doivent rester dessous
  await page.evaluate(() => { const v = document.querySelector('.marque .version'); if (v) v.textContent = 'v2.22.0 · v2.22.1 disponible'; });
  await page.waitForTimeout(400);
  const g = await page.evaluate(() => { const b = (q) => { const e = document.querySelector(q); return e ? e.getBoundingClientRect() : null; }; const a = b('.barre'), s = b('.recherche-lieu'), l = b('.leaflet-top.leaflet-right'); return { barre: a && a.bottom, rech: s && [s.top, s.bottom], bouton: l && l.top }; });
  if (g.barre && g.rech && g.rech[0] >= g.barre && (!g.bouton || g.bouton >= g.rech[1])) ok('téléphone : recherche et bouton ◎ sous la barre du haut, sans chevauchement'); else ko('téléphone : chevauchement en haut ' + JSON.stringify(g));
  await capture(page, 'telephone');
  bilanErreurs(erreurs.filter((e) => !/HTTP 401|401/.test(e)), 'téléphone');
  await contexte.close();
}

async function essaiPagesPubliques(navig) {
  for (const [url, nom, attendu] of [['/publique.html', 'carte publique', '#carte .leaflet-pane, .leaflet-pane'], ['/topologie.html', 'graphe des liens', 'svg, canvas']]) {
    console.log(nom[0].toUpperCase() + nom.slice(1) + ' (visiteur)');
    const contexte = await navig.newContext({ viewport: { width: 1280, height: 800 }, locale: 'fr-FR' });
    await contexte.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); } catch { /* */ } });
    const { page, erreurs } = await ouvrir(contexte, url);
    if (await page.locator(attendu).count()) ok(`${nom} affichée`); else ko(`${nom} : contenu absent`);
    if (url === '/publique.html') { const h = await page.getAttribute('#lien-explorer', 'href').catch(() => null); if (h && h.startsWith('/?consultation&vue=')) ok('carte publique : lien « Explorer en détail »'); else ko('carte publique : lien d’exploration ' + h); }
    await capture(page, nom.replace(/ /g, '-'));
    bilanErreurs(erreurs, nom);
    await contexte.close();
  }
}

(async () => {
  let code = 0;
  try {
    demarrerServeur();
    await attendreServeur();
    const cookie = await creerAdmin();
    navigateur = await chromium.launch();
    const contexte = await navigateur.newContext({ viewport: { width: 1400, height: 900 }, locale: 'fr-FR' });
    await contexte.addCookies([cookie]);
    await contexte.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); if (!localStorage.getItem('gaulix_langue')) localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
    await essaiCarteFrancais(contexte);
    await essaiAnglais(contexte);
    await essaiConsultation(contexte);
    await contexte.close();
    await essaiDemoVisiteur(navigateur);
    await essaiUsbAuto(navigateur, cookie);
    await essaiEcran150(navigateur);
    await essaiTelephone(navigateur);
    await essaiPagesPubliques(navigateur);
    code = echecs ? 1 : 0;
    console.log(echecs ? `\n${echecs} problème(s) : captures et journal dans tests/resultats/` : '\nTout est bon ✓');
  } catch (e) {
    console.error('Essai interrompu :', e.message);
    code = 1;
  } finally {
    if (navigateur) await navigateur.close().catch(() => {});
    if (serveur) serveur.kill();
    fs.rmSync(donnees, { recursive: true, force: true });
    process.exit(code);
  }
})();
