'use strict';
// Sites routiers (webcams et stations du Département de la Haute-Loire et de la DIR Massif Central) d'après la carte
// publique inforoute43.fr. Ces sites ont souvent un mât, l'électricité et parfois une liaison réseau :
// des emplacements intéressants à proposer pour des relais. Cache d'une semaine dans /data/sites-routiers.json.

const fs = require('fs');
const path = require('path');

const SOURCE = 'https://www.inforoute43.fr/mod_turbolead/mod/inforoute/index.php?action=383';

function creerSitesRoutiers(config, journal) {
  const fichier = path.join(path.dirname(config.fichierBase), 'sites-routiers.json');
  let donnees = null;
  try { donnees = JSON.parse(fs.readFileSync(fichier, 'utf8')); } catch { /* absent */ }

  async function charger() {
    if (donnees && Date.now() - donnees.date < 7 * 86400000) return donnees;
    try {
      const r = await fetch(SOURCE, { headers: { 'User-Agent': 'Mozilla/5.0 (carte-live-meshtastic)' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      // On ne garde que le nom, la position et le gestionnaire (rien des autres champs techniques)
      const sites = (j.features || []).filter((f) => f.geometry && f.geometry.type === 'Point').map((f) => {
        const p = f.properties || {};
        const titre = String(p.titre || '').trim();
        const dir = /inforoute-massif-central/.test(p.url_dossier || p.url_script || '');
        const m = /alt(?:itude)?\.?\s*(\d{3,4})\s*m/i.exec(titre);
        return {
          id: (dir ? 'dir-' : 'dep-') + p.id_webcam, nom: titre.replace(/\s*\(Département de la Haute-Loire\)\s*/i, ' ').replace(/\s*(alt(itude)?\.?\s*\d{3,4}\s*m)\s*$/i, '').replace(/\s+/g, ' ').trim(),
          gestionnaire: dir ? 'DIR Massif Central' : /Département de la Haute-Loire/i.test(titre) ? 'Département de la Haute-Loire' : 'autre',
          lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], altitude: m ? Number(m[1]) : null,
          type: p.type_media === 'VIDEO' ? 'caméra vidéo' : 'webcam',
          lien: dir ? 'https://www.inforoute-massif-central.fr/' : 'https://www.inforoute43.fr/',
        };
      });
      donnees = { date: Date.now(), source: 'inforoute43.fr', sites };
      try { fs.writeFileSync(fichier, JSON.stringify(donnees)); } catch { /* lecture seule */ }
      journal(`[Sites routiers] ${sites.length} sites chargés (inforoute43.fr)`);
    } catch (e) { journal('[Sites routiers] chargement impossible :', e.message); }
    return donnees || { date: null, sites: [] };
  }
  return { charger };
}

module.exports = { creerSitesRoutiers };
