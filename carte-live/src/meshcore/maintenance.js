'use strict';
// Maintenance MeshCore : versions de firmware des répéteurs et room servers, accès administrateur
// (mot de passe mémorisé, configuration déjà lue) et conformité automatique chaque nuit.

const fs = require('fs');
const path = require('path');

const versionNum = (v) => { const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v || '')); return m ? [+m[1], +m[2], +(m[3] || 0)] : null; };
const comparer = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);

function creerMaintenanceMc({ config, reseauMc, adminMc, companion, journal }) {
  const fConf = path.join(path.dirname(config.fichierBase), 'meshcore-conformite.json');
  let conf = { actif: false, heure: 3, reference: null, elements: null, dernier: null, tache: null, lancee: 0 };
  try { conf = { ...conf, ...JSON.parse(fs.readFileSync(fConf, 'utf8')) }; } catch { /* aucune */ }
  const sauver = () => { try { fs.writeFileSync(fConf, JSON.stringify(conf)); } catch { /* lecture seule */ } };

  // Dernières versions publiées (une par type de firmware : repeater, room-server, companion)
  let versions = null;
  async function verifierVersions() {
    try {
      const r = await fetch('https://api.github.com/repos/meshcore-dev/MeshCore/releases?per_page=30', { headers: { 'User-Agent': 'carte-live', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const v = {};
      for (const x of await r.json()) {
        if (x.prerelease || x.draft) continue;
        const m = /^(repeater|room-server|companion)-v(.+)$/.exec(x.tag_name || '');
        if (!m) continue;
        const n = versionNum(m[2]);
        if (n && (!v[m[1]] || comparer(n, v[m[1]].v) > 0)) v[m[1]] = { tag: x.tag_name, version: m[2], v: n, date: x.published_at, url: x.html_url };
      }
      versions = { ...v, verifie: Date.now() };
    } catch (e) { journal('[MeshCore] versions :', e.message); }
  }
  setTimeout(verifierVersions, 45000).unref();
  setInterval(verifierVersions, 12 * 3600000).unref();

  const dansZone = (n) => { const z = config.zone; return n.lat != null && n.lat >= z[0] && n.lat <= z[2] && n.lon >= z[1] && n.lon <= z[3]; };

  function etat() {
    resumer();
    const memo = new Set(adminMc.memorises());
    const lim = Date.now() - 7 * 86400000;
    const l = reseauMc.q.noeuds.all().filter((n) => ['repeteur', 'salon'].includes(n.role) && (dansZone(n) || memo.has(n.cle)) && ((n.dernier_vu || 0) >= lim || memo.has(n.cle)));
    const noeuds = l.map((n) => {
      const lu = adminMc.lecture(n.cle) || {};
      const infos = lu.infos || {};
      const type = n.role === 'salon' ? 'room-server' : 'repeater';
      const ref = versions && versions[type];
      const v = versionNum(infos.version);
      const etatFw = !v ? 'inconnu' : !ref ? 'connu' : comparer(v, ref.v) >= 0 ? 'a-jour' : 'retard';
      const aFaire = [];
      if (!memo.has(n.cle)) aFaire.push('mot de passe admin non mémorisé : impossible de le gérer à distance');
      else if (!lu.heure) aFaire.push('jamais lu : lancez « Lire la configuration »');
      if (etatFw === 'retard') aFaire.push(`firmware ${infos.version} → ${ref.version} disponible (mise à jour en USB, ou « start ota » sur place)`);
      return {
        cle: n.cle, nom: n.nom || n.cle.slice(0, 8), role: n.role, dernierVu: n.dernier_vu, lat: n.lat, lon: n.lon,
        firmware: infos.version || null, materiel: infos.carte || null, etatFw, derniereVersion: ref ? ref.version : null,
        motDePasse: memo.has(n.cle), lu: lu.heure || null, aFaire,
      };
    }).sort((a, b) => b.aFaire.length - a.aFaire.length || a.nom.localeCompare(b.nom));
    return { versions, noeuds, conformite: { ...conf, elementsPossibles: adminMc.ELEMENTS, elementsDefaut: adminMc.ELEMENTS_DEFAUT } };
  }

  // ---- Conformité automatique (même vérification que « Vérifier », sur les répéteurs à mot de passe mémorisé)
  function cibles() { return adminMc.memorises().filter((k) => k !== conf.reference); }
  function lancer(auteur = 'automatique') {
    if (!conf.reference) throw new Error('aucune référence choisie');
    const c = cibles();
    if (!c.length) throw new Error('aucun autre répéteur à mot de passe mémorisé');
    const t = adminMc.lancer('verifier', [conf.reference, ...c], { elements: conf.elements || adminMc.ELEMENTS_DEFAUT }, auteur);
    conf.tache = t.id; conf.lancee = Date.now(); sauver();
    return t;
  }
  function resumer() {
    const t = conf.tache && adminMc.tache(conf.tache);
    if (!t || !t.fin || !t.rapport || (conf.dernier && conf.dernier.tache === t.id)) return;
    const r = t.rapport;
    conf.dernier = {
      tache: t.id, date: t.fin, reference: r.reference,
      conformes: r.noeuds.filter((x) => x.lu && x.conforme).map((x) => ({ cle: x.cle, nom: x.nom })),
      ecarts: r.noeuds.filter((x) => x.lu && !x.conforme).map((x) => ({ cle: x.cle, nom: x.nom, ecarts: x.ecarts })),
      nonLus: r.noeuds.filter((x) => !x.lu).map((x) => ({ cle: x.cle, nom: x.nom, erreur: x.erreur })),
    };
    sauver();
    journal(`[MeshCore] conformité automatique : ${conf.dernier.conformes.length} conforme(s), ${conf.dernier.ecarts.length} avec écarts`);
  }
  const m = setInterval(() => {
    resumer();
    if (!conf.actif) return;
    const h = Number(new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }).slice(0, 2));
    if (h !== conf.heure || Date.now() - (conf.lancee || 0) < 20 * 3600000 || !companion.etat().connecte) return;
    try { lancer(); } catch (e) { journal('[MeshCore] conformité automatique :', e.message); conf.lancee = Date.now(); sauver(); }
  }, 5 * 60000);
  if (m.unref) m.unref();

  return {
    etat,
    regler(b) {
      if (b.reference !== undefined) conf.reference = b.reference ? String(b.reference).toUpperCase() : null;
      if (b.actif != null) conf.actif = !!b.actif;
      if (Array.isArray(b.elements)) conf.elements = b.elements.filter((e) => adminMc.ELEMENTS.includes(e));
      sauver();
      return conf;
    },
    lancer,
  };
}

module.exports = { creerMaintenanceMc };
