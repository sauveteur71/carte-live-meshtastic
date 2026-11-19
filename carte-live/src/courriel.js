'use strict';
// Envoi d'e-mails (mot de passe oublié) par le serveur SMTP choisi dans Réglages › Réglages avancés › E-mail.
// Rien n'est envoyé tant que SMTP_HOTE et CARTE_ADRESSE ne sont pas renseignés : la carte se rabat alors sur
// les administrateurs. Le mot de passe SMTP est une variable « secret », jamais renvoyée à la page ni écrite au journal.
// SMTP_HOTE=fichier (essais) : les messages sont écrits dans le dossier des données, rien ne part.
const fs = require('fs');
const path = require('path');

function creerCourriel({ config, journal = () => {} }) {
  const env = () => process.env;
  const adresseCarte = () => String(env().CARTE_ADRESSE || '').trim().replace(/\/+$/, '');
  const actif = () => !!(env().SMTP_HOTE && /^https?:\/\/[^\s/]+/i.test(adresseCarte()));
  let transport = null, cle = '';
  function obtenir() {
    const e = env();
    const k = [e.SMTP_HOTE, e.SMTP_PORT, e.SMTP_SECURISE, e.SMTP_UTILISATEUR, e.SMTP_MOT_DE_PASSE].join('|');
    if (transport && k === cle) return transport;
    const nodemailer = require('nodemailer');
    if (e.SMTP_HOTE === 'fichier') transport = nodemailer.createTransport({ jsonTransport: true });
    else {
      const port = Number(e.SMTP_PORT) || 587;
      transport = nodemailer.createTransport({
        host: e.SMTP_HOTE, port, secure: e.SMTP_SECURISE ? e.SMTP_SECURISE === 'oui' : port === 465,
        auth: e.SMTP_UTILISATEUR ? { user: e.SMTP_UTILISATEUR, pass: e.SMTP_MOT_DE_PASSE || '' } : undefined,
        connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
      });
    }
    cle = k;
    return transport;
  }
  async function envoyer({ a, sujet, texte }) {
    const e = env();
    const de = e.SMTP_EXPEDITEUR || e.SMTP_UTILISATEUR || 'carte-live@localhost';
    const info = await obtenir().sendMail({ from: de, to: a, subject: sujet, text: texte });
    if (e.SMTP_HOTE === 'fichier') {
      const dossier = path.join(path.dirname(config.fichierBase), 'courriels-essai');
      fs.mkdirSync(dossier, { recursive: true });
      fs.writeFileSync(path.join(dossier, `${Date.now()}.json`), info.message);
    }
    return true;
  }
  // Masque l'adresse pour l'afficher sans la révéler : o•••@g•••.com
  const masquer = (m) => String(m || '').replace(/^(.)[^@]*@(.)[^.]*(\..*)$/, '$1•••@$2•••$3');
  return { actif, adresseCarte, envoyer, masquer };
}

module.exports = { creerCourriel };
