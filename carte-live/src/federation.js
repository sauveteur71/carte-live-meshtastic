'use strict';
// Fédération entre cartes : chaque instance publie ses relais et leurs liaisons (/api/federation),
// et récupère celles des bulles voisines déclarées par l'admin. Les relais voisins apparaissent sur la carte
// et comptent dans les calculs de couverture près des limites du département.
const fs = require('fs');
const path = require('path');

function creerFederation({ config, stockage, reseau, installations, journal, version }) {
  const fichier = path.join(path.dirname(config.fichierBase), 'federation.json');
  let donnees = { partenaires: [] };
  try { donnees = JSON.parse(fs.readFileSync(fichier, 'utf8')); } catch { /* aucune */ }
  const etats = new Map(); // url → { heure, erreur, instance, relais, liens }
  const sauver = () => { try { fs.writeFileSync(fichier, JSON.stringify(donnees, null, 1)); } catch { /* ignoré */ } };

  // Ce que cette carte publie : relais et passerelles positionnés, entendus depuis 3 jours, et leurs liaisons
  function publier() {
    const limite = Date.now() - 3 * 86400000;
    const relais = stockage.q.noeuds.all().filter((n) => n.lat != null && reseau.estSurveille(n) && (n.dernier_vu || 0) >= limite)
      .map((n) => { const f = installations.radio(n.num); return { id: n.id, num: n.num, nom: n.nom_long || n.nom_court || n.id, role: n.role, lat: n.lat, lon: n.lon, alt: n.alt, passerelle: !!n.est_passerelle, dernierVu: n.dernier_vu, hauteur: f.h ?? null, gain: f.gain ?? null }; });
    const nums = new Set(relais.map((r) => r.num));
    const liens = reseau.liens(24 * 3600000).filter((l) => nums.has(l.a) && nums.has(l.b)).map((l) => ({ a: l.a, b: l.b, snr: l.snr, source: l.source, dernierVu: l.dernierVu }));
    return {
      format: 'carte-live-federation', version: 1, logiciel: version,
      instance: { nom: config.carte.titre, departement: config.departement, zone: config.zone },
      heure: Date.now(), relais, liens,
    };
  }

  async function recuperer(p) {
    const url = p.url.replace(/\/+$/, '') + '/api/federation';
    const e = { heure: Date.now(), erreur: null };
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'carte-live-federation/' + version } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.format !== 'carte-live-federation' || !Array.isArray(j.relais)) throw new Error('réponse inattendue (pas une carte live ?)');
      Object.assign(e, { instance: j.instance, relais: j.relais.slice(0, 500), liens: (j.liens || []).slice(0, 2000) });
    } catch (err) {
      e.erreur = err.message;
      const ancien = etats.get(p.url);
      if (ancien && ancien.relais) Object.assign(e, { instance: ancien.instance, relais: ancien.relais, liens: ancien.liens, perime: true });
    }
    etats.set(p.url, e);
    return e;
  }
  async function toutRecuperer() {
    for (const p of donnees.partenaires) { try { await recuperer(p); } catch (err) { journal('[Fédération]', err.message); } }
  }
  setTimeout(toutRecuperer, 20000).unref();
  setInterval(toutRecuperer, 10 * 60000).unref();

  // Relais des bulles voisines (sans doublon avec les nôtres)
  function relaisVoisins() {
    const locaux = new Set(stockage.q.noeuds.all().filter((n) => reseau.estSurveille(n)).map((n) => n.id));
    const r = [];
    for (const p of donnees.partenaires) {
      const e = etats.get(p.url);
      if (!e || !e.relais) continue;
      const bulle = p.nom || (e.instance && e.instance.nom) || p.url;
      for (const x of e.relais) if (!locaux.has(x.id)) r.push({ ...x, bulle, url: p.url });
    }
    return r;
  }

  return {
    publier,
    partenaires: () => donnees.partenaires.map((p) => {
      const e = etats.get(p.url) || {};
      return { url: p.url, nom: p.nom || (e.instance && e.instance.nom) || null, departement: e.instance ? e.instance.departement : null, relais: e.relais ? e.relais.length : 0, liens: e.liens ? e.liens.length : 0, heure: e.heure || null, erreur: e.erreur || null, perime: !!e.perime };
    }),
    async ajouter(url, nom) {
      let u;
      try { u = new URL(url); } catch { throw new Error('Adresse invalide (ex. https://carte.exemple.fr)'); }
      if (!/^https?:$/.test(u.protocol)) throw new Error('Adresse http(s) attendue');
      const propre = u.origin + u.pathname.replace(/\/+$/, '');
      if (donnees.partenaires.some((p) => p.url === propre)) throw new Error('Déjà déclarée');
      const p = { url: propre, nom: nom ? String(nom).slice(0, 60) : null };
      donnees.partenaires.push(p);
      sauver();
      return recuperer(p);
    },
    retirer(url) { donnees.partenaires = donnees.partenaires.filter((p) => p.url !== url); etats.delete(url); sauver(); },
    voisins() {
      const out = [];
      for (const p of donnees.partenaires) {
        const e = etats.get(p.url);
        if (!e || !e.relais) continue;
        out.push({ url: p.url, nom: p.nom || (e.instance && e.instance.nom) || p.url, departement: e.instance ? e.instance.departement : null, heure: e.heure, perime: !!e.perime, relais: e.relais, liens: e.liens || [] });
      }
      return out;
    },
    // Pour les calculs de relief : relais voisins positionnés, avec leur hauteur d'antenne si connue
    noeudsCalcul: () => relaisVoisins().map((x) => ({ num: 'fed-' + x.id, nom: `${x.nom} (${x.bulle})`, lat: x.lat, lon: x.lon, h: x.hauteur ?? undefined, gain: x.gain ?? undefined, voisin: true })),
  };
}

module.exports = { creerFederation };
