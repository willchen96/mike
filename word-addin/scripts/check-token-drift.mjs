#!/usr/bin/env node
/*
 * Design-token drift check: the add-in's tokens.css is a hand-maintained
 * subset of the web app's globals.css, and for years of one comment's
 * lifetime ("Keep values in sync with globals.css") nothing verified that
 * anyone did. This script is the mechanism that comment wished it was:
 * every custom property the ADD-IN declares (in `:root`, `.dark`, and
 * `@theme inline`) must exist in globals.css in the same scope with an
 * identical value. Web-only additions are fine (the add-in is a subset);
 * an add-in value that differs from — or no longer exists in — the web's
 * is a hard failure naming each drifted token.
 *
 * Runs as part of `npm run typecheck` (so `npm run build` and the
 * word-addin CI workflow both enforce it) and standalone via
 * `npm run check:tokens`.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ADDIN_TOKENS = resolve(here, "../src/shared/styles/tokens.css");
const WEB_GLOBALS = resolve(here, "../../frontend/src/app/globals.css");

// The scopes tokens.css duplicates from globals.css. Selector blocks the
// add-in does not duplicate (media queries, component classes) are out of
// scope.
const SCOPES = [
  [/:root\s*\{/g, ":root"],
  [/\.dark\s*\{/g, ".dark"],
  [/@theme inline\s*\{/g, "@theme inline"],
];

/**
 * Collect `--custom-property: value` declarations per scope. Multiple blocks
 * with the same selector are merged; the FIRST declaration of a property
 * wins, matching how the add-in's single-block files are written. Values are
 * whitespace-normalized so formatting differences don't count as drift.
 */
function parseTokens(path) {
  const css = readFileSync(path, "utf8");
  const tokens = new Map();
  for (const [pattern, scope] of SCOPES) {
    pattern.lastIndex = 0;
    for (const match of css.matchAll(pattern)) {
      let depth = 1;
      let i = match.index + match[0].length;
      while (depth > 0 && i < css.length) {
        if (css[i] === "{") depth += 1;
        else if (css[i] === "}") depth -= 1;
        i += 1;
      }
      const block = css.slice(match.index + match[0].length, i - 1);
      for (const decl of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        const key = `${scope} ${decl[1]}`;
        if (!tokens.has(key)) {
          tokens.set(key, decl[2].trim().replace(/\s+/g, " "));
        }
      }
    }
  }
  return tokens;
}

const addin = parseTokens(ADDIN_TOKENS);
const web = parseTokens(WEB_GLOBALS);

if (addin.size === 0) {
  console.error(`check-token-drift: parsed 0 tokens from ${ADDIN_TOKENS} — ` +
    "the parser no longer matches the file's structure; fix the check.");
  process.exit(1);
}

const problems = [];
for (const [key, addinValue] of addin) {
  if (!web.has(key)) {
    problems.push(`  ${key}\n    add-in: ${addinValue}\n    web:    (not defined)`);
  } else if (web.get(key) !== addinValue) {
    problems.push(`  ${key}\n    add-in: ${addinValue}\n    web:    ${web.get(key)}`);
  }
}

if (problems.length > 0) {
  console.error(
    `check-token-drift: ${problems.length} token(s) in word-addin/src/shared/styles/tokens.css ` +
      "have drifted from frontend/src/app/globals.css.\n" +
      "The web app is the source of truth — update the add-in values to match\n" +
      "(or, if the web token was removed, remove it from tokens.css):\n\n" +
      problems.join("\n"),
  );
  process.exit(1);
}

console.log(
  `check-token-drift: ${addin.size} add-in tokens match globals.css.`,
);
