/**
 * What the product runs on, for the reader who wants to know how much of it is
 * real. Every name here is load-bearing in the pipeline, not a logo wall.
 */
export function SiteFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-6 text-xs text-muted-foreground">
        <p>
          Built for the AI Builder Cup by Google. Gemini listens, adapts and critiques;
          Cloud Text-to-Speech speaks; it all runs on Cloud Run.
        </p>
        <p>English to Hindi, with the reasoning shown.</p>
      </div>
    </footer>
  );
}
