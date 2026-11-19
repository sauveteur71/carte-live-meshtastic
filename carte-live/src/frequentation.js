'use strict';
// Fréquentation de la carte (administrateurs) : pages ouvertes, visiteurs uniques par jour, pays, provenance.
// Respect de la vie privée : aucune adresse IP n'est gardée, ni sur disque ni en clair en mémoire. Un visiteur est
// reconnu dans la journée par une empreinte (HMAC de son adresse et de son navigateur avec un sel tiré au hasard
// chaque jour, jamais écrit) ; seuls des compteurs par jour sont enregistrés. Pas de cookie, rien chez un tiers.
// Le pays vient de la base libre DB-IP « IP to Country Lite » (CC BY 4.0), téléchargée une fois par mois sur le
// serveur et consultée sur place.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const ROBOTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|curl|wget|python|go-http|headless|monitor|uptime/i;
const CONSERVATION_JOURS = 400;

function creerFrequentation({ db, config, journal = () => {}, clientsEnLigne = () => 0 }) {
  const actif = () => String(process.env.STATS_FREQUENTATION || 'oui').toLowerCase() !== 'non';
  db.exec(`CREATE TABLE IF NOT EXISTS frequentation (
    jour TEXT NOT NULL, page TEXT NOT NULL, pays TEXT NOT NULL, provenance TEXT NOT NULL DEFAULT '', visites INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (jour, page, pays, provenance))`);
  db.exec(`CREATE TABLE IF NOT EXISTS frequentation_visiteurs (
    jour TEXT NOT NULL, pays TEXT NOT NULL, visiteurs INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (jour, pays))`);
  const q = {
    visites: db.prepare(`INSERT INTO frequentation (jour, page, pays, provenance, visites) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (jour, page, pays, provenance) DO UPDATE SET visites = visites + excluded.visites`),
    visiteurs: db.prepare(`INSERT INTO frequentation_visiteurs (jour, pays, visiteurs) VALUES (?, ?, ?)
      ON CONFLICT (jour, pays) DO UPDATE SET visiteurs = visiteurs + excluded.visiteurs`),
    purger: db.prepare('DELETE FROM frequentation WHERE jour < ?'),
    purgerV: db.prepare('DELETE FROM frequentation_visiteurs WHERE jour < ?'),
    parJour: db.prepare('SELECT jour, SUM(visites) AS visites FROM frequentation WHERE jour >= ? GROUP BY jour'),
    visiteursParJour: db.prepare('SELECT jour, SUM(visiteurs) AS visiteurs FROM frequentation_visiteurs WHERE jour >= ? GROUP BY jour'),
    parPays: db.prepare('SELECT pays, SUM(visiteurs) AS visiteurs FROM frequentation_visiteurs WHERE jour >= ? GROUP BY pays ORDER BY visiteurs DESC'),
    visitesPays: db.prepare('SELECT pays, SUM(visites) AS visites FROM frequentation WHERE jour >= ? GROUP BY pays'),
    parPage: db.prepare('SELECT page, SUM(visites) AS visites FROM frequentation WHERE jour >= ? GROUP BY page ORDER BY visites DESC'),
    parProvenance: db.prepare("SELECT provenance, SUM(visites) AS visites FROM frequentation WHERE jour >= ? AND provenance <> '' GROUP BY provenance ORDER BY visites DESC LIMIT 30"),
  };

  // ---- Pays : base DB-IP Lite (mmdb) dans le dossier des données, renouvelée chaque mois ----
  const dossierGeo = path.join(path.dirname(config.fichierBase), 'geoip');
  const fichierGeo = path.join(dossierGeo, 'dbip-country-lite.mmdb');
  let lecteur = null, etatGeo = 'absente', telechargement = null;
  function chargerGeo() {
    try { const { Reader } = require('maxmind'); lecteur = new Reader(fs.readFileSync(fichierGeo)); etatGeo = 'prête'; }
    catch { lecteur = null; etatGeo = fs.existsSync(fichierGeo) ? 'illisible' : 'absente'; }
  }
  async function telechargerGeo() {
    if (telechargement) return telechargement;
    telechargement = (async () => {
      const d = new Date();
      const mois = (k) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 1)); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`; };
      for (const m of [mois(0), mois(1)]) {
        try {
          const r = await fetch(`https://download.db-ip.com/free/dbip-country-lite-${m}.mmdb.gz`, { signal: AbortSignal.timeout(120000) });
          if (!r.ok) continue;
          const brut = zlib.gunzipSync(Buffer.from(await r.arrayBuffer()));
          fs.mkdirSync(dossierGeo, { recursive: true });
          fs.writeFileSync(fichierGeo + '.tmp', brut);
          fs.renameSync(fichierGeo + '.tmp', fichierGeo);
          chargerGeo();
          journal(`Fréquentation : base des pays DB-IP ${m} chargée`);
          return true;
        } catch (e) { journal('Fréquentation : base des pays indisponible :', e.message); }
      }
      etatGeo = lecteur ? etatGeo : 'indisponible';
      return false;
    })().finally(() => { telechargement = null; });
    return telechargement;
  }
  const geoActive = () => String(process.env.STATS_PAYS || 'oui').toLowerCase() !== 'non';
  function verifierGeo() {
    if (!actif() || !geoActive()) return;
    let age = Infinity;
    try { age = Date.now() - fs.statSync(fichierGeo).mtimeMs; } catch { /* absente */ }
    if (!lecteur && age < Infinity) chargerGeo();
    if (age > 32 * 86400000) telechargerGeo();
  }
  setTimeout(verifierGeo, 15000).unref();
  setInterval(verifierGeo, 24 * 3600000).unref();

  // Adresse : réseau local et VPN repérés sans base ; sinon pays (code ISO) ou « ? »
  function pays(ip) {
    ip = String(ip || '').replace(/^::ffff:/, '');
    if (!ip || ip === '127.0.0.1' || ip === '::1' || /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^f[cd]/i.test(ip) || /^fe80:/i.test(ip)) return 'LAN';
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return 'VPN'; // Tailscale et autres CGNAT
    if (!lecteur || !geoActive()) return '?';
    try { const x = lecteur.get(ip); return (x && x.country && x.country.iso_code) || '?'; } catch { return '?'; }
  }

  // ---- Comptage en mémoire, écrit toutes les minutes ----
  let jourCourant = '', sel = null, vus = new Set();
  const enAttente = new Map(); // jour|page|pays|provenance → visites
  const visiteursEnAttente = new Map(); // jour|pays → visiteurs
  const aujourdhui = () => new Date().toISOString().slice(0, 10);
  function noter(req, page) {
    if (!actif()) return;
    const ua = String(req.get('user-agent') || '');
    if (!ua || ROBOTS.test(ua)) return;
    const jour = aujourdhui();
    if (jour !== jourCourant) { jourCourant = jour; sel = crypto.randomBytes(32); vus = new Set(); }
    const p = pays(req.ip);
    let prov = '';
    try {
      const ref = req.get('referer');
      if (ref) { const h = new URL(ref).hostname.replace(/^www\./, '').toLowerCase(); if (h && h !== String(req.hostname || '').replace(/^www\./, '').toLowerCase()) prov = h.slice(0, 80); }
    } catch { /* provenance illisible */ }
    // Facebook, Messenger… regroupés : l.facebook.com, m.facebook.com → facebook.com
    prov = prov.replace(/^(?:l|lm|m|mbasic|web)\.(facebook\.com|messenger\.com)$/, '$1').replace(/^(?:t|out)\.co$/, 'x.com');
    const k = `${jour}|${page}|${p}|${prov}`;
    enAttente.set(k, (enAttente.get(k) || 0) + 1);
    const empreinte = crypto.createHmac('sha256', sel).update(String(req.ip) + '|' + ua).digest('base64').slice(0, 16);
    if (!vus.has(empreinte)) { vus.add(empreinte); const kv = `${jour}|${p}`; visiteursEnAttente.set(kv, (visiteursEnAttente.get(kv) || 0) + 1); }
  }
  function ecrire() {
    if (!enAttente.size && !visiteursEnAttente.size) return;
    try {
      db.transaction(() => {
        for (const [k, n] of enAttente) { const [j, pg, p, pr] = k.split('|'); q.visites.run(j, pg, p, pr, n); }
        for (const [k, n] of visiteursEnAttente) { const [j, p] = k.split('|'); q.visiteurs.run(j, p, n); }
      })();
      enAttente.clear(); visiteursEnAttente.clear();
    } catch (e) { journal('Fréquentation : écriture impossible :', e.message); }
  }
  setInterval(ecrire, 60000).unref();
  setInterval(() => { const l = new Date(Date.now() - CONSERVATION_JOURS * 86400000).toISOString().slice(0, 10); q.purger.run(l); q.purgerV.run(l); }, 24 * 3600000).unref();

  function resume(jours = 30) {
    ecrire();
    jours = Math.min(Math.max(Number(jours) || 30, 1), CONSERVATION_JOURS);
    const depuis = new Date(Date.now() - (jours - 1) * 86400000).toISOString().slice(0, 10);
    const v = new Map(q.parJour.all(depuis).map((x) => [x.jour, { visites: x.visites, visiteurs: 0 }]));
    for (const x of q.visiteursParJour.all(depuis)) { const e = v.get(x.jour) || { visites: 0, visiteurs: 0 }; e.visiteurs = x.visiteurs; v.set(x.jour, e); }
    const parJour = [];
    for (let k = jours - 1; k >= 0; k--) { const j = new Date(Date.now() - k * 86400000).toISOString().slice(0, 10); parJour.push({ jour: j, ...(v.get(j) || { visites: 0, visiteurs: 0 }) }); }
    const somme = (l, c) => l.reduce((s, x) => s + (x[c] || 0), 0);
    const visitesPays = new Map(q.visitesPays.all(depuis).map((x) => [x.pays, x.visites]));
    const aj = parJour[parJour.length - 1];
    return {
      actif: actif(), jours, enLigne: clientsEnLigne(),
      aujourdhui: aj, total: { visites: somme(parJour, 'visites'), visiteurs: somme(parJour, 'visiteurs') },
      parJour,
      pays: q.parPays.all(depuis).map((x) => ({ pays: x.pays, visiteurs: x.visiteurs, visites: visitesPays.get(x.pays) || 0 })),
      pages: q.parPage.all(depuis),
      provenances: q.parProvenance.all(depuis),
      geo: { etat: geoActive() ? etatGeo : 'désactivée', source: 'DB-IP (CC BY 4.0)' },
    };
  }
  return { noter, resume, ecrire, pays, telechargerGeo, etatGeo: () => etatGeo };
}

module.exports = { creerFrequentation };
