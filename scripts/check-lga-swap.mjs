#!/usr/bin/env node
/**
 * Swap-lint for the LOGMAS backend (see LGA_ONBOARDING_BACKEND.md).
 *
 * Fails (exit 1) when traces of ANOTHER Local Government Area remain in the
 * code or the services data. Run it after cloning this repo for a new LGA.
 *
 * Usage:
 *   node scripts/check-lga-swap.mjs            # active LGA from LGA_ID env (default: ijebu-north-east)
 *   LGA_ID=kosofe node scripts/check-lga-swap.mjs
 *   EXTRA_TOKENS="ward-name" node scripts/check-lga-swap.mjs
 *
 * Allowlisted (may legitimately mention LGAs):
 *   src/config/lga.config.ts   — presets for known LGAs
 *   prisma/migrations/**       — historical DDL
 *   .env.example, this script, and the onboarding docs
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ─── Active LGA (same contract as src/config/lga.config.ts / seed.ts) ────────
const activeId = (process.env.LGA_ID || "ijebu-north-east").trim().toLowerCase();
const activeName = (process.env.LGA_NAME || activeId).trim().toLowerCase();
const activeTokens = [activeId, activeName];

// Baseline of LGA identities this codebase has ever shipped with, plus extras.
const KNOWN_LGA_TOKENS = ["odeda", "odedalga"];
const extra = (process.env.EXTRA_TOKENS || "")
  .split(",")
  .map((t) => t.trim().toLowerCase())
  .filter(Boolean);

const foreignTokens = [...new Set([...KNOWN_LGA_TOKENS, ...extra])].filter(
  (t) => !activeTokens.some((a) => a.includes(t) || t.includes(a)),
);

const ALLOWED = new Set([
  "src/config/lga.config.ts",
  // prisma/seed.ts falls back to the platform's default LGA id when LGA_ID
  // is unset (same contract as src/config/lga.config.ts) — that single
  // fallback line is legitimate; everything else in seed.ts stays scanned.
  "prisma/seed.ts",
  "scripts/check-lga-swap.mjs",
  ".env.example",
  "LGA_ONBOARDING_BACKEND.md",
  "LGA_CLONE_AND_ONBOARDING_GUIDE.md",
]);

const SKIP_DIRS = new Set(["node_modules", "dist", "out", ".git", "build"]);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) yield* walk(abs);
    else yield abs;
  }
}

function relPosix(abs) {
  return relative(ROOT, abs).split(sep).join("/");
}

const violations = [];

function scanTextFile(absPath, patterns) {
  const rel = relPosix(absPath);
  if (ALLOWED.has(rel)) return;
  if (rel.startsWith("prisma/migrations/")) return; // historical DDL
  const lines = readFileSync(absPath, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    const token = patterns.find((t) => line.toLowerCase().includes(t));
    if (token) {
      violations.push(`${rel}:${i + 1}  contains "${token}": ${line.trim().slice(0, 120)}`);
    }
  });
}

if (foreignTokens.length > 0) {
  for (const file of walk(join(ROOT, "src"))) {
    if (/\.(ts|tsx|js|jsx|json)$/.test(file)) scanTextFile(file, foreignTokens);
  }
  for (const file of walk(join(ROOT, "prisma"))) {
    if (/\.(ts|json)$/.test(file)) scanTextFile(file, foreignTokens);
  }
  const pkg = join(ROOT, "package.json");
  if (existsSync(pkg)) scanTextFile(pkg, foreignTokens);
}

console.log(`swap-lint: active LGA = "${activeName}" (${activeId})`);
if (foreignTokens.length === 0) {
  console.log("swap-lint: no foreign LGA tokens known for this active LGA — nothing to flag.");
} else {
  console.log(`swap-lint: foreign tokens checked: ${foreignTokens.join(", ")}`);
}

if (violations.length > 0) {
  console.error(`\n❌ swap-lint FAILED — ${violations.length} leftover(s) from another LGA:\n`);
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nFix: replace these with the active LGA's values (env vars, preset, or services JSON).",
  );
  process.exit(1);
}

console.log("✅ swap-lint passed — no foreign LGA traces outside the allowlist.");
