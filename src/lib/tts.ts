import { TextToSpeechClient } from "@google-cloud/text-to-speech";
import { config } from "../config/index.ts";

/**
 * ============================================================================
 * The one place this project names a Cloud TTS voice, API surface or encoding.
 * ============================================================================
 *
 * Same shape as src/lib/gemini.ts and for the same reason: docs/SPEC.md section
 * g lists an API renamed mid-hackathon as a live risk, and a single module means
 * that is one constant and one deploy rather than a search across call sites in
 * the last week.
 *
 * The rule that holds throughout: this module shells out to Google and returns
 * bytes plus what they cost. Every decision about WHAT to say — which markup,
 * which rate, where the pauses go — lives in
 * src/modules/localize/synthesize.stage.ts, so those decisions are pure,
 * readable and testable without a credential. That is the same split as
 * lib/ffmpeg.ts (parse) versus modules/localize/acoustics.ts (interpret).
 */

/** Verified 2026-09-08 via listVoices(): 46 hi-IN voices, Chirp 3 HD and Neural2. */
export const TTS_LANGUAGE_CODE = "hi-IN";

/** From config, so a voice swap is an env change. docs/research.md has the list. */
export const TTS_VOICE = config.tts.voice;

/**
 * The full-SSML fallback named in docs/SPEC.md section b and research.md.
 *
 * Only reached if the Phase 3 spike shows Chirp 3 HD ignoring prosody markup AND
 * that turns out to matter. It is here rather than in config because it is not
 * an operator's knob — it is a documented escape hatch with a measurement
 * attached, and switching to it changes what the demo sounds like.
 */
export const TTS_FALLBACK_VOICE = "hi-IN-Neural2-D";

/**
 * Chirp 3 HD's documented range (docs/research.md, Cloud TTS Chirp 3 HD page).
 *
 * AdaptedSegment.ttsHints.speakingRate is already constrained to 0.7-1.3 by its
 * Zod schema, which sits comfortably inside this. Both bounds exist anyway: the
 * schema bound is a statement about what a sensible teaching pace is, this one
 * is a statement about what the API accepts, and conflating them would mean a
 * future widening of the first silently produces 400s from the second.
 */
export const MIN_SPEAKING_RATE = 0.25;
export const MAX_SPEAKING_RATE = 2.0;

/**
 * What we send and how Google should read it.
 *
 * A discriminated union rather than three optional fields because the API's own
 * `input` is a oneof — setting two is not "more information", it is an error —
 * and because the Phase 3 spike exists precisely to find out which of these
 * `ssml` actually survives on Chirp 3 HD. Making the mode explicit at every call
 * site means the spike and the stage share one code path.
 */
export type TtsInput =
  | { mode: "text"; content: string }
  | { mode: "markup"; content: string }
  | { mode: "ssml"; content: string };

export interface SynthesizeOptions {
  input: TtsInput;
  /** Defaults to config.tts.voice. The spike overrides it to compare voices. */
  voice?: string;
  /** Omit to leave the API at its own default of 1.0. */
  speakingRate?: number;
}

export interface SynthesizeResult {
  audio: Buffer;
  latencyMs: number;
  /**
   * Characters in the string actually sent, markup and tags included.
   *
   * Cloud TTS bills per character of the request, not per character of speech,
   * so this is the billable figure rather than a count of the Hindi. A markup
   * string is longer than the sentence it wraps and it costs more; recording the
   * count of the thing we sent is the only version of this number that is true.
   */
  billedChars: number;
  voice: string;
  /** What was actually applied after clamping, for the audit trail. */
  speakingRate: number;
}

let client: TextToSpeechClient | null = null;

/**
 * Lazily built, so importing this module never requires a credential.
 *
 * The client itself does not resolve ADC until the first RPC, which means a
 * missing credential surfaces as a gRPC UNAUTHENTICATED from three frames deep.
 * synthesize() below translates that; this factory exists to keep the singleton
 * out of the call sites, matching getGeminiClient().
 */
export function getTtsClient(): TextToSpeechClient {
  if (client) return client;
  client = new TextToSpeechClient();
  return client;
}

/** Into the range the API documents. Exported so the stage can report clamping. */
export function clampSpeakingRate(rate: number): number {
  return Math.min(MAX_SPEAKING_RATE, Math.max(MIN_SPEAKING_RATE, rate));
}

/**
 * Turns an ADC failure into an instruction.
 *
 * Measured 2026-09-08: Cloud TTS rejects API keys outright — `voices.list` with
 * the AI Studio key returns 401 CREDENTIALS_MISSING, "API keys are not supported
 * by this API". So the failure mode a contributor hits is not a typo'd key, it
 * is having no ADC at all, and the fix is a specific command rather than a
 * different value in .env. gemini.ts names the AI Studio URL for the same
 * reason.
 */
function explainAuthFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const isAuth =
    /UNAUTHENTICATED|PERMISSION_DENIED|could not load the default credentials|API keys are not supported/i.test(
      message
    );

  if (!isAuth) return error instanceof Error ? error : new Error(message);

  return new Error(
    "Cloud Text-to-Speech rejected the credentials. It does NOT accept the " +
      "GEMINI_API_KEY — measured 2026-09-08, an API key returns 401 " +
      "CREDENTIALS_MISSING — so it needs Application Default Credentials:\n\n" +
      "  gcloud auth application-default login\n" +
      "  gcloud auth application-default set-quota-project <PROJECT_ID>\n" +
      "  gcloud services enable texttospeech.googleapis.com\n\n" +
      `Underlying error: ${message}`
  );
}

/**
 * One synthesis call, in, out, and costed.
 *
 * LINEAR16 rather than MP3, deliberately, and this is not a preference. The
 * pipeline synthesizes per segment and concatenates, and MP3 carries encoder
 * padding at every frame boundary: concatenating eight of them yields audible
 * clicks and a file whose duration is not the sum of its parts. Phase 3's whole
 * point is measuring real durations to replace an estimate, so a container that
 * quietly adds milliseconds at each join would corrupt the one number this phase
 * exists to produce. WAV throughout, one MP3 encode at the very end.
 */
export async function synthesize(
  options: SynthesizeOptions
): Promise<SynthesizeResult> {
  const { input, voice = TTS_VOICE, speakingRate } = options;

  const rate = speakingRate === undefined ? 1.0 : clampSpeakingRate(speakingRate);

  const startedAt = performance.now();

  let response;
  try {
    [response] = await getTtsClient().synthesizeSpeech({
      input: { [input.mode]: input.content },
      voice: { languageCode: TTS_LANGUAGE_CODE, name: voice },
      audioConfig: { audioEncoding: "LINEAR16", speakingRate: rate },
    });
  } catch (error) {
    throw explainAuthFailure(error);
  }

  const latencyMs = Math.round(performance.now() - startedAt);
  const audioContent = response.audioContent;

  if (audioContent === null || audioContent === undefined) {
    throw new Error(
      `Cloud TTS returned no audioContent for voice ${voice} in ${input.mode} mode. ` +
        "The request was accepted but produced nothing, which usually means the " +
        "input was empty after markup was stripped."
    );
  }

  return {
    audio: Buffer.from(audioContent as Uint8Array),
    latencyMs,
    billedChars: input.content.length,
    voice,
    speakingRate: rate,
  };
}

/**
 * The voice catalogue for a locale. Free and read-only.
 *
 * Used as the credential preflight: a stage that is about to spend money on
 * eight synthesis calls should find out that ADC is missing from a call that
 * costs nothing, rather than halfway through the run.
 */
export async function listVoices(
  languageCode: string = TTS_LANGUAGE_CODE
): Promise<string[]> {
  try {
    const [response] = await getTtsClient().listVoices({ languageCode });
    return (response.voices ?? [])
      .map((entry) => entry.name)
      .filter((name): name is string => typeof name === "string")
      .sort();
  } catch (error) {
    throw explainAuthFailure(error);
  }
}
