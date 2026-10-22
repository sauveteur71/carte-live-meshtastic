# Carte live Meshtastic — image du service (x86-64 ou ARM64)
# Construction depuis la racine du dépôt :  docker build -t carte-live-meshtastic .

# 1. Agents (petit programme qui relie un module USB ou d'un autre réseau à la carte), compilés pour chaque système
FROM golang:1.24-bookworm AS agents
WORKDIR /src
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ ./
RUN set -e; mkdir -p /out; \
    CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/agent-gaulix-windows.exe . ; \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/agent-gaulix-linux-amd64 . ; \
    CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o /out/agent-gaulix-raspberrypi-arm64 . ; \
    CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 go build -trimpath -ldflags="-s -w" -o /out/agent-gaulix-raspberrypi-armv7 .

# 2. Service Node.js
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8095 \
    FICHIER_BASE=/data/carte-live.db \
    TZ=Europe/Paris
WORKDIR /app
COPY carte-live/package.json carte-live/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY carte-live/protobufs ./protobufs
COPY carte-live/src ./src
COPY carte-live/public ./public
COPY carte-live/outils ./outils
COPY carte-live/donnees-ref ./donnees-ref
COPY --from=agents /out/ ./public/agent/
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8095 4404
VOLUME ["/data"]
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8095)+'/sante').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
