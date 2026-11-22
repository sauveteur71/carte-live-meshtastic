'use strict';
// Page de la section ADRASEC : main courante, radiogoniométrie (relevés, cônes, intersection), équipes, Winlink (Pat)
// et gestion des membres par les administrateurs. Données : /api/adrasec (réservé aux membres validés).
(async () => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 0) => (n == null || !Number.isFinite(Number(n)) ? '–' : Number(n).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const heure = (t) => new Date(t).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  let groupe = null; // ADRASEC consultée par un administrateur de la carte (?g=43)
  const avecGroupe = (url) => (groupe && /^\/api\/adrasec(\/|$|\?|\.)/.test(url) && !/\/api\/adrasec\/(acces|demande|groupes)/.test(url) ? url + (url.includes('?') ? '&' : '?') + 'g=' + encodeURIComponent(groupe) : url);
  async function api(url, opts = {}) {
    url = avecGroupe(url);
    const r = await fetch(url, { credentials: 'same-origin', ...opts, headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erreur || 'Erreur ' + r.status);
    return j;
  }
  const memo = (k, v) => { try { if (v === undefined) return localStorage.getItem('adrasec-' + k); localStorage.setItem('adrasec-' + k, v); } catch { /* navigateur sans stockage */ } return null; };

  // ---- Accès -----------------------------------------------------------------------------------------------
  groupe = memo('groupe') || null;
  const acces = await api('/api/adrasec/acces').catch(() => ({ acces: false }));
  $('#titre').textContent = `Section ${acces.nom || 'ADRASEC'}`;
  document.title = `Section ${acces.nom || 'ADRASEC'}`;
  if (!acces.acces) {
    // Pas encore membre : se connecter (ou créer son compte), puis demander à rejoindre l'ADRASEC de son département
    const nomS = esc(acces.nom || 'ADRASEC'), z = document.querySelector('main');
    const cadre = (h) => { z.innerHTML = `<div class="adhesion bandeau">${h}</div>`; };
    if (!acces.connecte) {
      cadre(`<h2>Section ${nomS}</h2><p>Cette section est réservée aux membres des ADRASEC (radioamateurs et SWL). Pour la rejoindre :</p>
        <ol><li><b>Créez votre compte</b> sur la carte (ou connectez-vous si vous en avez déjà un).</li><li>Revenez ici et demandez à rejoindre l’ADRASEC de votre département.</li><li>Le président de l’ADRASEC valide votre demande.</li></ol>
        <div class="ligne-champs">${acces.inscriptions !== 'fermees' ? '<a class="bouton principal" href="/?compte=inscription&amp;retour=/adrasec">Créer mon compte</a>' : ''}<a class="bouton" href="/?compte=connexion&amp;retour=/adrasec">Me connecter</a></div>
        ${acces.inscriptions === 'validation' ? '<p class="note">Sur cette carte, un administrateur valide d’abord les nouveaux comptes.</p>' : ''}`);
    } else if (!acces.actif || !(acces.groupes || []).length) {
      cadre(`<h2>Section ${nomS}</h2><p>Aucune ADRASEC n’est encore ouverte sur cette carte. Revenez plus tard.</p>`);
    } else if (acces.demande) {
      cadre(`<h2>${esc(acces.demande.nomGroupe || nomS)}</h2><p>✔ Votre demande a été envoyée le ${new Date(acces.demande.heure).toLocaleString('fr-FR')}.</p><p>Le président de l’ADRASEC doit la valider ; cette page s’ouvrira alors entièrement.</p>`);
    } else {
      const gr = acces.groupes;
      cadre(`<h2>Rejoindre une ADRASEC</h2><p>Connecté en tant que <b>${esc(acces.identifiant)}</b>.</p>
        <label>ADRASEC de votre département <select id="ad-groupe">${gr.length > 1 ? '<option value="">— choisir —</option>' : ''}${gr.map((x) => `<option value="${esc(x.code)}">${esc(x.nom)}</option>`).join('')}</select></label>
        <label>Vous êtes <select id="ad-qualite"><option value="radioamateur">radioamateur licencié</option><option value="swl">SWL (écouteur)</option><option value="">autre bénévole</option></select></label>
        <label title="Votre indicatif radioamateur (vérifié ensuite par le président)">Indicatif <input id="ad-ind" class="mono" value="${esc(acces.indicatif || '')}" placeholder="F4ABC"></label>
        <label title="Votre numéro d’écouteur si vous en avez un (ex. F-12345)" id="ad-swl-l" hidden>Numéro SWL (facultatif) <input id="ad-swl" class="mono" placeholder="F-12345"></label>
        <label>Message au président (facultatif) <textarea id="ad-msg" rows="3" placeholder="ex. Membre depuis 2019, équipe gonio de Monistrol"></textarea></label>
        <div class="ligne-champs"><button id="ad-envoyer" class="principal">Demander à rejoindre</button><span id="ad-retour" class="erreur"></span></div>`);
      const majQ = () => { const q = $('#ad-qualite').value; $('#ad-ind').closest('label').hidden = q !== 'radioamateur'; $('#ad-swl-l').hidden = q !== 'swl'; };
      $('#ad-qualite').onchange = majQ; majQ();
      $('#ad-envoyer').onclick = async () => {
        const q = $('#ad-qualite').value;
        try { await api('/api/adrasec/demande', { method: 'POST', body: { groupe: $('#ad-groupe').value, qualite: q, indicatif: q === 'radioamateur' ? $('#ad-ind').value : '', numeroSwl: q === 'swl' ? $('#ad-swl').value : '', message: $('#ad-msg').value } }); location.reload(); }
        catch (e) { $('#ad-retour').textContent = e.message; }
      };
    }
    return;
  }

  // ---- Carte ------------------------------------------------------------------------------------------------
  const cfg = await api('/api/config').catch(() => ({}));
  const carte = L.map('carte', { zoomControl: true, attributionControl: true }).setView(cfg.centre || [45.05, 3.9], cfg.zoom || 10);
  // Fonds de carte : Plan IGN par défaut (noms des communes et lieux-dits, routes, relief), choix gardé
  const wmts = (couche, format = 'image/png') => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${couche}&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${format}`;
  const ign = '&copy; <a href="https://www.ign.fr/" target="_blank" rel="noopener">IGN</a> Géoplateforme';
  const t = cfg.tuiles || {};
  const fonds = {
    'Plan IGN': L.tileLayer(wmts('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2'), { maxZoom: 19, maxNativeZoom: 19, attribution: ign }),
    'Carte topographique': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 19, maxNativeZoom: 17, subdomains: 'abc', attribution: 'Carte &copy; <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA), données &copy; contributeurs OpenStreetMap' }),
    'Photos aériennes IGN': L.layerGroup([L.tileLayer(wmts('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg'), { maxZoom: 19, maxNativeZoom: 19, attribution: ign }), L.tileLayer(wmts('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2'), { maxZoom: 19, maxNativeZoom: 19, opacity: 0.35 })]),
    ...(t.url ? { 'Sombre': L.layerGroup([L.tileLayer(t.url, { maxZoom: 19, maxNativeZoom: t.zoomMaxNatif || 18, className: t.sombre ? 'tuiles-sombres' : '', attribution: t.attribution || '' }), ...(t.etiquettes ? [L.tileLayer(t.etiquettes, { maxZoom: 19, maxNativeZoom: t.zoomMaxNatif || 18 })] : [])]) } : {}),
  };
  const fondChoisi = fonds[memo('fond')] ? memo('fond') : 'Plan IGN';
  fonds[fondChoisi].addTo(carte);
  L.control.layers(fonds, null, { position: 'topright', collapsed: true }).addTo(carte);
  carte.on('baselayerchange', (e) => memo('fond', e.name));
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(carte);
  // Position sous le curseur : coordonnées, locator et DFCI, pour se repérer et dicter une position
  const pointeur = L.control({ position: 'bottomright' });
  pointeur.onAdd = () => { const d = L.DomUtil.create('div', 'pointeur'); d.innerHTML = '&nbsp;'; return d; };
  pointeur.addTo(carte);
  carte.on('mousemove', (e) => { const d = document.querySelector('.pointeur'); if (d) d.textContent = `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)} · ${Gonio.versLocator(e.latlng.lat, e.latlng.lng, 8)}${window.DFCI ? ' · DFCI ' + (DFCI.versDfci(e.latlng.lat, e.latlng.lng) || '–') : ''}`; });
  // Recherche d'un lieu (commune, lieu-dit, sommet, adresse), comme sur la carte principale
  const chercheur = L.control({ position: 'topleft' });
  chercheur.onAdd = () => {
    const d = L.DomUtil.create('div', 'chercheur');
    d.innerHTML = '<input type="search" placeholder="🔍 Commune, lieu-dit, sommet…" aria-label="Chercher un lieu"><div class="resultats" hidden></div>';
    L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d);
    const champ = d.querySelector('input'), res = d.querySelector('.resultats');
    let minut = null;
    champ.oninput = () => {
      clearTimeout(minut);
      const q = champ.value.trim();
      if (q.length < 2) { res.hidden = true; return; }
      minut = setTimeout(async () => {
        const c = carte.getCenter();
        const l = await api(`/api/recherche?q=${encodeURIComponent(q)}&lat=${c.lat}&lon=${c.lng}`).catch(() => []);
        res.innerHTML = (l || []).slice(0, 8).map((x, i) => `<button data-i="${i}"><b>${esc(x.nom)}</b> <small>${esc(x.type || '')}${x.detail ? ' · ' + esc(x.detail) : ''}</small></button>`).join('') || '<div class="note" style="padding:6px">Aucun résultat</div>';
        res.hidden = false;
        for (const b of res.querySelectorAll('button')) b.onclick = () => { const x = l[Number(b.dataset.i)]; carte.setView([x.lat, x.lon], x.zoom || 14); res.hidden = true; champ.value = x.nom; };
      }, 350);
    };
    return d;
  };
  chercheur.addTo(carte);
  const couchesApercu = L.layerGroup().addTo(carte), couchesGonio = L.layerGroup().addTo(carte), couchesEquipes = L.layerGroup().addTo(carte), couchesRms = L.layerGroup().addTo(carte);
  let modeClic = null; // fonction appelée au prochain clic sur la carte
  carte.on('click', (e) => { if (!modeClic) return; const f = modeClic; modeClic = null; $('#consigne').hidden = true; f(e.latlng); });
  const consigne = (t) => { const c = $('#consigne'); c.textContent = t; c.hidden = !t; };

  // ---- État ---------------------------------------------------------------------------------------------------
  let E = null, rechercheChoisie = memo('recherche') || null, ongletActif = memo('onglet') || 'mc';
  const equipe = (id) => (E && E.equipes.find((e) => e.id === id)) || null;
  const couleurEquipe = (id) => (equipe(id) || {}).couleur || '#e0115f'; // sans équipe : rouge vif, visible sur tous les fonds
  const nomEquipe = (id) => (equipe(id) || {}).nom || '';

  for (const b of document.querySelectorAll('#onglets button')) b.onclick = () => montrer(b.dataset.vue);
  function montrer(v) {
    ongletActif = v; memo('onglet', v);
    for (const b of document.querySelectorAll('#onglets button')) b.classList.toggle('actif', b.dataset.vue === v);
    for (const s of document.querySelectorAll('.vue')) s.classList.toggle('actif', s.id === 'vue-' + v);
    if (v === 'winlink') rendreWinlink();
  }

  async function charger() {
    try { E = await api('/api/adrasec'); } catch (e) {
      // Administrateur de la carte, aucune ADRASEC encore créée : création de la première
      if (/Aucune ADRASEC/.test(e.message)) { rendreCreation(); return; }
      $('#vue-mc').innerHTML = `<p class="erreur">${esc(e.message)}</p>`; return;
    }
    if (!groupe) groupe = E.code;
    $('#titre').textContent = E.nom; document.title = E.nom;
    const q = E.moi.qualite === 'swl' ? '<span class="pastille">SWL</span>' : E.moi.licencie ? '<span class="pastille ok">licencié</span>' : E.moi.membre ? '<span class="pastille">non licencié</span>' : '';
    $('#moi').innerHTML = `${E.groupes && E.groupes.length > 1 ? `<select id="choix-groupe" title="ADRASEC affichée (administrateur de la carte)">${E.groupes.map((x) => `<option value="${esc(x.code)}" ${x.code === E.code ? 'selected' : ''}>${esc(x.nom)}</option>`).join('')}</select> ` : ''}${esc(E.moi.indicatif || E.moi.identifiant)} ${q}${E.moi.admin ? ' <span class="pastille">admin carte</span>' : E.moi.responsable ? ' <span class="pastille ok">président</span>' : ''}`;
    if ($('#choix-groupe')) $('#choix-groupe').onchange = () => { groupe = $('#choix-groupe').value; memo('groupe', groupe); rechercheChoisie = null; ajoutes = new Set(); charger(); };
    $('#onglets [data-vue="gestion"]').hidden = !E.moi.responsable;
    { const b = $('#onglets [data-vue="gestion"]'), n = (E.demandes || []).length; if (b) b.dataset.nb = n || ''; }
    if (!E.actif) $('#vue-mc').innerHTML = `<div class="bandeau">La section est <b>désactivée</b>. ${E.moi.responsable ? 'Activez-la dans l’onglet ⚙️ Gestion, puis ajoutez les membres.' : ''}</div>`;
    if (!E.recherches.some((r) => r.id === rechercheChoisie)) rechercheChoisie = (E.recherches.find((r) => r.statut === 'en-cours') || E.recherches[0] || {}).id || null;
    if (E.actif) rendreMc();
    rendreGonio(); rendreEquipes();
    if (E.moi.responsable) rendreGestion();
  }

  // ---- Main courante ----------------------------------------------------------------------------------------
  const LIB_TYPE = { information: 'Information', 'message-recu': 'Message reçu', 'message-emis': 'Message émis', decision: 'Décision', mouvement: 'Mouvement', incident: 'Incident', fin: 'Fin' };
  function rendreMc() {
    const v = $('#vue-mc');
    const brouillon = $('#mc-texte') ? $('#mc-texte').value : '';
    v.innerHTML = `<h2>Main courante</h2>
      <div class="ligne-champs"><label>Type <select id="mc-type">${E.typesMc.map((t) => `<option value="${t}">${LIB_TYPE[t] || t}</option>`).join('')}</select></label>
        <label>Équipe <select id="mc-equipe"><option value="">—</option>${E.equipes.map((e) => `<option value="${e.id}" ${E.moi.equipe === e.id ? 'selected' : ''}>${esc(e.nom)}</option>`).join('')}</select></label></div>
      <textarea id="mc-texte" placeholder="Événement, message reçu ou émis, décision… (heure et auteur ajoutés tout seuls)"></textarea>
      <div class="ligne-champs"><button class="principal" id="mc-ajouter">Inscrire</button><a href="${avecGroupe('/api/adrasec/main-courante.csv')}" download><button type="button">⬇ Export CSV</button></a><span class="erreur" id="mc-erreur"></span></div>
      <p class="note">Les inscriptions ne se modifient pas : pour corriger, inscrivez une nouvelle ligne. Les relevés, recherches et messages Winlink s'y ajoutent tout seuls.</p>
      <div id="mc-liste">${E.mainCourante.length ? E.mainCourante.slice().reverse().map((x) => `<div class="entree"><div class="tete"><b>${heure(x.heure)}</b><span>${esc(x.auteur)}</span>${x.equipe ? `<span><i class="equipe-pastille" style="background:${couleurEquipe(x.equipe)}"></i>${esc(nomEquipe(x.equipe))}</span>` : ''}<span class="type">${esc(LIB_TYPE[x.type] || x.type)}</span></div><div class="corps">${esc(x.texte)}</div></div>`).join('') : '<div class="vide">Aucune inscription.</div>'}</div>`;
    $('#mc-texte').value = brouillon;
    $('#mc-ajouter').onclick = async () => {
      try { await api('/api/adrasec/main-courante', { method: 'POST', body: { type: $('#mc-type').value, equipe: $('#mc-equipe').value, texte: $('#mc-texte').value } }); $('#mc-texte').value = ''; charger(); } catch (e) { $('#mc-erreur').textContent = e.message; }
    };
  }

  // ---- Radiogoniométrie ---------------------------------------------------------------------------------------
  let posReleve = null; // { lat, lon, source, locator? }
  // Équipe qui donne le relevé (le PC saisit souvent les relevés des équipes reçus par radio) : retenue d'un relevé à l'autre
  let equipeReleve = memo('equipeReleve');
  const equipeChoisie = () => { const s = $('#g-equipe'); return s ? s.value || null : equipeReleve && equipe(equipeReleve) ? equipeReleve : E.moi.equipe || null; };
  // Membre de l'équipe dont le nœud a la position la plus récente
  const noeudEquipe = (eid) => E.membres.filter((m) => eid && m.equipe === eid && m.position && m.noeud).sort((a, b) => (b.position.heure || 0) - (a.position.heure || 0))[0] || null;
  // Aperçu du relevé en cours de saisie : point de l'équipe (dès qu'il est choisi) et trait du gisement tapé
  function majApercu() {
    couchesApercu.clearLayers();
    let p = posReleve && posReleve.lat ? posReleve : null;
    const zl = $('#g-loc-zone');
    if (zl && !zl.hidden && $('#g-loc').value.trim()) { const q = Gonio.depuisLocator($('#g-loc').value.trim()); p = q ? { ...q, source: 'locator' } : null; }
    if (!p) return;
    const ca = equipeChoisie() ? couleurEquipe(equipeChoisie()) : '#3ee6c4'; // couleur de l'équipe qui donne le relevé
    const gis = $('#g-gis') ? Number(String($('#g-gis').value).replace(',', '.')) : NaN;
    if ($('#g-gis') && $('#g-gis').value !== '' && gis >= 0 && gis <= 360) {
      const inc = Number(String(($('#g-inc') || {}).value || '5').replace(',', '.')) || 5;
      const r = { lat: p.lat, lon: p.lon, gisement: gis, incertitude: inc };
      L.polygon(Gonio.cone(r, 30000), { color: ca, weight: 1.5, dashArray: '6 6', fillColor: ca, fillOpacity: 0.12, interactive: false }).addTo(couchesApercu);
      const bout = Gonio.destination(p.lat, p.lon, gis, 30000);
      L.polyline([[p.lat, p.lon], [bout.lat, bout.lon]], { color: '#0b1117', weight: 8, opacity: 0.5, interactive: false }).addTo(couchesApercu);
      L.polyline([[p.lat, p.lon], [bout.lat, bout.lon]], { color: ca, weight: 4, dashArray: '12 8', interactive: false }).addTo(couchesApercu);
    }
    L.circleMarker([p.lat, p.lon], { radius: 10, color: '#ffffff', weight: 3, fillColor: ca, fillOpacity: 1, interactive: false })
      .bindTooltip(`${equipeChoisie() ? esc(nomEquipe(equipeChoisie())) + ' · ' : ''}position du relevé (pas encore envoyé)`, { permanent: true, direction: 'top', offset: [0, -10], className: 'etq-equipe' }).addTo(couchesApercu);
  }
  function rendreGonio() {
    const v = $('#vue-gonio');
    if (!E.actif) { v.innerHTML = '<div class="bandeau">Section désactivée.</div>'; couchesGonio.clearLayers(); return; }
    const r = E.recherches.find((x) => x.id === rechercheChoisie) || null;
    const enCours = r && r.statut === 'en-cours';
    const c = r ? r.calcul : null;
    const gardes = { gis: $('#g-gis') ? $('#g-gis').value : '', inc: $('#g-inc') ? $('#g-inc').value : memo('incertitude') || '5', force: $('#g-force') ? $('#g-force').value : '', note: $('#g-note') ? $('#g-note').value : '', loc: $('#g-loc') ? $('#g-loc').value : '' };
    const est = c && c.estimation;
    v.innerHTML = `<h2>Recherche de balise</h2>
      <div class="ligne-champs"><label>Recherche <select id="g-recherche">${E.recherches.length ? E.recherches.map((x) => `<option value="${x.id}" ${x.id === rechercheChoisie ? 'selected' : ''}>${x.statut === 'en-cours' ? '🔴 ' : '✔ '}${esc(x.nom)} · ${esc(x.frequence)}</option>`).join('') : '<option value="">Aucune</option>'}</select></label>
        <button id="g-nouvelle">＋ Nouvelle recherche</button>${enCours ? '<button class="danger" id="g-cloturer">Clôturer</button>' : ''}</div>
      <div id="g-form-nouvelle" hidden class="bandeau"><div class="ligne-champs"><label>Nom <input id="gn-nom" placeholder="ex. Balise ELT Yssingeaux"></label><label>Fréquence <select id="gn-freq">${E.frequences.map((f) => `<option>${f}</option>`).join('')}</select></label></div>
        <label>Détail <input id="gn-detail" placeholder="ex. déclenchement signalé par le CNES / SATER niveau 1"></label><div class="ligne-champs"><button class="principal" id="gn-ok">Ouvrir la recherche</button><button id="gn-annuler">Annuler</button></div></div>
      ${r ? `
      ${est ? `<div class="resultat"><div>Position la plus probable (${c.utilises || c.nb} relevés${c.ecartes.length ? `, ${c.ecartes.length} écarté(s)` : ''})</div>
        <b class="grand mono">${est.lat.toFixed(5)}, ${est.lon.toFixed(5)}</b> <button class="mini" data-copier="${est.lat.toFixed(5)}, ${est.lon.toFixed(5)}">Copier</button><br>
        <span class="mono">${Gonio.versLocator(est.lat, est.lon, 8)}</span>${window.DFCI ? ` · DFCI <span class="mono">${esc(DFCI.versDfci(est.lat, est.lon) || '–')}</span>` : ''}<br>
        <span class="note">Zone à 95 % : ellipse de ${fmt(c.ellipse.grandAxeM / 1000, 1)} × ${fmt(c.ellipse.petitAxeM / 1000, 1)} km (demi-axes). Première indication à confirmer sur le terrain : réflexions sur le relief et les bâtiments possibles.</span></div>`
      : `<p class="note">${c && c.nb >= 2 ? 'Les relèvements ne se croisent pas devant les équipes : vérifiez les gisements (vrais, pas magnétiques) et les positions.' : 'Il faut au moins deux relèvements, de deux endroits éloignés, pour situer l’émetteur.'}</p>`}
      ${enCours ? `<h3>Diffusion aux équipes</h3>
      <div class="bandeau diffusion">
        <div><b>📡 Par radio LoRa</b> <span class="note">(zone blanche : point « 🎯 Balise estimée » sur la carte de l’appli Meshtastic + message texte)</span></div>
        <div class="ligne-champs"><label title="Canal du module de la carte sur lequel partent le point et le message : de préférence le canal chiffré des équipes">Canal <select id="d-canal"><option value="${r.diffusion ? r.diffusion.canal : 0}">${r.diffusion ? 'canal ' + r.diffusion.canal : 'chargement…'}</option></select></label>
          <label class="case" title="Renvoyer le point à chaque nouveau relevé si la position estimée bouge de plus de 300 m (au plus une fois par minute)" style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" id="d-auto" ${r.diffusion && r.diffusion.auto ? 'checked' : ''}> Automatique</label>
          <button id="d-envoyer" class="principal" ${est ? '' : 'disabled title="Il faut d’abord une position estimée"'}>Diffuser maintenant</button></div>
        <div class="note" id="d-retour">${r.diffusion && r.diffusion.dernier ? `Dernière diffusion : ${heure(r.diffusion.dernier.heure)}` : 'Pas encore diffusée.'}</div>
        <div style="margin-top:10px"><b>🔗 Lien terrain</b> <span class="note">(réseau mobile : la carte de cette recherche, sans compte, en lecture seule, jusqu’à la clôture)</span></div>
        ${r.lien ? `<div class="ligne-champs"><input id="d-lien" readonly class="mono" value="${esc(location.origin + '/terrain/' + r.lien.jeton)}"><button id="d-copier">Copier</button><button id="d-qr">QR code</button><button class="danger" id="d-couper">Désactiver</button></div>
          <div id="d-qr-zone"></div><p class="note">Envoyez-le par SMS ou faites scanner le QR code. Il ne marche que si la carte est joignable depuis le téléphone (adresse en …ts.net avec Tailscale, ou adresse publique) : pas avec « localhost ».</p>`
        : '<div class="ligne-champs"><button id="d-lien-creer">Créer le lien terrain</button></div>'}
      </div>
      <h3>Nouveau relevé</h3>
      <div class="ligne-champs"><label title="Équipe qui a fait ce relevé : son nom et sa couleur s’affichent sur la carte et dans la main courante">Équipe qui donne le relevé <select id="g-equipe"><option value="">— aucune —</option>${E.equipes.map((e) => `<option value="${e.id}" ${e.id === equipeChoisie() ? 'selected' : ''}>● ${esc(e.nom)}</option>`).join('')}</select></label></div>
      <div class="ligne-champs"><label>Gisement vrai (°) <input id="g-gis" inputmode="decimal" placeholder="0 à 360"></label><label>Incertitude ± (°) <input id="g-inc" inputmode="decimal"></label><label>Force <select id="g-force"><option value="">—</option><option>S1-S3 faible</option><option>S4-S6 moyen</option><option>S7-S9 fort</option><option>Saturé</option></select></label></div>
      <div class="note">Position de l’équipe :</div>
      <div class="choix-pos"><button data-pos="gps">📍 Mon GPS</button><button data-pos="equipe" ${noeudEquipe(equipeChoisie()) ? '' : 'disabled title="Aucun membre de cette équipe n’a de nœud suivi (Gestion › Nœud porté)"'}>📡 Nœud de l’équipe</button><button data-pos="noeud" ${E.moi.noeud ? '' : 'disabled title="Aucun nœud associé à votre compte"'}>📡 Mon nœud</button><button data-pos="carte">🖱 Clic sur la carte</button><button data-pos="locator">⌗ Locator</button></div>
      <div id="g-pos-detail" class="note">${posReleve ? `Retenue : <b class="mono">${posReleve.lat.toFixed(5)}, ${posReleve.lon.toFixed(5)}</b> (${esc(posReleve.source)})` : 'Aucune position choisie.'}</div>
      <div id="g-loc-zone" hidden><label>QTH-locator (6 à 10 caractères) <input id="g-loc" placeholder="JN15XC33"></label></div>
      <label>Note <input id="g-note" placeholder="ex. réflexion probable, antenne Yagi 3 él."></label>
      <div class="ligne-champs"><button class="principal" id="g-envoyer">Envoyer le relevé</button><span class="erreur" id="g-erreur"></span></div>
      <p class="note">Par radio : depuis le nœud associé à son compte, un membre envoie « <b class="mono">GONIO 125</b> » ou « <b class="mono">GIS 125/5</b> » (gisement puis incertitude) ; le relevé arrive ici avec la position du nœud.</p>` : `<p class="note">Recherche clôturée le ${heure(r.fin)}${r.resultat ? ' : ' + esc(r.resultat) : ''}.</p>`}
      <h3>Relevés (${r.releves.length})</h3>
      ${r.releves.length ? r.releves.slice().reverse().map((x) => { const rs = c && c.residus[x.id]; const ecarte = c && c.ecartes.includes(x.id); return `<div class="entree ${x.retire ? 'retire' : ''}"><div class="tete"><b>${heure(x.heure)}</b><span>${esc(x.auteur)}</span>${x.equipe ? `<span><i class="equipe-pastille" style="background:${couleurEquipe(x.equipe)}"></i>${esc(nomEquipe(x.equipe))}</span>` : ''}${x.origine === 'radio' ? '<span class="type">radio</span>' : ''}</div>
        <div class="corps"><b>${fmt(x.gisement, 1)}°</b> ±${fmt(x.incertitude, 1)}° depuis <span class="mono">${Gonio.versLocator(x.lat, x.lon, 8)}</span> (${esc(x.source)})${x.force ? ' · ' + esc(x.force) : ''}${rs && !x.retire ? ` · écart ${fmt(rs.ecartDeg, 1)}° à ${fmt(rs.distanceM / 1000, 1)} km` : ''}${ecarte ? ' · <b class="erreur">écarté (tourne le dos aux autres)</b>' : ''}${x.note ? '<br><span class="note">' + esc(x.note) + '</span>' : ''}
        ${!x.retire && enCours ? `<div class="ligne-champs"><label class="mini-champ" title="Corriger l’équipe qui a fait ce relevé (couleur du trait)">Équipe <select data-releve-equipe="${x.id}"><option value="">— aucune —</option>${E.equipes.map((e) => `<option value="${e.id}" ${e.id === x.equipe ? 'selected' : ''}>● ${esc(e.nom)}</option>`).join('')}</select></label><button class="mini" data-retirer="${x.id}">Retirer du calcul</button></div>` : ''}</div></div>`; }).join('') : '<div class="vide">Aucun relevé.</div>'}` : '<p class="note">Ouvrez une recherche pour saisir les relevés des équipes.</p>'}`;
    if ($('#g-gis')) { $('#g-gis').value = gardes.gis; $('#g-inc').value = gardes.inc; $('#g-force').value = gardes.force; $('#g-note').value = gardes.note; $('#g-loc').value = gardes.loc; }
    $('#g-recherche').onchange = () => { rechercheChoisie = $('#g-recherche').value; memo('recherche', rechercheChoisie); rendreGonio(); cadrerGonio(); };
    $('#g-nouvelle').onclick = () => { $('#g-form-nouvelle').hidden = false; $('#gn-nom').focus(); };
    const ok = $('#gn-ok');
    if (ok) {
      ok.onclick = async () => { try { const n = await api('/api/adrasec/recherches', { method: 'POST', body: { nom: $('#gn-nom').value, frequence: $('#gn-freq').value, detail: $('#gn-detail').value } }); rechercheChoisie = n.id; memo('recherche', n.id); charger(); } catch (e) { alert(e.message); } };
      $('#gn-annuler').onclick = () => { $('#g-form-nouvelle').hidden = true; };
    }
    const cl = $('#g-cloturer');
    if (cl) cl.onclick = async () => { const res = prompt('Clôturer la recherche. Résultat (ex. « balise trouvée sur le planeur au lieu-dit… ») :', ''); if (res === null) return; await api('/api/adrasec/recherches/' + r.id, { method: 'PATCH', body: { cloturer: true, resultat: res } }).catch((e) => alert(e.message)); charger(); };
    for (const b of v.querySelectorAll('[data-copier]')) b.onclick = () => navigator.clipboard && navigator.clipboard.writeText(b.dataset.copier).then(() => { b.textContent = 'Copié ✓'; });
    for (const s of v.querySelectorAll('[data-releve-equipe]')) s.onchange = async () => { await api('/api/adrasec/releves/' + s.dataset.releveEquipe, { method: 'PATCH', body: { equipe: s.value || null } }).catch((e) => alert(e.message)); charger(); };
    for (const b of v.querySelectorAll('[data-retirer]')) b.onclick = async () => { await api('/api/adrasec/releves/' + b.dataset.retirer, { method: 'DELETE' }).catch((e) => alert(e.message)); charger(); };
    for (const b of v.querySelectorAll('[data-pos]')) b.onclick = () => choisirPosition(b.dataset.pos);
    const se = $('#g-equipe');
    if (se) se.onchange = () => {
      equipeReleve = se.value || ''; memo('equipeReleve', equipeReleve);
      const be = v.querySelector('[data-pos="equipe"]'), ok = !!noeudEquipe(se.value);
      be.disabled = !ok; be.title = ok ? '' : 'Aucun membre de cette équipe n’a de nœud suivi (Gestion › Nœud porté)';
      if (posReleve && posReleve.noeud) { if (ok) choisirPosition('equipe'); else { posReleve = null; be.classList.remove('actif'); $('#g-pos-detail').textContent = 'Aucune position choisie.'; } }
      majApercu();
    };
    const env = $('#g-envoyer');
    if (env) env.onclick = async () => {
      $('#g-erreur').textContent = '';
      const corps = { recherche: r.id, equipe: $('#g-equipe').value || null, gisement: $('#g-gis').value, incertitude: $('#g-inc').value, force: $('#g-force').value, note: $('#g-note').value };
      if (!$('#g-loc-zone').hidden && $('#g-loc').value.trim()) corps.locator = $('#g-loc').value.trim();
      else if (posReleve && posReleve.source === 'mon nœud') corps.noeud = E.moi.noeud;
      else if (posReleve && posReleve.noeud) corps.noeud = posReleve.noeud;
      else if (posReleve) Object.assign(corps, { lat: posReleve.lat, lon: posReleve.lon, source: posReleve.source === 'GPS' ? 'gps' : 'carte' });
      memo('incertitude', $('#g-inc').value);
      try { await api('/api/adrasec/releves', { method: 'POST', body: corps }); $('#g-gis').value = ''; $('#g-note').value = ''; charger(); } catch (e) { $('#g-erreur').textContent = e.message; }
    };
    dessinerGonio(r);
    if (r && enCours) brancherDiffusion(r);
    for (const id of ['#g-gis', '#g-inc', '#g-loc']) { const e = $(id); if (e) e.addEventListener('input', majApercu); }
    majApercu();
  }
  async function brancherDiffusion(r) {
    const sel = $('#d-canal');
    if (sel) api('/api/adrasec/canaux').then((m) => {
      const cur = r.diffusion ? r.diffusion.canal : 0;
      if (!m.connecte) { sel.innerHTML = `<option value="${cur}">module radio non relié</option>`; return; }
      sel.innerHTML = m.canaux.map((c) => `<option value="${c.index}" ${c.index === cur ? 'selected' : ''}>${c.index} · ${esc(c.nom)}</option>`).join('');
    }).catch(() => {});
    const regler = (b) => api(`/api/adrasec/recherches/${r.id}/diffuser`, { method: 'POST', body: { ...b, reglageSeul: true } }).catch((e) => { $('#d-retour').textContent = e.message; });
    if (sel) sel.onchange = () => regler({ canal: Number(sel.value) });
    const au = $('#d-auto'); if (au) au.onchange = () => regler({ auto: au.checked, canal: Number(sel.value) });
    const be = $('#d-envoyer');
    if (be) be.onclick = async () => {
      be.disabled = true;
      try { const x = await api(`/api/adrasec/recherches/${r.id}/diffuser`, { method: 'POST', body: { canal: Number(sel.value) } }); $('#d-retour').textContent = '✔ Diffusé : ' + x.texte; } catch (e) { $('#d-retour').innerHTML = `<span class="erreur">${esc(e.message)}</span>`; }
      be.disabled = false;
    };
    const bc = $('#d-lien-creer'); if (bc) bc.onclick = async () => { await api(`/api/adrasec/recherches/${r.id}/lien`, { method: 'POST' }).catch((e) => alert(e.message)); charger(); };
    const bx = $('#d-couper'); if (bx) bx.onclick = async () => { if (!confirm('Désactiver le lien terrain ? Les équipes qui l’ont ne verront plus la carte.')) return; await api(`/api/adrasec/recherches/${r.id}/lien`, { method: 'DELETE' }).catch((e) => alert(e.message)); charger(); };
    const bp = $('#d-copier'); if (bp) bp.onclick = () => navigator.clipboard && navigator.clipboard.writeText($('#d-lien').value).then(() => { bp.textContent = 'Copié ✓'; });
    const bq = $('#d-qr'); if (bq) bq.onclick = async () => { const z = $('#d-qr-zone'); if (z.innerHTML) { z.innerHTML = ''; return; } const q = await api('/api/adrasec/qr?u=' + encodeURIComponent($('#d-lien').value)).catch(() => null); if (q) z.innerHTML = `<img src="${q.qr}" alt="QR code du lien terrain" style="background:#fff;padding:6px;border-radius:8px;margin-top:6px">`; };
  }
  function choisirPosition(mode) {
    modeClic = null; consigne(''); // un autre choix annule l'attente d'un clic sur la carte
    for (const b of document.querySelectorAll('[data-pos]')) b.classList.toggle('actif', b.dataset.pos === mode);
    $('#g-loc-zone').hidden = mode !== 'locator';
    const maj = (p) => { posReleve = p; const d = $('#g-pos-detail'); if (d) d.innerHTML = `Retenue : <b class="mono">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</b> (${esc(p.source)}${p.precision ? ', ±' + Math.round(p.precision) + ' m' : ''}) — point vert sur la carte`; majApercu(); if (!carte.getBounds().contains([p.lat, p.lon])) carte.panTo([p.lat, p.lon]); };
    if (mode === 'gps') {
      if (!navigator.geolocation) { $('#g-pos-detail').textContent = 'GPS indisponible sur cet appareil.'; return; }
      $('#g-pos-detail').textContent = '📡 Recherche de la position GPS…';
      navigator.geolocation.getCurrentPosition((p) => maj({ lat: p.coords.latitude, lon: p.coords.longitude, precision: p.coords.accuracy, source: 'GPS' }), (e) => { $('#g-pos-detail').textContent = 'GPS : ' + e.message; }, { enableHighAccuracy: true, timeout: 30000, maximumAge: 10000 });
    } else if (mode === 'noeud') {
      const m = E.membres.find((x) => x.noeud === E.moi.noeud);
      if (m && m.position) maj({ ...m.position, source: 'mon nœud' }); else { posReleve = { lat: 0, lon: 0, source: 'mon nœud' }; $('#g-pos-detail').textContent = 'Position de votre nœud : prise par le serveur à l’envoi.'; }
    } else if (mode === 'equipe') {
      const m = noeudEquipe(equipeChoisie());
      if (m) maj({ ...m.position, source: 'nœud de ' + (m.indicatif || m.nom), noeud: m.noeud }); else $('#g-pos-detail').textContent = 'Aucun nœud suivi dans cette équipe.';
    } else if (mode === 'carte') {
      consigne('Cliquez sur la carte à l’endroit où se trouve l’équipe');
      modeClic = (ll) => maj({ lat: ll.lat, lon: ll.lng, source: 'carte' });
    } else { posReleve = null; majApercu(); $('#g-pos-detail').textContent = 'Saisissez le locator ci-dessous.'; $('#g-loc').focus(); }
  }
  function dessinerGonio(r) {
    couchesGonio.clearLayers();
    if (!r) return;
    const c = r.calcul, est = c && c.estimation;
    for (const x of r.releves) {
      if (x.retire) continue;
      const coul = couleurEquipe(x.equipe), ecarte = c && c.ecartes.includes(x.id);
      const longueur = Math.max(15000, est ? Gonio.distance(x, est) * 1.6 : 30000);
      L.polygon(Gonio.cone(x, longueur), { color: coul, weight: 1.5, opacity: 0.9, fillColor: coul, fillOpacity: ecarte ? 0.05 : 0.2, dashArray: ecarte ? '6 6' : null, interactive: false }).addTo(couchesGonio);
      const bout = Gonio.destination(x.lat, x.lon, x.gisement, longueur);
      // Trait du relèvement : liseré sombre puis trait de couleur épais, lisibles sur le plan IGN comme sur les photos
      L.polyline([[x.lat, x.lon], [bout.lat, bout.lon]], { color: '#0b1117', weight: 8, opacity: ecarte ? 0.25 : 0.55, interactive: false }).addTo(couchesGonio);
      L.polyline([[x.lat, x.lon], [bout.lat, bout.lon]], { color: coul, weight: 4, opacity: ecarte ? 0.5 : 1, dashArray: ecarte ? '10 8' : null }).addTo(couchesGonio);
      // Flèche au bout, dans la direction du relèvement, et gisement écrit près de l'équipe
      L.marker([bout.lat, bout.lon], { interactive: false, icon: L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], html: `<div style="transform:rotate(${x.gisement - 90}deg);color:${coul};font-size:26px;line-height:26px;text-shadow:0 0 3px #0b1117,0 0 3px #0b1117">➤</div>` }) }).addTo(couchesGonio);
      // Étiquette permanente sur le point : équipe (ou auteur), direction et force du signal
      const qui = x.equipe ? nomEquipe(x.equipe) : x.auteur;
      L.circleMarker([x.lat, x.lon], { radius: 8, color: '#ffffff', weight: 3, fillColor: coul, fillOpacity: 1 })
        .bindTooltip(`<b>${esc(qui)}</b> · ${fmt(x.gisement, 0)}°${x.force ? ' · ' + esc(x.force) : ''}`, { permanent: true, direction: 'left', offset: [-10, 0], className: 'etq-releve' + (ecarte ? ' ecarte' : '') }).bindPopup(`<b>${esc(x.auteur)}</b>${x.equipe ? ' · ' + esc(nomEquipe(x.equipe)) : ''}<br>${fmt(x.gisement, 1)}° ±${fmt(x.incertitude, 1)}° · ${heure(x.heure)}<br>${esc(x.source)}${x.force ? '<br>' + esc(x.force) : ''}`).addTo(couchesGonio);
    }
    if (c) for (const k of c.croisements.filter((k) => !c.ecartes.includes(k.a) && !c.ecartes.includes(k.b))) L.circleMarker([k.lat, k.lon], { radius: 3, color: '#f1f5f9', weight: 1, fillOpacity: 0.7, interactive: false }).addTo(couchesGonio);
    if (est) {
      if (c.ellipse) L.polygon(Gonio.contourEllipse(est, c.ellipse.grandAxeM, c.ellipse.petitAxeM, c.ellipse.azimutGrandAxe), { color: '#ff5c6c', weight: 2, fillOpacity: 0.12 }).addTo(couchesGonio);
      L.marker([est.lat, est.lon], { icon: L.divIcon({ className: '', html: '<div style="font-size:26px;line-height:26px;filter:drop-shadow(0 0 3px #000)">🎯</div>', iconSize: [26, 26], iconAnchor: [13, 13] }) })
        .bindPopup(`<b>Position la plus probable</b><br><span class="mono">${est.lat.toFixed(5)}, ${est.lon.toFixed(5)}</span><br>${Gonio.versLocator(est.lat, est.lon, 8)}${window.DFCI ? ' · DFCI ' + esc(DFCI.versDfci(est.lat, est.lon) || '–') : ''}`).addTo(couchesGonio);
    }
  }
  let cadre = false;
  function cadrerGonio() {
    const l = couchesGonio.getLayers();
    if (!l.length) return;
    const b = L.featureGroup(l).getBounds();
    if (b.isValid()) carte.fitBounds(b.pad(0.1), { maxZoom: 14 });
  }

  // ---- Équipes ------------------------------------------------------------------------------------------------
  // Membre dans une équipe : petite étiquette, ✕ pour le sortir de l'équipe (président)
  const puceMembre = (m, sansEquipe) => `<span class="puce-membre" style="--c:${couleurEquipe(m.equipe)}"><b>${esc(m.indicatif || m.numeroSwl || m.nom)}</b>${m.indicatif || m.numeroSwl ? ` <small>${esc(m.nom)}</small>` : ''}${m.fonction ? ` <small>· ${esc(m.fonction)}</small>` : ''}${m.position ? ' 📍' : ''}${E.moi.responsable && !sansEquipe ? `<button class="retirer-eq" data-sortir="${m.compte}" title="Sortir de l’équipe">✕</button>` : ''}</span>`;
  function rendreEquipes() {
    const v = $('#vue-equipes');
    couchesEquipes.clearLayers();
    const parEq = new Map([[null, []], ...E.equipes.map((e) => [e.id, []])]);
    for (const m of E.membres) (parEq.get(m.equipe) || parEq.get(null)).push(m);
    v.innerHTML = `<h2>Équipes</h2>${E.moi.responsable ? '<div class="ligne-champs"><label>Nouvelle équipe <input id="eq-nom" placeholder="ex. Gonio 1"></label><button id="eq-creer">Créer</button></div>' : ''}
      ${E.equipes.map((e) => `<div class="entree"><div class="tete"><b>${E.moi.responsable ? `<input type="color" class="couleur-eq" data-couleur-eq="${e.id}" value="${e.couleur}" title="Couleur de l’équipe (traits des relevés, points sur la carte)">` : `<i class="equipe-pastille" style="background:${e.couleur}"></i>`}${esc(e.nom)}</b>${e.mission ? `<span class="type">🎯 ${esc(e.mission)}</span>` : ''}${E.moi.responsable ? ` <button class="mini principal" data-ajout-eq="${e.id}">＋ Membres</button> <button class="mini" data-mission="${e.id}">Mission</button> <button class="mini danger" data-suppr-eq="${e.id}">Supprimer</button>` : ''}</div>
        <div class="corps puces-membres">${parEq.get(e.id).map(puceMembre).join('') || '<span class="note">Aucun membre : « ＋ Membres » pour en ajouter</span>'}</div></div>`).join('') || '<div class="vide">Aucune équipe : le président les crée ici.</div>'}
      ${parEq.get(null).length ? `<h3>Sans équipe</h3><div class="corps puces-membres">${parEq.get(null).map((m) => puceMembre(m, true)).join('')}</div>` : ''}
      <p class="note">📍 : position en direct du nœud Meshtastic associé au membre (Gestion). Elle s'affiche sur la carte et sert de position par défaut pour ses relevés.</p>`;
    for (const m of E.membres) {
      if (!m.position) continue;
      const coul = couleurEquipe(m.equipe);
      L.circleMarker([m.position.lat, m.position.lon], { radius: 8, color: '#0b1117', weight: 2, fillColor: coul, fillOpacity: 1 })
        .bindTooltip(`${esc(m.indicatif || m.nom)}${m.equipe ? ' · ' + esc(nomEquipe(m.equipe)) : ''}`, { permanent: true, direction: 'right', offset: [8, 0], className: 'etq-equipe' })
        .bindPopup(`<b>${esc(m.indicatif || m.nom)}</b><br>${esc(nomEquipe(m.equipe) || 'sans équipe')}<br>${m.position.heure ? 'position ' + heure(m.position.heure) : ''}`).addTo(couchesEquipes);
    }
    const bc = $('#eq-creer');
    if (bc) bc.onclick = async () => { await api('/api/adrasec/equipes', { method: 'POST', body: { nom: $('#eq-nom').value } }).catch((e) => alert(e.message)); charger(); };
    // Mission : choisie dans une liste (recherches en cours, missions déjà données aux autres équipes) pour rattacher
    // plusieurs équipes à la même mission en un clic, ou saisie librement
    for (const b of v.querySelectorAll('[data-mission]')) b.onclick = () => {
      const e = equipe(b.dataset.mission);
      const boite = b.closest('.entree');
      if (boite.querySelector('.choix-mission')) return;
      const enCours = E.recherches.filter((r) => r.statut === 'en-cours').map((r) => `Recherche « ${r.nom} » (${r.frequence})`);
      const autres = [...new Set(E.equipes.filter((x) => x.id !== e.id && x.mission).map((x) => x.mission))];
      const options = [...new Set([...enCours, ...autres])];
      const z = document.createElement('div');
      z.className = 'choix-mission ligne-champs';
      z.innerHTML = `<label>Mission de ${esc(e.nom)} <select>${options.map((o) => `<option ${o === e.mission ? 'selected' : ''}>${esc(o)}</option>`).join('')}<option value="__autre" ${e.mission && !options.includes(e.mission) ? 'selected' : ''}>✏️ Autre mission…</option><option value="" ${!e.mission ? 'selected' : ''}>— Aucune mission —</option></select></label>
        <label class="autre-mission" hidden>Nouvelle mission <input maxlength="120" placeholder="ex. Recherche ELT secteur Yssingeaux" value="${esc(e.mission && !options.includes(e.mission) ? e.mission : '')}"></label>
        <button class="principal mini">OK</button><button class="mini">Annuler</button>`;
      boite.appendChild(z);
      const sel = z.querySelector('select'), autre = z.querySelector('.autre-mission'), champ = autre.querySelector('input');
      const majAutre = () => { autre.hidden = sel.value !== '__autre'; if (!autre.hidden) champ.focus(); };
      sel.onchange = majAutre; majAutre();
      const [ok, annuler] = z.querySelectorAll('button');
      annuler.onclick = () => z.remove();
      ok.onclick = async () => { const t = sel.value === '__autre' ? champ.value.trim() : sel.value; await api('/api/adrasec/equipes/' + e.id, { method: 'PATCH', body: { mission: t } }).catch((x) => alert(x.message)); charger(); };
    };
    for (const c of v.querySelectorAll('[data-couleur-eq]')) c.onchange = async () => { await api('/api/adrasec/equipes/' + c.dataset.couleurEq, { method: 'PATCH', body: { couleur: c.value } }).catch((x) => alert(x.message)); charger(); };
    // Composer une équipe : cocher les membres (ceux d'une autre équipe y sont déplacés)
    for (const b of v.querySelectorAll('[data-ajout-eq]')) b.onclick = () => {
      const e = equipe(b.dataset.ajoutEq), boite = b.closest('.entree');
      if (boite.querySelector('.choix-membres')) return;
      const dispo = E.membres.filter((m) => m.equipe !== e.id).sort((a, x) => (a.equipe ? 1 : 0) - (x.equipe ? 1 : 0) || String(a.indicatif || a.nom).localeCompare(String(x.indicatif || x.nom)));
      const z = document.createElement('div');
      z.className = 'choix-membres';
      z.innerHTML = dispo.length ? `<p class="note">Cochez les membres de ${esc(e.nom)}. Un membre déjà dans une autre équipe y sera déplacé.</p>
        <input type="search" placeholder="🔎 Filtrer (nom, indicatif)">
        <div class="liste-ajout">${dispo.map((m) => `<label class="case" data-texte="${esc(`${m.nom} ${m.indicatif || ''} ${m.numeroSwl || ''}`.toLowerCase())}"><input type="checkbox" value="${m.compte}"> <b>${esc(m.indicatif || m.numeroSwl || m.nom)}</b>${m.indicatif || m.numeroSwl ? ` <small>${esc(m.nom)}</small>` : ''}${m.equipe ? ` <small class="note">(${esc(nomEquipe(m.equipe))})</small>` : ''}</label>`).join('')}</div>
        <div class="ligne-champs"><button class="principal mini" disabled>Ajouter à l’équipe</button><button class="mini">Annuler</button></div>`
        : `<p class="note">Tous les membres sont déjà dans cette équipe. Ajoutez des membres à l’ADRASEC dans l’onglet Gestion.</p><button class="mini">Fermer</button>`;
      boite.appendChild(z);
      const boutons = z.querySelectorAll('button'), ok = dispo.length ? boutons[0] : null, annuler = boutons[boutons.length - 1];
      annuler.onclick = () => z.remove();
      if (!ok) return;
      const cases = () => [...z.querySelectorAll('.liste-ajout input:checked')];
      z.querySelector('.liste-ajout').onchange = () => { const n = cases().length; ok.disabled = !n; ok.textContent = n ? `Ajouter à l’équipe (${n})` : 'Ajouter à l’équipe'; };
      z.querySelector('input[type=search]').oninput = (ev) => { const q = ev.target.value.trim().toLowerCase(); for (const l of z.querySelectorAll('.liste-ajout label')) l.hidden = !!q && !l.dataset.texte.includes(q); };
      ok.onclick = async () => {
        ok.disabled = true;
        for (const c of cases()) await api('/api/adrasec/membres/' + c.value, { method: 'PUT', body: { membre: true, equipe: e.id } }).catch((x) => alert(x.message));
        charger();
      };
    };
    for (const b of v.querySelectorAll('[data-sortir]')) b.onclick = async () => { await api('/api/adrasec/membres/' + b.dataset.sortir, { method: 'PUT', body: { membre: true, equipe: null } }).catch((x) => alert(x.message)); charger(); };
    for (const b of v.querySelectorAll('[data-suppr-eq]')) b.onclick = async () => { if (!confirm('Supprimer cette équipe ? Ses membres restent dans la section, sans équipe.')) return; await api('/api/adrasec/equipes/' + b.dataset.supprEq, { method: 'PATCH', body: { supprimer: true } }).catch((x) => alert(x.message)); charger(); };
  }

  // ---- Winlink --------------------------------------------------------------------------------------------------
  let boite = 'in';
  async function rendreWinlink() {
    const v = $('#vue-winlink');
    if (!E) return;
    if (E.winlink.configure && E.winlink.autorise === false) {
      v.innerHTML = `<h2>Winlink</h2><div class="bandeau">La station Winlink de cette carte est réservée à <b>${esc(E.winlink.adrasec)}</b>. Sa boîte de messages n’est visible que de ses membres.</div>`;
      return;
    }
    if (!E.winlink.configure) {
      v.innerHTML = `<h2>Winlink</h2><div class="bandeau">Winlink n’est pas encore installé sur ce serveur.</div>
        <p class="note">La carte s’appuie sur <b>Pat</b>, client Winlink libre. Pour l’ajouter : lancez <span class="mono">docker compose --profile winlink up -d</span> dans le dossier de la carte, réglez l’indicatif, le mot de passe Winlink et le locator de la station dans Pat, puis activez Winlink dans <b>Réglages › Fonctions de la carte</b>. Marche à suivre détaillée (dont NAS Synology) : wiki, page « Section ADRASEC ». La carte ne voit jamais ce mot de passe.</p>
        <p class="note">VARA HF / FM tourne sur le PC Windows relié au poste radio : Pat s’y relie par le réseau (ports 8300 et 8301 par défaut).</p>`;
      return;
    }
    v.innerHTML = '<h2>Winlink</h2><div class="vide">Interrogation de Pat…</div>';
    const et = await api('/api/adrasec/winlink/etat').catch((e) => ({ joignable: false, erreur: e.message }));
    const lic = E.moi.licencie;
    v.innerHTML = `<h2>Winlink</h2>
      <p>${et.joignable ? `Pat joignable${et.indicatif ? ' · station <b class="mono">' + esc(et.indicatif) + '</b>' : ''} · ${et.connecte ? '<span class="pastille ok">session en cours</span>' : et.appel ? '<span class="pastille att">appel…</span>' : '<span class="pastille">au repos</span>'}` : `<span class="erreur">${esc(et.erreur || 'Pat injoignable')}</span>`}</p>
      ${lic ? '' : '<div class="bandeau">Lecture seule : rédiger et lancer une session est réservé aux radioamateurs licenciés (indicatif validé par un administrateur).</div>'}
      <div class="ligne-champs">${['in', 'out', 'sent', 'archive'].map((b) => `<button class="${boite === b ? 'principal' : ''}" data-boite="${b}">${{ in: '📥 Reçus', out: '📤 À envoyer', sent: '✔ Envoyés', archive: '🗄 Archives' }[b]}</button>`).join('')}</div>
      <div id="wl-liste"><div class="vide">Chargement…</div></div>
      ${lic ? `<h3>Rédiger</h3>
      <label>À (indicatifs ou adresses e-mail, séparés par des virgules) <input id="wl-a" placeholder="F4ABC, prefecture@…"></label>
      <label>Copie <input id="wl-cc"></label>
      <label>Sujet <input id="wl-sujet" placeholder="ex. ADRASEC 43 – point de situation 14 h"></label>
      <textarea id="wl-corps" placeholder="Texte du message (signé de votre indicatif)"></textarea>
      <div class="ligne-champs"><button class="principal" id="wl-envoyer">Déposer dans « À envoyer »</button><span id="wl-retour" class="note"></span></div>
      <h3>Session</h3>
      <div class="ligne-champs"><label>Cible <input id="wl-cible" value="${esc(memo('cible') || 'telnet')}" placeholder="telnet ou varahf:///F1ABC-10?freq=3590"></label><button id="wl-session">Lancer la session</button></div>
      <p class="note"><span class="mono">telnet</span> : par Internet. Par radio : <span class="mono">varahf:///INDICATIF-10?freq=7101</span>, <span class="mono">varafm:///…</span>, <span class="mono">ardop:///…</span> ou <span class="mono">ax25:///…</span> selon ce que Pat sait joindre. Une session radio peut durer plusieurs minutes.</p>` : ''}
      <h3>Passerelles RMS</h3>
      <div class="ligne-champs"><label>Mode <select id="wl-mode"><option value="">Tous</option><option value="varahf">VARA HF</option><option value="varafm">VARA FM</option><option value="ardop">ARDOP</option><option value="packet">Packet</option><option value="pactor">PACTOR</option></select></label><button id="wl-rms">Afficher sur la carte</button><button id="wl-rms-effacer">Effacer</button></div>
      <div id="wl-rms-retour" class="note"></div>`;
    for (const b of v.querySelectorAll('[data-boite]')) b.onclick = () => { boite = b.dataset.boite; rendreWinlink(); };
    listerBoite();
    const be = $('#wl-envoyer');
    if (be) be.onclick = async () => {
      $('#wl-retour').textContent = '';
      try { await api('/api/adrasec/winlink/envoyer', { method: 'POST', body: { a: $('#wl-a').value, cc: $('#wl-cc').value, sujet: $('#wl-sujet').value, corps: $('#wl-corps').value } }); $('#wl-retour').textContent = '✔ Déposé : il partira à la prochaine session.'; $('#wl-sujet').value = ''; $('#wl-corps').value = ''; if (boite === 'out') listerBoite(); } catch (e) { $('#wl-retour').innerHTML = `<span class="erreur">${esc(e.message)}</span>`; }
    };
    const bs = $('#wl-session');
    if (bs) bs.onclick = async () => {
      memo('cible', $('#wl-cible').value);
      bs.disabled = true; bs.textContent = 'Session en cours…';
      try { const r = await api('/api/adrasec/winlink/session', { method: 'POST', body: { cible: $('#wl-cible').value } }); alert(`Session terminée${r.recus != null ? ' : ' + r.recus + ' message(s) reçu(s)' : ''}.`); } catch (e) { alert(e.message); }
      rendreWinlink();
    };
    $('#wl-rms').onclick = async () => {
      $('#wl-rms-retour').textContent = 'Liste demandée à Pat…';
      try {
        const l = await api('/api/adrasec/winlink/passerelles?mode=' + encodeURIComponent($('#wl-mode').value));
        couchesRms.clearLayers();
        const b = carte.getBounds().pad(2);
        const proches = l.filter((p) => b.contains([p.lat, p.lon]));
        for (const p of proches) L.circleMarker([p.lat, p.lon], { radius: 6, color: '#0b1117', weight: 1.5, fillColor: '#ffd23f', fillOpacity: 0.95 }).bindPopup(`<b class="mono">${esc(p.indicatif)}</b> · ${esc(p.locator)}<br>${esc(p.modes || '')}<br>${esc(p.freq || (p.freqKHz ? fmt(p.freqKHz, 1) + ' kHz' : ''))}${p.url ? `<br><span class="mono" style="font-size:11px">${esc(p.url)}</span>` : ''}`).addTo(couchesRms);
        $('#wl-rms-retour').textContent = `${proches.length} passerelle(s) affichée(s) autour de la vue (${l.length} dans la liste). Position au carré de locator près.`;
      } catch (e) { $('#wl-rms-retour').innerHTML = `<span class="erreur">${esc(e.message)}</span>`; }
    };
    $('#wl-rms-effacer').onclick = () => { couchesRms.clearLayers(); $('#wl-rms-retour').textContent = ''; };
  }
  async function listerBoite() {
    const z = $('#wl-liste');
    try {
      const l = await api('/api/adrasec/winlink/boite/' + boite);
      z.innerHTML = l.length ? l.map((m) => `<div class="entree msg ${m.nonLu ? 'non-lu' : ''}" data-mid="${esc(m.mid)}"><div class="tete"><b>${esc(m.sujet || '(sans sujet)')}</b><span>${boite === 'in' ? 'de ' + esc(m.de) : 'à ' + esc(m.a.join(', '))}</span><span>${m.date ? heure(m.date) : ''}</span>${m.pieces.length ? `<span>📎 ${m.pieces.length}</span>` : ''}</div><div class="corps" hidden></div></div>`).join('') : '<div class="vide">Boîte vide.</div>';
      for (const d of z.querySelectorAll('[data-mid]')) d.onclick = async () => {
        const c = $('.corps', d);
        if (!c.hidden) { c.hidden = true; return; }
        c.hidden = false; c.textContent = 'Lecture…';
        try { const m = await api(`/api/adrasec/winlink/boite/${boite}/${encodeURIComponent(d.dataset.mid)}`); c.textContent = `De : ${m.de}\nÀ : ${m.a.join(', ')}${m.cc.length ? '\nCc : ' + m.cc.join(', ') : ''}\n\n${m.corps || ''}`; d.classList.remove('non-lu'); } catch (e) { c.textContent = e.message; }
      };
    } catch (e) { z.innerHTML = `<p class="erreur">${esc(e.message)}</p>`; }
  }

  // ---- Gestion : président (responsable) de l'ADRASEC et administrateurs de la carte -----------------------------
  // L'administrateur de la carte crée les ADRASEC hébergées et nomme leurs présidents ; le président (ou
  // l'administrateur) accepte les demandes et intègre les membres radioamateurs ou SWL de son ADRASEC.
  let ajoutes = new Set(); // comptes ajoutés à la main, pas encore enregistrés
  function blocGroupes(titre) {
    return `<h2>${titre}</h2>
      ${E && E.groupes && E.groupes.length ? `<div class="liste-groupes">${E.groupes.map((x) => `<div class="ligne-groupe${E && x.code === E.code ? ' actif' : ''}"><b>${esc(x.nom)}</b> <span class="note">${x.membres} membre${x.membres > 1 ? 's' : ''} · ${x.presidents ? x.presidents + ' président' + (x.presidents > 1 ? 's' : '') : '<span class="attention">pas de président</span>'}</span>${E && x.code === E.code ? ' <span class="pastille">affichée</span>' : ` <button class="mini" data-voir-groupe="${esc(x.code)}">Ouvrir</button>`}</div>`).join('')}</div>` : ''}
      <div class="ligne-champs"><label title="Numéro du département (43, 07, 2A, 971…)">Département <input id="gr-code" class="mono" maxlength="3" placeholder="43" style="width:80px"></label><label>Nom <input id="gr-nom" placeholder="ADRASEC 43"></label><button id="gr-creer" class="principal">Créer l’ADRASEC</button></div>
      <p class="note">Ensuite, ajoutez son président : ouvrez l’ADRASEC, intégrez son compte comme membre et cochez <b>Président</b>. Il gérera lui-même ses membres.</p>`;
  }
  function brancherGroupes(err) {
    $('#gr-code').oninput = () => { const c = $('#gr-code').value.trim().toUpperCase(); if (!$('#gr-nom').dataset.touche) $('#gr-nom').value = c ? 'ADRASEC ' + c : ''; };
    $('#gr-nom').oninput = () => { $('#gr-nom').dataset.touche = '1'; };
    $('#gr-creer').onclick = async () => {
      const code = $('#gr-code').value.trim().toUpperCase();
      try { await api('/api/adrasec/groupes/' + encodeURIComponent(code), { method: 'PUT', body: { nom: $('#gr-nom').value } }); groupe = code; memo('groupe', code); ajoutes = new Set(); await charger(); montrer('gestion'); }
      catch (e) { err(e.message); }
    };
    for (const b of document.querySelectorAll('[data-voir-groupe]')) b.onclick = async () => { groupe = b.dataset.voirGroupe; memo('groupe', groupe); rechercheChoisie = null; ajoutes = new Set(); await charger(); montrer('gestion'); };
  }
  // Administrateur de la carte, aucune ADRASEC créée : seulement la création
  function rendreCreation() {
    $('#onglets [data-vue="gestion"]').hidden = false;
    $('#vue-mc').innerHTML = '<div class="bandeau">Aucune ADRASEC n’est encore créée sur cette carte. Créez celle de votre département dans l’onglet <b>⚙️ Gestion</b>.</div>';
    $('#vue-gestion').innerHTML = `${blocGroupes('ADRASEC hébergées sur cette carte')}<p class="erreur" id="ge-erreur"></p>`;
    brancherGroupes((m) => { $('#ge-erreur').textContent = m; });
    montrer('gestion');
  }
  const QUALITES = { radioamateur: 'Radioamateur licencié', swl: 'SWL (écouteur)', '': 'Autre bénévole' };
  function ficheMembre(c, m) {
    const peutResp = E.moi.admin;
    const qual = m ? m.qualite || (m.licencie ? 'radioamateur' : '') : (c.indicatif ? 'radioamateur' : '');
    return `<div class="fiche-membre${m ? '' : ' nouvelle'}" data-compte="${c.id}">
        <div class="tete-membre"><b>${esc(c.identifiant)}</b>${c.role === 'admin' ? ' <span class="pastille">admin carte</span>' : ''}${m && m.responsable ? ' <span class="pastille ok">président</span>' : ''}
          <label class="case" title="Ouvre la section à ce compte"><input type="checkbox" class="ge-membre" ${m || !c.adrasec ? 'checked' : ''}> Membre</label>
          <label class="case" title="${peutResp ? 'Président (ou responsable) de cette ADRASEC : gère les membres, les équipes, les missions et les réglages de l’ADRASEC, sans être administrateur de la carte.' : 'Seul un administrateur de la carte nomme les présidents.'}"><input type="checkbox" class="ge-resp" ${m && m.responsable ? 'checked' : ''} ${peutResp ? '' : 'disabled'}> Président / responsable</label></div>
        <div class="ligne-champs">
          <label title="Radioamateur licencié : à choisir seulement après avoir vérifié son certificat d’opérateur (ou l’autorisation ANFR) ; ouvre la rédaction et les sessions Winlink. SWL : écouteur, fait des relevés mais n’émet pas sur les bandes amateurs.">Qualité <select class="ge-qual">${Object.entries(QUALITES).map(([k, t]) => `<option value="${k}" ${qual === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label class="ge-ind-l" title="Indicatif radioamateur, ex. F4ABC. Il signe la main courante et les messages Winlink.">Indicatif <input type="text" class="ge-ind mono" value="${esc((m && m.indicatif) || c.indicatif || '')}" placeholder="F4ABC"></label>
          <label class="ge-swl-l" title="Numéro d’écouteur (facultatif), ex. F-12345 ; il signe la main courante.">N° SWL <input type="text" class="ge-swl mono" value="${esc((m && m.numeroSwl) || '')}" placeholder="F-12345"></label>
        </div>
        <div class="ligne-champs">
          <label title="Équipe d’intervention du membre (créées dans l’onglet Équipes)">Équipe <select class="ge-eq"><option value="">—</option>${E.equipes.map((e) => `<option value="${e.id}" ${m && m.equipe === e.id ? 'selected' : ''}>${esc(e.nom)}</option>`).join('')}</select></label>
          <label title="Rôle dans l’ADRASEC, ex. chef d’équipe, opérateur gonio, transmissions">Fonction <input type="text" class="ge-fonc" value="${esc((m && m.fonction) || '')}" placeholder="ex. opérateur gonio"></label>
        </div>
        <label title="Facultatif. Le module Meshtastic que ce membre emporte sur le terrain : sa position s’affiche en direct pour l’équipe, sert de position par défaut pour ses relevés, et ses messages « GONIO 125 » arrivent comme relevés. Commencez à taper son nom pour le choisir dans la liste des nœuds connus.">Nœud porté sur le terrain (facultatif) <input type="text" class="ge-noeud" list="ge-noeuds" value="${m && m.noeud ? '!' + (m.noeud >>> 0).toString(16).padStart(8, '0') + (m.nomNoeud ? ' · ' + esc(m.nomNoeud) : '') : ''}" placeholder="tapez le nom du nœud, ou !a1b2c3d4"></label>
        <div class="ligne-champs"><button class="ge-sauver principal">Enregistrer</button><span class="ge-retour note"></span></div>
      </div>`;
  }
  // ---- Jeu de canaux de l'ADRASEC (président et responsables) ----
  async function chargerCanaux() {
    const z = $('#ge-canaux'); if (!z) return;
    let j;
    try { j = await api('/api/adrasec/canaux'); } catch (e) { z.innerHTML = `<p class="erreur">${esc(e.message)}</p>`; return; }
    const badge = (c) => (c.chiffrement === 'prive' ? `🔒 <span class="mono">${esc(c.empreinte || '')}</span>` : '<span class="pastille att">en clair</span>');
    const ligne = (c = {}) => `<div class="ligne-champs ligne-jeu" data-id="${esc(c.id || '')}">
      <input class="mono" data-champ="nom" maxlength="11" placeholder="Nom (11 car.)" value="${esc(c.nom || '')}" style="width:9.5em">
      <select data-champ="cle">${c.id ? `<option value="">garder la clé${c.empreinte ? ' ' + esc(c.empreinte) : ' (publique)'}</option>` : ''}<option value="aleatoire" ${c.id ? '' : 'selected'}>nouvelle clé privée (aléatoire)</option><option value="publique">clé publique (en clair)</option><option value="coller">coller une clé (base64)</option></select>
      <input class="mono" data-champ="collee" placeholder="clé en base64 (16 ou 32 octets)" hidden autocomplete="off">
      <label class="case"><input type="checkbox" data-champ="positions" ${c.positions ? 'checked' : ''}> positions</label>
      <button type="button" class="mini" data-retirer title="Retirer ce canal">✕</button></div>`;
    z.innerHTML = `${j.canaux.length ? `<div class="liste-canaux-adrasec">${j.canaux.map((c) => `<div class="ligne-champs"><b class="mono">${esc(c.nom)}</b> ${badge(c)}${c.positions ? ' <small>positions partagées</small>' : ''}</div>`).join('')}</div>` : '<p class="note">Aucun canal défini pour l’instant.</p>'}
      ${j.maj ? `<p class="note">Modifié le ${new Date(j.maj).toLocaleString('fr-FR')}${j.auteur ? ' par ' + esc(j.auteur) : ''}.</p>` : ''}
      ${j.modifiable ? `<details class="edition-canaux"><summary>✏️ Modifier les canaux</summary>
        <p class="note">7 canaux au plus (le canal 0 de la radio n’est jamais touché). Nom : lettres sans accent, chiffres, _ + - . (11 caractères).</p>
        <div class="lignes-jeu">${j.canaux.map(ligne).join('')}</div>
        <div class="ligne-champs"><button type="button" id="gc-plus">＋ Canal</button><button type="button" class="principal" id="gc-ok">✔ Enregistrer les canaux</button><span class="erreur" id="gc-err"></span></div></details>` : ''}`;
    if (!j.modifiable) return;
    const brancher = () => z.querySelectorAll('.ligne-jeu').forEach((l) => {
      const sel = l.querySelector('[data-champ="cle"]'), col = l.querySelector('[data-champ="collee"]');
      sel.onchange = () => { col.hidden = sel.value !== 'coller'; if (!col.hidden) col.focus(); };
      l.querySelector('[data-retirer]').onclick = () => l.remove();
    });
    brancher();
    $('#gc-plus').onclick = () => { if (z.querySelectorAll('.ligne-jeu').length >= 7) return; z.querySelector('.lignes-jeu').insertAdjacentHTML('beforeend', ligne()); brancher(); };
    $('#gc-ok').onclick = async () => {
      const canaux = [...z.querySelectorAll('.ligne-jeu')].map((l) => {
        const v = (k) => l.querySelector(`[data-champ="${k}"]`);
        return { id: l.dataset.id || undefined, nom: v('nom').value.trim(), cle: v('cle').value === 'coller' ? v('collee').value.trim() : v('cle').value, positions: v('positions').checked };
      });
      try { await api('/api/adrasec/canaux', { method: 'PUT', body: { canaux } }); chargerCanaux(); } catch (e) { $('#gc-err').textContent = e.message; }
    };
  }
  // ---- Transfert de la section d'une carte à une autre : export d'un fichier, import avec récapitulatif ----
  function brancherTransfert(err) {
    const lien = $('#tr-export'); if (lien) lien.href = avecGroupe('/api/adrasec/export.json');
    const champ = $('#tr-fichier'), zone = $('#tr-apercu');
    if (!champ || !zone) return;
    const ligne = (titre, l, classe = 'note') => (l.length ? `<p class="${classe}"><b>${esc(titre)} (${l.length})</b> : ${l.map((x) => esc(x.quoi) + (x.identifiant ? ' → ' + esc(x.identifiant) : '') + (x.equipe ? ' · ' + esc(x.equipe) : '') + (x.raison ? ' — ' + esc(x.raison) : '')).join(' · ')}</p>` : '');
    const recap = (r) => `<div class="bandeau">
      <h3>Import depuis « ${esc(r.section)} »</h3>
      <p><b>${r.rattaches.length}</b> membre${r.rattaches.length > 1 ? 's' : ''} rattaché${r.rattaches.length > 1 ? 's' : ''} à un compte existant · <b>${r.attentes.length}</b> fiche${r.attentes.length > 1 ? 's' : ''} en attente d’un compte · <b>${r.equipesCreees.length}</b> équipe${r.equipesCreees.length > 1 ? 's' : ''} à créer · <b>${r.dejaMembres.length + r.ambigus.length + r.ignores.length}</b> ignoré${r.dejaMembres.length + r.ambigus.length + r.ignores.length > 1 ? 's' : ''}</p>
      ${r.equipesCreees.length ? `<p class="note"><b>Équipes créées</b> : ${r.equipesCreees.map(esc).join(', ')}${r.equipesExistantes > 0 ? ` (${r.equipesExistantes} déjà présente${r.equipesExistantes > 1 ? 's' : ''}, réutilisée${r.equipesExistantes > 1 ? 's' : ''})` : ''}</p>` : r.equipesExistantes > 0 ? `<p class="note">Les ${r.equipesExistantes} équipe(s) du fichier existent déjà ici : elles sont réutilisées, pas dupliquées.</p>` : ''}
      ${ligne('Rattachés à un compte', r.rattaches)}
      ${ligne('En attente du compte de la personne', r.attentes)}
      ${ligne('Déjà membres ici', r.dejaMembres)}
      ${ligne('À rattacher à la main', r.ambigus, 'note attention')}
      ${ligne('Ignorés', r.ignores, 'note attention')}
      ${r.presidents ? `<p class="note">${r.presidents} président(s) dans le fichier : le rôle n’est <b>pas</b> repris. Un administrateur de cette carte doit le donner.</p>` : ''}
      ${r.sansIdentifiant ? `<p class="note">${r.sansIdentifiant} membre(s) de la carte d’origine n’avaient ni indicatif ni n° SWL : rien ne permettait de les reconnaître, ils ne sont pas dans le fichier.</p>` : ''}
      <p class="note">Rien n’est effacé : les membres déjà présents ici restent en place.</p>
      <div class="ligne-champs"><button class="principal" id="tr-ok" ${r.rattaches.length + r.attentes.length + r.equipesCreees.length ? '' : 'disabled'}>✔ Appliquer l’import</button><button id="tr-non">Annuler</button><span class="erreur" id="tr-err"></span></div></div>`;
    champ.onchange = async () => {
      const f = champ.files && champ.files[0];
      champ.value = '';
      zone.innerHTML = '';
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) { err('Fichier trop gros (2 Mo au plus) : ce n’est probablement pas un export de section.'); return; }
      let doc;
      try { doc = JSON.parse(await f.text()); } catch { err('Fichier illisible : attendu le fichier .json exporté par une autre carte.'); return; }
      let r;
      try { r = await api('/api/adrasec/import', { method: 'POST', body: { fichier: doc, appliquer: false } }); } catch (e) { err(e.message); return; }
      err('');
      zone.innerHTML = recap(r);
      zone.scrollIntoView({ block: 'nearest' });
      $('#tr-non').onclick = () => { zone.innerHTML = ''; };
      $('#tr-ok').onclick = async () => {
        $('#tr-ok').disabled = true;
        try { const fait = await api('/api/adrasec/import', { method: 'POST', body: { fichier: doc, appliquer: true } }); zone.innerHTML = `<div class="bandeau">✔ Import terminé : ${fait.rattaches.length} membre(s) rattaché(s), ${fait.attentes.length} fiche(s) en attente, ${fait.equipesCreees.length} équipe(s) créée(s).</div>`; await charger(); montrer('gestion'); }
        catch (e) { $('#tr-ok').disabled = false; $('#tr-err').textContent = e.message; }
      };
    };
  }
  function rendreGestion() {
    const v = $('#vue-gestion');
    const membres = E.comptes.filter((c) => c.adrasec || ajoutes.has(c.id));
    const autres = E.comptes.filter((c) => !c.adrasec && !ajoutes.has(c.id));
    const lien = location.origin + '/adrasec';
    v.innerHTML = `${(E.demandes || []).length ? `<h2>Demandes d’adhésion <span class="pastille att">${E.demandes.length}</span></h2>
      ${E.demandes.map((x) => `<div class="fiche-membre demande" data-demande="${x.compte}"><div class="tete-membre"><b>${esc(x.identifiant)}</b> <span class="pastille">${esc(QUALITES[x.qualite || ''] || '')}</span>${x.indicatif || x.numeroSwl ? ` <span class="mono">${esc(x.indicatif || x.numeroSwl)}</span>` : ''} <small class="note">le ${new Date(x.heure).toLocaleString('fr-FR')}</small></div>
        ${x.message ? `<p class="message-demande">« ${esc(x.message)} »</p>` : ''}
        <div class="ligne-champs"><button class="principal ge-accepter">✔ Accepter</button><button class="danger ge-refuser">Refuser</button></div>
        ${x.qualite === 'radioamateur' ? '<p class="note">Vérifiez son certificat d’opérateur avant de laisser la qualité « radioamateur licencié ».</p>' : ''}</div>`).join('')}` : ''}
      <h2>Membres de ${esc(E.nom)} <span class="pastille">${E.membres.length}</span></h2>
      <p class="note">Pour faire entrer quelqu’un : envoyez-lui le lien <b class="mono">${esc(lien)}</b> <button class="mini" id="ge-copier">Copier</button>. Il crée son compte sur la carte, puis demande à rejoindre ${esc(E.nom)} ; sa demande apparaît ici. Vous pouvez aussi intégrer directement un compte existant (plus bas).</p>
      ${E.comptesEnAttente ? `<div class="bandeau">⏳ ${E.comptesEnAttente} compte${E.comptesEnAttente > 1 ? 's' : ''} de la carte attend${E.comptesEnAttente > 1 ? 'ent' : ''} votre validation (carte → Gérer → Comptes) avant de pouvoir demander à rejoindre.</div>` : ''}
      <datalist id="ge-noeuds"></datalist>
      <input type="search" id="ge-filtre" placeholder="🔎 Chercher un membre (nom, indicatif)">
      <div id="ge-fiches">${membres.map((c) => ficheMembre(c, E.membres.find((x) => x.compte === c.id))).join('') || '<p class="note">Aucun membre pour l’instant.</p>'}</div>
      <h2>Intégrer un compte de la carte</h2>
      ${autres.length ? `<p class="note">Cochez un ou plusieurs comptes. Ceux qui ont un indicatif sont intégrés comme radioamateurs licenciés, les autres comme bénévoles : corrigez ensuite leur fiche si besoin (SWL, équipe, nœud).</p>
        <div class="ligne-champs"><input type="search" id="ge-ajout-filtre" placeholder="🔎 Filtrer les comptes"><label class="case"><input type="checkbox" id="ge-ajout-tout"> Tout cocher</label></div>
        <div class="liste-ajout" id="ge-ajout-liste">${autres.map((c) => `<label class="case${c.autre ? ' indispo' : ''}" data-texte="${esc((c.identifiant + ' ' + (c.indicatif || '')).toLowerCase())}"><input type="checkbox" value="${c.id}" ${c.autre ? 'disabled' : ''}> <b>${esc(c.identifiant)}</b>${c.indicatif ? ` <span class="mono">${esc(c.indicatif)}</span>` : ''}${c.autre ? ` <small>(membre de l’ADRASEC ${esc(c.autre)})</small>` : ''}</label>`).join('')}</div>
        <div class="ligne-champs"><button id="ge-ajouter" class="principal" disabled>Intégrer la sélection</button><span class="note" id="ge-ajout-retour"></span></div>` : '<p class="note">Tous les comptes de la carte sont déjà membres. Les nouveaux membres créent d’abord leur compte avec le lien ci-dessus.</p>'}
      ${(E.attentes || []).length ? `<h2>Fiches en attente d’un compte <span class="pastille att">${E.attentes.length}</span></h2>
      <p class="note">Ces fiches viennent d’une autre carte. La personne doit <b>créer son compte elle-même</b> avec le lien ci-dessus, puis demander à rejoindre ${esc(E.nom)} : sa fiche (équipe, fonction, nœud) se rattachera toute seule. Rien ici ne donne d’accès à qui que ce soit.</p>
      ${E.attentes.map((a) => `<div class="fiche-membre attente" data-attente="${esc(a.id)}"><div class="tete-membre"><b class="mono">${esc(a.indicatif || a.numeroSwl || '?')}</b> <span class="pastille">${esc(QUALITES[a.qualite || ''] || '')}</span>${a.fonction ? ' <small>' + esc(a.fonction) + '</small>' : ''}${a.equipe ? ' <small>équipe ' + esc((E.equipes.find((e) => e.id === a.equipe) || {}).nom || '') + '</small>' : ''}</div>
        <p class="note">Importée${a.source ? ' de ' + esc(a.source) : ''} le ${new Date(a.heure).toLocaleDateString('fr-FR')}${a.identifiant ? ` · un compte porte cet indicatif : <b>${esc(a.identifiant)}</b>` : a.homonymes > 1 ? ` · ${a.homonymes} comptes portent cet indicatif : à rattacher à la main` : ' · aucun compte ne porte encore cet indicatif'}</p>
        <div class="ligne-champs">${a.compte ? '<button class="principal at-rattacher">Rattacher à ce compte</button>' : ''}<button class="danger at-retirer">Retirer la fiche</button><span class="note at-retour"></span></div></div>`).join('')}` : ''}
      <h2>🎚️ Canaux de ${esc(E.nom)}</h2>
      <p class="note">Les canaux Meshtastic que vos membres doivent avoir sur leur radio. Un membre qui relie sa radio à la carte depuis son navigateur (carte › Outils › 📡 Devenir passerelle) les y écrit en un clic. Les clés restent sur le serveur, chiffrées : personne ne les voit, pas même ici (une empreinte courte permet de les reconnaître).</p>
      <div id="ge-canaux"><p class="note">Chargement…</p></div>
      <h2>Réglages de ${esc(E.nom)}</h2>
      <div class="ligne-champs"><label>Nom affiché <input id="ge-nom" value="${esc(E.nom)}" placeholder="ADRASEC 43"></label><label>Conservation (jours) <input id="ge-cons" type="number" min="7" max="3650" value="${E.conservationJours}"></label><button id="ge-ok">Enregistrer</button></div>
      <p class="note">Main courante et relevés plus anciens que la durée choisie sont effacés (données personnelles : indicatifs, positions).</p>
      <h2>🔄 Transférer la section vers une autre carte</h2>
      <p class="note">Pour installer ${esc(E.nom)} sur une autre carte (celle d’un collègue, un second serveur) : exportez un fichier ici, puis importez-le là-bas. Le fichier contient le <b>nom de la section, les équipes et la fiche de chaque membre</b> (indicatif, qualité, n° SWL, équipe, fonction, nœud porté). Il ne contient <b>aucun compte, aucun mot de passe</b> : sur la carte d’arrivée, chacun crée son compte lui-même avec le lien d’invitation, et sa fiche l’y attend.</p>
      <p class="note">La <b>main courante</b> et les <b>recherches</b> ne partent pas : ce sont les archives horodatées et signées d’opérations réelles, qui restent sur la carte qui les a enregistrées (bouton « Exporter la main courante » pour les archiver en CSV). Le rôle de <b>président</b> ne part pas non plus : seul un administrateur de la carte d’arrivée peut le donner.</p>
      <div class="ligne-champs"><a class="bouton" id="tr-export" href="/api/adrasec/export.json" download>⬇ Exporter la section (fichier .json)</a>
        <label class="bouton">📥 Importer un fichier…<input type="file" id="tr-fichier" accept=".json,application/json" hidden></label></div>
      <div id="tr-apercu"></div>
      ${E.moi.admin ? `<div class="ligne-champs"><label style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="ge-actif" ${E.actif ? 'checked' : ''}> Section ADRASEC activée sur la carte</label></div>${blocGroupes('ADRASEC hébergées sur cette carte')}` : ''}
      <p class="erreur" id="ge-erreur"></p>`;
    const err = (m) => { $('#ge-erreur').textContent = m; if (m) $('#ge-erreur').scrollIntoView({ block: 'nearest' }); };
    chargerCanaux();
    brancherTransfert(err);
    // Fiches en attente venues d'une autre carte
    for (const f of v.querySelectorAll('.fiche-membre[data-attente]')) {
      const a = (E.attentes || []).find((x) => x.id === f.dataset.attente);
      const r = $('.at-retour', f);
      const bR = $('.at-rattacher', f);
      if (bR) bR.onclick = async () => {
        bR.disabled = true;
        try { await api('/api/adrasec/membres/' + a.compte, { method: 'PUT', body: { membre: true, qualite: a.qualite || '', indicatif: a.indicatif || '', numeroSwl: a.numeroSwl || '' } }); await charger(); }
        catch (e) { bR.disabled = false; r.textContent = e.message; }
      };
      $('.at-retirer', f).onclick = async () => {
        if (!confirm(`Retirer la fiche en attente de ${a.indicatif || a.numeroSwl} ? Elle devra être ressaisie à la main.`)) return;
        try { await api('/api/adrasec/attentes/' + encodeURIComponent(a.id), { method: 'DELETE' }); await charger(); } catch (e) { r.textContent = e.message; }
      };
    }
    $('#ge-copier').onclick = async () => { try { await navigator.clipboard.writeText(lien); $('#ge-copier').textContent = '✔ Copié'; } catch { prompt('Lien à envoyer :', lien); } };
    $('#ge-ok').onclick = async () => { try { await api('/api/adrasec/reglages', { method: 'PUT', body: { nom: $('#ge-nom').value, conservationJours: $('#ge-cons').value } }); await charger(); } catch (e) { err(e.message); } };
    if ($('#ge-actif')) { $('#ge-actif').onchange = async () => { try { await api('/api/adrasec/reglages', { method: 'PUT', body: { actif: $('#ge-actif').checked } }); await charger(); } catch (e) { err(e.message); } }; brancherGroupes(err); }
    $('#ge-filtre').oninput = () => { const q = $('#ge-filtre').value.trim().toLowerCase(); for (const f of v.querySelectorAll('#ge-fiches .fiche-membre')) f.hidden = !!q && !f.textContent.toLowerCase().includes(q) && !$('.ge-ind', f).value.toLowerCase().includes(q); };
    // Intégration de plusieurs comptes d'un coup
    if ($('#ge-ajouter')) {
      const cases = () => [...v.querySelectorAll('#ge-ajout-liste input:not([disabled])')];
      const choisis = () => cases().filter((x) => x.checked);
      const maj = () => { const n = choisis().length; $('#ge-ajouter').disabled = !n; $('#ge-ajouter').textContent = n ? `Intégrer la sélection (${n})` : 'Intégrer la sélection'; };
      v.querySelector('#ge-ajout-liste').onchange = maj;
      $('#ge-ajout-filtre').oninput = () => { const q = $('#ge-ajout-filtre').value.trim().toLowerCase(); for (const l of v.querySelectorAll('#ge-ajout-liste label')) l.hidden = !!q && !l.dataset.texte.includes(q); };
      $('#ge-ajout-tout').onchange = () => { for (const x of cases()) if (!x.closest('label').hidden) x.checked = $('#ge-ajout-tout').checked; maj(); };
      $('#ge-ajouter').onclick = async () => {
        const ids = choisis().map((x) => Number(x.value));
        $('#ge-ajouter').disabled = true;
        let faits = 0; const erreurs = [];
        for (const id of ids) {
          const c = E.comptes.find((x) => x.id === id) || {};
          try { await api('/api/adrasec/membres/' + id, { method: 'PUT', body: { membre: true, qualite: c.indicatif ? 'radioamateur' : '', indicatif: c.indicatif || '' } }); faits++; $('#ge-ajout-retour').textContent = `${faits} / ${ids.length}…`; }
          catch (e) { erreurs.push(`${c.identifiant} : ${e.message}`); }
        }
        await charger();
        if (erreurs.length) err(erreurs.join(' · '));
        const r = $('#ge-ajout-retour'); if (r) r.textContent = `✔ ${faits} membre${faits > 1 ? 's' : ''} intégré${faits > 1 ? 's' : ''}`;
      };
    }
    for (const f of v.querySelectorAll('.fiche-membre[data-demande]')) {
      const cid = f.dataset.demande, x = E.demandes.find((y) => String(y.compte) === cid);
      $('.ge-accepter', f).onclick = async () => { try { await api('/api/adrasec/membres/' + cid, { method: 'PUT', body: { membre: true, qualite: x.qualite || '', indicatif: x.indicatif || x.indicatifCompte || '', numeroSwl: x.numeroSwl || '' } }); await charger(); } catch (e) { err(e.message); } };
      $('.ge-refuser', f).onclick = async () => { if (!confirm(`Refuser la demande de ${x.identifiant} ?`)) return; try { await api('/api/adrasec/demandes/' + cid, { method: 'DELETE' }); await charger(); } catch (e) { err(e.message); } };
    }
    // Champs selon la qualité : indicatif pour un radioamateur, numéro d'écouteur pour un SWL
    for (const f of v.querySelectorAll('.fiche-membre[data-compte]')) { const maj = () => { const q = $('.ge-qual', f).value; $('.ge-ind-l', f).hidden = q !== 'radioamateur'; $('.ge-swl-l', f).hidden = q !== 'swl'; }; $('.ge-qual', f).onchange = maj; maj(); }
    // Liste des nœuds Meshtastic connus, pour choisir le nœud porté par son nom
    api('/api/noeuds').then((l) => { const d = $('#ge-noeuds'); if (d) d.innerHTML = (Array.isArray(l) ? l : []).filter((n) => n.num != null).map((n) => `<option value="!${(n.num >>> 0).toString(16).padStart(8, '0')} · ${esc(n.nomLong || n.nomCourt || '')}">`).join(''); }).catch(() => {});
    for (const tr of v.querySelectorAll('.fiche-membre[data-compte]')) $('.ge-sauver', tr).onclick = async () => {
      err('');
      // « !a1b2c3d4 · Nom » (choisi dans la liste), « !a1b2c3d4 » ou numéro décimal
      const n = $('.ge-noeud', tr).value.trim();
      const hex = /^!?([0-9a-f]{8})\b/i.exec(n);
      const noeud = !n ? null : hex ? parseInt(hex[1], 16) : /^\d+$/.test(n) ? Number(n) : NaN;
      if (Number.isNaN(noeud)) { err('Nœud : choisissez-le dans la liste en tapant son nom, ou saisissez son identifiant (!a1b2c3d4)'); return; }
      const membre = $('.ge-membre', tr).checked;
      if (!membre && !confirm('Retirer ce compte de l’ADRASEC ?')) return;
      const q = $('.ge-qual', tr).value;
      const corps = { membre: true, qualite: q, indicatif: q === 'radioamateur' ? $('.ge-ind', tr).value : '', numeroSwl: q === 'swl' ? $('.ge-swl', tr).value : '', equipe: $('.ge-eq', tr).value || null, fonction: $('.ge-fonc', tr).value, noeud };
      if (E.moi.admin) corps.responsable = $('.ge-resp', tr).checked;
      try {
        await api('/api/adrasec/membres/' + tr.dataset.compte, { method: 'PUT', body: membre ? corps : { membre: false } });
        ajoutes.delete(Number(tr.dataset.compte));
        $('.ge-retour', tr).textContent = '✔ Enregistré'; charger();
      } catch (e) { err(e.message); }
    };
  }

  await charger();
  montrer(ongletActif);
  cadrerGonio();
  // Rafraîchissement : toutes les 15 s, sans perdre la saisie en cours
  setInterval(() => { const a = document.activeElement; if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return; if (document.querySelector('.choix-mission, .choix-membres, #g-form-nouvelle:not([hidden]), #ge-ajout-liste input:checked, .fiche-membre.nouvelle, .edition-canaux[open]')) return; charger(); }, 15000);
  window.adrasecEtat = () => E; // essais
})();
