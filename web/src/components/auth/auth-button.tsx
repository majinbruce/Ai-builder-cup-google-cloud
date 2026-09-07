import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/auth-server";
import { UserMenu } from "@/components/auth/user-menu";

/**
 * The header's auth slot: an avatar menu when signed in, a pair of links when
 * not. A SERVER component, so the right one is in the initial HTML and there is
 * no flash of "Sign in" for a signed-in user.
 *
 * The cost is that `getSession()` reads cookies, which makes every route that
 * renders the header dynamic. That is the right default for an app behind a
 * login. If a project needs a statically rendered marketing page, move this
 * component's session read behind a Suspense boundary and turn on
 * `cacheComponents` — do not scatter `useSession()` through the header.
 */
export async function AuthButton() {
  const session = await getSession();

  if (session) {
    return <UserMenu user={session.user} />;
  }

  return (
    <div className="flex items-center gap-1.5">
      <Button asChild variant="ghost" size="sm">
        <Link href="/sign-in">Sign in</Link>
      </Button>
      <Button asChild size="sm">
        <Link href="/sign-up">Get started</Link>
      </Button>
    </div>
  );
}
