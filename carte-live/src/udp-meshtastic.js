'use strict';
// Écoute des modules Meshtastic du réseau local par UDP multicast (firmware 2.6 et plus, réglage « UDP » du module :
// Réseau › Protocoles activés › UDP broadcast). Chaque module en Wi-Fi diffuse sur le réseau local les paquets qu'il
// entend ou émet, tels qu'ils passent sur l'air (MeshPacket chiffré). La carte se contente d'écouter : le module reste
// libre pour l'appli du téléphone, aucun agent ni réglage par module.
// Groupes : 239.0.0.69 (firmware 2.8 et plus) et 224.0.0.69 (avant), port 4403.
// Docker : le multicast du réseau local n'atteint le conteneur qu'en réseau « host » (network_mode: host).

const dgram = require('dgram');
const os = require('os');

const GROUPES = ['239.0.0.69', '224.0.0.69'];
const PORT = 4403;

function creerUdpMeshtastic({ types, surPaquet, journal }) {
  const etat = { actif: false, depuis: null, paquets: 0, illisibles: 0, emetteurs: new Map(), erreur: null, groupes: [] };
  let sock = null;

  function interfaces() {
    const l = [];
    for (const liste of Object.values(os.networkInterfaces())) for (const a of liste || []) if (a.family === 'IPv4' && !a.internal) l.push(a.address);
    return l;
  }

  function demarrer() {
    if (sock) return;
    etat.erreur = null;
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (e) => { etat.erreur = e.message; journal(`écoute UDP impossible : ${e.message}`); arreter(); });
    sock.on('message', (buf, rinfo) => {
      let p;
      try { p = types.MeshPacket.decode(buf); } catch { etat.illisibles++; return; }
      if (!p || !p.from) { etat.illisibles++; return; }
      etat.paquets++;
      const e = etat.emetteurs.get(rinfo.address) || { paquets: 0, derniere: 0 };
      e.paquets++; e.derniere = Date.now();
      etat.emetteurs.set(rinfo.address, e);
      if (etat.emetteurs.size > 200) etat.emetteurs.delete(etat.emetteurs.keys().next().value);
      try { surPaquet(p, rinfo.address); } catch (err) { journal('paquet UDP :', err.message); }
    });
    sock.bind(PORT, () => {
      try { sock.setMulticastLoopback(false); } catch { /* ignoré */ }
      etat.groupes = [];
      const ifs = interfaces();
      for (const g of GROUPES) {
        // Abonnement sur chaque interface du serveur (Wi-Fi, Ethernet…), sinon le système n'en choisit qu'une
        for (const i of ifs.length ? ifs : [undefined]) { try { sock.addMembership(g, i); if (!etat.groupes.includes(g)) etat.groupes.push(g); } catch { /* interface sans multicast */ } }
      }
      etat.actif = true; etat.depuis = Date.now();
      journal(`écoute des modules Meshtastic du réseau local (UDP ${etat.groupes.join(', ') || 'aucun groupe'} port ${PORT})`);
    });
  }

  function arreter() {
    if (!sock) return;
    try { sock.close(); } catch { /* déjà fermé */ }
    sock = null; etat.actif = false;
  }

  return {
    demarrer,
    arreter,
    etat: () => ({
      actif: etat.actif, depuis: etat.depuis, paquets: etat.paquets, illisibles: etat.illisibles, erreur: etat.erreur, groupes: etat.groupes, port: PORT,
      emetteurs: [...etat.emetteurs.entries()].sort((a, b) => b[1].derniere - a[1].derniere).slice(0, 20).map(([ip, e]) => ({ ip, ...e })),
    }),
  };
}

module.exports = { creerUdpMeshtastic, GROUPES, PORT };
