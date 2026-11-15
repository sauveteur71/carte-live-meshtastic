// Langue de l'interface : français (texte d'origine), anglais, espagnol, allemand, italien, portugais, néerlandais,
// polonais ou tchèque, traduits à l'affichage. Le code reste écrit en français ; dans une autre langue, chaque texte affiché (nœuds texte, title,
// placeholder, aria-label, boîtes alert/confirm/prompt) passe par le dictionnaire /i18n-xx.json, complété par
// l'anglais pour ce qui n'y est pas encore. Les « {} » d'une entrée valent n'importe quel morceau variable (nom,
// nombre…), lui-même traduit s'il est connu. Le contenu des utilisateurs (messages, noms) porte translate="no" et
// n'est jamais touché.
(function () {
  const LANGUES = { fr: 'Français', en: 'English', es: 'Español', de: 'Deutsch', it: 'Italiano', pt: 'Português', nl: 'Nederlands', pl: 'Polski', cs: 'Čeština' };
  const LOCALES = { fr: 'fr-FR', en: 'en-GB', es: 'es-ES', de: 'de-DE', it: 'it-IT', pt: 'pt-PT', nl: 'nl-NL', pl: 'pl-PL', cs: 'cs-CZ' };
  const DEFAUT = 'en'; // langue par défaut de l'édition quand celle du navigateur n'est pas proposée
  const lire = () => { try { return localStorage.getItem('gaulix_langue'); } catch { return null; } };
  const nav = String(navigator.language || '').slice(0, 2).toLowerCase();
  let choix = lire() || (LANGUES[nav] ? nav : DEFAUT);
  if (!LANGUES[choix]) choix = DEFAUT;
  window.LANGUES = LANGUES;
  window.LANGUE = choix;
  window.LOCALE = LOCALES[choix];
  window.choisirLangue = (l) => { try { localStorage.setItem('gaulix_langue', l); } catch { /* navigation privée */ } location.reload(); };
  // Liste <option> des langues, pour les sélecteurs de l'interface
  window.optionsLangues = () => Object.entries(LANGUES).map(([k, v]) => `<option value="${k}" ${k === choix ? 'selected' : ''}>${v}</option>`).join('');
  // Traduction d'un texte isolé (pour le code qui en a besoin) : identité en français
  window.tr = (t) => t;
  if (choix === 'fr') return;
  document.documentElement.lang = choix;
  // Dates et nombres écrits « à la française » dans le code : au format de la langue choisie
  const loc = (l) => (l === 'fr-FR' || l === 'fr' ? LOCALES[choix] : l);
  for (const [P, fs] of [[Date.prototype, ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']], [Number.prototype, ['toLocaleString']]]) {
    for (const f of fs) { const o = P[f]; P[f] = function (l, ...r) { return o.call(this, loc(l), ...r); }; }
  }

  const exact = new Map(); // texte -> traduction
  const motifs = new Map(); // premier mot littéral (ou '') -> [{ re, en }]
  const prefixes = []; // entrées qui peuvent ouvrir un texte plus long (« Message direct de » + nom)
  const memo = new Map();
  let pret = false;
  const echap = (s) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const norme = (s) => s.replace(/\s+/g, ' ').trim();
  function charger(dico) {
    for (const [fr, en] of Object.entries(dico)) {
      if (!en) continue;
      if (fr.includes('{}')) {
        const parts = fr.split('{}');
        // Deux variables collées : la seconde reste vide (évite les retours arrière sans fin des expressions)
        let src = '^' + echap(parts[0]);
        for (let i = 1; i < parts.length; i++) src += (parts[i - 1] === '' && i > 1 ? '()' : /[a-zà-ÿ]$/i.test(parts[i - 1]) ? '(\\S{0,12}?)' : '([\\s\\S]*?)') + echap(parts[i]);
        const re = new RegExp(src + '$');
        const cle = (parts[0].match(/^(\S+)\s/) || ['', ''])[1]; // premier mot complet seulement (« ({} détections) » : aucun)
        if (!motifs.has(cle)) motifs.set(cle, []);
        motifs.get(cle).push({ re, en, morceaux: parts.filter((x) => x.trim()), poids: fr.replace(/\{\}/g, '').length });
      } else {
        exact.set(fr, en);
        if (fr.length >= 6 && /[a-zà-ÿ]$|[:…]$/i.test(fr)) prefixes.push(fr);
      }
    }
    for (const l of motifs.values()) l.sort((a, b) => b.poids - a.poids);
    prefixes.sort((a, b) => b.length - a.length);
  }
  // Remplit « Message sur {} » → « Message on {} » ; {0} {1}… pour changer l'ordre
  // Une variable longue restée en français (phrase non reconnue) : le motif ne convient pas, on n'en fait pas un mélange
  const phraseFr = (v) => v.length > 20 && /[a-zà-ÿ]{3,}[ ’'][a-zà-ÿ]{2,} [a-zà-ÿ]{3,}/i.test(v);
  function remplir(en, g) {
    const t = g.map((v) => (v == null ? '' : traduire(v, true)));
    if (g.some((v, i) => v && t[i] === v && phraseFr(v))) return null;
    let k = 0;
    return en.replace(/\{(\d*)\}/g, (_, n) => { const v = t[n === '' ? k++ : Number(n)]; return v == null ? '' : v; });
  }
  function traduire(t, interne) {
    const s = norme(t);
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
      // Début connu suivi d'un nom ou d'une valeur
      for (const p of prefixes) if (s.length > p.length + 1 && s.startsWith(p) && /^[\s:]*[A-Z0-9!«“"'(À-Ý]/.test(s.slice(p.length))) { r = exact.get(p) + s.slice(p.length); break; }
    }
    if (r == null) r = t;
    if (memo.size > 20000) memo.clear();
    memo.set(s, r);
    return r;
  }
  window.tr = (t) => (pret ? traduire(String(t)) : t);
  const poses = new WeakMap(); // nœuds texte déjà traduits par nous : valeur posée
  const IGNORER = 'script,style,textarea,code,pre,[translate="no"],.notranslate,.leaflet-tile-pane';
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
  function traduireNoeud(n) {
    if (n.nodeType === 3) {
      const p = n.parentElement;
      if (!p || p.closest(IGNORER)) return;
      const v = n.nodeValue;
      if (!/[a-zà-ÿ]/i.test(v)) return;
      if (poses.get(n) === v) return;
      const r = traduire(v);
      if (r !== v) {
        const avant = v.match(/^\s*/)[0], apres = v.match(/\s*$/)[0];
        n.nodeValue = avant + norme(r) + apres;
        poses.set(n, n.nodeValue);
      }
      return;
    }
    if (n.nodeType !== 1) return;
    if (n.closest(IGNORER)) return;
    traduireAttrs(n);
    const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (x) => (x.nodeType === 1 && x.matches(IGNORER) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let x;
    while ((x = w.nextNode())) { if (x.nodeType === 3) traduireNoeud(x); else traduireAttrs(x); }
  }
  function traduireAttrs(e) {
    for (const a of ATTRS) {
      const v = e.getAttribute(a);
      if (v && /[a-zà-ÿ]/i.test(v)) { const r = traduire(v); if (r !== v) e.setAttribute(a, r); }
    }
    if (e.tagName === 'INPUT' && (e.type === 'button' || e.type === 'submit') && e.value) { const r = traduire(e.value); if (r !== e.value) e.value = r; }
  }
  let titre = null;
  function demarrer() {
    pret = true;
    traduireNoeud(document.body);
    titre = traduire(document.title); document.title = titre;
    new MutationObserver((l) => {
      for (const m of l) {
        if (m.type === 'childList') m.addedNodes.forEach(traduireNoeud);
        else if (m.type === 'characterData') traduireNoeud(m.target);
        else if (m.type === 'attributes') traduireAttrs(m.target);
      }
      if (document.title !== titre) { titre = traduire(document.title); if (titre !== document.title) document.title = titre; }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  // Boîtes du navigateur
  for (const f of ['alert', 'confirm', 'prompt']) {
    const o = window[f].bind(window);
    window[f] = (m, ...r) => o(m == null ? m : String(m).split('\n').map((l) => traduire(l)).join('\n'), ...r);
  }
  const v = (document.currentScript && document.currentScript.src.match(/\?v=([^&]+)/)) || [];
  const dico = (l) => fetch(`/i18n-${l}.json` + (v[1] ? '?v=' + v[1] : '')).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  Promise.all([dico('en'), choix === 'en' ? {} : dico(choix)])
    .then(([en, autre]) => {
      // Entrée « = » : identique au français ; sans traduction dans la langue choisie : l'anglais
      const d = {};
      for (const [k, x] of Object.entries(en)) d[k] = x === '=' ? k : x;
      for (const [k, x] of Object.entries(autre)) if (x) d[k] = x === '=' ? k : x;
      charger(d);
      if (document.body) demarrer(); else document.addEventListener('DOMContentLoaded', demarrer);
    })
    .catch(() => { /* dictionnaire indisponible : l'interface reste en français */ });
})();
