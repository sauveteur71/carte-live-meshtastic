'use strict';
// Mode urgence : la carte passe en configuration de crise, activée et terminée à la main par un administrateur
// (les gestionnaires lisent le tableau de crise et ajoutent des notes au journal). Inspiré du « mode urgence » de l'application MeshWave (qui débloque toutes ses fonctions quand
// une catastrophe survient), adapté à une carte de supervision :
// - bandeau visible pour tous les comptes connectés, affichage simplifié et contrasté côté navigateur ;
// - outils de crise remis en service s'ils étaient masqués (signalements, main courante) ;
// - état du réseau rafraîchi plus souvent (10 s au lieu de 30 s) ;
// - journal horodaté de la crise (déclenchement, demandes d'aide, sorties de secteur, alertes critiques, notes),
//   exportable en CSV, gardé avec les 10 crises précédentes dans urgence.json.
// Aucun réglage radio n'est changé et aucun paquet LoRa n'est émis par ce module.

const path = require('path');
const crypto = require('crypto');
const { ecrireSur, lireJson } = require('./fichiers');

const EVENEMENTS_MAX = 5000;
const ARCHIVES_MAX = 10;

function creerUrgence({ config, journal = () => {}, diffuser = () => {}, maintenant = () => Date.now() }) {
  const fichier = path.join(path.dirname(config.fichierBase), 'urgence.json');
  let crise = null, archives = [];
  try { const d = lireJson(fichier); crise = d.crise || null; archives = d.archives || []; } catch { /* jamais activé */ }
  const vus = new Set((crise ? crise.evenements : []).map((e) => e.cle).filter(Boolean));

  let minuterie = null;
  function sauver(tout = false) {
    clearTimeout(minuterie);
    const ecrire = () => { try { ecrireSur(fichier, JSON.stringify({ crise, archives }), { mode: 0o600 }); } catch (e) { journal('[Urgence] enregistrement impossible :', e.message); } };
    if (tout) ecrire(); else { minuterie = setTimeout(ecrire, 1000); if (minuterie.unref) minuterie.unref(); }
  }
  const actif = () => !!crise;
  const resume = (c) => (c ? { id: c.id, debut: c.debut, fin: c.fin || null, auteur: c.auteur, finPar: c.finPar || null, motif: c.motif || '', nb: c.evenements.length } : null);
  function etat() { return { actif: actif(), ...(crise ? resume(crise) : {}) }; }

  // Événement du journal de crise. cle : évite de noter deux fois la même chose (alerte vue à chaque rafraîchissement)
  function noter({ cle, type = 'info', niveau = 'info', texte, noeud = null, lat = null, lon = null, auteur = null } = {}) {
    if (!crise || !texte) return null;
    if (cle) { if (vus.has(cle)) return null; vus.add(cle); }
    const e = { id: crypto.randomBytes(5).toString('hex'), heure: maintenant(), type, niveau, texte: String(texte).slice(0, 500), noeud, lat, lon, auteur, cle: cle || null };
    crise.evenements.push(e);
    if (crise.evenements.length > EVENEMENTS_MAX) crise.evenements.splice(0, crise.evenements.length - EVENEMENTS_MAX);
    sauver();
    diffuser({ genre: 'urgence-evt', evenement: e });
    return e;
  }
  function activer({ motif } = {}, auteur) {
    if (crise) throw new Error('Le mode urgence est déjà actif');
    const m = String(motif || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 140);
    crise = { id: crypto.randomBytes(5).toString('hex'), debut: maintenant(), auteur, motif: m, evenements: [] };
    vus.clear();
    noter({ type: 'debut', niveau: 'critique', texte: `Mode urgence activé par ${auteur}${m ? ' : ' + m : ''}`, auteur });
    sauver(true);
    journal(`[Urgence] mode urgence activé par ${auteur}${m ? ' (' + m + ')' : ''}`);
    diffuser({ genre: 'urgence', ...etat() });
    return etat();
  }
  function desactiver(auteur) {
    if (!crise) throw new Error('Le mode urgence n’est pas actif');
    noter({ type: 'fin', niveau: 'info', texte: `Mode urgence terminé par ${auteur}`, auteur });
    crise.fin = maintenant(); crise.finPar = auteur;
    archives.unshift(crise);
    archives = archives.slice(0, ARCHIVES_MAX);
    const fini = resume(crise);
    crise = null; vus.clear();
    sauver(true);
    journal(`[Urgence] mode urgence terminé par ${auteur} (${fini.nb} événement(s) au journal)`);
    diffuser({ genre: 'urgence', actif: false, derniere: fini });
    return { actif: false, derniere: fini };
  }
  function note(texte, auteur) {
    if (!crise) throw new Error('Le mode urgence n’est pas actif');
    const t = String(texte || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim();
    if (!t) throw new Error('Note vide');
    return noter({ type: 'note', niveau: 'info', texte: t.slice(0, 500), auteur });
  }
  const trouverCrise = (id) => (!id || (crise && crise.id === id) ? crise : archives.find((c) => c.id === id)) || null;
  function evenements(id, limite = 200) {
    const c = trouverCrise(id);
    if (!c) return [];
    return c.evenements.slice(-Math.min(Math.max(Number(limite) || 200, 1), EVENEMENTS_MAX)).reverse();
  }
  function csv(id) {
    const c = trouverCrise(id) || archives[0];
    if (!c) throw new Error('Aucune crise enregistrée');
    const q = (v) => (v == null ? '' : /[";\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const local = (t) => new Date(t).toLocaleString('fr-FR', { timeZone: process.env.TZ || 'Europe/Paris' });
    const noeud = (n) => (n == null ? '' : typeof n === 'number' ? '!' + (n >>> 0).toString(16).padStart(8, '0') : String(n));
    return { nom: `crise-${new Date(c.debut).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`,
      texte: ['heure_utc;heure_locale;type;niveau;noeud;lat;lon;auteur;texte',
        ...c.evenements.map((e) => [new Date(e.heure).toISOString(), local(e.heure), e.type, e.niveau, noeud(e.noeud), e.lat, e.lon, e.auteur, e.texte].map(q).join(';'))].join('\n') };
  }
  return {
    actif, etat, activer, desactiver, noter, note, evenements, csv,
    archives: () => archives.map(resume),
    arreter: () => { clearTimeout(minuterie); sauver(true); },
  };
}

module.exports = { creerUrgence };
