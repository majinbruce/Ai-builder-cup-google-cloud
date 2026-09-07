import { defineConfig } from "vitest/config";

/**
 * The frontend's own test config — deliberately present so vitest does NOT walk
 * up and inherit the API's `vitest.config.ts` at the repo root. The two projects
 * are independent (separate package.json, tsconfig, eslint); their test setups
 * are too. Without this file, running vitest here picks up the API's `unit` /
 * `integration` projects, whose `include` globs point at `test/` and find
 * nothing under `web/`.
 *
 * Tests are colocated as `src/**\/*.test.ts`. The default `node` environment is
 * right for the pure utilities tested so far; add `environment: "jsdom"` (and
 * the dependency) if a component test ever needs the DOM.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
