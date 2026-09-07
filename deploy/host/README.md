# Shared host infrastructure — extract this to its own repo

**This directory does not belong to this project.** It configures the VPS
itself, and there is exactly ONE of it per box no matter how many projects run
there. It ships inside the boilerplate only so that you have it on day one,
before there is anywhere else to put it.

The second time you clone this boilerplate, you will have two copies of this
directory and only one of them can be true. That is the problem this file
exists to prevent, and the fix takes about a minute:

```bash
# Once, from your FIRST project clone:
mkdir ~/vps-infra && cp -r deploy/host/. ~/vps-infra/
cd ~/vps-infra && git init && git add . && git commit -m "VPS infrastructure"
# push it somewhere

# Then, in every project clone including this one:
git rm -r --cached deploy/host && rm -rf deploy/host
echo "deploy/host/" >> .gitignore
```

Afterwards `deploy/README.md` stays — it documents the **per-project** contract
(`PROJECT_SLUG`, `TRUST_PROXY`, the `edge` network, the backup labels), which
genuinely is different in every clone and belongs with the project.

## Why not just leave it here and ignore the copies?

Because the copies are not inert. The file that actually runs is
`/srv/edge/Caddyfile` on the server, and the moment you add project #2 you will
edit it there. Now the repo copy is stale. Six months later you clone the
boilerplate for project #5, see `deploy/host/caddy/Caddyfile` listing two
projects that are not the two on the box, and have to work out which of five
checked-in copies — if any — matches production. Configuration that is
duplicated is configuration that drifts, and drift in the file that terminates
your TLS is the kind you find out about at renewal time.

One repo, one copy, one history of changes to your edge.

## What is in here

| Path          | What it is                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `caddy/`      | The shared reverse proxy. One container, all TLS, all projects.                                                                        |
| `backup/`     | Nightly `pg_dump` of every project on the box, offsite sync, and the restore script.                                                   |
| `monitoring/` | Uptime checks and the backup dead-man's switch. Mostly setup instructions — the monitoring itself is deliberately external to the box. |

Setup instructions for all three are in `deploy/README.md` in any project clone,
under "One-time host setup".
