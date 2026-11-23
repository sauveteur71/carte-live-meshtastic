// Essais des espaces « Secours » (DPS, PCS) : node --test tests/secours.js
// Le module est essayé seul, dans un dossier temporaire : création d'un espace, comptes, équipes, interventions,
// remontées par radio, et surtout le cloisonnement (un fichier par espace, sessions qui ne passent pas d'un espace
// à l'autre, nœuds vus seulement par l'espace qui les a reçus).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { creerSecours, numeroNoeud, idNoeud } = require('../src/secours');
const { creerComptes } = require('../src/comptes');

const N1 = 0xa1b2c3d4, N2 = 0x0badcafe, N3 = 0x12345678;
function monter() {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'secours-essai-'));
  const positions = new Map([[N1, { lat: 45.05, lon: 3.9, heure: 1 }], [N2, { lat: 45.1, lon: 3.95, heure: 1 }]]);
  const journal = [];
  // Faux module radio : garde ce qui part, numérote les paquets, accusé réglable
  const partis = [], accuses = new Map();
  const radio = { panne: null, connecte: () => !radio.panne,
    envoyerTexte: ({ texte, dest, canal }, auteur) => { if (radio.panne) throw new Error(radio.panne); const id = partis.length + 1; partis.push({ id, texte, dest, canal, auteur }); accuses.set(id, 'envoye'); return { id, dest }; },
    etatEnvoi: (n) => (accuses.has(n) ? { statut: accuses.get(n) } : null),
    canaux: () => [{ index: 0, nom: 'LongFast' }, { index: 1, nom: 'Secours43' }, { index: 2, nom: 'Mairie' }] };
  // Ce que la carte sait de ses nœuds (sélecteur, batterie, trajets) et son serveur d'e-mails, simulés
  const carte = { noeuds: [{ num: N1, court: 'ALPH', long: 'Binôme Alpha', vu: 5 }, { num: N2, court: 'MAIR', long: 'Mairie', vu: 4 }, { num: N3, court: 'PS01', long: 'Poste 1', vu: 3 }], sante: new Map(), traces: new Map(), courriels: [], smtp: true };
  const secours = creerSecours({ config: { fichierBase: path.join(dossier, 'carte-live.db') }, journal: (...a) => journal.push(a.join(' ')), radio, espacement: 5,
    noeudsCarte: () => carte.noeuds, santeDe: (n) => carte.sante.get(n >>> 0) || null, traceDe: (n, depuis) => (carte.traces.get(n >>> 0) || []).filter((p) => p.heure >= depuis),
    courriel: { actif: () => carte.smtp, envoyer: async (m) => { carte.courriels.push(m); return true; } },
    positionDe: (n) => positions.get(n >>> 0) || null, nomDe: (n) => (n >>> 0 === N1 ? 'Binôme Alpha' : null) });
  return { dossier, secours, positions, journal, radio, partis, accuses, carte };
}
const festival = (secours, plus = {}) => secours.creer({ code: 'festival-2027', nom: 'Festival du Velay', genre: 'dps', responsable: { identifiant: 'chef.dispositif', motDePasse: 'motdepasse-1' }, noeuds: [idNoeud(N1)], ...plus }, 'admin');
const commune = (secours, plus = {}) => secours.creer({ code: 'pcs-commune', nom: 'PCS de la commune', genre: 'pcs', responsable: { identifiant: 'mairie', motDePasse: 'motdepasse-2' }, noeuds: [idNoeud(N2)], ...plus }, 'admin');

test('numéros de nœud : !hexa, hexa et décimal', () => {
  assert.strictEqual(numeroNoeud('!a1b2c3d4'), N1);
  assert.strictEqual(numeroNoeud('A1B2C3D4'), N1);
  assert.strictEqual(numeroNoeud(String(N3)), N3);
  assert.strictEqual(idNoeud(N2), '!0badcafe');
  assert.throws(() => numeroNoeud('pas-un-noeud'), /Nœud invalide/);
});

test('création : un fichier par espace, adresse contrôlée, responsable obligatoire', () => {
  const { dossier, secours } = monter();
  const d = festival(secours);
  assert.deepStrictEqual({ code: d.code, genre: d.genre, comptes: d.comptes, noeuds: d.noeuds }, { code: 'festival-2027', genre: 'dps', comptes: 1, noeuds: 1 });
  assert.ok(fs.existsSync(path.join(dossier, 'secours', 'festival-2027.db')));
  assert.ok(!fs.existsSync(path.join(dossier, 'carte-live.db')), 'rien n’est écrit dans la base de la carte');
  assert.throws(() => festival(secours), /déjà prise/);
  assert.throws(() => secours.creer({ code: 'Ma Fête !', nom: 'x', genre: 'dps', responsable: { identifiant: 'abc', motDePasse: '12345678' } }, 'admin'), /Adresse de l’espace/);
  assert.throws(() => secours.creer({ code: 'espaces', nom: 'x', genre: 'dps', responsable: { identifiant: 'abc', motDePasse: '12345678' } }, 'admin'), /Adresse de l’espace/);
  assert.throws(() => secours.creer({ code: 'sans-chef', nom: 'x', genre: 'pcs' }, 'admin'), /premier responsable/);
  assert.throws(() => secours.creer({ code: 'autre-genre', nom: 'x', genre: 'adrasec', responsable: { identifiant: 'abc', motDePasse: '12345678' } }, 'admin'), /Type d’espace inconnu/);
  // Un mot de passe trop court fait échouer la création : aucun fichier à moitié créé ne reste
  assert.throws(() => secours.creer({ code: 'trop-court', nom: 'x', genre: 'pcs', responsable: { identifiant: 'abc', motDePasse: 'court' } }, 'admin'), /8 caractères/);
  assert.ok(!fs.existsSync(path.join(dossier, 'secours', 'trop-court.db')));
  assert.strictEqual(secours.lister().length, 1);
  secours.fermer();
});

test('cloisonnement : sessions, comptes et nœuds ne passent pas d’un espace à l’autre', () => {
  const { dossier, secours } = monter();
  festival(secours); commune(secours);
  const F = secours.espace('festival-2027'), C = secours.espace('pcs-commune');
  const chef = F.comptes.connecter('chef.dispositif', 'motdepasse-1');
  const jetonF = secours.jeton(F, chef);
  assert.strictEqual(secours.session(jetonF).espace.code, 'festival-2027');
  // Le même jeton présenté comme une session de l'autre espace est refusé (secret de signature différent)
  assert.strictEqual(secours.session(jetonF.replace(/^festival-2027\./, 'pcs-commune.')), null);
  assert.strictEqual(secours.session('inconnu.' + jetonF.split('.').slice(1).join('.')), null);
  // … et il ne vaut rien non plus pour les comptes de la carte, même avec un compte du même numéro
  const carte = new Database(':memory:');
  const comptesCarte = creerComptes(carte, { admin: { secret: 'secret-de-la-carte' }, fichierBase: path.join(dossier, 'carte-live.db') });
  comptesCarte.creer({ identifiant: 'admin.carte', motDePasse: 'motdepasse-3' }, 'admin');
  assert.strictEqual(comptesCarte.lireJeton(jetonF.split('.').slice(1).join('.')), null);
  assert.strictEqual(F.comptes.lireJeton(comptesCarte.jeton({ id: 1 })), null, 'une session de la carte n’ouvre pas un espace');
  // Les comptes d'un espace n'existent pas dans l'autre
  assert.throws(() => C.comptes.connecter('chef.dispositif', 'motdepasse-1'), /incorrect/);
  // Un nœud attribué à un espace ne peut pas l'être à un autre, ni porté par une équipe d'un autre
  assert.throws(() => secours.modifier('pcs-commune', { noeuds: [idNoeud(N2), idNoeud(N1)] }, 'admin'), /déjà attribué à l’espace « Festival du Velay »/);
  assert.throws(() => C.majEquipe(null, { nom: 'Équipe 1', noeud: idNoeud(N1) }), /n’est pas attribué à votre espace/);
  const vueC = C.etat(C.comptes.connecter('mairie', 'motdepasse-2'));
  assert.deepStrictEqual(vueC.noeuds.map((n) => n.id), [idNoeud(N2)]);
  secours.fermer();
});

test('DPS : postes, effectif face au référentiel, interventions et état des équipes', () => {
  const { secours } = monter();
  festival(secours);
  const F = secours.espace('festival-2027');
  const chef = F.comptes.connecter('chef.dispositif', 'motdepasse-1');
  F.reglages({ categorie: 'pe', publicAttendu: 5000, lieu: 'Place du Breuil', centre: { lat: 45.043, lon: 3.885, zoom: 16 } });
  const poste = F.majEquipe(null, { nom: 'Poste scène', genre: 'poste', lat: 45.0431, lon: 3.8852, effectif: 4 });
  const binome = F.majEquipe(null, { nom: 'Binôme Alpha', genre: 'binome', effectif: 2, noeud: idNoeud(N1) });
  assert.throws(() => F.majEquipe(null, { nom: 'Doublon', noeud: idNoeud(N1) }), /déjà porté par « Binôme Alpha »/);
  assert.throws(() => F.majEquipe(null, { nom: 'Mauvais type', genre: 'terrain' }), /Type d’équipe inconnu/);
  let v = F.etat(chef);
  assert.deepStrictEqual(v.effectif, { prevu: 6, categorie: { nom: 'DPS-PE', min: 4, max: 12 }, conforme: true });
  assert.deepStrictEqual(v.equipes.find((e) => e.id === binome.id).position, { lat: 45.05, lon: 3.9, heure: 1 }, 'position en direct du nœud porté');
  assert.strictEqual(v.equipes.find((e) => e.id === poste.id).position, null);
  assert.deepStrictEqual(v.centre, { lat: 45.043, lon: 3.885, zoom: 16 });
  F.reglages({ categorie: 'me' });
  assert.strictEqual(F.etat(chef).effectif.conforme, false, '6 secouristes : en dessous d’un DPS-ME (12 à 36)');

  // Intervention confiée à une équipe : elle passe en cours, l'équipe « en intervention », puis disponible à la fin
  const x = F.majIntervention(null, { genre: 'malaise', titre: 'Malaise devant la scène', lat: 45.0432, lon: 3.8853, urgente: true }, 'chef.dispositif');
  assert.strictEqual(x.statut, 'a-faire');
  assert.strictEqual(F.majIntervention(x.id, { equipe: binome.id }, 'chef.dispositif').statut, 'en-cours');
  assert.strictEqual(F.etat(chef).equipes.find((e) => e.id === binome.id).etat, 'intervention');
  const fin = F.majIntervention(x.id, { statut: 'terminee' }, 'chef.dispositif');
  assert.ok(fin.cloture > 0);
  assert.strictEqual(F.etat(chef).equipes.find((e) => e.id === binome.id).etat, 'disponible');
  assert.throws(() => F.majIntervention(x.id, { lat: 95, lon: 3 }, 'chef.dispositif'), /Position invalide/);
  const mc = F.etat(chef).mainCourante.map((m) => m.texte);
  assert.ok(mc.some((t) => /Intervention ouverte : Malaise devant la scène \(urgente\)/.test(t)));
  assert.ok(mc.some((t) => /confiée à Binôme Alpha/.test(t)));
  assert.ok(mc.some((t) => /: terminée/.test(t)));
  assert.match(F.csvMc(), /^Date;Heure;Auteur;Équipe;Type;Origine;Texte\r\n/);
  secours.fermer();
});

test('remontées par radio : seulement les nœuds de l’espace, INTER / états / FIN / message libre', () => {
  const { secours } = monter();
  festival(secours); commune(secours);
  const F = secours.espace('festival-2027'), C = secours.espace('pcs-commune');
  const chef = F.comptes.connecter('chef.dispositif', 'motdepasse-1'), maire = C.comptes.connecter('mairie', 'motdepasse-2');
  const binome = F.majEquipe(null, { nom: 'Binôme Alpha', genre: 'binome', noeud: idNoeud(N1) });
  const terrain = C.majEquipe(null, { nom: 'Équipe Nord', genre: 'terrain', noeud: idNoeud(N2) });

  secours.texteRecu({ de: N1, texte: 'INTER chute au virage 4' });
  secours.texteRecu({ de: N1, texte: 'INTER chute au virage 4' }); // reçu une seconde fois par une autre passerelle
  let v = F.etat(chef);
  assert.strictEqual(v.interventions.length, 1);
  assert.deepStrictEqual({ titre: v.interventions[0].titre, lat: v.interventions[0].lat, origine: v.interventions[0].origine, equipe: v.interventions[0].equipe, statut: v.interventions[0].statut },
    { titre: 'chute au virage 4', lat: 45.05, origine: 'radio', equipe: binome.id, statut: 'en-cours' });
  secours.texteRecu({ de: N1, texte: 'FIN victime remise aux pompiers' });
  v = F.etat(chef);
  assert.strictEqual(v.interventions[0].statut, 'terminee');
  assert.ok(v.mainCourante.some((m) => m.texte === 'victime remise aux pompiers' && m.origine === 'radio'));
  secours.texteRecu({ de: N1, texte: 'PAUSE' });
  assert.strictEqual(F.etat(chef).equipes[0].etat, 'pause');
  secours.texteRecu({ de: N1, texte: 'Pause repas terminée, on repart' }); // une phrase n'est pas un changement d'état
  assert.strictEqual(F.etat(chef).equipes[0].etat, 'pause');
  assert.ok(F.etat(chef).mainCourante.some((m) => m.texte === 'Pause repas terminée, on repart' && m.type === 'message-recu'));

  // Le message d'un nœud de la commune n'apparaît que chez elle ; celui d'un nœud attribué à personne, nulle part
  secours.texteRecu({ de: N2, texte: 'Route de la gare coupée par un arbre' });
  secours.texteRecu({ de: N3, texte: 'INTER message d’un nœud du réseau qui n’est à aucun espace' });
  assert.ok(C.etat(maire).mainCourante.some((m) => /Route de la gare/.test(m.texte) && m.equipe === terrain.id));
  assert.ok(!F.etat(chef).mainCourante.some((m) => /Route de la gare/.test(m.texte)));
  assert.strictEqual(C.etat(maire).interventions.length, 0);
  assert.strictEqual(F.etat(chef).interventions.length, 1);
  secours.fermer();
});

test('envois vers le terrain : message direct aux nœuds des équipes, droits, accusés, limite', async () => {
  const { secours, radio, partis, accuses } = monter();
  secours.creer({ code: 'festival-2027', nom: 'Festival du Velay', genre: 'dps', responsable: { identifiant: 'chef.dispositif', motDePasse: 'motdepasse-1' }, noeuds: [idNoeud(N1), idNoeud(N2)] }, 'admin');
  const F = secours.espace('festival-2027');
  const chef = F.comptes.connecter('chef.dispositif', 'motdepasse-1');
  const alpha = F.majEquipe(null, { nom: 'Binôme Alpha', genre: 'binome', noeud: idNoeud(N1) });
  const bravo = F.majEquipe(null, { nom: 'Binôme Bravo', genre: 'binome', noeud: idNoeud(N2) });
  const poste = F.majEquipe(null, { nom: 'Poste scène', genre: 'poste', lat: 45.0431, lon: 3.8852 });
  const pc = F.majEquipe(null, { nom: 'PC', genre: 'pc' });
  // Une équipe : un seul message direct, vers son nœud et aucun autre
  assert.deepStrictEqual(F.envoyer(chef, { texte: 'Rejoignez le poste scène', equipe: alpha.id }).destinataires, ['Binôme Alpha']);
  assert.deepStrictEqual(partis.map((p) => [p.dest, p.texte, p.auteur]), [[N1, 'Rejoignez le poste scène', 'espace Secours festival-2027']]);
  assert.throws(() => F.envoyer(chef, { texte: 'x', equipe: poste.id }), /ne porte pas de nœud/);
  assert.throws(() => F.envoyer(chef, { texte: '   ' }), /Message vide/);
  // Toutes : une par une, seulement celles qui portent un nœud
  F.envoyer(chef, { texte: 'Fin du dispositif à 23 h' });
  await new Promise((ok) => setTimeout(ok, 60));
  assert.deepStrictEqual(partis.slice(1).map((p) => p.dest), [N1, N2]);
  // Accusé de réception lu dans la main courante
  accuses.set(1, 'recu');
  const mc = F.etat(chef).mainCourante;
  assert.strictEqual(mc.find((m) => m.texte === '→ Binôme Alpha : Rejoignez le poste scène').accuse, 'recu');
  assert.ok(mc.every((m) => m.type !== 'message-emis' || m.origine === 'radio'));
  assert.ok(F.accuses().some((a) => a.accuse === 'recu'));
  // Intervention envoyée à l'équipe engagée
  const x = F.majIntervention(null, { genre: 'malaise', titre: 'Malaise devant la scène', lat: 45.0432, lon: 3.8853, urgente: true, equipe: bravo.id, detail: 'é'.repeat(300) }, 'chef.dispositif');
  F.diffuserIntervention(x.id, {}, chef);
  const dernier = partis.at(-1);
  assert.strictEqual(dernier.dest, N2);
  // Sans lieu saisi, l'intitulé en tient lieu ; ni précisions ni priorité dans le message
  assert.match(dernier.texte, /^INTER Malaise devant la scène · 45\.04320,3\.88530 DFCI [A-Z]{2}\d{2}[A-Z]\d(\.\d)? · Malaise$/);
  // Message d'intervention : lieu précis, nature, état apparent, et rien d'autre
  F.majIntervention(x.id, { lieu: 'Point B, près de la scène principale', etat: 'consciente' }, 'chef.dispositif');
  F.diffuserIntervention(x.id, {}, chef);
  assert.match(partis.at(-1).texte, /^INTER Point B, près de la scène principale · 45\.04320,3\.88530 DFCI \S+ · Malaise · consciente$/);
  assert.strictEqual(F.majIntervention(x.id, { etat: 'inventé' }, 'chef.dispositif').etat, null);
  F.majIntervention(x.id, { lieu: 'L'.repeat(80), etat: 'ne-respire-pas' }, 'chef.dispositif');
  F.diffuserIntervention(x.id, {}, chef);
  assert.ok(Buffer.byteLength(partis.at(-1).texte) <= 200 && /ne respire pas$/.test(partis.at(-1).texte));
  // Droits : un équipier d'une équipe ordinaire n'envoie pas ; celui du poste de coordination, si
  const equipier = F.creerCompte({ identifiant: 'secouriste.un', motDePasse: 'motdepasse-4', equipe: alpha.id });
  assert.throws(() => F.envoyer(equipier, { texte: 'essai', equipe: bravo.id }), /réservé aux responsables et au poste de coordination/);
  assert.strictEqual(F.etat(equipier).radio.peutEnvoyer, false);
  const operateur = F.creerCompte({ identifiant: 'operateur.pc', motDePasse: 'motdepasse-5', equipe: pc.id });
  assert.strictEqual(F.etat(operateur).radio.peutEnvoyer, true);
  F.envoyer(operateur, { texte: 'Bien reçu', equipe: alpha.id });
  // Module de la carte non connecté : l'erreur revient à celui qui envoie, rien n'est noté comme envoyé
  radio.panne = 'Module radio non connecté';
  const avant = F.etat(chef).mainCourante.length;
  assert.throws(() => F.envoyer(chef, { texte: 'perdu', equipe: alpha.id }), /Module radio non connecté/);
  assert.strictEqual(F.etat(chef).mainCourante.length, avant);
  assert.strictEqual(F.etat(chef).radio.connecte, false);
  radio.panne = null;
  // Limite de temps d'antenne : 30 messages par 10 minutes
  assert.throws(() => { for (let k = 0; k < 40; k++) F.envoyer(chef, { texte: 'essai ' + k, equipe: alpha.id }); }, /30 messages au plus par 10 minutes/);
  // Sans module radio fourni (essais, carte sans émission) : envoi refusé proprement
  secours.fermer();
});

test('comptes d’un espace : équipiers, affectation, rôle, mot de passe remis, dernier responsable gardé', () => {
  const { secours } = monter();
  commune(secours);
  const C = secours.espace('pcs-commune');
  const maire = C.comptes.connecter('mairie', 'motdepasse-2');
  const eq = C.majEquipe(null, { nom: 'Équipe Nord', genre: 'terrain' });
  const agent = C.creerCompte({ identifiant: 'agent.technique', motDePasse: 'motdepasse-4', equipe: eq.id, fonction: 'Services techniques' });
  let v = C.etat(maire);
  assert.strictEqual(v.comptes.length, 2);
  assert.deepStrictEqual(v.equipes[0].membres, [{ nom: 'agent.technique', fonction: 'Services techniques' }]);
  const vueAgent = C.etat(C.comptes.connecter('agent.technique', 'motdepasse-4'));
  assert.strictEqual(vueAgent.comptes, undefined, 'un équipier ne voit pas la liste des comptes');
  assert.strictEqual(vueAgent.noeuds, undefined);
  assert.strictEqual(vueAgent.moi.equipe, eq.id);
  // Mot de passe remis par le responsable : l'ancien ne marche plus, la session ouverte tombe
  const jeton = secours.jeton(C, agent);
  C.majCompte(agent.id, { motDePasse: 'nouveau-mot-de-passe' }, maire);
  assert.strictEqual(secours.session(jeton), null);
  assert.throws(() => C.comptes.connecter('agent.technique', 'motdepasse-4'), /incorrect/);
  assert.ok(C.comptes.connecter('agent.technique', 'nouveau-mot-de-passe'));
  assert.throws(() => C.majCompte(maire.id, { responsable: false }, maire), /au moins un administrateur/);
  assert.throws(() => C.majCompte(maire.id, { supprimer: true }, maire), /votre propre compte/);
  C.majCompte(agent.id, { supprimer: true }, maire);
  assert.strictEqual(C.etat(maire).equipes[0].membres.length, 0);
  // L'administrateur de la carte renomme un responsable (mot de passe perdu) sans entrer dans l'espace
  secours.modifier('pcs-commune', { responsable: { identifiant: 'mairie', motDePasse: 'motdepasse-5' } }, 'admin');
  assert.ok(C.comptes.connecter('mairie', 'motdepasse-5'));
  secours.fermer();
});

test('suppression : fichier mis à la corbeille, adresse libérée ; les espaces se rechargent au démarrage', async () => {
  const { dossier, secours, positions } = monter();
  festival(secours); commune(secours);
  const C = secours.espace('pcs-commune');
  C.ajouterMc({ texte: 'Ouverture du poste de commandement communal', type: 'decision' }, C.comptes.connecter('mairie', 'motdepasse-2'));
  const copie = await C.copier(path.join(dossier, 'secours', 'copies'));
  assert.ok(fs.existsSync(copie) && /pcs-commune-\d{4}-\d{2}-\d{2}\.db$/.test(copie));
  assert.strictEqual(await C.copier(path.join(dossier, 'secours', 'copies')), null, 'une seule copie par jour');
  secours.supprimer('festival-2027', 'admin');
  assert.strictEqual(secours.espace('festival-2027'), null);
  assert.ok(!fs.existsSync(path.join(dossier, 'secours', 'festival-2027.db')));
  assert.strictEqual(fs.readdirSync(path.join(dossier, 'secours', 'corbeille')).filter((f) => /^festival-2027-.*\.db$/.test(f)).length, 1);
  secours.fermer();
  // Redémarrage : seul l'espace restant revient, avec sa main courante (ni la corbeille ni les copies ne sont lues)
  const apres = creerSecours({ config: { fichierBase: path.join(dossier, 'carte-live.db') }, positionDe: (n) => positions.get(n >>> 0) || null });
  assert.deepStrictEqual(apres.lister().map((e) => e.code), ['pcs-commune']);
  const C2 = apres.espace('pcs-commune');
  assert.ok(C2.etat(C2.comptes.connecter('mairie', 'motdepasse-2')).mainCourante.some((m) => /Ouverture du poste de commandement/.test(m.texte)));
  apres.fermer();
});

test('organisations et sélecteur : nœuds choisis dans la liste de la carte, rangés par organisation, attendus par leur nom court', () => {
  const { secours, carte } = monter();
  festival(secours, { noeuds: [], organisations: ['Croix-Rouge française'] }); commune(secours);
  const F = secours.espace('festival-2027');
  assert.deepStrictEqual(F.organisations().map((o) => o.nom), ['Croix-Rouge française']);
  const crf = F.organisations()[0].id;
  // Le sélecteur montre les nœuds de la carte et l'espace qui les a déjà ; l'ADRASEC figure parmi les organisations proposées
  let sel = secours.selecteur();
  assert.deepStrictEqual(sel.noeuds.map((n) => [n.id, n.court, n.espace]), [['!a1b2c3d4', 'ALPH', null], ['!0badcafe', 'MAIR', 'pcs-commune'], ['!12345678', 'PS01', null]]);
  assert.ok(sel.organisations.dps.includes('ADRASEC') && sel.organisations.dps.includes('Ordre de Malte France') && sel.organisations.pcs.includes('Services techniques'));
  assert.deepStrictEqual(sel.canaux, ['Secours43', 'Mairie'], 'le canal principal ne se réserve pas');
  // Une deuxième organisation et ses nœuds dans le même appel ; un nœud d'un autre espace est refusé
  secours.modifier('festival-2027', { organisation: { nom: 'Protection Civile (ADPC, FNPC)' }, attribuer: { noeuds: ['!12345678'], organisation: 'nouvelle' } }, 'admin');
  secours.modifier('festival-2027', { attribuer: { noeuds: [idNoeud(N1)], organisation: crf } }, 'admin');
  assert.throws(() => secours.modifier('festival-2027', { attribuer: { noeuds: [idNoeud(N2)] } }, 'admin'), /déjà attribué à l’espace « PCS de la commune »/);
  assert.throws(() => secours.modifier('festival-2027', { organisation: { nom: 'croix-rouge française' } }, 'admin'), /existe déjà/);
  assert.throws(() => secours.modifier('festival-2027', { attribuer: { noeuds: [idNoeud(N1)], organisation: 'inconnue' } }, 'admin'), /Organisation inconnue/);
  const pc = F.organisations().find((o) => /Protection/.test(o.nom)).id;
  assert.deepStrictEqual(F.lignesNoeuds().map((n) => [n.id, n.organisation]), [['!12345678', pc], ['!a1b2c3d4', crf]]);
  // Une équipe prend l'organisation de son nœud ; le responsable peut la changer
  const chef = F.comptes.lister()[0];
  const eq = F.majEquipe(null, { nom: 'Poste 1', genre: 'poste', noeud: '!12345678' });
  assert.strictEqual(eq.organisation, pc);
  assert.strictEqual(F.majEquipe(eq.id, { organisation: crf }).organisation, crf);
  assert.deepStrictEqual(F.etat(chef).organisations.map((o) => o.nom), ['Croix-Rouge française', 'Protection Civile (ADPC, FNPC)']);
  // Nœud pas encore allumé : attendu par son nom court, attribué quand la carte le voit (un seul nœud de ce nom)
  secours.modifier('festival-2027', { attendre: { nom: 'VPSP', organisation: crf } }, 'admin');
  assert.throws(() => secours.modifier('pcs-commune', { attendre: { nom: 'vpsp' } }, 'admin'), /déjà attendu par l’espace « Festival du Velay »/);
  assert.throws(() => secours.modifier('festival-2027', { attendre: { nom: 'deux mots' } }, 'admin'), /pas d’espace/);
  assert.deepStrictEqual(secours.lister().find((e) => e.code === 'festival-2027').attentes.map((a) => a.nom), ['VPSP']);
  const N4 = 0x0000beef, N5 = 0x0000cafe;
  carte.noeuds.push({ num: N4, court: 'vpsp', long: 'Véhicule', vu: 9 }, { num: N5, court: 'VPSP', long: 'Homonyme', vu: 9 });
  secours.resoudreAttentes();
  assert.ok(!F.possedeNoeud(N4) && !F.possedeNoeud(N5), 'deux nœuds portent ce nom : rien n’est attribué');
  carte.noeuds.pop();
  secours.resoudreAttentes();
  assert.ok(F.possedeNoeud(N4));
  assert.strictEqual(F.lignesNoeuds().find((n) => n.num === N4).organisation, crf);
  assert.strictEqual(F.lignesAttentes().length, 0);
  // Un nom attendu déjà porté par un nœud d'un autre espace n'est pas pris
  secours.modifier('festival-2027', { attendre: { nom: 'MAIR' } }, 'admin');
  assert.ok(!F.possedeNoeud(N2) && F.lignesAttentes().length === 1);
  secours.modifier('festival-2027', { retirerAttente: 'mair' }, 'admin');
  assert.strictEqual(F.lignesAttentes().length, 0);
  // Organisation retirée : nœuds et équipes restent, sans organisation ; nœud retiré : l'équipe le perd
  secours.modifier('festival-2027', { organisation: { id: crf, supprimer: true } }, 'admin');
  assert.strictEqual(F.lignesNoeuds().find((n) => n.num === N1).organisation, null);
  assert.strictEqual(F.etat(chef).equipes[0].organisation, null);
  secours.modifier('festival-2027', { retirer: ['!12345678'] }, 'admin');
  assert.ok(!F.possedeNoeud(N3));
  assert.strictEqual(F.etat(chef).equipes[0].noeud, null);
  secours.fermer();
});

test('options de l’espace : activables par genre, messages-types, priorités, alerte e-mail', async () => {
  const { secours, carte } = monter();
  festival(secours); commune(secours);
  const F = secours.espace('festival-2027'), P = secours.espace('pcs-commune');
  const chef = F.comptes.lister()[0], maire = P.comptes.lister()[0];
  // Les repères du PCS ne sont proposés qu'à un PCS ; chaque espace règle les siennes
  assert.ok(!('couches' in F.etat(chef).options) && P.etat(maire).options.couches === true);
  assert.deepStrictEqual(Object.keys(F.etat(chef).catalogueOptions).sort(), ['alerteRadio', 'batterie', 'canal', 'courriel', 'macros', 'points', 'priorites', 'rapport', 'trajets']);
  F.reglages({ options: { trajets: false, couches: true, inconnue: true } });
  assert.strictEqual(F.option('trajets'), false);
  assert.ok(!F.option('couches') && P.option('trajets'), 'option d’un autre genre ignorée ; l’autre espace n’a pas bougé');
  // Messages-types : ceux du genre par défaut, puis ceux du responsable
  assert.ok(F.etat(chef).macros.length >= 3);
  F.reglages({ macros: ['Rejoignez le PC', '', '  Pause repas à 13 h  '] });
  assert.deepStrictEqual(F.etat(chef).macros, ['Rejoignez le PC', 'Pause repas à 13 h']);
  assert.throws(() => F.reglages({ macros: Array.from({ length: 13 }, (_, i) => 'm' + i) }), /12 messages-types/);
  // Priorités : « urgente » vaut priorité 1 ; la case à cocher d'avant reste comprise
  const a = F.majIntervention(null, { titre: 'Entorse', priorite: 3 }, 'chef');
  assert.deepStrictEqual([a.priorite, a.urgente], [3, 0]);
  assert.deepStrictEqual([F.majIntervention(a.id, { urgente: true }, 'chef').priorite, F.majIntervention(a.id, { urgente: false }, 'chef').priorite], [1, 2]);
  assert.throws(() => F.majIntervention(a.id, { priorite: 7 }, 'chef'), /Priorité inconnue/);
  // Alerte e-mail : option éteinte par défaut ; adresses contrôlées ; un envoi par intervention qui devient urgente
  F.majIntervention(null, { titre: 'Sans alerte', priorite: 1 }, 'chef');
  await new Promise((ok) => setTimeout(ok, 20));
  assert.strictEqual(carte.courriels.length, 0);
  assert.throws(() => F.reglages({ courriels: 'pas-une-adresse' }), /Adresse e-mail invalide/);
  assert.throws(() => F.reglages({ courriels: 'a@x.fr b@x.fr c@x.fr d@x.fr e@x.fr f@x.fr' }), /5 adresses/);
  F.reglages({ options: { courriel: true }, courriels: 'PC@exemple.fr, astreinte@exemple.fr' });
  assert.deepStrictEqual(F.etat(chef).courriel, { disponible: true, adresses: ['pc@exemple.fr', 'astreinte@exemple.fr'] });
  const u = F.majIntervention(null, { titre: 'Arrêt cardiaque', genre: 'detresse', priorite: 1, lat: 45.04, lon: 3.88 }, 'chef');
  F.majIntervention(u.id, { detail: 'DAE en cours' }, 'chef'); // déjà urgente : pas de second e-mail
  F.majIntervention(a.id, { priorite: 1 }, 'chef'); // le devient : un e-mail
  await new Promise((ok) => setTimeout(ok, 20));
  assert.strictEqual(carte.courriels.length, 2);
  assert.strictEqual(carte.courriels[0].a, 'pc@exemple.fr, astreinte@exemple.fr');
  assert.match(carte.courriels[0].sujet, /^\[Festival du Velay\] Urgent : Arrêt cardiaque$/);
  assert.match(carte.courriels[0].texte, /Position : 45\.04000, 3\.88000 \(DFCI /);
  assert.ok(F.etat(chef).mainCourante.some((m) => /Alerte e-mail envoyée \(2 adresses\) : Arrêt cardiaque/.test(m.texte)));
  // Envoi d'e-mails non réglé sur la carte : rien ne part, l'espace le sait
  carte.smtp = false;
  F.majIntervention(null, { titre: 'Autre urgence', priorite: 1 }, 'chef');
  await new Promise((ok) => setTimeout(ok, 20));
  assert.strictEqual(carte.courriels.length, 2);
  assert.strictEqual(F.etat(chef).courriel.disponible, false);
  assert.strictEqual(F.etat(F.creerCompte({ identifiant: 'equipier', motDePasse: 'motdepasse-9' })).courriel, undefined, 'les adresses ne sont montrées qu’aux responsables');
  secours.fermer();
});

test('ce qui revient à un espace : points de passage, canal réservé, et rien pour la carte', () => {
  const { secours, partis, journal } = monter();
  festival(secours); commune(secours);
  const F = secours.espace('festival-2027'), P = secours.espace('pcs-commune');
  const chef = F.comptes.lister()[0], maire = P.comptes.lister()[0];
  const alpha = F.majEquipe(null, { nom: 'Binôme Alpha', genre: 'binome', noeud: idNoeud(N1) });
  // recu() dit à la carte si le paquet revient à un espace (elle ne le montre alors pas à ses membres)
  assert.strictEqual(secours.recu({ port: 'texte', de: N3, texte: 'bonjour à tous', canal: 'LongFast' }), false);
  assert.strictEqual(secours.recu({ port: 'texte', de: N1, texte: 'DISPO', canal: 'LongFast' }), true);
  assert.strictEqual(secours.recu({ port: 'position', de: N1, position: { lat: 45, lon: 3 } }), false, 'les positions restent à la carte');
  // Point de passage posé par le nœud d'une équipe : une intervention ; déplacé : mise à jour ; expiré : terminée
  const point = (plus) => ({ port: 'waypoint', de: N1, pointRepere: { id: 4242, nom: '🚑 Chute au virage 4', description: 'jambe', lat: 45.051, lon: 3.901, expire: 0, ...plus } });
  assert.strictEqual(secours.recu(point()), true);
  secours.recu(point()); // reçu par une autre passerelle
  let x = F.etat(chef).interventions;
  assert.strictEqual(x.length, 1);
  assert.deepStrictEqual([x[0].titre, x[0].detail, x[0].lat, x[0].equipe, x[0].origine, x[0].statut], ['Chute au virage 4', 'jambe', 45.051, alpha.id, 'radio', 'en-cours']);
  secours.recu(point({ lat: 45.06 }));
  x = F.etat(chef).interventions;
  assert.deepStrictEqual([x.length, x[0].lat], [1, 45.06]);
  secours.recu(point({ lat: 45.06, expire: 1 }));
  assert.strictEqual(F.etat(chef).interventions[0].statut, 'terminee');
  assert.strictEqual(secours.recu({ port: 'waypoint', de: N3, pointRepere: { id: 1, nom: 'x', lat: 45, lon: 3 } }), false, 'point d’un nœud hors espace : laissé à la carte');
  assert.strictEqual(P.etat(maire).interventions.length, 0);
  // Option éteinte : le point n'ouvre rien, mais il reste hors de la carte (il vient d'un nœud de l'espace)
  F.reglages({ options: { points: false } });
  assert.strictEqual(secours.recu(point({ id: 77, nom: 'Autre' })), true);
  assert.strictEqual(F.etat(chef).interventions.length, 1);
  // Canal réservé : il doit exister sur le module, ne sert qu'à un espace, jamais le canal principal
  assert.throws(() => secours.modifier('festival-2027', { canal: 'Inconnu' }, 'admin'), /n’a pas de canal « Inconnu »/);
  assert.throws(() => secours.modifier('festival-2027', { canal: 'LongFast' }, 'admin'), /canal principal/);
  secours.modifier('festival-2027', { canal: 'secours43' }, 'admin');
  assert.throws(() => secours.modifier('pcs-commune', { canal: 'Secours43' }, 'admin'), /déjà réservé à l’espace « Festival du Velay »/);
  assert.deepStrictEqual(F.etat(chef).canal, { nom: 'Secours43', utilisable: true });
  // Un nœud inconnu de l'espace qui parle sur son canal réservé : noté dans la main courante, caché à la carte
  assert.strictEqual(secours.recu({ port: 'texte', de: N3, texte: 'ici le renfort', canal: 'Secours43' }), true);
  const mc = F.etat(chef).mainCourante[0];
  assert.deepStrictEqual([mc.texte, mc.auteur, mc.origine], ['ici le renfort', '!12345678 (nœud hors espace)', 'radio']);
  assert.strictEqual(secours.recu({ port: 'texte', de: N3, texte: 'ici le renfort', canal: 'Mairie' }), false);
  // Le nœud d'un autre espace qui parle sur ce canal : son message reste à son espace, pas à celui du canal
  assert.strictEqual(secours.recu({ port: 'texte', de: N2, texte: 'la mairie écoute', canal: 'Secours43' }), true);
  assert.ok(P.etat(maire).mainCourante.some((m) => m.texte === 'la mairie écoute') && !F.etat(chef).mainCourante.some((m) => m.texte === 'la mairie écoute'));
  // « Toutes les équipes » : un seul message sur le canal ; une équipe précise : toujours un message direct
  partis.length = 0;
  assert.deepStrictEqual(F.envoyer(chef, { texte: 'Point de situation à 15 h' }).destinataires, ['toutes les équipes (canal Secours43)']);
  F.envoyer(chef, { texte: 'Pour toi seul', equipe: alpha.id });
  assert.deepStrictEqual(partis.map((p) => [p.canal, p.dest, p.texte]), [[1, undefined, 'Point de situation à 15 h'], [undefined, N1, 'Pour toi seul']]);
  assert.match(F.etat(chef).mainCourante[1].texte, /^→ canal Secours43 : Point de situation/);
  // Option « canal » éteinte : retour aux messages directs, équipe par équipe
  F.reglages({ options: { canal: false } });
  partis.length = 0;
  F.envoyer(chef, { texte: 'Sans canal' });
  assert.deepStrictEqual(partis.map((p) => [p.canal, p.dest]), [[undefined, N1]]);
  secours.modifier('festival-2027', { canal: '' }, 'admin');
  assert.strictEqual(F.etat(chef).canal.nom, null);
  assert.ok(journal.some((l) => /canal réservé de l’espace festival-2027 : aucun/.test(l)));
  secours.fermer();
});

test('repères : point de rassemblement partout, repères d’un PCS en option, envoi aux équipes', () => {
  const { secours, partis } = monter();
  festival(secours); commune(secours);
  const F = secours.espace('festival-2027'), P = secours.espace('pcs-commune');
  const chef = F.comptes.lister()[0], maire = P.comptes.lister()[0];
  assert.deepStrictEqual(Object.keys(F.etat(chef).listes.reperes), ['rassemblement']);
  assert.deepStrictEqual(Object.keys(P.etat(maire).listes.reperes), ['rassemblement', 'zone', 'accueil', 'eau', 'acces', 'danger']);
  assert.throws(() => F.majRepere(null, { genre: 'rassemblement', nom: 'Parking' }, 'chef'), /Pointez le repère/);
  const r = F.majRepere(null, { genre: 'rassemblement', nom: 'Parking nord', detail: 'côté portail', lat: 45.0421, lon: 3.8853 }, 'chef');
  assert.throws(() => F.majRepere(null, { genre: 'zone', nom: 'x', contour: [[45, 3], [45.1, 3], [45.1, 3.1]] }, 'chef'), /Type de repère inconnu/);
  assert.deepStrictEqual(F.etat(chef).reperes.map((x) => [x.nom, x.genre, x.lat]), [['Parking nord', 'rassemblement', 45.0421]]);
  // « Tout le monde se retrouve ici » : nom, position et code DFCI partent aux équipes
  F.majEquipe(null, { nom: 'Binôme Alpha', genre: 'binome', noeud: idNoeud(N1) });
  F.diffuserRepere(r.id, {}, chef);
  assert.match(partis[0].texte, /^RASSEMBLEMENT Parking nord · 45\.04210,3\.88530 DFCI \S+ · côté portail$/);
  assert.strictEqual(partis[0].dest, N1);
  // PCS : une zone à évacuer se dessine (3 points au moins), son centre sert de position
  assert.throws(() => P.majRepere(null, { genre: 'zone', nom: 'Quartier bas', contour: [[45, 3], [45.1, 3]] }, 'mairie'), /3 à 60 points/);
  const z = P.majRepere(null, { genre: 'zone', nom: 'Quartier bas', contour: [[45, 3], [45.1, 3], [45.1, 3.3]] }, 'mairie');
  assert.deepStrictEqual([z.contour.length, z.lat, z.lon], [3, 45.066667, 3.1]);
  P.majRepere(null, { genre: 'accueil', nom: 'Gymnase', lat: 45.07, lon: 3.2 }, 'mairie');
  // Option « Repères du PCS » éteinte : il ne reste que les points de rassemblement, rien n'est effacé
  P.reglages({ options: { couches: false } });
  assert.strictEqual(P.etat(maire).reperes.length, 0);
  assert.throws(() => P.diffuserRepere(z.id, {}, maire), /Repère inconnu/);
  P.reglages({ options: { couches: true } });
  assert.strictEqual(P.etat(maire).reperes.length, 2);
  P.majRepere(z.id, { supprimer: true }, 'mairie');
  assert.deepStrictEqual(P.etat(maire).reperes.map((x) => x.nom), ['Gymnase']);
  assert.strictEqual(F.etat(chef).reperes.length, 1, 'les repères d’un espace ne passent pas dans l’autre');
  secours.fermer();
});

test('suivi des nœuds : batterie, trajet, radio de la carte qui tombe, accusés retenus, rapport de fin', () => {
  const { secours, carte, accuses, radio } = monter();
  festival(secours);
  const F = secours.espace('festival-2027'), chef = F.comptes.lister()[0];
  const alpha = F.majEquipe(null, { nom: 'Binôme Alpha', genre: 'binome', noeud: idNoeud(N1), effectif: 2 });
  assert.strictEqual(F.etat(chef).equipes[0].sante, null);
  carte.sante.set(N1, { batterie: 17.6, tension: 3.512, heure: 99 });
  assert.deepStrictEqual(F.etat(chef).equipes[0].sante, { batterie: 18, tension: 3.51, heure: 99 });
  F.reglages({ options: { batterie: false } });
  assert.strictEqual(F.etat(chef).equipes[0].sante, null);
  // Trajet : les positions gardées par la carte pour ce nœud, sur la période demandée
  const t = Date.now();
  carte.traces.set(N1, [{ lat: 45, lon: 3.9, heure: t - 30 * 3600000 }, { lat: 45.01, lon: 3.91, heure: t - 3600000 }, { lat: 45.02, lon: 3.92, heure: t - 60000 }]);
  assert.deepStrictEqual(F.trace(alpha.id, 6).points.map((p) => p[0]), [45.01, 45.02]);
  assert.throws(() => F.trace('inconnue', 6), /Équipe inconnue/);
  F.reglages({ options: { trajets: false } });
  assert.throws(() => F.trace(alpha.id, 6), /pas activés/);
  // Le module radio de la carte tombe puis revient : la main courante le note
  secours.veilleRadio();
  radio.panne = 'Module radio non connecté'; secours.veilleRadio(); secours.veilleRadio();
  radio.panne = null; secours.veilleRadio();
  assert.deepStrictEqual(F.etat(chef).mainCourante.filter((m) => m.origine === 'systeme').map((m) => /déconnecté/.test(m.texte)), [false, true]);
  assert.strictEqual(F.etat(chef).radio.tombee, false);
  radio.panne = 'Module radio non connecté'; secours.veilleRadio();
  assert.strictEqual(F.etat(chef).radio.tombee, true, 'bandeau : le module était connecté et ne l’est plus');
  radio.panne = null; secours.veilleRadio();
  // Accusé retenu dans le fichier de l'espace : il survit à l'oubli du module
  F.envoyer(chef, { texte: 'Rejoignez le PC', equipe: alpha.id });
  const envoi = F.etat(chef).mainCourante[0];
  accuses.set(envoi.envoi, 'recu');
  assert.strictEqual(F.etat(chef).mainCourante[0].accuse, 'recu');
  accuses.clear();
  assert.strictEqual(F.etat(chef).mainCourante[0].accuse, 'recu');
  // Rapport de fin : une page figée avec équipes, interventions, main courante et accusés
  const x = F.majIntervention(null, { titre: 'Malaise <stand 3>', genre: 'malaise', priorite: 1, equipe: alpha.id, lat: 45.04, lon: 3.88 }, 'chef');
  F.majIntervention(x.id, { statut: 'terminee' }, 'chef');
  const r = F.rapport();
  assert.match(r.nom, /^rapport-festival-2027-\d{4}-\d{2}-\d{2}\.html$/);
  for (const attendu of ['Festival du Velay', 'Binôme Alpha', 'Malaise &lt;stand 3&gt;', 'Urgente', '→ Binôme Alpha : Rejoignez le PC', '<td>reçu</td>', 'DFCI ']) assert.ok(r.html.includes(attendu), attendu);
  assert.ok(!r.html.includes('<stand 3>') && !/<script/i.test(r.html));
  F.reglages({ options: { rapport: false } });
  assert.throws(() => F.rapport(), /n’est pas activé/);
  secours.fermer();
});
