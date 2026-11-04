'use strict';
// Nœuds suivis par chaque compte : favoris (étoile) et « mes nœuds » (ceux que l'on administre).
// Identifiant d'un nœud : numéro décimal (Meshtastic) ou clé publique de 64 caractères hexadécimaux (MeshCore),
// comme pour les secteurs des gestionnaires.
// « Mes nœuds » = nœuds ajoutés à la main + nœuds administrés d'office (secteur d'un gestionnaire ; pour un
// administrateur : nœuds Meshtastic qui acceptent le module de la carte et répéteurs MeshCore à mot de passe
// mémorisé), moins ceux retirés à la main.

const fs = require('fs');
const path = require('path');

const normaliser = (id) => {
  const x = String(id || '').trim();
  if (/^[0-9a-f]{64}$/i.test(x)) return x.toUpperCase();
  if (/^\d+$/.test(x)) return String(Number(x) >>> 0);
  if (/^!?[0-9a-f]{8}$/i.test(x)) return String(parseInt(x.replace('!', ''), 16) >>> 0);
  return null;
};

function creerSuivis(config, { autoAdministres }) {
  const fichier = path.join(path.dirname(config.fichierBase), 'suivis.json');
  let memo = {};
  try { memo = JSON.parse(fs.readFileSync(fichier, 'utf8')) || {}; } catch { /* aucun */ }
  const sauver = () => { try { fs.writeFileSync(fichier, JSON.stringify(memo)); } catch { /* lecture seule */ } };
  const de = (u) => { const k = String(u.identifiant); if (!memo[k]) memo[k] = { favoris: [], administres: [], exclus: [] }; return memo[k]; };

  function lire(u) {
    const m = memo[String(u.identifiant)] || { favoris: [], administres: [], exclus: [] };
    let auto = [];
    try { auto = (autoAdministres(u) || []).map(normaliser).filter(Boolean); } catch { /* ignoré */ }
    const exclus = new Set(m.exclus || []);
    const administres = [...new Set([...(m.administres || []), ...auto])].filter((k) => !exclus.has(k));
    return { favoris: m.favoris || [], administres, auto: [...new Set(auto)], manuels: m.administres || [], exclus: [...exclus] };
  }

  function regler(u, idBrut, liste, valeur) {
    const id = normaliser(idBrut);
    if (!id) throw new Error('nœud invalide');
    if (!['favoris', 'administres'].includes(liste)) throw new Error('liste inconnue');
    const m = de(u);
    const ote = (l) => l.filter((x) => x !== id);
    if (liste === 'favoris') {
      m.favoris = ote(m.favoris);
      if (valeur) m.favoris.unshift(id);
      m.favoris = m.favoris.slice(0, 500);
    } else {
      m.administres = ote(m.administres); m.exclus = ote(m.exclus);
      const estAuto = lire(u).auto.includes(id);
      if (valeur && !estAuto) m.administres.unshift(id);
      if (!valeur && estAuto) m.exclus.push(id); // retiré à la main : il ne revient plus d'office
      m.administres = m.administres.slice(0, 500); m.exclus = m.exclus.slice(0, 1000);
    }
    sauver();
    return lire(u);
  }

  return { lire, regler, normaliser };
}

module.exports = { creerSuivis };
