import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // One-off conversion script — CJS require() is intentional here.
    "src/scripts/**",
  ]),

  // ─── Day-one permissive overrides ────────────────────────────────────────
  // The rules below produce errors on the existing (upstream) codebase.
  // Downgraded to warn or off so CI isn't blocked on day one.
  // Tighten these incrementally as the team cleans up the code.
  {
    rules: {
      // Existing code calls setState() synchronously inside useEffect bodies
      // in many places.  This is a React anti-pattern but not a bug; warn
      // rather than error so we can fix gradually.
      "react-hooks/set-state-in-effect": "warn",

      // Several components read ref.current inside a dependency array or
      // before the ref is declared.  Warn only for now.
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",

      // Existing code uses `any` in places — same policy as the backend.
      "@typescript-eslint/no-explicit-any": "off",

      // Unescaped apostrophes / quotes in JSX (e.g. don't, "value").
      // Warn rather than error; easy to fix but not a correctness issue.
      "react/no-unescaped-entities": "warn",

      // CJS require() is used in a few places (scripts, conditional imports).
      "@typescript-eslint/no-require-imports": "off",

      // Existing code assigns a component to a local variable inside render
      // (e.g. const Icon = getIcon(); <Icon />).  Warn only — this is a
      // real anti-pattern (state resets each render) but not a crash.
      "react-hooks/static-components": "warn",
    },
  },
]);

export default eslintConfig;
