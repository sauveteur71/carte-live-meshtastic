'use strict';
// Relief grossier du monde entier : NOAA ETOPO1 (1′, domaine public) pris un point sur cinq, soit une grille de
// 5′ d'arc (≈ 9 km) : 2161 × 4320 altitudes en Int16, 18,7 Mo sur le disque. Il sert le temps que le relief précis
// (250 m) d'une zone se télécharge : la couverture s'affiche tout de suite, marquée « approximative », puis le relief
// précis la remplace. Jamais chargé en entier en mémoire : seules les lignes utiles sont lues sur le disque.
//
// Source : service ERDDAP de la NOAA (griddap, jeu « etopo180 »), en bandes de 10° de latitude au format ESRI ASCII
// (≈ 1 Mo compressé chacune). Le téléchargement reprend à la bande suivante après une coupure ou un redémarrage.
// Océans et terres sous le niveau de la mer : 0 m (comme le relief précis).
const fs = require('fs');
const path = require('path');
const { ecrireSur, lireJson } = require('./fichiers');

// Miroirs ERDDAP du même jeu (NOAA CoastWatch, NOAA AOML, Marine Institute irlandais), essayés dans l'ordre
const SERVEURS = ['https://coastwatch.pfeg.noaa.gov/erddap', 'https://cwcgom.aoml.noaa.gov/erddap', 'https://erddap.marine.ie/erddap'];
const MINUTES_PERMISES = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];
const SOURCE = 'NOAA ETOPO1 (ERDDAP etopo180)';
const ceder = () => new Promise((r) => setImmediate(r));

function creerReliefGrossier({ dossier, journal = () => {}, minutes = 5, serveurs = null, recuperer = null, degreParBande = 10 } = {}) {
  if (!MINUTES_PERMISES.includes(minutes)) minutes = 5;
  const liste = serveurs || (process.env.RELIEF_MONDE_ERDDAP ? process.env.RELIEF_MONDE_ERDDAP.split(',').map((x) => x.trim()).filter(Boolean) : SERVEURS);
  const pas = minutes / 60;
  const NLAT = Math.round(180 / pas) + 1, NLON = Math.round(360 / pas); // ligne 0 = 90° S, colonne 0 = 180° O
  const TAILLE = NLAT * NLON * 2;
  const lignesParBande = Math.max(1, Math.round(degreParBande / pas));
  const nBandes = Math.ceil(NLAT / lignesParBande);
  const nom = `relief-monde-${minutes}m`;
  const fBin = path.join(dossier, nom + '.bin'), fInfo = path.join(dossier, nom + '.json');
  const fPart = fBin + '.part', fReprise = path.join(dossier, nom + '.reprise.json');
  const etat = { statut: 'absent', progression: 0, erreur: null, date: null, source: SOURCE, minutes, resolutionKm: +(minutes * 1.852).toFixed(1), octets: 0 };
  const abonnes = new Set();
  let promesse = null, arret = false;

  function verifierFichier() {
    try {
      const info = lireJson(fInfo);
      const st = fs.statSync(fBin);
      if (info.nLat === NLAT && info.nLon === NLON && st.size === TAILLE) {
        Object.assign(etat, { statut: 'pret', progression: 100, erreur: null, date: info.date || st.mtimeMs, octets: st.size });
        return true;
      }
    } catch { /* absent ou incomplet */ }
    return false;
  }
  verifierFichier();

  // ---- Téléchargement d'une bande (lignes r0 à r1) ---------------------------------------------------------
  const url = (srv, r0, r1) => {
    const c = `altitude[(${(-90 + r0 * pas).toFixed(6)}):${minutes}:(${(-90 + r1 * pas).toFixed(6)})][(-180):${minutes}:(${(-180 + (NLON - 1) * pas).toFixed(6)})]`;
    return `${srv.replace(/\/$/, '')}/griddap/etopo180.esriAscii?${encodeURIComponent(c)}`;
  };
  // Lecture en flux du format ESRI ASCII (en-tête de 6 lignes, puis lignes du nord vers le sud), écriture directe
  // de chaque ligne à sa place dans le fichier : rien n'est gardé en mémoire au-delà d'une ligne.
  async function lireBande(srv, r0, r1, fd) {
    const f = recuperer || globalThis.fetch;
    const rep = await f(url(srv, r0, r1), { headers: { 'Accept-Encoding': 'gzip' }, signal: AbortSignal.timeout(180000) });
    if (!rep.ok) throw new Error('HTTP ' + rep.status);
    const attendu = r1 - r0 + 1;
    const entete = {};
    let reste = '', enTete = true, ligne = 0, col = 0, nodata = null, haut = null;
    const tampon = Buffer.alloc(NLON * 2);
    const decodeur = new TextDecoder();
    const traiterJeton = (t) => {
      if (ligne >= attendu) throw new Error('trop de lignes');
      let v = Number(t);
      if (!Number.isFinite(v) || v === nodata || v < 0) v = 0;
      tampon.writeInt16LE(Math.min(9000, Math.round(v)), col * 2);
      if (++col === NLON) {
        fs.writeSync(fd, tampon, 0, tampon.length, (haut - ligne) * NLON * 2);
        col = 0; ligne++;
      }
    };
    const finEntete = () => {
      const nc = Number(entete.ncols), nr = Number(entete.nrows), cs = Number(entete.cellsize);
      const y = entete.yllcenter != null ? Number(entete.yllcenter) : Number(entete.yllcorner) + cs / 2;
      const x = entete.xllcenter != null ? Number(entete.xllcenter) : Number(entete.xllcorner) + cs / 2;
      if (nc !== NLON || nr !== attendu || !(Math.abs(cs - pas) < 1e-6) || !(Math.abs(y - (-90 + r0 * pas)) < pas / 2) || !(Math.abs(x + 180) < pas / 2)) {
        throw new Error(`réponse inattendue (${nc} × ${nr}, pas ${cs})`);
      }
      nodata = entete.nodata_value != null ? Number(entete.nodata_value) : null;
      haut = r1; // première ligne reçue = la plus au nord
      enTete = false;
    };
    const lecteur = rep.body.getReader();
    for (;;) {
      if (arret) { try { await lecteur.cancel(); } catch { /* déjà fermé */ } throw new Error('téléchargement arrêté'); }
      const { done, value } = await lecteur.read();
      reste += done ? decodeur.decode() : decodeur.decode(value, { stream: true });
      let morceaux;
      if (enTete) {
        let k;
        while (enTete && (k = reste.indexOf('\n')) >= 0) {
          const l = reste.slice(0, k).trim();
          reste = reste.slice(k + 1);
          if (!l) continue;
          const m = /^([a-z_]+)\s+(\S+)$/i.exec(l);
          if (!m) throw new Error('en-tête illisible');
          entete[m[1].toLowerCase()] = m[2];
          if (Object.keys(entete).length >= 6) finEntete();
        }
        if (enTete) { if (done) throw new Error('réponse tronquée'); continue; }
      }
      morceaux = reste.split(/\s+/);
      reste = done ? '' : morceaux.pop(); // dernier jeton peut-être coupé
      for (const t of morceaux) if (t) traiterJeton(t);
      if (done) break;
    }
    if (ligne !== attendu) throw new Error(`réponse tronquée (${ligne}/${attendu} lignes)`);
  }

  async function telechargerTout() {
    etat.statut = 'chargement'; etat.erreur = null;
    let fd = null;
    try {
      let reprise = { minutes, bandes: [] };
      try { const r = lireJson(fReprise); if (r.minutes === minutes && Array.isArray(r.bandes) && fs.existsSync(fPart)) reprise = r; } catch { /* nouveau départ */ }
      fd = fs.openSync(fPart, fs.existsSync(fPart) ? 'r+' : 'w+');
      if (fs.fstatSync(fd).size !== TAILLE) { fs.ftruncateSync(fd, TAILLE); reprise.bandes = []; }
      const faites = new Set(reprise.bandes);
      if (faites.size) journal(`[Relief] relief mondial : reprise du téléchargement (${faites.size}/${nBandes} bandes déjà là)`);
      else journal(`[Relief] relief mondial : téléchargement de ${SOURCE} à ${minutes}′ (${NLAT} × ${NLON} points, ${Math.round(TAILLE / 1048576)} Mo)`);
      for (let b = 0; b < nBandes; b++) {
        if (faites.has(b)) continue;
        const r0 = b * lignesParBande, r1 = Math.min(NLAT - 1, r0 + lignesParBande - 1);
        let ok = false, derniere = null;
        for (let essai = 0; essai < 3 && !ok; essai++) {
          for (const srv of liste) {
            if (arret) throw new Error('téléchargement arrêté');
            try { await lireBande(srv, r0, r1, fd); ok = true; break; } catch (e) { derniere = e; if (/arrêté/.test(e.message)) throw e; }
          }
          if (!ok) await new Promise((r) => setTimeout(r, 5000 * (essai + 1)).unref());
        }
        if (!ok) throw new Error(`serveurs ERDDAP indisponibles (${derniere ? derniere.message : '?'})`);
        faites.add(b);
        try { fs.fsyncSync(fd); } catch { /* système sans fsync */ }
        ecrireSur(fReprise, JSON.stringify({ minutes, bandes: [...faites] }));
        etat.progression = Math.round((faites.size / nBandes) * 100);
        await ceder();
      }
      fs.closeSync(fd); fd = null;
      // Fichier d'info écrit AVANT le renommage final : un arrêt entre les deux laissait un .bin complet sans son
      // .json (relief jugé absent et retéléchargé)
      ecrireSur(fInfo, JSON.stringify({ nLat: NLAT, nLon: NLON, minutes, source: SOURCE, date: Date.now(), sud: -90, ouest: -180, ordre: 'ligne 0 = sud, Int16 petit-boutiste' }));
      fs.renameSync(fPart, fBin);
      for (const f of [fReprise, fReprise + '.bak']) { try { fs.unlinkSync(f); } catch { /* déjà */ } }
      verifierFichier();
      journal(`[Relief] relief mondial prêt (${Math.round(TAILLE / 1048576)} Mo, ≈ ${etat.resolutionKm} km)`);
      for (const cb of abonnes) { try { cb(); } catch (e) { journal('[Relief] relief mondial :', e.message); } }
    } catch (e) {
      etat.statut = arret ? 'absent' : 'erreur';
      etat.erreur = e.message;
      journal(`[Relief] relief mondial : ${e.message} (le téléchargement reprendra plus tard)`);
    } finally {
      if (fd != null) { try { fs.closeSync(fd); } catch { /* déjà */ } }
    }
  }

  // Une seule fois à la fois ; rien à faire si le fichier est déjà là. Arrêt puis réactivation rapide (case décochée
  // puis recochée) : le téléchargement en cours s'arrête, et un nouveau est enchaîné aussitôt après, sans attendre
  // l'essai horaire.
  function telecharger() {
    if (etat.statut === 'pret' || verifierFichier()) return Promise.resolve();
    // (la promesse n'est effacée que si c'est encore la dernière : celle d'un téléchargement arrêté ne doit pas
    // effacer celle qui lui est enchaînée)
    let p;
    if (promesse && arret) {
      arret = false;
      p = promesse.catch(() => {}).then(() => (etat.statut === 'pret' || verifierFichier() ? undefined : telechargerTout()));
    } else if (!promesse) { arret = false; p = telechargerTout(); } else return promesse;
    const p2 = p.finally(() => { if (promesse === p2) promesse = null; });
    promesse = p2;
    return promesse;
  }

  // ---- Lecture : grille régulière (ligne 0 = sud), interpolée en bilinéaire, NaN si le relief manque ----------
  function grille({ sud, ouest, pasLat, pasLon, nLat, nLon }) {
    if (etat.statut !== 'pret') return null;
    const fd = fs.openSync(fBin, 'r');
    const lignes = new Map();
    const tampon = Buffer.alloc(NLON * 2);
    const lireLigne = (i) => {
      let l = lignes.get(i);
      if (!l) {
        fs.readSync(fd, tampon, 0, tampon.length, i * NLON * 2);
        l = new Int16Array(NLON);
        for (let j = 0; j < NLON; j++) l[j] = tampon.readInt16LE(j * 2);
        lignes.set(i, l);
      }
      return l;
    };
    try {
      const z = new Float32Array(nLat * nLon);
      for (let i = 0; i < nLat; i++) {
        const lat = Math.max(-90, Math.min(90, sud + i * pasLat));
        const fi = (lat + 90) / pas, i0 = Math.min(NLAT - 2, Math.floor(fi)), di = fi - i0;
        const a = lireLigne(i0), b = lireLigne(i0 + 1);
        for (let j = 0; j < nLon; j++) {
          const lon = ((((ouest + j * pasLon + 180) % 360) + 360) % 360);
          const fj = lon / pas, j0 = Math.floor(fj) % NLON, j1 = (j0 + 1) % NLON, dj = fj - Math.floor(fj);
          z[i * nLon + j] = (a[j0] * (1 - dj) + a[j1] * dj) * (1 - di) + (b[j0] * (1 - dj) + b[j1] * dj) * di;
        }
      }
      return z;
    } finally { fs.closeSync(fd); }
  }

  // Fichiers sur le disque (pour l'espace occupé et la purge)
  function fichiers() {
    return [fBin, fInfo, fInfo + '.bak', fPart, fReprise, fReprise + '.bak'].filter((f) => fs.existsSync(f)).map((f) => ({ fichier: path.basename(f), octets: fs.statSync(f).size }));
  }
  async function supprimer() {
    arret = true;
    if (promesse) { try { await promesse; } catch { /* arrêté */ } }
    for (const f of fichiers()) { try { fs.unlinkSync(path.join(dossier, f.fichier)); } catch { /* déjà */ } }
    Object.assign(etat, { statut: 'absent', progression: 0, erreur: null, date: null, octets: 0 });
    arret = false;
  }

  return {
    etat: () => ({ ...etat, enCours: !!promesse, octetsDisque: fichiers().reduce((t, f) => t + f.octets, 0) }),
    pret: () => etat.statut === 'pret',
    telecharger,
    arreter: () => { arret = true; },
    grille,
    quandPret: (cb) => { abonnes.add(cb); return () => abonnes.delete(cb); },
    fichiers,
    supprimer,
    nomFichiers: nom,
  };
}

module.exports = { creerReliefGrossier, SERVEURS_ERDDAP: SERVEURS };
