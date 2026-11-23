'use strict';
// Espaces « Secours » : dispositif prévisionnel de secours (DPS) d'une association de sécurité civile, ou volet radio
// du plan communal de sauvegarde (PCS) d'une commune. Interventions pointées sur la carte, équipes suivies en direct
// par leur nœud LoRa, main courante alimentée aussi par les messages radio du terrain.
// - /secours            : gestion des espaces, pour les administrateurs de la carte (créer, attribuer des nœuds,
//                         nommer un responsable) ; ils n'entrent pas dans les espaces.
// - /secours/<adresse>  : l'espace lui-même, avec ses propres comptes (rien de commun avec ceux de la carte).
(async () => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
  const heure = (t) => new Date(t).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const depuis = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'à l’instant' : m < 60 ? `il y a ${m} min` : m < 1440 ? `il y a ${Math.round(m / 60)} h` : `il y a ${Math.round(m / 1440)} j`; };
  async function api(url, opts = {}) {
    const r = await fetch(url, { credentials: 'same-origin', ...opts, headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.erreur || 'Erreur ' + r.status), { statut: r.status });
    return j;
  }
  const page = $('#page');
  const code = (/^\/secours\/([a-z0-9][a-z0-9-]{1,30}[a-z0-9])\/?$/.exec(location.pathname) || [])[1] || null;
  const NOMS_GENRE = { dps: 'DPS — dispositif prévisionnel de secours', pcs: 'PCS — plan communal de sauvegarde' };

  // =================================================================================================================
  // Gestion des espaces (administrateur de la carte)
  // =================================================================================================================
  if (!code) {
    let espaces, sel = { noeuds: [], canaux: [], organisations: { dps: [], pcs: [] } };
    const lireSelecteur = async () => { try { sel = await api('/api/secours-admin/selecteur'); } catch { /* liste des nœuds indisponible */ } };
    try { espaces = (await api('/api/secours-admin/espaces')).espaces; } catch {
      page.innerHTML = `<div class="plein etroit"><h2>Espaces Secours</h2>
        <p>Ces espaces servent aux associations de sécurité civile (dispositifs prévisionnels de secours) et aux communes (plan communal de sauvegarde).</p>
        <p>Pour entrer dans le vôtre, utilisez l’adresse que votre responsable vous a donnée : <span class="mono">/secours/nom-de-l-espace</span>.</p>
        <p class="note">Administrateur de la carte : <a class="bouton mini" href="/?compte=connexion&amp;retour=/secours">connectez-vous à la carte</a> pour gérer les espaces.</p></div>`;
      return;
    }
    await lireSelecteur();
    $('#titre').textContent = 'Espaces Secours';
    $('#moi').innerHTML = '<a class="bouton mini" href="/">← Carte</a>';
    // Ce qui est ouvert ou saisi dans une fiche survit à son redessin (après chaque enregistrement)
    const ouverts = new Set(), recherches = new Map(), coches = new Map();
    const optionsOrg = (e, choisi, vide = '— sans organisation —') => `<option value="">${esc(vide)}</option>` + e.organisations.map((o) => `<option value="${esc(o.id)}" ${o.id === choisi ? 'selected' : ''}>${esc(o.nom)}</option>`).join('');
    const proposees = (e) => (sel.organisations[e.genre] || []).filter((n) => !e.organisations.some((o) => o.nom.toLowerCase() === n.toLowerCase()));
    const nomNoeud = (n) => [n.court, n.long].filter(Boolean).join(' · ') || n.nom || '';
    // Lignes du sélecteur : les nœuds que la carte connaît, filtrés par la recherche (60 au plus à l'écran)
    function lignesSelecteur(e) {
      const r = (recherches.get(e.code) || '').trim().toLowerCase(), c = coches.get(e.code) || new Set();
      const tous = sel.noeuds.filter((n) => n.espace !== e.code && (!r || `${n.court || ''} ${n.long || ''} ${n.id}`.toLowerCase().includes(r)));
      const vus = tous.slice(0, 60);
      return (vus.length ? vus.map((n) => { const autre = n.espace ? espaces.find((x) => x.code === n.espace) : null;
        return `<label class="case ligne-noeud"><input type="checkbox" value="${esc(n.id)}" ${c.has(n.id) ? 'checked' : ''} ${autre ? 'disabled' : ''}><span><b translate="no">${esc(n.court || '—')}</b> <span translate="no">${esc(n.long || '')}</span> <span class="mono note">${esc(n.id)}</span> <span class="note">${autre ? `— déjà dans « ${esc(autre.nom)} »` : n.vu ? `· vu ${depuis(n.vu)}` : ''}</span></span></label>`; }).join('') : '<div class="vide">Aucun nœud de la carte ne correspond.</div>')
        + (tous.length > vus.length ? `<p class="note">${tous.length - vus.length} autres nœuds : précisez la recherche.</p>` : '');
    }
    const dessiner = (message = '') => {
      page.innerHTML = `<div class="plein">
        <h2>Espaces Secours de cette carte</h2>
        <p class="note">Chaque espace est séparé de tout le reste : son propre fichier de données, ses propres comptes (sans aucun accès à la carte ni à la section ADRASEC), et il ne voit du réseau que les nœuds que vous lui attribuez ici. Vous créez l’espace et nommez son responsable ; vous n’entrez pas dedans. Les messages de ces nœuds ne s’affichent plus dans les messages de la carte.</p>
        ${message}
        <div id="liste">${espaces.length ? espaces.map((e) => `
          <div class="fiche" data-code="${esc(e.code)}">
            <div class="tete"><b>${esc(e.nom)}</b><span class="pastille">${esc((e.genre || '').toUpperCase())}</span><span class="heure">${e.comptes} compte${e.comptes > 1 ? 's' : ''} · ${e.equipes} équipe${e.equipes > 1 ? 's' : ''}</span></div>
            <p>Adresse à donner aux membres : <a class="mono" href="/secours/${esc(e.code)}">${esc(location.origin)}/secours/${esc(e.code)}</a></p>
            <p class="note">Responsable${e.responsables.length > 1 ? 's' : ''} : ${e.responsables.map(esc).join(', ') || '<span class="erreur">aucun</span>'}</p>

            <h3>Organisations</h3>
            <p class="note">${e.genre === 'dps' ? 'Les associations qui tiennent ce dispositif ensemble.' : 'Les services et associations engagés par la commune.'} Elles partagent le même espace : c’est un rangement des nœuds et des équipes, pas une séparation.</p>
            <div class="puces">${e.organisations.map((o) => `<span class="pastille puce" style="border-color:${esc(o.couleur || '#4cc9f0')}"><span translate="no">${esc(o.nom)}</span> <button class="mini o-suppr" data-id="${esc(o.id)}" title="Retirer cette organisation" aria-label="Retirer ${esc(o.nom)}">✕</button></span>`).join('') || '<span class="note">Aucune pour l’instant.</span>'}</div>
            <div class="champs"><label>Ajouter une organisation <select class="o-choix">${proposees(e).map((n) => `<option>${esc(n)}</option>`).join('')}<option value="">Autre…</option></select></label>
              <label class="o-libre" ${proposees(e).length ? 'hidden' : ''}>Son nom <input class="o-nom" maxlength="60"></label><button class="mini o-ajout">Ajouter</button></div>

            <h3>Nœuds de l’espace</h3>
            ${e.noeudsAttribues.length ? `<table><tbody>${e.noeudsAttribues.map((n) => `<tr data-noeud="${esc(n.id)}"><td><b translate="no">${esc(n.nom || '—')}</b><br><span class="mono note">${esc(n.id)}</span></td>
              <td><select class="n-org" aria-label="Organisation du nœud">${optionsOrg(e, n.organisation)}</select></td><td><button class="mini danger n-retirer">Retirer</button></td></tr>`).join('')}</tbody></table>` : '<p class="note">Aucun nœud attribué : les équipes de cet espace n’ont pas encore de position ni de message par radio.</p>'}
            ${e.attentes.length ? `<p class="note">En attente (pas encore vus par la carte, attribués dès qu’ils s’allument) :</p><div class="puces">${e.attentes.map((a) => `<span class="pastille puce att"><span class="mono" translate="no">${esc(a.nom)}</span>${a.organisation && e.organisations.find((o) => o.id === a.organisation) ? ' · ' + esc(e.organisations.find((o) => o.id === a.organisation).nom) : ''} <button class="mini a-retirer" data-nom="${esc(a.nom)}" aria-label="Ne plus attendre ${esc(a.nom)}">✕</button></span>`).join('')}</div>` : ''}
            <details class="selecteur" ${ouverts.has(e.code) ? 'open' : ''}><summary>➕ Choisir des nœuds dans la liste de la carte</summary>
              <label>Chercher (nom court, nom long ou numéro) <input class="s-recherche" type="search" value="${esc(recherches.get(e.code) || '')}" placeholder="ex. PS01, Poste scène, !a1b2c3d4" autocapitalize="off" spellcheck="false"></label>
              <div class="s-liste">${ouverts.has(e.code) ? lignesSelecteur(e) : ''}</div>
              <div class="champs"><label>Ranger dans <select class="s-org">${optionsOrg(e, null)}</select></label><button class="mini principal s-attribuer">Attribuer les nœuds cochés</button></div>
              <div class="champs"><label>Nœud pas encore allumé : son nom court <input class="s-attente mono" maxlength="12" placeholder="ex. PS01" autocapitalize="off" spellcheck="false"></label><button class="mini s-attendre">L’attendre</button></div>
              <p class="note">Le nœud attendu rejoint l’espace (et l’organisation choisie ci-dessus) dès que la carte voit un nœud portant ce nom court. Si plusieurs nœuds portent le même nom, rien n’est attribué : choisissez-le alors dans la liste.</p>
            </details>

            <h3>Canal réservé</h3>
            <div class="champs"><label>Canal du module radio de la carte réservé à cet espace <select class="c-canal"><option value="">— aucun —</option>${[...new Set([...(e.canal ? [e.canal] : []), ...sel.canaux])].map((c) => `<option ${c === e.canal ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label><button class="mini c-ok">Enregistrer</button></div>
            <p class="note">Facultatif. « Toutes les équipes » part alors en un seul message sur ce canal, et ce qui s’y dit n’apparaît que dans l’espace. Créez d’abord le canal (avec sa clé) sur le module de la carte et sur les nœuds des équipes.</p>

            <div class="actions">
              <button class="mini nommer">Nommer un responsable / remettre son mot de passe</button>
              <button class="mini danger supprimer">Supprimer l’espace</button>
            </div>
            <div class="zone-nommer" hidden>
              <div class="champs"><label>Identifiant <input class="r-id" autocomplete="off"></label><label>Mot de passe (8 caractères au moins) <input class="r-mdp" type="password" autocomplete="new-password"></label><button class="mini principal r-ok">Valider</button></div>
            </div>
            <div class="retour erreur"></div>
          </div>`).join('') : '<div class="vide">Aucun espace pour l’instant.</div>'}</div>
        <h2>Créer un espace</h2>
        <div class="champs">
          <label>Nom <input id="n-nom" placeholder="ex. Festival du Velay 2027" maxlength="60"></label>
          <label>Type <select id="n-genre"><option value="dps">${NOMS_GENRE.dps}</option><option value="pcs">${NOMS_GENRE.pcs}</option></select></label>
          <label>Adresse (minuscules, chiffres, tirets) <input id="n-code" class="mono" placeholder="festival-2027" maxlength="32" autocapitalize="off" spellcheck="false"></label>
        </div>
        <div class="champs">
          <label>Première organisation (d’autres s’ajoutent ensuite) <select id="n-org"></select></label>
          <label id="n-org-libre" hidden>Son nom <input id="n-org-nom" maxlength="60"></label>
        </div>
        <div class="champs">
          <label>Identifiant du premier responsable <input id="n-rid" autocomplete="off"></label>
          <label>Son mot de passe (8 caractères au moins) <input id="n-rmdp" type="password" autocomplete="new-password"></label>
        </div>
        <p class="note">Les nœuds s’attribuent ensuite, dans la fiche de l’espace.</p>
        <div class="champs"><button id="n-creer" class="principal">Créer l’espace</button><span id="n-retour" class="erreur"></span></div>
      </div>`;
      // Adresse proposée d'après le nom, tant qu'elle n'a pas été saisie à la main
      let adresseLibre = true;
      $('#n-code').oninput = () => { adresseLibre = false; };
      $('#n-nom').oninput = () => { if (adresseLibre) $('#n-code').value = $('#n-nom').value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32); };
      const majOrgCreation = () => { $('#n-org').innerHTML = '<option value="-">— aucune pour l’instant —</option>' + (sel.organisations[$('#n-genre').value] || []).map((n) => `<option>${esc(n)}</option>`).join('') + '<option value="">Autre…</option>'; $('#n-org-libre').hidden = true; };
      majOrgCreation();
      $('#n-genre').onchange = majOrgCreation;
      $('#n-org').onchange = () => { $('#n-org-libre').hidden = $('#n-org').value !== ''; };
      $('#n-creer').onclick = async () => {
        const org = $('#n-org').value === '-' ? null : $('#n-org').value || $('#n-org-nom').value.trim();
        try {
          espaces = (await api('/api/secours-admin/espaces', { method: 'POST', body: { nom: $('#n-nom').value, genre: $('#n-genre').value, code: $('#n-code').value, responsable: { identifiant: $('#n-rid').value, motDePasse: $('#n-rmdp').value }, organisations: org ? [org] : [] } })).espaces;
          ouverts.add($('#n-code').value);
          await lireSelecteur();
          dessiner('<p class="reussi">Espace créé. Attribuez-lui ses nœuds ci-dessous, puis donnez son adresse, l’identifiant et le mot de passe au responsable.</p>');
        } catch (e) { $('#n-retour').textContent = e.message; }
      };
      for (const f of page.querySelectorAll('.fiche[data-code]')) {
        const c = f.dataset.code, e = espaces.find((x) => x.code === c), retour = $('.retour', f);
        const appel = async (methode, corps, ok) => { try { espaces = (await api('/api/secours-admin/espaces/' + c, { method: methode, body: corps })).espaces; await lireSelecteur(); dessiner(`<p class="reussi">${ok}</p>`); const g = page.querySelector(`.fiche[data-code="${c}"]`); if (g) g.scrollIntoView({ block: 'nearest' }); } catch (err) { retour.textContent = err.message; retour.scrollIntoView({ block: 'nearest' }); } };
        // Organisations
        if ($('.o-choix', f)) $('.o-choix', f).onchange = () => { $('.o-libre', f).hidden = $('.o-choix', f).value !== ''; };
        $('.o-ajout', f).onclick = () => { const nom = $('.o-choix', f).value || $('.o-nom', f).value.trim(); appel('PATCH', { organisation: { nom } }, `Organisation « ${esc(nom)} » ajoutée.`); };
        for (const b of f.querySelectorAll('.o-suppr')) b.onclick = () => { if (confirm('Retirer cette organisation ? Ses nœuds et ses équipes restent dans l’espace, sans organisation.')) appel('PATCH', { organisation: { id: b.dataset.id, supprimer: true } }, 'Organisation retirée.'); };
        // Nœuds attribués
        for (const tr of f.querySelectorAll('tr[data-noeud]')) {
          $('.n-org', tr).onchange = (ev) => appel('PATCH', { attribuer: { noeuds: [tr.dataset.noeud], organisation: ev.target.value || null } }, 'Nœud rangé.');
          $('.n-retirer', tr).onclick = () => { if (confirm(`Retirer le nœud ${tr.dataset.noeud} de cet espace ? L’équipe qui le porte n’aura plus de position.`)) appel('PATCH', { retirer: [tr.dataset.noeud] }, 'Nœud retiré.'); };
        }
        for (const b of f.querySelectorAll('.a-retirer')) b.onclick = () => appel('PATCH', { retirerAttente: b.dataset.nom }, 'Nœud en attente retiré.');
        // Sélecteur
        const d = $('.selecteur', f), liste = $('.s-liste', f);
        const cocher = () => { const s = coches.get(c) || new Set(); for (const x of liste.querySelectorAll('input[type=checkbox]')) { if (x.checked) s.add(x.value); else s.delete(x.value); } coches.set(c, s); $('.s-attribuer', f).textContent = s.size ? `Attribuer les nœuds cochés (${s.size})` : 'Attribuer les nœuds cochés'; };
        const lister = () => { liste.innerHTML = lignesSelecteur(e); cocher(); };
        d.ontoggle = () => { if (d.open) { ouverts.add(c); lister(); } else ouverts.delete(c); };
        liste.onchange = cocher;
        $('.s-recherche', f).oninput = (ev) => { cocher(); recherches.set(c, ev.target.value); lister(); };
        if (d.open) cocher();
        $('.s-attribuer', f).onclick = () => { cocher(); const n = [...(coches.get(c) || [])]; if (!n.length) { retour.textContent = 'Cochez au moins un nœud dans la liste.'; return; } coches.delete(c); appel('PATCH', { attribuer: { noeuds: n, organisation: $('.s-org', f).value || null } }, `${n.length} nœud${n.length > 1 ? 's' : ''} attribué${n.length > 1 ? 's' : ''}.`); };
        $('.s-attendre', f).onclick = () => { const nom = $('.s-attente', f).value.trim(); appel('PATCH', { attendre: { nom, organisation: $('.s-org', f).value || null } }, `« ${esc(nom)} » sera attribué dès qu’il s’allumera.`); };
        $('.c-ok', f).onclick = () => appel('PATCH', { canal: $('.c-canal', f).value }, 'Canal enregistré.');
        $('.nommer', f).onclick = () => { $('.zone-nommer', f).hidden = !$('.zone-nommer', f).hidden; };
        $('.r-ok', f).onclick = () => appel('PATCH', { responsable: { identifiant: $('.r-id', f).value, motDePasse: $('.r-mdp', f).value } }, 'Responsable enregistré.');
        $('.supprimer', f).onclick = () => { if (confirm(`Supprimer l’espace « ${$('.tete b', f).textContent} » ?\nSes membres n’y auront plus accès. Son fichier est gardé dans le dossier secours/corbeille du serveur.`)) appel('DELETE', {}, 'Espace supprimé.'); };
      }
    };
    dessiner();
    return;
  }

  // =================================================================================================================
  // Un espace
  // =================================================================================================================
  const base = '/api/secours/' + code;
  let acces;
  try { acces = await api(base + '/acces'); } catch {
    page.innerHTML = '<div class="plein etroit"><h2>Aucun espace à cette adresse</h2><p>Vérifiez l’adresse que votre responsable vous a donnée.</p></div>';
    return;
  }
  $('#titre').textContent = acces.nom;
  document.title = acces.nom;
  $('#genre').textContent = (acces.genre || '').toUpperCase(); $('#genre').hidden = false; $('#genre').title = NOMS_GENRE[acces.genre] || '';
  if (!acces.connecte) {
    page.innerHTML = `<form class="plein etroit" id="connexion">
      <h2>${esc(acces.nom)}</h2><p class="note">${esc(NOMS_GENRE[acces.genre] || '')}. Connectez-vous avec le compte que votre responsable vous a remis.</p>
      <label>Identifiant <input id="c-id" autocomplete="username" autocapitalize="off" required></label>
      <label style="margin-top:8px">Mot de passe <input id="c-mdp" type="password" autocomplete="current-password" required></label>
      <div class="champs"><button class="principal">Entrer</button><span id="c-retour" class="erreur"></span></div></form>`;
    $('#connexion').onsubmit = async (ev) => {
      ev.preventDefault();
      try { await api(base + '/connexion', { method: 'POST', body: { identifiant: $('#c-id').value, motDePasse: $('#c-mdp').value } }); location.reload(); }
      catch (e) { $('#c-retour').textContent = e.message; }
    };
    $('#c-id').focus();
    return;
  }

  let E = await api(base + '/etat');
  page.innerHTML = `<div id="carte"><div id="consigne" hidden></div></div>
    <div id="poignee" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Largeur du panneau : tirez, ou flèches gauche et droite" title="Tirez pour élargir ou rétrécir le panneau (double-clic : largeur d’origine)"></div>
    <aside>
      <div class="alerte-radio" id="alerte-radio" role="alert" hidden>⚠ Le module radio de la carte est déconnecté : les envois par radio ne partent plus.</div>
      <nav class="onglets" id="onglets">
        <button data-vue="inter" class="actif">📍 Interventions</button>
        <button data-vue="equipes">👥 Équipes</button>
        <button data-vue="reperes">🚩 Repères</button>
        <button data-vue="mc">🗒️ Main courante</button>
        <button data-vue="gestion">⚙️ ${E.moi.responsable ? 'Gestion' : 'Mon compte'}</button>
      </nav>
      <section class="vue actif" id="vue-inter"></section>
      <section class="vue" id="vue-equipes"></section>
      <section class="vue" id="vue-reperes"></section>
      <section class="vue" id="vue-mc"></section>
      <section class="vue" id="vue-gestion"></section>
    </aside>`;
  $('#moi').innerHTML = `<span>${esc(E.moi.identifiant)}${E.moi.responsable ? ' · responsable' : ''}</span><button class="mini" id="sortir">Se déconnecter</button>`;
  $('#sortir').onclick = async () => { await api(base + '/deconnexion', { method: 'POST' }).catch(() => {}); location.reload(); };

  // ---- Carte --------------------------------------------------------------------------------------------------
  const memo = (k, v) => { try { if (v === undefined) return localStorage.getItem('secours-' + k); if (v === null) localStorage.removeItem('secours-' + k); else localStorage.setItem('secours-' + k, v); } catch { /* navigateur sans stockage */ } return null; };
  // Largeur du panneau, retenue sur cet appareil (avant de créer la carte, qui prend la place restante)
  const cote = $('aside'), poignee = $('#poignee');
  const borner = (l) => Math.round(Math.max(340, Math.min(innerWidth - 260, l)));
  if (Number(memo('largeur'))) cote.style.setProperty('--largeur', borner(Number(memo('largeur'))) + 'px');
  const depart = E.centre ? [[E.centre.lat, E.centre.lon], E.centre.zoom] : [acces.carte.centre, acces.carte.zoom || 10];
  const carte = L.map('carte', { zoomControl: true }).setView(depart[0], depart[1]);
  function largeur(l, retenir) {
    if (l == null) { cote.style.removeProperty('--largeur'); memo('largeur', null); } else { cote.style.setProperty('--largeur', borner(l) + 'px'); if (retenir) memo('largeur', String(borner(l))); }
    carte.invalidateSize({ pan: false });
  }
  poignee.onpointerdown = (ev) => {
    ev.preventDefault(); poignee.setPointerCapture(ev.pointerId); poignee.classList.add('glisse'); document.body.classList.add('glisse-panneau');
    const droite = cote.getBoundingClientRect().right;
    let l = cote.offsetWidth;
    poignee.onpointermove = (e2) => { l = droite - e2.clientX - poignee.offsetWidth / 2; largeur(l); };
    poignee.onpointerup = poignee.onpointercancel = () => { poignee.onpointermove = poignee.onpointerup = poignee.onpointercancel = null; poignee.classList.remove('glisse'); document.body.classList.remove('glisse-panneau'); largeur(l, true); };
  };
  poignee.ondblclick = () => largeur(null);
  poignee.onkeydown = (ev) => { const pas = { ArrowLeft: 40, ArrowRight: -40 }[ev.key]; if (pas) { ev.preventDefault(); largeur(cote.offsetWidth + pas, true); } else if (ev.key === 'Home') { ev.preventDefault(); largeur(null); } };
  window.addEventListener('resize', () => carte.invalidateSize({ pan: false }));
  // Fonds de carte : les mêmes que la carte du réseau (sombre, plans, photos, topographique), relief et noms en surcouche
  const wmts = (couche, format = 'image/png', style = 'normal') => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${couche}&STYLE=${style}&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${format}`;
  const ign = '&copy; <a href="https://www.ign.fr/" target="_blank" rel="noopener">IGN</a> Géoplateforme';
  const t = acces.carte.tuiles;
  const fonds = {
    ...(t && t.url ? { 'Sombre': L.layerGroup([
      L.tileLayer(t.url, { maxZoom: 19, maxNativeZoom: t.zoomMaxNatif || 19, className: t.sombre ? 'tuiles-sombres' : '', attribution: t.attribution }),
      ...(t.etiquettes ? [L.tileLayer(t.etiquettes, { maxZoom: 19, maxNativeZoom: t.zoomMaxNatif || 19, className: 'etiquettes-claires' })] : []),
    ]) } : {}),
    'Plan IGN': L.tileLayer(wmts('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2'), { maxZoom: 19, attribution: ign }),
    'Plan IGN sombre': L.tileLayer(wmts('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2'), { maxZoom: 19, className: 'tuiles-sombres', attribution: ign }),
    'Photos aériennes IGN': L.tileLayer(wmts('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg'), { maxZoom: 19, attribution: ign }),
    'Topographique (relief)': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 19, maxNativeZoom: 17, subdomains: 'abc', attribution: 'Carte &copy; <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA), données &copy; contributeurs OpenStreetMap' }),
    'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, subdomains: 'abc', attribution: '&copy; contributeurs <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }),
  };
  const surcouches = {
    'Relief ombré': L.tileLayer(wmts('ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW', 'image/png', 'estompage_grayscale'), { maxZoom: 19, maxNativeZoom: 15, opacity: 0.4, attribution: ign }),
    'Noms des lieux': L.tileLayer(wmts('GEOGRAPHICALNAMES.NAMES'), { maxZoom: 19, maxNativeZoom: 18, className: 'noms-ign', attribution: ign }),
  };
  const fondChoisi = fonds[memo('fond')] ? memo('fond') : 'Plan IGN';
  fonds[fondChoisi].addTo(carte);
  document.body.classList.toggle('fond-sombre', /sombre/i.test(fondChoisi));
  let surcouchesChoisies = [];
  try { surcouchesChoisies = (JSON.parse(memo('surcouches') || '[]') || []).filter((n) => surcouches[n]); } catch { /* choix illisible : aucune surcouche */ }
  for (const n of surcouchesChoisies) surcouches[n].addTo(carte);
  L.control.layers(fonds, surcouches, { position: 'topright' }).addTo(carte);
  carte.on('baselayerchange', (e) => { memo('fond', e.name); document.body.classList.toggle('fond-sombre', /sombre/i.test(e.name)); });
  carte.on('overlayadd overlayremove', (e) => { if (!surcouches[e.name]) return; surcouchesChoisies = surcouchesChoisies.filter((n) => n !== e.name); if (e.type === 'overlayadd') surcouchesChoisies.push(e.name); memo('surcouches', JSON.stringify(surcouchesChoisies)); });
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(carte);
  const coucheReperes = L.layerGroup().addTo(carte), coucheTrajets = L.layerGroup().addTo(carte);
  const couchesEquipes = L.layerGroup().addTo(carte), couchesInter = L.layerGroup().addTo(carte), couchePointage = L.layerGroup().addTo(carte);

  // Pointage : « cliquez sur la carte » pour donner une position à une intervention ou à un poste
  let pointage = null;
  function pointer(texte, rappel) {
    pointage = rappel;
    $('#consigne').textContent = texte + ' (Échap pour annuler)'; $('#consigne').hidden = false;
    $('#carte').style.cursor = 'crosshair';
  }
  function finPointage() { pointage = null; contour = null; couchePointage.clearLayers(); $('#consigne').hidden = true; $('#carte').style.cursor = ''; }
  // Contour d'une zone : un clic par angle, « Terminer » quand il y en a au moins trois
  let contour = null;
  function dessinerContour() {
    couchePointage.clearLayers();
    if (!contour) return;
    if (contour.points.length > 1) L.polyline(contour.points, { color: '#ff6b79', weight: 3, dashArray: '6 6' }).addTo(couchePointage);
    for (const p of contour.points) L.circleMarker(p, { radius: 5, color: '#ff6b79', fillOpacity: 1 }).addTo(couchePointage);
    $('#consigne').innerHTML = `${esc(contour.texte)} — ${contour.points.length} point${contour.points.length > 1 ? 's' : ''} <button class="mini" id="z-retour" ${contour.points.length ? '' : 'disabled'}>↶ Retirer le dernier</button><button class="mini principal" id="z-fin" ${contour.points.length >= 3 ? '' : 'disabled'}>Terminer</button><button class="mini" id="z-annuler">Annuler</button>`;
    $('#z-retour').onclick = (ev) => { ev.stopPropagation(); contour.points.pop(); dessinerContour(); };
    $('#z-annuler').onclick = (ev) => { ev.stopPropagation(); finPointage(); };
    $('#z-fin').onclick = (ev) => { ev.stopPropagation(); const c = contour; finPointage(); c.rappel(c.points); };
  }
  function tracerZone(texte, rappel) { finPointage(); contour = { texte, rappel, points: [] }; $('#consigne').hidden = false; $('#carte').style.cursor = 'crosshair'; dessinerContour(); }
  carte.on('click', (e) => {
    if (contour) { if (contour.points.length < 60) contour.points.push([+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)]); dessinerContour(); return; }
    if (!pointage) return; const f = pointage; finPointage(); f({ lat: +e.latlng.lat.toFixed(6), lon: +e.latlng.lng.toFixed(6) });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (pointage || contour)) finPointage(); });
  function marquerPointage(p) { couchePointage.clearLayers(); if (p && p.lat != null) L.circleMarker([p.lat, p.lon], { radius: 9, color: '#3ee6c4', weight: 3, fillOpacity: 0.25 }).addTo(couchePointage); }

  const ICONES_EQ = { poste: '⛑', binome: '🚶', pc: '📡', vehicule: '🚑', terrain: '🚶', accueil: '🏠' };
  const nomEquipe = (id) => (E.equipes.find((e) => e.id === id) || {}).nom || null;
  // Position affichée d'une équipe : celle de son nœud si elle est connue, sinon son emplacement fixe
  const ou = (e) => (e.position ? { ...e.position, direct: true } : e.fixe ? { ...e.fixe, direct: false } : null);
  const nomOrg = (id) => (E.organisations.find((o) => o.id === id) || {}).nom || null;
  function dessinerCarte() {
    couchesEquipes.clearLayers(); couchesInter.clearLayers(); coucheReperes.clearLayers();
    $('#alerte-radio').hidden = !(E.options.alerteRadio && E.radio.tombee);
    for (const r of E.reperes) {
      const g = E.listes.reperes[r.genre] || {}, bulle = `<b>${esc(r.nom)}</b><br>${esc(g.nom || '')}${r.detail ? '<br>' + esc(r.detail) : ''}`;
      if (r.contour) L.polygon(r.contour, { color: '#ff6b79', weight: 3, fillOpacity: 0.16, dashArray: '8 6' }).bindPopup(bulle).bindTooltip(esc(r.nom), { permanent: true, direction: 'center', className: 'etq' }).addTo(coucheReperes);
      else L.marker([r.lat, r.lon], { icon: L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17], html: `<div class="rep-repere ${esc(r.genre)}">${esc(g.icone || '•')}</div>` }), zIndexOffset: 200 })
        .bindTooltip(esc(r.nom), { permanent: true, direction: 'bottom', offset: [0, 15], className: 'etq' }).bindPopup(bulle).addTo(coucheReperes);
    }
    for (const e of E.equipes) {
      const p = ou(e);
      if (!p) continue;
      const ancien = p.direct && p.heure && Date.now() - p.heure > 30 * 60000;
      L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: `<div class="rep-equipe${p.direct ? '' : ' fixe'}${ancien ? ' ancien' : ''}" style="background:${esc(e.couleur || '#4cc9f0')}">${ICONES_EQ[e.genre] || '•'}</div>` }), zIndexOffset: 500 })
        .bindTooltip(esc(e.nom), { permanent: true, direction: 'bottom', offset: [0, 14], className: 'etq' })
        .bindPopup(`<b>${esc(e.nom)}</b>${nomOrg(e.organisation) ? ' — ' + esc(nomOrg(e.organisation)) : ''}<br>${esc(E.listes.equipes[e.genre] || '')} · ${esc(E.listes.etats[e.etat] || e.etat)}<br>${p.direct ? `Position du nœud ${p.heure ? depuis(p.heure) : ''}` : 'Emplacement fixe'}`)
        .addTo(couchesEquipes);
    }
    for (const x of E.interventions) {
      if (x.lat == null) continue;
      if (x.statut === 'terminee' && Date.now() - (x.cloture || 0) > 3600000) continue; // terminée depuis plus d'une heure : hors carte
      L.marker([x.lat, x.lon], { icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: `<div class="rep-inter ${x.statut === 'a-faire' && x.urgente ? 'urgente' : esc(x.statut)}"><span>${x.statut === 'terminee' ? '✓' : '!'}</span></div>` }), zIndexOffset: x.statut === 'terminee' ? 0 : 900 })
        .bindPopup(`<b>${esc(x.titre)}</b><br>${esc(E.listes.interventions[x.genre] || '')}${x.equipe ? '<br>Équipe : ' + esc(nomEquipe(x.equipe) || '') : ''}<br>${heure(x.heure)}`)
        .addTo(couchesInter);
    }
  }
  // Trajets affichés (bouton « Trajet » d'une équipe) : relus toutes les minutes
  const trajets = new Map();
  async function majTrajets() {
    for (const id of [...trajets.keys()]) {
      const e = E.equipes.find((x) => x.id === id);
      if (!e || !e.noeud || !E.options.trajets) { trajets.delete(id); continue; }
      try { trajets.set(id, (await api(`${base}/equipes/${id}/trace?heures=12`)).points); } catch { trajets.delete(id); }
    }
    coucheTrajets.clearLayers();
    for (const [id, pts] of trajets) { const e = E.equipes.find((x) => x.id === id); if (e && pts.length > 1) L.polyline(pts.map((p) => [p[0], p[1]]), { color: e.couleur || '#4cc9f0', weight: 4, opacity: 0.85 }).bindTooltip(`Trajet de ${esc(e.nom)} (12 h)`, { sticky: true }).addTo(coucheTrajets); }
  }
  setInterval(() => { if (trajets.size && !document.hidden) majTrajets(); }, 60000);
  let minuterieAnnonce = null;
  function annoncer(texte) { $('#consigne').textContent = texte; $('#consigne').hidden = false; clearTimeout(minuterieAnnonce); minuterieAnnonce = setTimeout(() => { if (!pointage) $('#consigne').hidden = true; }, 5000); }
  const allerA = (p) => { if (p && p.lat != null) carte.setView([p.lat, p.lon], Math.max(carte.getZoom(), 16)); };
  // Premier affichage sans centre réglé : cadrer sur ce qui est posé sur la carte
  if (!E.centre) { const pts = [...E.equipes.map(ou).filter(Boolean), ...E.interventions.filter((x) => x.lat != null && x.statut !== 'terminee'), ...E.reperes].map((p) => [p.lat, p.lon]); if (pts.length) carte.fitBounds(pts, { maxZoom: 16, padding: [40, 40] }); }

  // ---- Onglets --------------------------------------------------------------------------------------------------
  const options = (liste, choisi, vide) => (vide != null ? `<option value="">${esc(vide)}</option>` : '') + Object.entries(liste).map(([k, v]) => `<option value="${esc(k)}" ${k === choisi ? 'selected' : ''}>${esc(typeof v === 'string' ? v : v.nom)}</option>`).join('');
  const optionsEquipes = (choisi, vide = '— aucune —') => `<option value="">${esc(vide)}</option>` + E.equipes.map((e) => `<option value="${esc(e.id)}" ${e.id === choisi ? 'selected' : ''}>${esc(e.nom)}</option>`).join('');
  // Saisie commencée dans l'onglet Gestion : il n'est pas redessiné tant qu'elle n'est pas enregistrée ou abandonnée
  let saisieGestion = false;
  // Le responsable qui est aussi administrateur de la carte (sa session de la carte est ouverte dans ce navigateur)
  // attribue les nœuds d'ici, sans repasser par la page de gestion des espaces. C'est sa session d'administrateur qui
  // l'autorise : un responsable sans elle ne voit rien de la liste des nœuds de la carte.
  let adminCarte = null;
  const lireAdminCarte = async () => { try { adminCarte = await api('/api/secours-admin/selecteur'); } catch { adminCarte = null; } };
  if (E.moi.responsable) await lireAdminCarte();
  let selOuvert = false, selRecherche = '';
  const selCoches = new Set();
  const menuOuvert = (zone) => { const a = document.activeElement; return !!a && a.tagName === 'SELECT' && zone.contains(a); };
  async function agir(f, zoneErreur) {
    if (document.activeElement && /^(BUTTON|SELECT)$/.test(document.activeElement.tagName)) document.activeElement.blur();
    try { await f(); saisieGestion = false; await rafraichir(true); return true; } catch (e) { if (zoneErreur) zoneErreur.textContent = e.message; else alert(e.message); return false; }
  }

  // Interventions
  const vInter = $('#vue-inter');
  const optionsPrio = (choisie) => Object.entries(E.listes.priorites).map(([k, v]) => `<option value="${k}" ${Number(k) === Number(choisie) ? 'selected' : ''}>${esc(v)}</option>`).join('');
  vInter.innerHTML = `<div id="i-bord"></div><button class="principal" id="i-nouvelle">➕ Nouvelle intervention</button>
    <div class="cadre" id="i-form" hidden>
      <div class="champs"><label>Nature <select id="i-genre">${options(E.listes.interventions)}</select></label>
        <label>Équipe engagée <select id="i-equipe"></select></label></div>
      <label>Intitulé court <input id="i-titre" maxlength="80" placeholder="ex. Chute au virage 4"></label>
      <div class="champs"><label>Lieu précis (dit à la radio) <input id="i-lieu" maxlength="80" placeholder="ex. Point B, près de la scène principale"></label>
        ${E.listes.etatsVictime ? `<label>État apparent <select id="i-etat">${options(E.listes.etatsVictime, null, '— non précisé —')}</select></label>` : ''}</div>
      <label style="margin-top:6px">Précisions <textarea id="i-detail" maxlength="600" placeholder="Accès, nombre de personnes, matériel utile…"></textarea></label>
      <p class="note">N’écrivez ni nom de victime ni information médicale nominative.</p>
      ${E.options.priorites ? `<div class="champs"><label>Priorité <select id="i-priorite">${optionsPrio(2)}</select></label></div>` : '<label class="case"><input type="checkbox" id="i-urgente"> Urgente</label>'}
      <div class="champs"><button id="i-pointer">📍 Pointer sur la carte</button><span id="i-pos" class="note">Aucune position</span></div>
      <div class="champs"><button class="principal" id="i-ok">Enregistrer</button><button id="i-annuler">Annuler</button><span id="i-retour" class="erreur"></span></div>
    </div>
    <div id="i-liste"></div>`;
  let posInter = null;
  const majPosInter = () => { $('#i-pos').textContent = posInter ? `${posInter.lat.toFixed(5)}, ${posInter.lon.toFixed(5)}` : 'Aucune position'; marquerPointage(posInter); };
  $('#i-nouvelle').onclick = () => { $('#i-form').hidden = false; $('#i-nouvelle').hidden = true; $('#i-equipe').innerHTML = optionsEquipes(null, '— à désigner —'); $('#i-titre').focus(); };
  const fermerInter = () => { $('#i-form').hidden = true; $('#i-nouvelle').hidden = false; posInter = null; majPosInter(); for (const k of ['#i-titre', '#i-detail', '#i-lieu']) $(k).value = ''; if ($('#i-etat')) $('#i-etat').value = ''; if ($('#i-urgente')) $('#i-urgente').checked = false; if ($('#i-priorite')) $('#i-priorite').value = '2'; $('#i-retour').textContent = ''; };
  $('#i-annuler').onclick = fermerInter;
  $('#i-pointer').onclick = () => pointer('Cliquez sur la carte à l’endroit de l’intervention', (p) => { posInter = p; majPosInter(); });
  $('#i-ok').onclick = async () => {
    const corps = { genre: $('#i-genre').value, titre: $('#i-titre').value, lieu: $('#i-lieu').value, ...($('#i-etat') ? { etat: $('#i-etat').value || null } : {}), detail: $('#i-detail').value, ...($('#i-priorite') ? { priorite: Number($('#i-priorite').value) } : { urgente: $('#i-urgente').checked }), equipe: $('#i-equipe').value || null, ...(posInter || {}) };
    if (await agir(() => api(base + '/interventions', { method: 'POST', body: corps }), $('#i-retour'))) fermerInter();
  };
  const LIB_STATUT = { 'a-faire': 'À faire', 'en-cours': 'En cours', terminee: 'Terminée' };
  function dessinerInter() {
    const l = $('#i-liste');
    if (menuOuvert(l)) return; // un menu est ouvert : ne pas le refermer sous les doigts
    const rang = (x) => (x.statut === 'terminee' ? 9 : (x.statut === 'en-cours' ? 4 : 0) + (x.priorite || 2));
    const liste = [...E.interventions].sort((a, b) => rang(a) - rang(b) || b.heure - a.heure);
    const ouvertes = liste.filter((x) => x.statut !== 'terminee');
    $('#onglets [data-vue="inter"]').dataset.nb = ouvertes.length || '';
    // Tableau de bord : où en est le dispositif, d'un coup d'œil
    const urgentes = ouvertes.filter((x) => x.priorite === 1 && x.statut === 'a-faire').length, sansEquipe = ouvertes.filter((x) => !x.equipe).length;
    const mobiles = E.equipes.filter((e) => e.genre !== 'pc'), libres = mobiles.filter((e) => e.etat === 'disponible' || e.etat === 'poste').length;
    $('#i-bord').innerHTML = E.options.priorites ? `<div class="tableau-bord" aria-label="Tableau de bord">
      <div class="${urgentes ? 'crit' : ''}"><b>${urgentes}</b>urgente${urgentes > 1 ? 's' : ''} à faire</div>
      <div class="${sansEquipe ? 'att' : ''}"><b>${sansEquipe}</b>sans équipe</div>
      <div><b>${ouvertes.filter((x) => x.statut === 'en-cours').length}</b>en cours</div>
      <div><b>${libres}/${mobiles.length}</b>équipe${mobiles.length > 1 ? 's' : ''} libre${libres > 1 ? 's' : ''}</div>
      <div><b>${liste.length - ouvertes.length}</b>terminée${liste.length - ouvertes.length > 1 ? 's' : ''} (12 h)</div></div>` : '';
    l.innerHTML = liste.length ? liste.map((x) => `
      <div class="fiche ${x.statut === 'terminee' ? 'terminee' : x.urgente ? 'urgente' : ''}" data-id="${esc(x.id)}">
        <div class="tete"><b translate="no">${esc(x.titre)}</b>${x.urgente && x.statut !== 'terminee' ? '<span class="pastille crit">Urgente</span>' : ''}${E.options.priorites && x.priorite === 3 && x.statut !== 'terminee' ? '<span class="pastille">Peut attendre</span>' : ''}<span class="pastille ${x.statut === 'terminee' ? 'ok' : x.statut === 'en-cours' ? '' : 'att'}">${LIB_STATUT[x.statut]}</span><span class="heure">${heure(x.heure)}</span></div>
        <div class="note">${esc(E.listes.interventions[x.genre] || '')} · signalée par <span translate="no">${esc(x.auteur || '?')}</span>${x.origine === 'radio' ? ' 📻 par radio' : ''}</div>
        ${x.lieu || x.etat ? `<div class="corps" translate="no">${x.lieu ? '📍 ' + esc(x.lieu) : ''}${x.lieu && x.etat ? ' · ' : ''}${x.etat ? esc((E.listes.etatsVictime || {})[x.etat] || x.etat) : ''}</div>` : ''}
        ${x.detail ? `<div class="corps" translate="no">${esc(x.detail)}</div>` : ''}
        <div class="actions">
          <select class="eq" aria-label="Équipe engagée">${optionsEquipes(x.equipe, '— équipe à désigner —')}</select>
          ${E.options.priorites && x.statut !== 'terminee' ? `<select class="prio" aria-label="Priorité">${optionsPrio(x.priorite || 2)}</select>` : ''}
          ${x.statut !== 'terminee' ? '<button class="mini principal fin">✓ Terminée</button>' : '<button class="mini rouvrir">Rouvrir</button>'}
          ${x.lat != null ? '<button class="mini voir">Voir</button>' : '<button class="mini placer">📍 Placer</button>'}
          ${E.radio.peutEnvoyer && x.statut !== 'terminee' ? '<button class="mini radio" title="Envoyer cette intervention par radio, en message direct">📻 Envoyer</button>' : ''}
        </div>
      </div>`).join('') : '<div class="vide">Aucune intervention en cours.</div>';
    for (const f of l.querySelectorAll('.fiche')) {
      const x = E.interventions.find((y) => y.id === f.dataset.id), maj = (corps) => agir(() => api(`${base}/interventions/${x.id}`, { method: 'PATCH', body: corps }));
      $('.eq', f).onchange = (ev) => { ev.target.blur(); maj({ equipe: ev.target.value || null }); };
      if ($('.prio', f)) $('.prio', f).onchange = (ev) => { ev.target.blur(); maj({ priorite: Number(ev.target.value) }); };
      if ($('.fin', f)) $('.fin', f).onclick = () => maj({ statut: 'terminee' });
      if ($('.rouvrir', f)) $('.rouvrir', f).onclick = () => maj({ statut: x.equipe ? 'en-cours' : 'a-faire' });
      if ($('.voir', f)) $('.voir', f).onclick = () => allerA(x);
      if ($('.placer', f)) $('.placer', f).onclick = () => pointer(`Cliquez sur la carte : « ${x.titre} »`, (p) => maj(p));
      if ($('.radio', f)) $('.radio', f).onclick = async () => {
        const a = x.equipe ? E.equipes.find((e) => e.id === x.equipe) : null;
        const qui = a ? `à « ${a.nom} »` : E.canal.utilisable ? `à toutes les équipes, sur le canal « ${E.canal.nom} »` : `à toutes les équipes qui portent un nœud (${E.equipes.filter((e) => e.noeud).length})`;
        if (!confirm(`Envoyer l’intervention « ${x.titre} » par radio ${qui} ?\nLe message donne le lieu précis, la nature et l’état apparent.`)) return;
        try { const r = await api(`${base}/interventions/${x.id}/diffuser`, { method: 'POST', body: {} }); await rafraichir(true); annoncer(`📻 Envoyé à ${r.destinataires.join(', ')}`); }
        catch (e) { alert(e.message); }
      };
    }
  }

  // Équipes
  const vEq = $('#vue-equipes');
  const optionsOrgs = (choisi, vide = '— sans organisation —') => `<option value="">${esc(vide)}</option>` + E.organisations.map((o) => `<option value="${esc(o.id)}" ${o.id === choisi ? 'selected' : ''}>${esc(o.nom)}</option>`).join('');
  let filtreOrg = '';
  vEq.innerHTML = `<div id="e-resume"></div><div class="champs" id="e-filtre" hidden><label>Afficher <select id="e-org-filtre"></select></label></div>
    ${E.moi.responsable ? `<button class="principal" id="e-nouvelle">➕ Nouvelle équipe ou nouveau poste</button>
    <div class="cadre" id="e-form" hidden>
      <div class="champs"><label>Nom <input id="e-nom" maxlength="40" placeholder="ex. Poste scène, Binôme Alpha"></label>
        <label>Type <select id="e-genre">${options(E.listes.equipes)}</select></label></div>
      <div class="champs" id="e-org-ligne"><label>Organisation <select id="e-org"></select></label></div>
      <div class="champs"><label>Effectif prévu <input id="e-effectif" type="number" min="0" max="500" inputmode="numeric"></label>
        <label>Nœud LoRa porté <select id="e-noeud"></select></label>
        <label>Couleur <input id="e-couleur" type="color" value="#4cc9f0"></label></div>
      ${adminCarte ? '<div class="champs"><button class="mini" id="e-plus-noeuds">➕ Ajouter des nœuds à l’espace</button><span class="note">s’il manque dans la liste ci-dessus</span></div>' : ''}
      <label>Consigne <input id="e-consigne" maxlength="200" placeholder="ex. Reste à l’entrée nord jusqu’à 23 h"></label>
      <div class="champs"><button id="e-pointer">📍 Emplacement fixe sur la carte</button><button id="e-sans-pos" class="mini">Aucun</button><span id="e-pos" class="note"></span></div>
      <div class="champs"><button class="principal" id="e-ok">Enregistrer</button><button id="e-annuler">Annuler</button><button class="danger mini" id="e-supprimer" hidden>Supprimer</button><span id="e-retour" class="erreur"></span></div>
    </div>` : ''}
    <div id="e-liste"></div>`;
  let eqEdit = null, posEq = null;
  const majPosEq = () => { if ($('#e-pos')) $('#e-pos').textContent = posEq ? `${posEq.lat.toFixed(5)}, ${posEq.lon.toFixed(5)}` : 'Pas d’emplacement fixe'; marquerPointage(posEq); };
  function ouvrirEquipe(e) {
    eqEdit = e ? e.id : null; posEq = e && e.fixe ? { ...e.fixe } : null;
    $('#e-form').hidden = false; $('#e-nouvelle').hidden = true; $('#e-retour').textContent = '';
    $('#e-nom').value = e ? e.nom : ''; $('#e-genre').value = e ? e.genre : Object.keys(E.listes.equipes)[0];
    $('#e-org').innerHTML = optionsOrgs(e ? e.organisation : filtreOrg || null); $('#e-org-ligne').hidden = !E.organisations.length;
    $('#e-effectif').value = e && e.effectif != null ? e.effectif : ''; $('#e-consigne').value = (e && e.consigne) || ''; $('#e-couleur').value = (e && e.couleur) || '#4cc9f0';
    const pris = new Map(E.equipes.filter((q) => q.noeud && q.id !== eqEdit).map((q) => [q.noeud.num, q.nom]));
    $('#e-noeud').innerHTML = '<option value="">— aucun —</option>' + (E.noeuds || []).map((n) => `<option value="${esc(n.id)}" ${e && e.noeud && e.noeud.num === n.num ? 'selected' : ''} ${pris.has(n.num) ? 'disabled' : ''}>${esc(n.nom ? `${n.nom} (${n.id})` : n.id)}${pris.has(n.num) ? ' — ' + esc(pris.get(n.num)) : ''}</option>`).join('');
    $('#e-supprimer').hidden = !e;
    majPosEq(); $('#e-nom').focus(); $('#e-form').scrollIntoView({ block: 'nearest' });
  }
  const fermerEquipe = () => { $('#e-form').hidden = true; $('#e-nouvelle').hidden = false; eqEdit = null; posEq = null; marquerPointage(null); };
  if (E.moi.responsable) {
    $('#e-nouvelle').onclick = () => ouvrirEquipe(null);
    $('#e-annuler').onclick = fermerEquipe;
    $('#e-pointer').onclick = () => pointer('Cliquez sur la carte à l’emplacement du poste', (p) => { posEq = p; majPosEq(); });
    $('#e-sans-pos').onclick = () => { posEq = null; majPosEq(); };
    if ($('#e-plus-noeuds')) $('#e-plus-noeuds').onclick = () => { selOuvert = true; $('#onglets [data-vue="gestion"]').click(); const d = $('#g-selecteur'); if (d) { d.scrollIntoView({ block: 'start' }); $('#g-s-recherche').focus(); } };
    $('#e-ok').onclick = async () => {
      const corps = { nom: $('#e-nom').value, genre: $('#e-genre').value, organisation: $('#e-org').value || null, effectif: $('#e-effectif').value, noeud: $('#e-noeud').value || null, consigne: $('#e-consigne').value, couleur: $('#e-couleur').value, lat: posEq ? posEq.lat : null, lon: posEq ? posEq.lon : null };
      if (await agir(() => api(eqEdit ? `${base}/equipes/${eqEdit}` : `${base}/equipes`, { method: eqEdit ? 'PATCH' : 'POST', body: corps }), $('#e-retour'))) fermerEquipe();
    };
    $('#e-supprimer').onclick = async () => { if (confirm('Supprimer cette équipe ? Ses interventions restent dans la liste, sans équipe.') && await agir(() => api(`${base}/equipes/${eqEdit}`, { method: 'PATCH', body: { supprimer: true } }), $('#e-retour'))) fermerEquipe(); };
  }
  function dessinerEquipes() {
    const r = $('#e-resume'), ev = E.evenement, ef = E.effectif;
    r.innerHTML = E.genre === 'dps' ? `<div class="fiche"><div class="tete"><b>Effectif prévu : ${ef.prevu} secouriste${ef.prevu > 1 ? 's' : ''}</b>${ef.categorie ? `<span class="pastille ${ef.conforme ? 'ok' : 'att'}">${esc(ef.categorie.nom)} : ${ef.categorie.min === ef.categorie.max ? ef.categorie.min : ef.categorie.max == null ? 'plus de ' + (ef.categorie.min - 1) : ef.categorie.min + ' à ' + ef.categorie.max}</span>` : ''}</div>
      <div class="note">${ev.publicAttendu ? `Public attendu : ${ev.publicAttendu.toLocaleString('fr-FR')} · ` : ''}${ef.categorie ? (ef.conforme ? 'Effectif dans la fourchette de la catégorie.' : 'Effectif hors de la fourchette de la catégorie choisie.') + ' Repère indicatif : le dimensionnement réel sort de votre grille d’évaluation des risques.' : 'Choisissez la catégorie du dispositif dans Gestion pour comparer l’effectif au référentiel.'}</div></div>` : '';
    const l = $('#e-liste');
    if (menuOuvert(l) || menuOuvert($('#e-filtre'))) return;
    // Plusieurs organisations dans l'espace : effectif de chacune, et un filtre sur la liste
    if (filtreOrg && !E.organisations.some((o) => o.id === filtreOrg)) filtreOrg = '';
    $('#e-filtre').hidden = !E.organisations.length;
    $('#e-org-filtre').innerHTML = optionsOrgs(filtreOrg, `Toutes les organisations (${E.equipes.length})`).replace(/<option value="([^"]+)"([^>]*)>([^<]*)<\/option>/g, (m, id, plus, nom) => { const q = E.equipes.filter((e) => e.organisation === id); return `<option value="${id}"${plus}>${nom} — ${q.length} équipe${q.length > 1 ? 's' : ''}, ${q.reduce((t, e) => t + (e.effectif || 0), 0)} prévus</option>`; });
    $('#e-org-filtre').onchange = (ev2) => { filtreOrg = ev2.target.value; ev2.target.blur(); dessinerEquipes(); };
    const visibles = E.equipes.filter((e) => !filtreOrg || e.organisation === filtreOrg);
    l.innerHTML = visibles.length ? visibles.map((e) => {
      const p = ou(e), peut = E.moi.responsable || E.moi.equipe === e.id;
      return `<div class="fiche" data-id="${esc(e.id)}" style="--c:${esc(e.couleur || '#4cc9f0')}">
        <div class="tete"><b translate="no">${ICONES_EQ[e.genre] || ''} ${esc(e.nom)}</b><span class="pastille ${e.etat === 'intervention' ? 'crit' : e.etat === 'indisponible' || e.etat === 'pause' ? 'att' : 'ok'}">${esc(E.listes.etats[e.etat] || e.etat)}</span><span class="heure">${e.etatHeure ? depuis(e.etatHeure) : ''}</span></div>
        <div class="note">${nomOrg(e.organisation) ? `<b translate="no">${esc(nomOrg(e.organisation))}</b> · ` : ''}${esc(E.listes.equipes[e.genre] || '')}${e.effectif != null ? ` · ${e.effectif} prévu${e.effectif > 1 ? 's' : ''}` : ''}${e.noeud ? ` · nœud <span class="mono" translate="no">${esc(e.noeud.nom || e.noeud.id)}</span>` : ' · sans nœud'}</div>
        ${e.membres.length ? `<div class="note" translate="no">👤 ${e.membres.map((m) => esc(m.nom) + (m.fonction ? ` (${esc(m.fonction)})` : '')).join(', ')}</div>` : ''}
        ${e.consigne ? `<div class="corps" translate="no">${esc(e.consigne)}</div>` : ''}
        <div class="note">${p ? (p.direct ? `📻 Position reçue ${p.heure ? depuis(p.heure) : ''}` : '📌 Emplacement fixe') : e.noeud ? '📻 En attente de la position du nœud' : 'Pas de position'}${e.sante && e.sante.batterie != null ? (e.sante.batterie <= 20 ? ` <span class="pastille crit">🪫 Batterie ${e.sante.batterie} %</span>` : ` · 🔋 ${e.sante.batterie > 100 ? 'sur secteur' : e.sante.batterie + ' %'}`) : ''}</div>
        <div class="actions">${peut ? `<select class="etat" aria-label="État de l’équipe">${options(E.listes.etats, e.etat)}</select>` : ''}${p ? '<button class="mini voir">Voir</button>' : ''}${E.options.trajets && e.noeud ? `<button class="mini trajet ${trajets.has(e.id) ? 'actif' : ''}" aria-pressed="${trajets.has(e.id)}">〰 Trajet</button>` : ''}${E.moi.responsable ? '<button class="mini modifier">Modifier</button>' : ''}</div>
      </div>`;
    }).join('') : `<div class="vide">${E.equipes.length ? 'Aucune équipe dans cette organisation.' : 'Aucune équipe.' + (E.moi.responsable ? ' Créez les postes et les équipes du dispositif.' : '')}</div>`;
    for (const f of l.querySelectorAll('.fiche')) {
      const e = E.equipes.find((q) => q.id === f.dataset.id);
      if ($('.etat', f)) $('.etat', f).onchange = (ev2) => { ev2.target.blur(); agir(() => api(`${base}/equipes/${e.id}/etat`, { method: 'PUT', body: { etat: ev2.target.value } })); };
      if ($('.voir', f)) $('.voir', f).onclick = () => allerA(ou(e));
      if ($('.trajet', f)) $('.trajet', f).onclick = async () => {
        if (trajets.has(e.id)) trajets.delete(e.id); else trajets.set(e.id, []);
        await majTrajets();
        if (trajets.has(e.id)) { const pts = trajets.get(e.id); if (pts.length > 1) carte.fitBounds(pts.map((q) => [q[0], q[1]]), { maxZoom: 17, padding: [40, 40] }); else annoncer(`Aucun trajet connu pour « ${e.nom} » sur les 12 dernières heures`); }
        dessinerEquipes();
      };
      if ($('.modifier', f)) $('.modifier', f).onclick = () => ouvrirEquipe(e);
    }
  }

  // Repères : points de rassemblement (partout), repères d'un PCS (option)
  const vRep = $('#vue-reperes');
  const peutReperes = E.radio.peutEnvoyer || E.moi.responsable;
  vRep.innerHTML = `${peutReperes ? `<div class="champs"><button class="principal" id="p-rassemblement">🟢 Nouveau point de rassemblement</button><button id="p-autre" hidden>➕ Autre repère</button></div>
    <div class="cadre" id="p-form" hidden>
      <div class="champs"><label>Type <select id="p-genre"></select></label><label>Nom <input id="p-nom" maxlength="60" placeholder="ex. Parking de la mairie"></label></div>
      <label>Précisions <input id="p-detail" maxlength="300" placeholder="ex. Côté portail nord"></label>
      <div class="champs"><button id="p-pointer">📍 Pointer sur la carte</button><span id="p-pos" class="note"></span></div>
      <div class="champs"><button class="principal" id="p-ok">Enregistrer</button><button id="p-annuler">Annuler</button><button class="danger mini" id="p-supprimer" hidden>Supprimer</button><span id="p-retour" class="erreur"></span></div>
    </div>` : ''}
    <p class="note">Un point de rassemblement est visible de tout l’espace. ${E.radio.peutEnvoyer ? 'Son bouton 📻 l’envoie aux équipes par radio, avec sa position et son code DFCI : « tout le monde se retrouve ici ».' : ''}</p>
    <div id="p-liste"></div>`;
  let repEdit = null, posRep = null, contourRep = null;
  const surface = () => !!(E.listes.reperes[$('#p-genre').value] || {}).surface;
  const majPosRep = () => {
    $('#p-pointer').textContent = surface() ? '✏️ Dessiner la zone sur la carte' : '📍 Pointer sur la carte';
    $('#p-pos').textContent = surface() ? (contourRep ? `Zone de ${contourRep.length} points` : 'Zone à dessiner') : posRep ? `${posRep.lat.toFixed(5)}, ${posRep.lon.toFixed(5)}` : 'Aucune position';
    if (!surface()) marquerPointage(posRep);
  };
  function ouvrirRepere(r, genre = 'rassemblement') {
    repEdit = r ? r.id : null; posRep = r && !r.contour ? { lat: r.lat, lon: r.lon } : null; contourRep = r && r.contour ? r.contour : null;
    $('#p-form').hidden = false; $('#p-retour').textContent = '';
    $('#p-genre').innerHTML = Object.entries(E.listes.reperes).map(([k, g]) => `<option value="${esc(k)}" ${k === (r ? r.genre : genre) ? 'selected' : ''}>${esc(g.icone)} ${esc(g.nom)}</option>`).join('');
    $('#p-nom').value = r ? r.nom : ''; $('#p-detail').value = (r && r.detail) || ''; $('#p-supprimer').hidden = !r;
    majPosRep(); $('#p-nom').focus(); $('#p-form').scrollIntoView({ block: 'nearest' });
  }
  const fermerRepere = () => { $('#p-form').hidden = true; repEdit = null; posRep = null; contourRep = null; marquerPointage(null); };
  if (peutReperes) {
    $('#p-rassemblement').onclick = () => ouvrirRepere(null, 'rassemblement');
    $('#p-autre').onclick = () => ouvrirRepere(null, Object.keys(E.listes.reperes).find((k) => k !== 'rassemblement') || 'rassemblement');
    $('#p-genre').onchange = majPosRep;
    $('#p-annuler').onclick = fermerRepere;
    $('#p-pointer').onclick = () => (surface() ? tracerZone('Cliquez sur la carte à chaque angle de la zone', (pts) => { contourRep = pts; majPosRep(); }) : pointer('Cliquez sur la carte à l’endroit du repère', (q) => { posRep = q; majPosRep(); }));
    $('#p-ok').onclick = async () => {
      const corps = { genre: $('#p-genre').value, nom: $('#p-nom').value, detail: $('#p-detail').value, ...(surface() ? { contour: contourRep || undefined } : posRep || {}) };
      if (await agir(() => api(repEdit ? `${base}/reperes/${repEdit}` : `${base}/reperes`, { method: repEdit ? 'PATCH' : 'POST', body: corps }), $('#p-retour'))) fermerRepere();
    };
    $('#p-supprimer').onclick = async () => { if (confirm('Supprimer ce repère ?') && await agir(() => api(`${base}/reperes/${repEdit}`, { method: 'PATCH', body: { supprimer: true } }), $('#p-retour'))) fermerRepere(); };
  }
  function dessinerReperes() {
    if (peutReperes) $('#p-autre').hidden = Object.keys(E.listes.reperes).length < 2;
    $('#onglets [data-vue="reperes"]').dataset.nb = E.reperes.filter((r) => r.genre === 'rassemblement').length || '';
    const l = $('#p-liste');
    l.innerHTML = E.reperes.length ? E.reperes.map((r) => { const g = E.listes.reperes[r.genre] || {};
      return `<div class="fiche" data-id="${esc(r.id)}" style="--c:${r.genre === 'rassemblement' ? '#3ee68a' : r.contour ? '#ff6b79' : '#4cc9f0'}">
        <div class="tete"><b translate="no">${esc(g.icone || '')} ${esc(r.nom)}</b><span class="pastille">${esc(g.nom || r.genre)}</span></div>
        ${r.detail ? `<div class="corps" translate="no">${esc(r.detail)}</div>` : ''}
        <div class="note mono">${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}</div>
        <div class="actions"><button class="mini voir">Voir</button>${E.radio.peutEnvoyer ? '<button class="mini radio" title="Envoyer ce repère aux équipes par radio">📻 Envoyer aux équipes</button>' : ''}${peutReperes ? '<button class="mini modifier">Modifier</button>' : ''}</div>
      </div>`; }).join('') : '<div class="vide">Aucun repère pour l’instant.</div>';
    for (const f of l.querySelectorAll('.fiche')) {
      const r = E.reperes.find((x) => x.id === f.dataset.id);
      $('.voir', f).onclick = () => (r.contour ? carte.fitBounds(r.contour, { maxZoom: 17, padding: [40, 40] }) : allerA(r));
      if ($('.modifier', f)) $('.modifier', f).onclick = () => ouvrirRepere(r);
      if ($('.radio', f)) $('.radio', f).onclick = async () => {
        const qui = E.canal.utilisable ? `à toutes les équipes, sur le canal « ${E.canal.nom} »` : `à toutes les équipes qui portent un nœud (${E.equipes.filter((e) => e.noeud).length})`;
        if (!confirm(`Envoyer « ${r.nom} » par radio ${qui} ?`)) return;
        try { const x = await api(`${base}/reperes/${r.id}/diffuser`, { method: 'POST', body: {} }); await rafraichir(true); annoncer(`📻 Envoyé à ${x.destinataires.join(', ')}`); }
        catch (e) { alert(e.message); }
      };
    }
  }

  // Main courante
  const vMc = $('#vue-mc');
  const LIB_MC = { information: 'Information', 'message-recu': 'Message reçu', 'message-emis': 'Message émis', decision: 'Décision', mouvement: 'Mouvement', intervention: 'Intervention', fin: 'Fin' };
  vMc.innerHTML = `<label>Nouvelle entrée <textarea id="m-texte" maxlength="1000" placeholder="Fait, décision, message reçu ou transmis…"></textarea></label>
    <div class="champs"><label>Type <select id="m-type">${['information', 'decision', 'message-recu', 'message-emis', 'mouvement'].map((k) => `<option value="${k}">${LIB_MC[k]}</option>`).join('')}</select></label>
      <button class="principal" id="m-ok">Noter</button><a class="bouton" href="${base}/main-courante.csv" download>⬇ CSV</a></div>
    <div id="m-retour" class="erreur"></div>
    <p class="note">Les entrées ne se modifient pas : pour corriger, ajoutez-en une nouvelle. 📻 = passé par la radio.</p>
    ${E.radio.peutEnvoyer ? `<div class="cadre"><b>📻 Écrire au terrain par radio</b>
      <div class="champs"><label>Destinataire <select id="r-dest"></select></label></div>
      <div class="macros" id="r-macros"></div>
      <label>Message (court : 200 caractères au plus) <input id="r-texte" maxlength="200" placeholder="ex. Rejoignez le poste scène"></label>
      <div class="champs"><button class="principal" id="r-ok">Envoyer</button><span id="r-retour" class="erreur"></span></div>
      <p class="note" id="r-etat"></p></div>` : ''}
    <div id="m-liste"></div>`;
  if (E.radio.peutEnvoyer) $('#r-ok').onclick = async () => {
    const z = $('#r-retour'); z.className = 'erreur'; z.textContent = '';
    try {
      const r = await api(base + '/envoi', { method: 'POST', body: { texte: $('#r-texte').value, equipe: $('#r-dest').value || null } });
      $('#r-texte').value = ''; z.className = 'reussi'; z.textContent = `Envoyé à ${r.destinataires.join(', ')}`;
      await rafraichir(true);
    } catch (e) { z.textContent = e.message; }
  };
  $('#m-ok').onclick = async () => { if (await agir(() => api(base + '/main-courante', { method: 'POST', body: { texte: $('#m-texte').value, type: $('#m-type').value } }), $('#m-retour'))) { $('#m-texte').value = ''; $('#m-retour').textContent = ''; } };
  function dessinerMc() {
    if (E.radio.peutEnvoyer && !menuOuvert(vMc)) {
      const avec = E.equipes.filter((e) => e.noeud), choisi = $('#r-dest').value;
      $('#r-macros').innerHTML = (E.options.macros ? E.macros : []).map((m, i) => `<button class="mini" data-i="${i}" translate="no">${esc(m)}</button>`).join('');
      for (const b of $('#r-macros').querySelectorAll('button')) b.onclick = () => { $('#r-texte').value = E.macros[Number(b.dataset.i)]; $('#r-texte').focus(); };
      $('#r-dest').innerHTML = `<option value="">${E.canal.utilisable ? `Toutes les équipes, en un message sur le canal « ${esc(E.canal.nom)} »` : `Toutes les équipes qui portent un nœud (${avec.length})`}</option>` + avec.map((e) => `<option value="${esc(e.id)}" ${e.id === choisi ? 'selected' : ''}>${esc(e.nom)}</option>`).join('');
      $('#r-etat').textContent = !E.radio.disponible ? 'Envoi par radio indisponible sur cette carte.' : !E.radio.connecte ? '⚠ Le module radio de la carte n’est pas connecté : rien ne peut partir pour l’instant.' : 'Message direct au nœud de l’équipe ; l’accusé de réception s’affiche dans la main courante.';
      $('#r-ok').disabled = !E.radio.connecte || (!avec.length && !E.canal.utilisable);
    }
    $('#m-liste').innerHTML = E.mainCourante.length ? E.mainCourante.map((x) => `<div class="entree"><div class="tete"><span>${heure(x.heure)}</span><b translate="no">${esc(x.auteur || '')}</b><span class="pastille">${esc(LIB_MC[x.type] || x.type)}</span>${x.origine === 'radio' ? '<span title="Passé par la radio">📻</span>' : ''}${x.accuse ? `<span class="pastille ${x.accuse === 'recu' ? 'ok' : x.accuse === 'echec' ? 'crit' : ''}">${esc(E.radio.accuses[x.accuse] || x.accuse)}</span>` : ''}${x.equipe && nomEquipe(x.equipe) ? `<span translate="no">${esc(nomEquipe(x.equipe))}</span>` : ''}</div><div class="corps" translate="no">${esc(x.texte)}</div></div>`).join('') : '<div class="vide">Main courante vide.</div>';
  }

  // Gestion (responsable) et « mon compte » (tous)
  const vG = $('#vue-gestion');
  vG.addEventListener('input', () => { saisieGestion = true; });
  const versChamp = (t) => { if (!t) return ''; const d = new Date(t - new Date(t).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
  function dessinerGestion() {
    if (saisieGestion || menuOuvert(vG)) return;
    const ev = E.evenement;
    vG.innerHTML = `${E.moi.responsable ? `
      <h2>Réglages de l’espace</h2>
      <div class="champs"><label class="large">Nom <input id="g-nom" maxlength="60" value="${esc(E.nom)}"></label></div>
      ${E.genre === 'dps' ? `<div class="champs"><label class="large">Lieu de l’événement <input id="g-lieu" maxlength="120" value="${esc(ev.lieu || '')}"></label></div>
      <div class="champs"><label>Début <input id="g-debut" type="datetime-local" value="${versChamp(ev.debut)}"></label><label>Fin <input id="g-fin" type="datetime-local" value="${versChamp(ev.fin)}"></label></div>
      <div class="champs"><label>Public attendu <input id="g-public" type="number" min="0" inputmode="numeric" value="${ev.publicAttendu ?? ''}"></label>
        <label>Catégorie du dispositif <select id="g-categorie">${options(Object.fromEntries(Object.entries(E.listes.categories).map(([k, c]) => [k, `${c.nom} (${c.min === c.max ? c.min : c.max == null ? 'plus de ' + (c.min - 1) : c.min + ' à ' + c.max} secouristes)`])), ev.categorie, '— non précisée —')}</select></label></div>` : ''}
      <div class="champs"><label>Conservation de la main courante (jours) <input id="g-conservation" type="number" min="7" max="3650" value="${E.conservationJours}"></label></div>
      <div class="champs"><button id="g-centre">🗺 Ouvrir la carte sur la vue actuelle</button><button class="principal" id="g-ok">Enregistrer</button><span id="g-retour" class="erreur"></span></div>

      <h2>Options de l’espace</h2>
      <p class="note">Activez ce dont votre dispositif a besoin ; le reste disparaît de l’écran de tous les membres.</p>
      ${Object.entries(E.catalogueOptions).map(([k, o]) => `<label class="case"><input type="checkbox" class="g-option" value="${esc(k)}" ${E.options[k] ? 'checked' : ''}><span><b>${esc(o.nom)}</b> — <span class="note">${esc(o.aide)}</span></span></label>`).join('')}
      ${E.catalogueOptions.canal ? `<p class="note">Canal réservé : ${E.canal.nom ? `« <span translate="no">${esc(E.canal.nom)}</span> »${E.canal.utilisable || !E.options.canal ? '' : ' — introuvable sur le module radio de la carte pour l’instant'}` : 'aucun. L’administrateur de la carte peut en réserver un à cet espace.'}</p>` : ''}
      <label style="margin-top:8px">Messages-types (un par ligne, 12 au plus, 200 caractères chacun) <textarea id="g-macros" rows="5" spellcheck="true">${esc(E.macros.join('\n'))}</textarea></label>
      <label style="margin-top:8px">Adresses e-mail prévenues d’une intervention urgente (${E.courriel.disponible ? '5 au plus, séparées par des virgules' : 'l’envoi d’e-mails n’est pas réglé sur cette carte : demandez-le à son administrateur'}) <input id="g-courriels" type="text" inputmode="email" autocapitalize="off" spellcheck="false" value="${esc(E.courriel.adresses.join(', '))}" placeholder="pc@exemple.fr, astreinte@exemple.fr"></label>
      <p class="note">Pour un SMS, utilisez l’adresse e-mail-vers-SMS de votre opérateur ou de votre service d’alerte, s’il en propose une : la carte n’envoie pas de SMS elle-même.</p>
      <div class="champs"><button class="principal" id="g-options-ok">Enregistrer les options</button>${E.options.rapport ? `<a class="bouton" href="${base}/rapport.html" download>⬇ Rapport de fin</a>` : ''}<span id="g-options-retour" class="erreur"></span></div>

      <h2>Organisations</h2>
      <p class="note">${E.genre === 'dps' ? 'Les associations qui tiennent ce dispositif ensemble' : 'Les services et associations engagés par la commune'}. Tout l’espace reste commun : c’est un rangement des équipes et des nœuds.</p>
      <div class="puces">${E.organisations.map((o) => `<span class="pastille puce" style="border-color:${esc(o.couleur || '#4cc9f0')}"><span translate="no">${esc(o.nom)}</span> <button class="mini g-o-suppr" data-id="${esc(o.id)}" aria-label="Retirer ${esc(o.nom)}">✕</button></span>`).join('') || '<span class="note">Aucune pour l’instant.</span>'}</div>
      <div class="champs"><label>Ajouter <select id="g-o-choix">${E.listes.organisations.filter((n) => !E.organisations.some((o) => o.nom.toLowerCase() === n.toLowerCase())).map((n) => `<option>${esc(n)}</option>`).join('')}<option value="">Autre…</option></select></label>
        <label id="g-o-libre" hidden>Son nom <input id="g-o-nom" maxlength="60"></label><button id="g-o-ajout">Ajouter</button><span id="g-o-retour" class="erreur"></span></div>

      <h2>Comptes</h2>
      <p class="note">Ces comptes n’existent que dans cet espace : ils ne donnent accès ni à la carte du réseau radio ni à une autre organisation.</p>
      <table><tbody>${E.comptes.map((c) => `<tr data-id="${c.id}"><td><b translate="no">${esc(c.identifiant)}</b>${c.responsable ? ' <span class="pastille ok">responsable</span>' : ''}${c.statut !== 'actif' ? ' <span class="pastille att">désactivé</span>' : ''}<br><span class="note">${c.derniere ? 'vu ' + depuis(c.derniere) : 'jamais connecté'}${c.fonction ? ' · ' + esc(c.fonction) : ''}</span></td>
        <td><select class="c-equipe" aria-label="Équipe du compte">${optionsEquipes(c.equipe)}</select>
          <div class="champs" style="margin-top:4px"><button class="mini c-resp">${c.responsable ? 'Retirer responsable' : 'Nommer responsable'}</button><button class="mini c-mdp">Nouveau mot de passe</button><button class="mini c-actif">${c.statut === 'actif' ? 'Désactiver' : 'Réactiver'}</button>${c.id !== E.moi.id ? '<button class="mini danger c-suppr">Supprimer</button>' : ''}</div></td></tr>`).join('')}</tbody></table>
      <div id="g-c-retour" class="erreur"></div>
      <h3>Ajouter un compte</h3>
      <div class="champs"><label>Identifiant <input id="n-id" autocomplete="off" maxlength="32"></label><label>Mot de passe (8 caractères au moins) <input id="n-mdp" type="password" autocomplete="new-password"></label></div>
      <div class="champs"><label>Équipe <select id="n-equipe">${optionsEquipes(null)}</select></label><label>Fonction <input id="n-fonction" maxlength="40" placeholder="ex. Chef de poste"></label></div>
      <div class="champs"><label class="case"><input type="checkbox" id="n-resp"> Responsable</label><button class="principal" id="n-ok">Créer le compte</button><span id="n-retour" class="erreur"></span></div>

      <h2>Nœuds LoRa de l’espace</h2>
      ${adminCarte ? `
      ${E.noeuds.length ? `<table><tbody>${E.noeuds.map((n) => `<tr data-noeud="${esc(n.id)}"><td><b translate="no">${esc(n.nom || '—')}</b><br><span class="mono note">${esc(n.id)}</span></td>
        <td><select class="gn-org" aria-label="Organisation du nœud">${optionsOrgs(n.organisation)}</select></td><td><button class="mini danger gn-retirer">Retirer</button></td></tr>`).join('')}</tbody></table>` : '<p class="bandeau">Aucun nœud n’est attribué à cet espace : choisissez ci-dessous ceux que porteront vos équipes.</p>'}
      ${E.attentes.length ? `<p class="note">En attente (pas encore vus par la carte, attribués dès qu’ils s’allument) :</p><div class="puces">${E.attentes.map((a) => `<span class="pastille puce att"><span class="mono" translate="no">${esc(a.nom)}</span>${nomOrg(a.organisation) ? ' · ' + esc(nomOrg(a.organisation)) : ''} <button class="mini gn-attente" data-nom="${esc(a.nom)}" aria-label="Ne plus attendre ${esc(a.nom)}">✕</button></span>`).join('')}</div>` : ''}
      <details class="selecteur" id="g-selecteur" ${selOuvert ? 'open' : ''}><summary>➕ Choisir des nœuds dans la liste de la carte</summary>
        <label>Chercher (nom court, nom long ou numéro) <input id="g-s-recherche" type="search" value="${esc(selRecherche)}" placeholder="ex. PS01, Poste scène, !a1b2c3d4" autocapitalize="off" spellcheck="false"></label>
        <div class="s-liste" id="g-s-liste"></div>
        <div class="champs"><label>Ranger dans <select id="g-s-org">${optionsOrgs(null)}</select></label><button class="mini principal" id="g-s-attribuer">Attribuer les nœuds cochés</button></div>
        <div class="champs"><label>Nœud pas encore allumé : son nom court <input id="g-s-attente" class="mono" maxlength="12" placeholder="ex. PS01" autocapitalize="off" spellcheck="false"></label><button class="mini" id="g-s-attendre">L’attendre</button></div>
        <p class="note">Le nœud attendu rejoint l’espace dès que la carte voit un nœud portant ce nom court. Si plusieurs nœuds portent le même nom, rien n’est attribué : choisissez-le alors dans la liste.</p>
      </details>
      <div id="g-n-retour" class="erreur"></div>
      <p class="note">Vous voyez la liste des nœuds de la carte parce que votre session d’administrateur de la carte est ouverte dans ce navigateur. Les autres responsables de l’espace ne la voient pas.</p>` : `
      ${E.attentes.length ? `<p class="note">Attendus, pas encore allumés : <span class="mono" translate="no">${E.attentes.map((a) => esc(a.nom)).join(', ')}</span></p>` : ''}
      ${E.noeuds.length ? `<p translate="no" class="mono">${E.noeuds.map((n) => esc(n.nom ? `${n.nom} (${n.id})` : n.id) + (nomOrg(n.organisation) ? ` — ${esc(nomOrg(n.organisation))}` : '')).join('<br>')}</p>` : '<p class="bandeau">Aucun nœud n’est attribué à cet espace. Demandez à l’administrateur de la carte d’y ajouter les nœuds que porteront vos équipes.</p>'}
      <p class="note">Seul l’administrateur de la carte attribue des nœuds : l’espace ne voit que ceux-là.</p>`}` : ''}

      <h2>Depuis le terrain, par radio</h2>
      <p class="note">Un message texte envoyé par le nœud d’une équipe arrive ici :</p>
      <table><tbody>
        <tr><td class="mono">INTER chute au virage 4</td><td>crée une intervention à la position du nœud</td></tr>
        <tr><td class="mono">FIN</td><td>termine l’intervention en cours de l’équipe</td></tr>
        <tr><td class="mono">DISPO · POSTE · PAUSE · INDISPO</td><td>change l’état de l’équipe</td></tr>
        ${E.options.points ? '<tr><td>un point de passage (application Meshtastic)</td><td>crée une intervention à cet endroit ; supprimé, il la termine</td></tr>' : ''}
        <tr><td>tout autre message</td><td>est noté dans la main courante</td></tr>
      </tbody></table>

      <h2>Vers le terrain, par radio</h2>
      <p class="note">Les responsables et le poste de coordination écrivent aux équipes depuis l’onglet 🗒️ Main courante, ou envoient une intervention avec son bouton 📻. C’est toujours un <b>message direct</b> au nœud de l’équipe (jamais un canal lu par tout le réseau), avec la position et le code DFCI pour une intervention. « reçu » s’affiche quand le nœud a accusé réception.</p>

      <h2>Mon mot de passe</h2>
      <div class="champs"><label>Actuel <input id="p-ancien" type="password" autocomplete="current-password"></label><label>Nouveau <input id="p-nouveau" type="password" autocomplete="new-password"></label></div>
      <div class="champs"><button id="p-ok">Changer</button><span id="p-retour" class="erreur"></span></div>`;
    $('#p-ok').onclick = async () => {
      try { await api(base + '/mot-de-passe', { method: 'PUT', body: { ancien: $('#p-ancien').value, nouveau: $('#p-nouveau').value } }); $('#p-retour').className = 'reussi'; $('#p-retour').textContent = 'Mot de passe changé.'; $('#p-ancien').value = $('#p-nouveau').value = ''; }
      catch (e) { $('#p-retour').className = 'erreur'; $('#p-retour').textContent = e.message; }
    };
    if (!E.moi.responsable) return;
    let centre;
    $('#g-centre').onclick = () => { const c = carte.getCenter(); centre = { lat: c.lat, lon: c.lng, zoom: carte.getZoom() }; $('#g-centre').classList.add('actif'); $('#g-centre').textContent = '🗺 Vue actuelle retenue'; };
    const date = (s) => ($(s) && $(s).value ? new Date($(s).value).getTime() : null);
    $('#g-ok').onclick = async () => {
      const corps = { nom: $('#g-nom').value, conservationJours: $('#g-conservation').value, ...(centre ? { centre } : {}),
        ...(E.genre === 'dps' ? { lieu: $('#g-lieu').value, debut: date('#g-debut'), fin: date('#g-fin'), publicAttendu: $('#g-public').value, categorie: $('#g-categorie').value || null } : {}) };
      if (await agir(() => api(base + '/reglages', { method: 'PUT', body: corps }), $('#g-retour'))) { $('#titre').textContent = E.nom; document.title = E.nom; }
    };
    $('#g-options-ok').onclick = async () => {
      const corps = { options: Object.fromEntries([...vG.querySelectorAll('.g-option')].map((x) => [x.value, x.checked])), macros: $('#g-macros').value.split('\n'), courriels: $('#g-courriels').value };
      if (await agir(() => api(base + '/reglages', { method: 'PUT', body: corps }), $('#g-options-retour'))) location.reload(); // les formulaires dépendent des options
    };
    $('#g-o-choix').onchange = () => { $('#g-o-libre').hidden = $('#g-o-choix').value !== ''; };
    $('#g-o-libre').hidden = $('#g-o-choix').value !== '';
    $('#g-o-ajout').onclick = () => agir(() => api(base + '/organisations', { method: 'POST', body: { nom: $('#g-o-choix').value || $('#g-o-nom').value } }), $('#g-o-retour'));
    for (const b of vG.querySelectorAll('.g-o-suppr')) b.onclick = () => { if (confirm('Retirer cette organisation ? Ses équipes et ses nœuds restent dans l’espace, sans organisation.')) agir(() => api(`${base}/organisations/${b.dataset.id}`, { method: 'PATCH', body: { supprimer: true } }), $('#g-o-retour')); };
    for (const tr of vG.querySelectorAll('tr[data-id]')) {
      const c = E.comptes.find((x) => x.id === Number(tr.dataset.id)), maj = (corps) => { return agir(() => api(`${base}/comptes/${c.id}`, { method: 'PATCH', body: corps }), $('#g-c-retour')); };
      $('.c-equipe', tr).onchange = (ev2) => maj({ equipe: ev2.target.value || null });
      $('.c-resp', tr).onclick = () => maj({ responsable: !c.responsable });
      $('.c-actif', tr).onclick = () => maj({ actif: c.statut !== 'actif' });
      $('.c-mdp', tr).onclick = () => { const m = prompt(`Nouveau mot de passe de ${c.identifiant} (8 caractères au moins) :`); if (m) maj({ motDePasse: m }); };
      if ($('.c-suppr', tr)) $('.c-suppr', tr).onclick = () => { if (confirm(`Supprimer le compte ${c.identifiant} ?`)) maj({ supprimer: true }); };
    }
    // Nœuds de l'espace, pour le responsable qui est aussi administrateur de la carte
    if (adminCarte) {
      const retour = $('#g-n-retour'), liste = $('#g-s-liste'), d = $('#g-selecteur');
      const adminEspace = (corps) => agir(async () => { await api('/api/secours-admin/espaces/' + code, { method: 'PATCH', body: corps }); await lireAdminCarte(); }, retour);
      const lister = () => {
        const r = selRecherche.trim().toLowerCase();
        const tous = adminCarte.noeuds.filter((n) => n.espace !== code && (!r || `${n.court || ''} ${n.long || ''} ${n.id}`.toLowerCase().includes(r))), vus = tous.slice(0, 60);
        liste.innerHTML = (vus.length ? vus.map((n) => `<label class="case ligne-noeud"><input type="checkbox" value="${esc(n.id)}" ${selCoches.has(n.id) ? 'checked' : ''} ${n.espace ? 'disabled' : ''}><span><b translate="no">${esc(n.court || '—')}</b> <span translate="no">${esc(n.long || '')}</span> <span class="mono note">${esc(n.id)}</span> <span class="note">${n.espace ? '— déjà dans un autre espace' : n.vu ? `· vu ${depuis(n.vu)}` : ''}</span></span></label>`).join('') : '<div class="vide">Aucun nœud de la carte ne correspond.</div>')
          + (tous.length > vus.length ? `<p class="note">${tous.length - vus.length} autres nœuds : précisez la recherche.</p>` : '');
        $('#g-s-attribuer').textContent = selCoches.size ? `Attribuer les nœuds cochés (${selCoches.size})` : 'Attribuer les nœuds cochés';
      };
      if (selOuvert) lister();
      d.ontoggle = () => { selOuvert = d.open; if (d.open) lister(); };
      liste.onchange = (ev2) => { if (ev2.target.checked) selCoches.add(ev2.target.value); else selCoches.delete(ev2.target.value); $('#g-s-attribuer').textContent = selCoches.size ? `Attribuer les nœuds cochés (${selCoches.size})` : 'Attribuer les nœuds cochés'; };
      $('#g-s-recherche').oninput = (ev2) => { selRecherche = ev2.target.value; lister(); };
      $('#g-s-attribuer').onclick = () => { const n = [...selCoches]; if (!n.length) { retour.textContent = 'Cochez au moins un nœud dans la liste.'; return; } const org = $('#g-s-org').value || null; selCoches.clear(); selRecherche = ''; adminEspace({ attribuer: { noeuds: n, organisation: org } }); };
      $('#g-s-attendre').onclick = () => adminEspace({ attendre: { nom: $('#g-s-attente').value.trim(), organisation: $('#g-s-org').value || null } });
      for (const b of vG.querySelectorAll('.gn-attente')) b.onclick = () => adminEspace({ retirerAttente: b.dataset.nom });
      for (const tr of vG.querySelectorAll('tr[data-noeud]')) {
        $('.gn-org', tr).onchange = (ev2) => { ev2.target.blur(); adminEspace({ attribuer: { noeuds: [tr.dataset.noeud], organisation: ev2.target.value || null } }); };
        $('.gn-retirer', tr).onclick = () => { if (confirm(`Retirer le nœud ${tr.dataset.noeud} de cet espace ? L’équipe qui le porte n’aura plus de position.`)) adminEspace({ retirer: [tr.dataset.noeud] }); };
      }
    }
    $('#n-ok').onclick = async () => {
      const corps = { identifiant: $('#n-id').value, motDePasse: $('#n-mdp').value, equipe: $('#n-equipe').value || null, fonction: $('#n-fonction').value, responsable: $('#n-resp').checked };
      await agir(() => api(base + '/comptes', { method: 'POST', body: corps }), $('#n-retour'));
    };
  }

  const dessins = { inter: dessinerInter, equipes: dessinerEquipes, reperes: dessinerReperes, mc: dessinerMc, gestion: dessinerGestion };
  let vueActive = 'inter';
  function dessinerTout() { dessinerCarte(); dessinerInter(); dessinerReperes(); if (vueActive !== 'inter' && vueActive !== 'reperes') dessins[vueActive](); }
  for (const b of document.querySelectorAll('#onglets button')) b.onclick = () => {
    vueActive = b.dataset.vue; saisieGestion = false;
    for (const x of document.querySelectorAll('#onglets button')) x.classList.toggle('actif', x === b);
    for (const v of document.querySelectorAll('.vue')) v.classList.toggle('actif', v.id === 'vue-' + vueActive);
    dessins[vueActive]();
  };

  // ---- Rafraîchissement : toutes les 5 s ; le détail ne revient que s'il a changé, les positions à chaque fois -----
  let enCours = false;
  async function rafraichir(force = false) {
    if (enCours && !force) return;
    enCours = true;
    try {
      const r = await api(`${base}/etat${force ? '' : '?rev=' + E.rev}`);
      if (r.inchange) { for (const q of r.equipes) { const e = E.equipes.find((x) => x.id === q.id); if (e) { e.position = q.position; e.etat = q.etat; e.sante = q.sante; } } 
        let change = E.radio.connecte !== r.radioConnectee; E.radio.connecte = r.radioConnectee; E.radio.tombee = r.radioTombee;
        for (const a of r.accuses || []) { const m = E.mainCourante.find((x) => x.id === a.id); if (m && m.accuse !== a.accuse) { m.accuse = a.accuse; change = true; } }
        dessinerCarte(); if (vueActive === 'equipes') dessinerEquipes(); if (change && vueActive === 'mc') dessinerMc(); }
      else { const avant = JSON.stringify(E.options); E = r; if (JSON.stringify(r.options) !== avant && !saisieGestion) { location.reload(); return; } dessinerTout(); }
    } catch (e) { if (e.statut === 401) location.reload(); if (force) throw e; } finally { enCours = false; }
  }
  setInterval(() => { if (!document.hidden) rafraichir().catch(() => {}); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) rafraichir().catch(() => {}); });
  dessinerTout();
})();
