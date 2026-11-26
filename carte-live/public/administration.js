/* Carte live Meshtastic — fonctions d'administration, chargées à la demande par app.js (chargerAdministration) */
'use strict';
// Écrans réservés aux membres et administrateurs : mise à jour, broker MQTT, passerelle, éditeur des réglages d'un nœud,
// modèles, firmware 2.8, comptes, journal, sauvegardes, réglages, relief de la France, registre des relais, nœuds à inviter.
// Ce fichier s'appuie sur les fonctions et l'état d'app.js ; il remplace les relais déclarés là-bas.

// ---- Mise à jour de la carte en un clic (administrateur) ---------------------------------------------------
async function ficheMaj() {
  $('#fiche').hidden = false; etat.selection = null;
  const z = $('#fiche-contenu');
  z.innerHTML = '<div class="vide">Vérification…</div>';
  let r;
  try { r = await api('/api/maj'); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  afficherVersion(r);
  const s = r.service || {};
  z.innerHTML = `<div class="fiche-maj"><h2>⬆️ Mise à jour de la carte</h2>
    <div class="grille"><div class="mesure"><span>Installée</span><b>v${esc(r.version)}</b></div><div class="mesure"><span>Dernière publiée</span><b>${r.derniere ? 'v' + esc(r.derniere) : '?'}</b></div></div>
    <p class="note">${r.majDisponible ? `Une nouvelle version est disponible : <a href="${esc(r.url)}" target="_blank" rel="noopener">voir les nouveautés</a>.` : 'La carte est à jour : rien à faire.'}</p>
    ${r.installe ? `
      ${r.taches ? `<div class="alerte attention">${r.taches} programmation(s) à distance en cours : la mise à jour les interromprait. Attendez leur fin.
        <button type="button" class="mini" id="maj-detail">Détail</button>
        <div id="maj-detail-liste" hidden>${(r.tachesDetail || []).map((t) => `<div class="tache-maj"><b>${esc(t.reseau)} · ${esc(t.nom)}</b> — ${esc(t.avancement)}, lancée ${ilYa(t.debut)} par ${esc(t.auteur || '?')}
          ${t.courant ? `<br>En ce moment : ${esc(t.courant)}` : ''}<br>Après une mise à jour forcée : <b>${esc(t.reprise)}</b></div>`).join('') || '<div class="note">Détail indisponible.</div>'}
          <p class="note">Si toutes reprennent toutes seules, vous pouvez forcer : elles continueront après le redémarrage (1 à 3 minutes). Sinon, attendez leur fin.</p></div></div>` : ''}
      ${s.enCours ? `<div class="alerte info-lecture">Mise à jour en cours : ${esc(s.message || '')}</div>` : s.phase === 'echec' || s.phase === 'retour' ? `<div class="alerte attention">Dernière tentative : ${esc(s.message || '')}</div>` : ''}
      <div class="actions-prop">${r.majDisponible || s.enCours ? `<button class="principal" id="maj-go" ${s.enCours ? 'disabled' : ''}>⬆️ Mettre à jour maintenant</button>` : '<button class="mini" id="maj-go" title="Retélécharge la même version : utile seulement si la carte fonctionne mal">↻ Réinstaller la version actuelle</button>'}${r.taches ? '<button id="maj-forcer" class="danger">Forcer quand même</button>' : ''}</div>
      <p class="note">La carte télécharge la nouvelle image, puis redémarre avec les mêmes réglages et les mêmes données (1 à 3 minutes, la page se recharge toute seule). Si la nouvelle version ne démarre pas, l’ancienne est remise en route.</p>`
    : `<div class="alerte attention">Le service de mise à jour n’est pas installé sur ce serveur (${esc(r.raison || '')}).</div>
      <p class="note">Pour mettre à jour en un clic, ajoutez le service <b>maj</b> à votre <code>docker-compose.yml</code> (voir le wiki, page Installation), puis <code>docker compose up -d</code> une dernière fois. En attendant : <code>docker compose pull && docker compose up -d</code>.</p>`}
    ${r.installe ? '<label class="case"><input type="checkbox" id="maj-auto"> Mettre à jour automatiquement la nuit, à <select id="maj-auto-h">' + [2, 3, 4, 5].map((h) => `<option value="${h}">${h} h</option>`).join('') + '</select></label><p class="note">Seulement si une nouvelle version est publiée et qu’aucune programmation à distance n’est en cours. En cas d’échec, l’ancienne version repart.</p>' : ''}
    <p class="erreur" id="maj-retour"></p></div>`;
  if (r.installe) api('/api/maj/auto').then((a) => {
    const c = $('#maj-auto'), h = $('#maj-auto-h'); if (!c) return;
    c.checked = !!a.actif; h.value = String(a.heure);
    c.onchange = h.onchange = async () => { try { await postJson('/api/maj/auto', { actif: c.checked, heure: Number(h.value) }); annonce(c.checked ? `✔ Mise à jour automatique à ${h.value} h` : 'Mise à jour automatique désactivée', 'ok'); } catch (x) { annonce('⚠ ' + x.message, 'erreur'); } };
  }).catch(() => {});
  const lancer = async (forcer) => {
    if (!(await confirmer('Mettre la carte à jour maintenant ? Elle sera indisponible 1 à 3 minutes.'))) return;
    try { await postJson('/api/maj', { forcer: !!forcer }); attendreMaj(r.version); } catch (e) { $('#maj-retour').textContent = e.message; }
  };
  const g = $('#maj-go'); if (g) g.onclick = () => lancer(false);
  const dt = $('#maj-detail'); if (dt) dt.onclick = () => { const l = $('#maj-detail-liste'); l.hidden = !l.hidden; dt.textContent = l.hidden ? 'Détail' : 'Masquer le détail'; };
  const f = $('#maj-forcer'); if (f) f.onclick = () => lancer(true);
}
// Attend que la carte revienne avec une autre version (ou la même si l'image n'avait pas changé)
async function attendreMaj(avant) {
  document.body.insertAdjacentHTML('beforeend', '<div class="voile-redemarrage"><div><b>Mise à jour en cours…</b><br><small id="maj-etape">téléchargement de la nouvelle version</small></div></div>');
  const t0 = Date.now();
  let coupe = false;
  while (Date.now() - t0 < 10 * 60000) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const v = await (await fetch('/api/version', { cache: 'no-store' })).json();
      if (coupe || v.version !== avant) { location.reload(); return; }
      try { const m = await (await fetch('/api/maj', { cache: 'no-store' })).json(); if (m.service) { const e = document.getElementById('maj-etape'); if (e) e.textContent = m.service.message || ''; if (!m.service.enCours && ['a-jour', 'echec', 'retour'].includes(m.service.phase)) { location.reload(); return; } } } catch { /* carte en redémarrage */ }
    } catch { coupe = true; const e = document.getElementById('maj-etape'); if (e) e.textContent = 'redémarrage de la carte…'; }
  }
  location.reload();
}

// ---- Modules Meshtastic Wi-Fi (admin) ---------------------------------------------------------
const REDIFFUSION_FR = {
  ALL: 'ALL · relaie tout (conseillé pour un relais)', ALL_SKIP_DECODING: 'ALL_SKIP_DECODING · relaie tout sans déchiffrer', LOCAL_ONLY: 'LOCAL_ONLY · seulement ses canaux',
  KNOWN_ONLY: 'KNOWN_ONLY · seulement les nœuds connus', NONE: 'NONE · ne relaie rien', CORE_PORTNUMS_ONLY: 'CORE_PORTNUMS_ONLY · types de base seulement',
};

// ---- Version de firmware : vrai si v ≥ min (« 2.7.26.54e0d8d » ≥ « 2.7.11 ») ----------------------------
function fwAuMoins(v, min) {
  const t = (x) => { const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(x || '')); return m ? [+m[1], +m[2], +m[3]] : null; };
  const a = t(v), b = t(min);
  if (!a || !b) return false;
  for (let k = 0; k < 3; k++) if (a[k] !== b[k]) return a[k] > b[k];
  return true;
}
const SIGNATURES_FR = {
  PACKET_SIGNATURE_POLICY_COMPATIBLE: 'Compatible (accepte les nœuds 2.7)',
  PACKET_SIGNATURE_POLICY_BALANCED: 'Équilibrée',
  PACKET_SIGNATURE_POLICY_STRICT: 'Stricte (signés seulement)',
};
const dureeCourte = (s) => (s == null ? '–' : s === 0 ? 'défaut' : s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);

// ---- Modèles de programmation : réglages types par usage, export / import YAML ----------------------------
function resumeModele(m) {
  const t = [];
  const d = m.device || {}, l = m.lora || {}, p = m.position || {}, v = m.voisinage || {}, te = m.telemetrie || {};
  if (d.role) t.push(`rôle ${d.role}`);
  if (d.rebroadcastMode) t.push(`rediffusion ${d.rebroadcastMode}`);
  if (d.nodeInfoBroadcastSecs != null) t.push(`fiche toutes les ${dureeCourte(d.nodeInfoBroadcastSecs)}`);
  if (l.hopLimit) t.push(`${l.hopLimit} sauts`);
  if (l.configOkToMqtt != null) t.push(`MQTT ${l.configOkToMqtt ? 'autorisé' : 'refusé'}`);
  if (l.sx126xRxBoostedGain) t.push('réception boostée');
  if (p.positionBroadcastSecs != null) t.push(`position ${p.positionBroadcastSmartEnabled ? 'intelligente, ' : ''}toutes les ${dureeCourte(p.positionBroadcastSecs)}`);
  if (v.enabled != null) t.push(v.enabled ? `voisinage ${dureeCourte(v.updateInterval)}${v.transmitOverLora ? ' sur LoRa' : ''}` : 'sans voisinage');
  if (te.deviceTelemetryEnabled != null || te.deviceUpdateInterval != null) t.push(te.deviceTelemetryEnabled === false ? 'sans télémétrie' : `télémétrie ${dureeCourte(te.deviceUpdateInterval)}`);
  if (m.favoris) t.push('favoris des routeurs voisins');
  return t.join(' · ');
}
async function ficheModeles(prerempli) {
  $('#fiche').hidden = false;
  etat.selection = null;
  const z = $('#fiche-contenu');
  z.dataset.tache = '';
  let r;
  try { r = await api('/api/admin-noeuds/modeles'); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  const sel = [...gestion.selection];
  z.innerHTML = `<h2>📋 Modèles de programmation</h2>
    <p class="note">Un modèle regroupe les réglages d’un usage (rôle, sauts, intervalles, voisinage, télémétrie). Il s’applique en une fois, nœud par nœud, avec relecture de contrôle. Les canaux et la radio (région, preset, slot) ne sont jamais touchés : utilisez la vérification de conformité pour eux.</p>
    ${sel.length ? `<div class="alerte info-lecture">${sel.length} nœud(s) coché(s) dans Programmer : ${esc(sel.slice(0, 6).map(nomNoeud).join(', '))}${sel.length > 6 ? '…' : ''}</div>` : '<div class="note">Cochez des nœuds dans Programmer pour pouvoir leur appliquer un modèle.</div>'}
    ${r.modeles.map((m) => `<div class="proposition modele" data-id="${esc(m.id)}">
      <div class="entete-prop"><b>${esc(m.nom)}</b><span class="marge">${m.integre ? 'intégré' : 'personnel' + (m.auteur ? ' · ' + esc(m.auteur) : '')}</span></div>
      ${m.description ? `<div class="meta-longue">${esc(m.description)}</div>` : ''}
      <div class="note">${esc(resumeModele(m))}</div>
      <div class="actions-prop">${sel.length ? `<button class="mini principal" data-appliquer="${esc(m.id)}">Appliquer à ${sel.length} nœud(s)</button>` : ''}${etat.admin ? `<button class="mini" data-copier-modele="${esc(m.id)}">${m.integre ? 'Copier pour l’adapter' : 'Modifier'}</button>${m.integre ? '' : `<button class="mini" data-suppr-modele="${esc(m.id)}">Supprimer</button>`}` : ''}</div>
    </div>`).join('')}
    ${etat.admin ? `<h3>Nouveau modèle</h3>
    <div class="actions-prop"><button id="mod-nouveau">Créer un modèle…</button><label class="bouton-lien">Importer un YAML (meshtastic --export-config)<input type="file" id="mod-fichier" accept=".yaml,.yml,text/yaml,text/plain" hidden></label></div>
    <div id="mod-edition"></div>` : ''}
    <p class="erreur" id="mod-retour"></p>
    <p class="note">Export : dans l’éditeur d’un nœud (✏️ Modifier ses réglages), « ⬇ YAML » donne sa configuration au format de l’outil officiel, à appliquer en USB avec <span class="mono">meshtastic --configure fichier.yaml</span> (pratique pour préparer un relais de remplacement avant de monter au point haut).</p>`;
  z.querySelectorAll('[data-appliquer]').forEach((b) => (b.onclick = async () => {
    const m = r.modeles.find((x) => x.id === b.dataset.appliquer);
    if (!(await confirmer(`Appliquer « ${m.nom} » à ${sel.length} nœud(s) ?\n${resumeModele(m)}\n\nLes nœuds enregistrent puis redémarrent si besoin ; comptez 1 à 3 min par nœud.`))) return;
    try {
      const x = await postJson(`/api/admin-noeuds/modeles/${encodeURIComponent(m.id)}/appliquer`, { cibles: sel });
      $('#mod-retour').textContent = `${x.taches.length} opération(s) lancée(s)${x.favoris ? ' + pose des favoris' : ''} : suivez-les dans Programmer › Opérations récentes.`;
      if (typeof rendreGestion === 'function') { rendreGestion(); suivreTaches(); }
    } catch (e) { $('#mod-retour').textContent = e.message; }
  }));
  z.querySelectorAll('[data-copier-modele]').forEach((b) => (b.onclick = () => {
    const m = r.modeles.find((x) => x.id === b.dataset.copierModele);
    editerModele(m.integre ? { ...m, id: null, nom: m.nom + ' (copie)' } : m);
  }));
  z.querySelectorAll('[data-suppr-modele]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmer('Supprimer ce modèle ?'))) return;
    try { await api('/api/admin-noeuds/modeles/' + encodeURIComponent(b.dataset.supprModele), { method: 'DELETE' }); ficheModeles(); } catch (e) { $('#mod-retour').textContent = e.message; }
  }));
  const bn = $('#mod-nouveau');
  if (bn) bn.onclick = () => editerModele({ nom: '', device: {}, lora: {}, position: {}, voisinage: {}, telemetrie: {} });
  const fi = $('#mod-fichier');
  if (fi) fi.onchange = async () => {
    const f = fi.files[0];
    if (!f) return;
    try {
      const x = await api('/api/admin-noeuds/modeles/import', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: await f.text() });
      editerModele({ nom: x.nom, ...x.reglages }, x.ignores.length ? `Ignorés (propres à un nœud) : ${x.ignores.join(', ')}. Seuls les réglages d’usage sont repris.` : '');
    } catch (e) { $('#mod-retour').textContent = e.message; }
    fi.value = '';
  };
  if (prerempli) editerModele(prerempli);
}
function editerModele(m, note = '') {
  const zone = $('#mod-edition');
  if (!zone) return;
  const d = m.device || {}, l = m.lora || {}, p = m.position || {}, v = m.voisinage || {}, t = m.telemetrie || {};
  const i = gestion.info || {};
  const opt = (liste, val, fr = {}) => `<option value="">inchangé</option>` + liste.map((x) => `<option value="${x}" ${String(x) === String(val ?? '') ? 'selected' : ''}>${esc(fr[x] || x)}</option>`).join('');
  const oui = (val) => `<option value="">inchangé</option><option value="1" ${val === true ? 'selected' : ''}>oui</option><option value="0" ${val === false ? 'selected' : ''}>non</option>`;
  const dur = (liste, val) => `<option value="">inchangé</option>` + liste.map(([s, txt]) => `<option value="${s}" ${val === s ? 'selected' : ''}>${txt}</option>`).join('') + (val != null && !liste.some(([s]) => s === val) ? `<option value="${val}" selected>${dureeCourte(val)}</option>` : '');
  zone.innerHTML = `<form id="f-modele" class="form-edit">
    ${note ? `<div class="note">${esc(note)}</div>` : ''}
    <div class="grille-edit"><label>Nom <input name="nom" maxlength="60" required value="${esc(m.nom || '')}"></label>
      <label>Description <input name="description" maxlength="300" value="${esc(m.description || '')}"></label></div>
    <h4>Appareil</h4><div class="grille-edit">
      <label>Rôle <select name="role">${opt(i.roles || ['CLIENT', 'CLIENT_BASE', 'ROUTER', 'ROUTER_LATE'], d.role, ROLES_FR_ADMIN)}</select></label>
      <label>Rediffusion <select name="rebroadcastMode">${opt(i.rediffusions || ['ALL'], d.rebroadcastMode, REDIFFUSION_FR)}</select></label>
      <label>Fiche (NodeInfo) <select name="nodeInfoBroadcastSecs">${dur([[3600, '1 h'], [10800, '3 h'], [21600, '6 h'], [43200, '12 h'], [86400, '24 h']], d.nodeInfoBroadcastSecs)}</select></label></div>
    <h4>LoRa (sans toucher à la fréquence ni au preset)</h4><div class="grille-edit">
      <label>Sauts <select name="hopLimit">${opt([1, 2, 3, 4, 5, 6, 7], l.hopLimit)}</select></label>
      <label>Autoriser MQTT <select name="configOkToMqtt">${oui(l.configOkToMqtt)}</select></label>
      <label>Réception boostée <select name="sx126xRxBoostedGain">${oui(l.sx126xRxBoostedGain)}</select></label></div>
    <h4>Position</h4><div class="grille-edit">
      <label>Toutes les <select name="positionBroadcastSecs">${dur([[900, '15 min'], [1800, '30 min'], [3600, '1 h'], [10800, '3 h'], [21600, '6 h'], [43200, '12 h'], [86400, '24 h']], p.positionBroadcastSecs)}</select></label>
      <label>Position intelligente <select name="positionBroadcastSmartEnabled">${oui(p.positionBroadcastSmartEnabled)}</select></label></div>
    <h4>Voisinage et télémétrie</h4><div class="grille-edit">
      <label>Voisinage <select name="voisinage"><option value="">inchangé</option><option value="off" ${v.enabled === false ? 'selected' : ''}>désactivé</option>${[[21600, true, 'toutes les 6 h, sur LoRa'], [43200, true, 'toutes les 12 h, sur LoRa'], [14400, false, 'toutes les 4 h, sans LoRa (passerelle MQTT)'], [21600, false, 'toutes les 6 h, sans LoRa']].map(([s, lo, txt]) => `<option value="${s}-${lo ? 1 : 0}" ${v.enabled && v.updateInterval === s && !!v.transmitOverLora === lo ? 'selected' : ''}>${txt}</option>`).join('')}</select></label>
      <label>Télémétrie <select name="telemetrie"><option value="">inchangé</option><option value="off" ${t.deviceTelemetryEnabled === false ? 'selected' : ''}>désactivée</option>${[[1800, '30 min'], [3600, '1 h'], [10800, '3 h']].map(([s, txt]) => `<option value="${s}" ${t.deviceTelemetryEnabled !== false && t.deviceUpdateInterval === s ? 'selected' : ''}>toutes les ${txt}</option>`).join('')}</select></label>
      <label class="case"><input type="checkbox" name="favoris" ${m.favoris ? 'checked' : ''}> Poser aussi les favoris des routeurs voisins</label></div>
    <div class="actions-prop"><button type="submit" class="principal">Enregistrer le modèle</button><button type="button" id="mod-annuler">Annuler</button></div>
  </form>`;
  $('#mod-annuler').onclick = () => (zone.innerHTML = '');
  $('#f-modele').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, vv = (n) => f.elements[n].value, num = (n) => (vv(n) === '' ? undefined : Number(vv(n))), bool = (n) => (vv(n) === '' ? undefined : vv(n) === '1');
    const corps = {
      id: m.id || undefined, nom: vv('nom'), description: vv('description'), favoris: f.favoris.checked,
      device: { role: vv('role') || undefined, rebroadcastMode: vv('rebroadcastMode') || undefined, nodeInfoBroadcastSecs: num('nodeInfoBroadcastSecs') },
      lora: { hopLimit: num('hopLimit'), configOkToMqtt: bool('configOkToMqtt'), sx126xRxBoostedGain: bool('sx126xRxBoostedGain') },
      position: { positionBroadcastSecs: num('positionBroadcastSecs'), positionBroadcastSmartEnabled: bool('positionBroadcastSmartEnabled') },
    };
    if (vv('voisinage') === 'off') corps.voisinage = { enabled: false };
    else if (vv('voisinage')) { const [s, lo] = vv('voisinage').split('-'); corps.voisinage = { enabled: true, updateInterval: Number(s), transmitOverLora: lo === '1' }; }
    if (vv('telemetrie') === 'off') corps.telemetrie = { deviceTelemetryEnabled: false };
    else if (vv('telemetrie')) corps.telemetrie = { deviceTelemetryEnabled: true, deviceUpdateInterval: Number(vv('telemetrie')) };
    try { await postJson('/api/admin-noeuds/modeles', corps); ficheModeles(); } catch (err) { $('#mod-retour').textContent = err.message; }
  };
  zone.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---- Firmware 2.8 : préparation, nœuds renumérotés, clés en double -------------------------------------------
async function ficheV28() {
  $('#fiche').hidden = false;
  etat.selection = null;
  const z = $('#fiche-contenu');
  z.dataset.tache = '';
  z.innerHTML = '<div class="vide">Analyse…</div>';
  let r;
  try { r = await api('/api/admin-noeuds/v28'); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  const ligneN = (x) => `<b>${esc(x.nom)}</b> <small class="mono">${esc(x.id)}</small>`;
  z.innerHTML = `<h2>Firmware 2.8</h2>
    <div class="alerte attention">La 2.8.1 est encore une version de test (alpha) ; la 2.8.0 a été retirée. Meshtastic conseille d’attendre pour la plupart des nœuds. Les nœuds 2.7 et 2.8 continuent de se parler.</div>
    <p class="note"><b>Ce qui change à la mise à jour :</b> le <b>numéro du nœud change</b> (calculé à partir de sa clé) ; <b>position et télémétrie sont coupées</b> sur les canaux publics ; les noms longs sont limités à 24 octets ; il faut souvent reconfigurer (système de fichiers modifié). <b>Avant de mettre à jour un relais</b> : exportez sa configuration (éditeur › ⬇ YAML + canaux) pour pouvoir la remettre en USB.</p>
    <div class="grille"><div class="mesure"><span>Relais en 2.7</span><b>${r.n27}</b></div><div class="mesure"><span>Relais en 2.8</span><b>${r.n28}</b></div></div>
    ${r.noeuds.length ? `<h3>Relais déjà en 2.8</h3>${r.noeuds.map((x) => `<div class="proposition"><div class="entete-prop"><b>${esc(x.nom)}</b><span class="marge">${esc(x.firmware || '')}</span></div>${x.problemes.length ? x.problemes.map((p) => `<div class="meta-longue" style="color:var(--${p.niveau === 'critique' ? 'critique' : 'attention'})">⚠ ${esc(p.texte)}</div>`).join('') : '<div class="note">✔ rien à signaler</div>'}<div class="actions-prop"><button class="mini" data-editer="${x.num}">✏️ Modifier ses réglages</button></div></div>`).join('')}` : ''}
    <h3>Nœuds renumérotés</h3>
    ${r.renumerotations.length ? r.renumerotations.map((x) => `<div class="proposition"><div>${ligneN(x.ancien)} → ${ligneN(x.nouveau)}</div>
      <div class="note">Même clé publique${x.certain ? ' ; le nouveau numéro découle de cette clé (règle 2.8) : renumérotation certaine' : ''}. Ancien numéro vu pour la dernière fois ${ilYa(x.ancien.dernierVu)} ; nouveau apparu ${ilYa(x.nouveau.premierVu)}${x.nouveau.firmware ? ' (' + esc(x.nouveau.firmware) + ')' : ''}.</div>
      ${etat.admin ? `<div class="actions-prop"><button class="mini principal" data-fusion="${x.ancien.num}:${x.nouveau.num}">Fusionner l’historique</button></div>` : ''}</div>`).join('') : '<div class="vide">Aucun : la carte repère un nœud renuméroté grâce à sa clé publique (fiche NodeInfo) dès qu’elle a reçu la fiche de l’ancien et du nouveau numéro.</div>'}
    ${(r.probables || []).length ? `<h3>Nœuds probablement réinitialisés</h3>${r.probables.map((x) => `<div class="proposition"><div>${ligneN(x.ancien)} → ${ligneN(x.nouveau)}</div>
      <div class="note">${esc(x.raison)}${x.nouveau.materiel ? ' · ' + esc(x.nouveau.materiel) : ''}. Ancien vu pour la dernière fois ${ilYa(x.ancien.dernierVu)} ; nouveau apparu ${ilYa(x.nouveau.premierVu)}. Les clés diffèrent : vérifiez que c’est bien le même appareil avant de fusionner.</div>
      ${etat.admin ? `<div class="actions-prop"><button class="mini" data-fusion="${x.ancien.num}:${x.nouveau.num}" data-force="1">Fusionner quand même</button></div>` : ''}</div>`).join('')}` : ''}
    <p class="note">La fusion rattache au nouveau numéro l’historique de l’ancien (positions, télémétrie, paquets, liaisons, traceroutes), sa fiche d’installation, son état d’administration, ses favoris, ses équipes, son responsable et les secteurs des gestionnaires. L’ancien numéro disparaît de la carte. Les 20 dernières fusions peuvent être annulées.</p>
    ${r.doublons.length ? `<h3>Clés publiques en double</h3>${r.doublons.map((x) => `<div class="proposition"><div>${ligneN(x.ancien)} et ${ligneN(x.nouveau)}</div><div class="meta-longue" style="color:var(--attention)">Les deux sont actifs avec la même clé (configuration clonée, ${x.chevauchementH} h en même temps) : les messages directs et l’administration à distance peuvent partir vers le mauvais. Régénérez la clé de l’un des deux (appli › Sécurité › Régénérer la clé privée), puis remettez la clé d’administration.</div></div>`).join('')}` : ''}
    ${r.historique.length ? `<h3>Fusions faites</h3>${r.historique.map((h) => `<div class="note">${new Date(h.heure).toLocaleString('fr-FR')} · ${esc(h.nom || '')} ${esc(h.idAncien)} → ${esc(h.idNouveau)} par ${esc(h.par || '?')}${h.force ? ' · forcée' : ''}${h.annule ? ` · <b>annulée</b> le ${new Date(h.annule.heure).toLocaleString('fr-FR')}` : ''}${h.annulable && etat.admin ? ` <button class="mini" data-annuler="${h.heure}:${h.ancien}:${h.nouveau}">↩ Annuler</button>` : ''}</div>`).join('')}` : ''}
    <p class="erreur" id="v28-retour"></p>`;
  z.querySelectorAll('[data-editer]').forEach((b) => (b.onclick = () => editeurReglages(Number(b.dataset.editer))));
  z.querySelectorAll('[data-fusion]').forEach((b) => (b.onclick = async () => {
    const [a, n] = b.dataset.fusion.split(':').map(Number);
    const force = b.dataset.force === '1';
    if (!(await confirmer(`Fusionner ${nomNoeud(a)} dans ${nomNoeud(n)} ? L’historique de l’ancien numéro passe au nouveau${force ? ' alors que leurs clés diffèrent' : ''}. Vous pourrez annuler la fusion tant que l’ancien numéro n’est pas réentendu.`))) return;
    try {
      const h = await postJson('/api/admin-noeuds/fusion', { ancien: a, nouveau: n, force });
      $('#v28-retour').textContent = `Fusionné : ${Object.entries(h.lignes).map(([k, v]) => `${v} ${k}`).join(', ')}.`;
      setTimeout(ficheV28, 1500);
      chargerNoeuds(true).catch(() => {});
    } catch (e) { $('#v28-retour').textContent = e.message; }
  }));
  z.querySelectorAll('[data-annuler]').forEach((b) => (b.onclick = async () => {
    const [heure, a, n] = b.dataset.annuler.split(':').map(Number);
    if (!(await confirmer('Annuler cette fusion ? L’ancien numéro revient sur la carte avec l’historique qu’il avait au moment de la fusion.'))) return;
    try {
      const h = await postJson('/api/admin-noeuds/fusion/annuler', { heure, ancien: a, nouveau: n });
      $('#v28-retour').textContent = `Fusion annulée : ${h.annule.lignes} lignes rendues à ${h.idAncien}.`;
      setTimeout(ficheV28, 1500);
      chargerNoeuds(true).catch(() => {});
    } catch (e) { $('#v28-retour').textContent = e.message; }
  }));
}
async function lancerTache(type, params, cibles = [...gestion.selection]) {
  const zone = $('#retour-action');
  try {
    const ins = $('#insister-action');
    const t = await postJson('/api/admin-noeuds/taches', { type, cibles, params, insister: !!(ins && ins.checked) });
    if ((type === 'lire' || type === 'verifier') && t && t.id) { gestion.lectureSuivie = t.id; voirTache(t.id); }
    if (zone) zone.textContent = 'Opération lancée : suivez-la ci-dessous.';
    const i = await api('/api/admin-noeuds');
    $('#taches-gestion').innerHTML = rendreTaches(i.taches);
    brancherArrets();
    suivreTaches();
  } catch (e) { if (zone) zone.textContent = e.message; else alert(e.message); }
}
async function formulaireAction(act) {
  const f = $('#form-action');
  const num = [...gestion.selection][0];
  const n = etat.noeuds.get(num);
  const pied = '<label class="case-insister" title="Pour un nœud mobile, lointain ou souvent occupé : les nœuds en échec sont repris automatiquement"><input type="checkbox" id="insister-action"> Insister en cas d’échec : nouvel essai toutes les 10 min pendant 2 h</label><p class="erreur" id="retour-action"></p>';
  if (act === 'editer') { f.innerHTML = pied; editeurReglages(num); return; }
  if (act === 'lire') {
    let l = null;
    try { l = await api('/api/admin-noeuds/lecture/' + num); } catch { /* ignore */ }
    if (l && !l.aucune && !l.complete) {
      f.innerHTML = `<div class="alerte attention">Lecture précédente incomplète (${ilYa(l.heure)}).<br>
        Déjà lu : ${esc(l.faites.join(', ') || 'rien')}${l.nbCanaux ? ` + ${l.nbCanaux} canal(aux)` : ''}.<br>Manque : <b>${esc(l.manquantes.join(', '))}</b>.</div>
        <div class="actions-prop"><button id="lire-reprendre" class="principal">Reprendre (seulement ce qui manque)</button><button id="lire-tout">Tout relire</button></div>${pied}`;
      $('#lire-reprendre').onclick = () => lancerTache('lire', { reprendre: true });
      $('#lire-tout').onclick = () => lancerTache('lire', {});
      return;
    }
    // Lecture ciblée : seulement les éléments cochés (bien plus rapide qu'une lecture complète)
    const SECTIONS = [['device', 'Rôle et rediffusion'], ['lora', 'Radio LoRa (preset, sauts, fréquence, puissance)'], ['canaux', 'Canaux'], ['position', 'Position et intervalle'],
      ['proprietaire', 'Nom'], ['materiel', 'Matériel et firmware'], ['telemetrie', 'Télémétrie'], ['voisinage', 'Module Voisinage'], ['securite', 'Sécurité (clés d’admin)'], ['trafic', 'Gestion du trafic (2.8)']];
    const deja = l && !l.aucune ? `<p class="note">Dernière lecture ${ilYa(l.heure)}${l.faites && l.faites.length ? ` : ${esc(l.faites.join(', '))}` : ''}.</p>` : '';
    f.innerHTML = `<form id="f-lire" class="form-gestion">
      <p class="note">Cochez seulement ce que vous voulez vérifier : chaque élément est une demande radio (10 à 60 s selon la distance). Une lecture complète en fait une quinzaine.</p>
      ${deja}
      <div class="sections-lire">${SECTIONS.map(([k, t]) => `<label class="case"><input type="checkbox" name="s" value="${k}"> ${esc(t)}</label>`).join('')}</div>
      <div class="actions-prop"><button type="submit" class="principal">Lire la sélection</button><button type="button" id="lire-tout">Tout lire</button></div>
    </form>${pied}`;
    $('#lire-tout').onclick = () => lancerTache('lire', {});
    $('#f-lire').onsubmit = (e) => {
      e.preventDefault();
      const sections = [...e.target.querySelectorAll('[name=s]:checked')].map((x) => x.value);
      if (!sections.length) { $('#retour-action').textContent = 'Cochez au moins un élément (ou « Tout lire »).'; return; }
      lancerTache('lire', { sections });
    };
    return;
  }
  if (act === 'echanger') { f.innerHTML = pied; lancerTache('echanger', {}); return; }
  if (act === 'modele') { f.innerHTML = pied; ficheModeles(); return; }
  if (act === 'firmware') {
    f.innerHTML = '<div class="vide">Recherche des versions…</div>';
    let r;
    try { r = await api('/api/admin-noeuds/firmware'); } catch (e) { f.innerHTML = `<div class="vide">${esc(e.message)}</div>${pied}`; return; }
    const m = r.module || {};
    const v = (x) => (x ? x.tag.replace(/^v/, '') : null);
    const options = [r.stable ? [v(r.stable), `${v(r.stable)} · stable (${new Date(r.stable.date).toLocaleDateString('fr-FR')})`] : null, r.test && r.test.tag !== (r.stable || {}).tag ? [v(r.test), `${v(r.test)} · test / bêta (${new Date(r.test.date).toLocaleDateString('fr-FR')})`] : null].filter(Boolean);
    const aJour = m.firmware && r.stable && String(m.firmware).startsWith(v(r.stable));
    f.innerHTML = `<form id="f-act" class="form-gestion">
      <p><b>${esc(m.nom || '')}</b> · ${esc(m.materiel || '?')} · firmware actuel <b>${esc(m.firmware || 'inconnu')}</b>${aJour ? ' <span class="badge actif">à jour (stable)</span>' : r.stable ? ` <span class="badge attente">${esc(v(r.stable))} disponible</span>` : ''}</p>
      ${!m.ip ? '<div class="alerte attention">Ce module est relié par un agent ou en USB : la mise à jour par Wi-Fi n’est possible que pour un module joignable en IP depuis le NAS (même réseau local).</div>' : ''}
      <label>Version à installer <select name="version">${options.map(([val, lib]) => `<option value="${esc(val)}">${esc(lib)}</option>`).join('')}</select></label>
      <div class="alerte attention">Mise à jour par le Wi-Fi (ESP32, firmware 2.7.18 ou plus récent) : le module redémarre sur son chargeur, reçoit le firmware (≈ 2 Mo), le vérifie puis redémarre. Comptez 2 à 4 minutes, pendant lesquelles la carte ne reçoit plus rien de ce module. Les réglages sont conservés. Une version « test » peut contenir des défauts.</div>
      <label>Pour confirmer, tapez <b>METTRE A JOUR</b> <input name="confirmation" autocomplete="off" placeholder="METTRE A JOUR"></label>
      <div class="actions-prop"><button type="submit" class="principal" ${!m.ip || !options.length ? 'disabled' : ''}>Mettre à jour</button></div>
    </form>${pied}`;
    $('#f-act').onsubmit = (e) => {
      e.preventDefault();
      if (e.target.confirmation.value.trim().toUpperCase() !== 'METTRE A JOUR') { alert('Tapez METTRE A JOUR pour confirmer'); return; }
      lancerTache('firmware', { version: e.target.version.value });
    };
    return;
  }
  if (act === 'redemarrer') {
    f.innerHTML = `<p>Redémarrer ${gestion.selection.size} nœud(s) ?</p><div class="actions-prop"><button id="ok-action" class="principal">Redémarrer</button></div>${pied}`;
    $('#ok-action').onclick = () => lancerTache('redemarrer', {});
    return;
  }
  if (act === 'canal') {
    f.innerHTML = `<form id="f-act" class="form-gestion">
      <label>Emplacement <select name="index"><option value="0">Canal 0 · principal ⚠️</option>${[1, 2, 3, 4, 5, 6, 7].map((k) => `<option value="${k}" ${k === 1 ? 'selected' : ''}>Canal ${k}</option>`).join('')}</select></label>
      <div class="garde-principal" hidden>
        <div class="alerte attention"><b>Canal principal :</b> le nœud y envoie sa fiche, sa position et sa télémétrie. Garde-fous appliqués à chaque nœud :
          relecture de son réglage LoRa (refus si sa fréquence dépend du nom du canal 0), écriture, puis relecture 20 s après pour vérifier qu’il répond toujours.
          Compter 1 à 2 minutes par nœud.</div>
        <label>Pour confirmer, tapez <b>CANAL 0</b> <input name="confirmation" autocomplete="off" placeholder="CANAL 0"></label>
      </div>
      <label>Nom (11 car. max) <input name="nom" maxlength="11" required></label>
      <label>Clé <select name="typeCle"><option value="defaut">Clé publique par défaut (AQ==)</option><option value="aleatoire">Nouvelle clé aléatoire (AES-256)</option><option value="saisie">Saisir une clé base64…</option></select></label>
      <label class="cle-saisie" hidden>Clé base64 <input name="psk" placeholder="ex. 1PG7OiApB1nwvP+rz05pAQ=="></label>
      <label>Précision de la position sur ce canal <select name="precision">
        ${[[32, 'précise'], [19, '≈ 45 m'], [18, '≈ 91 m'], [17, '≈ 182 m'], [16, '≈ 364 m'], [15, '≈ 729 m'], [14, '≈ 1,5 km'], [13, '≈ 2,9 km'], [0, 'pas de position']].map(([v, t]) => `<option value="${v}" ${v === 17 ? 'selected' : ''}>${t}${v && v < 32 ? ` (${v} bits)` : ''}</option>`).join('')}</select></label>
      <label class="case"><input type="checkbox" name="montant"> Envoi vers MQTT (montant)</label>
      <label class="case"><input type="checkbox" name="descendant"> Réception depuis MQTT (descendant)</label>
      <div class="actions-prop"><button type="submit" class="principal">Appliquer à ${gestion.selection.size} nœud(s)</button><button type="button" id="suppr-canal">Supprimer ce canal</button></div>
      <p class="note">Pour un canal privé partagé, choisissez « Nouvelle clé » une fois puis réutilisez la même clé (affichée ici après application) sur les autres nœuds et votre module.</p>
      ${pied}</form>`;
    const fo = $('#f-act');
    fo.typeCle.onchange = () => (fo.querySelector('.cle-saisie').hidden = fo.typeCle.value !== 'saisie');
    const majPrincipal = () => {
      const p = fo.index.value === '0';
      fo.querySelector('.garde-principal').hidden = !p;
      $('#suppr-canal').hidden = p;
    };
    fo.index.onchange = majPrincipal;
    fo.onsubmit = async (e) => {
      e.preventDefault();
      let psk = 'AQ==';
      if (fo.typeCle.value === 'aleatoire') { const b = new Uint8Array(32); crypto.getRandomValues(b); psk = btoa(String.fromCharCode(...b)); }
      if (fo.typeCle.value === 'saisie') psk = fo.psk.value.trim();
      if (!/^[A-Za-z0-9+/=]{2,64}$/.test(psk)) { $('#retour-action').textContent = 'Clé invalide'; return; }
      fo.typeCle.value = 'saisie'; fo.psk.value = psk; fo.querySelector('.cle-saisie').hidden = false; // garde la clé pour les autres nœuds
      const index = Number(fo.index.value);
      if (index === 0) {
        if (fo.confirmation.value.trim().toUpperCase() !== 'CANAL 0') { $('#retour-action').textContent = 'Tapez « CANAL 0 » pour confirmer le changement du canal principal'; fo.confirmation.focus(); return; }
        if (!(await confirmer(`Changer le canal PRINCIPAL en « ${fo.nom.value} » sur ${gestion.selection.size} nœud(s) ?`))) return;
      }
      lancerTache('canal', { index, nom: fo.nom.value, psk, precision: Number(fo.precision.value), montant: fo.montant.checked, descendant: fo.descendant.checked, role: index === 0 ? 'PRIMARY' : 'SECONDARY', confirmation: index === 0 ? 'CANAL 0' : undefined });
      if (index === 0) fo.confirmation.value = '';
    };
    $('#suppr-canal').onclick = async () => { if ((await confirmer(`Supprimer le canal ${fo.index.value} sur ${gestion.selection.size} nœud(s) ?`))) lancerTache('canal', { index: Number(fo.index.value), role: 'DISABLED' }); };
    return;
  }
  if (act === 'config') {
    const i = gestion.info;
    f.innerHTML = `<form id="f-act" class="form-gestion">
      <p class="note">Laissez « inchangé » ce que vous ne voulez pas modifier. Le nœud redémarre après une modification de rôle ou de LoRa.</p>
      <label>Rôle <select name="role"><option value="">inchangé</option>${i.roles.map((r) => `<option value="${r}">${ROLES_FR_ADMIN[r] || r}</option>`).join('')}</select></label>
      <label>Rediffusion (rebroadcast) <select name="rebroadcastMode"><option value="">inchangé</option>${(i.rediffusions || []).map((r) => `<option value="${r}">${REDIFFUSION_FR[r] || r}</option>`).join('')}</select></label>
      <label>Nombre de sauts (hop limit) <select name="hopLimit"><option value="">inchangé</option>${[1, 2, 3, 4, 5, 6, 7].map((k) => `<option value="${k}">${k}${k === 3 ? ' (conseillé)' : ''}</option>`).join('')}</select></label>
      <label>Intervalle des positions (s) <input name="positionBroadcastSecs" type="number" min="0" placeholder="inchangé"></label>
      <label>Intervalle des infos nœud (s) <input name="nodeInfoBroadcastSecs" type="number" min="0" placeholder="inchangé"></label>
      <label>Module Voisinage (NeighborInfo) <select name="voisinage"><option value="">inchangé</option><option value="lora-21600">activé, toutes les 6 h, aussi sur LoRa (conseillé pour les relais)</option><option value="lora-43200">activé, toutes les 12 h, aussi sur LoRa</option><option value="mqtt-14400">activé, toutes les 4 h, sans LoRa (passerelles MQTT)</option><option value="off">désactivé</option></select></label>
      <div class="actions-prop"><button type="submit" class="principal">Appliquer à ${gestion.selection.size} nœud(s)</button></div>${pied}</form>`;
    $('#f-act').onsubmit = async (e) => {
      e.preventDefault();
      const fo = e.target;
      const ops = [];
      const dev = {}; if (fo.role.value) dev.role = fo.role.value; if (fo.rebroadcastMode.value) dev.rebroadcastMode = fo.rebroadcastMode.value; if (fo.nodeInfoBroadcastSecs.value) dev.nodeInfoBroadcastSecs = Number(fo.nodeInfoBroadcastSecs.value);
      if (Object.keys(dev).length) ops.push({ section: 'device', valeurs: dev });
      if (fo.hopLimit.value) ops.push({ section: 'lora', valeurs: { hopLimit: Number(fo.hopLimit.value) } });
      if (fo.positionBroadcastSecs.value) ops.push({ section: 'position', valeurs: { positionBroadcastSecs: Number(fo.positionBroadcastSecs.value) } });
      if (fo.voisinage.value) {
        const [mode, iv] = fo.voisinage.value.split('-');
        ops.push({ section: 'voisinage', valeurs: mode === 'off' ? { enabled: false } : { enabled: true, updateInterval: Number(iv), transmitOverLora: mode === 'lora' } });
      }
      if (!ops.length) { $('#retour-action').textContent = 'Rien à modifier'; return; }
      for (const o of ops) await lancerTache('config', o);
    };
    return;
  }
  if (act === 'nom') {
    f.innerHTML = `<form id="f-act" class="form-gestion">
      <label>Nom long <input name="nomLong" maxlength="39" value="${esc(n ? n.nomLong || '' : '')}"></label>
      <label>Nom court (4 car.) <input name="nomCourt" maxlength="4" value="${esc(n ? n.nomCourt || '' : '')}"></label>
      <div class="actions-prop"><button type="submit" class="principal">Renommer</button></div>${pied}</form>`;
    $('#f-act').onsubmit = (e) => { e.preventDefault(); lancerTache('nom', { nomLong: e.target.nomLong.value, nomCourt: e.target.nomCourt.value }); };
    return;
  }
  if (act === 'position') {
    f.innerHTML = `<form id="f-act" class="form-gestion">
      <div class="grille-2"><label>Latitude <input data-notion="latitude" name="lat" required value="${n && n.lat != null ? n.lat.toFixed(6) : ''}"></label><label>Longitude <input data-notion="longitude" name="lon" required value="${n && n.lon != null ? n.lon.toFixed(6) : ''}"></label></div>
      <label>Altitude (m, facultatif) <input name="alt" type="number" value="${n && n.alt != null ? n.alt : ''}"></label>
      <div class="actions-prop"><button type="button" id="choisir-pos">📍 Choisir sur la carte</button><button type="submit" class="principal">Définir la position fixe</button><button type="button" id="retirer-pos">Retirer la position fixe</button></div>
      <p class="note">Le nœud passe en position fixe : il diffuse ces coordonnées au lieu de celles de son GPS. Astuce : la barre de recherche et le clic droit donnent les coordonnées d’un lieu.</p>${pied}</form>`;
    const fo = $('#f-act');
    const marquer = () => {
      const lat = Number(String(fo.lat.value).replace(',', '.')), lon = Number(String(fo.lon.value).replace(',', '.'));
      if (gestion.marqueurPos) gestion.marqueurPos.remove();
      if (Number.isFinite(lat) && Number.isFinite(lon)) gestion.marqueurPos = L.marker([lat, lon], { icon: L.divIcon({ className: 'repere-lieu', html: '<span></span>', iconSize: [18, 18], iconAnchor: [9, 9] }), pane: 'traces' }).addTo(carte).bindTooltip('Nouvelle position', { className: 'info', permanent: true, direction: 'top' });
    };
    fo.lat.oninput = fo.lon.oninput = marquer;
    $('#choisir-pos').onclick = () => {
      $('#choisir-pos').textContent = 'Cliquez sur la carte…';
      document.body.classList.add('mode-viseur');
      carte.once('click', (ev) => {
        document.body.classList.remove('mode-viseur');
        fo.lat.value = ev.latlng.lat.toFixed(6); fo.lon.value = ev.latlng.lng.toFixed(6); fo.alt.value = '';
        $('#choisir-pos').textContent = '📍 Choisir sur la carte';
        marquer();
      });
    };
    fo.onsubmit = async (e) => {
      e.preventDefault();
      const lat = Number(String(fo.lat.value).replace(',', '.')), lon = Number(String(fo.lon.value).replace(',', '.'));
      if (!(await confirmer(`Définir la position fixe de ${n ? n.nomLong || n.id : 'ce nœud'} à ${lat.toFixed(5)}, ${lon.toFixed(5)} ?`))) return;
      lancerTache('position', { lat, lon, alt: fo.alt.value });
    };
    $('#retirer-pos').onclick = async () => { if ((await confirmer('Retirer la position fixe (le nœud reprendra son GPS) ?'))) lancerTache('position', { retirer: true }); };
    marquer();
  }
}
function rapportVerif(t) {
  const defil = [$('#fiche').scrollTop, $('#fiche-contenu').scrollTop];
  const [ref, ...autres] = t.noeuds;
  const conf = autres.filter((n) => n.statut === 'ok' && n.resultat && n.resultat.conforme).length;
  const ecart = autres.filter((n) => n.statut === 'ok' && n.resultat && !n.resultat.conforme).length;
  const ko = autres.filter((n) => n.statut === 'echec' || n.statut === 'annule').length;
  $('#fiche').hidden = false;
  etat.selection = null;
  $('#fiche-contenu').innerHTML = `
    <h2>Vérification de conformité</h2><div class="ident">${esc(t.resume || '')}</div>
    ${!t.fin ? `<div class="alerte info-lecture"><span class="sablier"></span> Vérification en cours… <small>(${autres.filter((n) => n.statut !== 'en_attente' && n.statut !== 'en_cours').length}/${autres.length} nœuds)</small> <button class="mini arreter" data-arreter-tache="${t.id}">■ Arrêter</button></div>` : ''}
    <div class="bilan-verif"><span class="ok">✔ ${conf} conforme(s)</span><span class="ecart">⚠ ${ecart} avec écarts</span><span class="ko">✖ ${ko} non vérifié(s)</span></div>
    <div class="ligne-verif ref"><b>Référence : ${esc(nomNoeud(ref.num))}</b><span>${esc(STATUTS_TACHE[ref.statut])}${ref.statut !== 'ok' && ref.detail ? ' · ' + esc(ref.detail) : ''}</span></div>
    ${autres.map((n) => {
      const r = n.resultat;
      const etatTxt = n.statut === 'ok' ? (r.conforme ? '<span class="ok">✔ conforme</span>' : `<span class="ecart">⚠ ${r.ecarts.length} écart(s)</span>`) : n.statut === 'en_cours' ? `<span class="sablier"></span> ${esc(n.detail || '')}` : n.statut === 'en_attente' ? 'en attente' : `<span class="ko">✖ ${esc(STATUTS_TACHE[n.statut])}</span>`;
      return `<div class="ligne-verif"><b data-ouvrir="${n.num}">${esc(nomNoeud(n.num))}</b><span>${etatTxt}</span>
        ${n.statut === 'ok' && !r.conforme ? `<table class="ecarts"><tr><th></th><th>Attendu</th><th>Trouvé</th></tr>${r.ecarts.map((e) => `<tr><td>${esc(NOMS_ECARTS[e.element] || e.element)} · ${esc(e.objet)}</td><td>${esc(e.attendu)}</td><td class="ecart">${esc(e.trouve)}</td></tr>`).join('')}</table>` : ''}
        ${(n.statut === 'echec' || n.statut === 'annule') && n.detail ? `<small class="note">${esc(n.detail.slice(0, 160))}</small>` : ''}</div>`;
    }).join('')}
    ${t.fin && ko ? '<p class="note">Les nœuds non vérifiés peuvent être relancés avec « ↻ Réessayer » dans Opérations récentes.</p>' : ''}`;
  $('#fiche-contenu').dataset.tache = t.id;
  $('#fiche').scrollTop = defil[0]; $('#fiche-contenu').scrollTop = defil[1];
  $('#fiche-contenu').querySelectorAll('[data-ouvrir]').forEach((b) => (b.onclick = () => ouvrirFiche(Number(b.dataset.ouvrir))));
  const ba = $('#fiche-contenu').querySelector('[data-arreter-tache]');
  if (ba) ba.onclick = async () => { ba.disabled = true; ba.textContent = 'arrêt…'; try { await postJson(`/api/admin-noeuds/taches/${t.id}/arreter`, {}); } catch (e) { alert(e.message); } };
  if (!t.fin) { gestion.lectureSuivie = t.id; suivreTaches(); }
}

// ---- Éditeur des réglages d'un nœud (module connecté ou nœud distant) ---------------------------
const PRECISIONS = [[32, 'précise'], [19, '≈ 45 m'], [18, '≈ 91 m'], [17, '≈ 182 m'], [16, '≈ 364 m'], [15, '≈ 729 m'], [14, '≈ 1,5 km'], [13, '≈ 2,9 km'], [0, 'pas de position']];
async function editeurReglages(num) {
  const i = gestion.info || await api('/api/admin-noeuds');
  const local = num === i.noeudLocal;
  $('#fiche').hidden = false;
  etat.selection = null;
  const z = $('#fiche-contenu');
  z.dataset.tache = '';
  z.innerHTML = '<div class="vide">Chargement…</div>';
  let r;
  try { r = await api(`/api/admin-noeuds/lecture/${num}/detail`); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  const lireDabord = async (reprendre) => {
    try {
      const t = await postJson('/api/admin-noeuds/taches', { type: 'lire', cibles: [num], params: reprendre ? { reprendre: true } : {} });
      gestion.editerApres = { num, tache: t.id }; gestion.lectureSuivie = t.id; voirTache(t.id); suivreTaches();
    } catch (e) { alert(e.message); }
  };
  if (r.aucune || !r.complet || !r.lora || !r.device || !r.position) {
    z.innerHTML = `<h2>Modifier les réglages · ${esc(nomNoeud(num))}</h2>
      <p>${r.aucune ? 'Sa configuration n’a pas encore été lue.' : 'La dernière lecture est incomplète.'} Le programme la lit d’abord${local ? ' (module connecté : quelques secondes)' : ' par LoRa (1 à 3 min)'}, puis ouvre l’éditeur tout seul.</p>
      <div class="actions-prop"><button id="ed-lire" class="principal">Lire la configuration</button>${!r.aucune ? '<button id="ed-reprendre">Reprendre la lecture</button>' : ''}</div>`;
    $('#ed-lire').onclick = () => lireDabord(false);
    if ($('#ed-reprendre')) $('#ed-reprendre').onclick = () => lireDabord(true);
    return;
  }
  const lo = r.lora, d = r.device, po = r.position;
  const vo = r.voisinage, te = r.telemetrie, tr = r.trafic;
  const v28 = fwAuMoins(r.firmware, '2.8.0'), v281 = fwAuMoins(r.firmware, '2.8.1');
  const nPos = etat.noeuds.get(num);
  const posActuelle = nPos && nPos.lat != null ? { lat: nPos.lat, lon: nPos.lon, alt: nPos.alt ?? null } : null;
  const opt = (liste, v, fr = {}) => liste.map((x) => `<option value="${x}" ${x === v ? 'selected' : ''}>${esc(fr[x] || x)}</option>`).join('');
  const parIndex = new Map(r.canaux.map((c) => [c.index, c]));
  const dernierCanal = Math.max(0, ...r.canaux.map((c) => c.index));
  const ligneCanal = (k) => {
    const c = parIndex.get(k);
    return `<tr data-canal="${k}" class="${c ? '' : 'vide-canal'}"><td>${k}${k === 0 ? '<br><small>principal</small>' : ''}</td>
      <td><input name="nom" maxlength="11" value="${esc(c ? c.nom || '' : '')}" placeholder="${k === 0 ? 'nom du preset' : c ? '' : '(libre)'}"></td>
      <td><input name="psk" class="mono" value="${esc(c ? c.psk || '' : 'AQ==')}" title="Clé en base64 : AQ== = clé par défaut"></td>
      <td><select name="precision">${PRECISIONS.map(([v, t]) => `<option value="${v}" ${(c ? c.precision || 0 : 17) === v ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
      <td><input type="checkbox" name="montant" ${c && c.montant ? 'checked' : ''}></td><td><input type="checkbox" name="descendant" ${c && c.descendant ? 'checked' : ''}></td>
      <td>${k > 0 && c && k === dernierCanal ? '<input type="checkbox" name="supprimer" title="Supprimer ce canal (seul le dernier peut l’être, pour ne pas laisser de trou)">' : ''}</td></tr>`;
  };
  z.innerHTML = `<h2>✏️ ${esc(r.proprietaire ? r.proprietaire.nomLong : nomNoeud(num))}</h2>
    <div class="ident">${esc(r.id)} · ${local ? 'module connecté' : 'nœud distant (LoRa)'} · configuration lue ${ilYa(r.heure)} <button class="mini principal" id="ed-relire">↻ Relire</button> <button class="mini" id="ed-autres" title="Canaux, rôle et balises, renommer, position fixe, redémarrer, firmware, conformité…">Autres actions ›</button>
      <a class="bouton-lien" href="/api/admin-noeuds/lecture/${num}/yaml" download title="Configuration au format de « meshtastic --export-config », sans les clés des canaux">⬇ YAML</a>
      <a class="bouton-lien" href="/api/admin-noeuds/lecture/${num}/yaml?canaux=1" download title="Avec le lien des canaux (clés incluses) : pour reprogrammer ce nœud ou un remplaçant en USB avec « meshtastic --configure ». Ne pas diffuser.">⬇ YAML + canaux</a></div>
    ${r.firmware ? `<div class="note">Firmware ${esc(r.firmware)}${v28 ? ' · réglages 2.8 disponibles ci-dessous' : ''}</div>` : ''}
    <div class="parametres compact"><label>Préremplir avec un modèle <select id="ed-modele"><option value="">— choisir —</option></select></label></div>
    ${Date.now() - r.heure > 3600000 ? '<div class="alerte attention">Lecture de plus d’une heure : relisez avant de modifier si quelqu’un a pu changer ce nœud entre-temps.</div>' : ''}
    <form id="f-edit" class="form-edit">
      <h4>Nom</h4><div class="grille-edit">
        <label>Nom long <input name="nomLong" maxlength="39" value="${esc(r.proprietaire.nomLong || '')}"></label>
        <label>Nom court <input name="nomCourt" maxlength="4" value="${esc(r.proprietaire.nomCourt || '')}"></label></div>
      <h4>Appareil</h4><div class="grille-edit">
        <label>Rôle <select name="role">${opt(i.roles, d.role, ROLES_FR_ADMIN)}</select></label>
        <label>Rediffusion <select name="rebroadcastMode">${opt(i.rediffusions || [], d.rebroadcastMode, REDIFFUSION_FR)}</select></label>
        <label>Infos nœud toutes les (s) <input name="nodeInfoBroadcastSecs" type="number" min="0" value="${d.nodeInfoBroadcastSecs || 0}"></label></div>
      <h4>LoRa</h4><div class="grille-edit">
        <label>Région <select name="region">${opt(i.regions || [lo.region], lo.region)}</select></label>
        <label>Preset <select name="modemPreset">${opt(i.presets, lo.modemPreset)}</select></label>
        <label>Slot (0 = auto) <input name="channelNum" type="number" min="0" max="200" value="${lo.channelNum || 0}"></label>
        <label>Fréquence forcée MHz (0 = non) <input name="overrideFrequency" type="number" step="0.0001" min="0" value="${lo.overrideFrequency ? Number(lo.overrideFrequency).toFixed(4) : 0}"></label>
        <label>Sauts <select name="hopLimit">${opt([1, 2, 3, 4, 5, 6, 7], lo.hopLimit)}</select></label>
        <label>Puissance dBm (0 = défaut) <input name="txPower" type="number" min="0" max="30" value="${lo.txPower || 0}"></label>
        <label class="case"><input type="checkbox" name="sx126xRxBoostedGain" ${lo.sx126xRxBoostedGain ? 'checked' : ''}> Réception boostée (SX126x)</label>
        <label class="case"><input type="checkbox" name="configOkToMqtt" ${lo.configOkToMqtt ? 'checked' : ''}> Autoriser l’envoi vers MQTT</label></div>
      <h4>Position</h4><div class="grille-edit">
        <label>Intervalle (s) <input name="positionBroadcastSecs" type="number" min="0" value="${po.positionBroadcastSecs || 0}"></label>
        <label class="case"><input type="checkbox" name="positionBroadcastSmartEnabled" ${po.positionBroadcastSmartEnabled ? 'checked' : ''}> Mode intelligent</label></div>
      <div class="bloc-position-fixe">
        <div class="ident">Position fixe ${po.fixedPosition ? '<b>activée</b>' : 'désactivée (GPS ou aucune)'} · position connue : ${posActuelle ? `${posActuelle.lat.toFixed(5)}, ${posActuelle.lon.toFixed(5)}${posActuelle.alt != null ? ' · ' + posActuelle.alt + ' m' : ''}` : 'aucune'}</div>
        <div class="grille-edit">
          <label>Latitude <input name="pfLat" inputmode="decimal" placeholder="45.12345" value=""></label>
          <label>Longitude <input name="pfLon" inputmode="decimal" placeholder="3.98765" value=""></label>
          <label>Altitude (m, facultatif) <input name="pfAlt" type="number" value=""></label>
        </div>
        <div class="actions-prop"><button type="button" id="pf-carte">📍 Choisir sur la carte</button><button type="button" id="pf-actuelle" ${posActuelle ? '' : 'disabled'}>Reprendre la position connue</button>${po.fixedPosition ? '<label class="case"><input type="checkbox" name="pfRetirer"> Retirer la position fixe (reprendre le GPS)</label>' : ''}</div>
        <p class="note">Laisser vide pour ne pas toucher à la position. Renseignée, elle est envoyée comme position fixe : le nœud diffuse ces coordonnées au lieu de celles de son GPS.</p>
      </div>
      <h4>Voisinage (NeighborInfo)</h4>
      ${vo ? `<div class="grille-edit">
        <label class="case"><input type="checkbox" name="voisEnabled" ${vo.enabled ? 'checked' : ''}> Publier la liste des nœuds entendus directement</label>
        <label>Toutes les <select name="voisInterval">${[[14400, '4 h'], [21600, '6 h'], [43200, '12 h'], [86400, '24 h']].map(([v, t]) => `<option value="${v}" ${(vo.updateInterval || 0) === v ? 'selected' : ''}>${t}</option>`).join('')}${vo.updateInterval && ![14400, 21600, 43200, 86400].includes(vo.updateInterval) ? `<option value="${Math.max(14400, vo.updateInterval)}" selected>${Math.round(vo.updateInterval / 3600)} h</option>` : ''}</select></label>
        <label class="case"><input type="checkbox" name="voisLora" ${vo.transmitOverLora ? 'checked' : ''}> Envoyer aussi sur LoRa</label></div>
        <p class="note">Indispensable pour savoir ce qu’entend un relais qui n’est pas passerelle MQTT (liaisons à sens unique, SNR de chaque voisin). « Envoyer aussi sur LoRa » est nécessaire pour un nœud sans MQTT ; le firmware l’ignore sur un canal principal à clé et nom par défaut, et impose au moins 4 h entre deux envois.</p>`
      : '<p class="note">Réglage du module Voisinage non encore lu : « Relire » ci-dessus le récupère (firmware récent).</p>'}
      <h4>Télémétrie de l’appareil</h4>
      ${te ? `<div class="grille-edit">
        <label class="case"><input type="checkbox" name="telEnabled" ${te.deviceTelemetryEnabled ? 'checked' : ''}> Envoyer batterie, tension, occupation du canal sur le maillage</label>
        <label>Toutes les <select name="telInterval">${[[0, 'défaut (30 min)'], [900, '15 min'], [1800, '30 min'], [3600, '1 h'], [7200, '2 h'], [10800, '3 h'], [21600, '6 h']].map(([v, t]) => `<option value="${v}" ${(te.deviceUpdateInterval || 0) === v ? 'selected' : ''}>${t}</option>`).join('')}${te.deviceUpdateInterval && ![0, 900, 1800, 3600, 7200, 10800, 21600].includes(te.deviceUpdateInterval) ? `<option value="${te.deviceUpdateInterval}" selected>${Math.round(te.deviceUpdateInterval / 60)} min</option>` : ''}</select></label></div>
        <p class="note">Sans télémétrie, la carte ne voit ni la batterie ni la charge radio du nœud. En 2.8, cet envoi est désactivé par défaut sur les canaux publics.</p>`
      : '<p class="note">Module Télémétrie non encore lu : « Relire » ci-dessus le récupère.</p>'}
      ${v28 ? `<h4>Gestion du trafic (2.8)</h4>
      ${tr ? `<div class="grille-edit">
        <label>Positions d’un même nœud : au plus une toutes les (s, 0 = non) <input name="trPos" type="number" min="0" value="${tr.positionMinIntervalSecs || 0}"></label>
        <label>Répondre aux demandes de fiche jusqu’à (sauts, 0 = non) <input name="trInfo" type="number" min="0" max="7" value="${tr.nodeinfoDirectResponseMaxHops || 0}"></label>
        <label>Limite de débit : fenêtre (s, 0 = non) <input name="trFen" type="number" min="0" value="${tr.rateLimitWindowSecs || 0}"></label>
        <label>Paquets max par nœud et par fenêtre (0 = non) <input name="trMax" type="number" min="0" value="${tr.rateLimitMaxPackets || 0}"></label>
        <label>Paquets illisibles avant blocage (0 = non) <input name="trInc" type="number" min="0" value="${tr.unknownPacketThreshold || 0}"></label></div>
        <p class="note">Module du firmware 2.8 pour les grands maillages : un relais ne retransmet plus les positions trop fréquentes ni les nœuds trop bavards. Une valeur à 0 désactive la fonction.</p>`
      : '<p class="note">Gestion du trafic non encore lue : « Relire » ci-dessus la récupère.</p>'}` : ''}
      ${v281 ? `<h4>Signature des paquets (2.8.1)</h4><div class="grille-edit">
        <label>Paquets acceptés <select name="signature">${(i.signatures || []).map((x) => `<option value="${x}" ${x === r.signature ? 'selected' : ''}>${esc(SIGNATURES_FR[x] || x)}</option>`).join('')}</select></label></div>
        <p class="note">« Compatible » accepte les nœuds 2.7 qui ne signent pas : à garder tant que le réseau n’est pas entièrement en 2.8. « Équilibrée » exige la signature des nœuds qui ont déjà signé. « Stricte » n’accepte que les paquets signés ou chiffrés PKI.</p>` : ''}
      <h4>Canaux</h4>
      <div class="defil-canaux"><table class="canaux-edit"><thead><tr><th>#</th><th>Nom</th><th>Clé</th><th>Position</th><th>↑</th><th>↓</th><th>🗑</th></tr></thead><tbody>
        ${[0, 1, 2, 3, 4, 5, 6, 7].map(ligneCanal).join('')}</tbody></table></div>
      <p class="note">Pour ajouter un canal, remplissez une ligne libre. AQ== = clé publique par défaut. Seuls les champs modifiés sont envoyés, en une seule fois ; le nœud enregistre puis redémarre si besoin, et le programme relit pour contrôler.</p>
      <div id="ed-resume" class="note"></div>
      <div class="actions-prop"><button type="submit" class="principal">Appliquer les modifications</button><button type="button" id="ed-annuler">Annuler</button></div>
      <p class="erreur" id="ed-retour"></p>
    </form>`;
  $('#ed-relire').onclick = () => lireDabord(false);
  $('#ed-autres').onclick = () => {
    gestion.selection = new Set([num]);
    gestion.filtre = '';
    $('#panneau').classList.remove('replie'); $('#deplier').hidden = true;
    document.querySelector('.onglets button[data-onglet="gestion"]').click();
  };
  $('#ed-annuler').onclick = () => { if (gestion.marqueurPos) { gestion.marqueurPos.remove(); gestion.marqueurPos = null; } editeurReglages(num); };
  const fo = $('#f-edit');
  // Position fixe : repère sur la carte, choix au clic
  const marquerPf = () => {
    const lat = Number(String(fo.pfLat.value).replace(',', '.')), lon = Number(String(fo.pfLon.value).replace(',', '.'));
    if (gestion.marqueurPos) { gestion.marqueurPos.remove(); gestion.marqueurPos = null; }
    if (fo.pfLat.value.trim() && Number.isFinite(lat) && Number.isFinite(lon)) gestion.marqueurPos = L.marker([lat, lon], { icon: L.divIcon({ className: 'repere-lieu', html: '<span></span>', iconSize: [18, 18], iconAnchor: [9, 9] }), pane: 'traces' }).addTo(carte).bindTooltip(`Nouvelle position de ${esc(nomNoeud(num))}`, { className: 'info', permanent: true, direction: 'top' });
  };
  fo.pfLat.addEventListener('input', marquerPf); fo.pfLon.addEventListener('input', marquerPf);
  $('#pf-carte').onclick = () => {
    $('#pf-carte').textContent = 'Cliquez sur la carte…';
    document.body.classList.add('mode-viseur');
    carte.once('click', (ev) => {
      document.body.classList.remove('mode-viseur');
      fo.pfLat.value = ev.latlng.lat.toFixed(6); fo.pfLon.value = ev.latlng.lng.toFixed(6); fo.pfAlt.value = '';
      $('#pf-carte').textContent = '📍 Choisir sur la carte';
      marquerPf(); majResume();
    });
  };
  $('#pf-actuelle').onclick = () => { if (!posActuelle) return; fo.pfLat.value = posActuelle.lat.toFixed(6); fo.pfLon.value = posActuelle.lon.toFixed(6); fo.pfAlt.value = posActuelle.alt ?? ''; marquerPf(); majResume(); };
  const diff = () => {
    const p = {}, chg = [];
    const val = (n) => fo.elements[n];
    if (val('nomLong').value.trim() !== (r.proprietaire.nomLong || '') || val('nomCourt').value.trim() !== (r.proprietaire.nomCourt || '')) { p.nom = { nomLong: val('nomLong').value.trim(), nomCourt: val('nomCourt').value.trim() }; chg.push('nom'); }
    const sec = (nom, champs, src) => {
      const o = {};
      for (const [k, type] of champs) {
        const el = val(k); let v = type === 'bool' ? el.checked : type === 'num' ? Number(el.value) : el.value;
        const avant = type === 'bool' ? !!src[k] : type === 'num' ? Number(src[k] || 0) : src[k];
        if (type === 'num' && k === 'overrideFrequency' ? Math.abs(v - avant) > 0.00005 : v !== avant) { o[k] = v; chg.push(k); }
      }
      if (Object.keys(o).length) p[nom] = o;
    };
    sec('device', [['role', 'txt'], ['rebroadcastMode', 'txt'], ['nodeInfoBroadcastSecs', 'num']], d);
    sec('lora', [['region', 'txt'], ['modemPreset', 'txt'], ['channelNum', 'num'], ['overrideFrequency', 'num'], ['hopLimit', 'num'], ['txPower', 'num'], ['sx126xRxBoostedGain', 'bool'], ['configOkToMqtt', 'bool']], lo);
    sec('position', [['positionBroadcastSecs', 'num'], ['positionBroadcastSmartEnabled', 'bool']], po);
    if (vo) {
      const v = {};
      if (val('voisEnabled').checked !== !!vo.enabled) { v.enabled = val('voisEnabled').checked; chg.push(v.enabled ? 'voisinage activé' : 'voisinage désactivé'); }
      if (Number(val('voisInterval').value) !== (vo.updateInterval || 0) && (val('voisEnabled').checked || vo.enabled)) { v.updateInterval = Number(val('voisInterval').value); chg.push('intervalle du voisinage'); }
      if (val('voisLora').checked !== !!vo.transmitOverLora) { v.transmitOverLora = val('voisLora').checked; chg.push(v.transmitOverLora ? 'voisinage sur LoRa' : 'voisinage hors LoRa'); }
      if (Object.keys(v).length) p.voisinage = v;
    }
    if (te && val('telEnabled')) {
      const t = {};
      if (val('telEnabled').checked !== !!te.deviceTelemetryEnabled) { t.deviceTelemetryEnabled = val('telEnabled').checked; chg.push(t.deviceTelemetryEnabled ? 'télémétrie activée' : 'télémétrie désactivée'); }
      if (Number(val('telInterval').value) !== (te.deviceUpdateInterval || 0)) { t.deviceUpdateInterval = Number(val('telInterval').value); chg.push('intervalle de télémétrie'); }
      if (Object.keys(t).length) p.telemetrie = t;
    }
    if (tr && val('trPos')) {
      const t = {};
      for (const [champ, cle, lib] of [['trPos', 'positionMinIntervalSecs', 'intervalle mini des positions'], ['trInfo', 'nodeinfoDirectResponseMaxHops', 'réponse aux fiches'], ['trFen', 'rateLimitWindowSecs', 'fenêtre de limite de débit'], ['trMax', 'rateLimitMaxPackets', 'paquets max'], ['trInc', 'unknownPacketThreshold', 'seuil de paquets illisibles']]) {
        if (Number(val(champ).value) !== (tr[cle] || 0)) { t[cle] = Number(val(champ).value); chg.push(lib); }
      }
      if (Object.keys(t).length) p.trafic = t;
    }
    if (val('signature') && val('signature').value !== r.signature) { p.securite = { packetSignaturePolicy: val('signature').value }; chg.push('signature des paquets'); }
    const nb = (x) => Number(String(x || '').trim().replace(',', '.'));
    if (val('pfRetirer') && val('pfRetirer').checked) { p.positionFixe = { retirer: true }; chg.push('retrait de la position fixe'); }
    else if (val('pfLat').value.trim() || val('pfLon').value.trim()) {
      const lat = nb(val('pfLat').value), lon = nb(val('pfLon').value);
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) { p.positionFixe = { lat, lon, alt: val('pfAlt').value }; chg.push(`position fixe ${lat.toFixed(5)}, ${lon.toFixed(5)}`); }
      else chg.push('position invalide');
    }
    p.canaux = [];
    fo.querySelectorAll('tr[data-canal]').forEach((tr) => {
      const k = Number(tr.dataset.canal), c = parIndex.get(k), q = (n) => tr.querySelector(`[name="${n}"]`);
      const now = { index: k, nom: q('nom').value.trim(), psk: q('psk').value.trim() || 'AQ==', precision: Number(q('precision').value), montant: q('montant').checked, descendant: q('descendant').checked, supprimer: q('supprimer') ? q('supprimer').checked : false };
      if (!c) { if (now.nom) { p.canaux.push(now); chg.push('nouveau canal ' + k); } return; }
      if (now.supprimer) { p.canaux.push({ index: k, supprimer: true }); chg.push('suppression canal ' + k); return; }
      if (now.nom !== (c.nom || '') || now.psk !== (c.psk || '') || now.precision !== (c.precision || 0) || now.montant !== !!c.montant || now.descendant !== !!c.descendant) { p.canaux.push(now); chg.push('canal ' + k); }
    });
    return { p, chg };
  };
  const majResume = () => { const { chg } = diff(); $('#ed-resume').textContent = chg.length ? 'Modifié : ' + chg.join(', ') : 'Aucune modification.'; };
  fo.oninput = majResume; fo.onchange = majResume; majResume();
  // Préremplissage par un modèle : seuls les champs prévus par le modèle changent, rien n'est envoyé avant « Appliquer »
  api('/api/admin-noeuds/modeles').then(({ modeles }) => {
    const sel = $('#ed-modele');
    if (!sel) return;
    sel.innerHTML += modeles.map((m) => `<option value="${esc(m.id)}">${esc(m.nom)}</option>`).join('');
    sel.onchange = () => {
      const m = modeles.find((x) => x.id === sel.value);
      if (!m) return;
      const mettre = (n, v) => { const el = fo.elements[n]; if (!el || v == null) return; if (el.type === 'checkbox') el.checked = !!v; else el.value = v; };
      const dv = m.device || {}, lv = m.lora || {}, pv = m.position || {}, vv = m.voisinage || {}, tv = m.telemetrie || {};
      mettre('role', dv.role); mettre('rebroadcastMode', dv.rebroadcastMode); mettre('nodeInfoBroadcastSecs', dv.nodeInfoBroadcastSecs);
      mettre('hopLimit', lv.hopLimit); mettre('configOkToMqtt', lv.configOkToMqtt); mettre('sx126xRxBoostedGain', lv.sx126xRxBoostedGain);
      mettre('positionBroadcastSecs', pv.positionBroadcastSecs); mettre('positionBroadcastSmartEnabled', pv.positionBroadcastSmartEnabled);
      mettre('voisEnabled', vv.enabled); if (vv.enabled) { mettre('voisInterval', vv.updateInterval); mettre('voisLora', vv.transmitOverLora); }
      mettre('telEnabled', tv.deviceTelemetryEnabled); mettre('telInterval', tv.deviceUpdateInterval);
      majResume();
      $('#ed-retour').textContent = `Modèle « ${m.nom} » appliqué au formulaire : vérifiez puis « Appliquer les modifications ».${m.favoris ? ' Pensez aux favoris des routeurs voisins (Programmer › ⭐ Favoris relais).' : ''}`;
    };
  }).catch(() => {});
  fo.onsubmit = async (e) => {
    e.preventDefault();
    const { p, chg } = diff();
    if (!chg.length) { $('#ed-retour').textContent = 'Aucune modification'; return; }
    if (chg.includes('position invalide')) { $('#ed-retour').textContent = 'Coordonnées de position invalides'; return; }
    if (p.canaux.some((c) => c.psk && !/^[A-Za-z0-9+/=]{2,64}$/.test(c.psk))) { $('#ed-retour').textContent = 'Clé invalide (base64)'; return; }
    if (p.canaux.some((c) => c.index === 0)) {
      const t = (await saisir(`Le canal PRINCIPAL (0) va changer${local ? '' : ' sur un nœud distant'}.\nTapez CANAL 0 pour confirmer :`));
      if ((t || '').trim().toUpperCase() !== 'CANAL 0') return;
      p.confirmation = 'CANAL 0';
    }
    if (p.lora && (p.lora.region || p.lora.modemPreset || p.lora.channelNum != null || p.lora.overrideFrequency != null) && !local
      && !(await confirmer('Vous changez la radio (région, preset, slot ou fréquence) d’un nœud DISTANT : s’il ne parle plus comme les autres, vous perdrez le contact. Continuer ?'))) return;
    if (!(await confirmer(`Appliquer à ${nomNoeud(num)} : ${chg.join(', ')} ?`))) return;
    try {
      // La position fixe est une opération à part (message d'administration dédié), mise en file après les réglages
      const pos = p.positionFixe; delete p.positionFixe;
      const autres = chg.filter((x) => !/position fixe/.test(x));
      let t = null;
      if (autres.length) t = await postJson('/api/admin-noeuds/taches', { type: 'modifier', cibles: [num], params: p });
      if (pos) { const tp = await postJson('/api/admin-noeuds/taches', { type: 'position', cibles: [num], params: pos }); if (!t) t = tp; }
      gestion.lectureSuivie = t.id; voirTache(t.id); suivreTaches();
    } catch (err) { $('#ed-retour').textContent = err.message; }
  };
}

// ---- Page du broker MQTT : état, passerelles entendues, réglages et test ----------------------
let suiviBroker = null;
async function ouvrirBroker() {
  const dlg = $('#dlg-mqtt'), z = $('#mqtt-contenu');
  if (!dlg.open) dlg.showModal();
  dlg.onclose = () => { clearInterval(suiviBroker); suiviBroker = null; };
  let m;
  try { m = await api('/api/mqtt'); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  const formOuvert = z.querySelector('#f-broker');
  const etatHtml = `
    <div class="grille">
      <div class="mesure"><span>État</span><b class="${m.connecte ? 'ok' : 'ko'}">${m.connecte ? '● connecté' : '● déconnecté'}</b></div>
      <div class="mesure"><span>Connecté depuis</span><b>${m.depuis ? ilYa(m.depuis).replace('il y a ', '') : '–'}</b></div>
      <div class="mesure"><span>Dernier message</span><b>${m.dernierMessage ? ilYa(m.dernierMessage) : '–'}</b></div>
      <div class="mesure"><span>Messages / min (10 min)</span><b>${fmt(m.parMinute, 1)}</b></div>
      <div class="mesure"><span>Reçus · décodés · erreurs</span><b>${m.recus} · ${m.decodes} · ${m.erreurs}</b></div>
      <div class="mesure"><span>Reconnexions</span><b>${m.reconnexions}</b></div>
    </div>
    ${m.derniereErreur ? `<div class="alerte attention">Dernière erreur (${ilYa(m.derniereErreur.heure)}) : ${esc(m.derniereErreur.message)}</div>` : ''}
    <p class="note">Abonnement : <span class="mono">${esc(m.sujets.join(', '))}</span></p>
    ${(m.brokersSupplementaires || []).length ? `<h4>Brokers supplémentaires</h4>${m.brokersSupplementaires.map((b) => `<div class="mesure-ligne"><b class="${b.connecte ? 'ok' : 'ko'}">●</b> <span class="mono">${esc(b.url)}</span> · ${esc(b.racine)} · ${b.messages} message(s)${b.derniereErreur && !b.connecte ? ` · <span class="ko">${esc(b.derniereErreur.message)}</span>` : ''}</div>`).join('')}
      <p class="note">${m.doublonsIgnores || 0} paquet(s) reçu(s) en double par plusieurs brokers, ignoré(s). Liste réglable plus bas.</p>` : '<p class="note">Un autre broker à écouter en même temps (bulle voisine) ? Ajoutez-le plus bas, dans « Brokers supplémentaires ».</p>'}
    <h4>Modules du réseau local (UDP)</h4>
    ${!m.udp || !m.udp.demande ? `<p class="note">Désactivé. Les modules Meshtastic en Wi-Fi réglés sur « UDP » (appli Meshtastic › Réseau › Protocoles, firmware 2.6 ou plus) diffusent ce qu’ils entendent sur le réseau local : la carte peut les écouter sans occuper le module, l’appli du téléphone reste connectée. À activer dans Réglages avancés › « Écouter les modules Meshtastic du réseau local ». Avec Docker, la carte doit être en réseau « host » (wiki, Installation).</p>`
      : m.udp.erreur ? `<div class="alerte attention">Écoute UDP impossible : ${esc(m.udp.erreur)}</div>`
      : `<div class="mesure-ligne"><b class="${m.udp.paquets ? 'ok' : 'ko'}">●</b> ${m.udp.paquets} paquet(s) reçu(s) de ${m.udp.emetteurs.length} module(s) · groupes ${esc((m.udp.groupes || []).join(', '))}</div>
        ${m.udp.emetteurs.map((e) => `<div class="mesure-ligne"><span class="mono">${esc(e.ip)}</span> ${esc((m.udp.noeuds || {})[e.ip] || '')} · ${e.paquets} paquet(s) · ${ilYa(e.derniere)}</div>`).join('')}
        ${!m.udp.paquets && m.udp.depuis && Date.now() - m.udp.depuis > 5 * 60000 ? '<p class="note attention">Rien reçu depuis 5 min : réglage « UDP » activé sur les modules ? Même réseau local que le serveur ? Avec Docker, réseau « host » ?</p>' : ''}`}
    <h4>Domotique (Home Assistant, Node-RED)</h4>
    ${!m.domotique || !m.domotique.actif ? '<p class="note">Désactivée. La carte peut publier l’état du réseau, les alertes et les relais vers le broker MQTT de Home Assistant ou de Node-RED, et recevoir un message à envoyer en LoRa. À régler dans Réglages avancés › « Domotique ».</p>'
      : `<div class="mesure-ligne"><b class="${m.domotique.connecte ? 'ok' : 'ko'}">●</b> <span>${m.domotique.connecte ? 'Connectée' : 'Non connectée'}</span> · <span>${m.domotique.noeuds} nœud(s) publié(s)</span> · <span class="mono">${esc(m.domotique.racine)}/…</span>${m.domotique.erreur && !m.domotique.connecte ? ` · <span class="ko">${esc(m.domotique.erreur)}</span>` : ''}</div>
        <p class="note">${m.domotique.decouverte ? 'Découverte Home Assistant activée : les capteurs apparaissent dans Paramètres › Appareils et services › MQTT.' : 'Découverte Home Assistant désactivée : sujets bruts pour Node-RED.'} ${m.domotique.envoi ? `Envoi LoRa accepté sur ${esc(m.domotique.racine)}/envoyer.` : 'Envoi LoRa depuis la domotique refusé.'}</p>`}
    <h4>Passerelles entendues par le broker (${m.passerelles.length})</h4>
    ${m.passerelles.length ? `<div class="defil-gw"><table class="voisins"><thead><tr><th>Passerelle</th><th>Sujet</th><th class="num">Messages</th><th>Dernier</th></tr></thead><tbody>
      ${m.passerelles.map((g) => `<tr><td>${esc(g.nom || g.id)}<br><small class="mono">${esc(g.id)}</small></td><td class="mono petit">${esc(g.sujet)}</td><td class="num">${g.messages}</td><td>${ilYa(g.derniere)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="vide">Aucune passerelle depuis le démarrage.</div>'}
    ${m.canaux.length ? `<p class="note">Canaux vus : ${m.canaux.map((c) => `${esc(c.canal)} (${c.messages})`).join(' · ')}</p>` : ''}`;
  if (formOuvert) { $('#broker-etat').innerHTML = etatHtml; return; }
  z.innerHTML = `<h3>Broker MQTT</h3><div class="ident">${esc(m.url)}</div>
    <div id="broker-etat">${etatHtml}</div>
    <h4>Réglages</h4>
    <form id="f-broker" class="form-edit">
      <div class="grille-edit">
        <label>Adresse <input data-notion="mqttUrl" name="url" value="${esc(m.url.includes('***') ? '' : m.url)}" placeholder="mqtt://serveur:1883 ou mqtts://serveur:8883"></label>
        <label>Racine des sujets <input data-notion="mqttRacine" name="racine" value="${esc(m.racine)}" placeholder="msh/EU_868"></label>
        <label>Utilisateur <input name="utilisateur" value="${esc(m.utilisateur || '')}" autocomplete="off"></label>
        <label>Mot de passe <input name="motDePasse" type="password" placeholder="${m.motDePasseDefini ? '(inchangé)' : ''}" autocomplete="new-password"></label>
        <label style="grid-column: 1 / -1">Sujets supplémentaires (séparés par des virgules) <input data-notion="mqttSujets" name="sujetsSupplementaires" value="${esc(m.sujetsSupplementaires || '')}"></label>
        <label style="grid-column: 1 / -1">Brokers supplémentaires écoutés en même temps (5 au plus, un par ligne) <textarea data-notion="brokers" name="brokers" rows="3" spellcheck="false" autocomplete="off" placeholder="mqtts://nom:motdepasse@broker-voisin:8883|msh/EU_868">${esc(m.brokersReglage || '')}</textarea></label>
      </div>
      <p class="note">Brokers supplémentaires : une ligne par broker, « adresse » ou « adresse|racine » (racine vide = celle du broker principal). Chacun est écouté pour Meshtastic et pour MeshCore ; un paquet reçu par plusieurs brokers n’est compté qu’une fois. Identifiant et mot de passe dans l’adresse ; un mot de passe affiché <span class="mono">***</span> reste celui déjà enregistré. Ligne effacée = broker retiré.</p>
      <div class="actions-prop"><button type="button" id="broker-tester">🔌 Tester ces réglages (10 s)</button><button type="submit" class="principal">Enregistrer et redémarrer</button></div>
      <div id="broker-test"></div>
      <p class="note">Le test se connecte avec ces réglages <b>sans toucher</b> à la connexion actuelle, s’abonne à la racine et compte les messages reçus pendant 10 s. Mot de passe vide = celui déjà enregistré.</p>
    </form>`;
  const fo = $('#f-broker');
  const valeurs = () => ({ url: fo.url.value.trim() || undefined, racine: fo.racine.value.trim(), utilisateur: fo.utilisateur.value.trim(), motDePasse: fo.motDePasse.value, sujetsSupplementaires: fo.sujetsSupplementaires.value, brokers: fo.brokers.value });
  $('#broker-tester').onclick = async () => {
    const b = $('#broker-tester'), zt = $('#broker-test');
    b.disabled = true; zt.innerHTML = '<div class="alerte info-lecture"><span class="sablier"></span> Test en cours (connexion puis 10 s d’écoute)…</div>';
    try {
      const r = await postJson('/api/mqtt/tester', valeurs());
      zt.innerHTML = r.connecte
        ? `<div class="alerte info-lecture">✔ Connecté en ${r.delaiConnexionMs} ms · abonnement ${esc(r.abonnement || '?')} · <b>${r.messages}</b> message(s) en ${r.dureeEcouteS} s${r.erreur ? ' · ' + esc(r.erreur) : ''}</div>
           ${r.messages ? `<table class="voisins petit"><thead><tr><th>Sujet</th><th class="num">Messages</th></tr></thead><tbody>${r.sujets.map((x) => `<tr><td class="mono">${esc(x.sujet)}</td><td class="num">${x.n}</td></tr>`).join('')}</tbody></table>` : '<p class="note">Connexion correcte mais aucun message : vérifiez la racine, les droits (ACL) du compte et que des passerelles publient.</p>'}`
        : `<div class="alerte attention">✖ Échec : ${esc(r.erreur || 'connexion impossible')}</div>`;
    } catch (e) { zt.innerHTML = `<div class="alerte attention">${esc(e.message)}</div>`; }
    b.disabled = false;
  };
  fo.onsubmit = async (e) => {
    e.preventDefault();
    if (!(await confirmer('Enregistrer ces réglages ? Le service redémarre (quelques secondes) et se reconnecte au broker.'))) return;
    const v = valeurs();
    const corps = { mqtt: { racine: v.racine, utilisateur: v.utilisateur, motDePasse: v.motDePasse, sujetsSupplementaires: v.sujetsSupplementaires, brokers: v.brokers } };
    if (v.url) corps.mqtt.url = v.url;
    try { await postJson('/api/reglages', corps); $('#broker-test').innerHTML = '<div class="alerte info-lecture">Enregistré : redémarrage du service… la page se recharge.</div>'; setTimeout(() => location.reload(), 9000); }
    catch (err) { $('#broker-test').innerHTML = `<div class="alerte attention">${esc(err.message)}</div>`; }
  };
  clearInterval(suiviBroker);
  suiviBroker = setInterval(() => { if ($('#dlg-mqtt').open) ouvrirBroker(); }, 5000);
}

// ---- Sauvegardes des réglages (admin) ----------------------------------------------------------
async function rendreSauvegardes() {
  const z = $('#pan-sauvegardes');
  let l = [];
  try { l = await api('/api/sauvegardes'); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  z.innerHTML = `<p class="note">Chaque nuit vers 3 h 30, la carte sauvegarde ses réglages : comptes, réglages généraux, fiches d’installation des relais, modules radio, configurations lues des nœuds, mots de passe d’administration MeshCore, traceroutes. Les 14 dernières sont gardées sur le NAS. Les données radio (paquets, liens) ne sont pas sauvegardées : elles se reconstituent toutes seules.</p>
    <p class="note"><b>Fichier sensible</b> (clés des canaux, mots de passe d’administration MeshCore) : gardez la copie téléchargée en lieu sûr.</p>
    <div class="actions-prop"><button id="sv-maintenant" class="principal">Sauvegarder maintenant</button></div>
    <div class="liste">${l.map((x) => `<div class="ligne" style="grid-template-columns:1fr auto"><span class="titre"><b>${esc(new Date(x.date).toLocaleString(document.documentElement.lang || 'fr-FR', { dateStyle: 'full', timeStyle: 'short' }))}</b><small>${Math.round(x.taille / 1024)} ko</small></span><span class="meta"><a class="bouton-lien" href="/api/sauvegardes/${encodeURIComponent(x.nom)}">Télécharger</a></span></div>`).join('') || '<div class="vide">Aucune sauvegarde pour l’instant.</div>'}</div>
    <h4>Restaurer</h4>
    <p class="note">Choisissez un fichier de sauvegarde téléchargé : les réglages et les comptes sont remplacés (l’état actuel est d’abord mis de côté), puis la carte redémarre.</p>
    <input type="file" id="sv-fichier" accept=".json,application/json"><button id="sv-restaurer" disabled>Restaurer ce fichier</button>
    <p class="erreur" id="sv-retour"></p>`;
  $('#sv-maintenant').onclick = async () => { try { await postJson('/api/sauvegardes', {}); rendreSauvegardes(); } catch (e) { $('#sv-retour').textContent = e.message; } };
  const fi = $('#sv-fichier'), br = $('#sv-restaurer');
  fi.onchange = () => { br.disabled = !fi.files.length; };
  br.onclick = async () => {
    const f = fi.files[0];
    if (!f) return;
    let s;
    try { s = JSON.parse(await f.text()); } catch { $('#sv-retour').textContent = 'Fichier illisible'; return; }
    if (s.format !== 'carte-live-sauvegarde') { $('#sv-retour').textContent = 'Ce fichier n’est pas une sauvegarde de la carte'; return; }
    if (!(await confirmer(`Restaurer la sauvegarde du ${new Date(s.date).toLocaleString('fr-FR')} ? Les réglages et les comptes actuels seront remplacés et la carte redémarrera.`))) return;
    try { await postJson('/api/sauvegardes/restaurer', s); attendreRedemarrage('Sauvegarde restaurée'); } catch (e) { $('#sv-retour').textContent = e.message; }
  };
}
// Choix des nœuds d'un gestionnaire : relais Meshtastic connus et répéteurs MeshCore, ou saisie libre (!a1b2c3d4, clé MeshCore)
function editerSecteur(c, fini) {
  const z = $('#edition-secteur');
  const choisis = new Set(c.noeuds || []);
  const mt = [...etat.noeuds.values()].filter((n) => n.infrastructure || choisis.has(String(n.num))).map((n) => ({ id: String(n.num), nom: n.nomLong || n.id, info: n.id + (n.role ? ' · ' + n.role : '') }));
  const mcl = (typeof mc !== 'undefined' && mc.noeuds ? [...mc.noeuds.values()] : []).filter((n) => ['repeteur', 'salon'].includes(n.role) || choisis.has(String(n.cle).toUpperCase())).map((n) => ({ id: String(n.cle).toUpperCase(), nom: n.nom || n.cle.slice(0, 8), info: 'MeshCore · ' + n.cle.slice(0, 8) }));
  const tous = [...mt, ...mcl].sort((a, b) => a.nom.localeCompare(b.nom));
  const connus = new Set(tous.map((x) => x.id));
  const autres = [...choisis].filter((x) => !connus.has(x));
  z.innerHTML = `<h3>Secteur de ${esc(c.identifiant)}</h3>
    <div class="recherche"><input id="filtre-secteur" type="search" placeholder="Filtrer…"></div>
    <div class="liste-gestion" style="max-height:260px">${tous.map((x) => `<label class="ligne-gestion" data-nom="${esc((x.nom + ' ' + x.info).toLowerCase())}"><input type="checkbox" value="${x.id}" ${choisis.has(x.id) ? 'checked' : ''}><span class="titre">${esc(x.nom)} <small>${esc(x.info)}</small></span></label>`).join('') || '<div class="vide">Aucun relais connu.</div>'}</div>
    <label class="champ-libre">Autres nœuds (identifiants !xxxxxxxx ou clés MeshCore, séparés par des virgules) <input id="secteur-autres" value="${esc(autres.join(', '))}"></label>
    <div class="actions-prop"><button class="principal" id="secteur-ok">Enregistrer le secteur</button><button id="secteur-annuler">Annuler</button></div>`;
  z.scrollIntoView({ block: 'nearest' });
  $('#filtre-secteur').oninput = (e) => { const t = e.target.value.toLowerCase(); z.querySelectorAll('[data-nom]').forEach((l) => (l.hidden = t && !l.dataset.nom.includes(t))); };
  $('#secteur-annuler').onclick = () => (z.innerHTML = '');
  $('#secteur-ok').onclick = async () => {
    const l = [...z.querySelectorAll('input[type=checkbox]:checked')].map((i) => i.value).concat($('#secteur-autres').value.split(/[\s,;]+/).filter(Boolean));
    try { await postJson(`/api/comptes/${c.id}`, { noeuds: l }); z.innerHTML = ''; fini(); } catch (e) { $('#retour-comptes').textContent = e.message; }
  };
}
const ACTIONS_AUDIT = [
  [/admin-noeuds\/taches\/[^/]+\/relancer/, 'Programmation relancée'], [/admin-noeuds\/taches\/[^/]+\/arreter/, 'Programmation arrêtée'], [/admin-noeuds\/taches$/, 'Programmation à distance (Meshtastic)'],
  [/mc\/admin\/taches/, 'Administration MeshCore'], [/mc\/admin\/mot-de-passe/, 'Mot de passe MeshCore mémorisé'], [/compte\/deux-facteurs\/activer/, 'Double authentification activée'],
  [/compte\/deux-facteurs\/retirer/, 'Double authentification retirée'], [/compte\/deux-facteurs\/preparer/, 'Double authentification : QR code affiché'], [/compte\/deconnecter-partout/, 'Autres sessions fermées'],
  [/compte\/mot-de-passe/, 'Mot de passe changé'], [/^DELETE \/api\/comptes/, 'Compte supprimé'], [/\/api\/comptes\/\d+/, 'Compte modifié'], [/\/api\/comptes$/, 'Compte créé'],
  [/installation$/, 'Fiche d’installation'], [/a-faire$/, 'Note « à faire sur place »'], [/sauvegardes\/restaurer/, 'Sauvegarde restaurée'], [/\/api\/sauvegardes$/, 'Sauvegarde manuelle'],
  [/traceroute\//, 'Traceroute manuel'], [/\/api\/envoi/, 'Message envoyé'], [/mc\/messages/, 'Message MeshCore envoyé'], [/federation/, 'Bulles voisines'], [/releves/, 'Relevé de terrain'],
  [/radio\/(connecter|deconnecter|modules|scanner|agents)/, 'Module radio'], [/reglages|mqtt|config/, 'Réglages'],
];
const libelleAudit = (a) => { for (const [re, l] of ACTIONS_AUDIT) if (re.test(a)) return `${l} <small class="mono">${esc(a)}</small>`; return esc(a); };
// ---- Fréquentation : visiteurs par jour, pays, pages, provenance (aucune adresse IP gardée) ----------------------
let joursFrequentation = 30;
async function rendreFrequentation(jours) {
  if (jours) joursFrequentation = jours;
  const z = $('#pan-frequentation');
  let f;
  try { f = await api('/api/frequentation?jours=' + joursFrequentation); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  const nb = (n) => Number(n || 0).toLocaleString('fr-FR');
  let noms = null;
  try { noms = new Intl.DisplayNames(['fr'], { type: 'region' }); } catch { /* navigateur ancien */ }
  const drapeau = (c) => (/^[A-Z]{2}$/.test(c) ? String.fromCodePoint(...[...c].map((x) => 0x1f1e6 + x.charCodeAt(0) - 65)) : '');
  const nomPays = (c) => (c === 'LAN' ? '🏠 Réseau local' : c === 'VPN' ? '🔒 VPN (Tailscale…)' : c === '?' ? '❔ Inconnu' : `${drapeau(c)} ${(noms && noms.of(c)) || c}`);
  const max = Math.max(1, ...f.parJour.map((x) => x.visiteurs));
  const totPays = Math.max(1, f.pays.reduce((s, x) => s + x.visiteurs, 0));
  const ligneBarre = (libelle, n, total, extra = '') => `<tr><td>${libelle}</td><td class="barre-cellule"><span class="barre-freq" style="width:${Math.max(2, Math.round((n / total) * 100))}%"></span></td><td class="nombre">${nb(n)}</td>${extra}</tr>`;
  z.innerHTML = `<div class="ligne-champs"><label>Période <select id="freq-jours">${[7, 30, 90, 365].map((j) => `<option value="${j}" ${j === f.jours ? 'selected' : ''}>${j} derniers jours</option>`).join('')}</select></label><button class="mini" id="freq-maj">↻ Actualiser</button></div>
    ${f.actif ? '' : '<div class="alerte info-lecture">Le comptage est arrêté (Réglages avancés › Services › Statistiques de fréquentation).</div>'}
    <div class="cartes-freq">
      <div class="carte-freq"><b>${nb(f.enLigne)}</b><span>en ligne maintenant</span></div>
      <div class="carte-freq"><b>${nb(f.aujourdhui.visiteurs)}</b><span>visiteurs aujourd’hui</span><small>${nb(f.aujourdhui.visites)} pages ouvertes</small></div>
      <div class="carte-freq"><b>${nb(f.total.visiteurs)}</b><span>visiteurs sur ${f.jours} jours</span><small>${nb(f.total.visites)} pages ouvertes</small></div>
      <div class="carte-freq"><b>${nb(f.pays.filter((x) => /^[A-Z]{2}$/.test(x.pays)).length)}</b><span>pays</span></div>
    </div>
    <h3>Visiteurs par jour</h3>
    <div class="histo-freq" role="img" aria-label="Visiteurs par jour">${f.parJour.map((x) => `<div class="colonne-freq" title="${new Date(x.jour + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })} : ${nb(x.visiteurs)} visiteurs, ${nb(x.visites)} pages"><span style="height:${Math.round((x.visiteurs / max) * 100)}%"></span></div>`).join('')}</div>
    <div class="axe-freq"><span>${new Date(f.parJour[0].jour + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}</span><span>aujourd’hui</span></div>
    <div class="grille-freq">
      <div><h3>Pays</h3><table class="voisins tableau-freq"><tbody>${f.pays.map((x) => ligneBarre(nomPays(x.pays), x.visiteurs, totPays)).join('') || '<tr><td class="vide">Pas encore de visite.</td></tr>'}</tbody></table></div>
      <div><h3>Pages ouvertes</h3><table class="voisins tableau-freq"><tbody>${f.pages.map((x) => ligneBarre(esc(x.page), x.visites, Math.max(1, f.total.visites))).join('') || '<tr><td class="vide">—</td></tr>'}</tbody></table>
        <h3>Venus de</h3><table class="voisins tableau-freq"><tbody>${f.provenances.map((x) => ligneBarre(`<a href="https://${esc(x.provenance)}" target="_blank" rel="noopener noreferrer">${esc(x.provenance)}</a>`, x.visites, Math.max(1, f.provenances[0].visites))).join('') || '<tr><td class="vide">Accès directs seulement (favori, adresse tapée, appli).</td></tr>'}</tbody></table></div>
    </div>
    <p class="note">Un visiteur est compté une fois par jour ; les robots (moteurs de recherche, aperçus de liens) sont ignorés. Aucune adresse IP n’est enregistrée et aucun cookie n’est posé : seuls des totaux par jour sont gardés, 400 jours. Pays : base IP to Country Lite de <a href="https://db-ip.com" target="_blank" rel="noopener">DB-IP</a> (CC BY 4.0), consultée sur le serveur${f.geo.etat === 'prête' ? '' : ` — <b>${esc(f.geo.etat)}</b>${f.geo.etat === 'absente' ? ' (téléchargement automatique dans les minutes qui suivent le démarrage)' : ''}`}.</p>`;
  $('#freq-jours').onchange = (e) => rendreFrequentation(Number(e.target.value));
  $('#freq-maj').onclick = () => rendreFrequentation();
}
async function rendreJournal(filtre) {
  const z = $('#pan-journal');
  let l;
  try { l = await api('/api/audit?limite=500' + (filtre ? '&action=' + encodeURIComponent(filtre) : '')); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  let bl = [];
  try { bl = await api('/api/securite/blocages'); } catch { /* ignoré */ }
  const blocs = bl.length ? `<h3>🔒 Blocages et échecs récents</h3>
    <table class="voisins"><thead><tr><th>Adresse ou compte</th><th>État</th><th></th></tr></thead><tbody>
    ${bl.map((x) => `<tr class="${x.bloqueJusqua ? 'refus' : ''}"><td>${x.type === 'ip' ? '🌐 ' : '👤 '}<span class="mono">${esc(x.valeur)}</span></td><td>${x.bloqueJusqua ? `bloqué jusqu’à ${new Date(x.bloqueJusqua).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}${x.niveau > 1 ? ` (${x.niveau}ᵉ blocage)` : ''}` : `${x.echecs} échec${x.echecs > 1 ? 's' : ''} récent${x.echecs > 1 ? 's' : ''}`}</td><td><button class="mini" data-debloquer="${esc(x.cle)}">Débloquer</button></td></tr>`).join('')}
    </tbody></table>` : '<p class="note">🔒 Aucun blocage en cours.</p>';
  z.innerHTML = `<p class="note">Qui a fait quoi : connexions (et refus), programmation des nœuds, réglages, comptes, sauvegardes… Les mots de passe, clés et codes n’y figurent jamais. Gardé 180 jours.</p>
    <p class="note">Sécurité : après ${3} échecs de connexion en 15 min, l’adresse est bloquée 15 min (durée doublée à chaque récidive, jusqu’à 24 h) et le compte visé est suspendu 15 min.</p>
    ${blocs}
    <div class="recherche"><input id="filtre-journal" type="search" placeholder="Filtrer (ex. connexion, admin-noeuds, comptes)…" value="${esc(filtre || '')}"></div>
    <table class="voisins journal-audit"><thead><tr><th>Quand</th><th>Qui</th><th>Action</th><th>Détail</th></tr></thead><tbody>
    ${l.map((x) => `<tr class="${x.ok ? '' : 'refus'}"><td title="${new Date(x.heure).toLocaleString('fr-FR')}">${new Date(x.heure).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td><td>${esc(x.compte || '?')}<br><small>${esc(x.ip || '')}</small></td><td>${x.ok ? '' : '⛔ '}${libelleAudit(x.action)}</td><td><small>${esc(x.detail || '')}</small></td></tr>`).join('') || '<tr><td colspan="4" class="vide">Rien pour l’instant.</td></tr>'}
    </tbody></table>`;
  const fi = $('#filtre-journal');
  fi.onchange = () => rendreJournal(fi.value.trim());
  z.querySelectorAll('[data-debloquer]').forEach((b) => (b.onclick = async () => { try { await postJson('/api/securite/debloquer', { cle: b.dataset.debloquer }); } catch (e) { alert(e.message); return; } rendreJournal(filtre); }));
}
async function rendreComptes() {
  const z = $('#pan-comptes');
  let liste;
  try { liste = await api('/api/comptes'); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  // Section ADRASEC (édition française) : case par compte, ADRASEC du département et président
  const ad = await api('/api/adrasec/roles').catch(() => null);
  const caseAdrasec = (c) => {
    const r = (ad.roles || {})[c.id], gr = ad.groupes || [];
    return `<td class="col-adrasec"><div class="adrasec-compte"><label class="case" title="Membre d’une ADRASEC : ouvre la section ADRASEC (main courante, radiogoniométrie, équipes)"><input type="checkbox" data-adrasec ${r ? 'checked' : ''}> ${r && gr.length <= 1 ? esc((gr[0] || {}).nom || 'ADRASEC') : 'ADRASEC'}</label>${r && (r.groupes || []).length > 1 ? `<small class="note" title="Ce compte est membre de plusieurs ADRASEC : ses fiches et le rôle de président se règlent dans la page ADRASEC, onglet Gestion">${esc(r.groupes.map((k) => (gr.find((g) => g.code === k) || {}).nom || 'ADRASEC ' + k).join(' + '))}</small>` : r && gr.length > 1 ? `<select data-adrasec-groupe class="mini">${gr.map((g) => `<option value="${esc(g.code)}" ${g.code === r.groupe ? 'selected' : ''}>${esc(g.nom)}</option>`).join('')}</select>` : ''}${r && (r.groupes || []).length <= 1 ? `<label class="case" title="Président (responsable) de son ADRASEC : accepte les demandes, intègre les membres et gère l’ADRASEC, sans être administrateur de la carte"><input type="checkbox" data-adrasec-pres ${r.president ? 'checked' : ''}> Président</label>` : ''}</div></td>`;
  };
  const STATUTS = { actif: 'Actif', en_attente: 'À valider', desactive: 'Désactivé' };
  z.innerHTML = `
    <table class="voisins comptes"><thead><tr><th>Identifiant</th><th>Indicatif</th><th>Rôle</th>${ad ? '<th>ADRASEC</th>' : ''}<th>Statut</th><th>Dernière connexion</th><th></th></tr></thead><tbody>
    ${liste.map((c) => `<tr data-id="${c.id}">
      <td><b>${esc(c.identifiant)}</b> <button class="mini" data-fiche title="Modifier l’identifiant, l’indicatif ou l’e-mail de ce compte">✏️</button>${c.email ? `<br><small>${esc(c.email)}</small>` : ''}</td><td>${esc(c.indicatif || '–')}</td>
      <td><select data-role>${['membre', 'gestionnaire', 'admin'].map((r) => `<option value="${r}" ${c.role === r ? 'selected' : ''}>${ROLES_COMPTE[r]}</option>`).join('')}</select>${c.role === 'gestionnaire' ? `<br><button class="mini" data-secteur>Secteur : ${(c.noeuds || []).length} nœud(s)…</button>` : ''}</td>
      ${ad ? caseAdrasec(c) : ''}
      <td><span class="badge ${c.statut === 'actif' ? 'actif' : c.statut === 'en_attente' ? 'attente' : 'inactif'}">${STATUTS[c.statut] || c.statut}</span>${c.deuxFacteurs ? ' <span class="badge actif" title="Double authentification activée">2FA</span>' : ''}${c.reinitDemande ? `<br><span class="badge attente" title="Demande faite le ${new Date(c.reinitDemande).toLocaleString()}">🔑 mot de passe oublié</span>` : ''}</td>
      <td>${c.derniere ? ilYa(c.derniere) : 'jamais'}</td>
      <td class="actions-ligne">${c.statut === 'en_attente' ? '<button data-statut="actif" class="principal">Valider</button>' : c.statut === 'actif' ? '<button data-statut="desactive">Désactiver</button>' : '<button data-statut="actif">Réactiver</button>'}<button data-lien-mdp class="${c.reinitDemande ? 'principal' : ''}" title="Mot de passe oublié : créer un lien (24 h, usage unique) pour que cette personne choisisse un nouveau mot de passe">🔑 Lien</button>${c.deuxFacteurs ? '<button data-retirer-2fa title="Téléphone perdu : retirer la double authentification de ce compte">Retirer 2FA</button>' : ''}<button data-deco title="Fermer toutes les sessions ouvertes de ce compte">Déconnecter</button><button data-suppr title="Supprimer">✕</button></td>
    </tr>`).join('')}
    </tbody></table>
    <h3>Ajouter un compte</h3>
    <form id="form-ajout-compte" class="parametres compact">
      <label>Identifiant <input name="identifiant" required minlength="3" maxlength="32" placeholder="pseudo ou NOM Prénom"></label>
      <label>Indicatif <input data-notion="indicatif" name="indicatif"></label>
      <label>Mot de passe provisoire <input name="motDePasse" type="password" required minlength="8" autocomplete="new-password"></label>
      <label>Rôle <select name="role"><option value="membre">Membre</option><option value="gestionnaire">Gestionnaire de secteur</option><option value="admin">Administrateur</option></select></label>
      <button type="submit">Créer</button>
    </form>
    <p class="erreur" id="retour-comptes"></p>
    <div id="edition-secteur"></div>
    <p class="note">Un <b>membre</b> voit les messages texte et les positions exactes. Un <b>gestionnaire de secteur</b> programme à distance, remplit la fiche d’installation et teste (traceroute) les seuls nœuds de son secteur, Meshtastic ou MeshCore. Un <b>administrateur</b> gère en plus les comptes, les réglages, les modules et tous les nœuds.</p>
    ${ad ? '<p class="note">ADRASEC : la case ouvre la section ADRASEC au compte. Président : il gère son ADRASEC et en intègre les membres.</p>' : ''}`;
  const retour = (t) => ($('#retour-comptes').textContent = t);
  const action = async (fn) => { try { await fn(); rendreComptes(); } catch (e) { retour(e.message); } };
  // Enregistre toutes les fiches ouvertes d'un coup (plusieurs noms changés avant de cliquer : aucun n'est perdu)
  async function enregistrerFiches() {
    const erreurs = [];
    for (const tr of z.querySelectorAll('tr[data-id]')) {
      const ident = tr.querySelector('.fiche-ident');
      if (!ident) continue;
      try { await postJson(`/api/comptes/${tr.dataset.id}`, { identifiant: ident.value, email: tr.querySelector('.fiche-email').value, indicatif: tr.querySelector('.fiche-ind').value }); }
      catch (e) { erreurs.push(`${ident.value} : ${e.message}`); }
    }
    await rendreComptes();
    if (erreurs.length) retour(erreurs.join(' · '));
  }
  z.querySelectorAll('tr[data-id]').forEach((tr) => {
    const id = tr.dataset.id;
    tr.querySelector('[data-role]').onchange = (e) => action(() => postJson(`/api/comptes/${id}`, { role: e.target.value }));
    const bs = tr.querySelector('[data-statut]');
    if (bs) bs.onclick = () => action(() => postJson(`/api/comptes/${id}`, { statut: bs.dataset.statut }));
    tr.querySelector('[data-suppr]').onclick = async () => { if ((await confirmer('Supprimer ce compte ?'))) action(() => postJson(`/api/comptes/${id}`, {}, 'DELETE')); };
    const b2f = tr.querySelector('[data-retirer-2fa]');
    if (b2f) b2f.onclick = async () => { if ((await confirmer('Retirer la double authentification de ce compte ?'))) action(() => postJson(`/api/comptes/${id}`, { retirerDeuxFacteurs: true })); };
    tr.querySelector('[data-deco]').onclick = () => action(() => postJson(`/api/comptes/${id}`, { deconnecter: true }));
    // Fiche du compte : identifiant (ex. « DELAGE Fabrice »), indicatif, e-mail
    tr.querySelector('[data-fiche]').onclick = () => {
      const c = liste.find((x) => String(x.id) === String(id)) || {};
      const td = tr.querySelector('td'), td2 = td.nextElementSibling;
      td.innerHTML = `<input class="fiche-ident" value="${esc(c.identifiant)}" maxlength="32" title="Identifiant de connexion : pseudo ou NOM Prénom"><input data-notion="email" class="fiche-email" type="email" value="${esc(c.email || '')}" placeholder="e-mail" maxlength="120">`;
      td2.innerHTML = `<input data-notion="indicatif" class="fiche-ind" value="${esc(c.indicatif || '')}" placeholder="F4ABC" maxlength="16"><div class="actions-fiche"><button class="mini bouton-enregistrer" data-ok>✔ Enregistrer</button><button class="mini" data-annuler>Annuler</button></div>`;
      td.querySelector('.fiche-ident').focus();
      td2.querySelector('[data-annuler]').onclick = () => rendreComptes();
      td2.querySelector('[data-ok]').onclick = enregistrerFiches;
      // Entrée enregistre, Échap annule
      for (const ch of tr.querySelectorAll('.fiche-ident, .fiche-email, .fiche-ind')) ch.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); enregistrerFiches(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); rendreComptes(); } };
    };
    // Mot de passe oublié : lien à usage unique (24 h), que l'administrateur transmet lui-même
    tr.querySelector('[data-lien-mdp]').onclick = async () => {
      try {
        const r = await postJson(`/api/comptes/${id}`, { lienReinit: true });
        const lien = location.origin + '/?reinit=' + r.jeton, c = liste.find((x) => String(x.id) === String(id)) || {};
        let boite = z.querySelector('.lien-mdp');
        if (!boite) { boite = document.createElement('div'); boite.className = ['lien-mdp', 'alerte', 'info-lecture'].join(' '); z.prepend(boite); }
        boite.innerHTML = `<b>🔑 Lien de nouveau mot de passe pour ${esc(c.identifiant || '')}</b><br><small>Valable 24 h, une seule fois. Transmettez-le à cette personne (SMS, e-mail, messagerie) ; elle y choisira son nouveau mot de passe.</small>
          <div class="ligne-lien"><input class="mono" readonly value="${esc(lien)}"><button class="mini principal">Copier</button></div>`;
        const champ = boite.querySelector('input'), bc = boite.querySelector('button');
        bc.onclick = async () => { try { await navigator.clipboard.writeText(lien); bc.textContent = '✔ Copié'; } catch { champ.select(); document.execCommand('copy'); bc.textContent = '✔ Copié'; } };
        champ.onfocus = () => champ.select();
        boite.scrollIntoView({ block: 'nearest' });
      } catch (e) { alert(e.message); }
    };
    const ca = tr.querySelector('[data-adrasec]');
    if (ca) {
      const r = (ad.roles || {})[id], groupe = () => (tr.querySelector('[data-adrasec-groupe]') || {}).value || (r && r.groupe) || 'AUTO';
      const envoyer = (corps) => action(() => postJson(`/api/adrasec/roles/${id}`, corps, 'PUT'));
      ca.onchange = () => envoyer(ca.checked ? { groupe: 'AUTO' } : { groupe: '' });
      const sg = tr.querySelector('[data-adrasec-groupe]'); if (sg) sg.onchange = () => envoyer({ groupe: sg.value });
      const cp = tr.querySelector('[data-adrasec-pres]'); if (cp) cp.onchange = () => envoyer({ groupe: groupe(), president: cp.checked });
    }
    const bsec = tr.querySelector('[data-secteur]');
    if (bsec) bsec.onclick = () => editerSecteur(liste.find((c) => String(c.id) === id), () => rendreComptes());
  });
  $('#form-ajout-compte').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    action(() => postJson('/api/comptes', { identifiant: f.identifiant.value, indicatif: f.indicatif.value, motDePasse: f.motDePasse.value, role: f.role.value }));
  };
}
async function rendreReglages() {
  const z = $('#pan-reglages');
  let r;
  try { r = await api('/api/reglages'); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  z.innerHTML = `
    <form id="form-reglages">
      <div class="grille-form">
        <label>Nom de la carte <input name="titre" value="${esc(r.titre)}" maxlength="80"></label>
        <label>Département <select name="departement"></select><small>Fixe la zone, le contour et le centrage de la carte (un département, une région entière, ou la France entière)</small></label>
        <div class="large-col note-source">${r.depuisPage && r.depuisPage.mqtt ? `⚠️ Le serveur MQTT est réglé ici : ces valeurs <b>remplacent celles du .env</b>${r.env && r.env.mqtt.url ? ` (MQTT_URL=${esc(r.env.mqtt.url)})` : ''}. <button type="button" class="mini" data-revenir-env="mqtt">Revenir au .env</button>` : 'ℹ️ Serveur MQTT lu dans le fichier .env. Une valeur changée ici le remplacera (le .env ne sera plus lu pour elle).'}</div>
        <label>Serveur MQTT <input data-notion="mqttUrl" name="mqttUrl" value="${esc(r.mqtt.url)}"></label>
        <label>Sujet racine <input data-notion="mqttRacine" name="mqttRacine" value="${esc(r.mqtt.racine)}"></label>
        <label>Utilisateur MQTT <input name="mqttUtilisateur" value="${esc(r.mqtt.utilisateur)}" autocomplete="off"></label>
        <label>Mot de passe MQTT <input name="mqttMotDePasse" type="password" placeholder="${r.mqtt.motDePasseDefini ? '•••••• (inchangé)' : ''}" autocomplete="new-password"></label>
        <label>Sujets supplémentaires <input data-notion="mqttSujets" name="mqttSujets" value="${esc(r.mqtt.sujetsSupplementaires)}" placeholder="séparés par des virgules"></label>
        <label>Inscriptions <select name="inscriptions">${[['validation', 'Sur validation de l’admin'], ['ouvertes', 'Ouvertes à tous'], ['fermees', 'Fermées']].map(([v, l]) => `<option value="${v}" ${r.inscriptions === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Positions publiques <select name="precisionPublique">${[[3, 'Arrondies à ≈ 100 m'], [2, 'Arrondies à ≈ 1 km'], [4, 'Arrondies à ≈ 10 m'], [-1, 'Exactes']].map(([v, l]) => `<option value="${v}" ${r.precisionPublique === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Conservation (jours) <input name="retentionJours" type="number" min="1" max="90" value="${r.retentionJours}"></label>
        <label class="large-col">Canaux à déchiffrer <textarea name="canaux" rows="5">${esc(r.canaux)}</textarea><small>Un canal par ligne : nom=clé en base64${r.depuisPage && r.depuisPage.canaux ? ' · réglés ici, ils remplacent CANAUX du .env <button type="button" class="mini" data-revenir-env="canaux">Revenir au .env</button>' : ' · lus dans le .env tant qu’ils ne sont pas changés ici'}</small></label>
      </div>
      <p class="erreur" id="retour-reglages"></p>
      <div class="actions"><button type="submit" class="principal">Enregistrer et redémarrer</button></div>
      <p class="note">L’enregistrement redémarre le service (une dizaine de secondes). Un changement de département ou de région retélécharge le relief IGN (quelques minutes pour un département, nettement plus pour une région entière). ⚠️ Pour la France entière, prévoir plusieurs heures de téléchargement IGN la première fois et plusieurs centaines de Mo de RAM : à réserver à un serveur dimensionné pour.</p>
    </form>
    <div class="bloc-france" id="bloc-france"></div>`;
  rendreFrance();
  optionsDepartements(z.querySelector('[name=departement]'), r.departement.code);
  z.querySelectorAll('[data-revenir-env]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmer('Reprendre les valeurs du fichier .env pour ce réglage ? Le service redémarre.'))) return;
    try { const x = await postJson('/api/reglages', { revenirEnv: [b.dataset.revenirEnv] }); if (x.redemarrage) attendreRedemarrage('Réglages du .env repris ✓'); } catch (err) { alert(err.message); }
  }));
  $('#form-reglages').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const corps = {
      titre: f.titre.value, inscriptions: f.inscriptions.value, precisionPublique: Number(f.precisionPublique.value), retentionJours: Number(f.retentionJours.value), canaux: f.canaux.value,
      mqtt: { url: f.mqttUrl.value, racine: f.mqttRacine.value, utilisateur: f.mqttUtilisateur.value, motDePasse: f.mqttMotDePasse.value, sujetsSupplementaires: f.mqttSujets.value },
    };
    if (f.departement.value !== r.departement.code) corps.departement = f.departement.value;
    try { await postJson('/api/reglages', corps); $('#dlg-gestion').close(); attendreRedemarrage('Réglages enregistrés'); }
    catch (x) { $('#retour-reglages').textContent = x.message; }
  };
}
// Carte publique : couverture sur le département de la carte ou sur toute la France, préparation du relief
// Toute la France (administrateur) : la même chose que dans Réglages, en accès direct depuis Outils
function ficheFrance() {
  $('#fiche').hidden = false; etat.selection = null;
  $('#fiche-contenu').innerHTML = '<div class="bloc-france" id="bloc-france"><div class="vide">Chargement…</div></div>';
  rendreFrance();
}
async function rendreFrance() {
  const z = $('#bloc-france');
  if (!z) return;
  let r;
  try { r = await api('/api/relief/france'); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  const p = r.precharge;
  const duree = p.debut ? Math.round(((p.fin || Date.now()) - p.debut) / 60000) : 0;
  z.innerHTML = `<h3>🗺️ Carte publique et relief</h3>
    <label>Calculs de couverture de la carte publique <select id="fr-couv">
      <option value="departement" ${r.couverture === 'departement' ? 'selected' : ''}>Département de la carte seulement (léger)</option>
      <option value="france" ${r.couverture === 'france' ? 'selected' : ''}>Tous les départements de France (relief chargé à la demande)</option></select></label>
    <p class="note">Avec « tous les départements », chaque visiteur peut calculer la couverture, les emplacements de relais et la couverture d’un point dans n’importe quel département. Le premier calcul d’un département télécharge son relief IGN et ses points hauts (quelques minutes), sauf s’il a été préparé ci-dessous.</p>
    <div class="actions-prop">${p.enCours ? '<button class="mini" id="fr-stop">⏹ Arrêter la préparation</button>' : '<button class="mini principal" id="fr-go" title="Installe le paquet « relief France » puis complète département par département ; la carte publique passe ensuite d’elle-même en « tous les départements »">⬇ Télécharger et installer toute la France</button>'}<span class="note">Relief prêt sur le serveur : <b>${r.surDisque}</b> <span>sur ${r.total} départements</span></span></div>
    ${p.enCours ? `<div class="alerte info-lecture"><span class="sablier"></span> Préparation en cours : ${p.faits}/${p.total} départements${p.courant ? ` · département ${esc(p.courant === 'paquet' ? 'paquet GitHub' : p.courant)}${p.etape ? ' : ' + esc(p.etape) : ''}` : p.etape ? ' · ' + esc(p.etape) : ''} · ${duree} min${p.faits > p.deja + 1 && p.total > p.faits ? `, encore ≈ ${Math.round(((Date.now() - p.debut) / 60000 / Math.max(1, p.faits - p.deja)) * (p.total - p.faits) / 60)} h` : ''}. Elle continue même si vous fermez cette page.</div>` : p.fin ? `<p class="note">Dernière préparation : ${p.faits}/${p.total} départements en ${duree} min${p.erreurs.length ? `, ${p.erreurs.length} erreur(s) : ${p.erreurs.slice(0, 5).map((x) => esc(x.code + ' ' + x.erreur)).join(' ; ')}` : ''}.${p.aCompleter && p.aCompleter.length ? ` Points hauts OpenStreetMap manquants pour ${p.aCompleter.length} département(s) (${esc(p.aCompleter.slice(0, 12).join(', '))}${p.aCompleter.length > 12 ? '…' : ''}) : relancez la préparation plus tard, seuls ceux-là seront repris.` : ''}</p>` : ''}
    <p class="note">La préparation installe d’abord le paquet « relief France » publié sur GitHub (≈ 110 Mo, quelques minutes), puis télécharge département par département ce qui manque encore : relief IGN, points hauts, voies d’accès et sites (OpenStreetMap). Sans paquet, comptez plusieurs heures. Environ 250 Mo sur le disque. Les départements déjà prêts sont sautés.</p>
    <details class="note"><summary>Pour le mainteneur du projet : exporter le paquet « relief France »</summary>
      <p>Inutile pour faire marcher votre carte. Ce bouton rassemble en un seul fichier (tar.gz) le relief de tous les départements déjà prêts sur ce serveur, pour le publier sur GitHub comme paquet « relief-france » : c’est ce paquet que les autres cartes téléchargent avec le bouton ci-dessus.</p>
      <div class="actions-prop"><a class="mini bouton-lien" href="/api/relief/france/paquet" download>📦 Exporter le paquet (tar.gz)</a></div></details>`;
  z.insertAdjacentHTML('beforeend', '<div id="bloc-cache-relief"></div><div id="bloc-fond-hl"></div>');
  rendreCacheRelief();
  rendreFondHorsLigne();
  $('#fr-couv').onchange = async (e) => { try { await postJson('/api/relief/france', { couverture: e.target.value }); } catch (x) { alert(x.message); } rendreFrance(); };
  const go = $('#fr-go'); if (go) go.onclick = async () => { try { await postJson('/api/relief/france', { precharger: true, activer: true }); } catch (x) { alert(x.message); } setTimeout(rendreFrance, 800); };
  const st = $('#fr-stop'); if (st) st.onclick = async () => { try { await postJson('/api/relief/france', { precharger: false }); } catch (x) { alert(x.message); } setTimeout(rendreFrance, 800); };
  if (p.enCours) { clearTimeout(etat.minuterieFrance); etat.minuterieFrance = setTimeout(() => { if ($('#bloc-france')) rendreFrance(); }, 15000); }
}
// Relief téléchargé sur le serveur : espace occupé, purge (tout, par zone, par ancienneté), plafond, relief mondial
const tailleDisque = (o) => (o >= 1e9 ? fmt(o / 1e9, 1, ' Go') : o >= 1e6 ? fmt(o / 1e6, 0, ' Mo') : fmt(o / 1e3, 0, ' ko'));
async function rendreCacheRelief(message) {
  const z = $('#bloc-cache-relief');
  if (!z) return;
  let r;
  try { r = await api('/api/relief/cache'); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  const g = r.grossier || {};
  const etatG = g.statut === 'pret' ? `✔ prêt (${tailleDisque(g.octets || 0)})` : g.enCours || g.statut === 'chargement' ? `<span class="sablier"></span> téléchargement ${g.progression || 0} %` : g.statut === 'erreur' ? `échec : ${esc(g.erreur || '?')} (nouvel essai toutes les heures)` : 'pas encore téléchargé';
  const ligneZone = (x) => `<tr><td><b>${esc(x.code)}</b>${x.nom ? ` <small>${esc(x.nom)}</small>` : ''}</td><td class="num">${tailleDisque(x.octets)}</td><td>${x.derniere ? ilYa(x.derniere) : '–'}</td>
    <td>${x.verrou ? '<span class="sablier"></span> en chargement' : x.recente ? 'utilisée à l’instant' : x.enMemoire ? 'ouverte' : ''}</td>
    <td><button class="mini" data-purger-zone="${esc(x.code)}" ${x.verrou || x.recente ? 'disabled' : ''}>🗑 Supprimer</button></td></tr>`;
  z.innerHTML = `<h3>💾 Relief téléchargé sur ce serveur</h3>
    <p class="note">Espace occupé : <b>${tailleDisque(r.totalOctets)}</b> · ${r.nbZones} zone(s) téléchargée(s) : ${tailleDisque(r.zonesOctets)} · zone de la carte : ${tailleDisque(r.principale.octets)}${g.octets ? ` · relief mondial : ${tailleDisque(g.octets)}` : ''}. Une zone supprimée se retélécharge toute seule au prochain calcul.</p>
    ${message ? `<div class="alerte info-lecture">${esc(message)}</div>` : ''}
    <label class="case"><input type="checkbox" id="cr-grossier" ${g.actif ? 'checked' : ''}> Relief approximatif du monde entier pendant les chargements</label>
    <p class="note">Un relief grossier de toute la Terre (≈ ${fmt(g.resolutionKm || 9.3, 0, ' km')}, ${esc(g.source || 'NOAA ETOPO1')}, ≈ 19 Mo, téléchargé une seule fois) : pendant que le relief précis d’une zone se télécharge, la couverture s’affiche déjà, marquée « approximative », puis se recalcule sur le relief précis. État : ${etatG}.</p>
    <div class="actions-prop">${g.actif && g.statut !== 'pret' && !g.enCours ? '<button class="mini" id="cr-dl-grossier">⬇ Télécharger le relief mondial maintenant</button>' : ''}${g.octets ? '<button class="mini" id="cr-suppr-grossier">🗑 Supprimer le relief mondial</button>' : ''}</div>
    <div class="parametres compact"><label>Garder au plus (Go) <input id="cr-plafond" type="number" min="0" max="10000" step="0.5" value="${r.plafondGo || 0}"></label><button class="mini" id="cr-plafond-ok">Enregistrer</button></div>
    <p class="note">0 = sans limite. Au-delà, les zones les moins récemment utilisées sont supprimées d’elles-mêmes (jamais la zone de la carte, ni une zone en cours d’utilisation).</p>
    <div class="actions-prop"><label>Zones inutilisées depuis <input id="cr-jours" type="number" min="1" max="3650" step="1" value="30" class="mini-h"> jours</label><button class="mini" id="cr-vieilles">🧹 Purger</button><button class="mini" id="cr-tout" ${r.nbZones ? '' : 'disabled'}>🗑 Tout purger</button></div>
    ${r.zones.length ? `<details class="note"><summary>Détail des ${r.zones.length} zone(s)</summary><table class="voisins"><thead><tr><th>Zone</th><th class="num">Taille</th><th>Dernière utilisation</th><th></th><th></th></tr></thead><tbody>${r.zones.map(ligneZone).join('')}</tbody></table></details>` : ''}`;
  const envoyer = async (corps, question) => {
    if (question && !confirm(question)) return;
    let rep;
    try { rep = await postJson('/api/relief/cache', corps); } catch (e) { alert(e.message); return; }
    const p = rep.purge;
    rendreCacheRelief(p ? `${p.supprimees.length} élément(s) supprimé(s), ${tailleDisque(p.octetsLiberes)} libérés${p.refusees.length ? ` · ${p.refusees.length} zone(s) gardée(s) car en cours d’utilisation (${p.refusees.map((x) => x.code).join(', ')})` : ''}.` : 'Réglage enregistré.');
  };
  $('#cr-grossier').onchange = (e) => envoyer({ grossier: e.target.checked });
  const dl = $('#cr-dl-grossier'); if (dl) dl.onclick = () => envoyer({ telechargerGrossier: true });
  const sg = $('#cr-suppr-grossier'); if (sg) sg.onclick = () => envoyer({ purger: { grossier: true } }, 'Supprimer le relief approximatif du monde entier ? L’option sera décochée en même temps (sinon il serait retéléchargé dans l’heure, ≈ 19 Mo).');
  $('#cr-plafond-ok').onclick = () => envoyer({ plafondGo: Number($('#cr-plafond').value) || 0 });
  $('#cr-vieilles').onclick = () => { const j = Math.max(1, Number($('#cr-jours').value) || 30); envoyer({ purger: { joursInactifs: j } }, `Supprimer le relief des zones inutilisées depuis ${j} jours ?`); };
  $('#cr-tout').onclick = () => envoyer({ purger: { tout: true } }, `Supprimer le relief des ${r.nbZones} zone(s) téléchargée(s) (${tailleDisque(r.zonesOctets)}) ? La zone de la carte et le relief mondial sont gardés.`);
  z.querySelectorAll('[data-purger-zone]').forEach((b) => (b.onclick = () => envoyer({ purger: { codes: [b.dataset.purgerZone] } }, `Supprimer le relief de la zone ${b.dataset.purgerZone} ?`)));
  if (g.enCours) { clearTimeout(etat.minuterieCacheRelief); etat.minuterieCacheRelief = setTimeout(() => { if ($('#bloc-cache-relief')) rendreCacheRelief(); }, 5000); }
}
// Fond de carte hors ligne : carte vectorielle OpenStreetMap du département gardée sur le serveur (Raspberry Pi
// autonome, coupure d'internet), et relief ombré calculé sur place
async function rendreFondHorsLigne() {
  const z = $('#bloc-fond-hl');
  if (!z) return;
  let r;
  try { r = await api('/api/fond-hors-ligne'); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  const f = r.fond, c = r.enCours;
  z.innerHTML = `<h3>📴 Fond de carte hors ligne</h3>
    <p class="note">Une carte OpenStreetMap complète (routes, chemins, noms, rivières, forêts) gardée sur ce serveur : elle s’affiche sans internet, idéal pour une installation autonome (Raspberry Pi) ou en cas de coupure. Fonds « Hors ligne · clair / sombre » dans Couches, et « Relief ombré (hors ligne) », calculé à partir du relief déjà préparé.</p>
    ${f ? `<div class="alerte info-lecture">✔ Fond prêt : <b>${esc(f.nom)}</b> · zoom ${f.maxzoom} · ${f.tailleMo} Mo · ${ilYa(f.date)}. Mis à jour chaque mois automatiquement. Rechargez la page pour le voir dans Couches.</div>` : ''}
    ${c.actif ? `<div class="alerte info-lecture"><span class="sablier"></span> Téléchargement : ${esc(c.etape || '…')} <button class="mini" id="fhl-stop">⏹ Arrêter</button></div>` : ''}
    ${c.erreur && !c.actif ? `<div class="alerte attention">Dernier essai : ${esc(c.erreur)}</div>` : ''}
    ${!r.outil ? '<div class="alerte attention">L’outil d’extraction « pmtiles » manque sur ce serveur : il est inclus dans l’image Docker à partir de la version 2.25 (mettez la carte à jour).</div>' : ''}
    <div class="parametres">
      <label>Zone <select id="fhl-zone">
        <option value="departement">Département de la carte (≈ 50 Mo)</option>
        <option value="voisins" selected>Département et alentours (≈ 120 Mo)</option>
        <option value="france">France entière (3 à 5 Go)</option></select></label>
      <label>Détail <select id="fhl-zoom">
        <option value="13">Zoom 13 : routes et villages (léger)</option>
        <option value="14" selected>Zoom 14 : chemins, lieux-dits</option>
        <option value="15">Zoom 15 : tout, bâtiments (≈ × 2)</option></select></label>
    </div>
    <div class="actions-prop"><button class="mini principal" id="fhl-go" ${c.actif || !r.outil ? 'disabled' : ''}>⬇ ${f ? 'Remplacer le fond' : 'Télécharger le fond hors ligne'}</button>${f ? '<button class="mini" id="fhl-suppr">Supprimer</button>' : ''}</div>
    <p class="note">Données © contributeurs OpenStreetMap (ODbL), carte Protomaps. Seule la zone choisie est téléchargée (quelques secondes à quelques minutes).</p>`;
  const go = $('#fhl-go'); if (go) go.onclick = async () => { try { await postJson('/api/fond-hors-ligne', { zone: $('#fhl-zone').value, maxzoom: Number($('#fhl-zoom').value) }); } catch (x) { alert(x.message); } rendreFondHorsLigne(); };
  const st = $('#fhl-stop'); if (st) st.onclick = async () => { await postJson('/api/fond-hors-ligne', { action: 'arreter' }).catch(() => {}); rendreFondHorsLigne(); };
  const sp = $('#fhl-suppr'); if (sp) sp.onclick = async () => { if (!confirm('Supprimer le fond hors ligne de ce serveur ?')) return; await postJson('/api/fond-hors-ligne', { action: 'supprimer' }).catch((x) => alert(x.message)); rendreFondHorsLigne(); };
  if (c.actif) { clearTimeout(etat.minuterieFhl); etat.minuterieFhl = setTimeout(() => { if ($('#bloc-fond-hl')) rendreFondHorsLigne(); }, 3000); }
}

// ---- Passerelle inter-réseaux Meshtastic ⇄ MeshCore (PASSERELLE=1 dans le .env, administrateurs) ----
async function ouvrirPasserelle() {
  const dlg = $('#dlg-passerelle');
  if (!dlg.open) dlg.showModal();
  dlg.querySelectorAll('[data-pp]').forEach((b) => (b.onclick = () => { pp.onglet = b.dataset.pp; dlg.querySelectorAll('[data-pp]').forEach((x) => x.classList.toggle('actif', x === b)); rendrePasserelle(true); }));
  $('#fermer-passerelle').onclick = () => dlg.close();
  dlg.addEventListener('close', () => { clearInterval(pp.minuterie); pp.minuterie = null; }, { once: true });
  // Aucune liaison encore : on ouvre directement l'onglet Règles
  try { const d = await api('/api/passerelle'); if (!d.regles.length) ppOnglet('regles'); else ppOnglet(pp.onglet); } catch { /* affiché plus bas */ }
  await rendrePasserelle(true);
  clearInterval(pp.minuterie);
  pp.minuterie = setInterval(() => { if (pp.onglet === 'bord' && !document.hidden) rendrePasserelle(false); }, 3000);
}
const ppSens = { mt2mc: 'MT → MC', mc2mt: 'MC → MT', bi: 'MT ⇄ MC' };
function ppOnglet(o) { pp.onglet = o; document.querySelectorAll('#dlg-passerelle [data-pp]').forEach((x) => x.classList.toggle('actif', x.dataset.pp === o)); }
async function rendrePasserelle(complet) {
  const z = $('#pp-contenu');
  try { pp.donnees = await api('/api/passerelle'); } catch (e) { z.innerHTML = `<div class="vide">${esc(e.message)}</div>`; return; }
  const d = pp.donnees, m = d.modules, g = d.reglages;
  const pastille = (ok, txt) => `<span class="badge ${ok ? 'actif' : 'inactif'}">${ok ? '●' : '○'} ${esc(txt)}</span>`;
  const entete = `<div class="pp-etat">${pastille(m.mt.connecte, 'Meshtastic : ' + (m.mt.connecte ? m.mt.nom || 'module principal' : 'module hors ligne'))}${pastille(m.mc.connecte, 'MeshCore : ' + (m.mc.connecte ? m.mc.nom || 'companion' : 'companion hors ligne'))}
    ${d.actif ? `<button class="mini ${g.pause ? 'principal' : ''}" id="pp-pause">${g.pause ? '▶ Reprendre la passerelle' : '⏸ Mettre en pause'}</button><button class="mini danger" id="pp-desactiver" title="Coupe complètement la passerelle (les règles sont gardées)">⏻ Désactiver</button>` : ''}</div>
    ${!d.actif ? `<div class="alerte attention pp-off"><b>Passerelle désactivée</b> : aucun message n’est relayé entre Meshtastic et MeshCore. Vous pouvez préparer les règles avant de l’activer.
      <div class="actions-prop"><button class="principal" id="pp-activer">⏻ Activer la passerelle</button></div></div>` : g.pause ? '<div class="alerte attention">Passerelle en pause : aucun message n’est relayé.</div>' : ''}`;
  if (pp.onglet === 'bord') {
    const rej = Object.entries(d.stats.rejets).sort((a, b) => b[1] - a[1]);
    const journalHtml = d.journal.slice().reverse().filter((x) => !pp.filtreJournal || x.type === pp.filtreJournal).slice(0, 150).map((x) => `<div class="${x.type}">[${new Date(x.heure).toLocaleTimeString('fr-FR')}] ${x.type === 'in' ? 'REÇU  ' : x.type === 'out' ? 'RELAYÉ' : 'IGNORÉ'} ${esc(x.texte)}${x.motif ? ` <b>(${esc(x.motif)})</b>` : ''}</div>`).join('') || '<div class="vide">Rien pour l’instant.</div>';
    if (!complet && $('#pp-journal')) { $('#pp-journal').innerHTML = journalHtml; $('#pp-c1').textContent = d.stats.mt2mc; $('#pp-c2').textContent = d.stats.mc2mt; $('#pp-c3').textContent = rej.reduce((t, x) => t + x[1], 0); return; }
    z.innerHTML = `${entete}
      <div class="pp-grille"><div class="mesure"><span>Relayés MT → MC</span><b id="pp-c1">${d.stats.mt2mc}</b></div><div class="mesure"><span>Relayés MC → MT</span><b id="pp-c2">${d.stats.mc2mt}</b></div><div class="mesure"><span>Ignorés</span><b id="pp-c3">${rej.reduce((t, x) => t + x[1], 0)}</b></div></div>
      <p class="note">Depuis ${ilYa(d.stats.depuis).replace('il y a ', '')}${d.stats.agreges ? ` · ${d.stats.agreges} message(s) regroupé(s)` : ''}${rej.length ? ' · ignorés : ' + rej.map(([k, v]) => `${esc(k)} ${v}`).join(', ') : ''}.</p>
      <p class="note">${d.regles.filter((x) => x.actif).length} règle(s) active(s) sur ${d.regles.length}. ${d.regles.length ? d.regles.map((x) => `<b>${esc(x.libelle)}</b>${x.actif ? '' : ' (suspendue)'}`).join(' · ') : 'Aucune liaison : '}${'<button class="mini principal" id="pp-aller-liaisons">🔗 Choisir les canaux à relier</button>'}</p>
      <h3>Journal en direct <select id="pp-filtre" class="mini"><option value="">tout</option><option value="in">reçus</option><option value="out">relayés</option><option value="drop">ignorés</option></select></h3>
      <div class="pp-journal" id="pp-journal">${journalHtml}</div>`;
    $('#pp-filtre').value = pp.filtreJournal;
    $('#pp-filtre').onchange = (e) => { pp.filtreJournal = e.target.value; rendrePasserelle(true); };
  } else if (pp.onglet === 'regles') {
    // Chaque côté : canaux du module (ou, s'il n'est pas relié, canaux connus de la carte) + saisie libre d'un nom
    const col = (liste, cote) => {
      const choix = cote === 'mt' ? pp.choixMt : pp.choixMc;
      const connus = (d.canauxConnus || {})[cote] || [];
      const lignes = liste.length
        ? liste.map((c) => `<div class="pp-canal ${choix && choix.nom === c.nom ? 'sel' : ''}" data-cote="${cote}" data-index="${c.index}" data-nom="${esc(c.nom)}"><span>#${esc(c.nom)}</span><small>${cote === 'mt' ? (c.index === 0 ? 'canal 0 · principal' : 'canal ' + c.index) : 'canal ' + c.index}</small></div>`).join('')
        : `<div class="note">${cote === 'mt' ? 'Module Meshtastic principal non relié' : 'Companion MeshCore non relié'} : choisissez un canal connu de la carte ou tapez son nom. La liaison fonctionnera dès que ${cote === 'mt' ? 'le module' : 'le companion'} aura ce canal.</div>`
          + connus.map((nom) => `<div class="pp-canal ${choix && choix.nom === nom ? 'sel' : ''}" data-cote="${cote}" data-nom="${esc(nom)}"><span>#${esc(nom.replace(/^#/, ''))}</span><small>connu de la carte</small></div>`).join('');
      return lignes + `<label class="pp-saisie">Autre canal <input data-saisie-canal="${cote}" placeholder="${cote === 'mt' ? 'ex. ADRASEC43' : 'ex. #adrasec'}" value="${choix && choix.saisi ? esc(choix.nom) : ''}"></label>`;
    };
    z.innerHTML = `${entete}
      <p class="note">Choisissez un canal de chaque côté (canaux du module Meshtastic principal et du companion MeshCore), le sens, puis « Créer la liaison ». Les messages relayés partent par ces deux modules.</p>
      <div class="pp-colonnes"><div><h3>Canal Meshtastic</h3>${col(m.mt.canaux, 'mt')}</div>
        <div class="pp-sens">${Object.entries(ppSens).map(([k, v]) => `<button class="mini ${pp.sens === k ? 'actif' : ''}" data-sens="${k}">${v}</button>`).join('')}
          <label class="case"><input type="checkbox" id="pp-coal"> Regrouper (${g.coalescenceS} s)</label>
          <label class="case" title="Positions des nœuds relayées en texte avec le code DFCI : Meshtastic → paquets de position du canal ; MeshCore → annonces des companions. Au plus une toutes les ${g.positionsMin} min par nœud, et seulement s’il a bougé"><input type="checkbox" id="pp-pos"> 📍 Positions</label>
          <label class="case" title="Signalements reçus par radio (points de passage Bipper, GerMaCrise, appli Meshtastic) relayés en texte avec le code DFCI ; coordonnées d’un message complétées du code DFCI"><input type="checkbox" id="pp-sig"> ⚠️ Signalements</label>
          <button class="principal" id="pp-creer">Créer la liaison</button></div>
        <div><h3>Canal MeshCore</h3>${col(m.mc.canaux, 'mc')}</div></div>
      ${pp.choixMt || pp.choixMc ? `<p class="note pp-resume">Liaison : <b>MT #${esc(pp.choixMt ? pp.choixMt.nom : '?')}</b> ${ppSens[pp.sens] ? esc(ppSens[pp.sens]).replace(/MT|MC/g, '') : '⇄'} <b>MC ${esc(pp.choixMc ? (pp.choixMc.nom.startsWith('#') ? pp.choixMc.nom : '#' + pp.choixMc.nom) : '?')}</b></p>` : ''}
      <p class="erreur" id="pp-retour"></p>
      <h3>Règles</h3>
      ${d.regles.length ? `<table class="voisins"><thead><tr><th>Liaison</th><th>Regrouper</th><th title="Positions des nœuds, avec le code DFCI">📍</th><th title="Signalements (points de passage) et coordonnées, avec le code DFCI">⚠️</th><th>Active</th><th></th></tr></thead><tbody>${d.regles.map((x) => `<tr data-id="${x.id}"><td><b>${esc(x.libelle)}</b>${x.enAttente ? ` <small>· ${x.enAttente} en attente</small>` : ''}
        <details class="pp-filtres"><summary>Filtres${Object.values(x.filtres || {}).some((v) => v && v !== 2) ? ' (réglés)' : ''}</summary>
          <label>Expéditeurs bloqués <input data-f="expediteurs" value="${esc((x.filtres || {}).expediteurs || '')}" placeholder="noms ou !id, séparés par des virgules"></label>
          <label>Mot requis <input data-f="motRequis" value="${esc((x.filtres || {}).motRequis || '')}" placeholder="vide = tout"></label>
          <label>Mots exclus <input data-f="motExclu" value="${esc((x.filtres || {}).motExclu || '')}" placeholder="ex. !pos, !meteo"></label>
          <label>Longueur min. <input data-f="longueurMin" type="number" min="1" max="50" value="${(x.filtres || {}).longueurMin || 2}"></label>
          <label>Heures silencieuses <input data-f="silence" value="${esc((x.filtres || {}).silence || '')}" placeholder="ex. 22-7"></label>
          <button class="mini principal" data-filtres>Enregistrer les filtres</button></details></td>
        <td><input type="checkbox" data-coal ${x.coalescence ? 'checked' : ''}></td><td><input type="checkbox" data-pos title="Relayer les positions" ${x.positions ? 'checked' : ''}></td><td><input type="checkbox" data-sig title="Relayer les signalements" ${x.signalements ? 'checked' : ''}></td><td><input type="checkbox" data-actif ${x.actif ? 'checked' : ''}></td><td><button class="mini" data-suppr>✕</button></td></tr>`).join('')}</tbody></table>` : '<div class="vide">Aucune liaison : choisissez un canal de chaque côté ci-dessus, puis « Créer la liaison ».</div>'}
      <details class="pp-essai"><summary>🧪 Essayer un message (rien n’est envoyé)</summary>
        <div class="parametres compact"><label>Arrive par <select id="pe-reseau"><option value="mt">Meshtastic</option><option value="mc">MeshCore</option></select></label>
          <label>Canal <input id="pe-canal" placeholder="ADRASEC43"></label><label>Expéditeur <input id="pe-nom" value="F4XYZ"></label><label>Texte <input id="pe-texte" value="essai de liaison"></label></div>
        <div class="actions-prop"><button type="button" class="mini principal" id="pe-go">Voir ce que ferait la passerelle</button></div><div id="pe-resultat" class="note"></div></details>
      <details class="pp-profils"><summary>🗂️ Profils (${(d.profils || []).length}) : normal, crise…</summary>
        <p class="note">Un profil garde toutes les liaisons, la liste noire et les réglages. Chargez-le d’un clic pour changer de configuration.</p>
        ${(d.profils || []).map((p) => `<div class="ligne"><span class="titre">${esc(p.nom)}<small>${p.regles} liaison(s) · ${esc(p.par || '')} ${p.heure ? ilYa(p.heure) : ''}</small></span><span class="meta"><button class="mini principal" data-prof-charger="${esc(p.nom)}">Charger</button> <button class="mini" data-prof-suppr="${esc(p.nom)}">✕</button></span></div>`).join('')}
        <div class="champ-ajout"><input id="pp-prof-nom" maxlength="20" placeholder="nom du profil (ex. crise)"><button type="button" class="mini principal" id="pp-prof-enr">Enregistrer la configuration actuelle</button></div></details>`;
    { const go = $('#pe-go'); if (go) go.onclick = async () => {
      try {
        const x = await postJson('/api/passerelle/essai', { reseau: $('#pe-reseau').value, canal: $('#pe-canal').value, nom: $('#pe-nom').value, texte: $('#pe-texte').value });
        $('#pe-resultat').innerHTML = `<b>${x.relaye ? '✅ Relayé' : '❌ Pas relayé'}</b>${x.motif ? ' : ' + esc(x.motif) : ''}${(x.etapes || []).map((s) => '<br>• ' + esc(s)).join('')}${(x.sorties || []).map((s) => `<br>→ ${s.vers === 'mc' ? 'MeshCore' : 'Meshtastic'} ${esc(s.canal)} : <span class="mono">${esc(s.texte)}</span>`).join('')}`;
      } catch (e) { $('#pe-resultat').textContent = e.message; }
    }; }
    { const be = $('#pp-prof-enr'); if (be) be.onclick = async () => { try { await postJson('/api/passerelle/profils', { nom: $('#pp-prof-nom').value }); rendrePasserelle(true); } catch (e) { $('#pp-retour').textContent = e.message; } }; }
    z.querySelectorAll('[data-prof-charger]').forEach((b) => (b.onclick = async () => { if (!(await confirmer(`Charger le profil « ${b.dataset.profCharger} » ? Il remplace les liaisons, la liste noire et les réglages actuels.`, { ok: 'Charger' }))) return; try { await postJson('/api/passerelle/profils', { action: 'charger', nom: b.dataset.profCharger }); rendrePasserelle(true); } catch (e) { $('#pp-retour').textContent = e.message; } }));
    z.querySelectorAll('[data-prof-suppr]').forEach((b) => (b.onclick = async () => { await postJson('/api/passerelle/profils', { action: 'supprimer', nom: b.dataset.profSuppr }).catch(() => {}); rendrePasserelle(true); }));
    z.querySelectorAll('.pp-canal').forEach((el) => (el.onclick = () => {
      const c = { index: el.dataset.index !== undefined ? Number(el.dataset.index) : null, nom: el.dataset.nom };
      if (el.dataset.cote === 'mt') pp.choixMt = c; else pp.choixMc = c;
      rendrePasserelle(true);
    }));
    z.querySelectorAll('[data-saisie-canal]').forEach((i) => (i.onchange = () => {
      const v = i.value.trim(), c = v ? { index: null, nom: v, saisi: true } : null;
      if (i.dataset.saisieCanal === 'mt') pp.choixMt = c; else pp.choixMc = c;
      rendrePasserelle(true);
    }));
    z.querySelectorAll('[data-sens]').forEach((b) => (b.onclick = () => { pp.sens = b.dataset.sens; rendrePasserelle(true); }));
    $('#pp-creer').onclick = async () => {
      if (pp.choixMt == null || pp.choixMc == null) { $('#pp-retour').textContent = 'Choisissez un canal de chaque côté.'; return; }
      try { await postJson('/api/passerelle/regles', { mt: pp.choixMt.index, mtNom: pp.choixMt.nom, mc: pp.choixMc.index, mcNom: pp.choixMc.nom, sens: pp.sens, coalescence: $('#pp-coal').checked, positions: $('#pp-pos').checked, signalements: $('#pp-sig').checked }); pp.choixMt = pp.choixMc = null; rendrePasserelle(true); } catch (e) { $('#pp-retour').textContent = e.message; }
    };
    z.querySelectorAll('tr[data-id]').forEach((tr) => {
      const id = tr.dataset.id, maj = async (o) => { try { await postJson(`/api/passerelle/regles/${id}`, o); } catch (e) { alert(e.message); } rendrePasserelle(true); };
      tr.querySelector('[data-actif]').onchange = (e) => maj({ actif: e.target.checked });
      tr.querySelector('[data-coal]').onchange = (e) => maj({ coalescence: e.target.checked });
      tr.querySelector('[data-pos]').onchange = (e) => maj({ positions: e.target.checked });
      tr.querySelector('[data-sig]').onchange = (e) => maj({ signalements: e.target.checked });
      tr.querySelector('[data-filtres]').onclick = () => maj({ filtres: Object.fromEntries([...tr.querySelectorAll('[data-f]')].map((i) => [i.dataset.f, i.value])) });
      tr.querySelector('[data-suppr]').onclick = async () => { if (!(await confirmer('Supprimer cette liaison ?'))) return; await fetch(`/api/passerelle/regles/${id}`, { method: 'DELETE' }); rendrePasserelle(true); };
    });
  } else if (pp.onglet === 'noire') {
    const connus = [...etat.noeuds.values()].filter((n) => n.nomCourt || n.nomLong).map((n) => ({ reseau: 'mt', id: String(n.num), nom: n.nomCourt || n.nomLong, lib: `${n.nomLong || n.nomCourt} (${n.id}) — Meshtastic` }))
      .concat(typeof mc !== 'undefined' && mc.noeuds ? [...mc.noeuds.values()].filter((n) => n.nom).map((n) => ({ reseau: 'mc', id: n.nom, nom: n.nom, lib: `${n.nom} — MeshCore` })) : []);
    z.innerHTML = `${entete}
      <p class="note">Les messages de ces utilisateurs ne sont jamais relayés vers l’autre réseau, quelle que soit la règle. Ils reçoivent toujours les messages de leur propre réseau.</p>
      <div class="pp-ajout"><input list="pp-connus" id="pp-qui" placeholder="Rechercher un nœud Meshtastic ou MeshCore connu…"><datalist id="pp-connus">${connus.slice(0, 1500).map((c) => `<option value="${esc(c.lib)}"></option>`).join('')}</datalist>
        <input id="pp-motif" placeholder="Motif (facultatif)" maxlength="120"><label class="case"><input type="checkbox" id="pp-recip"> aussi dans l’autre réseau (même nom)</label><button class="principal" id="pp-bloquer">Interdire le transfert</button></div>
      <p class="erreur" id="pp-retour"></p>
      ${d.listeNoire.length ? `<table class="voisins"><thead><tr><th>Utilisateur</th><th>Réseau</th><th>Motif</th><th>Autre réseau</th><th>Ajouté</th><th></th></tr></thead><tbody>${d.listeNoire.map((b) => `<tr data-r="${b.reseau}" data-id="${esc(b.id)}"><td><b>${esc(b.nom)}</b></td><td>${b.reseau === 'mt' ? 'Meshtastic' : 'MeshCore'}</td><td>${esc(b.motif || '—')}</td><td><input type="checkbox" data-recip ${b.reciproque ? 'checked' : ''}></td><td><small>${new Date(b.ajoute).toLocaleDateString('fr-FR')}${b.par ? ' · ' + esc(b.par) : ''}</small></td><td><button class="mini" data-retirer>✕</button></td></tr>`).join('')}</tbody></table>` : '<div class="vide">Liste noire vide.</div>'}`;
    $('#pp-bloquer').onclick = async () => {
      const v = $('#pp-qui').value.trim(), c = connus.find((x) => x.lib === v);
      if (!c) { $('#pp-retour').textContent = 'Choisissez un utilisateur dans la liste des nœuds connus.'; return; }
      try { await postJson('/api/passerelle/liste-noire', { reseau: c.reseau, id: c.id, nom: c.nom, motif: $('#pp-motif').value, reciproque: $('#pp-recip').checked }); rendrePasserelle(true); } catch (e) { $('#pp-retour').textContent = e.message; }
    };
    z.querySelectorAll('tr[data-r]').forEach((tr) => {
      tr.querySelector('[data-recip]').onchange = async (e) => { await postJson('/api/passerelle/liste-noire', { modifier: true, reseau: tr.dataset.r, id: tr.dataset.id, reciproque: e.target.checked }).catch((x) => alert(x.message)); rendrePasserelle(true); };
      tr.querySelector('[data-retirer]').onclick = async () => { await postJson('/api/passerelle/liste-noire', { retirer: true, reseau: tr.dataset.r, id: tr.dataset.id }).catch((x) => alert(x.message)); rendrePasserelle(true); };
    });
  } else {
    z.innerHTML = `${entete}
      <form id="pp-form" class="grille-form">
        <label>Préfixe des messages venus de Meshtastic <input name="prefixeMt" value="${esc(g.prefixeMt)}" maxlength="10"></label>
        <label>Préfixe des messages venus de MeshCore <input name="prefixeMc" value="${esc(g.prefixeMc)}" maxlength="10"></label>
        <label class="case"><input type="checkbox" name="avecExpediteur" ${g.avecExpediteur ? 'checked' : ''}> Nom de l’expéditeur dans le préfixe ([MT|F4XYZ])</label>
        <label class="case"><input type="checkbox" name="canalPrincipalAutorise" ${g.canalPrincipalAutorise ? 'checked' : ''}> Autoriser le canal principal Meshtastic (canal 0)</label>
        <label>Anti-doublon (minutes) <input name="ttlDoublonMin" type="number" min="1" max="120" value="${g.ttlDoublonMin}"></label>
        <label>Messages par minute, par règle et par sens <input name="quotaRegleMin" type="number" min="1" max="30" value="${g.quotaRegleMin}"></label>
        <label>Messages par minute, toute la passerelle <input name="quotaGlobalMin" type="number" min="1" max="120" value="${g.quotaGlobalMin}"></label>
        <label>File d’attente max. (au-delà : les plus anciens abandonnés) <input name="fileMax" type="number" min="1" max="50" value="${g.fileMax}"></label>
        <label>Écart minimal entre deux émissions sur un réseau (s) <input name="ecartEnvoiS" type="number" min="2" max="60" value="${g.ecartEnvoiS}"></label>
        <label>Positions : une au plus par nœud toutes les (min) <input name="positionsMin" type="number" min="5" max="240" value="${g.positionsMin || 15}"></label>
        <label>Fenêtre de regroupement <select name="coalescenceS">${[10, 30, 60].map((v) => `<option value="${v}" ${g.coalescenceS === v ? 'selected' : ''}>${v} s</option>`).join('')}</select></label>
      </form>
      <div class="actions"><button class="principal" id="pp-enreg">Enregistrer</button></div><p class="erreur" id="pp-retour"></p>
      <p class="note">Toujours actifs : un message envoyé par nos propres modules n’est jamais repris (anti-écho), un texte commençant par un préfixe de passerelle n’est jamais retransmis (anti-boucle). Messages texte de canal, et selon la liaison les positions et les signalements (en texte, avec le code DFCI) ; rien n’apparaît sur la carte publique.</p>`;
    $('#pp-enreg').onclick = async () => {
      const f = $('#pp-form'), o = {};
      for (const el of f.elements) if (el.name) o[el.name] = el.type === 'checkbox' ? el.checked : el.value;
      try { await postJson('/api/passerelle/reglages', o); $('#pp-retour').textContent = ''; rendrePasserelle(true); } catch (e) { $('#pp-retour').textContent = e.message; }
    };
  }
  const activer = async (oui) => {
    if (!oui && !(await confirmer('Désactiver la passerelle ? Plus aucun message ne sera relayé ; les règles sont gardées.'))) return;
    try { await postJson('/api/passerelle/activation', { active: oui }); etat.config.passerelle = oui; } catch (e) { alert(e.message); }
    // Activée : on passe directement aux règles pour créer la liaison canal ↔ canal
    if (oui) ppOnglet('regles');
    rendrePasserelle(true);
  };
  { const b = $('#pp-activer'); if (b) b.onclick = () => activer(true); }
  { const b = $('#pp-aller-liaisons'); if (b) b.onclick = () => { ppOnglet('regles'); rendrePasserelle(true); }; }
  { const b = $('#pp-desactiver'); if (b) b.onclick = () => activer(false); }
  const bp = $('#pp-pause');
  if (bp) bp.onclick = async () => { await postJson('/api/passerelle/reglages', { pause: !g.pause }).catch((e) => alert(e.message)); rendrePasserelle(true); };
}

// ---- Registre des relais : sites, autorisations, visites, matériel, firmware --------------------------
// Recherche libre (nom, site, commune, propriétaire, notes…), filtre par département d'après la position
// retransmise, et modification groupée de l'autorisation du site (cases à cocher).
// « memo » : état à retrouver en revenant d'une fiche de nœud (recherche, département, cases cochées).
async function ficheRegistreRelais(memo) {
  $('#fiche').hidden = false; etat.selection = null;
  $('#fiche-contenu').innerHTML = '<div class="liste-signalements"><h3>🗂️ Registre des relais</h3><p class="note">Chargement…</p></div>';
  let inst = {};
  try { inst = await api('/api/installations'); } catch (e) { $('#fiche-contenu').innerHTML = `<div class="liste-signalements"><h3>🗂️ Registre des relais</h3><p class="erreur">${esc(e.message)}</p></div>`; return; }
  // Département de chaque nœud : calculé par le serveur (contours nationaux), pas dans le navigateur
  const idx = await indexDepartementsNoeuds().catch(() => null);
  // Relais et passerelles de la zone de la carte (département et voisins), plus tout nœud qui a une fiche d'installation
  const relais = [...etat.noeuds.values()].filter((n) => ((n.infrastructure || n.passerelle) && dansZone(n)) || inst[n.num]).sort((a, b) => (a.nomLong || a.nomCourt || '').localeCompare(b.nomLong || b.nomCourt || ''));
  const jours = (d) => (d ? Math.floor((Date.now() - Date.parse(d)) / 86400000) : null);
  const reg = { q: (memo && memo.q) || '', dep: (memo && memo.dep) || '', coches: new Set((memo && memo.coches) || []) };
  const depDe = (n) => (idx && idx.parNoeud ? idx.parNoeud[String(n.num >>> 0)] || null : null);
  const nomDep = (c) => { const d = idx && (idx.departements || []).find((x) => x.code === c); return (d && d.nom) || ''; };
  const peutCocher = relais.some((n) => gerable(n.num));
  // Texte où l'on cherche, accents et majuscules mis de côté : gardé par nœud (la frappe ne le recalcule pas)
  const texteCache = new Map();
  const texteCherchable = (n) => {
    let t = texteCache.get(n.num);
    if (t == null) {
      const f = inst[n.num] || {}, c = depDe(n);
      t = sansAccent([n.nomLong, n.nomCourt, n.id, n.num, n.roleFr, n.materiel, n.firmware, f.site, f.proprietaire, f.contact, f.notes, f.aFaire,
        LIB_AUTORISATION[f.autorisation], LIB_ZONE_PROTEGEE[f.zoneProtegee], LIB_ALIM[f.alimentation], c, nomDep(c)]
        .filter((x) => x != null && x !== '').join(' '));
      texteCache.set(n.num, t);
    }
    return t;
  };
  let mots = [], affiches = [];
  const garder = (n) => {
    const c = depDe(n);
    if (reg.dep === 'sans' ? c != null : reg.dep && c !== reg.dep) return false;
    return mots.every((m) => texteCherchable(n).includes(m));
  };
  const ligne = (n) => {
    const f = inst[n.num] || {};
    const aut = f.autorisation;
    const autCls = !aut ? 'inconnu' : ['ecrite', 'convention', 'non-necessaire'].includes(aut) ? 'ok' : aut === 'aucune' ? 'ko' : 'attention';
    const jv = jours(f.derniereVisite);
    const visCls = jv == null ? 'inconnu' : jv > 365 ? 'ko' : jv > 180 ? 'attention' : 'ok';
    const c = depDe(n);
    return `<tr data-num="${n.num}" class="cliquable">
      ${peutCocher ? `<td class="col-case">${gerable(n.num) ? `<input type="checkbox" data-case="${n.num}" ${reg.coches.has(n.num) ? 'checked' : ''} aria-label="Cocher ce relais">` : ''}</td>` : ''}
      <td><b>${esc(n.nomLong || n.nomCourt || n.id)}</b><br><small>${esc(n.roleFr || '')}${n.materiel ? ' · ' + esc(n.materiel) : ''}${c ? ' · ' + esc(c) : ''}</small></td>
      <td>${esc(f.site || '—')}${f.zoneProtegee && f.zoneProtegee !== 'aucune' ? `<br><small class="ko">⚠ ${esc(LIB_ZONE_PROTEGEE[f.zoneProtegee])}</small>` : ''}</td>
      <td class="etat-${autCls}">${esc(LIB_AUTORISATION[aut] || 'Non renseignée')}${f.dateAutorisation ? `<br><small>${esc(f.dateAutorisation)}</small>` : ''}</td>
      <td class="etat-${visCls}">${f.derniereVisite ? esc(f.derniereVisite) : 'Jamais notée'}${jv != null ? `<br><small>${ilYa(Date.parse(f.derniereVisite))}</small>` : ''}</td>
      <td>${esc(LIB_ALIM[f.alimentation] || '—')}${f.batterieAh ? `<br><small>${f.batterieAh} Ah${f.panneauW ? ' · ' + f.panneauW + ' W' : ''}</small>` : ''}</td>
      <td>${esc(n.firmware || '—')}<br><small>${n.dernierVu ? ilYa(n.dernierVu) : ''}</small></td></tr>`;
  };
  // Choix du département : seulement s'il y a de quoi choisir
  const nbParDep = {};
  for (const n of relais) { const c = depDe(n); if (c) nbParDep[c] = (nbParDep[c] || 0) + 1; }
  const codes = Object.keys(nbParDep).sort();
  const sansDep = relais.filter((n) => depDe(n) == null).length;
  const optionsDep = idx && (codes.length > 1 || (codes.length === 1 && sansDep))
    ? `<option value="">Tous les départements</option>${codes.map((c) => `<option value="${esc(c)}" ${reg.dep === c ? 'selected' : ''}>${esc(c)}${nomDep(c) ? ' · ' + esc(nomDep(c)) : ''} (${nbParDep[c]})</option>`).join('')}${sansDep ? `<option value="sans" ${reg.dep === 'sans' ? 'selected' : ''}>Sans département, position inconnue ou hors de France (${sansDep})</option>` : ''}`
    : '';
  const colonnes = peutCocher ? 7 : 6;
  $('#fiche-contenu').innerHTML = `<div class="liste-signalements registre-relais"><h3>🗂️ Registre des relais</h3>
    <div class="registre-filtres">
      <input type="search" id="reg-recherche" placeholder="Chercher : nom, site, commune…" aria-label="Chercher dans le registre des relais" autocomplete="off" maxlength="60" value="${esc(reg.q)}">
      ${optionsDep ? `<label>Département <select id="reg-dep">${optionsDep}</select></label>` : ''}
    </div>
    <p id="reg-compte"></p>
    ${avertissementSites()}
    ${peutCocher ? `<div class="registre-groupe" id="reg-groupe" hidden>
      <b id="reg-coches"></b>
      <label>Autorisation du site <select id="reg-aut">${Object.entries(LIB_AUTORISATION).map(([k, v]) => `<option value="${esc(k)}" ${k === 'non-necessaire' ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <button type="button" class="principal" id="reg-appliquer">Appliquer aux relais cochés</button>
      <button type="button" class="mini" id="reg-vider">Tout décocher</button>
    </div>` : ''}
    <p id="reg-retour" class="note"></p>
    <div class="table-defile"><table><thead><tr>${peutCocher ? '<th class="col-case"><input type="checkbox" id="reg-tous" title="Cocher tous les relais affichés" aria-label="Cocher tous les relais affichés"></th>' : ''}<th>Relais</th><th>Site</th><th>Autorisation</th><th>Dernière visite</th><th>Énergie</th><th>Firmware · vu</th></tr></thead>
    <tbody id="reg-corps"></tbody></table></div>
    <div class="actions-prop"><button type="button" class="mini" id="registre-csv">⬇ Exporter le registre (CSV)</button></div>
    <p class="note">Cliquez sur un relais pour ouvrir sa fiche et compléter la rubrique « Installation » (site, autorisation, zone protégée, dernière visite) ; en fermant la fiche vous revenez ici, avec la même recherche. L’export reprend les relais affichés. ${etat.admin ? 'Le propriétaire du site et le contact figurent dans l’export.' : 'Le propriétaire du site et le contact ne sont visibles que des administrateurs.'}</p>
    ${idx ? '<p class="note">Le département vient de la position que le nœud a retransmise : un relais proche d’une limite, ou qui floute sa position, peut être rangé dans le département voisin. Un relais qui ne donne pas sa position ne peut pas être rangé du tout.</p>' : ''}
    ${peutCocher ? '<p class="note">Les cases servent à mettre la même autorisation à plusieurs relais d’un coup : cochez-les, choisissez l’autorisation, puis « Appliquer ». Le reste de chaque fiche est gardé.</p>' : ''}</div>`;
  function majGroupe() {
    const g = $('#reg-groupe');
    if (!g) return;
    const k = reg.coches.size;
    g.hidden = !k;
    const masques = [...reg.coches].filter((num) => !affiches.some((x) => x.num === num)).length;
    $('#reg-coches').textContent = masques ? `${k} relais coché(s), dont ${masques} hors de la recherche qui ne seront pas modifiés` : `${k} relais coché(s)`;
    const tous = $('#reg-tous');
    if (tous) { const cochables = affiches.filter((x) => gerable(x.num)); tous.checked = cochables.length > 0 && cochables.every((x) => reg.coches.has(x.num)); }
  }
  function brancherLignes() {
    $('#reg-corps').querySelectorAll('tr[data-num]').forEach((tr) => {
      const num = Number(tr.dataset.num);
      tr.onclick = (e) => {
        if (e.target.closest('.col-case')) return; // cocher une case n'ouvre pas la fiche
        etat.retourFicheDemande = { ecran: 'registre', q: reg.q, dep: reg.dep, coches: [...reg.coches] };
        ouvrirFiche(num);
      };
      const c = tr.querySelector('input[type="checkbox"]');
      if (c) c.onchange = () => { if (c.checked) reg.coches.add(num); else reg.coches.delete(num); majGroupe(); };
    });
  }
  function rendre() {
    mots = sansAccent(reg.q).split(/\s+/).filter(Boolean);
    affiches = relais.filter(garder);
    const sansAut = affiches.filter((n) => !inst[n.num] || !['ecrite', 'convention', 'non-necessaire'].includes(inst[n.num].autorisation)).length;
    const aVisiter = affiches.filter((n) => { const j = jours((inst[n.num] || {}).derniereVisite); return j == null || j > 365; }).length;
    const filtre = mots.length > 0 || !!reg.dep;
    const tete = filtre ? `${affiches.length} relais affichés sur ${relais.length}.` : `${affiches.length} relais et passerelles.`;
    $('#reg-compte').innerHTML = `${esc(tete)} ${sansAut ? `<b class="ko">${sansAut} sans autorisation écrite enregistrée</b> · ` : ''}${aVisiter ? `<b class="attention">${aVisiter} sans visite depuis plus d’un an</b>` : ''}`;
    $('#reg-corps').innerHTML = affiches.map(ligne).join('') || `<tr><td colspan="${colonnes}">${relais.length ? 'Aucun relais ne correspond à cette recherche.' : 'Aucun relais connu.'}</td></tr>`;
    brancherLignes();
    majGroupe();
  }
  const champ = $('#reg-recherche');
  champ.oninput = () => { reg.q = champ.value; rendre(); };
  champ.onkeydown = (e) => { if (e.key === 'Escape') { champ.value = ''; reg.q = ''; rendre(); } };
  { const sd = $('#reg-dep'); if (sd) sd.onchange = () => { reg.dep = sd.value; rendre(); }; }
  { const tous = $('#reg-tous'); if (tous) tous.onchange = () => { for (const n of affiches) if (gerable(n.num)) { if (tous.checked) reg.coches.add(n.num); else reg.coches.delete(n.num); } rendre(); }; }
  { const v = $('#reg-vider'); if (v) v.onclick = () => { reg.coches.clear(); rendre(); }; }
  // Modification groupée : même route que la fiche entière, un appel et une ligne de journal par relais
  { const b = $('#reg-appliquer'); if (b) b.onclick = async () => {
    const retour = $('#reg-retour');
    const choisis = [...reg.coches], cibles = choisis.filter((num) => affiches.some((x) => x.num === num));
    const masques = choisis.length - cibles.length;
    retour.className = 'note';
    if (!cibles.length) { retour.textContent = 'Aucun relais coché parmi ceux qui sont affichés.'; return; }
    const v = $('#reg-aut').value;
    const texte = masques
      ? `Enregistrer « ${LIB_AUTORISATION[v]} » comme autorisation du site de ${cibles.length} relais ? ${masques} relais coché(s) hors de la recherche ne seront pas modifiés. Le reste de chaque fiche d’installation est gardé.`
      : `Enregistrer « ${LIB_AUTORISATION[v]} » comme autorisation du site de ${cibles.length} relais ? Le reste de chaque fiche d’installation est gardé.`;
    if (!(await confirmer(texte, { ok: 'Enregistrer' }))) return;
    b.disabled = true;
    retour.textContent = 'Enregistrement…';
    let faits = 0;
    const rates = [];
    for (const num of cibles) {
      const n = etat.noeuds.get(num);
      try {
        await postJson(`/api/noeuds/${num}/autorisation`, { autorisation: v });
        inst[num] = { ...(inst[num] || {}), autorisation: v };
        texteCache.delete(num);
        reg.coches.delete(num); // les relais en échec restent cochés : on peut réessayer
        faits++;
      } catch (e) { rates.push(`${(n && (n.nomLong || n.nomCourt)) || num} : ${e.message}`); }
    }
    b.disabled = false;
    rendre();
    const r = $('#reg-retour');
    r.className = 'note';
    r.classList.add(rates.length ? 'erreur' : 'ok');
    r.innerHTML = `${faits ? esc(`✔ ${faits} relais mis à jour.`) : ''}${rates.length ? ` <b class="ko">${esc(`✗ ${rates.length} relais non modifié(s) :`)}</b> ${esc(rates.join(' ; '))}` : ''}`;
  }; }
  $('#registre-csv').onclick = () => {
    // Un nom de nœud vient de la radio : s'il commence comme une formule (= + - @), le tableur ne doit pas l'exécuter
    const c = (x) => { const t = String(x ?? ''); return `"${(typeof x !== 'number' && /^[=+\-@\t\r]/.test(t) ? "'" + t : t).replace(/"/g, '""')}"`; };
    const entete = ['Nom', 'Identifiant', 'Rôle', 'Matériel', 'Firmware', 'Latitude', 'Longitude', 'Département', 'Dernier paquet', 'Site', 'Propriétaire du site', 'Contact', 'Autorisation', 'Date autorisation', 'Zone protégée', 'Mise en service', 'Dernière visite', 'Alimentation', 'Batterie (Ah)', 'Panneau (W)', 'Antenne', 'Hauteur (m)', 'Gain (dBi)', 'Pertes câble (dB)', 'Notes'];
    const lignes = affiches.map((n) => { const f = inst[n.num] || {}; return [n.nomLong || n.nomCourt, n.id, n.roleFr, n.materiel, n.firmware, n.lat, n.lon, depDe(n), n.dernierVu ? new Date(n.dernierVu).toISOString() : '', f.site, f.proprietaire, f.contact, LIB_AUTORISATION[f.autorisation] || '', f.dateAutorisation, LIB_ZONE_PROTEGEE[f.zoneProtegee] || '', f.miseEnService, f.derniereVisite, LIB_ALIM[f.alimentation] || '', f.batterieAh, f.panneauW, f.antenne, f.hauteur, f.gain, f.pertesCable, f.notes].map(c).join(';'); });
    telechargerTexte(`registre-relais-${new Date().toISOString().slice(0, 10)}.csv`, '﻿' + [entete.map(c).join(';'), ...lignes].join('\r\n'));
  };
  rendre();
  if (reg.q) champ.focus();
}

// ---- Nœuds d'un département, d'après la position qu'ils ont retransmise -------------------------
// Recherche par position et non par nom : tous les nœuds dont la position reçue tombe dans le département.
// Un nœud qui ne donne pas sa position ne peut pas être rangé : il est compté à part, jamais effacé en silence.
// Meshtastic (position retransmise) et MeshCore (position de la dernière annonce) suivent la même règle ; la liste
// part du réseau affiché sur la carte (etat.vueReseau) et un sélecteur permet d'en changer sans toucher à la carte.
async function ficheNoeudsDepartement(code, memo) {
  const ND_RESEAUX = ['meshtastic', 'meshcore', 'les-deux'];
  const titre = '🧭 Nœuds d’un département';
  $('#fiche').hidden = false; etat.selection = null;
  if (typeof mc !== 'undefined') mc.selection = null;
  $('#fiche-contenu').innerHTML = `<div class="liste-signalements"><h3>${titre}</h3><p class="note">Chargement…</p></div>`;
  const idx = await indexDepartementsNoeuds().catch(() => null);
  if (!idx) { $('#fiche-contenu').innerHTML = `<div class="liste-signalements"><h3>${titre}</h3><p class="erreur">Liste indisponible : il faut être connecté à la carte.</p></div>`; return; }
  // Réseaux listables : MeshCore seulement si la carte le suit (serveur et navigateur) ; carte limitée à un réseau : pas de choix
  const avecMc = !!(idx.mc && typeof mc !== 'undefined' && mc.actif);
  const seul = etat.config && etat.config.reseaux && etat.config.reseaux !== 'les-deux' ? etat.config.reseaux : null;
  let reseau = (memo && memo.reseau) || etat.vueReseau;
  if (!ND_RESEAUX.includes(reseau)) reseau = 'les-deux'; // réseau affiché inconnu : on montre les deux
  if (!avecMc) reseau = 'meshtastic';
  else if (seul && ND_RESEAUX.includes(seul)) reseau = seul;
  const choixReseau = avecMc && !seul;
  const idxMc = avecMc ? { parNoeud: idx.mc.parNoeud || {}, sansPosition: idx.mc.sansPosition || [], horsDepartements: idx.mc.horsDepartements || [] } : { parNoeud: {}, sansPosition: [], horsDepartements: [] };
  const deps = idx.departements || [];
  const sansPos = idx.sansPosition || [], hors = idx.horsDepartements || [];
  const vue = { reseau, quoi: '', q: (memo && memo.q) || '' };
  const voitMt = () => vue.reseau !== 'meshcore', voitMc = () => vue.reseau !== 'meshtastic';
  const nbDep = (d) => (voitMt() ? d.nb || 0 : 0) + (voitMc() ? d.nbMc || 0 : 0);
  const nbSans = () => (voitMt() ? sansPos.length : 0) + (voitMc() ? idxMc.sansPosition.length : 0);
  const nbHors = () => (voitMt() ? hors.length : 0) + (voitMc() ? idxMc.horsDepartements.length : 0);
  const premier = () => (deps.filter((d) => nbDep(d) > 0).sort((a, b) => nbDep(b) - nbDep(a))[0] || {}).code || (nbSans() ? 'sans' : 'hors');
  vue.quoi = String(code || (memo && memo.code) || premier()).toUpperCase();
  if (vue.quoi === 'SANS') vue.quoi = 'sans';
  if (vue.quoi === 'HORS') vue.quoi = 'hors';
  const nomDe = (c) => { const d = deps.find((x) => x.code === c); return (d && d.nom) || ''; };
  // Liste des choix selon le réseau listé : un département sans nœud de ce réseau n'y figure pas (sauf celui affiché)
  const options = () => `${deps.slice().sort((a, b) => a.code.localeCompare(b.code)).filter((d) => nbDep(d) > 0 || d.code === vue.quoi).map((d) => `<option value="${esc(d.code)}" ${vue.quoi === d.code ? 'selected' : ''}>${esc(d.code)}${d.nom ? ' · ' + esc(d.nom) : ''} (${nbDep(d)})</option>`).join('')}`
    + (nbSans() || vue.quoi === 'sans' ? `<option value="sans" ${vue.quoi === 'sans' ? 'selected' : ''}>Sans position reçue (${nbSans()})</option>` : '')
    + (nbHors() || vue.quoi === 'hors' ? `<option value="hors" ${vue.quoi === 'hors' ? 'selected' : ''}>Position connue, hors de France (${nbHors()})</option>` : '');
  const rien = !(deps.length || sansPos.length || hors.length || idxMc.sansPosition.length || idxMc.horsDepartements.length);
  const boutonReseau = (r, lib, aide) => `<button type="button" data-nd-reseau="${r}" aria-pressed="${vue.reseau === r}" title="${aide}">${lib}</button>`;
  $('#fiche-contenu').innerHTML = `<div class="liste-signalements noeuds-departement"><h3>${titre}</h3>
    ${!rien ? `${choixReseau ? `<div class="nd-reseau" role="group" aria-label="Réseau listé"><span>Réseau</span>
      ${boutonReseau('meshtastic', 'Meshtastic', 'Lister seulement les nœuds Meshtastic')}${boutonReseau('meshcore', 'MeshCore', 'Lister seulement les nœuds MeshCore')}${boutonReseau('les-deux', 'Les deux', 'Lister les nœuds des deux réseaux')}</div>` : ''}
    <div class="registre-filtres">
      <label>Afficher <select id="nd-dep"></select></label>
      <input type="search" id="nd-recherche" placeholder="Filtrer : nom, identifiant, rôle…" aria-label="Filtrer la liste des nœuds" autocomplete="off" maxlength="60" value="${esc(vue.q)}">
    </div>
    <p id="nd-compte"></p>
    <div class="table-defile"><table><thead><tr>${avecMc ? '<th>Réseau</th>' : ''}<th>Nœud</th><th>Identifiant du nœud</th><th>Rôle</th><th>Position</th><th>Dernier paquet</th></tr></thead><tbody id="nd-corps"></tbody></table></div>
    <div class="actions-prop"><button type="button" class="mini" id="nd-csv">⬇ Exporter la liste (CSV)</button></div>` : '<p class="note">Aucun nœud connu pour l’instant.</p>'}
    <p class="note">Le département est celui qui contient la position retransmise par le nœud (contours officiels, calcul fait sur le serveur). Une position floutée ou imprécise peut ranger un nœud près d’une limite dans le département voisin : à vérifier au cas par cas.</p>
    ${avecMc ? '<p class="note">Pour un nœud MeshCore, la position est celle de sa dernière annonce (advert). Un nœud qui annonce 0, 0 n’a pas de position.</p>' : ''}
    <p class="note" id="nd-note-sans" hidden></p>
    ${idx.monde ? '<p class="note" id="nd-note-monde"></p>' : ''}
    <p class="note">Cliquez sur un nœud pour ouvrir sa fiche ; en la fermant vous revenez ici.</p></div>`;
  if (rien) return;
  // Numéros (Meshtastic) et clés (MeshCore) rangés par département une fois pour toutes : une frappe dans le filtre ne relit pas tout l'index
  const parDep = {}, parDepMc = {};
  for (const [num, c] of Object.entries(idx.parNoeud || {})) (parDep[c] = parDep[c] || []).push(Number(num));
  for (const [cle, c] of Object.entries(idxMc.parNoeud)) (parDepMc[c] = parDepMc[c] || []).push(cle);
  let liste = [];
  const champ = $('#nd-recherche');
  const texteDe = (x) => (x.r === 'mc' ? [x.n.nom, x.n.id, x.n.cle, x.n.roleFr, 'meshcore']
    : [x.n.nomLong, x.n.nomCourt, x.n.id, x.n.num, x.n.roleFr, x.n.materiel, x.n.firmware, 'meshtastic']).filter(Boolean).join(' ');
  function rendre() {
    $('#nd-dep').innerHTML = options();
    const nums = !voitMt() ? [] : vue.quoi === 'sans' ? sansPos : vue.quoi === 'hors' ? hors : parDep[vue.quoi] || [];
    const cles = !voitMc() ? [] : vue.quoi === 'sans' ? idxMc.sansPosition : vue.quoi === 'hors' ? idxMc.horsDepartements : parDepMc[vue.quoi] || [];
    const mots = sansAccent(vue.q).split(/\s+/).filter(Boolean);
    let inconnus = 0;
    const tous = [
      ...nums.map((num) => { const n = etat.noeuds.get(Number(num) >>> 0); if (!n) inconnus++; return n ? { r: 'mt', n } : null; }),
      ...cles.map((cle) => { const n = mc.noeuds.get(cle); if (!n) inconnus++; return n ? { r: 'mc', n } : null; }),
    ].filter(Boolean);
    liste = tous.filter((x) => mots.every((m) => sansAccent(texteDe(x)).includes(m)))
      .sort((a, b) => (b.n.dernierVu || 0) - (a.n.dernierVu || 0));
    const total = nums.length + cles.length;
    const tete = vue.quoi === 'sans' ? `${liste.length} nœud(s) sans position reçue.`
      : vue.quoi === 'hors' ? `${liste.length} nœud(s) positionnés hors de France.`
      : nomDe(vue.quoi) ? `${liste.length} nœud(s) dans le département ${vue.quoi} · ${nomDe(vue.quoi)}.` : `${liste.length} nœud(s) dans le département ${vue.quoi}.`;
    const detail = vue.reseau === 'les-deux' && avecMc ? ` <small>${esc(`Meshtastic : ${liste.filter((x) => x.r === 'mt').length} · MeshCore : ${liste.filter((x) => x.r === 'mc').length}`)}</small>` : '';
    $('#nd-compte').innerHTML = `${esc(tete)}${detail}${mots.length ? ` <span>${esc(`Recherche en cours : ${total} au total.`)}</span>` : ''}${inconnus ? ` <small>${esc(`${inconnus} nœud(s) purgés depuis le calcul ne sont plus affichés.`)}</small>` : ''}`;
    const cols = avecMc ? 6 : 5;
    $('#nd-corps').innerHTML = liste.map(({ r, n }) => r === 'mc'
      ? `<tr data-mc="${esc(n.cle)}" class="cliquable">
      ${avecMc ? '<td><span class="tag-reseau mc" title="MeshCore">MC</span></td>' : ''}
      <td><b>${esc(n.nom || n.id)}</b>${n.observateur ? ' <small>observateur</small>' : ''}</td>
      <td><small>${esc(n.id)}</small></td>
      <td>${esc(n.roleFr || '')}</td>
      <td>${n.lat != null && n.lon != null ? `${Number(n.lat).toFixed(4)}, ${Number(n.lon).toFixed(4)}` : 'inconnue'}</td>
      <td>${n.dernierVu ? ilYa(n.dernierVu) : '—'}</td></tr>`
      : `<tr data-num="${n.num}" class="cliquable">
      ${avecMc ? '<td><span class="tag-reseau mt" title="Meshtastic">MT</span></td>' : ''}
      <td><b>${esc(n.nomLong || n.nomCourt || n.id)}</b>${n.passerelle ? ' <small>passerelle</small>' : ''}</td>
      <td><small>${esc(n.id)}</small></td>
      <td>${esc(n.roleFr || '')}</td>
      <td>${n.lat != null ? `${n.lat.toFixed(4)}, ${n.lon.toFixed(4)}` : 'inconnue'}</td>
      <td>${n.dernierVu ? ilYa(n.dernierVu) : '—'}</td></tr>`).join('') || `<tr><td colspan="${cols}">Aucun nœud ne correspond.</td></tr>`;
    const memoire = () => ({ ecran: 'departement', code: vue.quoi, q: vue.q, reseau: vue.reseau });
    $('#nd-corps').querySelectorAll('tr[data-num]').forEach((tr) => (tr.onclick = () => {
      etat.retourFicheDemande = memoire();
      ouvrirFiche(Number(tr.dataset.num));
    }));
    $('#nd-corps').querySelectorAll('tr[data-mc]').forEach((tr) => (tr.onclick = () => {
      etat.retourFicheDemande = memoire();
      mcOuvrirFiche(tr.dataset.mc);
    }));
    // Notes qui dépendent du réseau listé
    const ns = $('#nd-note-sans'), k = nbSans();
    ns.hidden = !k || vue.quoi === 'sans';
    ns.textContent = k ? `${k} nœud(s) n’ont envoyé aucune position : ils ne peuvent être rangés dans aucun département. Choisissez « Sans position reçue » pour les voir.` : '';
    const nm = $('#nd-note-monde');
    if (nm) nm.textContent = `Les départements n’existent qu’en France. Sur cette carte du monde, ${nbHors()} nœud(s) positionné(s) sont hors de France : ils sont comptés à part, rien n’est deviné.`;
    document.querySelectorAll('[data-nd-reseau]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ndReseau === vue.reseau)));
  }
  document.querySelectorAll('[data-nd-reseau]').forEach((b) => (b.onclick = () => { vue.reseau = b.dataset.ndReseau; rendre(); }));
  $('#nd-dep').onchange = (e) => { vue.quoi = e.target.value; rendre(); };
  champ.oninput = () => { vue.q = champ.value; rendre(); };
  champ.onkeydown = (e) => { if (e.key === 'Escape') { champ.value = ''; vue.q = ''; rendre(); } };
  $('#nd-csv').onclick = () => {
    const c = (x) => { const t = String(x ?? ''); return `"${(typeof x !== 'number' && /^[=+\-@\t\r]/.test(t) ? "'" + t : t).replace(/"/g, '""')}"`; };
    const entete = ['Réseau', 'Nom', 'Nom court', 'Identifiant', 'Numéro', 'Rôle', 'Matériel', 'Firmware', 'Latitude', 'Longitude', 'Département', 'Dernier paquet'];
    const lignes = liste.map(({ r, n }) => (r === 'mc'
      ? ['MeshCore', n.nom, '', n.cle, '', n.roleFr, '', '', n.lat, n.lon, idxMc.parNoeud[n.cle] || '', n.dernierVu ? new Date(n.dernierVu).toISOString() : '']
      : ['Meshtastic', n.nomLong, n.nomCourt, n.id, n.num, n.roleFr, n.materiel, n.firmware, n.lat, n.lon, (idx.parNoeud || {})[String(n.num >>> 0)] || '', n.dernierVu ? new Date(n.dernierVu).toISOString() : '']).map(c).join(';'));
    telechargerTexte(`noeuds-${vue.quoi}-${new Date().toISOString().slice(0, 10)}.csv`, '﻿' + [entete.map(c).join(';'), ...lignes].join('\r\n'));
  };
  rendre();
  if (vue.q) champ.focus();
}
async function ficheAutresPresets() {
  $('#fiche').hidden = false;
  etat.selection = null;
  const z = $('#fiche-contenu');
  z.innerHTML = '<h2>📣 Nœuds à inviter</h2><p class="note">Chargement…</p>';
  const r = await chargerAutresPresets();
  if (!r) { z.innerHTML = '<h2>📣 Nœuds à inviter</h2><p class="note">Réservé aux administrateurs.</p>'; return; }
  const c = carte.getCenter();
  const dist = (n) => (n.lat != null && n.lon != null ? carte.distance(c, [n.lat, n.lon]) / 1000 : null);
  const tous = r.noeuds.map((n) => ({ ...n, km: dist(n) })).sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9));
  const sentinelle = (p) => r.sentinelles.find((s) => s.preset === p);
  let filtre = 'secteur';
  const FILTRES = [['secteur', 'Dans le secteur de la carte'], ['25', 'À moins de 25 km'], ['50', 'À moins de 50 km'], ['100', 'À moins de 100 km'], ['tous', 'Tous, même sans position']];
  const garder = (n) => (filtre === 'tous' ? true : filtre === 'secteur' ? n.lat != null && dansZone(n) : n.km != null && n.km <= Number(filtre));
  let l = [];
  function rendre() {
    l = tous.filter(garder);
    const parPreset = {};
    for (const n of l) parPreset[n.preset] = (parPreset[n.preset] || 0) + 1;
    $('#ap-liste').innerHTML = `<div class="badges">${Object.entries(parPreset).map(([p, k]) => `<span class="badge autre-preset">${esc(nomPreset(p))} · ${k}</span>`).join('')}</div>
      ${l.slice(0, 200).map((n) => { const s = sentinelle(n.preset); return `<div class="invite">
        <div class="invite-nom"><b translate="no">${esc(n.nom_long || n.nom_court || n.id)}</b> <span class="badge autre-preset">${esc(nomPreset(n.preset))}</span></div>
        <div class="invite-info"><span translate="no">${esc(n.id)}</span> · ${n.km != null ? fmt(n.km, n.km < 10 ? 1 : 0, ' km') : 'position inconnue'} · vu ${ilYa(n.dernier_vu)}${n.presetDeduit ? ` · <span title="Preset déduit du canal où il a été entendu">canal ${esc(n.canalVu)}</span>` : ''}</div>
        <div class="invite-actions">${n.lat != null ? `<button class="mini" data-ap-voir="${n.num}">📍 Voir</button>` : ''}${s ? `<button class="mini principal" data-ap-inviter="${n.num}">✉️ Inviter</button>` : `<button class="mini" disabled title="Il faut d’abord un module sentinelle réglé en ${esc(nomPreset(n.preset))} (étape 1)">✉️ Inviter</button>`}</div>
      </div>`; }).join('') || '<div class="vide">Aucun nœud d’un autre preset ici ces 30 derniers jours. Essayez une distance plus grande.</div>'}`;
    $('#ap-nb').textContent = `${l.length} nœud(s)`;
    brancher();
  }
  z.innerHTML = `<h2>📣 Nœuds à inviter</h2>
    <div class="invites-intro">
      <p>Votre réseau est en <b>${esc(nomPreset(r.preset))}</b>. Les nœuds ci-dessous sont réglés sur un <b>autre preset</b> : ils ne voient pas votre réseau, et votre réseau ne les voit pas. Une invitation leur explique comment vous rejoindre.</p>
      <p class="note">La carte les connaît par MQTT (rapport de carte, ou canal au nom d’un preset) ou par un module sentinelle. Vus ces 30 derniers jours, les plus proches du centre de la carte d’abord.</p>
    </div>
    <h4>① Module sentinelle (pour envoyer les invitations)</h4>
    ${r.sentinelles.length ? r.sentinelles.map((s) => `<div class="mesure-ligne"><b class="ok">●</b> ${esc(s.nom)} · ${esc(nomPreset(s.preset))}</div>`).join('')
      : `<div class="alerte attention">Aucun pour l’instant : vous pouvez voir ces nœuds, mais pas encore leur écrire.<br><small>Il suffit d’un petit module (un Heltec V3 suffit) réglé sur <b>leur</b> preset, relié à la carte <b>en écoute</b> : Outils › Connecter un module › « en écoute, en plus ». Il ne sert qu’à écouter et à envoyer les invitations que vous validez.</small></div>`}
    <p class="note">Modules sentinelles : ${r.sentinelles.length}</p>
    <h4>② Choisir les nœuds · <span id="ap-nb"></span></h4>
    <label class="ap-filtre">Afficher <select id="ap-filtre">${FILTRES.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label>
    <div id="ap-liste"></div>
    <div id="ap-invitation"></div>`;
  $('#ap-filtre').onchange = (e) => { filtre = e.target.value; rendre(); };
  function brancher() {
  z.querySelectorAll('[data-ap-voir]').forEach((b) => (b.onclick = () => { const n = l.find((x) => x.num === Number(b.dataset.apVoir)); carte.setView([n.lat, n.lon], Math.max(carte.getZoom(), 12)); ouvrirFiche(n.num); }));
  z.querySelectorAll('[data-ap-inviter]').forEach((b) => (b.onclick = () => {
    const n = l.find((x) => x.num === Number(b.dataset.apInviter));
    const s = sentinelle(n.preset);
    const zone = $('#ap-invitation');
    const defaut = etat.config.rejoindre
      ? tr(`Bonjour ! Le réseau Meshtastic du secteur est en ${nomPreset(r.preset)}. Pour nous rejoindre : ${location.host}/rejoindre`)
      : tr(`Bonjour ! Le réseau Meshtastic du secteur est en ${nomPreset(r.preset)}. Passez votre nœud dans ce preset pour nous rejoindre. Carte : ${location.host}`);
    zone.innerHTML = `<h4>Invitation à ${esc(n.nom_long || n.id)}</h4>
      <p class="note">Message direct envoyé par la sentinelle « ${esc(s.nom)} » (${esc(nomPreset(s.preset))}). Relisez-le : 200 octets au plus.</p>
      <textarea id="ap-texte" rows="4" maxlength="200">${esc(defaut)}</textarea>
      <div class="actions-prop"><small id="ap-octets"></small><button class="principal" id="ap-envoyer">✉️ Envoyer l’invitation</button></div>
      <div id="ap-retour" class="note"></div>`;
    const t = $('#ap-texte'), compte = () => { const o = new TextEncoder().encode(t.value).length; $('#ap-octets').textContent = `${o} / 200 octets`; $('#ap-envoyer').disabled = o > 200 || !t.value.trim(); };
    t.oninput = compte; compte();
    zone.scrollIntoView({ behavior: 'smooth' });
    $('#ap-envoyer').onclick = async () => {
      $('#ap-envoyer').disabled = true;
      try { await postJson('/api/autres-presets/inviter', { num: n.num, hote: s.hote, port: s.port, texte: t.value }); $('#ap-retour').textContent = '✓ Invitation envoyée. Sa réponse arrivera sur la sentinelle, dans les messages.'; }
      catch (e) { $('#ap-retour').textContent = '✗ ' + e.message; $('#ap-envoyer').disabled = false; }
    };
  }));
  }
  rendre();
}
