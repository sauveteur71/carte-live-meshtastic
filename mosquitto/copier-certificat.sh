#!/bin/sh
# ============================================================
#  Copie le certificat Let's Encrypt de votre domaine MQTT (géré par DSM Synology)
#  vers le dossier lu par Mosquitto, puis redémarre le broker.
#  À lancer en root par une tâche planifiée DSM (1 fois par semaine).
# ============================================================

DOMAINE="mqtt.mondomaine.fr"                                  # à adapter
DESTINATION="/volume1/docker/carte-live-meshtastic/mosquitto/certs"   # à adapter
CONTENEUR="mqtt-meshtastic"                                        # nom du conteneur Mosquitto

ARCHIVE="/usr/syno/etc/certificate/_archive"
INFO="$ARCHIVE/INFO"

# Recherche du dossier du certificat dont le nom couvre le domaine
ID=$(python3 -c "
import json,sys
d=json.load(open('$INFO'))
for k,v in d.items():
    if '$DOMAINE' in v.get('desc','') : print(k); sys.exit()
for k,v in d.items():
    for s in v.get('services',[]):
        if '$DOMAINE' in json.dumps(s): print(k); sys.exit()
" 2>/dev/null)

if [ -z "$ID" ]; then
  # Repli : certificat dont le fichier cert.pem contient le domaine
  for d in "$ARCHIVE"/*/; do
    if openssl x509 -in "$d/cert.pem" -noout -text 2>/dev/null | grep -q "DNS:$DOMAINE"; then
      ID=$(basename "$d"); break
    fi
  done
fi

if [ -z "$ID" ]; then
  echo "Certificat pour $DOMAINE introuvable. Créez-le dans DSM > Sécurité > Certificat." >&2
  exit 1
fi

SOURCE="$ARCHIVE/$ID"
mkdir -p "$DESTINATION"

if cmp -s "$SOURCE/cert.pem" "$DESTINATION/cert.pem"; then
  echo "Certificat déjà à jour."
  exit 0
fi

cp "$SOURCE/cert.pem" "$SOURCE/chain.pem" "$SOURCE/privkey.pem" "$DESTINATION/"
# Mosquitto tourne avec l'utilisateur 1883 dans le conteneur officiel
chown 1883:1883 "$DESTINATION"/*.pem
chmod 640 "$DESTINATION"/privkey.pem
chmod 644 "$DESTINATION"/cert.pem "$DESTINATION"/chain.pem

docker restart "$CONTENEUR" >/dev/null && echo "Certificat mis à jour et $CONTENEUR redémarré."
