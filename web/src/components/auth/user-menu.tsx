"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { LogOut, Settings, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import type { User } from "@/lib/api/schemas";

/**
 * Takes the user as a PROP rather than calling `useSession()`.
 *
 * The header already resolved the session on the server, so calling the hook
 * here would repeat that as a client fetch and render a skeleton for the round
 * trip. Passing it down means the correct name and avatar are in the first
 * HTML byte, and this component stays a leaf that is trivial to reuse.
 *
 * `useSession()` is still the right tool when a component needs to react to
 * the session CHANGING while the page is open.
 */
/**
 * `user.image` is whatever the identity provider handed back — for Google it is
 * an https URL, but the DTO types it as an arbitrary string, so only render it
 * when it is an absolute http(s) URL. Anything else (a `javascript:`/`data:`
 * scheme, a relative path pointing back at our own origin) falls through to the
 * initials, which is the safe default rather than a surprising `<img src>`.
 */
function safeImageSrc(image: string | null): string | undefined {
  if (image === null) return undefined;
  try {
    const url = new URL(image);
    return url.protocol === "https:" || url.protocol === "http:" ? image : undefined;
  } catch {
    return undefined;
  }
}

export function UserMenu({ user }: { user: User }) {
  const router = useRouter();

  const imageSrc = safeImageSrc(user.image);

  const initials = user.name
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const onSignOut = async () => {
    const { error } = await authClient.signOut();

    if (error) {
      toast.error("Could not sign out. Try again.");
      return;
    }

    // Same pairing as sign-in, for the same reason: the server components on
    // screen were rendered WITH a session and would keep showing it.
    router.refresh();
    router.push("/");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full">
          <Avatar className="size-8">
            {imageSrc === undefined ? null : <AvatarImage src={imageSrc} alt="" />}
            <AvatarFallback>{initials || "?"}</AvatarFallback>
          </Avatar>
          <span className="sr-only">Account menu</span>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="grid gap-0.5">
          <span className="truncate font-medium">{user.name}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">
            {user.email}
          </span>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Settings />
            Settings
          </Link>
        </DropdownMenuItem>

        {/* Rendering an admin link for a non-admin is a UI mistake, not a
            security hole — /api/v1/users is admin-guarded on the API and the
            page re-checks the role on the server. */}
        {user.role === "admin" ? (
          <DropdownMenuItem asChild>
            <Link href="/admin/users">
              <ShieldCheck />
              Admin
            </Link>
          </DropdownMenuItem>
        ) : null}

        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={onSignOut}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
