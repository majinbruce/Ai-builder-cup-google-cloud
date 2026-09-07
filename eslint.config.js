import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // `web/**` is the Next.js app: a separate npm project with its own flat
  // config, its own plugins and its own tsconfig. Linting it from here would
  // apply the API's type-aware rules against a tsconfig that does not include
  // those files — which crashes the React plugin rather than reporting
  // anything. Run `npm run lint` inside web/ instead; CI has a job for it.
  { ignores: ["dist/**", "node_modules/**", "logs/**", "web/**"] },
  eslint.configs.recommended,

  // Type-aware linting: these rules read the type checker, which is what
  // catches the real bugs (floating promises, unsafe `any` propagation).
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // An un-awaited promise in a request handler is a silent 500 with no
      // stack trace. This rule is the single highest-value one here.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "error",
      /**
       * Fastify's plugin and hook signatures are async by contract — the
       * framework awaits what they return — so a plugin that happens not to
       * await anything today is correct, not a mistake.
       */
      "@typescript-eslint/require-await": "off",
    },
  },

  // Config files are plain JS and are not in the TypeScript program, so the
  // type-aware rules have nothing to read for them.
  {
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  }
);
