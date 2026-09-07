# Knowing when it breaks

Sentry is already wired into the app (`src/instrument.ts`), and it is very good
at one thing: telling you that a request threw. It is structurally incapable of
telling you about the outages that matter most, because all of them stop the
process that would have reported them:

| Failure                            | Sentry sees it            | What does                       |
| ---------------------------------- | ------------------------- | ------------------------------- |
| Unhandled exception in a route     | yes                       | Sentry                          |
| Container crash-looping            | no                        | uptime check                    |
| Postgres down / disk full          | no — the app can't report | uptime check on `/health/ready` |
| VPS off, network gone, TLS expired | no                        | external uptime check           |
| Backups silently stopped           | no                        | dead-man's switch               |

Everything below is the second column. It is deliberately all **external** to
the box: a monitor that runs on the machine it is monitoring reports nothing at
all in the one case you care most about.

## 1. Uptime check per project

Any of UptimeRobot (free, 5-minute interval), Better Stack, or Healthchecks.io
will do. Per project:

- **URL:** `https://proj1.example.com/health/ready`
- **Interval:** 1–5 minutes
- **Alert after:** 2 consecutive failures — one failed poll during a deploy is
  normal and paging on it trains you to ignore the pager
- **Expected:** HTTP 200

**That path is blocked by default.** `api_defaults` in the Caddyfile answers
`/health/*` with a 404, because the probe is for the orchestrator and
`/health/ready` runs a database query per hit with rate limiting deliberately
disabled — a free amplification target if left open to the internet. To let a
monitor through, replace that `respond @health 404` with a `remote_ip` matcher
listing the monitor's published addresses:

```caddyfile
@health_public {
	path /health/*
	remote_ip 1.2.3.4 5.6.7.8      # your monitor's egress ranges
}
@health_blocked {
	path /health/*
	not remote_ip 1.2.3.4 5.6.7.8
}
respond @health_blocked 404
```

Every provider publishes its egress ranges; UptimeRobot and Better Stack both
do. If you would rather not maintain that list, monitor the frontend origin
(`https://proj1.example.com/`) for a 200 instead — it proves Caddy, TLS and the
web container, but not that the API can reach its database, which is the whole
reason `/health/ready` exists.

### Why `/health/ready` and not `/health/live`

They answer different questions, and picking the wrong one gives you a monitor
that is confidently wrong.

`/health/live` only asks "is the process running". It deliberately checks
nothing external, so it returns 200 from a container whose database has been
unreachable for an hour. Monitoring it tells you the box is on.

`/health/ready` checks the database and reports 503 when it is down — and also
during the shutdown drain, which is what makes deploys legible: you will see a
short blip, and it means the graceful shutdown in `src/server.ts` worked
exactly as designed.

Alert on `/health/ready`. Two consecutive failures is the threshold that
distinguishes "deploying" from "down".

### TLS expiry

Point the check at `https://`, and enable the SSL-expiry alert if your provider
has one. Caddy renews automatically and this should never fire — which is
precisely why it is worth having. The renewal failure you find out about from a
monitor is an inconvenience; the one you find out about from a user is an
outage.

## 2. Dead-man's switch for the backup

Set up in `deploy/host/backup/pg-backup.env.example`. The idea is worth stating
plainly because it is the opposite of how monitoring usually works:

A cron job that fails sends mail to a local mailbox nobody reads. A cron job
that _stops running_ — because the disk filled, or someone edited the crontab,
or the script was moved — produces no output whatsoever. That silence is
indistinguishable from a successful backup if you are only watching for errors.

A dead-man's switch inverts it. `pg-backup.sh` pings healthchecks.io on
success; healthchecks.io alerts when the ping does not arrive on schedule.
Silence becomes the alarm.

Create the check with **period 1 day, grace 6 hours** (the backup runs at 03:30
UTC; the grace covers a slow upload without paging you at 04:00).

## 3. Restore drill

Not monitoring, but it belongs on the same list, because it is the check that
actually validates the backups:

```bash
/srv/edge/backup/pg-restore.sh proj1
```

Do it once against a throwaway project now. `pg-backup.sh` verifies every dump
is a readable archive, which catches truncation — it does not prove you can
drive the restore under pressure. Put a reminder in the calendar for six months
out and do it again.

## What is deliberately not here

No Prometheus, no Grafana, no metrics pipeline. At 10k users per project the
question you need answered is "is it up and are the backups running", and both
have a free answer. A metrics stack on this box would consume more of your
attention than the services it watches. Add one when you have a performance
question you cannot answer from Sentry and the slow-query log in
`src/plugins/db.ts` — not before.
