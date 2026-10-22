'use strict';
// Administration à distance des répéteurs et room servers MeshCore, par le companion de la carte.
//
// Principe (comme l'appli officielle) : connexion au nœud avec son mot de passe admin, puis commandes CLI
// (« get name », « set tx 20 »…) envoyées en messages chiffrés ; le nœud répond par un message « CLI ».
// Les opérations sont des tâches (une seule à la fois, la radio étant partagée), suivies en direct par la page.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Réglages lus et modifiables (commande get / set)
const PARAMS = [
  { cle: 'name', nom: 'Nom', type: 'texte', max: 31 },
  { cle: 'radio', nom: 'Radio (MHz, kHz, SF, CR)', type: 'radio', redemarrage: true, sensible: true },
  { cle: 'tx', nom: 'Puissance (dBm)', type: 'nombre', min: 1, max: 30 },
  { cle: 'repeat', nom: 'Répétition des paquets', type: 'onoff' },
  { cle: 'flood.max', nom: 'Sauts max. (inondation)', type: 'nombre', min: 0, max: 64 },
  { cle: 'flood.max.advert', nom: 'Sauts max. des annonces', type: 'nombre', min: 0, max: 64 },
  { cle: 'advert.interval', nom: 'Annonce aux voisins (min)', type: 'nombre', min: 0, max: 240 },
  { cle: 'flood.advert.interval', nom: 'Annonce au réseau (h)', type: 'nombre', min: 0, max: 168 },
  { cle: 'path.hash.mode', nom: 'Taille des hachages de chemin', type: 'liste', valeurs: [['0', '1 octet'], ['1', '2 octets'], ['2', '3 octets']] },
  { cle: 'txdelay', nom: 'Délai de relais (inondation)', type: 'nombre', min: 0, max: 2, pas: 0.1 },
  { cle: 'direct.txdelay', nom: 'Délai de relais (direct)', type: 'nombre', min: 0, max: 2, pas: 0.1 },
  { cle: 'dutycycle', nom: 'Cycle d’émission max. (%)', type: 'nombre', min: 1, max: 100 },
  { cle: 'multi.acks', nom: 'Accusés multiples', type: 'nombre', min: 0, max: 3 },
  { cle: 'loop.detect', nom: 'Détection des boucles', type: 'liste', valeurs: [['off', 'non'], ['minimal', 'minimale'], ['moderate', 'modérée'], ['strict', 'stricte']] },
  { cle: 'lat', nom: 'Latitude', type: 'nombre', min: -90, max: 90, pas: 0.000001 },
  { cle: 'lon', nom: 'Longitude', type: 'nombre', min: -180, max: 180, pas: 0.000001 },
  { cle: 'owner.info', nom: 'Infos propriétaire', type: 'texte', max: 120 },
];
const INFOS = [{ cmd: 'ver', cle: 'version', nom: 'Firmware' }, { cmd: 'board', cle: 'carte', nom: 'Matériel' }, { cmd: 'get role', cle: 'role', nom: 'Rôle' }, { cmd: 'clock', cle: 'horloge', nom: 'Horloge du nœud' }];
// Éléments comparables entre nœuds (vérification de conformité)
const ELEMENTS = ['radio', 'tx', 'repeat', 'flood.max', 'flood.max.advert', 'advert.interval', 'flood.advert.interval', 'path.hash.mode', 'txdelay', 'direct.txdelay', 'dutycycle', 'multi.acks', 'loop.detect'];
const ELEMENTS_DEFAUT = ['radio', 'repeat', 'flood.max', 'advert.interval', 'flood.advert.interval', 'path.hash.mode'];
// Commandes refusées depuis la console (destructrices ou exposant des secrets)
const INTERDITES = /^(erase|set prv\.key|get prv\.key|start ota)\b/i;

const nettoyer = (r) => String(r || '').replace(/^>\s?/, '').trim();
function normaliser(cle, v) {
  v = nettoyer(v);
  if (cle === 'radio') return v.split(',').map((x, i) => (i < 2 ? String(Number(x)) : String(parseInt(x, 10)))).join(',');
  if (cle === 'dutycycle') return String(Math.round(parseFloat(v) * 10) / 10);
  if (['txdelay', 'direct.txdelay', 'lat', 'lon'].includes(cle)) return String(Number(v));
  return v;
}
function valeurValide(p, v) {
  v = String(v ?? '').trim();
  if (p.type === 'texte') { if (!v || Buffer.byteLength(v) > p.max || /[\r\n]/.test(v)) throw new Error(`${p.nom} : 1 à ${p.max} caractères`); return v; }
  if (p.type === 'onoff') { if (!['on', 'off'].includes(v)) throw new Error(`${p.nom} : on ou off`); return v; }
  if (p.type === 'liste') { if (!p.valeurs.some(([x]) => x === v)) throw new Error(`${p.nom} : valeur inconnue`); return v; }
  if (p.type === 'radio') {
    const m = /^(\d{3}(?:\.\d{1,4})?),(\d+(?:\.\d+)?),(\d{1,2}),(\d)$/.exec(v.replace(/\s/g, ''));
    if (!m || +m[3] < 5 || +m[3] > 12 || +m[4] < 5 || +m[4] > 8) throw new Error('Radio : fréquence,bande,SF,CR (ex. 869.618,62.5,8,8)');
    return `${m[1]},${m[2]},${m[3]},${m[4]}`;
  }
  const n = Number(v.replace(',', '.'));
  if (!Number.isFinite(n) || n < p.min || n > p.max) throw new Error(`${p.nom} : entre ${p.min} et ${p.max}`);
  return String(n);
}
// Liste « neighbors » : une ligne par voisin « préfixe:horodatage:snr×4 »
function lireVoisins(t) {
  return String(t || '').split(/\r?\n/).map((l) => l.trim().replace(/^>\s?/, '')).map((l) => /^([0-9A-Fa-f]{2,64}):(\d+):(-?\d+)/.exec(l)).filter(Boolean)
    .map((m) => ({ prefixe: m[1].toUpperCase(), vu: Number(m[2]) * 1000 || null, snr: Number(m[3]) / 4 }));
}

function creerAdministrationMc(config, companion, reseauMc, journal, surFin = () => {}) {
  const dossier = path.dirname(config.fichierBase);
  const fMdp = path.join(dossier, 'meshcore-admin.json');
  const fLectures = path.join(dossier, 'meshcore-lectures.json');
  const lire = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
  const motsDePasse = lire(fMdp); // clé -> mot de passe (fichier lisible seulement par le service)
  const lectures = lire(fLectures); // clé -> { heure, valeurs, infos, statut, voisins }
  const ecrire = (f, o) => { try { fs.writeFileSync(f, JSON.stringify(o), { mode: 0o600 }); } catch (e) { journal('enregistrement impossible :', e.message); } };

  const taches = new Map();
  const file = [];
  let enCours = null;

  function noeud(cle) {
    const n = reseauMc.q.noeud.get(String(cle).toUpperCase());
    if (!n) throw new Error('nœud MeshCore inconnu');
    return { cle: n.cle, nom: n.nom, role: n.role, lat: n.lat, lon: n.lon, horodatageAnnonce: n.horodatage_annonce };
  }

  function lancer(type, cles, params = {}, auteur = '?') {
    if (!Array.isArray(cles) || !cles.length || cles.length > 40) throw new Error('choisissez de 1 à 40 nœuds');
    const liste = cles.map((c) => noeud(c));
    if (type === 'cli') {
      const c = String(params.commande || '').trim();
      if (!c) throw new Error('commande vide');
      if (INTERDITES.test(c)) throw new Error('commande refusée depuis la carte (destructrice ou secrète) : utilisez la console série du nœud');
    }
    if (type === 'modifier') {
      const v = params.valeurs || {};
      if (!Object.keys(v).length) throw new Error('aucun réglage à changer');
      for (const [k, x] of Object.entries(v)) {
        const p = PARAMS.find((y) => y.cle === k);
        if (!p) throw new Error('réglage inconnu : ' + k);
        v[k] = valeurValide(p, x);
      }
    }
    if (type === 'verifier' && liste.length < 2) throw new Error('choisissez au moins 2 nœuds (le premier sert de référence)');
    if (!['lire', 'statut', 'voisins', 'cli', 'modifier', 'verifier', 'annonce', 'horloge', 'redemarrer', 'chemin'].includes(type)) throw new Error('opération inconnue');
    const t = {
      id: crypto.randomBytes(5).toString('hex'), type, cles: liste.map((n) => n.cle), noms: Object.fromEntries(liste.map((n) => [n.cle, n.nom])), params: { ...params, motDePasse: undefined },
      motDePasse: params.motDePasse || null, memoriser: !!params.memoriser, statut: 'en_attente', creee: Date.now(), auteur, etapes: [], resultats: {}, arret: false,
    };
    taches.set(t.id, t);
    if (taches.size > 60) taches.delete(taches.keys().next().value);
    file.push(t);
    setImmediate(suivante);
    return vue(t);
  }

  const etape = (t, cle, texte, ok = true) => { t.etapes.push({ heure: Date.now(), cle, texte, ok }); if (t.etapes.length > 400) t.etapes.shift(); };

  async function avecReprise(fn, essais = 2) {
    let derniere;
    for (let k = 0; k < essais; k++) {
      try { return await fn(); } catch (e) { derniere = e; if (/refusé|inconnu|invalide|non relié/i.test(e.message)) break; }
    }
    throw derniere;
  }

  async function seConnecter(t, n) {
    const mdp = t.motDePasse || motsDePasse[n.cle];
    if (!mdp && mdp !== '') throw new Error('mot de passe admin inconnu : saisissez-le');
    etape(t, n.cle, 'connexion…');
    const r = await avecReprise(() => companion.connexion(n, mdp));
    if (!r.admin) etape(t, n.cle, 'connecté en invité seulement (mot de passe invité ?) : réglages en lecture limitée', false);
    else etape(t, n.cle, `connecté en admin${r.inondation ? ' (chemin inconnu : envoi en inondation)' : ''}`);
    if (t.motDePasse && t.memoriser) { motsDePasse[n.cle] = t.motDePasse; ecrire(fMdp, motsDePasse); }
    return r;
  }
  const cli = (t, n, c) => avecReprise(() => companion.cli(n, c));

  async function lireConfig(t, n, cles = null) {
    const res = lectures[n.cle] || { valeurs: {}, infos: {} };
    res.valeurs = res.valeurs || {}; res.infos = res.infos || {};
    const aLire = PARAMS.filter((p) => !cles || cles.includes(p.cle));
    for (const p of aLire) {
      if (t.arret) throw new Error('arrêté');
      try {
        const r = await cli(t, n, 'get ' + p.cle);
        if (/^\?\?|unknown|error/i.test(r)) { etape(t, n.cle, `${p.nom} : non géré par ce firmware`, false); continue; }
        res.valeurs[p.cle] = normaliser(p.cle, r);
        etape(t, n.cle, `${p.nom} = ${res.valeurs[p.cle]}`);
      } catch (e) { etape(t, n.cle, `${p.nom} : ${e.message}`, false); }
      t.resultats[n.cle] = { ...(t.resultats[n.cle] || {}), valeurs: { ...res.valeurs } };
    }
    if (!cles) {
      for (const i of INFOS) {
        if (t.arret) throw new Error('arrêté');
        try { res.infos[i.cle] = nettoyer(await cli(t, n, i.cmd)); etape(t, n.cle, `${i.nom} : ${res.infos[i.cle]}`); } catch (e) { etape(t, n.cle, `${i.nom} : ${e.message}`, false); }
      }
    }
    res.heure = Date.now();
    lectures[n.cle] = res;
    ecrire(fLectures, lectures);
    t.resultats[n.cle] = { ...(t.resultats[n.cle] || {}), valeurs: res.valeurs, infos: res.infos };
    return res;
  }

  async function statut(t, n) {
    etape(t, n.cle, 'demande de l’état…');
    const s = await avecReprise(() => companion.statut(n));
    lectures[n.cle] = { ...(lectures[n.cle] || {}), statut: { ...s, heure: Date.now() } };
    ecrire(fLectures, lectures);
    t.resultats[n.cle] = { ...(t.resultats[n.cle] || {}), statut: s };
    if (s.batterieMv != null) reseauMc.noterEtat(n.cle, s);
    etape(t, n.cle, `batterie ${(s.batterieMv / 1000).toFixed(2)} V · bruit ${s.bruitDbm} dBm · émission ${s.occupationEmissionPct ?? '?'} % du temps`);
  }

  async function voisins(t, n) {
    const brut = await cli(t, n, 'neighbors');
    const v = reseauMc.lierVoisins(n.cle, lireVoisins(brut));
    lectures[n.cle] = { ...(lectures[n.cle] || {}), voisins: v, heureVoisins: Date.now() };
    ecrire(fLectures, lectures);
    t.resultats[n.cle] = { ...(t.resultats[n.cle] || {}), voisins: v };
    etape(t, n.cle, v.length ? `${v.length} voisin(s) : ${v.map((x) => `${x.nom || x.prefixe} (${x.snr} dB)`).join(', ')}` : 'aucun voisin entendu récemment');
  }

  async function executer(t) {
    const elements = Array.isArray(t.params.elements) && t.params.elements.length ? t.params.elements.filter((e) => ELEMENTS.includes(e)) : ELEMENTS_DEFAUT;
    for (const cle of t.cles) {
      if (t.arret) break;
      const n = noeud(cle);
      t.courant = cle;
      try {
        // L'état et la découverte de chemin ne demandent pas de connexion admin
        if (!['statut', 'chemin'].includes(t.type) || t.motDePasse || motsDePasse[n.cle]) await seConnecter(t, n).catch((e) => { if (!['statut', 'chemin'].includes(t.type)) throw e; etape(t, n.cle, 'connexion : ' + e.message + ' (on continue sans)', false); });
        switch (t.type) {
          case 'lire': await lireConfig(t, n); await statut(t, n).catch((e) => etape(t, n.cle, 'état : ' + e.message, false)); await voisins(t, n).catch((e) => etape(t, n.cle, 'voisins : ' + e.message, false)); break;
          case 'statut': await statut(t, n); break;
          case 'chemin': {
            etape(t, n.cle, 'découverte du chemin (requête en inondation)…');
            const r = await companion.decouvrirChemin(n);
            const moi = companion.etat();
            const res = (l) => { const rs = reseauMc.resoudreChemin(l, null, null); return l.map((h, i) => ({ prefixe: h, cle: rs[i] ? rs[i].cle : null, nom: rs[i] ? rs[i].nom : null })); };
            const aller = res(r.aller), retour = res(r.retour);
            t.resultats[n.cle] = { ...(t.resultats[n.cle] || {}), chemin: { aller, retour, dureeMs: r.dureeMs, de: moi.nom } };
            lectures[n.cle] = { ...(lectures[n.cle] || {}), chemin: { aller, retour, dureeMs: r.dureeMs, heure: Date.now() } };
            ecrire(fLectures, lectures);
            const txt = (l) => (l.length ? l.map((x) => x.nom || x.prefixe).join(' › ') : 'direct');
            etape(t, n.cle, `aller : ${moi.nom || 'companion'} › ${txt(aller)} › ${n.nom} · retour : ${txt(retour)} · ${(r.dureeMs / 1000).toFixed(1)} s`);
            break;
          }
          case 'voisins': await voisins(t, n); break;
          case 'verifier': await lireConfig(t, n, elements); break;
          case 'annonce': etape(t, n.cle, nettoyer(await cli(t, n, t.params.inondation === false ? 'advert.zerohop' : 'advert'))); break;
          case 'horloge': etape(t, n.cle, nettoyer(await cli(t, n, 'clock sync'))); break;
          case 'redemarrer':
            await companion.cli(n, 'reboot', 8000).catch(() => {}); // pas de réponse : le nœud redémarre
            etape(t, n.cle, 'ordre de redémarrage envoyé (pas de réponse attendue)');
            break;
          case 'cli': {
            const r = await cli(t, n, t.params.commande);
            t.resultats[n.cle] = { ...(t.resultats[n.cle] || {}), reponse: r };
            etape(t, n.cle, `> ${t.params.commande}\n${r}`);
            if (/^neighbors$/i.test(t.params.commande.trim())) reseauMc.lierVoisins(n.cle, lireVoisins(r));
            break;
          }
          case 'modifier': {
            const v = t.params.valeurs;
            const echecs = [];
            let redemarrage = false;
            for (const [k, x] of Object.entries(v)) {
              if (t.arret) break;
              const p = PARAMS.find((y) => y.cle === k);
              const r = nettoyer(await cli(t, n, `set ${k} ${x}`).catch((e) => 'ERR ' + e.message));
              const ok = /^ok/i.test(r) || (k === 'repeat' && /repeat is now/i.test(r));
              if (/reboot/i.test(r) || p.redemarrage) redemarrage = true;
              etape(t, n.cle, `${p.nom} → ${x} : ${r}`, ok);
              if (!ok) echecs.push(p.nom);
            }
            await lireConfig(t, n, Object.keys(v)).catch(() => {});
            const lu = (lectures[n.cle] || {}).valeurs || {};
            const ecarts = Object.entries(v).filter(([k, x]) => lu[k] !== undefined && normaliser(k, lu[k]) !== normaliser(k, x)).map(([k]) => k);
            t.resultats[n.cle] = { ...(t.resultats[n.cle] || {}), echecs, ecarts, redemarrage };
            if (redemarrage) etape(t, n.cle, 'un redémarrage du nœud est nécessaire pour appliquer la radio (bouton « Redémarrer »)', false);
            if (echecs.length || ecarts.length) throw new Error('réglages non appliqués : ' + [...new Set([...echecs, ...ecarts])].join(', '));
            break;
          }
          default: break;
        }
        t.resultats[n.cle] = { ...(t.resultats[n.cle] || {}), ok: true };
      } catch (e) {
        etape(t, n.cle, e.message, false);
        t.resultats[n.cle] = { ...(t.resultats[n.cle] || {}), ok: false, erreur: e.message };
        // Vérification : sans la référence, inutile de continuer
        if (t.type === 'verifier' && cle === t.cles[0]) { t.arret = true; etape(t, null, 'référence illisible : vérification arrêtée', false); }
      }
    }
    if (t.type === 'verifier') t.rapport = comparer(t, elements);
  }

  function comparer(t, elements) {
    const ref = t.cles[0];
    const vr = (t.resultats[ref] || {}).valeurs || {};
    return {
      reference: ref, elements,
      noeuds: t.cles.slice(1).map((cle) => {
        const r = t.resultats[cle] || {}, v = r.valeurs || {};
        if (!r.ok) return { cle, nom: t.noms[cle], lu: false, erreur: r.erreur || 'non lu' };
        const ecarts = elements.filter((e) => vr[e] !== undefined && v[e] !== undefined && vr[e] !== v[e]).map((e) => ({ element: e, reference: vr[e], valeur: v[e] }));
        return { cle, nom: t.noms[cle], lu: true, conforme: !ecarts.length, ecarts };
      }),
    };
  }

  async function suivante() {
    if (enCours || !file.length) return;
    const t = file.shift();
    if (t.arret) { t.statut = 'annule'; return suivante(); }
    enCours = t;
    t.statut = 'en_cours'; t.debut = Date.now();
    journal(`tâche MeshCore ${t.type} sur ${t.cles.length} nœud(s) (${t.auteur})`);
    try { await executer(t); } catch (e) { etape(t, null, e.message, false); }
    t.fin = Date.now();
    t.courant = null;
    t.motDePasse = null;
    const res = Object.values(t.resultats);
    t.statut = t.arret ? 'annule' : res.length && res.every((r) => r.ok) && res.length === t.cles.length ? 'ok' : 'echec';
    enCours = null;
    try { surFin(vue(t)); } catch { /* ignoré */ }
    setImmediate(suivante);
  }

  function vue(t, complet = true) {
    const v = { id: t.id, type: t.type, cles: t.cles, noms: t.noms, params: t.params, statut: t.statut, creee: t.creee, debut: t.debut, fin: t.fin, auteur: t.auteur, courant: t.courant };
    if (complet) Object.assign(v, { etapes: t.etapes, resultats: t.resultats, rapport: t.rapport || null });
    return v;
  }

  // Supervision : interrogation périodique de l'état des répéteurs surveillés, quand le companion est relié
  let derniereSupervision = 0;
  setInterval(() => {
    const h = config.meshcore.supervisionHeures;
    if (!h || enCours || file.length || !companion.etat().connecte || Date.now() - derniereSupervision < h * 3600000) return;
    derniereSupervision = Date.now();
    const contacts = new Set(companion.contacts().map((c) => c.cle));
    const cibles = reseauMc.surveilles(Object.keys(motsDePasse))
      .sort((a, b) => (motsDePasse[b.cle] ? 2 : contacts.has(b.cle) ? 1 : 0) - (motsDePasse[a.cle] ? 2 : contacts.has(a.cle) ? 1 : 0) || (b.dernier_vu || 0) - (a.dernier_vu || 0))
      .slice(0, config.meshcore.supervisionMax).map((n) => n.cle);
    if (cibles.length) { journal(`supervision : état de ${cibles.length} répéteur(s)`); lancer('statut', cibles, {}, 'supervision'); }
  }, 60000);

  return {
    PARAMS, ELEMENTS, ELEMENTS_DEFAUT,
    supervision: () => ({ derniere: derniereSupervision || null, intervalleHeures: config.meshcore.supervisionHeures }),
    lancer,
    tache: (id) => { const t = taches.get(id); return t ? vue(t) : null; },
    taches: () => [...taches.values()].reverse().slice(0, 30).map((t) => vue(t, false)),
    arreter(id) { const t = taches.get(id); if (!t) throw new Error('tâche inconnue'); t.arret = true; if (t.statut === 'en_attente') t.statut = 'annule'; },
    lecture: (cle) => lectures[String(cle).toUpperCase()] || null,
    memorises: () => Object.keys(motsDePasse),
    lectures: () => Object.fromEntries(Object.entries(lectures).map(([k, v]) => [k, { heure: v.heure, nom: (v.valeurs || {}).name }])),
    oublierMotDePasse(cle) { delete motsDePasse[String(cle).toUpperCase()]; ecrire(fMdp, motsDePasse); },
    memoriserMotDePasse(cle, mdp) { motsDePasse[String(cle).toUpperCase()] = String(mdp); ecrire(fMdp, motsDePasse); },
  };
}

module.exports = { creerAdministrationMc, lireVoisins, valeurValide, PARAMS, ELEMENTS };
