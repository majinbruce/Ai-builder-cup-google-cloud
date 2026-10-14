import { WordFilm } from "@/components/auth/word-film";

/**
 * The shell every auth screen shares: the flower film between the rails, and
 * the form in an ink panel on its right. The pages inside keep their shadcn
 * cards and fields; `.nua-auth` in globals.css restyles them to the design.
 *
 * A route GROUP: `(auth)` is parentheses, so it contributes a layout without
 * contributing a URL segment. The pages inside it are /sign-in and /sign-up,
 * not /auth/sign-in.
 */
export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="nua-page min-h-dvh pt-[calc(var(--nav-space)+24px)] pb-[3vw]">
      <div className="relative mx-(--rail) grid min-h-[max(640px,calc(100dvh-var(--nav-space)-24px-3vw))] border border-t-0 border-cream/16 md:grid-cols-[minmax(0,1fr)_minmax(380px,36vw)]">
        <div className="absolute -bottom-1 -left-1 z-3 size-[7px] bg-cream" />
        <div className="absolute -right-1 -bottom-1 z-3 size-[7px] bg-cream" />
        <div className="relative hidden md:block">
          <WordFilm />
        </div>
        <div className="nua-auth relative z-2 flex flex-col justify-end border-cream/16 bg-ink/90 p-[max(24px,3.9vw)] md:border-l">
          {children}
        </div>
      </div>
    </div>
  );
}
