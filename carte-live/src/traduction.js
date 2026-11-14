'use strict';
// Langue du serveur : le code et ses messages sont écrits en français ; avec LANGUE=en, le journal (docker compose
// logs) passe par le même dictionnaire que l'interface (public/i18n-en.json) et sort en anglais. Les messages
// envoyés au navigateur (erreurs, diagnostic, alertes) sont traduits par l'interface selon la langue du visiteur.
// Les « {} » d'une entrée valent n'importe quel morceau variable, lui-même traduit s'il est connu.
const fs = require('fs');
const path = require('path');

const exact = new Map();
const motifs = new Map();
const prefixes = [];
const memo = new Map();
let charge = false;
const echap = (s) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
const norme = (s) => s.replace(/\s+/g, ' ').trim();

function charger() {
  if (charge) return;
  charge = true;
  let dico = {};
  try { dico = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n-en.json'), 'utf8')); } catch { /* sans dictionnaire : français */ }
  for (const [fr, en0] of Object.entries(dico)) {
    const en = en0 === '=' ? fr : en0;
    if (!en) continue;
    if (fr.includes('{}')) {
      const parts = fr.split('{}');
      let src = '^' + echap(parts[0]);
      for (let i = 1; i < parts.length; i++) src += (parts[i - 1] === '' && i > 1 ? '()' : /[a-zà-ÿ]$/i.test(parts[i - 1]) ? '(\\S{0,12}?)' : '([\\s\\S]*?)') + echap(parts[i]);
      const cle = (parts[0].match(/^(\S+)\s/) || ['', ''])[1]; // premier mot complet seulement (« ({} détections) » : aucun)
      if (!motifs.has(cle)) motifs.set(cle, []);
      motifs.get(cle).push({ re: new RegExp(src + '$'), en, morceaux: parts.filter((x) => x.trim()), poids: fr.replace(/\{\}/g, '').length });
    } else {
      exact.set(fr, en);
      if (fr.length >= 6 && /[a-zà-ÿ]$|[:…]$/i.test(fr)) prefixes.push(fr);
    }
  }
  for (const l of motifs.values()) l.sort((a, b) => b.poids - a.poids);
  prefixes.sort((a, b) => b.length - a.length);
}
const phraseFr = (v) => v.length > 20 && /[a-zà-ÿ]{3,}[ ’'][a-zà-ÿ]{2,} [a-zà-ÿ]{3,}/i.test(v);
function remplir(en, g) {
  const t = g.map((v) => (v == null ? '' : traduire(v, true)));
  if (g.some((v, i) => v && t[i] === v && phraseFr(v))) return null;
  let k = 0;
  return en.replace(/\{(\d*)\}/g, (_, n) => { const v = t[n === '' ? k++ : Number(n)]; return v == null ? '' : v; });
}
function traduire(t, interne) {
  charger();
  const s = norme(String(t));
  if (!s || !/[a-zà-ÿ]/i.test(s)) return t;
  if (memo.has(s)) return memo.get(s);
  let r = exact.get(s);
  if (r == null && s.length <= 800) {
    const premier = (s.match(/^\S+/) || [''])[0];
    for (const cle of [premier, '']) {
      const l = motifs.get(cle);
      if (!l) continue;
      for (const m of l) { if (s.length > m.poids + 160 || !m.morceaux.every((x) => s.includes(x))) continue; const g = m.re.exec(s); if (g) { r = remplir(m.en, g.slice(1)); if (r != null) break; } }
      if (r != null) break;
    }
  }
  if (r == null && !interne) {
    for (const p of prefixes) if (s.length > p.length + 1 && s.startsWith(p) && /^[\s:]*[A-Z0-9!«“"'(À-Ý]/.test(s.slice(p.length))) { r = exact.get(p) + s.slice(p.length); break; }
  }
  if (r == null) r = t;
  if (memo.size > 20000) memo.clear();
  memo.set(s, r);
  return r;
}

// Ligne de journal « [Module] message » : le préfixe entre crochets et le message sont traduits séparément
function traduireLigne(l) {
  const m = /^((?:\[[^\]]{1,40}\]\s*)+)([\s\S]*)$/.exec(l);
  if (!m) return traduire(l);
  const tags = m[1].replace(/\[([^\]]+)\]/g, (_, x) => `[${traduire(x)}]`);
  if (!m[2]) return tags;
  const complet = traduire(m[1].trim() + ' ' + m[2]);
  return complet !== m[1].trim() + ' ' + m[2] ? complet : tags + traduire(m[2]);
}

// Journal en anglais : console.log/error/warn traduisent leurs textes (l'horodatage ISO en tête est gardé)
function installerJournal(langue) {
  if (langue !== 'en') return;
  for (const f of ['log', 'error', 'warn']) {
    const o = console[f].bind(console);
    console[f] = (...a) => {
      try {
        const iso = typeof a[0] === 'string' && /^\d{4}-\d\d-\d\dT/.test(a[0]) ? [a.shift()] : [];
        const texte = a.map((x) => (x instanceof Error ? x.message : typeof x === 'string' ? x : (() => { try { return typeof x === 'object' ? JSON.stringify(x) : String(x); } catch { return String(x); } })())).join(' ');
        return o(...iso, traduireLigne(texte));
      } catch { return o(...a); }
    };
  }
}

module.exports = { traduire, traduireLigne, installerJournal };
