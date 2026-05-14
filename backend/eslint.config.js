// Flat ESLint config for the backend (ESLint v9+ format).
//
// Intentionally permissive on day one so CI doesn't block on existing
// code style choices.  Tighten rules over time as the team agrees.
//
// To run locally:  npm run lint
// To autofix:      npx eslint . --fix

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "*.config.js",
      "*.config.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Existing code uses `any` in places — don't fail CI over it.
      // Re-enable as warn or error once the codebase is cleaned up.
      "@typescript-eslint/no-explicit-any": "off",

      // Ignore unused vars/args that start with `_`.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Allow `catch (e) {}` patterns where the error is intentionally swallowed.
      "no-empty": ["warn", { allowEmptyCatch: true }],

      // `require()` is sometimes needed for conditional/dynamic loads.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // Test files have looser rules — mocks and fixtures often use `any`,
    // unused params, etc.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
