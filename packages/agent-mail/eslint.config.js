// Flat config. Versions are pinned exactly in package.json on purpose: a linter's
// default rule set drifts between releases, and an unpinned linter turns every
// upstream publish into a red CI on unchanged code (see CHANGELOG "Fixed (CI)").
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    rules: {
      // Unused code is the failure this gate is actually for; everything else
      // that `tsc --strict` already proves is left to tsc.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
      // ESLint 10 added these to its recommended preset. Keep this
      // security-only toolchain update behavior-neutral; adopt them in a
      // separate code-quality change with focused review.
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
    },
  },
  {
    // Tests reach into internals and build deliberately malformed payloads.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
