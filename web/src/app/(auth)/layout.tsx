/**
 * The shell every auth screen shares — one centred column, no navigation.
 *
 * A route GROUP: `(auth)` is parentheses, so it contributes a layout without
 * contributing a URL segment. The pages inside it are /sign-in and /sign-up,
 * not /auth/sign-in.
 */
export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="mx-auto flex min-h-[calc(100dvh-3.5rem)] w-full max-w-sm items-center px-4 py-12">
      <div className="w-full">{children}</div>
    </div>
  );
}
