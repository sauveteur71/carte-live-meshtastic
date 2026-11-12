'use strict';
// Passerelle inter-réseaux Meshtastic ⇄ MeshCore (messages texte de canal uniquement).
// Désactivée par défaut : un administrateur l'active depuis son panneau (Outils › Passerelle inter-réseaux) ;
// PASSERELLE=1 dans le .env l'active au premier démarrage, PASSERELLE=0 l'interdit (bouton masqué). Outil d'appoint (exercice, événement,
// panne d'un réseau), pas une passerelle permanente : chaque règle se coupe d'un clic, et la passerelle entière
// se met en pause depuis son panneau.
//
// Entrées : les messages de canal déjà décodés par la carte (Meshtastic par MQTT ou module, MeshCore par le
// companion ou les observateurs). Sorties : le module Meshtastic principal et le companion MeshCore principal.
//
// Protections (cahier des charges) :
//  - anti-écho : ce qu'envoient nos propres modules n'est jamais repris (EF-10a) ;
//  - anti-boucle : un texte qui commence par [MT] ou [MC] n'est jamais retransmis (EF-10) ;
//  - anti-doublon : même canal, même expéditeur, même texte dans les N minutes (EF-11) ;
//  - quotas par règle et par sens, plafond global, file courte : au-delà, les plus anciens sont abandonnés (EF-10c) ;
//  - filtres par règle (expéditeurs, mot-clé requis ou exclu, longueur, heures silencieuses) et liste noire globale ;
//  - coalescence facultative par règle (EF-10e) ; journal motivé de chaque rejet (EF-10f).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LIMITE_MT = 200; // octets d'un texte Meshtastic
const LIMITE_MC = 140; // octets d'un texte de canal MeshCore (le firmware y ajoute « nom: »)
const SENS = { mt2mc: 'MT → MC', mc2mt: 'MC → MT', bi: 'MT ⇄ MC' };
const MOTIFS = { echo: 'écho de notre module', prefixe: 'préfixe passerelle', doublon: 'doublon', quota: 'quota', file: 'file pleine', expediteur: 'expéditeur filtré', motcle: 'mot-clé', longueur: 'longueur', silence: 'heures silencieuses', listeNoire: 'liste noire', horsLigne: 'module hors ligne', pause: 'passerelle en pause', erreur: 'erreur d’envoi' };
const DEFAUT = { prefixeMt: '[MT]', prefixeMc: '[MC]', avecExpediteur: true, ttlDoublonMin: 10, quotaRegleMin: 6, quotaGlobalMin: 60, fileMax: 10, coalescenceS: 30, ecartEnvoiS: 4, pause: false };

function creerPasserelle({ config, journal, audit, nomMt, envoyerMt, envoyerMc, etatMt, etatMc }) {
  const fichier = path.join(path.dirname(config.fichierBase), 'passerelle.json');
  let donnees = { regles: [], listeNoire: [], reglages: { ...DEFAUT } };
  try { const d = JSON.parse(fs.readFileSync(fichier, 'utf8')); donnees = { ...donnees, ...d, reglages: { ...DEFAUT, ...(d.reglages || {}) } }; } catch { /* aucun */ }
  // Activée ou non : choix de l'administrateur gardé dans passerelle.json, sinon la valeur du .env
  if (typeof donnees.activee !== 'boolean') donnees.activee = !!config.passerelle.actif;
  const sauver = () => { try { fs.writeFileSync(fichier, JSON.stringify(donnees, null, 1), { mode: 0o600 }); } catch (e) { journal('[Passerelle] enregistrement impossible :', e.message); } };

  // ---- Journal, statistiques ----
  const jrn = []; // { heure, type: in|out|drop, texte }
  const stats = { depuis: Date.now(), mt2mc: 0, mc2mt: 0, agreges: 0, rejets: {} };
  function noter(type, texte, motif) {
    jrn.push({ heure: Date.now(), type, texte: String(texte).slice(0, 300), motif: motif || null });
    if (jrn.length > 400) jrn.splice(0, jrn.length - 400);
    if (type === 'drop' && motif) stats.rejets[motif] = (stats.rejets[motif] || 0) + 1;
  }

  // ---- Outils ----
  const FLECHE = { mt2mc: '→', mc2mt: '←', bi: '⇄' };
  const diese = (n) => (String(n || '').startsWith('#') ? n : '#' + n);
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/^#/, '');
  const octets = (s) => Buffer.byteLength(s, 'utf8');
  const tronquer = (s, max) => { if (octets(s) <= max) return s; let t = s; while (octets(t + '…') > max) t = t.slice(0, -1); return t + '…'; };
  const doublons = new Map(); // empreinte -> heure
  const empreinte = (reseau, canal, de, texte) => crypto.createHash('sha1').update(`${reseau}|${norm(canal)}|${norm(de)}|${texte}`).digest('hex');
  const r = () => donnees.reglages;
  function heuresSilence(spec, d = new Date()) {
    const m = String(spec || '').match(/^\s*(\d{1,2})\s*[-–h:]+\s*(\d{1,2})/);
    if (!m) return false;
    const a = +m[1], b = +m[2], h = Number(d.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }));
    return a <= b ? h >= a && h < b : h >= a || h < b;
  }
  function surListeNoire(reseau, de, nom) {
    return donnees.listeNoire.some((b) => (b.reseau === reseau && (String(b.id) === String(de) || norm(b.nom) === norm(nom)))
      || (b.reciproque && b.reseau !== reseau && norm(b.nom) && norm(b.nom) === norm(nom)));
  }

  // ---- Files d'envoi (par règle et par sens), quotas, coalescence ----
  const files = new Map(); // `${id}|${sens}` -> { messages: [{texte, de}], ouverture }
  const envoisRecents = { regle: new Map(), global: [], dernier: { mt: 0, mc: 0 } };
  function prefixe(sensVers, nom) {
    const p = sensVers === 'mc' ? r().prefixeMt : r().prefixeMc;
    return r().avecExpediteur && nom ? `${p.replace(/\]$/, '')}|${nom}]` : p;
  }
  function moduleEnLigne(vers) { return vers === 'mc' ? !!(etatMc().pret) : !!(etatMt().connecte); }

  function entrer(regle, sensVers, msg) {
    const k = `${regle.id}|${sensVers}`;
    const f = files.get(k) || { messages: [], ouverture: Date.now() };
    if (!f.messages.length) f.ouverture = Date.now();
    f.messages.push(msg);
    const max = Math.max(1, r().fileMax);
    while (f.messages.length > max) { const x = f.messages.shift(); noter('drop', `${regle.libelle} : ${x.texte}`, MOTIFS.file); }
    files.set(k, f);
  }

  async function traiterFiles() {
    if (r().pause) return;
    const t = Date.now();
    envoisRecents.global = envoisRecents.global.filter((x) => t - x < 60000);
    for (const [k, f] of files) {
      if (!f.messages.length) continue;
      const [id, vers] = k.split('|');
      const regle = donnees.regles.find((x) => x.id === id);
      if (!regle || !regle.actif) { for (const x of f.messages) noter('drop', `${x.texte}`, MOTIFS.pause); f.messages = []; continue; }
      if (!moduleEnLigne(vers)) continue; // la file attend le retour du module (bornée)
      // Coalescence : attendre la fin de la fenêtre, sauf si le bloc atteint la taille maximale
      const limite = vers === 'mc' ? LIMITE_MC - octets(String(etatMc().nom || '')) - 2 : LIMITE_MT;
      let texte, nb = 1;
      if (regle.coalescence) {
        const bloc = [];
        for (const x of f.messages) {
          const essai = [...bloc, x];
          const t2 = `${prefixe(vers, null)} ${essai.map((y) => `${y.de ? y.de + ': ' : ''}${y.texte}`).join(' / ')}`;
          if (octets(t2) > limite && bloc.length) break;
          bloc.push(x);
        }
        const plein = bloc.length < f.messages.length;
        if (!plein && t - f.ouverture < r().coalescenceS * 1000) continue;
        texte = tronquer(`${prefixe(vers, null)} ${bloc.map((y) => `${y.de ? y.de + ': ' : ''}${y.texte}`).join(' / ')}`, limite);
        nb = bloc.length;
      } else {
        const x = f.messages[0];
        texte = tronquer(`${prefixe(vers, x.de)} ${x.texte}`, limite);
      }
      // Quotas : par règle et par sens (par minute), global, et écart minimal entre deux émissions sur un même réseau
      const rec = (envoisRecents.regle.get(k) || []).filter((x) => t - x < 60000);
      if (rec.length >= r().quotaRegleMin || envoisRecents.global.length >= r().quotaGlobalMin || t - envoisRecents.dernier[vers] < r().ecartEnvoiS * 1000) { envoisRecents.regle.set(k, rec); continue; }
      const partis = f.messages.splice(0, nb);
      f.ouverture = Date.now();
      rec.push(t); envoisRecents.regle.set(k, rec); envoisRecents.global.push(t); envoisRecents.dernier[vers] = t;
      try {
        // Le canal est retrouvé par son nom au moment d'envoyer (la règle a pu être créée module débranché,
        // ou les canaux du module ont été réordonnés depuis)
        const c = indexCanal(vers, regle[vers].nom);
        if (c == null) throw new Error(`canal « ${regle[vers].nom} » absent ${vers === 'mc' ? 'du companion' : 'du module Meshtastic'}`);
        if (vers === 'mc') await envoyerMc(c, texte); else await envoyerMt(c, texte);
        stats[vers === 'mc' ? 'mt2mc' : 'mc2mt'] += 1;
        if (nb > 1) stats.agreges += nb - 1;
        noter('out', `${vers === 'mc' ? 'MC ' + diese(regle.mc.nom) : 'MT ' + diese(regle.mt.nom)} → ${texte}${nb > 1 ? ` (${nb} messages regroupés)` : ''}`);
      } catch (e) { for (const x of partis) noter('drop', `${regle.libelle} : ${x.texte}`, MOTIFS.erreur + ' : ' + e.message); }
    }
  }
  const minuterie = setInterval(() => { traiterFiles().catch((e) => journal('[Passerelle]', e.message)); }, 1000);
  minuterie.unref();

  // ---- Entrée : un message de canal vient d'être décodé ----
  // m : { reseau: 'mt'|'mc', canal, de (num Meshtastic ou nom MeshCore), nom, texte }
  function recevoir(m) {
    if (!donnees.activee || !m || !m.texte || !m.canal) return;
    const regles = donnees.regles.filter((x) => (m.reseau === 'mt' ? norm(x.mt.nom) === norm(m.canal) && x.sens !== 'mc2mt' : norm(x.mc.nom) === norm(m.canal) && x.sens !== 'mt2mc'));
    if (!regles.length) return;
    const texte = String(m.texte).trim();
    const source = `${m.reseau === 'mt' ? 'MT' : 'MC'} #${m.canal} ← ${m.nom || m.de || '?'}`;
    // Anti-écho : nos propres modules
    if (m.reseau === 'mt' ? etatMt().noeudLocal != null && Number(m.de) === Number(etatMt().noeudLocal) : norm(m.nom) && norm(m.nom) === norm(etatMc().nom)) { noter('drop', `${source} : ${texte}`, MOTIFS.echo); return; }
    // Anti-boucle : préfixe d'une passerelle (la nôtre ou une autre)
    const pre = [r().prefixeMt, r().prefixeMc].map((p) => p.replace(/\]$/, ''));
    if (pre.some((p) => texte.startsWith(p))) { noter('drop', `${source} : ${texte}`, MOTIFS.prefixe); return; }
    // Anti-doublon
    const e = empreinte(m.reseau, m.canal, m.nom || m.de, texte), t = Date.now();
    for (const [k, h] of doublons) if (t - h > r().ttlDoublonMin * 60000) doublons.delete(k);
    if (doublons.has(e)) { noter('drop', `${source} : ${texte}`, MOTIFS.doublon); return; }
    doublons.set(e, t);
    if (r().pause) { noter('drop', `${source} : ${texte}`, MOTIFS.pause); return; }
    if (surListeNoire(m.reseau, m.de, m.nom)) { noter('drop', `${source} : ${texte}`, MOTIFS.listeNoire); return; }
    noter('in', `${source} : « ${texte} »`);
    for (const regle of regles) {
      const vers = m.reseau === 'mt' ? 'mc' : 'mt';
      const lib = `${regle.libelle}`;
      if (!regle.actif) { noter('drop', `${lib} : ${texte}`, MOTIFS.pause); continue; }
      const f = regle.filtres || {};
      const bloques = String(f.expediteurs || '').split(/[,;\n]/).map(norm).filter(Boolean);
      if (bloques.some((b) => b === norm(m.nom) || b === norm(m.de) || b === norm('!' + Number(m.de).toString(16).padStart(8, '0')))) { noter('drop', `${lib} : ${texte}`, MOTIFS.expediteur); continue; }
      if (f.motRequis && !texte.toLowerCase().includes(String(f.motRequis).toLowerCase())) { noter('drop', `${lib} : ${texte}`, MOTIFS.motcle); continue; }
      if (f.motExclu && String(f.motExclu).split(/[,;]/).map((x) => x.trim().toLowerCase()).filter(Boolean).some((x) => texte.toLowerCase().includes(x))) { noter('drop', `${lib} : ${texte}`, MOTIFS.motcle); continue; }
      if (texte.length < (Number(f.longueurMin) || 2)) { noter('drop', `${lib} : ${texte}`, MOTIFS.longueur); continue; }
      if (f.silence && heuresSilence(f.silence)) { noter('drop', `${lib} : ${texte}`, MOTIFS.silence); continue; }
      if (!moduleEnLigne(vers)) noter('drop', `${lib} : ${texte} (gardé en file jusqu’au retour du module)`, MOTIFS.horsLigne);
      entrer(regle, vers, { texte, de: m.reseau === 'mt' ? m.nom || null : m.nom || null });
    }
  }

  // ---- Gestion ----
  function vue() {
    const mt = etatMt(), mc = etatMc();
    return {
      actif: donnees.activee,
      modules: { mt: { connecte: !!mt.connecte, nom: mt.nomLocal || null, canaux: mt.canaux || [] }, mc: { connecte: !!mc.pret, nom: mc.nom || null, canaux: mc.canaux || [] } },
      // Canaux connus de la carte (réglages), proposés quand le module ou le companion n'est pas relié
      profils: profils(),
      canauxConnus: {
        mt: (config.canaux || []).map((c) => c.nom).filter(Boolean),
        mc: ((config.meshcore && config.meshcore.canaux) || []).map((c) => String(c).split('=')[0].trim()).filter(Boolean),
      },
      regles: donnees.regles.map((x) => ({ ...x, enAttente: (files.get(`${x.id}|mc`) || { messages: [] }).messages.length + (files.get(`${x.id}|mt`) || { messages: [] }).messages.length })),
      listeNoire: donnees.listeNoire,
      reglages: donnees.reglages,
      stats: { ...stats },
      journal: jrn.slice(-200),
      motifs: MOTIFS,
      sens: SENS,
    };
  }
  // Index actuel d'un canal d'après son nom (null si le module ne l'a pas, ou est débranché)
  function indexCanal(cote, nom) {
    const l = (cote === 'mc' ? etatMc().canaux : etatMt().canaux) || [];
    const c = l.find((x) => norm(x.nom) === norm(nom));
    return c ? c.index : null;
  }
  // Canal choisi : par son index dans la liste du module, ou par son nom (saisi, ou canal connu de la carte)
  function canalChoisi(cote, index, nom) {
    const l = (cote === 'mc' ? etatMc().canaux : etatMt().canaux) || [];
    if (index !== undefined && index !== null && index !== '') {
      const c = l.find((x) => x.index === Number(index));
      if (c) return { index: c.index, nom: c.nom };
    }
    nom = String(nom || '').trim().replace(/^#(?=[^#])/, cote === 'mc' ? '#' : '');
    if (!nom || nom.length > 32) throw new Error(`Choisissez ou tapez le canal ${cote === 'mc' ? 'MeshCore' : 'Meshtastic'}`);
    const c = l.find((x) => norm(x.nom) === norm(nom));
    return c ? { index: c.index, nom: c.nom } : { index: null, nom };
  }
  function ajouterRegle({ mt, mc, mtNom, mcNom, sens, coalescence }, qui) {
    const cmt = canalChoisi('mt', mt, mtNom);
    const cmc = canalChoisi('mc', mc, mcNom);
    if (donnees.regles.some((x) => norm(x.mt.nom) === norm(cmt.nom) && norm(x.mc.nom) === norm(cmc.nom))) throw new Error('Cette liaison existe déjà');
    if (cmt.index === 0 && !donnees.reglages.canalPrincipalAutorise) throw new Error('Le canal principal Meshtastic (index 0) est exclu par défaut : autorisez-le dans les réglages de la passerelle');
    if (!SENS[sens]) throw new Error('Sens invalide');
    const regle = { id: crypto.randomBytes(4).toString('hex'), mt: { index: cmt.index, nom: cmt.nom }, mc: { index: cmc.index, nom: cmc.nom }, sens, coalescence: !!coalescence, actif: true, filtres: {}, creee: Date.now(), par: qui };
    regle.libelle = `MT ${diese(regle.mt.nom)} ${FLECHE[sens]} MC ${diese(regle.mc.nom)}`;
    donnees.regles.push(regle);
    sauver();
    return regle;
  }
  function modifierRegle(id, champs) {
    const regle = donnees.regles.find((x) => x.id === id);
    if (!regle) throw new Error('Règle inconnue');
    if (typeof champs.actif === 'boolean') regle.actif = champs.actif;
    if (typeof champs.coalescence === 'boolean') regle.coalescence = champs.coalescence;
    if (champs.sens && SENS[champs.sens]) { regle.sens = champs.sens; regle.libelle = `MT ${diese(regle.mt.nom)} ${FLECHE[regle.sens]} MC ${diese(regle.mc.nom)}`; }
    if (champs.filtres && typeof champs.filtres === 'object') {
      const f = champs.filtres, s = (v, n) => String(v || '').slice(0, n);
      regle.filtres = { expediteurs: s(f.expediteurs, 400), motRequis: s(f.motRequis, 40), motExclu: s(f.motExclu, 120), longueurMin: Math.min(50, Math.max(1, Number(f.longueurMin) || 2)), silence: s(f.silence, 20) };
    }
    sauver();
    return regle;
  }
  function supprimerRegle(id) {
    const n = donnees.regles.length;
    donnees.regles = donnees.regles.filter((x) => x.id !== id);
    files.delete(`${id}|mc`); files.delete(`${id}|mt`);
    sauver();
    return donnees.regles.length !== n;
  }
  function regler(o) {
    const g = donnees.reglages, num = (v, a, b, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : d; };
    if (typeof o.prefixeMt === 'string' && /^\[[^\]\s]{1,8}\]$/.test(o.prefixeMt.trim())) g.prefixeMt = o.prefixeMt.trim();
    if (typeof o.prefixeMc === 'string' && /^\[[^\]\s]{1,8}\]$/.test(o.prefixeMc.trim())) g.prefixeMc = o.prefixeMc.trim();
    if (typeof o.avecExpediteur === 'boolean') g.avecExpediteur = o.avecExpediteur;
    if (typeof o.pause === 'boolean') g.pause = o.pause;
    if (typeof o.canalPrincipalAutorise === 'boolean') g.canalPrincipalAutorise = o.canalPrincipalAutorise;
    if (o.ttlDoublonMin !== undefined) g.ttlDoublonMin = num(o.ttlDoublonMin, 1, 120, g.ttlDoublonMin);
    if (o.quotaRegleMin !== undefined) g.quotaRegleMin = num(o.quotaRegleMin, 1, 30, g.quotaRegleMin);
    if (o.quotaGlobalMin !== undefined) g.quotaGlobalMin = num(o.quotaGlobalMin, 1, 120, g.quotaGlobalMin);
    if (o.fileMax !== undefined) g.fileMax = num(o.fileMax, 1, 50, g.fileMax);
    if (o.coalescenceS !== undefined) g.coalescenceS = [10, 30, 60].includes(Number(o.coalescenceS)) ? Number(o.coalescenceS) : g.coalescenceS;
    if (o.ecartEnvoiS !== undefined) g.ecartEnvoiS = num(o.ecartEnvoiS, 2, 60, g.ecartEnvoiS);
    sauver();
    return g;
  }
  function bloquer({ reseau, id, nom, motif, reciproque }, qui) {
    if (!['mt', 'mc'].includes(reseau) || !(id || nom)) throw new Error('Choisissez un utilisateur');
    if (donnees.listeNoire.some((b) => b.reseau === reseau && String(b.id) === String(id || nom))) throw new Error('Déjà dans la liste noire');
    const b = { reseau, id: String(id || nom).slice(0, 80), nom: String(nom || id).slice(0, 60), motif: String(motif || '').slice(0, 120), reciproque: !!reciproque, ajoute: Date.now(), par: qui };
    donnees.listeNoire.push(b);
    sauver();
    return b;
  }
  function modifierBlocage(reseau, id, champs) {
    const b = donnees.listeNoire.find((x) => x.reseau === reseau && String(x.id) === String(id));
    if (!b) throw new Error('Entrée inconnue');
    if (typeof champs.reciproque === 'boolean') b.reciproque = champs.reciproque;
    sauver();
    return b;
  }
  function debloquer(reseau, id) {
    const n = donnees.listeNoire.length;
    donnees.listeNoire = donnees.listeNoire.filter((x) => !(x.reseau === reseau && String(x.id) === String(id)));
    sauver();
    return donnees.listeNoire.length !== n;
  }

  // Module émetteur perdu ou retrouvé : une ligne au journal (les files attendent son retour)
  let dernierEtat = null;
  setInterval(() => {
    const e = `${moduleEnLigne('mt') ? 1 : 0}${moduleEnLigne('mc') ? 1 : 0}`;
    if (dernierEtat != null && e !== dernierEtat && donnees.regles.some((x) => x.actif)) {
      journal(`[Passerelle] module Meshtastic ${e[0] === '1' ? 'en ligne' : 'hors ligne'}, companion MeshCore ${e[1] === '1' ? 'en ligne' : 'hors ligne'}`);
      noter('drop', `module Meshtastic ${e[0] === '1' ? 'en ligne' : 'HORS LIGNE'} · companion MeshCore ${e[1] === '1' ? 'en ligne' : 'HORS LIGNE'} : les règles concernées attendent son retour`, MOTIFS.horsLigne);
    }
    dernierEtat = e;
  }, 10000).unref();

  // Alertes « passerelle hors ligne » : une règle active dont le module émetteur est injoignable (EF-16).
  // Ses messages attendent en file (bornée) le retour du module : la liaison reprend toute seule.
  const horsLigneDepuis = { mt: null, mc: null };
  function alertes() {
    const l = [], t = Date.now();
    for (const v of ['mt', 'mc']) {
      const concernees = donnees.regles.filter((x) => x.actif && (v === 'mc' ? x.sens !== 'mc2mt' : x.sens !== 'mt2mc'));
      if (!donnees.activee || !concernees.length || donnees.reglages.pause || moduleEnLigne(v)) { horsLigneDepuis[v] = null; continue; }
      if (!horsLigneDepuis[v]) horsLigneDepuis[v] = t;
      l.push({ cle: 'passerelle:' + v, type: 'passerelle', niveau: 'attention', depuis: horsLigneDepuis[v],
        message: `Passerelle inter-réseaux : ${v === 'mt' ? 'module Meshtastic' : 'companion MeshCore'} hors ligne, ${concernees.length} liaison(s) en attente de son retour (${concernees.map((x) => x.libelle).join(', ')})` });
    }
    return l;
  }

  // Essai à blanc : ce que la passerelle ferait d'un message, sans rien envoyer ni rien compter
  function essayer(m) {
    const texte = String(m.texte || '').trim(), etapes = [];
    const refus = (motif) => ({ relaye: false, motif, etapes });
    if (!texte || !m.canal) return refus('message ou canal vide');
    if (!donnees.activee) return refus('passerelle désactivée');
    const regles = donnees.regles.filter((x) => (m.reseau === 'mt' ? norm(x.mt.nom) === norm(m.canal) && x.sens !== 'mc2mt' : norm(x.mc.nom) === norm(m.canal) && x.sens !== 'mt2mc'));
    if (!regles.length) return refus(`aucune liaison ne part du canal ${m.reseau === 'mt' ? 'Meshtastic' : 'MeshCore'} « ${m.canal} »`);
    const pre = [r().prefixeMt, r().prefixeMc].map((p) => p.replace(/\]$/, ''));
    if (pre.some((p) => texte.startsWith(p))) return refus(MOTIFS.prefixe);
    if (r().pause) return refus(MOTIFS.pause);
    if (surListeNoire(m.reseau, m.de, m.nom)) return refus(MOTIFS.listeNoire);
    const sorties = [];
    for (const regle of regles) {
      const vers = m.reseau === 'mt' ? 'mc' : 'mt', f = regle.filtres || {};
      const non = (motif) => etapes.push(`${regle.libelle} : refusé (${motif})`);
      if (!regle.actif) { non('liaison suspendue'); continue; }
      const bloques = String(f.expediteurs || '').split(/[,;\n]/).map(norm).filter(Boolean);
      if (bloques.some((b) => b === norm(m.nom))) { non(MOTIFS.expediteur); continue; }
      if (f.motRequis && !texte.toLowerCase().includes(String(f.motRequis).toLowerCase())) { non(MOTIFS.motcle); continue; }
      if (f.motExclu && String(f.motExclu).split(/[,;]/).map((x) => x.trim().toLowerCase()).filter(Boolean).some((x) => texte.toLowerCase().includes(x))) { non(MOTIFS.motcle); continue; }
      if (texte.length < (Number(f.longueurMin) || 2)) { non(MOTIFS.longueur); continue; }
      if (f.silence && heuresSilence(f.silence)) { non(MOTIFS.silence); continue; }
      const sortie = tronquer(`${prefixe(vers, m.nom || null)} ${texte}`, vers === 'mc' ? LIMITE_MC : LIMITE_MT);
      const c = indexCanal(vers, regle[vers].nom);
      etapes.push(`${regle.libelle} : ${c == null ? `serait relayé, mais le canal « ${regle[vers].nom} » est absent ${vers === 'mc' ? 'du module MeshCore' : 'du module Meshtastic'} (ou le module n’est pas relié)` : 'relayé'}`);
      sorties.push({ vers, canal: regle[vers].nom, texte: sortie, pret: c != null });
    }
    return { relaye: sorties.length > 0, sorties, etapes, motif: sorties.length ? null : 'refusé par les filtres' };
  }
  // Profils : image complète (liaisons, liste noire, réglages) enregistrée sous un nom (« normal », « crise »…)
  function profils() { return Object.entries(donnees.profils || {}).map(([nom, p]) => ({ nom, regles: (p.regles || []).length, heure: p.heure, par: p.par })); }
  function enregistrerProfil(nom, qui) {
    nom = String(nom || '').trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,20}$/.test(nom)) throw new Error('Nom de profil : 1 à 20 lettres, chiffres, - ou _');
    donnees.profils = donnees.profils || {};
    if (Object.keys(donnees.profils).length >= 12 && !donnees.profils[nom]) throw new Error('12 profils au plus');
    donnees.profils[nom] = JSON.parse(JSON.stringify({ regles: donnees.regles, listeNoire: donnees.listeNoire, reglages: donnees.reglages, heure: Date.now(), par: qui }));
    sauver();
    journal(`[Passerelle] profil « ${nom} » enregistré par ${qui}`);
    return profils();
  }
  function chargerProfil(nom, qui) {
    const p = (donnees.profils || {})[String(nom || '').toLowerCase()];
    if (!p) throw new Error('Profil inconnu');
    donnees.regles = JSON.parse(JSON.stringify(p.regles || [])); donnees.listeNoire = JSON.parse(JSON.stringify(p.listeNoire || [])); donnees.reglages = { ...DEFAUT, ...(p.reglages || {}) };
    files.clear();
    sauver();
    journal(`[Passerelle] profil « ${nom} » chargé par ${qui}`);
    noter('drop', `profil « ${nom} » chargé par ${qui}`, null);
    return vue();
  }
  function supprimerProfil(nom) { if (donnees.profils) delete donnees.profils[String(nom || '').toLowerCase()]; sauver(); return profils(); }
  function activer(oui, qui) {
    donnees.activee = !!oui;
    if (!oui) { files.clear(); }
    sauver();
    journal(`[Passerelle] ${oui ? 'activée' : 'désactivée'} par ${qui}`);
    noter('drop', `passerelle ${oui ? 'activée' : 'désactivée'} par ${qui}`, oui ? null : MOTIFS.pause);
    return vue();
  }
  if (donnees.activee) journal(`[Passerelle] activée : ${donnees.regles.length} règle(s)${donnees.reglages.pause ? ', en pause' : ''}`);
  return { essayer, profils, enregistrerProfil, chargerProfil, supprimerProfil, activer, active: () => donnees.activee, recevoir, vue, alertes, ajouterRegle, modifierRegle, supprimerRegle, regler, bloquer, modifierBlocage, debloquer, MOTIFS, SENS, nomMt };
}

module.exports = { creerPasserelle, LIMITE_MT, LIMITE_MC };
