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
function installerSocle({ zone, aide, fonctions, carte = false }) {
  if (!zone) return;
  let b = zone.querySelector('.socle-commun');
  if (!b) { b = document.createElement('span'); b.className = 'socle-commun'; b.style.cssText = 'display:inline-flex;gap:6px;align-items:center'; zone.appendChild(b); }
  b.innerHTML = `${carte ? '<a class="btn-commun" href="/" title="Revenir à la carte du réseau">← Carte</a>' : ''}${fonctions ? '<button type="button" class="btn-commun" data-socle="chercher" title="Chercher une fonction de cette page (Ctrl+K)" aria-label="Chercher une fonction (Ctrl+K)">🔎</button>' : ''}${aide ? '<button type="button" class="btn-commun" data-socle="aide" title="Aide de cette page" aria-label="Aide de cette page">?</button>' : ''}`;
  const ba = b.querySelector('[data-socle="aide"]'); if (ba) ba.onclick = () => ouvrirAideCommune(aide);
  const bc = b.querySelector('[data-socle="chercher"]'); if (bc) bc.onclick = () => ouvrirRechercheCommune(fonctions);
  window.socleFonctions = fonctions || null;
}
if (PAGE_AUTONOME) document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && window.socleFonctions) { e.preventDefault(); ouvrirRechercheCommune(window.socleFonctions); }
});
