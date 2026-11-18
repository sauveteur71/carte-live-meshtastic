'use strict';
// Lien terrain d'une recherche de balise (section ADRASEC) : carte en lecture seule pour les équipes, sans compte,
// mise à jour toutes les 15 s. Position estimée, ellipse, relèvements, équipes ; avec le GPS du téléphone, distance
// et cap à suivre jusqu'à la balise.
(async () => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 0) => Number(n).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const heure = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const jeton = location.pathname.split('/').pop();
  const wmts = (couche, format = 'image/png') => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${couche}&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${format}`;
  const ign = '&copy; <a href="https://www.ign.fr/" target="_blank" rel="noopener">IGN</a>';
  const carte = L.map('carte', { zoomControl: true }).setView([45.05, 3.9], 10);
  const fonds = {
    'Plan IGN': L.tileLayer(wmts('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2'), { maxZoom: 19, attribution: ign }).addTo(carte),
    'Photos aériennes': L.tileLayer(wmts('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg'), { maxZoom: 19, attribution: ign }),
    'Topographique': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, subdomains: 'abc', attribution: '&copy; OpenTopoMap (CC-BY-SA), OpenStreetMap' }),
  };
  L.control.layers(fonds, null, { position: 'topright' }).addTo(carte);
  L.control.scale({ imperial: false }).addTo(carte);
  const couche = L.layerGroup().addTo(carte), coucheMoi = L.layerGroup().addTo(carte);
  let V = null, moi = null, cadre = false;

  function dessiner() {
    couche.clearLayers();
    const c = V.calcul, est = c && c.estimation;
    for (const x of V.releves) {
      const coul = x.couleur || '#e0115f', longueur = Math.max(15000, est ? Gonio.distance(x, est) * 1.6 : 30000);
      const ecarte = c && c.ecartes.includes(x.id);
      L.polygon(Gonio.cone(x, longueur), { color: coul, weight: 1.5, fillColor: coul, fillOpacity: ecarte ? 0.05 : 0.2, interactive: false }).addTo(couche);
      const bout = Gonio.destination(x.lat, x.lon, x.gisement, longueur);
      L.polyline([[x.lat, x.lon], [bout.lat, bout.lon]], { color: '#0b1117', weight: 8, opacity: 0.55, interactive: false }).addTo(couche);
      L.polyline([[x.lat, x.lon], [bout.lat, bout.lon]], { color: coul, weight: 4, opacity: ecarte ? 0.5 : 1, dashArray: ecarte ? '10 8' : null, interactive: false }).addTo(couche);
      L.circleMarker([x.lat, x.lon], { radius: 8, color: '#fff', weight: 3, fillColor: coul, fillOpacity: 1 })
        .bindTooltip(`<b>${esc(x.equipe || 'Relevé')}</b> · ${fmt(x.gisement)}°${x.force ? ' · ' + esc(x.force) : ''} · ${heure(x.heure)}`, { permanent: true, direction: 'left', offset: [-10, 0], className: 'etq-releve' }).addTo(couche);
    }
    for (const e of V.equipes) for (const p of e.positions) L.circleMarker([p.lat, p.lon], { radius: 9, color: '#0b1117', weight: 2, fillColor: e.couleur, fillOpacity: 1 }).bindTooltip(esc(e.nom), { permanent: true, direction: 'right', offset: [9, 0], className: 'etq-releve' }).addTo(couche);
    if (est) {
      if (c.ellipse) L.polygon(Gonio.contourEllipse(est, c.ellipse.grandAxeM, c.ellipse.petitAxeM, c.ellipse.azimutGrandAxe), { color: '#ff5c6c', weight: 3, fillOpacity: 0.15 }).addTo(couche);
      L.marker([est.lat, est.lon], { icon: L.divIcon({ className: '', html: '<div style="font-size:30px;line-height:30px;filter:drop-shadow(0 0 3px #000)">🎯</div>', iconSize: [30, 30], iconAnchor: [15, 15] }) }).addTo(couche);
    }
    if (!cadre) { const l = couche.getLayers(); if (l.length) { carte.fitBounds(L.featureGroup(l).getBounds().pad(0.1), { maxZoom: 14 }); cadre = true; } }
  }
  function fiche() {
    const c = V.calcul, est = c && c.estimation;
    let guidage = '';
    if (est && moi) {
      const dist = Gonio.distance(moi, est), cap = Gonio.azimut(moi, est);
      guidage = `<div>Depuis vous : <span class="cap">${dist >= 1000 ? fmt(dist / 1000, 1) + ' km' : fmt(dist) + ' m'} au ${fmt(cap)}°</span> <span class="note">(nord vrai, GPS ±${fmt(moi.precision || 0)} m)</span></div>`;
    }
    $('#fiche').innerHTML = est
      ? `<div class="note">Position la plus probable · zone ±${fmt(c.ellipse.grandAxeM / 1000, 1)} km · ${c.utilises || c.nb} relevés</div>
        <div class="grand">${est.lat.toFixed(5)}, ${est.lon.toFixed(5)}</div>
        <div class="mono">${Gonio.versLocator(est.lat, est.lon, 8)}${window.DFCI ? ' · DFCI ' + esc(DFCI.versDfci(est.lat, est.lon) || '–') : ''}</div>${guidage}
        <div class="boutons"><button class="principal" id="b-balise">🎯 Centrer</button><button id="b-moi">📍 Ma position</button><a class="bouton" href="geo:${est.lat.toFixed(6)},${est.lon.toFixed(6)}?q=${est.lat.toFixed(6)},${est.lon.toFixed(6)}(Balise)">🧭 GPS du téléphone</a></div>`
      : `<div class="note">Pas encore de position estimée : il faut au moins deux relevés qui se croisent.</div>${guidage}<div class="boutons"><button id="b-moi">📍 Ma position</button></div>`;
    const bb = $('#b-balise'); if (bb) bb.onclick = () => carte.setView([est.lat, est.lon], 14);
    $('#b-moi').onclick = suivreMoi;
  }
  async function charger() {
    try {
      const r = await fetch('/api/terrain/' + encodeURIComponent(jeton), { cache: 'no-store' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erreur || 'Lien invalide');
      V = await r.json();
    } catch (e) {
      $('#sous-titre').innerHTML = `<span class="erreur">${esc(e.message)}</span>`;
      $('#fiche').innerHTML = '<div class="note">Ce lien ne montre plus rien : la recherche est terminée, ou le lien a été désactivé par le PC.</div>';
      couche.clearLayers();
      return;
    }
    document.title = 'Balise · ' + V.recherche.nom;
    $('#titre').textContent = `🎯 ${V.recherche.nom}`;
    $('#sous-titre').textContent = `${V.section} · ${V.recherche.frequence}${V.recherche.detail ? ' · ' + V.recherche.detail : ''} · mis à jour ${heure(Date.now())}`;
    dessiner(); fiche();
  }
  let suivi = null;
  function suivreMoi() {
    if (!navigator.geolocation) { alert('GPS indisponible sur ce téléphone'); return; }
    if (suivi != null) { if (moi) carte.setView([moi.lat, moi.lon], Math.max(carte.getZoom(), 14)); return; }
    suivi = navigator.geolocation.watchPosition((p) => {
      const premier = !moi;
      moi = { lat: p.coords.latitude, lon: p.coords.longitude, precision: p.coords.accuracy };
      coucheMoi.clearLayers();
      L.circle([moi.lat, moi.lon], { radius: moi.precision, color: '#4c9aff', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(coucheMoi);
      L.circleMarker([moi.lat, moi.lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#4c9aff', fillOpacity: 1 }).bindTooltip('Vous', { permanent: true, direction: 'top', offset: [0, -8], className: 'etq-releve' }).addTo(coucheMoi);
      if (premier) carte.setView([moi.lat, moi.lon], Math.max(carte.getZoom(), 13));
      if (V) fiche();
    }, (e) => alert('GPS : ' + e.message), { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }
  await charger();
  setInterval(charger, 15000);
})();
