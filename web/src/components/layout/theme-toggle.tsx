"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

/**
 * The theme switch, written so that it has no hydration problem to solve.
 *
 * The usual version of this component keeps a `mounted` flag and renders
 * nothing until an effect sets it, because `useTheme()` cannot know the
 * resolved theme during SSR — the answer lives in localStorage and in the OS
 * preference, neither of which exists on the server. That works, but it costs a
 * state update on every mount and an empty slot in the header until it lands.
 *
 * Instead: render BOTH icons and let CSS pick. The markup is identical on the
 * server and the client, so there is nothing to mismatch, and `.dark` on <html>
 * — which next-themes sets in a blocking inline script, before React hydrates —
 * has already decided which one is visible by the time the page paints.
 *
 * `resolvedTheme` is still read, but only inside the click handler, which by
 * definition runs after mount and therefore always sees the real value.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      <Moon className="dark:hidden" />
      <Sun className="hidden dark:block" />
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}
