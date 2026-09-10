import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * The landing page. Functional copy and two ways in: the public demo job,
 * which needs no account, and the upload flow behind sign-in. The designer
 * owns the visual treatment; this states what the product is.
 */
export default function LandingPage() {
  return (
    <div className="mx-auto flex min-h-[calc(100dvh-3.5rem)] max-w-5xl items-center px-4">
      <section className="grid w-full max-w-2xl gap-6 py-24">
        <h1 className="text-4xl font-semibold tracking-tight text-balance">
          Localize a lecture without losing the teaching.
        </h1>
        <p className="text-lg text-muted-foreground text-pretty">
          Upload English educational audio. Gemini listens for what the teacher defined,
          stressed, warned about and recapped, re-teaches it in Hindi, critiques its own
          work blind, and speaks it with the pacing the original had — and every
          non-literal choice comes with its reasoning, so you can check the
          machine&rsquo;s judgment.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href="/demo">See the demo</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/localize">Localize a clip</Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
