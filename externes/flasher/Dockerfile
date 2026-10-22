# Flasheur web Meshtastic (https://github.com/meshtastic/web-flasher, GPL-3.0) servi localement.
# Le firmware est téléchargé par le navigateur depuis api.meshtastic.org / release.meshtastic.org.
FROM node:22-bookworm AS construction
ARG FLASHER_REF=main
RUN corepack enable && corepack prepare pnpm@9 --activate
RUN git clone --depth 1 --branch "${FLASHER_REF}" https://github.com/meshtastic/web-flasher.git /src
WORKDIR /src
ENV NUXT_TELEMETRY_DISABLED=1
RUN pnpm install --frozen-lockfile && pnpm generate

FROM nginx:1.27-alpine
COPY --from=construction /src/.output/public /usr/share/nginx/html
COPY default.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
