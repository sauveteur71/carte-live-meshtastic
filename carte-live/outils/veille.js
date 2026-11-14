'use strict';
// Veille technique de la carte live : node outils/veille.js [--jours 7] [--protos <dossier>]
// Écrit un rapport Markdown sur la sortie standard :
//  1. versions publiées des projets suivis (firmware Meshtastic, protobufs, MeshCore, Leaflet…) ;
//  2. écart entre nos protobufs Meshtastic et ceux du dépôt officiel (champs, ports et types ajoutés ou retirés) ;
//     avec --protos <dossier>, la version officielle y est aussi copiée (pour relancer les tests de décodage dessus) ;
//  3. failles connues et mises à jour des dépendances npm ;
//  4. projets voisins actifs sur GitHub (cartes Meshtastic / MeshCore) ;
//  5. tickets et propositions ouverts sur nos dépôts.
// GITHUB_TOKEN (facultatif) évite la limite de 60 requêtes par heure de l'API GitHub.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const JOURS = Number(opt('jours', 7));
const DOSSIER_ESSAI = opt('protos', '');
const OFFICIEL = opt('officiel', ''); // clone local de meshtastic/protobufs (sinon lecture par l'API GitHub)
const depuis = new Date(Date.now() - JOURS * 86400000);
const RACINE = path.join(__dirname, '..');

const SUIVIS = [
  ['meshtastic/firmware', 'Firmware Meshtastic'],
  ['meshtastic/protobufs', 'Protobufs Meshtastic (format des paquets)'],
  ['meshtastic/web', 'Client web Meshtastic'],
  ['meshtastic/python', 'Bibliothèque Python Meshtastic'],
  ['meshcore-dev/MeshCore', 'Firmware MeshCore'],
  ['Leaflet/Leaflet', 'Leaflet (carte)'],
  ['eclipse-mosquitto/mosquitto', 'Mosquitto (MQTT)'],
];
const NOS_DEPOTS = ['sauveteur71/carte-live-meshtastic', 'sauveteur71/live-mesh-map-world'];
const RECHERCHES = ['meshtastic map', 'meshcore map', 'meshtastic mqtt', 'meshcore mqtt'];

async function gh(url) {
  const r = await fetch(url.startsWith('http') ? url : 'https://api.github.com/' + url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'carte-live-veille', ...(process.env.GITHUB_TOKEN ? { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN } : {}) },
  });
  if (!r.ok) throw new Error(`${url} : HTTP ${r.status}`);
  return r.json();
}
const brut = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url} : HTTP ${r.status}`); return r.text(); };
const jour = (d) => new Date(d).toISOString().slice(0, 10);
const court = (t, n = 300) => { const s = String(t || '').replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\n{2,}/g, '\n').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const lignes = [];
const ecrire = (...l) => lignes.push(...l);
const alertes = []; // points qui demandent une action, repris en tête du rapport

// ---- 1. Versions publiées ----
async function versions() {
  ecrire('## 1. Nouvelles versions des projets suivis', '');
  let rien = true, erreurs = 0;
  for (const [depot, nom] of SUIVIS) {
    try {
      const l = (await gh(`repos/${depot}/releases?per_page=10`)).filter((r) => new Date(r.published_at) >= depuis);
      if (!l.length) continue;
      rien = false;
      for (const r of l) {
        ecrire(`- **${nom}** : [${r.name || r.tag_name}](${r.html_url}) (${jour(r.published_at)})${r.prerelease ? ' · pré-version' : ''}`);
        const notes = court(r.body, 600);
        if (notes) ecrire('  > ' + notes.split('\n').slice(0, 8).join('\n  > '));
        if (!r.prerelease && /firmware|protobufs/.test(depot)) alertes.push(`${nom} ${r.tag_name} publié : vérifier le décodage et l'administration à distance`);
      }
    } catch (e) { erreurs++; ecrire(`- ${nom} : lecture impossible (${e.message})`); }
  }
  if (rien && !erreurs) ecrire(`Aucune nouvelle version depuis ${JOURS} jours.`);
  ecrire('');
}

// ---- 2. Protobufs : nos fichiers comparés au dépôt officiel ----
const elements = (src) => {
  // « message X », « enum Y », champs « type nom = n; » et valeurs « NOM = n; », rattachés à leur bloc
  const out = new Set(); const pile = [];
  for (const l0 of src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').split('\n')) {
    const l = l0.trim();
    let m;
    if ((m = /^(message|enum|oneof)\s+(\w+)\s*\{/.exec(l))) { pile.push(m[2]); out.add(`${m[1]} ${pile.join('.')}`); continue; }
    if (l.startsWith('}')) { pile.pop(); continue; }
    if ((m = /^(?:optional\s+|repeated\s+)?([\w.]+)\s+(\w+)\s*=\s*(\d+)/.exec(l))) out.add(`${pile.join('.')}.${m[2]} = ${m[3]} (${m[1]})`);
    else if ((m = /^(\w+)\s*=\s*(-?\d+)/.exec(l))) out.add(`${pile.join('.')}.${m[1]} = ${m[2]}`);
  }
  return out;
};
async function protobufs() {
  ecrire('## 2. Protobufs Meshtastic : écart avec la version officielle', '');
  const ici = path.join(RACINE, 'protobufs', 'meshtastic');
  let liste;
  try {
    liste = OFFICIEL
      ? fs.readdirSync(path.join(OFFICIEL, 'meshtastic')).map((name) => ({ name, lire: async () => fs.readFileSync(path.join(OFFICIEL, 'meshtastic', name), 'utf8') }))
      : (await gh('repos/meshtastic/protobufs/contents/meshtastic')).map((f) => ({ name: f.name, lire: () => brut(f.download_url) }));
    liste = liste.filter((f) => f.name.endsWith('.proto') || f.name.endsWith('.options'));
  } catch (e) { ecrire(`Lecture impossible (${e.message}).`, ''); return; }
  if (DOSSIER_ESSAI) fs.mkdirSync(path.join(DOSSIER_ESSAI, 'meshtastic'), { recursive: true });
  const diff = [];
  for (const f of liste) {
    let officiel;
    try { officiel = await f.lire(); } catch { continue; }
    if (DOSSIER_ESSAI) fs.writeFileSync(path.join(DOSSIER_ESSAI, 'meshtastic', f.name), officiel);
    if (!f.name.endsWith('.proto')) continue;
    const local = fs.existsSync(path.join(ici, f.name)) ? fs.readFileSync(path.join(ici, f.name), 'utf8') : null;
    if (local === officiel) continue;
    if (local == null) { diff.push(`- **${f.name}** : nouveau fichier`); continue; }
    const a = elements(local), b = elements(officiel);
    const plus = [...b].filter((x) => !a.has(x)), moins = [...a].filter((x) => !b.has(x));
    if (!plus.length && !moins.length) { diff.push(`- ${f.name} : commentaires seulement`); continue; }
    diff.push(`- **${f.name}** : ${plus.length} ajout(s), ${moins.length} retrait(s) ou changement(s)`);
    for (const x of plus.slice(0, 15)) diff.push(`  - ➕ \`${x}\``);
    for (const x of moins.slice(0, 15)) diff.push(`  - ➖ \`${x}\``);
    if (moins.length) alertes.push(`${f.name} : ${moins.length} élément(s) retiré(s) ou renumérotés dans les protobufs officiels — risque de casse du décodage`);
    if (f.name === 'portnums.proto' && plus.length) alertes.push('Nouveaux ports Meshtastic (portnums.proto) : à afficher dans le trafic ?');
  }
  for (const n of fs.readdirSync(ici)) if (n.endsWith('.proto') && !liste.some((f) => f.name === n)) diff.push(`- **${n}** : n'existe plus dans le dépôt officiel`);
  if (DOSSIER_ESSAI && fs.existsSync(path.join(RACINE, 'protobufs', 'LICENSE'))) fs.copyFileSync(path.join(RACINE, 'protobufs', 'LICENSE'), path.join(DOSSIER_ESSAI, 'LICENSE'));
  ecrire(...(diff.length ? diff : ['Nos protobufs sont identiques à la version officielle.']), '');
}

// ---- 3. Dépendances npm ----
function npm(cmd) {
  try { return JSON.parse(execFileSync('npm', [cmd, '--json'], { cwd: RACINE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) || '{}'); }
  catch (e) { try { return JSON.parse(e.stdout || '{}'); } catch { return null; } } // npm audit / outdated sortent en erreur quand ils trouvent quelque chose
}
function dependances() {
  ecrire('## 3. Dépendances npm', '');
  const a = npm('audit');
  const v = a && a.vulnerabilities ? Object.values(a.vulnerabilities) : null;
  if (!v) ecrire('- Audit de sécurité : indisponible.');
  else if (!v.length) ecrire('- Audit de sécurité : aucune faille connue ✓');
  else {
    ecrire(`- Audit de sécurité : **${v.length} paquet(s) concerné(s)**`);
    for (const x of v) ecrire(`  - ${x.name} (${x.severity})${x.fixAvailable ? ' · correctif disponible' : ''}${x.isDirect ? '' : ' · dépendance indirecte'}`);
    if (v.some((x) => ['high', 'critical'].includes(x.severity))) alertes.push('Faille de sécurité haute ou critique dans les dépendances npm');
  }
  const o = npm('outdated');
  const l = o ? Object.entries(o) : [];
  if (l.length) {
    ecrire('- Mises à jour disponibles :');
    for (const [n, x] of l) ecrire(`  - ${n} : ${x.current || '?'} → ${x.latest}${x.wanted !== x.latest ? ` (dans la plage : ${x.wanted})` : ''}${String(x.current || '').split('.')[0] !== String(x.latest).split('.')[0] ? ' · **version majeure**' : ''}`);
  } else ecrire('- Toutes les dépendances sont à jour.');
  ecrire('');
}

// ---- 4. Projets voisins ----
async function voisins() {
  ecrire('## 4. Projets voisins actifs', '');
  const vus = new Map();
  for (const q of RECHERCHES) {
    try {
      const r = await gh(`search/repositories?q=${encodeURIComponent(`${q} pushed:>=${jour(depuis)}`)}&sort=stars&order=desc&per_page=8`);
      for (const d of r.items || []) if (!NOS_DEPOTS.includes(d.full_name) && !vus.has(d.full_name)) vus.set(d.full_name, d);
    } catch (e) { ecrire(`- Recherche « ${q} » impossible (${e.message})`); }
  }
  const l = [...vus.values()].sort((a, b) => b.stargazers_count - a.stargazers_count).slice(0, 15);
  const neufs = l.filter((d) => new Date(d.created_at) >= new Date(Date.now() - 30 * 86400000));
  for (const d of l) ecrire(`- [${d.full_name}](${d.html_url}) ★${d.stargazers_count}${new Date(d.created_at) >= new Date(Date.now() - 30 * 86400000) ? ' · 🆕 créé ' + jour(d.created_at) : ''} : ${court(d.description, 140)}`);
  if (!l.length) ecrire('Aucun.');
  if (neufs.length) alertes.push(`${neufs.length} projet(s) voisin(s) créé(s) ce mois-ci à regarder`);
  ecrire('');
}

// ---- 5. Nos tickets ----
async function tickets() {
  ecrire('## 5. Tickets et propositions sur nos dépôts', '');
  for (const d of NOS_DEPOTS) {
    try {
      const l = (await gh(`repos/${d}/issues?state=open&per_page=50`)).filter((i) => !(i.labels || []).some((x) => x.name === 'veille'));
      ecrire(`**${d}** : ${l.length} ouvert(s)`);
      for (const i of l) {
        const neuf = new Date(i.created_at) >= depuis;
        ecrire(`- ${neuf ? '🆕 ' : ''}${i.pull_request ? 'PR' : 'Ticket'} [#${i.number} ${i.title}](${i.html_url}) par ${i.user.login}, ${jour(i.created_at)} · ${i.comments} commentaire(s)`);
        if (neuf) alertes.push(`Nouveau ${i.pull_request ? 'PR' : 'ticket'} ${d.split('/')[1]}#${i.number} : ${i.title}`);
      }
    } catch (e) { ecrire(`**${d}** : lecture impossible (${e.message})`); }
    ecrire('');
  }
}

(async () => {
  await versions();
  await protobufs();
  dependances();
  await voisins();
  await tickets();
  const tete = [`# Veille de la carte live — semaine du ${jour(Date.now())}`, '', `Période : ${JOURS} derniers jours (depuis le ${jour(depuis)}).`, '',
    '### À regarder en priorité', '', ...(alertes.length ? alertes.map((a) => '- ⚠️ ' + a) : ['- Rien d’urgent.']), ''];
  process.stdout.write([...tete, ...lignes].join('\n') + '\n');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `alertes=${alertes.length}\n`);
})().catch((e) => { console.error(e); process.exit(1); });
