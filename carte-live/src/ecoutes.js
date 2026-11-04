'use strict';
// Modules « en écoute » : en plus du module Meshtastic principal et du companion MeshCore principal, d'autres
// modules peuvent être reliés en même temps (Wi-Fi, agent USB, Bluetooth ou USB d'une page de la carte).
// Chacun sert de passerelle d'écoute supplémentaire : tout ce qu'il entend est intégré avec sa propre mesure
// (SNR, RSSI, sauts), exactement comme une passerelle MQTT. Les paquets entendus par plusieurs modules ne
// sont pas comptés deux fois : ce sont des réceptions d'un même paquet par plusieurs passerelles.
// Envois de messages, traceroutes et administration passent toujours par le module principal.
//
// Les modules Wi-Fi et agents en écoute sont conservés (modules-ecoute.json) ; ceux d'une page ne durent
// que le temps de la page.

const fs = require('fs');
const path = require('path');

function creerEcoutes({ config, fabriquerRadio, fabriquerCompanion, journal, surChangement }) {
  const fichier = path.join(path.dirname(config.fichierBase), 'modules-ecoute.json');
  let memo = { meshtastic: [], meshcore: [] };
  try { memo = { ...memo, ...JSON.parse(fs.readFileSync(fichier, 'utf8')) }; } catch { /* aucun */ }
  const sauver = () => { try { fs.writeFileSync(fichier, JSON.stringify(memo, null, 1)); } catch (e) { journal('sauvegarde des modules en écoute impossible :', e.message); } };
  const radios = new Map(); // "hote:port" -> { hote, port, nom, navigateur, source, instance }
  const companions = new Map(); // clé -> { cle, cible, nom, navigateur, source, instance }
  const cleRadio = (hote, port) => `${hote}:${port}`;
  const cleCompanion = (c) => (c.type === 'tcp' ? `${c.hote}:${c.port}` : c.type === 'serie' ? c.chemin : c.hote);
  const changer = () => { if (surChangement) setImmediate(surChangement); };

  // ---- Meshtastic ----
  function ajouterRadio(hote, port, nom = null, { navigateur = false, source = null } = {}) {
    const k = cleRadio(hote, port);
    if (radios.has(k)) return radios.get(k);
    if (!nom) nom = hote.startsWith('agent-') ? hote.replace(/^agent-/, '') : `Meshtastic ${hote}`;
    const r = { hote, port, nom, navigateur, source, depuis: Date.now() };
    r.instance = fabriquerRadio({ hote, port, nom });
    radios.set(k, r);
    if (!navigateur && !memo.meshtastic.some((m) => m.hote === hote && m.port === port)) { memo.meshtastic.push({ hote, port, nom }); sauver(); }
    journal(`module Meshtastic « ${nom || hote} » ajouté en écoute`);
    changer();
    return r;
  }
  function retirerRadio(hote, port) {
    const k = cleRadio(hote, port);
    const r = radios.get(k);
    if (r) { try { r.instance.detruire(); } catch (e) { journal('arrêt :', e.message); } radios.delete(k); journal(`module Meshtastic « ${r.nom || hote} » retiré de l'écoute`); }
    const avant = memo.meshtastic.length;
    memo.meshtastic = memo.meshtastic.filter((m) => !(m.hote === hote && m.port === port));
    if (memo.meshtastic.length !== avant) sauver();
    changer();
    return !!r;
  }
  const estRadio = (hote, port) => radios.has(cleRadio(hote, port));

  // ---- MeshCore ----
  function ajouterCompanion(cible, nom = null, { navigateur = null, source = null } = {}) {
    if (!nom && cible) nom = cible.type === 'agent' ? cible.hote.replace(/^agent-/, '') : cible.type === 'serie' ? `MeshCore ${cible.chemin.split('/').pop()}` : `MeshCore ${cible.hote}`;
    const cle = navigateur ? 'nav:' + nom : cleCompanion(cible);
    if (companions.has(cle)) { const c = companions.get(cle); if (!navigateur) return c; try { c.instance.detruire(); } catch { /* déjà */ } }
    const c = { cle, cible: navigateur ? null : cible, nom: nom || (cible ? cible.hote : 'companion'), navigateur: !!navigateur, source, depuis: Date.now() };
    c.instance = fabriquerCompanion({ cible: navigateur ? null : cible, nom: c.nom });
    companions.set(cle, c);
    if (navigateur) {
      c.instance.brancherNavigateur(navigateur, c.nom, source || 'USB');
      navigateur.on('close', () => { if (companions.get(cle) === c) { try { c.instance.detruire(); } catch { /* déjà */ } companions.delete(cle); journal(`companion « ${c.nom} » (navigateur) retiré de l'écoute`); changer(); } });
    } else {
      if (!memo.meshcore.some((m) => cleCompanion(m.cible) === cle)) { memo.meshcore.push({ cible, nom }); sauver(); }
      c.instance.demarrer();
    }
    journal(`companion MeshCore « ${c.nom} » ajouté en écoute`);
    changer();
    return c;
  }
  function retirerCompanion(cle) {
    const c = companions.get(cle);
    if (c) { try { c.instance.detruire(); } catch { /* déjà */ } companions.delete(cle); journal(`companion « ${c.nom} » retiré de l'écoute`); }
    const avant = memo.meshcore.length;
    memo.meshcore = memo.meshcore.filter((m) => cleCompanion(m.cible) !== cle);
    if (memo.meshcore.length !== avant) sauver();
    changer();
    return !!c;
  }
  const estCompanion = (cible) => companions.has(cleCompanion(cible));

  // Un agent vient de se présenter : les modules en écoute qui en dépendent se reconnectent
  function agentDisponible(hote, nom, protocole) {
    if (protocole !== 'meshcore') for (const r of radios.values()) if (r.hote === hote) r.instance.agentDisponible(hote, nom);
    if (protocole !== 'meshtastic') for (const c of companions.values()) if (c.cible && c.cible.type === 'agent' && c.cible.hote === hote) c.instance.agentDisponible(hote);
  }

  function liste() {
    return {
      meshtastic: [...radios.values()].map((r) => {
        const e = r.instance.etat();
        return { hote: r.hote, port: r.port, nom: e.nomLocal || r.nom, navigateur: r.navigateur, source: r.source, depuis: r.depuis, connecte: !!e.connecte, noeud: e.noeudLocal, paquets: e.paquets || 0, erreur: e.erreur || null, reprise: e.reprise || null };
      }),
      meshcore: [...companions.values()].map((c) => {
        const e = c.instance.etat();
        return { cle: c.cle, cible: c.cible, nom: e.nom || c.nom, navigateur: c.navigateur, source: c.source, depuis: c.depuis, connecte: !!e.connecte, cleNoeud: e.cle, paquets: e.paquets || 0, erreur: e.erreur || null, lat: e.lat, lon: e.lon, radio: e.radio };
      }),
    };
  }

  // Au démarrage : modules conservés
  function demarrer() {
    for (const m of memo.meshtastic) if (!radios.has(cleRadio(m.hote, m.port))) { const r = { hote: m.hote, port: m.port, nom: m.nom, navigateur: false, depuis: Date.now() }; r.instance = fabriquerRadio(m); radios.set(cleRadio(m.hote, m.port), r); }
    for (const m of config.meshcore && config.meshcore.actif ? memo.meshcore : []) {
      const cle = cleCompanion(m.cible);
      if (companions.has(cle)) continue;
      const c = { cle, cible: m.cible, nom: m.nom || m.cible.hote || m.cible.chemin, navigateur: false, depuis: Date.now() };
      c.instance = fabriquerCompanion({ cible: m.cible, nom: c.nom });
      companions.set(cle, c);
      c.instance.demarrer();
    }
    const n = radios.size + companions.size;
    if (n) journal(`${n} module(s) en écoute`);
  }

  return { ajouterRadio, retirerRadio, estRadio, ajouterCompanion, retirerCompanion, estCompanion, cleCompanion, agentDisponible, liste, demarrer, companions: () => [...companions.values()].map((c) => c.instance) };
}

module.exports = { creerEcoutes };
