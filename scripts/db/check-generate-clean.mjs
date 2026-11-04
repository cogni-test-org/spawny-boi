// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/db/check-generate-clean`
 * Purpose: Fail-loud CI guard proving `drizzle-kit generate` produces no drift, for EVERY drizzle lane this repo owns.
 * Scope: Runs drizzle-kit generate for each configured lane (Postgres core schema + the node-template Doltgres knowledge plane); does not connect to a DB or apply migrations.
 * Invariants:
 *   - Every lane always runs: one lane's drift must not mask another's, so there is no early return.
 *   - Leaves no generated artifacts behind on any lane, drift or not: new .sql + snapshots are removed and the journal is byte-restored to its PRE-CHECK content (never to HEAD — `git checkout` here would destroy a reviewer's in-progress migration entry).
 *   - Exits non-zero if ANY lane drifts; passes only when every lane's schema TS matches its committed snapshot baseline.
 *   - Every message names its lane, so a failure points at one config + one migrations dir.
 * Side-effects: IO (spawns drizzle-kit, transient migration files, git restore).
 * Links: drizzle.config.ts, drizzle.doltgres.config.ts, .github/workflows/ci.yaml
 */

// biome-ignore-all lint/suspicious/noConsole: validator script
// biome-ignore-all lint/style/noProcessEnv: script entry point

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

// Every drizzle lane this repo owns. A lane absent from this list is a lane whose
// drift nothing catches, which is how `use_when` reached the schema TS while the
// committed Doltgres snapshot still lacked the column (task.5198).
const LANES = [
  {
    label: "postgres",
    config: "drizzle.config.ts",
    mig: "app/src/adapters/server/db/migrations",
  },
  {
    label: "doltgres",
    config: "drizzle.doltgres.config.ts",
    mig: "app/src/adapters/server/db/doltgres-migrations",
  },
];

function snapshotDir(mig) {
  return {
    sql: new Set(readdirSync(mig).filter((f) => f.endsWith(".sql"))),
    meta: new Set(
      readdirSync(`${mig}/meta`).filter(
        (f) => f.endsWith(".json") && f !== "_journal.json"
      )
    ),
  };
}

// Restore the journal to what it was WHEN THIS CHECK STARTED, not to HEAD. The
// previous implementation ran `git checkout -- _journal.json`, which silently
// destroyed legitimate uncommitted work: the exact flow this guard exists to
// support is "edit schema TS -> generate a migration -> review it -> commit", and
// running the check in the middle of it reverted the new journal entry while
// leaving its .sql and snapshot on disk. The migration then existed but was
// unlisted, so the migrator would never apply it — the silent half-commit is
// strictly worse than the drift being checked for. Byte-restore needs no git.
function restore(mig, newSql, newMeta, journalBefore) {
  for (const f of newSql) rmSync(`${mig}/${f}`, { force: true });
  for (const f of newMeta) rmSync(`${mig}/meta/${f}`, { force: true });
  if (journalBefore !== undefined) {
    writeFileSync(`${mig}/meta/_journal.json`, journalBefore);
  }
}

/** Returns true when the lane is clean. Never throws; always restores. */
function checkLane({ label, config, mig }) {
  const before = snapshotDir(mig);
  const journalBefore = readFileSync(`${mig}/meta/_journal.json`, "utf8");
  // spawnSync, not execFileSync: drizzle-kit EXITS 0 even when it cannot resolve the
  // schema module, so the only way to tell "clean" from "never ran" is to read the
  // output on the success path too -- and execFileSync discards stderr there.
  const result = spawnSync(
    "tsx",
    ["node_modules/drizzle-kit/bin.cjs", "generate", `--config=${config}`],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DATABASE_URL: "postgres://check@localhost:0/check",
      },
      encoding: "utf8",
    }
  );
  const exitZero = result.status === 0;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  const after = snapshotDir(mig);
  const newSql = [...after.sql].filter((f) => !before.sql.has(f));
  const newMeta = [...after.meta].filter((f) => !before.meta.has(f));
  const clean =
    exitZero &&
    newSql.length === 0 &&
    newMeta.length === 0 &&
    /No schema changes/.test(output);

  if (clean) {
    // Restore even on the clean path: drizzle-kit can rewrite the journal (field
    // order, trailing newline) without emitting a migration, and a guard must
    // leave no trace of itself in the tree it just certified.
    restore(mig, newSql, newMeta, journalBefore);
    console.log(
      `✓ check-generate-clean [${label}]: db:generate produces no drift -- schema TS matches the snapshot baseline (${config}).`
    );
    return true;
  }

  console.error(
    `✗ check-generate-clean [${label}]: db:generate is NOT clean -- schema TS has drifted from the committed snapshot baseline (${config}).`
  );
  for (const f of newSql) {
    console.error(`\n--- [${label}] drizzle would generate ${f} ---`);
    try {
      console.error(readFileSync(`${mig}/${f}`, "utf8"));
    } catch {
      /* already gone */
    }
  }
  // NOT-CLEAN WITH NOTHING GENERATED IS ALMOST NEVER DRIFT. drizzle-kit exits 0
  // when it cannot resolve the schema module, so reporting "schema TS has drifted"
  // with no further output actively misleads: the real cause is a schema that never
  // loaded, and the usual trigger is an unbuilt workspace package (the doltgres lane
  // resolves @cogni-dao/knowledge-base through `exports` -> dist, NOT src). Print
  // the captured output and say so.
  if (newSql.length === 0 && newMeta.length === 0) {
    console.error(
      `\n[${label}] drizzle-kit generate emitted no migration and never confirmed ` +
        `"No schema changes" (exit ${result.status}). drizzle-kit exits 0 even when it ` +
        "cannot load the schema, so this is far more likely a SCHEMA THAT FAILED TO " +
        "LOAD than real drift -- run `pnpm packages:build` first; this lane reads a " +
        "package's built dist, not its src. Captured output:\n" +
        (output.trim().length > 0 ? output.slice(-2000) : "<no output>")
    );
  }
  restore(mig, newSql, newMeta, journalBefore);
  return false;
}

// Run EVERY lane before reporting: a single `process.exit` on the first drift
// would hide a second lane's drift behind the first one's fix.
const drifted = LANES.filter((lane) => !checkLane(lane)).map((l) => l.label);

if (drifted.length === 0) {
  console.log(
    `✓ check-generate-clean: all ${LANES.length} lanes clean (${LANES.map((l) => l.label).join(", ")}).`
  );
  process.exit(0);
}

console.error(
  `\n✗ check-generate-clean: ${drifted.length} of ${LANES.length} lanes drifted: ${drifted.join(", ")}.`
);
console.error(
  "\nFix: for the postgres lane run `pnpm db:generate`; for the doltgres lane run " +
    "`pnpm db:generate:node-template:doltgres`. Review the migration, then commit it " +
    "(.sql + snapshot + journal)."
);
process.exit(1);
