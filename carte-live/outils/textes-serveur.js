// Textes du serveur sans traduction anglaise : node outils/textes-serveur.js (code de sortie 1 s'il en manque).
// Extrait les textes français de src/**/*.js (journal, erreurs, diagnostic, alertes…) et vérifie qu'ils passent par
// public/i18n-en.json (« {} » = partie variable). Demande acorn : npm i --no-save acorn acorn-walk
const fs = require('fs'), path = require('path');
const acorn = require('acorn'), walk = require('acorn-walk');
const APP = path.join(__dirname, '..');
const { traduire } = require(path.join(APP, 'src/traduction.js'));
const fichiers = [];
(function lister(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) lister(p); else if (f.endsWith('.js') && f !== 'traduction.js') fichiers.push(p); } })(path.join(APP, 'src'));
const FR = /[àâäçéèêëîïôöùûüœÀÂÇÉÈÊÎÔÛ]|\b(d|l|qu|n|s|j)['’]\w|\b(le|la|les|de|du|des|un|une|et|pas|est|sur|pour|avec|aucun|aucune|impossible|erreur|nœud|nœuds|introuvable|inconnu|requis|requise|connexion|depuis|dans|au|aux|par|ou|non|lu|lue|reçu|reçus|envoyé|déjà|trop|ce|cette|ces|son|sa|ses|il|elle|ne|canaux|canal|sujets|sujet|liens|relais|essai|lecture|envoi|toutes|tous|heures|jours|vers|sans|encore|plus|moins|très|quand|mais|donc|code|compte|mot|passe|réseau|carte|fichier|fichiers|dossier|serveur|port|nouvelle|nouveau|ancien|ancienne)\b/i;
const TAG = /^\[([^\]]{1,40})\]\s*/;
const res = new Map(), tags = new Set();
const ajouter = (t, f) => { t = t.replace(/\s+/g, ' ').trim(); if (!t || t.length < 3) return; if (!res.has(t)) res.set(t, f); };
for (const f of fichiers) {
  const src = fs.readFileSync(f, 'utf8');
  let ast; try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true }); } catch (e) { console.error('analyse', f, e.message); continue; }
  const texte = (n) => n.type === 'Literal' && typeof n.value === 'string' ? n.value : n.type === 'TemplateLiteral' ? n.quasis.map((q) => q.value.cooked).join('{}') : null;
  const appelJournal = new Set();
  walk.fullAncestor(ast, (n, anc) => {
    const t = texte(n); if (t == null) return;
    const p = anc[anc.length - 2];
    if (p && p.type === 'CallExpression' && p.callee.name === 'require') return;
    if (p && p.type === 'Property' && p.key === n) return;
    if (p && p.type === 'BinaryExpression' && /[=!]==?/.test(p.operator)) return;
    if (/^\s*(SELECT|INSERT|CREATE|UPDATE|DELETE|PRAGMA|ALTER|WITH|DROP|REPLACE)\b/i.test(t)) return;
    if (/^[\w.\-/:{}#%]+$/.test(t)) return; // identifiant, chemin, URL
    if (!FR.test(t)) return;
    if (/^https?:|<[a-z][^>]*>/i.test(t)) return; // URL, HTML
    let x = t, m;
    while ((m = TAG.exec(x))) { tags.add(m[1]); x = x.slice(m[0].length); }
    // Argument d'un appel de journal suivi d'autres arguments : la suite est variable
    const estJournal = p && p.type === 'CallExpression' && /journal|log|error|warn|etape/i.test((p.callee.name || (p.callee.property && p.callee.property.name) || '')) ;
    if (estJournal && p.arguments.indexOf(n) >= 0 && p.arguments.indexOf(n) < p.arguments.length - 1) x = x + ' {}';
    if (/^[\s{}:·.,()–-]*$/.test(x)) return;
    ajouter(x, path.relative(APP, f));
  });
}
const manque = {};
for (const [t, f] of res) { const e = t.replace(/\{\}/g, 'XYZ1'); const r = traduire(e); if (r === e || /[àâçéèêîôûœ]/i.test(String(r).replace(/XYZ1/g, ''))) manque[t] = f; }
for (const t of tags) { if (traduire(t) === t && FR.test(t)) manque[t] = 'tag'; }
// Ni texte d'interface ni message : SQL, noms propres, en-têtes HTTP, versions
const IGNORER = [/^\(?p\.(de|vers|port)\b|^AND p\.|^\(SELECT /, /Météo-France/, /^attachment;|^Mozilla|^carte-live-meshtastic\//, /^Département de la |^(Auvergne|Bourgogne|Centre|Grand Est|Île-de|Pays de la|Provence)/, /^s\|/, /^\{(niveau|relais)=/];
const dico = JSON.parse(fs.readFileSync(path.join(APP, 'public', 'i18n-en.json'), 'utf8'));
for (const k of Object.keys(manque)) if (IGNORER.some((r) => r.test(k)) || dico[k] === '=' || dico[k] === k) delete manque[k];
const l = Object.keys(manque);
console.log(`${res.size} textes du serveur, ${l.length} sans traduction anglaise (public/i18n-en.json ; « = » si identique)`);
for (const k of l) console.log(`  ${manque[k]} : ${k}`);
process.exit(l.length ? 1 : 0);
