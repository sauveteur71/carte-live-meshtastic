'use strict';
// Journal d'audit : qui a fait quoi, quand, depuis où (connexions, programmation, réglages, comptes…).
// Table « audit » dans la base ; 180 jours ou 20 000 lignes au plus.

const SENSIBLES = /mot ?de ?passe|motdepasse|mdp|password|ancien|nouveau|code|psk|cle|secret|jeton|token|photo|texte/i;

function creerAudit(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, heure INTEGER NOT NULL, compte TEXT, ip TEXT,
    action TEXT NOT NULL, detail TEXT, ok INTEGER NOT NULL DEFAULT 1
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS audit_heure ON audit (heure)');
  const q = {
    ins: db.prepare('INSERT INTO audit (heure, compte, ip, action, detail, ok) VALUES (?, ?, ?, ?, ?, ?)'),
    liste: db.prepare('SELECT * FROM audit WHERE (@compte IS NULL OR compte = @compte) AND (@action IS NULL OR action LIKE @action) ORDER BY id DESC LIMIT @limite'),
    purge: db.prepare('DELETE FROM audit WHERE heure < ? OR id <= (SELECT MAX(id) FROM audit) - 20000'),
  };
  const minuterie = setInterval(() => { try { q.purge.run(Date.now() - 180 * 86400000); } catch { /* base occupée */ } }, 6 * 3600000);
  if (minuterie.unref) minuterie.unref();

  // Résumé d'un corps de requête sans aucune valeur sensible
  function resumer(b) {
    if (!b || typeof b !== 'object') return '';
    const parties = [];
    for (const [k, v] of Object.entries(b)) {
      if (SENSIBLES.test(k)) { parties.push(`${k}=…`); continue; }
      if (v == null) continue;
      let t = typeof v === 'object' ? (Array.isArray(v) ? `[${v.slice(0, 8).map((x) => (typeof x === 'object' ? '…' : String(x))).join(',')}${v.length > 8 ? ',…' : ''}]` : `{${Object.keys(v).filter((x) => !SENSIBLES.test(x)).slice(0, 8).join(',')}}`) : String(v);
      if (t.length > 60) t = t.slice(0, 57) + '…';
      parties.push(`${k}=${t}`);
    }
    return parties.join(' · ').slice(0, 400);
  }

  return {
    noter(compte, ip, action, detail, ok = true) {
      try { q.ins.run(Date.now(), compte || null, ip || null, String(action).slice(0, 120), detail ? String(detail).slice(0, 500) : null, ok ? 1 : 0); } catch { /* ne bloque jamais l'action */ }
    },
    resumer,
    liste: ({ compte = null, action = null, limite = 300 } = {}) => q.liste.all({ compte, action: action ? `%${action}%` : null, limite: Math.min(Number(limite) || 300, 2000) }),
  };
}

module.exports = { creerAudit };
