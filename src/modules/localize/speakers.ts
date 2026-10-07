import type { Analysis, AnalyzedSegment, Speaker } from "./localize.schemas.ts";

/**
 * ============================================================================
 * Who is speaking, and which voice says their Hindi.
 * ============================================================================
 *
 * Stage 1 lists the distinct voices in a clip and names one per segment. Two
 * stages read that: stage 2 writes Hindi whose grammar agrees with the person
 * speaking, and stage 4 casts a voice for each of them. Both go through the
 * lookups here, so "the analysis does not say" — every job from before
 * 2026-10-07, and any segment naming a speaker the model never listed — means
 * the same thing in both places: no claim, default behaviour.
 *
 * Pure, like the other modules beside it that hold the model's output up
 * against something.
 */

type WithSpeakers = Pick<Analysis, "speakers">;

/** The speaker of a segment, or undefined when the analysis does not say. */
export function speakerOf(
  analysis: WithSpeakers,
  segment: Pick<AnalyzedSegment, "speaker">
): Speaker | undefined {
  if (segment.speaker === undefined) return undefined;
  return analysis.speakers?.find((speaker) => speaker.id === segment.speaker);
}

/**
 * The speaker who talks for longest: the one the brief's `instructorPersona`
 * describes. Undefined when no segment names a listed speaker.
 */
export function mainSpeaker(
  analysis: WithSpeakers & { segments: readonly AnalyzedSegment[] }
): Speaker | undefined {
  const spoken = new Map<string, number>();
  for (const segment of analysis.segments) {
    const speaker = speakerOf(analysis, segment);
    if (speaker === undefined) continue;
    spoken.set(
      speaker.id,
      (spoken.get(speaker.id) ?? 0) + Math.max(0, segment.endSec - segment.startSec)
    );
  }

  let main: Speaker | undefined;
  let longest = 0;
  for (const speaker of analysis.speakers ?? []) {
    const total = spoken.get(speaker.id) ?? 0;
    if (total > longest) {
      main = speaker;
      longest = total;
    }
  }
  return main;
}

/** The voices a speaker can be cast from, by how their own voice sounds. */
export interface VoicePools {
  female: readonly string[];
  male: readonly string[];
  /** For a speaker stage 1 could not place, and for a job with no speakers. */
  fallback: string;
}

/**
 * One voice per speaker, by speaker id. Pure.
 *
 * In the order the speakers are first heard, each takes the first voice of its
 * own kind that nobody has yet: a woman and a man get one voice each, and two
 * women get two different ones. Only when a pool runs out does a voice repeat —
 * a third man in a clip sounds like the first, which is wrong, and still better
 * than giving him a woman's voice.
 */
export function castVoices(
  speakers: readonly Speaker[],
  pools: VoicePools
): Map<string, string> {
  const cast = new Map<string, string>();
  const taken = new Set<string>();

  for (const speaker of speakers) {
    if (cast.has(speaker.id)) continue;

    const candidates =
      speaker.voice === "female"
        ? pools.female
        : speaker.voice === "male"
          ? pools.male
          : // Could not tell: the default, or failing that anything unused.
            [pools.fallback, ...pools.male, ...pools.female];

    const voice =
      candidates.find((name) => !taken.has(name)) ?? candidates[0] ?? pools.fallback;
    cast.set(speaker.id, voice);
    taken.add(voice);
  }

  return cast;
}
