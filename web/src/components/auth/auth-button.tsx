import Link from "next/link";
import { getSession } from "@/lib/auth-server";
import { UserMenu } from "@/components/auth/user-menu";

/**
 * The header's auth slot: "My videos" and an account menu when signed in, the
 * design's ink "Sign in" block when not. A SERVER component, so the right one
 * is in the initial HTML and there is no flash of "Sign in" for a signed-in
 * user.
 *
 * The cost is that `getSession()` reads cookies, which makes every route that
 * renders the header dynamic. That is the right default for an app behind a
 * login.
 */
export async function AuthButton() {
  const session = await getSession();
  const block =
    "flex h-[max(42px,3.3vw)] items-center bg-ink px-[max(16px,1.4vw)] text-[max(14px,1.05vw)] font-medium whitespace-nowrap text-cream transition-opacity hover:opacity-85 nua-focus";

  if (session) {
    return (
      <div className="flex items-center gap-[max(6px,0.5vw)]">
        <Link href="/localize" className={block}>
          My videos
        </Link>
        <UserMenu user={session.user} />
      </div>
    );
  }

  return (
    <Link href="/sign-in" className={block}>
      Sign in
    </Link>
  );
}
