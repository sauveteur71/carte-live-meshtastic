'use strict';
// Comptes utilisateurs : premier compte (administrateur) créé à l'installation, inscriptions, sessions.
// Mots de passe hachés avec scrypt (sel aléatoire), sessions dans un cookie signé HMAC.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DUREE_SESSION = 30 * 86400 * 1000; // 30 jours
const ROLES = ['admin', 'gestionnaire', 'membre'];
// « gestionnaire » : membre qui programme à distance les seuls nœuds de son secteur (liste « noeuds »)

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

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0, val = 0, out = '';
  for (const o of buf) { val = (val << 8) | o; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function deBase32(t) {
  let bits = 0, val = 0; const out = [];
  for (const ch of String(t).toUpperCase().replace(/[^A-Z2-7]/g, '')) { val = (val << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function codeTotp(secret, pas) {
  const msg = Buffer.alloc(8); msg.writeUInt32BE(Math.floor(pas / 2 ** 32), 0); msg.writeUInt32BE(pas >>> 0, 4);
  const h = crypto.createHmac('sha1', deBase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
// Accepte le pas courant et ses voisins (±30 s de décalage d'horloge) ; refuse un pas déjà utilisé (rejeu)
function verifierTotp(secret, code, dernier) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const maintenant = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) {
    const pas = maintenant + d;
    if (dernier != null && pas <= dernier) continue;
    const c = codeTotp(secret, pas);
    if (crypto.timingSafeEqual(Buffer.from(c), Buffer.from(code))) return pas;
  }
  return null;
}

function creerComptes(db, config) {
  db.exec(`CREATE TABLE IF NOT EXISTS comptes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identifiant TEXT NOT NULL UNIQUE COLLATE NOCASE,
    indicatif TEXT, email TEXT, hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'membre', statut TEXT NOT NULL DEFAULT 'actif',
    cree INTEGER, derniere INTEGER, version INTEGER NOT NULL DEFAULT 1
  )`);
  const colonnes = db.prepare('PRAGMA table_info(comptes)').all().map((c) => c.name);
  if (!colonnes.includes('noeuds')) db.exec('ALTER TABLE comptes ADD COLUMN noeuds TEXT');
  // Double authentification (TOTP) : secret actif, secret en cours d'activation, dernier pas utilisé (anti-rejeu)
  for (const col of ['totp TEXT', 'totp_attente TEXT', 'totp_dernier INTEGER']) if (!colonnes.includes(col.split(' ')[0])) db.exec('ALTER TABLE comptes ADD COLUMN ' + col);
  const q = {
    nombre: db.prepare('SELECT COUNT(*) AS n FROM comptes'),
    nbAdmins: db.prepare("SELECT COUNT(*) AS n FROM comptes WHERE role = 'admin' AND statut = 'actif'"),
    parId: db.prepare('SELECT * FROM comptes WHERE id = ?'),
    parIdentifiant: db.prepare('SELECT * FROM comptes WHERE identifiant = ?'),
    inserer: db.prepare('INSERT INTO comptes (identifiant, indicatif, email, hash, role, statut, cree) VALUES (@identifiant, @indicatif, @email, @hash, @role, @statut, @cree)'),
    tous: db.prepare('SELECT id, identifiant, indicatif, email, role, statut, cree, derniere, noeuds, totp IS NOT NULL AS deuxFacteurs FROM comptes ORDER BY statut DESC, identifiant'),
    noeuds: db.prepare('UPDATE comptes SET noeuds = ? WHERE id = ?'),
    totpAttente: db.prepare('UPDATE comptes SET totp_attente = ? WHERE id = ?'),
    totpActiver: db.prepare('UPDATE comptes SET totp = totp_attente, totp_attente = NULL, totp_dernier = ?, version = version + 1 WHERE id = ?'),
    totpRetirer: db.prepare('UPDATE comptes SET totp = NULL, totp_attente = NULL, totp_dernier = NULL, version = version + 1 WHERE id = ?'),
    totpDernier: db.prepare('UPDATE comptes SET totp_dernier = ? WHERE id = ?'),
    version: db.prepare('UPDATE comptes SET version = version + 1 WHERE id = ?'),
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

  // Nœuds d'un gestionnaire : numéros Meshtastic (texte) et clés publiques MeshCore (64 hex, majuscules)
  function lireNoeuds(t) { try { const l = JSON.parse(t || '[]'); return Array.isArray(l) ? l.map(String) : []; } catch { return []; } }
  function normaliserNoeuds(l) {
    return [...new Set((Array.isArray(l) ? l : String(l || '').split(/[\s,;]+/)).map((x) => String(x).trim()).filter(Boolean).map((x) => {
      if (/^[0-9a-f]{64}$/i.test(x)) return x.toUpperCase();
      if (/^!?[0-9a-f]{8}$/i.test(x) && /[a-f!]/i.test(x)) return String(parseInt(x.replace('!', ''), 16));
      if (/^\d+$/.test(x)) return String(Number(x) >>> 0);
      throw new Error(`Nœud invalide : ${x}`);
    }))].slice(0, 200);
  }
  function nettoyer(c) {
    if (!c) return null;
    return { id: c.id, identifiant: c.identifiant, indicatif: c.indicatif, email: c.email, role: c.role, statut: c.statut, cree: c.cree, derniere: c.derniere, noeuds: lireNoeuds(c.noeuds), deuxFacteurs: !!c.totp };
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
    connecter(identifiant, motDePasse, code) {
      const c = q.parIdentifiant.get(String(identifiant || '').trim());
      // Calcul effectué même si le compte n'existe pas (temps de réponse identique)
      const ok = verifierHash(String(motDePasse || ''), c ? c.hash : 'scrypt$00$00') && !!c;
      if (!ok) throw new Error('Identifiant ou mot de passe incorrect');
      if (c.statut === 'en_attente') throw new Error('Votre inscription attend la validation d’un administrateur');
      if (c.statut !== 'actif') throw new Error('Ce compte est désactivé');
      if (c.totp) {
        if (!code) throw Object.assign(new Error('Code de l’application d’authentification requis'), { codeRequis: true });
        const pas = verifierTotp(c.totp, code, c.totp_dernier);
        if (pas == null) throw Object.assign(new Error('Code d’authentification incorrect ou déjà utilisé'), { codeRequis: true });
        q.totpDernier.run(pas, c.id);
      }
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
    lister: () => q.tous.all().map((c) => ({ ...c, noeuds: lireNoeuds(c.noeuds), deuxFacteurs: !!c.deuxFacteurs })),
    changerNoeuds(id, liste) {
      if (!q.parId.get(id)) throw new Error('Compte inconnu');
      q.noeuds.run(JSON.stringify(normaliserNoeuds(liste)), id);
    },
    // Nœud renuméroté (firmware 2.8) : les secteurs des gestionnaires suivent le nouveau numéro
    remplacerNoeud(ancien, nouveau) {
      const a = String(ancien >>> 0), n = String(nouveau >>> 0);
      let nb = 0;
      for (const c of q.tous.all()) {
        const l = lireNoeuds(c.noeuds);
        if (!l.includes(a)) continue;
        q.noeuds.run(JSON.stringify([...new Set(l.map((x) => (x === a ? n : x)))]), c.id);
        nb++;
      }
      return nb;
    },
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
    // ---- Double authentification (TOTP, RFC 6238 : Google Authenticator, Aegis, FreeOTP…) ----
    preparerDeuxFacteurs(id) {
      const c = q.parId.get(id);
      if (!c) throw new Error('Compte inconnu');
      const secret = base32(crypto.randomBytes(20));
      q.totpAttente.run(secret, id);
      const nom = encodeURIComponent(`${config.carte && config.carte.titre ? config.carte.titre.split('·')[0].trim() : 'Carte live'}:${c.identifiant}`);
      return { secret, url: `otpauth://totp/${nom}?secret=${secret}&issuer=${encodeURIComponent('Carte live')}&algorithm=SHA1&digits=6&period=30` };
    },
    activerDeuxFacteurs(id, code) {
      const c = q.parId.get(id);
      if (!c || !c.totp_attente) throw new Error('Commencez par afficher le QR code');
      const pas = verifierTotp(c.totp_attente, code, null);
      if (pas == null) throw new Error('Code incorrect : vérifiez l’heure du téléphone et réessayez');
      q.totpActiver.run(pas, id);
    },
    retirerDeuxFacteurs(id, motDePasse, parAdmin) {
      const c = q.parId.get(id);
      if (!c) throw new Error('Compte inconnu');
      if (!parAdmin && !verifierHash(String(motDePasse || ''), c.hash)) throw new Error('Mot de passe incorrect');
      q.totpRetirer.run(id);
    },
    // Toutes les sessions ouvertes du compte deviennent invalides (le jeton contient la version du compte)
    deconnecterPartout(id) { q.version.run(id); },
    changerMotDePasse(id, ancien, nouveau) {
      const c = q.parId.get(id);
      if (!c || !verifierHash(String(ancien || ''), c.hash)) throw new Error('Mot de passe actuel incorrect');
      if (String(nouveau || '').length < 8) throw new Error('Mot de passe : 8 caractères minimum');
      q.mdp.run(hacher(String(nouveau)), id);
    },
    DUREE_SESSION,
  };
}

module.exports = { creerComptes, codeTotp };
