'use strict';
// Modules reliés par un « agent » : petit programme lancé sur un PC (module en USB) ou sur un appareil
// d'un autre réseau (module Wi-Fi chez quelqu'un d'autre). L'agent se connecte ici (port 4404, par Tailscale
// ou le réseau local), se présente avec le code secret, puis attend. Quand la carte choisit ce module,
// on lui envoie « OUVRIR » : il ouvre le module et relaie le flux Meshtastic tel quel.

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const journal = (...a) => console.log(new Date().toISOString(), '[Agents]', ...a);
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const nouveauCode = () => [...crypto.randomBytes(12)].map((b) => ALPHABET[b % ALPHABET.length]).join('').replace(/(.{4})(?!$)/g, '$1-');
const slug = (nom) => 'agent-' + (String(nom || 'module').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'module');

function creerAgents(config, { surArrivee } = {}) {
  const port = Number(process.env.AGENTS_PORT || 4404);
  const fCode = path.join(path.dirname(config.fichierBase), 'code-agents.txt');
  let code;
  try { code = fs.readFileSync(fCode, 'utf8').trim(); } catch { /* premier lancement */ }
  if (!code) { code = nouveauCode(); try { fs.writeFileSync(fCode, code, { mode: 0o600 }); } catch { /* lecture seule */ } }
  const agents = new Map(); // hote (agent-xxx) -> { nom, source, socket, depuis, ip, version, occupe }

  const serveur = net.createServer((s) => {
    const ip = (s.remoteAddress || '').replace(/^::ffff:/, '');
    let tampon = Buffer.alloc(0);
    s.setTimeout(15000, () => s.destroy());
    s.on('error', () => {});
    const surDonnees = (morceau) => {
      tampon = Buffer.concat([tampon, morceau]);
      if (tampon.length > 2048) return s.destroy();
      const i = tampon.indexOf(10);
      if (i < 0) return;
      s.off('data', surDonnees);
      s.pause();
      const reste = tampon.subarray(i + 1);
      if (reste.length) s.unshift(reste);
      let b;
      try { b = JSON.parse(tampon.subarray(0, i).toString('utf8')); } catch { s.end('ERREUR message illisible\n'); return; }
      const attendu = Buffer.from(code.replace(/-/g, '').toUpperCase()), recu = Buffer.from(String(b.code || '').replace(/[-\s]/g, '').toUpperCase());
      if (attendu.length !== recu.length || !crypto.timingSafeEqual(attendu, recu)) {
        journal(`agent refusé depuis ${ip} (code incorrect)`);
        setTimeout(() => s.end('ERREUR code incorrect : recopiez le code affiché dans la carte (Réseau › Modules)\n'), 1500);
        return;
      }
      const nom = String(b.nom || 'Module').slice(0, 40);
      const hote = slug(nom);
      const ancien = agents.get(hote);
      if (ancien && ancien.socket !== s) {
        if (ancien.occupe) { s.end(`ERREUR un agent « ${nom} » est déjà en service\n`); return; }
        ancien.socket.destroy();
      }
      s.setTimeout(0);
      s.setKeepAlive(true, 30000);
      s.setNoDelay(true);
      const a = { hote, nom, source: String(b.source || '').slice(0, 60), version: String(b.version || ''), ip, depuis: Date.now(), socket: s, occupe: false };
      a.ping = setInterval(() => { if (!a.occupe) s.write('PING\n'); }, 60000);
      agents.set(hote, a);
      s.on('close', () => {
        clearInterval(a.ping);
        if (agents.get(hote) === a) agents.delete(hote);
        journal(`agent « ${nom} » déconnecté`);
      });
      s.write('OK\n');
      journal(`agent « ${nom} » relié depuis ${ip} (${a.source})`);
      if (surArrivee) surArrivee(hote, nom);
    };
    s.on('data', surDonnees);
  });
  serveur.on('error', (e) => journal(`écoute du port ${port} impossible : ${e.message}`));
  serveur.listen(port, () => journal(`en attente des agents sur le port ${port}`));

  return {
    port,
    code: () => code,
    renouvelerCode() {
      code = nouveauCode();
      try { fs.writeFileSync(fCode, code, { mode: 0o600 }); } catch { /* lecture seule */ }
      for (const a of agents.values()) if (!a.occupe) a.socket.destroy();
      journal('nouveau code des agents (les agents en attente doivent être reconfigurés)');
      return code;
    },
    estAgent: (hote) => typeof hote === 'string' && hote.startsWith('agent-'),
    // Réserve l'agent pour la carte : il ouvre le module et relaie le flux. Renvoie le socket, ou null s'il est absent.
    prendre(hote) {
      const a = agents.get(hote);
      if (!a || a.occupe || a.socket.destroyed) return null;
      a.occupe = true;
      clearInterval(a.ping);
      a.socket.write('OUVRIR\n');
      return a.socket;
    },
    liste: () => [...agents.values()].map(({ hote, nom, source, version, ip, depuis, occupe }) => ({ hote, nom, source, version, ip, depuis, occupe })),
  };
}

module.exports = { creerAgents, slug };
