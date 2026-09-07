import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * The API's ESLint config and this one agree on the rules that are about
 * discipline rather than framework: no stray `console`, explicit `import type`,
 * no unused symbols. The rest comes from `eslint-config-next`, which carries
 * the rules only Next.js can know about (image usage, the client/server
 * boundary, `<Link>` vs `<a>`).
 */
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // The API forbids `console` because it has a real logger. Here the reason
      // is different but the rule is the same: a stray console.log in a server
      // component writes to the container's stdout on every request, and one in
      // a client component ships to every visitor's devtools. The error
      // boundary opts out explicitly.
      "no-console": ["error", { allow: ["warn", "error"] }],

      // `verbatimModuleSyntax` is on in tsconfig, so a type imported as a value
      // is emitted as a real import. This makes the fix automatic.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],

      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Vendored shadcn primitives. They are generated output that gets
    // overwritten by `npm run ui:add`, so house rules do not apply to them —
    // and a lint error in one is not something you can fix in place.
    files: ["src/components/ui/**"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
