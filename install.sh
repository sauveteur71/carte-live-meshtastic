#!/bin/sh
# Installation de la carte live Meshtastic / MeshCore en une commande (Linux : Debian, Ubuntu, Raspberry Pi OS…)
#
#   curl -fsSL https://raw.githubusercontent.com/sauveteur71/carte-live-meshtastic/main/install.sh | sudo sh
#
# Variables facultatives : DOSSIER (défaut /opt/carte-live-meshtastic), CARTE_PORT (défaut 8095),
# MISE_A_JOUR=non (sans le service de mise à jour en un clic).
# Le script ne touche qu'au dossier d'installation. Relancé sur une installation existante, il met simplement
# l'image à jour, sans changer le .env ni les données.
set -eu

DEPOT="https://raw.githubusercontent.com/sauveteur71/carte-live-meshtastic/main"
DOSSIER="${DOSSIER:-/opt/carte-live-meshtastic}"
CARTE_PORT="${CARTE_PORT:-8095}"
MISE_A_JOUR="${MISE_A_JOUR:-oui}"

info() { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m✔ %s\033[0m\n' "$*"; }
erreur() { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }
# Question posée au clavier même quand le script arrive par « curl … | sh »
demander() { if [ -r /dev/tty ]; then printf '%s ' "$1" > /dev/tty; read -r rep < /dev/tty || rep=""; else rep=""; fi; echo "$rep"; }

[ "$(id -u)" = 0 ] || erreur "Lancez le script en administrateur : … | sudo sh"
command -v curl > /dev/null 2>&1 || erreur "curl est nécessaire (apt install curl)"

# 1. Docker
if ! command -v docker > /dev/null 2>&1; then
  info "Docker n'est pas installé."
  r=$(demander "L'installer maintenant avec le script officiel de Docker (get.docker.com) ? [O/n]")
  case "$r" in n|N|non|Non) erreur "Installez Docker puis relancez ce script : https://docs.docker.com/engine/install/";; esac
  curl -fsSL https://get.docker.com | sh || erreur "Installation de Docker impossible"
  ok "Docker installé"
fi
docker compose version > /dev/null 2>&1 || erreur "Le module « docker compose » manque (paquet docker-compose-plugin)"

# 2. Dossier, docker-compose.yml et .env
mkdir -p "$DOSSIER"
cd "$DOSSIER"
if [ -f docker-compose.yml ]; then
  info "Installation existante dans $DOSSIER : mise à jour de l'image seulement"
else
  info "Téléchargement des fichiers dans $DOSSIER"
  curl -fsSL "$DEPOT/docker-compose.yml" -o docker-compose.yml
  if [ "$MISE_A_JOUR" = non ]; then
    # Retire le bloc « maj » (mise à jour en un clic : accès au moteur Docker)
    awk 'BEGIN{s=0} /^  maj:/{s=1; next} s && /^  [a-z#]/{s=0} !s' docker-compose.yml > dc.tmp && mv dc.tmp docker-compose.yml
  fi
  ok "docker-compose.yml"
fi
if [ ! -f .env ]; then
  curl -fsSL "$DEPOT/.env.exemple" -o .env
  # Port de la carte
  if grep -q '^#\? *CARTE_PORT=' .env; then sed -i "s|^#\? *CARTE_PORT=.*|CARTE_PORT=$CARTE_PORT|" .env; else printf '\nCARTE_PORT=%s\n' "$CARTE_PORT" >> .env; fi
  # Clé des équipes (chiffrement des clés de canaux d'équipe) : créée une fois, gardée dans le .env
  if ! grep -q '^CLE_EQUIPES=' .env; then printf '\n# Clé maîtresse des équipes (à garder : sans elle, une sauvegarde restaurée ne relit plus les clés)\nCLE_EQUIPES=%s\n' "$(head -c 32 /dev/urandom | base64 | tr -d '\n')" >> .env; fi
  chmod 600 .env
  ok ".env créé (les réglages se font ensuite dans la carte)"
fi

# 3. Lancement
info "Téléchargement des images (quelques minutes la première fois)"
docker compose pull -q
docker compose up -d
info "Démarrage de la carte"
i=0
until curl -fsS "http://127.0.0.1:$CARTE_PORT/sante" > /dev/null 2>&1; do
  i=$((i + 1)); [ $i -gt 60 ] && erreur "La carte ne répond pas : docker compose logs carte-live"
  sleep 2
done
ok "La carte tourne"

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
CODE=$(docker compose logs carte-live 2>/dev/null | grep -o "code d'installation [A-Z0-9-]*" | tail -1 | sed 's/.* //')
echo
ok "Ouvrez http://${IP:-IP_DU_SERVEUR}:$CARTE_PORT dans un navigateur"
echo "   L'assistant crée le compte administrateur et règle le serveur MQTT (avec un bouton pour le tester)."
[ -n "$CODE" ] && echo "   Code d'installation demandé hors du réseau local : $CODE"
echo "   Ensuite : Réglages › 🩺 Diagnostic vérifie que tout fonctionne ; les mises à jour se font d'un clic dans la carte."
echo "   Dossier : $DOSSIER (gardez le .env : il contient la clé des équipes)"
