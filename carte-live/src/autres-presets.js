'use strict';
// Nœuds Meshtastic d'un autre preset que le réseau (ex. LongFast autour d'un réseau en LongModerate) : ils n'entendent
// pas le réseau et le réseau ne les entend pas. On les repère pour pouvoir les inviter à rejoindre le fonctionnement local.
// - preset exact : rapport de carte Meshtastic (déjà enregistré dans la fiche du nœud) ;
// - preset déduit : paquet arrivé par MQTT sur un canal au nom par défaut d'un preset (« LongFast », « MediumFast »…),
//   donc entendu par une passerelle réglée sur ce preset ;
// - module « sentinelle » : module en écoute réglé sur l'autre preset, qui entend ces nœuds par radio et peut leur
//   envoyer un message direct d'invitation (seul envoi permis à un module en écoute, à la demande d'un administrateur).

// Nom par défaut du canal primaire selon le preset (firmware Meshtastic)
const PRESET_PAR_NOM = {
  LongFast: 'LONG_FAST', LongSlow: 'LONG_SLOW', VLongSlow: 'VERY_LONG_SLOW', MediumSlow: 'MEDIUM_SLOW', MediumFast: 'MEDIUM_FAST',
  ShortSlow: 'SHORT_SLOW', ShortFast: 'SHORT_FAST', LongMod: 'LONG_MODERATE', ShortTurbo: 'SHORT_TURBO', LongTurbo: 'LONG_TURBO',
  MediumTurbo: 'MEDIUM_TURBO', LiteFast: 'LITE_FAST', LiteSlow: 'LITE_SLOW', NarrowFast: 'NARROW_FAST', NarrowSlow: 'NARROW_SLOW',
  TinyFast: 'TINY_FAST', TinySlow: 'TINY_SLOW',
};

function creerAutresPresets(db, journal) {
  const majPreset = db.prepare('UPDATE noeuds SET preset = ? WHERE num = ? AND (preset IS NULL OR preset = \'\')');
  const deduits = new Map(); // num -> { preset, canal, heure }

  // Paquet décodé (MQTT ou réseau local) : preset déduit du nom du canal par défaut, si la fiche n'en a pas
  function noterPaquet(evt) {
    if (!evt || evt.genre !== 'paquet' || evt.viaMqtt || !evt.canalTopic) return;
    const preset = PRESET_PAR_NOM[evt.canalTopic];
    if (!preset) return;
    const num = evt.de >>> 0;
    const d = deduits.get(num);
    if (!d || d.preset !== preset) {
      try { majPreset.run(preset, num); } catch { /* nœud pas encore enregistré */ }
    }
    deduits.set(num, { preset, canal: evt.canalTopic, heure: Date.now() });
    if (deduits.size > 20000) deduits.delete(deduits.keys().next().value);
  }

  // Nœuds dont le preset connu diffère de celui du réseau, vus depuis « jours » jours
  function liste(presetReseau, { jours = 30 } = {}) {
    const depuis = Date.now() - jours * 86400000;
    const lignes = db.prepare('SELECT num, id, nom_long, nom_court, materiel, role, firmware, preset, lat, lon, dernier_vu FROM noeuds WHERE preset IS NOT NULL AND preset != \'\' AND preset != ? AND dernier_vu >= ? ORDER BY dernier_vu DESC LIMIT 500').all(presetReseau, depuis);
    return lignes.map((n) => {
      const d = deduits.get(n.num);
      return { ...n, presetDeduit: !!(d && d.preset === n.preset), canalVu: d ? d.canal : null };
    });
  }

  return { noterPaquet, liste, PRESET_PAR_NOM };
}

module.exports = { creerAutresPresets, PRESET_PAR_NOM };
