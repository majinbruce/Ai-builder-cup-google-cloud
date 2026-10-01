import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type * as ConfigModule from "../src/config/index.ts";

/**
 * generateJson() against a stubbed SDK: what is sent, not what comes back.
 *
 * The network path is smoke-gemini.ts's job and cannot be mocked meaningfully.
 * What can be pinned here is the request this module builds — in particular the
 * per-call timeout, whose absence is invisible until a call hangs a job forever.
 */

const create = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    interactions = { create };
  },
}));

vi.mock("../src/config/index.ts", async (importOriginal) => {
  const { config } = await importOriginal<typeof ConfigModule>();
  return { config: { ...config, gemini: { ...config.gemini, apiKey: "test-key" } } };
});

const { generateJson } = await import("../src/lib/gemini.ts");

const reply = (text: string) => ({
  id: "i-1",
  status: "completed",
  output_text: text,
  usage: { total_input_tokens: 10, total_output_tokens: 5, total_thought_tokens: 2 },
});

describe("generateJson", () => {
  beforeEach(() => {
    create.mockReset();
  });

  it("sends a finite timeout, so a hung call cannot hold a job forever", async () => {
    create.mockResolvedValue(reply('{"ok":true}'));

    await generateJson({
      schema: z.object({ ok: z.boolean() }),
      prompt: "p",
      stage: "smoke",
    });

    const [, options] = create.mock.calls[0] as [unknown, { timeout?: number }];
    expect(options.timeout).toBeGreaterThan(0);
    expect(Number.isFinite(options.timeout)).toBe(true);
  });

  it("parses the reply with the schema and reports the call's cost", async () => {
    create.mockResolvedValue(reply('{"ok":true}'));

    const { data, call } = await generateJson({
      schema: z.object({ ok: z.boolean() }),
      prompt: "p",
      stage: "smoke",
    });

    expect(data).toEqual({ ok: true });
    expect(call).toMatchObject({ inputTokens: 10, outputTokens: 5, thoughtTokens: 2 });
  });

  it("fails rather than reporting zero cost when usage is missing", async () => {
    create.mockResolvedValue({ ...reply('{"ok":true}'), usage: undefined });

    await expect(
      generateJson({ schema: z.object({ ok: z.boolean() }), prompt: "p", stage: "smoke" })
    ).rejects.toThrow(/no token usage/);
  });
});
