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
    envoyerTexte: ({ texte, dest }, auteur) => { if (radio.panne) throw new Error(radio.panne); const id = partis.length + 1; partis.push({ id, texte, dest, auteur }); accuses.set(id, 'envoye'); return { id, dest }; },
    etatEnvoi: (n) => (accuses.has(n) ? { statut: accuses.get(n) } : null) };
  const secours = creerSecours({ config: { fichierBase: path.join(dossier, 'carte-live.db') }, journal: (...a) => journal.push(a.join(' ')), radio, espacement: 5,
    positionDe: (n) => positions.get(n >>> 0) || null, nomDe: (n) => (n >>> 0 === N1 ? 'Binôme Alpha' : null) });
  return { dossier, secours, positions, journal, radio, partis, accuses };
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
  // Intervention : intitulé, position et code DFCI, à l'équipe engagée ; message ramené à 200 octets
  const x = F.majIntervention(null, { genre: 'malaise', titre: 'Malaise devant la scène', lat: 45.0432, lon: 3.8853, urgente: true, equipe: bravo.id, detail: 'é'.repeat(300) }, 'chef.dispositif');
  F.diffuserIntervention(x.id, {}, chef);
  const dernier = partis.at(-1);
  assert.strictEqual(dernier.dest, N2);
  assert.match(dernier.texte, /^INTER Malaise devant la scène \(URGENT\) · 45\.04320,3\.88530 DFCI [A-Z]{2}\d{2}[A-Z]\d(\.\d)? · é+$/);
  assert.ok(Buffer.byteLength(dernier.texte) <= 200);
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
