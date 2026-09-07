# Running several of these on one VPS

Two different things live under `deploy/`, and the distinction matters:

- **This file** is the **per-project** contract — the settings and conventions
  that differ in every clone and are genuinely part of this project.
- **`deploy/host/`** is **shared host infrastructure**: Caddy, backups,
  monitoring. There is one of it per VPS regardless of how many projects run
  there, so it should live in its own repo rather than being duplicated into
  every clone. See [`deploy/host/README.md`](host/README.md) for the one-minute
  extraction — do it before you clone this boilerplate a second time.

Application deployment itself is unchanged and still lives in
`compose.prod.yml` and the root README.

Target shape, on a 4-core / 16 GB / 200 GB box:

```
                    internet
                       |  :80 :443
              +--------v---------+
              |   Caddy (edge)   |   one container, all TLS
              +--------+---------+
                       |  docker network "edge"
        +--------------+--------------+
        |                             |
  proj1-api:3000                proj2-api:3000
        |                             |
  proj1_default                 proj2_default     private, per project
        |                             |
    postgres                      postgres        never on "edge"
```

Every project keeps its own Postgres. On 16 GB that costs roughly 150 MB per
project under real load and buys the thing that actually matters: one project's
runaway query, bloated table or botched restore cannot touch another's. The
databases are on per-project private networks, so `proj2` cannot reach `proj1`'s
Postgres even by accident.

**No application port is published on the host at all** — not even on loopback.
Caddy reaches each api over the shared `edge` network by its alias. That is why
there is no port to allocate per project and nothing for a misconfigured
firewall to leak.

## One-time host setup

```bash
# 1. The shared network. Created by hand so no single project owns it.
docker network create edge

# 2. The edge proxy.
sudo mkdir -p /srv/edge
sudo cp -r deploy/host/caddy/. /srv/edge/
sudo $EDITOR /srv/edge/Caddyfile        # set `email`, add your site blocks
cd /srv/edge && docker compose up -d

# 3. Backups.
sudo mkdir -p /srv/edge/backup /var/backups/postgres
sudo cp deploy/host/backup/pg-backup.sh deploy/host/backup/pg-restore.sh /srv/edge/backup/
sudo chmod +x /srv/edge/backup/*.sh
sudo cp deploy/host/backup/pg-backup.env.example /etc/pg-backup.env
sudo chmod 600 /etc/pg-backup.env
sudo $EDITOR /etc/pg-backup.env

# rclone, for the offsite copy
sudo apt install rclone
rclone config                            # create the remote named in the config
sudo rclone config file                  # note the path; root's cron needs root's config

# 4. Schedules.
sudo crontab -e                          # paste deploy/host/backup/crontab.example

# 5. Prove the backup works BEFORE you need it.
sudo /srv/edge/backup/pg-backup.sh
sudo /srv/edge/backup/pg-restore.sh proj1
```

Then follow [`deploy/host/monitoring/README.md`](host/monitoring/README.md) — an uptime check per project and a
dead-man's switch on the backup. That step is the difference between "I have
backups" and "I know my backups are running".

## Adding a project

```bash
git clone <this-repo> /srv/proj2 && cd /srv/proj2

# The API's env, and the frontend's — two files, two containers.
cp .env.example .env.production && $EDITOR .env.production
cp web/.env.example web/.env.production && $EDITOR web/.env.production
```

The settings that must be right for a shared box:

| Setting              | Value                           | Why                                                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROJECT_SLUG`       | `proj2`                         | Namespaces the Compose project, the image tag, the volumes and the network alias. Two projects sharing it are treated as **one stack**: `up -d` on the second adopts the first's containers and its `pgdata` volume. The `:?` guard in `compose.prod.yml` makes that a startup error. |
| `TRUST_PROXY`        | `1`                             | Exactly one proxy hop (Caddy). Without it every request appears to come from Caddy's container IP — one rate-limit bucket for the whole internet, in front of sign-in and password reset. The app refuses to boot in production without it.                                           |
| `BETTER_AUTH_URL`    | `https://proj2.example.com`     | The origin **the browser** uses — the frontend's, not an `api.` hostname. The web container serves `/api/auth/*` on that origin and Caddy routes it here. Google's redirect URI is built from this value and must match the Cloud Console entry exactly: `https://proj2.example.com/api/auth/callback/google`. |
| `FRONTEND_URL`       | `https://proj2.example.com`     | Same origin. Every `callbackURL` is checked against `TRUSTED_ORIGINS`, which defaults to this.                                                                                                                                                                                        |
| `CORS_ORIGINS`       | `https://proj2.example.com`     | `*` is refused in production — CORS runs with `credentials: true`. With the bundled frontend there is no cross-origin browser traffic at all, so this list is only for clients that call the API directly.                                                                            |
| `PG_POOL_MAX`        | `10`                            | 20 is more idle backends than a 10k-user app will ever use. Not a capacity concern on this box, just tidiness.                                                                                                                                                                        |
| `PG_PASSWORD`        | distinct per project            | Separate databases with a shared password are one leak away from being one database.                                                                                                                                                                                                  |
| `BETTER_AUTH_SECRET` | `npm run auth:secret`           | Distinct per project, or a session minted for one is valid on the other.                                                                                                                                                                                                              |

And in `web/.env.production`:

| Setting     | Value                       | Why                                                                                                                                                       |
| ----------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_URL`   | `https://proj2.example.com` | Only used for metadata URLs. The browser never calls it — it calls relative paths.                                                                          |
| `APP_NAME`  | the project's name          | Match `APP_NAME` on the API so the UI and the auth emails agree.                                                                                            |
| `AUTH_GOOGLE_ENABLED` | `true` / `false`  | Must match whether the API has `GOOGLE_CLIENT_ID`/`SECRET` set. A button for a provider the API did not register returns a 400.                              |
| `AUTH_REQUIRE_EMAIL_VERIFICATION` | mirror the API | Only decides which screen sign-up lands on.                                                                                              |

`API_ORIGIN` is **not** in that file — `compose.prod.yml` sets it to
`http://api:3000`, because it is a fact about the Compose network rather than a
project setting, and it is the one thing an env file should not be able to get
wrong.

Then:

```bash
# DNS: A record for proj2.example.com -> this box, and let it propagate
#      BEFORE the first request, or Caddy burns an ACME attempt on a name
#      that does not resolve yet.

docker compose --env-file .env.production -f compose.prod.yml up -d --build

# Add the site block and reload the proxy — no restart, no downtime for others.
sudo $EDITOR /srv/edge/Caddyfile
cd /srv/edge && docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

Backups pick the new project up on their next run with no edit here: the
postgres service carries `backup.enable=true` and `backup.project=${PROJECT_SLUG}`
labels, and `pg-backup.sh` discovers containers by label. The one per-project
line you do have to add by hand is the weekly prune in the crontab.

## Deploying an update

The flow is deliberately manual: push from your machine, then ssh and run one
script. No webhook and no CD agent means nothing on the box holds credentials
that can write to your repo, and a bad deploy always has a human watching it.

```bash
# on your machine
git push

# on the server — from anywhere, the script finds its own project root
ssh you@your-box
/srv/proj1/deploy/deploy.sh
```

The script is the same `git pull` + `compose up -d --build` you would type by
hand, plus the checks that get skipped when a deploy "obviously worked": it
refuses a force-pushed branch (`--ff-only`), waits for the new container to
report **healthy** — the api container and the web container both — hits
`/health/ready` through the api container to prove the app can reach its
database, stamps the git commit into `APP_VERSION` so Sentry reports name the
release, and prunes the dangling image layers that otherwise fill the disk one
rebuild at a time. Any failure dumps the migrate, api and web logs and exits
non-zero.

## Log rotation for the cron logs

Docker's own logs are capped by the `json-file` options in each compose file.
The two cron logs are plain files and are not:

```
# /etc/logrotate.d/vps-cron
/var/log/pg-backup.log /var/log/pg-prune.log {
    weekly
    rotate 8
    compress
    missingok
    notifempty
}
```

## Deploys are not zero-downtime, and that is fine

`docker compose up -d --build` stops the old api container before the new one
is healthy, so there is a gap of a few seconds. The readiness drain in
`src/server.ts` is written for a load balancer with somewhere else to send
traffic, and with one container there isn't one — what the drain still buys you
is that in-flight requests finish instead of being reset.

For side projects at this scale, a few seconds on deploy is the right trade
against the complexity of blue/green. If it ever stops being the right trade,
the change is: run two api replicas with distinct aliases, put both in the
Caddy upstream, and turn on `health_uri /health/ready` (see the note at the
bottom of the Caddyfile for why it is off today). At that point the in-memory
rate limiter also needs to move to Redis — see the root README.
