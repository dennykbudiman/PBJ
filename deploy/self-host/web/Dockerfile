# Builds the Axle app and packs it into a small Caddy web server image.
# Built by `axle.sh install` / `axle.sh update` (docker compose build web); the build context is the app folder.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
# The address of this server and its public (anon) key. Both end up in the browser by design;
# the database's access rules decide what that key can do.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
RUN test -n "$VITE_SUPABASE_URL" && test -n "$VITE_SUPABASE_ANON_KEY" \
    || (echo "VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing: run this through axle.sh" >&2; exit 1)
RUN VITE_SUPABASE_URL="$VITE_SUPABASE_URL" VITE_SUPABASE_ANON_KEY="$VITE_SUPABASE_ANON_KEY" npm run build

FROM caddy:2.10-alpine
COPY deploy/self-host/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
