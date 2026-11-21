/* Bandeau « Switch to the world map » : propose l'édition monde aux visiteurs étrangers.
   Affiché seulement si l'installation l'a activé (Réglages avancés › Affichage, /api/config → bandeauMonde),
   si la langue du navigateur n'est pas le français (et que le visiteur n'a pas choisi le français dans la carte),
   et s'il n'a pas été fermé (mémorisé dans le navigateur). Texte volontairement en anglais : translate="no",
   la traduction de l'interface n'y touche pas.
   Placement : le bandeau cherche lui-même une place libre (en bas au centre, sinon sous un élément du haut), sans
   recouvrir la barre du haut, la barre d'outils, la recherche, le panneau, la légende ni les boutons de la carte.
   S'il n'y a aucune place (tiroir du téléphone ouvert en grand, fiche ouverte…), il s'efface jusqu'à ce qu'elle revienne. */
(function () {
  'use strict';
  const CLE = 'gaulix_bandeau_monde_ferme';
  const lireFerme = () => { try { return localStorage.getItem(CLE) === '1'; } catch { return false; } };
  const ecrireFerme = () => { try { localStorage.setItem(CLE, '1'); } catch { /* navigation privée : il reviendra */ } };

  // Langue du navigateur (première préférée) : pas de bandeau pour un francophone
  function navigateurFrancais() {
    const l = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    if (/^fr\b/i.test(l)) return true;
    if (window.LANGUE === 'fr') return true; // français choisi dans la carte
    return false;
  }
  const adresseSure = (u) => typeof u === 'string' && /^https?:\/\/[^\s"'<>]+$/i.test(u);

  const STYLE = `
#bandeau-monde { position: fixed; z-index: 1001; left: 0; top: 0; box-sizing: border-box; width: 520px; max-width: calc(100vw - 16px);
  display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 12px; border-radius: 10px;
  background: #0f1c2a; color: #f8fafc; border: 1px solid #5eead4; box-shadow: 0 4px 16px rgba(0,0,0,.45);
  font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
#bandeau-monde.cache { visibility: hidden; pointer-events: none; }
#bandeau-monde .bm-texte { flex: 1; min-width: 0; }
#bandeau-monde .bm-texte b { display: block; font-size: 14px; color: #ffffff; }
#bandeau-monde .bm-texte span { color: #e2e8f0; }
#bandeau-monde .bm-ouvrir { flex: none; display: inline-block; padding: 7px 12px; border-radius: 8px; background: #3ee6c4; color: #04130f;
  font-weight: 700; text-decoration: none; white-space: nowrap; }
#bandeau-monde .bm-ouvrir:hover, #bandeau-monde .bm-ouvrir:focus-visible { background: #7ff3dc; outline: 2px solid #fff; outline-offset: 2px; }
#bandeau-monde .bm-fermer { flex: none; width: 32px; height: 32px; border: 1px solid #64748b; border-radius: 8px; background: transparent;
  color: #ffffff; font-size: 18px; line-height: 1; cursor: pointer; }
#bandeau-monde .bm-fermer:hover, #bandeau-monde .bm-fermer:focus-visible { background: #1e293b; outline: 2px solid #fff; outline-offset: 1px; }
#bandeau-monde.etroit { flex-wrap: wrap; }
#bandeau-monde.etroit .bm-texte { flex-basis: calc(100% - 44px); }
#bandeau-monde.etroit .bm-ouvrir { flex: 1; text-align: center; }`;

  let el = null, minuterie = null, observateur = null;
  const MARGE = 8;

  // Éléments à ne pas recouvrir : enfants fixes de la page (barre, outils, panneau, légende, recherche…)
  // et contrôles de la carte (zoom, couches, attribution)
  function obstacles() {
    const vw = window.innerWidth, vh = window.innerHeight, l = [];
    const ajouter = (e) => {
      if (!e || e === el || e.id === 'carte' || e.tagName === 'SCRIPT' || e.tagName === 'DIALOG') return;
      const r = e.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return;
      if (r.width * r.height > vw * vh * 0.6) return; // calque plein écran (carte, voile) : pas un obstacle
      const cs = getComputedStyle(e);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return;
      l.push(r);
    };
    for (const e of document.body.children) {
      if (e === el || e.hidden) continue;
      const pos = getComputedStyle(e).position;
      if (pos === 'fixed' || pos === 'sticky') ajouter(e);
    }
    document.querySelectorAll('.leaflet-control').forEach(ajouter);
    return l;
  }
  const croise = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  // Intervalles horizontaux libres dans la bande [haut, bas]
  function libres(obs, haut, bas) {
    const vw = window.innerWidth;
    const pris = obs.filter((r) => r.top < bas + MARGE && r.bottom > haut - MARGE).map((r) => [r.left - MARGE, r.right + MARGE]).sort((a, b) => a[0] - b[0]);
    const res = []; let x = MARGE;
    for (const [g, d] of pris) { if (g > x) res.push([x, g]); x = Math.max(x, d); }
    if (vw - MARGE > x) res.push([x, vw - MARGE]);
    return res;
  }

  // Cherche une place libre : en bas d'abord (discret), puis sous chaque élément du haut, de haut en bas
  function placer() {
    if (!el) return;
    const vw = window.innerWidth, vh = window.innerHeight, obs = obstacles();
    // Place actuelle toujours libre : on ne bouge pas (pas de sautillement)
    const actuel = el.getBoundingClientRect();
    if (el.dataset.place && !el.classList.contains('cache') && actuel.width && !obs.some((r) => croise(r, actuel)) && actuel.bottom <= vh && actuel.right <= vw) return;
    const largeurMax = Math.min(520, vw - 2 * MARGE);
    // Étroit : le bouton passe sous le texte (sinon le texte s'écrase en colonne)
    const mesurer = (w) => { el.style.width = w + 'px'; el.classList.toggle('etroit', w < 440); return el.getBoundingClientRect().height; };
    const niveaux = ['bas', MARGE, ...obs.map((r) => Math.ceil(r.bottom) + MARGE + 1).filter((y) => y > 0 && y < vh).sort((a, b) => a - b)];
    // 1er passage : une place confortable (400 px ou toute la largeur d'un téléphone) ; 2e : une place étroite
    for (const largeurMin of [Math.min(400, largeurMax), Math.min(260, largeurMax)]) for (const niv of niveaux) {
      let w = largeurMax;
      for (let essai = 0; essai < 3; essai++) {
        const h = mesurer(w);
        const haut = niv === 'bas' ? vh - h - 30 : niv; // en bas : au-dessus de la ligne d'attribution
        if (haut < 0 || haut + h > vh - 4) break;
        const meilleur = libres(obs, haut, haut + h).filter(([g, d]) => d - g >= largeurMin).sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
        if (!meilleur) break;
        const dispo = Math.floor(meilleur[1] - meilleur[0]);
        if (dispo < w) { w = dispo; continue; } // plus étroit, donc plus haut : on revérifie la bande
        const gauche = Math.round(meilleur[0] + (dispo - w) / 2);
        el.style.left = gauche + 'px'; el.style.top = Math.round(haut) + 'px';
        el.dataset.place = niv === 'bas' ? 'bas' : 'haut';
        el.classList.remove('cache');
        // Dernière vérification une fois posé (retour à la ligne du texte)
        const r = el.getBoundingClientRect();
        if (!obs.some((o) => croise(o, r))) return;
        break;
      }
    }
    // Aucune place : le bandeau s'efface sans rien recouvrir, il reviendra quand l'écran se libère
    el.classList.add('cache');
    delete el.dataset.place;
  }

  function fermer() {
    ecrireFerme();
    if (el) el.remove();
    el = null;
    clearInterval(minuterie);
    if (observateur) observateur.disconnect();
    window.removeEventListener('resize', placer);
  }

  function afficher(url, zoneNom) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);
    el = document.createElement('div');
    el.id = 'bandeau-monde';
    el.className = 'cache';
    el.setAttribute('translate', 'no');
    el.setAttribute('lang', 'en');
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'World map');
    const texte = document.createElement('div'); texte.className = 'bm-texte';
    const titre = document.createElement('b'); titre.textContent = 'Switch to the world map';
    const phrase = document.createElement('span');
    phrase.textContent = zoneNom ? `This map only covers ${zoneNom}, France. See Meshtastic and MeshCore networks worldwide.` : 'This map only covers one area of France. See Meshtastic and MeshCore networks worldwide.';
    texte.append(titre, phrase);
    const lien = document.createElement('a'); lien.className = 'bm-ouvrir'; lien.href = url; lien.rel = 'noopener';
    // Adresse par défaut (dépôt GitHub) : le bouton dit honnêtement où il mène
    lien.textContent = /^https?:\/\/(www\.)?github\.com\//i.test(url) ? 'See the world edition' : 'Open the world map';
    const croix = document.createElement('button'); croix.type = 'button'; croix.className = 'bm-fermer'; croix.textContent = '✕';
    croix.title = 'Close'; croix.setAttribute('aria-label', 'Close');
    croix.addEventListener('click', fermer);
    el.append(texte, lien, croix);
    document.body.appendChild(el);
    placer();
    window.addEventListener('resize', placer);
    // Panneau replié, tiroir déplacé, fiche ouverte… : vérification légère et régulière de la place
    minuterie = setInterval(placer, 1500);
    // La barre du haut change de hauteur (--bas-barre, --bas-haut… posés sur <html>) : la recherche et le panneau
    // descendent aussitôt, le bandeau se replace dans la foulée au lieu d'attendre la vérification suivante
    if (window.MutationObserver) {
      observateur = new MutationObserver(() => requestAnimationFrame(placer));
      observateur.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
      observateur.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
  }

  async function demarrer() {
    if (lireFerme() || navigateurFrancais()) return;
    let cfg = null;
    try { const r = await fetch('/api/config', { credentials: 'same-origin' }); if (r.ok) cfg = await r.json(); } catch { return; }
    const b = cfg && cfg.bandeauMonde;
    if (!b || !adresseSure(b.url)) return;
    // Laisser la page poser sa barre, sa recherche et ses contrôles avant de chercher une place
    setTimeout(() => { if (!lireFerme() && !el) afficher(b.url, String(cfg.zoneNom || '').slice(0, 60)); }, 1200);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', demarrer); else demarrer();
})();
