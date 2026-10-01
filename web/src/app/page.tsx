import Link from "next/link";
import { ArrowRight, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Highlight } from "@/components/localize/highlight";
import { LessonMap } from "@/components/localize/lesson-map";
import { SIGNAL_LABEL, SIGNAL_TONE } from "@/components/localize/format";
import { jobResponse } from "@/lib/api/localize";
import { apiFetchServer } from "@/lib/api/server";
import type { Job, PedagogicalSignal } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";

/**
 * The public demo job, or null. Any failure — none promoted yet, the API down —
 * degrades the landing page to its copy rather than to an error page: the
 * visitor can still read what the product does.
 */
async function loadDemo(): Promise<Job | null> {
  try {
    const { data } = await apiFetchServer("/api/v1/localize/demo", jobResponse);
    return data;
  } catch {
    return null;
  }
}

/** Moves that show the product's point best, most telling first. */
const SHOWCASE_ORDER: PedagogicalSignal[] = [
  "definition",
  "warning",
  "emphasis_shift",
  "key_term",
  "recap",
  "example",
];

/**
 * The one segment the hero shows: the most telling instructional move that has
 * both a stressed term and an explained adaptation choice, so the specimen
 * demonstrates all three things the product claims at once.
 */
function pickShowcase(job: Job) {
  const { analysis, adaptation, critique } = job;
  if (analysis === null || adaptation === null) return null;

  const candidates = analysis.segments
    .map((source) => ({
      source,
      adapted: adaptation.segments.find((segment) => segment.id === source.id),
      critique: critique?.segments.find((segment) => segment.id === source.id),
    }))
    // A regenerated segment's critique scored the draft it replaced, so its
    // scores would sit beside Hindi they were not given for.
    .filter(
      (entry) =>
        entry.adapted !== undefined && !(job.retriedIds ?? []).includes(entry.source.id)
    );

  const score = (entry: (typeof candidates)[number]) => {
    const rank = SHOWCASE_ORDER.indexOf(entry.source.signal);
    return (
      (rank === -1 ? 0 : (SHOWCASE_ORDER.length - rank) * 10) +
      (entry.source.emphasis.length > 0 ? 5 : 0) +
      ((entry.adapted?.choices.length ?? 0) > 0 ? 5 : 0)
    );
  };

  const best = [...candidates].sort((a, b) => score(b) - score(a))[0];
  if (best?.adapted === undefined) return null;
  return { ...best, adapted: best.adapted };
}

const STEPS = [
  {
    title: "Listen",
    body: "Gemini hears the lecture itself, not a transcript, and marks each stretch by what the teacher is doing: defining, giving an example, warning, recapping.",
    check:
      "Every stressed word the model claims is checked against ffmpeg's loudness and pause measurements.",
  },
  {
    title: "Plan",
    body: "Before translating a word, it writes a brief: who the teacher is, the register a Hindi classroom expects, and one glossary for the whole clip.",
    check:
      "The glossary says, per term, whether it was translated, transliterated or kept as English, and why.",
  },
  {
    title: "Re-teach",
    body: "Each segment is adapted in Hindi for intent, not word for word. Idioms become their Hindi equivalents; key terms stay stressed.",
    check:
      "A literal translation sits beside every adaptation, with a reason for each departure from it.",
  },
  {
    title: "Grade itself blind",
    body: "A separate Gemini call, which never sees the reasoning, back-translates the Hindi and scores it. Anything under 70 is rewritten once.",
    check:
      "The back-translation and both scores are shown, including for the drafts that failed.",
  },
  {
    title: "Speak",
    body: "Cloud Text-to-Speech voices it with Chirp 3 HD, at the pace of the original and with a pause before the word that matters.",
    check:
      "The exact markup sent to the voice is shown, and so is every stress it could not produce.",
  },
];

export default async function LandingPage() {
  const demo = await loadDemo();
  const showcase = demo === null ? null : pickShowcase(demo);
  const segments = demo?.analysis?.segments ?? [];

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-20 px-4 pt-14 pb-24 sm:pt-20">
      <section className="grid items-center gap-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        <div className="grid gap-6">
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Translate a lecture without losing the teaching.
          </h1>
          <p className="max-w-xl text-lg text-muted-foreground text-pretty">
            Upload an English lesson. Gemini finds where the teacher defines, stresses,
            warns and recaps, re-teaches it in Hindi with the same intent, grades its own
            work blind, and speaks it at the original&rsquo;s pace. Every choice it made
            comes with its reasoning.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href="/demo">
                <Play aria-hidden />
                Open the demo lecture
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/localize">Localize your own clip</Link>
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            The demo needs no account. Your own clip takes about four minutes.
          </p>
        </div>

        {showcase === null ? null : (
          <figure className="grid gap-3">
            <div className="grid gap-4 rounded-xl border bg-card p-5 shadow-sm">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span
                  className={cn(
                    "rounded-md px-2 py-0.5 font-medium",
                    SIGNAL_TONE[showcase.source.signal]
                  )}
                >
                  {SIGNAL_LABEL[showcase.source.signal]}
                </span>
                <span className="text-muted-foreground">
                  detected with {Math.round(showcase.source.signalConfidence * 100)}%
                  confidence
                </span>
              </div>
              <p className="leading-relaxed text-muted-foreground">
                <Highlight
                  text={showcase.source.text}
                  marks={showcase.source.emphasis.map((mark) => ({
                    term: mark.term,
                    title: mark.evidence,
                  }))}
                />
              </p>
              <p lang="hi" className="text-xl leading-relaxed">
                <Highlight
                  text={showcase.adapted.targetText}
                  marks={showcase.adapted.emphasisTerms.map((term) => ({
                    term,
                    title: "Stressed in the Hindi too",
                  }))}
                />
              </p>
              {showcase.critique === undefined ? null : (
                <div className="grid gap-1.5 border-l-2 border-primary/40 pl-3 text-sm">
                  <span className="text-muted-foreground">
                    Read back into English by a critic that never saw the reasoning:
                  </span>
                  <span className="italic">
                    &ldquo;{showcase.critique.backTranslation}&rdquo;
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    Fidelity {showcase.critique.fidelity}/100 · naturalness{" "}
                    {showcase.critique.naturalness}/100
                  </span>
                </div>
              )}
            </div>
            <figcaption className="text-xs text-muted-foreground">
              One segment of the demo lecture, exactly as the pipeline produced it.
            </figcaption>
          </figure>
        )}
      </section>

      {segments.length === 0 ||
      demo?.analysis === null ||
      demo?.analysis === undefined ? null : (
        <section className="grid gap-4" aria-labelledby="shape-heading">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="grid gap-1">
              <h2 id="shape-heading" className="text-xl font-semibold tracking-tight">
                The shape of a lesson
              </h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                {demo.analysis.topic}, as Gemini heard it: each band is one stretch of the
                lecture, coloured by what the teacher was doing.
              </p>
            </div>
            <Link
              href="/demo"
              className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
              Explore it
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
          <LessonMap segments={segments} />
        </section>
      )}

      <section className="grid gap-8" aria-labelledby="how-heading">
        <div className="grid gap-1">
          <h2 id="how-heading" className="text-xl font-semibold tracking-tight">
            Five steps, each one you can check
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            A translation you cannot inspect is a translation you have to trust. Each step
            leaves evidence on the page.
          </p>
        </div>
        <ol className="grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-5">
          {STEPS.map((step, index) => (
            <li key={step.title} className="grid content-start gap-2">
              <span className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-semibold tabular-nums text-primary-foreground">
                {index + 1}
              </span>
              <h3 className="font-semibold">{step.title}</h3>
              <p className="text-sm text-muted-foreground">{step.body}</p>
              <p className="text-sm">{step.check}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
