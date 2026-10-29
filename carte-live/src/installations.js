'use strict';
// Fiche d'installation des relais : antenne, hauteur, gain, câble, alimentation, site.
// Stockée dans /data/installations.json ; les valeurs techniques servent aux calculs de couverture.
const fs = require('fs');
const path = require('path');

const CHAMPS_TECHNIQUES = {
  hauteur: { min: 0.5, max: 120 }, // hauteur de l'antenne au-dessus du sol (m)
  gain: { min: -5, max: 15 }, // gain de l'antenne (dBi)
  pertesCable: { min: 0, max: 20 }, // pertes câble + connecteurs (dB)
  puissance: { min: 0, max: 30 }, // puissance d'émission (dBm)
  batterieAh: { min: 0, max: 1000 },
  panneauW: { min: 0, max: 2000 },
};
const CHAMPS_TEXTE = { antenne: 80, alimentation: 20, site: 120, proprietaire: 120, contact: 160, miseEnService: 10, notes: 1000, aFaire: 500 };
const ALIMENTATIONS = ['secteur', 'solaire', 'batterie', 'secteur+batterie', 'solaire+batterie', 'autre'];
const PRIVES = ['proprietaire', 'contact'];

function creerInstallations(dossier) {
  const fichier = path.join(dossier, 'installations.json');
  let donnees = {};
  try { donnees = JSON.parse(fs.readFileSync(fichier, 'utf8')); } catch { /* vide */ }
  const sauver = () => { try { fs.writeFileSync(fichier, JSON.stringify(donnees, null, 1)); } catch { /* disque plein */ } };

  function nettoyer(entree) {
    const r = {};
    for (const [k, { min, max }] of Object.entries(CHAMPS_TECHNIQUES)) {
      const v = entree[k];
      if (v === '' || v == null) continue;
      const n = Number(String(v).replace(',', '.'));
      if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Valeur invalide pour ${k} (${min} à ${max})`);
      r[k] = Math.round(n * 10) / 10;
    }
    for (const [k, lg] of Object.entries(CHAMPS_TEXTE)) {
      const v = entree[k];
      if (v == null || String(v).trim() === '') continue;
      r[k] = String(v).trim().slice(0, lg);
    }
    if (r.alimentation && !ALIMENTATIONS.includes(r.alimentation)) throw new Error('Alimentation inconnue');
    if (r.miseEnService && !/^\d{4}-\d{2}-\d{2}$/.test(r.miseEnService)) throw new Error('Date de mise en service invalide (AAAA-MM-JJ)');
    return r;
  }

  return {
    ALIMENTATIONS,
    lire(num, admin) {
      const f = donnees[String(num)];
      if (!f) return null;
      if (admin) return f;
      const { proprietaire, contact, ...publique } = f;
      return publique;
    },
    // Mise à jour de quelques champs seulement (ex. « à faire sur place »), le reste de la fiche est gardé
    completer(num, champs, auteur) {
      const actuel = { ...(donnees[String(num)] || {}) };
      delete actuel.maj; delete actuel.par;
      for (const [k, v] of Object.entries(champs || {})) { if (v == null || String(v).trim() === '') delete actuel[k]; else actuel[k] = v; }
      return this.ecrire(num, actuel, auteur);
    },
    ecrire(num, entree, auteur) {
      const r = nettoyer(entree || {});
      if (!Object.keys(r).length) delete donnees[String(num)];
      else donnees[String(num)] = { ...r, maj: Date.now(), par: auteur || null };
      sauver();
      return donnees[String(num)] || null;
    },
    // Valeurs utiles aux calculs radio
    radio(num) {
      const f = donnees[String(num)];
      if (!f) return {};
      return { h: f.hauteur, gain: f.gain, pertes: f.pertesCable, ptx: f.puissance };
    },
    toutes: () => donnees,
    // Nœud renuméroté : la fiche passe au nouveau numéro (si celui-ci n'en a pas déjà une)
    deplacer(ancien, nouveau) {
      const a = String(ancien >>> 0), n = String(nouveau >>> 0);
      if (!donnees[a] || donnees[n]) return false;
      donnees[n] = donnees[a]; delete donnees[a]; sauver();
      return true;
    },
    PRIVES,
  };
}

module.exports = { creerInstallations };
