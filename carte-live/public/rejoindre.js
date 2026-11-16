'use strict';
// Page publique « Rejoindre le réseau » : contenu saisi par l'administrateur (Outils › Rejoindre le réseau).
(async function () {
  const page = document.getElementById('page');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lignes = (t) => String(t || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const PRESETS = { LONG_FAST: 'LongFast', LONG_MODERATE: 'LongModerate', LONG_SLOW: 'LongSlow', VERY_LONG_SLOW: 'VeryLongSlow', MEDIUM_FAST: 'MediumFast', MEDIUM_SLOW: 'MediumSlow', MEDIUM_TURBO: 'MediumTurbo', SHORT_FAST: 'ShortFast', SHORT_SLOW: 'ShortSlow', SHORT_TURBO: 'ShortTurbo', LONG_TURBO: 'LongTurbo' };
  let d;
  try {
    const r = await fetch('/api/rejoindre');
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erreur || r.statusText);
    d = await r.json();
  } catch (e) {
    page.innerHTML = `<p class="erreur">Cette page n’est pas encore publiée.<br><a href="/publique">Voir la carte du réseau</a></p>`;
    return;
  }
  document.title = `Rejoindre le réseau · ${d.titre}`;
  let n = 0;
  const etape = (titre) => `<h2><span class="n">${++n}</span>${titre}</h2>`;
  const liste = (t) => `<ul class="liste" translate="no">${lignes(t).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;

  const blocs = [];
  blocs.push(`<header class="tete"><img src="/symbole.svg" alt=""><div>
    <h1>Rejoindre le réseau <span translate="no">${esc(d.titre)}</span></h1>
    <p class="sous">Réseau maillé LoRa · Meshtastic${d.meshcore ? ' et MeshCore' : ''}</p></div></header>`);
  if (d.presentation) blocs.push(`<section><p class="presentation" translate="no">${esc(d.presentation)}</p></section>`);

  // 1. Le canal et les réglages Meshtastic
  const reglages = `<dl class="reglages">
      ${d.region ? `<dt>Région</dt><dd>${esc(d.region)}</dd>` : ''}
      <dt>Preset LoRa</dt><dd>${esc(PRESETS[d.preset] || d.preset)}</dd>
      <dt>Limite de sauts</dt><dd>${esc(d.limiteSauts)}</dd>
    </dl>`;
  blocs.push(`<section>${etape('Régler votre nœud Meshtastic')}
    ${d.lienCanal ? `<div class="canal">
      <div class="qr" role="img" aria-label="QR code du canal du réseau">${d.qrCanal}</div>
      <div>
        <p>Dans l’appli Meshtastic, scannez ce QR code (ou touchez le bouton sur votre téléphone) : le canal du réseau et le preset LoRa sont réglés d’un coup.</p>
        ${reglages}
        <div class="boutons"><a class="bouton principal" href="${esc(d.lienCanal)}">📲 Ouvrir dans l’appli Meshtastic</a>
        <button type="button" class="bouton" id="copier">📋 Copier le lien</button></div>
      </div></div>`
    : `<p>Réglez votre nœud ainsi dans l’appli Meshtastic (Radio › LoRa) :</p>${reglages}`}
    <p class="note">La limite de sauts se règle dans Radio › LoRa › Hop limit. Plus de sauts n’aide pas : cela encombre le canal pour tout le monde.</p>
  </section>`);

  // 2. Rôle
  if (d.roles) blocs.push(`<section>${etape('Choisir le bon rôle')}${liste(d.roles)}</section>`);

  // 3. MeshCore
  if (d.meshcore) {
    const m = d.meshcore;
    blocs.push(`<section>${etape('Régler votre nœud MeshCore')}
      <dl class="reglages">
        ${m.frequence ? `<dt>Fréquence</dt><dd translate="no">${esc(m.frequence)}</dd>` : ''}
        ${m.bande ? `<dt>Bande passante</dt><dd translate="no">${esc(m.bande)}</dd>` : ''}
        ${m.sf ? `<dt>Facteur d’étalement (SF)</dt><dd translate="no">${esc(m.sf)}</dd>` : ''}
        ${m.cr ? `<dt>Taux de codage (CR)</dt><dd translate="no">${esc(m.cr)}</dd>` : ''}
      </dl></section>`);
  }

  // 4. Règles
  if (d.regles) blocs.push(`<section>${etape('Les règles du réseau')}${liste(d.regles)}</section>`);

  // 5. Antennes
  if (d.antennes) blocs.push(`<section>${etape('Antennes testées sur le réseau')}${liste(d.antennes)}</section>`);

  // 6. Relais communautaires
  if (d.relais && d.relais.length) {
    blocs.push(`<section>${etape('Les relais du réseau')}
      <p>${d.relais.length} relais entendus ces 7 derniers jours. Ils sont installés et entretenus par des bénévoles.</p>
      <ul class="relais">${d.relais.map((r) => `<li><span translate="no">${esc(r.nom)}</span> <small>${esc(r.reseau)} · ${esc(r.role)}</small></li>`).join('')}</ul>
      <div class="boutons"><a class="bouton" href="/publique">🗺️ Voir la carte du réseau</a></div></section>`);
  } else {
    blocs.push(`<section>${etape('Voir le réseau')}<div class="boutons"><a class="bouton" href="/publique">🗺️ Voir la carte du réseau</a></div></section>`);
  }

  // 7. Contact et dons
  if (d.contact || d.donsLien) {
    blocs.push(`<section>${etape('Contact et soutien')}
      ${d.contact ? `<p class="presentation" translate="no">${esc(d.contact)}</p>` : ''}
      ${d.donsTexte ? `<p class="presentation" translate="no">${esc(d.donsTexte)}</p>` : ''}
      ${d.donsLien ? `<div class="boutons"><a class="bouton don" href="${esc(d.donsLien)}" target="_blank" rel="noopener">❤️ Soutenir le réseau</a></div>` : ''}
    </section>`);
  }

  // Partager la page (affiche, flyer)
  if (d.qrPage) {
    blocs.push(`<section class="partage"><div class="qr" role="img" aria-label="QR code de cette page">${d.qrPage}</div>
      <div><h2>Faire connaître le réseau</h2><p>Ce QR code ouvre cette page : imprimez-la pour une affiche ou un flyer.</p>
      <div class="boutons"><button type="button" class="bouton" id="imprimer">🖨️ Imprimer</button></div></div></section>`);
  }
  blocs.push('<footer>Carte live · réseau maillé LoRa en direct</footer>');
  page.innerHTML = blocs.join('');

  const c = document.getElementById('copier');
  if (c) c.onclick = async () => { try { await navigator.clipboard.writeText(d.lienCanal); c.textContent = '✓ Lien copié'; } catch { prompt('Lien du canal', d.lienCanal); } };
  const i = document.getElementById('imprimer');
  if (i) i.onclick = () => window.print();
})();
