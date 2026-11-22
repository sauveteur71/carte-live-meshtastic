'use strict';
// Mur des donateurs : affiche sur la carte ceux qui ont soutenu le projet, par exemple
// « 42B*** 🇫🇷 a donné 20 € pour soutenir le projet ».
//
// Deux sources, chacune activable/désactivable séparément par l'administrateur :
//  1. HelloAsso (dons à une association, par exemple le formulaire de don du Radio-club du Velay
//     https://www.helloasso.com/associations/radioclub-du-velay/formulaires/2) : l'API HelloAsso (jeton OAuth2
//     client_credentials) sait lire les paiements d'un formulaire — GET /v5/organizations/{slug}/forms/{type}/{formSlug}/payments,
//     réservé aux identifiants qui ont le privilège « AccessTransactions » côté HelloAsso — mais ne dit pas si le
//     donateur a accepté d'être affiché publiquement. Le mur n'affiche donc JAMAIS un paiement HelloAsso
//     automatiquement : cette source reste une LISTE SAISIE À LA MAIN par l'administrateur, avec une case
//     « accord du donateur » obligatoire pour chaque entrée (voir manuelAjouter). L'API ne sert qu'à vérifier,
//     depuis la page d'administration, que les identifiants fonctionnent : GET /v5/organizations/{slug}/forms
//     (liste des formulaires, aucun paiement nominatif lu). Le type de formulaire (HELLOASSO_TYPE : Donation par
//     défaut ; CrowdFunding, Membership, Event, PaymentForm, Checkout, Shop) ne sert qu'à l'adresse des paiements.
//  2. GitHub Sponsors (parrainages du compte GitHub réglé) : API GraphQL, avec un jeton stocké côté serveur et
//     jamais envoyé au navigateur. Seuls les parrainages publics sont demandés (includePrivate: false) : les
//     sponsors privés ne sont jamais lus, même pas leur nom. Ces versements vont sur le compte personnel du
//     titulaire (revenus à déclarer), à lui de décider s'il les affiche.
//
// Réglages (fichier .env) — tout est désactivé par défaut, rien n'est codé en dur :
//   HELLOASSO_ACTIF=oui
//   HELLOASSO_CLIENT_ID=…           (créés sur https://admin.helloasso.com, rubrique API, après inscription
//   HELLOASSO_CLIENT_SECRET=…        développeur HelloAsso — sans elle, la source reste manuelle uniquement)
//   HELLOASSO_ORGANISATION=radioclub-du-velay   (slug de l'association dans l'adresse HelloAsso)
//   HELLOASSO_FORMULAIRE=2                       (slug du formulaire, à la fin de son adresse)
//   HELLOASSO_TYPE=Donation                      (type du formulaire, voir ci-dessus)
//   GITHUB_SPONSORS_ACTIF=oui
//   GITHUB_SPONSORS_JETON=…         (jeton GitHub à lecture seule, droit « read:user » suffisant pour lire ses
//                                     propres sponsors ; jamais écrit dans ce fichier ni dans le journal)
//   GITHUB_SPONSORS_COMPTE=sauveteur71
//   DONATEURS_INTERVALLE_HEURES=1
// Ces réglages peuvent aussi être faits depuis la page d'administration (Réglages › Mur des donateurs). Seul ce qui
// a été SAISI DANS LA PAGE est alors enregistré dans donateurs.json (droits 600, à côté de la base) : un secret qui
// vient du .env n'y est jamais recopié. Un réglage saisi prime sur le .env tant qu'il n'est pas effacé depuis la
// page (bouton « Effacer », qui rend la main au .env). Rien n'est écrit dans le journal, et l'API ne renvoie jamais un
// secret en clair (seul un indicateur « défini » dit qu'une clé a été saisie).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ecrireSur, lireJson } = require('./fichiers');

const MAX_MANUEL = 200;
const TYPES_HELLOASSO = ['CrowdFunding', 'Membership', 'Event', 'Donation', 'PaymentForm', 'Checkout', 'Shop'];
const PAGES_GITHUB_MAX = 5; // 100 parrainages par page : au-delà de 500, les plus anciens ne sont pas lus (plafond documenté)
const RE_SLUG = /^[a-z0-9][a-z0-9_-]{0,79}$/i;

// Dons HelloAsso saisis à la main : nom affiché tel que l'administrateur l'a saisi (à lui de l'abréger s'il le veut,
// choix d'Olivier). Parrains GitHub Sponsors (lus automatiquement) : jamais le nom complet. Règle : au plus la moitié des caractères est gardée (1 seul pour un nom
// de 3 caractères ou moins, 6 au plus), le reste devient « *** ». Compté en caractères Unicode (un émoji n'est
// jamais coupé en deux). Exemples : « 42BARBE » → « 42B*** », « Jo » → « J*** », « F4GLD » → « F4*** ».
function anonymiser(nom) {
  const c = Array.from(String(nom || '').trim());
  if (!c.length) return 'Un donateur';
  const garde = c.length <= 3 ? 1 : Math.min(Math.floor(c.length / 2), 6);
  return c.slice(0, garde).join('') + '***';
}

const chaine = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function creerDonateurs({ config, journal = () => {}, fetch: fetchInjecte } = {}) {
  const f = fetchInjecte || globalThis.fetch;
  const fichier = path.join(path.dirname(config.fichierBase), 'donateurs.json');
  let d = {};
  try { d = lireJson(fichier); } catch { /* premier démarrage : rien à reprendre */ }
  // Fichier déjà là en 644 (versions précédentes) : resserré au démarrage, il contient des secrets saisis
  try { if (fs.existsSync(fichier)) fs.chmodSync(fichier, 0o600); } catch { /* système de fichiers sans droits (SMB) */ }
  const dh = (config.donateurs && config.donateurs.helloasso) || {};
  const dg = (config.donateurs && config.donateurs.githubSponsors) || {};
  // Ce qui a été saisi dans la page (seule partie enregistrée) ; le .env fournit le reste
  const saisi = {
    helloasso: (d.reglages && d.reglages.helloasso && typeof d.reglages.helloasso === 'object') ? d.reglages.helloasso : {},
    githubSponsors: (d.reglages && d.reglages.githubSponsors && typeof d.reglages.githubSponsors === 'object') ? d.reglages.githubSponsors : {},
    montantVisible: !!(d.reglages && d.reglages.montantVisible),
  };
  const typeHa = (t) => (TYPES_HELLOASSO.includes(t) ? t : 'Donation');
  // Réglages effectifs : .env, recouvert par ce qui a été saisi dans la page
  const reglages = () => ({
    helloasso: {
      actif: dh.actif || false, clientId: dh.clientId || '', clientSecret: dh.clientSecret || '',
      organisation: dh.organisation || '', formulaire: dh.formulaire || '', type: typeHa(dh.type),
      ...saisi.helloasso,
    },
    githubSponsors: { actif: dg.actif || false, jeton: dg.jeton || '', compte: dg.compte || '', ...saisi.githubSponsors },
    montantVisible: saisi.montantVisible,
  });
  const etat = {
    manuel: Array.isArray(d.manuel) ? d.manuel.filter((e) => e && typeof e === 'object').slice(0, MAX_MANUEL) : [], // [{ id, nom, pays, montant, date, accord }]
    github: [], // sponsors publics lus sur GitHub (pas persisté : relu au démarrage, 15 s après le lancement)
    maj: null,
    erreurs: { helloasso: null, githubSponsors: null },
  };
  // Enregistrement (droits 600) : une erreur remonte à l'appelant, qui doit répondre en erreur plutôt que faire
  // croire que le réglage est pris
  const sauver = () => {
    try { ecrireSur(fichier, JSON.stringify({ reglages: saisi, manuel: etat.manuel }), { mode: 0o600 }); }
    catch (e) { journal('[Donateurs] enregistrement impossible :', e.message); const err = new Error('Enregistrement impossible : ' + e.message); err.code = 'SAUVEGARDE'; throw err; }
  };

  // ---- HelloAsso : jeton OAuth2 (client_credentials), renouvelé avant son expiration -----------------------
  let jetonHa = null; // { valeur, expire }
  async function jetonHelloAsso() {
    const r = reglages().helloasso;
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
  // Vérification de l'accès (diagnostic admin) : liste des formulaires de l'association, sans lire un seul
  // paiement (voir l'en-tête : pas d'accord du donateur connu côté HelloAsso). Le formulaire réglé doit y figurer.
  async function verifierHelloAsso() {
    const r = reglages().helloasso;
    if (!r.actif) return;
    if (!r.clientId || !r.clientSecret || !r.organisation || !r.formulaire) throw new Error('Identifiants HelloAsso incomplets');
    if (!RE_SLUG.test(r.organisation) || !RE_SLUG.test(r.formulaire)) throw new Error('HelloAsso : slug d’organisation ou de formulaire invalide');
    const jeton = await jetonHelloAsso();
    const url = `https://api.helloasso.com/v5/organizations/${encodeURIComponent(r.organisation)}/forms?formTypes=${encodeURIComponent(r.type)}&pageSize=100`;
    const rep = await f(url, { headers: { Authorization: 'Bearer ' + jeton }, signal: AbortSignal.timeout(20000) });
    if (rep.status === 401) { jetonHa = null; throw new Error('HelloAsso : accès refusé (HTTP 401), identifiants à vérifier'); }
    if (!rep.ok) throw new Error(`HelloAsso : lecture des formulaires refusée (HTTP ${rep.status})`);
    const j = await rep.json().catch(() => ({}));
    const liste = Array.isArray(j.data) ? j.data : [];
    if (liste.length && !liste.some((x) => x && String(x.formSlug) === String(r.formulaire))) throw new Error(`HelloAsso : formulaire « ${r.formulaire} » introuvable parmi les formulaires ${r.type} de l’association`);
  }
  // Adresse des paiements du formulaire réglé (jamais appelée automatiquement : exige le privilège
  // AccessTransactions côté HelloAsso, et le mur n'affiche que des dons saisis à la main)
  const urlPaiementsHelloAsso = () => {
    const r = reglages().helloasso;
    return `https://api.helloasso.com/v5/organizations/${encodeURIComponent(r.organisation)}/forms/${encodeURIComponent(r.type)}/${encodeURIComponent(r.formulaire)}/payments`;
  };

  // ---- GitHub Sponsors : API GraphQL (jeton côté serveur, jamais exposé au navigateur) -----------------------
  // Parrainages PUBLICS seulement (includePrivate: false), 100 par page, PAGES_GITHUB_MAX pages au plus.
  async function sponsorsGithub() {
    const r = reglages().githubSponsors;
    if (!r.actif) return [];
    if (!r.jeton || !r.compte) throw new Error('Identifiants GitHub Sponsors incomplets');
    if (!RE_SLUG.test(r.compte)) throw new Error('GitHub Sponsors : nom de compte invalide');
    const requete = `query($login:String!, $apres:String){ user(login:$login){ sponsorshipsAsMaintainer(first:100, after:$apres, includePrivate:false, orderBy:{field:CREATED_AT, direction:DESC}){ pageInfo{ hasNextPage endCursor } nodes{ privacyLevel createdAt sponsorEntity{ __typename ... on User{ login name } ... on Organization{ login name } } tier{ monthlyPriceInDollars isOneTime } } } } }`;
    const noeuds = [];
    let apres = null;
    for (let page = 0; page < PAGES_GITHUB_MAX; page++) {
      const rep = await f('https://api.github.com/graphql', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + r.jeton, 'Content-Type': 'application/json', 'User-Agent': 'carte-live-donateurs' },
        body: JSON.stringify({ query: requete, variables: { login: r.compte, apres } }),
        signal: AbortSignal.timeout(20000),
      });
      if (!rep.ok) throw new Error(`GitHub Sponsors : HTTP ${rep.status}`);
      const j = await rep.json();
      if (j.errors && j.errors.length) throw new Error('GitHub Sponsors : ' + String(j.errors[0].message || 'erreur').slice(0, 200));
      const s = j && j.data && j.data.user && j.data.user.sponsorshipsAsMaintainer;
      if (!s || !Array.isArray(s.nodes)) break;
      noeuds.push(...s.nodes);
      if (!s.pageInfo || !s.pageInfo.hasNextPage || typeof s.pageInfo.endCursor !== 'string') break;
      apres = s.pageInfo.endCursor;
    }
    // Données extérieures : chaque champ est vérifié avant d'entrer dans la liste ; les sponsors non publics sont
    // ignorés même si GitHub en renvoyait (ceinture et bretelles)
    const liste = [];
    for (const n of noeuds) {
      if (!n || typeof n !== 'object' || n.privacyLevel !== 'PUBLIC' || !n.sponsorEntity || typeof n.sponsorEntity !== 'object') continue;
      const nom = chaine(n.sponsorEntity.name, 60) || chaine(n.sponsorEntity.login, 60);
      if (!nom) continue;
      const mensuel = n.tier && typeof n.tier === 'object' && !n.tier.isOneTime ? Number(n.tier.monthlyPriceInDollars) : NaN;
      const date = typeof n.createdAt === 'string' && Number.isFinite(Date.parse(n.createdAt)) ? new Date(n.createdAt).toISOString() : null;
      liste.push({ nom, pays: null, montant: Number.isFinite(mensuel) && mensuel >= 0 ? mensuel : null, devise: 'USD', date, source: 'github' });
    }
    return liste;
  }

  // Fusion des deux sources, pour affichage public : noms anonymisés, montant masqué sauf réglage contraire,
  // seulement les entrées consenties (case « accord » pour HelloAsso, sponsor public pour GitHub).
  // Pas de date dans la liste publique (la page ne s'en sert pas, et une date à la milliseconde identifierait un don).
  function fusionner() {
    const r = reglages();
    const ha = etat.manuel.filter((e) => e && e.accord).map((e) => ({ nom: e.nom, pays: e.pays || null, montant: Number.isFinite(e.montant) ? e.montant : null, devise: 'EUR', date: e.date, source: 'helloasso' }));
    const gh = r.githubSponsors.actif ? etat.github : [];
    return [...ha, ...gh]
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
      .map((x) => ({ nom: x.source === 'helloasso' ? (String(x.nom || '').trim() || 'Un donateur') : anonymiser(x.nom), pays: x.pays, montant: r.montantVisible && Number.isFinite(x.montant) ? x.montant : null, devise: x.devise, source: x.source }));
  }
  // Liens « Faire un don » affichés sur la carte : tirés des réglages, absents si la source est désactivée
  function liens() {
    const r = reglages();
    const h = r.helloasso, g = r.githubSponsors;
    return {
      helloasso: h.actif && RE_SLUG.test(h.organisation) && RE_SLUG.test(h.formulaire) ? `https://www.helloasso.com/associations/${h.organisation}/formulaires/${h.formulaire}` : null,
      github: g.actif && RE_SLUG.test(g.compte) ? `https://github.com/sponsors/${g.compte}` : null,
    };
  }

  // Une seule actualisation à la fois ; un réglage changé pendant l'actualisation en relance une autre juste
  // après. En cas d'erreur, la liste déjà en cache est conservée (pas de trou sur le mur juste parce que GitHub
  // ou HelloAsso est indisponible un moment).
  // rafraichir() rend toujours une promesse qui se termine quand la liste est à jour (y compris la relance).
  let enCours = null, relancer = false;
  async function actualiser() {
    const r = reglages();
    if (r.githubSponsors.actif) {
      try { etat.github = await sponsorsGithub(); etat.erreurs.githubSponsors = null; }
      catch (e) { etat.erreurs.githubSponsors = e.message; journal('[Donateurs] GitHub Sponsors :', e.message); }
    } else { etat.github = []; etat.erreurs.githubSponsors = null; }
    if (r.helloasso.actif) {
      try { await verifierHelloAsso(); etat.erreurs.helloasso = null; }
      catch (e) { etat.erreurs.helloasso = e.message; journal('[Donateurs] HelloAsso :', e.message); }
    } else { etat.erreurs.helloasso = null; }
    etat.maj = Date.now();
  }
  function rafraichir() {
    if (enCours) { relancer = true; return enCours; }
    enCours = actualiser().catch((e) => journal('[Donateurs] actualisation :', e.message)).then(() => {
      enCours = null;
      if (relancer) { relancer = false; return rafraichir(); }
      return undefined;
    });
    return enCours;
  }

  const heures = Math.min(24, Math.max(1, Number((config.donateurs || {}).intervalleHeures) || 1));
  const minuterie = setInterval(() => rafraichir().catch(() => {}), heures * 3600000);
  if (minuterie.unref) minuterie.unref();
  const demarrage = setTimeout(() => rafraichir().catch(() => {}), 15000);
  if (demarrage.unref) demarrage.unref();

  const api = {
    // Mur public (/api/donateurs) : jamais les clés, jamais d'e-mail ni d'adresse ni de date, montant masqué par défaut
    liste: () => fusionner(),
    liens,
    // Page d'administration : identifiants remplacés par un simple « défini : oui/non », et d'où vient chaque secret
    etat: () => {
      const r = reglages();
      return {
        maj: etat.maj,
        erreurs: etat.erreurs,
        reglages: {
          helloasso: {
            actif: r.helloasso.actif, organisation: r.helloasso.organisation, formulaire: r.helloasso.formulaire, type: r.helloasso.type,
            clientIdDefini: !!r.helloasso.clientId, clientSecretDefini: !!r.helloasso.clientSecret,
            clientIdSaisi: !!saisi.helloasso.clientId, clientSecretSaisi: !!saisi.helloasso.clientSecret,
          },
          githubSponsors: { actif: r.githubSponsors.actif, compte: r.githubSponsors.compte, jetonDefini: !!r.githubSponsors.jeton, jetonSaisi: !!saisi.githubSponsors.jeton },
          montantVisible: r.montantVisible,
          types: TYPES_HELLOASSO,
        },
        manuel: etat.manuel,
        maxManuel: MAX_MANUEL,
      };
    },
    regler(r = {}) {
      if (r.helloasso && typeof r.helloasso === 'object') {
        const h = r.helloasso, c = saisi.helloasso;
        if (typeof h.actif === 'boolean') c.actif = h.actif;
        if (typeof h.organisation === 'string' && h.organisation.trim()) { if (!RE_SLUG.test(h.organisation.trim())) throw new Error('HelloAsso : slug d’organisation invalide'); c.organisation = h.organisation.trim().slice(0, 80); }
        if (typeof h.formulaire === 'string' && h.formulaire.trim()) { if (!RE_SLUG.test(h.formulaire.trim())) throw new Error('HelloAsso : slug de formulaire invalide'); c.formulaire = h.formulaire.trim().slice(0, 80); }
        if (typeof h.type === 'string' && h.type) { if (!TYPES_HELLOASSO.includes(h.type)) throw new Error('HelloAsso : type de formulaire inconnu'); c.type = h.type; }
        // Champ vide = inchangé (comme le mot de passe MQTT dans les réglages) : un secret n'est jamais effacé par
        // erreur. « Effacer » (clientIdEffacer…) retire le secret saisi : le .env reprend la main, s'il en a un.
        if (h.clientIdEffacer === true) { delete c.clientId; jetonHa = null; }
        else if (typeof h.clientId === 'string' && h.clientId.trim()) { c.clientId = h.clientId.trim().slice(0, 200); jetonHa = null; }
        if (h.clientSecretEffacer === true) { delete c.clientSecret; jetonHa = null; }
        else if (typeof h.clientSecret === 'string' && h.clientSecret.trim()) { c.clientSecret = h.clientSecret.trim().slice(0, 200); jetonHa = null; }
      }
      if (r.githubSponsors && typeof r.githubSponsors === 'object') {
        const g = r.githubSponsors, c = saisi.githubSponsors;
        if (typeof g.actif === 'boolean') c.actif = g.actif;
        if (typeof g.compte === 'string' && g.compte.trim()) { const v = g.compte.trim().replace(/^@/, '').slice(0, 80); if (!RE_SLUG.test(v)) throw new Error('GitHub : nom de compte invalide'); c.compte = v; }
        if (g.jetonEffacer === true) delete c.jeton;
        else if (typeof g.jeton === 'string' && g.jeton.trim()) c.jeton = g.jeton.trim().slice(0, 200);
      }
      if (typeof r.montantVisible === 'boolean') saisi.montantVisible = r.montantVisible;
      sauver();
      rafraichir().catch(() => {});
      return api.etat();
    },
    // Liste manuelle HelloAsso : une entrée n'est acceptée qu'avec la case « accord du donateur » cochée
    manuelAjouter(e = {}) {
      const nom = chaine(e.nom, 60);
      if (!nom) throw new Error('Nom (ou pseudonyme) du donateur requis');
      if (e.accord !== true) throw new Error('La case « accord du donateur » doit être cochée avant d’afficher ce don sur la carte');
      if (etat.manuel.length >= MAX_MANUEL) throw new Error(`Liste pleine (${MAX_MANUEL} dons) : retirez d’anciennes entrées avant d’en ajouter`);
      const pays = chaine(e.pays, 10).toUpperCase();
      if (pays && !/^[A-Z]{2}$/.test(pays)) throw new Error('Pays : code à 2 lettres (ex. FR), ou vide');
      const montant = e.montant === '' || e.montant == null ? null : Number(e.montant);
      if (montant !== null && !(Number.isFinite(montant) && montant >= 0 && montant <= 1000000)) throw new Error('Montant invalide');
      const ligne = {
        id: crypto.randomBytes(6).toString('hex'),
        nom,
        pays: pays || null,
        montant: montant === null ? null : Math.round(montant * 100) / 100,
        date: new Date().toISOString(),
        accord: true,
      };
      etat.manuel.unshift(ligne);
      try { sauver(); } catch (e) { etat.manuel.shift(); throw e; }
      return ligne;
    },
    manuelRetirer(id) {
      const avant = etat.manuel.length;
      etat.manuel = etat.manuel.filter((x) => x.id !== id);
      if (etat.manuel.length === avant) throw new Error('Entrée inconnue');
      sauver();
    },
    rafraichir,
    urlPaiementsHelloAsso,
  };
  return api;
}

module.exports = { creerDonateurs, anonymiser, TYPES_HELLOASSO, MAX_MANUEL };
