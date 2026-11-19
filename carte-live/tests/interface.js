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
    env: { ...process.env, PORT: String(PORT), FICHIER_BASE: path.join(donnees, 'carte-live.db'), MQTT_URL: 'mqtt://127.0.0.1:1', DEPARTEMENT: '43', MESHCORE: 'oui', ADMIN_MOT_DE_PASSE: '', AGENTS_PORT: String(PORT + 5), PAT_URL: `http://127.0.0.1:${PORT + 7}`, PAT_INDICATIF: 'F4XYZ', SMTP_HOTE: 'fichier', CARTE_ADRESSE: 'https://carte.essai', STATS_PAYS: 'non' },
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

// Agent 1.7 « direct » simulé : il annonce un module déjà reconnu, la carte le relie tout de suite ; débranché, il disparaît.
// Puis l'agent prêt à l'emploi : le programme téléchargé porte l'adresse de la carte et le code à la fin.
// Nœuds d'un autre preset et écoute UDP : les panneaux s'ouvrent et s'affichent sans erreur
async function essaiRejoindre(navig, cookie) {
  console.log('Page « Rejoindre le réseau »');
  const entetes = { Cookie: `${cookie.name}=${cookie.value}`, 'Content-Type': 'application/json' };
  const avant = await fetch(BASE + '/api/rejoindre');
  if (avant.status === 404) ok('page Rejoindre : non publiée par défaut'); else ko('page Rejoindre publiée sans action de l’administrateur');
  const refus = await fetch(BASE + '/api/rejoindre/reglages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (refus.status === 401 || refus.status === 403) ok('page Rejoindre : réglages refusés sans compte'); else ko('page Rejoindre : réglages acceptés sans compte (' + refus.status + ')');
  const mauvais = await fetch(BASE + '/api/rejoindre/reglages', { method: 'POST', headers: entetes, body: JSON.stringify({ lienCanal: 'https://exemple.fr/x' }) });
  if (mauvais.status === 400) ok('page Rejoindre : lien de canal invalide refusé'); else ko('page Rejoindre : lien invalide accepté');
  const lien = 'https://meshtastic.org/e/#CgMSAQESBggBQANIAQ';
  const e = await fetch(BASE + '/api/rejoindre/reglages', { method: 'POST', headers: entetes, body: JSON.stringify({ actif: true, presentation: 'Bienvenue sur le réseau d’essai', lienCanal: lien, limiteSauts: 4, antennes: 'Antenne A\nAntenne B', donsLien: 'https://exemple.org/dons', mcFrequence: '869,618 MHz' }) });
  if (e.ok) ok('page Rejoindre : réglages enregistrés'); else ko('page Rejoindre : enregistrement refusé ' + e.status);
  const contexte = await navig.newContext({ viewport: { width: 390, height: 844 }, locale: 'fr-FR' });
  await contexte.addInitScript(() => { try { localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  const { page, erreurs } = await ouvrir(contexte, '/rejoindre');
  await page.waitForSelector('.canal .qr svg', { timeout: 10000 }).catch(() => {});
  const r = await page.evaluate(() => ({ texte: document.querySelector('main').textContent, qr: document.querySelectorAll('.qr svg').length, lien: (document.querySelector('a.bouton.principal') || {}).href, large: document.documentElement.scrollWidth > innerWidth + 1 }));
  if (r.qr === 2 && r.lien === lien) ok('page Rejoindre : QR du canal, lien vers l’appli, QR de la page'); else ko('page Rejoindre : QR ou lien manquant ' + JSON.stringify({ qr: r.qr, lien: r.lien }));
  if (/Limite de sauts/.test(r.texte) && /4/.test(r.texte) && /Antenne B/.test(r.texte) && /869,618 MHz/.test(r.texte) && /Soutenir le réseau/.test(r.texte) && /Les règles du réseau/.test(r.texte)) ok('page Rejoindre : sauts, rôles, règles, antennes, MeshCore, dons'); else ko('page Rejoindre : contenu incomplet');
  if (!r.large) ok('page Rejoindre : pas de défilement horizontal sur téléphone'); else ko('page Rejoindre : déborde en largeur sur téléphone');
  if (process.env.CAPTURE_REJOINDRE) await page.screenshot({ path: process.env.CAPTURE_REJOINDRE, fullPage: true });
  bilanErreurs(erreurs, 'page Rejoindre');
  // Réseau MeshCore seul : lien du canal et limite de sauts vides → pas de partie Meshtastic
  await fetch(BASE + '/api/rejoindre/reglages', { method: 'POST', headers: entetes, body: JSON.stringify({ lienCanal: '', limiteSauts: '' }) });
  const ctx2 = await navig.newContext({ viewport: { width: 390, height: 844 }, locale: 'fr-FR' }); // nouveau contexte : /api/rejoindre est gardé 60 s en cache
  await ctx2.addInitScript(() => { try { localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  const seul = await ouvrir(ctx2, '/rejoindre');
  await seul.page.waitForSelector('footer', { timeout: 10000 }).catch(() => {});
  const t2 = await seul.page.evaluate(() => document.querySelector('main').textContent);
  if (!/Régler votre nœud Meshtastic/.test(t2) && /Régler votre nœud MeshCore/.test(t2) && /LoRa · MeshCore/.test(t2)) ok('page Rejoindre : partie Meshtastic masquée quand elle est laissée vide'); else ko('page Rejoindre : partie Meshtastic affichée alors que vide');
  await ctx2.close();
  await fetch(BASE + '/api/rejoindre/reglages', { method: 'POST', headers: entetes, body: JSON.stringify({ lienCanal: lien, limiteSauts: 4 }) });
  const pub = await ouvrir(contexte, '/publique');
  await pub.page.waitForTimeout(1500);
  if (await pub.page.evaluate(() => !document.getElementById('lien-rejoindre').hidden)) ok('carte publique : bouton « Rejoindre le réseau »'); else ko('carte publique : bouton Rejoindre absent');
  await contexte.close();
}

async function essaiAutresPresets(navig, cookie) {
  console.log('Nœuds à inviter et écoute UDP');
  const contexte = await navig.newContext({ viewport: { width: 1400, height: 900 }, locale: 'fr-FR' });
  await contexte.addCookies([cookie]);
  await contexte.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  const { page, erreurs } = await ouvrir(contexte, '/');
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  const t = await page.evaluate(async () => { await ficheAutresPresets(); return document.querySelector('#fiche-contenu').textContent; });
  if (/Nœuds à inviter/.test(t) && /Votre réseau est en/.test(t) && /Modules sentinelles/.test(t)) ok('panneau « Nœuds à inviter » : preset du réseau, sentinelles, liste'); else ko('panneau « Nœuds à inviter » : ' + t.slice(0, 200));
  const bouton = await page.evaluate(() => { const b = document.querySelector('#outil-inviter'); return b ? !b.hidden : null; });
  if (bouton) ok('bouton « Nœuds à inviter » dans Outils pour l’administrateur'); else ko('bouton « Nœuds à inviter » absent');
  await page.evaluate(() => ouvrirBroker());
  await page.waitForTimeout(1500);
  const b = await page.evaluate(() => document.querySelector('#mqtt-contenu').textContent);
  if (/Modules du réseau local \(UDP\)/.test(b) && /Désactivé/.test(b)) ok('broker : rubrique « Modules du réseau local (UDP) », désactivée par défaut'); else ko('broker : rubrique UDP absente');
  bilanErreurs(erreurs, 'nœuds à inviter');
  await contexte.close();
}

async function essaiRegistreEtExports(navig, cookie) {
  console.log('Registre des relais, calculette des pertes, export KML');
  const contexte = await navig.newContext({ viewport: { width: 1400, height: 900 }, locale: 'fr-FR' });
  await contexte.addCookies([cookie]);
  await contexte.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  const { page, erreurs } = await ouvrir(contexte, '/');
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  const t = await page.evaluate(async () => { await ficheRegistreRelais(); return document.querySelector('#fiche-contenu').textContent; });
  if (/Registre des relais/.test(t) && /Autorisation/.test(t) && /Exporter le registre/.test(t)) ok('registre des relais : tableau, autorisations, export CSV'); else ko('registre des relais : ' + t.slice(0, 120));
  const calc = await page.evaluate(() => {
    const champ = document.querySelector('#form-profil input[name="pertes"]');
    const b = champ && champ.parentElement.querySelector('.calculette-btn');
    if (!b) return null;
    b.click();
    const p = champ.parentElement.querySelector('.calculette-pertes');
    p.querySelector('[data-c="long"]').value = '10'; p.querySelector('[data-c="conn"]').value = '2';
    p.querySelector('[data-c="long"]').dispatchEvent(new Event('input'));
    p.querySelector('[data-c="ok"]').click();
    return Number(champ.value);
  });
  if (calc > 2 && calc < 4) ok(`calculette des pertes : 10 m de RG213 + 2 connecteurs = ${calc} dB`); else ko('calculette des pertes : ' + calc);
  const kml = await (await fetch(BASE + '/api/export/reseau.kml')).text();
  const direct = await fetch(BASE + '/api/export/reseau-direct.kml');
  const derriereProxy = await (await fetch(BASE + '/api/export/reseau-direct.kml?origine=' + encodeURIComponent('https://127.0.0.1:' + PORT), { headers: { 'X-Forwarded-Host': '127.0.0.1:' + PORT } })).text();
  const autreHote = await (await fetch(BASE + '/api/export/reseau-direct.kml?origine=' + encodeURIComponent('https://exemple.org'))).text();
  if (/<href>https:\/\/127\.0\.0\.1:\d+\/api\/export\/reseau\.kml<\/href>/.test(derriereProxy) && !/exemple\.org/.test(autreHote)) ok('lien KML en direct : adresse https vue par le navigateur, autre hôte refusé'); else ko('lien KML en direct : ' + derriereProxy.slice(0, 200));
  if (/^<\?xml/.test(kml) && /<kml /.test(kml) && /Relais et passerelles/.test(kml) && /reseau\.kml/.test(await direct.text()) && /reseau-direct\.kml/.test(direct.headers.get('content-disposition') || '')) ok('export KML pour ATAK (réseau et lien en direct)'); else ko('export KML');
  bilanErreurs(erreurs, 'registre et exports');
  await contexte.close();
}
async function essaiAdministrationALaDemande(navig, cookie) {
  console.log('Écrans d’administration chargés à la demande');
  // Visiteur : le fichier d'administration n'est pas téléchargé
  const ctxV = await navig.newContext({ viewport: { width: 1400, height: 900 }, locale: 'fr-FR' });
  await ctxV.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  const pv = await ctxV.newPage();
  let charge = false;
  pv.on('request', (r) => { if (/\/administration\.js/.test(r.url())) charge = true; });
  await pv.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await pv.waitForTimeout(4500);
  if (!charge) ok('visiteur : écrans d’administration non téléchargés'); else ko('visiteur : administration.js téléchargé');
  await ctxV.close();
  // Administrateur : chaque écran s'ouvre par son relais, sans erreur
  const contexte = await navig.newContext({ viewport: { width: 1400, height: 900 }, locale: 'fr-FR' });
  await contexte.addCookies([cookie]);
  await contexte.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  const { page, erreurs } = await ouvrir(contexte, '/');
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  const essais = [
    ['ficheMaj', 'Mise à jour'], ['ouvrirBroker', 'MQTT'], ['ficheFrance', 'France'], ['ficheModeles', 'odèle'], ['ficheV28', '2.8'],
    ['ficheRegistreRelais', 'Registre des relais'], ['ficheAutresPresets', 'preset'],
  ];
  for (const [f, attendu] of essais) {
    const t = await page.evaluate(async (nom) => {
      try { await window[nom](); await new Promise((r) => setTimeout(r, 400)); } catch (e) { return 'ERREUR ' + e.message; }
      const d = document.querySelector('dialog[open]');
      const txt = (d ? d.textContent : '') + ' ' + document.querySelector('#fiche-contenu').textContent;
      document.querySelectorAll('dialog[open]').forEach((x) => x.close());
      return txt;
    }, f);
    if (!/^ERREUR/.test(t) && t.includes(attendu)) ok(`${f} : écran ouvert`); else ko(`${f} : ${t.slice(0, 140)}`);
  }
  for (const pan of ['comptes', 'journal', 'sauvegardes', 'reglages', 'frequentation']) {
    const t = await page.evaluate(async (p) => { await ouvrirDlg(p); await new Promise((r) => setTimeout(r, 700)); const x = document.querySelector(`#pan-${p}`); const v = x ? x.textContent.trim().length : 0; document.querySelectorAll('dialog[open]').forEach((d) => d.close()); return v; }, pan);
    if (t > 20) ok(`gestion › ${pan} : rempli`); else ko(`gestion › ${pan} vide`);
  }
  // Message direct vers un nœud dont le module n'a pas la clé : avertissement avant l'envoi, canal proposé
  const avert = await page.evaluate(async () => {
    await preparerEnvoi(); const f = $('#form-envoi'); if (!f || f.hidden) return 'formulaire caché';
    const n = [...etat.noeuds.values()].find((x) => x.num !== (etat.radio && etat.radio.noeudLocal)) || { num: 0x1234567 };
    f.vers.insertAdjacentHTML('beforeend', `<option value="d${n.num}">test</option>`); f.vers.value = 'd' + n.num;
    envoi.clesConnues = new Set(); avertirCleDirect(); const a = !!$('#avert-cle') && /clé publique/.test($('#avert-cle').textContent);
    envoi.clesConnues = new Set([n.num]); avertirCleDirect(); const b = !$('#avert-cle');
    return a && b ? 'ok' : `a=${a} b=${b}`;
  });
  if (avert === 'ok') ok('message direct sans clé publique : averti avant l’envoi'); else ko('avertissement clé publique : ' + avert);
  const relais = await page.evaluate(() => ['ficheMaj', 'ouvrirBroker', 'editeurReglages', 'rendreComptes'].filter((n) => window[n].relais).length);
  if (relais === 0) ok('relais remplacés par les vraies fonctions'); else ko(`${relais} relais non remplacé(s)`);
  bilanErreurs(erreurs, 'administration à la demande');
  await contexte.close();
}
async function essaiVue3D(navig) {
  console.log('Vue 3D du réseau');
  const contexte = await navig.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-GB' });
  await contexte.addInitScript(() => { try { localStorage.setItem('gaulix_langue', 'en'); } catch { /* */ } });
  const { page, erreurs } = await ouvrir(contexte, '/relief3d.html');
  await page.waitForTimeout(2000);
  const v = await page.evaluate(() => ({ h1: document.querySelector('h1').textContent, carte: !!window.carte3d && !!document.querySelector('#carte3d canvas'), legende: document.querySelector('#legende').textContent }));
  if (v.carte) ok('vue 3D : carte MapLibre affichée'); else ko('vue 3D : carte absente');
  if (v.h1 === '3D network view' && /Good link/.test(v.legende) && !/Relais|Nœud/.test(v.legende)) ok('vue 3D : traduite en anglais'); else ko('vue 3D en anglais : ' + v.h1 + ' / ' + v.legende.slice(0, 80));
  await capture(page, 'vue-3d');
  bilanErreurs(erreurs, 'vue 3D');
  await contexte.close();
}
async function essaiProfil3D(navig) {
  console.log('Profil 3D d’une liaison');
  const contexte = await navig.newContext({ viewport: { width: 1280, height: 800 } });
  // Altitudes simulées (le service IGN n'est pas joignable pendant les essais) : une bosse au milieu qui coupe la visée
  const serie = [];
  for (let i = 0; i <= 40; i++) {
    const d = i * 250, sol = 800 + 400 * Math.exp(-(((i - 20) / 5) ** 2)), visee = 806 + (i / 40) * 100;
    serie.push({ d, sol, solCourbe: sol, visee, fresnel: i === 0 || i === 40 ? 0 : 20 * Math.sin((Math.PI * i) / 40) });
  }
  await contexte.route('**/api/profil?**', (r) => r.fulfill({ json: {
    a: { num: null, nom: 'Sommet A', lat: 45.05, lon: 3.85, sol: 800, antenne: 6 }, b: { num: null, nom: 'Sommet B', lat: 45.08, lon: 3.97, sol: 900, antenne: 6 },
    distanceKm: 10, sourceAltitude: 'essai', preset: 'LONG_FAST', parametres: { frequenceMHz: 869.525 }, serie,
    obstacle: { distanceKm: 5, degagementM: -350, v: 20 }, verdict: 'Obstruée par le relief à 5.0 km (350 m au-dessus de la ligne de visée)',
    bilan: { fspl: 111, diffraction: 30, puissanceRecue: -110, bruit: -117, sensibilite: -137, snrEstime: 7, snrLimite: -20, marge: 27 }, mesure: {},
  } }));
  const { page, erreurs } = await ouvrir(contexte, '/relief3d.html?profil=1&aLat=45.05&aLon=3.85&bLat=45.08&bLon=3.97&ha=6&hb=6');
  await page.waitForTimeout(2500);
  const v = await page.evaluate(() => {
    const c = window.carte3d;
    const src = c && c.getSource('profil-visee');
    return { couches: c ? ['profil-trace', 'profil-fresnel', 'profil-visee'].filter((id) => c.getLayer(id)).length : 0,
      troncons: src ? src.serialize().data.features.length : 0, h1: document.querySelector('h1').textContent,
      info: (document.querySelector('#profil-info') || {}).textContent || '', etiquettes: document.querySelectorAll('.etiq-profil').length,
      bloque: !!document.querySelector('.etiq-profil.bloque') };
  });
  if (v.couches === 3 && v.troncons >= 40) ok('profil 3D : visée, Fresnel et tracé dessinés'); else ko('profil 3D : ' + JSON.stringify(v));
  if (/Sommet A → Sommet B/.test(v.h1) && /Obstruée|Blocked/.test(v.info) && v.etiquettes === 3 && v.bloque) ok('profil 3D : titre, verdict et obstacle signalés'); else ko('profil 3D (textes) : ' + JSON.stringify(v));
  await capture(page, 'profil-3d');
  bilanErreurs(erreurs, 'profil 3D');
  await contexte.close();
}
// Faux Pat (client Winlink) : état, boîtes, dépôt d'un message, session, liste des passerelles RMS
let fauxPat = null;
const patDepots = [];
function demarrerFauxPat() {
  const http = require('http');
  fauxPat = http.createServer((req, res) => {
    const json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    let corps = '';
    req.on('data', (x) => { corps += x; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/api/status') return json({ connected: false, dialing: false, active_listeners: [] });
      if (u.pathname === '/api/mailbox/in') return json([{ MID: 'ABC123', Date: new Date().toISOString(), From: { Addr: 'F1PREF' }, To: [{ Addr: 'F4XYZ' }], Subject: 'Point de situation préfecture', Unread: true, Files: [] }]);
      if (u.pathname === '/api/mailbox/in/ABC123') return json({ MID: 'ABC123', Date: new Date().toISOString(), From: { Addr: 'F1PREF' }, To: [{ Addr: 'F4XYZ' }], Subject: 'Point de situation préfecture', Body: 'Activation ADRASEC 43 confirmée.', Files: [] });
      if (/^\/api\/mailbox\/(out|sent|archive)$/.test(u.pathname) && req.method === 'GET') return json([]);
      if (u.pathname === '/api/mailbox/out' && req.method === 'POST') { patDepots.push(Object.fromEntries(new URLSearchParams(corps))); return json('OK'); }
      if (u.pathname === '/api/connect') return json({ NumReceived: 2 });
      if (u.pathname === '/api/rmslist') return json([{ callsign: 'F1ZZZ-10', gridsquare: 'JN15xc', distance: 12, modes: 'VARA HF 2300', freq: { hz: 3590000, khz: 3590, desc: '3.590.00 MHz' }, url: 'varahf:///F1ZZZ-10?freq=3590' }]);
      res.statusCode = 404; res.end('not found');
    });
  }).listen(PORT + 7, '127.0.0.1');
}
async function essaiAdrasec(navig, cookie) {
  console.log('Section ADRASEC (radiogoniométrie, main courante, Winlink)');
  const H = { 'Content-Type': 'application/json', Cookie: `${cookie.name}=${cookie.value}` };
  const appel = async (m, url, b) => { const r = await fetch(BASE + url, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(url + ' : ' + (j.erreur || r.status)); return j; };
  const moi = await (await fetch(BASE + '/api/compte', { headers: H })).json();
  await appel('PUT', '/api/adrasec/reglages', { actif: true });
  let sansGroupe = '';
  try { await appel('GET', '/api/adrasec'); } catch (e) { sansGroupe = e.message; }
  await appel('PUT', '/api/adrasec/groupes/43', { nom: 'ADRASEC 43' });
  if (/Aucune ADRASEC/.test(sansGroupe)) ok('ADRASEC : création de l’ADRASEC du département demandée avant usage'); else ko('ADRASEC sans groupe : ' + sansGroupe);
  const eq = await appel('POST', '/api/adrasec/equipes', { nom: 'Gonio 1' });
  await appel('PUT', '/api/adrasec/membres/' + moi.id, { membre: true, licencie: true, indicatif: 'F4XYZ', equipe: eq.equipes[0].id });
  let refus = '';
  try { await appel('PUT', '/api/adrasec/membres/' + moi.id, { membre: true, licencie: true, indicatif: 'PASBON' }); } catch (e) { refus = e.message; }
  if (/Indicatif invalide/.test(refus)) ok('ADRASEC : indicatif invalide refusé'); else ko('ADRASEC : indicatif invalide accepté ' + refus);
  const r = await appel('POST', '/api/adrasec/recherches', { nom: 'Balise essai', frequence: '121,5 MHz' });
  // Trois équipes autour d'un émetteur placé en 45.10, 3.95 (gisements à ±2° près)
  const G = require('../public/gonio.js');
  const cible = { lat: 45.10, lon: 3.95 };
  for (const [lat, lon, err] of [[45.0, 3.85, 1.5], [45.05, 4.10, -2], [45.20, 3.90, 1]]) await appel('POST', '/api/adrasec/releves', { recherche: r.id, lat, lon, gisement: +(G.azimut({ lat, lon }, cible) + err).toFixed(1), incertitude: 5 });
  await appel('POST', '/api/adrasec/releves', { recherche: r.id, locator: 'JN15WD', gisement: 45, incertitude: 5 });
  const vue = await appel('GET', '/api/adrasec');
  const rech = vue.recherches.find((x) => x.id === r.id);
  const err = rech.calcul.estimation ? G.distance(rech.calcul.estimation, cible) : Infinity;
  if (rech.releves.length === 4 && err < 1500) ok(`ADRASEC : 4 relevés, émetteur situé à ${Math.round(err)} m près`); else ko('ADRASEC calcul : ' + JSON.stringify(rech.calcul).slice(0, 300));
  if (vue.mainCourante.filter((x) => /^Relevé/.test(x.texte)).length === 4 && vue.mainCourante.some((x) => /Ouverture de la recherche/.test(x.texte))) ok('ADRASEC : relevés et ouverture inscrits à la main courante'); else ko('ADRASEC main courante : ' + vue.mainCourante.length);
  const csv = await (await fetch(BASE + '/api/adrasec/main-courante.csv', { headers: H })).text();
  if (/Date;Heure;Auteur/.test(csv) && /F4XYZ/.test(csv)) ok('ADRASEC : export CSV de la main courante'); else ko('ADRASEC CSV : ' + csv.slice(0, 100));
  const anonyme = await fetch(BASE + '/api/adrasec');
  if (anonyme.status === 401) ok('ADRASEC : refusé sans connexion'); else ko('ADRASEC sans connexion : HTTP ' + anonyme.status);
  // Plusieurs départements : l'administrateur crée l'ADRASEC 42 ; un compte demande à la rejoindre comme SWL,
  // l'administrateur l'accepte et le nomme président ; il ne voit que son ADRASEC et ne nomme pas de président
  await appel('PUT', '/api/adrasec/groupes/42', { nom: 'ADRASEC 42' });
  const b1 = await appel('POST', '/api/comptes', { identifiant: 'benevole42', motDePasse: 'Essai-benevole-2026!' });
  const cx = await fetch(BASE + '/api/connexion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiant: 'benevole42', motDePasse: 'Essai-benevole-2026!' }) });
  const HB = { 'Content-Type': 'application/json', Cookie: (cx.headers.get('set-cookie') || '').split(';')[0] };
  const appelB = async (m, url, b) => { const x = await fetch(BASE + url, { method: m, headers: HB, body: b ? JSON.stringify(b) : undefined }); return { statut: x.status, j: await x.json().catch(() => ({})) }; };
  const avant = await appelB('GET', '/api/adrasec');
  const sansChoix = await appelB('POST', '/api/adrasec/demande', { qualite: 'swl' });
  const dem = await appelB('POST', '/api/adrasec/demande', { groupe: '42', qualite: 'swl', numeroSwl: 'f-12345', message: 'Équipe gonio' });
  const vue43 = await appel('GET', '/api/adrasec?g=43'), vue42 = await appel('GET', '/api/adrasec?g=42');
  const d1 = (vue42.demandes || []).find((x) => x.compte === b1.id);
  if (avant.statut === 403 && sansChoix.statut === 400 && dem.statut === 200 && d1 && d1.qualite === 'swl' && d1.numeroSwl === 'F-12345' && !(vue43.demandes || []).length && vue42.groupes.length === 2) ok('ADRASEC : demande d’adhésion pour l’ADRASEC de son département (SWL), visible de cette seule ADRASEC'); else ko('ADRASEC demande : ' + JSON.stringify({ avant: avant.statut, sansChoix: sansChoix.statut, dem, d1, d43: vue43.demandes }));
  await appel('PUT', '/api/adrasec/membres/' + b1.id + '?g=42', { membre: true, qualite: 'swl', numeroSwl: 'F-12345', responsable: true });
  const apres = await appelB('GET', '/api/adrasec?g=43'); // demande une autre ADRASEC : reçoit la sienne
  const eqB = await appelB('POST', '/api/adrasec/equipes', { nom: 'Gonio B' });
  const nomme = await appelB('PUT', '/api/adrasec/membres/' + b1.id, { membre: true, qualite: 'swl', responsable: false });
  const winB = await appelB('POST', '/api/adrasec/winlink/envoyer', { a: 'X', sujet: 'x', corps: 'x' });
  const double = await appel('PUT', '/api/adrasec/membres/' + b1.id + '?g=43', { membre: true }).then(() => 'accepté', (e) => e.message);
  const wlAutre = await appelB('GET', '/api/adrasec/winlink/boite/in');
  if (wlAutre.statut === 400 && /réservée à ADRASEC 43/.test(wlAutre.j.erreur) && apres.j.winlink && apres.j.winlink.autorise === false) ok('Winlink : boîte réservée à l’ADRASEC de la station (refusée à une autre ADRASEC)'); else ko('Winlink réservé : ' + JSON.stringify({ wl: wlAutre, w: apres.j.winlink }));
  if (apres.statut === 200 && apres.j.code === '42' && apres.j.moi.responsable && apres.j.moi.qualite === 'swl' && !apres.j.mainCourante.length && eqB.statut === 200 && nomme.statut === 400 && /administrateur de la carte/.test(nomme.j.erreur) && winB.statut === 403 && /déjà membre de ADRASEC 42/.test(double)) ok('ADRASEC : président de son département (équipes, membres), ADRASEC séparées, SWL sans Winlink, un seul département par membre'); else ko('ADRASEC président : ' + JSON.stringify({ apres: apres.statut, code: apres.j.code, resp: apres.j.moi && apres.j.moi.responsable, mc: apres.j.mainCourante && apres.j.mainCourante.length, eqB: eqB.statut, nomme, win: winB.statut, double }));
  // Case ADRASEC de la gestion des comptes : cocher intègre le compte à l'ADRASEC du département de la carte
  const b2 = await appel('POST', '/api/comptes', { identifiant: 'bruno43', motDePasse: 'Essai-bruno-2026!!' });
  const r1 = await appel('PUT', '/api/adrasec/roles/' + b2.id, { groupe: 'AUTO' });
  const r2 = await appel('PUT', '/api/adrasec/roles/' + b2.id, { groupe: r1.groupe, president: true });
  const roles = await appel('GET', '/api/adrasec/roles');
  const r3 = await appel('PUT', '/api/adrasec/roles/' + b2.id, { groupe: '' });
  if (r1.groupe === '43' && r2.president && roles.roles[b2.id] && roles.roles[b2.id].president && roles.groupes.length === 2 && r3.groupe === null) ok('ADRASEC : case ADRASEC et président depuis la gestion des comptes'); else ko('ADRASEC case comptes : ' + JSON.stringify({ r1, r2, r3, role: roles.roles[b2.id] }));
  // Diffusion radio (pas de module dans l'essai : refus explicite) et lien terrain sans compte
  let refusRadio = '';
  try { await appel('POST', `/api/adrasec/recherches/${r.id}/diffuser`, { canal: 0 }); } catch (e) { refusRadio = e.message; }
  const reglage = await appel('POST', `/api/adrasec/recherches/${r.id}/diffuser`, { canal: 1, auto: true, reglageSeul: true });
  if (/module radio non connecté/.test(refusRadio) && reglage.diffusion.canal === 1 && reglage.diffusion.auto) ok('ADRASEC : diffusion radio réglée, refus clair sans module'); else ko('diffusion : ' + refusRadio + ' ' + JSON.stringify(reglage));
  const lien = await appel('POST', `/api/adrasec/recherches/${r.id}/lien`);
  const vt = await (await fetch(BASE + '/api/terrain/' + lien.jeton)).json();
  const faux = await fetch(BASE + '/api/terrain/' + '0'.repeat(32));
  if (vt.releves && vt.releves.length === 4 && vt.calcul.estimation && !JSON.stringify(vt).includes('F4XYZ') && faux.status === 404) ok('lien terrain : recherche visible sans compte, aucun nom de compte, faux jeton refusé'); else ko('lien terrain : ' + JSON.stringify(vt).slice(0, 200) + ' ' + faux.status);
  const ct = await navig.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: 'fr-FR' });
  const t = await ouvrir(ct, '/terrain/' + lien.jeton);
  const tf = await t.page.evaluate(() => ({ fiche: document.querySelector('#fiche').textContent, titre: document.querySelector('#titre').textContent }));
  if (/Position la plus probable/.test(tf.fiche) && /Balise essai/.test(tf.titre)) ok('page terrain (téléphone) : position estimée affichée'); else ko('page terrain : ' + JSON.stringify(tf));
  await capture(t.page, 'adrasec-terrain');
  bilanErreurs(t.erreurs, 'page terrain');
  await ct.close();
  // Winlink par le faux Pat
  const boite = await appel('GET', '/api/adrasec/winlink/boite/in');
  await appel('POST', '/api/adrasec/winlink/envoyer', { a: 'F1PREF, cod@prefecture.example', sujet: 'Essai', corps: 'Bonjour' });
  const rms = await appel('GET', '/api/adrasec/winlink/passerelles');
  const sess = await appel('POST', '/api/adrasec/winlink/session', { cible: 'telnet' });
  let cibleRefusee = '';
  try { await appel('POST', '/api/adrasec/winlink/session', { cible: 'telnet; rm -rf /' }); } catch (e) { cibleRefusee = e.message; }
  if (boite[0] && boite[0].de === 'F1PREF' && patDepots[0] && patDepots[0].to === 'F1PREF,cod@prefecture.example' && /F4XYZ · ADRASEC 43/.test(patDepots[0].body) && rms[0] && Math.abs(rms[0].lat - 45.1) < 0.1 && sess.recus === 2 && /invalide/.test(cibleRefusee)) ok('Winlink : boîte, dépôt signé, passerelles positionnées, session, cible douteuse refusée');
  else ko('Winlink : ' + JSON.stringify({ boite: boite[0], depot: patDepots[0], rms: rms[0], sess, cibleRefusee }).slice(0, 400));
  // Non licencié : lecture oui, envoi non
  await appel('PUT', '/api/adrasec/membres/' + moi.id, { membre: true, licencie: false });
  const contexteNL = await fetch(BASE + '/api/adrasec/winlink/envoyer', { method: 'POST', headers: H, body: JSON.stringify({ a: 'F1PREF', sujet: 'x', corps: 'y' }) });
  if (contexteNL.status === 403) ok('Winlink : envoi refusé à un membre non licencié'); else ko('Winlink non licencié : HTTP ' + contexteNL.status);
  await appel('PUT', '/api/adrasec/membres/' + moi.id, { membre: true, licencie: true, indicatif: 'F4XYZ' });
  // Page
  const contexte = await navig.newContext({ viewport: { width: 1400, height: 900 }, locale: 'fr-FR' });
  await contexte.addCookies([cookie]);
  await contexte.addInitScript(() => { try { localStorage.setItem('adrasec-onglet', 'gonio'); } catch { /* */ } });
  const { page, erreurs } = await ouvrir(contexte, '/adrasec');
  const p = await page.evaluate(() => ({ titre: document.querySelector('#titre').textContent, resultat: (document.querySelector('.resultat') || {}).textContent || '', cones: document.querySelectorAll('#carte path.leaflet-interactive, #carte svg path').length, gestion: !document.querySelector('[data-vue="gestion"]').hidden }));
  if (/ADRASEC 43/.test(p.titre) && /Position la plus probable/.test(p.resultat) && p.cones >= 8 && p.gestion) ok('page ADRASEC : estimation, cônes et onglet Gestion'); else ko('page ADRASEC : ' + JSON.stringify(p));
  // Clic sur la carte : point de l'équipe et aperçu du gisement tapé
  await page.evaluate(() => { document.querySelector('[data-pos="carte"]').click(); });
  await page.mouse.click(300, 450);
  await page.fill('#g-gis', '45');
  await page.waitForTimeout(400);
  const ap = await page.evaluate(() => ({ retenue: /Retenue/.test(document.querySelector('#g-pos-detail').textContent), tip: /pas encore envoyé/.test(document.body.innerText) }));
  if (ap.retenue && ap.tip) ok('page ADRASEC : point de l’équipe et aperçu du gisement après un clic'); else ko('aperçu du relevé : ' + JSON.stringify(ap));
  // Relevé donné par une autre équipe (saisie au PC) : équipe choisie dans la liste
  const eqs = await page.evaluate(() => [...document.querySelectorAll('#g-equipe option')].map((o) => o.value).filter(Boolean));
  if (eqs.length) await page.selectOption('#g-equipe', eqs[eqs.length - 1]);
  await page.click('#g-envoyer'); await page.waitForTimeout(1500);
  const der = await page.evaluate(async () => { const v = await (await fetch('/api/adrasec')).json(); const r = v.recherches.find((x) => x.statut === 'en-cours'); const x = v.releves ? null : null; return { eqChoisie: document.querySelector('#g-equipe') && document.querySelector('#g-equipe').value, dernier: r && r.releves && r.releves[r.releves.length - 1] }; });
  if (eqs.length && der.dernier && der.dernier.equipe === eqs[eqs.length - 1] && der.eqChoisie === eqs[eqs.length - 1]) ok('page ADRASEC : équipe qui donne le relevé choisie à la saisie (gardée pour le suivant)'); else ko('relevé d’une équipe : ' + JSON.stringify({ eqs, der }));
  // Corriger l'équipe d'un relevé enregistré : la couleur de son trait suit
  const rid = await page.evaluate(() => { const s = document.querySelector('[data-releve-equipe]'); return s && s.dataset.releveEquipe; });
  if (rid && eqs.length) { await page.selectOption(`[data-releve-equipe="${rid}"]`, eqs[0]); await page.waitForTimeout(1500); }
  const corr = await page.evaluate(async (id) => { const v = await (await fetch('/api/adrasec')).json(); const r = v.recherches.find((x) => x.statut === 'en-cours'); const x = r.releves.find((y) => y.id === id); const e = v.equipes.find((q) => q.id === (x && x.equipe)); return { equipe: x && x.equipe, couleur: e && e.couleur, trait: [...document.querySelectorAll('#carte path')].some((p) => (p.getAttribute('stroke') || '').toLowerCase() === (e && e.couleur || '').toLowerCase()) }; }, rid);
  if (rid && corr.equipe === eqs[0] && corr.trait) ok('page ADRASEC : équipe d’un relevé corrigée, trait à la couleur de l’équipe'); else ko('correction d’équipe d’un relevé : ' + JSON.stringify({ rid, corr }));
  await capture(page, 'adrasec-gonio');
  await page.click('[data-vue="winlink"]');
  await page.waitForTimeout(1500);
  const w = await page.evaluate(() => document.querySelector('#vue-winlink').textContent);
  if (/F4XYZ/.test(w) && /Point de situation préfecture/.test(w) && /Rédiger/.test(w)) ok('page ADRASEC : onglet Winlink'); else ko('page Winlink : ' + w.slice(0, 200));
  await page.click('[data-vue="equipes"]');
  await page.waitForTimeout(500);
  await page.click('[data-mission]');
  const opts = await page.evaluate(() => [...document.querySelectorAll('.choix-mission option')].map((o) => o.textContent));
  if (opts.some((o) => /Recherche « Balise essai »/.test(o)) && opts.some((o) => /Autre mission/.test(o))) ok('page ADRASEC : mission choisie dans la liste (recherche en cours)'); else ko('mission : ' + JSON.stringify(opts));
  await page.click('[data-vue="winlink"]');
  await page.waitForTimeout(1500);
  await capture(page, 'adrasec-winlink');
  await page.click('[data-vue="gestion"]');
  await page.waitForTimeout(1200);
  const g = await page.evaluate(() => { const f = document.querySelector('.fiche-membre'); const v = document.querySelector('#vue-gestion'); const n = f && f.querySelector('.ge-noeud'); return { fiche: !!f, deborde: v.scrollWidth > v.clientWidth + 2, aide: n ? (n.closest('label').title || '').length : 0, liste: document.querySelectorAll('#ge-noeuds option').length }; });
  const g2 = await page.evaluate(() => ({ resp: !!document.querySelector('.ge-resp:not([disabled])'), lien: /\/adrasec/.test(document.querySelector('#vue-gestion').textContent), qual: !!document.querySelector('.ge-qual'), groupes: document.querySelectorAll('.ligne-groupe').length, choix: document.querySelectorAll('#choix-groupe option').length }));
  // Intégration de plusieurs comptes cochés d'un coup
  await page.evaluate(async () => { for (const n of ['multi-un', 'multi-deux']) await fetch('/api/comptes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiant: n, motDePasse: 'Multi-compte-2026' }) }); });
  await page.reload(); await page.waitForTimeout(1500);
  await page.click('#onglets [data-vue="gestion"]'); await page.waitForTimeout(800);
  const nb0 = await page.evaluate(() => document.querySelectorAll('#ge-fiches .fiche-membre').length);
  const multi = await page.evaluate(() => { const l = [...document.querySelectorAll('#ge-ajout-liste input:not([disabled])')]; l.slice(0, 2).forEach((x) => { x.checked = true; }); document.querySelector('#ge-ajout-liste').dispatchEvent(new Event('change', { bubbles: true })); return { n: l.length, bouton: document.querySelector('#ge-ajouter').textContent }; });
  if (multi.n >= 2) { await page.click('#ge-ajouter'); await page.waitForTimeout(1500); }
  const nb1 = await page.evaluate(() => document.querySelectorAll('#ge-fiches .fiche-membre').length);
  if (multi.n >= 2 && /\(2\)/.test(multi.bouton) && nb1 === nb0 + 2) ok('page ADRASEC : plusieurs comptes cochés intégrés d’un coup'); else ko('ADRASEC intégration multiple : ' + JSON.stringify({ multi, nb0, nb1 }));
  // Équipes : « ＋ Membres », cocher, ajouter ; ✕ sort de l'équipe
  await page.click('#onglets [data-vue="equipes"]'); await page.waitForTimeout(500);
  const eqAvant = await page.evaluate(() => document.querySelectorAll('#vue-equipes .entree')[0].querySelectorAll('.puce-membre').length);
  await page.click('#vue-equipes [data-ajout-eq]');
  await page.evaluate(() => { const l = [...document.querySelectorAll('.choix-membres .liste-ajout input')].slice(0, 2); l.forEach((x) => { x.checked = true; }); document.querySelector('.choix-membres .liste-ajout').dispatchEvent(new Event('change', { bubbles: true })); });
  await page.click('.choix-membres button.principal'); await page.waitForTimeout(1500);
  const eqApres = await page.evaluate(() => document.querySelectorAll('#vue-equipes .entree')[0].querySelectorAll('.puce-membre').length);
  await page.click('#vue-equipes .entree [data-sortir]'); await page.waitForTimeout(1200);
  const eqSorti = await page.evaluate(() => document.querySelectorAll('#vue-equipes .entree')[0].querySelectorAll('.puce-membre').length);
  if (eqApres === eqAvant + 2 && eqSorti === eqApres - 1) ok('page ADRASEC : membres cochés ajoutés à une équipe, ✕ pour en sortir'); else ko('ADRASEC composition d’équipe : ' + JSON.stringify({ eqAvant, eqApres, eqSorti }));
  await page.click('#onglets [data-vue="gestion"]'); await page.waitForTimeout(500);
  if (g.fiche && !g.deborde && g.aide > 50 && g2.resp && g2.lien && g2.qual && g2.groupes === 2 && g2.choix === 2) ok('page ADRASEC : ADRASEC hébergées, fiches (qualité, président), lien d’adhésion, sans débordement'); else ko('page ADRASEC gestion : ' + JSON.stringify({ ...g, ...g2 }));
  await capture(page, 'adrasec-gestion');
  bilanErreurs(erreurs, 'section ADRASEC');
  await contexte.close();
  // Lien d'adhésion sans compte : la carte ouvre directement l'inscription
  const c3 = await navig.newContext({ viewport: { width: 1200, height: 850 }, locale: 'fr-FR' });
  await c3.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  const p3 = await ouvrir(c3, '/adrasec');
  const liens = await p3.page.evaluate(() => [...document.querySelectorAll('.adhesion a.bouton')].map((a) => a.getAttribute('href')));
  await p3.page.goto(BASE + liens[0]);
  await p3.page.waitForTimeout(1800);
  const insc = await p3.page.evaluate(() => ({ ouvert: document.querySelector('#dlg-compte').open, form: !!document.querySelector('#form-inscription') && document.querySelector('#form-inscription').offsetParent !== null }));
  if (liens.length === 2 && /compte=inscription/.test(liens[0]) && insc.ouvert && insc.form) ok('page ADRASEC sans compte : « Créer mon compte » ouvre l’inscription de la carte'); else ko('adhésion sans compte : ' + JSON.stringify({ liens, insc }));
  await c3.close();
  // Réglages › Fonctions de la carte : interrupteurs (section ADRASEC, Winlink, fonctions affichées)
  const c2 = await navig.newContext({ viewport: { width: 1400, height: 900 }, locale: 'fr-FR' });
  await c2.addCookies([cookie]);
  await c2.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  const o = await ouvrir(c2, '/');
  await o.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  const visible = await o.page.evaluate(() => !document.querySelector('#outil-fonctions').hidden);
  await o.page.evaluate(() => dlgFonctionsCarte());
  await o.page.waitForTimeout(1500);
  const f = await o.page.evaluate(() => { const d = document.querySelector('#dlg-fonctions-carte'); return { ouvert: d && d.open, adrasec: !!(d && d.querySelector('[data-adrasec]:checked')), winlink: d ? /Pat joignable/.test(d.textContent) : false, inters: d ? d.querySelectorAll('.interrupteur').length : 0 }; });
  if (visible && f.ouvert && f.adrasec && f.winlink && f.inters >= 7) ok('Fonctions de la carte : bouton du menu, section ADRASEC activée, Winlink joignable, interrupteurs'); else ko('Fonctions de la carte : ' + JSON.stringify({ visible, ...f }));
  await capture(o.page, 'fonctions-carte');
  bilanErreurs(o.erreurs, 'fonctions de la carte');
  await c2.close();
}
async function essaiMotDePasseOublie(navig, cookie) {
  console.log('Mot de passe oublié (e-mail, lien de l’administrateur)');
  const H = { 'Content-Type': 'application/json', Cookie: `${cookie.name}=${cookie.value}` };
  const appel = async (m, url, b, h = H) => { const r = await fetch(BASE + url, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }); return { statut: r.status, j: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie') }; };
  const SANS = { 'Content-Type': 'application/json' };
  const a1 = (await appel('POST', '/api/comptes', { identifiant: 'oubli-mail', motDePasse: 'Ancien-mdp-2026', email: 'oubli@exemple.fr' })).j;
  const a2 = (await appel('POST', '/api/comptes', { identifiant: 'oubli-admin', motDePasse: 'Ancien-mdp-2026' })).j;
  // Par e-mail : lien écrit dans courriels-essai (SMTP_HOTE=fichier), même réponse pour un compte inconnu
  const dossier = path.join(donnees, 'courriels-essai');
  const etat = (await appel('GET', '/api/mot-de-passe/oubli', null, SANS)).j;
  const r1 = await appel('POST', '/api/mot-de-passe/oubli', { identifiant: 'oubli@exemple.fr' }, SANS);
  const inconnu = await appel('POST', '/api/mot-de-passe/oubli', { identifiant: 'personne-de-ce-nom' }, SANS);
  const mails = fs.existsSync(dossier) ? fs.readdirSync(dossier) : [];
  const mail = mails.length ? JSON.parse(fs.readFileSync(path.join(dossier, mails[mails.length - 1]), 'utf8')) : {};
  const jeton = (/https:\/\/carte\.essai\/\?reinit=([\w-]+)/.exec(mail.text || '') || [])[1];
  if (etat.courriel && r1.statut === 200 && JSON.stringify(r1.j) === JSON.stringify(inconnu.j) && mails.length === 1 && mail.to && mail.to[0].address === 'oubli@exemple.fr' && jeton) ok('mot de passe oublié : lien envoyé par e-mail, même réponse pour un compte inconnu'); else ko('oubli par e-mail : ' + JSON.stringify({ etat, r1: r1.j, inconnu: inconnu.j, mails: mails.length, to: mail.to }));
  const court = await appel('POST', '/api/mot-de-passe/reinitialiser', { jeton, nouveau: 'court' }, SANS);
  const bon = await appel('POST', '/api/mot-de-passe/reinitialiser', { jeton, nouveau: 'Nouveau-mdp-2026' }, SANS);
  const encore = await appel('POST', '/api/mot-de-passe/reinitialiser', { jeton, nouveau: 'Autre-mdp-2026!' }, SANS);
  const ancien = await appel('POST', '/api/connexion', { identifiant: 'oubli-mail', motDePasse: 'Ancien-mdp-2026' }, SANS);
  const nouveau = await appel('POST', '/api/connexion', { identifiant: 'oubli-mail', motDePasse: 'Nouveau-mdp-2026' }, SANS);
  if (court.statut === 400 && bon.statut === 200 && bon.j.connecte && /gaulix_session=/.test(bon.cookie || '') && encore.statut === 400 && ancien.statut === 401 && nouveau.statut === 200) ok('mot de passe oublié : nouveau mot de passe par le lien, lien à usage unique, ancien refusé'); else ko('réinitialisation : ' + JSON.stringify({ court: court.statut, bon: bon.j, encore: encore.statut, ancien: ancien.statut, nouveau: nouveau.statut }));
  // Sans e-mail : demande signalée aux administrateurs, qui créent le lien
  await appel('POST', '/api/mot-de-passe/oubli', { identifiant: 'oubli-admin' }, SANS);
  const liste = (await appel('GET', '/api/comptes')).j;
  const vu = liste.find((c) => c.id === a2.id) || {};
  const lien = (await appel('POST', '/api/comptes/' + a2.id, { lienReinit: true })).j;
  const parAdmin = await appel('POST', '/api/mot-de-passe/reinitialiser', { jeton: lien.jeton, nouveau: 'Admin-donne-2026' }, SANS);
  const apres = ((await appel('GET', '/api/comptes')).j.find((c) => c.id === a2.id) || {});
  if (vu.reinitDemande && lien.jeton && parAdmin.statut === 200 && !apres.reinitDemande && fs.readdirSync(dossier).length === 1) ok('mot de passe oublié sans e-mail : demande visible des administrateurs, lien créé par l’administrateur'); else ko('oubli sans e-mail : ' + JSON.stringify({ demande: vu.reinitDemande, lien: !!lien.jeton, parAdmin: parAdmin.j, apres: apres.reinitDemande }));
  // Interface : lien « Mot de passe oublié ? » et page du lien reçu
  const ctx = await navig.newContext({ viewport: { width: 1200, height: 850 }, locale: 'fr-FR' });
  await ctx.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  const { page } = await ouvrir(ctx, '/?compte=connexion');
  await page.waitForTimeout(1200);
  await page.click('#btn-oubli');
  await page.waitForTimeout(500);
  await page.fill('#form-oubli input[name=identifiant]', 'oubli-admin');
  await page.click('#form-oubli button[type=submit]');
  await page.waitForTimeout(800);
  const note = await page.textContent('#note-oubli');
  const l2 = (await appel('POST', '/api/comptes/' + a2.id, { lienReinit: true })).j;
  await page.goto(BASE + '/?reinit=' + l2.jeton);
  await page.waitForTimeout(1800);
  const visible = await page.evaluate(() => !document.querySelector('#form-reinit').hidden && document.querySelector('#dlg-compte').open && !/reinit=/.test(location.search));
  await page.fill('#form-reinit input[name=nouveau]', 'Via-la-page-2026');
  await page.fill('#form-reinit input[name=confirmation]', 'Via-la-page-2026');
  await Promise.all([page.waitForNavigation({ timeout: 8000 }).catch(() => {}), page.click('#form-reinit button[type=submit]')]);
  await page.waitForTimeout(1500);
  const connecte = await page.evaluate(async () => (await (await fetch('/api/compte')).json() || {}).identifiant);
  if (/Demande envoyée/.test(note) && visible && connecte === 'oubli-admin') ok('page : « Mot de passe oublié ? », lien reçu, nouveau mot de passe et connexion'); else ko('page mot de passe oublié : ' + JSON.stringify({ note, visible, connecte }));
  await ctx.close();
  // Tableau des comptes (avec ADRASEC) : ✏️ et 🔑 visibles, pas de défilement horizontal sur un écran de portable
  const ctxA = await navig.newContext({ viewport: { width: 1366, height: 768 }, locale: 'fr-FR' });
  await ctxA.addCookies([cookie]);
  await ctxA.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  const pa = (await ouvrir(ctxA, '/')).page;
  await pa.waitForTimeout(1000);
  const tab = await pa.evaluate(async () => { await ouvrirDlg('comptes'); await new Promise((r) => setTimeout(r, 1200)); const d = document.querySelector('#dlg-gestion'); return { crayon: document.querySelectorAll('#pan-comptes [data-fiche]').length, lien: document.querySelectorAll('#pan-comptes [data-lien-mdp]').length, adrasec: document.querySelectorAll('#pan-comptes [data-adrasec]').length, deborde: d.scrollWidth - d.clientWidth }; });
  await capture(pa, 'gestion-comptes');
  if (tab.crayon && tab.lien && tab.adrasec && tab.deborde <= 2) ok('gestion › comptes : ✏️, 🔑 et case ADRASEC visibles, sans défilement horizontal'); else ko('tableau des comptes : ' + JSON.stringify(tab));
  // Deux fiches modifiées, Entrée dans l'une : les deux sont enregistrées
  const deux = await pa.evaluate(async (ids) => {
    for (const id of ids) document.querySelector(`#pan-comptes tr[data-id="${id}"] [data-fiche]`).click();
    document.querySelector(`#pan-comptes tr[data-id="${ids[0]}"] .fiche-ident`).value = 'OUBLI Admin';
    document.querySelector(`#pan-comptes tr[data-id="${ids[1]}"] .fiche-ident`).value = 'OUBLI Mail';
    const bouton = getComputedStyle(document.querySelector('#pan-comptes .bouton-enregistrer')).backgroundColor;
    document.querySelector(`#pan-comptes tr[data-id="${ids[1]}"] .fiche-ident`).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 1500));
    const l = await (await fetch('/api/comptes')).json();
    return { bouton, noms: ids.map((i) => (l.find((c) => c.id === i) || {}).identifiant) };
  }, [a2.id, a1.id]);
  if (deux.noms[0] === 'OUBLI Admin' && deux.noms[1] === 'OUBLI Mail' && !/rgba\(0, 0, 0, 0\)/.test(deux.bouton)) ok('gestion › comptes : plusieurs noms modifiés enregistrés d’un coup (Entrée), bouton Enregistrer visible'); else ko('renommage multiple : ' + JSON.stringify(deux));
  await ctxA.close();
  // Identifiant « NOM Prénom » et fiche modifiée par l'administrateur
  const f1 = await appel('POST', '/api/comptes', { identifiant: '  DELAGE   Fabrice ', indicatif: 'f1ukz', motDePasse: 'Provisoire-2026' });
  const ren = await appel('POST', '/api/comptes/' + f1.j.id, { identifiant: 'Fabrice D\u2019Elage', indicatif: 'F1UKZ', email: 'fabrice@exemple.fr' });
  const pris = await appel('POST', '/api/comptes/' + f1.j.id, { identifiant: 'oubli mail' }); // « OUBLI Mail » existe (casse indifférente)
  const fiche = ((await appel('GET', '/api/comptes')).j.find((c) => c.id === f1.j.id) || {});
  const cx = await appel('POST', '/api/connexion', { identifiant: 'fabrice d\u2019elage', motDePasse: 'Provisoire-2026' }, SANS);
  if (f1.statut === 200 && f1.j.identifiant === 'DELAGE Fabrice' && ren.statut === 200 && pris.statut === 400 && fiche.identifiant === 'Fabrice D\u2019Elage' && fiche.email === 'fabrice@exemple.fr' && cx.statut === 200) ok('comptes : identifiant « NOM Prénom », renommé par l’administrateur (doublon refusé), connexion avec le nouveau nom'); else ko('identifiant NOM Prénom : ' + JSON.stringify({ f1: f1.j, ren: ren.j, pris: pris.statut, fiche, cx: cx.statut }));
  for (const id of [a1.id, a2.id, f1.j.id]) await appel('DELETE', '/api/comptes/' + id);
}

async function essaiFrequentation(navig, cookie) {
  console.log('Fréquentation (visiteurs, pays, provenance)');
  const H = { Cookie: `${cookie.name}=${cookie.value}` };
  const avant = await (await fetch(BASE + '/api/frequentation?jours=7', { headers: H })).json();
  const ua = 'Mozilla/5.0 (Windows NT 10.0) Essai/1.0';
  for (let k = 0; k < 3; k++) await fetch(BASE + '/', { headers: { 'User-Agent': ua, Referer: 'https://l.facebook.com/l.php?u=x' } });
  await fetch(BASE + '/adrasec', { headers: { 'User-Agent': ua } });
  await fetch(BASE + '/', { headers: { 'User-Agent': 'Googlebot/2.1' } });
  await fetch(BASE + '/', { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) CarteLiveAndroid/2.28.12' } });
  const f = await (await fetch(BASE + '/api/frequentation?jours=7', { headers: H })).json();
  const page = (n) => (f.pages.find((x) => x.page === n) || {}).visites || 0;
  const pageAv = (n) => (avant.pages.find((x) => x.page === n) || {}).visites || 0;
  const fb = (f.provenances.find((x) => x.provenance === 'facebook.com') || {}).visites || 0;
  const lan = f.pays.find((x) => x.pays === 'LAN');
  const anonyme = await fetch(BASE + '/api/frequentation');
  if (page('carte') - pageAv('carte') === 3 && page('ADRASEC') - pageAv('ADRASEC') === 1 && page('appli Android') - pageAv('appli Android') === 1 && fb >= 3 && lan && f.aujourdhui.visiteurs - avant.aujourdhui.visiteurs === 2 && anonyme.status === 401 && !JSON.stringify(f).includes('127.0.0.1')) ok('fréquentation : pages, visiteurs uniques du jour, provenance Facebook, réseau local, robots ignorés, sans adresse IP, réservé aux administrateurs');
  else ko('fréquentation : ' + JSON.stringify({ pages: f.pages, avant: avant.pages, fb, lan, v: [avant.aujourdhui, f.aujourdhui], anonyme: anonyme.status }));
  const ctx = await navig.newContext({ viewport: { width: 1366, height: 800 }, locale: 'fr-FR' });
  await ctx.addCookies([cookie]);
  await ctx.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  const { page: pg, erreurs } = await ouvrir(ctx, '/');
  await pg.waitForTimeout(800);
  const e = await pg.evaluate(async () => { await ouvrirDlg('frequentation'); await new Promise((r) => setTimeout(r, 1200)); const z = document.querySelector('#pan-frequentation'); return { cartes: z.querySelectorAll('.carte-freq').length, colonnes: z.querySelectorAll('.colonne-freq').length, fb: /facebook\.com/.test(z.textContent), lan: /Réseau local/.test(z.textContent), deborde: document.querySelector('#dlg-gestion').scrollWidth - document.querySelector('#dlg-gestion').clientWidth }; });
  await capture(pg, 'frequentation');
  if (e.cartes === 4 && e.colonnes === 30 && e.fb && e.lan && e.deborde <= 2 && !erreurs.length) ok('Gérer › Fréquentation : chiffres, visiteurs par jour, pays et provenance'); else ko('écran fréquentation : ' + JSON.stringify({ ...e, erreurs }));
  await ctx.close();
}

async function essaiAgentDirect(cookie) {
  console.log('Agent zéro question (simulé)');
  const net = require('net');
  const entetes = { Cookie: `${cookie.name}=${cookie.value}` };
  const ag = await (await fetch(BASE + '/api/radio/agents', { headers: entetes })).json();
  const sock = net.connect(ag.port, '127.0.0.1');
  const reponse = await new Promise((okp, kop) => {
    sock.once('error', kop);
    sock.once('connect', () => sock.write(JSON.stringify({ v: 1, code: ag.code, nom: 'PC-ESSAI · ttyUSB0', source: 'USB ttyUSB0', version: '1.7', direct: true, protocole: 'meshtastic', role: 'principal' }) + '\n'));
    let t = ''; sock.on('data', (x) => { t += x.toString('latin1'); if (t.includes('\n')) okp(t.split('\n')[0]); });
    setTimeout(() => okp(t || '(rien)'), 5000);
  });
  if (reponse === 'OK direct') ok('agent direct accepté par la carte'); else ko('agent direct : réponse ' + reponse);
  await new Promise((r) => setTimeout(r, 800));
  const actif = async () => ((await (await fetch(BASE + '/api/radio/modules', { headers: entetes })).json()).actif || {}).hote;
  const a1 = await actif();
  if (a1 === 'agent-pc-essai-ttyusb0') ok('module de l’agent devenu module principal tout de suite'); else ko('module principal après l’agent : ' + a1);
  sock.destroy();
  await new Promise((r) => setTimeout(r, 1200));
  const a2 = await actif();
  if (a2 !== 'agent-pc-essai-ttyusb0') ok('module débranché : retiré, retour au module d’avant'); else ko('module de l’agent toujours principal après débranchement');
  const refus = await new Promise((okp) => {
    const s2 = net.connect(ag.port, '127.0.0.1', () => s2.write(JSON.stringify({ v: 1, code: 'FAUX-FAUX-FAUX', nom: 'Intrus', direct: true, protocole: 'meshtastic' }) + '\n'));
    let t = ''; s2.on('data', (x) => { t += x; }); s2.on('close', () => okp(t)); s2.on('error', () => okp(t)); setTimeout(() => { s2.destroy(); okp(t); }, 5000);
  });
  if (/^ERREUR/.test(refus)) ok('agent direct avec un faux code refusé'); else ko('faux code : ' + refus);
  const dossier = path.join(__dirname, '..', 'public', 'agent'), f = path.join(dossier, 'agent-gaulix-linux-amd64');
  const creeDossier = !fs.existsSync(dossier);
  fs.mkdirSync(dossier, { recursive: true }); fs.writeFileSync(f, Buffer.from('\x7fELF programme factice'));
  try {
    const r = await fetch(BASE + '/api/agent/pret/agent-gaulix-linux-amd64', { headers: entetes });
    const b = Buffer.from(await r.arrayBuffer());
    const m = b.toString('utf8').match(/\nCARTE-LIVE-AGENT(\{.*\})\n$/);
    const j = m ? JSON.parse(m[1]) : {};
    if (r.ok && b.subarray(0, 4).toString('latin1') === '\x7fELF' && j.code === ag.code && j.serveurs && j.serveurs[0] === `127.0.0.1:${ag.port}`) ok('agent prêt à l’emploi : programme intact, adresse et code ajoutés à la fin');
    else ko('agent prêt à l’emploi : ' + r.status + ' ' + JSON.stringify(j));
    const visiteur = await fetch(BASE + '/api/agent/pret/agent-gaulix-linux-amd64');
    if (visiteur.status === 401 || visiteur.status === 403) ok('agent prêt à l’emploi refusé sans compte administrateur'); else ko('agent prêt à l’emploi sans compte : HTTP ' + visiteur.status);
  } finally {
    fs.rmSync(f, { force: true });
    if (creeDossier) fs.rmSync(dossier, { recursive: true, force: true });
  }
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
  // Tiroir plein avec texte agrandi (réglage Android) : jamais sous le titre ni la recherche, bouton ▾ pour réduire
  await page.evaluate(() => { document.documentElement.style.fontSize = '130%'; document.querySelectorAll('.marque, .recherche-lieu').forEach((e) => { e.style.fontSize = '130%'; }); window.dispatchEvent(new Event('resize')); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { const p = document.querySelector('.poignee-tiroir'); for (let i = 0; i < 3 && !document.body.classList.contains('tiroir-plein'); i++) { p.dispatchEvent(new PointerEvent('pointerdown', { clientY: 500, pointerId: 1, bubbles: true })); p.dispatchEvent(new PointerEvent('pointerup', { clientY: 500, pointerId: 1, bubbles: true })); } });
  await page.waitForTimeout(500);
  const t = await page.evaluate(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(); const b = document.querySelector('.reduire-tiroir'); return { plein: document.body.classList.contains('tiroir-plein'), haut: r('.panneau').top, rech: r('.recherche-lieu').bottom, barre: r('.barre').bottom, bouton: b && b.offsetParent !== null }; });
  if (t.plein && t.haut >= Math.max(t.rech, t.barre) && t.bouton) ok('téléphone : tiroir plein sous le titre et la recherche, bouton ▾ visible'); else ko('téléphone : tiroir ' + JSON.stringify(t));
  await page.tap('.reduire-tiroir');
  await page.waitForTimeout(400);
  if (await page.evaluate(() => document.body.classList.contains('tiroir-reduit'))) ok('téléphone : bouton ▾ réduit le tiroir'); else ko('téléphone : ▾ sans effet');
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
    demarrerFauxPat();
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
    await essaiAutresPresets(navigateur, cookie);
    await essaiRejoindre(navigateur, cookie);
    await essaiRegistreEtExports(navigateur, cookie);
    await essaiVue3D(navigateur);
    await essaiProfil3D(navigateur);
    await essaiAdrasec(navigateur, cookie);
    await essaiMotDePasseOublie(navigateur, cookie);
    await essaiFrequentation(navigateur, cookie);
    await essaiAdministrationALaDemande(navigateur, cookie);
    await essaiAgentDirect(cookie);
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
    if (fauxPat) fauxPat.close();
    fs.rmSync(donnees, { recursive: true, force: true });
    process.exit(code);
  }
})();
