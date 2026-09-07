import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * Prompts are files on disk, never string literals in the code that calls the
 * model.
 *
 * The reason is versioning. A prompt is the part of this system most likely to
 * change and hardest to review: an inline template literal edited in a service
 * shows up in a diff as an unreadable wall, and two stages that drifted apart
 * are invisible. As files under src/prompts/<stage>.v<n>.md they diff cleanly,
 * a new version is a new file rather than an edit, and the version that
 * produced a saved fixture output is recoverable from git.
 *
 * Resolved from process.cwd(), NOT import.meta.dirname. The build compiles
 * src/**\/*.ts to dist/ and the .md files are not compiled at all, so relative
 * to this module they would be one directory up in development and somewhere
 * else entirely in the image. The Dockerfile copies src/prompts to
 * /app/src/prompts alongside dist/, and cwd is /app in both stages — so cwd is
 * the one anchor that means the same thing everywhere.
 */

const PROMPT_DIR = path.join(process.cwd(), "src", "prompts");

const cache = new Map<string, string>();

/**
 * Reads src/prompts/<name>.md once and memoizes it.
 *
 * @param name Prompt name including its version, without the extension —
 *             e.g. "analyze.v1". The version is part of the name so that
 *             bumping it is a deliberate edit at the call site.
 */
export function loadPrompt(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const file = path.join(PROMPT_DIR, `${name}.md`);

  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch {
    // A typo'd prompt name is otherwise a model call with an empty system
    // prompt, which does not throw — it just returns worse output for the rest
    // of the hackathon. Listing what IS there turns that into a one-line fix.
    const available = fs
      .readdirSync(PROMPT_DIR)
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => entry.replace(/\.md$/, ""))
      .join(", ");

    throw new Error(
      `Prompt "${name}" not found at ${file}. Available prompts: ${available || "(none)"}`
    );
  }

  const trimmed = contents.trim();
  if (trimmed.length === 0) {
    throw new Error(`Prompt "${name}" at ${file} is empty.`);
  }

  cache.set(name, trimmed);
  return trimmed;
}
