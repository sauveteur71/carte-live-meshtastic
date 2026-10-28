'use strict';
// Rapport hebdomadaire : page HTML imprimable (« Imprimer › Enregistrer en PDF ») sur l'état du réseau.
// Archivé chaque lundi matin dans /data/rapports (52 gardés), consultable à tout moment pour les 7 derniers jours.

const fs = require('fs');
const path = require('path');

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? '–' : Number(v).toFixed(d).replace('.', ','));
const date = (t) => (t ? new Date(t).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–');
const jour = (t) => new Date(t).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: '2-digit', month: '2-digit' });

function creerRapport(dep) {
  const { stockage, config, reseau, maintenance, journal } = dep;
  const dossier = path.join(path.dirname(config.fichierBase), 'rapports');
  try { fs.mkdirSync(dossier, { recursive: true }); } catch { /* lecture seule */ }
  const db = stockage.db;
  const qJours = db.prepare(`SELECT CAST((heure - ?) / 86400000 AS INTEGER) AS j, COUNT(*) AS nb, SUM(CASE WHEN port = 'texte' THEN 1 ELSE 0 END) AS textes, COUNT(DISTINCT de) AS emetteurs
    FROM paquets WHERE heure >= ? GROUP BY j ORDER BY j`);
  const nomNum = (num) => { const n = stockage.q.noeud.get(num >>> 0); return n ? n.nom_long || n.nom_court || '!' + (num >>> 0).toString(16) : '!' + (num >>> 0).toString(16); };

  function construire() {
    const fin = Date.now(), debut = fin - 7 * 86400000;
    const titre = (config.carte && config.carte.titre) || 'Réseau Meshtastic';
    const z = config.zone;
    const dansZone = (n) => !z || (n.lat != null && n.lat >= z[0] && n.lat <= z[2] && n.lon >= z[1] && n.lon <= z[3]);
    const tous = stockage.q.noeuds.all();
    const relais = tous.filter((n) => dansZone(n) && reseau.estSurveille(n)).map((n) => ({ ...n, v: reseau.vueNoeud(n, true) }));
    const actifs7 = tous.filter((n) => dansZone(n) && (n.dernier_vu || 0) >= debut).length;
    const stats = reseau.statistiques();
    const jours = qJours.all(debut, debut);
    const totalPaquets = jours.reduce((t, x) => t + x.nb, 0), totalTextes = jours.reduce((t, x) => t + x.textes, 0);
    let couv = null, nouveaux = [], asym = null, conf = null, fw = null, autonomie = [], charge = [], mc = null;
    try { couv = dep.couverture && dep.couverture(); } catch { /* relief pas prêt */ }
    try { nouveaux = dep.nouveaux ? dep.nouveaux().lister(7).noeuds : []; } catch { /* ignoré */ }
    try { asym = dep.asymetrie ? dep.asymetrie() : null; } catch { /* ignoré */ }
    try { conf = dep.conformite ? dep.conformite() : null; } catch { /* ignoré */ }
    try { fw = maintenance.firmwares(); autonomie = maintenance.autonomie(); charge = maintenance.chargeRadio(); } catch { /* ignoré */ }
    try { mc = dep.meshcore ? dep.meshcore() : null; } catch { /* ignoré */ }
    const alertes = dep.alertes ? dep.alertes() : [];
    const muets = relais.filter((r) => (r.dernier_vu || 0) < fin - 6 * 3600000);
    const sourds = asym ? (asym.sourds || []).filter((x) => !x.pos || dansZone(x.pos)) : [];
    const sensUnique = asym ? asym.sensUnique.filter((x) => (x.a && dansZone(x.a)) || (x.b && dansZone(x.b))) : [];
    const maxJour = Math.max(1, ...jours.map((x) => x.nb));

    const section = (t, contenu) => `<section><h2>${t}</h2>${contenu}</section>`;
    const tableau = (entetes, lignes) => lignes.length ? `<table><thead><tr>${entetes.map((e) => `<th>${e}</th>`).join('')}</tr></thead><tbody>${lignes.map((l) => `<tr>${l.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<p class="vide">Rien à signaler.</p>';
    const pastille = (ok, txt) => `<span class="p ${ok}">${txt}</span>`;

    const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rapport hebdomadaire · ${esc(titre)}</title>
<style>
  :root { --t: #1f2933; --d: #52606d; --b: #d9e2ec; --ok: #0f8a5f; --at: #b7791f; --cr: #c53030; }
  body { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--t); background: #fff; margin: 0 auto; max-width: 980px; padding: 24px 16px; }
  h1 { font-size: 22px; margin: 0; } h2 { font-size: 16px; margin: 26px 0 8px; padding-bottom: 4px; border-bottom: 2px solid var(--b); }
  .sous { color: var(--d); margin: 4px 0 18px; }
  .chiffres { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .chiffres div { border: 1px solid var(--b); border-radius: 8px; padding: 8px 10px; } .chiffres b { display: block; font-size: 22px; } .chiffres span { color: var(--d); font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; } th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--b); vertical-align: top; } th { color: var(--d); font-weight: 600; }
  .p { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 12px; font-weight: 600; } .p.ok { background: #e3f9e5; color: var(--ok); } .p.at { background: #fffbea; color: var(--at); } .p.cr { background: #ffe3e3; color: var(--cr); }
  .barres { display: flex; align-items: flex-end; gap: 6px; height: 110px; } .barres div { flex: 1; text-align: center; font-size: 11px; color: var(--d); } .barres i { display: block; background: #4c8bf5; border-radius: 3px 3px 0 0; margin-bottom: 3px; }
  .vide { color: var(--d); font-style: italic; } ul { margin: 4px 0; padding-left: 20px; }
  .imprimer { float: right; } @media print { .imprimer { display: none; } section { break-inside: avoid; } }
</style></head><body>
<button class="imprimer" onclick="print()">Imprimer / PDF</button>
<h1>Rapport hebdomadaire · ${esc(titre)}</h1>
<p class="sous">Du ${new Date(debut).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' })} au ${new Date(fin).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' })} · ${esc(config.zoneNom || '')} · produit le ${date(fin)}</p>

<div class="chiffres">
  <div><b>${relais.length - muets.length}/${relais.length}</b><span>relais et passerelles actifs</span></div>
  <div><b>${actifs7}</b><span>nœuds entendus dans la zone (7 j)</span></div>
  <div><b>${couv ? fmt(couv.pct) + ' %' : '–'}</b><span>couverture calculée du département</span></div>
  <div><b>${totalPaquets.toLocaleString('fr-FR')}</b><span>paquets reçus (7 j)</span></div>
  <div><b>${totalTextes}</b><span>messages texte</span></div>
  <div><b>${nouveaux.length}</b><span>nouveaux nœuds dans le secteur</span></div>
</div>

${section('Trafic par jour', `<div class="barres">${jours.map((x) => `<div><i style="height:${Math.round((x.nb / maxJour) * 85)}px"></i>${x.nb}<br>${jour(debut + x.j * 86400000)}</div>`).join('')}</div>`)}

${section('Alertes en cours', alertes.length ? `<ul>${alertes.slice(0, 25).map((a) => `<li>${pastille(a.niveau === 'critique' ? 'cr' : 'at', a.niveau || 'alerte')} ${esc(a.message || a.texte || a.titre || '')}</li>`).join('')}</ul>` : '<p class="vide">Aucune alerte.</p>')}

${section('Relais et passerelles', tableau(['Nœud', 'Rôle', 'Dernière réception', 'Batterie', 'Occupation canal 24 h', 'Firmware'], relais.sort((a, b) => (a.nom_long || '').localeCompare(b.nom_long || '')).map((r) => {
    const au = autonomie.find((x) => x.num === r.num), ch = charge.find((x) => x.num === r.num);
    const muet = (r.dernier_vu || 0) < fin - 6 * 3600000;
    return [esc(r.nom_long || r.v.id), esc(r.role || ''), `${muet ? pastille('cr', 'muet') : pastille('ok', 'actif')} ${date(r.dernier_vu)}`,
      au ? `${au.tension != null ? fmt(au.tension, 2) + ' V' : ''} ${au.etat === 'critique' ? pastille('cr', 'critique') : au.etat === 'attention' ? pastille('at', 'à surveiller') : ''}<br><small>${esc(au.message || '')}</small>` : '–',
      ch && ch.canal24 != null ? `${fmt(ch.canal24)} %${ch.niveau !== 'ok' ? ' ' + pastille(ch.niveau === 'critique' ? 'cr' : 'at', ch.niveau) : ''}` : '–', esc(r.firmware || '–')];
  })))}

${section('Qualité des liaisons', `${sourds.length ? `<p><b>Relais qui entendent mal</b> (émettent bien, reçoivent ${'≥'} 8 dB moins bien que leurs voisins) :</p><ul>${sourds.map((x) => `<li>${esc(x.nom)} : ≈ ${fmt(x.ecartDb, 0)} dB (${x.nbConcordants}/${x.nbVoisins} voisins)</li>`).join('')}</ul>` : '<p class="vide">Aucun relais « sourd » détecté.</p>'}
  ${sensUnique.length ? `<p><b>Liaisons à sens unique</b> :</p><ul>${sensUnique.slice(0, 15).map((x) => `<li>${esc(x.nomEntendu)} n’entend pas ${esc(x.nomEntend)} (qui l’entend à ${fmt(x.snr)} dB)</li>`).join('')}</ul>` : ''}`)}

${section('Nouveaux nœuds du secteur', tableau(['Nœud', 'Apparu', 'Paquets', 'Diagnostic'], nouveaux.slice(0, 30).map((n) => [esc(n.nom || n.id) + `<br><small>${esc(n.id)} ${esc(n.role || '')}</small>`, date(n.premierVu), String(n.nbPaquets), n.diagnostic.map((d) => esc(d.texte)).join('<br>') || 'OK'])))}

${section('Conformité des configurations', conf && conf.dernier ? `<p>Dernière vérification automatique le ${date(conf.dernier.date)} (référence : ${esc(nomNum(conf.dernier.reference))}) : <b>${conf.dernier.conformes.length} conforme(s)</b>, ${conf.dernier.ecarts.length} avec écarts, ${conf.dernier.nonLus.length} non lu(s).</p>${conf.dernier.ecarts.length ? `<ul>${conf.dernier.ecarts.map((e) => `<li>${esc(nomNum(e.num))} : ${esc(e.ecarts.map((x) => `${x.element} ${x.trouve} au lieu de ${x.attendu}`).join(' ; '))}</li>`).join('')}</ul>` : ''}` : '<p class="vide">Pas de vérification automatique (Programmer › Conformité › « Refaire chaque nuit »).</p>')}

${section('Firmwares', fw ? `<p>Dernière version stable : <b>${esc(fw.reference && fw.reference.stable ? fw.reference.stable.tag : '?')}</b>. ${Object.entries(fw.parVersion || {}).map(([v, nb]) => `${esc(v)} : ${nb}`).join(' · ')}</p>${fw.noeuds.filter((x) => x.etat === 'ancien' || x.etat === 'retard').length ? `<ul>${fw.noeuds.filter((x) => x.etat === 'ancien' || x.etat === 'retard').map((x) => `<li>${esc(x.nom)} : ${esc(x.firmware || '?')} (${esc(x.retard || '')})</li>`).join('')}</ul>` : '<p class="vide">Tous les relais connus sont à jour.</p>'}` : '<p class="vide">Indisponible.</p>')}

${mc ? section('MeshCore', `<p>${mc.repeteurs} répéteur(s) dans la zone, dont ${mc.actifs} actif(s) cette semaine · ${mc.noeuds} nœud(s) MeshCore entendus.</p>`) : ''}

<p class="sous" style="margin-top:28px">Couverture et liaisons calculées d’après le relief IGN, les fiches d’installation et les mesures réelles du réseau. Rapport généré automatiquement par la carte live.</p>
</body></html>`;
    return html;
  }

  const nomFichier = (t) => `rapport-${new Date(t).toISOString().slice(0, 10)}.html`;
  function archiver() {
    const f = path.join(dossier, nomFichier(Date.now()));
    fs.writeFileSync(f, construire());
    const l = fs.readdirSync(dossier).filter((x) => /^rapport-\d{4}-\d\d-\d\d\.html$/.test(x)).sort();
    for (const x of l.slice(0, Math.max(0, l.length - 52))) { try { fs.unlinkSync(path.join(dossier, x)); } catch { /* ignoré */ } }
    journal(`[Rapport] rapport hebdomadaire archivé (${path.basename(f)})`);
  }
  // Chaque lundi vers 7 h (heure de Paris)
  const minuterie = setInterval(() => {
    const p = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    if (p.getDay() !== 1 || p.getHours() !== 7) return;
    if (fs.existsSync(path.join(dossier, nomFichier(Date.now())))) return;
    try { archiver(); } catch (e) { journal('[Rapport] erreur :', e.message); }
  }, 10 * 60000);
  if (minuterie.unref) minuterie.unref();

  return {
    construire,
    archiver,
    liste: () => { try { return fs.readdirSync(dossier).filter((x) => /^rapport-\d{4}-\d\d-\d\d\.html$/.test(x)).sort().reverse(); } catch { return []; } },
    fichier: (nom) => (/^rapport-\d{4}-\d\d-\d\d\.html$/.test(nom) ? path.join(dossier, nom) : null),
  };
}

module.exports = { creerRapport };
