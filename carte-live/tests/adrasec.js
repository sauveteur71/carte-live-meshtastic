// Essais de la section ADRASEC : node --test tests/adrasec.js
// Le module est essayé seul, dans un dossier temporaire. Ici : un compte membre de plusieurs ADRASEC (une fiche dans
// chacune) et le message radio de son nœud, qui va à l'ADRASEC du canal utilisé.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { creerAdrasec } = require('../src/adrasec');

const N1 = 0xa1b2c3d4, N2 = 0x0badcafe;
function monter() {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'adrasec-essai-'));
  const canaux = { 43: ['Adrasec43'], 42: ['Adrasec42'] };
  const adrasec = creerAdrasec({ config: { fichierBase: path.join(dossier, 'carte-live.db'), departement: { code: '43' } },
    positionDe: (n) => (n >>> 0 === N1 ? { lat: 45.05, lon: 3.9, heure: 1 } : n >>> 0 === N2 ? { lat: 45.4, lon: 4.3, heure: 1 } : null),
    canauxSection: (code) => canaux[code] || [] });
  adrasec.reglagesGlobaux({ actif: true });
  adrasec.majGroupe('43', { nom: 'ADRASEC 43' }, 'admin');
  adrasec.majGroupe('42', { nom: 'ADRASEC 42' }, 'admin');
  const admin = { id: 1, identifiant: 'admin', role: 'admin' }, op = { id: 2, identifiant: 'operateur', role: 'membre' }, seul = { id: 3, identifiant: 'seul42', role: 'membre' };
  const G = (code) => adrasec.groupePour(admin, code);
  const releves = (code) => G(code).g.releves.length;
  return { adrasec, admin, op, seul, G, releves, canaux };
}

test('un compte membre de deux ADRASEC : une fiche dans chacune, il choisit celle qu’il affiche', () => {
  const { adrasec, admin, op, seul, G } = monter();
  const eq = G('43').majEquipe(null, { nom: 'Gonio 1' }).equipes[0];
  G('43').majMembre(op.id, { membre: true, qualite: 'radioamateur', indicatif: 'F4ABC', noeud: N1, equipe: eq.id, fonction: 'Chef d’équipe' }, 'admin', true);
  assert.deepStrictEqual(adrasec.groupesDe(op), ['43']);
  // Ajouté à l'ADRASEC 42 : plus de refus ; ce qui tient à la personne suit, pas l'équipe, la fonction ni la présidence
  const r = G('42').majMembre(op.id, { membre: true, responsable: true }, 'admin', true);
  assert.strictEqual(r.membre.indicatif, 'F4ABC');
  assert.strictEqual(r.membre.licencie, true);
  assert.strictEqual(r.membre.noeud, N1);
  assert.strictEqual(r.membre.equipe, undefined);
  assert.strictEqual(r.membre.fonction, undefined);
  assert.deepStrictEqual(adrasec.groupesDe(op), ['42', '43']);
  assert.strictEqual(G('43').g.membres[op.id].equipe, eq.id, 'la fiche de la première ADRASEC ne bouge pas');
  // Il affiche celle qu'il choisit ; président dans l'une, simple membre dans l'autre
  assert.strictEqual(adrasec.groupePour(op, '43').g.code, '43');
  assert.strictEqual(adrasec.groupePour(op, '42').g.code, '42');
  assert.strictEqual(adrasec.groupePour(op, null).g.code, '42');
  assert.strictEqual(adrasec.groupePour(op, '42').estResponsable(op), true);
  assert.strictEqual(adrasec.groupePour(op, '43').estResponsable(op), false);
  const v = adrasec.vue(op, [admin, op].map((c) => ({ ...c, statut: 'actif' })), adrasec.groupePour(op, '43'));
  assert.deepStrictEqual(v.sections, [{ code: '42', nom: 'ADRASEC 42' }, { code: '43', nom: 'ADRASEC 43' }]);
  assert.strictEqual(v.groupes, undefined);
  // Un membre d'une seule ADRASEC ne voit pas l'autre, même en la demandant
  G('42').majMembre(seul.id, { membre: true }, 'admin', true);
  assert.strictEqual(adrasec.groupePour(seul, '43').g.code, '42');
  // Gestion des comptes : ses ADRASEC ; les équipes des deux pour un secteur d'alerte
  assert.deepStrictEqual(adrasec.rolesComptes().roles[op.id], { groupe: '42', president: true, groupes: ['42', '43'] });
  assert.deepStrictEqual(adrasec.equipesPourSecteurs(op).map((x) => x.code), ['43']);
  G('42').majEquipe(null, { nom: 'Gonio Loire' });
  assert.deepStrictEqual(adrasec.equipesPourSecteurs(op).map((x) => x.code), ['42', '43']);
  // Retiré de l'une, il reste membre de l'autre
  G('42').majMembre(op.id, { membre: false }, 'admin', true);
  assert.deepStrictEqual(adrasec.groupesDe(op), ['43']);
  assert.strictEqual(G('43').g.membres[op.id].indicatif, 'F4ABC');
});

test('message radio d’un opérateur membre de deux ADRASEC : il va à celle du canal utilisé', () => {
  const { adrasec, admin, op, seul, G, releves } = monter();
  G('43').majMembre(op.id, { membre: true, qualite: 'radioamateur', indicatif: 'F4ABC', noeud: N1 }, 'admin', true);
  G('42').majMembre(op.id, { membre: true }, 'admin', true);
  G('42').majMembre(seul.id, { membre: true, noeud: N2 }, 'admin', true);
  G('43').majRecherche(null, { nom: 'Balise 43' }, admin);
  G('42').majRecherche(null, { nom: 'Balise 42' }, admin);
  // Sur le canal de l'ADRASEC 43 : elle seule
  adrasec.texteRecu({ de: N1, texte: 'GONIO 125', canal: 'Adrasec43' });
  assert.deepStrictEqual([releves('43'), releves('42')], [1, 0]);
  // Sur le canal de l'ADRASEC 42 (casse indifférente) : elle seule
  adrasec.texteRecu({ de: N1, texte: 'GONIO 200', canal: 'adrasec42' });
  assert.deepStrictEqual([releves('43'), releves('42')], [1, 1]);
  // Message direct, ou canal qu'aucune ne déclare : ses deux ADRASEC
  adrasec.texteRecu({ de: N1, texte: 'GONIO 90' });
  assert.deepStrictEqual([releves('43'), releves('42')], [2, 2]);
  adrasec.texteRecu({ de: N1, texte: 'GONIO 95', canal: 'LongFast' });
  assert.deepStrictEqual([releves('43'), releves('42')], [3, 3]);
  // Le membre d'une seule ADRASEC : la sienne, quel que soit le canal
  adrasec.texteRecu({ de: N2, texte: 'GONIO 10', canal: 'Adrasec43' });
  assert.deepStrictEqual([releves('43'), releves('42')], [3, 4]);
  // Un nœud inconnu : rien
  adrasec.texteRecu({ de: 0x99, texte: 'GONIO 10', canal: 'Adrasec43' });
  assert.deepStrictEqual([releves('43'), releves('42')], [3, 4]);
});

test('demande d’adhésion et import : être membre d’une ADRASEC n’empêche plus d’en rejoindre une autre', () => {
  const { adrasec, admin, op, G } = monter();
  G('43').majMembre(op.id, { membre: true, qualite: 'radioamateur', indicatif: 'F4ABC' }, 'admin', true);
  assert.throws(() => adrasec.demander(op, { groupe: '43' }), /déjà membre de cette ADRASEC/);
  assert.deepStrictEqual(adrasec.demander(op, { groupe: '42', qualite: 'radioamateur', indicatif: 'F4ABC' }), { ok: true });
  assert.strictEqual(adrasec.demandeDe(op).groupe, '42');
  G('42').majMembre(op.id, { membre: true }, 'président 42');
  assert.strictEqual(adrasec.demandeDe(op), null);
  assert.deepStrictEqual(adrasec.groupesDe(op), ['42', '43']);
  // Import d'une section : un compte déjà membre d'une autre ADRASEC est rattaché, plus ignoré
  const { adrasec: b, admin: adminB, G: GB } = monter();
  const comptes = [{ id: 7, identifiant: 'F4XYZ', indicatif: 'F4XYZ', statut: 'actif' }];
  GB('43').majMembre(7, { membre: true, qualite: 'radioamateur', indicatif: 'F4XYZ' }, 'admin', true);
  const doc = GB('43').exporter();
  const r = GB('42').importer(doc, comptes, { appliquer: true }, 'admin');
  assert.deepStrictEqual(r.rattaches.map((x) => x.quoi), ['F4XYZ']);
  assert.deepStrictEqual(b.groupesDe({ id: 7 }), ['42', '43']);
  assert.ok(adminB);
});
