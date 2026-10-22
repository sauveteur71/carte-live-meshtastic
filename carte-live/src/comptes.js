'use strict';
// Comptes utilisateurs : premier compte (administrateur) créé à l'installation, inscriptions, sessions.
// Mots de passe hachés avec scrypt (sel aléatoire), sessions dans un cookie signé HMAC.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DUREE_SESSION = 30 * 86400 * 1000; // 30 jours
const ROLES = ['admin', 'membre'];

function hacher(motDePasse) {
  const sel = crypto.randomBytes(16);
  const h = crypto.scryptSync(motDePasse, sel, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${sel.toString('hex')}$${h.toString('hex')}`;
}
function verifierHash(motDePasse, stocke) {
  const [algo, sel, h] = String(stocke || '').split('$');
  if (algo !== 'scrypt' || !sel || !h) return false;
  const calc = crypto.scryptSync(motDePasse, Buffer.from(sel, 'hex'), 32, { N: 16384, r: 8, p: 1 });
  const attendu = Buffer.from(h, 'hex');
  return attendu.length === calc.length && crypto.timingSafeEqual(attendu, calc);
}

function creerComptes(db, config) {
  db.exec(`CREATE TABLE IF NOT EXISTS comptes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identifiant TEXT NOT NULL UNIQUE COLLATE NOCASE,
    indicatif TEXT, email TEXT, hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'membre', statut TEXT NOT NULL DEFAULT 'actif',
    cree INTEGER, derniere INTEGER, version INTEGER NOT NULL DEFAULT 1
  )`);
  const q = {
    nombre: db.prepare('SELECT COUNT(*) AS n FROM comptes'),
    nbAdmins: db.prepare("SELECT COUNT(*) AS n FROM comptes WHERE role = 'admin' AND statut = 'actif'"),
    parId: db.prepare('SELECT * FROM comptes WHERE id = ?'),
    parIdentifiant: db.prepare('SELECT * FROM comptes WHERE identifiant = ?'),
    inserer: db.prepare('INSERT INTO comptes (identifiant, indicatif, email, hash, role, statut, cree) VALUES (@identifiant, @indicatif, @email, @hash, @role, @statut, @cree)'),
    tous: db.prepare('SELECT id, identifiant, indicatif, email, role, statut, cree, derniere FROM comptes ORDER BY statut DESC, identifiant'),
    vu: db.prepare('UPDATE comptes SET derniere = ? WHERE id = ?'),
    role: db.prepare('UPDATE comptes SET role = ?, version = version + 1 WHERE id = ?'),
    statut: db.prepare('UPDATE comptes SET statut = ?, version = version + 1 WHERE id = ?'),
    mdp: db.prepare('UPDATE comptes SET hash = ?, version = version + 1 WHERE id = ?'),
    supprimer: db.prepare('DELETE FROM comptes WHERE id = ?'),
  };

  // Secret de signature conservé dans le volume : les sessions survivent aux redémarrages
  let secret = config.admin.secret;
  if (!secret) {
    const f = path.join(path.dirname(config.fichierBase), 'secret-session.txt');
    try { secret = fs.readFileSync(f, 'utf8').trim(); } catch { /* absent */ }
    if (!secret) { secret = crypto.randomBytes(32).toString('hex'); try { fs.writeFileSync(f, secret, { mode: 0o600 }); } catch { /* volume en lecture seule */ } }
  }
  const signer = (txt) => crypto.createHmac('sha256', secret).update(txt).digest('hex');

  function nettoyer(c) {
    if (!c) return null;
    return { id: c.id, identifiant: c.identifiant, indicatif: c.indicatif, email: c.email, role: c.role, statut: c.statut, cree: c.cree, derniere: c.derniere };
  }
  function valider({ identifiant, motDePasse, indicatif, email }) {
    identifiant = String(identifiant || '').trim();
    if (!/^[\p{L}\p{N}._-]{3,32}$/u.test(identifiant)) throw new Error('Identifiant : 3 à 32 caractères (lettres, chiffres, point, tiret)');
    if (String(motDePasse || '').length < 8) throw new Error('Mot de passe : 8 caractères minimum');
    if (String(motDePasse).length > 200) throw new Error('Mot de passe trop long');
    indicatif = indicatif ? String(indicatif).trim().toUpperCase().slice(0, 16) : null;
    if (indicatif && !/^[A-Z0-9/]{3,16}$/.test(indicatif)) throw new Error('Indicatif invalide');
    email = email ? String(email).trim().slice(0, 120) : null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Adresse e-mail invalide');
    return { identifiant, motDePasse: String(motDePasse), indicatif, email };
  }

  return {
    installationRequise: () => q.nombre.get().n === 0,
    creer(donnees, role = 'membre', statut = 'actif') {
      const d = valider(donnees);
      if (q.parIdentifiant.get(d.identifiant)) throw new Error('Cet identifiant est déjà pris');
      const r = q.inserer.run({ identifiant: d.identifiant, indicatif: d.indicatif, email: d.email, hash: hacher(d.motDePasse), role, statut, cree: Date.now() });
      return nettoyer(q.parId.get(r.lastInsertRowid));
    },
    connecter(identifiant, motDePasse) {
      const c = q.parIdentifiant.get(String(identifiant || '').trim());
      // Calcul effectué même si le compte n'existe pas (temps de réponse identique)
      const ok = verifierHash(String(motDePasse || ''), c ? c.hash : 'scrypt$00$00') && !!c;
      if (!ok) throw new Error('Identifiant ou mot de passe incorrect');
      if (c.statut === 'en_attente') throw new Error('Votre inscription attend la validation d’un administrateur');
      if (c.statut !== 'actif') throw new Error('Ce compte est désactivé');
      q.vu.run(Date.now(), c.id);
      return nettoyer(c);
    },
    // Jeton de session : id.version.expiration.signature (changer le mot de passe ou le rôle invalide les sessions)
    jeton(compte) {
      const c = q.parId.get(compte.id);
      const corps = `${c.id}.${c.version}.${Date.now() + DUREE_SESSION}`;
      return `${corps}.${signer(corps)}`;
    },
    lireJeton(jeton) {
      const m = String(jeton || '').match(/^(\d+)\.(\d+)\.(\d+)\.([0-9a-f]{64})$/);
      if (!m) return null;
      const corps = `${m[1]}.${m[2]}.${m[3]}`;
      const attendu = Buffer.from(signer(corps), 'hex');
      if (!crypto.timingSafeEqual(attendu, Buffer.from(m[4], 'hex'))) return null;
      if (Number(m[3]) < Date.now()) return null;
      const c = q.parId.get(Number(m[1]));
      if (!c || c.statut !== 'actif' || c.version !== Number(m[2])) return null;
      return nettoyer(c);
    },
    lister: () => q.tous.all(),
    changerRole(id, role) {
      if (!ROLES.includes(role)) throw new Error('Rôle inconnu');
      const c = q.parId.get(id);
      if (!c) throw new Error('Compte inconnu');
      if (c.role === 'admin' && role !== 'admin' && q.nbAdmins.get().n <= 1) throw new Error('Il doit rester au moins un administrateur');
      q.role.run(role, id);
    },
    changerStatut(id, statut) {
      if (!['actif', 'en_attente', 'desactive'].includes(statut)) throw new Error('Statut inconnu');
      const c = q.parId.get(id);
      if (!c) throw new Error('Compte inconnu');
      if (c.role === 'admin' && statut !== 'actif' && q.nbAdmins.get().n <= 1) throw new Error('Il doit rester au moins un administrateur');
      q.statut.run(statut, id);
    },
    supprimer(id) {
      const c = q.parId.get(id);
      if (!c) return;
      if (c.role === 'admin' && q.nbAdmins.get().n <= 1) throw new Error('Il doit rester au moins un administrateur');
      q.supprimer.run(id);
    },
    changerMotDePasse(id, ancien, nouveau) {
      const c = q.parId.get(id);
      if (!c || !verifierHash(String(ancien || ''), c.hash)) throw new Error('Mot de passe actuel incorrect');
      if (String(nouveau || '').length < 8) throw new Error('Mot de passe : 8 caractères minimum');
      q.mdp.run(hacher(String(nouveau)), id);
    },
    DUREE_SESSION,
  };
}

module.exports = { creerComptes };
