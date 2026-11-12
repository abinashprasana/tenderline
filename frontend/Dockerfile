# The web app: a static build served by Caddy, which also proxies the API so both share one origin.
FROM node:24-alpine AS build
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG VITE_GRAFANA_URL=""
ENV VITE_GRAFANA_URL=${VITE_GRAFANA_URL}
RUN npm run build

FROM caddy:2
COPY --from=build /web/dist /srv
COPY caddy/tenderline.caddy /etc/caddy/tenderline.caddy
COPY caddy/Caddyfile /etc/caddy/Caddyfile
ENV API_UPSTREAM=app:8000
EXPOSE 8080
