'use strict';
// Page de la section ADRASEC : main courante, radiogoniométrie (relevés, cônes, intersection), équipes, Winlink (Pat)
// et gestion des membres par les administrateurs. Données : /api/adrasec (réservé aux membres validés).
(async () => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 0) => (n == null || !Number.isFinite(Number(n)) ? '–' : Number(n).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const heure = (t) => new Date(t).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  async function api(url, opts = {}) {
    const r = await fetch(url, { credentials: 'same-origin', ...opts, headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erreur || 'Erreur ' + r.status);
    return j;
  }
  const memo = (k, v) => { try { if (v === undefined) return localStorage.getItem('adrasec-' + k); localStorage.setItem('adrasec-' + k, v); } catch { /* navigateur sans stockage */ } return null; };

  // ---- Accès -----------------------------------------------------------------------------------------------
  const acces = await api('/api/adrasec/acces').catch(() => ({ acces: false }));
  $('#titre').textContent = `Section ${acces.nom || 'ADRASEC'}`;
  document.title = `Section ${acces.nom || 'ADRASEC'}`;
  if (!acces.acces) {
    document.querySelector('main').innerHTML = `<div style="margin:auto;max-width:520px;padding:24px" class="bandeau"><b>Accès réservé.</b><br>Cette section est réservée aux membres de ${esc(acces.nom || 'l’ADRASEC')} validés par un administrateur de la carte. Connectez-vous sur la carte avec votre compte, puis demandez à un administrateur de vous ajouter à la section.</div>`;
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
  const couchesGonio = L.layerGroup().addTo(carte), couchesEquipes = L.layerGroup().addTo(carte), couchesRms = L.layerGroup().addTo(carte);
  let modeClic = null; // fonction appelée au prochain clic sur la carte
  carte.on('click', (e) => { if (!modeClic) return; const f = modeClic; modeClic = null; $('#consigne').hidden = true; f(e.latlng); });
  const consigne = (t) => { const c = $('#consigne'); c.textContent = t; c.hidden = !t; };

  // ---- État ---------------------------------------------------------------------------------------------------
  let E = null, rechercheChoisie = memo('recherche') || null, ongletActif = memo('onglet') || 'mc';
  const equipe = (id) => (E && E.equipes.find((e) => e.id === id)) || null;
  const couleurEquipe = (id) => (equipe(id) || {}).couleur || '#c3d0dc';
  const nomEquipe = (id) => (equipe(id) || {}).nom || '';

  for (const b of document.querySelectorAll('#onglets button')) b.onclick = () => montrer(b.dataset.vue);
  function montrer(v) {
    ongletActif = v; memo('onglet', v);
    for (const b of document.querySelectorAll('#onglets button')) b.classList.toggle('actif', b.dataset.vue === v);
    for (const s of document.querySelectorAll('.vue')) s.classList.toggle('actif', s.id === 'vue-' + v);
    if (v === 'winlink') rendreWinlink();
  }

  async function charger() {
    try { E = await api('/api/adrasec'); } catch (e) { $('#vue-mc').innerHTML = `<p class="erreur">${esc(e.message)}</p>`; return; }
    $('#moi').innerHTML = `${esc(E.moi.indicatif || E.moi.identifiant)} ${E.moi.licencie ? '<span class="pastille ok">licencié</span>' : '<span class="pastille">non licencié</span>'}${E.moi.admin ? ' <span class="pastille">admin</span>' : ''}`;
    $('#onglets [data-vue="gestion"]').hidden = !E.moi.admin;
    if (!E.actif) $('#vue-mc').innerHTML = `<div class="bandeau">La section est <b>désactivée</b>. ${E.moi.admin ? 'Activez-la dans l’onglet ⚙️ Gestion, puis ajoutez les membres.' : ''}</div>`;
    if (!E.recherches.some((r) => r.id === rechercheChoisie)) rechercheChoisie = (E.recherches.find((r) => r.statut === 'en-cours') || E.recherches[0] || {}).id || null;
    if (E.actif) rendreMc();
    rendreGonio(); rendreEquipes();
    if (E.moi.admin) rendreGestion();
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
      <div class="ligne-champs"><button class="principal" id="mc-ajouter">Inscrire</button><a href="/api/adrasec/main-courante.csv" download><button type="button">⬇ Export CSV</button></a><span class="erreur" id="mc-erreur"></span></div>
      <p class="note">Les inscriptions ne se modifient pas : pour corriger, inscrivez une nouvelle ligne. Les relevés, recherches et messages Winlink s'y ajoutent tout seuls.</p>
      <div id="mc-liste">${E.mainCourante.length ? E.mainCourante.slice().reverse().map((x) => `<div class="entree"><div class="tete"><b>${heure(x.heure)}</b><span>${esc(x.auteur)}</span>${x.equipe ? `<span><i class="equipe-pastille" style="background:${couleurEquipe(x.equipe)}"></i>${esc(nomEquipe(x.equipe))}</span>` : ''}<span class="type">${esc(LIB_TYPE[x.type] || x.type)}</span></div><div class="corps">${esc(x.texte)}</div></div>`).join('') : '<div class="vide">Aucune inscription.</div>'}</div>`;
    $('#mc-texte').value = brouillon;
    $('#mc-ajouter').onclick = async () => {
      try { await api('/api/adrasec/main-courante', { method: 'POST', body: { type: $('#mc-type').value, equipe: $('#mc-equipe').value, texte: $('#mc-texte').value } }); $('#mc-texte').value = ''; charger(); } catch (e) { $('#mc-erreur').textContent = e.message; }
    };
  }

  // ---- Radiogoniométrie ---------------------------------------------------------------------------------------
  let posReleve = null; // { lat, lon, source, locator? }
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
      ${enCours ? `<h3>Nouveau relevé</h3>
      <div class="ligne-champs"><label>Gisement vrai (°) <input id="g-gis" inputmode="decimal" placeholder="0 à 360"></label><label>Incertitude ± (°) <input id="g-inc" inputmode="decimal"></label><label>Force <select id="g-force"><option value="">—</option><option>S1-S3 faible</option><option>S4-S6 moyen</option><option>S7-S9 fort</option><option>Saturé</option></select></label></div>
      <div class="note">Position de l’équipe :</div>
      <div class="choix-pos"><button data-pos="gps">📍 Mon GPS</button><button data-pos="noeud" ${E.moi.noeud ? '' : 'disabled title="Aucun nœud associé à votre compte"'}>📡 Mon nœud</button><button data-pos="carte">🖱 Clic sur la carte</button><button data-pos="locator">⌗ Locator</button></div>
      <div id="g-pos-detail" class="note">${posReleve ? `Retenue : <b class="mono">${posReleve.lat.toFixed(5)}, ${posReleve.lon.toFixed(5)}</b> (${esc(posReleve.source)})` : 'Aucune position choisie.'}</div>
      <div id="g-loc-zone" hidden><label>QTH-locator (6 à 10 caractères) <input id="g-loc" placeholder="JN15XC33"></label></div>
      <label>Note <input id="g-note" placeholder="ex. réflexion probable, antenne Yagi 3 él."></label>
      <div class="ligne-champs"><button class="principal" id="g-envoyer">Envoyer le relevé</button><span class="erreur" id="g-erreur"></span></div>
      <p class="note">Par radio : depuis le nœud associé à son compte, un membre envoie « <b class="mono">GONIO 125</b> » ou « <b class="mono">GIS 125/5</b> » (gisement puis incertitude) ; le relevé arrive ici avec la position du nœud.</p>` : `<p class="note">Recherche clôturée le ${heure(r.fin)}${r.resultat ? ' : ' + esc(r.resultat) : ''}.</p>`}
      <h3>Relevés (${r.releves.length})</h3>
      ${r.releves.length ? r.releves.slice().reverse().map((x) => { const rs = c && c.residus[x.id]; const ecarte = c && c.ecartes.includes(x.id); return `<div class="entree ${x.retire ? 'retire' : ''}"><div class="tete"><b>${heure(x.heure)}</b><span>${esc(x.auteur)}</span>${x.equipe ? `<span><i class="equipe-pastille" style="background:${couleurEquipe(x.equipe)}"></i>${esc(nomEquipe(x.equipe))}</span>` : ''}${x.origine === 'radio' ? '<span class="type">radio</span>' : ''}</div>
        <div class="corps"><b>${fmt(x.gisement, 1)}°</b> ±${fmt(x.incertitude, 1)}° depuis <span class="mono">${Gonio.versLocator(x.lat, x.lon, 8)}</span> (${esc(x.source)})${x.force ? ' · ' + esc(x.force) : ''}${rs && !x.retire ? ` · écart ${fmt(rs.ecartDeg, 1)}° à ${fmt(rs.distanceM / 1000, 1)} km` : ''}${ecarte ? ' · <b class="erreur">écarté (tourne le dos aux autres)</b>' : ''}${x.note ? '<br><span class="note">' + esc(x.note) + '</span>' : ''}
        ${!x.retire && enCours ? ` <button class="mini" data-retirer="${x.id}">Retirer du calcul</button>` : ''}</div></div>`; }).join('') : '<div class="vide">Aucun relevé.</div>'}` : '<p class="note">Ouvrez une recherche pour saisir les relevés des équipes.</p>'}`;
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
    for (const b of v.querySelectorAll('[data-retirer]')) b.onclick = async () => { await api('/api/adrasec/releves/' + b.dataset.retirer, { method: 'DELETE' }).catch((e) => alert(e.message)); charger(); };
    for (const b of v.querySelectorAll('[data-pos]')) b.onclick = () => choisirPosition(b.dataset.pos);
    const env = $('#g-envoyer');
    if (env) env.onclick = async () => {
      $('#g-erreur').textContent = '';
      const corps = { recherche: r.id, gisement: $('#g-gis').value, incertitude: $('#g-inc').value, force: $('#g-force').value, note: $('#g-note').value };
      if (!$('#g-loc-zone').hidden && $('#g-loc').value.trim()) corps.locator = $('#g-loc').value.trim();
      else if (posReleve && posReleve.source === 'mon nœud') corps.noeud = E.moi.noeud;
      else if (posReleve) Object.assign(corps, { lat: posReleve.lat, lon: posReleve.lon, source: posReleve.source === 'GPS' ? 'gps' : 'carte' });
      memo('incertitude', $('#g-inc').value);
      try { await api('/api/adrasec/releves', { method: 'POST', body: corps }); $('#g-gis').value = ''; $('#g-note').value = ''; charger(); } catch (e) { $('#g-erreur').textContent = e.message; }
    };
    dessinerGonio(r);
  }
  function choisirPosition(mode) {
    for (const b of document.querySelectorAll('[data-pos]')) b.classList.toggle('actif', b.dataset.pos === mode);
    $('#g-loc-zone').hidden = mode !== 'locator';
    const maj = (p) => { posReleve = p; const d = $('#g-pos-detail'); if (d) d.innerHTML = `Retenue : <b class="mono">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</b> (${esc(p.source)}${p.precision ? ', ±' + Math.round(p.precision) + ' m' : ''})`; };
    if (mode === 'gps') {
      if (!navigator.geolocation) { $('#g-pos-detail').textContent = 'GPS indisponible sur cet appareil.'; return; }
      $('#g-pos-detail').textContent = '📡 Recherche de la position GPS…';
      navigator.geolocation.getCurrentPosition((p) => maj({ lat: p.coords.latitude, lon: p.coords.longitude, precision: p.coords.accuracy, source: 'GPS' }), (e) => { $('#g-pos-detail').textContent = 'GPS : ' + e.message; }, { enableHighAccuracy: true, timeout: 30000, maximumAge: 10000 });
    } else if (mode === 'noeud') {
      const m = E.membres.find((x) => x.noeud === E.moi.noeud);
      if (m && m.position) maj({ ...m.position, source: 'mon nœud' }); else { posReleve = { lat: 0, lon: 0, source: 'mon nœud' }; $('#g-pos-detail').textContent = 'Position de votre nœud : prise par le serveur à l’envoi.'; }
    } else if (mode === 'carte') {
      consigne('Cliquez sur la carte à l’endroit où se trouve l’équipe');
      modeClic = (ll) => maj({ lat: ll.lat, lon: ll.lng, source: 'carte' });
    } else { posReleve = null; $('#g-pos-detail').textContent = 'Saisissez le locator ci-dessous.'; $('#g-loc').focus(); }
  }
  function dessinerGonio(r) {
    couchesGonio.clearLayers();
    if (!r) return;
    const c = r.calcul, est = c && c.estimation;
    for (const x of r.releves) {
      if (x.retire) continue;
      const coul = couleurEquipe(x.equipe), ecarte = c && c.ecartes.includes(x.id);
      const longueur = Math.max(15000, est ? Gonio.distance(x, est) * 1.6 : 30000);
      L.polygon(Gonio.cone(x, longueur), { color: coul, weight: 1, opacity: 0.6, fillOpacity: ecarte ? 0.04 : 0.13, dashArray: ecarte ? '4 4' : null, interactive: false }).addTo(couchesGonio);
      const bout = Gonio.destination(x.lat, x.lon, x.gisement, longueur);
      L.polyline([[x.lat, x.lon], [bout.lat, bout.lon]], { color: coul, weight: 2.5, opacity: ecarte ? 0.4 : 0.95 }).addTo(couchesGonio);
      L.circleMarker([x.lat, x.lon], { radius: 6, color: '#0b1117', weight: 2, fillColor: coul, fillOpacity: 1 }).bindPopup(`<b>${esc(x.auteur)}</b>${x.equipe ? ' · ' + esc(nomEquipe(x.equipe)) : ''}<br>${fmt(x.gisement, 1)}° ±${fmt(x.incertitude, 1)}° · ${heure(x.heure)}<br>${esc(x.source)}${x.force ? '<br>' + esc(x.force) : ''}`).addTo(couchesGonio);
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
  function rendreEquipes() {
    const v = $('#vue-equipes');
    couchesEquipes.clearLayers();
    const parEq = new Map([[null, []], ...E.equipes.map((e) => [e.id, []])]);
    for (const m of E.membres) (parEq.get(m.equipe) || parEq.get(null)).push(m);
    v.innerHTML = `<h2>Équipes</h2>${E.moi.admin ? '<div class="ligne-champs"><label>Nouvelle équipe <input id="eq-nom" placeholder="ex. Gonio 1"></label><button id="eq-creer">Créer</button></div>' : ''}
      ${E.equipes.map((e) => `<div class="entree"><div class="tete"><b><i class="equipe-pastille" style="background:${e.couleur}"></i>${esc(e.nom)}</b>${e.mission ? `<span>${esc(e.mission)}</span>` : ''}${E.moi.admin ? ` <button class="mini" data-mission="${e.id}">Mission</button> <button class="mini danger" data-suppr-eq="${e.id}">Supprimer</button>` : ''}</div>
        <div class="corps">${parEq.get(e.id).map((m) => `${esc(m.indicatif || m.nom)}${m.fonction ? ' (' + esc(m.fonction) + ')' : ''}${m.position ? ' 📍' : ''}`).join(', ') || '<span class="note">Aucun membre</span>'}</div></div>`).join('') || '<div class="vide">Aucune équipe : un administrateur les crée ici.</div>'}
      ${parEq.get(null).length ? `<h3>Sans équipe</h3><div class="corps">${parEq.get(null).map((m) => esc(m.indicatif || m.nom)).join(', ')}</div>` : ''}
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
    for (const b of v.querySelectorAll('[data-mission]')) b.onclick = async () => { const e = equipe(b.dataset.mission); const t = prompt('Mission de l’équipe ' + e.nom + ' :', e.mission || ''); if (t === null) return; await api('/api/adrasec/equipes/' + e.id, { method: 'PATCH', body: { mission: t } }).catch((x) => alert(x.message)); charger(); };
    for (const b of v.querySelectorAll('[data-suppr-eq]')) b.onclick = async () => { if (!confirm('Supprimer cette équipe ? Ses membres restent dans la section, sans équipe.')) return; await api('/api/adrasec/equipes/' + b.dataset.supprEq, { method: 'PATCH', body: { supprimer: true } }).catch((x) => alert(x.message)); charger(); };
  }

  // ---- Winlink --------------------------------------------------------------------------------------------------
  let boite = 'in';
  async function rendreWinlink() {
    const v = $('#vue-winlink');
    if (!E) return;
    if (!E.winlink.configure) {
      v.innerHTML = `<h2>Winlink</h2><div class="bandeau">Winlink n’est pas encore installé sur ce serveur.</div>
        <p class="note">La carte s’appuie sur <b>Pat</b>, client Winlink libre. Pour l’ajouter : dans le dossier de la carte, renseignez <span class="mono">PAT_URL=http://pat:8080</span> dans le fichier .env, lancez <span class="mono">docker compose --profile winlink up -d</span>, puis réglez l’indicatif et le mot de passe Winlink de la station dans Pat (voir le wiki, page « Section ADRASEC »). La carte ne voit jamais ce mot de passe.</p>
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

  // ---- Gestion (administrateurs) --------------------------------------------------------------------------------
  function rendreGestion() {
    const v = $('#vue-gestion');
    v.innerHTML = `<h2>Réglages de la section</h2>
      <div class="ligne-champs"><label style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="ge-actif" ${E.actif ? 'checked' : ''}> Section activée</label></div>
      <div class="ligne-champs"><label>Nom affiché <input id="ge-nom" value="${esc(E.nom)}" placeholder="ADRASEC 43"></label><label>Conservation (jours) <input id="ge-cons" type="number" min="7" max="3650" value="${E.conservationJours}"></label><button id="ge-ok">Enregistrer</button></div>
      <p class="note">Main courante et relevés plus anciens que la durée choisie sont effacés (données personnelles : indicatifs, positions).</p>
      <h2>Membres</h2>
      <p class="note">Une fiche par compte de la carte. Cochez <b>Membre</b> pour lui ouvrir la section, puis <b>Enregistrer</b>.</p>
      <datalist id="ge-noeuds"></datalist>
      ${E.comptes.map((c) => { const m = E.membres.find((x) => x.compte === c.id); return `<div class="fiche-membre" data-compte="${c.id}">
        <div class="tete-membre"><b>${esc(c.identifiant)}</b>${c.role === 'admin' ? ' <span class="pastille">admin</span>' : ''}
          <label class="case" title="Ouvre la section ADRASEC à ce compte"><input type="checkbox" class="ge-membre" ${m ? 'checked' : ''}> Membre</label>
          <label class="case" title="À cocher seulement après avoir vérifié le certificat d’opérateur radioamateur (ou l’autorisation ANFR). Ouvre la rédaction et les sessions Winlink."><input type="checkbox" class="ge-lic" ${m && m.licencie ? 'checked' : ''}> Licencié</label></div>
        <div class="ligne-champs">
          <label title="Indicatif radioamateur, ex. F4ABC. Obligatoire pour un licencié ; il signe la main courante et les messages Winlink.">Indicatif <input type="text" class="ge-ind mono" value="${esc((m && m.indicatif) || c.indicatif || '')}" placeholder="F4ABC"></label>
          <label title="Équipe d’intervention du membre (créées dans l’onglet Équipes)">Équipe <select class="ge-eq"><option value="">—</option>${E.equipes.map((e) => `<option value="${e.id}" ${m && m.equipe === e.id ? 'selected' : ''}>${esc(e.nom)}</option>`).join('')}</select></label>
        </div>
        <label title="Facultatif. Le module Meshtastic que ce membre emporte sur le terrain : sa position s’affiche en direct pour l’équipe, sert de position par défaut pour ses relevés, et ses messages « GONIO 125 » arrivent comme relevés. Commencez à taper son nom pour le choisir dans la liste des nœuds connus.">Nœud porté sur le terrain (facultatif) <input type="text" class="ge-noeud" list="ge-noeuds" value="${m && m.noeud ? '!' + (m.noeud >>> 0).toString(16).padStart(8, '0') + (m.nomNoeud ? ' · ' + esc(m.nomNoeud) : '') : ''}" placeholder="tapez le nom du nœud, ou !a1b2c3d4"></label>
        <div class="ligne-champs"><button class="ge-sauver principal">Enregistrer</button><span class="ge-retour note"></span></div>
      </div>`; }).join('')}<p class="erreur" id="ge-erreur"></p>`;
    $('#ge-ok').onclick = async () => { try { await api('/api/adrasec/reglages', { method: 'PUT', body: { actif: $('#ge-actif').checked, nom: $('#ge-nom').value, conservationJours: $('#ge-cons').value } }); location.reload(); } catch (e) { $('#ge-erreur').textContent = e.message; } };
    // Liste des nœuds Meshtastic connus, pour choisir le nœud porté par son nom
    api('/api/noeuds').then((l) => { const d = $('#ge-noeuds'); if (d) d.innerHTML = (Array.isArray(l) ? l : []).filter((n) => n.num != null).map((n) => `<option value="!${(n.num >>> 0).toString(16).padStart(8, '0')} · ${esc(n.nomLong || n.nomCourt || '')}">`).join(''); }).catch(() => {});
    for (const tr of v.querySelectorAll('.fiche-membre[data-compte]')) $('.ge-sauver', tr).onclick = async () => {
      $('#ge-erreur').textContent = '';
      // « !a1b2c3d4 · Nom » (choisi dans la liste), « !a1b2c3d4 » ou numéro décimal
      const n = $('.ge-noeud', tr).value.trim();
      const hex = /^!?([0-9a-f]{8})\b/i.exec(n);
      const noeud = !n ? null : hex ? parseInt(hex[1], 16) : /^\d+$/.test(n) ? Number(n) : NaN;
      if (Number.isNaN(noeud)) { $('#ge-erreur').textContent = 'Nœud : choisissez-le dans la liste en tapant son nom, ou saisissez son identifiant (!a1b2c3d4)'; return; }
      const membre = $('.ge-membre', tr).checked;
      try {
        await api('/api/adrasec/membres/' + tr.dataset.compte, { method: 'PUT', body: membre ? { membre: true, licencie: $('.ge-lic', tr).checked, indicatif: $('.ge-ind', tr).value, equipe: $('.ge-eq', tr).value || null, noeud } : { membre: false } });
        $('.ge-retour', tr).textContent = '✔ Enregistré'; charger();
      } catch (e) { $('#ge-erreur').textContent = e.message; }
    };
  }

  await charger();
  montrer(ongletActif);
  cadrerGonio();
  // Rafraîchissement : toutes les 15 s, sans perdre la saisie en cours
  setInterval(() => { const a = document.activeElement; if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return; charger(); }, 15000);
  window.adrasecEtat = () => E; // essais
})();
