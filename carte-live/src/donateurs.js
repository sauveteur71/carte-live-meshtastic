'use strict';
// Mur des donateurs : affiche sur la carte ceux qui ont soutenu le projet, par exemple
// « 42BAR*** 🇫🇷 a donné 20 € pour soutenir le projet ».
//
// Deux sources, chacune activable/désactivable séparément par l'administrateur :
//  1. HelloAsso (dons à l'association Radio-club du Velay, formulaire déjà en ligne
//     https://www.helloasso.com/associations/radioclub-du-velay/formulaires/2) : l'API publique HelloAsso
//     (jeton OAuth2 client_credentials) sait lire les paiements d'un formulaire, mais ne dit pas si le donateur a
//     accepté d'être affiché publiquement. Le mur n'affiche donc JAMAIS un paiement HelloAsso automatiquement :
//     cette source reste une LISTE SAISIE À LA MAIN par l'administrateur, avec une case « accord du donateur »
//     obligatoire pour chaque entrée (voir manuelAjouter). Le code d'appel à l'API HelloAsso est prêt et utilisé
//     pour vérifier, depuis la page d'administration, que les identifiants fonctionnent (voir etat().erreurs),
//     mais il n'alimente jamais la liste publique.
//  2. GitHub Sponsors (sponsors personnels du compte GitHub d'Olivier Parriaux, sauveteur71) : API GraphQL,
//     avec un jeton d'administration stocké côté serveur et jamais envoyé au navigateur. Seuls les sponsors que
//     GitHub marque publics (privacyLevel = PUBLIC) sont affichés ; les sponsors privés ne sont jamais lus
//     nommément dans cette liste. Olivier est informé que ces versements vont sur son compte personnel (revenus
//     à déclarer) et les affiche quand même sur le mur, à côté des dons HelloAsso.
//
// Réglages (fichier .env) — tout est désactivé par défaut, rien n'est codé en dur :
//   HELLOASSO_ACTIF=oui
//   HELLOASSO_CLIENT_ID=…           (créés sur https://admin.helloasso.com, rubrique API, après inscription
//   HELLOASSO_CLIENT_SECRET=…        développeur HelloAsso — sans elle, la source reste manuelle uniquement)
//   HELLOASSO_ORGANISATION=radioclub-du-velay   (slug de l'association dans l'adresse HelloAsso)
//   HELLOASSO_FORMULAIRE=2                       (identifiant du formulaire, à la fin de son adresse)
//   GITHUB_SPONSORS_ACTIF=oui
//   GITHUB_SPONSORS_JETON=…         (jeton GitHub à lecture seule, droit « read:user » suffisant pour lire ses
//                                     propres sponsors ; jamais écrit dans ce fichier ni dans le journal)
//   GITHUB_SPONSORS_COMPTE=sauveteur71
//   DONATEURS_INTERVALLE_HEURES=1
// Ces réglages peuvent aussi être faits depuis la page d'administration (Réglages › Mur des donateurs) ; ils sont
// alors enregistrés dans donateurs.json, à côté de la base — jamais dans le fichier .env, jamais dans le journal,
// et jamais renvoyés en clair par l'API (seul un indicateur « défini » dit qu'une clé a été saisie).
const path = require('path');
const crypto = require('crypto');
const { ecrireSur, lireJson } = require('./fichiers');

const MAX_MANUEL = 200;

// Nom affiché : jamais le nom complet. Les premiers caractères sont gardés, le reste devient des étoiles.
// Exemple : « 42BARBE » -> « 42BAR*** »
function anonymiser(nom) {
  const n = String(nom || '').trim();
  if (!n) return 'Un donateur';
  const garde = Math.min(Math.max(2, Math.ceil(n.length / 3)), 6);
  return n.slice(0, garde) + '***';
}

function creerDonateurs({ config, journal = () => {}, fetch: fetchInjecte } = {}) {
  const f = fetchInjecte || globalThis.fetch;
  const fichier = path.join(path.dirname(config.fichierBase), 'donateurs.json');
  let d = {};
  try { d = lireJson(fichier); } catch { /* premier démarrage : rien à reprendre */ }
  const dh = (config.donateurs && config.donateurs.helloasso) || {};
  const dg = (config.donateurs && config.donateurs.githubSponsors) || {};
  const sauve = (d.reglages && d.reglages.helloasso) || {};
  const sauveG = (d.reglages && d.reglages.githubSponsors) || {};
  const etat = {
    reglages: {
      // Les réglages déjà enregistrés sur disque (page d'administration) priment sur le .env, comme pour les
      // autres sources (voir alertes-officielles.js, federation.js)
      helloasso: {
        actif: dh.actif || false, clientId: dh.clientId || '', clientSecret: dh.clientSecret || '',
        organisation: dh.organisation || 'radioclub-du-velay', formulaire: dh.formulaire || '2',
        ...sauve,
      },
      githubSponsors: {
        actif: dg.actif || false, jeton: dg.jeton || '', compte: dg.compte || 'sauveteur71',
        ...sauveG,
      },
      montantVisible: !!(d.reglages && d.reglages.montantVisible),
    },
    manuel: Array.isArray(d.manuel) ? d.manuel.slice(0, MAX_MANUEL) : [], // [{ id, nom, pays, montant, date, accord }]
    github: [], // sponsors publics lus sur GitHub (pas persisté : relu au démarrage, 15 s après le lancement)
    maj: null,
    erreurs: { helloasso: null, githubSponsors: null },
  };
  const sauver = () => {
    try { ecrireSur(fichier, JSON.stringify({ reglages: etat.reglages, manuel: etat.manuel })); }
    catch (e) { journal('[Donateurs] sauvegarde impossible :', e.message); }
  };

  // ---- HelloAsso : jeton OAuth2 (client_credentials), renouvelé avant son expiration -----------------------
  let jetonHa = null; // { valeur, expire }
  async function jetonHelloAsso() {
    const r = etat.reglages.helloasso;
    if (jetonHa && jetonHa.expire > Date.now() + 30000) return jetonHa.valeur;
    const corps = new URLSearchParams({ grant_type: 'client_credentials', client_id: r.clientId, client_secret: r.clientSecret });
    const rep = await f('https://api.helloasso.com/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: corps, signal: AbortSignal.timeout(20000),
    });
    if (!rep.ok) throw new Error(`HelloAsso : jeton refusé (HTTP ${rep.status})`);
    const j = await rep.json();
    if (!j.access_token) throw new Error('HelloAsso : jeton absent de la réponse');
    jetonHa = { valeur: j.access_token, expire: Date.now() + (Number(j.expires_in) || 1800) * 1000 };
    return jetonHa.valeur;
  }
  // Vérification de l'accès (diagnostic admin) : lit la première page de paiements du formulaire, sans jamais
  // les faire apparaître sur le mur (voir le commentaire d'en-tête : pas d'accord du donateur connu côté HelloAsso)
  async function verifierHelloAsso() {
    const r = etat.reglages.helloasso;
    if (!r.actif) return;
    if (!r.clientId || !r.clientSecret || !r.organisation || !r.formulaire) throw new Error('Identifiants HelloAsso incomplets');
    const jeton = await jetonHelloAsso();
    const url = `https://api.helloasso.com/v5/organizations/${encodeURIComponent(r.organisation)}/forms/Checkout/${encodeURIComponent(r.formulaire)}/payments?pageSize=20`;
    const rep = await f(url, { headers: { Authorization: 'Bearer ' + jeton }, signal: AbortSignal.timeout(20000) });
    if (!rep.ok) throw new Error(`HelloAsso : lecture des paiements refusée (HTTP ${rep.status})`);
  }

  // ---- GitHub Sponsors : API GraphQL (jeton d'administration, jamais exposé au navigateur) ------------------
  async function sponsorsGithub() {
    const r = etat.reglages.githubSponsors;
    if (!r.actif) return [];
    if (!r.jeton || !r.compte) throw new Error('Identifiants GitHub Sponsors incomplets');
    const requete = `query($login:String!){ user(login:$login){ sponsorshipsAsMaintainer(first:100, includePrivate:true, orderBy:{field:CREATED_AT, direction:DESC}){ nodes{ privacyLevel createdAt sponsorEntity{ __typename ... on User{ login name } ... on Organization{ login name } } tier{ monthlyPriceInDollars isOneTime } } } } }`;
    const rep = await f('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + r.jeton, 'Content-Type': 'application/json', 'User-Agent': 'carte-live-donateurs' },
      body: JSON.stringify({ query: requete, variables: { login: r.compte } }),
      signal: AbortSignal.timeout(20000),
    });
    if (!rep.ok) throw new Error(`GitHub Sponsors : HTTP ${rep.status}`);
    const j = await rep.json();
    if (j.errors && j.errors.length) throw new Error('GitHub Sponsors : ' + j.errors[0].message);
    const noeuds = ((j.data || {}).user && j.data.user.sponsorshipsAsMaintainer && j.data.user.sponsorshipsAsMaintainer.nodes) || [];
    // Seuls les sponsors que GitHub marque publics sont affichés ; les autres restent invisibles (y compris leur nom)
    return noeuds.filter((n) => n.privacyLevel === 'PUBLIC' && n.sponsorEntity).map((n) => ({
      nom: n.sponsorEntity.name || n.sponsorEntity.login,
      pays: null, // GitHub Sponsors ne communique pas le pays du sponsor
      montant: n.tier && !n.tier.isOneTime ? n.tier.monthlyPriceInDollars : null,
      devise: 'USD',
      date: n.createdAt,
      source: 'github',
    }));
  }

  // Fusion des deux sources, pour affichage public : noms anonymisés, montant masqué sauf réglage contraire,
  // seulement les entrées consenties (case « accord » pour HelloAsso, sponsor public pour GitHub)
  function fusionner() {
    const ha = etat.manuel.filter((e) => e && e.accord).map((e) => ({ nom: e.nom, pays: e.pays || null, montant: Number.isFinite(e.montant) ? e.montant : null, devise: 'EUR', date: e.date, source: 'helloasso' }));
    const gh = etat.reglages.githubSponsors.actif ? etat.github : [];
    return [...ha, ...gh]
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
      .map((x) => ({ nom: anonymiser(x.nom), pays: x.pays, montant: etat.reglages.montantVisible ? x.montant : null, devise: x.devise, source: x.source, date: x.date }));
  }

  // Une seule actualisation à la fois ; en cas d'erreur, la liste déjà en cache est conservée (pas de trou sur
  // le mur juste parce que GitHub ou HelloAsso est indisponible un moment)
  let enCours = false;
  async function rafraichir() {
    if (enCours) return;
    enCours = true;
    try {
      if (etat.reglages.githubSponsors.actif) {
        try { etat.github = await sponsorsGithub(); etat.erreurs.githubSponsors = null; }
        catch (e) { etat.erreurs.githubSponsors = e.message; journal('[Donateurs] GitHub Sponsors :', e.message); }
      } else { etat.github = []; etat.erreurs.githubSponsors = null; }
      if (etat.reglages.helloasso.actif) {
        try { await verifierHelloAsso(); etat.erreurs.helloasso = null; }
        catch (e) { etat.erreurs.helloasso = e.message; journal('[Donateurs] HelloAsso :', e.message); }
      } else { etat.erreurs.helloasso = null; }
      etat.maj = Date.now();
    } finally { enCours = false; }
  }

  const heures = Math.min(24, Math.max(1, Number((config.donateurs || {}).intervalleHeures) || 1));
  const minuterie = setInterval(rafraichir, heures * 3600000);
  if (minuterie.unref) minuterie.unref();
  const demarrage = setTimeout(rafraichir, 15000);
  if (demarrage.unref) demarrage.unref();

  return {
    // Mur public (/api/donateurs) : jamais les clés, jamais d'e-mail ni d'adresse, montant masqué par défaut
    liste: () => fusionner(),
    // Page d'administration : identifiants remplacés par un simple « défini : oui/non »
    etat: () => ({
      maj: etat.maj,
      erreurs: etat.erreurs,
      reglages: {
        helloasso: {
          actif: etat.reglages.helloasso.actif, organisation: etat.reglages.helloasso.organisation, formulaire: etat.reglages.helloasso.formulaire,
          clientIdDefini: !!etat.reglages.helloasso.clientId, clientSecretDefini: !!etat.reglages.helloasso.clientSecret,
        },
        githubSponsors: { actif: etat.reglages.githubSponsors.actif, compte: etat.reglages.githubSponsors.compte, jetonDefini: !!etat.reglages.githubSponsors.jeton },
        montantVisible: etat.reglages.montantVisible,
      },
      manuel: etat.manuel,
    }),
    regler(r = {}) {
      if (r.helloasso && typeof r.helloasso === 'object') {
        const h = r.helloasso, c = etat.reglages.helloasso;
        if (typeof h.actif === 'boolean') c.actif = h.actif;
        if (typeof h.organisation === 'string' && h.organisation.trim()) c.organisation = h.organisation.trim().slice(0, 80);
        if (typeof h.formulaire === 'string' && h.formulaire.trim()) c.formulaire = h.formulaire.trim().slice(0, 40);
        // Champ vide = inchangé (comme le mot de passe MQTT dans les réglages) : un secret n'est jamais effacé par erreur
        if (typeof h.clientId === 'string' && h.clientId) c.clientId = h.clientId.trim().slice(0, 200);
        if (typeof h.clientSecret === 'string' && h.clientSecret) { c.clientSecret = h.clientSecret.trim().slice(0, 200); jetonHa = null; }
      }
      if (r.githubSponsors && typeof r.githubSponsors === 'object') {
        const g = r.githubSponsors, c = etat.reglages.githubSponsors;
        if (typeof g.actif === 'boolean') c.actif = g.actif;
        if (typeof g.compte === 'string' && g.compte.trim()) c.compte = g.compte.trim().replace(/^@/, '').slice(0, 80);
        if (typeof g.jeton === 'string' && g.jeton) c.jeton = g.jeton.trim().slice(0, 200);
      }
      if (typeof r.montantVisible === 'boolean') etat.reglages.montantVisible = r.montantVisible;
      sauver();
      rafraichir();
      return this.etat();
    },
    // Liste manuelle HelloAsso : une entrée n'est acceptée qu'avec la case « accord du donateur » cochée
    manuelAjouter(e = {}) {
      const nom = String(e.nom || '').trim();
      if (!nom) throw new Error('Nom (ou pseudonyme) du donateur requis');
      if (e.accord !== true) throw new Error('La case « accord du donateur » doit être cochée avant d’afficher ce don sur la carte');
      const montant = e.montant === '' || e.montant == null ? null : Number(e.montant);
      const ligne = {
        id: crypto.randomBytes(6).toString('hex'),
        nom: nom.slice(0, 60),
        pays: String(e.pays || '').trim().slice(0, 2).toUpperCase() || null,
        montant: Number.isFinite(montant) && montant >= 0 ? montant : null,
        date: new Date().toISOString(),
        accord: true,
      };
      etat.manuel.unshift(ligne);
      etat.manuel = etat.manuel.slice(0, MAX_MANUEL);
      sauver();
      return ligne;
    },
    manuelRetirer(id) {
      const avant = etat.manuel.length;
      etat.manuel = etat.manuel.filter((x) => x.id !== id);
      if (etat.manuel.length === avant) throw new Error('Entrée inconnue');
      sauver();
    },
    rafraichir,
  };
}

module.exports = { creerDonateurs, anonymiser };
