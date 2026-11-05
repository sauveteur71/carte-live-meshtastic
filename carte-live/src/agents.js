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

const echecsAgents = new Map(); // adresse -> heures des codes faux (15 dernières minutes)
function creerAgents(config, { surArrivee } = {}) {
  const port = Number(process.env.AGENTS_PORT || 4404);
  const fCode = path.join(path.dirname(config.fichierBase), 'code-agents.txt');
  let code;
  try { code = fs.readFileSync(fCode, 'utf8').trim(); } catch { /* premier lancement */ }
  if (!code) { code = nouveauCode(); try { fs.writeFileSync(fCode, code, { mode: 0o600 }); } catch { /* lecture seule */ } }
  const agents = new Map(); // hote (agent-xxx) -> { nom, source, socket, depuis, ip, version, occupe, relais, reseaux }
  // Modules Wi-Fi d'un autre réseau, joints par leur adresse IP à travers le relais du réseau local d'un agent (1.6+)
  const fPseudos = path.join(path.dirname(config.fichierBase), 'relais-ip.json');
  const pseudos = new Map(); // hote -> { hote, nom, adresse (ip:port), relaisDe, protocole, occupe }
  try { for (const p of JSON.parse(fs.readFileSync(fPseudos, 'utf8'))) pseudos.set(p.hote, { ...p, occupe: false }); } catch { /* aucun */ }
  const sauverPseudos = () => { try { fs.writeFileSync(fPseudos, JSON.stringify([...pseudos.values()].map(({ occupe, ...p }) => p))); } catch { /* lecture seule */ } };
  const ipVersNombre = (ip) => ip.split('.').reduce((a, x) => a * 256 + Number(x), 0);
  const dansReseau = (ip, cidr) => {
    const [base, l] = cidr.split('/'); const n = Number(l);
    const masque = n === 0 ? 0 : 2 ** 32 - 2 ** (32 - n);
    return (ipVersNombre(ip) & masque) >>> 0 === (ipVersNombre(base) & masque) >>> 0;
  };

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
      // Même protection que la connexion : 3 codes faux en 15 min → adresse refusée 15 min
      const t = Date.now(), ech = (echecsAgents.get(ip) || []).filter((x) => t - x < 15 * 60000);
      if (ech.length >= 3) { setTimeout(() => s.end('ERREUR trop de codes incorrects : réessayez dans 15 minutes\n'), 1500); return; }
      if (attendu.length !== recu.length || !crypto.timingSafeEqual(attendu, recu)) {
        ech.push(t); echecsAgents.set(ip, ech);
        if (echecsAgents.size > 5000) echecsAgents.clear();
        journal(`agent refusé depuis ${ip} (code incorrect${ech.length >= 3 ? ', adresse bloquée 15 min' : ''})`);
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
      const reseaux = b.relais && Array.isArray(b.reseaux) ? b.reseaux.map(String).filter((x) => /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(x)).slice(0, 8) : [];
      const a = { hote, nom, source: String(b.source || '').slice(0, 120), version: String(b.version || ''), ip, depuis: Date.now(), socket: s, occupe: false, relais: !!b.relais, reseaux };
      a.ping = setInterval(() => { if (!a.occupe) s.write('PING\n'); }, 60000);
      agents.set(hote, a);
      s.on('close', () => {
        clearInterval(a.ping);
        if (agents.get(hote) === a) agents.delete(hote);
        journal(`agent « ${nom} » déconnecté`);
      });
      s.write('OK\n');
      journal(`agent « ${nom} » relié depuis ${ip} (${a.source})`);
      if (a.relais) {
        // Relais du réseau local : ce sont les modules joints par leur adresse IP qui redeviennent disponibles
        if (surArrivee) for (const p of pseudos.values()) if (p.relaisDe === hote) surArrivee(p.hote, p.nom, p.protocole);
      } else if (surArrivee) surArrivee(hote, nom);
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
      const p = pseudos.get(hote);
      if (p) {
        const r = agents.get(p.relaisDe);
        if (!r || r.occupe || r.socket.destroyed) return null;
        r.occupe = true; p.occupe = true;
        clearInterval(r.ping);
        r.socket.write(`RELAIS ${p.adresse}\n`);
        r.socket.once('close', () => { p.occupe = false; });
        journal(`module ${p.adresse} joint par le relais « ${r.nom} »`);
        return r.socket;
      }
      const a = agents.get(hote);
      if (!a || a.occupe || a.socket.destroyed) return null;
      a.occupe = true;
      clearInterval(a.ping);
      if (!a.virtuel) a.socket.write('OUVRIR\n');
      return a.socket;
    },
    // Relais vers un autre port du module Wi-Fi (3232 : chargeur de mise à jour du firmware) ; agent 1.5 ou plus
    prendrePort(hote, port) {
      const a = agents.get(hote);
      if (!a || a.occupe || a.socket.destroyed || a.virtuel) return null;
      if (!/^1\.([5-9]|\d\d)|^[2-9]\./.test(a.version || '')) throw new Error(`l’agent « ${a.nom} » (version ${a.version || '?'}) est trop ancien : téléchargez et relancez l’agent 1.5 ou plus récent`);
      a.occupe = true;
      clearInterval(a.ping);
      a.socket.write(`TCP ${Number(port)}\n`);
      return a.socket;
    },
    // Module relié par la page web elle-même (USB ou Bluetooth du navigateur) : flux déjà ouvert
    ajouterVirtuel(nom, source, flux, ip) {
      const hote = slug(nom);
      const ancien = agents.get(hote);
      if (ancien && ancien.socket !== flux) ancien.socket.destroy();
      const a = { hote, nom, source, version: 'navigateur', ip, depuis: Date.now(), socket: flux, occupe: false, virtuel: true };
      agents.set(hote, a);
      flux.on('close', () => { if (agents.get(hote) === a) agents.delete(hote); journal(`module « ${nom} » (navigateur) déconnecté`); });
      journal(`module « ${nom} » relié par le navigateur depuis ${ip} (${source})`);
      return hote;
    },
    // Agents et modules joints par IP (en ligne si leur relais est là) ; les relais eux-mêmes n'y figurent pas
    liste: () => [
      ...[...agents.values()].filter((a) => !a.relais).map(({ hote, nom, source, version, ip, depuis, occupe }) => ({ hote, nom, source, version, ip, depuis, occupe })),
      ...[...pseudos.values()].filter((p) => agents.has(p.relaisDe)).map((p) => { const r = agents.get(p.relaisDe); return { hote: p.hote, nom: p.nom, source: `Wi-Fi ${p.adresse} via ${r.nom}`, version: r.version, ip: r.ip, depuis: r.depuis, occupe: p.occupe, protocole: p.protocole }; }),
    ],
    relais: () => [...agents.values()].filter((a) => a.relais).map(({ hote, nom, reseaux, version, occupe, ip }) => ({ hote, nom, reseaux, version, occupe, ip })),
    // Relais du réseau local qui couvre cette adresse
    relaisPour: (ip) => [...agents.values()].filter((a) => a.relais && !a.socket.destroyed && a.reseaux.some((c) => dansReseau(ip, c))),
    // Demande au relais quels ports (4403 Meshtastic, 5000 MeshCore) répondent à cette adresse
    sonder(hoteRelais, ip) {
      const r = agents.get(hoteRelais);
      if (!r || !r.relais || r.occupe || r.socket.destroyed) return Promise.reject(new Error('relais indisponible (occupé ou hors ligne)'));
      return new Promise((ok, ko) => {
        let t = Buffer.alloc(0);
        const fin = (f, v) => { clearTimeout(minut); r.socket.off('data', surD); r.socket.pause(); f(v); };
        const surD = (d) => {
          t = Buffer.concat([t, d]);
          for (;;) {
            const i = t.indexOf(10); if (i < 0) return;
            const l = t.subarray(0, i).toString().trim(); t = t.subarray(i + 1);
            if (l === 'HORS') return fin(ko, new Error('adresse hors des réseaux locaux du PC de l’agent'));
            if (l.startsWith('PORTS')) return fin(ok, l.slice(5).trim().split(',').filter(Boolean).map(Number));
          }
        };
        const minut = setTimeout(() => fin(ko, new Error('le relais ne répond pas')), 12000);
        r.socket.on('data', surD);
        r.socket.resume();
        r.socket.write(`SONDER ${ip}\n`);
      });
    },
    // Inscrit un module joint par IP à travers un relais ; renvoie son identifiant (utilisable comme un agent)
    ajouterParIp(hoteRelais, ip, port, protocole) {
      const r = agents.get(hoteRelais);
      const nom = `${protocole === 'meshcore' ? 'MeshCore' : 'Meshtastic'} ${ip}`;
      const hote = slug(nom);
      pseudos.set(hote, { hote, nom, adresse: `${ip}:${port}`, relaisDe: hoteRelais, protocole, occupe: false });
      sauverPseudos();
      journal(`module ${ip}:${port} (${protocole}) inscrit, joignable par « ${r ? r.nom : hoteRelais} »`);
      return hote;
    },
  };
}

module.exports = { creerAgents, slug };
