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
    let espaces;
    try { espaces = (await api('/api/secours-admin/espaces')).espaces; } catch {
      page.innerHTML = `<div class="plein etroit"><h2>Espaces Secours</h2>
        <p>Ces espaces servent aux associations de sécurité civile (dispositifs prévisionnels de secours) et aux communes (plan communal de sauvegarde).</p>
        <p>Pour entrer dans le vôtre, utilisez l’adresse que votre responsable vous a donnée : <span class="mono">/secours/nom-de-l-espace</span>.</p>
        <p class="note">Administrateur de la carte : <a class="bouton mini" href="/?compte=connexion&amp;retour=/secours">connectez-vous à la carte</a> pour gérer les espaces.</p></div>`;
      return;
    }
    $('#titre').textContent = 'Espaces Secours';
    $('#moi').innerHTML = '<a class="bouton mini" href="/">← Carte</a>';
    const dessiner = (message = '') => {
      page.innerHTML = `<div class="plein">
        <h2>Espaces Secours de cette carte</h2>
        <p class="note">Chaque espace est séparé de tout le reste : son propre fichier de données, ses propres comptes (sans aucun accès à la carte ni à la section ADRASEC), et il ne voit du réseau que les nœuds que vous lui attribuez ici. Vous créez l’espace et nommez son responsable ; vous n’entrez pas dedans.</p>
        ${message}
        <div id="liste">${espaces.length ? espaces.map((e) => `
          <div class="fiche" data-code="${esc(e.code)}">
            <div class="tete"><b>${esc(e.nom)}</b><span class="pastille">${esc((e.genre || '').toUpperCase())}</span><span class="heure">${e.comptes} compte${e.comptes > 1 ? 's' : ''} · ${e.equipes} équipe${e.equipes > 1 ? 's' : ''}</span></div>
            <p>Adresse à donner aux membres : <a class="mono" href="/secours/${esc(e.code)}">${esc(location.origin)}/secours/${esc(e.code)}</a></p>
            <p class="note">Responsable${e.responsables.length > 1 ? 's' : ''} : ${e.responsables.map(esc).join(', ') || '<span class="erreur">aucun</span>'}</p>
            <label class="large">Nœuds attribués (un par ligne ou séparés par des espaces, ex. !a1b2c3d4)
              <textarea class="mono noeuds" rows="2" spellcheck="false">${esc(e.noeudsAttribues.map((n) => n.id).join(' '))}</textarea></label>
            ${e.noeudsAttribues.some((n) => n.nom) ? `<p class="note">${e.noeudsAttribues.filter((n) => n.nom).map((n) => `${esc(n.id)} = ${esc(n.nom)}`).join(' · ')}</p>` : ''}
            <div class="actions">
              <button class="mini principal enregistrer-noeuds">Enregistrer les nœuds</button>
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
          <label>Identifiant du premier responsable <input id="n-rid" autocomplete="off"></label>
          <label>Son mot de passe (8 caractères au moins) <input id="n-rmdp" type="password" autocomplete="new-password"></label>
        </div>
        <label>Nœuds attribués (facultatif, modifiable ensuite) <textarea id="n-noeuds" class="mono" rows="2" placeholder="!a1b2c3d4 !0badcafe" spellcheck="false"></textarea></label>
        <div class="champs"><button id="n-creer" class="principal">Créer l’espace</button><span id="n-retour" class="erreur"></span></div>
      </div>`;
      // Adresse proposée d'après le nom, tant qu'elle n'a pas été saisie à la main
      let adresseLibre = true;
      $('#n-code').oninput = () => { adresseLibre = false; };
      $('#n-nom').oninput = () => { if (adresseLibre) $('#n-code').value = $('#n-nom').value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32); };
      $('#n-creer').onclick = async () => {
        try {
          espaces = (await api('/api/secours-admin/espaces', { method: 'POST', body: { nom: $('#n-nom').value, genre: $('#n-genre').value, code: $('#n-code').value, responsable: { identifiant: $('#n-rid').value, motDePasse: $('#n-rmdp').value }, noeuds: $('#n-noeuds').value } })).espaces;
          dessiner('<p class="reussi">Espace créé. Donnez son adresse, l’identifiant et le mot de passe au responsable.</p>');
        } catch (e) { $('#n-retour').textContent = e.message; }
      };
      for (const f of page.querySelectorAll('.fiche[data-code]')) {
        const c = f.dataset.code, retour = $('.retour', f);
        const appel = async (methode, corps, ok) => { try { espaces = (await api('/api/secours-admin/espaces/' + c, { method: methode, body: corps })).espaces; dessiner(`<p class="reussi">${ok}</p>`); } catch (e) { retour.textContent = e.message; } };
        $('.enregistrer-noeuds', f).onclick = () => appel('PATCH', { noeuds: $('.noeuds', f).value }, 'Nœuds enregistrés.');
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
    <aside>
      <nav class="onglets" id="onglets">
        <button data-vue="inter" class="actif">📍 Interventions</button>
        <button data-vue="equipes">👥 Équipes</button>
        <button data-vue="mc">🗒️ Main courante</button>
        <button data-vue="gestion">⚙️ ${E.moi.responsable ? 'Gestion' : 'Mon compte'}</button>
      </nav>
      <section class="vue actif" id="vue-inter"></section>
      <section class="vue" id="vue-equipes"></section>
      <section class="vue" id="vue-mc"></section>
      <section class="vue" id="vue-gestion"></section>
    </aside>`;
  $('#moi').innerHTML = `<span>${esc(E.moi.identifiant)}${E.moi.responsable ? ' · responsable' : ''}</span><button class="mini" id="sortir">Se déconnecter</button>`;
  $('#sortir').onclick = async () => { await api(base + '/deconnexion', { method: 'POST' }).catch(() => {}); location.reload(); };

  // ---- Carte --------------------------------------------------------------------------------------------------
  const depart = E.centre ? [[E.centre.lat, E.centre.lon], E.centre.zoom] : [acces.carte.centre, acces.carte.zoom || 10];
  const carte = L.map('carte', { zoomControl: true }).setView(depart[0], depart[1]);
  const wmts = (couche, format = 'image/png') => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${couche}&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${format}`;
  const ign = '&copy; <a href="https://www.ign.fr/" target="_blank" rel="noopener">IGN</a> Géoplateforme';
  const fonds = {
    'Plan IGN': L.tileLayer(wmts('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2'), { maxZoom: 19, attribution: ign }),
    'Photos aériennes IGN': L.tileLayer(wmts('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg'), { maxZoom: 19, attribution: ign }),
    'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, subdomains: 'abc', attribution: '&copy; contributeurs <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }),
  };
  const memo = (k, v) => { try { if (v === undefined) return localStorage.getItem('secours-' + k); localStorage.setItem('secours-' + k, v); } catch { /* navigateur sans stockage */ } return null; };
  fonds[fonds[memo('fond')] ? memo('fond') : 'Plan IGN'].addTo(carte);
  L.control.layers(fonds, null, { position: 'topright' }).addTo(carte);
  carte.on('baselayerchange', (e) => memo('fond', e.name));
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(carte);
  const couchesEquipes = L.layerGroup().addTo(carte), couchesInter = L.layerGroup().addTo(carte), couchePointage = L.layerGroup().addTo(carte);

  // Pointage : « cliquez sur la carte » pour donner une position à une intervention ou à un poste
  let pointage = null;
  function pointer(texte, rappel) {
    pointage = rappel;
    $('#consigne').textContent = texte + ' (Échap pour annuler)'; $('#consigne').hidden = false;
    $('#carte').style.cursor = 'crosshair';
  }
  function finPointage() { pointage = null; $('#consigne').hidden = true; $('#carte').style.cursor = ''; }
  carte.on('click', (e) => { if (!pointage) return; const f = pointage; finPointage(); f({ lat: +e.latlng.lat.toFixed(6), lon: +e.latlng.lng.toFixed(6) }); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pointage) finPointage(); });
  function marquerPointage(p) { couchePointage.clearLayers(); if (p && p.lat != null) L.circleMarker([p.lat, p.lon], { radius: 9, color: '#3ee6c4', weight: 3, fillOpacity: 0.25 }).addTo(couchePointage); }

  const ICONES_EQ = { poste: '⛑', binome: '🚶', pc: '📡', vehicule: '🚑', terrain: '🚶', accueil: '🏠' };
  const nomEquipe = (id) => (E.equipes.find((e) => e.id === id) || {}).nom || null;
  // Position affichée d'une équipe : celle de son nœud si elle est connue, sinon son emplacement fixe
  const ou = (e) => (e.position ? { ...e.position, direct: true } : e.fixe ? { ...e.fixe, direct: false } : null);
  function dessinerCarte() {
    couchesEquipes.clearLayers(); couchesInter.clearLayers();
    for (const e of E.equipes) {
      const p = ou(e);
      if (!p) continue;
      const ancien = p.direct && p.heure && Date.now() - p.heure > 30 * 60000;
      L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: `<div class="rep-equipe${p.direct ? '' : ' fixe'}${ancien ? ' ancien' : ''}" style="background:${esc(e.couleur || '#4cc9f0')}">${ICONES_EQ[e.genre] || '•'}</div>` }), zIndexOffset: 500 })
        .bindTooltip(esc(e.nom), { permanent: true, direction: 'bottom', offset: [0, 14], className: 'etq' })
        .bindPopup(`<b>${esc(e.nom)}</b><br>${esc(E.listes.equipes[e.genre] || '')} · ${esc(E.listes.etats[e.etat] || e.etat)}<br>${p.direct ? `Position du nœud ${p.heure ? depuis(p.heure) : ''}` : 'Emplacement fixe'}`)
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
  let minuterieAnnonce = null;
  function annoncer(texte) { $('#consigne').textContent = texte; $('#consigne').hidden = false; clearTimeout(minuterieAnnonce); minuterieAnnonce = setTimeout(() => { if (!pointage) $('#consigne').hidden = true; }, 5000); }
  const allerA = (p) => { if (p && p.lat != null) carte.setView([p.lat, p.lon], Math.max(carte.getZoom(), 16)); };
  // Premier affichage sans centre réglé : cadrer sur ce qui est posé sur la carte
  if (!E.centre) { const pts = [...E.equipes.map(ou).filter(Boolean), ...E.interventions.filter((x) => x.lat != null && x.statut !== 'terminee')].map((p) => [p.lat, p.lon]); if (pts.length) carte.fitBounds(pts, { maxZoom: 16, padding: [40, 40] }); }

  // ---- Onglets --------------------------------------------------------------------------------------------------
  const options = (liste, choisi, vide) => (vide != null ? `<option value="">${esc(vide)}</option>` : '') + Object.entries(liste).map(([k, v]) => `<option value="${esc(k)}" ${k === choisi ? 'selected' : ''}>${esc(typeof v === 'string' ? v : v.nom)}</option>`).join('');
  const optionsEquipes = (choisi, vide = '— aucune —') => `<option value="">${esc(vide)}</option>` + E.equipes.map((e) => `<option value="${esc(e.id)}" ${e.id === choisi ? 'selected' : ''}>${esc(e.nom)}</option>`).join('');
  // Saisie commencée dans l'onglet Gestion : il n'est pas redessiné tant qu'elle n'est pas enregistrée ou abandonnée
  let saisieGestion = false;
  const menuOuvert = (zone) => { const a = document.activeElement; return !!a && a.tagName === 'SELECT' && zone.contains(a); };
  async function agir(f, zoneErreur) {
    if (document.activeElement && /^(BUTTON|SELECT)$/.test(document.activeElement.tagName)) document.activeElement.blur();
    try { await f(); saisieGestion = false; await rafraichir(true); return true; } catch (e) { if (zoneErreur) zoneErreur.textContent = e.message; else alert(e.message); return false; }
  }

  // Interventions
  const vInter = $('#vue-inter');
  vInter.innerHTML = `<button class="principal" id="i-nouvelle">➕ Nouvelle intervention</button>
    <div class="cadre" id="i-form" hidden>
      <div class="champs"><label>Nature <select id="i-genre">${options(E.listes.interventions)}</select></label>
        <label>Équipe engagée <select id="i-equipe"></select></label></div>
      <label>Intitulé court <input id="i-titre" maxlength="80" placeholder="ex. Chute au virage 4"></label>
      <label style="margin-top:6px">Précisions <textarea id="i-detail" maxlength="600" placeholder="Accès, nombre de personnes, matériel utile…"></textarea></label>
      <p class="note">N’écrivez ni nom de victime ni information médicale nominative.</p>
      <label class="case"><input type="checkbox" id="i-urgente"> Urgente</label>
      <div class="champs"><button id="i-pointer">📍 Pointer sur la carte</button><span id="i-pos" class="note">Aucune position</span></div>
      <div class="champs"><button class="principal" id="i-ok">Enregistrer</button><button id="i-annuler">Annuler</button><span id="i-retour" class="erreur"></span></div>
    </div>
    <div id="i-liste"></div>`;
  let posInter = null;
  const majPosInter = () => { $('#i-pos').textContent = posInter ? `${posInter.lat.toFixed(5)}, ${posInter.lon.toFixed(5)}` : 'Aucune position'; marquerPointage(posInter); };
  $('#i-nouvelle').onclick = () => { $('#i-form').hidden = false; $('#i-nouvelle').hidden = true; $('#i-equipe').innerHTML = optionsEquipes(null, '— à désigner —'); $('#i-titre').focus(); };
  const fermerInter = () => { $('#i-form').hidden = true; $('#i-nouvelle').hidden = false; posInter = null; majPosInter(); for (const k of ['#i-titre', '#i-detail']) $(k).value = ''; $('#i-urgente').checked = false; $('#i-retour').textContent = ''; };
  $('#i-annuler').onclick = fermerInter;
  $('#i-pointer').onclick = () => pointer('Cliquez sur la carte à l’endroit de l’intervention', (p) => { posInter = p; majPosInter(); });
  $('#i-ok').onclick = async () => {
    const corps = { genre: $('#i-genre').value, titre: $('#i-titre').value, detail: $('#i-detail').value, urgente: $('#i-urgente').checked, equipe: $('#i-equipe').value || null, ...(posInter || {}) };
    if (await agir(() => api(base + '/interventions', { method: 'POST', body: corps }), $('#i-retour'))) fermerInter();
  };
  const LIB_STATUT = { 'a-faire': 'À faire', 'en-cours': 'En cours', terminee: 'Terminée' };
  function dessinerInter() {
    const l = $('#i-liste');
    if (menuOuvert(l)) return; // un menu est ouvert : ne pas le refermer sous les doigts
    const rang = (x) => (x.statut === 'terminee' ? 3 : x.statut === 'en-cours' ? 1 : x.urgente ? 0 : 2);
    const liste = [...E.interventions].sort((a, b) => rang(a) - rang(b) || b.heure - a.heure);
    const ouvertes = liste.filter((x) => x.statut !== 'terminee').length;
    $('#onglets [data-vue="inter"]').dataset.nb = ouvertes || '';
    l.innerHTML = liste.length ? liste.map((x) => `
      <div class="fiche ${x.statut === 'terminee' ? 'terminee' : x.urgente ? 'urgente' : ''}" data-id="${esc(x.id)}">
        <div class="tete"><b translate="no">${esc(x.titre)}</b>${x.urgente && x.statut !== 'terminee' ? '<span class="pastille crit">Urgente</span>' : ''}<span class="pastille ${x.statut === 'terminee' ? 'ok' : x.statut === 'en-cours' ? '' : 'att'}">${LIB_STATUT[x.statut]}</span><span class="heure">${heure(x.heure)}</span></div>
        <div class="note">${esc(E.listes.interventions[x.genre] || '')} · signalée par <span translate="no">${esc(x.auteur || '?')}</span>${x.origine === 'radio' ? ' 📻 par radio' : ''}</div>
        ${x.detail ? `<div class="corps" translate="no">${esc(x.detail)}</div>` : ''}
        <div class="actions">
          <select class="eq" aria-label="Équipe engagée">${optionsEquipes(x.equipe, '— équipe à désigner —')}</select>
          ${x.statut !== 'terminee' ? '<button class="mini principal fin">✓ Terminée</button>' : '<button class="mini rouvrir">Rouvrir</button>'}
          ${x.lat != null ? '<button class="mini voir">Voir</button>' : '<button class="mini placer">📍 Placer</button>'}
          ${E.radio.peutEnvoyer && x.statut !== 'terminee' ? '<button class="mini radio" title="Envoyer cette intervention par radio, en message direct">📻 Envoyer</button>' : ''}
        </div>
      </div>`).join('') : '<div class="vide">Aucune intervention en cours.</div>';
    for (const f of l.querySelectorAll('.fiche')) {
      const x = E.interventions.find((y) => y.id === f.dataset.id), maj = (corps) => agir(() => api(`${base}/interventions/${x.id}`, { method: 'PATCH', body: corps }));
      $('.eq', f).onchange = (ev) => { ev.target.blur(); maj({ equipe: ev.target.value || null }); };
      if ($('.fin', f)) $('.fin', f).onclick = () => maj({ statut: 'terminee' });
      if ($('.rouvrir', f)) $('.rouvrir', f).onclick = () => maj({ statut: x.equipe ? 'en-cours' : 'a-faire' });
      if ($('.voir', f)) $('.voir', f).onclick = () => allerA(x);
      if ($('.placer', f)) $('.placer', f).onclick = () => pointer(`Cliquez sur la carte : « ${x.titre} »`, (p) => maj(p));
      if ($('.radio', f)) $('.radio', f).onclick = async () => {
        const a = x.equipe ? E.equipes.find((e) => e.id === x.equipe) : null;
        const qui = a ? `à « ${a.nom} »` : `à toutes les équipes qui portent un nœud (${E.equipes.filter((e) => e.noeud).length})`;
        if (!confirm(`Envoyer l’intervention « ${x.titre} » par radio ${qui} ?`)) return;
        try { const r = await api(`${base}/interventions/${x.id}/diffuser`, { method: 'POST', body: {} }); await rafraichir(true); annoncer(`📻 Envoyé à ${r.destinataires.join(', ')}`); }
        catch (e) { alert(e.message); }
      };
    }
  }

  // Équipes
  const vEq = $('#vue-equipes');
  vEq.innerHTML = `<div id="e-resume"></div>
    ${E.moi.responsable ? `<button class="principal" id="e-nouvelle">➕ Nouvelle équipe ou nouveau poste</button>
    <div class="cadre" id="e-form" hidden>
      <div class="champs"><label>Nom <input id="e-nom" maxlength="40" placeholder="ex. Poste scène, Binôme Alpha"></label>
        <label>Type <select id="e-genre">${options(E.listes.equipes)}</select></label></div>
      <div class="champs"><label>Effectif prévu <input id="e-effectif" type="number" min="0" max="500" inputmode="numeric"></label>
        <label>Nœud LoRa porté <select id="e-noeud"></select></label>
        <label>Couleur <input id="e-couleur" type="color" value="#4cc9f0"></label></div>
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
    $('#e-ok').onclick = async () => {
      const corps = { nom: $('#e-nom').value, genre: $('#e-genre').value, effectif: $('#e-effectif').value, noeud: $('#e-noeud').value || null, consigne: $('#e-consigne').value, couleur: $('#e-couleur').value, lat: posEq ? posEq.lat : null, lon: posEq ? posEq.lon : null };
      if (await agir(() => api(eqEdit ? `${base}/equipes/${eqEdit}` : `${base}/equipes`, { method: eqEdit ? 'PATCH' : 'POST', body: corps }), $('#e-retour'))) fermerEquipe();
    };
    $('#e-supprimer').onclick = async () => { if (confirm('Supprimer cette équipe ? Ses interventions restent dans la liste, sans équipe.') && await agir(() => api(`${base}/equipes/${eqEdit}`, { method: 'PATCH', body: { supprimer: true } }), $('#e-retour'))) fermerEquipe(); };
  }
  function dessinerEquipes() {
    const r = $('#e-resume'), ev = E.evenement, ef = E.effectif;
    r.innerHTML = E.genre === 'dps' ? `<div class="fiche"><div class="tete"><b>Effectif prévu : ${ef.prevu} secouriste${ef.prevu > 1 ? 's' : ''}</b>${ef.categorie ? `<span class="pastille ${ef.conforme ? 'ok' : 'att'}">${esc(ef.categorie.nom)} : ${ef.categorie.min === ef.categorie.max ? ef.categorie.min : ef.categorie.max == null ? 'plus de ' + (ef.categorie.min - 1) : ef.categorie.min + ' à ' + ef.categorie.max}</span>` : ''}</div>
      <div class="note">${ev.publicAttendu ? `Public attendu : ${ev.publicAttendu.toLocaleString('fr-FR')} · ` : ''}${ef.categorie ? (ef.conforme ? 'Effectif dans la fourchette de la catégorie.' : 'Effectif hors de la fourchette de la catégorie choisie.') + ' Repère indicatif : le dimensionnement réel sort de votre grille d’évaluation des risques.' : 'Choisissez la catégorie du dispositif dans Gestion pour comparer l’effectif au référentiel.'}</div></div>` : '';
    const l = $('#e-liste');
    if (menuOuvert(l)) return;
    l.innerHTML = E.equipes.length ? E.equipes.map((e) => {
      const p = ou(e), peut = E.moi.responsable || E.moi.equipe === e.id;
      return `<div class="fiche" data-id="${esc(e.id)}" style="--c:${esc(e.couleur || '#4cc9f0')}">
        <div class="tete"><b translate="no">${ICONES_EQ[e.genre] || ''} ${esc(e.nom)}</b><span class="pastille ${e.etat === 'intervention' ? 'crit' : e.etat === 'indisponible' || e.etat === 'pause' ? 'att' : 'ok'}">${esc(E.listes.etats[e.etat] || e.etat)}</span><span class="heure">${e.etatHeure ? depuis(e.etatHeure) : ''}</span></div>
        <div class="note">${esc(E.listes.equipes[e.genre] || '')}${e.effectif != null ? ` · ${e.effectif} prévu${e.effectif > 1 ? 's' : ''}` : ''}${e.noeud ? ` · nœud <span class="mono" translate="no">${esc(e.noeud.nom || e.noeud.id)}</span>` : ' · sans nœud'}</div>
        ${e.membres.length ? `<div class="note" translate="no">👤 ${e.membres.map((m) => esc(m.nom) + (m.fonction ? ` (${esc(m.fonction)})` : '')).join(', ')}</div>` : ''}
        ${e.consigne ? `<div class="corps" translate="no">${esc(e.consigne)}</div>` : ''}
        <div class="note">${p ? (p.direct ? `📻 Position reçue ${p.heure ? depuis(p.heure) : ''}` : '📌 Emplacement fixe') : e.noeud ? '📻 En attente de la position du nœud' : 'Pas de position'}</div>
        <div class="actions">${peut ? `<select class="etat" aria-label="État de l’équipe">${options(E.listes.etats, e.etat)}</select>` : ''}${p ? '<button class="mini voir">Voir</button>' : ''}${E.moi.responsable ? '<button class="mini modifier">Modifier</button>' : ''}</div>
      </div>`;
    }).join('') : `<div class="vide">Aucune équipe.${E.moi.responsable ? ' Créez les postes et les équipes du dispositif.' : ''}</div>`;
    for (const f of l.querySelectorAll('.fiche')) {
      const e = E.equipes.find((q) => q.id === f.dataset.id);
      if ($('.etat', f)) $('.etat', f).onchange = (ev2) => { ev2.target.blur(); agir(() => api(`${base}/equipes/${e.id}/etat`, { method: 'PUT', body: { etat: ev2.target.value } })); };
      if ($('.voir', f)) $('.voir', f).onclick = () => allerA(ou(e));
      if ($('.modifier', f)) $('.modifier', f).onclick = () => ouvrirEquipe(e);
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
      $('#r-dest').innerHTML = `<option value="">Toutes les équipes qui portent un nœud (${avec.length})</option>` + avec.map((e) => `<option value="${esc(e.id)}" ${e.id === choisi ? 'selected' : ''}>${esc(e.nom)}</option>`).join('');
      $('#r-etat').textContent = !E.radio.disponible ? 'Envoi par radio indisponible sur cette carte.' : !E.radio.connecte ? '⚠ Le module radio de la carte n’est pas connecté : rien ne peut partir pour l’instant.' : 'Message direct au nœud de l’équipe ; l’accusé de réception s’affiche dans la main courante.';
      $('#r-ok').disabled = !E.radio.connecte || !avec.length;
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
      ${E.noeuds.length ? `<p translate="no" class="mono">${E.noeuds.map((n) => esc(n.nom ? `${n.nom} (${n.id})` : n.id)).join('<br>')}</p>` : '<p class="bandeau">Aucun nœud n’est attribué à cet espace. Demandez à l’administrateur de la carte d’y ajouter les nœuds que porteront vos équipes.</p>'}
      <p class="note">Seul l’administrateur de la carte attribue des nœuds : l’espace ne voit que ceux-là.</p>` : ''}

      <h2>Depuis le terrain, par radio</h2>
      <p class="note">Un message texte envoyé par le nœud d’une équipe arrive ici :</p>
      <table><tbody>
        <tr><td class="mono">INTER chute au virage 4</td><td>crée une intervention à la position du nœud</td></tr>
        <tr><td class="mono">FIN</td><td>termine l’intervention en cours de l’équipe</td></tr>
        <tr><td class="mono">DISPO · POSTE · PAUSE · INDISPO</td><td>change l’état de l’équipe</td></tr>
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
    for (const tr of vG.querySelectorAll('tr[data-id]')) {
      const c = E.comptes.find((x) => x.id === Number(tr.dataset.id)), maj = (corps) => { return agir(() => api(`${base}/comptes/${c.id}`, { method: 'PATCH', body: corps }), $('#g-c-retour')); };
      $('.c-equipe', tr).onchange = (ev2) => maj({ equipe: ev2.target.value || null });
      $('.c-resp', tr).onclick = () => maj({ responsable: !c.responsable });
      $('.c-actif', tr).onclick = () => maj({ actif: c.statut !== 'actif' });
      $('.c-mdp', tr).onclick = () => { const m = prompt(`Nouveau mot de passe de ${c.identifiant} (8 caractères au moins) :`); if (m) maj({ motDePasse: m }); };
      if ($('.c-suppr', tr)) $('.c-suppr', tr).onclick = () => { if (confirm(`Supprimer le compte ${c.identifiant} ?`)) maj({ supprimer: true }); };
    }
    $('#n-ok').onclick = async () => {
      const corps = { identifiant: $('#n-id').value, motDePasse: $('#n-mdp').value, equipe: $('#n-equipe').value || null, fonction: $('#n-fonction').value, responsable: $('#n-resp').checked };
      await agir(() => api(base + '/comptes', { method: 'POST', body: corps }), $('#n-retour'));
    };
  }

  const dessins = { inter: dessinerInter, equipes: dessinerEquipes, mc: dessinerMc, gestion: dessinerGestion };
  let vueActive = 'inter';
  function dessinerTout() { dessinerCarte(); dessinerInter(); dessins[vueActive](); }
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
      if (r.inchange) { for (const q of r.equipes) { const e = E.equipes.find((x) => x.id === q.id); if (e) { e.position = q.position; e.etat = q.etat; } } 
        let change = E.radio.connecte !== r.radioConnectee; E.radio.connecte = r.radioConnectee;
        for (const a of r.accuses || []) { const m = E.mainCourante.find((x) => x.id === a.id); if (m && m.accuse !== a.accuse) { m.accuse = a.accuse; change = true; } }
        dessinerCarte(); if (vueActive === 'equipes') dessinerEquipes(); if (change && vueActive === 'mc') dessinerMc(); }
      else { E = r; dessinerTout(); }
    } catch (e) { if (e.statut === 401) location.reload(); if (force) throw e; } finally { enCours = false; }
  }
  setInterval(() => { if (!document.hidden) rafraichir().catch(() => {}); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) rafraichir().catch(() => {}); });
  dessinerTout();
})();
