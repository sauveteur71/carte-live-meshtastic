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
    env: { ...process.env, PORT: String(PORT), FICHIER_BASE: path.join(donnees, 'carte-live.db'), MQTT_URL: 'mqtt://127.0.0.1:1', DEPARTEMENT: '43', MESHCORE: 'oui', ADMIN_MOT_DE_PASSE: '', AGENTS_PORT: String(PORT + 5), PAT_URL: `http://127.0.0.1:${PORT + 7}`, PAT_INDICATIF: 'F4XYZ', SMTP_HOTE: 'fichier', CARTE_ADRESSE: 'https://carte.essai', STATS_PAYS: 'non', RELIEF_MONDE_ERDDAP: 'http://127.0.0.1:1/erddap', BANDEAU_MONDE: 'oui', BANDEAU_MONDE_URL: 'https://monde.essai/carte' },
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

// ESSAIS=Secours,Adrasec node tests/interface.js : ne lance que les essais dont le nom contient un de ces mots
const voulu = (nom) => !process.env.ESSAIS || process.env.ESSAIS.split(',').some((m) => nom.toLowerCase().includes(m.trim().toLowerCase()));
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
  // Mots-clés portés par l'entrée du menu (data-chercher) : « radiogoniométrie » mène à la section ADRASEC, sans liste à part
  const motsCles = await page.evaluate(() => { const e = document.querySelector('#outil-secours'); const etait = e.hidden; e.hidden = false; const l = indexReglages().filter((x) => /point de rassemblement/.test(x.m)).map((x) => x.t); e.hidden = etait; return l; });
  if (motsCles.some((t) => /Espaces Secours/.test(t))) ok('recherche : mots-clés portés par l’entrée du menu Outils'); else ko('mots-clés du menu : ' + JSON.stringify(motsCles));
  // Niveau d'affichage porté par l'entrée (data-niveau) : masquée en Simple, visible en Expert
  const niveaux = await page.evaluate(() => { const vu = (id) => getComputedStyle(document.querySelector('#' + id)).display !== 'none'; const avant = document.body.dataset.niveau; const r = {}; for (const n of ['simple', 'operateur', 'expert']) { document.body.dataset.niveau = n; r[n] = { trafic: vu('outil-trafic'), usb: vu('outil-portee'), theme: vu('outil-theme') }; } document.body.dataset.niveau = avant; return r; });
  if (!niveaux.simple.trafic && !niveaux.simple.usb && niveaux.simple.theme && niveaux.operateur.usb && !niveaux.operateur.trafic && niveaux.expert.trafic) ok('menu Outils : niveau d’affichage porté par chaque entrée'); else ko('niveaux du menu Outils : ' + JSON.stringify(niveaux));
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  // Sites proposés : cases à cocher, barre de sélection, couverture cumulée puis retour à la liste (cases gardées)
  const choix = await page.evaluate(async () => {
    const vraie = window.couvertureMulti;
    let recus = null;
    window.couvertureMulti = async (sites) => { recus = sites; document.querySelector('#fiche-contenu').innerHTML = '<h2>Couverture</h2><button id="retour-liste-sites">↩</button>'; document.querySelector('#retour-liste-sites').onclick = revenirListeSites; };
    document.querySelector('#fiche').hidden = false;
    const z = document.querySelector('#fiche-contenu');
    z.innerHTML = '<h2>Liste d’essai</h2>' + Array.from({ length: 12 }, (_, i) => `<div class="proposition">${blocCoords(45 + i / 100, 3.9, { couv: { nom: 'Site ' + (i + 1), h: 6 } })}</div>`).join('');
    const cases = () => [...z.querySelectorAll('[data-choix-site]')];
    const cocher = (i) => { const c = cases()[i]; c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); };
    const r = { cases: cases().length, barreAvant: !!z.querySelector('.barre-sites-coches') };
    cocher(0); cocher(2);
    r.barre = (z.querySelector('.barre-sites-coches span') || {}).textContent;
    r.surlignes = z.querySelectorAll('.proposition.site-coche').length;
    for (let i = 3; i < 11; i++) cocher(i);
    r.max = cases().filter((c) => c.checked).length; r.bloquees = cases().filter((c) => c.disabled).length;
    z.querySelector('[data-voir-coches]').click();
    await new Promise((ok) => setTimeout(ok, 50));
    r.envoyes = recus && recus.length; r.premier = recus && recus[0]; r.listePartie = !z.querySelector('[data-choix-site]');
    document.querySelector('#retour-liste-sites').click();
    r.retour = cases().length; r.gardees = cases().filter((c) => c.checked).length; r.barreRetour = !!z.querySelector('.barre-sites-coches');
    z.querySelector('[data-vider-coches]').click();
    r.vide = cases().filter((c) => c.checked).length; r.barreFin = !!z.querySelector('.barre-sites-coches');
    window.couvertureMulti = vraie;
    document.querySelector('#fermer-fiche').click();
    return r;
  });
  if (choix.cases === 12 && !choix.barreAvant && /2 sites cochés/.test(choix.barre) && choix.surlignes === 2 && choix.max === 10 && choix.bloquees === 2 && choix.envoyes === 10 && choix.premier.nom === 'Site 1' && choix.premier.h === 6 && choix.listePartie && choix.retour === 12 && choix.gardees === 10 && choix.barreRetour && choix.vide === 0 && !choix.barreFin)
    ok('sites proposés : cases à cocher (10 au plus), couverture de la sélection, retour à la liste avec les cases gardées');
  else ko('sélection de sites proposés : ' + JSON.stringify(choix));
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
  // 3 bis. Alertes des capteurs réglés à la main : visibles même hors de la zone ; les autres restent filtrées
  const hz = await page.evaluate(() => {
    const CLE = 'AA'.repeat(32);
    const avant = (mc.etat && mc.etat.alertes) || [];
    mc.noeuds.set(CLE, { cle: CLE, nom: 'Abri lointain', role: 'capteur', lat: 10, lon: 10, statut: 'actif' });
    const d = Date.now() - 11 * 3600000;
    mc.etat = { ...(mc.etat || {}), alertes: [
      { cle: 'mc-capteur-retard:' + CLE, noeud: CLE, type: 'releve', niveau: 'attention', nom: 'Abri lointain', depuis: d, message: 'Abri lointain : aucun relev\u00e9 automatique re\u00e7u depuis hier' },
      { cle: 'mc-capteur:' + CLE + ':tension:1', noeud: CLE, type: 'capteur', niveau: 'attention', nom: 'Abri lointain', depuis: d, message: 'Abri lointain \u00b7 Tension ADC : 3,20 V (sous 3,4 V)' },
      { cle: 'mc-muet:' + CLE, noeud: CLE, type: 'muet', niveau: 'critique', nom: 'Abri lointain', depuis: d, message: 'R\u00e9p\u00e9teur MeshCore Abri lointain non entendu depuis 30 h' },
    ] };
    mcMajAlertes();
    const t = document.querySelector('#alertes-mc').textContent;
    const r = { horsZone: !mcDansZone(mc.noeuds.get(CLE)), pastille: (document.querySelector('#nb-alertes-mc') || {}).textContent, retard: /aucun relev\u00e9 automatique/.test(t), seuil: /Tension ADC/.test(t), muet: /non entendu depuis/.test(t) };
    mc.noeuds.delete(CLE); mc.etat = { ...mc.etat, alertes: avant }; mcMajAlertes(); // la page est rendue \u00e0 son \u00e9tat d'avant
    return r;
  }).catch((e) => ({ erreur: e.message }));
  if (hz.horsZone && hz.retard && hz.seuil && !hz.muet && hz.pastille === '2') ok('alertes des capteurs réglés à la main : visibles hors zone, les autres toujours filtrées'); else ko('alertes hors zone : ' + JSON.stringify(hz));
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
  // Cache du relief : espace occupé, purge, plafond et relief mondial dans l'écran du relief
  const cacheRel = await page.evaluate(async () => {
    await ficheFrance();
    for (let k = 0; k < 30 && !(document.querySelector('#bloc-cache-relief h3')); k++) await new Promise((r) => setTimeout(r, 200));
    const b = document.querySelector('#bloc-cache-relief');
    return b ? { titre: b.textContent.includes('Relief téléchargé'), purge: !!b.querySelector('#cr-tout'), plafond: !!b.querySelector('#cr-plafond'), grossier: !!b.querySelector('#cr-grossier') } : null;
  });
  if (cacheRel && cacheRel.titre && cacheRel.purge && cacheRel.plafond && cacheRel.grossier) ok('relief : espace occupé, purge, plafond et relief mondial affichés'); else ko('cache du relief : ' + JSON.stringify(cacheRel));
  const purgeVide = await page.evaluate(async () => { const r = await postJson('/api/relief/cache', { purger: { joursInactifs: 30 } }); return r && r.purge && Array.isArray(r.purge.supprimees) && r.principale && r.principale.code; });
  if (purgeVide) ok('purge du relief : réponse correcte, zone de la carte gardée'); else ko('purge du relief : réponse inattendue');
  const refuse = await fetch(BASE + '/api/relief/cache', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purger: { tout: true } }) });
  if (refuse.status === 401) ok('purge du relief refusée sans connexion admin'); else ko('purge du relief sans connexion : HTTP ' + refuse.status);
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
  if (apres.statut === 200 && apres.j.code === '42' && apres.j.moi.responsable && apres.j.moi.qualite === 'swl' && !apres.j.mainCourante.length && eqB.statut === 200 && nomme.statut === 400 && /administrateur de la carte/.test(nomme.j.erreur) && winB.statut === 403) ok('ADRASEC : président de son département (équipes, membres), ADRASEC séparées, SWL sans Winlink'); else ko('ADRASEC président : ' + JSON.stringify({ apres: apres.statut, code: apres.j.code, resp: apres.j.moi && apres.j.moi.responsable, mc: apres.j.mainCourante && apres.j.mainCourante.length, eqB: eqB.statut, nomme, win: winB.statut, double }));
  // Un opérateur à cheval sur deux départements : membre des deux ADRASEC, une fiche dans chacune (président de
  // l'une, simple membre de l'autre), il choisit celle qu'il affiche ; retiré de l'une, il garde l'autre
  const deux = await appelB('GET', '/api/adrasec?g=43'), defaut = await appelB('GET', '/api/adrasec');
  const eq43 = await appelB('POST', '/api/adrasec/equipes?g=43', { nom: 'Pas à moi' });
  const rolesDeux = (await appel('GET', '/api/adrasec/roles')).roles[b1.id];
  await appel('PUT', '/api/adrasec/membres/' + b1.id + '?g=43', { membre: false });
  const retire = await appelB('GET', '/api/adrasec?g=43');
  if (double === 'accepté' && deux.statut === 200 && deux.j.code === '43' && !deux.j.moi.responsable && deux.j.moi.qualite === 'swl' && deux.j.sections.length === 2 && defaut.j.code === '42' && defaut.j.moi.responsable && eq43.statut === 403 && rolesDeux.groupes.join() === '42,43' && retire.j.code === '42' && retire.j.sections.length === 1)
    ok('ADRASEC : un compte membre de deux ADRASEC (fiche et rôle propres à chacune, choix de celle affichée), puis retiré de l’une');
  else ko('ADRASEC deux sections : ' + JSON.stringify({ double, deux: deux.statut, code: deux.j.code, moi: deux.j.moi, sections: deux.j.sections, defaut: defaut.j.code, eq43: eq43.statut, rolesDeux, retire: retire.j.code }));
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
  // Points de rassemblement (tout membre, propres à la section) et options de la section (président)
  const essayer = async (f) => { try { await f(); return 'ok'; } catch (e) { return e.message; } };
  const rp = await appel('POST', '/api/adrasec/reperes', { nom: 'Parking de la mairie', detail: 'côté nord', lat: 45.043, lon: 3.885 });
  const R = {
    sansPosition: await essayer(() => appel('POST', '/api/adrasec/reperes', { nom: 'Sans position' })),
    autreSection: (await appel('GET', '/api/adrasec?g=42')).reperes.length,
    diffusion: await essayer(() => appel('POST', `/api/adrasec/reperes/${rp.reperes[0].id}/diffuser`, { canal: 0 })),
    messagesEteints: await essayer(() => appel('POST', '/api/adrasec/messages', { texte: 'Essai', canal: 0 })),
    trajetsEteints: await essayer(() => appel('GET', `/api/adrasec/membres/${moi.id}/trace`)),
  };
  const reg = await appel('PUT', '/api/adrasec/reglages', { options: { messages: true, trajets: true, inconnue: true }, macros: ['Rejoignez le PC', ''] });
  R.messages = await essayer(() => appel('POST', '/api/adrasec/messages', { texte: 'Essai', canal: 0 }));
  R.trajets = (await appel('GET', `/api/adrasec/membres/${moi.id}/trace`)).points.length;
  const vueOpt = await appel('GET', '/api/adrasec');
  if (/Pointez le point de rassemblement/.test(R.sansPosition) && R.autreSection === 0 && /module radio non connecté/i.test(R.diffusion) && /ne sont pas activés/.test(R.messagesEteints) && /ne sont pas activés/.test(R.trajetsEteints)
    && /module radio non connecté/i.test(R.messages) && R.trajets === 0 && JSON.stringify(reg.options) === JSON.stringify({ batterie: true, alerteRadio: true, messages: true, trajets: true }) && reg.macros.join() === 'Rejoignez le PC'
    && vueOpt.reperes.length === 1 && vueOpt.radio.tombee === false && Object.keys(vueOpt.catalogueOptions).length === 4 && !vueOpt.mainCourante.some((x) => x.type === 'message-emis' && /canal/.test(x.texte)))
    ok('ADRASEC : point de rassemblement propre à la section, options réglées par le président, envoi radio refusé avec son motif sans module');
  else ko('ADRASEC repères et options : ' + JSON.stringify({ R, options: reg.options, macros: reg.macros }));
  // Page
  const contexte = await navig.newContext({ viewport: { width: 1400, height: 900 }, locale: 'fr-FR' });
  await contexte.addCookies([cookie]);
  await contexte.addInitScript(() => { try { localStorage.setItem('adrasec-onglet', 'gonio'); } catch { /* */ } });
  const { page, erreurs } = await ouvrir(contexte, '/adrasec');
  const p = await page.evaluate(() => ({ titre: document.querySelector('#titre').textContent, resultat: (document.querySelector('.resultat') || {}).textContent || '', cones: document.querySelectorAll('#carte path.leaflet-interactive, #carte svg path').length, gestion: !document.querySelector('[data-vue="gestion"]').hidden }));
  if (/ADRASEC 43/.test(p.titre) && /Position la plus probable/.test(p.resultat) && p.cones >= 8 && p.gestion) ok('page ADRASEC : estimation, cônes et onglet Gestion'); else ko('page ADRASEC : ' + JSON.stringify(p));
  const po = await page.evaluate(() => ({ repere: document.querySelectorAll('#carte .rep-rassemblement').length, liste: document.querySelectorAll('#vue-equipes [data-repere]').length, nouveau: !!document.querySelector('#rp-nouveau'), diffuser: document.querySelector('.rp-diffuser').disabled,
    options: document.querySelectorAll('.ge-option').length, cochees: document.querySelectorAll('.ge-option:checked').length, radio: !!document.querySelector('#rm-texte'), macros: document.querySelectorAll('#vue-mc [data-macro]').length, bandeau: document.querySelector('#alerte-radio').hidden }));
  if (po.repere === 1 && po.liste === 1 && po.nouveau && po.diffuser && po.options === 4 && po.cochees === 4 && po.radio && po.macros === 1 && po.bandeau) ok('page ADRASEC : point de rassemblement sur la carte et dans l’onglet Équipes, options dans Gestion, bloc « Écrire aux équipes par radio »');
  else ko('page ADRASEC, repères et options : ' + JSON.stringify(po));
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
// Transfert d'une section ADRASEC d'une carte à une autre : export d'un fichier, import avec récapitulatif.
// Le point capital : le fichier exporté ne doit contenir aucun secret ni aucun compte.
async function essaiAdrasecTransfert(navig, cookie) {
  console.log('ADRASEC : transfert de la section (export / import)');
  const H = { 'Content-Type': 'application/json', Cookie: `${cookie.name}=${cookie.value}` };
  const appel = async (m, url, b, h = H) => { const r = await fetch(BASE + url, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }); return { statut: r.status, j: await r.json().catch(() => ({})) }; };
  // 1) Export : en-têtes de téléchargement, et aucun secret dans le fichier
  const rep = await fetch(BASE + '/api/adrasec/export.json?g=43', { headers: H });
  const brut = await rep.text();
  let doc = null;
  try { doc = JSON.parse(brut); } catch { /* illisible */ }
  const cles = new Set();
  if (doc) (function parcourir(x) { if (Array.isArray(x)) x.forEach(parcourir); else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { cles.add(k); parcourir(v); } })(doc);
  // Définition de la section, puis historique (main courante, recherches, relevés) : liste fermée de champs
  const permis = ['code', 'couleur', 'date', 'equipe', 'equipes', 'fonction', 'format', 'id', 'indicatif', 'membres', 'membresSansIdentifiant', 'mission', 'noeud', 'nom', 'numeroSwl', 'president', 'qualite', 'section', 'version',
    'mainCourante', 'heure', 'auteur', 'type', 'texte', 'complete', 'recherches', 'frequence', 'detail', 'debut', 'fin', 'statut', 'ouvertePar', 'resultat', 'positionFinale', 'lat', 'lon', 'locator',
    'releves', 'recherche', 'source', 'gisement', 'incertitude', 'force', 'note', 'origine', 'retire', 'par'];
  const enTrop = [...cles].filter((k) => !permis.includes(k));
  if (rep.status === 200 && /attachment; filename="adrasec-43-/.test(rep.headers.get('content-disposition') || '')) ok('ADRASEC : la section s’exporte en fichier .json téléchargeable'); else ko('export : HTTP ' + rep.status + ' ' + rep.headers.get('content-disposition'));
  if (doc && doc.format === 'carte-live-adrasec' && /ADRASEC 43/.test((doc.section || {}).nom || '') && (doc.membres || []).some((m) => m.indicatif === 'F4XYZ')) ok('export : nom de la section, équipes et fiches des membres'); else ko('export : ' + brut.slice(0, 200));
  if (!enTrop.length) ok('export : aucun champ en dehors de la section et de son historique'); else ko('export : champs inattendus : ' + enTrop.join(', '));
  // Mots interdits dans la définition (section, équipes, fiches) ; l'historique contient des textes libres
  // (« session Winlink… ») : on y vérifie les champs (liste fermée ci-dessus) et l'absence du jeton du lien terrain
  const definition = doc ? JSON.stringify({ section: doc.section, equipes: doc.equipes, membres: doc.membres }) : brut;
  let fuite = null;
  for (const interdit of ['hash', 'motdepasse', 'password', 'totp', 'jeton', 'token', 'session', 'cookie', 'psk', 'secret', 'demandes']) if (new RegExp(interdit, 'i').test(definition)) { fuite = 'mot « ' + interdit + ' »'; break; }
  // Aucun identifiant de compte de cette carte ne doit figurer dans la définition
  const tousComptes = await (await fetch(BASE + '/api/comptes', { headers: H })).json().catch(() => []);
  for (const c of Array.isArray(tousComptes) ? tousComptes : []) if (c.identifiant && definition.includes(c.identifiant)) { fuite = 'identifiant de compte « ' + c.identifiant + ' »'; break; }
  // Le lien terrain de la recherche d'essai (créé plus haut) ne doit pas partir
  const vueAvant = await appel('GET', '/api/adrasec?g=43');
  const jetons = (vueAvant.j.recherches || []).map((r) => r.lien && r.lien.jeton).filter(Boolean);
  if (jetons.some((j) => brut.includes(j))) fuite = 'jeton d’un lien terrain';
  if (!fuite) ok(`export : ni mot de passe, ni condensat, ni jeton (${jetons.length} lien(s) terrain vérifié(s)), ni compte (${(tousComptes || []).length} comptes vérifiés)`);
  else ko('export : ' + fuite + ' dans le fichier');
  if (doc && (doc.recherches || []).some((r) => r.nom === 'Balise essai') && (doc.releves || []).length >= 4 && (doc.mainCourante || []).some((x) => /Ouverture de la recherche/.test(x.texte))) ok('export : main courante, recherches et relevés partent aussi');
  else ko('export sans historique : ' + JSON.stringify({ mc: (doc && doc.mainCourante || []).length, r: (doc && doc.recherches || []).length, rel: (doc && doc.releves || []).length }));
  // Réimporter sur la même section le fichier qu'elle vient d'exporter : rien en double
  const reimp = doc ? await appel('POST', '/api/adrasec/import?g=43', { fichier: doc, appliquer: false }) : { j: {} };
  const rj = reimp.j;
  if (rj.mainCourante && rj.mainCourante.nouvelles === 0 && rj.recherches.nouvelles === 0 && rj.releves.nouveaux === 0 && rj.mainCourante.deja === doc.mainCourante.length) ok(`aperçu d’import : la main courante (${rj.mainCourante.deja}), les recherches et les relevés déjà présents sont reconnus, rien en double`);
  else ko('réimport du même fichier : ' + JSON.stringify(rj).slice(0, 300));
  // 2) Réservé au président et aux responsables de la section
  const cx = await fetch(BASE + '/api/connexion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiant: 'multi-un', motDePasse: 'Multi-compte-2026' }) });
  const HM = { 'Content-Type': 'application/json', Cookie: (cx.headers.get('set-cookie') || '').split(';')[0] };
  const expMembre = await fetch(BASE + '/api/adrasec/export.json', { headers: HM });
  const impMembre = await appel('POST', '/api/adrasec/import', { fichier: { format: 'carte-live-adrasec', version: 1 } }, HM);
  const expAnonyme = await fetch(BASE + '/api/adrasec/export.json');
  if (expMembre.status === 403 && impMembre.statut === 403 && expAnonyme.status === 403) ok('export et import réservés au président / responsable (403 pour un membre et pour un anonyme)');
  else ko('droits du transfert : ' + JSON.stringify({ membre: expMembre.status, import: impMembre.statut, anonyme: expAnonyme.status }));
  // 3) Import : récapitulatif avant d'appliquer, puis application non destructrice
  const fichier = { format: 'carte-live-adrasec', version: 1, section: { code: '07', nom: 'ADRASEC 07' },
    equipes: [{ id: 'e1', nom: 'Gonio 07', couleur: '#4cc9f0', mission: 'Vallée du Rhône' }],
    membres: [
      { indicatif: 'F4XYZ', qualite: 'radioamateur', equipe: 'e1' },
      { indicatif: 'F5ABC', qualite: 'radioamateur', equipe: 'e1', fonction: 'opérateur gonio', president: true },
      { numeroSwl: 'F-99999', qualite: 'swl' },
      { indicatif: 'PASBON', qualite: 'radioamateur' },
    ] };
  const vue0 = await appel('GET', '/api/adrasec?g=43');
  const ap = await appel('POST', '/api/adrasec/import?g=43', { fichier, appliquer: false });
  const vue1 = await appel('GET', '/api/adrasec?g=43');
  const justeApercu = (vue1.j.attentes || []).length === 0 && vue1.j.equipes.length === vue0.j.equipes.length && vue1.j.membres.length === vue0.j.membres.length;
  const r = ap.j;
  if (ap.statut === 200 && r.rattaches.length === 0 && r.attentes.length === 2 && r.dejaMembres.length === 1 && r.ignores.length === 1 && r.equipesCreees.length === 1 && r.presidents === 1 && justeApercu)
    ok('import : récapitulatif juste (1 déjà membre, 2 en attente, 1 équipe, 1 ignoré, 1 président signalé) et rien écrit avant confirmation');
  else ko('aperçu d’import : ' + JSON.stringify({ r, justeApercu }).slice(0, 400));
  const fait = await appel('POST', '/api/adrasec/import?g=43', { fichier, appliquer: true });
  const vue2 = await appel('GET', '/api/adrasec?g=43');
  const att = vue2.j.attentes || [];
  const rien = vue2.j.membres.length === vue0.j.membres.length;
  const eqNeuve = vue2.j.equipes.some((e) => e.nom === 'Gonio 07');
  const sansResp = att.every((a) => !a.responsable && !a.president);
  if (fait.statut === 200 && att.length === 2 && rien && eqNeuve && sansResp)
    ok('import appliqué : équipe créée, 2 fiches en attente, aucun membre ajouté sans compte, aucun président');
  else ko('import appliqué : ' + JSON.stringify({ fait: fait.statut, att, rien, eqNeuve }).slice(0, 400));
  const mc = (vue2.j.mainCourante || []).some((x) => /Import de la section depuis/.test(x.texte));
  if (mc) ok('import inscrit à la main courante de la section'); else ko('import absent de la main courante');
  // 4) Retrait d'une fiche en attente, refusé à un simple membre
  const retraitMembre = await appel('DELETE', '/api/adrasec/attentes/' + att[0].id, null, HM);
  const retrait = await appel('DELETE', '/api/adrasec/attentes/' + att[0].id);
  const vue3 = await appel('GET', '/api/adrasec?g=43');
  if (retraitMembre.statut === 403 && retrait.statut === 200 && (vue3.j.attentes || []).length === 1) ok('fiche en attente retirée par le président, refusée à un simple membre');
  else ko('retrait d’une fiche en attente : ' + JSON.stringify({ membre: retraitMembre.statut, resp: retrait.statut, reste: (vue3.j.attentes || []).length }));
  // 5) Journal d'audit des deux côtés
  const audit = JSON.stringify(await (await fetch(BASE + '/api/audit', { headers: H })).json().catch(() => []));
  if (/ADRASEC : section exportée/.test(audit) && /ADRASEC : section importée/.test(audit)) ok('journal d’audit : export et import notés'); else ko('journal d’audit du transfert : ' + audit.slice(0, 200));
  // 6) Interface (téléphone 390 px) : bloc de transfert et fiches en attente
  const ctx = await navig.newContext({ viewport: { width: 390, height: 844 }, locale: 'fr-FR', isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addCookies([cookie]);
  await ctx.addInitScript(() => { try { localStorage.setItem('adrasec-onglet', 'gestion'); localStorage.setItem('adrasec-groupe', '43'); } catch { /* */ } });
  const { page, erreurs } = await ouvrir(ctx, '/adrasec');
  await page.waitForTimeout(1500);
  const u = await page.evaluate(() => { const v = document.querySelector('#vue-gestion'); return { texte: v.textContent.replace(/\s+/g, ' '), bouton: !!v.querySelector('#tr-export'), fichier: !!v.querySelector('#tr-fichier'), attentes: v.querySelectorAll('.fiche-membre.attente').length, deborde: v.scrollWidth > v.clientWidth + 2 }; });
  if (u.bouton && u.fichier && /Transférer la section vers une autre carte/.test(u.texte) && /aucun compte, aucun mot de passe/.test(u.texte)) ok('page ADRASEC (téléphone) : bloc de transfert, export et import');
  else ko('bloc de transfert : ' + JSON.stringify({ ...u, texte: u.texte.slice(0, 200) }));
  if (u.attentes === 1 && /Fiches en attente d’un compte/.test(u.texte)) ok('page ADRASEC : fiche en attente affichée avec ce qu’il faut faire'); else ko('fiches en attente : ' + u.attentes);
  if (!u.deborde) ok('page ADRASEC (390 px) : pas de débordement horizontal'); else ko('page ADRASEC : débordement en largeur');
  await page.evaluate(() => { const e = document.querySelector('#tr-export'); if (e) e.scrollIntoView({ block: 'center' }); });
  await page.waitForTimeout(400);
  await capture(page, 'adrasec-transfert-telephone');
  bilanErreurs(erreurs, 'transfert de la section ADRASEC');
  await ctx.close();
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

// Espaces « Secours » (DPS, PCS) : séparés de la carte et de l'ADRASEC. Chaque espace a ses comptes ; une session de
// la carte n'y entre pas, une session d'espace n'ouvre rien d'autre (ni la carte, ni l'ADRASEC, ni un autre espace).
async function essaiSecours(navig, cookie) {
  console.log('Espaces Secours (DPS, PCS) : cloisonnement et page');
  const H = { Cookie: `${cookie.name}=${cookie.value}`, 'Content-Type': 'application/json' };
  const statut = async (url, entetes = {}) => (await fetch(BASE + url, { headers: entetes })).status;
  const poster = (url, corps, entetes = { 'Content-Type': 'application/json' }, methode = 'POST') => fetch(BASE + url, { method: methode, headers: entetes, body: JSON.stringify(corps) });
  const creer = (code, nom, genre, id, noeuds) => poster('/api/secours-admin/espaces', { code, nom, genre, responsable: { identifiant: id, motDePasse: 'motdepasse-essai' }, noeuds }, H);
  const r1 = await creer('festival-essai', 'Festival d’essai', 'dps', 'chef.essai', '!a1b2c3d4');
  const r2 = await creer('pcs-essai', 'PCS d’essai', 'pcs', 'mairie.essai', '');
  const doublon = await poster('/api/secours-admin/espaces/pcs-essai', { noeuds: '!a1b2c3d4' }, H, 'PATCH');
  const liste = (await r2.json()).espaces || [];
  const retrait = await poster('/api/secours-admin/espaces/pcs-essai', { retirer: ['!a1b2c3d4'] }, H, 'PATCH');
  if (r1.ok && r2.ok && liste.length === 2 && doublon.status === 200 && retrait.status === 200) ok('deux espaces créés par l’administrateur de la carte ; un même nœud peut servir à deux espaces');
  else ko('création des espaces : ' + JSON.stringify({ r1: r1.status, r2: r2.status, liste: liste.length, doublon: doublon.status }));
  // Sessions
  const entrer = async (code, id) => { const r = await poster(`/api/secours/${code}/connexion`, { identifiant: id, motDePasse: 'motdepasse-essai' }); return (r.headers.get('set-cookie') || '').split(';')[0]; };
  const chef = await entrer('festival-essai', 'chef.essai');
  const refus = await poster('/api/secours/pcs-essai/connexion', { identifiant: 'chef.essai', motDePasse: 'motdepasse-essai' });
  const S = {
    anonyme: await statut('/api/secours/festival-essai/etat'),
    adminCarte: await statut('/api/secours/festival-essai/etat', { Cookie: H.Cookie }),
    chefChezLui: await statut('/api/secours/festival-essai/etat', { Cookie: chef }),
    chefAutreEspace: await statut('/api/secours/pcs-essai/etat', { Cookie: chef }),
    chefAdrasec: await statut('/api/adrasec', { Cookie: chef }),
    chefMessages: await statut('/api/messages', { Cookie: chef }),
    chefGestion: await statut('/api/secours-admin/espaces', { Cookie: chef }),
    // Le cookie d'un espace présenté comme session de la carte, et l'inverse
    chefCommeCarte: await statut('/api/comptes', { Cookie: `${cookie.name}=${chef.split('=')[1].replace(/^festival-essai\./, '')}` }),
    carteCommeEspace: await statut('/api/secours/festival-essai/etat', { Cookie: `secours_session=festival-essai.${cookie.value}` }),
    autreComptes: refus.status,
  };
  const attendu = { anonyme: 401, adminCarte: 401, chefChezLui: 200, chefAutreEspace: 401, chefAdrasec: 401, chefMessages: 401, chefGestion: 403, chefCommeCarte: 401, carteCommeEspace: 401, autreComptes: 401 };
  if (JSON.stringify(S) === JSON.stringify(attendu)) ok('cloisonnement : ni la session de la carte ni celle d’un autre espace n’entrent ; un compte d’espace n’ouvre ni la carte ni l’ADRASEC');
  else ko('cloisonnement des espaces : ' + JSON.stringify(S));
  const acces = await (await fetch(BASE + '/api/secours/festival-essai/acces')).json();
  if (Object.keys(acces).sort().join() === 'carte,code,connecte,genre,identifiant,nom' && acces.connecte === false) ok('sans connexion, un espace ne dit que son nom et son type');
  else ko('accès public d’un espace : ' + JSON.stringify(acces));
  // Équipe, intervention, main courante par l'API ; équipier limité à l'état de son équipe
  const HC = { Cookie: chef, 'Content-Type': 'application/json' };
  const eq = await (await poster('/api/secours/festival-essai/equipes', { nom: 'Binôme A', genre: 'binome', effectif: 2, noeud: '!a1b2c3d4' }, HC)).json();
  const eq2 = await (await poster('/api/secours/festival-essai/equipes', { nom: 'Poste 1', genre: 'poste', effectif: 4, lat: 45.04, lon: 3.88 }, HC)).json();
  await poster('/api/secours/festival-essai/comptes', { identifiant: 'secouriste.essai', motDePasse: 'motdepasse-essai', equipe: eq.id }, HC);
  const sec = await entrer('festival-essai', 'secouriste.essai'), HS = { Cookie: sec, 'Content-Type': 'application/json' };
  const x = await (await poster('/api/secours/festival-essai/interventions', { genre: 'malaise', titre: 'Malaise essai', lat: 45.041, lon: 3.881, equipe: eq.id }, HS)).json();
  const R = {
    equipierCree: (await poster('/api/secours/festival-essai/equipes', { nom: 'Pirate' }, HS)).status,
    equipierComptes: (await poster('/api/secours/festival-essai/comptes', { identifiant: 'pirate', motDePasse: 'motdepasse-essai' }, HS)).status,
    etatAutre: (await poster(`/api/secours/festival-essai/equipes/${eq2.id}/etat`, { etat: 'pause' }, HS, 'PUT')).status,
    etatSienne: (await poster(`/api/secours/festival-essai/equipes/${eq.id}/etat`, { etat: 'pause' }, HS, 'PUT')).status,
    csv: (await (await fetch(BASE + '/api/secours/festival-essai/main-courante.csv', { headers: { Cookie: sec } })).text()).includes('Intervention ouverte : Malaise essai'),
  };
  const vue = await (await fetch(BASE + '/api/secours/festival-essai/etat', { headers: { Cookie: sec } })).json();
  if (x.statut === 'en-cours' && JSON.stringify(R) === JSON.stringify({ equipierCree: 403, equipierComptes: 403, etatAutre: 400, etatSienne: 200, csv: true }) && vue.comptes === undefined && vue.noeuds === undefined && vue.equipes.length === 2)
    ok('équipier : interventions et main courante oui, équipes, comptes et nœuds réservés aux responsables');
  else ko('droits d’un équipier : ' + JSON.stringify({ x: x.statut, R, comptes: vue.comptes, noeuds: vue.noeuds }));
  // Envoi vers le terrain : réservé aux responsables et au poste de coordination ; sans module radio branché sur la
  // carte d'essai, l'envoi est refusé avec le motif, et rien n'est noté comme envoyé
  const envoiChef = await poster('/api/secours/festival-essai/envoi', { texte: 'Essai', equipe: eq.id }, HC), envoiSec = await poster('/api/secours/festival-essai/envoi', { texte: 'Essai', equipe: eq.id }, HS);
  const diffusion = await poster(`/api/secours/festival-essai/interventions/${x.id}/diffuser`, {}, HC);
  const motifs = [(await envoiChef.json()).erreur, (await envoiSec.json()).erreur, (await diffusion.json()).erreur];
  const vueChef = await (await fetch(BASE + '/api/secours/festival-essai/etat', { headers: { Cookie: chef } })).json();
  if (envoiChef.status === 400 && /Module radio non connecté/.test(motifs[0]) && envoiSec.status === 400 && /réservé aux responsables/.test(motifs[1]) && /Module radio non connecté/.test(motifs[2])
    && vueChef.radio.peutEnvoyer && !vueChef.radio.connecte && vue.radio.peutEnvoyer === false && !vueChef.mainCourante.some((m) => m.type === 'message-emis'))
    ok('envoi vers le terrain : réservé aux responsables, refusé avec son motif quand le module radio n’est pas connecté');
  else ko('envoi vers le terrain : ' + JSON.stringify({ s: [envoiChef.status, envoiSec.status, diffusion.status], motifs, radio: vueChef.radio }));
  // Organisations dans l'espace, nœuds choisis dans la liste de la carte, nœud attendu par son nom court
  const HA = { ...H, 'Content-Type': 'application/json' };
  const modifier = (code, corps) => poster('/api/secours-admin/espaces/' + code, corps, HA, 'PATCH');
  const org1 = await modifier('festival-essai', { organisation: { nom: 'Croix-Rouge française' } });
  const sel = await (await fetch(BASE + '/api/secours-admin/selecteur', { headers: H })).json();
  const O = {
    org: org1.status, selChef: await statut('/api/secours-admin/selecteur', { Cookie: chef }),
    proposees: sel.organisations.dps.includes('ADRASEC') && sel.organisations.dps.includes('Ordre de Malte France') && sel.organisations.pcs.includes('Services techniques'),
    doublon: (await modifier('festival-essai', { organisation: { nom: 'croix-rouge française' } })).status,
    attente: (await modifier('festival-essai', { organisation: { nom: 'Protection Civile (ADPC, FNPC)' }, attendre: { nom: 'PS01', organisation: 'nouvelle' } })).status,
    attenteAilleurs: (await modifier('pcs-essai', { attendre: { nom: 'ps01' } })).status,
    canalInconnu: (await modifier('festival-essai', { canal: 'CanalAbsent' })).status,
  };
  await modifier('pcs-essai', { retirerAttente: 'ps01' });
  const fiche = (await (await fetch(BASE + '/api/secours-admin/espaces', { headers: H })).json()).espaces.find((e) => e.code === 'festival-essai');
  if (JSON.stringify(O) === JSON.stringify({ org: 200, selChef: 403, proposees: true, doublon: 400, attente: 200, attenteAilleurs: 200, canalInconnu: 400 }) && Array.isArray(sel.noeuds)
    && fiche.organisations.length === 2 && fiche.attentes.length === 1 && fiche.attentes[0].nom === 'PS01' && fiche.attentes[0].organisation === fiche.organisations[1].id)
    ok('organisations d’un espace : liste proposée (dont l’ADRASEC), sélecteur réservé à l’administrateur de la carte, nœud attendu par son nom court');
  else ko('organisations et sélecteur : ' + JSON.stringify({ O, organisations: fiche.organisations, attentes: fiche.attentes }));
  // Repères et options : point de rassemblement dans un DPS, zone à évacuer seulement dans un PCS, droits
  const orgEquipe = await poster(`/api/secours/festival-essai/equipes/${eq2.id}`, { organisation: fiche.organisations[0].id }, HC, 'PATCH');
  const rp = await poster('/api/secours/festival-essai/reperes', { genre: 'rassemblement', nom: 'Parking nord', lat: 45.042, lon: 3.885 }, HC);
  const repere = await rp.json();
  const mairie = await entrer('pcs-essai', 'mairie.essai'), HM = { Cookie: mairie, 'Content-Type': 'application/json' };
  const P = {
    orgEquipe: orgEquipe.status, rassemblement: rp.status,
    zoneDps: (await poster('/api/secours/festival-essai/reperes', { genre: 'zone', nom: 'Zone', contour: [[45, 3.8], [45.1, 3.8], [45.1, 3.9]] }, HC)).status,
    zonePcs: (await poster('/api/secours/pcs-essai/reperes', { genre: 'zone', nom: 'Quartier bas', contour: [[45, 3.8], [45.1, 3.8], [45.1, 3.9]] }, HM)).status,
    equipier: (await poster('/api/secours/festival-essai/reperes', { genre: 'rassemblement', nom: 'Pirate', lat: 45, lon: 3.8 }, HS)).status,
    diffusion: (await poster(`/api/secours/festival-essai/reperes/${repere.id}/diffuser`, {}, HC)).status,
    optionsEquipier: (await poster('/api/secours/festival-essai/reglages', { options: { trajets: false } }, HS, 'PUT')).status,
    options: (await poster('/api/secours/festival-essai/reglages', { options: { trajets: false }, macros: ['Rejoignez le PC'] }, HC, 'PUT')).status,
    trace: (await fetch(BASE + `/api/secours/festival-essai/equipes/${eq.id}/trace`, { headers: { Cookie: chef } })).status,
    rapportEquipier: await statut('/api/secours/festival-essai/rapport.html', { Cookie: sec }),
  };
  const rapport = await fetch(BASE + '/api/secours/festival-essai/rapport.html', { headers: { Cookie: chef } });
  const texteRapport = await rapport.text();
  const vueSec = await (await fetch(BASE + '/api/secours/festival-essai/etat', { headers: { Cookie: sec } })).json();
  if (JSON.stringify(P) === JSON.stringify({ orgEquipe: 200, rassemblement: 200, zoneDps: 400, zonePcs: 200, equipier: 400, diffusion: 400, optionsEquipier: 403, options: 200, trace: 400, rapportEquipier: 403 })
    && rapport.status === 200 && /attachment/.test(rapport.headers.get('content-disposition') || '') && texteRapport.includes('Malaise essai') && texteRapport.includes('Parking nord')
    && vueSec.reperes.length === 1 && vueSec.options.trajets === false && vueSec.macros[0] === 'Rejoignez le PC' && vueSec.catalogueOptions === undefined && vueSec.courriel === undefined && vueSec.organisations.length === 2)
    ok('repères, options et rapport de fin : point de rassemblement vu de tout l’espace, zone réservée au PCS, réglages et rapport réservés aux responsables');
  else ko('repères et options : ' + JSON.stringify({ P, rapport: rapport.status, reperes: vueSec.reperes.length, options: vueSec.options }));
  // Page : connexion, onglets, carte, sans erreur JavaScript (ordinateur puis téléphone)
  const ctx = await navig.newContext({ viewport: { width: 1366, height: 800 }, locale: 'fr-FR' });
  const { page, erreurs } = await ouvrir(ctx, '/secours/festival-essai');
  await page.fill('#c-id', 'chef.essai'); await page.fill('#c-mdp', 'motdepasse-essai'); await page.click('#connexion button');
  await page.waitForSelector('#onglets', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
  const p = await page.evaluate(() => ({ onglets: document.querySelectorAll('#onglets button').length, fiches: document.querySelectorAll('#i-liste .fiche').length, carte: !!document.querySelector('#carte .leaflet-pane'),
    reperes: document.querySelectorAll('.rep-equipe, .rep-inter').length, gestion: document.querySelector('[data-vue="gestion"]').textContent.trim() }));
  await page.click('[data-vue="equipes"]'); await page.waitForTimeout(300);
  const resume = await page.textContent('#e-resume');
  await page.click('[data-vue="mc"]'); await page.waitForTimeout(300);
  const envoi = await page.evaluate(() => ({ bloc: !!document.querySelector('#r-texte'), choix: document.querySelectorAll('#r-dest option').length, coupe: document.querySelector('#r-ok').disabled, etat: document.querySelector('#r-etat').textContent }));
  await page.click('[data-vue="reperes"]'); await page.waitForTimeout(300);
  const rep = await page.evaluate(() => ({ fiches: document.querySelectorAll('#p-liste .fiche').length, carte: document.querySelectorAll('.rep-repere.rassemblement').length, nouveau: !!document.querySelector('#p-rassemblement'), autre: document.querySelector('#p-autre').hidden, radio: !!document.querySelector('#p-liste .radio') }));
  await page.click('#p-rassemblement'); await page.fill('#p-nom', 'Entrée sud'); await page.click('#p-pointer'); await page.mouse.click(400, 400); await page.waitForTimeout(200);
  await page.click('#p-ok'); await page.waitForTimeout(900);
  rep.apres = await page.locator('#p-liste .fiche').count();
  await page.click('[data-vue="equipes"]'); await page.waitForTimeout(300);
  const filtre = await page.evaluate(() => ({ choix: document.querySelectorAll('#e-org-filtre option').length, trajet: !!document.querySelector('#e-liste .trajet'), org: /Croix-Rouge française/.test(document.querySelector('#e-liste').textContent) }));
  await page.selectOption('#e-org-filtre', { index: 1 }); await page.waitForTimeout(300);
  filtre.filtrees = await page.locator('#e-liste .fiche').count();
  await page.click('[data-vue="gestion"]'); await page.waitForTimeout(400);
  const gestion = await page.evaluate(() => ({ options: document.querySelectorAll('.g-option').length, rapport: !!document.querySelector('a[href$="/rapport.html"]'), macros: document.querySelector('#g-macros').value, attendu: /PS01/.test(document.querySelector('#vue-gestion').textContent), bord: document.querySelectorAll('#i-bord .tableau-bord div').length }));
  if (rep.fiches === 1 && rep.carte === 1 && rep.nouveau && rep.autre && rep.radio && rep.apres === 2 && filtre.choix === 3 && !filtre.trajet && filtre.org && filtre.filtrees === 1
    && gestion.options === 9 && gestion.rapport && gestion.macros === 'Rejoignez le PC' && gestion.attendu && gestion.bord === 5)
    ok('page d’un espace : onglet Repères (point posé sur la carte), équipes filtrées par organisation, options et rapport dans Gestion, tableau de bord');
  else { ko('repères, organisations et options dans la page : ' + JSON.stringify({ rep, filtre, gestion })); await capture(page, 'secours-options'); }
  await page.click('[data-vue="reperes"]'); await page.waitForTimeout(300);
  await page.click('#p-rassemblement'); await page.fill('#p-nom', 'Salle des fêtes'); await page.click('#p-pointer'); await page.mouse.click(500, 420); await page.waitForTimeout(200);
  await page.click('#p-ok'); await page.waitForTimeout(900);
  const apresGestion = await page.evaluate(() => ({ fiches: document.querySelectorAll('#p-liste .fiche').length, retour: (document.querySelector('#p-retour') || {}).textContent, mdp: !!document.querySelector('#mdp-ok') }));
  if (apresGestion.fiches === 3 && !apresGestion.retour) ok('repère enregistré après un passage par Gestion : le formulaire du mot de passe ne prend pas le bouton du repère');
  else { ko('repère après Gestion : ' + JSON.stringify(apresGestion)); await capture(page, 'secours-repere-gestion'); }
  if (envoi.bloc && envoi.choix === 2 && envoi.coupe && /n’est pas connecté/.test(envoi.etat)) ok('main courante : bloc « Écrire au terrain par radio », désactivé tant que le module n’est pas connecté');
  else { ko('bloc d’envoi par radio : ' + JSON.stringify(envoi)); await capture(page, 'secours-envoi'); }
  if (p.onglets === 5 && p.fiches === 1 && p.carte && p.reperes >= 2 && /Gestion/.test(p.gestion) && /Effectif prévu : 6 secouristes/.test(resume)) ok('page d’un espace : interventions, équipes sur la carte, effectif du dispositif');
  else { ko('page d’un espace : ' + JSON.stringify({ p, resume })); await capture(page, 'secours-espace'); }
  // Fonds de carte (dont sombre et relief), panneau élargi à la souris, sélecteur de nœuds dans la Gestion du responsable
  const fondsDispo = await page.evaluate(() => [...document.querySelectorAll('.leaflet-control-layers label')].map((l) => l.textContent.trim()));
  await page.evaluate(() => { const r = [...document.querySelectorAll('.leaflet-control-layers-base label')].find((l) => /Plan IGN sombre/.test(l.textContent)); r.querySelector('input').click(); });
  const boite = await page.locator('#poignee').boundingBox(), avantL = await page.evaluate(() => document.querySelector('aside').offsetWidth);
  await page.mouse.move(boite.x + 5, boite.y + 200); await page.mouse.down(); await page.mouse.move(boite.x - 195, boite.y + 220, { steps: 5 }); await page.mouse.up(); await page.waitForTimeout(300);
  const pan = await page.evaluate(() => ({ l: document.querySelector('aside').offsetWidth, carte: document.querySelector('#carte').offsetWidth, retenue: localStorage.getItem('secours-largeur'), fond: localStorage.getItem('secours-fond'), sombre: document.body.classList.contains('fond-sombre'), selecteur: !!document.querySelector('#g-selecteur'), deborde: document.documentElement.scrollWidth > innerWidth }));
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('#onglets', { timeout: 8000 }).catch(() => {}); await page.waitForTimeout(600);
  pan.apres = await page.evaluate(() => document.querySelector('aside').offsetWidth);
  if (['Sombre', 'Plan IGN', 'Plan IGN sombre', 'Photos aériennes IGN', 'Topographique (relief)', 'Relief ombré', 'Noms des lieux'].every((n) => fondsDispo.includes(n)) && pan.fond === 'Plan IGN sombre' && pan.sombre
    && Math.abs(pan.l - avantL - 200) <= 12 && Number(pan.retenue) === pan.l && pan.apres === pan.l && pan.carte > 300 && !pan.deborde && pan.selecteur)
    ok(`page d’un espace : fonds sombre et relief au choix, panneau élargi à la souris (${avantL} → ${pan.l} px) et largeur retenue`);
  else { ko('fonds de carte et largeur du panneau : ' + JSON.stringify({ fondsDispo, avantL, pan })); await capture(page, 'secours-panneau'); }
  // Socle commun : aide « ? », recherche d'une fonction (Ctrl+K) et confirmations dans l'interface, comme sur la carte
  const natives = [];
  page.on('dialog', (d) => { natives.push(d.type()); d.dismiss().catch(() => {}); });
  await page.keyboard.press('Control+k'); await page.waitForTimeout(300);
  const rech = await page.evaluate(() => ({ ouverte: !!document.querySelector('#dlg-recherche-commune[open]'), titres: [...document.querySelectorAll('#dlg-recherche-commune .res-commun b')].map((b) => b.textContent) }));
  await page.fill('#dlg-recherche-commune input', 'mot de passe'); await page.waitForTimeout(200);
  rech.trouve = await page.evaluate(() => [...document.querySelectorAll('#dlg-recherche-commune .res-commun b')].map((b) => b.textContent).join('|'));
  await page.keyboard.press('Enter'); await page.waitForTimeout(500);
  rech.onglet = await page.evaluate(() => (document.querySelector('#onglets button.actif') || {}).dataset.vue);
  rech.fermee = await page.evaluate(() => !document.querySelector('#dlg-recherche-commune[open]'));
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  if (process.env.DEBOGAGE) console.log(JSON.stringify(rech), await page.evaluate(() => document.querySelector('#vue-gestion').innerHTML.length));
  await page.click('.socle-commun [data-socle="aide"]'); await page.waitForTimeout(900);
  const aide = await page.evaluate(() => { const d = document.querySelector('#dlg-aide-commune[open]'); return { ouverte: !!d, texte: d ? d.querySelector('.corps-aide').textContent.length : 0, titres: d ? d.querySelectorAll('.corps-aide h2, .corps-aide h3').length : 0 }; });
  await capture(page, 'secours-aide');
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  await page.click('.c-suppr'); await page.waitForTimeout(300);
  const conf = await page.evaluate(() => { const d = document.querySelector('#dlg-confirmer[open]'); return { ouverte: !!d, texte: d ? d.querySelector('p').textContent : '', danger: d ? !!d.querySelector('button.danger') : false }; });
  await capture(page, 'secours-confirmation');
  await page.click('#dlg-confirmer [data-r="0"]'); await page.waitForTimeout(300);
  conf.comptes = (await (await fetch(BASE + '/api/secours/festival-essai/etat', { headers: { Cookie: chef } })).json()).comptes.length;
  if (rech.ouverte && rech.titres.length >= 5 && /Mon mot de passe/.test(rech.trouve) && rech.onglet === 'gestion' && rech.fermee && aide.ouverte && aide.texte > 500 && aide.titres >= 3 && conf.ouverte && /Supprimer le compte/.test(conf.texte) && conf.danger && conf.comptes >= 2 && !natives.length)
    ok('page d’un espace : recherche d’une fonction (Ctrl+K), aide « ? » et confirmation dans l’interface, sans boîte du navigateur');
  else { ko('socle commun sur la page Secours : ' + JSON.stringify({ rech, aide, conf, natives })); await capture(page, 'secours-socle'); }
  bilanErreurs(erreurs, 'Page d’un espace Secours');
  await ctx.close();
  // Le responsable choisit lui-même les nœuds de son espace (sans session d'administrateur de la carte) ; pas un équipier
  const deux = await navig.newContext({ viewport: { width: 1366, height: 800 }, locale: 'fr-FR' });
  await deux.addCookies([{ name: 'secours_session', value: chef.split('=')[1], domain: '127.0.0.1', path: '/' }]);
  const dx = await ouvrir(deux, '/secours/festival-essai');
  await dx.page.click('[data-vue="equipes"]'); await dx.page.click('#e-nouvelle'); await dx.page.click('#e-plus-noeuds'); await dx.page.waitForTimeout(400);
  const sd = await dx.page.evaluate(() => ({ ouvert: (document.querySelector('#g-selecteur') || {}).open, gestion: document.querySelector('#vue-gestion').classList.contains('actif'), noeud: !!document.querySelector('#vue-gestion tr[data-noeud="!a1b2c3d4"] .gn-org'), lignes: document.querySelectorAll('#g-s-liste > *').length }));
  await dx.page.fill('#g-s-attente', 'PC01'); await dx.page.click('#g-s-attendre'); await dx.page.waitForTimeout(900);
  sd.attendus = await dx.page.evaluate(() => [...document.querySelectorAll('.gn-attente')].map((b) => b.dataset.nom).join());
  await dx.page.click('.gn-attente[data-nom="PC01"]'); await dx.page.waitForTimeout(900);
  sd.apres = await dx.page.evaluate(() => [...document.querySelectorAll('.gn-attente')].map((b) => b.dataset.nom).join());
  sd.equipier = await statut('/api/secours/festival-essai/selecteur', { Cookie: sec }); sd.equipierAjout = (await poster('/api/secours/festival-essai/noeuds', { attendre: { nom: 'PIRA' } }, HS)).status;
  if (sd.ouvert && sd.gestion && sd.noeud && sd.lignes >= 1 && sd.attendus === 'PS01,PC01' && sd.apres === 'PS01' && sd.equipier === 403 && sd.equipierAjout === 403) ok('responsable d’un espace : il choisit et attend lui-même ses nœuds dans Gestion ; un équipier ne voit pas la liste des nœuds de la carte');
  else { ko('sélecteur de nœuds dans l’espace : ' + JSON.stringify(sd)); await capture(dx.page, 'secours-selecteur-espace'); }
  bilanErreurs(dx.erreurs, 'Sélecteur de nœuds dans un espace');
  await deux.close();
  const tel = await navig.newContext({ viewport: { width: 390, height: 800 }, locale: 'fr-FR' });
  await tel.addCookies([{ name: 'secours_session', value: sec.split('=')[1], domain: '127.0.0.1', path: '/' }]);
  const t = await ouvrir(tel, '/secours/festival-essai');
  const pt = await t.page.evaluate(() => ({ deborde: document.documentElement.scrollWidth > innerWidth, gestion: document.querySelector('[data-vue="gestion"]').textContent.trim(), nouvelle: !!document.querySelector('#i-nouvelle') }));
  if (!pt.deborde && /Mon compte/.test(pt.gestion) && pt.nouvelle) ok('équipier sur téléphone : page lisible sans défilement horizontal, pas d’onglet Gestion');
  else { ko('espace sur téléphone : ' + JSON.stringify(pt)); await capture(t.page, 'secours-telephone'); }
  bilanErreurs(t.erreurs, 'Espace Secours sur téléphone');
  await tel.close();
  // Gestion des espaces (administrateur de la carte), puis suppression
  const adm = await navig.newContext({ viewport: { width: 1366, height: 800 }, locale: 'fr-FR' });
  await adm.addCookies([cookie]);
  const g = await ouvrir(adm, '/secours');
  const nb = await g.page.locator('#liste .fiche').count();
  if (nb === 2) ok('gestion des espaces : les deux espaces listés pour l’administrateur de la carte'); else { ko(`gestion des espaces : ${nb} fiche(s)`); await capture(g.page, 'secours-gestion'); }
  const sg = await g.page.locator('.fiche[data-code="festival-essai"]').evaluate((el) => ({ puces: el.querySelectorAll('.puce').length, attentes: [...el.querySelectorAll('.a-retirer')].map((b) => b.dataset.nom).join(), selecteur: !!el.querySelector('details.selecteur'), noeud: !!el.querySelector('tr[data-noeud="!a1b2c3d4"] .n-retirer'), canal: !!el.querySelector('.c-canal'),
    large: document.querySelector('.plein.large').clientWidth, cote: new Set([...document.querySelectorAll('#liste .fiche')].map((f) => Math.round(f.getBoundingClientRect().top))).size, deborde: document.documentElement.scrollWidth > innerWidth }));
  if (sg.puces === 3 && sg.attentes === 'PS01' && !sg.selecteur && sg.noeud && sg.canal && sg.large > 1300 && sg.cote === 1 && !sg.deborde) ok('gestion des espaces : toute la largeur, fiches côte à côte, organisations et canal ; les nœuds se choisissent dans l’espace');
  else { ko('gestion des espaces, fiche : ' + JSON.stringify(sg)); await capture(g.page, 'secours-selecteur'); }
  const socleAdmin = await g.page.evaluate(() => ({ carte: (document.querySelector('.socle-commun a[href="/"]') || {}).textContent, aide: !!document.querySelector('.socle-commun [data-socle="aide"]') }));
  if (/Carte/.test(socleAdmin.carte || '') && socleAdmin.aide) ok('gestion des espaces : retour à la carte et aide dans l’en-tête'); else ko('en-tête de la gestion des espaces : ' + JSON.stringify(socleAdmin));
  bilanErreurs(g.erreurs, 'Gestion des espaces Secours');
  await adm.close();
  const suppr = await fetch(BASE + '/api/secours-admin/espaces/festival-essai', { method: 'DELETE', headers: H });
  const apres = await statut('/api/secours/festival-essai/etat', { Cookie: chef });
  if (suppr.ok && apres === 401 && fs.readdirSync(path.join(donnees, 'secours', 'corbeille')).some((f) => f.startsWith('festival-essai-'))) ok('espace supprimé : plus d’accès, fichier gardé dans la corbeille');
  else ko('suppression d’un espace : ' + JSON.stringify({ suppr: suppr.status, apres }));
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

// Passerelle d'un membre : sa radio (simulée derrière la WebSocket de la page) reste en écoute, porte son identifiant,
// ne remplace aucun module ; il y écrit les canaux de la carte et de son ADRASEC (clés jamais montrées), avec place libérée.
function fausseRadio(ws, num) {
  const { racine } = require('../src/decodeur');
  const FromRadio = racine.lookupType('meshtastic.FromRadio'), ToRadio = racine.lookupType('meshtastic.ToRadio'), Admin = racine.lookupType('meshtastic.AdminMessage');
  const cle = (n) => Buffer.alloc(32, n);
  const canaux = [
    { index: 0, role: 1, settings: { name: '', psk: Buffer.from([1]) } },
    { index: 1, role: 2, settings: { name: 'Fr_Balise', psk: Buffer.from([1]) } },
    { index: 2, role: 2, settings: { name: 'Perso', psk: cle(7), moduleSettings: { positionPrecision: 13 } } },
    ...[3, 4, 5, 6, 7].map((i) => ({ index: i, role: 0, settings: {} })),
  ];
  const ordres = [];
  const envoyer = (o) => { const c = FromRadio.encode(FromRadio.create(o)).finish(); const t = Buffer.from([0x94, 0xc3, c.length >> 8, c.length & 255]); ws.send(Buffer.concat([t, Buffer.from(c)])); };
  let tampon = Buffer.alloc(0);
  ws.on('message', (d, binaire) => {
    if (!binaire) return;
    tampon = Buffer.concat([tampon, Buffer.from(d)]);
    for (;;) {
      const i = tampon.indexOf(Buffer.from([0x94, 0xc3]));
      if (i < 0) { tampon = tampon.subarray(Math.max(0, tampon.length - 1)); break; }
      tampon = tampon.subarray(i);
      if (tampon.length < 4) break;
      const n = tampon.readUInt16BE(2); if (tampon.length < 4 + n) break;
      const tr = ToRadio.decode(tampon.subarray(4, 4 + n)); tampon = tampon.subarray(4 + n);
      if (tr.wantConfigId) {
        envoyer({ myInfo: { myNodeNum: num } });
        envoyer({ nodeInfo: { num, user: { id: '!' + num.toString(16), longName: 'Radio de Paul', shortName: 'PAUL' } } });
        envoyer({ config: { lora: { modemPreset: 0, hopLimit: 3, region: 3 } } });
        for (const c of canaux) envoyer({ channel: c });
        envoyer({ configCompleteId: tr.wantConfigId });
      } else if (tr.packet && tr.packet.decoded && tr.packet.decoded.portnum === 6) {
        const a = Admin.decode(tr.packet.decoded.payload);
        ordres.push({ vers: tr.packet.to >>> 0, a: Object.keys(Admin.toObject(a)).filter((k) => a[k] != null)[0] });
        if (a.setChannel) canaux[a.setChannel.index] = Admin.toObject(a, { defaults: false }).setChannel;
      }
    }
  });
  return { canaux, ordres };
}
async function essaiPasserelleMembre(navig, cookie) {
  console.log('Passerelle d’un membre et jeux de canaux');
  const WebSocket = require('ws');
  const HA = { 'Content-Type': 'application/json', Cookie: `${cookie.name}=${cookie.value}` };
  const appelA = async (m, url, b) => { const r = await fetch(BASE + url, { method: m, headers: HA, body: b ? JSON.stringify(b) : undefined }); return { statut: r.status, j: await r.json().catch(() => ({})) }; };
  const paul = (await appelA('POST', '/api/comptes', { identifiant: 'Paul passerelle', motDePasse: 'Essai-paul-2026!!' })).j;
  await appelA('PUT', '/api/adrasec/roles/' + paul.id, { groupe: '43' });
  const cx = await fetch(BASE + '/api/connexion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiant: 'Paul passerelle', motDePasse: 'Essai-paul-2026!!' }) });
  const cookieP = (cx.headers.get('set-cookie') || '').split(';')[0];
  const HP = { 'Content-Type': 'application/json', Cookie: cookieP };
  const appelP = async (m, url, b) => { const r = await fetch(BASE + url, { method: m, headers: HP, body: b ? JSON.stringify(b) : undefined }); return { statut: r.status, j: await r.json().catch(() => ({})) }; };
  // Jeux de canaux : carte (administrateur) et ADRASEC 43 (président / administrateur)
  const jc = await appelA('PUT', '/api/jeux-canaux/carte', { canaux: [{ nom: 'Fr_EMCOM', cle: 'publique' }] });
  const ja = await appelA('PUT', '/api/adrasec/canaux?g=43', { canaux: [{ nom: 'ADRASEC43', cle: 'aleatoire', positions: true }, { nom: 'Alerte', cle: 'publique' }] });
  const refusP = await appelP('PUT', '/api/jeux-canaux/carte', { canaux: [] });
  const mauvais = await appelA('PUT', '/api/jeux-canaux/carte', { canaux: [{ nom: 'Accentué_é', cle: 'publique' }] });
  const vueP = await appelP('GET', '/api/jeux-canaux');
  const texte = JSON.stringify([jc.j, ja.j, vueP.j]);
  const adr = (vueP.j.jeux || []).find((x) => x.portee === 'adrasec:43');
  if (jc.statut === 200 && ja.statut === 200 && refusP.statut === 401 && mauvais.statut === 400 && adr && adr.canaux.length === 2 && !adr.modifiable && !adr.canaux[0].empreinte && ja.j.canaux[0].empreinte && !/psk|"cle"|[A-Za-z0-9+/]{40,}={0,2}/.test(texte)) ok('jeux de canaux : carte et ADRASEC, réglés par l’administrateur, clés jamais renvoyées (empreinte pour qui règle)');
  else ko('jeux de canaux : ' + JSON.stringify({ jc: jc.statut, ja: ja.statut, refusP: refusP.statut, mauvais: mauvais.statut, adr }).slice(0, 400));
  // Radio de Paul reliée par « sa page » : demande « principal », reçoit « en écoute » avec son identifiant
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws/module?nom=Radio%20USB&source=USB&role=principal', { headers: { Cookie: cookieP } });
  const premier = new Promise((r) => ws.on('message', (d, bin) => { if (!bin) r(JSON.parse(d.toString())); }));
  await new Promise((r, k) => { ws.once('open', r); ws.once('error', k); });
  const radio = fausseRadio(ws, 0x11223344);
  const info = await Promise.race([premier, new Promise((r) => setTimeout(() => r({}), 3000))]);
  let mien = null;
  for (let k = 0; k < 30; k++) { mien = (await appelP('GET', '/api/passerelle/miennes')).j; if (mien.passerelles && mien.passerelles[0] && mien.passerelles[0].radio && mien.passerelles[0].radio.connecte) break; await new Promise((r) => setTimeout(r, 300)); }
  const p0 = mien.passerelles && mien.passerelles[0];
  const ecA = await appelA('GET', '/api/ecoutes');
  const vueAdmin = (ecA.j.meshtastic || []).find((x) => x.hote === info.hote);
  const anonyme = await new Promise((r) => { const w = new WebSocket(BASE.replace('http', 'ws') + '/ws/module'); w.on('open', () => { w.close(); r('ouverte'); }); w.on('error', () => r('refusée')); w.on('unexpected-response', () => r('refusée')); });
  if (info.role === 'ecoute' && /paul-passerelle/.test(info.hote || '') && p0 && p0.radio.connecte && p0.radio.canaux.length === 8 && p0.radio.canaux[2].chiffrement === 'prive' && !JSON.stringify(mien).includes('BwcH') && vueAdmin && /Paul passerelle/.test(vueAdmin.compte) && anonyme === 'refusée') ok('passerelle d’un membre : en écoute seulement, nom à son identifiant, vue de l’administrateur, canaux lus sans clé, refusée sans compte');
  else ko('passerelle membre : ' + JSON.stringify({ info, p0, vueAdmin, anonyme }).slice(0, 500));
  // Page de Paul : « Devenir passerelle » et le panneau des canaux de sa radio
  const ctx = await navig.newContext({ viewport: { width: 1366, height: 860 }, locale: 'fr-FR' });
  const [n, v] = cookieP.split('=');
  await ctx.addCookies([{ name: n, value: v, domain: '127.0.0.1', path: '/' }]);
  await ctx.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  const { page, erreurs } = await ouvrir(ctx, '/');
  await page.waitForTimeout(800);
  const e1 = await page.evaluate(async (hote) => {
    const bouton = document.querySelector('#outil-connecter').textContent;
    moduleNav.etat = 'relie'; moduleNav.hote = hote; moduleNav.type = 'usb'; moduleNav.role = 'ecoute';
    await ouvrirConnexion();
    await new Promise((r) => setTimeout(r, 1500));
    const z = document.querySelector('#cx-canaux');
    const cases = [...z.querySelectorAll('[data-ajout]')].map((x) => x.dataset.nom + (x.checked ? '+' : ''));
    return { bouton, titre: document.querySelector('#fiche-contenu h2').textContent, serie: !!document.querySelector('[data-cx="serie"]'), role: document.querySelector('#cx-role').hidden, grille: z.querySelectorAll('.case-canal').length, cases, clair: !z.querySelector('.avert-clair').hidden, liberer: !z.querySelector('.liberer-canaux').hidden, bouton2: !!document.querySelector('#cx-ecrire') };
  }, info.hote);
  await capture(page, 'passerelle-membre');
  if (/Devenir passerelle/.test(e1.bouton) && /Devenir passerelle/.test(e1.titre) && !e1.serie && e1.role && e1.grille === 8 && e1.cases.join(',') === 'Fr_EMCOM+,ADRASEC43+,Alerte+' && e1.clair && !e1.liberer && e1.bouton2 && !erreurs.length) ok('page d’un membre : « Devenir passerelle », canaux de sa radio et jeux à cocher, avertissement « en clair »');
  else ko('page passerelle : ' + JSON.stringify({ ...e1, erreurs }));
  // Écriture : 3 canaux à ajouter, 5 places libres ; « Perso » (clé privée, précision 13) reste à sa place
  const w1 = await appelP('POST', '/api/passerelle/canaux', { hote: info.hote, ajouter: (adr.canaux.map((c) => ({ portee: 'adrasec:43', id: c.id }))).concat([{ portee: 'carte', id: vueP.j.jeux.find((x) => x.portee === 'carte').canaux[0].id }]) });
  const noms = radio.canaux.map((c) => (c.role ? (c.settings && c.settings.name) || '' : '-'));
  const k3 = radio.canaux.find((c) => c.settings && c.settings.name === 'ADRASEC43');
  const versLui = radio.ordres.every((o) => o.vers === 0x11223344);
  // Radio pleine : il faut libérer ; refus clair puis écriture avec un emplacement libéré
  const autre = (await appelA('PUT', '/api/jeux-canaux/carte', { canaux: [{ nom: 'Fr_EMCOM', cle: '' , id: vueP.j.jeux.find((x) => x.portee === 'carte').canaux[0].id }, { nom: 'C6', cle: 'publique' }, { nom: 'C7', cle: 'publique' }, { nom: 'C8', cle: 'aleatoire' }] })).j;
  const ids = (nm) => autre.canaux.filter((c) => nm.includes(c.nom)).map((c) => ({ portee: 'carte', id: c.id }));
  const plein = await appelP('POST', '/api/passerelle/canaux', { hote: info.hote, ajouter: ids(['C6', 'C7', 'C8']) });
  const libere = await appelP('POST', '/api/passerelle/canaux', { hote: info.hote, ajouter: ids(['C6', 'C7', 'C8']), liberer: [1] });
  const noms2 = radio.canaux.map((c) => (c.role ? (c.settings && c.settings.name) || '' : '-'));
  const perso = radio.canaux.find((c) => c.settings && c.settings.name === 'Perso');
  const autreCompte = await appelA('POST', '/api/passerelle/canaux', { hote: 'agent-inconnu', ajouter: ids(['C6']) });
  if (w1.statut === 200 && noms.join(',') === ',Fr_Balise,Perso,ADRASEC43,Alerte,Fr_EMCOM,-,-' && k3 && Buffer.from(k3.settings.psk).length === 32 && k3.settings.moduleSettings.positionPrecision === 32 && versLui && radio.ordres[0].a === 'beginEditSettings'
    && plein.statut === 400 && /libérez encore 1/.test(plein.j.erreur) && libere.statut === 200 && noms2.join(',') === ',Perso,ADRASEC43,Alerte,Fr_EMCOM,C6,C7,C8' && perso.settings.moduleSettings.positionPrecision === 13 && Buffer.from(perso.settings.psk).equals(Buffer.alloc(32, 7)) && autreCompte.statut === 400)
    ok('canaux écrits sur la radio du membre : ajout, clé ADRASEC privée, place libérée sur demande, canal gardé déplacé intact, relecture');
  else ko('écriture des canaux : ' + JSON.stringify({ w1, noms, k3: !!k3, versLui, ordre0: radio.ordres[0], plein, libere: libere.statut, noms2, autre: autreCompte.statut }).slice(0, 700));
  // Coupure par l'administrateur : la passerelle ne peut plus se relier (12 h)
  await appelA('DELETE', '/api/ecoutes', { hote: info.hote, port: 1 });
  await new Promise((r) => setTimeout(r, 500));
  const apres = (await appelP('GET', '/api/passerelle/miennes')).j;
  const ws2 = await new Promise((r) => { const w = new WebSocket(BASE.replace('http', 'ws') + '/ws/module?nom=Radio%20USB', { headers: { Cookie: cookieP } }); w.on('open', () => { w.close(); r('ouverte'); }); w.on('unexpected-response', () => r('refusée')); w.on('error', () => r('refusée')); });
  if (ws.readyState !== 1 && ws2 === 'refusée' && /coupée par un administrateur/.test(apres.refus || '')) ok('passerelle coupée par l’administrateur : refusée ensuite, motif affiché au membre'); else ko('coupure passerelle : ' + JSON.stringify({ etat: ws.readyState, ws2, refus: apres.refus }));
  try { ws.close(); } catch { /* déjà */ }
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

// Recherche dans les messages : droits (visiteur, démonstration, administrateur), champ, surlignage, clic = message
// affiché à sa place dans son canal ; téléphone : résultats lisibles
async function essaiRechercheMessages(navig, cookie) {
  console.log('Recherche dans les messages');
  // Messages écrits directement dans la base de la carte : les déclencheurs SQLite tiennent l'index à jour
  const Database = require('better-sqlite3');
  const db = new Database(path.join(donnees, 'carte-live.db'));
  db.pragma('busy_timeout = 5000');
  const h = Date.now() - 600000;
  // Jamais INSERT OR REPLACE sur « noeuds » : l'index des noms (déclencheurs) ne verrait pas la suppression
  db.prepare('INSERT INTO noeuds (num, id, nom_long, nom_court, premier_vu, dernier_vu) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(num) DO UPDATE SET nom_long = excluded.nom_long, nom_court = excluded.nom_court').run(0x5a1e0042, '!5a1e0042', 'Olivier F4GLD', 'GLD', h, h);
  const ins = db.prepare("INSERT INTO paquets (id_paquet, de, vers, canal, port, heure, texte) VALUES (?, ?, ?, ?, 'texte', ?, ?)");
  ins.run(900001, 0x5a1e0042, 0xffffffff, 'LongFast', h, 'Bonjour depuis le Mézenc');
  ins.run(900002, 0x5a1e0043, 0xffffffff, 'LongFast', h + 1000, 'Qui a vu mon CHAPEAU ?');
  ins.run(900003, 0x5a1e0043, 0xffffffff, 'Equipe', h + 2000, 'Chapeau rangé au local');
  ins.run(900004, 0x5a1e0043, 0x5a1e0042, 'LongFast', h + 3000, 'Message direct pour Olivier');
  db.close();
  const appel = async (url, entetes = {}) => { const r = await fetch(BASE + url, { headers: entetes }); return { statut: r.status, j: await r.json().catch(() => ({})) }; };
  const anonyme = await appel('/api/messages/recherche?q=chapeau');
  const demo = await appel('/api/messages/recherche?q=chapeau', { 'X-Demo': '1' });
  const demoNom = await appel('/api/messages/recherche?q=f4gld', { 'X-Demo': '1' });
  const admin = await appel('/api/messages/recherche?q=chap%C3%A9au', { Cookie: `${cookie.name}=${cookie.value}` });
  const adminNom = await appel('/api/messages/recherche?q=F4GLD', { Cookie: `${cookie.name}=${cookie.value}` });
  const textes = (x) => (x.j.resultats || []).map((m) => m.texte);
  if (anonyme.statut === 401) ok('recherche : refusée à un visiteur non connecté'); else ko('recherche visiteur : ' + anonyme.statut);
  // Démonstration : la référence d'un résultat n'est pas masquée (champ « ref », pas « cle »), le clic ouvre le bon message
  if (demo.statut === 200 && (demo.j.resultats || []).every((m) => /^mt\d+$/.test(m.ref) && !('cle' in m))) ok('recherche (démonstration) : référence « ref » lisible, pas de champ masqué'); else ko('recherche démonstration ref : ' + JSON.stringify((demo.j.resultats || []).map((m) => [m.ref, m.cle])));
  // Débit : 10 recherches par minute en démonstration, puis 429
  let refus = 0, message = '';
  for (let k = 0; k < 12; k++) { const r = await appel('/api/messages/recherche?q=chapeau' + k, { 'X-Demo': '1' }); if (r.statut === 429) { refus++; message = r.j.erreur; } }
  const membre = await appel('/api/messages/recherche?q=chapeau', { Cookie: `${cookie.name}=${cookie.value}` });
  if (refus === 4 && /une minute/.test(message) && membre.statut === 200) ok('recherche : 10 par minute en démonstration (4 refus sur 12 après les 2 premières), membre connecté non bloqué'); else ko(`recherche : limite de débit, refus = ${refus}, membre ${membre.statut}`);
  if (demo.statut === 200 && JSON.stringify(textes(demo)) === JSON.stringify(['Qui a vu mon CHAPEAU ?']) && JSON.stringify(textes(demoNom)) === JSON.stringify(['Bonjour depuis le Mézenc'])) ok('recherche (démonstration) : canaux publics seulement, jamais les messages directs');
  else ko('recherche démonstration : ' + JSON.stringify([demo.statut, textes(demo), textes(demoNom)]));
  if (JSON.stringify(textes(admin)) === JSON.stringify(['Chapeau rangé au local', 'Qui a vu mon CHAPEAU ?']) && JSON.stringify(textes(adminNom)) === JSON.stringify(['Message direct pour Olivier', 'Bonjour depuis le Mézenc'])) ok('recherche (administrateur) : accents ignorés, tous canaux, expéditeur et destinataire par leur nom');
  else ko('recherche administrateur : ' + JSON.stringify([textes(admin), textes(adminNom)]));
  // Dans la page : champ, résultats surlignés, clic = message repéré dans son canal
  for (const [nom, vue] of [['ordinateur', { width: 1400, height: 900 }], ['téléphone', { width: 390, height: 844 }]]) {
    const contexte = await navig.newContext({ viewport: vue, locale: 'fr-FR', hasTouch: nom === 'téléphone', isMobile: nom === 'téléphone' });
    await contexte.addCookies([cookie]);
    await contexte.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); localStorage.removeItem('filtreMessages'); } catch { /* */ } });
    const { page, erreurs } = await ouvrir(contexte, '/');
    await page.evaluate(() => allerGroupe('messages'));
    await page.waitForTimeout(500);
    await page.fill('#recherche-messages', 'chapeau');
    await page.waitForSelector('#resultats-recherche .resultat-recherche', { timeout: 5000 }).catch(() => {});
    const r = await page.evaluate(() => ({
      n: document.querySelectorAll('#resultats-recherche .resultat-recherche').length,
      marques: [...document.querySelectorAll('#resultats-recherche mark')].map((m) => m.textContent),
      listeCachee: getComputedStyle(document.querySelector('#messages')).display === 'none',
      large: document.documentElement.scrollWidth <= innerWidth + 1,
    }));
    if (r.n === 2 && r.marques.includes('CHAPEAU') && r.marques.includes('Chapeau') && r.listeCachee && r.large) ok(`recherche (${nom}) : 2 résultats, terme surligné, liste remplacée`); else ko(`recherche (${nom}) : ` + JSON.stringify(r));
    await capture(page, 'recherche-messages-' + (nom === 'téléphone' ? 'telephone' : 'ordinateur'));
    if (nom === 'ordinateur') {
      await page.click('#resultats-recherche .resultat-recherche:nth-child(3) .texte'); // 2e résultat : LongFast
      await page.waitForSelector('#messages .message.repere', { timeout: 5000 }).catch(() => {});
      const c = await page.evaluate(() => ({ filtre: filtreMessages, repere: (document.querySelector('#messages .message.repere .texte') || {}).textContent, visible: getComputedStyle(document.querySelector('#messages')).display !== 'none' }));
      if (c.filtre === 'c:LongFast' && c.repere === 'Qui a vu mon CHAPEAU ?' && c.visible) ok('recherche : clic = message repéré dans son canal'); else ko('recherche clic : ' + JSON.stringify(c));
      // Le nom de l'expéditeur suffit ; Échap efface et rend la liste
      await page.fill('#recherche-messages', 'gld');
      await page.waitForFunction(() => [...document.querySelectorAll('#resultats-recherche mark')].some((m) => m.textContent === 'GLD'), null, { timeout: 5000 }).catch(() => {});
      const parNom = await page.evaluate(() => [...document.querySelectorAll('#resultats-recherche .resultat-recherche .texte')].map((x) => x.textContent));
      await page.press('#recherche-messages', 'Escape');
      const apres = await page.evaluate(() => ({ champ: $('#recherche-messages').value, cache: $('#resultats-recherche').hidden }));
      if (JSON.stringify(parNom) === JSON.stringify(['Message direct pour Olivier', 'Bonjour depuis le Mézenc']) && apres.champ === '' && apres.cache) ok('recherche : par nom court de l’expéditeur, Échap efface'); else ko('recherche par nom : ' + JSON.stringify({ parNom, apres }));
    }
    bilanErreurs(erreurs, 'recherche (' + nom + ')');
    await contexte.close();
  }
}

// Secteurs d'alerte et mode urgence : secteur dessiné à la souris, bascule urgence (bandeau, carte, tableau de crise), retour normal
async function essaiUrgenceEtSecteurs(navig, cookie) {
  console.log('Secteurs d’alerte et mode urgence');
  const H = { 'Content-Type': 'application/json', Cookie: `${cookie.name}=${cookie.value}` };
  const appel = async (m, url, b, h = H) => { const r = await fetch(BASE + url, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }); return { statut: r.status, j: await r.json().catch(() => ({})) }; };
  const ctx = await navig.newContext({ viewport: { width: 1400, height: 900 }, locale: 'fr-FR' });
  await ctx.addCookies([cookie]);
  await ctx.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  const { page, erreurs } = await ouvrir(ctx, '/');
  // Secteur : polygone dessiné sur la carte puis créé
  await page.evaluate(() => ficheSecteurs()); await page.waitForTimeout(1200);
  await page.locator('.nouveau-sa [data-poly]').click();
  for (const [x, y] of [[520, 320], [820, 330], [780, 600], [500, 580]]) { await page.mouse.click(x, y); await page.waitForTimeout(120); }
  await page.locator('#barre-dessin [data-finir]').click();
  await page.locator('.nouveau-sa [data-c="nom"]').fill('Secteur essai');
  await page.locator('.nouveau-sa [data-c="noeuds"]').fill('!5a1e0001');
  await page.locator('.nouveau-sa [data-creer]').click(); await page.waitForTimeout(1200);
  const l = await appel('GET', '/api/secteurs');
  const sec = (l.j.secteurs || []).find((x) => x.nom === 'Secteur essai');
  if (sec && sec.forme === 'polygone' && sec.points.length === 4 && sec.membres.length === 1) ok('secteur dessiné à la souris et créé'); else ko('secteur : ' + JSON.stringify(l.j).slice(0, 200));
  if (await page.locator('.leaflet-secteurs-pane path').count()) ok('secteur tracé sur la carte'); else ko('secteur absent de la carte');
  const pub = await appel('GET', '/api/secteurs', null, {});
  if (pub.statut === 401) ok('secteurs refusés au public'); else ko('secteurs lisibles sans compte : ' + pub.statut);
  // Fuites vers les visiteurs (I4) : équipe avec une position de membre et un secteur ; anonyme → 401 ; démonstration → vidé
  const eq = await appel('POST', '/api/equipes', { nom: 'EssaiEq', positions: true });
  if (eq.statut === 200) {
    await appel('POST', '/api/equipes/' + eq.j.id + '/membres', { ajouter: [0x5a1e0042], insister: false }).catch(() => {});
    const anonEq = await appel('GET', '/api/equipes', null, {});
    const demoEq = await appel('GET', '/api/equipes', null, { 'X-Demo': '1' });
    const adminEq = await appel('GET', '/api/equipes');
    const e1 = (demoEq.j.equipes || []).find((x) => x.nom === 'EssaiEq') || {};
    const vide = e1 && (e1.sos || []).length === 0 && (e1.secteurs || []).length === 0 && !e1.zone && (e1.membres || []).every((m) => m.position == null);
    if (anonEq.statut === 401 && demoEq.statut === 200 && vide && adminEq.statut === 200) ok('équipes : 401 pour un anonyme ; en démonstration, ni demandes d’aide, ni positions, ni secteurs'); else ko('fuite équipes : ' + JSON.stringify({ anon: anonEq.statut, demo: demoEq.statut, e1 }).slice(0, 300));
    await appel('DELETE', '/api/equipes/' + eq.j.id, { retirerDesNoeuds: false });
  } else ko('création d’équipe pour l’essai : ' + JSON.stringify(eq.j));
  const rapAnon = await fetch(BASE + '/rapport');
  const rapDemo = await fetch(BASE + '/rapport', { headers: { 'X-Demo': '1' } });
  const rapDemoTexte = await rapDemo.text();
  if (rapAnon.status === 401 && rapDemo.status === 200 && !/Secteur essai/.test(rapDemoTexte)) ok('rapport : 401 pour un anonyme, sans alerte de secteur en démonstration'); else ko('rapport : ' + JSON.stringify({ anon: rapAnon.status, demo: rapDemo.status, secteur: /Secteur essai/.test(rapDemoTexte) }));
  // Mode urgence : activé (bandeau, carte en crise, tableau), puis terminé
  const a = await appel('POST', '/api/urgence', { actif: true, motif: 'Essai automatique' });
  await page.waitForTimeout(1500);
  const enCrise = await page.evaluate(() => ({ classe: document.body.classList.contains('mode-urgence'), bandeau: (document.querySelector('#bandeau-urgence') || {}).textContent || '' }));
  if (a.statut === 200 && enCrise.classe && /URGENCE/.test(enCrise.bandeau) && /Essai automatique/.test(enCrise.bandeau)) ok('mode urgence : bandeau et carte en crise reçus en direct'); else ko('mode urgence activé : ' + JSON.stringify({ a, enCrise }));
  await page.locator('#bandeau-urgence').click(); await page.waitForTimeout(1200);
  const tableau = await page.locator('#fiche-contenu').innerText().catch(() => '');
  if (/Tableau de crise/.test(tableau) && /Mode urgence activé par/.test(tableau)) ok('tableau de crise et journal'); else ko('tableau de crise : ' + tableau.slice(0, 160));
  await capture(page, 'mode-urgence');
  const deux = await appel('POST', '/api/urgence', { actif: true });
  if (deux.statut === 400) ok('double activation refusée'); else ko('double activation : ' + deux.statut);
  // Gestionnaire : lit le tableau de crise et note au journal, mais n'active ni ne termine le mode urgence
  await appel('POST', '/api/comptes', { identifiant: 'Gilles gestion', motDePasse: 'Essai-gilles-2026!!', role: 'gestionnaire' });
  const cx = await fetch(BASE + '/api/connexion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiant: 'Gilles gestion', motDePasse: 'Essai-gilles-2026!!' }) });
  const HG = { 'Content-Type': 'application/json', Cookie: (cx.headers.get('set-cookie') || '').split(';')[0] };
  const finG = await appel('POST', '/api/urgence', { actif: false }, HG);
  const lectureG = await appel('GET', '/api/urgence', null, HG);
  const noteG = await appel('POST', '/api/urgence/note', { texte: 'Note du gestionnaire' }, HG);
  if (finG.statut === 403 && lectureG.statut === 200 && lectureG.j.actif && lectureG.j.tableau && noteG.statut === 200) ok('gestionnaire : 403 pour terminer, tableau lisible, note acceptée'); else ko('gestionnaire : ' + JSON.stringify({ fin: finG.statut, lecture: lectureG.statut, note: noteG.statut }));
  const f = await appel('POST', '/api/urgence', { actif: false });
  const actG = await appel('POST', '/api/urgence', { actif: true }, HG);
  if (actG.statut === 403) ok('gestionnaire : 403 pour activer le mode urgence'); else ko('gestionnaire active le mode urgence : ' + actG.statut);
  await page.waitForTimeout(1500);
  const apres = await page.evaluate(() => ({ classe: document.body.classList.contains('mode-urgence'), bandeau: !!document.querySelector('#bandeau-urgence') }));
  if (f.statut === 200 && !apres.classe && !apres.bandeau) ok('mode urgence terminé : affichage habituel'); else ko('fin du mode urgence : ' + JSON.stringify({ f: f.statut, apres }));
  const csv = await fetch(BASE + '/api/urgence/journal.csv?crise=' + (f.j.derniere || {}).id, { headers: H });
  if (csv.status === 200 && /heure_utc;heure_locale;type/.test(await csv.text())) ok('journal de crise exporté (CSV)'); else ko('export du journal de crise : ' + csv.status);
  await appel('DELETE', '/api/secteurs/' + (sec ? sec.id : 'x'));
  bilanErreurs(erreurs, 'secteurs et urgence');
  await ctx.close();
}

// Bandeau « Switch to the world map » : visiteurs étrangers seulement, sans chevaucher la barre, la recherche,
// les outils, le panneau, la légende ni les boutons de la carte ; fermeture mémorisée
async function essaiBandeauMonde(navig, cookie) {
  console.log('Bandeau « carte monde » (visiteurs étrangers)');
  // Rectangles du bandeau et des éléments à ne pas couvrir, puis liste de ceux qui le croisent
  const mesurer = (page, selecteurs) => page.evaluate((sel) => {
    const e = document.getElementById('bandeau-monde');
    if (!e) return { present: false };
    const r = e.getBoundingClientRect();
    const croise = (x, y) => x.left < y.right && y.left < x.right && x.top < y.bottom && y.top < x.bottom;
    const chevauche = [];
    for (const q of sel) document.querySelectorAll(q).forEach((o) => { const b = o.getBoundingClientRect(); if (b.width && b.height && getComputedStyle(o).visibility !== 'hidden' && croise(r, b)) chevauche.push(q); });
    const a = e.querySelector('.bm-ouvrir');
    return { present: true, visible: !e.classList.contains('cache') && r.width > 0, dedans: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      titre: (e.querySelector('b') || {}).textContent, bouton: a && a.textContent, href: a && a.getAttribute('href'), cible: a && a.getAttribute('target'), rel: a && a.getAttribute('rel'), croix: !!e.querySelector('.bm-fermer'), chevauche, place: e.dataset.place, largeur: Math.round(r.width), texteLarge: Math.round(e.querySelector('.bm-texte').getBoundingClientRect().width) };
  }, selecteurs);
  const CARTE = ['.barre', '.outils', '.recherche-lieu', '.panneau', '.legende', '.leaflet-control', '.deplier'];
  const attendre = (page) => page.waitForFunction(() => { const e = document.getElementById('bandeau-monde'); return e && !e.classList.contains('cache'); }, null, { timeout: 6000 }).catch(() => {});

  // Navigateur en français : jamais de bandeau
  let ctx = await navig.newContext({ viewport: { width: 1366, height: 800 }, locale: 'fr-FR' });
  await ctx.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); } catch { /* */ } });
  let { page, erreurs } = await ouvrir(ctx, '/');
  await page.waitForTimeout(1800);
  if (!(await mesurer(page, [])).present) ok('navigateur en français : pas de bandeau'); else ko('navigateur en français : bandeau affiché');
  await ctx.close();

  // Ordinateur, navigateur en anglais : bandeau, lien réglé, rien de recouvert ; la croix le ferme pour de bon
  ctx = await navig.newContext({ viewport: { width: 1366, height: 800 }, locale: 'en-US' });
  await ctx.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); } catch { /* */ } });
  ({ page, erreurs } = await ouvrir(ctx, '/'));
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  await attendre(page);
  let m = await mesurer(page, CARTE);
  if (m.visible && m.dedans && m.titre === 'Switch to the world map' && m.bouton === 'Open the world map' && m.href === 'https://monde.essai/carte' && m.cible === '_blank' && m.rel === 'noopener' && m.croix) ok('ordinateur en anglais : bandeau « Switch to the world map » et bouton vers la carte monde réglée (nouvel onglet)');
  else ko('ordinateur en anglais : bandeau ' + JSON.stringify(m));
  if (m.visible && !m.chevauche.length) ok(`ordinateur : bandeau (${m.place}) sans chevauchement de la barre, des outils, de la recherche, du panneau ni de la légende`); else ko('ordinateur : bandeau chevauche ' + JSON.stringify(m.chevauche));
  // Lisible : pas de texte écrasé en colonne étroite
  if (m.largeur >= 400 && m.texteLarge >= 200) ok(`ordinateur : bandeau lisible (${m.largeur} px, texte ${m.texteLarge} px)`); else ko(`ordinateur : bandeau trop étroit ${m.largeur} px, texte ${m.texteLarge} px`);
  await capture(page, 'bandeau-monde-ordinateur');
  await page.click('#bandeau-monde .bm-fermer');
  const ferme = await page.evaluate(() => ({ parti: !document.getElementById('bandeau-monde'), memo: localStorage.getItem('gaulix_bandeau_monde_ferme') }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  if (ferme.parti && ferme.memo === '1' && !(await mesurer(page, [])).present) ok('croix : bandeau fermé et pas revenu après rechargement'); else ko('croix : ' + JSON.stringify(ferme));
  bilanErreurs(erreurs, 'bandeau carte monde (ordinateur)');
  await ctx.close();

  // Téléphone en anglais : bandeau visible sans toucher la barre du haut, la recherche, les boutons ni le tiroir
  ctx = await navig.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en-GB' });
  await ctx.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); } catch { /* */ } });
  ({ page, erreurs } = await ouvrir(ctx, '/'));
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  await attendre(page);
  m = await mesurer(page, CARTE);
  if (m.visible && m.dedans && !m.chevauche.length) ok(`téléphone : bandeau (${m.place}) sans chevauchement de la barre du haut, de la recherche, des outils, du tiroir ni des boutons`);
  else ko('téléphone : bandeau ' + JSON.stringify(m));
  await capture(page, 'bandeau-monde-telephone');
  // Tablette en paysage
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.waitForTimeout(2200);
  m = await mesurer(page, CARTE);
  if (!m.visible || (m.dedans && !m.chevauche.length)) ok('tablette : bandeau sans chevauchement (ou effacé faute de place)'); else ko('tablette : bandeau chevauche ' + JSON.stringify(m.chevauche));
  bilanErreurs(erreurs, 'bandeau carte monde (téléphone)');
  await ctx.close();

  // Page publique, navigateur en allemand : texte anglais intact (pas traduit), rien de recouvert
  ctx = await navig.newContext({ viewport: { width: 1280, height: 800 }, locale: 'de-DE' });
  ({ page, erreurs } = await ouvrir(ctx, '/publique.html'));
  await attendre(page);
  m = await mesurer(page, ['.bandeau', '.legende', '.leaflet-control']);
  if (m.visible && m.titre === 'Switch to the world map' && !m.chevauche.length) ok('page publique (allemand) : bandeau en anglais, sans chevauchement'); else ko('page publique : bandeau ' + JSON.stringify(m));
  await capture(page, 'bandeau-monde-publique');
  bilanErreurs(erreurs, 'bandeau carte monde (page publique)');
  await ctx.close();

  // Installation qui ne l'a pas activé : rien ; adresse par défaut (GitHub) : bouton honnête
  for (const [bm, attendu] of [[null, null], [{ url: 'https://github.com/sauveteur71/live-mesh-map-world' }, 'See the world edition']]) {
    ctx = await navig.newContext({ viewport: { width: 1366, height: 800 }, locale: 'en-US' });
    await ctx.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); } catch { /* */ } });
    await ctx.route('**/api/config', async (r) => { const rep = await r.fetch(); const j = await rep.json(); j.bandeauMonde = bm; await r.fulfill({ response: rep, json: j }); });
    ({ page } = await ouvrir(ctx, '/'));
    await page.waitForTimeout(1800);
    m = await mesurer(page, []);
    if (bm === null) { if (!m.present) ok('bandeau non activé par l’installation : rien ne s’affiche'); else ko('bandeau affiché alors qu’il est désactivé'); }
    else if (m.bouton === attendu) ok('adresse GitHub par défaut : bouton « See the world edition »'); else ko('adresse GitHub : bouton ' + m.bouton);
    await ctx.close();
  }
  // Réglage avancé : adresse autre que http(s) refusée par le serveur (sans rien enregistrer)
  const r = await fetch(BASE + '/api/reglages/variables', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `${cookie.name}=${cookie.value}` }, body: JSON.stringify({ variables: { BANDEAU_MONDE_URL: 'javascript:alert(1)' } }) });
  const t = await r.json().catch(() => ({}));
  if (r.status === 400 && /http/.test(t.erreur || '')) ok('réglage : adresse de la carte monde non http(s) refusée'); else ko(`réglage : adresse refusée attendue, reçu ${r.status} ${JSON.stringify(t)}`);
}

// Mur des donateurs : un don saisi par l'administrateur → bandeau visible sur la carte et sur la page publique,
// sans recouvrir la barre du haut, la recherche, le panneau, la légende ni les boutons ; croix = fermé ; caché en urgence
async function essaiPartager(navig, cookie) {
  console.log('Panneau « Carte publique et exports » (téléphone, administrateur)');
  const contexte = await navig.newContext({ viewport: { width: 390, height: 844 }, locale: 'fr-FR', isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await contexte.addCookies([cookie]);
  await contexte.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  const { page, erreurs } = await ouvrir(contexte, '/');
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  await page.evaluate(() => fichePartager());
  await page.waitForFunction(() => !/Chargement…/.test(document.querySelector('#donateurs-reglages') ? document.querySelector('#donateurs-reglages').textContent : ''), null, { timeout: 8000 }).catch(() => {});
  const m = await page.evaluate(() => {
    const liens = [...document.querySelectorAll('#fiche-contenu .ligne.sans-pastille .titre a')].map((a) => ({ texte: a.textContent.trim(), largeur: Math.round(a.getBoundingClientRect().width), tronque: a.scrollWidth > a.clientWidth + 1 }));
    const z = document.querySelector('#donateurs-reglages');
    return { liens, donateurs: z ? z.textContent.slice(0, 60) : null };
  });
  const coupes = m.liens.filter((l) => l.tronque || l.largeur < 60);
  if (m.liens.length >= 7 && !coupes.length) ok('liens d’export : libellés entiers (' + m.liens.length + ' lignes, pas de texte coupé)'); else ko('liens d’export coupés : ' + JSON.stringify(coupes.length ? coupes : m.liens));
  if (m.donateurs && !/^\s*Chargement/.test(m.donateurs)) ok('mur des donateurs : réglages chargés'); else ko('mur des donateurs : toujours « Chargement… » : ' + m.donateurs);
  await capture(page, 'partager-telephone');
  if (erreurs.length) ko('panneau Partager : ' + erreurs.join(' | ')); else ok('panneau Partager : aucune erreur JavaScript');
  await contexte.close();
}

async function essaiDonateurs(navig, cookie) {
  console.log('Mur des donateurs');
  const entetes = { 'Content-Type': 'application/json', Cookie: `${cookie.name}=${cookie.value}` };
  const poster = (url, corps) => fetch(BASE + url, { method: 'POST', headers: entetes, body: JSON.stringify(corps) });
  let r = await poster('/api/donateurs/manuel', { nom: '42BARBE', pays: 'FR', montant: 20, accord: true });
  const ajout = await r.json().catch(() => ({}));
  if (r.ok && ajout.id) ok('don manuel ajouté par l’API admin'); else ko('don manuel : ' + r.status + ' ' + JSON.stringify(ajout));
  r = await poster('/api/donateurs/manuel', { nom: 'Sans accord', accord: false });
  if (r.status === 400) ok('don sans accord refusé'); else ko('don sans accord : ' + r.status);
  r = await poster('/api/donateurs/manuel', { nom: 'Pays faux', pays: 'France', accord: true });
  if (r.status === 400) ok('pays autre qu’un code à 2 lettres refusé'); else ko('pays faux : ' + r.status);
  // Liens « Faire un don » : seulement quand la source est activée, tirés des réglages
  await poster('/api/donateurs/reglages', { helloasso: { actif: true, organisation: 'asso-essai', formulaire: 'form-1' }, githubSponsors: { actif: false } });
  const pub = await (await fetch(BASE + '/api/donateurs')).json();
  const nomsOk = (pub.liste || []).length === 1 && pub.liste[0].nom === '42BARBE' && pub.liste[0].montant == null && !('date' in pub.liste[0]);
  if (nomsOk) ok('liste publique : nom HelloAsso tel que saisi (42BARBE), montant masqué, pas de date'); else ko('liste publique : ' + JSON.stringify(pub));
  if (pub.liens && pub.liens.helloasso === 'https://www.helloasso.com/associations/asso-essai/formulaires/form-1' && pub.liens.github === null) ok('liens tirés des réglages, GitHub absent (source désactivée)'); else ko('liens : ' + JSON.stringify(pub.liens));
  // Journal d'audit : le nom du donateur n'y figure pas
  const audit = await (await fetch(BASE + '/api/audit', { headers: entetes })).json().catch(() => []);
  const lignes = JSON.stringify(audit);
  if (/donateurs\/manuel/.test(lignes) && !/42BARBE/.test(lignes)) ok('journal d’audit : action notée sans le nom du donateur'); else ko('journal d’audit : ' + lignes.slice(0, 300));
  // Rectangle du bandeau et chevauchements avec les éléments à ne pas couvrir
  const mesurer = (page, selecteurs) => page.evaluate((sel) => {
    const e = document.getElementById('bandeau-donateurs');
    if (!e) return { present: false };
    const r = e.getBoundingClientRect();
    const croise = (x, y) => x.left < y.right && y.left < x.right && x.top < y.bottom && y.top < x.bottom;
    const chevauche = [];
    for (const q of sel) document.querySelectorAll(q).forEach((o) => { const b = o.getBoundingClientRect(); if (b.width && b.height && getComputedStyle(o).visibility !== 'hidden' && getComputedStyle(o).display !== 'none' && croise(r, b)) chevauche.push(q); });
    const liens = [...e.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]);
    return { present: true, visible: getComputedStyle(e).display !== 'none' && r.width > 0, dedans: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      texte: (e.querySelector('.don-texte') || {}).textContent, liens, croix: !!e.querySelector('.fermer-bandeau'), chevauche, largeur: Math.round(r.width), style: getComputedStyle(e).position };
  }, selecteurs);
  const attendre = (page) => page.waitForFunction(() => { const e = document.getElementById('bandeau-donateurs'); return e && (e.querySelector('.don-texte') || {}).textContent; }, null, { timeout: 8000 }).catch(() => {});
  const CARTE = ['.barre', '.outils', '.recherche-lieu', '.panneau', '.legende', '.leaflet-control', '.deplier', '.bandeau-urgence', '.bandeau-crise'];
  for (const [nom, vue, mobile] of [['ordinateur', { width: 1400, height: 900 }, false], ['téléphone', { width: 390, height: 844 }, true], ['tablette', { width: 1024, height: 700 }, false]]) {
    const ctx = await navig.newContext({ viewport: vue, locale: 'fr-FR', isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
    await ctx.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
    const { page, erreurs } = await ouvrir(ctx, '/');
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await attendre(page);
    const m = await mesurer(page, CARTE);
    if (m.visible && m.dedans && /42BARBE 🇫🇷 a donné pour soutenir le projet/.test(m.texte || '') && m.croix) ok(`${nom} : bandeau des donateurs visible (« ${m.texte} »)`); else ko(`${nom} : bandeau ` + JSON.stringify(m));
    if (m.visible && !m.chevauche.length) ok(`${nom} : bandeau sans chevauchement de la barre du haut, de la recherche, du panneau, de la légende ni des boutons`); else ko(`${nom} : bandeau chevauche ` + JSON.stringify(m.chevauche));
    if (nom === 'ordinateur') {
      if (m.liens.length === 1 && m.liens[0][0] === 'Faire un don' && m.liens[0][1] === 'https://www.helloasso.com/associations/asso-essai/formulaires/form-1' && m.liens[0][2] === '_blank' && m.liens[0][3] === 'noopener') ok('ordinateur : lien « Faire un don » des réglages, nouvel onglet, pas de lien GitHub'); else ko('ordinateur : liens ' + JSON.stringify(m.liens));
      // Mode urgence : le bandeau s'efface
      await page.evaluate(() => document.body.classList.add('mode-urgence'));
      const u = await mesurer(page, []);
      if (!u.visible) ok('ordinateur : bandeau caché en mode urgence'); else ko('ordinateur : bandeau visible en mode urgence');
      await page.evaluate(() => document.body.classList.remove('mode-urgence'));
    }
    await capture(page, 'donateurs-' + nom.normalize('NFD').replace(/[^a-z]/g, ''));
    if (nom === 'téléphone') {
      await page.click('#bandeau-donateurs .fermer-bandeau');
      const ferme = await page.evaluate(() => ({ parti: !document.getElementById('bandeau-donateurs'), memo: localStorage.getItem('gaulix_donateurs_masque') }));
      if (ferme.parti && ferme.memo === '1') ok('téléphone : croix = bandeau fermé et mémorisé'); else ko('téléphone : croix ' + JSON.stringify(ferme));
    }
    bilanErreurs(erreurs, 'donateurs (' + nom + ')');
    await ctx.close();
  }
  // Page publique (sans style.css) : le bandeau a son style, en bas, sans toucher le bandeau du haut ni la légende
  for (const [nom, vue] of [['ordinateur', { width: 1280, height: 800 }], ['téléphone', { width: 390, height: 844 }]]) {
    const ctx = await navig.newContext({ viewport: vue, locale: 'fr-FR', isMobile: nom === 'téléphone', hasTouch: nom === 'téléphone' });
    const { page, erreurs } = await ouvrir(ctx, '/publique.html');
    await attendre(page);
    const m = await mesurer(page, ['.bandeau', '.legende', '.leaflet-control', '#bandeau-monde']);
    if (m.visible && m.dedans && m.style === 'fixed' && m.largeur > 150 && /42BARBE/.test(m.texte || '')) ok(`page publique (${nom}) : bandeau stylé et visible`); else ko(`page publique (${nom}) : bandeau ` + JSON.stringify(m));
    if (m.visible && !m.chevauche.length) ok(`page publique (${nom}) : sans chevauchement`); else ko(`page publique (${nom}) : chevauche ` + JSON.stringify(m.chevauche));
    await capture(page, 'donateurs-publique-' + (nom === 'téléphone' ? 'telephone' : 'ordinateur'));
    if (nom === 'ordinateur') {
      await page.click('#bandeau-donateurs .fermer-bandeau');
      if (await page.evaluate(() => !document.getElementById('bandeau-donateurs') && localStorage.getItem('publique_donateurs_masque') === '1')) ok('page publique : croix = bandeau fermé'); else ko('page publique : croix');
    }
    bilanErreurs(erreurs, 'donateurs (page publique, ' + nom + ')');
    await ctx.close();
  }
  // Nettoyage : le don retiré ne pollue pas les autres essais
  await fetch(BASE + '/api/donateurs/manuel/' + ajout.id, { method: 'DELETE', headers: entetes });
  await poster('/api/donateurs/reglages', { helloasso: { actif: false } });
}

// Page Topologie : dans l'onglet Analyse, un clic sur le nom d'un nœud ouvre sa fiche (vue « noeud »).
// Avant, la ligne ne faisait que le sélectionner dans le graphe : rien ne semblait se passer.
async function essaiTopologieFiche(navig) {
  console.log('Topologie : le nom d’un nœud ouvre sa fiche');
  const Database = require('better-sqlite3');
  const db = new Database(path.join(donnees, 'carte-live.db'));
  db.pragma('busy_timeout = 5000');
  const h = Date.now() - 600000;
  // Une passerelle avec position, un relais, et deux nœuds sans position dont une feuille (un seul voisin)
  const noeud = db.prepare('INSERT INTO noeuds (num, id, nom_long, nom_court, role, est_passerelle, lat, lon, premier_vu, dernier_vu) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(num) DO UPDATE SET nom_long = excluded.nom_long, role = excluded.role, lat = excluded.lat, lon = excluded.lon, dernier_vu = excluded.dernier_vu');
  noeud.run(0x7a000001, '!7a000001', 'Passerelle Mézenc', 'PMEZ', 'ROUTER', 1, 44.92, 4.18, h, h);
  noeud.run(0x7a000002, '!7a000002', 'Relais Bouchet', 'BOUC', 'ROUTER', 0, 44.91, 4.19, h, h);
  noeud.run(0x7a000003, '!7a000003', 'Client sans position', 'SPOS', 'CLIENT', 0, null, null, h, h);
  noeud.run(0x7a000004, '!7a000004', 'Feuille isolée', 'FEUI', 'CLIENT', 0, null, null, h, h);
  const lien = db.prepare('INSERT INTO liens (a, b, source, snr, nb, premier_vu, dernier_vu) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(a, b, source) DO UPDATE SET dernier_vu = excluded.dernier_vu');
  lien.run(0x7a000001, 0x7a000002, 'rf', 8, 5, h, h);
  lien.run(0x7a000002, 0x7a000001, 'rf', 7, 5, h, h);
  lien.run(0x7a000002, 0x7a000003, 'rf', 5, 3, h, h);
  lien.run(0x7a000003, 0x7a000002, 'rf', 4, 3, h, h);
  lien.run(0x7a000002, 0x7a000004, 'rf', 2, 2, h, h);
  db.close();
  const contexte = await navig.newContext({ viewport: { width: 1280, height: 800 }, locale: 'fr-FR' });
  await contexte.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); } catch { /* */ } });
  const { page, erreurs } = await ouvrir(contexte, '/topologie.html');
  await page.waitForFunction(() => document.querySelectorAll('#vue-analyse [data-fiche]').length > 0, null, { timeout: 15000 }).catch(() => {});
  const nb = await page.locator('#vue-analyse [data-fiche]').count();
  if (nb > 0) ok(`onglet Analyse : ${nb} nom(s) de nœud cliquables`); else ko('onglet Analyse : aucun nom de nœud cliquable (données d’essai absentes ?)');
  if (nb > 0) {
    const attendu = await page.evaluate(() => document.querySelector('#vue-analyse [data-fiche]').textContent.trim());
    const vueAvant = await page.evaluate(() => (document.querySelector('.vue.actif') || {}).id || null);
    await page.locator('#vue-analyse [data-fiche]').first().click();
    await page.waitForTimeout(800);
    const apres = await page.evaluate(() => ({ vue: (document.querySelector('.vue.actif') || {}).id || null, contenu: (document.querySelector('#vue-noeud') || {}).textContent || '' }));
    if (apres.vue === 'vue-noeud') ok('clic sur le nom : la fiche du nœud s’ouvre'); else ko(`clic sur le nom : vue « ${apres.vue} » au lieu de « vue-noeud » (avant : ${vueAvant})`);
    if (apres.contenu.includes(attendu)) ok(`la fiche ouverte est bien celle du nœud cliqué (${attendu})`); else ko(`fiche d’un autre nœud : « ${attendu} » absent de ${apres.contenu.slice(0, 120)}`);
    if (/Ouvrir sur la carte|Simuler/.test(apres.contenu)) ok('fiche renseignée (actions du nœud présentes)'); else ko('fiche vide : ' + apres.contenu.slice(0, 120));
    // La ligne elle-même garde son rôle : sélection sans quitter l'analyse
    await page.evaluate(() => { const b = [...document.querySelectorAll('nav.onglets button')].find((x) => x.dataset.vue === 'analyse'); if (b) b.click(); });
    await page.waitForTimeout(400);
    await page.evaluate(() => { const l = document.querySelector('#vue-analyse .ligne[data-n]'); const e = new MouseEvent('click', { bubbles: true }); l.dispatchEvent(e); });
    await page.waitForTimeout(600);
    const vue2 = await page.evaluate(() => (document.querySelector('.vue.actif') || {}).id || null);
    if (vue2 === 'vue-analyse') ok('clic ailleurs sur la ligne : on reste sur l’analyse'); else ko('clic sur la ligne : vue ' + vue2);
  }
  await capture(page, 'topologie-fiche');
  bilanErreurs(erreurs, 'topologie (fiche du nœud)');
  await contexte.close();
}

// Rapport hebdomadaire : les archives s'affichaient « S.. », le titre étant coincé dans la colonne de pastille
async function essaiRapportArchives(navig, cookie) {
  console.log('Rapport hebdomadaire (archives)');
  const fs2 = require('fs');
  const dossier = path.join(donnees, 'rapports');
  try { fs2.mkdirSync(dossier, { recursive: true }); } catch { /* existe */ }
  for (const nom of ['rapport-2026-11-09.html', 'rapport-2026-11-16.html']) fs2.writeFileSync(path.join(dossier, nom), '<!doctype html><title>Essai</title><p>Rapport d’essai</p>');
  const contexte = await navig.newContext({ viewport: { width: 1280, height: 800 }, locale: 'fr-FR' });
  await contexte.addCookies([cookie]);
  await contexte.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  const { page, erreurs } = await ouvrir(contexte, '/');
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  await page.evaluate(() => { const b = document.querySelector('#outil-rapport'); if (b) b.click(); });
  await page.waitForTimeout(1500);
  const n = await page.locator('#fiche-contenu .ligne > .titre:first-child').count();
  if (n > 0) ok(`archives listées (${n})`); else ko('aucune archive listée (fichiers d’essai non vus ?)');
  // Titres écrasés : une ligne qui commence par son titre ne doit pas le coincer dans la colonne de pastille
  // (« Semaine du 16/11/2026 » s'affichait « S.. » dans les archives du rapport hebdomadaire)
  const etroits = await page.evaluate(() => {
    const l = [];
    document.querySelectorAll('#fiche-contenu .ligne > .titre:first-child').forEach((t) => {
      const r = t.getBoundingClientRect();
      if (r.width > 0 && r.width < 60 && t.textContent.trim().length > 3) l.push({ texte: t.textContent.trim().slice(0, 40), largeur: Math.round(r.width) });
    });
    return l;
  });
  if (!etroits.length) ok('rapport hebdomadaire : titres des archives entiers'); else ko('titres écrasés : ' + JSON.stringify(etroits));
  await capture(page, 'rapport-archives');
  bilanErreurs(erreurs, 'rapport hebdomadaire');
  await contexte.close();
}


// Registre des relais : date du jour proposée, retour au registre en fermant une fiche, recherche libre,
// liste des nœuds d'un département (d'après la position reçue) et modification groupée de l'autorisation.
async function essaiRegistreAvance(navig, cookie) {
  console.log('Registre des relais : dates proposées, retour au registre, recherche, départements, autorisations groupées');
  const H = { 'Content-Type': 'application/json', Cookie: `${cookie.name}=${cookie.value}` };
  const appel = async (m, url, b, h = H) => { const r = await fetch(BASE + url, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }); return { statut: r.status, j: await r.json().catch(() => ({})) }; };
  // Relais écrits directement dans la base : trois en Haute-Loire (43), un dans la Loire (42) mais dans le
  // rectangle de la carte, un sans aucune position, un à Londres (position connue, hors de France).
  const MEZ = 0x43000001, CHD = 0x43000002, MON = 0x43000003, PIL = 0x42000004, SPO = 0x43000005, LDN = 0x44000006;
  const Database = require('better-sqlite3');
  const db = new Database(path.join(donnees, 'carte-live.db'));
  db.pragma('busy_timeout = 5000');
  const vu = Date.now() - 300000;
  const ins = db.prepare('INSERT INTO noeuds (num, id, nom_long, nom_court, role, materiel, firmware, lat, lon, alt, heure_position, premier_vu, dernier_vu) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(num) DO UPDATE SET nom_long = excluded.nom_long, nom_court = excluded.nom_court, role = excluded.role, lat = excluded.lat, lon = excluded.lon');
  for (const [num, nom, court, lat, lon] of [
    [MEZ, '43 Relais Mézenc', 'MEZ', 45.0433, 3.8853], [CHD, '43 Relais Chaise-Dieu', 'CHD', 45.32, 3.69],
    [MON, '43 Relais Monistrol', 'MON', 45.29, 4.17], [PIL, '42 Relais du Pilat', 'PIL', 45.294, 4.4],
    [SPO, '43 Relais sans position', 'SPO', null, null], [LDN, 'London test node', 'LDN', 51.5, -0.12],
  ]) ins.run(num, '!' + num.toString(16).padStart(8, '0'), nom, court, 'ROUTER', 'HELTEC_V3', '2.7.11', lat, lon, lat == null ? null : 1100, lat == null ? null : vu, vu, vu);
  // Nœuds MeshCore : un au Puy-en-Velay (43, position de son annonce), un qui annonce 0, 0 (donc sans position)
  const MC43 = 'C43A' + '0'.repeat(56) + '0001', MC00 = 'C000' + '0'.repeat(56) + '0002';
  const insMc = db.prepare('INSERT OR REPLACE INTO mc_noeuds (cle, nom, role, lat, lon, heure_position, premier_vu, dernier_vu, derniere_annonce, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insMc.run(MC43, 'MC Companion du Puy', 'companion', 45.0434, 3.8855, vu, vu, vu, vu, 'essai');
  insMc.run(MC00, 'MC Sans GPS', 'companion', 0, 0, vu, vu, vu, vu, 'essai');
  db.close();
  // La liste complète des nœuds est gardée 10 s par le serveur : on attend qu'elle contienne les nouveaux relais,
  // sinon la page chargée juste après recevrait l'ancienne liste et ne les verrait pas de la visite entière.
  for (let k = 0; k < 40; k++) {
    const l = await (await fetch(BASE + '/api/noeuds', { headers: H })).json().catch(() => []);
    if (Array.isArray(l) && l.some((n) => (n.num >>> 0) === MEZ)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  // Fiche d'installation de départ : site accentué, propriétaire, notes, hauteur (ne doit jamais être perdue)
  const pose = await appel('PUT', `/api/noeuds/${MEZ}/installation`, { site: 'Château d’eau de Saint-Vincent', proprietaire: 'Commune de Saint-Vincent', contact: 'mairie@exemple.fr', notes: 'Accès par le chemin du stade', hauteur: 8 });
  if (pose.statut !== 200) ko('fiche d’installation de départ : ' + pose.statut);

  // ---- Nœuds rangés par département, d'après la position retransmise
  const idx = await appel('GET', '/api/noeuds-par-departement');
  const anon = (await fetch(BASE + '/api/noeuds-par-departement')).status;
  const pn = idx.j.parNoeud || {}, d43 = (idx.j.departements || []).find((x) => x.code === '43');
  if (idx.statut === 200 && pn[String(MEZ)] === '43' && pn[String(MON)] === '43' && pn[String(PIL)] === '42'
    && (idx.j.sansPosition || []).includes(SPO) && (idx.j.horsDepartements || []).includes(LDN)
    && d43 && d43.nom === 'Haute-Loire' && d43.nb >= 3 && anon === 401) ok(`départements des nœuds : 43 (${d43.nb}), 42 pour le Pilat, sans position et hors de France à part, refusé sans compte`);
  else ko('départements des nœuds : ' + JSON.stringify({ statut: idx.statut, anon, d43, mez: pn[String(MEZ)], pil: pn[String(PIL)], sans: (idx.j.sansPosition || []).includes(SPO), hors: (idx.j.horsDepartements || []).includes(LDN) }));
  // Même index pour MeshCore : rangé à part, par clé publique ; 0, 0 = sans position ; les compteurs MT restent ceux de Meshtastic
  const imc = idx.j.mc || {};
  if (imc.parNoeud && imc.parNoeud[MC43] === '43' && (imc.sansPosition || []).includes(MC00) && !(imc.horsDepartements || []).includes(MC00)
    && d43 && d43.nbMc >= 1 && !pn[MC43]) ok(`départements MeshCore : le companion du Puy rangé dans le 43 (${d43.nbMc} nœud(s) MC), l’annonce 0, 0 comptée sans position`);
  else ko('départements MeshCore : ' + JSON.stringify({ mc: imc.parNoeud && imc.parNoeud[MC43], sans: imc.sansPosition, d43 }));

  // ---- Route de l'autorisation seule : droits, validation, reste de la fiche gardé, rien de privé en retour
  const mauvais = await appel('POST', `/api/noeuds/${CHD}/autorisation`, { autorisation: 'n’importe-quoi' });
  const sansCompte = await fetch(BASE + `/api/noeuds/${CHD}/autorisation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"autorisation":"non-necessaire"}' });
  const bon = await appel('POST', `/api/noeuds/${MEZ}/autorisation`, { autorisation: 'ecrite' });
  const fiches = (await appel('GET', '/api/installations')).j;
  const fm = fiches[String(MEZ)] || {};
  if (mauvais.statut === 400 && sansCompte.status === 401 && bon.statut === 200 && !JSON.stringify(bon.j).includes('Commune')
    && fm.autorisation === 'ecrite' && fm.site === 'Château d’eau de Saint-Vincent' && fm.hauteur === 8 && fm.proprietaire === 'Commune de Saint-Vincent') ok('autorisation seule : valeur inconnue refusée, refusée sans compte, reste de la fiche gardé, propriétaire jamais renvoyé');
  else ko('autorisation seule : ' + JSON.stringify({ mauvais: mauvais.statut, sansCompte: sansCompte.status, bon: bon.statut, fm }));

  // ---- Gestionnaire de secteur : un nœud hors de son secteur est refusé par le serveur
  const gest = await appel('POST', '/api/comptes', { identifiant: 'Gestion 43', motDePasse: 'Essai-gest-2026!!', role: 'gestionnaire', noeuds: [String(MEZ), String(CHD)] });
  const cx = await fetch(BASE + '/api/connexion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiant: 'Gestion 43', motDePasse: 'Essai-gest-2026!!' }) });
  const brut = (cx.headers.get('set-cookie') || '').split(';')[0];
  const HG = { 'Content-Type': 'application/json', Cookie: brut };
  const dedans = await appel('POST', `/api/noeuds/${CHD}/autorisation`, { autorisation: 'convention' }, HG);
  const dehors = await appel('POST', `/api/noeuds/${MON}/autorisation`, { autorisation: 'convention' }, HG);
  const apresGest = (await appel('GET', '/api/installations')).j;
  if (gest.statut === 200 && dedans.statut === 200 && dehors.statut === 403 && (apresGest[String(CHD)] || {}).autorisation === 'convention' && !apresGest[String(MON)]) ok('gestionnaire de secteur : son relais accepté, un relais hors secteur refusé (403) et non modifié');
  else ko('gestionnaire de secteur : ' + JSON.stringify({ gest: gest.statut, dedans: dedans.statut, dehors: dehors.statut, chd: apresGest[String(CHD)], mon: apresGest[String(MON)] }));
  // On remet CHD sans autorisation pour la suite (modification groupée)
  await appel('POST', `/api/noeuds/${CHD}/autorisation`, { autorisation: '' });

  // ---- Interface, administrateur, ordinateur
  const ctx = await navig.newContext({ viewport: { width: 1400, height: 900 }, locale: 'fr-FR' });
  await ctx.addCookies([cookie]);
  await ctx.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  const { page, erreurs } = await ouvrir(ctx, '/');
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  const lignes = () => page.locator('#reg-corps tr[data-num]').count();
  const chercher = async (t) => { await page.fill('#reg-recherche', t); await page.waitForTimeout(150); return lignes(); };
  // La liste des nœuds arrive par /api/noeuds : on attend qu'elle soit là avant d'ouvrir le registre
  await page.waitForFunction((num) => typeof etat !== 'undefined' && etat.noeuds && etat.noeuds.has(num), MEZ, { timeout: 20000 });
  await page.evaluate(() => ficheRegistreRelais());
  const pret = await page.waitForSelector('#reg-corps tr[data-num]', { timeout: 10000 }).then(() => true).catch(() => false);
  if (!pret) { ko('registre : aucune ligne affichée — ' + (await page.locator('#fiche-contenu').innerText()).slice(0, 300).replace(/\s+/g, ' ')); await capture(page, 'registre-vide'); await ctx.close(); return; }
  const total = await lignes();

  // 3) Recherche libre : nom, site accentué, propriétaire, rien qui corresponde
  const parNom = await chercher('mezenc');
  const parSite = await chercher('chateau d eau');
  const parProprio = await chercher('COMMUNE de saint vincent');
  const rien = await chercher('zzzz-introuvable');
  const vide = await page.locator('#reg-corps').innerText();
  const compteRien = await page.locator('#reg-compte').innerText();
  if (total >= 5 && parNom === 1 && parSite === 1 && parProprio === 1 && rien === 0 && /Aucun relais ne correspond/.test(vide) && new RegExp(`0 relais affich.s sur ${total}`).test(compteRien)) ok(`recherche du registre : ${total} relais, 1 par nom (accents ignorés), 1 par site, 1 par propriétaire, 0 pour un mot absent, compteur cohérent`);
  else ko('recherche du registre : ' + JSON.stringify({ total, parNom, parSite, parProprio, rien, compteRien, vide: vide.slice(0, 80) }));
  // Indicateurs recalculés sur ce qui est affiché
  const indic = await (async () => { await chercher('monistrol'); return page.locator('#reg-compte').innerText(); })();
  if (/1 relais affich.s sur/.test(indic) && /1 sans autorisation/.test(indic)) ok('indicateurs du registre : « sans autorisation » compté sur les relais affichés seulement');
  else ko('indicateurs du registre : ' + indic);

  // 4) Filtre par département dans le registre
  const dep42 = await page.evaluate(async () => {
    document.querySelector('#reg-recherche').value = ''; document.querySelector('#reg-recherche').dispatchEvent(new Event('input'));
    const s = document.querySelector('#reg-dep');
    if (!s) return null;
    const codes = [...s.options].map((o) => o.value);
    s.value = '42'; s.dispatchEvent(new Event('change'));
    const noms = [...document.querySelectorAll('#reg-corps tr[data-num] b')].map((b) => b.textContent);
    s.value = 'sans'; s.dispatchEvent(new Event('change'));
    const sans = [...document.querySelectorAll('#reg-corps tr[data-num] b')].map((b) => b.textContent);
    s.value = ''; s.dispatchEvent(new Event('change'));
    return { codes, noms, sans };
  });
  if (dep42 && dep42.codes.includes('42') && dep42.codes.includes('43') && dep42.codes.includes('sans')
    && JSON.stringify(dep42.noms) === JSON.stringify(['42 Relais du Pilat']) && dep42.sans.includes('43 Relais sans position')) ok('filtre par département du registre : 42 → le Pilat seul, « sans département » → le relais sans position');
  else ko('filtre par département du registre : ' + JSON.stringify(dep42));
  await capture(page, 'registre-recherche');

  // 2) Fermer une fiche ouverte depuis le registre = revenir au registre, avec la recherche
  const retour = await (async () => {
    await chercher('mezenc');
    await page.click('#reg-corps tr[data-num]');
    await page.waitForSelector('#fiche-contenu h2', { timeout: 8000 });
    const titre = await page.locator('#fiche-contenu h2').innerText();
    await page.click('#fermer-fiche');
    await page.waitForSelector('#reg-recherche', { timeout: 8000 });
    const q = await page.inputValue('#reg-recherche');
    const n = await lignes();
    // Deuxième fermeture : on quitte le registre, sans y revenir sans fin
    await page.click('#fermer-fiche');
    const ferme = await page.evaluate(() => document.querySelector('#fiche').hidden);
    // Fiche ouverte depuis la carte : la fermeture ne ramène pas au registre
    await page.evaluate((num) => ouvrirFiche(num), MEZ);
    await page.waitForSelector('#fiche-contenu h2', { timeout: 8000 });
    await page.click('#fermer-fiche');
    const fermeCarte = await page.evaluate(() => document.querySelector('#fiche').hidden && !document.querySelector('#reg-recherche'));
    return { titre, q, n, ferme, fermeCarte };
  })();
  if (/Mézenc/.test(retour.titre) && retour.q === 'mezenc' && retour.n === 1 && retour.ferme && retour.fermeCarte) ok('retour au registre : la fiche fermée rend la liste et la recherche « mezenc » ; une fiche ouverte depuis la carte ne ramène pas au registre, et le registre se ferme normalement');
  else ko('retour au registre : ' + JSON.stringify(retour));

  // 1) Date du jour proposée dans la fiche d'installation
  const dates = await page.evaluate(async (num) => {
    const d = new Date();
    const aujourdhui = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    await ouvrirFiche(num);
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('#fiche-contenu [data-of="install"]').click();
    const visite = document.querySelector('#f-install input[name="derniereVisite"]');
    const avant = visite.value;
    visite.focus();
    const propose = { valeur: visite.value, marque: visite.classList.contains('date-proposee'), texte: (visite.parentElement.querySelector('.date-proposee-marque') || {}).textContent || '' };
    // On efface : le champ reste vide, la marque disparaît et rien ne se re-remplit tout seul
    visite.value = ''; visite.dispatchEvent(new Event('input', { bubbles: true }));
    visite.blur(); visite.focus();
    const apresEffacement = { valeur: visite.value, marque: visite.classList.contains('date-proposee'), reste: !!visite.parentElement.querySelector('.date-proposee-marque') };
    return { aujourdhui, avant, propose, apresEffacement };
  }, MEZ);
  const ficheAvant = (await appel('GET', '/api/installations')).j[String(MEZ)] || {};
  if (dates.avant === '' && dates.propose.valeur === dates.aujourdhui && dates.propose.marque && /Date du jour propos/.test(dates.propose.texte)
    && dates.apresEffacement.valeur === '' && !dates.apresEffacement.marque && !dates.apresEffacement.reste
    && !ficheAvant.derniereVisite) ok(`date du jour : proposée au premier passage dans « Dernière visite » (${dates.aujourdhui}), signalée, effaçable sans revenir, et non enregistrée tant que la fiche n’est pas validée`);
  else ko('date du jour proposée : ' + JSON.stringify({ dates, enregistre: ficheAvant.derniereVisite }));
  await capture(page, 'registre-date-proposee');
  // Fiche enregistrée : la date proposée et gardée est écrite, et nommée dans le retour
  const enreg = await page.evaluate(async () => {
    const autor = document.querySelector('#f-install input[name="dateAutorisation"]');
    autor.focus();
    const propose = autor.value;
    document.querySelector('#f-install button[type="submit"]').click();
    for (let k = 0; k < 40 && !/enregistr/i.test(document.querySelector('#install-retour').textContent); k++) await new Promise((r) => setTimeout(r, 100));
    return { propose, retour: document.querySelector('#install-retour').textContent };
  });
  const apres = (await appel('GET', '/api/installations')).j[String(MEZ)] || {};
  if (apres.dateAutorisation === dates.aujourdhui && !apres.derniereVisite && apres.site === 'Château d’eau de Saint-Vincent' && apres.hauteur === 8 && /Date du jour enregistr/.test(enreg.retour)) ok('date du jour : enregistrée seulement avec la fiche, nommée dans le message de retour, le champ effacé reste vide');
  else ko('date du jour enregistrée : ' + JSON.stringify({ enreg, apres }));
  // Une date déjà saisie n'est jamais remplacée
  const dejaSaisie = await page.evaluate(async (num) => {
    await ouvrirFiche(num);
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('#fiche-contenu [data-of="install"]').click();
    const autor = document.querySelector('#f-install input[name="dateAutorisation"]');
    const avant = autor.value;
    autor.focus();
    return { avant, apres: autor.value, marque: autor.classList.contains('date-proposee') };
  }, MEZ);
  if (dejaSaisie.avant === dates.aujourdhui && dejaSaisie.apres === dejaSaisie.avant && !dejaSaisie.marque) ok('date du jour : un champ déjà rempli n’est pas touché');
  else ko('date déjà saisie : ' + JSON.stringify(dejaSaisie));
  await page.click('#fermer-fiche');

  // 4) Liste des nœuds d'un département, et entrée « Nœuds du département » dans la recherche de lieu
  const dep = await page.evaluate(async () => {
    await ficheNoeudsDepartement('43');
    await new Promise((r) => setTimeout(r, 300));
    const noms = () => [...document.querySelectorAll('#nd-corps tr[data-num] b')].map((b) => b.textContent);
    const en43 = noms(), compte43 = document.querySelector('#nd-compte').textContent;
    const choix = [...document.querySelectorAll('#nd-dep option')].map((o) => o.value);
    const s = document.querySelector('#nd-dep');
    s.value = 'sans'; s.dispatchEvent(new Event('change'));
    const sans = noms();
    s.value = 'hors'; s.dispatchEvent(new Event('change'));
    const hors = noms();
    return { en43, compte43, choix, sans, hors, note: document.querySelector('.noeuds-departement').textContent };
  });
  const attendus43 = ['43 Relais Mézenc', '43 Relais Chaise-Dieu', '43 Relais Monistrol'];
  if (attendus43.every((n) => dep.en43.includes(n)) && !dep.en43.includes('42 Relais du Pilat') && !dep.en43.includes('London test node')
    && /dans le d.partement 43 . Haute-Loire/.test(dep.compte43) && dep.choix.includes('42') && dep.choix.includes('sans') && dep.choix.includes('hors')
    && dep.sans.includes('43 Relais sans position') && dep.hors.includes('London test node')
    && /position flout.e ou impr.cise/.test(dep.note)) ok(`liste par position : ${dep.en43.length} nœuds dans le 43, le Pilat et Londres exclus, « sans position » et « hors de France » à part, incertitude signalée`);
  else ko('liste par département : ' + JSON.stringify({ en43: dep.en43, compte43: dep.compte43, choix: dep.choix, sans: dep.sans.slice(0, 4), hors: dep.hors.slice(0, 4) }));
  await capture(page, 'registre-departement');

  // 4 bis) Liste du département selon le réseau affiché : Meshtastic seul, MeshCore seul, les deux, réseau inconnu
  await page.waitForFunction((cle) => typeof mc !== 'undefined' && mc.noeuds && mc.noeuds.has(cle), MC43, { timeout: 20000 }).catch(() => null);
  const parReseau = await page.evaluate(async ({ MC43, MC00, MEZ }) => {
    const avant = etat.vueReseau;
    const lire = () => ({
      mt: [...document.querySelectorAll('#nd-corps tr[data-num]')].map((t) => Number(t.dataset.num)),
      mc: [...document.querySelectorAll('#nd-corps tr[data-mc]')].map((t) => t.dataset.mc),
      tags: [...document.querySelectorAll('#nd-corps .tag-reseau')].map((t) => t.textContent),
      presse: (document.querySelector('[data-nd-reseau][aria-pressed="true"]') || {}).dataset?.ndReseau || null,
    });
    const ouvrir = async (r) => { etat.vueReseau = r; await ficheNoeudsDepartement('43'); await new Promise((x) => setTimeout(x, 200)); return lire(); };
    const res = { mt: await ouvrir('meshtastic'), mc: await ouvrir('meshcore'), deux: await ouvrir('les-deux'), inconnu: await ouvrir(undefined) };
    // Sélecteur dans l'écran : MeshCore seul, puis « sans position »
    etat.vueReseau = 'les-deux';
    await ficheNoeudsDepartement('43');
    document.querySelector('[data-nd-reseau="meshcore"]').click();
    res.bouton = lire();
    res.global = etat.vueReseau; // le sélecteur de l'écran ne change pas le réseau de la carte
    const s = document.querySelector('#nd-dep'); s.value = 'sans'; s.dispatchEvent(new Event('change'));
    res.sans = lire();
    // Clic sur un nœud MeshCore : sa fiche MeshCore, puis retour à la liste (réseau et département gardés)
    s.value = '43'; s.dispatchEvent(new Event('change'));
    document.querySelector(`#nd-corps tr[data-mc="${MC43}"]`).click();
    for (let k = 0; k < 50 && !/MC Companion du Puy/.test((document.querySelector('#fiche-contenu h2') || {}).textContent || ''); k++) await new Promise((x) => setTimeout(x, 100));
    res.fiche = (document.querySelector('#fiche-contenu h2') || {}).textContent || '';
    res.ficheMc = /MeshCore/.test((document.querySelector('#fiche-contenu .ident') || {}).textContent || '');
    document.querySelector('#fermer-fiche').click();
    for (let k = 0; k < 50 && !document.querySelector('#nd-corps tr'); k++) await new Promise((x) => setTimeout(x, 100));
    res.retour = { ...lire(), dep: (document.querySelector('#nd-dep') || {}).value };
    document.querySelector('#fermer-fiche').click();
    etat.vueReseau = avant;
    return res;
  }, { MC43, MC00, MEZ });
  const P = parReseau;
  const aMt = (x) => x.mt.includes(MEZ), aMc = (x) => x.mc.includes(MC43);
  if (aMt(P.mt) && !P.mt.mc.length && P.mt.presse === 'meshtastic'
    && aMc(P.mc) && !P.mc.mt.length && P.mc.presse === 'meshcore'
    && aMt(P.deux) && aMc(P.deux) && P.deux.tags.includes('MT') && P.deux.tags.includes('MC') && P.deux.presse === 'les-deux'
    && aMt(P.inconnu) && aMc(P.inconnu) && P.inconnu.presse === 'les-deux') ok('liste du département selon le réseau affiché : Meshtastic → MT seuls, MeshCore → MC seuls, les deux → MT et MC avec leur pastille, réseau inconnu → les deux');
  else ko('liste du département selon le réseau : ' + JSON.stringify(P));
  if (aMc(P.bouton) && !P.bouton.mt.length && P.global === 'les-deux' && P.sans.mc.includes(MC00) && !P.sans.mt.length) ok('sélecteur MT / MC de l’écran : MeshCore seul sans changer la carte, l’annonce 0, 0 rangée « sans position »');
  else ko('sélecteur MT / MC de l’écran : ' + JSON.stringify({ bouton: P.bouton, global: P.global, sans: P.sans }));
  if (/MC Companion du Puy/.test(P.fiche) && P.ficheMc && aMc(P.retour) && !P.retour.mt.length && P.retour.dep === '43' && P.retour.presse === 'meshcore') ok('clic sur un nœud MeshCore : sa fiche MeshCore, et retour à la liste du 43 en MeshCore à la fermeture');
  else ko('fiche MeshCore depuis la liste : ' + JSON.stringify({ fiche: P.fiche, ficheMc: P.ficheMc, retour: P.retour }));
  // Captures : liste des deux réseaux, sur ordinateur puis au format téléphone (le sélecteur doit tenir dans la largeur)
  await page.evaluate(async () => { etat.vueReseau = 'les-deux'; await ficheNoeudsDepartement('43'); });
  await page.waitForSelector('#nd-corps tr[data-mc]', { timeout: 5000 }).catch(() => null);
  await capture(page, 'departement-deux-reseaux');
  const tailleAvant = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const debord = await page.evaluate(() => { const g = document.querySelector('.nd-reseau'); return g ? [...g.querySelectorAll('button')].some((b) => b.getBoundingClientRect().right > window.innerWidth + 1) : null; });
  await capture(page, 'departement-deux-reseaux-telephone');
  if (debord === false) ok('sélecteur MT / MC : tient dans un écran de téléphone (390 px)'); else ko('sélecteur MT / MC au téléphone : ' + debord);
  await page.setViewportSize(tailleAvant);
  await page.evaluate(() => { document.querySelector('#fermer-fiche').click(); });
  for (const terme of ['43', 'Haute-Loire']) {
    await page.fill('#recherche-lieu', terme);
    const trouve = await page.waitForFunction(() => [...document.querySelectorAll('#resultats-lieu li')].some((li) => /N.uds du d.partement 43/.test(li.textContent)), null, { timeout: 8000 }).then(() => true).catch(() => false);
    if (trouve) ok(`recherche de lieu : « ${terme} » propose « Nœuds du département 43 »`); else ko(`recherche de lieu : « ${terme} » ne propose pas la liste du département`);
  }
  await page.evaluate(() => { const c = document.querySelector('#recherche-lieu'); c.value = ''; const l = document.querySelector('#resultats-lieu'); if (l) l.hidden = true; });

  // 5) Modification groupée de l'autorisation (administrateur) : trois relais cochés d'un coup
  const groupe = await page.evaluate(async (nums) => {
    await ficheRegistreRelais();
    await new Promise((r) => setTimeout(r, 400));
    for (const num of nums) { const c = document.querySelector(`input[data-case="${num}"]`); c.checked = true; c.dispatchEvent(new Event('change')); }
    const avant = { libelle: document.querySelector('#reg-coches').textContent, visible: !document.querySelector('#reg-groupe').hidden, valeur: document.querySelector('#reg-aut').value };
    document.querySelector('#reg-appliquer').click();
    await new Promise((r) => setTimeout(r, 200));
    const demande = (document.querySelector('#dlg-confirmer p') || {}).textContent || '';
    document.querySelector('#dlg-confirmer [data-r="1"]').click();
    for (let k = 0; k < 60 && !/mis . jour|non modifi/.test(document.querySelector('#reg-retour').textContent); k++) await new Promise((r) => setTimeout(r, 100));
    return { avant, demande, retour: document.querySelector('#reg-retour').textContent, coches: document.querySelectorAll('#reg-corps input[data-case]:checked').length, groupe: document.querySelector('#reg-groupe').hidden };
  }, [MEZ, CHD, MON]);
  const apresGroupe = (await appel('GET', '/api/installations')).j;
  const toutes = [MEZ, CHD, MON].every((num) => (apresGroupe[String(num)] || {}).autorisation === 'non-necessaire');
  const gardee = (apresGroupe[String(MEZ)] || {}).site === 'Château d’eau de Saint-Vincent' && (apresGroupe[String(MEZ)] || {}).hauteur === 8;
  if (groupe.avant.visible && /3 relais coch/.test(groupe.avant.libelle) && groupe.avant.valeur === 'non-necessaire'
    && /3 relais/.test(groupe.demande) && /Pas n.cessaire/.test(groupe.demande) && /3 relais mis . jour/.test(groupe.retour)
    && toutes && gardee && groupe.coches === 0 && groupe.groupe) ok('modification groupée : 3 relais cochés, confirmation qui dit combien, « Pas nécessaire » enregistré pour les trois, reste des fiches gardé, cases remises à zéro');
  else ko('modification groupée : ' + JSON.stringify({ groupe, toutes, gardee, mez: apresGroupe[String(MEZ)] }));
  // Journal d'audit : une ligne par relais
  const audit = await (await fetch(BASE + '/api/audit?limite=200', { headers: H })).json().catch(() => []);
  const lignesAudit = (audit || []).filter((a) => /\/autorisation$/.test(a.action || '')).length;
  if (lignesAudit >= 3) ok(`journal d’audit : ${lignesAudit} lignes « /autorisation », une par relais modifié`); else ko('journal d’audit : ' + lignesAudit + ' ligne(s) /autorisation');
  await capture(page, 'registre-groupe');
  // Téléphone : les filtres et la barre groupée tiennent dans l'écran
  const ctxTel = await navig.newContext({ viewport: { width: 390, height: 844 }, locale: 'fr-FR', isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctxTel.addCookies([cookie]);
  await ctxTel.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  const tel = await ouvrir(ctxTel, '/');
  await tel.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  await tel.page.waitForFunction((num) => typeof etat !== 'undefined' && etat.noeuds && etat.noeuds.has(num), MEZ, { timeout: 20000 });
  await tel.page.evaluate(async (num) => { await ficheRegistreRelais(); await new Promise((r) => setTimeout(r, 400)); const c = document.querySelector(`input[data-case="${num}"]`); if (c) { c.checked = true; c.dispatchEvent(new Event('change')); } }, MEZ);
  await tel.page.waitForSelector('#reg-recherche', { timeout: 8000 });
  const mesuresTel = await tel.page.evaluate(() => {
    const r = document.querySelector('#reg-recherche').getBoundingClientRect(), g = document.querySelector('#reg-groupe');
    const b = g && !g.hidden ? g.getBoundingClientRect() : null;
    // Tous les réglages du registre doivent tenir dans la largeur de l'écran, listes déroulantes comprises
    const dehors = [...document.querySelectorAll('.registre-filtres select, .registre-filtres input, .registre-groupe select, .registre-groupe button')]
      .filter((e) => { const x = e.getBoundingClientRect(); return x.width && (x.left < -1 || x.right > innerWidth + 1); }).length;
    return { champ: r.width > 120 && r.left >= 0 && r.right <= innerWidth + 1, barre: !!b && b.left >= 0 && b.right <= innerWidth + 1, dehors, deborde: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  if (mesuresTel.champ && mesuresTel.barre && !mesuresTel.dehors && !mesuresTel.deborde) ok('téléphone : champ de recherche, listes déroulantes et barre « relais cochés » entiers dans l’écran, pas de débordement');
  else ko('téléphone : ' + JSON.stringify(mesuresTel));
  await capture(tel.page, 'registre-telephone');
  bilanErreurs(tel.erreurs, 'registre (téléphone)');
  await ctxTel.close();

  // 5 bis) Échec partiel : un gestionnaire de secteur dont la page a été trafiquée pour cocher un relais
  // hors de son secteur. Le serveur refuse ce relais seul : le compte rendu doit le dire.
  const [cn, cv] = brut.split('=');
  const ctxG = await navig.newContext({ viewport: { width: 1400, height: 900 }, locale: 'fr-FR' });
  await ctxG.addCookies([{ name: cn, value: cv, domain: '127.0.0.1', path: '/' }]);
  await ctxG.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  const g = await ouvrir(ctxG, '/');
  await g.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  await g.page.waitForFunction((num) => typeof etat !== 'undefined' && etat.noeuds && etat.noeuds.has(num), MEZ, { timeout: 20000 });
  const partiel = await g.page.evaluate(async (nums) => {
    const [mez, chd, mon] = nums;
    await ficheRegistreRelais();
    await new Promise((r) => setTimeout(r, 400));
    const cases = () => [...document.querySelectorAll('#reg-corps input[data-case]')].map((c) => Number(c.dataset.case));
    const secteur = cases();
    // Page trafiquée : le gestionnaire se donne un relais qui n'est pas dans son secteur
    etat.secteur = [...etat.secteur, String(mon)];
    await ficheRegistreRelais();
    await new Promise((r) => setTimeout(r, 400));
    for (const num of [mez, chd, mon]) { const c = document.querySelector(`input[data-case="${num}"]`); c.checked = true; c.dispatchEvent(new Event('change')); }
    document.querySelector('#reg-aut').value = 'orale';
    document.querySelector('#reg-appliquer').click();
    await new Promise((r) => setTimeout(r, 200));
    document.querySelector('#dlg-confirmer [data-r="1"]').click();
    for (let k = 0; k < 80 && !/non modifi/.test(document.querySelector('#reg-retour').textContent); k++) await new Promise((r) => setTimeout(r, 100));
    return { secteur, retour: document.querySelector('#reg-retour').textContent, restees: [...document.querySelectorAll('#reg-corps input[data-case]:checked')].map((c) => Number(c.dataset.case)) };
  }, [MEZ, CHD, MON]);
  const apresPartiel = (await appel('GET', '/api/installations')).j;
  const bons = [MEZ, CHD].every((num) => (apresPartiel[String(num)] || {}).autorisation === 'orale');
  const refuse = (apresPartiel[String(MON)] || {}).autorisation === 'non-necessaire';
  if (JSON.stringify(partiel.secteur.sort()) === JSON.stringify([MEZ, CHD].sort()) && /2 relais mis . jour/.test(partiel.retour)
    && /1 relais non modifi/.test(partiel.retour) && /Monistrol/.test(partiel.retour) && /secteur/.test(partiel.retour)
    && bons && refuse && JSON.stringify(partiel.restees) === JSON.stringify([MON])) ok('échec partiel : cases du gestionnaire limitées à son secteur, 2 relais modifiés et 1 refusé par le serveur, dit clairement, le relais refusé reste coché et inchangé');
  else ko('échec partiel : ' + JSON.stringify({ partiel, bons, refuse, mon: apresPartiel[String(MON)] }));
  await capture(g.page, 'registre-echec-partiel');
  bilanErreurs(g.erreurs, 'registre (gestionnaire de secteur)');
  await ctxG.close();
  // Anglais : les écrans du registre et des départements sont traduits (pas de reste de français)
  const ctxEn = await navig.newContext({ viewport: { width: 1400, height: 900 }, locale: 'en-GB' });
  await ctxEn.addCookies([cookie]);
  await ctxEn.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'en'); } catch { /* */ } });
  const en = await ouvrir(ctxEn, '/');
  await en.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  await en.page.waitForFunction((num) => typeof etat !== 'undefined' && etat.noeuds && etat.noeuds.has(num), MEZ, { timeout: 20000 });
  const texteEn = await en.page.evaluate(async (num) => {
    await ficheRegistreRelais();
    await new Promise((r) => setTimeout(r, 600));
    const c = document.querySelector(`input[data-case="${num}"]`);
    if (c) { c.checked = true; c.dispatchEvent(new Event('change')); }
    await new Promise((r) => setTimeout(r, 400));
    const registre = document.querySelector('#fiche-contenu').innerText;
    await ficheNoeudsDepartement('43');
    await new Promise((r) => setTimeout(r, 600));
    return { registre, departement: document.querySelector('#fiche-contenu').innerText, placeholder: '' };
  }, MEZ);
  const resteFr = /relais et passerelles|Appliquer aux|Tout décocher|Nœuds du département|relais coché/.test(texteEn.registre + texteEn.departement);
  if (/Relay register/.test(texteEn.registre) && /relays and gateways/.test(texteEn.registre) && /Apply to the ticked relays/.test(texteEn.registre)
    && /Untick everything/.test(texteEn.registre) && /relay\(s\) ticked/.test(texteEn.registre)
    && /Nodes of a department/.test(texteEn.departement) && /node\(s\) in department 43/.test(texteEn.departement) && !resteFr) ok('anglais : registre et liste par département entièrement traduits');
  else ko('anglais : ' + JSON.stringify({ registre: texteEn.registre.replace(/\s+/g, ' ').slice(0, 260), departement: texteEn.departement.replace(/\s+/g, ' ').slice(0, 200) }));
  await capture(en.page, 'registre-anglais');
  bilanErreurs(en.erreurs, 'registre (anglais)');
  await ctxEn.close();
  bilanErreurs(erreurs, 'registre des relais');
  await ctx.close();
}

// Boutons du menu Outils : chacun doit déclencher SON action. Le gestionnaire générique des couches était
// posé sur tous les éléments .bascule (y compris ceux du menu Outils, qui n'ont pas de data-couche) et
// écrasait leur vrai gestionnaire : le clic ne faisait plus rien. Essai dans le contexte d'Olivier, carte
// ouverte en HTTP via une adresse Tailscale : Chrome n'expose alors ni navigator.serial ni navigator.bluetooth.
async function essaiBoutonsOutils(navig, cookie) {
  console.log('Menu Outils : chaque bouton garde son action (contexte non sécurisé)');
  const contexte = await navig.newContext({ viewport: { width: 1400, height: 900 }, locale: 'fr-FR' });
  await contexte.addCookies([cookie]);
  await contexte.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
  // Carte en http:// hors de ce PC : ni Web Serial ni Web Bluetooth, et isSecureContext faux
  await contexte.addInitScript(() => {
    delete Navigator.prototype.serial;
    delete Navigator.prototype.bluetooth;
    Object.defineProperty(window, 'isSecureContext', { get: () => false });
  });
  const { page, erreurs } = await ouvrir(contexte, '/');

  // 1. Aucun bouton sans data-couche ne doit porter le gestionnaire des couches
  const etatBoutons = await page.evaluate(() => {
    const l = [];
    document.querySelectorAll('.bascule').forEach((b) => {
      const src = b.onclick ? b.onclick.toString() : null;
      l.push({
        cle: b.id ? '#' + b.id : (b.getAttribute('href') || '').slice(0, 40) || (b.textContent || '').trim().slice(0, 36),
        couche: b.dataset.couche || null, tag: b.tagName,
        href: b.getAttribute('href'), action: !!src,
        couchier: !!(src && /dataset\.couche/.test(src)),
      });
    });
    return l;
  });
  const avecCouche = etatBoutons.filter((b) => b.couche);
  const sansCouche = etatBoutons.filter((b) => !b.couche);
  const voles = sansCouche.filter((b) => b.couchier);
  if (!voles.length) ok(`boutons d’outils : aucun n’a hérité du gestionnaire des couches (${sansCouche.length} boutons vérifiés)`);
  else ko(`${voles.length} bouton(s) d’outils déclenchent la bascule des couches au lieu de leur action : ` + voles.map((b) => b.cle).join(', '));
  // Les vraies bascules de couche, elles, doivent toutes l'avoir gardé
  const perdues = avecCouche.filter((b) => !b.couchier);
  if (avecCouche.length >= 15 && !perdues.length) ok(`bascules de couche : les ${avecCouche.length} conservent leur gestionnaire`);
  else ko('bascules de couche perdues : ' + JSON.stringify(perdues.map((b) => b.couche)) + ` (${avecCouche.length} trouvées)`);
  // Aucun bouton muet : soit un gestionnaire, soit un lien
  const muets = sansCouche.filter((b) => !b.action && !b.href);
  if (!muets.length) ok('boutons d’outils : aucun sans action ni lien');
  else ko('boutons sans aucune action : ' + muets.map((b) => b.cle).join(', '));

  // 2. Les 13 boutons signalés par Olivier : chacun a bien son action propre ou un lien utilisable
  const ATTENDUS = ['#outil-connecter', '#lien-client', '#lien-flasher', '#outil-passerelle', '#outil-theme', '#outil-installer', '#outil-adrasec'];
  const manque = await page.evaluate((ids) => ids.filter((id) => {
    const b = document.querySelector(id);
    if (!b) return false; // bouton absent de cette édition
    const src = b.onclick ? b.onclick.toString() : null;
    if (src && /dataset\.couche/.test(src)) return true;
    return !src && !b.getAttribute('href');
  }), ATTENDUS);
  if (!manque.length) ok('boutons nommés par Olivier : tous rendus à leur action (' + ATTENDUS.length + ' vérifiés)');
  else ko('boutons toujours inertes : ' + manque.join(', '));

  // 3. Une seule porte pour relier un module : « Connecter un module… ». Les anciennes entrées USB, Bluetooth et
  //    companion ont quitté le menu ; l'écran unique les propose, et dit pourquoi elles sont indisponibles ici (HTTP)
  await page.evaluate(() => { const m = document.querySelector('.menu-outils'); if (m) m.open = true; document.querySelector('#outil-connecter').click(); });
  await page.waitForTimeout(700);
  const porte = await page.evaluate(() => { const d = document.querySelector('dialog[open]'); return { anciennes: ['#outil-usb', '#outil-ble', '#outil-companion-mc'].filter((x) => document.querySelector(x)).length, ouverte: !!d, usb: d ? !!d.querySelector('[data-cx="usb"]') : false, ble: d ? !!d.querySelector('[data-cx="ble"]') : false, raison: d ? (d.querySelector('.alerte.attention') || {}).textContent || '' : '',
    topoMc: (() => { const l = [...document.querySelectorAll('.menu-outils .menu > *')]; const i = l.findIndex((e) => (e.getAttribute('href') || '').includes('reseau=mc')); let k = i; while (k >= 0 && !l[k].classList.contains('titre-outils')) k--; return k >= 0 ? l[k].textContent.trim() : ''; })() }; });
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  if (!porte.anciennes && porte.ouverte && porte.usb && porte.ble && /HTTPS|Chrome ou Edge/i.test(porte.raison) && porte.topoMc === 'MeshCore') ok('menu Outils : une seule entrée pour relier un module (USB, Bluetooth, raison de l’indisponibilité), topologie MeshCore rangée sous MeshCore');
  else ko('menu Outils dédoublonné : ' + JSON.stringify(porte));

  // 4. Aucune clé parasite dans les couches après ces clics
  const parasites = await page.evaluate(() => Object.keys(etat.couches).filter((k) => k === 'undefined' || k === 'null'));
  if (!parasites.length) ok('couches : aucune clé parasite après les clics d’outils');
  else ko('clé parasite dans etat.couches : ' + JSON.stringify(parasites));

  // 5. Le bouton « Thème clair » agit vraiment
  await page.evaluate(() => { const m = document.querySelector('.menu-outils'); if (m) m.open = true; document.querySelector('#outil-theme').click(); });
  await page.waitForTimeout(300);
  const clair = await page.evaluate(() => document.body.classList.contains('theme-clair'));
  if (clair) ok('clic « Thème clair » : le thème change'); else ko('clic « Thème clair » : aucun effet');
  await page.evaluate(() => { const m = document.querySelector('.menu-outils'); if (m) m.open = true; document.querySelector('#outil-theme').click(); });

  // 6. Une clé parasite déjà enregistrée par une ancienne version est purgée, les choix légitimes gardés
  await page.evaluate(() => localStorage.setItem('gaulix_couches', JSON.stringify({ rf: false, aprs: true, undefined: true })));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const apres = await page.evaluate(() => ({ ls: JSON.parse(localStorage.getItem('gaulix_couches') || '{}'), rf: etat.couches.rf, aprs: etat.couches.aprs }));
  if (!('undefined' in apres.ls) && apres.rf === false && apres.aprs === true) ok('couches mémorisées : clé parasite purgée, choix légitimes gardés (rf, aprs)');
  else ko('purge des couches mémorisées : ' + JSON.stringify(apres));

  await capture(page, 'outils-non-securise');
  bilanErreurs(erreurs, 'menu Outils');
  await contexte.close();
}

// Fenêtres (<dialog>) : largeur sur grand écran, bouton ⤢, fermeture par un clic à côté, protection
// d'une saisie en cours, Échap toujours actif.
async function essaiFenetres(navig, cookie) {
  console.log('Fenêtres : largeur, élargissement et fermeture par un clic à côté');
  const prep = async (vue) => {
    const ctx = await navig.newContext({ viewport: vue, locale: 'fr-FR', isMobile: vue.width < 500, hasTouch: vue.width < 500, deviceScaleFactor: vue.width < 500 ? 2 : 1 });
    await ctx.addCookies([cookie]);
    await ctx.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
    const r = await ouvrir(ctx, '/');
    await r.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    return { ctx, ...r };
  };
  const ouvrirFonctions = async (page) => {
    await page.evaluate(() => dlgFonctionsCarte());
    await page.waitForFunction(() => { const d = document.getElementById('dlg-fonctions-carte'); return d && d.open && !d.querySelector('.vide'); }, null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);
  };
  const mesurer = (page) => page.evaluate(() => {
    const d = document.getElementById('dlg-fonctions-carte');
    const b = d.querySelector('.elargir');
    return {
      largeur: Math.round(d.getBoundingClientRect().width),
      defile: d.scrollHeight > d.clientHeight + 1,
      manquant: d.scrollHeight - d.clientHeight,
      elargirVisible: !!b && getComputedStyle(b).display !== 'none',
      debordement: document.documentElement.scrollWidth > window.innerWidth + 1,
      colonnes: (getComputedStyle(d.querySelector('.grille-fonctions')).gridTemplateColumns.match(/px/g) || []).length,
    };
  });

  // Grand écran : tout doit tenir sans barre de défilement, sur deux colonnes
  {
    const { ctx, page, erreurs } = await prep({ width: 1920, height: 1080 });
    await ouvrirFonctions(page);
    const m = await mesurer(page);
    if (!m.defile) ok(`« Fonctions de la carte » en 1920 px : tout tient sans défilement (largeur ${m.largeur} px)`);
    else ko(`« Fonctions de la carte » en 1920 px : encore ${m.manquant} px à faire défiler (largeur ${m.largeur} px)`);
    if (m.largeur >= 900 && m.largeur <= 1200) ok('largeur de départ dans la plage lisible (900–1200 px)');
    else ko('largeur de départ hors de la plage lisible : ' + m.largeur + ' px');
    if (m.colonnes === 2) ok('réglages sur deux colonnes quand la fenêtre est large');
    else ko('réglages : ' + m.colonnes + ' colonne(s) au lieu de 2');
    // Bouton ⤢ : élargit, et le choix est gardé d'une fenêtre à l'autre
    if (m.elargirVisible) ok('bouton ⤢ présent à côté de la croix'); else ko('bouton ⤢ absent sur grand écran');
    await page.click('#dlg-fonctions-carte .elargir');
    await page.waitForTimeout(300);
    const m2 = await mesurer(page);
    const garde = await page.evaluate(() => localStorage.getItem('gaulix_fenetres_larges'));
    if (m2.largeur > m.largeur && m2.largeur <= 1800) ok(`⤢ élargit la fenêtre (${m.largeur} → ${m2.largeur} px) sans dépasser 1800 px`);
    else ko(`⤢ : largeur ${m.largeur} → ${m2.largeur} px`);
    if (garde === 'true') ok('largeur élargie gardée pour la prochaine visite'); else ko('largeur élargie non mémorisée : ' + garde);
    await page.click('#dlg-fonctions-carte .elargir');
    await page.waitForTimeout(200);
    // Clic DANS la fenêtre (titre, puis zone vide près du bord) : ne ferme jamais
    await page.click('#dlg-fonctions-carte h3');
    await page.waitForTimeout(200);
    let ouverte = await page.evaluate(() => document.getElementById('dlg-fonctions-carte').open);
    if (ouverte) ok('clic sur le titre de la fenêtre : elle reste ouverte'); else ko('clic intérieur : la fenêtre s’est fermée');
    await page.evaluate(() => {
      const r = document.getElementById('dlg-fonctions-carte').getBoundingClientRect();
      document.elementFromPoint(Math.round(r.left + 3), Math.round(r.top + 3)).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 3, clientY: r.top + 3 }));
      document.elementFromPoint(Math.round(r.left + 3), Math.round(r.top + 3)).dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 3, clientY: r.top + 3 }));
    });
    await page.waitForTimeout(200);
    ouverte = await page.evaluate(() => document.getElementById('dlg-fonctions-carte').open);
    if (ouverte) ok('clic sur le bord intérieur de la fenêtre : elle reste ouverte'); else ko('clic sur le bord intérieur : la fenêtre s’est fermée');
    // Clic À CÔTÉ : ferme
    await page.mouse.click(6, 540);
    await page.waitForTimeout(300);
    const fermee = await page.evaluate(() => !document.getElementById('dlg-fonctions-carte').open);
    if (fermee) ok('clic à côté de la fenêtre : elle se ferme'); else ko('clic à côté : la fenêtre reste ouverte');
    await capture(page, 'fenetres-1920');
    bilanErreurs(erreurs, 'fenêtres (1920 px)');
    await ctx.close();
  }

  // Tablette et téléphone : rien ne doit déborder, le bouton ⤢ disparaît, le clic à côté marche toujours
  for (const vue of [{ width: 1024, height: 768 }, { width: 390, height: 844 }]) {
    const { ctx, page, erreurs } = await prep(vue);
    await ouvrirFonctions(page);
    const m = await mesurer(page);
    if (!m.debordement && m.largeur <= vue.width - 8) ok(`${vue.width} px : la fenêtre tient dans l’écran (${m.largeur} px, pas de défilement horizontal)`);
    else ko(`${vue.width} px : largeur ${m.largeur} px, débordement horizontal : ${m.debordement}`);
    if (vue.width === 390) {
      if (!m.elargirVisible) ok('téléphone : bouton ⤢ masqué'); else ko('téléphone : bouton ⤢ affiché à tort');
      if (m.colonnes === 1) ok('téléphone : réglages sur une seule colonne'); else ko('téléphone : ' + m.colonnes + ' colonnes');
      const croix = await page.locator('#dlg-fonctions-carte .fermer').isVisible();
      if (croix) ok('téléphone : la croix de fermeture reste présente'); else ko('téléphone : croix de fermeture absente');
    }
    await page.mouse.click(Math.round(vue.width / 2), vue.height - 6);
    await page.waitForTimeout(300);
    const fermee = await page.evaluate(() => !document.getElementById('dlg-fonctions-carte').open);
    if (fermee) ok(`${vue.width} px : clic à côté = fenêtre fermée`); else ko(`${vue.width} px : clic à côté sans effet`);
    await capture(page, 'fenetres-' + vue.width);
    bilanErreurs(erreurs, `fenêtres (${vue.width} px)`);
    await ctx.close();
  }

  // Saisie en cours : un clic à côté ne doit rien perdre ; la croix et Échap restent disponibles
  {
    const { ctx, page, erreurs } = await prep({ width: 1400, height: 900 });
    await page.evaluate(() => $('#dlg-profil').showModal());
    await page.waitForTimeout(300);
    await page.fill('#dlg-profil input[name="ha"]', '12');
    await page.mouse.click(6, 450);
    await page.waitForTimeout(400);
    const etatSaisie = await page.evaluate(() => ({
      ouverte: document.getElementById('dlg-profil').open,
      valeur: document.querySelector('#dlg-profil input[name="ha"]').value,
      message: (document.getElementById('annonces') || { textContent: '' }).textContent.trim(),
    }));
    if (etatSaisie.ouverte && etatSaisie.valeur === '12') ok('saisie en cours : le clic à côté ne ferme pas et ne perd rien');
    else ko('saisie en cours : ' + JSON.stringify(etatSaisie));
    if (/saisie/i.test(etatSaisie.message)) ok('saisie en cours : l’utilisateur est prévenu (« ' + etatSaisie.message.slice(0, 44) + '… »)');
    else ko('saisie en cours : aucun message (« ' + etatSaisie.message.slice(0, 60) + ' »)');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    if (await page.evaluate(() => !document.getElementById('dlg-profil').open)) ok('Échap ferme toujours la fenêtre');
    else ko('Échap ne ferme plus la fenêtre');
    // Fenêtre sans saisie : le clic à côté ferme bien
    await page.evaluate(() => $('#dlg-profil').showModal());
    await page.waitForTimeout(250);
    await page.mouse.click(6, 450);
    await page.waitForTimeout(300);
    if (await page.evaluate(() => !document.getElementById('dlg-profil').open)) ok('sans saisie commencée : le clic à côté ferme');
    else ko('sans saisie commencée : le clic à côté ne ferme pas');
    bilanErreurs(erreurs, 'fenêtres (saisie en cours)');
    await ctx.close();
  }
}

// Anti-force-brute : seuls les ECHECS remplissent le compteur des 15 minutes. Plusieurs personnes derriere
// la meme connexion internet (caserne, local ADRASEC) doivent pouvoir se connecter a la suite.
async function essaiConnexionsRepetees(navig, cookie) {
  console.log('Connexions répétées depuis la même adresse');
  const post = (corps) => fetch(BASE + '/api/connexion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) });
  const MDP = 'Essai-rep-2026!!';
  const r = await fetch(BASE + '/api/comptes', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `${cookie.name}=${cookie.value}` }, body: JSON.stringify({ identifiant: 'Repetition', motDePasse: MDP, role: 'membre' }) });
  if (!r.ok) { ko('connexions répétées : compte d’essai non créé (' + r.status + ')'); return; }
  let refus = 0, sansCookie = 0;
  for (let k = 0; k < 12; k++) {
    const x = await post({ identifiant: 'Repetition', motDePasse: MDP });
    if (x.status === 429) refus++;
    else if (!(x.headers.get('set-cookie') || '').includes('=')) sansCookie++;
  }
  if (!refus && !sansCookie) ok('12 connexions réussies de suite depuis la même adresse : aucune refusée');
  else ko(`connexions réussies refusées à tort : ${refus} en 429, ${sansCookie} sans cookie`);
  // La protection doit rester entière sur les mauvais mots de passe
  let bloque = 0;
  for (let k = 0; k < 12; k++) { const x = await post({ identifiant: 'Repetition', motDePasse: 'FauxMotDePasse!!' }); if (x.status === 429) bloque++; }
  if (bloque > 0) ok(`mauvais mot de passe répété : toujours bloqué (${bloque} refus sur 12)`); else ko('mauvais mot de passe répété 12 fois sans jamais être bloqué');
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

// Opérations récentes : la carte d'une opération doit dire CE QUI A ÉTÉ ENVOYÉ au relais (valeurs et unités),
// rester lisible sur téléphone, et ne jamais laisser voir une clé de canal.
// Les opérations d'essai sont mises en forme par le vrai module du serveur : l'écran et le serveur ne peuvent pas divergir.
async function essaiResumeOperations(navig, cookie) {
  console.log('Opérations récentes : résumé de ce qui a été envoyé');
  const ops = require('../src/resume-operations');
  const PSK_ESSAI = 'c2VjcmV0ZGVjYW5hbDEyMzQ1Njc4OTBhYmNk';
  const vue = (id, t) => ({
    id, type: t.type, nom: t.nom || 'Modification des réglages', auteur: 'F4GLD', debut: Date.now() - 600000, fin: Date.now() - 60000, insister: true,
    resume: ops.resumeOperation(t), details: ops.detailsOperation(t), principal: ops.toucheCanalPrincipal(t),
    noeuds: [{ num: 0x43ab1234, statut: 'echec', detail: 'pas de réponse du nœud', finNoeud: Date.now() - 60000 }],
  });
  const operations = [
    // Le cas d'Olivier : correction lancée depuis « Contrôle du trafic » (intervalles mesurés sur 24 h)
    vue('e1', { type: 'modifier', params: { device: { nodeInfoBroadcastSecs: 10800 }, telemetrie: { deviceUpdateInterval: 1800 } }, mesures: { heures: 24, valeurs: { 'device.nodeInfoBroadcastSecs': 360, 'telemetrie.deviceUpdateInterval': 240 } } }),
    // Résumé long : plusieurs sections et plusieurs canaux, dont une clé de canal qui ne doit jamais s'afficher
    vue('e2', {
      type: 'modifier',
      params: {
        nom: { nomLong: 'Le Bouchet', nomCourt: 'BCH' }, device: { role: 'ROUTER' }, lora: { hopLimit: 4, txPower: 20 },
        position: { positionBroadcastSecs: 43200 }, voisinage: { enabled: true, updateInterval: 21600 }, trafic: { rateLimitWindowSecs: 60 },
        canaux: [{ index: 0, nom: 'LongFast', psk: 'AQ==', precision: 16, montant: true, descendant: true }, { index: 2, nom: 'Secours', psk: PSK_ESSAI, precision: 32 }],
      },
      avant: { heure: Date.now() - 20 * 60000, valeurs: { 'lora.hopLimit': 3, 'position.positionBroadcastSecs': 900 } },
    }),
  ];
  for (const [nom, vueFenetre, mobile] of [['ordinateur', { width: 1400, height: 900 }, false], ['téléphone', { width: 390, height: 844 }, true]]) {
    const ctx = await navig.newContext({ viewport: vueFenetre, locale: 'fr-FR', isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
    await ctx.addCookies([cookie]);
    await ctx.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
    const { page, erreurs } = await ouvrir(ctx, '/');
    const pose = await page.evaluate(async (l) => {
      document.querySelectorAll('dialog[open]').forEach((d) => d.close());
      const o = document.querySelector('.onglets button[data-onglet="gestion"]');
      if (o) o.click();
      for (let k = 0; k < 40 && !document.querySelector('#taches-gestion'); k++) await new Promise((r) => setTimeout(r, 150));
      await new Promise((r) => setTimeout(r, 800)); // l'écran Gérer se reconstruit : attendre qu'il soit posé
      if (typeof gestion === 'object' && gestion.suivi) clearInterval(gestion.suivi); // plus de rafraîchissement automatique
      let z = null;
      for (let k = 0; k < 5; k++) {
        z = document.querySelector('#taches-gestion');
        if (!z) return null;
        z.innerHTML = rendreTaches(l);
        brancherArrets();
        await new Promise((r) => setTimeout(r, 500)); // laisser la traduction de l'interface passer
        z = document.querySelector('#taches-gestion');
        if (z && z.querySelector('.tache')) break;
      }
      const t1 = z && z.querySelector('.tache');
      if (!t1) return null;
      const couleur = (s) => { const e = z.querySelector(s); return e ? getComputedStyle(e).color : null; };
      const details = [...z.querySelectorAll('details.reste-resume')].map((d) => ({ resume: d.querySelector('summary').textContent.trim(), caches: d.querySelectorAll('.ligne-resume').length }));
      const deborde = [...z.querySelectorAll('.tache')].filter((e) => e.scrollWidth > e.clientWidth + 1).length;
      return {
        texte: z.textContent, html: z.innerHTML,
        lignes: [...t1.querySelectorAll('.ligne-resume')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
        couleurValeur: couleur('.val-resume'), couleurLib: couleur('.lib-resume'),
        couleurTexte: getComputedStyle(document.body).getPropertyValue('--texte').trim(),
        details, deborde, pageDeborde: document.documentElement.scrollWidth > innerWidth + 1,
        principal: [...z.querySelectorAll('[data-relancer-tache]')].map((b) => b.dataset.principal),
      };
    }, operations).catch((e) => ({ erreur: e.message }));
    if (!pose || pose.erreur) { ko(`opérations récentes (${nom}) : écran non obtenu ${pose ? pose.erreur : ''}`); await ctx.close(); continue; }
    // 1. Les valeurs envoyées, pas les noms de champs du firmware
    if (/Fiche du nœud/.test(pose.texte) && /toutes les 3 h/.test(pose.texte) && !/nodeInfoBroadcastSecs/.test(pose.texte)) ok(`${nom} : le résumé donne le réglage en français et sa valeur`); else ko(`${nom} : résumé ` + JSON.stringify(pose.lignes));
    // 2. Valeur d'avant : mesure sur 24 h, et valeur lue datée
    if (/mesuré sur 24 h : toutes les 6 min/.test(pose.texte)) ok(`${nom} : intervalle mesuré avant la correction affiché comme une mesure`); else ko(`${nom} : mesure absente ` + JSON.stringify(pose.lignes));
    if (/avant : 3 \(lu il y a 20 min\)/.test(pose.texte)) ok(`${nom} : valeur précédente lue sur le nœud, avec l’âge de la lecture`); else ko(`${nom} : « avant » absent`);
    // 3. Aucune clé de canal à l'écran ni dans le HTML
    if (!pose.html.includes(PSK_ESSAI) && !pose.html.includes('AQ==') && /clé envoyée \(non affichée\)/.test(pose.texte)) ok(`${nom} : aucune clé de canal affichée`); else ko(`${nom} : clé visible dans la carte d’opération`);
    // 4. Contraste : la valeur est écrite dans la couleur de texte pleine, le libellé en couleur douce
    if (pose.couleurValeur && pose.couleurValeur !== pose.couleurLib) ok(`${nom} : valeur bien contrastée (${pose.couleurValeur}), libellé plus doux`); else ko(`${nom} : valeur et libellé de même couleur (${pose.couleurValeur})`);
    // 5. Résumé long : les lignes en trop sont repliées, pas perdues
    if (pose.details.length === 1 && /autres réglages/.test(pose.details[0].resume) && pose.details[0].caches >= 3) ok(`${nom} : résumé long replié (« ${pose.details[0].resume} »), rien de supprimé`); else ko(`${nom} : repli du résumé long ` + JSON.stringify(pose.details));
    // 6. Le bouton « Réessayer » sait qu'un canal principal est réécrit (sans deviner d'après le texte)
    if (pose.principal.includes('1') && pose.principal.includes('0')) ok(`${nom} : relance d’une opération touchant le canal principal signalée`); else ko(`${nom} : drapeau canal principal ` + JSON.stringify(pose.principal));
    // 7. Téléphone : rien ne dépasse
    if (nom === 'téléphone') {
      if (!pose.deborde && !pose.pageDeborde) ok('téléphone 390 px : les lignes du résumé tiennent dans la carte, sans défilement horizontal'); else ko(`téléphone 390 px : ${pose.deborde} carte(s) débordent, page ${pose.pageDeborde}`);
    }
    await page.evaluate(() => { const z = document.querySelector('#taches-gestion'); if (z) z.scrollIntoView({ block: 'start' }); document.querySelectorAll('details.reste-resume').forEach((d) => (d.open = true)); });
    await page.waitForTimeout(300);
    await capture(page, 'resume-operations-' + (nom === 'téléphone' ? 'telephone' : 'ordinateur'));
    bilanErreurs(erreurs, 'opérations récentes (' + nom + ')');
    await ctx.close();
  }
  // Autre langue : les libellés, les unités et la mention « mesuré » sont traduits (édition monde : 16 langues)
  const ctxEn = await navig.newContext({ viewport: { width: 1400, height: 900 }, locale: 'en-GB' });
  await ctxEn.addCookies([cookie]);
  await ctxEn.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'en'); } catch { /* */ } });
  const { page: pEn, erreurs: errEn } = await ouvrir(ctxEn, '/');
  const texteEn = await pEn.evaluate(async (l) => {
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    const o = document.querySelector('.onglets button[data-onglet="gestion"]');
    if (o) o.click();
    for (let k = 0; k < 40 && !document.querySelector('#taches-gestion'); k++) await new Promise((r) => setTimeout(r, 150));
    await new Promise((r) => setTimeout(r, 800));
    if (typeof gestion === 'object' && gestion.suivi) clearInterval(gestion.suivi);
    let z = null;
    for (let k = 0; k < 5; k++) {
      z = document.querySelector('#taches-gestion');
      if (!z) return '';
      z.innerHTML = rendreTaches(l);
      await new Promise((r) => setTimeout(r, 600));
      z = document.querySelector('#taches-gestion');
      if (z && z.querySelector('.tache')) break;
    }
    return z ? z.textContent : '';
  }, operations).catch(() => '');
  if (/Node sheet/.test(texteEn) && /every 3 h/.test(texteEn) && /measured over 24 h: every 6 min/.test(texteEn)) ok('anglais : libellés, unités et mention « mesuré » traduits'); else ko('anglais : ' + String(texteEn).replace(/\s+/g, ' ').slice(0, 220));
  if (/Secours/.test(texteEn)) ok('anglais : les noms de canaux restent tels quels (translate="no")'); else ko('anglais : nom de canal perdu');
  await capture(pEn, 'resume-operations-anglais');
  bilanErreurs(errEn, 'opérations récentes (anglais)');
  await ctxEn.close();
}

// Fenêtre « Secteurs d'alerte » : de quelles équipes parle la liste déroulante, et où les créer.
// Le cas « aucune équipe » est celui où l'utilisateur est perdu : le message doit lui dire quoi faire.
async function essaiSecteursEquipes(navig, cookie) {
  console.log('Secteurs d’alerte : lien vers les équipes de la carte');
  const H = { 'Content-Type': 'application/json', Cookie: `${cookie.name}=${cookie.value}` };
  const appel = async (m, url, b) => { const r = await fetch(BASE + url, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); return { statut: r.status, j: await r.json().catch(() => ({})) }; };
  const vider = async () => { const l = await appel('GET', '/api/equipes'); for (const e of l.j.equipes || []) await appel('DELETE', '/api/equipes/' + e.id, { retirerDesNoeuds: false }); };
  const ouvrirSecteurs = async (vue, mobile) => {
    const ctx = await navig.newContext({ viewport: vue, locale: 'fr-FR', ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    await ctx.addCookies([cookie]);
    await ctx.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
    const o = await ouvrir(ctx, '/');
    await o.page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    await o.page.evaluate(() => ficheSecteurs());
    await o.page.waitForTimeout(1200);
    return { ctx, ...o };
  };
  const mesurer = (page) => page.evaluate(() => {
    const z = document.querySelector('.nouveau-sa');
    const al = z && z.querySelector('.alerte.attention');
    const note = z && z.querySelector('small.note');
    const lien = z && z.querySelector('[data-vers-equipes]');
    return { alerte: al ? al.textContent.replace(/\s+/g, ' ').trim() : null, note: note ? note.textContent.replace(/\s+/g, ' ').trim() : null,
      lien: lien ? lien.textContent.trim() : null, couleurAlerte: al ? getComputedStyle(al).color : null,
      options: [...(z ? z.querySelectorAll('[data-c="equipe"] option') : [])].map((o) => o.textContent),
      debordeX: document.documentElement.scrollWidth > innerWidth + 1 };
  });

  // 1) Aucune équipe sur la carte (ordinateur et téléphone 390 px) ; section ADRASEC désactivée le temps de
  //    l'essai : une carte sans ADRASEC doit garder exactement le comportement d'avant
  await vider();
  const adActif = (await appel('GET', '/api/adrasec/acces')).j.actif;
  await appel('PUT', '/api/adrasec/reglages', { actif: false });
  for (const [nom, vue, mobile] of [['ordinateur', { width: 1400, height: 900 }, false], ['téléphone 390 px', { width: 390, height: 844 }, true]]) {
    const { ctx, page, erreurs } = await ouvrirSecteurs(vue, mobile);
    const m = await mesurer(page);
    if (m.alerte && /Aucune équipe n’existe encore sur cette carte/.test(m.alerte) && /Programmer › 👥 Équipes/.test(m.alerte) && /Autres nœuds suivis/.test(m.alerte))
      ok(`${nom} : sans équipe, la fenêtre dit de quelles équipes il s’agit, où en créer une et quoi faire en attendant`);
    else ko(`${nom} : message « aucune équipe » : ` + JSON.stringify(m).slice(0, 300));
    if (m.lien === 'Créer une équipe de la carte') ok(`${nom} : lien « Créer une équipe de la carte »`); else ko(`${nom} : lien absent (${m.lien})`);
    if (m.couleurAlerte && !/rgba?\(0, 0, 0/.test(m.couleurAlerte)) ok(`${nom} : message lisible (${m.couleurAlerte})`); else ko(`${nom} : couleur du message : ${m.couleurAlerte}`);
    if (!m.debordeX) ok(`${nom} : pas de débordement horizontal`); else ko(`${nom} : la page déborde en largeur`);
    if (m.options.length === 1 && /aucune/.test(m.options[0])) ok(`${nom} : liste déroulante réduite à « — aucune — »`); else ko(`${nom} : options : ` + JSON.stringify(m.options));
    await capture(page, 'secteurs-equipes-' + (mobile ? 'telephone' : 'ordinateur'));
    // Le lien mène bien à l'écran où l'on crée les équipes
    await page.evaluate(() => document.querySelector('.nouveau-sa [data-vers-equipes]').click());
    await page.waitForTimeout(1500);
    const arrive = await page.evaluate(() => ({ equipes: !!document.querySelector('#fiche-contenu .equipes'), titre: (document.querySelector('#fiche-contenu h2') || {}).textContent || '' }));
    if (arrive.equipes) ok(`${nom} : le lien ouvre l’écran des équipes (${arrive.titre.trim().slice(0, 30)})`); else ko(`${nom} : le lien n’ouvre pas les équipes : ` + JSON.stringify(arrive));
    await capture(page, 'secteurs-vers-equipes-' + (mobile ? 'telephone' : 'ordinateur'));
    bilanErreurs(erreurs, `secteurs sans équipe (${nom})`);
    await ctx.close();
  }

  // 2) Une équipe existe : la phrase change, le lien reste, l'équipe est proposée
  const eq = await appel('POST', '/api/equipes', { nom: 'EqLien' });
  if (eq.statut !== 200) { ko('création de l’équipe d’essai : ' + JSON.stringify(eq.j).slice(0, 120)); return; }
  const { ctx, page, erreurs } = await ouvrirSecteurs({ width: 1400, height: 900 }, false);
  const m2 = await mesurer(page);
  if (m2.note && /Équipes de la carte/.test(m2.note) && /Programmer › 👥 Équipes/.test(m2.note) && !m2.alerte) ok('avec une équipe : la fenêtre rappelle d’où viennent les équipes');
  else ko('avec une équipe : ' + JSON.stringify(m2).slice(0, 300));
  if (m2.lien === 'Voir les équipes de la carte') ok('avec une équipe : lien « Voir les équipes de la carte »'); else ko('lien : ' + m2.lien);
  if (m2.options.some((o) => /EqLien/.test(o))) ok('l’équipe créée est proposée dans la liste'); else ko('options : ' + JSON.stringify(m2.options));
  bilanErreurs(erreurs, 'secteurs avec une équipe');
  await ctx.close();

  // 3) Équipes ADRASEC : proposées à part (une rubrique par section), lien vers l'onglet Équipes de la section,
  //    secteur rattaché à une équipe ADRASEC (nœud porté par un membre), puis équipe supprimée
  await appel('PUT', '/api/adrasec/reglages', { actif: true });
  const eqA = await appel('POST', '/api/adrasec/equipes?g=43', { nom: 'GonioSecteur' });
  const idA = eqA.statut === 200 ? (eqA.j.equipes.find((e) => e.nom === 'GonioSecteur') || {}).id : null;
  const moi = ((await appel('GET', '/api/adrasec?g=43')).j.moi) || {};
  const comptesL = (await appel('GET', '/api/comptes')).j;
  const compteMoi = (Array.isArray(comptesL) ? comptesL : []).find((c) => c.identifiant === moi.identifiant);
  const ancienMoi = ((await appel('GET', '/api/adrasec?g=43')).j.membres || []).find((x) => compteMoi && x.compte === compteMoi.id) || {};
  if (compteMoi) await appel('PUT', '/api/adrasec/membres/' + compteMoi.id + '?g=43', { membre: true, equipe: idA, noeud: 0x5a1e00a1 });
  const c3 = await ouvrirSecteurs({ width: 1400, height: 900 }, false);
  const m3 = await c3.page.evaluate(() => {
    const z = document.querySelector('.nouveau-sa');
    const groupes = [...z.querySelectorAll('[data-c="equipe"] optgroup')].map((g) => ({ label: g.label, options: [...g.querySelectorAll('option')].map((o) => ({ t: o.textContent, v: o.value })) }));
    const l = z.querySelector('[data-vers-adrasec="43"]');
    return { groupes, lien: l ? { texte: l.textContent.trim(), href: l.getAttribute('href'), cible: l.target } : null, note: (z.querySelector('small.note') || {}).textContent || '' };
  });
  const gA = m3.groupes.find((g) => /ADRASEC 43/.test(g.label));
  const optA = gA && gA.options.find((o) => /GonioSecteur/.test(o.t));
  if (gA && optA && optA.v === `adrasec:43:${idA}` && /1 nœud/.test(optA.t) && m3.groupes.some((g) => /Équipes de la carte/.test(g.label))) ok('secteurs : équipes ADRASEC proposées dans une rubrique « Équipes ADRASEC 43 », à côté de celles de la carte');
  else ko('secteurs, équipes ADRASEC : ' + JSON.stringify(m3).slice(0, 400));
  if (m3.lien && /onglet=equipes/.test(m3.lien.href) && /g=43/.test(m3.lien.href) && /Voir les équipes ADRASEC 43/.test(m3.lien.texte)) ok('secteurs : lien « Voir les équipes ADRASEC 43 » vers l’onglet Équipes de la section');
  else ko('lien vers les équipes ADRASEC : ' + JSON.stringify(m3.lien));
  await capture(c3.page, 'secteurs-equipes-adrasec');
  bilanErreurs(c3.erreurs, 'secteurs avec équipes ADRASEC');
  // Le lien ouvre bien la page ADRASEC sur l'onglet Équipes
  const pA = await c3.ctx.newPage();
  await pA.goto(BASE + m3.lien.href, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await pA.waitForTimeout(2500);
  const surEq = await pA.evaluate(() => { const v = document.querySelector('#vue-equipes'); return { actif: !!(v && v.classList.contains('actif')), equipe: !!(v && /GonioSecteur/.test(v.textContent)) }; });
  if (surEq.actif && surEq.equipe) ok('le lien ouvre la page ADRASEC directement sur l’onglet Équipes'); else ko('page ADRASEC ouverte par le lien : ' + JSON.stringify(surEq));
  await c3.ctx.close();
  // Secteur rattaché à l'équipe ADRASEC : nom affiché et nœud porté suivi ; équipe d'une ADRASEC inexistante refusée
  const sA = await appel('POST', '/api/secteurs', { nom: 'Secteur ADRASEC', forme: 'cercle', centre: { lat: 45.0, lon: 4.0 }, rayon: 1000, equipe: `adrasec:43:${idA}` });
  const faux = await appel('POST', '/api/secteurs', { nom: 'Faux', forme: 'cercle', centre: { lat: 45.0, lon: 4.0 }, rayon: 1000, equipe: 'adrasec:99:aaaaaaaaaaaa' });
  if (sA.statut === 200 && /GonioSecteur/.test(sA.j.nomEquipe || '') && /ADRASEC 43/.test(sA.j.nomEquipe || '') && sA.j.membres.some((x) => x.cle === 'mt:' + 0x5a1e00a1) && faux.statut === 400) ok('secteur rattaché à une équipe ADRASEC : nom affiché, nœud porté du membre suivi ; équipe inconnue refusée');
  else ko('secteur ADRASEC : ' + JSON.stringify({ sA: sA.j, faux: faux.statut }).slice(0, 300));
  if (idA) await appel('PATCH', '/api/adrasec/equipes/' + idA + '?g=43', { supprimer: true });
  const apresSup = sA.j.id ? (await appel('GET', '/api/secteurs')).j.secteurs.find((x) => x.id === sA.j.id) : null;
  if (apresSup && apresSup.equipe === null && apresSup.actif === false) ok('équipe ADRASEC supprimée : le secteur qui ne suivait qu’elle est désactivé, pas supprimé'); else ko('après suppression de l’équipe ADRASEC : ' + JSON.stringify(apresSup).slice(0, 200));
  if (sA.j.id) await appel('DELETE', '/api/secteurs/' + sA.j.id);
  if (compteMoi) await appel('PUT', '/api/adrasec/membres/' + compteMoi.id + '?g=43', { membre: true, equipe: ancienMoi.equipe || null, noeud: ancienMoi.noeud || null });
  if (!adActif) await appel('PUT', '/api/adrasec/reglages', { actif: false });
  await appel('DELETE', '/api/equipes/' + eq.j.id, { retirerDesNoeuds: false });
}

// Boîte « Identifiant du nœud à écouter » : propositions au fil de la frappe, clavier, champ qui reste libre
async function essaiSuggestionsNoeuds(navig, cookie) {
  console.log('Boîte de saisie : propositions de nœuds au fil de la frappe');
  for (const [nom, vue, mobile] of [['ordinateur', { width: 1400, height: 900 }, false], ['téléphone 390 px', { width: 390, height: 844 }, true]]) {
    const ctx = await navig.newContext({ viewport: vue, locale: 'fr-FR', ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    await ctx.addCookies([cookie]);
    await ctx.addInitScript(() => { try { localStorage.setItem('gaulix_visite', 'true'); localStorage.setItem('gaulix_langue', 'fr'); } catch { /* */ } });
    const { page, erreurs } = await ouvrir(ctx, '/');
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
    // Beaucoup de nœuds : on vérifie que la liste reste courte et que la frappe reste réactive
    await page.evaluate(() => {
      etat.noeuds.set(0x5a1e0043, { num: 0x5a1e0043, id: '!5a1e0043', nomCourt: 'MZN4', nomLong: 'Mézenc 43 relais' });
      etat.noeuds.set(0x5a1e0044, { num: 0x5a1e0044, id: '!5a1e0044', nomCourt: 'PUY1', nomLong: 'Le Puy-en-Velay 43' });
      for (let i = 0; i < 3000; i++) { const n = 0x60000000 + i; etat.noeuds.set(n, { num: n, id: '!' + n.toString(16), nomCourt: 'R' + i, nomLong: 'Remplissage ' + i }); }
      window.__portee = testPortee();
    });
    await page.waitForSelector('#dlg-saisir[open] #saisir-champ', { timeout: 5000 });
    // Accents et casse ignorés : « mezenc » trouve « Mézenc 43 relais »
    const t0 = Date.now();
    await page.locator('#saisir-champ').fill('mezenc');
    await page.waitForFunction(() => { const p = document.querySelector('#saisir-props'); return p && !p.hidden && p.children.length; }, null, { timeout: 4000 }).catch(() => {});
    const delai = Date.now() - t0;
    const l1 = await page.evaluate(() => ({
      nb: document.querySelectorAll('#saisir-props button').length,
      premier: (document.querySelector('#saisir-props button b') || {}).textContent || '',
      detail: (document.querySelector('#saisir-props button small') || {}).textContent || '',
      role: (document.querySelector('#saisir-props') || {}).getAttribute('role'),
      combo: document.querySelector('#saisir-champ').getAttribute('role'),
      deploye: document.querySelector('#saisir-champ').getAttribute('aria-expanded'),
      debordeX: document.querySelector('#dlg-saisir').scrollWidth > innerWidth + 1,
    }));
    if (l1.nb >= 1 && /Mézenc 43 relais/.test(l1.premier)) ok(`${nom} : « mezenc » propose « ${l1.premier} » (accents et casse ignorés)`); else ko(`${nom} : propositions : ` + JSON.stringify(l1));
    if (/!5a1e0043/.test(l1.detail)) ok(`${nom} : l’identifiant est montré sous le nom`); else ko(`${nom} : détail : ${l1.detail}`);
    if (l1.role === 'listbox' && l1.combo === 'combobox' && l1.deploye === 'true') ok(`${nom} : liste annoncée aux lecteurs d’écran (combobox / listbox)`); else ko(`${nom} : accessibilité : ` + JSON.stringify(l1));
    if (!l1.debordeX) ok(`${nom} : la boîte ne déborde pas en largeur`); else ko(`${nom} : la boîte déborde en largeur`);
    // Plafond des propositions avec 3 000 nœuds, et réactivité
    await page.locator('#saisir-champ').fill('r1');
    await page.waitForTimeout(400);
    const nb2 = await page.evaluate(() => document.querySelectorAll('#saisir-props button').length);
    if (nb2 > 0 && nb2 <= 8) ok(`${nom} : au plus 8 propositions avec 3 000 nœuds (${nb2})`); else ko(`${nom} : ${nb2} propositions`);
    if (delai < 3000) ok(`${nom} : propositions affichées en ${delai} ms`); else ko(`${nom} : propositions trop lentes (${delai} ms)`);
    // Clavier : ↓ vise la première, Entrée la prend et remplit le champ
    await page.locator('#saisir-champ').fill('puy');
    await page.waitForTimeout(400);
    await page.keyboard.press('ArrowDown');
    const vise1 = await page.evaluate(() => { const b = document.querySelector('#saisir-props button'); return { classe: b && b.classList.contains('vise'), choisi: b && b.getAttribute('aria-selected'), actif: document.querySelector('#saisir-champ').getAttribute('aria-activedescendant') }; });
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const apres = await page.evaluate(() => ({ valeur: document.querySelector('#saisir-champ').value, cachee: document.querySelector('#saisir-props').hidden, ouverte: !!document.querySelector('#dlg-saisir[open]') }));
    if (vise1.classe && vise1.choisi === 'true' && vise1.actif === 'saisir-prop-0') ok(`${nom} : ↓ vise la première proposition (annoncée)`); else ko(`${nom} : ↓ : ` + JSON.stringify(vise1));
    if (apres.valeur === '!5a1e0044' && apres.cachee && apres.ouverte) ok(`${nom} : Entrée prend la proposition et remplit le champ sans valider la boîte`); else ko(`${nom} : après Entrée : ` + JSON.stringify(apres));
    // Échap referme d'abord la liste, puis la boîte
    await page.locator('#saisir-champ').fill('mezenc');
    await page.waitForTimeout(400);
    await capture(page, 'suggestions-noeuds-' + (mobile ? 'telephone' : 'ordinateur'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const ech1 = await page.evaluate(() => ({ cachee: document.querySelector('#saisir-props').hidden, ouverte: !!document.querySelector('#dlg-saisir[open]') }));
    if (ech1.cachee && ech1.ouverte) ok(`${nom} : Échap referme la liste sans fermer la boîte`); else ko(`${nom} : premier Échap : ` + JSON.stringify(ech1));
    // Champ libre : un identifiant inconnu de la carte est accepté tel quel
    await page.locator('#saisir-champ').fill('!deadbeef');
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    const libre = await page.evaluate(() => ({ num: typeof portee !== 'undefined' ? portee.num : null, ouverte: !!document.querySelector('#dlg-saisir[open]') }));
    if (libre.num === 0xdeadbeef && !libre.ouverte) ok(`${nom} : un identifiant inconnu de la carte reste acceptable (écoute lancée)`); else ko(`${nom} : champ libre : ` + JSON.stringify(libre));
    await page.evaluate(() => { try { arreterPortee(); } catch { /* */ } });
    bilanErreurs(erreurs, `propositions de nœuds (${nom})`);
    await ctx.close();
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
    if (voulu('essaiCarteFrancais')) await essaiCarteFrancais(contexte);
    if (voulu('essaiAnglais')) await essaiAnglais(contexte);
    if (voulu('essaiConsultation')) await essaiConsultation(contexte);
    await contexte.close();
    if (voulu('essaiDemoVisiteur')) await essaiDemoVisiteur(navigateur);
    if (voulu('essaiAutresPresets')) await essaiAutresPresets(navigateur, cookie);
    if (voulu('essaiRejoindre')) await essaiRejoindre(navigateur, cookie);
    if (voulu('essaiRegistreEtExports')) await essaiRegistreEtExports(navigateur, cookie);
    if (voulu('essaiVue3D')) await essaiVue3D(navigateur);
    if (voulu('essaiProfil3D')) await essaiProfil3D(navigateur);
    if (voulu('essaiAdrasec')) await essaiAdrasec(navigateur, cookie);
    if (voulu('essaiAdrasecTransfert')) await essaiAdrasecTransfert(navigateur, cookie);
    if (voulu('essaiMotDePasseOublie')) await essaiMotDePasseOublie(navigateur, cookie);
    if (voulu('essaiSecours')) await essaiSecours(navigateur, cookie);
    if (voulu('essaiFrequentation')) await essaiFrequentation(navigateur, cookie);
    if (voulu('essaiPasserelleMembre')) await essaiPasserelleMembre(navigateur, cookie);
    if (voulu('essaiAdministrationALaDemande')) await essaiAdministrationALaDemande(navigateur, cookie);
    if (voulu('essaiAgentDirect')) await essaiAgentDirect(cookie);
    if (voulu('essaiUsbAuto')) await essaiUsbAuto(navigateur, cookie);
    if (voulu('essaiEcran150')) await essaiEcran150(navigateur);
    if (voulu('essaiTelephone')) await essaiTelephone(navigateur);
    if (voulu('essaiRechercheMessages')) await essaiRechercheMessages(navigateur, cookie);
    if (voulu('essaiUrgenceEtSecteurs')) await essaiUrgenceEtSecteurs(navigateur, cookie);
    if (voulu('essaiSecteursEquipes')) await essaiSecteursEquipes(navigateur, cookie);
    if (voulu('essaiSuggestionsNoeuds')) await essaiSuggestionsNoeuds(navigateur, cookie);
    if (voulu('essaiBandeauMonde')) await essaiBandeauMonde(navigateur, cookie);
    if (voulu('essaiDonateurs')) await essaiDonateurs(navigateur, cookie);
    if (voulu('essaiPartager')) await essaiPartager(navigateur, cookie);
    if (voulu('essaiRegistreAvance')) await essaiRegistreAvance(navigateur, cookie);

    if (voulu('essaiResumeOperations')) await essaiResumeOperations(navigateur, cookie);

    if (voulu('essaiBoutonsOutils')) await essaiBoutonsOutils(navigateur, cookie);
    if (voulu('essaiFenetres')) await essaiFenetres(navigateur, cookie);
    if (voulu('essaiConnexionsRepetees')) await essaiConnexionsRepetees(navigateur, cookie);
    if (voulu('essaiPagesPubliques')) await essaiPagesPubliques(navigateur);
    if (voulu('essaiTopologieFiche')) await essaiTopologieFiche(navigateur);
    if (voulu('essaiRapportArchives')) await essaiRapportArchives(navigateur, cookie);
    code = echecs ? 1 : 0;
    console.log(echecs ? `\n${echecs} problème(s) : captures et journal dans tests/resultats/` : '\nTout est bon ✓');
  } catch (e) {
    console.error('Essai interrompu :', e.message);
    code = 1;
  } finally {
    if (navigateur) await navigateur.close().catch(() => {});
    // Attendre la fin réelle du serveur : il peut encore écrire (relief, donateurs…) pendant la suppression du dossier
    if (serveur) { const fin = new Promise((r) => { serveur.once('exit', r); setTimeout(r, 5000); }); serveur.kill(); await fin; }
    if (fauxPat) fauxPat.close();
    try { fs.rmSync(donnees, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { console.error('Dossier d’essai non supprimé :', e.message); }
    process.exit(code);
  }
})();
