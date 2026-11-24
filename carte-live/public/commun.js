'use strict';
// Socle commun à toutes les pages (la carte, /secours, /adrasec) : confirmation et saisie dans l'interface à la
// place des boîtes du navigateur, annonces en bas d'écran, rendu de l'aide (pages du wiki), et, pour les pages
// qui ne sont pas la carte : bouton « ? » d'aide, recherche d'une fonction (Ctrl+K) et styles de ces fenêtres.
// Chargé avant les autres scripts de la page. Ne dépend d'aucun d'eux.
const escCommun = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---- Confirmation dans l'interface (remplace confirm() du navigateur) -----------------------------------------
function confirmer(texte, { ok = 'Confirmer', annuler = 'Annuler' } = {}) {
  return new Promise((resoudre) => {
    let d = document.getElementById('dlg-confirmer');
    if (!d) {
      d = document.createElement('dialog');
      d.id = 'dlg-confirmer'; d.className = 'dlg-confirmer';
      d.setAttribute('aria-labelledby', 'confirmer-texte');
      document.body.appendChild(d);
    }
    const danger = /supprim|effac|retir|désactiv|termin|forcer|interromp|remettre à zéro|nouvelle clé|seront remplacés/i.test(texte);
    d.innerHTML = `<p id="confirmer-texte"></p><div class="actions-confirmer"><button type="button" data-r="0">${escCommun(annuler)}</button><button type="button" data-r="1" class="${danger ? 'danger' : 'principal'}">${escCommun(ok)}</button></div>`;
    d.querySelector('p').textContent = texte;
    const fin = (v) => { d.onclose = null; if (d.open) d.close(); resoudre(v); };
    d.querySelectorAll('[data-r]').forEach((b) => (b.onclick = () => fin(b.dataset.r === '1')));
    d.onclose = () => resoudre(false); // Échap
    d.onclick = (e) => { if (e.target === d) { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) fin(false); } };
    d.showModal();
    d.querySelector('[data-r="1"]').focus();
  });
}
// Saisie dans l'interface (remplace prompt() du navigateur) : renvoie le texte, ou null si annulé.
// options.type : type du champ (« password »…) ; options.exemple : exemple en filigrane ; options.aide : une ligne
// d'explication sous le champ. options.suggestions : fonction optionnelle, appelée au fil de la frappe avec ce qui est tapé, qui renvoie une
// liste de propositions [{ valeur, libelle, detail }]. Choisir une proposition remplit le champ, qui reste
// toujours LIBRE : on peut valider un texte qui n'est dans aucune proposition (écouter un nœud encore inconnu,
// par exemple). Clavier : ↓ ↑ pour parcourir, Entrée pour prendre la proposition visée, Échap pour refermer la
// liste (un second Échap ferme la boîte). Les appels qui ne passent pas « suggestions » ne changent pas.
function saisir(texte, defaut = '', options = {}) {
  return new Promise((resoudre) => {
    let d = document.getElementById('dlg-saisir');
    if (!d) { d = document.createElement('dialog'); d.id = 'dlg-saisir'; d.className = 'dlg-confirmer'; d.setAttribute('aria-labelledby', 'saisir-texte'); document.body.appendChild(d); }
    d.innerHTML = '<form method="dialog"><p id="saisir-texte"></p><input id="saisir-champ" autocomplete="off"><div class="propositions-saisir" id="saisir-props" role="listbox" aria-label="Propositions" hidden></div><div class="actions-confirmer"><button type="button" data-r="0">Annuler</button><button type="submit" class="principal">Valider</button></div></form>';
    d.querySelector('p').textContent = texte;
    const champ = d.querySelector('input');
    if (options.type) champ.type = options.type;
    if (options.exemple) champ.placeholder = options.exemple;
    if (options.aide) { const n = document.createElement('p'); n.className = 'note aide-saisir'; n.textContent = options.aide; champ.after(n); }
    champ.value = defaut == null ? '' : String(defaut);
    let rendu = false;
    const fin = (v) => { if (rendu) return; rendu = true; d.onclose = null; if (d.open) d.close(); resoudre(v); };
    d.querySelector('[data-r="0"]').onclick = () => fin(null);
    d.querySelector('form').onsubmit = (e) => { e.preventDefault(); fin(champ.value); };
    d.onclose = () => fin(null);
    const suggerer = typeof options.suggestions === 'function' ? options.suggestions : null;
    const props = d.querySelector('#saisir-props');
    if (suggerer) {
      let choix = [], vise = -1, minuterie = null;
      champ.setAttribute('role', 'combobox');
      champ.setAttribute('aria-autocomplete', 'list');
      champ.setAttribute('aria-controls', 'saisir-props');
      champ.setAttribute('aria-expanded', 'false');
      const fermer = () => { props.hidden = true; props.innerHTML = ''; choix = []; vise = -1; champ.setAttribute('aria-expanded', 'false'); champ.removeAttribute('aria-activedescendant'); };
      const viser = (i) => {
        vise = i;
        [...props.children].forEach((b, k) => { const a = k === i; b.classList.toggle('vise', a); b.setAttribute('aria-selected', a ? 'true' : 'false'); if (a) b.scrollIntoView({ block: 'nearest' }); });
        if (i >= 0) champ.setAttribute('aria-activedescendant', 'saisir-prop-' + i); else champ.removeAttribute('aria-activedescendant');
      };
      const prendre = (i) => { const c = choix[i]; if (!c) return; champ.value = String(c.valeur); fermer(); champ.focus(); };
      const proposer = () => {
        let l = [];
        try { l = suggerer(champ.value) || []; } catch { l = []; } // une proposition en panne ne doit pas bloquer la saisie
        choix = l.slice(0, 10);
        if (!choix.length) { fermer(); return; }
        props.innerHTML = choix.map((c, i) => `<button type="button" role="option" id="saisir-prop-${i}" aria-selected="false" data-i="${i}"><b>${escCommun(c.libelle)}</b>${c.detail ? `<small>${escCommun(c.detail)}</small>` : ''}</button>`).join('');
        props.hidden = false;
        champ.setAttribute('aria-expanded', 'true');
        viser(-1);
      };
      // Au fil de la frappe, mais pas à chaque touche : la liste est refaite après une courte pause
      champ.addEventListener('input', () => { clearTimeout(minuterie); minuterie = setTimeout(proposer, 120); });
      props.addEventListener('mousedown', (e) => { const b = e.target.closest('[data-i]'); if (b) { e.preventDefault(); prendre(Number(b.dataset.i)); } });
      champ.addEventListener('keydown', (e) => {
        if (props.hidden) { if (e.key === 'ArrowDown') { e.preventDefault(); clearTimeout(minuterie); proposer(); } return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); viser(vise + 1 >= choix.length ? 0 : vise + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); viser(vise <= 0 ? choix.length - 1 : vise - 1); }
        else if ((e.key === 'Enter' || e.key === 'Tab') && vise >= 0) { e.preventDefault(); prendre(vise); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fermer(); } // Échap referme la liste ; un second ferme la boîte
      });
      if (champ.value) setTimeout(proposer, 0);
    }
    d.showModal();
    champ.focus(); champ.select();
  });
}

// ---- Rendu de l'aide : Markdown simple des pages du wiki ------------------------------------------------------
function markdownSimple(md) {
  const enLigne = (t) => escCommun(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/!\[([^\]]*)\]\((https:[^)\s]+\.(?:jpg|png|webp))\)/g, '<img class="capture-aide" src="$2" alt="$1" loading="lazy">')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, a, b) => `<a href="#" data-aide="${(b || a).trim().replace(/ /g, '-')}">${a.trim()}</a>`)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let liste = null, code = false;
  const fermerListe = () => { if (liste) { out.push(`</${liste}>`); liste = null; } };
  for (const l of md.split('\n')) {
    if (/^```/.test(l)) { fermerListe(); out.push(code ? '</pre>' : '<pre>'); code = !code; continue; }
    if (code) { out.push(escCommun(l)); continue; }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { fermerListe(); const n = Math.min(4, m[1].length + 1); out.push(`<h${n}>${enLigne(m[2])}</h${n}>`); }
    else if ((m = l.match(/^\s*[-*]\s+(.*)/))) { if (liste !== 'ul') { fermerListe(); out.push('<ul>'); liste = 'ul'; } out.push(`<li>${enLigne(m[1])}</li>`); }
    else if ((m = l.match(/^\s*\d+\.\s+(.*)/))) { if (liste !== 'ol') { fermerListe(); out.push('<ol>'); liste = 'ol'; } out.push(`<li>${enLigne(m[1])}</li>`); }
    else if (/^\s*\|/.test(l)) { fermerListe(); if (!/^\s*\|[\s:|-]+\|\s*$/.test(l)) out.push(`<p class="ligne-tableau">${enLigne(l.replace(/^\s*\||\|\s*$/g, '').replace(/\|/g, ' · '))}</p>`); }
    else if (!l.trim()) fermerListe();
    else { fermerListe(); out.push(`<p>${enLigne(l)}</p>`); }
  }
  fermerListe();
  if (code) out.push('</pre>');
  return out.join('\n');
}

// ---- Annonces en bas d'écran (les pages sans app.js ; la carte garde la sienne, plus complète) -----------------
function annonceCommune(texte, genre = 'info') {
  let z = document.getElementById('annonces');
  if (!z) { z = document.createElement('div'); z.id = 'annonces'; z.setAttribute('aria-live', 'polite'); document.body.appendChild(z); }
  const d = document.createElement('div');
  d.className = 'annonce ' + genre;
  d.textContent = texte;
  d.onclick = () => d.remove();
  z.appendChild(d);
  setTimeout(() => d.remove(), genre === 'erreur' ? 9000 : 6000);
}

// ---- Pages hors de la carte : styles de ces fenêtres, aide « ? » et recherche d'une fonction --------------------
// La carte a tout cela dans style.css et ergonomie.js ; les pages /secours et /adrasec ont leur propre feuille,
// avec les mêmes couleurs (--fond, --texte, --bord, --accent…).
const PAGE_AUTONOME = !document.querySelector('link[href*="style.css"]');
if (PAGE_AUTONOME) {
  const st = document.createElement('style');
  st.textContent = `
#annonces { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 3000; display: flex; flex-direction: column; gap: 6px; align-items: center; pointer-events: none; max-width: calc(100vw - 24px); }
.annonce { pointer-events: auto; background: #0f172a; color: #f8fafc; border: 2px solid var(--accent); border-radius: 10px; padding: 9px 14px; font-weight: 600; box-shadow: 0 4px 14px rgba(0,0,0,.55); cursor: pointer; }
.annonce.ok { border-color: var(--ok); } .annonce.erreur { border-color: var(--critique); }
.dlg-confirmer, .dlg-commun { padding: 16px; border-radius: 12px; border: 1px solid var(--bord); background: var(--fond); color: var(--texte); }
.dlg-confirmer { width: min(460px, calc(100vw - 32px)); }
.dlg-commun { width: min(760px, calc(100vw - 32px)); max-height: calc(100vh - 48px); }
.dlg-confirmer::backdrop, .dlg-commun::backdrop { background: rgba(0,0,0,.6); }
.dlg-confirmer p { margin: 0 0 14px; line-height: 1.5; white-space: pre-line; font-size: 15px; }
.dlg-confirmer p.aide-saisir { margin: 6px 0 0; font-size: 13.5px; color: var(--doux); }
.dlg-confirmer input, .dlg-commun input[type=search] { width: 100%; padding: 9px 10px; border-radius: 8px; border: 1px solid var(--bord); background: var(--surface-2); color: var(--texte); font: inherit; }
.actions-confirmer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; flex-wrap: wrap; }
.actions-confirmer button { padding: 8px 14px; min-height: 40px; border-radius: 8px; border: 1px solid var(--bord); background: rgba(255,255,255,.08); color: inherit; cursor: pointer; font-weight: 600; }
.actions-confirmer button.principal { background: var(--accent); color: #062019; border-color: var(--accent); }
.actions-confirmer button.danger { background: #dc2626; color: #fff; border-color: #dc2626; }
.propositions-saisir { display: flex; flex-direction: column; gap: 2px; margin: 6px 0 2px; max-height: 42vh; overflow-y: auto; border: 1px solid var(--bord); border-radius: 8px; }
.propositions-saisir button { display: flex; flex-direction: column; align-items: flex-start; width: 100%; text-align: left; padding: 8px 10px; min-height: 40px; border: 0; border-radius: 6px; background: none; color: var(--texte); cursor: pointer; font: inherit; }
.propositions-saisir button small { color: var(--doux); font-size: 12px; }
.propositions-saisir button.vise, .propositions-saisir button:hover { background: var(--accent); color: #062019; }
.propositions-saisir button.vise small, .propositions-saisir button:hover small { color: #06382c; }
.tete-commun { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.tete-commun h2 { margin: 0; font-size: 17px; flex: 1; }
.fil-position { font-size: 13px; color: var(--doux); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tete-commun button, .btn-commun { min-height: 36px; min-width: 36px; padding: 4px 10px; border-radius: 8px; border: 1px solid var(--bord); background: var(--surface-2); color: var(--texte); cursor: pointer; font: inherit; font-weight: 650; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
.btn-commun:hover, .tete-commun button:hover { border-color: var(--accent); }
.corps-aide { overflow: auto; max-height: calc(100vh - 150px); line-height: 1.55; font-size: 15px; }
.corps-aide h2, .corps-aide h3, .corps-aide h4 { margin: 16px 0 6px; }
.corps-aide a { color: var(--accent); }
.corps-aide code { background: var(--surface-2); padding: 1px 5px; border-radius: 4px; }
.corps-aide pre { background: var(--surface-2); padding: 10px; border-radius: 8px; overflow: auto; }
.corps-aide img { max-width: 100%; border-radius: 8px; }
.corps-aide .ligne-tableau { margin: 2px 0; padding: 4px 8px; background: var(--surface-2); border-radius: 6px; }
.res-commun { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; max-height: 55vh; overflow: auto; }
.res-commun button { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; width: 100%; text-align: left; padding: 9px 10px; min-height: 42px; border: 0; border-radius: 6px; background: none; color: var(--texte); cursor: pointer; font: inherit; }
.res-commun button small { color: var(--doux); }
.res-commun button.actif, .res-commun button:hover { background: var(--accent); color: #062019; }
.res-commun button.actif small, .res-commun button:hover small { color: #06382c; }
.dlg-commun .note { color: var(--doux); font-size: 13px; margin: 8px 0 0; }
:focus-visible { outline: 3px solid #fbbf24; outline-offset: 1px; }`;
  document.head.appendChild(st);
  if (typeof window.annonce !== 'function') window.annonce = annonceCommune;
  // Les messages d'erreur ou d'information passent par les annonces en bas de l'écran
  window.alert = (t) => annonceCommune(String(t), /^✔|envoy|enregistr|copi/i.test(String(t)) ? 'ok' : 'erreur');
}
const sansAccentCommun = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function fenetreCommune(id, titre) {
  let d = document.getElementById(id);
  if (!d) { d = document.createElement('dialog'); d.id = id; d.className = 'dlg-commun'; d.setAttribute('aria-label', titre); document.body.appendChild(d); d.addEventListener('click', (e) => { if (e.target === d) { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); } }); }
  return d;
}
// Aide de la page : la page du wiki, dans une fenêtre (les liens [[…]] ouvrent les autres pages d'aide)
async function ouvrirAideCommune(page) {
  const d = fenetreCommune('dlg-aide-commune', 'Aide');
  d.innerHTML = '<div class="tete-commun"><h2>Aide</h2><button type="button" data-fermer aria-label="Fermer l’aide">✕</button></div><div class="corps-aide">Chargement de l’aide…</div>';
  d.querySelector('[data-fermer]').onclick = () => d.close();
  if (!d.open) d.showModal();
  const z = d.querySelector('.corps-aide');
  try {
    const r = await fetch('/api/aide/' + encodeURIComponent(page));
    const j = await r.json();
    if (!r.ok) throw new Error(j.erreur || 'Erreur ' + r.status);
    z.innerHTML = markdownSimple(j.texte);
    z.scrollTop = 0;
    z.querySelectorAll('[data-aide]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); ouvrirAideCommune(a.dataset.aide); }));
  } catch (e) { z.textContent = `Aide indisponible sur ce serveur (${e.message}).`; }
}
// Recherche d'une fonction de la page (Ctrl+K). fonctions() → [{ t: titre, ch: où elle se trouve, m: mots-clés, go }]
function ouvrirRechercheCommune(fonctions) {
  const d = fenetreCommune('dlg-recherche-commune', 'Chercher une fonction');
  d.innerHTML = '<div class="tete-commun"><h2>🔎 Chercher une fonction</h2><button type="button" data-fermer aria-label="Fermer la recherche">✕</button></div><input type="search" placeholder="ex. équipe, nœud, mot de passe, point de rassemblement…" aria-label="Chercher une fonction" autocomplete="off"><div class="res-commun" role="listbox"></div><p class="note">↑ ↓ pour choisir, Entrée pour y aller, Échap pour fermer · Ctrl+K pour rouvrir</p>';
  d.querySelector('[data-fermer]').onclick = () => d.close();
  const inp = d.querySelector('input'), zr = d.querySelector('.res-commun');
  let index = [];
  try { index = fonctions() || []; } catch { index = []; }
  let res = [], sel = 0;
  const aller = (i) => { const e = res[i]; if (!e) return; d.close(); try { e.go(); } catch (x) { annonceCommune('⚠ ' + x.message, 'erreur'); } };
  const rendre = () => {
    const mots = sansAccentCommun(inp.value).split(/\s+/).filter(Boolean);
    res = (!mots.length ? index : index.filter((e) => { const h = sansAccentCommun(`${e.t} ${e.ch || ''} ${e.m || ''}`); return mots.every((w) => h.includes(w)); })).slice(0, 14);
    sel = Math.min(sel, Math.max(0, res.length - 1));
    zr.innerHTML = res.length ? res.map((e, i) => `<button type="button" role="option" class="${i === sel ? 'actif' : ''}" data-i="${i}"><b>${escCommun(e.t)}</b><small>${escCommun(e.ch || '')}</small></button>`).join('') : '<p class="note">Aucune fonction trouvée. Essayez un autre mot.</p>';
    zr.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => aller(Number(b.dataset.i))));
  };
  inp.oninput = () => { sel = 0; rendre(); };
  inp.onkeydown = (ev) => {
    if (ev.key === 'ArrowDown') { sel = Math.min(sel + 1, res.length - 1); rendre(); ev.preventDefault(); }
    else if (ev.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); rendre(); ev.preventDefault(); }
    else if (ev.key === 'Enter') { aller(sel); ev.preventDefault(); }
  };
  rendre();
  if (!d.open) d.showModal();
  inp.focus();
}
// Fonctions d'une page à onglets, relevées dans la page elle-même au moment de chercher : chaque onglet visible, puis
// chaque titre (h2, h3, résumé d'un bloc repliable) de chaque vue. Rien à tenir à jour à la main : un bloc ajouté à
// la page devient cherchable. data-chercher="mots clés" sur un titre ou un onglet ajoute des mots à la recherche.
function fonctionsDePage() {
  const l = [], vus = new Set();
  const propre = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  for (const b of document.querySelectorAll('nav.onglets button[data-vue]')) {
    if (b.hidden) continue;
    const nomOnglet = propre(b.textContent);
    l.push({ t: nomOnglet, ch: 'Onglet', m: b.dataset.chercher || b.title || '', go: () => b.click() });
    const vue = document.getElementById('vue-' + b.dataset.vue);
    if (!vue) continue;
    for (const h of vue.querySelectorAll('h2, h3, summary')) {
      if (h.closest('[hidden]')) continue;
      const t = propre(h.childNodes.length ? [...h.childNodes].filter((n) => n.nodeType === 3 || (n.nodeType === 1 && !n.matches('.pastille, button, small'))).map((n) => n.textContent).join(' ') : h.textContent);
      const cle = nomOnglet + '|' + t;
      if (!t || t.length < 3 || vus.has(cle)) continue;
      vus.add(cle);
      l.push({ t, ch: nomOnglet, m: h.dataset.chercher || '', go: () => {
        b.click();
        // Le titre est relu après le changement d'onglet (la vue peut être réécrite)
        setTimeout(() => {
          const v2 = document.getElementById('vue-' + b.dataset.vue);
          const c = v2 && [...v2.querySelectorAll('h2, h3, summary')].find((x) => propre(x.textContent).includes(t));
          if (!c) return;
          const d = c.closest('details'); if (d) d.open = true;
          c.scrollIntoView({ block: 'start', behavior: 'smooth' });
          c.style.outline = '3px solid var(--accent)'; c.style.outlineOffset = '4px';
          setTimeout(() => { c.style.outline = ''; c.style.outlineOffset = ''; }, 2500);
        }, 120);
      } });
    }
  }
  return l;
}
// Une page hors de la carte pose ses boutons d'en-tête : « ? » (aide), 🔎 (recherche, Ctrl+K) et, si demandé, le retour à la carte.
// zone : élément de l'en-tête ; aide : page du wiki ; fonctions : voir ouvrirRechercheCommune ; carte : true pour le lien « ← Carte »
function installerSocle({ zone, aide, fonctions, carte = false, miette = '' }) {
  if (!zone) return;
  // Fil de position (Vague 3, point 9) : « où suis-je », à gauche des boutons ? / 🔎 / ← Carte. Chaque page le tient
  // à jour en appelant majFilPosition(texte) quand son onglet actif change ; rien d'autre à brancher ici.
  let f = zone.querySelector('.fil-position');
  if (!f) { f = document.createElement('span'); f.className = 'fil-position'; zone.insertBefore(f, zone.firstChild); }
  if (miette) f.textContent = miette;
  let b = zone.querySelector('.socle-commun');
  if (!b) { b = document.createElement('span'); b.className = 'socle-commun'; b.style.cssText = 'display:inline-flex;gap:6px;align-items:center'; zone.appendChild(b); }
  b.innerHTML = `${carte ? '<a class="btn-commun" href="/" title="Revenir à la carte du réseau">← Carte</a>' : ''}${fonctions ? '<button type="button" class="btn-commun" data-socle="chercher" title="Chercher une fonction de cette page (Ctrl+K)" aria-label="Chercher une fonction (Ctrl+K)">🔎</button>' : ''}${aide ? '<button type="button" class="btn-commun" data-socle="aide" title="Aide de cette page" aria-label="Aide de cette page">?</button>' : ''}`;
  const ba = b.querySelector('[data-socle="aide"]'); if (ba) ba.onclick = () => ouvrirAideCommune(aide);
  const bc = b.querySelector('[data-socle="chercher"]'); if (bc) bc.onclick = () => ouvrirRechercheCommune(fonctions);
  window.socleFonctions = fonctions || null;
  window.socleZoneFil = f;
}
// À appeler après installerSocle, chaque fois que l'onglet actif de la page change : met à jour le fil de position
// sans retoucher aux boutons ? / 🔎 / ← Carte.
function majFilPosition(texte) { if (window.socleZoneFil) window.socleZoneFil.textContent = texte || ''; }
if (PAGE_AUTONOME) document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && window.socleFonctions) { e.preventDefault(); ouvrirRechercheCommune(window.socleFonctions); }
});

// ---- Aide dans les champs : une notion = une explication, un exemple, un format, écrits une seule fois -----------
// Un champ dit ce qu'il attend par data-notion="…" ; rien d'autre à écrire à l'endroit du champ. Quand on entre dans
// le champ, une bulle s'affiche dessous (sans déplacer la page) : ce qui est attendu, un exemple, et, au fil de la
// frappe, si ce qui est tapé a la bonne forme. Le serveur reste seul juge à l'enregistrement : la bulle prévient,
// elle n'empêche rien. Un « ? » discret au bord droit du champ signale qu'une aide existe.
// verifier(valeur) → '' si la forme est bonne, sinon ce qui ne va pas. Les règles reprennent celles du serveur.
const NOTIONS = {
  noeud: { nom: 'Nœud', aide: 'Le nom du nœud tel qu’il apparaît sur la carte, ou son numéro : il commence par « ! » suivi de 8 caractères (chiffres et lettres a à f). On le lit sur la fiche du nœud ou dans l’appli Meshtastic.', exemple: '!a1b2c3d4' },
  numeroNoeud: { nom: 'Numéro de nœud', aide: 'Il commence par « ! » suivi de 8 caractères (chiffres et lettres a à f). On le lit sur la fiche du nœud ou dans l’appli Meshtastic. Le numéro décimal est accepté aussi.', exemple: '!a1b2c3d4',
    verifier: (v) => ((/^!?[0-9a-f]{8}$/i.test(v) && /[a-f!]/i.test(v)) || (/^\d{1,10}$/.test(v) && Number(v) > 0 && Number(v) <= 0xffffffff) ? '' : 'attendu : « ! » puis 8 caractères (0 à 9, a à f)') },
  listeNoeuds: { nom: 'Numéros de nœuds', aide: 'Un ou plusieurs numéros de nœud, séparés par des virgules. Chacun commence par « ! » suivi de 8 caractères ; on le lit sur la fiche du nœud.', exemple: '!a1b2c3d4, !e5f6a7b8',
    verifier: (v) => { const faux = v.split(/[,;\s]+/).filter(Boolean).find((x) => !/^!?[0-9a-f]{8}$/i.test(x)); return faux ? `« ${faux.slice(0, 16)} » : attendu « ! » puis 8 caractères (0 à 9, a à f)` : ''; } },
  noeudsSuivis: { nom: 'Nœuds suivis', aide: 'Les nœuds à surveiller, séparés par des virgules : un numéro Meshtastic (« ! » puis 8 caractères) ou la clé publique d’un nœud MeshCore (64 caractères), lus sur leur fiche.', exemple: '!a1b2c3d4' },
  nomCourt: { nom: 'Nom court du nœud', aide: 'Les 4 caractères affichés sur l’écran du module et dans sa pastille sur la carte (réglé dans l’appli Meshtastic). Respectez majuscules et minuscules.', exemple: 'PS01' },
  indicatif: { nom: 'Indicatif radioamateur', aide: 'L’indicatif délivré par l’ANFR, sans espace. Un suffixe « /P » ou « /M » est accepté.', exemple: 'F4ABC',
    verifier: (v) => (/^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}[A-Z](\/[A-Z0-9]{1,4})?$/.test(v.toUpperCase()) ? '' : 'ne ressemble pas à un indicatif (ex. F4ABC)') },
  swl: { nom: 'Numéro d’écouteur (SWL)', aide: 'Votre numéro d’écouteur si vous en avez un. Facultatif.', exemple: 'F-12345' },
  departement: { nom: 'Département', aide: 'Le numéro du département, à 2 ou 3 chiffres ; 2A ou 2B pour la Corse.', exemple: '43',
    verifier: (v) => (/^(\d{2,3}|2A|2B)$/i.test(v) ? '' : '2 ou 3 chiffres (ex. 43, 2A, 971)') },
  mqttUrl: { nom: 'Adresse du serveur MQTT (broker)', aide: 'Le protocole, le nom ou l’adresse IP du serveur, puis le port. mqtt:// pour une liaison simple (port 1883), mqtts:// si elle est chiffrée (port 8883), ws:// ou wss:// pour un broker en WebSocket.', exemple: 'mqtt://192.168.1.10:1883',
    verifier: (v) => (/^(mqtts?|wss?):\/\/[^\s]+$/.test(v) ? '' : 'doit commencer par mqtt://, mqtts://, ws:// ou wss://') },
  brokers: { nom: 'Brokers MQTT supplémentaires', aide: 'Une adresse par ligne, écrite comme celle du broker principal. La carte les écoute en même temps (5 au plus).', exemple: 'mqtt://autre-serveur:1883',
    verifier: (v) => { const faux = v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).find((l) => !/^(mqtts?|wss?):\/\/[^\s]+$/.test(l)); return faux ? `« ${faux.slice(0, 30)} » doit commencer par mqtt://, mqtts://, ws:// ou wss://` : ''; } },
  mqttRacine: { nom: 'Sujet racine MQTT', aide: 'Le début commun des sujets où les passerelles Meshtastic publient. Il est réglé dans le module MQTT de chaque passerelle : « msh » suivi de la région. Sans « / » à la fin.', exemple: 'msh/EU_868',
    verifier: (v) => (/\s/.test(v) ? 'pas d’espace dans un sujet MQTT' : /[#+]/.test(v) ? 'pas de « # » ni de « + » : la carte les ajoute elle-même' : '') },
  mqttSujets: { nom: 'Sujets MQTT supplémentaires', aide: 'D’autres sujets à écouter en plus du sujet racine, un par ligne ou séparés par des virgules. « # » à la fin prend tout ce qui suit.', exemple: 'msh/FR/43/#' },
  canauxCles: { nom: 'Canaux à déchiffrer', aide: 'Un canal par ligne : son nom, le signe « = », puis sa clé en base64, telle qu’elle est affichée dans l’appli Meshtastic. Le canal public LongFast a la clé « AQ== ». Sans la clé d’un canal, ses messages restent illisibles.', exemple: 'LongFast=AQ==',
    verifier: (v) => { const faux = v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).find((l) => !/^[^=\s][^=]*=\s*[A-Za-z0-9+/_-]+={0,2}$/.test(l)); return faux ? `« ${faux.slice(0, 24)} » : attendu Nom=clé en base64` : ''; } },
  cleCanal: { nom: 'Clé de canal', aide: 'La clé du canal en base64, telle qu’elle est affichée dans l’appli Meshtastic (16 ou 32 octets). Laissez vide pour qu’une clé soit tirée au hasard.', exemple: '1PG7OiApB1nwvP+rz05pAQ==',
    verifier: (v) => { if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) return 'ce n’est pas du base64'; let n = 0; try { n = atob(v.replace(/-/g, '+').replace(/_/g, '/')).length; } catch { return 'ce n’est pas du base64'; } return n === 16 || n === 32 ? '' : `clé de ${n} octets : il en faut 16 ou 32`; } },
  iata: { nom: 'Code de zone MeshCore', aide: 'Le code qui désigne votre secteur dans les sujets MQTT MeshCore : par convention le code de l’aéroport le plus proche, en 3 lettres.', exemple: 'LPY',
    verifier: (v) => (/^[A-Z0-9]{2,8}$/i.test(v) ? '' : '2 à 8 lettres ou chiffres, sans espace') },
  iataVoisins: { nom: 'Zones voisines', aide: 'Les codes de zone des secteurs voisins à écouter aussi, séparés par des virgules.', exemple: 'CFE, LYS, EBU',
    verifier: (v) => { const faux = v.split(/[,;\s]+/).filter(Boolean).find((x) => !/^[A-Z0-9]{2,8}$/i.test(x)); return faux ? `« ${faux} » : 2 à 8 lettres ou chiffres` : ''; } },
  racineMc: { nom: 'Racine des sujets MeshCore', aide: 'Le début des sujets MQTT où les observateurs MeshCore publient. Gardez « meshcore » sauf si votre broker en utilise un autre.', exemple: 'meshcore',
    verifier: (v) => (/[\s#+]/.test(v) ? 'pas d’espace, de « # » ni de « + »' : '') },
  hoteModule: { nom: 'Adresse du module', aide: 'L’adresse IP du module sur votre réseau Wi-Fi (affichée sur son écran ou dans votre box), ou son nom. Le module doit être allumé et joignable depuis le serveur de la carte.', exemple: '192.168.1.50',
    verifier: (v) => (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(v) ? '' : /:\/\//.test(v) ? 'l’adresse seule, sans « http:// »' : 'une adresse IP ou un nom, sans espace') },
  latitude: { nom: 'Latitude', aide: 'En degrés décimaux, avec un point : positive au nord. Un clic droit sur la carte donne les coordonnées d’un lieu.', exemple: '45.04300',
    verifier: (v) => (/,/.test(v) ? 'un point, pas une virgule (45.043)' : v.trim() !== '' && Number.isFinite(Number(v)) && Math.abs(Number(v)) <= 90 ? '' : 'un nombre entre -90 et 90') },
  longitude: { nom: 'Longitude', aide: 'En degrés décimaux, avec un point : positive à l’est de Greenwich. Un clic droit sur la carte donne les coordonnées d’un lieu.', exemple: '3.88500',
    verifier: (v) => (/,/.test(v) ? 'un point, pas une virgule (3.885)' : v.trim() !== '' && Number.isFinite(Number(v)) && Math.abs(Number(v)) <= 180 ? '' : 'un nombre entre -180 et 180') },
  locator: { nom: 'QTH locator', aide: 'Le carré Maidenhead de l’endroit où vous êtes : 4, 6 ou 8 caractères. Plus il est long, plus il est précis (8 caractères : quelques centaines de mètres).', exemple: 'JN15XC33',
    verifier: (v) => (v.length >= 4 && /^[A-R]{2}(\d{2}([A-X]{2}(\d{2}([A-X]{2})?)?)?)?$/i.test(v) ? '' : '2 lettres, 2 chiffres, puis 2 lettres et 2 chiffres (ex. JN15XC33)') },
  gisement: { nom: 'Gisement', aide: 'La direction d’où vient le signal, lue sur la boussole : 0° au nord, 90° à l’est, 180° au sud, 270° à l’ouest. Par rapport au nord géographique.', exemple: '125',
    verifier: (v) => { const n = Number(String(v).replace(',', '.')); return v.trim() !== '' && n >= 0 && n <= 360 ? '' : 'un nombre entre 0 et 360'; } },
  incertitude: { nom: 'Incertitude du relevé', aide: 'De combien de degrés vous pouvez vous tromper, de chaque côté. 5° avec une antenne directive bien tenue, 10 à 15° pour un relevé rapide. Vide : 5°.', exemple: '5',
    verifier: (v) => { const n = Number(String(v).replace(',', '.')); return n >= 0.5 && n <= 45 ? '' : 'entre 0,5 et 45 degrés'; } },
  identifiant: { nom: 'Identifiant', aide: 'Le nom avec lequel la personne se connectera : un pseudo ou « NOM Prénom ». 3 à 32 caractères.', exemple: 'DELAGE Fabrice',
    verifier: (v) => (v.trim().length >= 3 && v.trim().length <= 32 ? '' : '3 à 32 caractères') },
  motDePasse: { nom: 'Mot de passe', aide: '8 caractères au moins. Une phrase courte de plusieurs mots se retient mieux qu’un mot compliqué.', exemple: '',
    verifier: (v) => (v.length >= 8 ? '' : `encore ${8 - v.length} caractère${8 - v.length > 1 ? 's' : ''} (8 au moins)`) },
  email: { nom: 'Adresse e-mail', aide: 'Elle sert à recevoir un lien si le mot de passe est oublié, et les alertes si vous les demandez.', exemple: 'prenom.nom@exemple.fr',
    verifier: (v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? '' : 'il manque quelque chose (ex. prenom.nom@exemple.fr)') },
  courriels: { nom: 'Adresses e-mail', aide: 'Une ou plusieurs adresses, séparées par des virgules.', exemple: 'pc@exemple.fr, astreinte@exemple.fr',
    verifier: (v) => { const faux = v.split(/[,;\s]+/).filter(Boolean).find((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)); return faux ? `« ${faux} » n’est pas une adresse e-mail` : ''; } },
  codeEspace: { nom: 'Adresse de l’espace', aide: 'Le mot qui suit /secours/ dans l’adresse de la page, à donner aux membres. 3 à 32 caractères : lettres minuscules, chiffres et tirets. Il ne se change plus ensuite.', exemple: 'festival-2027',
    verifier: (v) => (/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(v) ? '' : /[A-Z]/.test(v) ? 'en minuscules' : /[^a-z0-9-]/.test(v) ? 'lettres minuscules, chiffres et tirets seulement (pas d’espace ni d’accent)' : '3 à 32 caractères') },
};
if (typeof window !== 'undefined') window.NOTIONS = NOTIONS;
(() => {
  if (typeof document === 'undefined') return;
  const st = document.createElement('style');
  st.textContent = `
[data-notion]:not(textarea) { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Ccircle cx='8' cy='8' r='7' fill='none' stroke='%239fb3c8' stroke-width='1.3'/%3E%3Ctext x='8' y='11.6' text-anchor='middle' font-family='sans-serif' font-size='10' font-weight='700' fill='%239fb3c8'%3E?%3C/text%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 6px center; padding-right: 26px !important; }
[data-notion][aria-invalid="true"] { border-color: #ffb547 !important; box-shadow: 0 0 0 1px #ffb547; }
#bulle-notion { position: fixed; z-index: 5000; max-width: min(380px, calc(100vw - 16px)); padding: 9px 11px; border-radius: 9px; background: #0f172a; color: #f8fafc; border: 1px solid #5b7189; box-shadow: 0 6px 18px rgba(0,0,0,.55); font: 13.5px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; pointer-events: none; }
#bulle-notion b { display: block; margin-bottom: 2px; }
#bulle-notion .ex { display: block; margin-top: 5px; color: #cbd7e2; }
#bulle-notion .ex code { font-family: ui-monospace, Menlo, Consolas, monospace; background: rgba(255,255,255,.1); padding: 1px 5px; border-radius: 4px; color: #f8fafc; }
#bulle-notion .etat { display: block; margin-top: 6px; font-weight: 650; }
#bulle-notion .etat.bon { color: #3ee6c4; } #bulle-notion .etat.faux { color: #ffb547; }`;
  document.head.appendChild(st);
  let bulle = null, champ = null;
  const fermer = () => { if (bulle) bulle.remove(); bulle = null; champ = null; };
  const etat = (c, n) => {
    const v = c.value;
    if (!n.verifier || !String(v).trim()) return null; // champ vide : rien à dire (facultatif ou pas, le serveur le sait)
    let m = '';
    try { m = n.verifier(String(v).trim()) || ''; } catch { m = ''; }
    return m;
  };
  const marquer = (c, n) => { const m = etat(c, n); if (m) c.setAttribute('aria-invalid', 'true'); else c.removeAttribute('aria-invalid'); return m; };
  const placer = () => {
    if (!bulle || !champ) return;
    const r = champ.getBoundingClientRect(), h = bulle.offsetHeight, l = bulle.offsetWidth;
    const dessous = r.bottom + 6 + h <= innerHeight || r.top - 6 - h < 0;
    bulle.style.top = Math.round(dessous ? r.bottom + 6 : r.top - 6 - h) + 'px';
    bulle.style.left = Math.round(Math.max(8, Math.min(r.left, innerWidth - l - 8))) + 'px';
  };
  const montrer = (c) => {
    const n = NOTIONS[c.dataset.notion];
    if (!n) return;
    if (!bulle) { bulle = document.createElement('div'); bulle.id = 'bulle-notion'; bulle.setAttribute('role', 'status'); bulle.setAttribute('aria-live', 'polite'); document.body.appendChild(bulle); }
    champ = c;
    const m = marquer(c, n);
    bulle.innerHTML = `<b>${escCommun(c.dataset.notionNom || n.nom)}</b>${escCommun(c.dataset.notionAide || n.aide)}${n.exemple ? `<span class="ex">Exemple : <code>${escCommun(n.exemple)}</code></span>` : ''}${m === null ? '' : m ? `<span class="etat faux">⚠ ${escCommun(m)}</span>` : '<span class="etat bon">✔ forme reconnue</span>'}`;
    placer();
  };
  document.addEventListener('focusin', (e) => { const c = e.target; if (c && c.matches && c.matches('[data-notion]') && !c.readOnly && !c.disabled) montrer(c); else fermer(); });
  document.addEventListener('focusout', (e) => { const c = e.target; if (c && c.matches && c.matches('[data-notion]')) { const n = NOTIONS[c.dataset.notion]; if (n) marquer(c, n); } fermer(); });
  document.addEventListener('input', (e) => { if (e.target === champ) montrer(champ); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && bulle) fermer(); }, true);
  addEventListener('scroll', placer, true);
  addEventListener('resize', placer);
})();
