import { Skeleton } from "@/components/ui/skeleton";

/**
 * The fallback shown while a route segment's server components are still
 * rendering. Its presence is what makes navigation feel instant: Next.js sends
 * this immediately and streams the real page in behind it.
 */
export default function Loading() {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4 px-4 py-10">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-72" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}
