// Liste les textes de l’interface qui n’ont pas encore de traduction anglaise : node outils/textes-a-traduire.js
// Extrait les fragments de texte français des sources (littéraux JS et HTML), ${…} remplacés par {}
const fs = require('fs');
const P = require('path').join(__dirname, '..', 'public') + '/';
const fichiers = ['index.html', 'app.js', 'ergonomie.js', 'meshcore.js', 'publique.js', 'publique.html', 'topologie.js', 'topologie.html', 'sim-maillage.js', 'animations.js'];
const frag = new Map();
function ajouter(t, f) {
  // découpe sur les balises HTML
  for (let x of t.split(/<[^>]*>/)) {
    x = x.replace(/\s+/g, ' ').trim();
    if (!x || x.length < 2) continue;
    if (!/[a-zà-ÿ]/i.test(x)) continue;
    if (/^[#.\/\[]|^https?:|^[a-z0-9_-]+$|^[a-z][a-zA-Z0-9_]*\(|=>|\bfunction\b|^\{\}$|^[a-z-]+:[^ ]/.test(x)) continue;
    const fr = /[éèêàùçôîœûâëïÉÈÀ’]/.test(x) || / [a-zà-ÿ’']{2,}/i.test(x) || /^[a-zà-ÿ]{4,}( ›)?$/.test(x) || /^[A-ZÀ-Ý][a-zà-ÿ]+[ …:?!.]*$/.test(x) || /^[^a-zA-Z]{1,4}[A-ZÀ-Ý][a-zà-ÿ]+/.test(x);
    if (!fr) continue;
    if (/^(var|calc|rgba?|hsl|url|translate|scale)\(/.test(x) || /;\s*[a-z-]+:/.test(x) || /^\d+px/.test(x)) continue;
    frag.set(x, (frag.get(x) || new Set()).add(f));
  }
}
// attributs title/placeholder/aria-label sont dans les gabarits : la découpe sur les balises les perd, on les reprend
function attributs(t, f) { for (const m of t.matchAll(/(?:title|placeholder|aria-label|alt|data-aide)="([^"]+)"/g)) ajouter(m[1].replace(/\$\{[^}]*\}/g, '{}'), f); }
function lireJs(s, f) {
  let i = 0;
  const n = s.length;
  function gabarit() { // après `
    let out = '';
    while (i < n) {
      const c = s[i];
      if (c === '\\') { out += s[i + 1]; i += 2; continue; }
      if (c === '`') { i++; return out; }
      if (c === '$' && s[i + 1] === '{') { i += 2; let prof = 1; const deb = i; code(() => prof === 0, (d) => (prof += d)); out += '{}'; continue; }
      out += c; i++;
    }
    return out;
  }
  function chaine(q) { let out = ''; while (i < n) { const c = s[i]; if (c === '\\') { out += s[i + 1] === 'n' ? '\n' : s[i + 1]; i += 2; continue; } if (c === q) { i++; return out; } if (c === '\n') return out; out += c; i++; } return out; }
  function code(fin, prof) {
    while (i < n) {
      const c = s[i];
      if (c === '/' && s[i + 1] === '/') { while (i < n && s[i] !== '\n') i++; continue; }
      if (c === '/' && s[i + 1] === '*') { i = s.indexOf('*/', i + 2) + 2; if (i < 2) i = n; continue; }
      if (c === '\'' || c === '"') { i++; const t = chaine(c); ajouter(t, f); attributs(t, f); continue; }
      if (c === '`') { i++; const t = gabarit(); ajouter(t, f); attributs(t, f); continue; }
      if (prof && c === '{') prof(1);
      if (prof && c === '}') { prof(-1); if (fin()) { i++; return; } }
      // regex littérale : on saute grossièrement /…/ après ( , = : [ ! & | ? ;
      if (c === '/' && /[(,=:\[!&|?;{}]\s*$/.test(s.slice(Math.max(0, i - 3), i))) { i++; while (i < n && s[i] !== '/' && s[i] !== '\n') { if (s[i] === '\\') i++; if (s[i] === '[') { while (i < n && s[i] !== ']') { if (s[i] === '\\') i++; i++; } } i++; } i++; continue; }
      i++;
    }
  }
  code(() => false, null);
}
for (const f of fichiers) {
  const s = fs.readFileSync(P + f, 'utf8');
  if (f.endsWith('.html')) {
    const sansScript = s.replace(/<script[\s\S]*?<\/script>/g, (m) => { lireJs(m.replace(/^<script[^>]*>|<\/script>$/g, ''), f); return ''; }).replace(/<style[\s\S]*?<\/style>/g, '');
    ajouter(sansScript, f); attributs(sansScript, f);
  } else lireJs(s, f);
}
const l = [...frag.keys()].sort();
const en = require(P + 'i18n-en.json');
const manque = l.filter((x) => !(x in en));
console.log(manque.join('\n'));
console.error(manque.length + ' texte(s) sans traduction anglaise (public/i18n-en.json ; « = » si identique)');
