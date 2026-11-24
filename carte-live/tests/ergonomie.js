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
