'use strict';
// Firmware Meshtastic 2.8 : signature XEdDSA des paquets (champ Data.xeddsa_signature, 64 octets).
// La carte vérifie elle-même la signature avec la clé publique de l'expéditeur (fiche NodeInfo), comme le
// firmware (CryptoEngine.cpp, buildSigningBuffer / xeddsa_verify) :
//   message = version 0x01 | de | id | vers | portnum | request_id | reply_id | emoji | bitfield (LE32) | drapeaux | charge
//   clé Ed25519 = image de la clé Curve25519 (RFC 7748 §4.1, bit de signe à 0) ; vérification Ed25519 standard.
// Firmware 2.8 : le numéro d'un nœud est le CRC32 de sa clé publique.

const crypto = require('crypto');
const zlib = require('zlib');

const P = 2n ** 255n - 19n;
const VERSION = 0x01;
const DRAPEAU_REPONSE = 0x01, DRAPEAU_BITFIELD = 0x02;
const PORT_TRACEROUTE = 70; // réécrit à chaque saut : sa signature ne se vérifie pas au-delà du premier

const modPow = (b, e) => { let r = 1n; b %= P; while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; };
const versBig = (buf) => { let x = 0n; for (let i = buf.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(buf[i]); return x; };
const versOctets = (x) => { const b = Buffer.alloc(32); for (let i = 0; i < 32; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };

// Clé Curve25519 (u) -> clé Ed25519 (y = (u-1)/(u+1), bit de signe à 0)
function curveVersEd(curve) {
  const c = Buffer.from(curve);
  c[31] &= 0x7f;
  const u = versBig(c) % P;
  const y = (((u - 1n + P) % P) * modPow((u + 1n) % P, P - 2n)) % P;
  const ed = versOctets(y);
  ed[31] &= 0x7f;
  return ed;
}
const cacheCles = new Map();
function cleEd(curveB64) {
  let k = cacheCles.get(curveB64);
  if (!k) {
    const ed = curveVersEd(Buffer.from(curveB64, 'base64'));
    k = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: ed.toString('base64url') }, format: 'jwk' });
    if (cacheCles.size > 5000) cacheCles.clear();
    cacheCles.set(curveB64, k);
  }
  return k;
}

// Message signé d'un paquet décodé (data : Meshtastic Data décodé par protobufjs)
function messageSigne(de, idPaquet, vers, data) {
  const charge = data.payload ? Buffer.from(data.payload) : Buffer.alloc(0);
  const aBitfield = data.bitfield != null && Object.prototype.hasOwnProperty.call(data, 'bitfield');
  const b = Buffer.alloc(34 + charge.length);
  let o = 0;
  b[o++] = VERSION;
  for (const v of [de, idPaquet, vers, data.portnum || 0, data.requestId || 0, data.replyId || 0, data.emoji || 0, aBitfield ? data.bitfield : 0]) { b.writeUInt32LE(v >>> 0, o); o += 4; }
  b[o++] = (data.wantResponse ? DRAPEAU_REPONSE : 0) | (aBitfield ? DRAPEAU_BITFIELD : 0);
  charge.copy(b, o);
  return b;
}

// Signature à vérifier, ou null (pas de signature, traceroute, taille anormale -> 'malformee')
function extraire(de, idPaquet, vers, data) {
  const s = data && data.xeddsaSignature;
  if (!s || !s.length) return null;
  if ((data.portnum || 0) === PORT_TRACEROUTE) return null;
  if (s.length !== 64) return { malformee: true };
  return { sig: Buffer.from(s), msg: messageSigne(de, idPaquet, vers, data) };
}

function verifier(curveB64, msg, sig) {
  try { return crypto.verify(null, msg, cleEd(curveB64), sig); } catch { return false; }
}

// Le numéro correspond-il à la clé (numéro 2.8 dérivé de la clé publique) ?
function numDeCle(curveB64) {
  try { const k = Buffer.from(curveB64, 'base64'); return k.length === 32 ? zlib.crc32(k) >>> 0 : null; } catch { return null; }
}

module.exports = { messageSigne, extraire, verifier, numDeCle, curveVersEd };
