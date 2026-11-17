'use strict';
// Maintenance MeshCore : versions de firmware des répéteurs et room servers, accès administrateur
// (mot de passe mémorisé, configuration déjà lue) et conformité automatique chaque nuit.

const fs = require('fs');
const { ecrireSur, lireJson } = require('../fichiers');
const path = require('path');

const versionNum = (v) => { const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v || '')); return m ? [+m[1], +m[2], +(m[3] || 0)] : null; };
const comparer = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);

// Avis connus (notes de version MeshCore, avis des fabricants) : versions de firmware à problème et matériel concerné.
// « versions » : versions touchées ; « materiel » : expression sur le résultat de la commande « board ».
const AVIS = [
  { id: 'fw-1.17.0-t096', versions: ['1.17.0'], materiel: /t0?96/i, niveau: 'critique',
    message: 'firmware 1.17.0 sur Heltec T096 : n’émet pas correctement, passez en 1.17.1 ou plus' },
  { id: 'thinknode-m9-sd', materiel: /thinknode.?m9/i, niveau: 'attention',
    message: 'avis de sécurité Elecrow : risque de logiciel malveillant sur la carte SD du ThinkNode M9 (voir elecrow.com, « Thinknode M9 Security Advisory »)' },
];

function creerMaintenanceMc({ config, reseauMc, adminMc, companion, journal, auditMc = null }) {
  const fConf = path.join(path.dirname(config.fichierBase), 'meshcore-conformite.json');
  let conf = { actif: false, heure: 3, reference: null, elements: null, dernier: null, tache: null, lancee: 0 };
  try { conf = { ...conf, ...lireJson(fConf) }; } catch { /* aucune */ }
  const sauver = () => { try { ecrireSur(fConf, JSON.stringify(conf)); } catch { /* lecture seule */ } };

  // Sauvegardes du configurateur MeshCore France (fichier .json « meshcore-config ») : matériel, firmware, date, réglages.
  // Les secrets (mots de passe, clé privée) ne sont jamais gardés.
  const fCfg = path.join(path.dirname(config.fichierBase), 'meshcore-configurations.json');
  let cfgs = {};
  try { cfgs = lireJson(fCfg) || {}; } catch { /* aucune */ }
  const PRESET_FR = '869.618,62.5,8,8';
  const SECRET = /^(password\b|set\s+(prv\.key|guest\.password|password)\b)/i;
  function importerConfiguration(doc, auteur) {
    if (!doc || doc.format !== 'meshcore-config' || !Array.isArray(doc.commandes)) throw new Error('Fichier attendu : sauvegarde .json du configurateur MeshCore France');
    const cmds = doc.commandes.map((c) => String(c).trim()).filter((c) => c && !SECRET.test(c)).slice(0, 300).map((c) => c.slice(0, 200));
    const val = (re) => { const c = cmds.find((x) => re.test(x)); return c ? c.replace(re, '').trim() : null; };
    const cle = /^[0-9A-F]{64}$/i.test((doc.identite || {}).cle_publique || '') ? doc.identite.cle_publique.toUpperCase() : null;
    const nom = String(val(/^set\s+name\s+/i) || doc.nom || '').slice(0, 40);
    if (!cle && !nom) throw new Error('Sauvegarde sans nom ni clé publique : impossible de la rattacher à un répéteur');
    const radio = (val(/^set\s+radio\s+/i) || '').replace(/\s+/g, '') || null;
    const lat = Number(val(/^set\s+lat\s+/i)), lon = Number(val(/^set\s+lon\s+/i));
    const fiche = {
      cle, nom, carte: String(doc.carte || '').slice(0, 80) || null, firmware: doc.firmware ? String(doc.firmware).slice(0, 80) : null,
      date: Date.parse(doc.date) || null, radio, lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null,
      regions: cmds.filter((c) => /^region\s+put\s+/i.test(c)).map((c) => c.replace(/^region\s+put\s+/i, '').trim()).slice(0, 20),
      commandes: cmds, importe: Date.now(), auteur: auteur || null,
    };
    cfgs[cle || 'nom:' + nom.toLowerCase()] = fiche;
    try { ecrireSur(fCfg, JSON.stringify(cfgs)); } catch { /* lecture seule */ }
    journal('[MeshCore] sauvegarde du configurateur importée :', nom || cle.slice(0, 8));
    return fiche;
  }
  const configurationDe = (n) => cfgs[n.cle] || cfgs['nom:' + String(n.nom || '').toLowerCase()] || null;

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
      // Recommandations françaises (MeshCore France), vérifiées sans mot de passe d'après ce que la carte entend
      if (!/^\d{2,3}/.test(n.nom || '')) aFaire.push('France : nom sans numéro de département au début (ex. « 43PUYE_Rep »)');
      if (n.lat == null) aFaire.push('France : position non annoncée (set lat / set lon)');
      const cfg = configurationDe(n);
      if (cfg && cfg.radio && cfg.radio !== PRESET_FR) aFaire.push(`France : configurée en ${cfg.radio} (fréquence, bande, SF, CR) au lieu du preset français ${PRESET_FR}`);
      if (reseauMc.annoncesDe) {
        const a = reseauMc.annoncesDe(n.cle, Date.now() - 2 * 86400000);
        if (a.tailles.length && Math.max(...a.tailles) === 1) aFaire.push('France : chemins sur 1 octet ; recommandé : set path.hash.mode 1 (2 octets)');
        if (a.inondations > 6) aFaire.push(`France : ${a.inondations} annonces en inondation en 2 jours ; recommandé : set flood.advert.interval 24 (une par jour)`);
      }
      return {
        cle: n.cle, nom: n.nom || n.cle.slice(0, 8), role: n.role, dernierVu: n.dernier_vu, lat: n.lat, lon: n.lon,
        firmware: infos.version || null, materiel: infos.carte || null, etatFw, derniereVersion: ref ? ref.version : null,
        motDePasse: memo.has(n.cle), lu: lu.heure || null, aFaire, configuration: (() => { const c = configurationDe(n); return c ? { ...c, commandes: undefined, nbCommandes: c.commandes.length } : null; })(),
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
    if (h !== conf.heure || Date.now() - (conf.lancee || 0) < 20 * 3600000 || !companion.etat().pret) return;
    try { lancer(); } catch (e) { journal('[MeshCore] conformité automatique :', e.message); conf.lancee = Date.now(); sauver(); }
  }, 5 * 60000);
  if (m.unref) m.unref();

  // Alertes de maintenance : versions à problème, matériel sous avis, nouvelle version publiée avec des répéteurs
  // en retard, room servers encore en mode répéteur (abandonné en 1.18), taille de hachage différente du réseau
  let cacheAlertes = null;
  function alertes() {
    if (cacheAlertes && Date.now() - cacheAlertes.heure < 10 * 60000) return cacheAlertes.l;
    const l = [], e = etat(), t = Date.now();
    for (const n of e.noeuds) {
      const v = n.firmware ? (versionNum(n.firmware) || []).join('.') : null;
      for (const a of AVIS) {
        if (a.versions && !(v && a.versions.includes(v))) continue;
        if (a.materiel && !(n.materiel && a.materiel.test(n.materiel))) continue;
        l.push({ cle: `mc-avis:${a.id}:${n.cle}`, noeud: n.cle, type: 'avis', niveau: a.niveau, nom: n.nom, depuis: n.lu || t, message: `${n.nom} : ${a.message}` });
      }
      const lu = adminMc.lecture(n.cle) || {};
      const fw = versionNum(n.firmware);
      if (n.role === 'salon' && (lu.valeurs || {}).repeat === 'on' && (!fw || comparer(fw, [1, 18, 0]) >= 0)) {
        l.push({ cle: `mc-salon-repeat:${n.cle}`, noeud: n.cle, type: 'avis', niveau: 'attention', nom: n.nom, depuis: lu.heure || t,
          message: `${n.nom} : room server encore en mode répéteur, abandonné depuis le firmware 1.18 (set repeat off, et un répéteur dédié pour relayer)` });
      }
    }
    for (const [type, lib, role] of [['repeater', 'répéteurs', 'repeteur'], ['room-server', 'room servers', 'salon']]) {
      const ref = versions && versions[type];
      if (!ref || !ref.date || t - Date.parse(ref.date) > 21 * 86400000) continue;
      const retard = e.noeuds.filter((n) => n.role === role && n.etatFw === 'retard');
      if (retard.length) l.push({ cle: `mc-version:${ref.tag}`, type: 'version', niveau: 'attention', depuis: Date.parse(ref.date),
        message: `MeshCore ${ref.version} publié le ${new Date(ref.date).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' })} : ${retard.length} de vos ${lib} à mettre à jour (${retard.slice(0, 4).map((n) => n.nom).join(', ')}${retard.length > 4 ? '…' : ''})` });
    }
    if (auditMc) {
      try {
        const z = config.zone;
        const h = auditMc.collisions({ bbox: [z[0], z[1], z[2], z[3]] }).hachages;
        for (const x of (h && h.ecarts) || []) l.push({ cle: `mc-hachage:${x.cle}`, noeud: x.cle, type: 'avis', niveau: 'attention', nom: x.nom, depuis: t,
          message: `${x.nom} : chemins en ${x.taille} octet${x.taille > 1 ? 's' : ''} alors que le réseau est en ${h.majoritaire} (set path.hash.mode ${h.majoritaire - 1})` });
      } catch (err) { journal('[MeshCore] hachages :', err.message); }
    }
    cacheAlertes = { heure: t, l };
    return l;
  }

  return {
    etat,
    alertes,
    importerConfiguration,
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
