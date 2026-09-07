/**
 * The container's liveness probe, and deliberately the dullest route here.
 *
 * It touches nothing — no session, no API call, no database. That is the whole
 * point: it answers "is this Node process serving HTTP", which is the only
 * question `docker stop`/`restart: unless-stopped` can act on. A probe that
 * called the API would mark this container unhealthy during an API outage and
 * restart a process that was working perfectly.
 *
 * `force-dynamic` because a probe that was answered from a build-time cache
 * proves nothing.
 *
 * It is NOT reachable from the internet: Caddy routes /api/* to the API and
 * everything else here, and the site block returns 404 for this path.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" });
}
