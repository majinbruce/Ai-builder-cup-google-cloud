#!/usr/bin/env bash
#
# Deploys the whole product to Google Cloud (SPEC section f, Phase 5).
#
#   bash deploy/gcp/deploy.sh
#
# Do NOT deploy while a localize job is running: with --max-instances=1 the new
# API revision replaces the only instance, the in-flight job dies with it, and
# the stale-job reaper marks it failed on the next boot.
#
# Run from the repository root, signed in with gcloud, after deploy/gcp/setup.sh
# has linked billing and put GEMINI_API_KEY in .env.development. Safe to re-run:
# every step checks for what exists before creating it, so the second run is the
# routine deploy (rebuild both images, roll both services, migrate).
#
#   browser ──▶ localize-web (Cloud Run, Next) ──/api/*──▶ localize-api (Cloud Run, Fastify)
#                                                             ├─▶ Gemini (AI Studio key)
#                                                             ├─▶ Cloud TTS (Chirp 3 HD hi-IN)
#                                                             ├─▶ GCS  gs://<project>-localize
#                                                             └─▶ Cloud SQL localize-pg (unix socket)
#
# Four settings here are not defaults and each one was a silent failure before
# it was a flag — see docs/research.md § Cloud Run:
#
#   --no-cpu-throttling  on the API. A job runs in-process AFTER its POST returns,
#                        and under request-based billing Cloud Run allocates CPU
#                        "only during request processing". Without it the
#                        pipeline starves between polls.
#   --max-instances=1    on the API. A job lives inside the process that accepted
#                        it; a second instance is one Cloud Run may scale away
#                        mid-job, and the job would be reaped as stale.
#   --min-instances=1    on the API (SPEC), so nothing scales to zero mid-job.
#   TRUST_PROXY          the number of hops in front of Fastify, measured on this
#                        stack. Wrong, and every visitor shares one rate-limit key.
#
# The two service URLs are deterministic (https://<svc>-<projectNumber>.<region>.run.app),
# so each service is configured with the other's URL before either exists.
#
# Secrets are generated here (or read from .env.development for the Gemini key),
# stored in Secret Manager, and never printed.
set -Eeuo pipefail

PROJECT="${GCP_PROJECT:-gen-lang-client-0389180296}"
REGION="${GCP_REGION:-asia-south1}"
REPO="localize"
BUCKET="${PROJECT}-localize"
SQL_INSTANCE="localize-pg"
DB_NAME="localize"
DB_USER="localize"
RUNTIME_SA="localize-api"
API_SVC="localize-api"
WEB_SVC="localize-web"
OPS_JOB="localize-ops"
APP_NAME="Intent-Preserving Localization"
DEMO_EMAIL="${DEMO_EMAIL:-demo@example.com}"

# Hops between the caller and Fastify: web's Next proxy, then the API's Google
# front end. Measured 2026-09-11 by comparing the web service's Cloud Run
# request log (the caller's real IP) with Fastify's logged request.ip: at 1,
# every request appeared to come from the web service's egress IP, so all
# visitors shared ONE rate-limit key. See docs/research.md § Cloud Run.
TRUST_PROXY="${TRUST_PROXY:-2}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

log() { printf '\n== %s\n' "$*"; }
gc() { gcloud --project="$PROJECT" --quiet "$@"; }

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
SA_EMAIL="${RUNTIME_SA}@${PROJECT}.iam.gserviceaccount.com"
API_URL="https://${API_SVC}-${PROJECT_NUMBER}.${REGION}.run.app"
WEB_URL="https://${WEB_SVC}-${PROJECT_NUMBER}.${REGION}.run.app"
SQL_CONN="${PROJECT}:${REGION}:${SQL_INSTANCE}"
SHA="$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- . ':!docs' || echo -dirty)"
IMAGE_BASE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}"

log "project $PROJECT ($PROJECT_NUMBER), region $REGION, build $SHA"

# ── 1. APIs ─────────────────────────────────────────────────────────────────
# sql-component is separate from sqladmin and is what `--set-cloudsql-instances`
# on a Cloud Run JOB checks for; without it gcloud prompts, and --quiet answers
# the prompt "no" and reports "Aborted by user" (first deploy, 2026-09-11).
log "enabling APIs"
gc services enable run.googleapis.com sqladmin.googleapis.com sql-component.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com storage.googleapis.com \
  texttospeech.googleapis.com iam.googleapis.com iamcredentials.googleapis.com

# ── 2. Artifact Registry ────────────────────────────────────────────────────
if ! gc artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1; then
  log "creating Artifact Registry repo $REPO"
  gc artifacts repositories create "$REPO" --repository-format=docker --location="$REGION"
fi

# ── 3. Bucket ───────────────────────────────────────────────────────────────
# No lifecycle rule on jobs/, deliberately: setup.sh offers a 30-day delete, and
# the promoted demo job's files live in this bucket through judging (5 Oct -
# 6 Nov). The one rule is on uploads/, where a direct upload waits only until
# /jobs/from-upload ingests and deletes it; an abandoned one goes after a day.
if ! gc storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then
  log "creating gs://${BUCKET}"
  gc storage buckets create "gs://${BUCKET}" --location="$REGION" \
    --uniform-bucket-level-access --public-access-prevention
fi

# The browser PUTs uploads straight to the bucket on a V4 signed URL, which is
# cross-origin from the web service, so the bucket must answer the preflight.
# Both request headers are part of the signature, so both must be allowed.
# Public access prevention stays on: a signed URL is not public access.
log "setting bucket CORS and the uploads/ lifecycle rule"
bucket_cfg="$(mktemp -d)"
cat >"$bucket_cfg/cors.json" <<JSON
[{"origin": ["${WEB_URL}"], "method": ["PUT"],
  "responseHeader": ["Content-Type", "x-goog-content-length-range"],
  "maxAgeSeconds": 3600}]
JSON
cat >"$bucket_cfg/lifecycle.json" <<'JSON'
{"rule": [{"action": {"type": "Delete"},
           "condition": {"age": 1, "matchesPrefix": ["uploads/"]}}]}
JSON
gc storage buckets update "gs://${BUCKET}" \
  --cors-file="$bucket_cfg/cors.json" --lifecycle-file="$bucket_cfg/lifecycle.json" >/dev/null
rm -rf "$bucket_cfg"

# ── 4. Runtime service account ──────────────────────────────────────────────
# One identity for the API service and the ops job, holding only what they use.
if ! gc iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1; then
  log "creating service account $SA_EMAIL"
  gc iam service-accounts create "$RUNTIME_SA" --display-name="Localize API runtime"
  sleep 10 # IAM is eventually consistent; a grant to a brand-new SA can 404
fi

log "granting roles to $SA_EMAIL"
gc storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SA_EMAIL}" --role=roles/storage.objectUser >/dev/null
for role in roles/cloudsql.client roles/secretmanager.secretAccessor \
  roles/serviceusage.serviceUsageConsumer; do
  gc projects add-iam-policy-binding "$PROJECT" --condition=None \
    --member="serviceAccount:${SA_EMAIL}" --role="$role" >/dev/null
done
# Signing upload URLs. Cloud Run gives the SA no private key, so the storage
# client signs through IAM signBlob AS the SA — which needs TokenCreator on
# itself, scoped to this one SA rather than the project.
gc iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --member="serviceAccount:${SA_EMAIL}" --role=roles/iam.serviceAccountTokenCreator >/dev/null

# ── 5. Secrets ──────────────────────────────────────────────────────────────
# put_secret NAME VALUE — creates the secret with VALUE only if it does not
# exist yet. Existing secrets are never rotated by a re-run: rotating
# BETTER_AUTH_SECRET signs everyone out, and rotating PG_PASSWORD here without
# also changing the database user would lock the API out.
put_secret() {
  if gc secrets describe "$1" >/dev/null 2>&1; then return 0; fi
  log "creating secret $1"
  printf '%s' "$2" | gc secrets create "$1" --replication-policy=automatic --data-file=-
}
secret_value() { gc secrets versions access latest --secret="$1"; }

gemini_key="$(grep -E '^GEMINI_API_KEY=' .env.development | tail -1 | cut -d= -f2- || true)"
[[ -n "$gemini_key" ]] || gc secrets describe GEMINI_API_KEY >/dev/null 2>&1 \
  || { echo "GEMINI_API_KEY missing from .env.development and Secret Manager" >&2; exit 1; }
put_secret GEMINI_API_KEY "$gemini_key"
put_secret BETTER_AUTH_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
put_secret PG_PASSWORD "$(openssl rand -hex 24)"
# Random only. The API's password policy rejects a password containing the
# email's local part, and a "demo-" prefix on demo@example.com was exactly that
# (first deploy, 2026-09-11: 400 WEAK_PASSWORD).
put_secret DEMO_PASSWORD "$(openssl rand -base64 24 | tr -d '/+=\n')"
unset gemini_key

# ── 6. Cloud SQL ────────────────────────────────────────────────────────────
# The smallest shared-core tier. db-f1-micro exists only in the ENTERPRISE
# edition, which Postgres 17 does not default to. No authorized networks: the
# only way in is the Cloud SQL connector Cloud Run mounts at /cloudsql/<conn>,
# which authenticates by IAM (roles/cloudsql.client above).
if ! gc sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1; then
  log "creating Cloud SQL $SQL_INSTANCE (takes several minutes)"
  gc sql instances create "$SQL_INSTANCE" --database-version=POSTGRES_17 \
    --edition=ENTERPRISE --tier=db-f1-micro --region="$REGION" \
    --storage-size=10 --storage-auto-increase --backup-start-time=20:00
fi
if ! gc sql databases describe "$DB_NAME" --instance="$SQL_INSTANCE" >/dev/null 2>&1; then
  gc sql databases create "$DB_NAME" --instance="$SQL_INSTANCE"
fi
if ! gc sql users list --instance="$SQL_INSTANCE" --format='value(name)' | grep -qx "$DB_USER"; then
  gc sql users create "$DB_USER" --instance="$SQL_INSTANCE" \
    --password="$(secret_value PG_PASSWORD)"
fi

# ── 7. Images ───────────────────────────────────────────────────────────────
# .gcloudignore (root and web/) decides what is uploaded — it keeps the .env
# files out of the Cloud Build source bucket. Both Dockerfiles end on their
# `runtime` stage, which is what a plain --tag build produces.
#
# SKIP_BUILD=1 reuses this build tag's images when both already exist — for
# re-running a later step after a fix that touched no image input.
image_exists() { gc artifacts docker images describe "$1" >/dev/null 2>&1; }
if [[ "${SKIP_BUILD:-0}" == 1 ]] && image_exists "$IMAGE_BASE/api:$SHA" \
  && image_exists "$IMAGE_BASE/web:$SHA"; then
  log "SKIP_BUILD=1: reusing $IMAGE_BASE/{api,web}:$SHA"
else
  log "building $IMAGE_BASE/api:$SHA"
  gc builds submit --region="$REGION" --tag="$IMAGE_BASE/api:$SHA" .
  log "building $IMAGE_BASE/web:$SHA"
  gc builds submit --region="$REGION" --tag="$IMAGE_BASE/web:$SHA" web
fi

# ── 8. Shared API environment ───────────────────────────────────────────────
# `^|^` switches gcloud's list delimiter from "," so no value has to avoid one.
API_ENV="^|^NODE_ENV=production"
API_ENV+="|HOST=0.0.0.0"
API_ENV+="|TRUST_PROXY=${TRUST_PROXY}"
API_ENV+="|BETTER_AUTH_URL=${WEB_URL}"
API_ENV+="|FRONTEND_URL=${WEB_URL}"
API_ENV+="|CORS_ORIGINS=${WEB_URL}"
API_ENV+="|AUTH_REQUIRE_EMAIL_VERIFICATION=false"
API_ENV+="|MAIL_PROVIDER=console"
API_ENV+="|APP_NAME=${APP_NAME}"
API_ENV+="|APP_VERSION=${SHA}"
API_ENV+="|PG_HOST=/cloudsql/${SQL_CONN}"
API_ENV+="|PG_PORT=5432"
API_ENV+="|PG_USER=${DB_USER}"
API_ENV+="|PG_DATABASE=${DB_NAME}"
API_ENV+="|PG_POOL_MAX=5"
API_ENV+="|GCS_BUCKET=${BUCKET}"
API_SECRETS="GEMINI_API_KEY=GEMINI_API_KEY:latest,BETTER_AUTH_SECRET=BETTER_AUTH_SECRET:latest,PG_PASSWORD=PG_PASSWORD:latest"

# ── 9. Ops job + migrate ────────────────────────────────────────────────────
# The API image with the API's env, running one script and exiting. Migrations
# run here, before the new API revision takes traffic, and a failure stops the
# deploy. promote-demo runs the same way:
#   gcloud run jobs execute localize-ops --region=asia-south1 --wait \
#     --args=dist/scripts/promote-demo.js,<jobId>
log "deploying job $OPS_JOB"
gc run jobs deploy "$OPS_JOB" --region="$REGION" --image="$IMAGE_BASE/api:$SHA" \
  --service-account="$SA_EMAIL" --set-cloudsql-instances="$SQL_CONN" \
  --set-env-vars="$API_ENV" --set-secrets="$API_SECRETS" \
  --command=node --args=dist/scripts/migrate.js \
  --memory=512Mi --max-retries=0 --task-timeout=300s

log "running migrations"
gc run jobs execute "$OPS_JOB" --region="$REGION" --wait \
  --args=dist/scripts/migrate.js

# ── 10. API service ─────────────────────────────────────────────────────────
log "deploying $API_SVC"
gc run deploy "$API_SVC" --region="$REGION" --image="$IMAGE_BASE/api:$SHA" \
  --service-account="$SA_EMAIL" --add-cloudsql-instances="$SQL_CONN" \
  --set-env-vars="$API_ENV" --set-secrets="$API_SECRETS" \
  --port=3000 --cpu=1 --memory=2Gi \
  --no-cpu-throttling --min-instances=1 --max-instances=1 \
  --timeout=300 --allow-unauthenticated

# ── 11. Web service ─────────────────────────────────────────────────────────
# The API is public too: web/src/proxy.ts forwards the browser's /api/* to it
# over its run.app URL. It carries its own auth on every route that needs it.
log "deploying $WEB_SVC"
gc run deploy "$WEB_SVC" --region="$REGION" --image="$IMAGE_BASE/web:$SHA" \
  --set-env-vars="^|^NODE_ENV=production|API_ORIGIN=${API_URL}|APP_URL=${WEB_URL}|APP_NAME=${APP_NAME}" \
  --port=3001 --cpu=1 --memory=512Mi --min-instances=1 --max-instances=3 \
  --allow-unauthenticated

# ── 12. The shared demo account ─────────────────────────────────────────────
# Created through the public sign-up endpoint rather than create-admin, so it is
# an ordinary user: create-admin grants admin, and an admin can list every
# user's email — which, with sign-up open, would include other visitors'.
# The password travels on stdin, never argv. "Already exists" on a re-run is
# expected; anything else stops the deploy with the API's own message.
log "ensuring demo account $DEMO_EMAIL"
signup_body="$(mktemp)"
status="$(curl -s -o "$signup_body" -w '%{http_code}' -X POST "${WEB_URL}/api/auth/sign-up/email" \
  -H 'content-type: application/json' -H "origin: ${WEB_URL}" \
  --data @- <<JSON
{"email":"${DEMO_EMAIL}","password":"$(secret_value DEMO_PASSWORD)","name":"Demo"}
JSON
)"
if [[ "$status" == 200 ]]; then
  echo "sign-up -> 200, created"
elif grep -q 'USER_ALREADY_EXISTS' "$signup_body"; then
  echo "sign-up -> $status, already exists"
else
  echo "sign-up -> $status: $(cat "$signup_body")" >&2
  rm -f "$signup_body"
  exit 1
fi
rm -f "$signup_body"

# ── 13. Smoke ───────────────────────────────────────────────────────────────
log "smoke"
curl -fsS "${API_URL}/health/ready" && echo
# Not /healthz: Cloud Run's front end reserves "some paths ending with z" and
# answers them with its own 404 before the container sees the request
# (docs.cloud.google.com/run/docs/known-issues). The route still works for
# in-container probes; from outside, the landing page is the check.
curl -fsS -o /dev/null -w "web / -> %{http_code}\n" "${WEB_URL}/"
curl -fsS -o /dev/null -w "web /api/auth/providers (through the proxy) -> %{http_code}\n" \
  "${WEB_URL}/api/auth/providers"

cat <<EOF

Deployed $SHA
  web   $WEB_URL
  api   $API_URL
  demo  $WEB_URL/demo

Demo account: $DEMO_EMAIL
  password: gcloud secrets versions access latest --secret=DEMO_PASSWORD --project=$PROJECT

Next:
  node src/scripts/e2e-localize.ts --base=$WEB_URL --origin=$WEB_URL \\
    --email=$DEMO_EMAIL --password="\$(gcloud secrets versions access latest --secret=DEMO_PASSWORD)"
  gcloud run jobs execute $OPS_JOB --region=$REGION --wait --args=dist/scripts/promote-demo.js,<jobId>
  node src/scripts/check-demo.ts --base=$WEB_URL
EOF
