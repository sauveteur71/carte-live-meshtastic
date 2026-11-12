'use strict';
// Alertes officielles affichées sur la carte et, si l'administrateur le veut, diffusées sur des canaux LoRa :
//  - vigilance météo et crues de Météo-France, par département (flux public MeteoAlarm, sans clé, toutes les 10 min) ;
//  - niveau Vigipirate, réglé à la main (aucun flux officiel lisible par un programme) ;
//  - alertes FR-Alert relayées à la main (FR-Alert passe par les antennes des téléphones, sans flux public fiable).
const fs = require('fs');
const { ecrireSur, lireJson } = require('./fichiers');
const path = require('path');

const URL_METEOALARM = process.env.METEOALARM_URL || 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-france';
const COULEURS = { Yellow: 'jaune', Orange: 'orange', Red: 'rouge' };
const RANG = { jaune: 1, orange: 2, rouge: 3 };
const ICONE = { jaune: '🟡', orange: '🟠', rouge: '🔴' };
const PHENOMENES = {
  wind: 'vent violent', 'snow-ice': 'neige-verglas', thunderstorm: 'orages', fog: 'brouillard', 'high-temperature': 'canicule',
  'low-temperature': 'grand froid', coastalevent: 'vagues-submersion', 'forest-fire': 'feux de forêt', avalanches: 'avalanches',
  rain: 'pluie', flooding: 'crues', 'rain-flood': 'pluie-inondation',
};
const NIVEAUX_VIGIPIRATE = {
  vigilance: { nom: 'Vigilance', icone: '🛡️' },
  renforcee: { nom: 'Sécurité renforcée – risque attentat', icone: '🛡️' },
  urgence: { nom: 'Urgence attentat', icone: '🚨' },
};
const sansAccent = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const balise = (bloc, nom) => { const m = new RegExp(`<${nom}[^>]*>([\\s\\S]*?)</${nom}>`).exec(bloc); return m ? m[1].trim() : ''; };

function creerAlertesOfficielles({ config, journal, departementsSuivis, envoyer, envoyerMc = null, diffuser }) {
  const fichier = path.join(path.dirname(config.fichierBase), 'alertes-officielles.json');
  let d = {};
  try { d = lireJson(fichier); } catch { /* premier démarrage */ }
  const etat = {
    // Diffusion LoRa : désactivée par défaut ; canaux Meshtastic par nom ; niveau de vigilance minimal diffusé
    // departements : codes suivis (vide = celui de la carte) ; canalMc : canal MeshCore (vide = pas d'envoi MeshCore)
    reglages: { diffuser: false, canaux: ['Alerte'], canalMc: '', niveauMin: 'orange', departements: [], ...(d.reglages || {}) },
    vigipirate: d.vigipirate || null, // { niveau, depuis, par }
    frAlert: d.frAlert || [], // [{ id, texte, zone, date, par, envois }]
    meteo: [], // vigilances en cours pour les départements suivis
    dejaDiffuse: d.dejaDiffuse || {}, // clé (département|phénomène|couleur|fin) → date
    maj: null, erreur: null,
  };
  const sauver = () => { try { ecrireSur(fichier, JSON.stringify({ reglages: etat.reglages, vigipirate: etat.vigipirate, frAlert: etat.frAlert.slice(0, 50), dejaDiffuse: etat.dejaDiffuse })); } catch (e) { journal('[Alertes] sauvegarde :', e.message); } };

  async function diffuserTexte(texte) {
    const envois = [];
    for (const [k, canal] of etat.reglages.canaux.entries()) {
      if (k) await new Promise((r) => setTimeout(r, 600));
      try { await envoyer(canal, texte); envois.push({ canal, statut: 'envoye' }); } catch (e) { envois.push({ canal, statut: 'echec', erreur: e.message }); }
    }
    if (etat.reglages.canalMc && envoyerMc) {
      try { await envoyerMc(etat.reglages.canalMc, texte); envois.push({ canal: 'MeshCore ' + etat.reglages.canalMc, statut: 'envoye' }); } catch (e) { envois.push({ canal: 'MeshCore ' + etat.reglages.canalMc, statut: 'echec', erreur: e.message }); }
    }
    return envois;
  }

  async function lireMeteo() {
    try {
      const r = await fetch(URL_METEOALARM, { headers: { 'User-Agent': 'carte-live-meshtastic' }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const xml = await r.text();
      const suivis = departementsSuivis(etat.reglages.departements);
      const parNom = new Map(suivis.map((x) => [sansAccent(x.nom), x]));
      const maintenant = Date.now();
      const liste = [];
      for (const e of xml.split('<entry>').slice(1)) {
        const dep = parNom.get(sansAccent(balise(e, 'cap:areaDesc')));
        if (!dep) continue;
        const titre = balise(e, 'title');
        const couleur = COULEURS[(/^(Yellow|Orange|Red)/.exec(titre) || [])[1]];
        if (!couleur) continue;
        const ev = balise(e, 'cap:event').toLowerCase();
        const cle = Object.keys(PHENOMENES).sort((a, b) => b.length - a.length).find((k) => ev.includes(k));
        const debut = Date.parse(balise(e, 'cap:onset') || balise(e, 'cap:effective')) || null;
        const fin = Date.parse(balise(e, 'cap:expires')) || null;
        if (fin && fin < maintenant) continue;
        if (balise(e, 'cap:status') !== 'Actual') continue;
        liste.push({ dep: dep.code, depNom: dep.nom, couleur, phenomene: PHENOMENES[cle] || ev.replace(/ warning$/, ''), debut, fin });
      }
      // Une ligne par département et phénomène : la couleur la plus forte
      const garde = new Map();
      for (const a of liste) { const k = a.dep + '|' + a.phenomene; const g = garde.get(k); if (!g || RANG[a.couleur] > RANG[g.couleur] || (RANG[a.couleur] === RANG[g.couleur] && (a.debut || 0) < (g.debut || 0))) garde.set(k, a); }
      etat.meteo = [...garde.values()].sort((a, b) => RANG[b.couleur] - RANG[a.couleur] || a.dep.localeCompare(b.dep));
      etat.maj = maintenant; etat.erreur = null;
      // Diffusion des nouvelles vigilances au niveau choisi (une seule fois par vigilance)
      if (etat.reglages.diffuser) {
        for (const a of etat.meteo) {
          if (RANG[a.couleur] < RANG[etat.reglages.niveauMin]) continue;
          const k = `${a.dep}|${a.phenomene}|${a.couleur}|${a.fin}`;
          if (etat.dejaDiffuse[k]) continue;
          etat.dejaDiffuse[k] = maintenant;
          const h = (t) => new Date(t).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          const texte = `${ICONE[a.couleur]} Vigilance ${a.couleur} ${a.phenomene} · ${a.depNom}${a.debut ? ' · du ' + h(a.debut) : ''}${a.fin ? ' au ' + h(a.fin) : ''} (Météo-France)`;
          a.envois = await diffuserTexte(texte);
          journal(`[Alertes] diffusé : ${texte}`);
        }
        for (const [k, t] of Object.entries(etat.dejaDiffuse)) if (maintenant - t > 7 * 86400000) delete etat.dejaDiffuse[k];
        sauver();
      }
      diffuser({ genre: 'alertes-officielles' });
    } catch (e) {
      etat.erreur = e.message;
      journal('[Alertes] vigilance Météo-France indisponible :', e.message);
    }
  }
  setTimeout(lireMeteo, 20000).unref();
  setInterval(lireMeteo, 10 * 60000).unref();

  return {
    NIVEAUX_VIGIPIRATE,
    etat: () => ({ meteo: etat.meteo, vigipirate: etat.vigipirate && { ...etat.vigipirate, ...NIVEAUX_VIGIPIRATE[etat.vigipirate.niveau] }, frAlert: etat.frAlert.filter((x) => !x.fin && Date.now() - x.date < 3 * 86400000), reglages: etat.reglages, maj: etat.maj, erreur: etat.erreur }),
    regler(r) {
      if (typeof r.diffuser === 'boolean') etat.reglages.diffuser = r.diffuser;
      if (Array.isArray(r.departements)) etat.reglages.departements = [...new Set(r.departements.map((c) => String(c).trim().toUpperCase()).filter((c) => /^(\d{2,3}|2A|2B)$/.test(c)))].slice(0, 30);
      if (r.canalMc !== undefined) etat.reglages.canalMc = String(r.canalMc || '').trim().slice(0, 32);
      if (RANG[r.niveauMin]) etat.reglages.niveauMin = r.niveauMin;
      if (Array.isArray(r.canaux)) etat.reglages.canaux = r.canaux.map((c) => String(c).trim().slice(0, 12)).filter(Boolean).slice(0, 4);
      sauver();
      lireMeteo();
      return etat.reglages;
    },
    async vigipirate(niveau, par, annoncer) {
      if (niveau && !NIVEAUX_VIGIPIRATE[niveau]) throw new Error('Niveau Vigipirate inconnu');
      etat.vigipirate = niveau ? { niveau, depuis: Date.now(), par } : null;
      let envois = [];
      if (niveau && annoncer) envois = await diffuserTexte(`${NIVEAUX_VIGIPIRATE[niveau].icone} Vigipirate : ${NIVEAUX_VIGIPIRATE[niveau].nom}`);
      sauver(); diffuser({ genre: 'alertes-officielles' });
      return { vigipirate: etat.vigipirate, envois };
    },
    // Relais d'une alerte FR-Alert reçue sur un téléphone : texte recopié, diffusé sur les canaux choisis
    async frAlert({ texte, zone }, par) {
      texte = String(texte || '').replace(/\s+/g, ' ').trim();
      if (!texte) throw new Error('Texte de l’alerte vide');
      const a = { id: Date.now().toString(36), texte: texte.slice(0, 500), zone: String(zone || '').trim().slice(0, 80), date: Date.now(), par };
      a.envois = await diffuserTexte(`📢 FR-Alert${a.zone ? ' ' + a.zone : ''} : ${a.texte}`.slice(0, 600));
      etat.frAlert.unshift(a);
      sauver(); diffuser({ genre: 'alertes-officielles' });
      return a;
    },
    finFrAlert(id, par) {
      const a = etat.frAlert.find((x) => x.id === id);
      if (!a) throw new Error('Alerte inconnue');
      a.fin = Date.now(); a.finPar = par;
      sauver(); diffuser({ genre: 'alertes-officielles' });
      return a;
    },
    relire: lireMeteo,
  };
}
module.exports = { creerAlertesOfficielles };
