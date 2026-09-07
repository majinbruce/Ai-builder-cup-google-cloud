"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * The root error boundary. Catches anything a server or client component threw
 * during render — including an `ApiError` from a failed server-side fetch.
 *
 * It MUST be a client component, and it must be tolerant: it renders while the
 * app is in a broken state, so it uses nothing that might be the thing that
 * broke. `digest` is the server-side error's id; the real stack is in the
 * server's log, never in this payload.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The browser console is the only reporter this boilerplate ships; point
    // it at Sentry (or whatever the API reports to) per project.
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto grid max-w-md gap-4 px-4 py-24 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">
        The page could not be loaded. Try again, and if it keeps happening the reference
        below will be in the server log.
      </p>
      {error.digest ? (
        <p className="font-mono text-xs text-muted-foreground">{error.digest}</p>
      ) : null}
      <div>
        <Button onClick={reset}>Try again</Button>
      </div>
    </div>
  );
}
