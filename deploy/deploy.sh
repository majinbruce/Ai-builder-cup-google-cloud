#!/usr/bin/env bash
#
# The routine deploy, run ON THE SERVER from anywhere:
#
#   ssh you@your-box
#   /srv/proj1/deploy/deploy.sh
#
# The flow is deliberately manual — you push from your machine, then ssh and
# run this. No webhook, no CD agent, no deploy key with write access sitting on
# the box. What the script adds over typing the commands yourself is the part
# humans skip when a deploy "obviously worked": waiting for the container to
# actually come up healthy, proving the database is reachable through it, and
# saying loudly which commit is now live.
#
# What it does, in order:
#
#   1. git pull --ff-only        refuses to deploy a rewritten branch silently
#   2. compose up -d --build     migrate runs to completion first (compose
#                                dependency), then the api and web are replaced
#   3. wait for HEALTHY          the Dockerfile healthchecks — the api polling
#                                /health/live, the web container /healthz
#   4. check /health/ready       proves the app can reach ITS database
#   5. docker image prune -f     dangling layers only — every rebuild strands
#                                the previous image's layers, and this is the
#                                disk leak that fills a VPS in a few months
#
# Failure in any step stops the script and dumps recent api + migrate logs.
# Note the window in step 2: the old api stops before the new one is healthy,
# so a deploy has a few seconds of downtime — see "Deploys are not
# zero-downtime" in deploy/README.md for why that is the right trade here.
set -Eeuo pipefail

HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-120}"

# Always operate on the project this script lives in, regardless of cwd — so
# cron, an ssh one-liner and a shell in the wrong directory all deploy the
# right project.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() { printf '\n== %s\n' "$*"; }

compose() {
  docker compose --env-file .env.production -f compose.prod.yml "$@"
}

fail() {
  printf '\nDEPLOY FAILED: %s\n\n' "$*" >&2
  # The two containers whose logs explain nearly every failed deploy.
  compose logs --tail 40 migrate api web >&2 || true
  exit 1
}

[[ -f .env.production ]] || fail ".env.production not found in ${ROOT} — create it from .env.example first (see README, Deploying)"

log "pulling ${ROOT}"
before="$(git rev-parse HEAD)"
# --ff-only: if the branch was force-pushed, this stops and makes you look,
# rather than quietly merging histories on the production box.
git pull --ff-only
after="$(git rev-parse HEAD)"

if [[ "$before" == "$after" ]]; then
  echo "already at $(git rev-parse --short HEAD) — rebuilding anyway (env or local changes still apply)"
else
  git --no-pager log --oneline "${before}..${after}"
fi

# Stamped into the container (see compose.prod.yml) and reported to Sentry as
# the release, so a stack trace names the commit that produced it.
APP_VERSION="$(git rev-parse --short HEAD)"
export APP_VERSION

log "building and starting (migrate first, then api and web)"
compose up -d --build || fail "compose up did not converge — the migrate service failing is the usual cause"

# Both containers are waited on the same way, so a frontend that builds but
# cannot start is a failed deploy rather than a silent 502 discovered by a user.
wait_healthy() {
  local service="$1" cid deadline state health

  cid="$(compose ps -q "$service")"
  [[ -n "$cid" ]] || fail "no ${service} container after up -d"

  log "waiting for the ${service} container to report healthy"

  deadline=$((SECONDS + HEALTH_TIMEOUT_S))
  while :; do
    state="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo missing)"
    health="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo unknown)"

    [[ "$state" == "running" || "$state" == "created" ]] || fail "${service} container is ${state}"
    [[ "$health" != "healthy" ]] || break
    ((SECONDS < deadline)) || fail "${service} not healthy after ${HEALTH_TIMEOUT_S}s (last status: ${health})"

    sleep 3
  done
}

wait_healthy api
wait_healthy web

# Fetched after the wait rather than returned from it: `log` writes to stdout,
# so capturing the function's output would capture the log lines with it.
cid="$(compose ps -q api)"

# The healthcheck above is /health/live, which deliberately checks nothing
# external. This is the readiness probe — the one that actually asks Postgres.
log "checking /health/ready through the container"
docker exec "$cid" node -e \
  "fetch('http://127.0.0.1:3000/health/ready').then(r=>r.text().then(t=>{console.log(t);process.exit(r.ok?0:1)})).catch(()=>process.exit(1))" \
  || fail "api is live but not ready — it cannot reach its database"

# Dangling images only: the per-project tag moved to the new build, so the old
# build's layers are unreferenced. Other projects' tagged images are untouched.
log "pruning dangling images"
docker image prune -f

log "deployed $(git rev-parse --short HEAD)"
