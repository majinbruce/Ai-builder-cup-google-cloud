# ---- dependencies ----------------------------------------------------------
# Split from the build so a code change does not reinstall node_modules.
FROM node:24-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci

# ---- build -----------------------------------------------------------------
FROM node:24-alpine AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Turbopack writes cache into .next; a stale one copied in from the host causes
# very confusing "changes not applied" builds. .dockerignore excludes it.
#
# NOTE: nothing project-specific is baked in here. This app has no
# NEXT_PUBLIC_* variables on purpose (see src/lib/env.ts), so one built image is
# valid for every environment and every clone — the container is configured by
# the env vars it starts with, not by the ones it was built with.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- development -----------------------------------------------------------
# Used by the root docker-compose.yml. Source is bind-mounted over /app, so this
# stage exists mainly for its node_modules — installed for the container's
# platform rather than the host's.
FROM node:24-alpine AS dev

WORKDIR /app

RUN apk add --no-cache dumb-init

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=development
ENV NEXT_TELEMETRY_DISABLED=1
EXPOSE 3001

ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "run", "dev"]

# ---- runtime ---------------------------------------------------------------
FROM node:24-alpine AS runtime

WORKDIR /app

# dumb-init reaps zombies and forwards SIGTERM to node, so `docker stop` ends
# the server rather than waiting out the grace period and killing it.
RUN apk add --no-cache dumb-init

RUN addgroup -S app && adduser -S app -G app

# `output: "standalone"` (next.config.ts) produced a self-contained server.js
# plus only the node_modules it actually imports. That is the whole runtime —
# there is no `npm ci --omit=dev` stage here because there is nothing to install.
#
# `static` and `public` are NOT copied into standalone automatically; the docs
# assume a CDN serves them. There is no CDN here, so they are copied in and
# Next serves them itself.
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public

USER app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# The standalone server reads these rather than a CLI flag.
ENV PORT=3001
ENV HOSTNAME=0.0.0.0
EXPOSE 3001

# /healthz, not /. Same contract as the API's healthcheck: it proves this
# process is serving, and nothing else. `/` renders the header, which resolves
# the session from the API — probing it would restart a perfectly healthy web
# container every time the API hiccuped.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
