// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/check-test-filters`
 * Purpose: Prove every `--filter <name>` in the root `test` script names a real workspace package that actually has a `test` script.
 * Scope: Static manifest + workspace-glob analysis. Does not run any test, build anything, or touch a database.
 * Invariants:
 *   - The filter list is PARSED out of the root `test` script itself, never duplicated here — a second copy would drift from the thing it guards.
 *   - A filter matching no package fails: `pnpm --filter <missing> test` exits 0 with "No projects matched", so the suite silently stops running.
 *   - A filter matching a package with no `test` script fails for the same reason: `--if-present` semantics would make it a no-op.
 *   - This script runs FIRST in the root `test` chain, so the trap is unreachable rather than merely documented.
 * Side-effects: IO (reads package manifests + pnpm-workspace.yaml).
 * Links: package.json, pnpm-workspace.yaml, .github/workflows/ci.yaml
 */

// biome-ignore-all lint/suspicious/noConsole: validator script

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const rootPkg = readJson(join(REPO_ROOT, "package.json"));
const testScript = rootPkg?.scripts?.test;
if (typeof testScript !== "string" || testScript.length === 0) {
  console.error("check-test-filters: root package.json declares no `test` script");
  process.exit(1);
}

// Parse the filters out of the guarded script itself. Single source of truth:
// adding a filter to `test` is what adds it here.
const filters = [...testScript.matchAll(/--filter\s+(\S+)/g)].map((m) =>
  m[1].replace(/^["']|["']$/g, "")
);
if (filters.length === 0) {
  console.error(
    "check-test-filters: root `test` script declares no `--filter` targets -- " +
      "the suite would run nothing while exiting 0"
  );
  process.exit(1);
}

// Resolve the workspace globs the same way pnpm does, limited to the shapes this
// repo uses ("app", "graphs", "packages/*").
const workspace = parse(readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8"));
const patterns = Array.isArray(workspace?.packages) ? workspace.packages : [];
if (patterns.length === 0) {
  console.error("check-test-filters: pnpm-workspace.yaml declares no packages");
  process.exit(1);
}

const dirs = [];
for (const pattern of patterns) {
  if (pattern.endsWith("/*")) {
    const parent = join(REPO_ROOT, pattern.slice(0, -2));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(parent, entry.name));
    }
    continue;
  }
  dirs.push(join(REPO_ROOT, pattern));
}

/** name -> has a `test` script */
const packages = new Map();
for (const dir of dirs) {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) continue;
  const pkg = readJson(manifest);
  if (typeof pkg?.name !== "string") continue;
  packages.set(pkg.name, typeof pkg?.scripts?.test === "string" && pkg.scripts.test.length > 0);
}

const problems = [];
for (const filter of filters) {
  if (!packages.has(filter)) {
    problems.push(
      `${filter}: matches no workspace package -- \`pnpm --filter\` exits 0 on "No projects matched", so this leg runs NOTHING`
    );
    continue;
  }
  if (!packages.get(filter)) {
    problems.push(
      `${filter}: workspace package exists but declares no \`test\` script -- this leg runs NOTHING`
    );
  }
}

if (problems.length > 0) {
  console.error(
    "✗ check-test-filters: the root `test` script contains filters that run no tests:"
  );
  for (const problem of problems) console.error(`    ${problem}`);
  console.error(
    "\nFix: correct the package name in the root `test` script, or give the package a `test` script."
  );
  process.exit(1);
}

console.log(
  `✓ check-test-filters: all ${filters.length} root test filters resolve to a workspace package with a \`test\` script (${filters.join(", ")}).`
);
