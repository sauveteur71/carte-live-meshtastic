// Essais de l'ergonomie, sans navigateur : node --test tests/ergonomie.js
// Garde-fous sur ce qui se tient « à la source » : chaque entrée du menu Outils porte son niveau d'affichage, les
// pages /secours et /adrasec chargent le socle commun et n'ouvrent plus de boîte du navigateur.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const lire = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

test('menu Outils : chaque entrée porte son niveau d’affichage (data-niveau)', () => {
  const h = lire('index.html');
  const a = h.indexOf('<details class="menu-couches menu-outils">');
  const menu = h.slice(a, h.indexOf('</details>', a));
  const entrees = menu.match(/<(?:button|a)\b[^>]*class="bascule[^"]*"[^>]*>/g) || [];
  assert.ok(entrees.length >= 25, 'entrées du menu Outils trouvées');
  for (const e of entrees) assert.match(e, /data-niveau="(simple|operateur|expert)"/, 'entrée sans niveau : ' + e.slice(0, 90));
  // Les listes tenues à la main dans ergonomie.js ne nomment plus les entrées du menu
  const e = lire('ergonomie.js'), f = e.slice(e.indexOf('function etiqueterNiveaux'), e.indexOf('// ---- Rubriques'));
  assert.ok(f.length > 50 && !/#outil-|#lien-/.test(f), 'etiqueterNiveaux ne nomme plus les entrées du menu Outils');
  // Celles qui doivent rester visibles au niveau Simple (dont le réglage du niveau lui-même)
  for (const id of ['outil-affichage', 'outil-theme', 'outil-urgence', 'outil-secours', 'outil-adrasec']) assert.match(menu, new RegExp(`id="${id}"[^>]*data-niveau="simple"`), id);
});

test('pages /secours et /adrasec : socle commun, plus de boîte du navigateur', () => {
  for (const page of ['secours', 'adrasec']) {
    const html = lire(page + '.html'), js = lire(page + '.js');
    assert.ok(html.indexOf('/commun.js') > 0 && html.indexOf('/commun.js') < html.indexOf(`/${page}.js`), `${page}.html charge commun.js avant ${page}.js`);
    assert.doesNotMatch(js, /(?<![\w.])(confirm|prompt)\(/, `${page}.js : confirm() ou prompt() du navigateur`);
    assert.match(js, /installerSocle\(\{[^}]*aide: '[\w-]+'/, `${page}.js : aide « ? » installée`);
    assert.match(js, /fonctions: [^\n]*fonctionsDePage/, `${page}.js : recherche d’une fonction installée`);
  }
  const commun = lire('commun.js');
  for (const f of ['function confirmer(', 'function saisir(', 'function markdownSimple(', 'function installerSocle(', 'function fonctionsDePage(']) assert.ok(commun.includes(f), f);
  // Une seule définition : la carte prend aussi les siennes dans commun.js
  assert.doesNotMatch(lire('ergonomie.js'), /function (confirmer|saisir|markdownSimple)\(/);
  assert.ok(lire('index.html').indexOf('/commun.js') < lire('index.html').indexOf('/app.js'));
  // Les pages d'aide demandées existent dans le wiki
  for (const p of ['Espaces-Secours', 'Section-ADRASEC']) assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'wiki', p + '.md')), p);
});

// Dictionnaire des notions (commun.js) : lu sans navigateur
function notions() {
  const src = lire('commun.js');
  const i = src.indexOf('const NOTIONS = {'), j = src.indexOf("if (typeof window !== 'undefined') window.NOTIONS");
  return new Function(src.slice(i, j) + ';return NOTIONS;')();
}

test('aide dans les champs : chaque notion demandée par un champ existe, avec son explication', () => {
  const N = notions();
  const demandees = new Set();
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'public')).filter((x) => /\.(js|html)$/.test(x) && x !== 'commun.js')) for (const m of lire(f).matchAll(/data-notion="([\w-]+)"/g)) demandees.add(m[1]);
  assert.ok(demandees.size >= 20, `${demandees.size} notions demandées par les pages`);
  for (const k of demandees) assert.ok(N[k], `notion inconnue : ${k}`);
  for (const [k, n] of Object.entries(N)) {
    assert.ok(n.nom && n.aide && n.aide.length >= 30, `${k} : nom et explication`);
    assert.ok(typeof n.exemple === 'string', `${k} : exemple`);
    // L'exemple donné passe sa propre vérification
    if (n.verifier && n.exemple) assert.strictEqual(n.verifier(n.exemple), '', `${k} : son exemple « ${n.exemple} » est refusé`);
  }
});

test('aide dans les champs : mêmes verdicts que le serveur sur la forme', () => {
  const N = notions();
  const { numeroNoeud } = require('../src/secours');
  const cas = [['numeroNoeud', '!a1b2c3d4', 1], ['numeroNoeud', 'a1b2c3d4', 1], ['numeroNoeud', '305419896', 1], ['numeroNoeud', '!a1b2', 0], ['numeroNoeud', 'zzzzzzzz', 0],
    ['indicatif', 'f4gld', 1], ['indicatif', 'F4GLD/P', 1], ['indicatif', 'PASBON', 0], ['mqttUrl', 'mqtt://10.0.0.1:1883', 1], ['mqttUrl', '10.0.0.1', 0], ['iata', 'LPY', 1], ['iata', 'L', 0],
    ['locator', 'JN15XC33', 1], ['locator', 'jn15', 1], ['locator', 'JN1', 0], ['latitude', '45.04', 1], ['latitude', '45,04', 0], ['latitude', '95', 0], ['longitude', '-181', 0],
    ['gisement', '125,5', 1], ['gisement', '400', 0], ['incertitude', '0.2', 0], ['motDePasse', '1234567', 0], ['motDePasse', '12345678', 1], ['email', 'a@b.fr', 1], ['email', 'a@b', 0],
    ['courriels', 'a@b.fr, c@d.fr', 1], ['courriels', 'a@b.fr, c', 0], ['codeEspace', 'festival-2027', 1], ['codeEspace', 'Festival', 0], ['codeEspace', 'ab', 0], ['departement', '2a', 1], ['departement', '4', 0],
    ['cleCanal', '1PG7OiApB1nwvP+rz05pAQ==', 1], ['cleCanal', 'AQ==', 0], ['canauxCles', 'LongFast=AQ==\nMonCanal=1PG7OiApB1nwvP+rz05pAQ==', 1], ['canauxCles', 'LongFast', 0],
    ['hoteModule', '192.168.1.50', 1], ['hoteModule', 'http://192.168.1.50', 0], ['listeNoeuds', '!a1b2c3d4, !e5f6a7b8', 1], ['listeNoeuds', '!a1b2c3d4, toto', 0],
    ['mqttRacine', 'msh/EU_868', 1], ['mqttRacine', 'msh/#', 0], ['brokers', 'mqtt://a:1883\nwss://b', 1], ['brokers', 'a:1883', 0], ['iataVoisins', 'CFE, LYS', 1], ['identifiant', 'ab', 0]];
  for (const [k, v, bon] of cas) assert.strictEqual(N[k].verifier(v) === '', !!bon, `${k} « ${v} »`);
  // Numéro de nœud : exactement la règle du serveur
  for (const v of ['!a1b2c3d4', 'A1B2C3D4', '305419896', '!a1b2', '0', 'toto', '12345678901']) {
    let serveur = true; try { numeroNoeud(v); } catch { serveur = false; }
    assert.strictEqual(N.numeroNoeud.verifier(v) === '', serveur, `numéro de nœud « ${v} »`);
  }
});
