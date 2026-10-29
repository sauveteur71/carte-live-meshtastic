'use strict';
// Simulation de la propagation d'un paquet Meshtastic dans le maillage (inondation), à événements discrets.
// Reprend la logique du firmware 2.7 (RadioInterface, FloodingRouter, NextHopRouter, Router) et s'inspire de
// Meshtasticator (lib/mac.py, lib/phy.py) :
//  - temps d'attente avant réémission pondéré par le SNR de réception (fenêtre de contention CWmin 3 … CWmax 8,
//    « slot time » = durée de détection d'activité + propagation + retournement) ; un ROUTER réémet en priorité ;
//  - un CLIENT annule sa réémission s'il entend un autre nœud réémettre le même paquet ; ROUTER et ROUTER_LATE jamais ;
//    ROUTER_LATE (et CLIENT_BASE pour ses favoris) passe alors en « fenêtre tardive » ;
//  - chaque réémission décompte un saut, sauf entre relais favoris (ROUTER, ROUTER_LATE, CLIENT_BASE ; 2.7.11+) ;
//  - avant d'émettre, le nœud écoute le canal (CAD) : occupé → nouvelle attente ;
//  - semi-duplex (un nœud qui émet n'entend rien) et collisions avec effet de capture (≥ 6 dB d'écart) ;
//  - message texte : l'émetteur réémet (3 fois au plus) s'il n'entend aucun relais (accusé implicite).
// Les liaisons sont celles mesurées par la carte (SNR dans chaque sens).

(function (racine, fabrique) {
  if (typeof module === 'object' && module.exports) module.exports = fabrique();
  else racine.SimMaillage = fabrique();
})(typeof self !== 'undefined' ? self : this, function () {
  const PRESETS = {
    LONG_FAST: { sf: 11, bw: 250, cr: 5 }, LONG_SLOW: { sf: 12, bw: 125, cr: 8 }, VERY_LONG_SLOW: { sf: 12, bw: 62.5, cr: 8 },
    MEDIUM_SLOW: { sf: 10, bw: 250, cr: 5 }, MEDIUM_FAST: { sf: 9, bw: 250, cr: 5 }, SHORT_SLOW: { sf: 8, bw: 250, cr: 5 },
    SHORT_FAST: { sf: 7, bw: 250, cr: 5 }, LONG_MODERATE: { sf: 11, bw: 125, cr: 8 }, SHORT_TURBO: { sf: 7, bw: 500, cr: 5 },
    LONG_TURBO: { sf: 11, bw: 500, cr: 8 },
    // MeshCore (réglage français 869,618 MHz) ; « EU/UK narrow » courant ailleurs en Europe
    MESHCORE_FR: { sf: 8, bw: 62.5, cr: 8 }, MESHCORE_EU_NARROW: { sf: 8, bw: 62.5, cr: 8 }, MESHCORE_SF10: { sf: 10, bw: 62.5, cr: 5 },
  };
  // SNR minimal démodulable par facteur d'étalement (dB)
  const SNR_LIMITE = { 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20 };
  const CW_MIN = 3, CW_MAX = 8, SNR_MIN = -20, SNR_MAX = 10;
  const PROCESSING_TIME_MS = 4500, RETX_MAX = 3, CAPTURE_DB = 6;
  const ROLES_ROUTEURS = ['ROUTER', 'ROUTER_LATE', 'CLIENT_BASE'];
  const NE_RELAIENT_PAS = ['CLIENT_MUTE', 'CLIENT_HIDDEN'];

  // Générateur pseudo-aléatoire reproductible (mulberry32)
  function aleatoire(graine) {
    let a = graine >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  // Durée d'émission (ms) d'une trame LoRa (formule Semtech, préambule de 16 symboles, en-tête Meshtastic de 16 octets)
  function tempsEmissionMs(octets, p, entete = 16) {
    const tsym = 2 ** p.sf / (p.bw * 1000);
    const de = tsym > 0.016 ? 1 : 0;
    const nb = 8 + Math.max(Math.ceil((8 * (octets + entete) - 4 * p.sf + 28 + 16) / (4 * (p.sf - 2 * de))) * p.cr, 0);
    return ((16 + 4.25) * tsym + nb * tsym) * 1000;
  }
  // « Slot time » du firmware (RadioInterface::computeSlotTimeMsec) : CAD (2 symboles + 0,5) + 0,2 + 0,4 + 7 ms
  const slotMs = (p) => Math.max(2.25, 2 + 0.5) * (2 ** p.sf / p.bw) + 7.6;
  const cwTaille = (snr) => {
    const s = Math.min(SNR_MAX, Math.max(SNR_MIN, snr));
    return Math.floor(((s - SNR_MIN) * (CW_MAX - CW_MIN)) / (SNR_MAX - SNR_MIN) + CW_MIN);
  };

  /**
   * reseau : { noeuds: [{ num, role, canal }], liens: [{ a, b, ab: {snr}|null, ba: {snr}|null }], favoris: { [num]: [nums] } }
   * opts : { emetteur, preset, presetMesure, hopLimit, octets, texte, symetrique, favoris: 'poses'|'tous'|'aucun', roles: { [num]: role }, graine, dureeMax }
   */
  function preparer(reseau, opts) {
    const p = PRESETS[opts.preset] || PRESETS.LONG_FAST;
    const pm = PRESETS[opts.presetMesure] || p;
    // SNR mesuré avec le preset du réseau, ramené à la bande du preset simulé (bruit ∝ bande)
    const correction = 10 * Math.log10(pm.bw / p.bw);
    const seuil = SNR_LIMITE[p.sf];
    const roleDe = new Map(reseau.noeuds.map((n) => [n.num, (opts.roles && opts.roles[n.num]) || n.role || 'CLIENT']));
    const canalDe = new Map(reseau.noeuds.map((n) => [n.num, n.canal || 0]));
    // entend.get(rx) : Map(tx → snr) — rx entend tx
    const entend = new Map(reseau.noeuds.map((n) => [n.num, new Map()]));
    const ajouter = (tx, rx, snr) => {
      if (!entend.has(rx) || !entend.has(tx)) return;
      const s = snr == null ? seuil + 3 : snr + correction; // liaison sans SNR connu (traceroute) : supposée juste au-dessus du seuil
      if (s < seuil) return;
      const e = entend.get(rx).get(tx);
      if (e == null || s > e) entend.get(rx).set(tx, s);
    };
    for (const l of reseau.liens) {
      if (l.ab) ajouter(l.a, l.b, l.ab.snr);
      if (l.ba) ajouter(l.b, l.a, l.ba.snr);
      // Liaison mesurée dans un seul sens : souvent parce que l'autre nœud ne rapporte rien ; supposée réciproque
      if (opts.symetrique !== false) {
        if (l.ab && !l.ba) ajouter(l.b, l.a, l.ab.snr);
        if (l.ba && !l.ab) ajouter(l.a, l.b, l.ba.snr);
      }
    }
    // Favoris : ceux posés par la carte, ou tous les routeurs entendus directement (simulation « tous posés »)
    const favoris = new Map();
    for (const n of reseau.noeuds) {
      let f = [];
      if (opts.favoris === 'poses') f = (reseau.favoris && reseau.favoris[n.num]) || n.favoris || [];
      else if (opts.favoris === 'tous') f = [...entend.get(n.num).keys()].filter((t) => ROLES_ROUTEURS.includes(roleDe.get(t)));
      favoris.set(n.num, new Set(f));
    }
    // qui entend tx : liste inverse
    const auditeurs = new Map(reseau.noeuds.map((n) => [n.num, []]));
    for (const [rx, m] of entend) for (const [tx, snr] of m) auditeurs.get(tx).push({ rx, snr });
    // Qui relaie : fourni par la carte (MeshCore : seuls les répéteurs), sinon tout sauf les rôles muets
    const relaieDe = new Map(reseau.noeuds.map((n) => [n.num, (opts.roles && opts.roles[n.num]) ? (opts.protocole === 'meshcore' ? opts.roles[n.num] === 'repeteur' : !NE_RELAIENT_PAS.includes(opts.roles[n.num])) : n.relaie != null ? !!n.relaie : !NE_RELAIENT_PAS.includes(roleDe.get(n.num))]));
    const mc = opts.protocole === 'meshcore';
    // MeshCore : en-tête (1) + longueur de chemin (1) ; Meshtastic : en-tête de 16 octets
    return { p, seuil, roleDe, relaieDe, canalDe, entend, auditeurs, favoris, airtime: tempsEmissionMs(opts.octets || 40, p, mc ? 2 : 16), slot: slotMs(p) };
  }

  function simuler(reseau, opts, prep) {
    prep = prep || preparer(reseau, opts);
    const { roleDe, relaieDe, canalDe, auditeurs, favoris, airtime, slot } = prep;
    const mc = opts.protocole === 'meshcore';
    // MeshCore (firmware répéteur) : délai de réémission aléatoire 0…5·t, t = temps d'antenne × tx_delay_factor (0,5) ;
    // pas d'annulation sur doublon ; canal occupé → nouvel essai après 120 à 360 ms ; flood.max (64, annonces 8)
    const txDelayFactor = opts.txDelayFactor ?? 0.5;
    const alea = aleatoire(opts.graine || 1);
    const tirer = (n) => Math.floor(alea() * n); // entier de 0 à n-1 (comme random(0, n) Arduino)
    const H = Math.min(mc ? 64 : 7, Math.max(0, opts.hopLimit ?? (mc ? 64 : 3)));
    const E = opts.emetteur;
    const dureeMax = opts.dureeMax || 180000;
    const journal = [];
    const etat = new Map(); // num → { recu, t, sauts, hop, de, attente: {t, hop, snr, tardif, id}, emet: fin, rx: [] }
    for (const n of reseau.noeuds) etat.set(n.num, { recu: false, t: null, sauts: null, hop: null, attente: null, emet: 0, rx: [], doublons: 0, emissions: 0, collisions: 0, annule: false });
    if (!etat.has(E)) throw new Error('Émetteur inconnu');
    const file = []; // événements { t, type, ... } triés par t
    let seq = 0;
    const planifier = (ev) => { ev.seq = seq++; let i = file.length; file.push(ev); while (i > 0 && (file[i - 1].t > ev.t || (file[i - 1].t === ev.t && file[i - 1].seq > ev.seq))) { file[i] = file[i - 1]; i--; } file[i] = ev; };
    const cwCanal = (num) => Math.floor(((Math.min(100, canalDe.get(num) || 0)) * (CW_MAX - CW_MIN)) / 100 + CW_MIN);
    const delaiPondere = (num, snr) => {
      const cw = cwTaille(snr);
      if (roleDe.get(num) === 'ROUTER') return tirer(2 * cw) * slot;
      return 2 * CW_MAX * slot + tirer(2 ** cw) * slot;
    };
    const delaiPireCas = (snr) => 2 * CW_MAX * slot + 2 ** cwTaille(snr) * slot;
    const stats = { emissions: 0, collisions: 0, doublons: 0, annulations: 0, reportsCanal: 0, retransmissions: 0, sautsGratuits: 0, tempsAntenne: 0 };

    // Départ : l'émetteur envoie (délai d'accès au canal aléatoire)
    const se = etat.get(E);
    se.recu = true; se.t = 0; se.sauts = 0; se.hop = H;
    if (mc) { se.hop = 0; } // MeshCore : « hop » = longueur du chemin déjà parcouru
    se.attente = { t: mc ? 0 : tirer(2 ** cwCanal(E)) * slot, hop: mc ? 0 : H, snr: null, tardif: false, origine: true, id: 1 };
    planifier({ t: se.attente.t, type: 'tx', num: E, id: 1 });
    let retx = 0, entenduRelais = false;
    if (opts.texte && !mc) planifier({ t: se.attente.t + 2 * airtime + (2 ** CW_MIN + 2 * CW_MAX + 2 ** 5) * slot + PROCESSING_TIME_MS, type: 'retx' });

    let fin = 0;
    while (file.length) {
      const ev = file.shift();
      if (ev.t > dureeMax) break;
      const t = ev.t;
      if (ev.type === 'tx') {
        const s = etat.get(ev.num);
        if (!s.attente || s.attente.id !== ev.id) continue; // annulé ou replanifié
        // Écoute du canal : une réception en cours → nouvelle attente
        if (s.rx.some((r) => r.fin > t) || s.emet > t) {
          s.attente.t = t + (mc ? (1 + tirer(3)) * 120 : tirer(2 ** cwCanal(ev.num)) * slot + slot);
          s.attente.id = ++seq;
          stats.reportsCanal++;
          journal.push({ t, type: 'report', num: ev.num });
          planifier({ t: s.attente.t, type: 'tx', num: ev.num, id: s.attente.id });
          continue;
        }
        const hop = s.attente.hop;
        s.attente = null;
        s.emet = t + airtime;
        s.emissions++;
        stats.emissions++;
        stats.tempsAntenne += airtime;
        journal.push({ t, type: 'tx', num: ev.num, hop, duree: airtime });
        fin = Math.max(fin, t + airtime);
        for (const { rx, snr } of auditeurs.get(ev.num)) {
          const r = etat.get(rx);
          const rec = { de: ev.num, debut: t, fin: t + airtime, snr, hop, perdu: false, raison: null };
          if (r.emet > t) { rec.perdu = true; rec.raison = 'emet'; }
          // Collisions avec les réceptions en cours (effet de capture)
          for (const o of r.rx) {
            if (o.fin <= t) continue;
            if (Math.abs(o.snr - snr) < CAPTURE_DB) { o.perdu = true; o.raison = o.raison || 'collision'; rec.perdu = true; rec.raison = 'collision'; }
            else if (o.snr > snr) { rec.perdu = true; rec.raison = 'collision'; }
            else { o.perdu = true; o.raison = o.raison || 'collision'; }
          }
          r.rx.push(rec);
          planifier({ t: t + airtime, type: 'rx', num: rx, rec });
        }
        // Un nœud qui se met à émettre perd ce qu'il était en train de recevoir
        for (const o of s.rx) if (o.fin > t) { o.perdu = true; o.raison = 'emet'; }
      } else if (ev.type === 'rx') {
        const num = ev.num, s = etat.get(num), rec = ev.rec;
        s.rx = s.rx.filter((x) => x.fin > t || x === rec);
        s.rx = s.rx.filter((x) => x !== rec);
        if (rec.perdu) {
          s.collisions++;
          if (rec.raison === 'collision') stats.collisions++;
          journal.push({ t, type: 'perdu', num, de: rec.de, raison: rec.raison });
          continue;
        }
        if (num === E) {
          // L'émetteur entend un relais : accusé implicite, pas de réémission
          entenduRelais = true;
          stats.doublons++;
          journal.push({ t, type: 'doublon', num, de: rec.de });
          continue;
        }
        const role = roleDe.get(num);
        if (s.recu) {
          s.doublons++;
          stats.doublons++;
          journal.push({ t, type: 'doublon', num, de: rec.de });
          if (s.attente && !mc) {
            const favEmetteur = favoris.get(num).has(E);
            const annulable = !['ROUTER', 'ROUTER_LATE'].includes(role) && !(role === 'CLIENT_BASE' && favEmetteur);
            if (rec.hop > s.attente.hop && rec.hop > 0) {
              // Copie « améliorée » (plus de sauts restants) : on la réémet à la place
              s.attente.hop = rec.hop - 1;
            } else if (annulable) {
              s.attente = null; s.annule = true;
              stats.annulations++;
              journal.push({ t, type: 'annule', num });
            } else if ((role === 'ROUTER_LATE' || (role === 'CLIENT_BASE' && favEmetteur)) && !s.attente.tardif) {
              s.attente.tardif = true;
              s.attente.t = t + delaiPireCas(s.attente.snr);
              s.attente.id = ++seq;
              planifier({ t: s.attente.t, type: 'tx', num, id: s.attente.id });
            }
          }
          continue;
        }
        // Première réception
        s.recu = true; s.t = t; s.de = rec.de; s.hop = rec.hop;
        s.sauts = (etat.get(rec.de).sauts ?? 0) + 1;
        journal.push({ t, type: 'recu', num, de: rec.de, hop: rec.hop, snr: rec.snr });
        if (!relaieDe.get(num)) continue;
        if (mc) {
          // Répéteur MeshCore : ajoute son empreinte au chemin et réémet si flood.max le permet
          if (rec.hop + 1 > H) continue;
          const id = ++seq;
          s.attente = { t: t + tirer(Math.floor(5 * airtime * txDelayFactor) + 1), hop: rec.hop + 1, snr: rec.snr, tardif: false, id };
          planifier({ t: s.attente.t, type: 'tx', num, id });
          continue;
        }
        if (rec.hop <= 0) continue;
        // Saut gratuit : relais favori (ROUTER, ROUTER_LATE, CLIENT_BASE) reçu d'un relais favori, pas au premier saut
        let hop = rec.hop - 1;
        const premierSaut = rec.de === E;
        if (!premierSaut && ROLES_ROUTEURS.includes(role) && ROLES_ROUTEURS.includes(roleDe.get(rec.de)) && favoris.get(num).has(rec.de)) { hop = rec.hop; stats.sautsGratuits++; }
        const id = ++seq;
        s.attente = { t: t + delaiPondere(num, rec.snr), hop, snr: rec.snr, tardif: false, id };
        planifier({ t: s.attente.t, type: 'tx', num, id });
      } else if (ev.type === 'retx') {
        if (entenduRelais || retx >= RETX_MAX) continue;
        retx++;
        stats.retransmissions++;
        const id = ++seq;
        se.attente = { t: t + tirer(2 ** cwCanal(E)) * slot, hop: H, snr: null, tardif: false, origine: true, id };
        planifier({ t: se.attente.t, type: 'tx', num: E, id });
        planifier({ t: se.attente.t + 2 * airtime + (2 ** CW_MIN + 2 * CW_MAX + 2 ** 5) * slot + PROCESSING_TIME_MS, type: 'retx' });
      }
    }
    const atteints = [...etat.entries()].filter(([num, s]) => s.recu && num !== E);
    return {
      journal, stats, airtime, slot, fin,
      noeuds: Object.fromEntries([...etat.entries()].map(([num, s]) => [num, { recu: s.recu, t: s.t, sauts: s.sauts, hop: s.hop, de: s.de ?? null, emissions: s.emissions, doublons: s.doublons, pertes: s.collisions, annule: s.annule }])),
      atteints: atteints.length, total: reseau.noeuds.length - 1,
    };
  }

  // Plusieurs tirages : probabilité d'être atteint par nœud, moyennes globales
  function monteCarlo(reseau, opts, n = 100) {
    const prep = preparer(reseau, opts);
    const parNoeud = new Map(reseau.noeuds.map((x) => [x.num, { atteint: 0, t: 0, sauts: 0 }]));
    const somme = { atteints: 0, emissions: 0, collisions: 0, doublons: 0, annulations: 0, retransmissions: 0, sautsGratuits: 0, tempsAntenne: 0, fin: 0 };
    for (let k = 0; k < n; k++) {
      const r = simuler(reseau, { ...opts, graine: (opts.graine || 1) * 7919 + k }, prep);
      somme.atteints += r.atteints; somme.fin += r.fin;
      for (const c of ['emissions', 'collisions', 'doublons', 'annulations', 'retransmissions', 'sautsGratuits', 'tempsAntenne']) somme[c] += r.stats[c];
      for (const [num, x] of Object.entries(r.noeuds)) if (x.recu && Number(num) !== opts.emetteur) { const p = parNoeud.get(Number(num)); p.atteint++; p.t += x.t; p.sauts += x.sauts; }
    }
    const moy = Object.fromEntries(Object.entries(somme).map(([k, v]) => [k, v / n]));
    return {
      tirages: n, total: reseau.noeuds.length - 1, airtime: prep.airtime, slot: prep.slot, moyenne: moy,
      noeuds: Object.fromEntries([...parNoeud.entries()].map(([num, p]) => [num, { proba: p.atteint / n, t: p.atteint ? p.t / p.atteint : null, sauts: p.atteint ? p.sauts / p.atteint : null }])),
    };
  }

  return { PRESETS, SNR_LIMITE, tempsEmissionMs, slotMs, preparer, simuler, monteCarlo };
});
