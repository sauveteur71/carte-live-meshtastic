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

async function essaiPagesPubliques(navig) {
  for (const [url, nom, attendu] of [['/publique.html', 'carte publique', '#carte .leaflet-pane, .leaflet-pane'], ['/topologie.html', 'graphe des liens', 'svg, canvas']]) {
    console.log(nom[0].toUpperCase() + nom.slice(1) + ' (visiteur)');
    const contexte = await navig.newContext({ viewport: { width: 1280, height: 800 }, locale: 'fr-FR' });
    await contexte.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); } catch { /* */ } });
    const { page, erreurs } = await ouvrir(contexte, url);
    if (await page.locator(attendu).count()) ok(`${nom} affichée`); else ko(`${nom} : contenu absent`);
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
    await contexte.close();
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
